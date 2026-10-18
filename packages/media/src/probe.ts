import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FFPROBE_PATH } from "./ffmpeg-paths";

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  formatName: string;
  bitRate: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

/**
 * Deterministic technical metadata extraction — no LLM, no judgment calls. Feeds Phase 3's
 * media analysis (spec §9 step 10) and the raw-materials for Take Selector/Edit Planner
 * context (duration, dimensions) and Technical QC (dimensions/encoding checks).
 */
export async function probeMedia(filePath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    FFPROBE_PATH,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { maxBuffer: 10 * 1024 * 1024 },
  );

  const data = JSON.parse(stdout) as FfprobeOutput;
  const streams = data.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");

  const durationSeconds = parseFloat(
    data.format?.duration ?? videoStream?.duration ?? audioStream?.duration ?? "0",
  );

  let frameRate: number | null = null;
  if (videoStream?.avg_frame_rate && videoStream.avg_frame_rate !== "0/0") {
    const [num, den] = videoStream.avg_frame_rate.split("/").map(Number);
    frameRate = num !== undefined && den ? num / den : null;
  }

  // DISPLAY size, not the coded size: iPhone footage is stored landscape with a 90° rotation flag,
  // and every consumer (players, ffmpeg's autorotate, layout, crops) sees it upright. Using the
  // coded size made vertical takes look sideways to the app (e.g. a 1280x720 preview proxy).
  const rotation = Number(videoStream?.side_data_list?.find((d) => d.rotation != null)?.rotation ?? videoStream?.tags?.rotate ?? 0);
  const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const codedW = videoStream?.width ?? null;
  const codedH = videoStream?.height ?? null;

  return {
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    width: quarterTurn ? codedH : codedW,
    height: quarterTurn ? codedW : codedH,
    frameRate,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    formatName: data.format?.format_name ?? "",
    bitRate: data.format?.bit_rate ? parseInt(data.format.bit_rate, 10) : null,
  };
}
