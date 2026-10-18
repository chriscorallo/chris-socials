import { join } from "node:path";
import type { Film } from "../dsl/schema";
import type { LineClip } from "../timing";
import { lineAudioPath, synthesizeLine } from "./kokoro";

/**
 * Narration for a film: every shot's line spoken by the local Kokoro voice, then transcribed
 * back by the repo's local Whisper (word timestamps) — the words the picture syncs to are the
 * words actually heard, not a guess. Lines are cached by content (voice|speed|text).
 */

export interface NarratedLine extends LineClip {
  path: string;
  heard: string;
}

export async function narrateFilm(film: Film, dir: string, opts: { force?: boolean; log?: (m: string) => void } = {}): Promise<Record<string, NarratedLine>> {
  if (!film.narration) return {};
  if (film.narration.engine !== "KOKORO") throw new Error(`narration engine ${film.narration.engine} has no automatic synthesis — record the lines and pass them as clips`);
  const { LocalWhisperTranscriptionProvider } = await import("@chris/media/transcription");
  const whisper = new LocalWhisperTranscriptionProvider();
  const voice = film.narration.voice;
  const speed = film.narration.speed ?? 1;
  const out: Record<string, NarratedLine> = {};
  for (const scene of film.scenes) {
    for (const shot of scene.shots) {
      if (!shot.line) continue;
      const text = shot.say ?? shot.line;
      const path = lineAudioPath(join(dir, "lines"), shot.id, voice, speed, text);
      const t0 = Date.now();
      const syn = await synthesizeLine(text, path, voice, speed, { force: opts.force });
      const tr = await whisper.transcribe(syn.path);
      out[shot.id] = { path, durationSeconds: syn.durationSeconds, words: tr.words.map((w) => ({ word: w.word, start: w.start, end: w.end })), heard: tr.text.trim() };
      opts.log?.(`  line ${shot.id}: ${syn.durationSeconds.toFixed(2)} s, ${tr.words.length} words (${Date.now() - t0} ms) — heard "${tr.text.trim()}"`);
    }
  }
  return out;
}
