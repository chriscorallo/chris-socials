/**
 * Boots a sandbox from a snapshot and checks the reference-learning OCR can run there:
 * tesseract.js installed in the runner, the English model present.
 *
 *   SANDBOX_ENV_FILE=.env pnpm exec tsx scripts/sandbox/probe-ocr.ts <snapshotId>
 */
import { Sandbox } from "@vercel/sandbox";
import { loadSandboxCredentials } from "./credentials";
import { SANDBOX_ROOT } from "./sandbox-setup";

async function main() {
  const snapshotId = process.argv[2];
  if (!snapshotId) throw new Error("usage: probe-ocr.ts <snapshotId>");
  const creds = loadSandboxCredentials();
  const sandbox = await Sandbox.create({ ...creds, source: { type: "snapshot", snapshotId }, resources: { vcpus: 2 }, timeout: 300_000 });
  try {
    const r = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", `cd ${SANDBOX_ROOT} && ls -la packages/media/assets/models/tesseract/ && node -e "import('tesseract.js').then(m=>console.log('tesseract.js loaded:', typeof (m.default?.createWorker ?? m.createWorker))).catch(e=>{console.error('LOAD FAILED', e.message); process.exit(1)})"`],
    });
    console.log(await r.stdout());
    const err = await r.stderr();
    if (err.trim()) console.error(err.slice(-600));
    console.log(r.exitCode === 0 ? "OCR OK in this snapshot" : `OCR NOT available (exit ${r.exitCode})`);
    process.exitCode = r.exitCode === 0 ? 0 : 1;
  } finally {
    await sandbox.stop();
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
