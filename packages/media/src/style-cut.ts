import type { TranscriptWord } from "./caption-chunking";
import { PROTECTED_HEAD_EXPANSION, subjectBoxAt, type NormBox, type SubjectTrack } from "./subject-track-core";
import { EditTimelineSchema, type EditTimeline, type TimelineClip } from "./timeline";

/**
 * "Style cut" — a deterministic jump-cut edit of one talking-head take, paced like Chris's
 * reference creators. PURE (browser-safe, no I/O, no model calls, $0): arithmetic on Whisper
 * word timings + the measured reference style profile (packages/domain style-metrics.ts
 * `StyleProfile`, passed in structurally — media doesn't depend on domain).
 *
 * What it does, in order:
 *  1. Dead air: starts `preRoll` before the first word, ends `tail` after the last word.
 *  2. Pauses: a silence between two words longer than the target is shortened to the target
 *     (a shorter pause mid-sentence, a slightly longer one after a sentence end), keeping a
 *     pad after the last word and before the next so consonants/breaths are never clipped.
 *     A cut is NEVER inside a word. Short pauses that would create a shot shorter than the
 *     minimum are left alone (a jump cut every half second reads as frantic, not edited).
 *  3. Rhythm: every removed pause is a visual cut — and by default that's the ONLY reason to
 *     cut. Chris's rule: a cut exists to make the delivery fluid (no dead pauses) and serve the
 *     story, never just to hit a cut-rate number, so `rhythmCuts` is off. When turned on,
 *     shots longer than the target's p75 are split at word boundaries (sentence ends > commas >
 *     natural gaps) near the target median, the opening shot near the target first-cut time.
 *     Story-level cuts (dropping a tangent or a repeated line) are semantic — that's the AI
 *     edit's job, not this arithmetic.
 *  4. Framing: on a single-camera talking head a "cut" is a change of framing — the shots
 *     alternate between WIDE / MEDIUM / TIGHT punch-ins (never the same framing twice in a
 *     row), centred on the face from the subject track so the head stays in frame and clear
 *     of the caption band.
 *  5. Captions stay on (the base timeline's style); the renderer/preview derive them from the
 *     clips, so removed pauses never leave them out of sync.
 *
 * Every clip duration is a whole number of 1/30 s frames so the renderer's frame-aligned
 * concat never slips audio between contiguous clips.
 */

export const STYLE_CUT_VERSION = 2;

/** Output frame grid (s). Multiples of 1/30 are also whole frames at 60 fps. */
const FRAME = 1 / 30;

/** Structural subset of domain's `StyleProfile` (a StatValue is {value, n, p25, p75}). */
interface StatLike {
  value: number;
  n: number;
  p25: number;
  p75: number;
}
export interface StyleProfileLike {
  sampleSize: number;
  creatorCount: number;
  shotMedianS?: StatLike | null;
  firstCutS?: StatLike | null;
  hookDurationS?: StatLike | null;
  gapP90S?: StatLike | null;
  longestGapS?: StatLike | null;
  integratedLufs?: StatLike | null;
}

/** The numbers a style cut aims for. */
export interface StyleCutTarget {
  /** Typical shot length (s) and the band shots should land in. */
  shotMedianS: number;
  shotP25S: number;
  shotP75S: number;
  /** When the first cut lands (s) — references open on a longer shot, then speed up. */
  firstCutS: number;
  hookDurationS: number;
  /** Silence kept between words mid-sentence (s). */
  pauseKeepS: number;
  /** Silence kept after a sentence end (s) — a beat, so it doesn't sound robotic. */
  sentencePauseKeepS: number;
  /** Loudness target (LUFS) — informational: the renderer masters at -14. */
  lufs: number;
  /** Where the numbers came from. */
  source: { kind: "REFERENCES" | "DEFAULTS"; sampleSize: number; creatorCount: number };
}

/** Sane short-form defaults (close to the first live reference measurement, 2026-10-17). */
export const DEFAULT_STYLE_CUT_TARGET: StyleCutTarget = {
  shotMedianS: 2.4,
  shotP25S: 1.9,
  shotP75S: 3.6,
  firstCutS: 3.2,
  hookDurationS: 3.0,
  pauseKeepS: 0.18,
  sentencePauseKeepS: 0.32,
  lufs: -14,
  source: { kind: "DEFAULTS", sampleSize: 0, creatorCount: 0 },
};

/** Fewer analysed reference videos than this → the built-in defaults (an "early" read). */
export const MIN_REFERENCE_SAMPLE = 3;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Turns a reference StyleProfile into cut targets. Each number falls back to the default when
 * fewer than MIN_REFERENCE_SAMPLE videos measured it; everything is clamped to a sane range
 * (a broken measurement must never produce a 0.2 s or 20 s shot).
 */
export function styleCutTargetFromProfile(profile: StyleProfileLike | null | undefined): StyleCutTarget {
  const d = DEFAULT_STYLE_CUT_TARGET;
  if (!profile || profile.sampleSize < MIN_REFERENCE_SAMPLE) {
    return { ...d, source: { kind: "DEFAULTS", sampleSize: profile?.sampleSize ?? 0, creatorCount: profile?.creatorCount ?? 0 } };
  }
  const ok = (s: StatLike | null | undefined): s is StatLike => !!s && s.n >= MIN_REFERENCE_SAMPLE && Number.isFinite(s.value);
  const shot = ok(profile.shotMedianS) ? profile.shotMedianS : null;
  const shotMedianS = shot ? clamp(shot.value, 1.2, 6) : d.shotMedianS;
  const shotP25S = shot ? clamp(Math.min(shot.p25, shotMedianS), 0.9, shotMedianS) : d.shotP25S;
  const shotP75S = shot ? clamp(Math.max(shot.p75, shotMedianS), shotMedianS, 8) : d.shotP75S;
  const hookDurationS = ok(profile.hookDurationS) ? clamp(profile.hookDurationS.value, 1.2, 8) : d.hookDurationS;
  const firstCutS = ok(profile.firstCutS) ? clamp(profile.firstCutS.value, 1.2, 8) : d.firstCutS;
  const p90 = ok(profile.gapP90S) ? profile.gapP90S.value : null;
  const longest = ok(profile.longestGapS) ? profile.longestGapS.value : null;
  const pauseKeepS = p90 != null ? clamp(p90, 0.12, 0.3) : d.pauseKeepS;
  const sentencePauseKeepS = clamp(
    Math.max(pauseKeepS + 0.08, longest != null ? longest * 0.5 : d.sentencePauseKeepS),
    0.22,
    0.5,
  );
  const lufs = ok(profile.integratedLufs) ? clamp(profile.integratedLufs.value, -20, -9) : d.lufs;
  return {
    shotMedianS,
    shotP25S,
    shotP75S,
    firstCutS,
    hookDurationS,
    pauseKeepS: Math.round(pauseKeepS * 1000) / 1000,
    sentencePauseKeepS: Math.round(sentencePauseKeepS * 1000) / 1000,
    lufs,
    source: { kind: "REFERENCES", sampleSize: profile.sampleSize, creatorCount: profile.creatorCount },
  };
}

export const STYLE_CUT_FRAMINGS = [
  { name: "WIDE", zoom: 1 },
  { name: "MEDIUM", zoom: 1.12 },
  { name: "TIGHT", zoom: 1.2 },
] as const;
export type StyleCutFramingName = (typeof STYLE_CUT_FRAMINGS)[number]["name"];

/** Shot k's framing: WIDE alternating with MEDIUM / TIGHT — 3 framings, never the same twice in a row. */
export function framingForShot(k: number): StyleCutFramingName {
  if (k % 2 === 0) return "WIDE";
  return k % 4 === 1 ? "TIGHT" : "MEDIUM";
}

export interface StyleCutInput {
  /** The timeline whose look (canvas, captions style, grade, audio) the cut keeps — normally
   * the plain starter edit converted by planToTimeline. Its clips/texts/zooms/visuals/sfx are
   * replaced (they're timed to the uncut take). */
  base: EditTimeline;
  mediaAssetId: string;
  /** The take's Whisper word timings (source seconds). */
  words: TranscriptWord[] | null | undefined;
  durationSeconds: number;
  /** Protected head region over time (MediaAsset.subjectTrack), if tracked. */
  subjectTrack?: SubjectTrack | null;
  /** Source frame size (for pan math on non-9:16 footage). Defaults to the canvas aspect. */
  sourceSize?: { width: number; height: number } | null;
  /** Measured silences of the take's audio (speech-activity.ts). Strongly preferred: Whisper's
   * word edges alone drift ±0.2 s, so without these the cut pads more and trims less. */
  silences?: Array<{ start: number; end: number }> | null;
  target?: StyleCutTarget;
  /** Fine-tuning (tests). */
  options?: Partial<StyleCutOptions>;
}

export interface StyleCutOptions {
  /** Kept before the first word (s). */
  preRollS: number;
  /** Kept after the last word (s) — a tight ending. */
  tailS: number;
  /** Minimum pad kept after a word's end before a cut (s). */
  minTailPadS: number;
  /** Minimum pad kept before a word's start after a cut (s). */
  minLeadPadS: number;
  /** Only remove a pause when it saves at least this much (s). */
  minRemovalS: number;
  /** Pauses at least this long are always removed, even if that makes a short shot. */
  alwaysCutGapS: number;
  /** Without measured silences: pad after a Whisper word end / before a word start (Whisper
   * ends words ~0.2 s early and starts them early after long pauses). */
  whisperTailPadS: number;
  whisperLeadPadS: number;
  /** A sound island with no words that's shorter than this (a breath, a click) counts as silence. */
  maxWordlessIslandS: number;
  /** Split long uninterrupted stretches purely to match the references' cut rate. Off: cuts
   * only where a pause/dead air was actually removed (see header, step 3). */
  rhythmCuts: boolean;
}

export const DEFAULT_STYLE_CUT_OPTIONS: StyleCutOptions = {
  preRollS: 0.12,
  tailS: 0.3,
  minTailPadS: 0.08,
  minLeadPadS: 0.06,
  minRemovalS: 0.12,
  alwaysCutGapS: 0.75,
  whisperTailPadS: 0.22,
  whisperLeadPadS: 0.1,
  maxWordlessIslandS: 0.3,
  rhythmCuts: false,
};

export interface StyleCutShot {
  sourceStart: number;
  sourceEnd: number;
  framing: StyleCutFramingName;
  /** "PAUSE" = the cut before this shot removed a pause; "RHYTHM" = framing change only;
   * "JOIN" = the first shot of the next part of a multi-part recording. */
  cutBefore: "START" | "PAUSE" | "RHYTHM" | "JOIN";
}

export interface StyleCutStats {
  sourceDurationS: number;
  outputDurationS: number;
  /** Pauses shortened inside the speech. */
  pausesRemoved: number;
  pauseSecondsRemoved: number;
  /** Dead air trimmed before the first / after the last word. */
  headTrimmedS: number;
  tailTrimmedS: number;
  cuts: number;
  pauseCuts: number;
  rhythmCuts: number;
  shotMedianS: number;
  shotP25S: number;
  shotP75S: number;
  firstCutS: number | null;
  /** Fraction of shots inside the target's [p25, p75] band. */
  shotsInBand: number;
  startsAfterS: number;
  endsAfterLastWordS: number;
  faceTracked: boolean;
  /** "AUDIO" = pauses measured from the sound; "WHISPER" = from word timings only (wider pads). */
  speechTiming: "AUDIO" | "WHISPER";
  /** Multi-part recordings only: parts joined, cuts at the joins, dead air trimmed at the joins
   * (each part's own start/end). */
  parts?: number;
  joinCuts?: number;
  joinTrimmedS?: number;
}

export type StyleCutResult =
  | {
      ok: true;
      version: typeof STYLE_CUT_VERSION;
      timeline: EditTimeline;
      shots: StyleCutShot[];
      stats: StyleCutStats;
      target: StyleCutTarget;
      /** One plain-English line for the editor. */
      summary: string;
      /** Where the pacing came from, in plain English. */
      profileNote: string;
      /** Stable key of every input — same key, same cut (idempotency). */
      inputsKey: string;
    }
  | { ok: false; reason: "NO_TRANSCRIPT" | "NO_DURATION"; message: string };

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const PHRASE_END = /[,;:—–-]["'”’)\]]*$/;

function q(t: number, mode: "floor" | "ceil" | "round"): number {
  const f = t / FRAME;
  // Tolerance so 0.1 + 0.2 style float noise doesn't jump a frame.
  const n = mode === "floor" ? Math.floor(f + 1e-6) : mode === "ceil" ? Math.ceil(f - 1e-6) : Math.round(f);
  return Math.round(n * FRAME * 1e6) / 1e6;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
function r6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** FNV-1a 32-bit over a string, hex. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function cleanWords(words: TranscriptWord[] | null | undefined, duration: number): TranscriptWord[] {
  return (words ?? [])
    .filter((w) => w && typeof w.word === "string" && w.word.trim() && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => ({ word: w.word.trim(), start: clamp(w.start, 0, duration), end: clamp(Math.max(w.start, w.end), 0, duration) }))
    .filter((w) => w.end > w.start || w.word.length > 0)
    .sort((a, b) => a.start - b.start);
}

interface Segment {
  start: number;
  end: number;
  /** Index range (into SpeechMap.pauses) of the pauses inside this segment. */
  firstPause: number;
  lastPause: number;
}

/** A silence between two stretches of speech (source seconds). */
interface Pause {
  start: number;
  end: number;
  /** The speech before it ends a sentence / a phrase (Whisper punctuation). */
  sentenceEnd: boolean;
  phraseEnd: boolean;
}

interface SpeechMap {
  mode: "AUDIO" | "WHISPER";
  /** Where speech starts / ends. */
  start: number;
  end: number;
  pauses: Pause[];
}

/**
 * Pure. Where the speech and the pauses are. With measured silences (AUDIO): the sound
 * "islands" between silences are the speech; each Whisper word is assigned to the island it
 * overlaps most (in order), so punctuation tells which pauses end sentences. Wordless islands
 * shorter than `maxWordlessIslandS` (breaths, clicks) count as silence; longer ones are kept
 * (they may be words Whisper missed). Without silences (WHISPER): the gaps between words.
 */
export function speechMap(
  words: TranscriptWord[],
  duration: number,
  silences: Array<{ start: number; end: number }> | null,
  maxWordlessIslandS = DEFAULT_STYLE_CUT_OPTIONS.maxWordlessIslandS,
): SpeechMap {
  const sentence = (w: TranscriptWord | undefined) => !!w && SENTENCE_END.test(w.word);
  const phrase = (w: TranscriptWord | undefined) => !!w && PHRASE_END.test(w.word);
  const sil = (silences ?? [])
    .map((s) => ({ start: clamp(s.start, 0, duration), end: clamp(s.end, 0, duration) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  if (sil.length > 0) {
    // Islands = the complement of the silences.
    let islands: Array<{ start: number; end: number; words: number[] }> = [];
    let t = 0;
    for (const s of sil) {
      if (s.start > t + 1e-6) islands.push({ start: t, end: s.start, words: [] });
      t = Math.max(t, s.end);
    }
    if (duration > t + 1e-6) islands.push({ start: t, end: duration, words: [] });
    if (islands.length > 0) {
      let prev = 0;
      words.forEach((w, wi) => {
        let best = prev;
        let bestScore = -Infinity;
        for (let k = prev; k < islands.length; k++) {
          const isl = islands[k]!;
          if (isl.start > w.end + 2) break;
          const overlap = Math.min(w.end, isl.end) - Math.max(w.start, isl.start);
          const score = overlap > 0 ? overlap : -Math.max(isl.start - w.end, w.start - isl.end);
          if (score > bestScore + 1e-9) {
            bestScore = score;
            best = k;
          }
        }
        islands[best]!.words.push(wi);
        prev = best;
      });
      islands = islands.filter((isl) => isl.words.length > 0 || isl.end - isl.start >= maxWordlessIslandS);
      const firstW = islands.findIndex((isl) => isl.words.length > 0);
      let lastW = -1;
      islands.forEach((isl, k) => {
        if (isl.words.length > 0) lastW = k;
      });
      if (firstW >= 0) {
        const kept = islands.slice(firstW, lastW + 1);
        const pauses: Pause[] = [];
        let lastWord: TranscriptWord | undefined;
        for (let k = 0; k < kept.length - 1; k++) {
          const a = kept[k]!;
          if (a.words.length) lastWord = words[a.words[a.words.length - 1]!];
          pauses.push({ start: a.end, end: kept[k + 1]!.start, sentenceEnd: sentence(lastWord), phraseEnd: phrase(lastWord) });
        }
        return { mode: "AUDIO", start: kept[0]!.start, end: kept[kept.length - 1]!.end, pauses };
      }
    }
  }
  const pauses: Pause[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i]!;
    const b = words[i + 1]!;
    if (b.start - a.end <= 0) continue;
    pauses.push({ start: a.end, end: b.start, sentenceEnd: sentence(a), phraseEnd: phrase(a) });
  }
  return { mode: "WHISPER", start: words[0]!.start, end: words[words.length - 1]!.end, pauses };
}

/** One take of a multi-part recording (segmented teleprompter recording), in playback order. */
export interface StyleCutTakeInput {
  mediaAssetId: string;
  words: TranscriptWord[] | null | undefined;
  durationSeconds: number;
  subjectTrack?: SubjectTrack | null;
  sourceSize?: { width: number; height: number } | null;
  silences?: Array<{ start: number; end: number }> | null;
}

/**
 * A style cut of SEVERAL takes played in order — the segments of one recording session
 * (record → pause → record …). Each take is cut on its own (dead air at its start and end
 * trimmed, pauses inside it removed) and the results are concatenated in order; every join is
 * a cut, and the framing alternation continues across joins.
 */
export interface StyleCutSequenceInput {
  base: EditTimeline;
  takes: StyleCutTakeInput[];
  target?: StyleCutTarget;
  options?: Partial<StyleCutOptions>;
}

/** Shot of a multi-take cut: which take it comes from. */
export interface StyleCutSequenceShot extends StyleCutShot {
  mediaAssetId: string;
  takeIndex: number;
}

interface TakeCut {
  shots: StyleCutShot[];
  speech: SpeechMap;
  start: number;
  end: number;
  pausesRemoved: number;
  pauseSecondsRemoved: number;
}

/**
 * Pure: steps 1–3 for one take. `shotOffset` = shots already placed before this take (framing
 * continues across joins); `firstTake` = this take opens the video (the opening-shot rules).
 */
function cutOneTake(
  words: TranscriptWord[],
  duration: number,
  silences: Array<{ start: number; end: number }> | null,
  opts: StyleCutOptions,
  target: StyleCutTarget,
  shotOffset: number,
  firstTake: boolean,
): TakeCut {
  // ---- 1+2. Speech segments: dead air trimmed, long pauses shortened ----------------------
  const speech = speechMap(words, duration, silences);
  const audio = speech.mode === "AUDIO";
  // Whisper's word ends run early (see speech-activity.ts) — without measured silences, pad more.
  const minTailPad = audio ? opts.minTailPadS : Math.max(opts.minTailPadS, opts.whisperTailPadS);
  const minLeadPad = audio ? opts.minLeadPadS : Math.max(opts.minLeadPadS, opts.whisperLeadPadS);
  const start = Math.max(0, q(speech.start - opts.preRollS, "floor"));
  const end = Math.min(duration, q(speech.end + (audio ? opts.tailS : Math.max(opts.tailS, opts.whisperTailPadS)), "ceil"));
  const minShot = Math.max(0.8, target.shotP25S * 0.5);
  const minFirstShot = Math.max(minShot, target.firstCutS * 0.6);

  const segments: Segment[] = [];
  let seg: Segment = { start, end, firstPause: 0, lastPause: speech.pauses.length - 1 };
  let pausesRemoved = 0;
  let pauseSecondsRemoved = 0;
  const removed = new Set<number>();
  speech.pauses.forEach((p, pi) => {
    const gap = p.end - p.start;
    const keep = p.sentenceEnd ? target.sentencePauseKeepS : target.pauseKeepS;
    if (gap - keep < opts.minRemovalS) return;
    // Pads: ~60 % of the kept pause after the speech (breath/release), ~40 % before the next.
    const tailPad = Math.max(minTailPad, keep * 0.6);
    const leadPad = Math.max(minLeadPad, keep * 0.4);
    const cutOut = q(p.start + tailPad, "ceil");
    const cutIn = q(p.end - leadPad, "floor");
    if (!(cutIn - cutOut >= opts.minRemovalS - 1e-9)) return;
    if (cutOut <= seg.start || cutIn >= end) return;
    // A short pause that would make a too-short shot stays (unless it's a long silence).
    const shotSoFar = cutOut - seg.start;
    const minHere = firstTake && segments.length === 0 ? minFirstShot : minShot;
    if (gap < opts.alwaysCutGapS && shotSoFar < minHere) return;
    segments.push({ start: seg.start, end: cutOut, firstPause: seg.firstPause, lastPause: pi - 1 });
    removed.add(pi);
    pausesRemoved++;
    pauseSecondsRemoved += cutIn - cutOut;
    seg = { start: cutIn, end, firstPause: pi + 1, lastPause: speech.pauses.length - 1 };
  });
  segments.push(seg);

  // ---- 3. Rhythm: split long segments at natural boundaries ------------------------------
  interface Boundary {
    /** Source time of the cut (frame-quantized, never inside a word). */
    t: number;
    score: number;
  }
  const boundariesIn = (s: Segment): Boundary[] => {
    const out: Boundary[] = [];
    // Kept pauses (real silence) are the best places for a framing change.
    for (let pi = s.firstPause; pi <= s.lastPause; pi++) {
      const p = speech.pauses[pi]!;
      if (removed.has(pi)) continue;
      const t = clamp(q((p.start + p.end) / 2, "round"), q(p.start, "ceil"), q(p.end, "floor"));
      if (t <= s.start + FRAME || t >= s.end - FRAME) continue;
      const gap = p.end - p.start;
      let score = p.sentenceEnd ? 0.45 : p.phraseEnd ? 0.25 : 0;
      score += gap >= 0.12 ? 0.15 : gap >= 0.04 ? 0.05 : -0.3;
      out.push({ t, score });
    }
    // In AUDIO mode also Whisper word boundaries inside continuous speech (a framing-only cut
    // on contiguous source has no audio splice, so word-edge drift only shifts the picture).
    if (audio) {
      for (let i = 0; i < words.length - 1; i++) {
        const a = words[i]!;
        const b = words[i + 1]!;
        if (b.start - a.end < -0.02) continue;
        const t = q((a.end + b.start) / 2, "round");
        if (t <= s.start + FRAME || t >= s.end - FRAME) continue;
        if (out.some((o) => Math.abs(o.t - t) < 0.15)) continue;
        if (speech.pauses.some((p) => t > p.start - 0.05 && t < p.end + 0.05)) continue;
        out.push({ t, score: (SENTENCE_END.test(a.word) ? 0.3 : PHRASE_END.test(a.word) ? 0.15 : 0) - 0.15 });
      }
    }
    return out.sort((x, y) => x.t - y.t);
  };

  const shots: StyleCutShot[] = [];
  segments.forEach((s, si) => {
    const cuts: number[] = [];
    const bounds = boundariesIn(s);
    let cursor = s.start;
    const remaining = () => s.end - cursor;
    for (let guard = 0; opts.rhythmCuts && guard < 500; guard++) {
      const isFirstShot = firstTake && shots.length === 0 && cuts.length === 0;
      const rem = remaining();
      // The opening shot aims at the target first-cut time; every other shot is split only
      // when it would run past p75, aiming at the median.
      const want = isFirstShot ? target.firstCutS : target.shotMedianS;
      const tooLong = isFirstShot ? rem > target.firstCutS + target.shotP25S : rem > target.shotP75S;
      if (!tooLong) break;
      const lo = isFirstShot ? Math.max(minShot, target.firstCutS * 0.75) : target.shotP25S;
      const hi = isFirstShot ? target.firstCutS * 1.35 : target.shotP75S;
      // Leave a last piece at least p25 long (or the min shot) when splitting.
      const tailMin = Math.min(target.shotP25S, Math.max(minShot, rem / 2));
      let best: Boundary | null = null;
      let bestScore = -Infinity;
      for (const b of bounds) {
        const len = b.t - cursor;
        if (len < lo * 0.85 || len > hi * 1.15) continue;
        if (s.end - b.t < tailMin) continue;
        const inBand = len >= lo && len <= hi;
        const score = b.score - Math.abs(len - want) / Math.max(0.5, want) - (inBand ? 0 : 0.4);
        if (score > bestScore) {
          bestScore = score;
          best = b;
        }
      }
      if (!best) break; // no safe word boundary — keep the long shot rather than cut mid-word
      cuts.push(best.t);
      cursor = best.t;
    }
    const edges = [s.start, ...cuts, s.end];
    for (let k = 0; k < edges.length - 1; k++) {
      const first = shots.length === 0 && k === 0;
      shots.push({
        sourceStart: edges[k]!,
        sourceEnd: edges[k + 1]!,
        framing: framingForShot(shotOffset + shots.length),
        cutBefore: first ? (firstTake ? "START" : "JOIN") : k === 0 && si > 0 ? "PAUSE" : "RHYTHM",
      });
    }
  });
  return { shots, speech, start, end, pausesRemoved, pauseSecondsRemoved };
}

interface ShotGeometry {
  mediaAssetId: string;
  track: SubjectTrack | null;
  src: { width: number; height: number };
}

/** Pure: step 4 — clips with face-centred punch-ins; never the same framing twice in a row
 * (across take joins too). Mutates `shots[i].framing` to the framing actually used. */
function framedClips(shots: StyleCutShot[], geo: ShotGeometry[], base: EditTimeline): TimelineClip[] {
  const canvas = base.canvas;
  const captionTop = clamp(base.captions.y - 0.06, 0.4, 0.95);
  const clips: TimelineClip[] = shots.map((shot, i) => {
    const g = geo[i]!;
    const face = g.track ? faceOverShot(g.track, shot.sourceStart, shot.sourceEnd) : null;
    const crop = cropFor(shot.framing, face, g.src, canvas, captionTop)!;
    return {
      id: `clip-${i + 1}`,
      mediaAssetId: g.mediaAssetId,
      sourceStart: r6(shot.sourceStart),
      sourceEnd: r6(shot.sourceEnd),
      crop,
      volume: 1,
    };
  });
  // Framing actually used (cropFor may step a punch-in down to keep the head in frame).
  shots.forEach((s, i) => {
    const z = clips[i]!.crop.zoom;
    s.framing = (STYLE_CUT_FRAMINGS.find((f) => Math.abs(f.zoom - z) < 1e-6)?.name ?? s.framing) as StyleCutFramingName;
  });
  // Never the same framing twice in a row: if a step-down made two neighbours equal, the
  // later one moves to the other punch-in (or WIDE).
  for (let i = 1; i < clips.length; i++) {
    if (Math.abs(clips[i]!.crop.zoom - clips[i - 1]!.crop.zoom) < 1e-6) {
      const g = geo[i]!;
      for (const f of STYLE_CUT_FRAMINGS) {
        if (Math.abs(f.zoom - clips[i - 1]!.crop.zoom) < 1e-6) continue;
        const face = g.track ? faceOverShot(g.track, shots[i]!.sourceStart, shots[i]!.sourceEnd) : null;
        const crop = cropFor(f.name, face, g.src, canvas, captionTop, false);
        if (crop) {
          clips[i]!.crop = crop;
          shots[i]!.framing = f.name;
          break;
        }
      }
    }
  }
  return clips;
}

function styleCutTimeline(base: EditTimeline, clips: TimelineClip[]): EditTimeline {
  return EditTimelineSchema.parse({
    ...base,
    clips,
    texts: [],
    zooms: [],
    visuals: [],
    sfx: [],
    coverFrameSeconds: null,
    captions: { ...base.captions, enabled: true },
    audio: { ...base.audio, normalize: true },
  });
}

function profileNoteFor(target: StyleCutTarget): string {
  return target.source.kind === "REFERENCES"
    ? `Paced like your ${target.source.sampleSize} reference ${target.source.sampleSize === 1 ? "video" : "videos"}${target.source.creatorCount > 1 ? ` (${target.source.creatorCount} creators)` : ""}.`
    : target.source.sampleSize > 0
      ? `Standard short-form pacing — only ${target.source.sampleSize} reference ${target.source.sampleSize === 1 ? "video is" : "videos are"} measured so far; add a few more to match your creators.`
      : "Standard short-form pacing — add reference videos to match your creators.";
}

function shotStats(shots: StyleCutShot[], target: StyleCutTarget) {
  const lens = shots.map((s) => s.sourceEnd - s.sourceStart);
  const sorted = [...lens].sort((a, b) => a - b);
  const outputDurationS = lens.reduce((a, b) => a + b, 0);
  const inner = lens.length > 2 ? lens.slice(1, -1) : lens; // the first/last shot are special
  const shotsInBand = inner.length ? inner.filter((l) => l >= target.shotP25S - 1e-6 && l <= target.shotP75S + 1e-6).length / inner.length : 1;
  return { lens, sorted, outputDurationS, shotsInBand };
}

function trackOrNull(t: SubjectTrack | null | undefined): SubjectTrack | null {
  return t && t.some((s) => s.box) ? t : null;
}

/**
 * Pure. Builds the style cut — of one take (`StyleCutInput`), or of several takes played in
 * order (`StyleCutSequenceInput`, the segments of one recording). Same inputs → identical
 * output (and `inputsKey`). A one-take sequence is exactly the single-take cut.
 */
export function buildStyleCut(input: StyleCutInput | StyleCutSequenceInput): StyleCutResult {
  if ("takes" in input) {
    const only = input.takes.length === 1 ? input.takes[0]! : null;
    if (!only) return buildSequenceCut(input);
    return buildStyleCut({ base: input.base, target: input.target, options: input.options, ...only });
  }
  const opts: StyleCutOptions = { ...DEFAULT_STYLE_CUT_OPTIONS, ...input.options };
  const target = input.target ?? DEFAULT_STYLE_CUT_TARGET;
  const duration = input.durationSeconds;
  if (!(duration > 0)) return { ok: false, reason: "NO_DURATION", message: "This take has no length yet — wait for it to finish processing." };
  const words = cleanWords(input.words, duration);
  if (words.length === 0) {
    return { ok: false, reason: "NO_TRANSCRIPT", message: "Style cut needs captions first — they appear once your words are transcribed." };
  }

  const { shots, speech, start, end, pausesRemoved, pauseSecondsRemoved } = cutOneTake(words, duration, input.silences ?? null, opts, target, 0, true);

  // ---- 4. Framing per shot (face-centred punch-ins) ---------------------------------------
  const canvas = input.base.canvas;
  const src = input.sourceSize && input.sourceSize.width > 0 && input.sourceSize.height > 0 ? input.sourceSize : canvas;
  const track = trackOrNull(input.subjectTrack);
  const clips = framedClips(
    shots,
    shots.map(() => ({ mediaAssetId: input.mediaAssetId, track, src })),
    input.base,
  );

  // ---- 5. Timeline --------------------------------------------------------------------------
  const timeline = styleCutTimeline(input.base, clips);

  // ---- Stats + summary ----------------------------------------------------------------------
  const { lens, sorted, outputDurationS, shotsInBand } = shotStats(shots, target);
  const pauseCuts = shots.filter((s) => s.cutBefore === "PAUSE").length;
  const rhythmCuts = shots.filter((s) => s.cutBefore === "RHYTHM").length;
  const stats: StyleCutStats = {
    sourceDurationS: r3(duration),
    outputDurationS: r3(outputDurationS),
    pausesRemoved,
    pauseSecondsRemoved: r3(pauseSecondsRemoved),
    headTrimmedS: r3(start),
    tailTrimmedS: r3(Math.max(0, duration - end)),
    cuts: shots.length - 1,
    pauseCuts,
    rhythmCuts,
    shotMedianS: r2(quantile(sorted, 0.5)),
    shotP25S: r2(quantile(sorted, 0.25)),
    shotP75S: r2(quantile(sorted, 0.75)),
    firstCutS: shots.length > 1 ? r2(lens[0]!) : null,
    shotsInBand: r2(shotsInBand),
    startsAfterS: r2(Math.max(0, speech.start - start)),
    endsAfterLastWordS: r2(Math.max(0, end - speech.end)),
    faceTracked: !!track,
    speechTiming: speech.mode,
  };

  const parts: string[] = [];
  const trimmed = stats.pauseSecondsRemoved + stats.headTrimmedS + stats.tailTrimmedS;
  if (pausesRemoved > 0) parts.push(`Removed ${pausesRemoved} ${pausesRemoved === 1 ? "pause" : "pauses"} (${fmtS(pauseSecondsRemoved)})`);
  else parts.push(trimmed >= 0.1 ? `Trimmed ${fmtS(trimmed)} of dead air` : "No long pauses to remove");
  if (stats.cuts > 0) parts.push(`${stats.cuts} ${stats.cuts === 1 ? "cut" : "cuts"}, one every ${fmtS(outputDurationS / shots.length)}`);
  parts.push(stats.startsAfterS <= 0.2 ? "starts on your first word" : `starts ${fmtS(stats.startsAfterS)} before your first word`);
  parts.push(`ends ${fmtS(stats.endsAfterLastWordS)} after your last`);
  const summary = parts.join(" · ");
  const profileNote = profileNoteFor(target);

  const inputsKey = `v${STYLE_CUT_VERSION}-${hash(
    JSON.stringify({
      a: input.mediaAssetId,
      d: r3(duration),
      w: words.map((w) => [w.word, r3(w.start), r3(w.end)]),
      t: track ? track.map((s) => [r3(s.t), s.box ? [r3(s.box.x), r3(s.box.y), r3(s.box.w), r3(s.box.h)] : null]) : null,
      s: input.sourceSize ?? null,
      z: input.silences ? input.silences.map((x) => [r3(x.start), r3(x.end)]) : null,
      g: { ...target, source: undefined },
      o: opts,
      c: [canvas.width, canvas.height, input.base.captions.y],
    }),
  )}`;

  return { ok: true, version: STYLE_CUT_VERSION, timeline, shots, stats, target, summary, profileNote, inputsKey };
}

/**
 * Pure: the multi-take cut. A take with no transcribed words is kept whole (without words we
 * can't tell speech from dead air — it might be a deliberate silent beat); a take with no
 * length is skipped. At least one take must have words.
 */
function buildSequenceCut(input: StyleCutSequenceInput): StyleCutResult {
  const opts: StyleCutOptions = { ...DEFAULT_STYLE_CUT_OPTIONS, ...input.options };
  const target = input.target ?? DEFAULT_STYLE_CUT_TARGET;
  const takes = input.takes.filter((t) => t.durationSeconds > 0);
  if (takes.length === 0) return { ok: false, reason: "NO_DURATION", message: "These parts have no length yet — wait for them to finish processing." };
  const cleaned = takes.map((t) => cleanWords(t.words, t.durationSeconds));
  if (cleaned.every((w) => w.length === 0)) {
    return { ok: false, reason: "NO_TRANSCRIPT", message: "Style cut needs captions first — they appear once your words are transcribed." };
  }
  const canvas = input.base.canvas;
  const shots: StyleCutSequenceShot[] = [];
  const geo: ShotGeometry[] = [];
  let pausesRemoved = 0;
  let pauseSecondsRemoved = 0;
  let headTrimmedS = 0;
  let tailTrimmedS = 0;
  let joinTrimmedS = 0;
  let startsAfterS = 0;
  let endsAfterLastWordS = 0;
  let allAudio = true;
  let anyTrack = false;
  takes.forEach((t, ti) => {
    const words = cleaned[ti]!;
    const src = t.sourceSize && t.sourceSize.width > 0 && t.sourceSize.height > 0 ? t.sourceSize : canvas;
    const track = trackOrNull(t.subjectTrack);
    if (track) anyTrack = true;
    const first = shots.length === 0;
    const last = ti === takes.length - 1;
    let takeShots: StyleCutShot[];
    let head = 0;
    let tail = 0;
    if (words.length === 0) {
      const whole = q(t.durationSeconds, "floor") || t.durationSeconds;
      takeShots = [{ sourceStart: 0, sourceEnd: whole, framing: framingForShot(shots.length), cutBefore: first ? "START" : "JOIN" }];
      allAudio = false;
    } else {
      const c = cutOneTake(words, t.durationSeconds, t.silences ?? null, opts, target, shots.length, first);
      takeShots = c.shots;
      pausesRemoved += c.pausesRemoved;
      pauseSecondsRemoved += c.pauseSecondsRemoved;
      head = c.start;
      tail = Math.max(0, t.durationSeconds - c.end);
      if (c.speech.mode !== "AUDIO") allAudio = false;
      if (first) startsAfterS = Math.max(0, c.speech.start - c.start);
      if (last) endsAfterLastWordS = Math.max(0, c.end - c.speech.end);
    }
    if (first) headTrimmedS = head;
    else joinTrimmedS += head;
    if (last) tailTrimmedS = tail;
    else joinTrimmedS += tail;
    for (const s of takeShots) {
      shots.push({ ...s, mediaAssetId: t.mediaAssetId, takeIndex: ti });
      geo.push({ mediaAssetId: t.mediaAssetId, track, src });
    }
  });

  const clips = framedClips(shots, geo, input.base);
  const timeline = styleCutTimeline(input.base, clips);
  const { lens, sorted, outputDurationS, shotsInBand } = shotStats(shots, target);
  const stats: StyleCutStats = {
    sourceDurationS: r3(takes.reduce((a, t) => a + t.durationSeconds, 0)),
    outputDurationS: r3(outputDurationS),
    pausesRemoved,
    pauseSecondsRemoved: r3(pauseSecondsRemoved),
    headTrimmedS: r3(headTrimmedS),
    tailTrimmedS: r3(tailTrimmedS),
    cuts: shots.length - 1,
    pauseCuts: shots.filter((s) => s.cutBefore === "PAUSE").length,
    rhythmCuts: shots.filter((s) => s.cutBefore === "RHYTHM").length,
    shotMedianS: r2(quantile(sorted, 0.5)),
    shotP25S: r2(quantile(sorted, 0.25)),
    shotP75S: r2(quantile(sorted, 0.75)),
    firstCutS: shots.length > 1 ? r2(lens[0]!) : null,
    shotsInBand: r2(shotsInBand),
    startsAfterS: r2(startsAfterS),
    endsAfterLastWordS: r2(endsAfterLastWordS),
    faceTracked: anyTrack,
    speechTiming: allAudio ? "AUDIO" : "WHISPER",
    parts: takes.length,
    joinCuts: shots.filter((s) => s.cutBefore === "JOIN").length,
    joinTrimmedS: r3(joinTrimmedS),
  };

  const parts: string[] = [`Joined your ${takes.length} parts${joinTrimmedS >= 0.1 ? ` (${fmtS(joinTrimmedS)} of dead air cut at the joins)` : ""}`];
  if (pausesRemoved > 0) parts.push(`removed ${pausesRemoved} ${pausesRemoved === 1 ? "pause" : "pauses"} (${fmtS(pauseSecondsRemoved)})`);
  if (stats.cuts > 0) parts.push(`${stats.cuts} ${stats.cuts === 1 ? "cut" : "cuts"}, one every ${fmtS(outputDurationS / shots.length)}`);
  parts.push(stats.startsAfterS <= 0.2 ? "starts on your first word" : `starts ${fmtS(stats.startsAfterS)} before your first word`);
  parts.push(`ends ${fmtS(stats.endsAfterLastWordS)} after your last`);

  const inputsKey = `v${STYLE_CUT_VERSION}-seq-${hash(
    JSON.stringify({
      takes: takes.map((t, ti) => ({
        a: t.mediaAssetId,
        d: r3(t.durationSeconds),
        w: cleaned[ti]!.map((w) => [w.word, r3(w.start), r3(w.end)]),
        t: trackOrNull(t.subjectTrack)?.map((s) => [r3(s.t), s.box ? [r3(s.box.x), r3(s.box.y), r3(s.box.w), r3(s.box.h)] : null]) ?? null,
        s: t.sourceSize ?? null,
        z: t.silences ? t.silences.map((x) => [r3(x.start), r3(x.end)]) : null,
      })),
      g: { ...target, source: undefined },
      o: opts,
      c: [canvas.width, canvas.height, input.base.captions.y],
    }),
  )}`;

  return { ok: true, version: STYLE_CUT_VERSION, timeline, shots, stats, target, summary: parts.join(" · "), profileNote: profileNoteFor(target), inputsKey };
}

function fmtS(s: number): string {
  return `${(Math.round(s * 10) / 10).toFixed(1)} s`;
}

/** The tracked box is the PROTECTED head region (face + hair/ear margins); a punch-in may crop
 * those margins (editors crop the top of the hair all the time) but never the face itself. */
export function faceFromProtectedRegion(b: NormBox): NormBox {
  const e = PROTECTED_HEAD_EXPANSION;
  const w = b.w / (1 + 2 * e.sides);
  const h = b.h / (1 + e.top + e.bottom);
  return { x: b.x + e.sides * w, y: b.y + e.top * h, w, h };
}

/** The face over a shot: the union of its boxes (safety) and their median centre (aim). */
function faceOverShot(track: SubjectTrack, s0: number, s1: number): { union: NormBox; cx: number; cy: number } | null {
  const boxes: NormBox[] = [];
  const step = 0.25;
  for (let t = s0; t <= s1 + 1e-9; t += step) {
    const b = subjectBoxAt(track, t);
    if (b) boxes.push(faceFromProtectedRegion(b));
  }
  if (boxes.length === 0) return null;
  const cxs = boxes.map((b) => b.x + b.w / 2).sort((a, b) => a - b);
  const cys = boxes.map((b) => b.y + b.h / 2).sort((a, b) => a - b);
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w));
  const y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { union: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, cx: quantile(cxs, 0.5), cy: quantile(cys, 0.5) };
}

/** No face track: assume a typical talking head (centred, eyes in the upper third). */
const ASSUMED_FACE = { cx: 0.5, cy: 0.36 };

/**
 * Crop (zoom + pan) for a framing. Pan maps the visible window (as the renderer computes it:
 * cover-scale × zoom, then crop at (overflow × (pan+1)/2)) so the face centre stays where it
 * sits in the WIDE shot horizontally centred — a punch-in reads as "closer", not "re-framed".
 * A punch-in that would push the head out of frame or into the caption band steps down to a
 * smaller zoom (with `stepDown` false, returns null instead).
 */
function cropFor(
  framing: StyleCutFramingName,
  face: { union: NormBox; cx: number; cy: number } | null,
  src: { width: number; height: number },
  canvas: { width: number; height: number },
  captionTop: number,
  stepDown = true,
): { zoom: number; panX: number; panY: number } | null {
  const order = STYLE_CUT_FRAMINGS.map((f) => f.name);
  let idx = order.indexOf(framing);
  for (;;) {
    const zoom = STYLE_CUT_FRAMINGS[idx]!.zoom;
    const res = windowFor(zoom, face, src, canvas);
    const safe = !face || headFits(res, face.union, captionTop);
    if (safe || zoom === 1) return { zoom, panX: res.panX, panY: res.panY };
    if (!stepDown) return null;
    idx--;
  }
}

interface Window {
  panX: number;
  panY: number;
  /** Visible window in source fractions. */
  left: number;
  top: number;
  fw: number;
  fh: number;
}

function windowFor(zoom: number, face: { cx: number; cy: number } | null, src: { width: number; height: number }, canvas: { width: number; height: number }): Window {
  const cover = Math.max(canvas.width / src.width, canvas.height / src.height) * zoom;
  const fw = Math.min(1, canvas.width / (src.width * cover));
  const fh = Math.min(1, canvas.height / (src.height * cover));
  const f = face ?? ASSUMED_FACE;
  // Where the face sits vertically in the WIDE (zoom 1) shot — keep it there, within reason.
  const cover1 = Math.max(canvas.width / src.width, canvas.height / src.height);
  const fh1 = Math.min(1, canvas.height / (src.height * cover1));
  const top1 = (1 - fh1) / 2;
  const ty = clamp((f.cy - top1) / fh1, 0.3, 0.45);
  const pan = (overflow: number, desiredStart: number) => (overflow < 1e-6 ? 0 : clamp((2 * desiredStart) / overflow - 1, -1, 1));
  const panX = pan(1 - fw, f.cx - fw * 0.5);
  const panY = pan(1 - fh, f.cy - fh * ty);
  const left = (1 - fw) * ((panX + 1) / 2);
  const top = (1 - fh) * ((panY + 1) / 2);
  return { panX: r3(panX), panY: r3(panY), left, top, fw, fh };
}

/** The face (source box) inside the visible window, clear of the edges and the caption band. */
function headFits(w: Window, head: NormBox, captionTop: number): boolean {
  const x1 = (head.x - w.left) / w.fw;
  const x2 = (head.x + head.w - w.left) / w.fw;
  const y1 = (head.y - w.top) / w.fh;
  const y2 = (head.y + head.h - w.top) / w.fh;
  return x1 >= 0.02 && x2 <= 0.98 && y1 >= 0.02 && y2 <= captionTop;
}
