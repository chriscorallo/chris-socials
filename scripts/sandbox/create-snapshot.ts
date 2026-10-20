/**
 * Builds the cloud worker's Vercel Sandbox snapshot. Reproducible for a given commit:
 *
 *   SANDBOX_ENV_FILE=<dotenv with VERCEL_TOKEN> pnpm exec tsx scripts/sandbox/create-snapshot.ts [--no-build] [--keep]
 *
 * 1. builds the runner artifact (scripts/sandbox/build-runner.ts) — its content hash is the
 *    snapshot's version;
 * 2. boots a sandbox from the managed image `vercel/sandbox/node:24` (Ubuntu, Node 24);
 * 3. installs Chrome headless shell's system libraries (apt);
 * 4. uploads the runner and `npm install`s its native externals (ffmpeg/ffprobe static,
 *    onnxruntime-node, transformers.js, @remotion/renderer + its Linux compositor);
 * 5. `run-job.sh warmup`: downloads Chrome headless shell, Whisper large-v3-turbo (timestamped) and
 *    MODNet into /vercel/sandbox/cache and loads each once;
 * 6. smoke-tests every runtime: ffmpeg/ffprobe, an offline render with a 2D + a 3D graphic
 *    (Remotion + WebGL on SwiftShader + compositing), the face tracker and the person matte;
 * 7. `sandbox.snapshot({ expiration: 0 })` (the snapshot never expires; delete old ones by hand)
 *    and prints the id → set RENDER_SANDBOX_SNAPSHOT_ID on Vercel.
 *
 * The sandbox is always stopped (snapshotting stops it; on failure we stop it).
 */
import { Sandbox } from "@vercel/sandbox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadSandboxCredentials } from "./credentials";
import { BUILD_DIR, OUT, buildRunner } from "./build-runner";
import { SANDBOX_IMAGE, SANDBOX_ROOT, installSystemPackages, restoreRunner, sh, uploadRunner, warmup } from "./sandbox-setup";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};

async function smoke(sandbox: Sandbox) {
  const dir = "/vercel/sandbox/smoke";
  await sh(sandbox, `mkdir -p ${dir}`);
  await sh(
    sandbox,
    `cd ${SANDBOX_ROOT} && FF=$(node -e "import('ffmpeg-static').then(m=>console.log(m.default))") && FP=$(node -e "import('ffprobe-static').then(m=>console.log(m.default.path))") && $FF -version | head -1 && $FP -version | head -1 && $FF -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=540x960:rate=30:duration=2 -f lavfi -i sine=frequency=330:duration=2 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest ${dir}/clip.mp4`,
  );
  const job = {
    output: "out.mp4",
    encode: { preset: "veryfast", crf: 23 },
    computeMattes: false,
    trackSubjects: false,
    assets: [{ id: "take", file: "clip.mp4" }],
    timeline: {
      version: 2,
      canvas: { width: 540, height: 960 },
      clips: [{ id: "c1", mediaAssetId: "take", sourceStart: 0, sourceEnd: 2 }],
      captions: { enabled: false, preset: "CLEAN", fontId: "inter-display-bold", fontSize: 48, color: "#FFFFFF", highlightColor: "#FFD54A", y: 0.85 },
      visuals: [
        { id: "num", template: "NUMBER_COUNTER", props: { value: 500, prefix: "$" }, start: 0.1, end: 1.0, placement: { mode: "MANUAL", x: 0.5, y: 0.3, scale: 0.8 } },
        { id: "icon", template: "ICON_3D", props: { icon: "PIGGY_BANK", caption: "3D" }, start: 1.0, end: 1.9, placement: { mode: "MANUAL", x: 0.5, y: 0.6, scale: 0.8 } },
      ],
    },
  };
  await sandbox.writeFiles([{ path: `${dir}/job.json`, content: Buffer.from(JSON.stringify(job)) }]);
  const out = await sh(sandbox, `${SANDBOX_ROOT}/bin/run-job.sh render --offline ${dir}/job.json | tail -1`);
  const done = JSON.parse(out.trim().split("\n").pop()!) as { result: { result: { motion: { overlays: number }; warnings: string[]; durationSeconds: number } } };
  const r = done.result.result;
  console.log(`  smoke render: overlays=${r.motion.overlays} duration=${r.durationSeconds}s warnings=${JSON.stringify(r.warnings)}`);
  if (r.motion.overlays !== 2) throw new Error(`smoke render produced ${r.motion.overlays} overlays (expected 2): ${JSON.stringify(r.warnings)}`);
  await sandbox.writeFiles([{ path: `${dir}/one.json`, content: Buffer.from(JSON.stringify({ file: "clip.mp4", output: "matte.mp4" })) }]);
  await sh(sandbox, `${SANDBOX_ROOT}/bin/run-job.sh subject-track --offline ${dir}/one.json | tail -1 | cut -c1-200`);
  await sh(sandbox, `${SANDBOX_ROOT}/bin/run-job.sh person-matte --offline ${dir}/one.json | tail -1 | cut -c1-200`);
  await sh(sandbox, `rm -rf ${dir}`);
}

async function main() {
  const creds = loadSandboxCredentials();
  const built = args.includes("--no-build") && existsSync(join(OUT, "VERSION"))
    ? { version: (await readFile(join(OUT, "VERSION"), "utf8")).trim() }
    : await buildRunner();
  console.log(`runner version ${built.version}`);

  // Iterating on a failed step (uploads can be slow from a home connection):
  //   --keep-on-failure leaves the sandbox running; --resume <name> --from <step> continues it.
  const steps = ["system", "upload", "restore", "warmup", "smoke"] as const;
  const resume = flag("--resume");
  const from = (flag("--from") ?? "system") as (typeof steps)[number];
  if (!steps.includes(from)) throw new Error(`--from must be one of ${steps.join(", ")}`);
  // --base <snapshotId>: incremental rebuild on top of a previous snapshot (system packages,
  // node_modules and model caches are already there; only changed runner files are uploaded).
  const base = flag("--base");
  const t0 = Date.now();
  const sandbox = resume
    ? await Sandbox.get({ ...creds, name: resume })
    : base
      ? await Sandbox.create({
          ...creds,
          source: { type: "snapshot", snapshotId: base },
          resources: { vcpus: 8 },
          timeout: 40 * 60_000,
          persistent: false,
          tags: { purpose: "cloud-worker-snapshot", runner: built.version },
        })
      : await Sandbox.create({
        ...creds,
        image: SANDBOX_IMAGE,
        resources: { vcpus: 8 },
        timeout: 40 * 60_000,
        persistent: false,
        tags: { purpose: "cloud-worker-snapshot", runner: built.version },
      });
  console.log(`sandbox ${sandbox.name} ${resume ? "resumed" : "booted"} in ${Date.now() - t0} ms`);
  let snapshotted = false;
  let failed = false;
  try {
    // With --base, `--from system` re-runs the apt step too (e.g. a new system package).
    const run = steps.slice(steps.indexOf(resume ? from : base ? (flag("--from") ? from : "upload") : "system"));
    if (run.includes("system")) await installSystemPackages(sandbox);
    if (run.includes("upload")) await uploadRunner(sandbox);
    if (run.includes("restore")) await restoreRunner(sandbox);
    if (run.includes("warmup")) await warmup(sandbox);
    // drawtext (storyboard sheets, on-screen text) must work — the static ffmpeg lacks it.
    // Check through run-job.sh itself (same shell options jobs run with), not a separate test.
    const ff = await sh(sandbox, `${SANDBOX_ROOT}/bin/run-job.sh print-ffmpeg`);
    if (!ff.includes("FFMPEG_BIN=/usr/bin/ffmpeg")) throw new Error(`run-job.sh would not use the system ffmpeg (drawtext): ${ff.trim()}`);
    await smoke(sandbox);
    await sh(sandbox, `echo ${built.version} > ${SANDBOX_ROOT}/SNAPSHOT_VERSION && du -sh /vercel/sandbox/runner /vercel/sandbox/cache`);
    if (keep) {
      console.log(`--keep: not snapshotting; sandbox ${sandbox.name} left running (stop it yourself)`);
      return;
    }
    const snap = await sandbox.snapshot({ expiration: 0 });
    snapshotted = true;
    const record = { snapshotId: snap.snapshotId, runnerVersion: built.version, sizeBytes: snap.sizeBytes, createdAt: new Date().toISOString(), image: SANDBOX_IMAGE };
    await mkdir(BUILD_DIR, { recursive: true });
    await writeFile(join(BUILD_DIR, "snapshot.json"), JSON.stringify(record, null, 2));
    console.log(`\nSNAPSHOT READY (${((Date.now() - t0) / 60_000).toFixed(1)} min): ${JSON.stringify(record)}`);
    console.log(`Set on Vercel: RENDER_SANDBOX_SNAPSHOT_ID=${snap.snapshotId}`);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (failed && args.includes("--keep-on-failure")) {
      console.log(`--keep-on-failure: sandbox ${sandbox.name} left running — fix, then --resume ${sandbox.name} --from <step> (or stop it: scripts/sandbox/stop.ts ${sandbox.name})`);
    } else if (!snapshotted && !keep) {
      const stopped = await sandbox.stop().catch(() => null);
      console.log(`sandbox stopped (active CPU ${stopped?.activeCpuDurationMs ?? "?"} ms)`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
