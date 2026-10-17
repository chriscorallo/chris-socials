import { spawn } from "node:child_process";
import type { TranscriptWord } from "./captions";
import { FFMPEG_PATH } from "./ffmpeg-paths";
import type { EditTimeline } from "./timeline";
import { locateOutputTime, timelineDuration } from "./timeline";
import { normalizeZooms, resolveGrade, temperatureGains, zoomStateAt } from "./timeline-layout";
import { extractAudioPcm16k } from "./transcription/local-whisper";
import {
  canvasRectToSourceRect,
  mergeSceneStats,
  sceneRegionFor,
  sceneSampleTimes,
  sceneStatsFromRgb,
  unzoomRect,
  type SceneStats,
  type WordLoudness,
} from "./visual-interaction";

/**
 * Node-side measurements feeding the pure interaction helpers (visual-interaction.ts):
 * - scene statistics of the footage behind each visual (ffmpeg: one frame, crop to the region,
 *   the edit's grade, area-downscale to 8×8 → mean colour / luma / contrast);
 * - per-word loudness of a take (decoded 16 kHz mono PCM → RMS and peak per word window).
 * Deterministic — no model calls.
 */

function runRaw(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", ...args]);
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-800)}`))));
  });
}

/** The edit's colour grade as ffmpeg filters (no vignette — it's position-dependent). */
function gradeChain(grade: EditTimeline["grade"]): string {
  const g = resolveGrade(grade);
  const out: string[] = [];
  if (g.brightness !== 0 || g.contrast !== 1 || g.saturation !== 1) out.push(`eq=brightness=${g.brightness}:contrast=${g.contrast}:saturation=${g.saturation}`);
  if (g.temperature !== 0) {
    const t = temperatureGains(g.temperature);
    out.push(`colorchannelmixer=rr=${t.r}:gg=${t.g}:bb=${t.b}`);
  }
  return out.length ? `,${out.join(",")}` : "";
}

/** Stats of one source-pixel rect at one source time. */
export async function sampleRegionStats(
  videoPath: string,
  sourceTime: number,
  rect: { x: number; y: number; width: number; height: number },
  grade?: EditTimeline["grade"],
): Promise<SceneStats> {
  const vf = `crop=${Math.max(2, rect.width)}:${Math.max(2, rect.height)}:${rect.x}:${rect.y}${grade ? gradeChain(grade) : ""},scale=8:8:flags=area,format=rgb24`;
  const buf = await runRaw(["-ss", String(Math.max(0, sourceTime)), "-i", videoPath, "-frames:v", "1", "-an", "-vf", vf, "-f", "rawvideo", "-"]);
  return sceneStatsFromRgb(buf);
}

/**
 * Scene stats for every visual of a timeline: 3 samples over its window (after the entrance,
 * middle, before the exit), each through the clip on screen, its crop and the zoom then.
 * Failures for one visual → null for it (neutral look), never an exception.
 */
export async function sampleSceneStatsForVisuals(
  timeline: Pick<EditTimeline, "clips" | "canvas" | "zooms" | "grade" | "visuals">,
  sources: Record<string, string>,
  sourceDimensions: Record<string, { width: number; height: number } | null | undefined>,
): Promise<Record<string, SceneStats | null>> {
  const { zooms } = normalizeZooms(timeline.zooms, timelineDuration(timeline));
  const out: Record<string, SceneStats | null> = {};
  for (const v of timeline.visuals) {
    try {
      const region = sceneRegionFor(v, timeline.canvas);
      const samples: SceneStats[] = [];
      for (const t of sceneSampleTimes(v)) {
        const loc = locateOutputTime(timeline, t);
        if (!loc) continue;
        const clip = timeline.clips[loc.clipIndex]!;
        const path = sources[clip.mediaAssetId];
        const dims = sourceDimensions[clip.mediaAssetId];
        if (!path || !dims) continue;
        const pre = unzoomRect(region, zoomStateAt(zooms, t), timeline.canvas);
        const src = canvasRectToSourceRect(pre, dims, timeline.canvas, clip.crop);
        samples.push(await sampleRegionStats(path, loc.sourceTime, src, timeline.grade));
      }
      out[v.id] = mergeSceneStats(samples);
    } catch {
      out[v.id] = null;
    }
  }
  return out;
}

/** RMS/peak (dBFS) of PCM samples in [start, end) seconds. Pure. */
export function windowLevels(pcm: Float32Array, sampleRate: number, start: number, end: number): { rmsDb: number; peakDb: number } {
  const a = Math.max(0, Math.floor(start * sampleRate));
  const b = Math.min(pcm.length, Math.max(a + 1, Math.ceil(end * sampleRate)));
  let sum = 0;
  let peak = 0;
  for (let i = a; i < b; i++) {
    const v = pcm[i]!;
    sum += v * v;
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
  }
  const rms = Math.sqrt(sum / Math.max(1, b - a));
  const db = (x: number) => Math.round(20 * Math.log10(Math.max(1e-6, x)) * 100) / 100;
  return { rmsDb: db(rms), peakDb: db(peak) };
}

/** Per-word loudness of a take (source timeline). */
export async function measureWordLoudness(videoPath: string, words: TranscriptWord[]): Promise<WordLoudness[]> {
  if (words.length === 0) return [];
  const pcm = await extractAudioPcm16k(videoPath);
  return words.map((w) => ({ word: w.word, start: w.start, end: w.end, ...windowLevels(pcm, 16000, w.start, Math.max(w.end, w.start + 0.05)) }));
}
