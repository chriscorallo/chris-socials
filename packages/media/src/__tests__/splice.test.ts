import { describe, it, expect } from "vitest";
import { analyzeSplicePcm, silencesFromVoice } from "../splice/analysis";
import { DEFAULT_SPLICE_MODEL, PRIOR_SPLICE_MODEL, learnSpliceModel, spliceSamplesFromTimeline, SPLICE_PAD_BAND } from "../splice/model";
import { placePauseCut, refineWordEdges } from "../splice/place";
import { auditSplices } from "../splice/audit";
import { EditTimelineSchema, type EditTimeline } from "../timeline";
import type { TranscriptWord } from "../caption-chunking";

const SR = 16000;

/** A deterministic noise generator (no Math.random in tests). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

interface Piece {
  /** Start/end (s). */
  at: number;
  len: number;
  kind: "VOICE" | "FRICATIVE" | "BURST";
  /** Linear amplitude. */
  amp?: number;
}

/** Synthetic take: a −60 dBFS pink-ish floor, voiced pieces (150 Hz + harmonics), fricatives (high-band noise), bursts (5 ms high-band click). */
function synth(durationS: number, pieces: Piece[], floorAmp = 0.001, seed = 7): Float32Array {
  const n = Math.round(durationS * SR);
  const pcm = new Float32Array(n);
  const rnd = lcg(seed);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp = 0.7 * lp + 0.3 * rnd(); // a broadband room (hiss with some low end), like an iPhone in a quiet room
    pcm[i] = lp * floorAmp * 6;
  }
  const hp = lcg(seed + 1);
  for (const p of pieces) {
    const a = Math.round(p.at * SR);
    const b = Math.min(n, Math.round((p.at + p.len) * SR));
    const amp = p.amp ?? 0.3;
    for (let i = a; i < b; i++) {
      const t = i / SR;
      const env = Math.min(1, (i - a) / (SR * 0.004), (b - i) / (SR * 0.004)); // 4 ms ramps
      if (p.kind === "VOICE") pcm[i] = pcm[i]! + amp * env * (Math.sin(2 * Math.PI * 150 * t) + 0.5 * Math.sin(2 * Math.PI * 300 * t) + 0.25 * Math.sin(2 * Math.PI * 450 * t)) * 0.57;
      else {
        // High-band noise: difference of successive samples (a crude high-pass) of white noise.
        const w = hp() - hp();
        pcm[i] = pcm[i]! + amp * env * w * (p.kind === "BURST" ? 2 : 0.25);
      }
    }
  }
  return pcm;
}

describe("splice analysis — where the voice is, to the millisecond", () => {
  it("finds onsets and offsets within 10 ms, keeps a fricative tail as voice, finds a plosive burst", () => {
    const pcm = synth(4, [
      { at: 0.5, len: 0.8, kind: "VOICE" },
      { at: 1.3, len: 0.06, kind: "FRICATIVE" }, // "…s" tail right after the voiced part
      { at: 2.0, len: 0.005, kind: "BURST" }, // "p…"
      { at: 2.005, len: 0.7, kind: "VOICE" },
      { at: 3.2, len: 0.3, kind: "VOICE", amp: 0.12 }, // a quieter line
    ]);
    const a = analyzeSplicePcm(pcm, SR);
    expect(a.voice.length).toBe(3);
    const [v1, v2, v3] = a.voice;
    expect(Math.abs(v1!.start - 0.5)).toBeLessThanOrEqual(0.01);
    // The fricative extends the first span to 1.36 s instead of ending it at 1.3 s.
    expect(v1!.end).toBeGreaterThanOrEqual(1.34);
    expect(v1!.end).toBeLessThanOrEqual(1.37);
    expect(Math.abs(v2!.start - 2.0)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(v2!.end - 2.705)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(v3!.start - 3.2)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(v3!.end - 3.5)).toBeLessThanOrEqual(0.01); // a quiet line's tail is not stretched by the room
    expect(v3!.db).toBeLessThan(v2!.db - 4); // the level-step audit can see the quieter line
    expect(a.bursts.some((b) => Math.abs(b - 2.0) <= 0.005)).toBe(true);
    expect(a.bursts.some((b) => Math.abs(b - 0.5) <= 0.01)).toBe(false); // a voiced onset is not a burst
    const sil = silencesFromVoice(a);
    expect(sil[0]).toMatchObject({ start: 0 });
    expect(sil.length).toBe(4);
  });

  it("a take with no speech has no voice; a 20 ms dip inside a word does not split it (hysteresis + hang)", () => {
    expect(analyzeSplicePcm(synth(2, []), SR).voice).toEqual([]);
    const pcm = synth(2, [
      { at: 0.5, len: 0.3, kind: "VOICE" },
      { at: 0.82, len: 0.3, kind: "VOICE" }, // 20 ms dip
    ]);
    expect(analyzeSplicePcm(pcm, SR).voice.length).toBe(1);
  });
});

describe("splice placement — cut on the voice", () => {
  it("places the cut from the model's pads, pulls the cut-in before a plosive, and skips pauses shorter than the pads", () => {
    const c = placePauseCut(1.36, 2.0, false, DEFAULT_SPLICE_MODEL, [])!;
    expect(c.cutOut).toBeCloseTo(1.36 + DEFAULT_SPLICE_MODEL.mid.tailS, 3);
    expect(c.cutIn).toBeCloseTo(2.0 - DEFAULT_SPLICE_MODEL.mid.leadS, 3);
    const s = placePauseCut(1.36, 2.0, true, DEFAULT_SPLICE_MODEL, [])!;
    expect(s.cutOut - c.cutOut).toBeCloseTo(DEFAULT_SPLICE_MODEL.sentence.tailS - DEFAULT_SPLICE_MODEL.mid.tailS, 3);
    // A voiced onset measured at 2.0 whose "p" burst came 70 ms earlier: the cut-in sits before the burst.
    const b = placePauseCut(1.36, 2.0, false, DEFAULT_SPLICE_MODEL, [1.93])!;
    expect(b.beforeBurst).toBe(true);
    expect(b.cutIn).toBeCloseTo(1.915, 3);
    expect(placePauseCut(1.36, 2.0, false, DEFAULT_SPLICE_MODEL, [1.985])!.beforeBurst).toBe(false); // the lead pad already clears it
    expect(placePauseCut(1.36, 1.45, false, DEFAULT_SPLICE_MODEL, [])).toBeNull();
  });

  it("refines Whisper's word edges to the voice only at span edges", () => {
    const a = analyzeSplicePcm(synth(3, [{ at: 0.5, len: 0.8, kind: "VOICE" }, { at: 2.0, len: 0.5, kind: "VOICE" }]), SR);
    const words: TranscriptWord[] = [
      { word: "two", start: 0.62, end: 0.9 }, // Whisper starts late
      { word: "people", start: 0.9, end: 1.18 }, // and ends early
      { word: "save.", start: 1.9, end: 2.3 }, // starts inside the pause
    ];
    const r = refineWordEdges(words, a);
    expect(Math.abs(r[0]!.start - 0.5)).toBeLessThanOrEqual(0.01);
    expect(r[0]!.end).toBe(0.9); // inside the span: untouched
    expect(Math.abs(r[1]!.end - 1.3)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(r[2]!.start - 2.0)).toBeLessThanOrEqual(0.01);
  });
});

const tl = (clips: Array<[number, number]>): EditTimeline =>
  EditTimelineSchema.parse({
    version: 2,
    clips: clips.map(([a, b], i) => ({ id: `c${i}`, mediaAssetId: "take", sourceStart: a, sourceEnd: b })),
    captions: { fontId: "inter-display-extrabold", fontSize: 64, color: "#FFFFFF", highlightColor: "#FFD84D", y: 0.72 },
  });

describe("splice model — learned from hand edits, inside the band", () => {
  it("measures a hand edit's pads against the voice and fits medians clamped to the band", () => {
    const a = analyzeSplicePcm(
      synth(8, [
        { at: 0.5, len: 0.8, kind: "VOICE" },
        { at: 2.0, len: 0.8, kind: "VOICE" },
        { at: 3.5, len: 0.8, kind: "VOICE" },
        { at: 5.0, len: 0.8, kind: "VOICE" },
      ]),
      SR,
    );
    // Chris cut every pause leaving 70 ms after the voice and 40 ms before it; the last cut is a reorder, not a pause cut.
    const hand = tl([[0.4, 1.37], [1.96, 2.87], [3.46, 4.37], [4.96, 6], [0.4, 1.3]]);
    const words: TranscriptWord[] = [{ word: "one.", start: 0.5, end: 1.3 }, { word: "two.", start: 2, end: 2.8 }, { word: "three.", start: 3.5, end: 4.3 }];
    const samples = spliceSamplesFromTimeline(hand, a, words, "take");
    expect(samples.length).toBe(3);
    for (const s of samples) {
      expect(Math.abs(s.tailS - 0.07)).toBeLessThanOrEqual(0.012);
      expect(Math.abs(s.leadS - 0.04)).toBeLessThanOrEqual(0.012);
    }
    const m = learnSpliceModel(samples, PRIOR_SPLICE_MODEL, 3);
    expect(m.source).toBe("LEARNED");
    expect(m.sentence.tailS).toBeGreaterThanOrEqual(SPLICE_PAD_BAND.tailS[0]);
    const wide = learnSpliceModel(Array.from({ length: 8 }, () => ({ tailS: 0.5, leadS: 0.4, sentenceEnd: false })), PRIOR_SPLICE_MODEL);
    expect(wide.mid).toEqual({ tailS: SPLICE_PAD_BAND.tailS[1], leadS: SPLICE_PAD_BAND.leadS[1] }); // never wider than the hand-edit band
    expect(learnSpliceModel([]).source).toBe("PRIOR");
    expect(DEFAULT_SPLICE_MODEL.source).toBe("LEARNED"); // the worker cuts with the fitted pads
  });
});

describe("splice audit — planted defects are caught and named", () => {
  const a = analyzeSplicePcm(
    synth(8, [
      { at: 0.5, len: 0.8, kind: "VOICE" }, // ends 1.3
      { at: 2.0, len: 0.8, kind: "VOICE" }, // 2.0–2.8
      { at: 3.5, len: 0.8, kind: "VOICE" }, // 3.5–4.3
      { at: 5.0, len: 0.8, kind: "VOICE", amp: 0.1 }, // quieter: 5.0–5.8
    ]),
    SR,
  );
  const words: TranscriptWord[] = [
    { word: "one", start: 0.5, end: 1.3 },
    { word: "two", start: 2, end: 2.8 },
    { word: "three", start: 3.5, end: 4.3 },
    { word: "four", start: 5, end: 5.8 },
  ];

  it("a clean cut passes; a gap, a clipped word and a level step are each found at the right cut", () => {
    const clean = tl([[0.4, 1.38], [1.95, 2.88]]);
    expect(auditSplices(clean, "take", words, a)).toEqual([]);
    const planted = tl([
      [0.4, 1.38], // cut 0 → gap: 1.38 → 1.75 leaves 80 + 250 ms of air
      [1.75, 2.72], // cut 1 → clipped: the voice runs to 2.8, cut-out at 2.72 (80 ms clipped)
      [3.45, 4.38], // cut 2 → level step: "three" is loud, "four" is quiet
      [4.95, 6.0],
    ]);
    const f = auditSplices(planted, "take", words, a);
    expect(f.map((x) => [x.index, x.kind])).toEqual([
      [0, "GAP"],
      [1, "CLIPPED_WORD"],
      [2, "LEVEL_STEP"],
    ]);
    expect(f[0]!.stage).toBe("SPLICE");
    expect(f[1]!.deltaMs).toBeGreaterThanOrEqual(70);
    expect(f[0]!.atS).toBeCloseTo(0.98, 2);
  });

  it("without an analysis, only clipped words on Whisper's edges are reported", () => {
    const clipped = tl([[0.4, 1.2], [1.95, 2.9]]);
    const f = auditSplices(clipped, "take", words, null);
    expect(f.map((x) => x.kind)).toEqual(["CLIPPED_WORD"]);
  });
});

// ---------------------------------------------------------------------------------------------
// The engine inside the cutter: every splice lands on the voice with the model's pads, no frame
// grid, and a story join leaves the sentence-end beat on both sides.
// ---------------------------------------------------------------------------------------------
import { buildStyleCut, buildStyleCutFromRanges, DEFAULT_STYLE_CUT_OPTIONS } from "../style-cut";
import { spliceMetrics } from "../golden";

function voicedTake(lines: Array<{ text: string; at: number; len: number }>, durationS: number) {
  const words: TranscriptWord[] = [];
  const pieces: Piece[] = [];
  for (const l of lines) {
    pieces.push({ at: l.at, len: l.len, kind: "VOICE" });
    const ws = l.text.split(" ");
    const step = l.len / ws.length;
    // Whisper-ish edges: starts 60 ms late, ends 80 ms early, drifting inside the line.
    ws.forEach((w, i) => words.push({ word: w, start: +(l.at + i * step + (i === 0 ? 0.06 : 0.01)).toFixed(3), end: +(l.at + (i + 1) * step - (i === ws.length - 1 ? 0.08 : 0.02)).toFixed(3) }));
  }
  return { words, analysis: analyzeSplicePcm(synth(durationS, pieces), SR) };
}

const BASE = EditTimelineSchema.parse({
  version: 2,
  clips: [{ id: "c1", mediaAssetId: "take", sourceStart: 0, sourceEnd: 12 }],
  captions: { fontId: "inter-display-extrabold", fontSize: 64, color: "#FFFFFF", highlightColor: "#FFD84D", y: 0.72 },
});

describe("style cut with the splice engine", () => {
  const { words, analysis } = voicedTake(
    [
      { text: "Two people make a hundred grand.", at: 0.6, len: 1.6 },
      { text: "One of them saves seven hundred", at: 2.9, len: 1.5 },
      { text: "a month.", at: 4.75, len: 0.5 }, // a 350 ms hesitation before it (mid-sentence)
      { text: "The other saves four thousand.", at: 6.0, len: 1.6 },
    ],
    9,
  );
  const m = DEFAULT_STYLE_CUT_OPTIONS.spliceModel;

  it("leaves exactly the model's air at every pause cut, on the voice, not on a frame grid", () => {
    const r = buildStyleCut({ base: BASE, mediaAssetId: "take", words, durationSeconds: 9, splice: analysis });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stats.speechTiming).toBe("AUDIO");
    expect(r.stats.pausesRemoved).toBe(3);
    const cuts = r.timeline.clips.slice(1).map((c, i) => ({ outS: r.timeline.clips[i]!.sourceEnd, inS: c.sourceStart }));
    // Voice: 0.6–2.2 . 2.9–4.4 (mid) 4.75–5.25 . 6.0–7.6
    const expectAir = (c: { outS: number; inS: number }, offset: number, onset: number, sentence: boolean) => {
      const pads = sentence ? m.sentence : m.mid;
      expect(Math.abs(c.outS - (offset + pads.tailS))).toBeLessThanOrEqual(0.008);
      expect(Math.abs(c.inS - (onset - pads.leadS))).toBeLessThanOrEqual(0.008);
    };
    expectAir(cuts[0]!, 2.2, 2.9, true);
    expectAir(cuts[1]!, 4.4, 4.75, false);
    expectAir(cuts[2]!, 5.25, 6.0, true);
    // Not on the 30 fps grid: at least one edge is off a frame boundary by more than 2 ms.
    const offGrid = cuts.some((c) => Math.abs(c.outS * 30 - Math.round(c.outS * 30)) / 30 > 0.002);
    expect(offGrid).toBe(true);
    // The golden harness sees no clipped word and the designed air only.
    const sm = spliceMetrics(r.timeline, words, null);
    expect(sm.every((x) => x.clippedTailMs === 0 && x.clippedLeadMs === 0)).toBe(true);
  });

  it("a story join (reordered lines) gets the sentence-end pads on both sides", () => {
    const r = buildStyleCutFromRanges({
      base: BASE,
      mediaAssetId: "take",
      words,
      durationSeconds: 9,
      splice: analysis,
      ranges: [
        { start: 5.5, end: 9 }, // the last line first
        { start: 0, end: 2.55 }, // then the first
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const join = r.timeline.clips.findIndex((c, i) => i > 0 && c.sourceStart < r.timeline.clips[i - 1]!.sourceEnd);
    expect(join).toBeGreaterThan(0);
    const a = r.timeline.clips[join - 1]!;
    const b = r.timeline.clips[join]!;
    expect(Math.abs(a.sourceEnd - (7.6 + m.sentence.tailS))).toBeLessThanOrEqual(0.01);
    expect(Math.abs(b.sourceStart - (0.6 - m.sentence.leadS))).toBeLessThanOrEqual(0.01);
  });
});
