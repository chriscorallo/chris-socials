import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FFMPEG_PATH } from "./ffmpeg-paths";
import { probeMedia } from "./probe";

const execFileAsync = promisify(execFile);

export interface TechnicalQCCheck {
  name: string;
  passed: boolean;
  detail: string;
  /** FAIL (default) makes the whole report FAIL when !passed; WARN is surfaced but never
   * fails the report on its own. */
  severity?: "FAIL" | "WARN";
}

/** Discriminated union, not a numeric score — a single failed FAIL-severity check makes the
 * whole report FAIL, by construction (the type can't express "average it away"). See
 * /docs/ARCHITECTURE.md's authority-enforcement rule for hard gates. */
export interface TechnicalQCReport {
  overall: "PASS" | "FAIL";
  checks: TechnicalQCCheck[];
  /** Names of failed WARN-severity checks (empty when clean). */
  warnings?: string[];
  measurements?: TechnicalQCMeasurements;
}

export interface TechnicalQCExpectations {
  targetWidth?: number;
  targetHeight?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  requiredVideoCodec?: string;
  requiredAudioCodec?: string;
}

/** Thresholds for short-form vertical video. Exported so tests/QC UI can cite them. */
export const LOUDNESS_TARGET_LUFS = -14;
export const LOUDNESS_MIN_LUFS = -24;
export const LOUDNESS_MAX_LUFS = -8;
export const TRUE_PEAK_MAX_DBTP = -0.5;
export const BLACK_WARN_SECONDS = 0.5;
export const BLACK_FAIL_SECONDS = 1.0;
export const OPENING_BLACK_FAIL_SECONDS = 0.3;
export const FREEZE_WARN_SECONDS = 2.0;

export interface TechnicalQCMeasurements {
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  loudnessRangeLu: number | null;
  blackIntervals: Array<{ start: number; end: number; duration: number }>;
  freezeIntervals: Array<{ start: number; end: number | null; duration: number | null }>;
}

/** Parses ffmpeg's ebur128 summary block + blackdetect/freezedetect log lines. Pure. */
export function parseAnalysisStderr(stderr: string): TechnicalQCMeasurements {
  // The summary block is printed last; take the LAST occurrences.
  const summaryIdx = stderr.lastIndexOf("Summary:");
  const summary = summaryIdx >= 0 ? stderr.slice(summaryIdx) : "";
  const num = (re: RegExp, text: string): number | null => {
    const m = re.exec(text);
    if (!m?.[1]) return null;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  const integratedLufs = num(/Integrated loudness:\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/, summary);
  const loudnessRangeLu = num(/Loudness range:\s*LRA:\s*(-?[\d.]+)\s*LU/, summary);
  const truePeakDbtp = num(/True peak:\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/, summary);

  const blackIntervals: TechnicalQCMeasurements["blackIntervals"] = [];
  for (const m of stderr.matchAll(
    /black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)\s+black_duration:\s*(-?[\d.]+)/g,
  )) {
    blackIntervals.push({ start: +m[1]!, end: +m[2]!, duration: +m[3]! });
  }

  const freezeIntervals: TechnicalQCMeasurements["freezeIntervals"] = [];
  const lines = stderr.split("\n");
  for (const line of lines) {
    const start = /freezedetect\.freeze_start:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      freezeIntervals.push({ start: +start[1]!, end: null, duration: null });
      continue;
    }
    const dur = /freezedetect\.freeze_duration:\s*(-?[\d.]+)/.exec(line);
    const last = freezeIntervals[freezeIntervals.length - 1];
    if (dur && last) last.duration = +dur[1]!;
    const end = /freezedetect\.freeze_end:\s*(-?[\d.]+)/.exec(line);
    if (end && last) last.end = +end[1]!;
  }

  return { integratedLufs, truePeakDbtp, loudnessRangeLu, blackIntervals, freezeIntervals };
}

async function analyze(
  filePath: string,
  hasAudio: boolean,
  hasVideo: boolean,
): Promise<TechnicalQCMeasurements> {
  const graphs: string[] = [];
  const maps: string[] = [];
  if (hasVideo) {
    graphs.push("[0:v]blackdetect=d=0.2:pix_th=0.10,freezedetect=n=0.003:d=1[vout]");
    maps.push("-map", "[vout]");
  }
  if (hasAudio) {
    graphs.push("[0:a]ebur128=peak=true[aout]");
    maps.push("-map", "[aout]");
  }
  if (graphs.length === 0) {
    return { integratedLufs: null, truePeakDbtp: null, loudnessRangeLu: null, blackIntervals: [], freezeIntervals: [] };
  }
  const { stderr } = await execFileAsync(
    FFMPEG_PATH,
    ["-hide_banner", "-nostats", "-i", filePath, "-filter_complex", graphs.join(";"), ...maps, "-f", "null", "-"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return parseAnalysisStderr(stderr);
}

/**
 * Deterministic technical QC — spec §9 step 14's "Technical" hard gate. No LLM judgment;
 * every check here is a plain assertion against ffprobe/ffmpeg measurements:
 * container/stream sanity, EBU R128 integrated loudness + true peak (ebur128), long or
 * opening black stretches (blackdetect), and frozen video (freezedetect). Semantic checks
 * (caption over a face, chart legibility) are Visual QA's job.
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

  const m = await analyze(filePath, probed.hasAudio, probed.hasVideo);

  if (probed.hasAudio) {
    const i = m.integratedLufs;
    const loudOk = i != null && i >= LOUDNESS_MIN_LUFS && i <= LOUDNESS_MAX_LUFS;
    checks.push({
      name: "integrated_loudness",
      passed: loudOk,
      detail:
        i == null
          ? "Integrated loudness could not be measured (silent or unreadable audio)."
          : `Integrated ${i.toFixed(1)} LUFS (target ${LOUDNESS_TARGET_LUFS}, allowed ${LOUDNESS_MIN_LUFS} to ${LOUDNESS_MAX_LUFS}).`,
    });
    const tp = m.truePeakDbtp;
    checks.push({
      name: "true_peak",
      passed: tp != null && tp <= TRUE_PEAK_MAX_DBTP,
      detail:
        tp == null
          ? "True peak could not be measured."
          : `True peak ${tp.toFixed(1)} dBTP (max ${TRUE_PEAK_MAX_DBTP}).`,
    });
  }

  if (probed.hasVideo) {
    const opening = m.blackIntervals.find((b) => b.start <= 0.05);
    const longest = m.blackIntervals.reduce((max, b) => Math.max(max, b.duration), 0);
    const openingFail = opening != null && opening.duration >= OPENING_BLACK_FAIL_SECONDS;
    checks.push({
      name: "black_frames",
      passed: !openingFail && longest < BLACK_FAIL_SECONDS,
      detail:
        m.blackIntervals.length === 0
          ? "No black stretches detected."
          : `Black stretches: ${m.blackIntervals
              .map((b) => `${b.start.toFixed(2)}-${b.end.toFixed(2)}s`)
              .join(", ")}${openingFail ? " (opens on black)" : ""}.`,
    });
    if (longest >= BLACK_WARN_SECONDS && longest < BLACK_FAIL_SECONDS && !openingFail) {
      checks.push({
        name: "black_frames_short",
        passed: false,
        severity: "WARN",
        detail: `A ${longest.toFixed(2)}s black stretch — likely an unintended gap at a cut.`,
      });
    }

    const longFreezes = m.freezeIntervals.filter(
      (f) => (f.duration ?? probed.durationSeconds - f.start) >= FREEZE_WARN_SECONDS,
    );
    // WARN, not FAIL: a deliberate held frame (chart, still) is legitimate; a stuck decoder is
    // not, but telling them apart is semantic — Visual QA's job, with this as its pointer.
    checks.push({
      name: "frozen_video",
      passed: longFreezes.length === 0,
      severity: "WARN",
      detail:
        longFreezes.length === 0
          ? "No frozen stretches >= 2s."
          : `Frozen video: ${longFreezes
              .map((f) => `${f.start.toFixed(2)}s for ${(f.duration ?? probed.durationSeconds - f.start).toFixed(2)}s`)
              .join(", ")}.`,
    });
  }

  const failing = checks.filter((c) => !c.passed && (c.severity ?? "FAIL") === "FAIL");
  const warnings = checks.filter((c) => !c.passed && c.severity === "WARN").map((c) => c.name);
  const overall: TechnicalQCReport["overall"] = failing.length === 0 ? "PASS" : "FAIL";
  return { overall, checks, warnings, measurements: m };
}
