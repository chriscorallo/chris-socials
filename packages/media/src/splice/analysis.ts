/**
 * The splice engine's ear (docs/PREMIUM_EDITOR_PLAN.md round 3; HANDOFF §4 Week 1). Where the
 * VOICE starts and stops, to the millisecond — not where Whisper thinks a word is, not where a
 * 20 ms RMS frame dips. Pure DSP, $0:
 *
 *  - a 1 ms-hop RMS envelope (5 ms window) of the full band and of the band above 2 kHz, so
 *    fricative tails ("s", "f", "th") that carry almost no low-band energy still count as voice;
 *  - hysteresis: voice turns ON at floor + 10 dB, OFF at floor + 4 dB after a 40 ms hang, so a
 *    soft word tail is not chopped into "silence" and the edges don't flicker;
 *  - plosive bursts (a sharp rise of the high band out of quiet — "p/b/t/k/d") so a cut-in can
 *    sit just before the burst and never clip it.
 *
 * The result is small (spans + bursts, a few KB), stored with the edit and replayed by the
 * golden-set harness; the raw PCM is never kept. Pure — this file is reached by the browser
 * bundle (timeline-browser → style-cut); the Node decoder lives in splice/node.ts.
 */

export interface VoiceSpan {
  start: number;
  end: number;
  /** Mean full-band level of the span (dBFS) — for the level-step audit. */
  db: number;
}

export interface SpliceAnalysis {
  version: 1;
  durationS: number;
  /** Room-noise floor / speech level (dBFS), full band. */
  floorDb: number;
  speechDb: number;
  /** Where the voice is, in time order, never overlapping. */
  voice: VoiceSpan[];
  /** Plosive burst onsets (s). */
  bursts: number[];
}

export interface SpliceAnalysisOptions {
  /** Hop between envelope frames (s). */
  hopS: number;
  /** RMS window (s). */
  windowS: number;
  /** Voice ON at floor + this (dB) … */
  onAboveFloorDb: number;
  /** … and OFF below floor + this (dB), after `hangS`. */
  offAboveFloorDb: number;
  hangS: number;
  /** High band: ON / OFF above the high-band floor (dB). */
  hfOnAboveFloorDb: number;
  hfOffAboveFloorDb: number;
  /** Spans shorter than this are clicks, not voice (s); gaps shorter than this are merged. */
  minVoiceS: number;
  minGapS: number;
  /** A burst: the high band rises by this much (dB) within `burstRiseS` after ≥ `burstQuietS` of quiet. */
  burstRiseDb: number;
  burstRiseS: number;
  burstQuietS: number;
}

export const DEFAULT_SPLICE_ANALYSIS_OPTIONS: SpliceAnalysisOptions = {
  hopS: 0.001,
  windowS: 0.005,
  onAboveFloorDb: 10,
  offAboveFloorDb: 4,
  hangS: 0.04,
  hfOnAboveFloorDb: 12,
  hfOffAboveFloorDb: 6,
  minVoiceS: 0.03,
  minGapS: 0.02,
  burstRiseDb: 12,
  burstRiseS: 0.005,
  burstQuietS: 0.02,
};

export const SPLICE_ANALYSIS_VERSION = 1 as const;

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) return -120;
  const sorted = Float32Array.from(values).sort();
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i]!;
}

/** Two cascaded one-pole high-pass stages at `cutoffHz` (−12 dB/oct). */
function highPass(pcm: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const a = rc / (rc + dt);
  let out = pcm;
  for (let pass = 0; pass < 2; pass++) {
    const y = new Float32Array(out.length);
    let prevX = 0;
    let prevY = 0;
    for (let i = 0; i < out.length; i++) {
      const x = out[i]!;
      prevY = a * (prevY + x - prevX);
      prevX = x;
      y[i] = prevY;
    }
    out = y;
  }
  return out;
}

/** RMS in dBFS per hop, over a centred window. */
function envelopeDb(pcm: Float32Array, sampleRate: number, hopS: number, windowS: number): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate * hopS));
  const win = Math.max(hop, Math.round(sampleRate * windowS));
  const n = Math.max(0, Math.floor(pcm.length / hop));
  const out = new Float32Array(n);
  // Prefix sums of x² for O(1) windows.
  const prefix = new Float64Array(pcm.length + 1);
  for (let i = 0; i < pcm.length; i++) prefix[i + 1] = prefix[i]! + pcm[i]! * pcm[i]!;
  const half = Math.floor(win / 2);
  for (let f = 0; f < n; f++) {
    const c = f * hop;
    const a = Math.max(0, c - half);
    const b = Math.min(pcm.length, c - half + win);
    const sum = prefix[b]! - prefix[a]!;
    out[f] = 10 * Math.log10(sum / Math.max(1, b - a) + 1e-12);
  }
  return out;
}

/** Pure. Mono PCM → where the voice is, with plosive bursts. */
export function analyzeSplicePcm(pcm: Float32Array, sampleRate: number, options: Partial<SpliceAnalysisOptions> = {}): SpliceAnalysis {
  const o = { ...DEFAULT_SPLICE_ANALYSIS_OPTIONS, ...options };
  const durationS = pcm.length / sampleRate;
  // Two views of the same signal: a fine one (5 ms) for exact onsets/offsets and a smoothed
  // one (20 ms) for the ON/OFF decision, so a rumbling room does not flicker the state.
  const hfPcm = highPass(pcm, sampleRate, 2000);
  const fine = envelopeDb(pcm, sampleRate, o.hopS, o.windowS);
  const smooth = envelopeDb(pcm, sampleRate, o.hopS, Math.max(o.windowS, 0.02));
  const hfFine = envelopeDb(hfPcm, sampleRate, o.hopS, o.windowS);
  const hfSmooth = envelopeDb(hfPcm, sampleRate, o.hopS, Math.max(o.windowS, 0.02));
  const n = fine.length;
  const empty = (floorDb: number, speechDb: number): SpliceAnalysis => ({ version: SPLICE_ANALYSIS_VERSION, durationS: r3(durationS), floorDb: r1(floorDb), speechDb: r1(speechDb), voice: [], bursts: [] });
  if (n === 0) return empty(-120, -120);
  const floorDb = percentile(smooth, 0.05);
  const speechDb = percentile(smooth, 0.9);
  const hfFloor = percentile(hfSmooth, 0.05);
  const on = floorDb + o.onAboveFloorDb;
  const off = floorDb + o.offAboveFloorDb;
  // The high band votes only when it carries real energy: a near-empty band (a low-passed
  // room, a tiny click) fluctuates by tens of dB around nothing and must not read as voice.
  const hfOn = Math.max(hfFloor + o.hfOnAboveFloorDb, floorDb + 3);
  const hfOff = Math.max(hfFloor + o.hfOffAboveFloorDb, floorDb - 3);
  // No speech at all: a take whose loud frames are not above its quiet ones.
  if (speechDb - floorDb < o.onAboveFloorDb) return empty(floorDb, speechDb);

  // How high the room's own 5 ms frames reach while the smoothed view says quiet: a span's
  // offset must sit above that, or a rumbling room would stretch every word's tail.
  const quietFine: number[] = [];
  for (let f = 0; f < n; f++) if (smooth[f]! < off) quietFine.push(fine[f]!);
  const quietFinePeak = quietFine.length ? percentile(Float32Array.from(quietFine), 0.95) : off;

  const hangFrames = Math.round(o.hangS / o.hopS);
  const spans: Array<{ a: number; b: number }> = [];
  let voiced = false;
  let start = 0;
  let quietRun = 0;
  const lastLoud = (from: number): number => {
    // The exact offset: the last fine frame still clearly voice (within 30 dB of the span's
    // peak, never below OFF) before the smoothed view went quiet — a decaying tail counts, the
    // room's own rumble does not.
    let peak = -120;
    for (let g = start; g <= from; g++) peak = Math.max(peak, fine[g]!);
    const floorOfSpan = Math.max(off, quietFinePeak + 2, peak - 30);
    for (let g = from; g > start; g--) if (fine[g]! >= floorOfSpan || hfFine[g]! >= hfOff) return g + 1;
    return from + 1;
  };
  for (let f = 0; f < n; f++) {
    if (!voiced) {
      if (fine[f]! >= on || hfFine[f]! >= hfOn) {
        voiced = true;
        start = f;
        quietRun = 0;
      }
    } else if (smooth[f]! < off && hfSmooth[f]! < hfOff) {
      quietRun++;
      if (quietRun > hangFrames) {
        spans.push({ a: start, b: lastLoud(f - quietRun) });
        voiced = false;
      }
    } else quietRun = 0;
  }
  if (voiced) spans.push({ a: start, b: n });

  // Clicks out, tiny gaps closed.
  const minVoice = Math.round(o.minVoiceS / o.hopS);
  const minGap = Math.round(o.minGapS / o.hopS);
  const merged: Array<{ a: number; b: number }> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.a - last.b < minGap) last.b = Math.max(last.b, s.b);
    else merged.push({ ...s });
  }
  // A span is voice when it is long enough and clearly above the room, not a rumble spike.
  const meanOf = (s: { a: number; b: number }) => {
    let sum = 0;
    for (let f = s.a; f < s.b; f++) sum += fine[f]!;
    return sum / Math.max(1, s.b - s.a);
  };
  const kept = merged.filter((s) => s.b - s.a >= minVoice && meanOf(s) >= floorDb + 6);

  const voice: VoiceSpan[] = kept.map((s) => {
    let sum = 0;
    for (let f = s.a; f < s.b; f++) sum += fine[f]!;
    return { start: r3(s.a * o.hopS), end: r3(s.b * o.hopS), db: r1(sum / Math.max(1, s.b - s.a)) };
  });

  // Bursts: the high band jumps out of quiet, and the energy IS mostly high band (a voiced
  // onset ramps the low band first; a "p/t/k" release is a high-band click).
  const riseFrames = Math.max(1, Math.round(o.burstRiseS / o.hopS));
  const quietFrames = Math.round(o.burstQuietS / o.hopS);
  const bursts: number[] = [];
  let hfQuiet = 0;
  for (let f = 0; f < n; f++) {
    if (hfFine[f]! < hfOff) {
      hfQuiet++;
      continue;
    }
    if (hfQuiet >= quietFrames) {
      const base = hfFine[Math.max(0, f - 1)]!;
      let peak = base;
      let peakFull = fine[f]!;
      for (let g = f; g < Math.min(n, f + riseFrames); g++) {
        if (hfFine[g]! > peak) {
          peak = hfFine[g]!;
          peakFull = fine[g]!;
        }
      }
      if (peak - base >= o.burstRiseDb && peak >= peakFull - 10) bursts.push(r3(f * o.hopS));
    }
    hfQuiet = 0;
  }
  return { version: SPLICE_ANALYSIS_VERSION, durationS: r3(durationS), floorDb: r1(floorDb), speechDb: r1(speechDb), voice, bursts };
}

/** The quiet between voice spans, as the style cut's `silences` (the whole take's edges included). */
export function silencesFromVoice(a: SpliceAnalysis, minS = 0.01): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let t = 0;
  for (const v of a.voice) {
    if (v.start - t >= minS) out.push({ start: r3(t), end: r3(v.start) });
    t = Math.max(t, v.end);
  }
  if (a.durationS - t >= minS) out.push({ start: r3(t), end: r3(a.durationS) });
  return out;
}

export function isSpliceAnalysis(value: unknown): value is SpliceAnalysis {
  const v = value as Partial<SpliceAnalysis> | null;
  return !!v && v.version === 1 && Array.isArray(v.voice) && Array.isArray(v.bursts) && typeof v.durationS === "number";
}
