import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Sandbox } from "@vercel/sandbox";
import { BUILD_DIR, LITE_EXCLUDES, OUT, SANDBOX_CACHE, SANDBOX_ROOT, ULTRAFACE_URL, runtimeEnv } from "./build-runner";

const execFileAsync = promisify(execFile);

/**
 * Shared steps for building the cloud-worker snapshot (create-snapshot.ts) and for ad-hoc
 * verification sandboxes (verify-offline.ts).
 */

/** Chrome headless shell's shared libraries on the sandbox's Ubuntu image (managed image
 * `vercel/sandbox/node:24`, Ubuntu 26.04 — t64 package names; the non-t64 names are tried as
 * a fallback for older bases). Remotion's Linux dependency list. */
export const CHROME_APT_PACKAGES = [
  "libnss3",
  "libnspr4",
  "libdbus-1-3",
  "libatk1.0-0t64|libatk1.0-0",
  "libatk-bridge2.0-0t64|libatk-bridge2.0-0",
  "libcups2t64|libcups2",
  "libgbm1",
  "libdrm2",
  "libasound2t64|libasound2",
  "libxrandr2",
  "libxkbcommon0",
  "libxfixes3",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libx11-xcb1",
  "libxcb1",
  "libpango-1.0-0",
  "libcairo2",
  "libexpat1",
  "fonts-liberation",
  "ca-certificates",
  "curl",
  // Full ffmpeg (FreeType/libass) for drawtext — the static build lacks it. run-job.sh points
  // FFMPEG_BIN at it when present.
  "ffmpeg",
];

export const SANDBOX_IMAGE = "vercel/sandbox/node:24";

export async function sh(sandbox: Sandbox, script: string, opts: { sudo?: boolean; env?: Record<string, string>; quiet?: boolean } = {}): Promise<string> {
  const started = Date.now();
  const r = await sandbox.runCommand({ cmd: "bash", args: ["-lc", script], sudo: opts.sudo, env: opts.env });
  const out = await r.stdout();
  const err = await r.stderr();
  if (r.exitCode !== 0) {
    throw new Error(`sandbox command failed (exit ${r.exitCode}): ${script.slice(0, 200)}\n--- stdout ---\n${out.slice(-3000)}\n--- stderr ---\n${err.slice(-3000)}`);
  }
  if (!opts.quiet) console.log(`  ✓ ${script.split("\n")[0]!.slice(0, 100)} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  return out;
}

export async function installSystemPackages(sandbox: Sandbox) {
  const pick = CHROME_APT_PACKAGES.map((p) => p.split("|"));
  // Pick, per alternative group, the first package name apt knows about.
  const script = [
    "set -e",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq",
    "PKGS=''",
    ...pick.map((alts) => `for p in ${alts.join(" ")}; do if apt-cache show "$p" >/dev/null 2>&1; then PKGS="$PKGS $p"; break; fi; done`),
    'echo "installing:$PKGS"',
    "apt-get install -y -qq --no-install-recommends $PKGS >/dev/null",
  ].join("\n");
  await sh(sandbox, script, { sudo: true });
}

const CHUNK_BYTES = 768 * 1024;

/** Uploads a buffer in chunks (per-chunk retry, visible progress) and reassembles it. */
async function uploadChunked(sandbox: Sandbox, content: Buffer, dest: string) {
  const parts = Math.ceil(content.byteLength / CHUNK_BYTES);
  const dir = `${dest}.parts`;
  const started = Date.now();
  for (let i = 0; i < parts; i++) {
    const chunk = content.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    for (let attempt = 1; ; attempt++) {
      try {
        await sandbox.writeFiles([{ path: `${dir}/${String(i).padStart(4, "0")}`, content: Buffer.from(chunk) }]);
        break;
      } catch (err) {
        if (attempt >= 4) throw err;
        console.log(`    chunk ${i + 1} failed (${err instanceof Error ? err.message : String(err)}), retrying…`);
      }
    }
    const done = Math.min(content.byteLength, (i + 1) * CHUNK_BYTES);
    console.log(`    ${(done / 1e6).toFixed(1)}/${(content.byteLength / 1e6).toFixed(1)} MB (${(done / 1024 / ((Date.now() - started) / 1000)).toFixed(0)} KB/s)`);
  }
  await sh(sandbox, `cat ${dir}/* > ${dest} && rm -rf ${dir}`, { quiet: true });
}

/**
 * Uploads the runner WITHOUT the files the sandbox can re-create (LITE_EXCLUDES); restoreRunner re-creates
 * them (copy, download, regenerate), verifies the whole tree against MANIFEST.sha256, then
 * `npm install`s the native externals.
 */
export async function uploadRunner(sandbox: Sandbox) {
  const tarPath = join(BUILD_DIR, "runner-lite.tgz");
  await rm(tarPath, { force: true });
  // Resuming a sandbox that already has a runner: send only the files whose hash changed.
  const remote = await sandbox.readFileToBuffer({ path: `${SANDBOX_ROOT}/MANIFEST.sha256` }).catch(() => null);
  if (remote) {
    const parse = (s: string) => new Map(s.trim().split("\n").map((l) => [l.slice(66), l.slice(0, 64)] as const));
    const before = parse(remote.toString("utf8"));
    const after = parse(await readFile(join(OUT, "MANIFEST.sha256"), "utf8"));
    const excluded = (p: string) => LITE_EXCLUDES.some((e) => (e.endsWith("*.wav") ? p.startsWith(e.slice(0, -5)) && p.endsWith(".wav") : p === e || p.startsWith(`${e}/`)));
    const changed = [...after].filter(([p, h]) => before.get(p) !== h && !excluded(p)).map(([p]) => p);
    const removed = [...before.keys()].filter((p) => !after.has(p) && !excluded(p));
    console.log(`  delta upload: ${changed.length} changed, ${removed.length} removed`);
    if (removed.length) await sh(sandbox, `cd ${SANDBOX_ROOT} && rm -f ${removed.map((p) => JSON.stringify(p)).join(" ")}`);
    await execFileAsync("tar", ["-czf", tarPath, "-C", OUT, "MANIFEST.sha256", "VERSION", ...changed], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  } else {
    await execFileAsync("tar", ["-czf", tarPath, ...LITE_EXCLUDES.map((e) => `--exclude=${e}`), "-C", OUT, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
  }
  const tar = await readFile(tarPath);
  console.log(`  uploading runner (${(tar.byteLength / 1e6).toFixed(1)} MB, lite)…`);
  await sh(sandbox, `mkdir -p ${SANDBOX_ROOT} ${SANDBOX_CACHE}`);
  await uploadChunked(sandbox, tar, "/vercel/sandbox/runner.tgz");
  await sh(sandbox, `tar -xzf /vercel/sandbox/runner.tgz -C ${SANDBOX_ROOT} && rm /vercel/sandbox/runner.tgz`);
}

/** Re-creates LITE_EXCLUDES, verifies MANIFEST.sha256, installs the externals. Idempotent. */
export async function restoreRunner(sandbox: Sandbox) {
  await sh(
    sandbox,
    [
      `cd ${SANDBOX_ROOT}`,
      "rm -rf motion-bundle/public && cp -r packages/media/assets motion-bundle/public",
      `node -e "fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error(r.status); require('fs').writeFileSync(process.argv[2], Buffer.from(await r.arrayBuffer())); })" ${ULTRAFACE_URL} packages/media/assets/models/ultraface/version-RFB-640.onnx`,
      "cp packages/media/assets/models/ultraface/version-RFB-640.onnx motion-bundle/public/models/ultraface/",
      // the mini-movie bundle's public dir is the same assets (runners built before it existed have no cinema-bundle)
      "if [ -d cinema-bundle ]; then rm -rf cinema-bundle/public && cp -r packages/media/assets cinema-bundle/public; fi",
      "node packages/motion/scripts/generate-sfx.mjs >/dev/null",
      "sha256sum --quiet -c MANIFEST.sha256",
      // Source maps aren't shipped (size); Remotion opens them when it symbolicates an error —
      // empty ones keep the real error message visible.
      "for f in motion-bundle/*.js cinema-bundle/*.js; do [ -f \"$f\" ] || continue; [ -f \"$f.map\" ] || echo '{\"version\":3,\"sources\":[],\"names\":[],\"mappings\":\"\"}' > \"$f.map\"; done",
    ].join(" && "),
  );
  await sh(sandbox, `cd ${SANDBOX_ROOT} && npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | tail -5`);
}

/** Downloads Chrome headless shell + the Whisper/MODNet models into the snapshot. */
export async function warmup(sandbox: Sandbox) {
  const out = await sh(sandbox, `${SANDBOX_ROOT}/bin/run-job.sh warmup`);
  console.log(`  warmup: ${out.trim().split("\n").pop()}`);
}

export { runtimeEnv, SANDBOX_ROOT, SANDBOX_CACHE };
