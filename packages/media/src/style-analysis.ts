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
    // ±3 frames too: encoders with B-frames make grainy footage "pulse" every 2–3 frames, which
    // would otherwise read as a spike (measured on a noisy 360p encode).
    let nb = 0;
    for (const k of [-3, -2, -1, 1, 2, 3]) if (i + k >= 1 && i + k < frames.length) nb = Math.max(nb, frames[i + k]!.mad);
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

/**
 * Peaks at full scale that repeat or are flat-topped (one stray full-scale sample isn't
 * clipping), or decoded peaks OVER full scale — a lossy (AAC) encode of clipped audio rounds off
 * the flat tops but overshoots 0 dBFS (measured: a clipped voice decoded at +0.98 dBFS with few
 * repeated peaks).
 */
export function isClipping(samplePeakDb: number | null, peakCount: number | null, flatFactor: number | null): boolean {
  if (samplePeakDb == null || samplePeakDb < -0.3) return false;
  return samplePeakDb > 0.1 || (peakCount ?? 0) >= 20 || (flatFactor ?? 0) >= 1;
}

/** `endS`: measure only up to here (an end card after it is left out). */
export async function measureStyleLoudness(filePath: string, options: { endS?: number | null } = {}): Promise<StyleLoudness> {
  const limit = options.endS != null && options.endS > 0 ? ["-t", String(Math.round(options.endS * 1000) / 1000)] : [];
  const { stderr } = await execFileAsync(
    FFMPEG_PATH,
    [
      "-hide_banner", "-nostats", "-i", filePath, "-vn", "-sn", "-map", "0:a:0",
      "-af", "ebur128=peak=true,astats=measure_overall=Peak_level+Peak_count+Flat_factor:measure_perchannel=none",
      ...limit,
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
  /** Voice minus background, dB (null when there's no audible background). */
  differenceDb: number | null;
  background: "none" | "present" | "unknown";
  method: "floor" | "none";
}

/** Background quieter than this (dBFS RMS, 16 kHz mono) is silence / faint room tone. */
export const SILENT_BACKGROUND_DB = -55;
/** Background more than this far under the voice is inaudible in practice. */
export const INAUDIBLE_UNDER_VOICE_DB = 36;
/** Short frames, so the brief dips between syllables are caught. */
const FRAME_S = 0.02;

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

function pct(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
}

/** Power-average of dB levels (a loud word dominates, as it does to the ear). */
function energyMeanDb(levels: number[]): number | null {
  if (!levels.length) return null;
  const mean = levels.reduce((s, l) => s + 10 ** (l / 10), 0) / levels.length;
  return 10 * Math.log10(Math.max(1e-12, mean));
}

/**
 * Pure: how loud whatever plays under the voice is, from mono PCM + word timings.
 * Voice = energy mean of 20 ms frames inside words. Background = the 2nd-percentile 20 ms frame
 * over the whole video (edges trimmed): a music bed fills every dip between syllables, so the
 * quietest moments ARE the music; clean speech dips to (near) silence. Whisper's word edges are
 * too loose to measure "between the words" directly (tested — it read voice tails as music).
 * Limit: it can't tell a music bed from equally loud room noise — both are "background sound".
 */
export function measureVoiceBackground(pcm: Float32Array, sampleRate: number, words: Array<{ start: number; end: number }>, durationS: number): VoiceBackground {
  const unknown: VoiceBackground = { voiceLevelDb: null, backgroundLevelDb: null, differenceDb: null, background: "unknown", method: "none" };
  const levels = frameLevels(pcm, sampleRate);
  if (levels.length < 50 || words.length === 0) return unknown;
  const edge = 0.08;
  const end = Math.min(durationS > 0 ? durationS : Infinity, levels.length * FRAME_S) - edge;
  const ws = [...words].sort((a, b) => a.start - b.start);
  const wordLevels: number[] = [];
  const all: number[] = [];
  let k = 0;
  levels.forEach((l, i) => {
    const t = (i + 0.5) * FRAME_S;
    if (t < edge || t > end) return;
    all.push(l);
    while (k < ws.length && ws[k]!.end < t) k++;
    const w = ws[k];
    if (w && t >= w.start && t <= w.end) wordLevels.push(l);
  });
  const voice = wordLevels.length >= 10 ? energyMeanDb(wordLevels) : pct(all, 0.9);
  const bg = pct(all, 0.02);
  if (voice == null || bg == null) return unknown;
  const diff = voice - bg;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const none = bg <= SILENT_BACKGROUND_DB || diff >= INAUDIBLE_UNDER_VOICE_DB;
  return {
    voiceLevelDb: r1(voice),
    backgroundLevelDb: r1(bg),
    differenceDb: none ? null : r1(Math.max(0, diff)),
    background: none ? "none" : "present",
    method: "floor",
  };
}

/** A 20 ms frame at or above this (dBFS RMS) has sound in it — music, voice or noise. */
export const ACTIVE_FRAME_DB = -45;

export interface AudioActivity {
  /** Share of 20 ms frames with sound in them (≥ ACTIVE_FRAME_DB). */
  activeShare: number;
  /** Energy mean inside Whisper's words / at least 0.15 s away from any word (dBFS). */
  inWordDb: number | null;
  outWordDb: number | null;
  /**
   * In-word minus out-of-word energy (dB). A real voice stands well above what's between its
   * words (silence, or a music bed under it); words Whisper invents over music sit on the same
   * sound as the gaps around them (≈ 0 dB). null when either side has under 0.3 s of audio.
   */
  contrastDb: number | null;
}

/** Pure: how much of the audio has sound, and whether the "words" stand out from their gaps. */
export function measureAudioActivity(pcm: Float32Array, sampleRate: number, words: Array<{ start: number; end: number }>, durationS: number): AudioActivity {
  const levels = frameLevels(pcm, sampleRate);
  const end = Math.min(durationS > 0 ? durationS : Infinity, levels.length * FRAME_S);
  const ws = [...words].filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end)).sort((a, b) => a.start - b.start);
  const inside: number[] = [];
  const outside: number[] = [];
  let active = 0;
  let total = 0;
  let k = 0;
  levels.forEach((l, i) => {
    const t = (i + 0.5) * FRAME_S;
    if (t > end) return;
    total++;
    if (l >= ACTIVE_FRAME_DB) active++;
    while (k < ws.length && ws[k]!.end + 0.15 < t) k++;
    let inWord = false;
    let near = false;
    for (let j = Math.max(0, k - 1); j < ws.length && ws[j]!.start - 0.15 <= t; j++) {
      const w = ws[j]!;
      if (t >= w.start && t <= w.end) inWord = true;
      if (t >= w.start - 0.15 && t <= w.end + 0.15) near = true;
    }
    if (inWord) inside.push(l);
    else if (!near) outside.push(l);
  });
  const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
  const inDb = inside.length >= 15 ? energyMeanDb(inside) : null;
  const outDb = outside.length >= 15 ? energyMeanDb(outside) : null;
  return {
    activeShare: total ? Math.round((active / total) * 1000) / 1000 : 0,
    inWordDb: r1(inDb),
    outWordDb: r1(outDb),
    contrastDb: inDb != null && outDb != null ? r1(inDb - outDb) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Platform end card (Instagram / TikTok download outro)
// ---------------------------------------------------------------------------------------------

/**
 * Videos saved from Instagram / TikTok carry an appended outro: the last frame frozen and
 * dimmed (often with a short fade) — or a cut to black — with a centred logo + "@username" on
 * top, roughly 1.5–5 s at the very end. It isn't the creator's edit, and it inflates the
 * length, "ends N s after the last word", the last-3-s pacing and the audio floor, so it is
 * detected and left out of every number.
 *
 * Deterministic, on the last few seconds decoded to 180×320 grey:
 *  1. Still run: walking back from the last frame, consecutive frames whose background (the
 *     frame minus the centre box, where the logo animates) is the previous frame up to a
 *     brightness change — a least-squares fit b ≈ α + β·a with a tiny residual. A frozen frame
 *     fading darker passes; real footage (motion, grain) doesn't.
 *  2. Position + length: that still run ends the video, lasts 1–6 s, and doesn't start before
 *     the last spoken word (+0.5 s for Whisper's loose word ends).
 *  3. Darker than what came before: the background's light (above video black) is ≤ 75 % of
 *     the second before (a dimmed freeze or a cut to black). When the still run fades, the
 *     card starts where the light starts dropping.
 *  4. A logo / handle: bright pixels well above the dimmed background in the centre box,
 *     horizontally centred, and almost none outside it.
 * All four must hold. A creator's own closing shot at normal brightness (fails 3), a fade to
 * black with nothing on it (fails 4), or a still longer than 6 s (fails 2) stays in.
 * Accuracy: docs/decisions-pending/reference-measuring-v2.md.
 */

export const TAIL_W = 180;
export const TAIL_H = 320;
/** Seconds of the tail decoded for end-card detection (cards are ≤ ~5 s). */
export const TAIL_WINDOW_S = 7;

export interface TailFrame {
  t: number;
  /** TAIL_W × TAIL_H grey, row-major. */
  px: Uint8Array;
}

export interface EndCardOptions {
  minS: number;
  maxS: number;
  /** Mean |residual| (0–255) of the brightness fit for two frames to count as the same still. */
  frozenResidual: number;
  /** Background light ratio (card ÷ the second before, above black) at or under which it's "darker". */
  darkerRatio: number;
  /** Seconds a word may run past the card start (Whisper's word ends are loose). */
  wordSlackS: number;
}

export const DEFAULT_END_CARD: EndCardOptions = { minS: 1, maxS: 6, frozenResidual: 1.5, darkerRatio: 0.75, wordSlackS: 0.5 };

export interface EndCardEvidence {
  stillS: number;
  darkRatio: number | null;
  overlayShare: number | null;
  overlayOutsideShare: number | null;
}

export interface EndCardResult {
  /** Where the card starts (the analyzed video ends here); null = no end card. */
  startS: number | null;
  durationS: number | null;
  /** Why it was / wasn't treated as an end card (logs and tests). */
  reason: string;
  evidence: EndCardEvidence;
}

/** Video black in 8-bit limited range. */
const VIDEO_BLACK = 16;

let maskCache: { bg: Int32Array; center: Int32Array } | null = null;
function masks(): { bg: Int32Array; center: Int32Array } {
  if (!maskCache) {
    const bg: number[] = [];
    const center: number[] = [];
    for (let y = 0; y < TAIL_H; y++) {
      for (let x = 0; x < TAIL_W; x++) {
        const c = x >= TAIL_W * 0.2 && x < TAIL_W * 0.8 && y >= TAIL_H * 0.3 && y < TAIL_H * 0.7;
        (c ? center : bg).push(y * TAIL_W + x);
      }
    }
    maskCache = { bg: Int32Array.from(bg), center: Int32Array.from(center) };
  }
  return maskCache;
}

/** Least-squares b ≈ α + β·a over the background: β and the mean |residual|. */
export function brightnessFit(a: Uint8Array, b: Uint8Array): { beta: number; residual: number } {
  const { bg } = masks();
  const n = bg.length;
  let sa = 0, sb = 0, saa = 0, sab = 0;
  for (let k = 0; k < n; k++) {
    const i = bg[k]!;
    const x = a[i]!;
    const y = b[i]!;
    sa += x;
    sb += y;
    saa += x * x;
    sab += x * y;
  }
  const ma = sa / n;
  const mb = sb / n;
  const va = saa / n - ma * ma;
  // A flat frame (black / one colour) has no shape to fit: "the same" only if the level held.
  const flat = va < 4;
  const beta = flat ? 1 : (sab / n - ma * mb) / va;
  const alpha = flat ? mb - ma : mb - beta * ma;
  let res = 0;
  for (let k = 0; k < n; k++) {
    const i = bg[k]!;
    res += Math.abs(b[i]! - (flat ? a[i]! : alpha + beta * a[i]!));
  }
  return { beta, residual: res / n };
}

function histogram(px: Uint8Array, idx: Int32Array): Uint32Array {
  const hist = new Uint32Array(256);
  for (let k = 0; k < idx.length; k++) hist[px[idx[k]!]!]!++;
  return hist;
}

/** Mean light above video black over the background (0 = black). */
function lightAboveBlack(px: Uint8Array): number {
  const { bg } = masks();
  let sum = 0;
  for (let k = 0; k < bg.length; k++) {
    const v = px[bg[k]!]! - VIDEO_BLACK;
    if (v > 0) sum += v;
  }
  return sum / bg.length;
}

function percentileOf(px: Uint8Array, idx: Int32Array, p: number): number {
  const hist = histogram(px, idx);
  let left = idx.length * p;
  for (let v = 0; v < 256; v++) {
    left -= hist[v]!;
    if (left <= 0) return v;
  }
  return 255;
}

/** A centred bright overlay (logo + handle): shares of bright pixels inside / outside the centre box. */
export function overlayShares(px: Uint8Array): { inside: number; outside: number; centred: boolean } {
  const { bg, center } = masks();
  // "Bright" = clearly above everything in the (dimmed) background: a white logo / handle.
  const thr = Math.min(235, Math.max(150, percentileOf(px, bg, 0.9) + 60, percentileOf(px, bg, 0.998) + 15));
  let inside = 0;
  let sx = 0;
  for (let k = 0; k < center.length; k++) {
    const i = center[k]!;
    if (px[i]! >= thr) {
      inside++;
      sx += i % TAIL_W;
    }
  }
  let outside = 0;
  for (let k = 0; k < bg.length; k++) if (px[bg[k]!]! >= thr) outside++;
  const cx = inside ? sx / inside / TAIL_W : 0;
  return { inside: inside / center.length, outside: outside / bg.length, centred: inside > 0 && cx > 0.38 && cx < 0.62 };
}

/**
 * Pure: is there a platform end card at the end of these tail frames? `durationS` is the full
 * video's length; `lastWordEndS` the end of the last real spoken word (null = no speech).
 */
export function detectEndCard(
  frames: TailFrame[],
  ctx: { durationS: number; lastWordEndS: number | null },
  options: EndCardOptions = DEFAULT_END_CARD,
): EndCardResult {
  const evidence: EndCardEvidence = { stillS: 0, darkRatio: null, overlayShare: null, overlayOutsideShare: null };
  const none = (reason: string): EndCardResult => ({ startS: null, durationS: null, reason, evidence });
  if (frames.length < 10) return none("too few frames");
  const n = frames.length;
  const step = (frames[n - 1]!.t - frames[0]!.t) / Math.max(1, n - 1);
  const end = Math.max(ctx.durationS, frames[n - 1]!.t + step);
  // 1. The still run back from the last frame…
  const fits = new Map<number, { beta: number; residual: number }>();
  const fitAt = (k: number) => {
    let f = fits.get(k);
    if (!f) fits.set(k, (f = brightnessFit(frames[k - 1]!.px, frames[k]!.px)));
    return f;
  };
  const still = (k: number, maxResidual = options.frozenResidual) => {
    const f = fitAt(k);
    return f.residual <= maxResidual && f.beta >= 0.6 && f.beta <= 1.15;
  };
  let i = n - 1;
  let glitches = 0;
  while (i > 0) {
    if (!still(i)) {
      // A low-bitrate encode "refreshes" a still image now and then (one frame, a bit off).
      // Tolerate up to two such isolated glitches when the still clearly continues before it.
      const isolated = glitches < 2 && i - 4 >= 1 && still(i, 4) && [1, 2, 3, 4].every((d) => still(i - d));
      if (!isolated) break;
      glitches++;
    }
    i--;
  }
  // …and when it fades inside that run, the card starts where the light starts its final drop
  // (slow, dark motion graphics can read as "still" for a while before the card).
  const light = frames.map((f, k) => (k >= i ? lightAboveBlack(f.px) : 0));
  let peak = i;
  for (let k = i; k < n; k++) if (light[k]! >= light[peak]!) peak = k;
  let s = i;
  if (light[n - 1]! < light[peak]! * 0.9 - 0.2) {
    s = peak;
    while (s + 1 < n && light[s + 1]! >= light[peak]! * 0.97) s++;
  }
  const startS = frames[s]!.t;
  const cardS = end - startS;
  evidence.stillS = Math.round(cardS * 1000) / 1000;
  if (s === 0) return none("the whole tail is one still image");
  if (cardS < options.minS) return none("no still ending long enough");
  if (cardS > options.maxS) return none("still ending too long for an end card");
  // 2. Not before the last word.
  if (ctx.lastWordEndS != null && ctx.lastWordEndS > startS + options.wordSlackS) return none("talking continues into the still ending");
  // 3. Darker than the second before it.
  const before = frames.filter((f) => f.t < startS && f.t >= startS - 1);
  if (before.length === 0) return none("nothing before the still ending");
  const beforeLight = before.reduce((sum, f) => sum + lightAboveBlack(f.px), 0) / before.length;
  const last = frames[n - 1]!.px;
  // Content that is itself (almost) black can't be seen to darken.
  const ratio = beforeLight >= 1 ? lightAboveBlack(last) / beforeLight : 1;
  evidence.darkRatio = Math.round(ratio * 1000) / 1000;
  if (ratio > options.darkerRatio) return none("the still ending isn't darker than the video");
  // 4. A centred logo / handle on it.
  const o = overlayShares(last);
  evidence.overlayShare = Math.round(o.inside * 10000) / 10000;
  evidence.overlayOutsideShare = Math.round(o.outside * 10000) / 10000;
  if (o.inside < 0.002 || o.inside > 0.25 || !o.centred || o.outside > Math.max(0.002, o.inside * 0.1)) return none("no centred logo on the still ending");
  return { startS: Math.round(startS * 1000) / 1000, durationS: Math.round(cardS * 1000) / 1000, reason: "darkened still ending with a centred logo", evidence };
}

/** The last `seconds` of the video as 180×320 grey frames, each with its own timestamp. */
export async function measureTailFrames(filePath: string, seconds = TAIL_WINDOW_S): Promise<TailFrame[]> {
  const { raw, stderr } = await new Promise<{ raw: Buffer; stderr: string }>((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, [
      "-hide_banner", "-loglevel", "info", "-sseof", `-${seconds}`, "-copyts", "-i", filePath, "-an", "-sn",
      "-vf", `scale=${TAIL_W}:${TAIL_H}:flags=area,format=gray,showinfo`,
      "-fps_mode", "passthrough", "-f", "rawvideo", "-",
    ]);
    const chunks: Buffer[] = [];
    let err = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve({ raw: Buffer.concat(chunks), stderr: err }) : reject(new Error(`ffmpeg tail decode failed (${code}): ${err.slice(-600)}`))));
  });
  const times: number[] = [];
  for (const m of stderr.matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(-?[\d.]+)/g)) times.push(Number(m[1]));
  const size = TAIL_W * TAIL_H;
  const count = Math.floor(raw.length / size);
  const frames: TailFrame[] = [];
  for (let f = 0; f < count; f++) {
    frames.push({ t: times[f] ?? (frames[f - 1]?.t ?? 0) + 1 / 30, px: new Uint8Array(raw.buffer, raw.byteOffset + f * size, size) });
  }
  return frames;
}
