import { spawn } from "node:child_process";
import { readFile, stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFMPEG_PATH } from "./ffmpeg-paths";

/**
 * Deterministic frame sampling for Visual QA (spec §9 step 14 — "inspects the actual rendered
 * file over time"). Seeking + single-frame extraction is real ffmpeg work, not model
 * judgment; only *what the frame shows* is Visual QA's job (packages/agents). Given the same
 * input file and the same timestamps, this always produces the same bytes.
 */
export interface ExtractedFrame {
  atSeconds: number;
  base64: string;
  mediaType: "image/png";
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}:\n${stderr.slice(-2000)}`));
      }
    });
  });
}

/** Picks up to `maxFrames` sample points across [0, durationSeconds): always the first frame
 * (spec explicitly calls out "first-frame comprehension" as its own check), then evenly
 * spaced through the rest. Pure function — same duration/count always yields the same
 * timestamps, which is what makes frame extraction reproducible across runs. */
export function pickSampleTimestamps(durationSeconds: number, maxFrames: number): number[] {
  if (durationSeconds <= 0 || maxFrames <= 0) return [];
  if (maxFrames === 1) return [0];

  const clamped = Math.min(maxFrames, Math.max(1, Math.ceil(durationSeconds)));
  const step = durationSeconds / clamped;
  const timestamps: number[] = [];
  for (let i = 0; i < clamped; i++) {
    const t = i === 0 ? 0 : Math.min(i * step, durationSeconds - 0.05);
    timestamps.push(Math.round(t * 100) / 100);
  }
  return timestamps;
}

export class FrameExtractionError extends Error {
  constructor(atSeconds: number, cause: unknown) {
    super(`Failed to extract a frame at t=${atSeconds}s: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "FrameExtractionError";
  }
}

/** Extracts one PNG per timestamp via ffmpeg's own `-ss` seek (fast, keyframe-adjacent —
 * acceptable for sampling, not for frame-exact editing). Runs sequentially rather than
 * Promise.all — no correctness requirement here, just keeps a burst of ffmpeg child processes
 * from being spawned at once for a long render. */
export async function extractFrames(
  videoPath: string,
  atSecondsList: number[],
): Promise<ExtractedFrame[]> {
  if (atSecondsList.length === 0) return [];

  const workDir = await mkdtemp(join(tmpdir(), "chris-frames-"));
  try {
    const frames: ExtractedFrame[] = [];
    for (let i = 0; i < atSecondsList.length; i++) {
      const atSeconds = atSecondsList[i]!;
      const framePath = join(workDir, `frame-${i}.png`);
      try {
        await runFfmpeg([
          "-y",
          "-ss",
          String(atSeconds),
          "-i",
          videoPath,
          "-frames:v",
          "1",
          framePath,
        ]);
        // Same class of ffmpeg quirk found in packages/media/src/render.ts's trim-clamping
        // bug: a seek past the end of the input exits 0 ("Output file is empty, nothing was
        // encoded") instead of erroring — verified directly against the real binary while
        // building this. Check the file actually exists and has bytes rather than trusting
        // the exit code.
        const stats = await stat(framePath).catch(() => null);
        if (!stats || stats.size === 0) {
          throw new Error(
            `ffmpeg exited successfully but wrote no frame at t=${atSeconds}s — the timestamp ` +
              `is likely past the end of the video.`,
          );
        }
        const bytes = await readFile(framePath);
        frames.push({ atSeconds, base64: bytes.toString("base64"), mediaType: "image/png" });
      } catch (err) {
        throw new FrameExtractionError(atSeconds, err);
      }
    }
    return frames;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export interface ScaledFrame {
  atSeconds: number;
  base64: string;
  mediaType: "image/jpeg";
  width: number;
  height: number;
}

/**
 * Downscaled JPEG frames for a vision model watching a whole video (the Viewer Panel): each
 * frame scaled so its long edge is `longEdge` px (never upscaled), JPEG `-q:v 3`. At 360×640 a
 * frame costs ≈ 308 image tokens instead of ≈ 2 765 for a full-HD PNG, and burned-in captions
 * stay legible. Input seeking (`-ss` before `-i`): fast and frame-accurate on re-encode. A
 * timestamp ffmpeg can't produce a frame for (past the end of a VFR file) is skipped rather
 * than failing the whole set — the caller sees which times came back.
 */
export async function extractScaledFrames(
  videoPath: string,
  atSecondsList: number[],
  options: { longEdge?: number; onFrame?: (done: number, total: number) => void } = {},
): Promise<ScaledFrame[]> {
  if (atSecondsList.length === 0) return [];
  const longEdge = Math.max(64, Math.round(options.longEdge ?? 640));
  const workDir = await mkdtemp(join(tmpdir(), "chris-vframes-"));
  try {
    const out: ScaledFrame[] = [];
    for (let i = 0; i < atSecondsList.length; i++) {
      const atSeconds = atSecondsList[i]!;
      const framePath = join(workDir, `f-${i}.jpg`);
      await runFfmpeg([
        "-y",
        "-loglevel",
        "error",
        "-ss",
        String(atSeconds),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        `scale='if(gte(iw,ih),min(${longEdge},iw),-2)':'if(gte(iw,ih),-2,min(${longEdge},ih))':flags=area`,
        "-q:v",
        "3",
        framePath,
      ]).catch(() => undefined);
      const stats = await stat(framePath).catch(() => null);
      options.onFrame?.(i + 1, atSecondsList.length);
      if (!stats || stats.size === 0) continue;
      const bytes = await readFile(framePath);
      const size = jpegSize(bytes);
      out.push({ atSeconds, base64: bytes.toString("base64"), mediaType: "image/jpeg", width: size?.width ?? 0, height: size?.height ?? 0 });
    }
    return out;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Width/height from a JPEG's SOF marker (no image library needed). */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    }
    i += 2 + len;
  }
  return null;
}
