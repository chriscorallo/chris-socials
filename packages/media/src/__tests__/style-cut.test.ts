import { describe, it, expect } from "vitest";
import {
  buildStyleCut,
  styleCutTargetFromProfile,
  framingForShot,
  faceFromProtectedRegion,
  DEFAULT_STYLE_CUT_TARGET,
  MIN_REFERENCE_SAMPLE,
  type StyleCutTarget,
} from "../style-cut";
import { EditTimelineSchema, clipDuration, clipStartTimes, timelineDuration, type EditTimeline } from "../timeline";
import { timelineCaptionWords } from "../timeline-captions";
import { cropGeometry } from "../timeline-layout";
import { detectSilencesFromPcm } from "../speech-activity";
import { clipAudioFades } from "../timeline-render";
import type { TranscriptWord } from "../caption-chunking";
import type { SubjectTrack } from "../subject-track-core";

const ASSET = "take-1";

function base(): EditTimeline {
  return EditTimelineSchema.parse({
    version: 2,
    canvas: { width: 1080, height: 1920 },
    clips: [{ id: "clip-1", mediaAssetId: ASSET, sourceStart: 0, sourceEnd: 60 }],
    captions: {
      enabled: true,
      preset: "BOLD_HIGHLIGHT",
      fontId: "inter-display-extrabold",
      fontSize: 72,
      color: "#FFFFFF",
      highlightColor: "#FFD84D",
      y: 0.74,
    },
    texts: [{ id: "t1", text: "old", start: 1, end: 2, fontId: "inter-semibold", fontSize: 50, color: "#FFFFFF" }],
  });
}

/** Deterministic pseudo-random (LCG) so the "speech" is varied but reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * A talking-head take: `lead` s of dead air, sentences of 6–14 words (0.18–0.38 s each, 0.02–0.09 s
 * apart), a pause after each sentence from `pauses` (cycled), `tail` s of dead air at the end.
 */
function speech(opts: { sentences: number; pauses: number[]; lead?: number; tail?: number; seed?: number; midPauseEvery?: number }) {
  const r = rng(opts.seed ?? 1);
  const words: TranscriptWord[] = [];
  let t = opts.lead ?? 1.2;
  for (let s = 0; s < opts.sentences; s++) {
    const n = 6 + Math.floor(r() * 9);
    for (let i = 0; i < n; i++) {
      const d = 0.18 + r() * 0.2;
      const last = i === n - 1;
      const comma = !last && i === Math.floor(n / 2);
      words.push({ word: `w${s}_${i}${last ? "." : comma ? "," : ""}`, start: round(t), end: round(t + d) });
      t += d;
      if (!last) t += opts.midPauseEvery && i > 0 && i % opts.midPauseEvery === 0 ? 0.45 : 0.02 + r() * 0.07;
    }
    t += opts.pauses[s % opts.pauses.length]!;
  }
  const duration = round(t + (opts.tail ?? 1.5) - opts.pauses[(opts.sentences - 1) % opts.pauses.length]!);
  return { words, duration };
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

/** The silences ≥ 0.1 s between true word timings (what speech-activity measures). */
function silencesOf(words: TranscriptWord[], duration: number) {
  const out: Array<{ start: number; end: number }> = [];
  let t = 0;
  for (const w of words) {
    if (w.start - t >= 0.1) out.push({ start: t, end: w.start });
    t = Math.max(t, w.end);
  }
  if (duration - t >= 0.1) out.push({ start: t, end: duration });
  return out;
}

/** Whisper-like drift: sentence ends reported 0.18 s early; a word after a ≥0.5 s pause starts 0.3 s early. */
function drift(words: TranscriptWord[]): TranscriptWord[] {
  return words.map((w, i) => {
    const prev = words[i - 1];
    const start = prev && w.start - prev.end >= 0.5 ? round(w.start - 0.3) : w.start;
    const end = /[.!?]$/.test(w.word) ? round(Math.max(start + 0.05, w.end - 0.18)) : w.end;
    return { ...w, start, end };
  });
}

function cut(words: TranscriptWord[] | null, duration: number, extra: Partial<Parameters<typeof buildStyleCut>[0]> = {}) {
  return buildStyleCut({ base: base(), mediaAssetId: ASSET, words, durationSeconds: duration, ...extra });
}

function okCut(...args: Parameters<typeof cut>) {
  const r = cut(...args);
  if (!r.ok) throw new Error(r.message);
  return r;
}

describe("buildStyleCut — pauses and dead air", () => {
  const { words, duration } = speech({ sentences: 14, pauses: [0.3, 0.7, 1.5, 0.9, 1.1], lead: 1.4, tail: 2.0 });

  it("never cuts inside a word: every word is entirely inside exactly one clip", () => {
    const r = okCut(words, duration);
    for (const w of words) {
      const holders = r.timeline.clips.filter((c) => w.start >= c.sourceStart - 1e-9 && w.end <= c.sourceEnd + 1e-9);
      expect(holders.length, `${w.word} ${w.start}-${w.end}`).toBe(1);
      const partial = r.timeline.clips.filter((c) => c.sourceStart > w.start + 1e-9 && c.sourceStart < w.end - 1e-9);
      expect(partial).toHaveLength(0);
    }
  });

  it("starts just before the first word and ends 0.2–0.4 s after the last", () => {
    const r = okCut(words, duration);
    const first = r.timeline.clips[0]!;
    const last = r.timeline.clips[r.timeline.clips.length - 1]!;
    expect(words[0]!.start - first.sourceStart).toBeGreaterThanOrEqual(0.05);
    expect(words[0]!.start - first.sourceStart).toBeLessThanOrEqual(0.2);
    const tail = last.sourceEnd - words[words.length - 1]!.end;
    expect(tail).toBeGreaterThanOrEqual(0.2);
    expect(tail).toBeLessThanOrEqual(0.4);
    expect(r.stats.headTrimmedS).toBeGreaterThan(1.2);
    expect(r.summary).toMatch(/starts on your first word/);
  });

  /** Kept silence across each removed pause, measured against `edges` (true speech edges). */
  function splices(r: ReturnType<typeof okCut>, edges: TranscriptWord[]) {
    const out: Array<{ tailPad: number; leadPad: number; before: TranscriptWord }> = [];
    const clips = r.timeline.clips;
    for (let i = 0; i < clips.length - 1; i++) {
      const a = clips[i]!;
      const b = clips[i + 1]!;
      if (Math.abs(a.sourceEnd - b.sourceStart) < 1e-9) continue; // rhythm cut, nothing removed
      const before = edges.filter((w) => w.end <= a.sourceEnd + 1e-9).at(-1)!;
      const after = edges.find((w) => w.start >= b.sourceStart - 1e-9)!;
      out.push({ tailPad: a.sourceEnd - before.end, leadPad: after.start - b.sourceStart, before });
    }
    return out;
  }

  it("WHISPER mode (no measured silences): shortens long pauses with wide pads (Whisper ends words early)", () => {
    const r = okCut(words, duration);
    expect(r.stats.speechTiming).toBe("WHISPER");
    const T = DEFAULT_STYLE_CUT_TARGET;
    const sp = splices(r, words);
    expect(sp.length).toBeGreaterThanOrEqual(5);
    for (const { tailPad, leadPad, before } of sp) {
      expect(tailPad).toBeGreaterThanOrEqual(0.22 - 1e-6);
      expect(leadPad).toBeGreaterThanOrEqual(0.1 - 1e-6);
      const keep = /[.!?]$/.test(before.word) ? T.sentencePauseKeepS : T.pauseKeepS;
      expect(tailPad + leadPad).toBeLessThanOrEqual(Math.max(keep * 0.6, 0.22) + Math.max(keep * 0.4, 0.1) + 0.07);
    }
    // Removed = source - output - head - tail.
    const removed = r.stats.sourceDurationS - r.stats.outputDurationS - r.stats.headTrimmedS - r.stats.tailTrimmedS;
    expect(Math.abs(removed - r.stats.pauseSecondsRemoved)).toBeLessThan(0.01);
  });

  it("AUDIO mode: cuts only inside measured silence, keeps the target pause + pads around the real speech", () => {
    // True speech = `words`; Whisper reports them drifted (ends 0.18 s early, starts after a
    // long pause 0.3 s early) — the measured silences must win.
    const silences = silencesOf(words, duration);
    const whisper = drift(words);
    const r = okCut(whisper, duration, { silences });
    expect(r.stats.speechTiming).toBe("AUDIO");
    const T = DEFAULT_STYLE_CUT_TARGET;
    const sp = splices(r, words);
    expect(sp.length).toBeGreaterThanOrEqual(10);
    for (const { tailPad, leadPad, before } of sp) {
      expect(tailPad).toBeGreaterThanOrEqual(0.08 - 1e-6);
      expect(leadPad).toBeGreaterThanOrEqual(0.06 - 1e-6);
      const keep = /[.!?]$/.test(before.word) ? T.sentencePauseKeepS : T.pauseKeepS;
      expect(tailPad + leadPad).toBeGreaterThanOrEqual(keep - 1e-6);
      expect(tailPad + leadPad).toBeLessThanOrEqual(Math.max(keep * 0.6, 0.08) + Math.max(keep * 0.4, 0.06) + 0.07);
    }
    // No removed span overlaps true speech.
    const clips = r.timeline.clips;
    for (let i = 0; i < clips.length - 1; i++) {
      const gapS = clips[i]!.sourceEnd;
      const gapE = clips[i + 1]!.sourceStart;
      if (gapE <= gapS) continue;
      for (const w of words) expect(w.end <= gapS + 1e-9 || w.start >= gapE - 1e-9, `${w.word}`).toBe(true);
    }
    // Starts/ends on the REAL speech, not Whisper's drifted edges.
    expect(words[0]!.start - clips[0]!.sourceStart).toBeGreaterThanOrEqual(0.1);
    expect(clips.at(-1)!.sourceEnd - words.at(-1)!.end).toBeGreaterThanOrEqual(0.28);
    expect(r.stats.pausesRemoved).toBeGreaterThan(okCut(whisper, duration).stats.pausesRemoved - 1);
  });

  it("AUDIO mode: a short wordless sound (breath/click) between words counts as silence", () => {
    const silences = silencesOf(words, duration);
    // Put a 0.15 s "breath" in the middle of the longest pause.
    const longest = silences.slice(1, -1).reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    const mid = (longest.start + longest.end) / 2;
    const withBreath = silences.flatMap((s) => (s === longest ? [{ start: s.start, end: mid - 0.075 }, { start: mid + 0.075, end: s.end }] : [s]));
    const a = okCut(words, duration, { silences });
    const b = okCut(words, duration, { silences: withBreath });
    expect(b.stats.pausesRemoved).toBe(a.stats.pausesRemoved);
    expect(Math.abs(b.stats.outputDurationS - a.stats.outputDurationS)).toBeLessThan(0.05);
  });

  it("keeps a longer beat after sentence ends than mid-sentence", () => {
    const T = DEFAULT_STYLE_CUT_TARGET;
    expect(T.sentencePauseKeepS).toBeGreaterThan(T.pauseKeepS);
    const mid = speech({ sentences: 6, pauses: [1.0], midPauseEvery: 3, seed: 5 });
    const r = okCut(mid.words, mid.duration, { silences: silencesOf(mid.words, mid.duration), options: { alwaysCutGapS: 0.4 } });
    const sp = splices(r, mid.words);
    const sentence = sp.filter((s) => /[.!?]$/.test(s.before.word)).map((s) => s.tailPad + s.leadPad);
    const inner = sp.filter((s) => !/[.!?]$/.test(s.before.word)).map((s) => s.tailPad + s.leadPad);
    expect(sentence.length).toBeGreaterThan(0);
    expect(inner.length).toBeGreaterThan(0);
    expect(Math.min(...sentence)).toBeGreaterThan(Math.max(...inner));
  });

  it("leaves short natural gaps alone (no cut for a 0.25 s pause)", () => {
    const { words: w2, duration: d2 } = speech({ sentences: 5, pauses: [0.25], seed: 3 });
    const r = okCut(w2, d2);
    expect(r.stats.pausesRemoved).toBe(0);
  });

  it("every clip is a whole number of 1/30 s frames (no audio slip between contiguous clips)", () => {
    const r = okCut(words, duration);
    for (const c of r.timeline.clips.slice(0, -1)) {
      const frames = clipDuration(c) * 30;
      expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-3);
      expect(c.sourceStart * 30 - Math.round(c.sourceStart * 30)).toBeLessThan(1e-3);
    }
  });
});

describe("buildStyleCut — rhythm", () => {
  it("by default never adds a cut just to hit a cut rate: every cut removes a pause", () => {
    const { words, duration } = speech({ sentences: 16, pauses: [0.3, 0.35], seed: 11 });
    const r = okCut(words, duration);
    expect(r.shots.filter((s) => s.cutBefore === "RHYTHM")).toHaveLength(0);
    expect(r.stats.rhythmCuts).toBe(0);
  });

  // Opt-in only (rhythmCuts: true) — kept for comparison/testing.
  it("shots land in the target p25–p75 band (opening shot near the first-cut target)", () => {
    // Long sentences, few pauses → the rhythm cuts do the pacing.
    const { words, duration } = speech({ sentences: 16, pauses: [0.3, 0.35], seed: 11 });
    const r = okCut(words, duration, { options: { rhythmCuts: true } });
    const T = DEFAULT_STYLE_CUT_TARGET;
    const lens = r.timeline.clips.map(clipDuration);
    expect(lens.length).toBeGreaterThan(8);
    const inner = lens.slice(1, -1);
    const inBand = inner.filter((l) => l >= T.shotP25S * 0.85 && l <= T.shotP75S * 1.15).length;
    expect(inBand / inner.length).toBeGreaterThanOrEqual(0.85);
    expect(lens[0]!).toBeGreaterThanOrEqual(T.firstCutS * 0.75 * 0.85);
    expect(lens[0]!).toBeLessThanOrEqual(T.firstCutS * 1.35 * 1.15);
    expect(r.stats.shotMedianS).toBeGreaterThan(T.shotP25S);
    expect(r.stats.shotMedianS).toBeLessThan(T.shotP75S);
  });

  it("rhythm cuts sit on word boundaries and prefer sentence ends", () => {
    const { words, duration } = speech({ sentences: 16, pauses: [0.3, 0.35], seed: 11 });
    const r = okCut(words, duration, { options: { rhythmCuts: true } });
    const rhythm = r.shots.filter((s) => s.cutBefore === "RHYTHM");
    expect(rhythm.length).toBeGreaterThan(3);
    let atSentence = 0;
    for (const s of rhythm) {
      const prev = words.filter((w) => w.end <= s.sourceStart + 1e-9).at(-1)!;
      const next = words.find((w) => w.start >= s.sourceStart - 1e-9)!;
      expect(words.indexOf(next)).toBe(words.indexOf(prev) + 1);
      if (/[.!?]$/.test(prev.word)) atSentence++;
    }
    expect(atSentence / rhythm.length).toBeGreaterThan(0.3);
  });

  it("follows a different target cadence", () => {
    const { words, duration } = speech({ sentences: 20, pauses: [0.3], seed: 4 });
    const slow: StyleCutTarget = { ...DEFAULT_STYLE_CUT_TARGET, shotMedianS: 4, shotP25S: 3.2, shotP75S: 5 };
    const fast = okCut(words, duration, { options: { rhythmCuts: true } });
    const slower = okCut(words, duration, { target: slow, options: { rhythmCuts: true } });
    expect(slower.timeline.clips.length).toBeLessThan(fast.timeline.clips.length);
    expect(slower.stats.shotMedianS).toBeGreaterThan(3);
  });
});

describe("buildStyleCut — framing", () => {
  const { words, duration } = speech({ sentences: 12, pauses: [0.3, 1.0], seed: 8 });

  it("alternates between 2–3 framings and never repeats one twice in a row", () => {
    const r = okCut(words, duration);
    const zooms = r.timeline.clips.map((c) => c.crop.zoom);
    for (let i = 1; i < zooms.length; i++) expect(zooms[i]).not.toBe(zooms[i - 1]);
    expect(new Set(zooms).size).toBeGreaterThanOrEqual(2);
    expect(new Set(zooms).size).toBeLessThanOrEqual(3);
    expect(Math.max(...zooms)).toBeLessThanOrEqual(1.2);
    expect(framingForShot(0)).toBe("WIDE");
  });

  it("centres punch-ins on the tracked face and keeps the head in frame, above the captions", () => {
    // Face off to the right and fairly high in the source.
    const track: SubjectTrack = Array.from({ length: Math.ceil(duration * 4) }, (_, i) => ({
      t: i / 4,
      box: { x: 0.55, y: 0.2, w: 0.3, h: 0.22 },
    }));
    const r = okCut(words, duration, { subjectTrack: track, sourceSize: { width: 1080, height: 1920 } });
    expect(r.stats.faceTracked).toBe(true);
    const face = faceFromProtectedRegion({ x: 0.55, y: 0.2, w: 0.3, h: 0.22 });
    let punched = 0;
    for (const c of r.timeline.clips) {
      if (c.crop.zoom === 1) continue;
      punched++;
      const g = cropGeometry({ width: 1080, height: 1920 }, { width: 1080, height: 1920 }, c.crop);
      const fx = (v: number) => (v * g.scaledWidth - g.offsetX) / 1080;
      const fy = (v: number) => (v * g.scaledHeight - g.offsetY) / 1920;
      expect(fx(face.x)).toBeGreaterThanOrEqual(0.02);
      expect(fx(face.x + face.w)).toBeLessThanOrEqual(0.98);
      expect(fy(face.y)).toBeGreaterThanOrEqual(0.02);
      expect(fy(face.y + face.h)).toBeLessThanOrEqual(0.74 - 0.06 + 1e-6);
      expect(c.crop.panX).toBeGreaterThan(0); // pushed toward the face
      // Face pulled toward the centre as far as the crop allows (pan is clamped to the overflow).
      expect(Math.abs(fx(face.x + face.w / 2) - 0.5)).toBeLessThan(Math.abs(face.x + face.w / 2 - 0.5));
      expect(c.crop.panX).toBe(1);
    }
    expect(punched).toBeGreaterThan(2);
  });

  it("a punch-in may crop the hair/ear margins of a close-up but never the face", () => {
    // Close-up: the protected region is 0.7 of the frame wide (the e2e test clip's real track).
    const track: SubjectTrack = Array.from({ length: Math.ceil(duration * 4) + 1 }, (_, i) => ({ t: i / 4, box: { x: 0.2675, y: 0.1193, w: 0.7069, h: 0.5652 } }));
    const r = okCut(words, duration, { subjectTrack: track });
    expect(r.timeline.clips.some((c) => c.crop.zoom > 1)).toBe(true);
  });

  it("stays WIDE when a punch-in would push the chin into the captions", () => {
    const track: SubjectTrack = Array.from({ length: Math.ceil(duration * 4) + 1 }, (_, i) => ({ t: i / 4, box: { x: 0.1, y: 0.25, w: 0.8, h: 0.7 } }));
    const r = okCut(words, duration, { subjectTrack: track });
    expect(r.timeline.clips.every((c) => c.crop.zoom === 1)).toBe(true);
  });
});

describe("buildStyleCut — captions", () => {
  it("captions stay in sync: every word is shown exactly once, at its remapped time", () => {
    const { words, duration } = speech({ sentences: 10, pauses: [0.8, 1.4, 0.3], seed: 21 });
    const r = okCut(words, duration);
    expect(r.timeline.captions.enabled).toBe(true);
    const shown = timelineCaptionWords(r.timeline, { [ASSET]: words });
    expect(shown.map((w) => w.word)).toEqual(words.map((w) => w.word));
    const starts = clipStartTimes(r.timeline);
    shown.forEach((sw, i) => {
      const w = words[i]!;
      const ci = r.timeline.clips.findIndex((c) => w.start >= c.sourceStart - 1e-9 && w.end <= c.sourceEnd + 1e-9);
      const c = r.timeline.clips[ci]!;
      expect(Math.abs(sw.start - (starts[ci]! + w.start - c.sourceStart))).toBeLessThan(0.002);
      expect(Math.abs(sw.end - sw.start - (w.end - w.start))).toBeLessThan(0.002);
    });
    expect(shown.at(-1)!.end).toBeLessThanOrEqual(timelineDuration(r.timeline));
  });

  it("drops the base's texts (timed to the uncut take) and keeps its caption style", () => {
    const { words, duration } = speech({ sentences: 4, pauses: [1.0] });
    const r = okCut(words, duration);
    expect(r.timeline.texts).toHaveLength(0);
    expect(r.timeline.captions.y).toBe(0.74);
    expect(r.timeline.captions.preset).toBe("BOLD_HIGHLIGHT");
    expect(r.timeline.audio.normalize).toBe(true);
  });
});

describe("buildStyleCut — idempotency and edge cases", () => {
  const { words, duration } = speech({ sentences: 8, pauses: [0.9, 0.3], seed: 2 });

  it("same inputs → identical output and inputsKey; different inputs → different key", () => {
    const a = okCut(words, duration);
    const b = okCut(JSON.parse(JSON.stringify(words)), duration);
    expect(b.timeline).toEqual(a.timeline);
    expect(b.inputsKey).toBe(a.inputsKey);
    const track: SubjectTrack = [{ t: 0, box: { x: 0.4, y: 0.2, w: 0.2, h: 0.15 } }];
    expect(okCut(words, duration, { subjectTrack: track }).inputsKey).not.toBe(a.inputsKey);
  });

  it("no transcript → nothing, with a plain message", () => {
    for (const w of [null, [], [{ word: " ", start: 0, end: 1 }]]) {
      const r = cut(w as TranscriptWord[] | null, 10);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("NO_TRANSCRIPT");
        expect(r.message).toMatch(/needs captions first/);
      }
    }
    expect(cut(words, 0).ok).toBe(false);
  });

  it("a one-word take still produces a valid, tight edit", () => {
    const r = okCut([{ word: "Hi.", start: 2, end: 2.4 }], 5);
    expect(r.timeline.clips).toHaveLength(1);
    expect(r.timeline.clips[0]!.sourceStart).toBeCloseTo(1.867, 2);
    expect(r.stats.cuts).toBe(0);
  });

  it("tolerates unsorted / overlapping word timings", () => {
    const messy = [...words].reverse().map((w, i) => (i % 7 === 0 ? { ...w, end: w.end + 0.05 } : w));
    const r = okCut(messy, duration);
    expect(r.timeline.clips.length).toBeGreaterThan(1);
  });
});

describe("styleCutTargetFromProfile", () => {
  const stat = (value: number, n = 15, p25 = value * 0.8, p75 = value * 1.3) => ({ value, n, p25, p75 });

  it("uses built-in defaults with no or few reference videos", () => {
    expect(styleCutTargetFromProfile(null).source.kind).toBe("DEFAULTS");
    const few = styleCutTargetFromProfile({ sampleSize: MIN_REFERENCE_SAMPLE - 1, creatorCount: 1, shotMedianS: stat(5, 2) });
    expect(few.source).toEqual({ kind: "DEFAULTS", sampleSize: 2, creatorCount: 1 });
    expect(few.shotMedianS).toBe(DEFAULT_STYLE_CUT_TARGET.shotMedianS);
    const r = okCut([{ word: "Hi.", start: 0, end: 0.3 }], 1, { target: few });
    expect(r.profileNote).toMatch(/only 2 reference videos/);
  });

  it("maps a real profile (the 2026-10-17 live numbers) to targets", () => {
    const t = styleCutTargetFromProfile({
      sampleSize: 15,
      creatorCount: 4,
      shotMedianS: { value: 2.4, n: 15, p25: 1.9, p75: 4.6 },
      firstCutS: stat(3.2),
      hookDurationS: stat(3.0),
      gapP90S: stat(0.09),
      longestGapS: stat(0.62),
      integratedLufs: stat(-14),
    });
    expect(t.source).toEqual({ kind: "REFERENCES", sampleSize: 15, creatorCount: 4 });
    expect(t.shotMedianS).toBe(2.4);
    expect(t.shotP25S).toBe(1.9);
    expect(t.shotP75S).toBe(4.6);
    expect(t.firstCutS).toBe(3.2);
    expect(t.pauseKeepS).toBe(0.12); // clamped up: never strip every breath
    expect(t.sentencePauseKeepS).toBeCloseTo(0.31, 2);
    expect(t.lufs).toBe(-14);
  });

  it("falls back per number when speech metrics are missing (music-led / no-talking references)", () => {
    const t = styleCutTargetFromProfile({
      sampleSize: 12,
      creatorCount: 3,
      shotMedianS: { value: 2.0, n: 12, p25: 1.6, p75: 3.0 },
      firstCutS: stat(2.5),
      hookDurationS: null,
      gapP90S: null,
      longestGapS: stat(0.6, 2), // too few videos measured it
      integratedLufs: undefined,
    });
    expect(t.source.kind).toBe("REFERENCES");
    expect(t.shotMedianS).toBe(2.0);
    expect(t.firstCutS).toBe(2.5);
    expect(t.hookDurationS).toBe(DEFAULT_STYLE_CUT_TARGET.hookDurationS);
    expect(t.pauseKeepS).toBe(DEFAULT_STYLE_CUT_TARGET.pauseKeepS);
    expect(t.sentencePauseKeepS).toBe(DEFAULT_STYLE_CUT_TARGET.sentencePauseKeepS);
    expect(t.lufs).toBe(-14);
  });

  it("clamps broken measurements", () => {
    const t = styleCutTargetFromProfile({ sampleSize: 9, creatorCount: 2, shotMedianS: stat(0.1), firstCutS: stat(60), gapP90S: stat(5), longestGapS: stat(9) });
    expect(t.shotMedianS).toBeGreaterThanOrEqual(1.2);
    expect(t.firstCutS).toBeLessThanOrEqual(8);
    expect(t.pauseKeepS).toBeLessThanOrEqual(0.3);
    expect(t.sentencePauseKeepS).toBeLessThanOrEqual(0.5);
  });
});

describe("captions across a removed pause", () => {
  it("a word straddling a forward splice is shown once (where more of it survives); a duplicated clip keeps its own", () => {
    const words = [
      { word: "one", start: 0.2, end: 0.6 },
      { word: "two", start: 0.9, end: 2.4 }, // Whisper stretched it across the pause
      { word: "three", start: 2.5, end: 2.9 },
    ];
    const tl = EditTimelineSchema.parse({
      ...base(),
      texts: [],
      clips: [
        { id: "a", mediaAssetId: ASSET, sourceStart: 0, sourceEnd: 1.1 },
        { id: "b", mediaAssetId: ASSET, sourceStart: 2.0, sourceEnd: 3.0 },
      ],
    });
    const shown = timelineCaptionWords(tl, { [ASSET]: words }).map((w) => w.word);
    expect(shown).toEqual(["one", "two", "three"]);
    const twice = EditTimelineSchema.parse({ ...tl, clips: [tl.clips[0], { ...tl.clips[0], id: "dup" }] });
    expect(timelineCaptionWords(twice, { [ASSET]: words }).map((w) => w.word)).toEqual(["one", "two", "one", "two"]);
  });
});

describe("detectSilencesFromPcm", () => {
  it("finds the quiet stretches between bursts of 'speech' over room noise", () => {
    const sr = 16000;
    const r = rng(9);
    const pcm = new Float32Array(sr * 6);
    // Speech bursts (s): [0.5,1.8] [2.3,2.5] [3.5,5.2]; room noise everywhere.
    const bursts = [[0.5, 1.8], [2.3, 2.5], [3.5, 5.2]] as const;
    for (let i = 0; i < pcm.length; i++) {
      const t = i / sr;
      let v = (r() - 0.5) * 0.004;
      if (bursts.some(([a, b]) => t >= a && t < b)) v += 0.3 * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t));
      pcm[i] = v;
    }
    const a = detectSilencesFromPcm(pcm, sr);
    const near = (x: number, y: number) => Math.abs(x - y) <= 0.04;
    expect(a.silences.length).toBe(4);
    expect(near(a.silences[0]!.start, 0) && near(a.silences[0]!.end, 0.5)).toBe(true);
    expect(near(a.silences[1]!.start, 1.8) && near(a.silences[1]!.end, 2.3)).toBe(true);
    expect(near(a.silences[2]!.start, 2.5) && near(a.silences[2]!.end, 3.5)).toBe(true);
    expect(near(a.silences[3]!.start, 5.2) && near(a.silences[3]!.end, 6)).toBe(true);
    expect(a.speechDb - a.floorDb).toBeGreaterThan(20);
  });

  it("all-quiet audio is one silence", () => {
    const pcm = new Float32Array(16000).map(() => 0.0001);
    expect(detectSilencesFromPcm(pcm, 16000).silences).toEqual([{ start: 0, end: 1 }]);
  });
});

describe("clipAudioFades (de-click at splices)", () => {
  const clip = (id: string, s: number, e: number, asset = ASSET) => ({ id, mediaAssetId: asset, sourceStart: s, sourceEnd: e, crop: { zoom: 1, panX: 0, panY: 0 }, volume: 1 });
  it("fades only where the audio jumps (removed pause or other take), never inside contiguous footage", () => {
    const clips = [clip("a", 0, 2), clip("b", 2, 3), clip("c", 4, 5), clip("d", 0, 1, "other")];
    expect(clipAudioFades(clips, 0, 2)).toBe("");
    expect(clipAudioFades(clips, 1, 1)).toBe(",afade=t=out:st=0.992:d=0.008");
    expect(clipAudioFades(clips, 2, 1)).toBe(",afade=t=in:st=0:d=0.008,afade=t=out:st=0.992:d=0.008");
    expect(clipAudioFades(clips, 3, 1)).toBe(",afade=t=in:st=0:d=0.008");
  });
});
