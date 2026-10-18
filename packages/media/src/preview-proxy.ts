/**
 * Editor PREVIEW assets for a raw take — the finishing editor never has to play the camera
 * original (4K HEVC at 20–50 Mbps on an iPhone: slow to download, slow to seek, heavy to decode
 * twice for cuts). Generated once per take (ingest heavy job / lazy backfill):
 *
 *  - proxy:     H.264 High, fit inside 720x1280 (portrait) / 1280x720, ≤ 30 fps, ~2.5 Mbps,
 *               a keyframe every 0.5 s (closed GOP, no scene-cut keyframes) so any seek decodes
 *               ≤ 15 frames, AAC-LC 128k stereo 48 kHz, moov first (plays while downloading).
 *  - filmstrip: one JPEG sprite of evenly spaced thumbnails (≤ 120 tiles, 120 px tall) for the
 *               timeline and an instant first-frame placeholder.
 *  - peaks:     audio peak envelope, 20 values per second, 0–255.
 *
 * PURE planning (`planPreviewAssets`, `filmstripTileAt`, `peaksFromPcm`) is browser-safe and
 * unit-tested; `makePreviewAssets` runs ffmpeg (Node only). The renderer ALWAYS uses the
 * originals — the proxy is preview-only and never a render input.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { FFMPEG_PATH } from "./ffmpeg-paths";
import { displayDimensions } from "./subject-track";

import { planPreviewAssets, peaksFromPcm, PEAKS_PER_SECOND, type PreviewPlan } from "./preview-plan";

export * from "./preview-plan";

/** The ffmpeg arguments for the proxy (exported for tests). */
export function proxyFfmpegArgs(srcPath: string, outPath: string, plan: PreviewPlan, hasAudio: boolean): string[] {
  const p = plan.proxy;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    srcPath,
    "-map",
    "0:v:0",
    ...(hasAudio ? ["-map", "0:a:0?"] : []),
    "-vf",
    `scale=${p.width}:${p.height}:flags=bicubic,fps=${p.fps},format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-profile:v",
    "high",
    "-level",
    "4.0",
    "-b:v",
    `${p.videoKbps}k`,
    "-maxrate",
    `${Math.round(p.videoKbps * 1.25)}k`,
    "-bufsize",
    `${Math.round(p.videoKbps * 1.25)}k`,
    "-g",
    String(p.gopFrames),
    "-keyint_min",
    String(p.gopFrames),
    "-sc_threshold",
    "0",
    "-flags",
    "+cgop",
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"] : ["-an"]),
    "-movflags",
    "+faststart",
    outPath,
  ];
}

function run(args: string[], collect = false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args);
    const chunks: Buffer[] = [];
    let err = "";
    proc.stdout.on("data", (d: Buffer) => {
      if (collect) chunks.push(d);
    });
    proc.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(-600)}`))));
  });
}

export interface PreviewAssetsResult {
  proxyPath: string;
  filmstripPath: string;
  plan: PreviewPlan;
  peaks: { perSecond: number; values: number[] } | null;
  ms: number;
}

/** Builds proxy + filmstrip (from the proxy, cheap) + peaks into `outDir`. Node only. */
export async function makePreviewAssets(
  srcPath: string,
  outDir: string,
  src: { width: number; height: number; fps: number | null; durationSeconds: number; hasAudio: boolean },
): Promise<PreviewAssetsResult> {
  const t0 = Date.now();
  // Plan from the file's real DISPLAY size (rotation applied) — ffmpeg autorotates the frames, so
  // planning from stored/coded dims squeezed vertical iPhone takes into a landscape proxy.
  const shown = await displayDimensions(srcPath).catch(() => null);
  const plan = planPreviewAssets(shown ? { ...src, width: shown.width, height: shown.height } : src);
  const proxyPath = join(outDir, "proxy.mp4");
  const filmstripPath = join(outDir, "filmstrip.jpg");
  await run(proxyFfmpegArgs(srcPath, proxyPath, plan, src.hasAudio));
  const f = plan.filmstrip;
  // Tile i = the frame at (i + 0.5) * step.
  await run([
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    String(Math.min(f.step / 2, Math.max(0, src.durationSeconds - 0.05))),
    "-i",
    proxyPath,
    "-vf",
    `fps=1/${f.step},scale=${f.tileW}:${f.tileH},tile=${f.cols}x${f.rows}`,
    "-frames:v",
    "1",
    "-q:v",
    "5",
    filmstripPath,
  ]);
  let peaks: PreviewAssetsResult["peaks"] = null;
  if (src.hasAudio) {
    const rate = 4000;
    const pcm = await run(["-hide_banner", "-loglevel", "error", "-i", proxyPath, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"], true).catch(() => null);
    if (pcm && pcm.length >= 2) peaks = { perSecond: PEAKS_PER_SECOND, values: peaksFromPcm(new Int16Array(new Uint8Array(pcm.subarray(0, pcm.length - (pcm.length % 2))).buffer), rate) };
  }
  return { proxyPath, filmstripPath, plan, peaks, ms: Date.now() - t0 };
}
