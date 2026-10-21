/**
 * Analyzes a public reel inside a runner-snapshot sandbox (fast network, ffmpeg, cached Whisper):
 * cut list + shot stats, a contact sheet, and a word-timed transcript. Writes sheet.jpg / hook.jpg
 * next to the given out prefix and prints the JSON result.
 *   SANDBOX_ENV_FILE=.env REEL_URL=<url> pnpm exec tsx scripts/sandbox/reel-analyze.ts <snapshotId> <outPrefix>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Sandbox } from "@vercel/sandbox";
import { loadSandboxCredentials } from "./credentials";

const creds = loadSandboxCredentials();
const [snapshotId, outPrefix] = process.argv.slice(2);
if (!snapshotId || !outPrefix || !process.env.REEL_URL) throw new Error("usage: REEL_URL=<url> reel-analyze.ts <snapshotId> <outPrefix>");
const sandbox = await Sandbox.create({ ...creds, source: { type: "snapshot", snapshotId }, resources: { vcpus: 8 }, timeout: 30 * 60_000, persistent: false });
console.log("sandbox", sandbox.name);
try {
  await sandbox.writeFiles([{ path: "/vercel/sandbox/reel/analyze.mjs", content: Buffer.from(readFileSync(new URL("./reel-analyze.mjs", import.meta.url))) }]);
  const r = await sandbox.runCommand("bash", ["-lc", `cd /vercel/sandbox/runner && REEL_URL="${process.env.REEL_URL}" node /vercel/sandbox/reel/analyze.mjs 2>&1 | grep -v Warning`]);
  const out = await r.stdout();
  for (const line of out.split("\n")) {
    if (line.startsWith("SHEET ")) writeFileSync(`${outPrefix}-sheet.jpg`, Buffer.from(line.slice(6), "base64"));
    else if (line.startsWith("HOOK ")) writeFileSync(`${outPrefix}-hook.jpg`, Buffer.from(line.slice(5), "base64"));
    else console.log(line.slice(0, 6000));
  }
  console.log("STDERR:", (await r.stderr()).slice(-800));
} finally {
  await sandbox.stop();
  console.log("stopped");
}
