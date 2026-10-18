import { join } from "node:path";
import type { Film } from "../dsl/schema";
import type { LineClip } from "../timing";
import { lineAudioPath, synthesizeLine } from "./kokoro";
import { DEFAULT_SENTENCE_PAUSE } from "./speech-text";

/**
 * Narration for a film: every shot's line spoken by the local Kokoro voice (sentence by sentence
 * with natural pauses), then transcribed back by the repo's local Whisper (word timestamps) — the
 * words the picture syncs to are the words actually heard, not a guess. Lines are cached by
 * content (voice|speed|pause|text). Chris's own voice (engine "CHRIS") comes from a recording —
 * see recording.ts `narrationFromRecording`.
 */

export interface NarratedLine extends LineClip {
  path: string;
  heard: string;
}

/** Anything that can give word timings for an audio file (the local Whisper by default; tests inject a fake). */
export interface WordTranscriber {
  transcribe(path: string): Promise<{ text: string; words: Array<{ word: string; start: number; end: number }> }>;
}

export async function defaultTranscriber(): Promise<WordTranscriber> {
  const { LocalWhisperTranscriptionProvider } = await import("@chris/media/transcription");
  return new LocalWhisperTranscriptionProvider();
}

export async function narrateFilm(film: Film, dir: string, opts: { force?: boolean; log?: (m: string) => void; transcriber?: WordTranscriber } = {}): Promise<Record<string, NarratedLine>> {
  if (!film.narration) return {};
  if (film.narration.engine !== "KOKORO") throw new Error(`narration engine ${film.narration.engine} has no automatic synthesis — upload the recording and align it (narrationFromRecording), then pass the lines to renderFilm`);
  const whisper = opts.transcriber ?? (await defaultTranscriber());
  const voice = film.narration.voice;
  const speed = film.narration.speed ?? 1;
  const pause = film.narration.sentencePause ?? DEFAULT_SENTENCE_PAUSE;
  const out: Record<string, NarratedLine> = {};
  for (const scene of film.scenes) {
    for (const shot of scene.shots) {
      if (!shot.line) continue;
      const text = shot.say ?? shot.line;
      const path = lineAudioPath(join(dir, "lines"), shot.id, voice, speed, text, `p${pause}`);
      const t0 = Date.now();
      const syn = await synthesizeLine(text, path, voice, speed, { force: opts.force, sentencePause: pause });
      const tr = await whisper.transcribe(syn.path);
      out[shot.id] = { path, durationSeconds: syn.durationSeconds, words: tr.words.map((w) => ({ word: w.word, start: w.start, end: w.end })), heard: tr.text.trim() };
      opts.log?.(`  line ${shot.id}: ${syn.durationSeconds.toFixed(2)} s, ${tr.words.length} words (${Date.now() - t0} ms) — heard "${tr.text.trim()}"`);
    }
  }
  return out;
}
