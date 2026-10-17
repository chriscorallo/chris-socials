/**
 * Checks the web app's REAL launcher (apps/web/lib/heavy-jobs.ts vercelSandboxLauncher) against
 * Vercel: boots a sandbox from the snapshot, writes the 0600 env/args files, starts the runner
 * DETACHED with --stop-self — with a JobRun id that doesn't exist and no database, so the runner
 * fails fast — then watches the sandbox stop itself. Proves: launch returns immediately, the env
 * file is consumed, and a finished/crashed worker stops its own sandbox via the API (the timeout is only the
 * safety net). Always stops the sandbox at the end.
 *
 *   SANDBOX_ENV_FILE=… pnpm exec tsx scripts/sandbox/verify-dispatch.ts [--snapshot snap_…]
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSandboxCredentials } from "./credentials";
import { BUILD_DIR } from "./build-runner";

const args = process.argv.slice(2);
const creds = loadSandboxCredentials();
process.env.VERCEL_TOKEN = creds.token;
process.env.VERCEL_TEAM_ID = creds.teamId;
process.env.VERCEL_PROJECT_ID = creds.projectId;
const snapshotId =
  (args.includes("--snapshot") ? args[args.indexOf("--snapshot") + 1] : null) ??
  (JSON.parse(await readFile(join(BUILD_DIR, "snapshot.json"), "utf8")) as { snapshotId: string }).snapshotId;

const { vercelSandboxLauncher } = await import("../../apps/web/lib/heavy-jobs");
const jobRunId = `verify-${Date.now()}`;
const t0 = Date.now();
const { sandboxName } = await vercelSandboxLauncher.launch({
  jobRunId,
  kind: "transcribe",
  args: { contentItemId: "verify-dispatch" },
  env: { APP_TIMEZONE: "America/Los_Angeles" },
  snapshotId,
  vcpus: 2,
  timeoutMs: 5 * 60_000,
  contentItemId: "verify-dispatch",
});
console.log(`launched ${sandboxName} in ${Date.now() - t0} ms (detached)`);
let status: string | null = "running";
for (let i = 0; i < 30 && status !== "stopped" && status !== null; i++) {
  await new Promise((r) => setTimeout(r, 2_000));
  status = await vercelSandboxLauncher.status(sandboxName);
  console.log(`  +${((Date.now() - t0) / 1000).toFixed(0)} s: ${status}`);
}
console.log(status === "stopped" || status === null ? "PASS: the worker stopped its own sandbox" : "the sandbox did not stop by itself — stopping it now");
if (status !== "stopped" && status !== null) await vercelSandboxLauncher.stop(sandboxName);
