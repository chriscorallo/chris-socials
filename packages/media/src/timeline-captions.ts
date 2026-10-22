import { buildCaptionChunks, type CaptionChunk, type TranscriptWord } from "./caption-chunking";
import { clipStartTimes, clipDuration, type EditTimeline } from "./timeline";

/** A caption word on the OUTPUT timeline, traceable back to its transcript word. */
export interface TimelineCaptionWord extends TranscriptWord {
  /** `${mediaAssetId}:${wordIndex}` — the key used by `captions.wordEdits`. */
  key: string;
}

export interface TimelineCaptionChunk extends Omit<CaptionChunk, "words"> {
  words: TimelineCaptionWord[];
}

/**
 * The caption words that will actually be heard, on the output timeline: for each clip, the
 * words of that clip's take that fall inside [sourceStart, sourceEnd] (same keep rule as the
 * renderer: >= 50% of the word or >= 0.12 s survives the cut), shifted to the clip's output
 * start, with `wordEdits` applied ("" hides a word). PURE — shared by the browser preview and
 * the server renderer so both show identical captions.
 */
export function timelineCaptionWords(
  timeline: Pick<EditTimeline, "clips" | "captions">,
  wordsByAsset: Record<string, TranscriptWord[] | null | undefined>,
): TimelineCaptionWord[] {
  const starts = clipStartTimes(timeline);
  const out: TimelineCaptionWord[] = [];
  // A word can straddle a removed pause (Whisper's word edges drift into silence): if it
  // survives on both sides of a FORWARD splice of the same take, show it once — on the side
  // where more of it is. (A clip that repeats footage, e.g. a duplicate, is not a forward
  // splice and keeps its own captions.)
  const shownAt = new Map<string, { index: number; kept: number; clip: number }>();
  const dropped = new Set<number>();
  timeline.clips.forEach((clip, ci) => {
    const words = wordsByAsset[clip.mediaAssetId] ?? [];
    const offset = starts[ci]!;
    const clipEnd = offset + clipDuration(clip);
    words.forEach((w, index) => {
      const s = Math.max(w.start, clip.sourceStart);
      const e = Math.min(w.end, clip.sourceEnd);
      const kept = e - s;
      if (kept <= 0) return;
      const original = Math.max(1e-6, w.end - w.start);
      if (kept / original < 0.5 && kept < 0.12) return;
      const key = `${clip.mediaAssetId}:${index}`;
      const edited = timeline.captions.wordEdits[key];
      const text = edited ?? w.word;
      if (text.trim() === "") return;
      const prev = shownAt.get(key);
      const prevClip = prev ? timeline.clips[prev.clip] : undefined;
      if (prev && prev.clip === ci - 1 && prevClip && prevClip.mediaAssetId === clip.mediaAssetId && clip.sourceStart >= prevClip.sourceEnd - 1e-6) {
        if (kept <= prev.kept) return;
        dropped.add(prev.index);
      }
      shownAt.set(key, { index: out.length, kept, clip: ci });
      out.push({
        key,
        word: timeline.captions.uppercase ? text.toUpperCase() : text,
        start: round3(Math.max(offset, s - clip.sourceStart + offset)),
        end: round3(Math.min(clipEnd, e - clip.sourceStart + offset)),
      });
    });
  });
  return out.filter((_, i) => !dropped.has(i)).sort((a, b) => a.start - b.start);
}

export function timelineCaptionChunks(
  timeline: Pick<EditTimeline, "clips" | "captions">,
  wordsByAsset: Record<string, TranscriptWord[] | null | undefined>,
): TimelineCaptionChunk[] {
  if (!timeline.captions.enabled) return [];
  const words = timelineCaptionWords(timeline, wordsByAsset);
  const chunkWith = (ws: TimelineCaptionWord[], maxWords: number) =>
    buildCaptionChunks(ws, {
      maxWords,
      minWords: Math.min(2, maxWords),
      maxChars: Math.max(10, maxWords * 7),
    }) as TimelineCaptionChunk[];
  const windows = [...timeline.captions.chunking].filter((w) => w.end > w.start).sort((a, b) => a.start - b.start);
  if (windows.length === 0) return chunkWith(words, timeline.captions.maxWordsPerChunk);
  // Adaptive chunking (screen/captions.ts): each word belongs to the window its midpoint falls
  // in (else the default size); runs of words with the same size are chunked together, so a
  // chunk never spans two windows and the default size still applies between them.
  const sizeOf = (w: TimelineCaptionWord) => {
    const mid = (w.start + w.end) / 2;
    const win = windows.find((x) => mid >= x.start && mid < x.end);
    return win ? win.maxWords : timeline.captions.maxWordsPerChunk;
  };
  const out: TimelineCaptionChunk[] = [];
  let run: TimelineCaptionWord[] = [];
  let runSize = -1;
  const flush = () => {
    if (run.length) out.push(...chunkWith(run, runSize));
    run = [];
  };
  for (const w of words) {
    const size = sizeOf(w);
    if (size !== runSize) {
      flush();
      runSize = size;
    }
    run.push(w);
  }
  flush();
  // A chunk may not run into the next one (buildCaptionChunks only polishes inside a run).
  for (let i = 0; i < out.length - 1; i++) {
    const c = out[i]!;
    const next = out[i + 1]!;
    if (c.end > next.start) c.end = Math.max(c.start + 0.05, next.start);
  }
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
