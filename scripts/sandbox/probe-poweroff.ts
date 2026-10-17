/** Diagnostics: can a sandbox end its own session from inside (poweroff / halt / reboot)? */
import { Sandbox } from "@vercel/sandbox";
import { loadSandboxCredentials } from "./credentials";

const creds = loadSandboxCredentials();
const how = process.argv[2] ?? "sudo -n poweroff";
const sandbox = await Sandbox.create({ ...creds, image: "vercel/sandbox/node:24", resources: { vcpus: 1 }, timeout: 3 * 60_000, persistent: false });
const t0 = Date.now();
try {
  const r = await sandbox.runCommand({ cmd: "bash", args: ["-c", `which poweroff halt systemctl; (${how}) ; echo exit=$?`], detached: true });
  void r;
  for (let i = 0; i < Number(process.env.PROBE_POLLS ?? 15); i++) {
    await new Promise((res) => setTimeout(res, 2000));
    const s = await Sandbox.get({ ...creds, name: sandbox.name });
    console.log(`+${((Date.now() - t0) / 1000).toFixed(0)}s ${s.status}`);
    if (s.status === "stopped" || s.status === "failed" || s.status === "aborted") break;
  }
  try {
    const log = await r.output("both");
    console.log(log.slice(-500));
  } catch (e) {
    console.log("no output:", e instanceof Error ? e.message : e);
  }
} finally {
  await sandbox.stop().catch(() => undefined);
}
