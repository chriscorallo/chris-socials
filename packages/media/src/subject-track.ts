import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FFMPEG_PATH, FFPROBE_PATH } from "./ffmpeg-paths";
import {
  chooseDominantFace,
  expandFaceToProtectedRegion,
  nonMaxSuppression,
  roundTrack,
  smoothFaceTrack,
  type FaceDetection,
  type NormBox,
  type SubjectTrack,
} from "./subject-track-core";

/**
 * Subject tracking (Node only): where Chris's head is over time in a raw take, so motion
 * graphics can be placed around him (visual-placement.ts). Deterministic code end to end —
 * a small ONNX face detector, not a model call (CLAUDE.md: deterministic when it can be).
 *
 * Pipeline: ffmpeg samples ~3 fps, letterboxed into the detector's 640x480 input (aspect
 * preserved) -> UltraFace RFB-640 (onnxruntime-node, CPU) -> NMS -> dominant face per frame
 * (size x confidence, continuity bonus) -> gap fill + median + EMA smoothing -> expansion to
 * the protected head region -> `[{ t, box }]` in SOURCE-frame fractions.
 *
 * Model: UltraFace "version-RFB-640" from Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB
 * (MIT), vendored at packages/media/assets/models/ultraface/ with its LICENSE. 1.6 MB, ~10-30 ms
 * per frame on a laptop CPU: a 60 s take analyses in a few seconds, dominated by decoding.
 */

const MODEL_FILE = join("models", "ultraface", "version-RFB-640.onnx");

/**
 * Absolute path of the vendored model. Same resolution strategy as the bundled fonts
 * (fonts.ts): env override, then relative to this module, then a walk up from cwd —
 * import.meta.url is synthetic under Next's server bundling. Throws (never guesses).
 */
export function resolveSubjectTrackModelPath(): string {
  const candidates: string[] = [];
  if (process.env.SUBJECT_TRACK_MODEL_PATH) candidates.push(process.env.SUBJECT_TRACK_MODEL_PATH);
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), "..", "assets", MODEL_FILE));
  } catch {
    // bundled: fall through to the cwd walk
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, "packages", "media", "assets", MODEL_FILE));
    candidates.push(join(dir, "node_modules", "@chris", "media", "assets", MODEL_FILE));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(`Subject-track model not found. Searched: ${candidates.join(", ")}. Set SUBJECT_TRACK_MODEL_PATH.`);
  }
  return found;
}

export const SUBJECT_TRACK_MODEL = {
  id: "ultraface-rfb-640",
  sha256: "8f4c659275977e7a3bfbfa339a9c769ad793df50f9c0baa8c14b11baa1646430",
  inputWidth: 640,
  inputHeight: 480,
} as const;

export interface AnalyzeSubjectTrackOptions {
  /** Sampling rate (default 3 fps). */
  fps?: number;
  /** Detection confidence threshold (default 0.7). */
  minScore?: number;
  /** Faces narrower than this fraction of the frame width are ignored (default 0.03). */
  minFaceWidth?: number;
  modelPath?: string;
}

export interface SubjectTrackAnalysis {
  track: SubjectTrack;
  /** Display (post-rotation) size of the source frames the fractions refer to. */
  source: { width: number; height: number };
  framesAnalyzed: number;
  framesWithFace: number;
  fps: number;
  model: string;
}

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;

const sessions = new Map<string, Promise<{ ort: OrtModule; session: OrtSession }>>();

/** Lazily loads onnxruntime + the model once per process (a process that never tracks never
 * loads onnxruntime). */
export function loadSession(modelPath: string) {
  let p = sessions.get(modelPath);
  if (!p) {
    p = (async () => {
      const ort = await import("onnxruntime-node");
      const session = await ort.InferenceSession.create(modelPath, { logSeverityLevel: 3 });
      return { ort, session };
    })();
    p.catch(() => sessions.delete(modelPath));
    sessions.set(modelPath, p);
  }
  return p;
}

const execFileAsync = promisify(execFile);

/** Frame size as displayed (ffmpeg auto-rotates phone footage, so a 90°-tagged 1920x1080
 * stream is analysed — and must be described — as 1080x1920). */
export async function displayDimensions(videoPath: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(
    FFPROBE_PATH,
    ["-v", "error", "-select_streams", "v:0", "-show_streams", "-print_format", "json", videoPath],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const s = (JSON.parse(stdout) as {
    streams?: Array<{ width?: number; height?: number; tags?: { rotate?: string }; side_data_list?: Array<{ rotation?: number }> }>;
  }).streams?.[0];
  if (!s?.width || !s.height) throw new Error(`No video stream in ${videoPath}.`);
  const rotation = Number(s.side_data_list?.find((d) => d.rotation != null)?.rotation ?? s.tags?.rotate ?? 0);
  const quarter = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  return quarter ? { width: s.height, height: s.width } : { width: s.width, height: s.height };
}

/** Letterbox geometry of a source frame inside the detector input. */
export function letterbox(source: { width: number; height: number }, input: { width: number; height: number }) {
  const s = Math.min(input.width / source.width, input.height / source.height);
  const cw = Math.max(2, 2 * Math.round((source.width * s) / 2));
  const ch = Math.max(2, 2 * Math.round((source.height * s) / 2));
  return { cw: Math.min(cw, input.width), ch: Math.min(ch, input.height), padX: Math.floor((input.width - Math.min(cw, input.width)) / 2), padY: Math.floor((input.height - Math.min(ch, input.height)) / 2) };
}

/**
 * Decodes UltraFace outputs (scores [1,N,2] softmaxed, boxes [1,N,4] corner form in input
 * fractions) into detections in SOURCE-frame fractions, undoing the letterbox. Pure.
 */
export function decodeUltraFace(
  scores: Float32Array,
  boxes: Float32Array,
  geom: ReturnType<typeof letterbox>,
  input: { width: number; height: number },
  minScore: number,
): FaceDetection[] {
  const out: FaceDetection[] = [];
  const n = scores.length / 2;
  for (let i = 0; i < n; i++) {
    const score = scores[i * 2 + 1]!;
    if (score < minScore) continue;
    const toSrcX = (v: number) => Math.min(1, Math.max(0, (v * input.width - geom.padX) / geom.cw));
    const toSrcY = (v: number) => Math.min(1, Math.max(0, (v * input.height - geom.padY) / geom.ch));
    const x1 = toSrcX(boxes[i * 4]!);
    const y1 = toSrcY(boxes[i * 4 + 1]!);
    const x2 = toSrcX(boxes[i * 4 + 2]!);
    const y2 = toSrcY(boxes[i * 4 + 3]!);
    if (x2 <= x1 || y2 <= y1) continue;
    out.push({ box: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, score });
  }
  return out;
}

/** Streams letterboxed RGB24 frames from ffmpeg, one at a time (backpressure: ffmpeg's stdout
 * is paused while a frame is being analysed, so memory stays at ~one frame). */
export async function forEachFrame(
  videoPath: string,
  fps: number,
  geom: ReturnType<typeof letterbox>,
  input: { width: number; height: number },
  onFrame: (rgb: Buffer, index: number) => Promise<void>,
): Promise<number> {
  const frameBytes = input.width * input.height * 3;
  const vf = `fps=${fps},scale=${geom.cw}:${geom.ch}:flags=bilinear,pad=${input.width}:${input.height}:${geom.padX}:${geom.padY}:black,format=rgb24`;
  const proc = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-i", videoPath, "-an", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c.toString()));
  let pending: Buffer = Buffer.alloc(0);
  let index = 0;
  let chain: Promise<void> = Promise.resolve();
  let failed: unknown = null;

  proc.stdout.on("data", (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const frames: Buffer[] = [];
    while (pending.length >= frameBytes) {
      frames.push(Buffer.from(pending.subarray(0, frameBytes)));
      pending = pending.subarray(frameBytes);
    }
    if (frames.length === 0) return;
    proc.stdout.pause();
    chain = chain
      .then(async () => {
        for (const f of frames) {
          if (failed) return;
          await onFrame(f, index++);
        }
      })
      .catch((err) => {
        failed = err;
        proc.kill("SIGKILL");
      })
      .finally(() => proc.stdout.resume());
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", resolve);
  });
  await chain;
  if (failed) throw failed;
  if (code !== 0) throw new Error(`ffmpeg frame sampling failed (code ${code}): ${stderr.slice(-1500)}`);
  return index;
}

/** RGB24 -> NCHW float32, (v - 127) / 128 (UltraFace's training normalisation). */
export function toInputTensor(rgb: Buffer, w: number, h: number): Float32Array {
  const plane = w * h;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = (rgb[i * 3]! - 127) / 128;
    out[plane + i] = (rgb[i * 3 + 1]! - 127) / 128;
    out[2 * plane + i] = (rgb[i * 3 + 2]! - 127) / 128;
  }
  return out;
}

export async function analyzeSubjectTrackDetailed(
  videoPath: string,
  options: AnalyzeSubjectTrackOptions = {},
): Promise<SubjectTrackAnalysis> {
  const fps = options.fps ?? 3;
  const minScore = options.minScore ?? 0.7;
  const minFaceWidth = options.minFaceWidth ?? 0.03;
  const modelPath = options.modelPath ?? resolveSubjectTrackModelPath();
  const input = { width: SUBJECT_TRACK_MODEL.inputWidth, height: SUBJECT_TRACK_MODEL.inputHeight };

  const source = await displayDimensions(videoPath);
  const geom = letterbox(source, input);
  const { ort, session } = await loadSession(modelPath);

  const raw: Array<{ t: number; box: NormBox | null }> = [];
  let previous: NormBox | null = null;
  let withFace = 0;
  const frames = await forEachFrame(videoPath, fps, geom, input, async (rgb, i) => {
    const tensor = new ort.Tensor("float32", toInputTensor(rgb, input.width, input.height), [1, 3, input.height, input.width]);
    const result = await session.run({ [session.inputNames[0]!]: tensor });
    const scores = result[session.outputNames[0]!]!.data as Float32Array;
    const boxes = result[session.outputNames[1]!]!.data as Float32Array;
    const dets = nonMaxSuppression(
      decodeUltraFace(scores, boxes, geom, input, minScore).filter((d) => d.box.w >= minFaceWidth),
    );
    const face = chooseDominantFace(dets, previous);
    if (face) {
      previous = face.box;
      withFace++;
    }
    raw.push({ t: i / fps, box: face ? face.box : null });
  });

  const smoothed = smoothFaceTrack(raw);
  const track = roundTrack(smoothed.map((s) => ({ t: s.t, box: s.box ? expandFaceToProtectedRegion(s.box) : null })));
  return { track, source, framesAnalyzed: frames, framesWithFace: withFace, fps, model: SUBJECT_TRACK_MODEL.id };
}

/** Where Chris's (protected) head is over time in a raw take — see subject-track-core.ts for
 * the stored format. */
export async function analyzeSubjectTrack(videoPath: string, options: AnalyzeSubjectTrackOptions = {}): Promise<SubjectTrack> {
  return (await analyzeSubjectTrackDetailed(videoPath, options)).track;
}
