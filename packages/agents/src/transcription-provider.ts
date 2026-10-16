/**
 * Transcription provider abstraction — mirrors ModelProvider's pattern (spec §16: never
 * hardcode to one vendor). The real implementation is local Whisper via transformers.js
 * (`LocalWhisperTranscriptionProvider` in `@chris/media/transcription`, which satisfies this
 * interface structurally — media and agents don't depend on each other). Manually typed
 * transcripts remain valid input everywhere: `words` is simply absent/null for those.
 */

/** One spoken word with its timing in seconds on the SOURCE media's timeline. */
export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptionResult {
  text: string;
  language?: string | null;
  durationSeconds?: number | null;
  /** Word-level timings when the provider produces them (null/absent otherwise). */
  words?: TranscriptWord[] | null;
}

export interface TranscriptionProvider {
  transcribe(filePath: string): Promise<TranscriptionResult>;
}
