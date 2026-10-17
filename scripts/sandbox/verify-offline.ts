/**
 * End-to-end check of a cloud-worker snapshot with REAL footage, no database: boots a sandbox
 * from the snapshot, uploads a talking-head stand-in clip (the public-domain portrait fixture,
 * packages/media/src/__tests__/fixtures/NOTICE.txt) and a timeline with a big number BEHIND the
 * subject + a 3D icon, runs `run-job.sh render --offline` (face track → MODNet matte → Remotion
 * motion layer with WebGL → depth compositing), downloads the MP4, extracts frames to look at,
 * and reports boot / render times and the sandbox's active CPU (→ cost).
 *
 *   SANDBOX_ENV_FILE=… pnpm exec tsx scripts/sandbox/verify-offline.ts [--snapshot snap_…] [--local] [--vcpus 8] [--env K=V …]
 *
 * --local runs the same offline render on this machine (sanity check of the job, no sandbox).
 * Outputs: .sandbox-build/verify/{clip.mp4,job.json,out.mp4,result.json,frames/*.png,report.json}
 */
import { Sandbox } from "@vercel/sandbox";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { BUILD_DIR, REPO, SANDBOX_ROOT } from "./build-runner";
import { loadSandboxCredentials } from "./credentials";

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? (args[args.indexOf(n) + 1] ?? null) : null);
const DIR = join(BUILD_DIR, "verify");
const req = createRequire(join(REPO, "packages/media/package.json"));
const FFMPEG = req("ffmpeg-static") as string;

async function ff(a: string[]) {
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...a], { maxBuffer: 1 << 26 });
}

/** 6 s 1080x1920 stand-in: the portrait with headroom over a blurred fill, a slow handheld drift, a quiet tone. */
async function makeClip(path: string) {
  const img = join(REPO, "packages/media/src/__tests__/fixtures/face-portrait-pd.jpg");
  await ff([
    "-loop", "1", "-framerate", "30", "-t", "6", "-i", img,
    "-f", "lavfi", "-t", "6", "-i", "sine=frequency=196:sample_rate=48000",
    "-filter_complex",
    [
      "[0:v]split[a][b]",
      "[a]scale=1120:1990:force_original_aspect_ratio=increase,crop=1120:1990,gblur=sigma=40,eq=brightness=-0.08[bg]",
      "[b]scale=1120:-2[fg]",
      "[bg][fg]overlay=0:H-h[c]",
      "[c]crop=1080:1920:x='20+18*sin(t*0.9)':y='35+22*sin(t*0.6)',format=yuv420p[v]",
      "[1:a]volume=0.15[aud]",
    ].join(";"),
    "-map", "[v]", "-map", "[aud]", "-c:v", "libx264", "-preset", "medium", "-crf", "30", "-c:a", "aac", "-b:a", "64k", "-shortest", path,
  ]);
}

async function headBox(clip: string) {
  const { analyzeSubjectTrackDetailed } = (await import(join(REPO, "packages/media/src/index.ts"))) as typeof import("../../packages/media/src/index");
  const r = await analyzeSubjectTrackDetailed(clip);
  const boxes = r.track.map((s) => s.box).filter((b): b is NonNullable<typeof b> => !!b);
  if (!boxes.length) throw new Error("no face found in the stand-in clip");
  const avg = (k: "x" | "y" | "w" | "h") => boxes.reduce((a, b) => a + b[k], 0) / boxes.length;
  return { x: avg("x"), y: avg("y"), w: avg("w"), h: avg("h"), track: r.track };
}

function timelineFor(head: { x: number; y: number; w: number; h: number }) {
  // The number's glyph band crosses the top of the (protected) head region: the classic
  // "behind the head" composition. Its centre sits a little above the head box's top.
  const numY = Math.max(0.12, head.y + 0.19 * head.h);
  return {
    version: 2,
    canvas: { width: 1080, height: 1920 },
    clips: [{ id: "c1", mediaAssetId: "take", sourceStart: 0, sourceEnd: 5.9 }],
    captions: { enabled: false, preset: "CLEAN", fontId: "inter-display-bold", fontSize: 60, color: "#FFFFFF", highlightColor: "#FFD54A", y: 0.86 },
    grade: { preset: "CINEMATIC" },
    visuals: [
      { id: "num", template: "NUMBER_COUNTER", props: { value: 24500, prefix: "$" }, start: 0.3, end: 3.4, placement: { mode: "MANUAL", x: 0.5, y: numY, scale: 1 }, depth: "BEHIND_SUBJECT", enterSfx: "RISER" },
      { id: "coin", template: "ICON_3D", props: { icon: "PIGGY_BANK", caption: "Free in 5 years" }, start: 3.6, end: 5.8, placement: { mode: "MANUAL", x: 0.5, y: 0.78, scale: 0.8 }, integration: { shadow: true, lightWrap: true, sceneMatch: true }, enterSfx: "SHIMMER" },
    ],
  };
}

async function main() {
  await mkdir(join(DIR, "frames"), { recursive: true });
  const clip = join(DIR, "clip.mp4");
  if (!existsSync(clip)) await makeClip(clip);
  const head = await headBox(clip);
  const job = { output: "out.mp4", encode: { preset: "medium", crf: 20 }, assets: [{ id: "take", file: "clip.mp4", subjectTrack: head.track }], timeline: timelineFor(head) };
  await writeFile(join(DIR, "job.json"), JSON.stringify(job, null, 2));
  console.log(`stand-in ready (${((await readFile(clip)).byteLength / 1e6).toFixed(2)} MB); head box ${JSON.stringify({ x: +head.x.toFixed(3), y: +head.y.toFixed(3), w: +head.w.toFixed(3), h: +head.h.toFixed(3) })}`);

  const report: Record<string, unknown> = {};
  if (args.includes("--local")) {
    const { runOffline } = (await import(join(REPO, "apps/worker/src/offline.ts"))) as typeof import("../../apps/worker/src/offline");
    const t = Date.now();
    const r = await runOffline("render", join(DIR, "job.json"));
    report.local = { ms: Date.now() - t, result: r };
  } else {
    const snapshotId = flag("--snapshot") ?? process.env.RENDER_SANDBOX_SNAPSHOT_ID ?? (JSON.parse(await readFile(join(BUILD_DIR, "snapshot.json"), "utf8")) as { snapshotId: string }).snapshotId;
    const vcpus = Number(flag("--vcpus") ?? 8);
    const creds = loadSandboxCredentials();
    const t0 = Date.now();
    const sandbox = await Sandbox.create({ ...creds, source: { type: "snapshot", snapshotId }, resources: { vcpus }, timeout: 20 * 60_000, persistent: false, tags: { purpose: "cloud-worker-verify" } });
    report.bootMs = Date.now() - t0;
    console.log(`sandbox ${sandbox.name} from ${snapshotId}: booted in ${report.bootMs} ms (${vcpus} vCPU)`);
    try {
      const dir = "/vercel/sandbox/verify";
      const t1 = Date.now();
      await sandbox.writeFiles([
        { path: `${dir}/clip.mp4`, content: await readFile(clip) },
        { path: `${dir}/job.json`, content: Buffer.from(JSON.stringify(job)) },
        { path: `${dir}/one.json`, content: Buffer.from(JSON.stringify({ file: "clip.mp4", output: "matte.mp4" })) },
      ]);
      report.uploadMs = Date.now() - t1;
      const exec = async (kind: string, file: string) => {
        const s = Date.now();
        const env = Object.fromEntries(args.filter((a, i) => args[i - 1] === "--env").map((kv) => kv.split("=") as [string, string]));
        const r = await sandbox.runCommand({ cmd: "bash", args: [`${SANDBOX_ROOT}/bin/run-job.sh`, kind, "--offline", `${dir}/${file}`], env });
        const out = await r.stdout();
        if (r.exitCode !== 0) throw new Error(`${kind} failed (${r.exitCode}): ${(await r.stderr()).slice(-3000)}\n${out.slice(-2000)}`);
        const last = JSON.parse(out.trim().split("\n").pop()!);
        console.log(`  ${kind}: ${Date.now() - s} ms wall`);
        return { wallMs: Date.now() - s, ...last };
      };
      report.render = await exec("render", "job.json");
      report.transcribe = await exec("transcribe", "one.json");
      report.subjectTrack = await exec("subject-track", "one.json");
      const t2 = Date.now();
      for (const f of ["out.mp4", "result.json", "matte-take.mp4"]) {
        const buf = await sandbox.readFileToBuffer({ path: `${dir}/${f}` });
        if (buf) await writeFile(join(DIR, f), buf);
      }
      report.downloadMs = Date.now() - t2;
    } finally {
      const stopped = await sandbox.stop().catch(() => null);
      report.activeCpuMs = (stopped as { activeCpuDurationMs?: number } | null)?.activeCpuDurationMs ?? null;
      report.sessionMs = Date.now() - t0;
      console.log(`sandbox stopped: active CPU ${report.activeCpuMs} ms over ${report.sessionMs} ms`);
    }
  }
  // Frames to look at: number behind the head, the 3D icon.
  for (const t of [0.6, 1.6, 2.8, 4.6, 5.4]) await ff(["-ss", String(t), "-i", join(DIR, "out.mp4"), "-frames:v", "1", join(DIR, "frames", `f-${t.toFixed(1)}.png`)]);
  await ff(["-ss", "2.8", "-i", join(DIR, "out.mp4"), "-vf", "crop=1080:900:0:0,scale=540:-2", "-frames:v", "1", join(DIR, "frames", "head-crop-2.8.png")]);
  await writeFile(join(DIR, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, (k, v) => (k === "track" || k === "words" || k === "placements" ? undefined : v), 2).slice(0, 4000));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
