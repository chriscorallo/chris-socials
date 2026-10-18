/**
 * Per-platform delivery profiles — PURE data (browser-safe; the finishing editor reads the
 * safe zones from here, so the overlay the editor shows is the one preflight checks).
 *
 * Model: ONE high-quality master render (renderTimeline, MASTER_ENCODE) + a lightweight
 * per-platform VARIANT re-encoded from it (encodePlatformVariant). Values cite official
 * guidance where it exists; where the platform is silent we pick conservative values and say
 * so (`basis`). Sources, checked 2026-10-16, are listed per profile and in
 * docs/decisions-pending/timeline-engine.md.
 */
import { PLATFORM_UI, derivedSafeZone, type PlatformUi } from "./platform-ui";

export type PlatformId = "INSTAGRAM" | "TIKTOK" | "YOUTUBE";

export interface SafeZonePx {
  /** px of app chrome at a 1080x1920 canvas; scale proportionally for other sizes. */
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PlatformProfile {
  id: PlatformId;
  label: string;
  canvas: { width: number; height: number };
  /** Keep the master's frame rate (constant), capped here. */
  maxFps: number;
  minFps: number;
  video: {
    codec: "h264";
    profile: "high";
    level: "4.2";
    pixelFormat: "yuv420p";
    /** Tagged BT.709 primaries / transfer / matrix, TV range. */
    colorspace: "bt709";
    /** Keyframe interval (closed GOP, no scene-cut keyframes). */
    gopSeconds: number;
    bFrames: number;
    crf: number;
    /** VBV cap by output frame rate. */
    maxrateKbps: { upTo30fps: number; upTo60fps: number };
    /** bufsize = maxrate x this. */
    bufsizeFactor: number;
  };
  audio: { codec: "aac"; profile: "aac_low"; sampleRate: 48000; channels: 2; bitrateKbps: number };
  loudness: { integratedLufs: number; truePeakDbtp: number; lra: number; basis: string };
  container: { format: "mp4"; faststart: true };
  maxFileSizeBytes: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  recommendedDurationNote: string;
  /**
   * Conservative margin rectangle, DERIVED from `ui.conservative` (derivedSafeZone) — kept for
   * code that wants a single rectangle. Warnings and the editor mock use `ui`'s regions.
   */
  safeZone: SafeZonePx;
  safeZoneBasis: string;
  /** Where the app's UI sits over the video on a reference iPhone (platform-ui.ts). */
  ui: PlatformUi;
  cover: {
    /** Whether the publish API can pick a cover frame from the video by timestamp. */
    timestampSupported: boolean;
    apiField: string | null;
    unit: "ms" | null;
    note: string;
  };
  sources: string[];
}

const COMMON = {
  canvas: { width: 1080, height: 1920 },
  maxFps: 60,
  minFps: 23,
  container: { format: "mp4", faststart: true },
} as const;

export const PLATFORM_PROFILES: Record<PlatformId, PlatformProfile> = {
  INSTAGRAM: {
    ...COMMON,
    id: "INSTAGRAM",
    label: "Instagram Reels",
    video: {
      codec: "h264",
      profile: "high",
      level: "4.2",
      pixelFormat: "yuv420p",
      colorspace: "bt709",
      gopSeconds: 2,
      bFrames: 2,
      crf: 19,
      // Graph API: VBR, max 25 Mbps. Well under it — Instagram re-encodes anyway.
      maxrateKbps: { upTo30fps: 10000, upTo60fps: 14000 },
      bufsizeFactor: 2,
    },
    // Graph API spec lists AAC, 48 kHz max, 128 kbps.
    audio: { codec: "aac", profile: "aac_low", sampleRate: 48000, channels: 2, bitrateKbps: 128 },
    loudness: {
      integratedLufs: -14,
      truePeakDbtp: -1,
      lra: 11,
      basis: "Meta publishes no loudness target; -14 LUFS / -1 dBTP is common short-form practice (conservative choice).",
    },
    maxFileSizeBytes: 300 * 1024 * 1024,
    minDurationSeconds: 3,
    maxDurationSeconds: 15 * 60,
    recommendedDurationNote: "API accepts 3 s - 15 min; Reels that perform tend to be 15-90 s.",
    safeZone: derivedSafeZone(PLATFORM_UI.INSTAGRAM),
    safeZoneBasis:
      "Derived from Meta's Reels ads safe zone (14% top / 35% bottom / 6% sides, plus the lower-right action area ≈227 px wide below y 1152 in Meta's diagram; checked 2026-10-17). Meta publishes no organic-Reels figure; the editor's mock/warnings use the best-estimate regions in platform-ui.ts.",
    ui: PLATFORM_UI.INSTAGRAM,
    cover: {
      timestampSupported: true,
      apiField: "thumb_offset",
      unit: "ms",
      note: "Graph API `thumb_offset` (ms, default 0 = first frame). `cover_url` (an uploaded image) overrides it if both are set.",
    },
    sources: [
      "https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media",
      "https://www.facebook.com/business/ads-guide/update/video/instagram-reels",
    ],
  },
  TIKTOK: {
    ...COMMON,
    id: "TIKTOK",
    label: "TikTok",
    video: {
      codec: "h264",
      profile: "high",
      level: "4.2",
      pixelFormat: "yuv420p",
      colorspace: "bt709",
      gopSeconds: 2,
      bFrames: 2,
      crf: 18,
      // No official organic bitrate guidance (H.264 recommended, 23-60 fps, 360-4096 px).
      maxrateKbps: { upTo30fps: 12000, upTo60fps: 16000 },
      bufsizeFactor: 2,
    },
    // No official audio spec for the Content Posting API; AAC-LC 48 kHz stereo 192k (conservative).
    audio: { codec: "aac", profile: "aac_low", sampleRate: 48000, channels: 2, bitrateKbps: 192 },
    loudness: {
      integratedLufs: -14,
      truePeakDbtp: -1,
      lra: 11,
      basis: "TikTok publishes no loudness target; -14 LUFS / -1 dBTP is common short-form practice (conservative choice).",
    },
    maxFileSizeBytes: 4 * 1024 * 1024 * 1024,
    minDurationSeconds: 3,
    maxDurationSeconds: 600,
    recommendedDurationNote:
      "Everyone can post 3 min; some creators 10 min — the real per-creator cap comes from creator_info (max_video_post_duration_sec). Short-form sweet spot 15-60 s.",
    safeZone: derivedSafeZone(PLATFORM_UI.TIKTOK),
    safeZoneBasis:
      "Derived from TikTok's official In-Feed ads safe-zone template (Apr 2025 file: 720x1280 top 160 / bottom 440 / sides 80, right action column from y 560 → 240 / 660 / 60 / 300 px at 1080x1920; checked 2026-10-17). No organic figure is published; it varies with caption length.",
    ui: PLATFORM_UI.TIKTOK,
    cover: {
      timestampSupported: true,
      apiField: "post_info.video_cover_timestamp_ms",
      unit: "ms",
      note: "Content Posting API `video_cover_timestamp_ms`; unset/invalid = first frame.",
    },
    sources: [
      "https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide",
      "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post",
      "https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads?lang=en",
    ],
  },
  YOUTUBE: {
    ...COMMON,
    id: "YOUTUBE",
    label: "YouTube Shorts",
    video: {
      codec: "h264",
      profile: "high",
      level: "4.2",
      pixelFormat: "yuv420p",
      colorspace: "bt709",
      // "Closed GOP. GOP of half the frame rate." + "2 consecutive B frames".
      gopSeconds: 0.5,
      bFrames: 2,
      crf: 17,
      // Recommended 1080p SDR: 8 Mbps @24-30 fps, 12 Mbps @48-60 fps — capped a bit above.
      maxrateKbps: { upTo30fps: 10000, upTo60fps: 15000 },
      bufsizeFactor: 2,
    },
    // Recommended: AAC-LC, stereo, 48 kHz, 384 kbps.
    audio: { codec: "aac", profile: "aac_low", sampleRate: 48000, channels: 2, bitrateKbps: 384 },
    loudness: {
      integratedLufs: -14,
      truePeakDbtp: -1,
      lra: 11,
      basis: "YouTube normalises playback toward ~-14 LUFS (measured, not officially published); it only turns loud uploads down.",
    },
    maxFileSizeBytes: 256 * 1024 * 1024 * 1024,
    minDurationSeconds: 1,
    maxDurationSeconds: 180,
    recommendedDurationNote: "Vertical/square uploads up to 3 min are Shorts.",
    safeZone: derivedSafeZone(PLATFORM_UI.YOUTUBE),
    safeZoneBasis:
      "Derived from Google Ads' vertical-video safe zone (official 1080x1920 template: top 288 / bottom 672 / left 48 / right 192, as measured by two independent tools; checked 2026-10-17), left widened to 60 for the side crop on tall phones. Ads guidance, not an organic Shorts spec.",
    ui: PLATFORM_UI.YOUTUBE,
    cover: {
      timestampSupported: false,
      apiField: null,
      unit: null,
      note:
        "No cover-frame timestamp in the API. thumbnails.set (JPEG/PNG <= 50 MB) is best-effort for Shorts (custom Shorts thumbnails reached desktop Studio for YPP creators in 2026; API effect unverified).",
    },
    sources: [
      "https://support.google.com/youtube/answer/1722171",
      "https://developers.google.com/youtube/v3/docs/videos/insert",
      "https://support.google.com/youtube/answer/15424877",
      "https://support.google.com/google-ads/answer/9128498",
      "https://developers.google.com/youtube/v3/docs/thumbnails/set",
    ],
  },
};

/**
 * The margin rectangle the graphics auto-placement solver has always used (the union of the
 * 2026-10-16 margins). Frozen so that refining the platform UI model never moves an auto-placed
 * graphic in an existing render; switching placement to the region model is a deliberate,
 * separate change (docs/decisions-pending/editor-smoothness-fullscreen-platform-ui.md).
 */
export const PLACEMENT_SAFE_ZONE: SafeZonePx = { top: 288, bottom: 672, left: 65, right: 192 };

/** Union of every platform's chrome — the zone to keep critical text out of for "post everywhere". */
export function combinedSafeZone(ids: PlatformId[] = ["INSTAGRAM", "TIKTOK", "YOUTUBE"]): SafeZonePx {
  const zones = ids.map((id) => PLATFORM_PROFILES[id].safeZone);
  return {
    top: Math.max(...zones.map((z) => z.top)),
    bottom: Math.max(...zones.map((z) => z.bottom)),
    left: Math.max(...zones.map((z) => z.left)),
    right: Math.max(...zones.map((z) => z.right)),
  };
}

/** Frame rate a variant is encoded at: the master's, capped at the profile max. */
export function variantFps(masterFps: number, profile: PlatformProfile): number {
  const fps = Math.round(masterFps * 1000) / 1000;
  return Math.min(profile.maxFps, fps > 0 ? fps : 30);
}

export interface ProfileIssue {
  code:
    | "DIMENSIONS"
    | "FPS"
    | "VIDEO_CODEC"
    | "PIXEL_FORMAT"
    | "AUDIO_CODEC"
    | "AUDIO_SAMPLE_RATE"
    | "AUDIO_CHANNELS"
    | "NO_AUDIO"
    | "DURATION_SHORT"
    | "DURATION_LONG"
    | "FILE_TOO_LARGE"
    | "NOT_FASTSTART";
  severity: "BLOCKING" | "WARNING";
  message: string;
}

/** What checkAgainstProfile needs (see probeVariant in platform-variant.ts). */
export interface VariantProbe {
  width: number | null;
  height: number | null;
  fps: number | null;
  durationSeconds: number;
  fileSizeBytes: number;
  videoCodec: string | null;
  pixelFormat: string | null;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  faststart: boolean | null;
}

/** Deterministic preflight of a file against a platform profile. Empty = deliverable. */
export function checkAgainstProfile(probe: VariantProbe, profile: PlatformProfile): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const add = (code: ProfileIssue["code"], severity: ProfileIssue["severity"], message: string) =>
    issues.push({ code, severity, message });
  if (probe.width !== profile.canvas.width || probe.height !== profile.canvas.height) {
    add("DIMENSIONS", "BLOCKING", `${probe.width}x${probe.height}, ${profile.label} expects ${profile.canvas.width}x${profile.canvas.height}.`);
  }
  if (probe.fps == null || probe.fps > profile.maxFps + 0.01 || probe.fps < profile.minFps - 0.01) {
    add("FPS", "BLOCKING", `${probe.fps ?? "unknown"} fps — ${profile.label} accepts ${profile.minFps}-${profile.maxFps}.`);
  }
  if (probe.videoCodec !== "h264") add("VIDEO_CODEC", "BLOCKING", `Video codec ${probe.videoCodec ?? "none"}, expected H.264.`);
  if (probe.pixelFormat !== profile.video.pixelFormat) {
    add("PIXEL_FORMAT", "WARNING", `Pixel format ${probe.pixelFormat ?? "unknown"}, expected ${profile.video.pixelFormat}.`);
  }
  if (!probe.audioCodec) add("NO_AUDIO", "WARNING", "No audio track.");
  else {
    if (probe.audioCodec !== "aac") add("AUDIO_CODEC", "BLOCKING", `Audio codec ${probe.audioCodec}, expected AAC.`);
    if (probe.audioSampleRate !== profile.audio.sampleRate) {
      add("AUDIO_SAMPLE_RATE", "WARNING", `Audio at ${probe.audioSampleRate} Hz, expected ${profile.audio.sampleRate}.`);
    }
    if (probe.audioChannels !== profile.audio.channels) {
      add("AUDIO_CHANNELS", "WARNING", `${probe.audioChannels} audio channels, expected ${profile.audio.channels}.`);
    }
  }
  if (probe.durationSeconds < profile.minDurationSeconds) {
    add("DURATION_SHORT", "BLOCKING", `${probe.durationSeconds.toFixed(2)} s is under ${profile.label}'s ${profile.minDurationSeconds} s minimum.`);
  }
  if (probe.durationSeconds > profile.maxDurationSeconds) {
    add("DURATION_LONG", "BLOCKING", `${probe.durationSeconds.toFixed(2)} s is over ${profile.label}'s ${profile.maxDurationSeconds} s maximum.`);
  }
  if (probe.fileSizeBytes > profile.maxFileSizeBytes) {
    add("FILE_TOO_LARGE", "BLOCKING", `${probe.fileSizeBytes} bytes exceeds ${profile.label}'s ${profile.maxFileSizeBytes}-byte limit.`);
  }
  if (probe.faststart === false) add("NOT_FASTSTART", "BLOCKING", "moov atom is not at the front of the file (no faststart).");
  return issues;
}

/**
 * Size-cap retry plan: the average video bitrate that lands a re-encode at ~92% of the cap,
 * or null when even 300 kbps of video can't fit (fail instead of producing mush).
 */
export function sizeCapRetryVideoKbps(input: {
  maxFileSizeBytes: number;
  durationSeconds: number;
  audioKbps: number;
}): number | null {
  const totalKbps = (input.maxFileSizeBytes * 8 * 0.92) / 1000 / Math.max(0.1, input.durationSeconds);
  const container = 0.01 * totalKbps;
  const video = Math.floor(totalKbps - input.audioKbps - container);
  return video >= 300 ? video : null;
}
