/**
 * Caption word remapping + chunking — PURE (no Node/ffmpeg/font imports), so the browser
 * finishing editor's preview and the server renderer split and time captions with the exact
 * same code. Re-exported from captions.ts for existing callers.
 */
export interface TranscriptWord {
  word: string;
  /** Seconds. Source-media timeline for transcripts, output timeline after remapping. */
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------------------
// Timeline remapping
// ---------------------------------------------------------------------------------------

/**
 * Maps word timings from the source take onto the rendered output timeline. Segments are
 * concatenated in order as hard cuts, so a word inside segment k lands at
 * `(t - seg.start) + sum(previous segment durations)`. Words entirely in cut regions are
 * dropped; words straddling a cut are clipped, and kept only if enough of them survives to
 * be audible (>= 50% of the word or >= 0.12 s) — otherwise a caption would show a word the
 * viewer can't hear.
 */
export function remapWordsToOutputTimeline(
  words: TranscriptWord[],
  segments: Array<{ startSeconds: number; endSeconds: number }>,
): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let offset = 0;
  for (const seg of segments) {
    const segDuration = Math.max(0, seg.endSeconds - seg.startSeconds);
    for (const w of words) {
      const clippedStart = Math.max(w.start, seg.startSeconds);
      const clippedEnd = Math.min(w.end, seg.endSeconds);
      const kept = clippedEnd - clippedStart;
      if (kept <= 0) continue;
      const original = Math.max(1e-6, w.end - w.start);
      if (kept / original < 0.5 && kept < 0.12) continue;
      out.push({
        word: w.word,
        start: round3(clippedStart - seg.startSeconds + offset),
        end: round3(clippedEnd - seg.startSeconds + offset),
      });
    }
    offset += segDuration;
  }
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------------------

export interface CaptionChunk {
  words: TranscriptWord[];
  text: string;
  start: number;
  end: number;
}

export interface ChunkingOptions {
  maxWords: number;
  minWords: number;
  maxChars: number;
  /** A silence longer than this always starts a new chunk. */
  pauseThresholdSeconds: number;
  /** Chunks are held on screen at least this long (if the next chunk allows). */
  minDisplaySeconds: number;
  /** Gaps shorter than this between chunks are bridged to avoid flicker. */
  bridgeGapSeconds: number;
}

export const DEFAULT_CHUNKING: ChunkingOptions = {
  maxWords: 4,
  minWords: 2,
  maxChars: 22,
  pauseThresholdSeconds: 0.35,
  minDisplaySeconds: 0.45,
  bridgeGapSeconds: 0.3,
};

const SENTENCE_END = /[.!?…]["'”’)]*$/;
const CLAUSE_END = /[,;:—–]["'”’)]*$/;

export function buildCaptionChunks(
  words: TranscriptWord[],
  options: Partial<ChunkingOptions> = {},
): CaptionChunk[] {
  const opts = { ...DEFAULT_CHUNKING, ...options };
  const clean = words
    .map((w) => ({ ...w, word: w.word.trim() }))
    .filter((w) => w.word.length > 0 && w.end > w.start)
    .sort((a, b) => a.start - b.start);

  const groups: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];
  const chars = (ws: TranscriptWord[]) => ws.map((w) => w.word).join(" ").length;

  for (let i = 0; i < clean.length; i++) {
    const w = clean[i]!;
    const prev = current[current.length - 1];
    if (prev) {
      const gap = w.start - prev.end;
      const wouldExceedChars = chars([...current, w]) > opts.maxChars;
      const full = current.length >= opts.maxWords;
      const pause = gap > opts.pauseThresholdSeconds;
      const sentenceBreak = SENTENCE_END.test(prev.word);
      const clauseBreak = CLAUSE_END.test(prev.word) && current.length >= opts.minWords;
      if (full || pause || sentenceBreak || clauseBreak || wouldExceedChars) {
        groups.push(current);
        current = [];
      }
    }
    current.push(w);
  }
  if (current.length > 0) groups.push(current);

  // Fold a trailing single-word orphan into its predecessor when they're contiguous in
  // speech and the merge still fits — "the whole / trick." reads worse than one chunk.
  const merged: TranscriptWord[][] = [];
  for (const g of groups) {
    const last = merged[merged.length - 1];
    if (
      last &&
      g.length === 1 &&
      !SENTENCE_END.test(last[last.length - 1]!.word) &&
      g[0]!.start - last[last.length - 1]!.end <= opts.pauseThresholdSeconds &&
      chars([...last, ...g]) <= opts.maxChars + 4 &&
      last.length < opts.maxWords
    ) {
      last.push(...g);
    } else {
      merged.push([...g]);
    }
  }

  const chunks: CaptionChunk[] = merged.map((g) => ({
    words: g,
    text: g.map((w) => w.word).join(" "),
    start: g[0]!.start,
    end: g[g.length - 1]!.end,
  }));

  // Timing polish: bridge tiny gaps, enforce a minimum on-screen time without overlapping.
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const next = chunks[i + 1];
    let end = c.end;
    if (end - c.start < opts.minDisplaySeconds) end = c.start + opts.minDisplaySeconds;
    if (next) {
      if (next.start - end < opts.bridgeGapSeconds) end = next.start;
      end = Math.min(end, next.start);
    }
    c.end = round3(Math.max(end, c.start + 0.05));
  }
  return chunks;
}

