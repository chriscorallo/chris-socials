/**
 * Voice audition: speaks the same line with several Kokoro voices, transcribes each back with
 * the local Whisper (intelligibility check) and writes one comparison WAV per voice.
 *   pnpm --filter @chris/cinema exec tsx scripts/voice-audition.ts <outDir> [voice,voice…]
 */
import { join } from "node:path";
import { LocalWhisperTranscriptionProvider } from "@chris/media/transcription";
import { synthesizeLine } from "../src/narration/kokoro";

const out = process.argv[2] ?? join(process.cwd(), ".cache", "voice-audition");
const voices = (process.argv[3] ?? "af_heart,af_bella,am_michael,am_fenrir,am_puck,bm_george,bm_fable").split(",");
const line = "Your ten thousand dollar raise is already gone. Here's exactly where it went.";

const whisper = new LocalWhisperTranscriptionProvider();
for (const v of voices) {
  const t0 = Date.now();
  const r = await synthesizeLine(line, join(out, `${v}.wav`), v, 1, { force: true });
  const synthMs = Date.now() - t0;
  const tr = await whisper.transcribe(r.path);
  console.log(JSON.stringify({ voice: v, seconds: Number(r.durationSeconds.toFixed(2)), synthMs, heard: tr.text.trim() }));
}
