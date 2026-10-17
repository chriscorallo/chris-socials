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
      out.push({
        key,
        word: timeline.captions.uppercase ? text.toUpperCase() : text,
        start: round3(Math.max(offset, s - clip.sourceStart + offset)),
        end: round3(Math.min(clipEnd, e - clip.sourceStart + offset)),
      });
    });
  });
  return out.sort((a, b) => a.start - b.start);
}

export function timelineCaptionChunks(
  timeline: Pick<EditTimeline, "clips" | "captions">,
  wordsByAsset: Record<string, TranscriptWord[] | null | undefined>,
): TimelineCaptionChunk[] {
  if (!timeline.captions.enabled) return [];
  const words = timelineCaptionWords(timeline, wordsByAsset);
  const maxWords = timeline.captions.maxWordsPerChunk;
  const chunks = buildCaptionChunks(words, {
    maxWords,
    minWords: Math.min(2, maxWords),
    maxChars: Math.max(10, maxWords * 7),
  });
  return chunks as TimelineCaptionChunk[];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
