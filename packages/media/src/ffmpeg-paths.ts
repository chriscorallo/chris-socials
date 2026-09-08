import ffmpegPathImport from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

/**
 * Real, static ffmpeg/ffprobe binaries — no system install required. See /docs/DECISIONS.md
 * ("Phase 3 renderer: ffmpeg-static + ffprobe-static, hosted in apps/worker").
 */
const resolvedFfmpegPath = ffmpegPathImport as unknown as string | null;

if (!resolvedFfmpegPath) {
  throw new Error(
    "ffmpeg-static returned no binary path for this platform/architecture — see " +
      "node_modules/ffmpeg-static's supported-platforms list.",
  );
}

export const FFMPEG_PATH: string = resolvedFfmpegPath;
export const FFPROBE_PATH: string = ffprobeStatic.path;
