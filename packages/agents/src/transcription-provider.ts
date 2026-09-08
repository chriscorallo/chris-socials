/**
 * Transcription provider abstraction — mirrors ModelProvider's pattern (spec §16: never
 * hardcode to one vendor). No real provider is wired in yet — see /docs/DECISIONS.md
 * ("Transcription: interface only, no provider chosen yet"). Take Selector and Edit Planner
 * both just consume a transcript string; nothing downstream cares whether it came from a
 * real provider or was typed in by hand while none is configured.
 */
export interface TranscriptionResult {
  text: string;
  language?: string | null;
  durationSeconds?: number | null;
}

export interface TranscriptionProvider {
  transcribe(filePath: string): Promise<TranscriptionResult>;
}
