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
