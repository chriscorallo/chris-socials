/**
 * Turns a line's spoken text into speech segments with natural pauses: one segment per sentence
 * (. ! ? ; — Kokoro voices each sentence with its own falling/rising contour), plus explicit
 * beats written as `[pause]` (default beat) or `[pause 0.6]` in `say`. Pure.
 */

export interface SpeechSegment {
  text: string;
  /** Silence after this segment, seconds (0 for the last). */
  pauseAfter: number;
}

export const DEFAULT_SENTENCE_PAUSE = 0.32;
export const DEFAULT_BEAT_PAUSE = 0.45;

export function splitForSpeech(text: string, sentencePause = DEFAULT_SENTENCE_PAUSE): SpeechSegment[] {
  const out: SpeechSegment[] = [];
  // explicit beats first
  const parts = text.split(/\[pause(?:\s+(\d+(?:\.\d+)?))?\]/i);
  // split() with a capture group interleaves: text, num|undefined, text, …
  for (let i = 0; i < parts.length; i += 2) {
    const chunk = (parts[i] ?? "").trim();
    const beat = i + 1 < parts.length ? (parts[i + 1] ? Number(parts[i + 1]) : DEFAULT_BEAT_PAUSE) : 0;
    if (chunk) {
      // sentences: end punctuation followed by space + a capital/quote/digit (keeps "$6.50" and "e.g." mid-sentence intact)
      const sentences = chunk.split(/(?<=[.!?;])\s+(?=["“'‘(]?[A-Z0-9$])/).map((s) => s.trim()).filter(Boolean);
      sentences.forEach((s, k) => out.push({ text: s, pauseAfter: k < sentences.length - 1 ? sentencePause : 0 }));
    }
    if (beat > 0) {
      if (out.length) out[out.length - 1]!.pauseAfter += beat;
    }
  }
  if (out.length) out[out.length - 1]!.pauseAfter = 0;
  return out;
}

/** The text with pause markers removed (what the words are). */
export function stripPauseMarkers(text: string): string {
  return text.replace(/\[pause(?:\s+\d+(?:\.\d+)?)?\]/gi, " ").replace(/\s+/g, " ").trim();
}
