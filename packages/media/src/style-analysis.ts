import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FFMPEG_PATH, FFPROBE_PATH } from "./ffmpeg-paths";
import { parseAnalysisStderr } from "./technical-qc";

const execFileAsync = promisify(execFile);

/**
 * Deterministic measurements for edit-style analysis of a finished short video (a reference
 * creator's upload): cut detection, loudness/peaks, voice-vs-background level. Plain ffmpeg +
 * arithmetic — no model calls. The metric math (shot lengths, pauses, hooks, aggregation) lives
 * in @chris/domain's style-metrics.ts; the worker job stitches the two together.
 */

// ---------------------------------------------------------------------------------------------
// Probe (display size — honours phone rotation metadata)
// ---------------------------------------------------------------------------------------------

export interface VideoProbe {
  durationS: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface ProbeJson {
  format?: { duration?: string };
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    duration?: string;
    tags?: Record<string, string>;
    side_data_list?: Array<{ rotation?: number }>;
  }>;
}

/** Pure: ffprobe JSON → display dimensions (90°/270° rotation swaps width and height). */
export function parseVideoProbe(data: ProbeJson): VideoProbe {
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const rate = (r?: string) => {
    if (!r || r === "0/0") return null;
    const [n, d] = r.split("/").map(Number);
    return n && d ? n / d : null;
  };
  const rotation = Math.abs(Number(v?.side_data_list?.find((s) => s.rotation != null)?.rotation ?? v?.tags?.rotate ?? 0)) % 180;
  const swap = rotation === 90;
  const duration = parseFloat(data.format?.duration ?? v?.duration ?? a?.duration ?? "0");
  const fps = rate(v?.avg_frame_rate) ?? rate(v?.r_frame_rate);
  return {
    durationS: Number.isFinite(duration) ? duration : 0,
    width: (swap ? v?.height : v?.width) ?? null,
    height: (swap ? v?.width : v?.height) ?? null,
    fps: fps != null && fps > 0 && fps < 1000 ? Math.round(fps * 100) / 100 : null,
    hasVideo: !!v,
    hasAudio: !!a,
  };
}

export async function probeVideo(filePath: string): Promise<VideoProbe> {
  const { stdout } = await execFileAsync(FFPROBE_PATH, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath], { maxBuffer: 16 * 1024 * 1024 });
  return parseVideoProbe(JSON.parse(stdout) as ProbeJson);
}

// ---------------------------------------------------------------------------------------------
// Cut detection
// ---------------------------------------------------------------------------------------------

/** Per decoded frame: its time, mean absolute luma change vs the previous frame (0–255 scale,
 * on a 72×128 area-downscale) and ffmpeg's scene-change score (0–1). */
export interface FrameChange {
  t: number;
  mad: number;
  scene: number;
}

export interface CutDetectionOptions {
  /** A frame whose change is at least this (0–255) AND `spikeRatio`× its neighbours' is a cut. */
  minChange: number;
  spikeRatio: number;
  /** Change this large is a cut regardless (a hard scene change during fast motion). */
  hardChange: number;
  /** ffmpeg scene score that counts as a cut on its own. */
  sceneScore: number;
  /** Two cuts closer than this keep only the stronger (shots shorter than ~8 frames are flashes). */
  minShotS: number;
}

/**
 * Tuned on synthetic talking-head jump-cut edits (still / head-bob / handheld motion, 74 cuts,
 * 20 % punch-ins; see docs/decisions-pending/reference-videos.md for the measured accuracy).
 * Precision is favoured over recall: an over-count would tell Chris to cut faster than his
 * references actually do.
 */
export const DEFAULT_CUT_DETECTION: CutDetectionOptions = {
  minChange: 4,
  spikeRatio: 2,
  hardChange: 30,
  sceneScore: 0.15,
  minShotS: 0.25,
};

export const CUT_DETECTION_METHOD = "luma-change spike (72×128, ≥4/255 and ≥2× neighbours) or ffmpeg scene ≥0.15 or change ≥30; min shot 0.25 s";

/**
 * Pure: cut times from per-frame changes. A jump cut in a talking head barely moves the scene
 * score (same background, same framing), but it is a one-frame SPIKE in frame-to-frame change
 * while continuous motion changes smoothly — so each frame is compared with its two neighbours
 * on each side, with an absolute floor so a near-static shot's noise can't qualify.
 */
export function detectCuts(frames: FrameChange[], options: CutDetectionOptions = DEFAULT_CUT_DETECTION): number[] {
  const cand: Array<{ t: number; strength: number }> = [];
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i]!;
    const nb = Math.max(frames[i - 1]?.mad ?? 0, frames[i + 1]?.mad ?? 0, i > 1 ? frames[i - 2]!.mad : 0, frames[i + 2]?.mad ?? 0);
    const spike = f.mad / Math.max(nb, 0.5);
    const isCut = f.mad >= options.hardChange || (f.mad >= options.minChange && spike >= options.spikeRatio) || f.scene >= options.sceneScore;
    if (isCut) cand.push({ t: f.t, strength: Math.max(f.mad / 255, f.scene) });
  }
  const out: Array<{ t: number; strength: number }> = [];
  for (const c of cand) {
    const last = out[out.length - 1];
    if (last && c.t - last.t < options.minShotS) {
      if (c.strength > last.strength) out[out.length - 1] = c;
      continue;
    }
    out.push(c);
  }
  // A "cut" in the first 0.1 s is the first frame settling, not an edit.
  return out.map((c) => Math.round(c.t * 1000) / 1000).filter((t) => t >= 0.1);
}

const FW = 72;
const FH = 128;

/**
 * One ffmpeg pass: decode → scene score (on a 240-px-wide copy) → 72×128 grey frames piped out.
 * Times come from each frame's own timestamp (variable-frame-rate phone/app exports are common).
 */
export async function measureFrameChanges(filePath: string): Promise<FrameChange[]> {
  const dir = await mkdtemp(join(tmpdir(), "chris-cuts-"));
  const metaPath = join(dir, "scene.txt");
  try {
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const proc = spawn(FFMPEG_PATH, [
        "-hide_banner", "-loglevel", "error", "-i", filePath, "-an", "-sn",
        "-vf", `scale=240:-2,select='gte(scene\\,0)',metadata=print:key=lavfi.scene_score:file='${metaPath.replace(/'/g, "")}',scale=${FW}:${FH}:flags=area,format=gray`,
        "-fps_mode", "passthrough", "-f", "rawvideo", "-",
      ]);
      const chunks: Buffer[] = [];
      let stderr = "";
      proc.stdout.on("data", (c: Buffer) => chunks.push(c));
      proc.stderr.on("data", (c) => (stderr += c.toString()));
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg frame analysis failed (${code}): ${stderr.slice(-600)}`))));
    });
    const meta = await readFile(metaPath, "utf8").catch(() => "");
    const times: number[] = [];
    const scores: number[] = [];
    for (const line of meta.split("\n")) {
      const t = /pts_time:(-?[\d.]+)/.exec(line);
      if (t) {
        times.push(Number(t[1]));
        scores.push(0);
        continue;
      }
      const s = /lavfi\.scene_score=([\d.]+)/.exec(line);
      if (s && scores.length) scores[scores.length - 1] = Number(s[1]);
    }
    const size = FW * FH;
    const n = Math.floor(raw.length / size);
    const frames: FrameChange[] = [];
    for (let f = 0; f < n; f++) {
      let mad = 0;
      if (f > 0) {
        const a = (f - 1) * size;
        const b = f * size;
        let sum = 0;
        for (let i = 0; i < size; i++) sum += Math.abs(raw[a + i]! - raw[b + i]!);
        mad = sum / size;
      }
      frames.push({ t: times[f] ?? (frames[f - 1]?.t ?? 0) + 1 / 30, mad: Math.round(mad * 1000) / 1000, scene: scores[f] ?? 0 });
    }
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Loudness, peaks, clipping
// ---------------------------------------------------------------------------------------------

export interface StyleLoudness {
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbtp: number | null;
  samplePeakDb: number | null;
  /** Times the signal hit its peak level (astats "Peak count"). */
  peakCount: number | null;
  /** astats "Flat factor": flat-topped (clipped) peaks > 0. */
  flatFactor: number | null;
  clipping: boolean;
}

/** Pure: ebur128 summary + astats overall block → measurement. */
export function parseStyleLoudnessStderr(stderr: string): StyleLoudness {
  const ebu = parseAnalysisStderr(stderr);
  const overall = stderr.slice(Math.max(0, stderr.lastIndexOf("Overall")));
  const num = (re: RegExp) => {
    const m = re.exec(overall);
    const v = m?.[1] != null ? Number(m[1]) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  const samplePeakDb = num(/Peak level dB:\s*(-?[\d.]+)/);
  const peakCount = num(/Peak count:\s*([\d.]+)/);
  const flatFactor = num(/Flat factor:\s*([\d.]+)/);
  return {
    integratedLufs: ebu.integratedLufs,
    loudnessRangeLu: ebu.loudnessRangeLu,
    truePeakDbtp: ebu.truePeakDbtp,
    samplePeakDb,
    peakCount,
    flatFactor,
    clipping: isClipping(samplePeakDb, peakCount, flatFactor),
  };
}

/** Peaks at full scale that repeat (or are flat-topped) — one stray full-scale sample isn't clipping. */
export function isClipping(samplePeakDb: number | null, peakCount: number | null, flatFactor: number | null): boolean {
  if (samplePeakDb == null || samplePeakDb < -0.3) return false;
  return (peakCount ?? 0) >= 20 || (flatFactor ?? 0) >= 1;
}

export async function measureStyleLoudness(filePath: string): Promise<StyleLoudness> {
  const { stderr } = await execFileAsync(
    FFMPEG_PATH,
    [
      "-hide_banner", "-nostats", "-i", filePath, "-vn", "-sn", "-map", "0:a:0",
      "-af", "ebur128=peak=true,astats=measure_overall=Peak_level+Peak_count+Flat_factor:measure_perchannel=none",
      "-f", "null", "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return parseStyleLoudnessStderr(stderr);
}

// ---------------------------------------------------------------------------------------------
// Voice vs background (music / room tone)
// ---------------------------------------------------------------------------------------------

export interface VoiceBackground {
  voiceLevelDb: number | null;
  backgroundLevelDb: number | null;
  /** Voice minus background, dB (null when not measurable). */
  differenceDb: number | null;
  background: "none" | "present" | "unknown";
  method: "gaps" | "floor" | "none";
}

/** Background quieter than this (dBFS RMS, 16 kHz mono) is silence / faint room tone, not music. */
export const SILENT_BACKGROUND_DB = -52;
/** Background more than this far under the voice is inaudible in practice. */
export const INAUDIBLE_UNDER_VOICE_DB = 32;

const FRAME_S = 0.05;

function frameLevels(pcm: Float32Array, sr: number): number[] {
  const n = Math.max(1, Math.round(FRAME_S * sr));
  const out: number[] = [];
  for (let i = 0; i + n <= pcm.length; i += n) {
    let sum = 0;
    for (let j = i; j < i + n; j++) sum += pcm[j]! * pcm[j]!;
    out.push(10 * Math.log10(Math.max(1e-12, sum / n)));
  }
  return out;
}

function q(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
}

/** Power-average of dB levels (so a loud word dominates as it does to the ear). */
function energyMeanDb(levels: number[]): number | null {
  if (!levels.length) return null;
  const mean = levels.reduce((s, l) => s + 10 ** (l / 10), 0) / levels.length;
  return 10 * Math.log10(Math.max(1e-12, mean));
}

/**
 * Pure: how loud whatever plays under the voice is, from mono PCM + word timings.
 * - "gaps": with ≥ 0.6 s of clean non-speech (gaps between words ≥ 0.25 s, trimmed 60 ms each
 *   side, plus lead-in/tail), background = the median level there; voice = the energy mean of
 *   frames inside words.
 * - "floor" (tightly edited videos have almost no gaps): background = the 10th-percentile frame
 *   level over the speech span (the dips between syllables are filled by any music bed);
 *   voice = the 90th percentile.
 * Background is "none" when it's near-silent or ≥ 32 dB under the voice.
 */
export function measureVoiceBackground(pcm: Float32Array, sampleRate: number, words: Array<{ start: number; end: number }>, durationS: number): VoiceBackground {
  const levels = frameLevels(pcm, sampleRate);
  if (levels.length === 0 || words.length === 0) return { voiceLevelDb: null, backgroundLevelDb: null, differenceDb: null, background: "unknown", method: "none" };
  const ws = [...words].sort((a, b) => a.start - b.start);
  const frameAt = (i: number) => (i + 0.5) * FRAME_S;
  const inWord = (t: number) => ws.some((w) => t >= w.start && t <= w.end);
  const quiet: Array<[number, number]> = [];
  const pad = 0.06;
  if (ws[0]!.start - 0.1 > pad) quiet.push([pad, ws[0]!.start - 0.1]);
  for (let i = 1; i < ws.length; i++) {
    const a = ws[i - 1]!.end + pad;
    const b = ws[i]!.start - pad;
    if (ws[i]!.start - ws[i - 1]!.end >= 0.25 && b > a) quiet.push([a, b]);
  }
  const lastEnd = ws[ws.length - 1]!.end;
  if (durationS - lastEnd > 0.1 + 2 * pad) quiet.push([lastEnd + 0.1, durationS - pad]);
  const gapLevels: number[] = [];
  const wordLevels: number[] = [];
  levels.forEach((l, i) => {
    const t = frameAt(i);
    if (quiet.some(([a, b]) => t >= a && t <= b)) gapLevels.push(l);
    else if (inWord(t)) wordLevels.push(l);
  });
  let voice: number | null;
  let bg: number | null;
  let method: VoiceBackground["method"];
  if (gapLevels.length * FRAME_S >= 0.6 && wordLevels.length >= 10) {
    voice = energyMeanDb(wordLevels);
    bg = q(gapLevels, 0.5);
    method = "gaps";
  } else {
    const span = levels.filter((_, i) => frameAt(i) >= ws[0]!.start && frameAt(i) <= lastEnd);
    if (span.length < 20) return { voiceLevelDb: null, backgroundLevelDb: null, differenceDb: null, background: "unknown", method: "none" };
    voice = q(span, 0.9);
    bg = q(span, 0.1);
    method = "floor";
  }
  if (voice == null || bg == null) return { voiceLevelDb: null, backgroundLevelDb: null, differenceDb: null, background: "unknown", method: "none" };
  const diff = voice - bg;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const none = bg <= SILENT_BACKGROUND_DB || diff >= INAUDIBLE_UNDER_VOICE_DB;
  return {
    voiceLevelDb: r1(voice),
    backgroundLevelDb: r1(bg),
    differenceDb: none ? null : r1(Math.max(0, diff)),
    background: none ? "none" : "present",
    method,
  };
}
