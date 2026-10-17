import { z } from "zod";

/**
 * Edit-style metrics of a short video — the numbers behind "Cuts every 1.8 s", "Talks 185
 * words a minute", "Music sits 18 dB under the voice". Measured deterministically (ffmpeg +
 * local Whisper word timings, no model calls) by apps/worker/src/reference-analysis-job.ts and
 * stored on ReferenceContent.metrics. This file holds the typed shape (validated on every
 * write and read), the pure math that turns raw measurements into metrics, the per-creator /
 * overall aggregation, and the plain-English wording. No Node imports: safe in the browser.
 * See docs/DECISIONS.md ("Reference videos").
 */

export const REFERENCE_METRICS_VERSION = 1;

/** Storage keys / Blob pathnames of reference videos: `reference/<creatorId>/<file>` (private). */
export const REFERENCE_VIDEO_KEY_PATTERN = /^reference\/[\w-]+\/[\w.-]+$/;

const num = z.number().finite();
const nnum = num.nullable();

export const ReferenceVideoMetricsSchema = z.object({
  version: z.literal(REFERENCE_METRICS_VERSION),
  video: z.object({
    durationS: num.nonnegative(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    /** "9:16", "16:9", "1:1", or "1080:1350"-style when it's no common ratio. */
    aspect: z.string().max(20).nullable(),
    fps: num.positive().nullable(),
  }),
  /** null = no video stream. */
  cuts: z
    .object({
      count: z.number().int().nonnegative(),
      /** Seconds, ascending (capped at 2000). */
      times: z.array(num.nonnegative()).max(2000),
      shotMedianS: nnum,
      shotP25S: nnum,
      shotP75S: nnum,
      cutsPer10s: num.nonnegative(),
      firstCutS: nnum,
      /** Cut density (per 10 s) in the first 3 s, the middle, and the last 3 s. */
      pacing: z.object({ first3sPer10s: num.nonnegative(), middlePer10s: nnum, last3sPer10s: num.nonnegative() }),
      method: z.string().max(200),
    })
    .nullable(),
  /** null = no speech found (no audio, or Whisper heard no words). */
  speech: z
    .object({
      wordCount: z.number().int().nonnegative(),
      speechStartS: num.nonnegative(),
      speechEndS: num.nonnegative(),
      wpm: nnum,
      /** Silence between consecutive words (Whisper word timings). */
      gapMedianS: nnum,
      gapP90S: nnum,
      longestGapS: nnum,
      /** Gaps of 0.3 s or more, per minute of speech. */
      pausesPerMinute: nnum,
      hookText: z.string().max(400),
      hookDurationS: nnum,
      hookEndS: nnum,
      lastSentence: z.string().max(400),
      tailAfterLastWordS: num.nonnegative(),
      /** The video ends within 0.3 s of the last word (a hard out on the last word). */
      endsRightAfterLastWord: z.boolean(),
      /** There's a cut after the last word (a separate closing shot / end card). null = no cut data. */
      closingShotAfterSpeech: z.boolean().nullable(),
    })
    .nullable(),
  /** null = no audio stream. */
  audio: z
    .object({
      integratedLufs: nnum,
      loudnessRangeLu: nnum,
      truePeakDbtp: nnum,
      samplePeakDb: nnum,
      /** Flat-topped peaks at full scale (audible distortion likely). */
      clipping: z.boolean(),
      voiceLevelDb: nnum,
      backgroundLevelDb: nnum,
      /** Voice minus background (dB) — only when background audio is present. */
      backgroundUnderVoiceDb: nnum,
      background: z.enum(["none", "present", "unknown"]),
      backgroundMethod: z.enum(["floor", "none"]),
    })
    .nullable(),
  transcript: z.string().max(6000).nullable(),
  /** Caveats worth showing ("Very few words — speech numbers are rough"). */
  notes: z.array(z.string().max(300)).max(20),
});
export type ReferenceVideoMetrics = z.infer<typeof ReferenceVideoMetricsSchema>;

export function parseReferenceVideoMetrics(raw: unknown): ReferenceVideoMetrics | null {
  const r = ReferenceVideoMetricsSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// ---------------------------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------------------------

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Linear-interpolated quantile of an unsorted list (null when empty). */
export function quantile(values: number[], q: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const pos = (v.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
}

export function median(values: number[]): number | null {
  return quantile(values, 0.5);
}

/** "9:16" for 1080×1920, "4:5" for 1080×1350, else "W:H" reduced. */
export function aspectLabel(width: number | null, height: number | null): string | null {
  if (!width || !height) return null;
  const ratio = width / height;
  const common: Array<[string, number]> = [["9:16", 9 / 16], ["16:9", 16 / 9], ["1:1", 1], ["4:5", 4 / 5], ["3:4", 3 / 4], ["4:3", 4 / 3]];
  for (const [label, r] of common) if (Math.abs(ratio - r) / r < 0.02) return label;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(width, height);
  return `${width / g}:${height / g}`;
}

export function shotMetrics(cutTimes: number[], durationS: number, method: string): NonNullable<ReferenceVideoMetrics["cuts"]> {
  const cuts = [...cutTimes].filter((t) => t > 0 && t < durationS).sort((a, b) => a - b);
  const bounds = [0, ...cuts, durationS];
  const shots: number[] = [];
  for (let i = 1; i < bounds.length; i++) shots.push(bounds[i]! - bounds[i - 1]!);
  const density = (from: number, to: number) => {
    const len = to - from;
    if (len <= 0) return 0;
    return r2((cuts.filter((t) => t >= from && t < to).length / len) * 10);
  };
  const edge = Math.min(3, durationS / 3);
  const opt = (x: number | null) => (x == null ? null : r3(x));
  return {
    count: cuts.length,
    times: cuts.slice(0, 2000).map(r3),
    shotMedianS: opt(median(shots)),
    shotP25S: opt(quantile(shots, 0.25)),
    shotP75S: opt(quantile(shots, 0.75)),
    cutsPer10s: durationS > 0 ? r2((cuts.length / durationS) * 10) : 0,
    firstCutS: cuts[0] != null ? r3(cuts[0]) : null,
    pacing: {
      first3sPer10s: density(0, edge),
      middlePer10s: durationS > 2 * edge ? density(edge, durationS - edge) : null,
      last3sPer10s: density(durationS - edge, durationS + 1e-9),
    },
    method,
  };
}

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

/** Splits timed words into sentences: punctuation first, a long silence (≥ 0.7 s) second. */
export function splitSentences(words: TimedWord[]): TimedWord[][] {
  const out: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    cur.push(w);
    const next = words[i + 1];
    if (SENTENCE_END.test(w.word) || (next && next.start - w.end >= 0.7)) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

function joinWords(ws: TimedWord[]): string {
  return ws.map((w) => w.word).join(" ").replace(/\s+([,.!?;:%])/g, "$1").trim().slice(0, 400);
}

/** The opening line: the first sentence, capped (an unpunctuated run stops at its first ≥0.35 s
 * pause after 4 words, or 25 words). */
function hookOf(sentences: TimedWord[][]): TimedWord[] {
  // A one- or two-word opener ("Okay.", "So,") isn't the hook — it runs on into the next sentence.
  let first: TimedWord[] = [];
  for (const s of sentences) {
    first = [...first, ...s];
    if (first.length >= 3) break;
  }
  if (first.length <= 25) return first;
  for (let i = 4; i < Math.min(first.length - 1, 25); i++) if (first[i + 1]!.start - first[i]!.end >= 0.35) return first.slice(0, i + 1);
  return first.slice(0, 25);
}

/**
 * Speech metrics from word timings. `cutTimes` (when known) answers "is there a closing shot
 * after the last word". null when there are no words.
 */
export function speechMetrics(rawWords: TimedWord[], durationS: number, cutTimes: number[] | null): ReferenceVideoMetrics["speech"] {
  const words = rawWords
    .filter((w) => w && typeof w.word === "string" && w.word.trim() && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => ({ word: w.word.trim(), start: Math.max(0, w.start), end: Math.max(w.start, w.end) }))
    .sort((a, b) => a.start - b.start);
  if (words.length === 0) return null;
  const first = words[0]!;
  const last = words[words.length - 1]!;
  const span = Math.max(0, last.end - first.start);
  const gaps: number[] = [];
  for (let i = 1; i < words.length; i++) gaps.push(Math.max(0, words[i]!.start - words[i - 1]!.end));
  const sentences = splitSentences(words);
  const hook = hookOf(sentences);
  const lastSentence = sentences[sentences.length - 1] ?? [];
  const tail = Math.max(0, durationS - last.end);
  const opt = (x: number | null) => (x == null ? null : r3(x));
  return {
    wordCount: words.length,
    speechStartS: r3(first.start),
    speechEndS: r3(last.end),
    wpm: words.length >= 5 && span >= 3 ? Math.round((words.length / span) * 60) : null,
    gapMedianS: opt(median(gaps)),
    gapP90S: opt(quantile(gaps, 0.9)),
    longestGapS: gaps.length ? r3(Math.max(...gaps)) : null,
    pausesPerMinute: span >= 3 ? r2((gaps.filter((g) => g >= 0.3).length / span) * 60) : null,
    hookText: joinWords(hook),
    hookDurationS: hook.length ? r3(hook[hook.length - 1]!.end - hook[0]!.start) : null,
    hookEndS: hook.length ? r3(hook[hook.length - 1]!.end) : null,
    lastSentence: joinWords(lastSentence.length > 25 ? lastSentence.slice(-25) : lastSentence),
    tailAfterLastWordS: r3(tail),
    endsRightAfterLastWord: tail <= 0.3,
    closingShotAfterSpeech: cutTimes ? cutTimes.some((t) => t > last.end - 0.05 && t < durationS - 0.1) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Aggregation ("style fingerprint")
// ---------------------------------------------------------------------------------------------

export interface StatValue {
  /** Median across videos. */
  value: number;
  /** Videos that had this number. */
  n: number;
  p25: number;
  p75: number;
}

export type StyleConfidence = "none" | "early" | "fair" | "solid";

export interface StyleProfile {
  /** Analyzed videos the profile is built from. */
  sampleSize: number;
  creatorCount: number;
  confidence: StyleConfidence;
  durationS: StatValue | null;
  shotMedianS: StatValue | null;
  cutsPer10s: StatValue | null;
  firstCutS: StatValue | null;
  pacingFirst3sPer10s: StatValue | null;
  pacingMiddlePer10s: StatValue | null;
  pacingLast3sPer10s: StatValue | null;
  wpm: StatValue | null;
  gapMedianS: StatValue | null;
  gapP90S: StatValue | null;
  longestGapS: StatValue | null;
  pausesPerMinute: StatValue | null;
  hookDurationS: StatValue | null;
  speechStartS: StatValue | null;
  tailAfterLastWordS: StatValue | null;
  integratedLufs: StatValue | null;
  /** Among videos with background audio only. */
  backgroundUnderVoiceDb: StatValue | null;
  /** How many videos had background audio / were measurable for it. */
  backgroundPresent: { withBackground: number; measured: number };
  endsRightAfterLastWord: { yes: number; measured: number };
  clipping: { yes: number; measured: number };
  /** A few example opening lines (most recent first). */
  exampleHooks: string[];
}

export function confidenceFor(n: number): StyleConfidence {
  if (n <= 0) return "none";
  if (n < 3) return "early";
  if (n < 8) return "fair";
  return "solid";
}

function stat(values: Array<number | null | undefined>): StatValue | null {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return null;
  return { value: r3(median(v)!), n: v.length, p25: r3(quantile(v, 0.25)!), p75: r3(quantile(v, 0.75)!) };
}

/** Medians across videos — each video counts once, however long it is. */
export function aggregateStyle(items: Array<{ metrics: ReferenceVideoMetrics; creatorId?: string }>): StyleProfile {
  const m = items.map((i) => i.metrics);
  const bgMeasured = m.filter((x) => x.audio && x.audio.background !== "unknown");
  const bgPresent = bgMeasured.filter((x) => x.audio!.background === "present");
  const speech = m.filter((x) => x.speech);
  return {
    sampleSize: m.length,
    creatorCount: new Set(items.map((i) => i.creatorId ?? "")).size,
    confidence: confidenceFor(m.length),
    durationS: stat(m.map((x) => x.video.durationS)),
    shotMedianS: stat(m.map((x) => x.cuts?.shotMedianS)),
    cutsPer10s: stat(m.map((x) => x.cuts?.cutsPer10s)),
    firstCutS: stat(m.map((x) => x.cuts?.firstCutS)),
    pacingFirst3sPer10s: stat(m.map((x) => x.cuts?.pacing.first3sPer10s)),
    pacingMiddlePer10s: stat(m.map((x) => x.cuts?.pacing.middlePer10s)),
    pacingLast3sPer10s: stat(m.map((x) => x.cuts?.pacing.last3sPer10s)),
    wpm: stat(m.map((x) => x.speech?.wpm)),
    gapMedianS: stat(m.map((x) => x.speech?.gapMedianS)),
    gapP90S: stat(m.map((x) => x.speech?.gapP90S)),
    longestGapS: stat(m.map((x) => x.speech?.longestGapS)),
    pausesPerMinute: stat(m.map((x) => x.speech?.pausesPerMinute)),
    hookDurationS: stat(m.map((x) => x.speech?.hookDurationS)),
    speechStartS: stat(m.map((x) => x.speech?.speechStartS)),
    tailAfterLastWordS: stat(m.map((x) => x.speech?.tailAfterLastWordS)),
    integratedLufs: stat(m.map((x) => x.audio?.integratedLufs)),
    backgroundUnderVoiceDb: stat(bgPresent.map((x) => x.audio!.backgroundUnderVoiceDb)),
    backgroundPresent: { withBackground: bgPresent.length, measured: bgMeasured.length },
    endsRightAfterLastWord: { yes: speech.filter((x) => x.speech!.endsRightAfterLastWord).length, measured: speech.length },
    clipping: { yes: m.filter((x) => x.audio?.clipping).length, measured: m.filter((x) => x.audio).length },
    exampleHooks: speech.map((x) => x.speech!.hookText).filter(Boolean).slice(0, 3),
  };
}

// ---------------------------------------------------------------------------------------------
// Plain English
// ---------------------------------------------------------------------------------------------

export interface StyleLine {
  key: string;
  /** Short headline ("Cuts every 1.8 s"). */
  text: string;
  /** Second line ("Most shots last 1.2–2.5 s"). */
  detail?: string;
}

/** "1.8 s", "0.25 s", "12 s" */
export function fmtSeconds(s: number): string {
  if (s >= 10) return `${Math.round(s)} s`;
  if (s >= 1) return `${(Math.round(s * 10) / 10).toFixed(1)} s`;
  return `${(Math.round(s * 100) / 100).toFixed(2).replace(/0$/, "")} s`;
}

export function sampleSizeText(n: number): string {
  if (n === 0) return "No videos measured yet";
  if (n < 3) return `From only ${n} video${n === 1 ? "" : "s"} — an early read; add a few more for a reliable picture`;
  if (n < 8) return `From ${n} videos — a fair read`;
  return `From ${n} videos`;
}

/**
 * The fingerprint as short plain-English lines (most useful first). Only lines backed by data;
 * nothing is invented for a metric that wasn't measured.
 */
export function describeStyle(p: StyleProfile): StyleLine[] {
  const lines: StyleLine[] = [];
  if (p.sampleSize === 0) return lines;
  if (p.shotMedianS) {
    const shot = p.shotMedianS;
    lines.push({
      key: "cuts",
      text: `Cuts every ${fmtSeconds(shot.value)}`,
      detail: shot.n > 1 && fmtSeconds(shot.p25) !== fmtSeconds(shot.p75) ? `Typical shot ${fmtSeconds(shot.p25)}–${fmtSeconds(shot.p75)} across videos` : undefined,
    });
  }
  const f = p.pacingFirst3sPer10s?.value;
  const mid = p.pacingMiddlePer10s?.value;
  if (f != null && mid != null && mid > 0) {
    if (f >= mid * 1.3) lines.push({ key: "pacing", text: "Faster cuts in the first 3 seconds", detail: `${r2(f / 10 * 3).toFixed(1)} cuts in the first 3 s vs ${(mid / 10 * 3).toFixed(1)} per 3 s after` });
    else if (f <= mid * 0.7) lines.push({ key: "pacing", text: "Opens on a longer shot, then speeds up" });
    else lines.push({ key: "pacing", text: "Even pace from start to finish" });
  }
  if (p.firstCutS) lines.push({ key: "firstCut", text: `First cut at ${fmtSeconds(p.firstCutS.value)}` });
  if (p.wpm) lines.push({ key: "wpm", text: `Talks ${Math.round(p.wpm.value)} words a minute`, detail: p.wpm.value >= 180 ? "Fast and dense" : p.wpm.value >= 150 ? "Brisk, conversational" : "Measured, unhurried" });
  if (p.gapP90S) {
    const g = p.gapP90S.value;
    lines.push({
      key: "pauses",
      text: g <= 0.35 ? `Pauses are short — under ${fmtSeconds(Math.max(0.1, g))}` : `Pauses go up to about ${fmtSeconds(g)}`,
      detail: p.longestGapS ? `Longest pause usually ${fmtSeconds(p.longestGapS.value)}` : undefined,
    });
  }
  if (p.hookDurationS) lines.push({ key: "hook", text: `Hook lasts ${fmtSeconds(p.hookDurationS.value)}`, detail: p.speechStartS ? `Starts talking at ${fmtSeconds(p.speechStartS.value)}` : undefined });
  if (p.tailAfterLastWordS) {
    const t = p.tailAfterLastWordS.value;
    lines.push({ key: "ending", text: t <= 0.3 ? `Ends right on the last word (${fmtSeconds(t)} after)` : `Ends ${fmtSeconds(t)} after the last word` });
  }
  const bg = p.backgroundPresent;
  if (bg.measured > 0) {
    if (bg.withBackground === 0) lines.push({ key: "music", text: "No background music — just the voice" });
    else if (p.backgroundUnderVoiceDb) {
      const most = bg.withBackground * 2 >= bg.measured;
      const under = Math.round(p.backgroundUnderVoiceDb.value);
      lines.push({
        key: "music",
        // ≥ 28 dB down is barely audible — could be a very quiet bed or just room sound.
        text: under >= 28 ? `Faint background sound, ${under} dB under the voice` : `Music sits ${under} dB under the voice`,
        detail: most ? (bg.withBackground === bg.measured ? undefined : `In ${bg.withBackground} of ${bg.measured} videos`) : `Only ${bg.withBackground} of ${bg.measured} videos have background sound`,
      });
    }
  }
  if (p.integratedLufs) lines.push({ key: "loudness", text: `Loudness ${Math.round(p.integratedLufs.value)} LUFS`, detail: p.integratedLufs.value >= -16 ? "Loud and punchy, like most short-form" : "On the quiet side for short-form" });
  if (p.durationS) lines.push({ key: "length", text: `Videos run about ${fmtSeconds(p.durationS.value)}` });
  return lines;
}

/** One video's headline numbers ("Cuts every 1.6 s · 190 wpm · hook 2.1 s"). */
export function videoSummary(m: ReferenceVideoMetrics): string {
  const parts: string[] = [];
  if (m.cuts?.shotMedianS != null) parts.push(m.cuts.count === 0 ? "No cuts" : `Cuts every ${fmtSeconds(m.cuts.shotMedianS)}`);
  if (m.speech?.wpm != null) parts.push(`${m.speech.wpm} wpm`);
  if (m.speech?.hookDurationS != null) parts.push(`hook ${fmtSeconds(m.speech.hookDurationS)}`);
  if (m.audio?.background === "present" && m.audio.backgroundUnderVoiceDb != null) parts.push(`music −${Math.round(m.audio.backgroundUnderVoiceDb)} dB`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------------------------
// You vs them
// ---------------------------------------------------------------------------------------------

export interface OwnSpeechProfile {
  /** Raw takes with word timings the numbers come from. */
  takes: number;
  wpm: StatValue | null;
  gapMedianS: StatValue | null;
  gapP90S: StatValue | null;
  longestGapS: StatValue | null;
  pausesPerMinute: StatValue | null;
  hookDurationS: StatValue | null;
  speechStartS: StatValue | null;
}

export function aggregateOwnSpeech(perTake: Array<NonNullable<ReferenceVideoMetrics["speech"]>>): OwnSpeechProfile {
  return {
    takes: perTake.length,
    wpm: stat(perTake.map((s) => s.wpm)),
    gapMedianS: stat(perTake.map((s) => s.gapMedianS)),
    gapP90S: stat(perTake.map((s) => s.gapP90S)),
    longestGapS: stat(perTake.map((s) => s.longestGapS)),
    pausesPerMinute: stat(perTake.map((s) => s.pausesPerMinute)),
    hookDurationS: stat(perTake.map((s) => s.hookDurationS)),
    speechStartS: stat(perTake.map((s) => s.speechStartS)),
  };
}

function ratioText(mine: number, theirs: number, more: string, less: string): string | null {
  if (theirs <= 0 || mine <= 0) return null;
  const r = mine / theirs;
  if (r >= 1.25) return `${r >= 1.95 ? `${(Math.round(r * 10) / 10).toFixed(1).replace(/\.0$/, "")}×` : `${Math.round((r - 1) * 100)}%`} ${more}`;
  if (r <= 0.8) return `${1 / r >= 1.95 ? `${(Math.round((1 / r) * 10) / 10).toFixed(1).replace(/\.0$/, "")}×` : `${Math.round((1 - r) * 100)}%`} ${less}`;
  return null;
}

/**
 * Chris's raw takes vs the reference style, in plain English. Raw takes are unedited, so
 * longer pauses are expected — the line says what the edit should tighten. Only compares
 * numbers both sides have; says "about the same" when within ±20 %.
 */
export function compareOwnToReference(own: OwnSpeechProfile, ref: StyleProfile): StyleLine[] {
  const out: StyleLine[] = [];
  if (own.takes === 0 || ref.sampleSize === 0) return out;
  if (own.gapP90S && ref.gapP90S) {
    const t = ratioText(own.gapP90S.value, ref.gapP90S.value, "longer than your references'", "shorter than your references'");
    out.push({
      key: "pauses",
      text: t ? `Your pauses are ${t}` : "Your pauses are about the same length as your references'",
      detail: `${fmtSeconds(own.gapP90S.value)} vs ${fmtSeconds(ref.gapP90S.value)} (90% of pauses are shorter than this)${t && own.gapP90S.value > ref.gapP90S.value ? " — the edit can tighten them" : ""}`,
    });
  }
  if (own.wpm && ref.wpm) {
    const t = ratioText(own.wpm.value, ref.wpm.value, "faster", "slower");
    out.push({
      key: "wpm",
      text: t ? `You talk ${t} than your references` : "You talk at about the same speed as your references",
      detail: `${Math.round(own.wpm.value)} vs ${Math.round(ref.wpm.value)} words a minute`,
    });
  }
  if (own.hookDurationS && ref.hookDurationS) {
    const t = ratioText(own.hookDurationS.value, ref.hookDurationS.value, "longer", "shorter");
    out.push({
      key: "hook",
      text: t ? `Your opening line is ${t} than theirs` : "Your opening line is about as long as theirs",
      detail: `${fmtSeconds(own.hookDurationS.value)} vs ${fmtSeconds(ref.hookDurationS.value)}`,
    });
  }
  if (own.speechStartS && ref.speechStartS && own.speechStartS.value - ref.speechStartS.value >= 0.4) {
    out.push({ key: "start", text: `You start talking ${fmtSeconds(own.speechStartS.value)} in — they start at ${fmtSeconds(ref.speechStartS.value)}`, detail: "Trimming the lead-in gets to the hook sooner" });
  }
  return out;
}
