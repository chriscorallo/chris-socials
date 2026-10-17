import type { TimelineMusic } from "@chris/media/timeline";

/**
 * Preview approximation of the renderer's music bed (packages/media buildAudioMix) — PURE.
 * The render loudness-normalises the track to the voice and ducks it from real word timings;
 * the editor preview can't measure loudness, so it plays the file at `levelDb` (as a linear
 * gain), lowers it by `duckDb` while words are being spoken (0.15 s lead-in, 0.4 s release —
 * the renderer's ramps) and applies the fades. Good enough to judge "is the music too loud /
 * does it fit", never a substitute for the render.
 */

export const DUCK_ATTACK_SECONDS = 0.15;
export const DUCK_RELEASE_SECONDS = 0.4;
/** Words closer than this merge into one speech region (renderer: 0.45 s). */
export const SPEECH_MERGE_GAP = 0.45;

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Merged speech regions (output seconds) from word timings. */
export function speechRegions(words: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const s = [...words].filter((w) => w.end > w.start).sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const w of s) {
    const last = out[out.length - 1];
    if (last && w.start - last.end < SPEECH_MERGE_GAP) last.end = Math.max(last.end, w.end);
    else out.push({ start: w.start, end: w.end });
  }
  return out;
}

/** 0..1 — how far the duck is engaged at time t (1 = fully ducked). */
export function duckAmount(regions: Array<{ start: number; end: number }>, t: number): number {
  let amt = 0;
  for (const r of regions) {
    if (t >= r.start - DUCK_ATTACK_SECONDS && t < r.start) amt = Math.max(amt, (t - (r.start - DUCK_ATTACK_SECONDS)) / DUCK_ATTACK_SECONDS);
    else if (t >= r.start && t <= r.end) return 1;
    else if (t > r.end && t < r.end + DUCK_RELEASE_SECONDS) amt = Math.max(amt, 1 - (t - r.end) / DUCK_RELEASE_SECONDS);
    if (r.start - DUCK_ATTACK_SECONDS > t) break;
  }
  return Math.min(1, Math.max(0, amt));
}

/** Linear gain for the music element at output time t of a video `duration` seconds long. */
export function musicGainAt(music: Pick<TimelineMusic, "levelDb" | "duckDb" | "fadeInSeconds" | "fadeOutSeconds">, regions: Array<{ start: number; end: number }>, t: number, duration: number): number {
  const duckDb = music.duckDb * duckAmount(regions, t);
  let g = dbToGain(music.levelDb - duckDb);
  if (music.fadeInSeconds > 0 && t < music.fadeInSeconds) g *= Math.max(0, t / music.fadeInSeconds);
  const toEnd = duration - t;
  if (music.fadeOutSeconds > 0 && toEnd < music.fadeOutSeconds) g *= Math.max(0, toEnd / music.fadeOutSeconds);
  return Math.min(1, Math.max(0, g));
}

/** Where in the track the music should be at output time t. */
export function musicTrackTime(music: Pick<TimelineMusic, "trackStart">, t: number, trackDuration: number): number | null {
  const x = music.trackStart + t;
  return trackDuration > 0 && x >= trackDuration ? null : x;
}
