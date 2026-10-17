/**
 * Stops sandboxes: by name, or `--all-running` (every running sandbox of the project — use
 * after an interrupted script). `SANDBOX_ENV_FILE=… pnpm exec tsx scripts/sandbox/stop.ts <name…>|--all-running`
 */
import { Sandbox } from "@vercel/sandbox";
import { loadSandboxCredentials } from "./credentials";

const creds = loadSandboxCredentials();
const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (process.argv.includes("--all-running")) {
  for await (const sb of await Sandbox.list({ ...creds })) {
    const s = sb as unknown as { name: string; status?: string };
    console.log(`${s.name}: ${s.status ?? "?"}`);
    if (s.status === "running" || s.status === "pending") names.push(s.name);
  }
}
for (const name of names) {
  try {
    const sb = await Sandbox.get({ ...creds, name });
    const r = await sb.stop();
    console.log(`stopped ${name} (active CPU ${(r as { activeCpuDurationMs?: number }).activeCpuDurationMs ?? "?"} ms)`);
  } catch (err) {
    console.log(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
