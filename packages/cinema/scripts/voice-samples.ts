/**
 * (Re)generates the curated narration voice samples (assets/voice-samples/<voice>.m4a): the
 * audition line spoken at each voice's suggested speed, with the engine's sentence pauses,
 * encoded as small AAC files the studio UI can play.
 *   pnpm --filter @chris/cinema exec tsx scripts/voice-samples.ts
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { NARRATION_VOICES } from "../src/narration/voices";
import { synthesizeLine } from "../src/narration/kokoro";
import { runFfmpeg } from "../src/audio/ffmpeg";

export const SAMPLE_LINE = "Your ten thousand dollar raise is already gone. But here's the part nobody tells you: you didn't just spend it.";

const outDir = join(import.meta.dirname, "..", "assets", "voice-samples");
await mkdir(outDir, { recursive: true });
const tmp = join(outDir, ".tmp");
for (const v of NARRATION_VOICES) {
  const wav = join(tmp, `${v.id}.wav`);
  const r = await synthesizeLine(SAMPLE_LINE, wav, v.id, v.suggestedSpeed, { force: true });
  await runFfmpeg(["-i", wav, "-af", "loudnorm=I=-18:TP=-2:LRA=11", "-ar", "24000", "-ac", "1", "-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart", join(outDir, `${v.id}.m4a`)]);
  console.log(`${v.id}: ${r.durationSeconds.toFixed(2)} s`);
}
await rm(tmp, { recursive: true, force: true });
