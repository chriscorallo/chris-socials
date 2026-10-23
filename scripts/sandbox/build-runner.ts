/**
 * Builds the cloud worker artifact that goes into the Vercel Sandbox snapshot:
 *
 *   .sandbox-build/runner/
 *     apps/worker/dist/job-runner.mjs   esbuild bundle (node24, ESM) of apps/worker/src/job-runner.ts
 *     bin/run-job.sh                    sets the runtime env (asset/model paths) and execs node
 *     package.json                      the native/heavy externals, versions pinned from this repo
 *     prompts/**  brand/**              read at runtime by the agents (REPO_ROOT = 3 dirs above dist)
 *     packages/media/assets/{fonts,models}   bundled fonts + the UltraFace face detector
 *     packages/motion/assets/sfx        the procedural SFX kit
 *     motion-bundle/                    the Remotion project pre-bundled with @remotion/bundler
 *                                       (no webpack/rspack in the sandbox)
 *     cinema-bundle/                    the mini-movie Remotion project (packages/cinema; three.js,
 *                                       @react-three/fiber, postprocessing all inside), CINEMA_BUNDLE_DIR
 *     VERSION                           sha256 of everything above (the snapshot's version)
 *
 * Usage: pnpm exec tsx scripts/sandbox/build-runner.ts [--skip-motion-bundle] [--skip-cinema-bundle]
 * Deterministic for a given commit (sorted file walk; the hash ignores mtimes).
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, rm, writeFile, chmod, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUILD_DIR = join(REPO, ".sandbox-build");
export const OUT = join(BUILD_DIR, "runner");
/** Where the artifact lives inside the sandbox. */
export const SANDBOX_ROOT = "/vercel/sandbox/runner";
export const SANDBOX_CACHE = "/vercel/sandbox/cache";

/** Packages installed with npm inside the sandbox (native binaries / large runtime deps). */
const EXTERNALS: Array<{ name: string; from: string }> = [
  { name: "ffmpeg-static", from: "packages/media" },
  { name: "ffprobe-static", from: "packages/media" },
  { name: "onnxruntime-node", from: "packages/media" },
  // Reference learning: OCR (pure WASM; loaded by name at runtime, so it must be installed here).
  { name: "tesseract.js", from: "packages/media" },
  { name: "@huggingface/transformers", from: "packages/media" },
  { name: "@remotion/renderer", from: "packages/motion" },
  // mini-movies: Kokoro TTS (kokoro-js brings phonemizer — eSpeak NG WASM — and its 28 English
  // voice files); the model weights download in `warmup` into TRANSCRIPTION_CACHE_DIR.
  { name: "kokoro-js", from: "packages/cinema" },
];
/** Never needed at runtime in the sandbox (the motion bundle is prebuilt; pg-native is optional). */
const NEVER_LOADED = ["@remotion/bundler", "pg-native", "sharp", "@remotion/compositor-*"];

async function versionOf(name: string, from: string): Promise<string> {
  const req = createRequire(join(REPO, from, "package.json"));
  let dir = dirname(req.resolve(name));
  for (let i = 0; i < 6; i++) {
    const p = join(dir, "package.json");
    if (existsSync(p)) {
      const pkg = JSON.parse(await readFile(p, "utf8")) as { name?: string; version: string };
      if (pkg.name === name) return pkg.version;
    }
    dir = dirname(dir);
  }
  throw new Error(`could not find the installed version of ${name}`);
}

/** Runtime env for every job (paths inside the sandbox). Secrets are NOT here — the dispatcher
 * passes them per job in a 0600 env file. */
export function runtimeEnv(root = SANDBOX_ROOT, cache = SANDBOX_CACHE): Record<string, string> {
  return {
    NODE_ENV: "production",
    RENDER_FONTS_DIR: `${root}/packages/media/assets/fonts`,
    SUBJECT_TRACK_MODEL_PATH: `${root}/packages/media/assets/models/ultraface/version-RFB-640.onnx`,
    TESSERACT_LANG_PATH: `${root}/packages/media/assets/models/tesseract`,
    // Director chat facial-expression model (FER+, MIT, 19 MB) — downloaded at build time below.
    EXPRESSION_MODEL_PATH: `${root}/packages/media/assets/models/emotion-ferplus/emotion-ferplus-12-int8.onnx`,
    EXPRESSION_MODEL_DOWNLOAD: "off",
    MOTION_SFX_DIR: `${root}/packages/motion/assets/sfx`,
    MOTION_BUNDLE_DIR: `${root}/motion-bundle`,
    CINEMA_BUNDLE_DIR: `${root}/cinema-bundle`,
    MATTE_CACHE_DIR: `${cache}/matte`,
    TRANSCRIPTION_CACHE_DIR: `${cache}/transformers`,
    // GPU-less microVM: WebGL (3D templates) through ANGLE on SwiftShader.
    REMOTION_GL: "swangle",
    // SwiftShader is multi-threaded per tab: 2 tabs measured fastest on 8 vCPU (60 s vs 89 s at
    // 1, 117 s at 4, 152 s at 8 for the same 159 frames).
    REMOTION_CONCURRENCY: "2",
  };
}

/**
 * Left out of the uploaded tarball and re-created inside the sandbox (the operator's uplink can
 * be very slow): the motion bundle's public/ dir is a copy of packages/media/assets, the
 * UltraFace model is downloaded from its source (SOURCE.txt), the SFX kit is regenerated by its
 * deterministic generator. All verified against MANIFEST.sha256 afterwards.
 */
export const LITE_EXCLUDES = ["./motion-bundle/public", "./cinema-bundle/public", "./packages/media/assets/models/ultraface/version-RFB-640.onnx", "./packages/media/assets/models/emotion-ferplus", "./packages/media/assets/models/tesseract", "./packages/motion/assets/sfx/*.wav"];
/** tesseract.js language data (tessdata_fast English, gzipped) — downloaded into the snapshot. */
export const TESSERACT_LANG_URL = "https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz";
export const ULTRAFACE_URL = "https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/raw/master/models/onnx/version-RFB-640.onnx";
/** Director chat expression model (ONNX Model Zoo, MIT); SHA-256 pinned in packages/media take-understanding.ts. */
export const EXPRESSION_MODEL_URL = "https://github.com/onnx/models/raw/main/validated/vision/body_analysis/emotion_ferplus/model/emotion-ferplus-12-int8.onnx";

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

export async function hashDir(dir: string, skip: (rel: string) => boolean = () => false): Promise<string> {
  const h = createHash("sha256");
  for (const f of await walk(dir)) {
    const rel = relative(dir, f);
    if (skip(rel)) continue;
    h.update(rel);
    h.update("\0");
    h.update(await readFile(f));
  }
  return h.digest("hex");
}

async function bundleMotion(outDir: string) {
  const motionReq = createRequire(join(REPO, "packages/motion/package.json"));
  const { bundle } = (await import(pathToFileURL(motionReq.resolve("@remotion/bundler")).href)) as typeof import("@remotion/bundler");
  await bundle({
    entryPoint: join(REPO, "packages/motion/src/remotion/entry.ts"),
    publicDir: join(REPO, "packages/media/assets"),
    enableCaching: false,
    outDir,
  });
}

/** The mini-movie Remotion project (packages/cinema/src/remotion/entry.ts), public dir = the media assets (fonts). */
async function bundleCinema(outDir: string) {
  const cinemaReq = createRequire(join(REPO, "packages/cinema/package.json"));
  const { bundle } = (await import(pathToFileURL(cinemaReq.resolve("@remotion/bundler")).href)) as typeof import("@remotion/bundler");
  await bundle({
    entryPoint: join(REPO, "packages/cinema/src/remotion/entry.ts"),
    publicDir: join(REPO, "packages/media/assets"),
    enableCaching: false,
    outDir,
  });
}

export async function buildRunner(options: { skipMotionBundle?: boolean; skipCinemaBundle?: boolean } = {}): Promise<{ dir: string; version: string; bytes: number }> {
  const t0 = Date.now();
  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, "apps/worker/dist"), { recursive: true });

  const externals = await Promise.all(EXTERNALS.map(async (e) => ({ ...e, version: await versionOf(e.name, e.from) })));
  await build({
    entryPoints: [join(REPO, "apps/worker/src/job-runner.ts")],
    outfile: join(OUT, "apps/worker/dist/job-runner.mjs"),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    // CJS deps inside an ESM bundle call require(): give them one.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    external: [...EXTERNALS.map((e) => e.name), ...NEVER_LOADED],
    jsx: "automatic",
    loader: { ".node": "copy", ".wasm": "binary" },
    logLevel: "warning",
    legalComments: "none",
    sourcemap: false,
    // Smaller upload (the snapshot build uploads this over the operator's connection); names
    // kept so stack traces in JobRun errors stay readable.
    minify: true,
    keepNames: true,
  });

  // Runtime-read files, laid out like the repo so path resolution is unchanged.
  for (const rel of ["prompts", "brand", "packages/media/assets", "packages/motion/assets/sfx", "packages/motion/scripts/generate-sfx.mjs"]) {
    await cp(join(REPO, rel), join(OUT, rel), { recursive: true });
  }

  if (!options.skipMotionBundle) {
    await bundleMotion(join(OUT, "motion-bundle"));
    for (const f of await walk(join(OUT, "motion-bundle"))) if (f.endsWith(".map")) await rm(f);
  }
  if (!options.skipCinemaBundle) {
    await bundleCinema(join(OUT, "cinema-bundle"));
    for (const f of await walk(join(OUT, "cinema-bundle"))) if (f.endsWith(".map")) await rm(f);
  }

  await mkdir(join(OUT, "bin"), { recursive: true });
  const env = runtimeEnv();
  const sh = [
    "#!/usr/bin/env bash",
    "# Generated by scripts/sandbox/build-runner.ts — runtime env for the cloud worker.",
    "set -euo pipefail",
    // Defaults; a value already in the environment (e.g. a per-job override) wins.
    ...Object.entries(env).map(([k, v]) => `export ${k}="${"$"}{${k}:-${v}}"`),
    // System ffmpeg (has drawtext) when the snapshot installed it.
    // No `grep -q` here: with pipefail, grep -q exiting early SIGPIPEs ffmpeg and the test fails.
    'if [ -z "${FFMPEG_BIN:-}" ] && [ -x /usr/bin/ffmpeg ] && [ "$(/usr/bin/ffmpeg -hide_banner -filters 2>/dev/null | grep -c " drawtext " || true)" != "0" ]; then export FFMPEG_BIN=/usr/bin/ffmpeg; fi',
    // `run-job.sh print-ffmpeg` (used by the snapshot check) prints which ffmpeg jobs will use.
    'if [ "${1:-}" = "print-ffmpeg" ]; then echo "FFMPEG_BIN=${FFMPEG_BIN:-static}"; exit 0; fi',
    `cd ${SANDBOX_ROOT}`,
    `exec node --enable-source-maps ${SANDBOX_ROOT}/apps/worker/dist/job-runner.mjs "$@"`,
    "",
  ].join("\n");
  await writeFile(join(OUT, "bin/run-job.sh"), sh);
  await chmod(join(OUT, "bin/run-job.sh"), 0o755);

  const pkg = {
    name: "chris-cloud-worker",
    private: true,
    type: "module",
    description: "Generated by scripts/sandbox/build-runner.ts",
    dependencies: Object.fromEntries(externals.map((e) => [e.name, e.version])),
  };
  await writeFile(join(OUT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  // Every file's sha256 — the sandbox verifies the restored tree against it (`sha256sum -c`),
  // including the files it re-creates instead of uploading (LITE_EXCLUDES).
  const lines: string[] = [];
  for (const f of await walk(OUT)) lines.push(`${createHash("sha256").update(await readFile(f)).digest("hex")}  ./${relative(OUT, f)}`);
  await writeFile(join(OUT, "MANIFEST.sha256"), lines.join("\n") + "\n");
  const version = (await hashDir(OUT)).slice(0, 16);
  await writeFile(join(OUT, "VERSION"), version + "\n");
  let bytes = 0;
  for (const f of await walk(OUT)) bytes += (await stat(f)).size;
  console.log(`runner built in ${Date.now() - t0} ms: ${OUT} (${(bytes / 1e6).toFixed(1)} MB, version ${version})`);
  console.log(`externals: ${externals.map((e) => `${e.name}@${e.version}`).join(", ")}`);
  return { dir: OUT, version, bytes };
}

if (process.argv[1] && /build-runner\.ts$/.test(process.argv[1])) {
  await buildRunner({ skipMotionBundle: process.argv.includes("--skip-motion-bundle"), skipCinemaBundle: process.argv.includes("--skip-cinema-bundle") });
}
