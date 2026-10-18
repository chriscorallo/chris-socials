import type { Ease } from "./dsl/schema";

/**
 * Cinematic easing + seeded noise. Pure. A camera never moves linearly: CINEMATIC starts like a
 * dolly grip leaning into the move (slow, motivated), travels, and settles long — the
 * "expensive" feel of a crane/dolly with a heavy head.
 */

/** Cubic bezier (CSS semantics) solved by Newton + bisection. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return sampleY(t);
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

const CINEMATIC = cubicBezier(0.45, 0.02, 0.16, 1);
const IN_OUT = cubicBezier(0.65, 0, 0.35, 1);
const OUT = cubicBezier(0.16, 1, 0.3, 1);
const IN = cubicBezier(0.55, 0, 0.9, 0.4);
const SNAP = cubicBezier(0.85, 0, 0.1, 1);

/** Critically-damped-ish spring with a small overshoot, normalized to settle by t=1. */
function spring(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const w = 9.5;
  const z = 0.62;
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}

export function ease(kind: Ease | undefined, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  switch (kind ?? "CINEMATIC") {
    case "CINEMATIC":
      return CINEMATIC(x);
    case "EASE_IN_OUT":
      return IN_OUT(x);
    case "EASE_OUT":
      return OUT(x);
    case "EASE_IN":
      return IN(x);
    case "LINEAR":
      return x;
    case "SNAP":
      return SNAP(x);
    case "SPRING":
      return spring(x);
  }
}

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a || 1e-9));
  return t * t * (3 - 2 * t);
};

/** mulberry32 — tiny seedable PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Smooth 1-D noise in [-1, 1] — a sum of three incommensurate sines with seeded phases.
 * Deterministic in (seed, channel, t); used for camera breathing and floating objects.
 */
export function smoothNoise(seed: number, channel: number, t: number): number {
  const r = rng(seed * 7919 + channel * 104729);
  const p1 = r() * Math.PI * 2;
  const p2 = r() * Math.PI * 2;
  const p3 = r() * Math.PI * 2;
  return (Math.sin(t * 0.31 * Math.PI * 2 + p1) * 0.55 + Math.sin(t * 0.17 * Math.PI * 2 + p2) * 0.3 + Math.sin(t * 0.73 * Math.PI * 2 + p3) * 0.15) / 1.0;
}
