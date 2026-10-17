/**
 * In-app recording choices (pure): container/codec, bitrate, camera constraints, labels.
 * iPhone Safari's MediaRecorder writes MP4 (H.264 + AAC); desktop Chrome writes WebM (and, on
 * recent versions, MP4 too). MP4/H.264 is preferred everywhere — it's what the rest of the
 * pipeline (ffmpeg, the editor, the platforms) handles most cheaply. See
 * docs/decisions-pending/teleprompter.md.
 */

export const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2", // H.264 High@4.0 + AAC-LC (iOS 14.5+/macOS Safari)
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=h264,opus",
  "video/webm",
] as const;

/** Video-only recordings (the pre-rendered floating script — a canvas, no microphone). */
export const VIDEO_ONLY_MIME_CANDIDATES = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"] as const;

/** First supported candidate, or "" (let the browser pick its default). */
export function pickRecorderMime(isTypeSupported: (t: string) => boolean, candidates: readonly string[] = MIME_CANDIDATES): string {
  for (const t of candidates) {
    try {
      if (isTypeSupported(t)) return t;
    } catch {
      // some engines throw on unknown codec strings — treat as unsupported
    }
  }
  return "";
}

export function extensionForMime(mime: string): "mp4" | "webm" | "mov" {
  const m = mime.toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("quicktime")) return "mov";
  return "mp4";
}

/** Base content type (no codecs) — what the upload stores as the file's type. */
export function baseMime(mime: string): string {
  const b = mime.split(";")[0]!.trim().toLowerCase();
  return b || "video/mp4";
}

/**
 * Video bitrate for a resolution + frame rate — generous, because this is a camera ORIGINAL the
 * editor re-encodes later (iPhone's own Camera app writes ~16 Mbps at 1080p30 HEVC / more in
 * H.264). 1080p30 → 10 Mbps, 1080p60 → 15, 4K30 → 35, 720p30 → 6.
 */
export function videoBitrateFor(width: number, height: number, fps: number): number {
  const short = Math.min(width, height) || 1080;
  let base: number;
  if (short >= 2000) base = 35_000_000;
  else if (short >= 1400) base = 20_000_000;
  else if (short >= 1000) base = 10_000_000;
  else if (short >= 700) base = 6_000_000;
  else base = 3_000_000;
  return fps > 45 ? Math.round(base * 1.5) : base;
}

export const AUDIO_BITRATE = 192_000;

export type Quality = "1080" | "4k";
export type Facing = "user" | "environment";

/**
 * getUserMedia constraints. Sizes are "ideal" so every phone falls back to its best; iPhone
 * delivers portrait frames when the phone is held upright. Voice processing (echo cancel /
 * noise suppression / auto gain) is OFF by default — those are tuned for calls and make a
 * creator's voice sound thin; `voiceCleanup` turns them back on for noisy places.
 */
export function cameraConstraints(opts: { facing: Facing; quality: Quality; fps: 30 | 60; voiceCleanup: boolean }): MediaStreamConstraints {
  const long = opts.quality === "4k" ? 3840 : 1920;
  const short = opts.quality === "4k" ? 2160 : 1080;
  return {
    video: {
      facingMode: { ideal: opts.facing },
      width: { ideal: long },
      height: { ideal: short },
      frameRate: { ideal: opts.fps },
    },
    audio: {
      echoCancellation: opts.voiceCleanup,
      noiseSuppression: opts.voiceCleanup,
      autoGainControl: opts.voiceCleanup,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
    },
  };
}

/** "1080p · 30fps" from what the camera ACTUALLY delivers (short side = the "p"). */
export function settingsLabel(s: { width?: number; height?: number; frameRate?: number }): string {
  const w = s.width ?? 0;
  const h = s.height ?? 0;
  if (!w || !h) return "";
  const short = Math.min(w, h);
  const res = short >= 2000 ? "4K" : `${short}p`;
  const fps = s.frameRate ? ` · ${Math.round(s.frameRate)}fps` : "";
  return `${res}${fps}`;
}

/** What the camera can do, from MediaStreamTrack.getCapabilities() (absent on older Safari). */
export function supportsQuality(caps: { width?: { max?: number }; height?: { max?: number }; frameRate?: { max?: number } } | null | undefined): { fourK: boolean; sixty: boolean } {
  const maxLong = Math.max(caps?.width?.max ?? 0, caps?.height?.max ?? 0);
  return { fourK: maxLong >= 3840, sixty: (caps?.frameRate?.max ?? 0) >= 59 };
}

/** File name for an in-app take: "teleprompter-take-2-2026-10-17_14-05.mp4". */
export function takeFileName(index: number, mime: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}-${pad(at.getMinutes())}`;
  return `teleprompter-take-${index}-${stamp.replace(" ", "_")}.${extensionForMime(mime)}`;
}
