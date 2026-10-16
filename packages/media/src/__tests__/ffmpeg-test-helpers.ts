import { spawn } from "node:child_process";
import { FFMPEG_PATH } from "../ffmpeg-paths";
import type { Rect } from "../safe-zones";

export function runFfmpegRaw(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, ["-hide_banner", ...args]);
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(stderr) : reject(new Error(stderr.slice(-1500)))));
  });
}

/** Raw 8-bit grayscale pixels of one frame region (row-major), straight from ffmpeg. */
export function grabGrayRegion(filePath: string, atSeconds: number, rect: Rect): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const r = {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      w: Math.max(2, Math.round(rect.width)),
      h: Math.max(2, Math.round(rect.height)),
    };
    const proc = spawn(FFMPEG_PATH, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(atSeconds),
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-vf",
      `crop=${r.w}:${r.h}:${r.x}:${r.y},format=gray`,
      "-f",
      "rawvideo",
      "-",
    ]);
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(stderr))));
  });
}

export function countAbove(buf: Buffer, threshold: number): number {
  let n = 0;
  for (const v of buf) if (v > threshold) n++;
  return n;
}

export function meanAbsDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  return n === 0 ? 0 : sum / n;
}
