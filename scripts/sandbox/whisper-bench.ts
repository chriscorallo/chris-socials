/**
 * Benchmarks word-timestamped Whisper exports inside a sandbox built from a runner snapshot:
 * synthesizes ~60 s of speech (Kokoro), transcribes it with each model, prints load/transcribe
 * time, real-time factor, word error rate on non-number words, the numbers heard, and timing
 * sanity. Picks the transcription model with evidence, not vibes.
 *   SANDBOX_ENV_FILE=.env pnpm exec tsx scripts/sandbox/whisper-bench.ts <snapshotId> [MODELS=a,b] [DTYPES=fp32,q8]
 */
import { readFileSync } from "node:fs";
import { Sandbox } from "@vercel/sandbox";
import { loadSandboxCredentials } from "./credentials";

const creds = loadSandboxCredentials();
const snapshotId = process.argv[2];
if (!snapshotId) throw new Error("usage: whisper-bench.ts <snapshotId>");
const sandbox = await Sandbox.create({ ...creds, source: { type: "snapshot", snapshotId }, resources: { vcpus: 8 }, timeout: 40 * 60_000, persistent: false });
console.log("sandbox", sandbox.name);
try {
  await sandbox.writeFiles([{ path: "/vercel/sandbox/bench/bench.mjs", content: Buffer.from(readFileSync(new URL("./whisper-bench.mjs", import.meta.url))) }]);
  const r = await sandbox.runCommand("bash", ["-lc", `cd /vercel/sandbox/runner && TRANSCRIPTION_CACHE_DIR=/vercel/sandbox/cache/transformers MODELS="${process.env.MODELS ?? ""}" DTYPES="${process.env.DTYPES ?? "fp32"}" SPEECH_URL="${process.env.SPEECH_URL ?? ""}" node /vercel/sandbox/bench/bench.mjs 2>&1 | grep -v Warning`]);
  console.log(await r.stdout());
  console.log("STDERR:", (await r.stderr()).slice(-1500));
} finally {
  await sandbox.stop();
  console.log("stopped");
}
