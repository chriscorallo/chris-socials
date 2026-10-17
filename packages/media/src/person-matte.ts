import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FFMPEG_PATH } from "./ffmpeg-paths";
import { probeMedia } from "./probe";
import { displayDimensions } from "./subject-track";
import { matteDimensionsFor } from "./visual-interaction";

/**
 * Person matte (Node only): a per-frame grayscale matte of Chris (white = person) aligned to a
 * raw take — same duration, same timing, the source's aspect at ≤ 512 px tall — so motion
 * graphics can be composited BEHIND him (timeline-render.ts) and the editor can preview it.
 *
 * Model: MODNet (Ke et al., "MODNet: Trimap-Free Portrait Matting in Real Time", AAAI 2022),
 * ONNX export "Xenova/modnet" (Apache-2.0, https://huggingface.co/Xenova/modnet; upstream
 * https://github.com/ZHKKKe/MODNet, Apache-2.0). Run directly with onnxruntime-node (CPU) —
 * no transformers.js image pipeline, ffmpeg streams raw RGB frames in and raw gray frames out.
 * Input [1,3,H,W] in [-1,1] with H,W multiples of 32; output alpha [1,1,H,W] in [0,1].
 *
 * Post-processing (deterministic):
 * - edge tightening: alpha → smoothstep(0.06, 0.94) — kills the faint haze MODNet leaves on
 *   background texture and firms the edge without aliasing hair;
 * - temporal stabilisation: motion-adaptive EMA per pixel — where the alpha barely changes
 *   (edge flicker) the previous frame is blended in (weight 0.45), where it changes a lot (real
 *   motion) the new value wins outright — no ghosting on movement, no shimmer on still edges;
 * - encode: H.264 (yuv420p, CRF 14, all-intra-ish GOP of 1 s) MP4 — plays in every browser
 *   (the editor's preview) and decodes reliably in ffmpeg (the renderer).
 *
 * Model cache: MATTE_CACHE_DIR, else the nearest ancestor `.cache/matte` that already has the
 * model (a git worktree reuses the main checkout's), else `<repo>/.cache/matte` (downloaded once,
 * ~26 MB, sha256-verified).
 */

export const PERSON_MATTE_MODEL = {
  id: "modnet-xenova-fp32",
  repo: "Xenova/modnet",
  file: "onnx/model.onnx",
  url: "https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx",
  sha256: "07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9",
  license: "Apache-2.0",
  /** Inference height (px). Width follows the source aspect, rounded to a multiple of 32. */
  inferHeight: 512,
} as const;

/** Storage key convention for a take's matte. */
export function matteStorageKeyFor(contentItemId: string, mediaAssetId: string): string {
  return `mattes/${contentItemId}/${mediaAssetId}.mp4`;
}

function modelRelPath(): string {
  return join("Xenova", "modnet", "onnx", "model.onnx");
}

/** Where the model lives (or will be downloaded to). Never downloads. */
export function resolveMatteModelPath(): { path: string; exists: boolean } {
  if (process.env.MATTE_MODEL_PATH) return { path: process.env.MATTE_MODEL_PATH, exists: existsSync(process.env.MATTE_MODEL_PATH) };
  if (process.env.MATTE_CACHE_DIR) {
    const p = join(process.env.MATTE_CACHE_DIR, modelRelPath());
    return { path: p, exists: existsSync(p) };
  }
  let repoRoot: string | null = null;
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, ".cache", "matte", modelRelPath());
    if (existsSync(candidate)) return { path: candidate, exists: true };
    if (!repoRoot && existsSync(join(dir, "pnpm-workspace.yaml"))) repoRoot = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { path: join(repoRoot ?? process.cwd(), ".cache", "matte", modelRelPath()), exists: false };
}

async function sha256File(path: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

/** The model path, downloading + verifying it first when missing (unless `allowDownload` is false). */
export async function ensureMatteModel(options: { allowDownload?: boolean } = {}): Promise<string> {
  const { path, exists } = resolveMatteModelPath();
  if (exists) return path;
  if (options.allowDownload === false || process.env.MATTE_ALLOW_DOWNLOAD === "0") {
    throw new Error(`Person-matte model not found at ${path} (downloads disabled). Set MATTE_CACHE_DIR or MATTE_MODEL_PATH.`);
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.part-${process.pid}`;
  const res = await fetch(PERSON_MATTE_MODEL.url);
  if (!res.ok || !res.body) throw new Error(`Person-matte model download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  const sum = await sha256File(tmp);
  if (sum !== PERSON_MATTE_MODEL.sha256) {
    await rm(tmp, { force: true });
    throw new Error(`Person-matte model checksum mismatch (${sum}).`);
  }
  await rename(tmp, path);
  return path;
}

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;
const sessions = new Map<string, Promise<{ ort: OrtModule; session: OrtSession }>>();

function loadSession(modelPath: string) {
  let p = sessions.get(modelPath);
  if (!p) {
    p = (async () => {
      const ort = await import("onnxruntime-node");
      const session = await ort.InferenceSession.create(modelPath, { logSeverityLevel: 3, graphOptimizationLevel: "all" });
      return { ort, session };
    })();
    p.catch(() => sessions.delete(modelPath));
    sessions.set(modelPath, p);
  }
  return p;
}

/** Inference size for a source: `inferHeight` tall (never upscaled), width to a multiple of 32. */
export function matteInferenceSize(source: { width: number; height: number }, inferHeight: number = PERSON_MATTE_MODEL.inferHeight) {
  const h32 = (v: number) => Math.max(32, Math.round(v / 32) * 32);
  const h = h32(Math.min(inferHeight, source.height));
  return { width: h32((source.width * h) / source.height), height: h };
}

// ---------------------------------------------------------------------------------------
// Pure post-processing (unit-tested)
// ---------------------------------------------------------------------------------------

/** Edge tightening curve: smoothstep(lo, hi) on alpha. */
export function tightenAlpha(a: number, lo = 0.06, hi = 0.94): number {
  const t = Math.min(1, Math.max(0, (a - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/**
 * Motion-adaptive temporal EMA, in place on `next` (0..1 floats): where |next − prev| is small
 * (≤ `still`) the previous value is blended in with weight `keep`; the weight falls linearly
 * to 0 by `moving`. Removes edge shimmer without ghosting real motion.
 */
export function stabilizeAlpha(prev: Float32Array | null, next: Float32Array, keep = 0.45, still = 0.08, moving = 0.3): Float32Array {
  if (!prev || prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) {
    const d = Math.abs(next[i]! - prev[i]!);
    const w = d <= still ? keep : d >= moving ? 0 : keep * (1 - (d - still) / (moving - still));
    next[i] = next[i]! * (1 - w) + prev[i]! * w;
  }
  return next;
}

/** RGB24 → NCHW float32 in [-1, 1] (MODNet's normalisation: (x/255 − 0.5)/0.5). */
export function rgbToModnetInput(rgb: Uint8Array | Buffer, w: number, h: number): Float32Array {
  const plane = w * h;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = rgb[i * 3]! / 127.5 - 1;
    out[plane + i] = rgb[i * 3 + 1]! / 127.5 - 1;
    out[2 * plane + i] = rgb[i * 3 + 2]! / 127.5 - 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------

export interface PersonMatteOptions {
  /** Matte frame rate. Default: the source's, capped at 30 (the renderer resamples to its fps). */
  fps?: number;
  /** Output matte height (px, default 512). Width follows the source aspect. */
  size?: number;
  modelPath?: string;
  /** Progress 0..1 (needs the source duration). */
  onProgress?: (p: number) => void;
}

export interface PersonMatteResult {
  outPath: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** Average share of each frame that is "person" (alpha > 0.5) — 0 means no one was found. */
  coverage: number;
  ms: number;
  model: string;
}

/**
 * Computes the person matte of `videoPath` into `outPath` (H.264 MP4, gray in luma). Streams:
 * ffmpeg decode → MODNet → post-process → ffmpeg encode, one frame in memory at a time.
 */
export async function computePersonMatte(videoPath: string, outPath: string, options: PersonMatteOptions = {}): Promise<PersonMatteResult> {
  const started = Date.now();
  const probe = await probeMedia(videoPath);
  if (!probe.hasVideo) throw new Error(`computePersonMatte: ${videoPath} has no video stream.`);
  const source = await displayDimensions(videoPath);
  const fps = options.fps ?? Math.min(30, Math.max(1, Math.round(probe.frameRate ?? 30)));
  const inf = matteInferenceSize(source);
  const out = matteDimensionsFor(source, options.size ?? 512);
  const modelPath = options.modelPath ?? (await ensureMatteModel());
  const { ort, session } = await loadSession(modelPath);
  await mkdir(dirname(outPath), { recursive: true });

  const frameBytes = inf.width * inf.height * 3;
  const plane = inf.width * inf.height;
  const dec = spawn(FFMPEG_PATH, [
    "-hide_banner", "-loglevel", "error", "-i", videoPath, "-an",
    "-vf", `setpts=PTS-STARTPTS,fps=${fps},scale=${inf.width}:${inf.height}:flags=bicubic,format=rgb24`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  const enc = spawn(FFMPEG_PATH, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${inf.width}x${inf.height}`, "-r", String(fps), "-i", "-",
    "-vf", `scale=${out.width}:${out.height}:flags=bicubic,format=yuv420p`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-g", String(fps), "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-movflags", "+faststart", "-r", String(fps), outPath,
  ]);
  let decErr = "";
  let encErr = "";
  dec.stderr.on("data", (c) => (decErr += c.toString()));
  enc.stderr.on("data", (c) => (encErr += c.toString()));
  const encDone = new Promise<number | null>((resolve, reject) => {
    enc.on("error", reject);
    enc.on("close", resolve);
  });
  const decDone = new Promise<number | null>((resolve, reject) => {
    dec.on("error", reject);
    dec.on("close", resolve);
  });

  let prev: Float32Array | null = null;
  let frames = 0;
  let coverageSum = 0;
  const totalFrames = Math.max(1, Math.round(probe.durationSeconds * fps));
  const gray = Buffer.alloc(plane);

  const processFrame = async (rgb: Buffer) => {
    const tensor = new ort.Tensor("float32", rgbToModnetInput(rgb, inf.width, inf.height), [1, 3, inf.height, inf.width]);
    const res = await session.run({ [session.inputNames[0]!]: tensor });
    const raw = res[session.outputNames[0]!]!.data as Float32Array;
    const a = new Float32Array(plane);
    for (let i = 0; i < plane; i++) a[i] = tightenAlpha(raw[i]!);
    stabilizeAlpha(prev, a);
    prev = a;
    let fg = 0;
    for (let i = 0; i < plane; i++) {
      const v = a[i]!;
      if (v > 0.5) fg++;
      gray[i] = Math.round(v * 255);
    }
    coverageSum += fg / plane;
    frames++;
    if (!enc.stdin.write(gray)) await new Promise<void>((r) => enc.stdin.once("drain", () => r()));
    options.onProgress?.(Math.min(1, frames / totalFrames));
  };

  let pending: Buffer = Buffer.alloc(0);
  let chain: Promise<void> = Promise.resolve();
  let failed: unknown = null;
  dec.stdout.on("data", (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const list: Buffer[] = [];
    while (pending.length >= frameBytes) {
      list.push(Buffer.from(pending.subarray(0, frameBytes)));
      pending = pending.subarray(frameBytes);
    }
    if (!list.length) return;
    dec.stdout.pause();
    chain = chain
      .then(async () => {
        for (const f of list) {
          if (failed) return;
          await processFrame(f);
        }
      })
      .catch((err) => {
        failed = err;
        dec.kill("SIGKILL");
      })
      .finally(() => dec.stdout.resume());
  });

  const decCode = await decDone;
  await chain;
  enc.stdin.end();
  const encCode = await encDone;
  if (failed) throw failed;
  if (decCode !== 0) throw new Error(`computePersonMatte: decode failed (${decCode}): ${decErr.slice(-1500)}`);
  if (encCode !== 0) throw new Error(`computePersonMatte: encode failed (${encCode}): ${encErr.slice(-1500)}`);
  if (frames === 0) throw new Error("computePersonMatte: no frames decoded.");
  return {
    outPath,
    width: out.width,
    height: out.height,
    fps,
    frames,
    coverage: Math.round((coverageSum / frames) * 1000) / 1000,
    ms: Date.now() - started,
    model: PERSON_MATTE_MODEL.id,
  };
}
