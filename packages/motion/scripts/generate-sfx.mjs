#!/usr/bin/env node
/**
 * Procedural SFX kit generator — every sound in packages/motion/assets/sfx/ is synthesized
 * here from scratch (seeded noise, sine/FM oscillators, filters, envelopes, a small
 * Schroeder/Freeverb-style reverb). No samples, no third-party audio: zero licensing risk and
 * fully reproducible (`pnpm --filter @chris/motion sfx`). Output: 48 kHz, stereo, 16-bit PCM
 * WAV, peak-normalized to PEAK_DBFS (<= -6 dBFS) so the kit sits under the voice by design.
 *
 * Design brief: premium, clean, restrained — Apple-keynote / finance-explainer UI sound, not
 * cartoon. Soft transients, no harsh 2–5 kHz spikes, gentle air on top, short tails.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SR = 48000;
const PEAK_DBFS = -8;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "sfx");

// ---------- primitives ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const buf = (sec) => new Float64Array(Math.round(sec * SR));
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
/** exponential frequency interpolation */
const expInterp = (a, b, t) => a * Math.pow(b / a, clamp01(t));

function noise(len, seed) {
  const r = rng(seed);
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) out[i] = r() * 2 - 1;
  return out;
}

/** Time-varying state-variable filter (Chamberlin, oversampled x2). mode: lp|bp|hp */
function svf(input, freqAt, q, mode) {
  const out = new Float64Array(input.length);
  let low = 0;
  let band = 0;
  const damp = 1 / q;
  for (let i = 0; i < input.length; i++) {
    const fc = Math.min(freqAt(i / SR), SR / 6);
    const f = 2 * Math.sin((Math.PI * fc) / (SR * 2));
    let y = 0;
    for (let k = 0; k < 2; k++) {
      low += f * band;
      const high = input[i] - low - damp * band;
      band += f * high;
      y = mode === "lp" ? low : mode === "bp" ? band : high;
    }
    out[i] = y;
  }
  return out;
}

function onePoleLP(input, fc) {
  const a = Math.exp((-2 * Math.PI * fc) / SR);
  const out = new Float64Array(input.length);
  let y = 0;
  for (let i = 0; i < input.length; i++) {
    y = (1 - a) * input[i] + a * y;
    out[i] = y;
  }
  return out;
}
function onePoleHP(input, fc) {
  const lp = onePoleLP(input, fc);
  return input.map((v, i) => v - lp[i]);
}

/** Sine with a frequency function (Hz) of time; optional FM: modRatio, modIndexAt(t). */
function osc(len, freqAt, { phase = 0, modRatio = 0, modIndexAt = () => 0 } = {}) {
  const out = new Float64Array(len);
  let p = phase;
  let mp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = freqAt(t);
    const mod = modRatio ? Math.sin(mp) * modIndexAt(t) : 0;
    out[i] = Math.sin(p + mod);
    p += (2 * Math.PI * f) / SR;
    mp += (2 * Math.PI * f * modRatio) / SR;
  }
  return out;
}

function env(len, fn) {
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) out[i] = fn(i / SR);
  return out;
}
const mul = (a, b) => a.map((v, i) => v * (typeof b === "number" ? b : (b[i] ?? 0)));
function mixInto(dst, src, offsetSec = 0, gain = 1) {
  const off = Math.round(offsetSec * SR);
  for (let i = 0; i < src.length && off + i < dst.length; i++) if (off + i >= 0) dst[off + i] += src[i] * gain;
  return dst;
}
/** attack/decay envelope: linear-ish attack, exponential decay */
const ad = (attack, decay) => (t) => (t < attack ? smooth(t / attack) : Math.exp(-(t - attack) / decay));

/** Small stereo Freeverb-style reverb. Returns [L, R] wet signals. */
function reverb(monoIn, { room = 0.78, damp = 0.4, seconds = 0 } = {}) {
  const len = monoIn.length + Math.round(seconds * SR);
  const input = new Float64Array(len);
  input.set(monoIn);
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const allp = [556, 441, 341, 225];
  const run = (spread) => {
    const out = new Float64Array(len);
    for (const d0 of combs) {
      const d = Math.round(((d0 + spread) * SR) / 44100);
      const line = new Float64Array(d);
      let idx = 0;
      let store = 0;
      for (let i = 0; i < len; i++) {
        const y = line[idx];
        store = y * (1 - damp) + store * damp;
        line[idx] = input[i] * 0.015 + store * room;
        idx = (idx + 1) % d;
        out[i] += y;
      }
    }
    for (const d0 of allp) {
      const d = Math.round(((d0 + spread) * SR) / 44100);
      const line = new Float64Array(d);
      let idx = 0;
      for (let i = 0; i < len; i++) {
        const b = line[idx];
        const y = -out[i] + b;
        line[idx] = out[i] + b * 0.5;
        idx = (idx + 1) % d;
        out[i] = y;
      }
    }
    return out;
  };
  return [run(0), run(23)];
}

function pad(a, len) {
  if (a.length >= len) return a;
  const o = new Float64Array(len);
  o.set(a);
  return o;
}

/** stereo from mono with constant-power pan function pan(t) in [-1, 1] */
function panStereo(mono, panAt) {
  const L = new Float64Array(mono.length);
  const R = new Float64Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const p = (clamp01((panAt(i / SR) + 1) / 2) * Math.PI) / 2;
    L[i] = mono[i] * Math.cos(p);
    R[i] = mono[i] * Math.sin(p);
  }
  return [L, R];
}

/** Raised-cosine release over the last `frac` of a signal, so no dry layer ever ends abruptly. */
function release(sig, frac = 0.2) {
  const out = sig.slice();
  const n = Math.max(1, Math.round(sig.length * frac));
  for (let i = 0; i < n; i++) out[sig.length - n + i] *= 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / n);
  return out;
}

function addStereo(a, b, gain = 1, releaseFrac = 0.2) {
  const len = Math.max(a[0].length, b[0].length);
  const L = pad(release(a[0], releaseFrac), len).slice();
  const R = pad(release(a[1], releaseFrac), len).slice();
  mixInto(L, b[0], 0, gain);
  mixInto(R, b[1], 0, gain);
  return [L, R];
}

function finalize([L, R], name) {
  // DC removal, gentle top-end smoothing (no harsh air), soft-clip safety, edge fades.
  let l = onePoleHP(L, 25);
  let r = onePoleHP(R, 25);
  l = onePoleLP(l, 15000);
  r = onePoleLP(r, 15000);
  const len = l.length;
  const fadeIn = Math.round(0.002 * SR);
  const fadeOut = Math.round(len * 0.15);
  for (let i = 0; i < len; i++) {
    let g = 1;
    if (i < fadeIn) g = i / fadeIn;
    if (i > len - fadeOut) g = Math.min(g, 0.5 + 0.5 * Math.cos((Math.PI * (i - (len - fadeOut))) / fadeOut));
    l[i] *= g;
    r[i] *= g;
  }
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  const target = Math.pow(10, PEAK_DBFS / 20);
  const k = peak > 0 ? target / peak : 1;
  const data = Buffer.alloc(44 + len * 4);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + len * 4, 4);
  data.write("WAVE", 8);
  data.write("fmt ", 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(len * 4, 40);
  const r2 = rng(0xd17e);
  for (let i = 0; i < len; i++) {
    // TPDF dither
    const d = (r2() - r2()) / 32768;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((l[i] * k + d) * 32767))), 44 + i * 4);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((r[i] * k + d) * 32767))), 46 + i * 4);
  }
  writeFileSync(join(OUT_DIR, `${name.toLowerCase()}.wav`), data);
  return { name, seconds: len / SR };
}

// ---------- the kit ----------
const SOUNDS = {
  /** Air moving past: band-passed noise, centre sweeps up then settles, pans L->R. */
  WHOOSH() {
    const d = 0.62;
    const len = buf(d).length;
    const center = (t) => 380 * Math.pow(2600 / 380, Math.sin(Math.PI * clamp01(t / d)) ** 1.4);
    const amp = env(len, (t) => {
      const x = clamp01(t / d);
      return Math.pow(Math.sin(Math.PI * Math.pow(x, 0.8)), 2.2);
    });
    const a = mul(svf(noise(len, 11), center, 1.6, "bp"), amp);
    const b = mul(svf(noise(len, 12), (t) => center(t) * 1.07, 1.6, "bp"), amp);
    const body = mul(svf(noise(len, 13), (t) => center(t) * 0.45, 0.9, "lp"), mul(amp, 0.35));
    const L = a.map((v, i) => v * 0.9 + body[i]);
    const R = b.map((v, i) => v * 0.9 + body[i]);
    const panned = [L.map((v, i) => v * lerp(1.15, 0.7, i / len)), R.map((v, i) => v * lerp(0.7, 1.15, i / len))];
    const [wl, wr] = reverb(mul(a, 0.5), { seconds: 0.25, room: 0.7 });
    return addStereo(panned, [wl, wr], 0.18);
  },
  /** Upward swoosh: rising band-pass + faint tonal glide, for things appearing / growing. */
  SWOOSH_UP() {
    const d = 0.5;
    const len = buf(d).length;
    const center = (t) => expInterp(320, 5200, Math.pow(t / d, 1.25));
    const amp = env(len, (t) => {
      const x = clamp01(t / d);
      return Math.pow(x, 1.6) * Math.pow(1 - x, 0.55) * 2.6;
    });
    const n1 = mul(svf(noise(len, 21), center, 2.2, "bp"), amp);
    const n2 = mul(svf(noise(len, 22), (t) => center(t) * 1.05, 2.2, "bp"), amp);
    const tone = mul(osc(len, (t) => expInterp(260, 780, t / d)), mul(amp, 0.05));
    const [wl, wr] = reverb(n1, { seconds: 0.3 });
    return addStereo([n1.map((v, i) => v + tone[i]), n2.map((v, i) => v + tone[i])], [wl, wr], 0.2);
  },
  /** Soft rounded pop: sine with a fast pitch drop and a tiny filtered transient. */
  SOFT_POP() {
    const d = 0.3;
    const len = buf(d).length;
    const s = mul(osc(len, (t) => 340 + 520 * Math.exp(-t / 0.012)), env(len, ad(0.002, 0.045)));
    const s2 = mul(osc(len, (t) => 2 * (340 + 520 * Math.exp(-t / 0.012))), env(len, ad(0.001, 0.02)));
    const tr = mul(svf(noise(len, 31), () => 1800, 1.2, "lp"), env(len, ad(0.0005, 0.004)));
    const mono = s.map((v, i) => v + s2[i] * 0.18 + tr[i] * 0.25);
    const [wl, wr] = reverb(mono, { seconds: 0.15, room: 0.6 });
    return addStereo([mono, mono], [wl, wr], 0.12);
  },
  /** Crisp, small UI click (soft, not clicky-harsh). */
  CLICK() {
    const d = 0.08;
    const len = buf(d).length;
    const body = mul(osc(len, (t) => 1650 - 500 * clamp01(t / 0.01)), env(len, ad(0.0006, 0.007)));
    const tick = mul(svf(noise(len, 41), () => 4200, 2.5, "bp"), env(len, ad(0.0003, 0.0018)));
    const low = mul(osc(len, () => 420), env(len, ad(0.001, 0.012)));
    const mono = body.map((v, i) => v * 0.8 + tick[i] * 0.5 + low[i] * 0.35);
    return [mono, mono];
  },
  /** Wooden tick for counters/steps: two inharmonic partials, very short. */
  TICK() {
    const d = 0.07;
    const len = buf(d).length;
    const e = env(len, ad(0.0005, 0.011));
    const a = mul(osc(len, () => 1420), e);
    const b = mul(osc(len, () => 1420 * 2.32), env(len, ad(0.0004, 0.005)));
    const tr = mul(svf(noise(len, 51), () => 3000, 1.5, "bp"), env(len, ad(0.0002, 0.0015)));
    const mono = a.map((v, i) => v + b[i] * 0.35 + tr[i] * 0.3);
    return [mono, mono];
  },
  /** Tension riser into a reveal: rising filtered noise + detuned rising fifths. */
  RISER() {
    const d = 1.6;
    const len = buf(d).length;
    const x = (t) => clamp01(t / d);
    const amp = env(len, (t) => Math.pow(x(t), 2.4) * (t > d - 0.04 ? (d - t) / 0.04 : 1));
    const center = (t) => expInterp(180, 6500, Math.pow(x(t), 1.5));
    const nL = mul(svf(noise(len, 61), center, 2.8, "bp"), amp);
    const nR = mul(svf(noise(len, 62), (t) => center(t) * 1.03, 2.8, "bp"), amp);
    const f0 = (t) => expInterp(110, 440, Math.pow(x(t), 1.3));
    const tone = (ratio, det, ph) => osc(len, (t) => f0(t) * ratio * det, { phase: ph, modRatio: 1, modIndexAt: (t) => 0.6 * x(t) });
    const chord = [tone(1, 1, 0), tone(1.5, 1.004, 1), tone(2, 0.997, 2)].reduce((acc, s) => acc.map((v, i) => v + s[i]), new Float64Array(len));
    const tonal = mul(onePoleLP(chord, 2500), mul(amp, 0.09));
    const [wl, wr] = reverb(nL, { seconds: 0.2, room: 0.75 });
    return addStereo([nL.map((v, i) => v + tonal[i]), nR.map((v, i) => v + tonal[i])], [wl, wr], 0.22, 0.02);
  },
  /** Cinematic hit: sub drop + soft noise transient + short dark tail. */
  IMPACT() {
    const d = 1.6;
    const len = buf(d).length;
    const sub = mul(osc(len, (t) => 46 + 70 * Math.exp(-t / 0.05)), env(len, ad(0.003, 0.24)));
    const body = mul(osc(len, (t) => 110 + 120 * Math.exp(-t / 0.02)), env(len, ad(0.002, 0.09)));
    const crack = mul(svf(noise(len, 71), (t) => 3200 * Math.exp(-t / 0.05) + 400, 0.8, "lp"), env(len, ad(0.001, 0.035)));
    let mono = sub.map((v, i) => v * 1.0 + body[i] * 0.45 + crack[i] * 0.55);
    mono = mono.map((v) => Math.tanh(v * 1.4) / Math.tanh(1.4));
    const tailSrc = mul(svf(noise(len, 72), () => 900, 0.7, "lp"), env(len, ad(0.002, 0.06)));
    const [wl, wr] = reverb(tailSrc, { seconds: 0.2, room: 0.84, damp: 0.6 });
    return addStereo([mono, mono], [wl, wr], 0.9);
  },
  /** Sparkle/shimmer: arpeggiated soft FM bells (A major, high), stereo spread + reverb. */
  SHIMMER() {
    const d = 2.0;
    const len = buf(d).length;
    const notes = [1760, 2217.46, 2637.02, 3520, 4434.92];
    const L = new Float64Array(len);
    const R = new Float64Array(len);
    notes.forEach((f, k) => {
      const start = k * 0.055;
      const n = len - Math.round(start * SR);
      const e = env(n, (t) => ad(0.004, 0.26 - k * 0.025)(t) * (1 + 0.15 * Math.sin(2 * Math.PI * 7 * t)));
      const tone = mul(osc(n, () => f, { modRatio: 3.5, modIndexAt: (t) => 0.9 * Math.exp(-t / 0.05) }), e);
      const pan = -0.7 + (1.4 * k) / (notes.length - 1);
      const [l, r] = panStereo(tone, () => pan);
      mixInto(L, l, start, 0.4);
      mixInto(R, r, start, 0.4);
    });
    const air = mul(svf(noise(len, 81), () => 9000, 1.5, "bp"), env(len, (t) => 0.12 * Math.sin(Math.PI * clamp01(t / 0.6))));
    mixInto(L, air);
    mixInto(R, air);
    const [wl, wr] = reverb(L.map((v, i) => (v + R[i]) / 2), { seconds: 0.3, room: 0.82 });
    return addStereo([L, R], [wl, wr], 0.5);
  },
  /** "Cha-ching": soft drawer click + two bright bell strikes + a few coin glints. */
  CASH() {
    const d = 1.7;
    const len = buf(d).length;
    const L = new Float64Array(len);
    const R = new Float64Array(len);
    const click = mul(svf(noise(len, 91), () => 2600, 1.4, "bp"), env(len, ad(0.0005, 0.006)));
    const thunk = mul(osc(len, (t) => 180 + 120 * Math.exp(-t / 0.01)), env(len, ad(0.001, 0.03)));
    mixInto(L, click, 0, 0.6);
    mixInto(R, click, 0, 0.6);
    mixInto(L, thunk, 0, 0.5);
    mixInto(R, thunk, 0, 0.5);
    const bell = (f, start, gain, pan) => {
      const n = len - Math.round(start * SR);
      const partials = [
        [1, 1, 0.3],
        [2.76, 0.42, 0.13],
        [5.4, 0.18, 0.06],
      ];
      const s = new Float64Array(n);
      for (const [ratio, g, dec] of partials) {
        mixInto(s, mul(osc(n, () => f * ratio), env(n, ad(0.002, dec))), 0, g);
      }
      const [l, r] = panStereo(s, () => pan);
      mixInto(L, l, start, gain);
      mixInto(R, r, start, gain);
    };
    bell(1568, 0.07, 0.55, -0.25);
    bell(2093, 0.16, 0.6, 0.25);
    const r = rng(93);
    for (let k = 0; k < 6; k++) {
      const start = 0.2 + r() * 0.35;
      const n = Math.round(0.08 * SR);
      const g = mul(osc(n, () => 4200 + r() * 2200), env(n, ad(0.001, 0.012)));
      const [l, rr] = panStereo(g, () => r() * 1.6 - 0.8);
      mixInto(L, l, start, 0.12);
      mixInto(R, rr, start, 0.12);
    }
    const [wl, wr] = reverb(L.map((v, i) => (v + R[i]) / 2), { seconds: 0.25, room: 0.76 });
    return addStereo([L, R], [wl, wr], 0.35);
  },
};

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, make] of Object.entries(SOUNDS)) {
  const res = finalize(make(), name);
  console.log(`${res.name.padEnd(10)} ${res.seconds.toFixed(2)}s -> ${join(OUT_DIR, name.toLowerCase() + ".wav")}`);
}
