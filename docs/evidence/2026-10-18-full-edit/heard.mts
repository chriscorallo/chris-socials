// What is actually HEARD in a render: real Whisper on the output MP4 (independent of captions).
import { writeFileSync } from "node:fs";
const WT = "/Users/christophercorallo/Desktop/Claude Projects/Chris Socials/.claude/worktrees/agent-aad446c9bef68772d";
const D = "/private/tmp/claude-501/-Users-christophercorallo-Desktop-Claude-Projects-Chris-Socials/2fa27366-298a-4c40-a49e-d2c8b0f369a9/scratchpad/fulledit";
const { LocalWhisperTranscriptionProvider } = await import(WT + "/packages/media/src/transcription/index.ts");
for (const f of process.argv.slice(2)) {
  const r = await new LocalWhisperTranscriptionProvider().transcribe(`${D}/${f}.mp4`);
  const text = r.words.map((w: { word: string }) => w.word).join(" ");
  writeFileSync(`${D}/${f}-heard.txt`, text + "\n");
  console.log(`${f}: ${text}`);
}
