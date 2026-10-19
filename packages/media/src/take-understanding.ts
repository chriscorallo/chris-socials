import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FFMPEG_PATH } from "./ffmpeg-paths";
import { probeMedia } from "./probe";
import {
  SUBJECT_TRACK_MODEL,
  decodeUltraFace,
  displayDimensions,
  forEachFrame,
  letterbox,
  loadSession,
  resolveSubjectTrackModelPath,
  toInputTensor,
} from "./subject-track";
import { chooseDominantFace, nonMaxSuppression, type NormBox } from "./subject-track-core";
import { UNDERSTANDING_VERSION, type SpriteInfo, type TakeUnderstanding, type UnderstandingSample } from "./director/understanding";

/**
 * Take understanding (Node only) — what the Director chat "sees" of one raw take, computed ONCE
 * per take in the worker and cached (TakeUnderstanding table). Free and local:
 *
 * - one ffmpeg decode at 4 fps, letterboxed into 640×480 RGB (the same frames the face tracker
 *   reads), UltraFace RFB-640 for the face box (MIT, vendored);
 * - a facial-expression classifier on each face crop: **FER+ (emotion-ferplus-12-int8, ONNX
 *   Model Zoo, MIT)**, 64×64 grayscale → 8-class softmax (neutral, happy, surprise, sad, angry,
 *   disgust, fear, contempt). Approximate — FER+ was trained on small, mostly frontal web faces;
 *   every value carries its confidence and the pack says so;
 * - motion energy = mean absolute difference of 32×(…) grayscale thumbnails between samples;
 * - a JPEG sprite of the take (one cell every 0.5 s) — the browser composes the labelled
 *   contact sheet for the CURRENT edit from it (director/understanding.ts contactSheetPlan).
 *
 * Long takes: the sample step grows so a take never needs more than ~720 classifier runs
 * (~25 ms each on a laptop CPU).
 */

export const EXPRESSION_MODEL = {
  id: "emotion-ferplus-12-int8",
  file: "emotion-ferplus-12-int8.onnx",
  url: "https://github.com/onnx/models/raw/main/validated/vision/body_analysis/emotion_ferplus/model/emotion-ferplus-12-int8.onnx",
  sha256: "3e47195d79e9593294df9e81a6d296a1e10969b68a717284081c29493a0ff5f1",
  bytes: 19_300_656,
  license: "MIT",
  source: "ONNX Model Zoo — FER+ emotion recognition (Microsoft FER+ labels on FER-2013 faces), int8-quantized",
} as const;

const MODEL_REL = join("models", "emotion-ferplus", EXPRESSION_MODEL.file);

function candidatePaths(): string[] {
  const c: string[] = [];
  if (process.env.EXPRESSION_MODEL_PATH) c.push(process.env.EXPRESSION_MODEL_PATH);
  try {
    c.push(join(dirname(fileURLToPath(import.meta.url)), "..", "assets", MODEL_REL));
  } catch {
    // bundled
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    c.push(join(dir, "packages", "media", "assets", MODEL_REL));
    c.push(join(dir, "node_modules", "@chris", "media", "assets", MODEL_REL));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return c;
}

/** Absolute path of the expression model, or null when it isn't on disk. */
export function findExpressionModelPath(): string | null {
  return candidatePaths().find((p) => existsSync(p)) ?? null;
}

/**
 * The model path — downloading it once (19 MB, SHA-256 verified) into
 * packages/media/assets/models/emotion-ferplus/ when it's missing and downloads are allowed
 * (`EXPRESSION_MODEL_DOWNLOAD` ≠ "off"). The cloud worker's snapshot downloads it at build
 * time (scripts/sandbox/sandbox-setup.ts). Not committed (size).
 */
export async function ensureExpressionModel(): Promise<string> {
  const found = findExpressionModelPath();
  if (found) return found;
  if (process.env.EXPRESSION_MODEL_DOWNLOAD === "off") {
    throw new Error(`Expression model not found (searched ${candidatePaths().join(", ")}). Set EXPRESSION_MODEL_PATH.`);
  }
  const target = candidatePaths().find((p) => p.includes(join("packages", "media", "assets"))) ?? candidatePaths()[0]!;
  const res = await fetch(EXPRESSION_MODEL.url);
  if (!res.ok) throw new Error(`Couldn't download the expression model (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== EXPRESSION_MODEL.sha256) throw new Error(`Expression model checksum mismatch (${sha}).`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(`${target}.part`, buf);
  await rename(`${target}.part`, target);
  return target;
}

function softmax(v: ArrayLike<number>): number[] {
  let m = -Infinity;
  for (let i = 0; i < v.length; i++) m = Math.max(m, v[i]!);
  const e = Array.from(v, (x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => Math.round((x / s) * 1000) / 1000);
}

/**
 * Square face crop from a letterboxed RGB frame → 64×64 grayscale float (0–255), FER+'s input.
 * `face` is in source fractions; the crop is 1.15× the face's longer side (FER faces are framed
 * brow-to-chin with a little margin). Bilinear sampling. Pure.
 */
export function faceCropGray64(
  rgb: Uint8Array,
  frame: { width: number; height: number },
  geom: { cw: number; ch: number; padX: number; padY: number },
  face: NormBox,
): Float32Array {
  const cx = geom.padX + (face.x + face.w / 2) * geom.cw;
  const cy = geom.padY + (face.y + face.h / 2) * geom.ch;
  const side = 1.15 * Math.max(face.w * geom.cw, face.h * geom.ch);
  const out = new Float32Array(64 * 64);
  const x0 = cx - side / 2;
  const y0 = cy - side / 2;
  const step = side / 64;
  const W = frame.width;
  const H = frame.height;
  const gray = (x: number, y: number) => {
    const xi = Math.max(0, Math.min(W - 1, x));
    const yi = Math.max(0, Math.min(H - 1, y));
    const o = (yi * W + xi) * 3;
    return 0.299 * rgb[o]! + 0.587 * rgb[o + 1]! + 0.114 * rgb[o + 2]!;
  };
  for (let j = 0; j < 64; j++) {
    const sy = y0 + (j + 0.5) * step - 0.5;
    const y1 = Math.floor(sy);
    const fy = sy - y1;
    for (let i = 0; i < 64; i++) {
      const sx = x0 + (i + 0.5) * step - 0.5;
      const x1 = Math.floor(sx);
      const fx = sx - x1;
      const a = gray(x1, y1);
      const b = gray(x1 + 1, y1);
      const c = gray(x1, y1 + 1);
      const d = gray(x1 + 1, y1 + 1);
      out[j * 64 + i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

/** 32-wide grayscale thumbnail of the content area (for frame-difference motion). */
function thumb(rgb: Uint8Array, frame: { width: number }, geom: { cw: number; ch: number; padX: number; padY: number }): Float32Array {
  const tw = 32;
  const th = Math.max(8, Math.round((32 * geom.ch) / geom.cw));
  const out = new Float32Array(tw * th);
  for (let j = 0; j < th; j++) {
    for (let i = 0; i < tw; i++) {
      const x = Math.floor(geom.padX + ((i + 0.5) / tw) * geom.cw);
      const y = Math.floor(geom.padY + ((j + 0.5) / th) * geom.ch);
      const o = (y * frame.width + x) * 3;
      out[j * tw + i] = 0.299 * rgb[o]! + 0.587 * rgb[o + 1]! + 0.114 * rgb[o + 2]!;
    }
  }
  return out;
}

export interface AnalyzeTakeUnderstandingOptions {
  mediaAssetId: string;
  /** Samples per second (default 4 → 0.25 s; lowered automatically for long takes). */
  fps?: number;
  /** Sprite cell spacing (default 0.5 s) and width (default 180 px). */
  spriteStepS?: number;
  spriteCellW?: number;
  expressionModelPath?: string;
  faceModelPath?: string;
}

export interface TakeUnderstandingAnalysis {
  understanding: TakeUnderstanding;
  spriteJpeg: Buffer | null;
  ms: number;
}

/** Runs the whole analysis on a local video file. */
export async function analyzeTakeUnderstanding(videoPath: string, options: AnalyzeTakeUnderstandingOptions): Promise<TakeUnderstandingAnalysis> {
  const t0 = Date.now();
  const probe = await probeMedia(videoPath);
  const duration = Math.max(0, probe.durationSeconds ?? 0);
  const maxSamples = 720;
  const fps = Math.min(options.fps ?? 4, duration > 0 ? Math.max(0.5, maxSamples / duration) : 4);
  const stepS = Math.round((1 / fps) * 1000) / 1000;
  const source = await displayDimensions(videoPath);
  const input = { width: SUBJECT_TRACK_MODEL.inputWidth, height: SUBJECT_TRACK_MODEL.inputHeight };
  const geom = letterbox(source, input);
  const face = await loadSession(options.faceModelPath ?? resolveSubjectTrackModelPath());
  const expr = await loadSession(options.expressionModelPath ?? (await ensureExpressionModel()));

  const samples: UnderstandingSample[] = [];
  let previous: NormBox | null = null;
  let prevThumb: Float32Array | null = null;
  await forEachFrame(videoPath, fps, geom, input, async (rgb, i) => {
    const t = Math.round(i * stepS * 1000) / 1000;
    const tensor = new face.ort.Tensor("float32", toInputTensor(rgb, input.width, input.height), [1, 3, input.height, input.width]);
    const res = await face.session.run({ [face.session.inputNames[0]!]: tensor });
    const dets = nonMaxSuppression(
      decodeUltraFace(res[face.session.outputNames[0]!]!.data as Float32Array, res[face.session.outputNames[1]!]!.data as Float32Array, geom, input, 0.7).filter((d) => d.box.w >= 0.03),
    );
    const best = chooseDominantFace(dets, previous);
    let probs: number[] | null = null;
    if (best) {
      previous = best.box;
      const crop = faceCropGray64(rgb, input, geom, best.box);
      const x = new expr.ort.Tensor("float32", crop, [1, 1, 64, 64]);
      const out = await expr.session.run({ [expr.session.inputNames[0]!]: x });
      probs = softmax(out[expr.session.outputNames[0]!]!.data as Float32Array);
    }
    const th = thumb(rgb, input, geom);
    let motion = 0;
    if (prevThumb) {
      let s = 0;
      for (let k = 0; k < th.length; k++) s += Math.abs(th[k]! - prevThumb[k]!);
      motion = Math.min(1, Math.round((s / th.length / 255) * 4 * 1000) / 1000);
    }
    prevThumb = th;
    const r4 = (n: number) => Math.round(n * 10000) / 10000;
    samples.push({ t, face: best ? { x: r4(best.box.x), y: r4(best.box.y), w: r4(best.box.w), h: r4(best.box.h) } : null, probs, motion });
  });

  let spriteJpeg: Buffer | null = null;
  let sprite: SpriteInfo | null;
  try {
    const made = await makeSprite(videoPath, duration, source, options.spriteStepS ?? 0.5, options.spriteCellW ?? 180);
    spriteJpeg = made.jpeg;
    sprite = { ...made.info, key: null };
  } catch {
    sprite = null;
  }

  return {
    understanding: {
      version: UNDERSTANDING_VERSION,
      mediaAssetId: options.mediaAssetId,
      durationS: Math.round(duration * 1000) / 1000,
      stepS,
      source,
      model: { id: `${EXPRESSION_MODEL.id}+${SUBJECT_TRACK_MODEL.id}`, license: EXPRESSION_MODEL.license, source: EXPRESSION_MODEL.source },
      samples,
      sprite,
    },
    spriteJpeg,
    ms: Date.now() - t0,
  };
}

/** One JPEG of the take: a cell every `stepS` seconds (coarser for long takes, ≤ 200 cells). */
async function makeSprite(
  videoPath: string,
  duration: number,
  source: { width: number; height: number },
  stepS0: number,
  cellW: number,
): Promise<{ jpeg: Buffer; info: Omit<SpriteInfo, "key"> }> {
  const stepS = Math.max(stepS0, Math.ceil((duration / 200) * 10) / 10);
  const count = Math.max(1, Math.ceil(duration / stepS));
  const cellH = 2 * Math.round((cellW * source.height) / source.width / 2);
  const cols = Math.min(10, count);
  const rows = Math.ceil(count / cols);
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "chris-sprite-"));
  const out = join(dir, "sprite.jpg");
  try {
    const vf = `fps=${1 / stepS},scale=${cellW}:${cellH}:flags=bicubic,tile=${cols}x${rows}:padding=0:color=black`;
    await new Promise<void>((resolve, reject) => {
      const p = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", "-i", videoPath, "-an", "-vf", vf, "-frames:v", "1", "-q:v", "4", out]);
      let err = "";
      p.stderr.on("data", (c) => (err += c.toString()));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`sprite failed: ${err.slice(-500)}`))));
    });
    return { jpeg: await readFile(out), info: { cols, rows, cellW, cellH, stepS, count } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

