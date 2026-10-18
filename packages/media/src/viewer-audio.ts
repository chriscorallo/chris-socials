/**
 * Measured sound facts for the Viewer Panel — PURE (mono PCM in, numbers out; no Node APIs).
 * What a viewer hears as "the sound jumped" or "a pop at the cut", as deterministic numbers the
 * model is handed instead of guessing from frames. Voice-vs-background reuses
 * measureVoiceBackground (style-analysis.ts); loudness reuses measureStyleLoudness.
 */

function rmsDb(pcm: Float32Array, from: number, to: number): number | null {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(pcm.length, Math.floor(to));
  if (b - a < 8) return null;
  let sum = 0;
  for (let i = a; i < b; i++) sum += pcm[i]! * pcm[i]!;
  return 10 * Math.log10(Math.max(1e-12, sum / (b - a)));
}

function speechSeconds(words: Array<{ start: number; end: number }>, a: number, b: number): number {
  let s = 0;
  for (const w of words) {
    const lo = Math.max(a, w.start);
    const hi = Math.min(b, w.end);
    if (hi > lo) s += hi - lo;
  }
  return s;
}

export interface ViewerAudioMeasure {
  /** dBFS RMS per whole second (index = second). */
  levelPerSecond: number[];
  /** Neighbouring seconds, both ≥ 50 % speech, whose levels differ by ≥ `jumpDb`. */
  levelJumps: Array<{ t: number; fromDb: number; toDb: number }>;
  /** Cuts where the 150 ms after is ≥ `jumpDb` louder/quieter than the 150 ms before, with speech on both sides. */
  cutJumps: Array<{ t: number; deltaDb: number }>;
}

export function measureViewerAudio(
  pcm: Float32Array,
  sampleRate: number,
  input: { words: Array<{ start: number; end: number }>; cutTimes: number[]; durationS: number },
  options: { jumpDb?: number; cutWindowS?: number } = {},
): ViewerAudioMeasure {
  const jump = options.jumpDb ?? 6;
  const cw = options.cutWindowS ?? 0.15;
  const d = Math.min(input.durationS > 0 ? input.durationS : Infinity, pcm.length / sampleRate);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const levelPerSecond: number[] = [];
  const share: number[] = [];
  for (let s = 0; s + 0.5 <= d; s++) {
    const end = Math.min(d, s + 1);
    const db = rmsDb(pcm, s * sampleRate, end * sampleRate);
    levelPerSecond.push(db == null ? -120 : r1(Math.max(-120, db)));
    share.push(speechSeconds(input.words, s, end) / Math.max(0.02, end - s));
  }
  const levelJumps: ViewerAudioMeasure["levelJumps"] = [];
  for (let s = 1; s < levelPerSecond.length; s++) {
    if (share[s - 1]! < 0.5 || share[s]! < 0.5) continue;
    const a = levelPerSecond[s - 1]!;
    const b = levelPerSecond[s]!;
    if (Math.abs(b - a) >= jump) levelJumps.push({ t: s, fromDb: a, toDb: b });
  }
  const cutJumps: ViewerAudioMeasure["cutJumps"] = [];
  for (const t of input.cutTimes) {
    if (t - cw < 0 || t + cw > d) continue;
    if (speechSeconds(input.words, t - cw, t) < cw * 0.3 || speechSeconds(input.words, t, t + cw) < cw * 0.3) continue;
    const before = rmsDb(pcm, (t - cw) * sampleRate, t * sampleRate);
    const after = rmsDb(pcm, t * sampleRate, (t + cw) * sampleRate);
    if (before == null || after == null) continue;
    if (Math.abs(after - before) >= jump) cutJumps.push({ t: Math.round(t * 100) / 100, deltaDb: r1(after - before) });
  }
  return { levelPerSecond, levelJumps, cutJumps };
}
