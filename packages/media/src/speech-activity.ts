/**
 * Where a take is actually silent — measured from the audio, not from Whisper.
 *
 * Whisper's word timings are good for WHICH word and roughly WHEN, but its word edges drift
 * ±0.2–0.4 s (measured 2026-10-17 on a `say` take with known silences: sentence-final words
 * end ~0.2 s before the voice does, and a word after a long pause often "starts" inside the
 * pause). Cutting pauses on Whisper edges alone would clip the ends of sentences. So the style
 * cut removes only stretches the AUDIO says are quiet, and uses Whisper for punctuation and
 * word boundaries.
 *
 * PURE core (`detectSilencesFromPcm`) — 20 ms RMS frames, an adaptive threshold between the
 * room-noise floor and the speech level, a minimum silence length. No model, $0.
 */

export interface SilenceInterval {
  start: number;
  end: number;
}

export interface SilenceAnalysis {
  silences: SilenceInterval[];
  /** Room-noise floor (5th percentile of 20 ms frames), dBFS. */
  floorDb: number;
  /** Speech level (90th percentile of frames), dBFS. */
  speechDb: number;
  /** Frames below this are silent, dBFS. */
  thresholdDb: number;
  durationS: number;
}

export interface SilenceOptions {
  /** Frame length (s). */
  frameS: number;
  /** Shortest silence reported (s). */
  minSilenceS: number;
  /** Threshold position between floor (0) and speech (1), in dB. Low = only true quiet counts. */
  thresholdFraction: number;
  /** Threshold is at least this far above the floor (dB). */
  minAboveFloorDb: number;
}

export const DEFAULT_SILENCE_OPTIONS: SilenceOptions = {
  frameS: 0.02,
  minSilenceS: 0.1,
  thresholdFraction: 0.3,
  minAboveFloorDb: 6,
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return -120;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i]!;
}

/** Pure. Mono PCM (any sample rate) → silent intervals (seconds). */
export function detectSilencesFromPcm(pcm: Float32Array, sampleRate: number, options: Partial<SilenceOptions> = {}): SilenceAnalysis {
  const o = { ...DEFAULT_SILENCE_OPTIONS, ...options };
  const frame = Math.max(1, Math.round(sampleRate * o.frameS));
  const n = Math.floor(pcm.length / frame);
  const durationS = pcm.length / sampleRate;
  const db: number[] = new Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    const off = f * frame;
    for (let i = 0; i < frame; i++) {
      const v = pcm[off + i]!;
      sum += v * v;
    }
    db[f] = 10 * Math.log10(sum / frame + 1e-12);
  }
  const sorted = [...db].sort((a, b) => a - b);
  const floorDb = percentile(sorted, 0.05);
  const speechDb = percentile(sorted, 0.9);
  const thresholdDb = floorDb + Math.max(o.minAboveFloorDb, o.thresholdFraction * (speechDb - floorDb));
  const silences: SilenceInterval[] = [];
  let runStart = -1;
  for (let f = 0; f <= n; f++) {
    const quiet = f < n && db[f]! < thresholdDb;
    if (quiet && runStart < 0) runStart = f;
    if (!quiet && runStart >= 0) {
      const s = (runStart * frame) / sampleRate;
      const e = f === n ? durationS : (f * frame) / sampleRate;
      if (e - s >= o.minSilenceS - 1e-9) silences.push({ start: round3(s), end: round3(e) });
      runStart = -1;
    }
  }
  // A take that is silent from start to end has no speech at all.
  if (speechDb - floorDb < o.minAboveFloorDb) return { silences: n ? [{ start: 0, end: round3(durationS) }] : [], floorDb, speechDb, thresholdDb, durationS };
  return { silences, floorDb: round1(floorDb), speechDb: round1(speechDb), thresholdDb: round1(thresholdDb), durationS: round3(durationS) };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Loudness envelope: RMS dBFS per `frameS` (default 100 ms) — the Full edit's delivery-energy
 * signal (a line said louder/with more energy than the rest of the take). Pure. */
export function loudnessEnvelopeFromPcm(pcm: Float32Array, sampleRate: number, frameS = 0.1): { frameS: number; db: number[] } {
  const frame = Math.max(1, Math.round(sampleRate * frameS));
  const n = Math.floor(pcm.length / frame);
  const db: number[] = new Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    const off = f * frame;
    for (let i = 0; i < frame; i++) {
      const v = pcm[off + i]!;
      sum += v * v;
    }
    db[f] = Math.round(10 * Math.log10(sum / frame + 1e-12) * 10) / 10;
  }
  return { frameS, db };
}

/** Node: one decode → silences + loudness envelope (the Full edit's audio inputs). */
export async function analyzeTakeAudio(filePath: string, options: Partial<SilenceOptions> = {}): Promise<SilenceAnalysis & { envelope: { frameS: number; db: number[] } }> {
  const { extractAudioPcm16k, WHISPER_SAMPLE_RATE } = await import("./transcription/local-whisper");
  const pcm = await extractAudioPcm16k(filePath);
  return { ...detectSilencesFromPcm(pcm, WHISPER_SAMPLE_RATE, options), envelope: loudnessEnvelopeFromPcm(pcm, WHISPER_SAMPLE_RATE) };
}

/** Node: decodes a take's audio (16 kHz mono via ffmpeg) and finds its silences. */
export async function detectSilences(filePath: string, options: Partial<SilenceOptions> = {}): Promise<SilenceAnalysis> {
  const { extractAudioPcm16k, WHISPER_SAMPLE_RATE } = await import("./transcription/local-whisper");
  const pcm = await extractAudioPcm16k(filePath);
  return detectSilencesFromPcm(pcm, WHISPER_SAMPLE_RATE, options);
}
