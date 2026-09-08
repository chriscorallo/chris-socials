import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FFMPEG_PATH } from "./ffmpeg-paths";
import { probeMedia } from "./probe";

const execFileAsync = promisify(execFile);

export interface TechnicalQCCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Discriminated union, not a numeric score — a single FAIL check makes the whole report
 * FAIL, by construction (the type can't express "average it away"). See
 * /docs/ARCHITECTURE.md's authority-enforcement rule for hard gates. */
export interface TechnicalQCReport {
  overall: "PASS" | "FAIL";
  checks: TechnicalQCCheck[];
}

export interface TechnicalQCExpectations {
  targetWidth?: number;
  targetHeight?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  requiredVideoCodec?: string;
  requiredAudioCodec?: string;
}

async function measureLoudness(
  filePath: string,
): Promise<{ meanVolumeDb: number | null; maxVolumeDb: number | null }> {
  // ffmpeg's volumedetect filter writes its results to stderr (via -f null, no real output).
  const { stderr } = await execFileAsync(
    FFMPEG_PATH,
    ["-i", filePath, "-af", "volumedetect", "-f", "null", "-"],
    { maxBuffer: 10 * 1024 * 1024 },
  );

  const meanMatch = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  const maxMatch = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);

  return {
    meanVolumeDb: meanMatch?.[1] ? parseFloat(meanMatch[1]) : null,
    maxVolumeDb: maxMatch?.[1] ? parseFloat(maxMatch[1]) : null,
  };
}

/**
 * Deterministic technical QC — spec §9 step 14's "Technical" hard gate. No LLM judgment;
 * every check here is a plain assertion against ffprobe/ffmpeg output. Semantic checks
 * (does the caption collide with a face, is the chart legible) are Visual QA's job (Phase 4,
 * LLM-based) — this module only checks what's actually deterministic.
 */
export async function runTechnicalQC(
  filePath: string,
  expectations: TechnicalQCExpectations = {},
): Promise<TechnicalQCReport> {
  const checks: TechnicalQCCheck[] = [];
  const probed = await probeMedia(filePath);

  checks.push({
    name: "has_video_stream",
    passed: probed.hasVideo,
    detail: probed.hasVideo ? "Video stream present." : "No video stream found.",
  });
  checks.push({
    name: "has_audio_stream",
    passed: probed.hasAudio,
    detail: probed.hasAudio ? "Audio stream present." : "No audio stream found.",
  });

  if (expectations.targetWidth != null && expectations.targetHeight != null) {
    const matches =
      probed.width === expectations.targetWidth && probed.height === expectations.targetHeight;
    checks.push({
      name: "dimensions",
      passed: matches,
      detail: `Expected ${expectations.targetWidth}x${expectations.targetHeight}, got ${probed.width}x${probed.height}.`,
    });
  }

  if (expectations.minDurationSeconds != null || expectations.maxDurationSeconds != null) {
    const min = expectations.minDurationSeconds ?? 0;
    const max = expectations.maxDurationSeconds ?? Number.POSITIVE_INFINITY;
    const withinBounds = probed.durationSeconds >= min && probed.durationSeconds <= max;
    checks.push({
      name: "duration_bounds",
      passed: withinBounds,
      detail: `Duration ${probed.durationSeconds.toFixed(2)}s, expected ${min}-${
        Number.isFinite(max) ? max : "∞"
      }s.`,
    });
  }

  if (expectations.requiredVideoCodec) {
    const matches = probed.videoCodec === expectations.requiredVideoCodec;
    checks.push({
      name: "video_codec",
      passed: matches,
      detail: `Expected ${expectations.requiredVideoCodec}, got ${probed.videoCodec ?? "none"}.`,
    });
  }

  if (expectations.requiredAudioCodec) {
    const matches = probed.audioCodec === expectations.requiredAudioCodec;
    checks.push({
      name: "audio_codec",
      passed: matches,
      detail: `Expected ${expectations.requiredAudioCodec}, got ${probed.audioCodec ?? "none"}.`,
    });
  }

  if (probed.hasAudio) {
    const loudness = await measureLoudness(filePath);
    // volumedetect reports dBFS (peak/mean sample level), not LUFS (perceptual loudness) —
    // a true platform-loudness-standard check needs the loudnorm filter's measured-JSON pass,
    // not volumedetect. This is a coarser sanity check (not silent, not clipping) rather than
    // "meets -14 LUFS" — see /docs/DECISIONS.md for why that distinction matters here.
    const notSilent = loudness.meanVolumeDb != null && loudness.meanVolumeDb > -50;
    const notClipping = loudness.maxVolumeDb != null && loudness.maxVolumeDb <= 0.5;
    checks.push({
      name: "audio_loudness_sanity",
      passed: notSilent && notClipping,
      detail: `mean_volume=${loudness.meanVolumeDb ?? "n/a"}dB, max_volume=${
        loudness.maxVolumeDb ?? "n/a"
      }dB.`,
    });
  }

  const overall: TechnicalQCReport["overall"] = checks.every((c) => c.passed) ? "PASS" : "FAIL";
  return { overall, checks };
}
