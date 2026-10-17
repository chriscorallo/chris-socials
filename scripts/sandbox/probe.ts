/**
 * Diagnostics: boots a plain sandbox, prints OS/CPU/memory/tool facts and measures file-upload
 * throughput, then stops it.
 * `SANDBOX_ENV_FILE=../.env pnpm exec tsx scripts/sandbox/probe.ts [image] [vcpus] [uploadMB…]`
 */
import { randomBytes } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { loadSandboxCredentials } from "./credentials";

const image = process.argv[2] || "vercel/sandbox/node:24";
const vcpus = Number(process.argv[3] || 4);
const uploads = process.argv.slice(4).map(Number).filter((n) => n > 0);
const creds = loadSandboxCredentials();
const t0 = Date.now();
const sandbox = await Sandbox.create({ ...creds, image, resources: { vcpus }, timeout: 5 * 60_000, persistent: false });
console.log(`boot ${Date.now() - t0} ms, name ${sandbox.name}`);
try {
  const r = await sandbox.runCommand("sh", [
    "-c",
    "cat /etc/os-release | head -3; uname -m; nproc; free -m | head -2; node -v; whoami; pwd; df -h / | tail -1",
  ]);
  console.log(await r.stdout(), await r.stderr());
  for (const mb of uploads) {
    const buf = randomBytes(Math.round(mb * 1024 * 1024));
    const s = Date.now();
    await sandbox.writeFiles([{ path: `/vercel/sandbox/upload-${mb}.bin`, content: buf }]);
    console.log(`writeFiles ${mb} MB: ${Date.now() - s} ms`);
  }
  if (uploads.length) {
    const s = Date.now();
    await Promise.all([0, 1, 2, 3].map((i) => sandbox.writeFiles([{ path: `/vercel/sandbox/par-${i}.bin`, content: randomBytes(512 * 1024) }])));
    console.log(`4 parallel writeFiles x 0.5 MB: ${Date.now() - s} ms`);
  }
} finally {
  await sandbox.stop();
  console.log("stopped");
}
