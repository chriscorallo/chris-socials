import { spawn } from "node:child_process";
import { FFMPEG_PATH, FFPROBE_PATH } from "@chris/media";

/** Thin promise wrappers over the repo's static ffmpeg/ffprobe (Node only). */

export function runFfmpeg(args: string[], opts: { capture?: boolean } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, ["-hide_banner", "-y", ...args]);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => {
      if (opts.capture) stdout += d;
    });
    p.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export function probeDurationSeconds(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE_PATH, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error(`ffprobe failed for ${path}`))));
  });
}

export interface LoudnessReport {
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
}

/** EBU R128 measurement (ffmpeg ebur128 filter). */
export async function measureLoudness(path: string): Promise<LoudnessReport> {
  const { stderr } = await runFfmpeg(["-nostats", "-i", path, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"]);
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => {
    const m = summary.match(re);
    return m ? Number(m[1]) : NaN;
  };
  return { integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/), truePeakDb: num(/Peak:\s+(-?[\d.]+) dBFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/) };
}
