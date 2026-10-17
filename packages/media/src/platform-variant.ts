import { execFile, spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { FFMPEG_PATH, FFPROBE_PATH } from "./ffmpeg-paths";
import {
  checkAgainstProfile,
  sizeCapRetryVideoKbps,
  variantFps,
  type PlatformProfile,
  type ProfileIssue,
  type VariantProbe,
} from "./platform-profiles";

const execFileAsync = promisify(execFile);

/**
 * Per-platform variant encoding from the master render. See platform-profiles.ts for the
 * profiles and docs/decisions-pending/timeline-engine.md ("VARIANT INTEGRATION") for the
 * call contract.
 */

function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, ["-hide_banner", ...args]);
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg exited with code ${code}:\n${stderr.slice(-2000)}`)),
    );
  });
}

export interface LoudnessMeasurement {
  integratedLufs: number;
  truePeakDbtp: number;
  lra: number;
  threshold: number;
  targetOffset: number;
}

/** Parses the JSON block loudnorm prints with print_format=json (last {...} in stderr). */
export function parseLoudnormJson(stderr: string): LoudnessMeasurement {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("loudnorm produced no measurement JSON.");
  const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
  const f = (k: string) => {
    const v = parseFloat(j[k] ?? "");
    return Number.isFinite(v) ? v : -99;
  };
  return {
    integratedLufs: f("input_i"),
    truePeakDbtp: f("input_tp"),
    lra: f("input_lra"),
    threshold: f("input_thresh"),
    targetOffset: f("target_offset"),
  };
}

/** EBU R128 measurement of a file's audio (loudnorm analysis pass). */
export async function measureLoudness(
  path: string,
  target: { integratedLufs: number; truePeakDbtp: number; lra: number } = { integratedLufs: -14, truePeakDbtp: -1, lra: 11 },
): Promise<LoudnessMeasurement> {
  const stderr = await runFfmpeg([
    "-nostats", "-i", path, "-vn",
    "-af", `loudnorm=I=${target.integratedLufs}:TP=${target.truePeakDbtp}:LRA=${target.lra}:print_format=json`,
    "-f", "null", "-",
  ]);
  return parseLoudnormJson(stderr);
}

/** True when the MP4's moov box precedes mdat (progressive playback / faststart). */
export async function isFaststart(path: string): Promise<boolean | null> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    let offset = 0;
    const header = Buffer.alloc(16);
    for (let i = 0; i < 64 && offset + 8 <= size; i++) {
      await fh.read(header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      else if (boxSize === 0) return null;
      if (boxSize < 8) return null;
      offset += boxSize;
    }
    return null;
  } finally {
    await fh.close();
  }
}

interface StreamInfo {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
  profile?: string;
}

/** Probe with the fields profile preflight needs (per-stream bitrates, pix_fmt, faststart). */
export async function probeVariant(path: string): Promise<VariantProbe & { videoBitrateKbps: number | null; audioBitrateKbps: number | null; videoProfile: string | null }> {
  const { stdout } = await execFileAsync(
    FFPROBE_PATH,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: StreamInfo[] };
  const v = data.streams?.find((s) => s.codec_type === "video");
  const a = data.streams?.find((s) => s.codec_type === "audio");
  const rate = (r?: string) => {
    if (!r || r === "0/0") return null;
    const [nu, de] = r.split("/").map(Number);
    return nu !== undefined && de ? Math.round((nu / de) * 1000) / 1000 : null;
  };
  const kbps = (b?: string) => (b ? Math.round(parseInt(b, 10) / 1000) : null);
  return {
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps: rate(v?.avg_frame_rate) ?? rate(v?.r_frame_rate),
    durationSeconds: parseFloat(data.format?.duration ?? "0") || 0,
    fileSizeBytes: (await stat(path)).size,
    videoCodec: v?.codec_name ?? null,
    pixelFormat: v?.pix_fmt ?? null,
    audioCodec: a?.codec_name ?? null,
    audioSampleRate: a?.sample_rate ? parseInt(a.sample_rate, 10) : null,
    audioChannels: a?.channels ?? null,
    faststart: await isFaststart(path),
    videoBitrateKbps: kbps(v?.bit_rate),
    audioBitrateKbps: kbps(a?.bit_rate),
    videoProfile: v?.profile ?? null,
  };
}

export class VariantTooLargeError extends Error {
  constructor(profile: PlatformProfile, sizeBytes: number) {
    super(
      `${profile.label} variant is ${sizeBytes} bytes even after a lower-bitrate retry — over the ` +
        `${profile.maxFileSizeBytes}-byte limit. Shorten the video or publish elsewhere.`,
    );
    this.name = "VariantTooLargeError";
  }
}

export interface EncodePlatformVariantInput {
  masterPath: string;
  outputPath: string;
  profile: PlatformProfile;
  /** Writes `${outputPath without .mp4}.cover.jpg` from this output time. */
  coverFrameSeconds?: number;
  /** Encoder preset (default "slow"; tests use a faster one). */
  preset?: string;
}

export interface EncodePlatformVariantResult {
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  fileSizeBytes: number;
  videoBitrateKbps: number | null;
  audioBitrateKbps: number | null;
  integratedLufs: number;
  truePeakDbtp: number;
  coverImagePath?: string;
  /** Whether the size-cap retry ran. */
  retriedForSize: boolean;
  /** Preflight of the delivered file (should be empty). */
  issues: ProfileIssue[];
  ffmpegArgs: string[];
}

/** ffmpeg args for one variant encode (pure — unit-testable). */
export function variantEncodeArgs(input: {
  masterPath: string;
  outputPath: string;
  profile: PlatformProfile;
  fps: number;
  loudness: LoudnessMeasurement | null;
  preset: string;
  /** Size-cap retry: average-bitrate mode instead of CRF. */
  videoKbps?: number;
  hasAudio: boolean;
}): string[] {
  const { profile: p, fps } = input;
  const W = p.canvas.width;
  const H = p.canvas.height;
  const gop = Math.max(1, Math.round(p.video.gopSeconds * fps));
  const maxrate = fps > 30.5 ? p.video.maxrateKbps.upTo60fps : p.video.maxrateKbps.upTo30fps;
  const cappedRate = input.videoKbps ? Math.min(maxrate, input.videoKbps) : maxrate;
  const vf =
    `scale=w='max(${W},2*round(iw*max(${W}/iw,${H}/ih)/2))':h='max(${H},2*round(ih*max(${W}/iw,${H}/ih)/2))':flags=lanczos,` +
    `crop=${W}:${H},setsar=1,fps=${fps},format=yuv420p`;
  const args = ["-y", "-i", input.masterPath, "-map", "0:v:0", "-vf", vf,
    "-c:v", "libx264", "-preset", input.preset,
    ...(input.videoKbps ? ["-b:v", `${input.videoKbps}k`] : ["-crf", String(p.video.crf)]),
    "-maxrate", `${cappedRate}k`, "-bufsize", `${Math.round(cappedRate * p.video.bufsizeFactor)}k`,
    "-profile:v", p.video.profile, "-level:v", p.video.level, "-pix_fmt", p.video.pixelFormat,
    "-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0", "-flags", "+cgop", "-bf", String(p.video.bFrames),
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-r", String(fps),
  ];
  if (input.hasAudio) {
    const L = p.loudness;
    const m = input.loudness;
    // Second loudnorm pass with the first pass's measurements: linear (pure gain) whenever the
    // true-peak ceiling allows, so dynamics are untouched.
    const af = m
      ? `loudnorm=I=${L.integratedLufs}:TP=${L.truePeakDbtp}:LRA=${L.lra}:measured_I=${m.integratedLufs}:measured_TP=${m.truePeakDbtp}:measured_LRA=${m.lra}:measured_thresh=${m.threshold}:offset=${m.targetOffset}:linear=true,aresample=${p.audio.sampleRate}`
      : `aresample=${p.audio.sampleRate}`;
    args.push("-map", "0:a:0", "-af", af, "-c:a", "aac", "-profile:a", p.audio.profile, "-b:a", `${p.audio.bitrateKbps}k`,
      "-ar", String(p.audio.sampleRate), "-ac", String(p.audio.channels));
  }
  args.push("-movflags", "+faststart", input.outputPath);
  return args;
}

/**
 * Re-encodes the master into a platform variant: canvas, fps (master's, capped), H.264 High
 * 4.2 closed GOP, BT.709 tags, AAC-LC, two-pass loudness normalisation to the profile target,
 * faststart. If the result is over the profile's size cap it retries once at a computed
 * average bitrate, then fails with VariantTooLargeError. Optionally extracts a cover JPEG.
 */
export async function encodePlatformVariant(input: EncodePlatformVariantInput): Promise<EncodePlatformVariantResult> {
  const { profile } = input;
  const master = await probeVariant(input.masterPath);
  const fps = variantFps(master.fps ?? 30, profile);
  const hasAudio = master.audioCodec != null;
  const loudness = hasAudio ? await measureLoudness(input.masterPath, profile.loudness) : null;
  const preset = input.preset ?? "slow";

  let args = variantEncodeArgs({ ...input, fps, loudness, preset, hasAudio });
  await runFfmpeg(args);
  let out = await probeVariant(input.outputPath);
  let retriedForSize = false;
  if (out.fileSizeBytes > profile.maxFileSizeBytes) {
    const videoKbps = sizeCapRetryVideoKbps({
      maxFileSizeBytes: profile.maxFileSizeBytes,
      durationSeconds: out.durationSeconds,
      audioKbps: hasAudio ? profile.audio.bitrateKbps : 0,
    });
    if (videoKbps == null) throw new VariantTooLargeError(profile, out.fileSizeBytes);
    retriedForSize = true;
    args = variantEncodeArgs({ ...input, fps, loudness, preset, hasAudio, videoKbps });
    await runFfmpeg(args);
    out = await probeVariant(input.outputPath);
    if (out.fileSizeBytes > profile.maxFileSizeBytes) throw new VariantTooLargeError(profile, out.fileSizeBytes);
  }

  const delivered = hasAudio ? await measureLoudness(input.outputPath, profile.loudness) : null;

  let coverImagePath: string | undefined;
  if (input.coverFrameSeconds != null) {
    const t = Math.min(Math.max(0, input.coverFrameSeconds), Math.max(0, out.durationSeconds - 1 / fps));
    coverImagePath = input.outputPath.replace(/\.mp4$/i, "") + ".cover.jpg";
    await runFfmpeg(["-y", "-ss", String(t), "-i", input.outputPath, "-frames:v", "1", "-q:v", "2", coverImagePath]);
  }

  return {
    outputPath: input.outputPath,
    width: out.width ?? 0,
    height: out.height ?? 0,
    fps: out.fps ?? fps,
    durationSeconds: out.durationSeconds,
    fileSizeBytes: out.fileSizeBytes,
    videoBitrateKbps: out.videoBitrateKbps,
    audioBitrateKbps: out.audioBitrateKbps,
    integratedLufs: delivered?.integratedLufs ?? -99,
    truePeakDbtp: delivered?.truePeakDbtp ?? -99,
    coverImagePath,
    retriedForSize,
    issues: checkAgainstProfile(out, profile),
    ffmpegArgs: args,
  };
}
