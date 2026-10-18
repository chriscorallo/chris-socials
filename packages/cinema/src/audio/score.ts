import { rng } from "../ease";

/**
 * The procedural score: an original, generated-from-code ambient cue (no samples, no licenses).
 * Layers, each following a per-shot intensity curve:
 *   - pad: the chord progression on detuned saw/triangle voices through a slow low-pass,
 *   - sub: the chord root an octave down (warm sine, soft saturation),
 *   - pluck: a sparse felt-piano-like FM arpeggio,
 *   - pulse: a soft heartbeat kick + ticking hat for tension (intensity > ~0.55),
 *   - hits: boom + swell where a shot asks for one; drops: silence for "the beat before the twist".
 * Ducking under the narration is applied in-sample from the real word timings, so the voice is
 * always on top without pumping. Deterministic: same plan + seed → same samples.
 */

export const SCORE_SAMPLE_RATE = 48000;

export interface ScoreSection {
  start: number;
  end: number;
  intensity: number;
  hit?: boolean;
  drop?: boolean;
}

export interface ScorePlan {
  durationSeconds: number;
  bpm: number;
  /** "D minor" etc. */
  key: string;
  sections: ScoreSection[];
  /** Speech windows (seconds) — the music ducks under these. */
  speech: Array<{ start: number; end: number }>;
  /** dB the music sits under the voice while speech is on (negative). */
  duckDb: number;
  seed: number;
}

const NOTE_INDEX: Record<string, number> = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };

/** MIDI note of the key's root in octave 3 (D minor → D3 = 50). */
export function keyRoot(key: string): { root: number; minor: boolean } {
  const [n, mode] = key.split(" ");
  return { root: 48 + (NOTE_INDEX[n ?? "D"] ?? 2), minor: mode !== "major" };
}

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** A slow cinematic progression (degrees + chord quality) — i–VI–III–VII in minor, I–vi–IV–V-ish in major. */
export function progression(key: string): number[][] {
  const { root, minor } = keyRoot(key);
  // chord tones as semitone offsets from the key root
  const chords = minor
    ? [
        [0, 3, 7, 14], // i(add9)
        [-4, 0, 3, 10], // VI(maj7)
        [3, 7, 10, 14], // III
        [-2, 2, 5, 9], // VII
      ]
    : [
        [0, 4, 7, 14],
        [-3, 0, 4, 11],
        [-7, -3, 0, 7],
        [-5, -1, 2, 9],
      ];
  return chords.map((c) => c.map((s) => root + s));
}

function intensityAt(plan: ScorePlan, t: number): number {
  // smoothed: blend across section boundaries over 0.8 s
  let v = 0;
  for (const s of plan.sections) {
    if (t >= s.start - 0.4 && t < s.end + 0.4) {
      const fadeIn = Math.min(1, (t - (s.start - 0.4)) / 0.8);
      const fadeOut = Math.min(1, (s.end + 0.4 - t) / 0.8);
      v = Math.max(v, s.intensity * Math.max(0, Math.min(fadeIn, fadeOut)));
    }
  }
  return v;
}

function dropGain(plan: ScorePlan, t: number): number {
  let g = 1;
  for (const s of plan.sections) {
    if (!s.drop) continue;
    const a = Math.min(1, Math.max(0, (t - (s.start - 0.12)) / 0.12));
    const b = Math.min(1, Math.max(0, (s.end - t) / 0.05));
    g = Math.min(g, 1 - Math.min(a, b) * 0.97);
  }
  return g;
}

/** Duck envelope from speech windows: down 0.12 s before a word, release 0.45 s after. */
export function duckEnvelope(plan: ScorePlan, t: number): number {
  const down = Math.pow(10, plan.duckDb / 20);
  let k = 0;
  for (const w of plan.speech) {
    if (t < w.start - 0.12 || t > w.end + 0.45) continue;
    let v = 1;
    if (t < w.start) v = (t - (w.start - 0.12)) / 0.12;
    else if (t > w.end) v = 1 - (t - w.end) / 0.45;
    k = Math.max(k, Math.max(0, Math.min(1, v)));
  }
  return 1 + (down - 1) * k;
}

class OnePole {
  z = 0;
  run(x: number, coef: number) {
    this.z += coef * (x - this.z);
    return this.z;
  }
}

class Comb {
  buf: Float32Array;
  i = 0;
  store = 0;
  constructor(n: number) {
    this.buf = new Float32Array(n);
  }
  run(x: number, fb: number, damp: number) {
    const y = this.buf[this.i]!;
    this.store = y * (1 - damp) + this.store * damp;
    this.buf[this.i] = x + this.store * fb;
    this.i = (this.i + 1) % this.buf.length;
    return y;
  }
}

class Allpass {
  buf: Float32Array;
  i = 0;
  constructor(n: number) {
    this.buf = new Float32Array(n);
  }
  run(x: number) {
    const b = this.buf[this.i]!;
    const y = -x + b;
    this.buf[this.i] = x + b * 0.5;
    this.i = (this.i + 1) % this.buf.length;
    return y;
  }
}

/** Freeverb-style stereo reverb (8 combs + 4 allpasses per side). */
class Reverb {
  l: Comb[];
  r: Comb[];
  al: Allpass[];
  ar: Allpass[];
  constructor(sr: number) {
    const s = sr / 44100;
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
    const aps = [556, 441, 341, 225];
    this.l = combs.map((n) => new Comb(Math.round(n * s)));
    this.r = combs.map((n) => new Comb(Math.round((n + 23) * s)));
    this.al = aps.map((n) => new Allpass(Math.round(n * s)));
    this.ar = aps.map((n) => new Allpass(Math.round((n + 23) * s)));
  }
  run(x: number, room = 0.86, damp = 0.4): [number, number] {
    let l = 0;
    let r = 0;
    for (const c of this.l) l += c.run(x, room, damp);
    for (const c of this.r) r += c.run(x, room, damp);
    for (const a of this.al) l = a.run(l);
    for (const a of this.ar) r = a.run(r);
    return [l * 0.06, r * 0.06];
  }
}

const softClip = (x: number) => Math.tanh(x);

/** Renders the score to interleaved stereo float samples at SCORE_SAMPLE_RATE. */
export function renderScore(plan: ScorePlan): Float32Array {
  const sr = SCORE_SAMPLE_RATE;
  const n = Math.ceil(plan.durationSeconds * sr);
  const out = new Float32Array(n * 2);
  const rand = rng(plan.seed);
  const chords = progression(plan.key);
  const beat = 60 / plan.bpm;
  const chordLen = beat * 8; // two bars of 4/4 per chord
  const reverb = new Reverb(sr);
  const padLp = [new OnePole(), new OnePole()];
  const subLp = new OnePole();
  const hatHp = new OnePole();
  // per-voice phases + detune (seeded)
  const voices = 4 * 3;
  const phase = new Float64Array(voices * 2);
  const detune = Array.from({ length: voices }, () => (rand() - 0.5) * 0.012);
  for (let i = 0; i < phase.length; i++) phase[i] = rand();
  let subPhase = 0;
  // pluck schedule: an arpeggio note every 2 beats, seeded choices
  const plucks: Array<{ t: number; midi: number; vel: number }> = [];
  for (let t = beat * 2; t < plan.durationSeconds; t += beat * 2) {
    const ci = Math.floor(t / chordLen) % chords.length;
    const tones = chords[ci]!;
    plucks.push({ t: t + (rand() - 0.5) * 0.02, midi: tones[Math.floor(rand() * tones.length)]! + 12, vel: 0.6 + rand() * 0.4 });
  }
  const hits = plan.sections.filter((s) => s.hit).map((s) => s.start);
  const noise = rng(plan.seed ^ 0x9e3779b9);

  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const inten = intensityAt(plan, t);
    const ci = Math.floor(t / chordLen);
    const chord = chords[ci % chords.length]!;
    const prevChord = chords[(ci - 1 + chords.length) % chords.length]!;
    const inChord = t - ci * chordLen;
    const xf = Math.min(1, inChord / 1.6); // 1.6 s crossfade between chords
    // --- pad
    let padL = 0;
    let padR = 0;
    for (let v = 0; v < 4; v++) {
      for (const [ch, g] of [
        [chord, xf],
        [prevChord, 1 - xf],
      ] as const) {
        if (g <= 0.001) continue;
        const hz = midiHz(ch[v]!) * (1 + detune[v]!);
        for (let side = 0; side < 2; side++) {
          const idx = (v * 3 + (ch === chord ? 0 : 1)) * 2 + side;
          phase[idx] = (phase[idx]! + (hz * (1 + (side ? 0.0035 : -0.0035))) / sr) % 1;
          const p = phase[idx]!;
          const saw = 2 * p - 1;
          const tri = 1 - 4 * Math.abs(p - 0.5);
          const s = (saw * 0.35 + tri * 0.65) * g * 0.11;
          if (side) padR += s;
          else padL += s;
        }
      }
    }
    // slow filter opening with intensity (dark when calm)
    const cutoff = 0.012 + inten * 0.05 + 0.006 * Math.sin(t * 0.21);
    padL = padLp[0]!.run(padL, cutoff);
    padR = padLp[1]!.run(padR, cutoff);
    const padGain = 0.55 + inten * 0.45;
    // --- sub
    subPhase = (subPhase + midiHz(chord[0]! - 12) / sr) % 1;
    const sub = subLp.run(softClip(Math.sin(subPhase * Math.PI * 2) * 1.4) * 0.22, 0.05) * (0.3 + inten * 0.7) * xf + 0;
    // --- plucks (FM, exponential decay)
    let pl = 0;
    if (inten > 0.25) {
      for (const p of plucks) {
        const u = t - p.t;
        if (u < 0 || u > 2.2) continue;
        const hz = midiHz(p.midi);
        const env = Math.exp(-u * 3.2) * Math.min(1, u * 200);
        const mod = Math.sin(2 * Math.PI * hz * 2 * u) * 1.6 * Math.exp(-u * 6);
        pl += Math.sin(2 * Math.PI * hz * u + mod) * env * p.vel * 0.09 * Math.min(1, (inten - 0.25) * 3);
      }
    }
    // --- pulse (heartbeat kick on 1 and 3, hat on 8ths) for tension
    let pulse = 0;
    if (inten > 0.55) {
      const amt = Math.min(1, (inten - 0.55) / 0.3);
      const bpos = t % (beat * 2);
      const kickU = bpos;
      const kf = 48 + 70 * Math.exp(-kickU * 28);
      pulse += Math.sin(2 * Math.PI * kf * kickU) * Math.exp(-kickU * 9) * 0.32 * amt;
      const hpos = t % (beat / 2);
      const nz = noise() * 2 - 1;
      const hp = nz - hatHp.run(nz, 0.25);
      pulse += hp * Math.exp(-hpos * 60) * 0.035 * amt;
    }
    // --- hits: boom (pitch-dropping sine + noise burst)
    let boom = 0;
    for (const h of hits) {
      const u = t - h;
      if (u < 0 || u > 3) continue;
      const f = 38 + 60 * Math.exp(-u * 10);
      boom += Math.sin(2 * Math.PI * f * u) * Math.exp(-u * 2.2) * 0.5;
      boom += (noise() * 2 - 1) * Math.exp(-u * 18) * 0.08;
    }
    const dry = (padL + padR) * 0.5 * padGain;
    const [rl, rr] = reverb.run(dry * 0.8 + pl * 1.2 + boom * 0.3);
    const g = dropGain(plan, t) * duckEnvelope(plan, t);
    out[i * 2] = softClip((padL * padGain + sub + pl * 0.8 + pulse + boom + rl * 1.6) * g * 0.9);
    out[i * 2 + 1] = softClip((padR * padGain + sub + pl * 0.8 + pulse + boom + rr * 1.6) * g * 0.9);
  }
  // fade in/out
  const fi = Math.min(n, Math.round(sr * 0.6));
  const fo = Math.min(n, Math.round(sr * 1.4));
  for (let i = 0; i < fi; i++) {
    out[i * 2]! *= i / fi;
    out[i * 2 + 1]! *= i / fi;
  }
  for (let i = 0; i < fo; i++) {
    const k = i / fo;
    out[(n - 1 - i) * 2]! *= k;
    out[(n - 1 - i) * 2 + 1]! *= k;
  }
  return out;
}

/** 16-bit stereo WAV from interleaved float samples (peak-normalized to `peakDb`). */
export function encodeStereoWav(samples: Float32Array, sampleRate: number, peakDb = -1): Buffer {
  let peak = 1e-9;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
  const gain = Math.pow(10, peakDb / 20) / peak;
  const frames = samples.length / 2;
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]! * gain));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}
