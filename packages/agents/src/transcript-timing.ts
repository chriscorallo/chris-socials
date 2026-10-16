import type { TranscriptWord } from "./transcription-provider";

/**
 * Deterministic helpers that ground the Edit Planner / Take Selector in real speech timing.
 * Pure functions — no model calls (CLAUDE.md: arithmetic is code, not judgment).
 */

export interface TranscriptPhrase {
  start: number;
  end: number;
  text: string;
}

const SENTENCE_END = /[.!?…]["'”’)]*$/;

/**
 * Groups words into sentence/phrase-level segments: breaks at sentence-ending punctuation,
 * at pauses longer than `pauseThresholdSeconds`, and at `maxPhraseSeconds`. These are the
 * natural cut points the planner should choose between.
 */
export function buildTranscriptPhrases(
  words: TranscriptWord[],
  options: { pauseThresholdSeconds?: number; maxPhraseSeconds?: number } = {},
): TranscriptPhrase[] {
  const pause = options.pauseThresholdSeconds ?? 0.3;
  const maxLen = options.maxPhraseSeconds ?? 8;
  const sorted = [...words].filter((w) => w.word.trim()).sort((a, b) => a.start - b.start);
  const phrases: TranscriptPhrase[] = [];
  let current: TranscriptWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    phrases.push({
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
      text: current.map((w) => w.word.trim()).join(" "),
    });
    current = [];
  };
  for (const w of sorted) {
    const prev = current[current.length - 1];
    if (prev) {
      const gap = w.start - prev.end;
      if (
        gap > pause ||
        SENTENCE_END.test(prev.word.trim()) ||
        w.end - current[0]!.start > maxLen
      ) {
        flush();
      }
    }
    current.push(w);
  }
  flush();
  return phrases;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

/** "[0.00-2.18] Most people think..." one phrase per line, plus the pause before it. */
export function formatTimestampedTranscript(phrases: TranscriptPhrase[]): string {
  return phrases
    .map((p, i) => {
      const prevEnd = i > 0 ? phrases[i - 1]!.end : 0;
      const gap = p.start - prevEnd;
      const pauseNote = i > 0 && gap >= 0.3 ? ` (pause ${gap.toFixed(2)}s before)` : "";
      return `[${fmt(p.start)}-${fmt(p.end)}]${pauseNote} ${p.text}`;
    })
    .join("\n");
}

export interface SnapOptions {
  sourceDurationSeconds?: number | null;
  /** Breathing room kept before the first kept word / after the last kept word. */
  preRollSeconds?: number;
  postRollSeconds?: number;
  /** A cut point further than this from any word boundary (and not inside a word) is left
   * alone — it's already in silence. */
  maxSnapSeconds?: number;
}

export interface SnapResult {
  segments: Array<{ startSeconds: number; endSeconds: number }>;
  adjustments: string[];
}

/**
 * Snaps model-chosen cut points onto real speech boundaries. A segment start moves to just
 * before the nearest word onset; a segment end moves to just after the nearest word offset;
 * a cut that lands inside a word always moves to that word's edge (a clipped syllable is
 * the most obvious "this was edited by a machine" tell). Pre/post-roll never reaches into
 * the neighbouring word.
 */
export function snapSegmentsToWordBoundaries(
  segments: Array<{ startSeconds: number; endSeconds: number }>,
  words: TranscriptWord[],
  options: SnapOptions = {},
): SnapResult {
  const pre = options.preRollSeconds ?? 0.08;
  const post = options.postRollSeconds ?? 0.15;
  const maxSnap = options.maxSnapSeconds ?? 0.75;
  const duration = options.sourceDurationSeconds ?? Number.POSITIVE_INFINITY;
  const ws = [...words].filter((w) => w.end > w.start).sort((a, b) => a.start - b.start);
  const adjustments: string[] = [];
  if (ws.length === 0) return { segments: segments.map((s) => ({ ...s })), adjustments };

  const snapStart = (t: number): number => {
    const inside = ws.findIndex((w) => t > w.start && t < w.end);
    let idx: number;
    if (inside >= 0) {
      const w = ws[inside]!;
      // Nearer edge: keep the whole word (its start) or drop it (next word's start).
      idx = t - w.start <= w.end - t || inside === ws.length - 1 ? inside : inside + 1;
    } else {
      idx = -1;
      let best = Infinity;
      ws.forEach((w, i) => {
        const d = Math.abs(w.start - t);
        if (d < best) {
          best = d;
          idx = i;
        }
      });
      if (best > maxSnap) return t;
    }
    const w = ws[idx]!;
    const prevEnd = idx > 0 ? ws[idx - 1]!.end : 0;
    return Math.max(prevEnd, w.start - pre, 0);
  };

  const snapEnd = (t: number): number => {
    const inside = ws.findIndex((w) => t > w.start && t < w.end);
    let idx: number;
    if (inside >= 0) {
      const w = ws[inside]!;
      idx = w.end - t <= t - w.start || inside === 0 ? inside : inside - 1;
    } else {
      idx = -1;
      let best = Infinity;
      ws.forEach((w, i) => {
        const d = Math.abs(w.end - t);
        if (d < best) {
          best = d;
          idx = i;
        }
      });
      if (best > maxSnap) return Math.min(t, duration);
    }
    const w = ws[idx]!;
    const nextStart = idx < ws.length - 1 ? ws[idx + 1]!.start : duration;
    return Math.min(nextStart, w.end + post, duration);
  };

  const out: SnapResult["segments"] = [];
  for (const seg of segments) {
    let start = round3(snapStart(seg.startSeconds));
    let end = round3(snapEnd(seg.endSeconds));
    const prev = out[out.length - 1];
    if (prev && start < prev.endSeconds) start = prev.endSeconds;
    if (end - start < 0.1) {
      start = seg.startSeconds;
      end = seg.endSeconds;
    }
    if (start !== seg.startSeconds || end !== seg.endSeconds) {
      adjustments.push(
        `segment ${fmt(seg.startSeconds)}-${fmt(seg.endSeconds)}s snapped to ${fmt(start)}-${fmt(end)}s`,
      );
    }
    out.push({ startSeconds: start, endSeconds: end });
  }
  return { segments: out, adjustments };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
