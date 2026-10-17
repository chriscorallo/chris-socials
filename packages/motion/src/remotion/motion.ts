import { Easing, interpolate, spring } from "remotion";
import type { ConcreteTransition } from "../timing";
import { DEFAULT_FEEL, type MotionFeel } from "../style";

/**
 * Motion vocabulary. Springs are tuned for a calm, expensive feel: critically-damped-ish
 * settles (no wobble) for UI, one soft overshoot only where it means "arrival" (SPRING).
 * These are the CRISP (house) values; a video's motion language swaps them via
 * `MotionFeel.springs` (src/style.ts).
 */
export const SPRINGS = {
  /** Smooth premium settle — cards, charts. */
  settle: { damping: 200, stiffness: 120, mass: 1 },
  /** Gentle arrival with a whisper of overshoot. */
  soft: { damping: 18, stiffness: 140, mass: 0.9 },
  /** Snappy word hits (kinetic type). */
  punch: { damping: 14, stiffness: 220, mass: 0.6 },
  /** Bars / stacks growing. */
  grow: { damping: 26, stiffness: 90, mass: 1 },
} as const;

export const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1); // expo-like out
export const EASE_IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);
export const EASE_IN = Easing.bezier(0.5, 0, 0.75, 0);

const easeCache = new Map<string, (t: number) => number>();
/** The motion language's main out-ease (memoised bezier). */
export function feelEase(feel: MotionFeel | undefined): (t: number) => number {
  const f = feel ?? DEFAULT_FEEL;
  const key = f.ease.join(",");
  let e = easeCache.get(key);
  if (!e) {
    e = Easing.bezier(f.ease[0], f.ease[1], f.ease[2], f.ease[3]);
    easeCache.set(key, e);
  }
  return e;
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** 0..1 progress over [start, start+len) frames with an easing. */
export function prog(frame: number, start: number, len: number, ease: (t: number) => number = EASE_OUT): number {
  return interpolate(frame, [start, start + Math.max(1, len)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
}

export function springAt(frame: number, fps: number, delay: number, config: { damping: number; stiffness: number; mass: number }, durationInFrames?: number): number {
  return spring({ frame: frame - delay, fps, config, durationInFrames });
}

export interface ContainerStyle {
  opacity: number;
  transform: string;
  filter: string;
}

function blurOf(px: number): string {
  return px > 0.05 ? `blur(${Math.round(px * 10) / 10}px)` : "none";
}

/**
 * Container style for the entrance (frame in [0, enterFrames)) and exit (last exitFrames).
 * The motion-blur feel comes from a short blur that tracks velocity: strongest at the start of
 * a move, gone by the time it settles. `feel` (the video's motion language) scales travel,
 * blur, overshoot, rotation accents, entrance/exit length and adds the cinematic push; the
 * default (CRISP) reproduces the original house motion exactly.
 */
export function enterExitStyle(
  frame: number,
  fps: number,
  durationInFrames: number,
  enter: ConcreteTransition,
  exit: ConcreteTransition,
  enterFramesIn: number,
  exitFramesIn: number,
  feel: MotionFeel = DEFAULT_FEEL,
): ContainerStyle {
  let opacity = 1;
  let ty = 0;
  let scale = 1;
  let blur = 0;
  let rot = 0;
  // The language stretches/compresses entrance and exit, never past 45% of the visual (a short
  // graphic must still hold) — and never below what the timing engine already gave it.
  const cap = Math.max(1, Math.floor(durationInFrames * 0.45));
  const stretch = (n: number, k: number) => (k === 1 ? n : Math.max(1, Math.min(Math.max(cap, n), Math.round(n * k))));
  const enterFrames = stretch(enterFramesIn, feel.enterStretch);
  const exitFrames = stretch(exitFramesIn, feel.exitStretch);
  const D = feel.distance;
  const B = feel.blur;
  const EO = feel.language === "CRISP" ? EASE_OUT : feelEase(feel);
  const over = Math.max(0, feel.hitScale - 1);

  // Entrance
  const e = prog(frame, 0, enterFrames, EO);
  const e1 = Math.min(1, e);
  switch (enter) {
    case "FADE":
      opacity *= prog(frame, 0, enterFrames, EASE_IN_OUT);
      scale *= 1.02 - 0.02 * e1;
      // Cinematic: defocus -> sharp, like a rack focus.
      if (B > 1.2) blur += (1 - e1) * 7 * B;
      break;
    case "SCALE": {
      opacity *= prog(frame, 0, enterFrames * 0.6, EASE_OUT);
      // Overshooting languages hit with a spring (bigger start, rebound); calm ones ease.
      const k = over > 0 ? springAt(frame, fps, 0, feel.springs.soft, Math.round(enterFrames * 1.6)) : e;
      scale *= 0.88 - 0.08 * over + (0.12 + 0.08 * over) * k;
      blur += Math.max(0, 1 - k) * 10 * B;
      rot += (1 - Math.min(1, k)) * -feel.rotate;
      break;
    }
    case "SLIDE":
      opacity *= prog(frame, 0, enterFrames * 0.6, EASE_OUT);
      ty += (1 - e) * 90 * D;
      blur += Math.max(0, 1 - e) * 8 * B;
      rot += (1 - e1) * feel.rotate * 0.5;
      break;
    case "BLUR":
      opacity *= prog(frame, 0, enterFrames * 0.8, EASE_OUT);
      blur += Math.max(0, 1 - e) * 28 * B;
      scale *= 1.06 - 0.06 * e;
      break;
    case "SPRING": {
      const sp = feel.language === "CRISP" ? springAt(frame, fps, 0, SPRINGS.soft, enterFrames * 1.6) : springAt(frame, fps, 0, feel.springs.soft, Math.round(enterFrames * 1.6));
      opacity *= prog(frame, 0, enterFrames * 0.45, EASE_OUT);
      scale *= 0.7 + 0.3 * sp;
      blur += Math.max(0, 1 - sp) * 10 * B;
      rot += (1 - sp) * -feel.rotate * 1.3;
      break;
    }
  }

  // Exit
  const xStart = durationInFrames - exitFrames;
  if (frame >= xStart) {
    const x = prog(frame, xStart, exitFrames, EASE_IN);
    switch (exit) {
      case "FADE":
        opacity *= 1 - x;
        break;
      case "SCALE":
        opacity *= 1 - x;
        scale *= 1 - 0.08 * x;
        blur += x * 6 * B;
        break;
      case "SLIDE":
        opacity *= 1 - x;
        ty -= x * 70 * D;
        blur += x * 6 * B;
        break;
      case "BLUR":
        opacity *= 1 - x;
        blur += x * 24 * B;
        scale *= 1 + 0.04 * x;
        break;
      case "SPRING":
        opacity *= 1 - x;
        scale *= 1 - 0.25 * x;
        break;
    }
  }
  // Cinematic push: a slow, constant scale gain over the visual's whole life.
  if (feel.push > 0) scale *= 1 + feel.push * clamp01(frame / Math.max(1, durationInFrames));
  const rotPart = Math.abs(rot) > 0.01 ? ` rotate(${Math.round(rot * 100) / 100}deg)` : "";
  return {
    opacity: clamp01(opacity),
    transform: `translateY(${Math.round(ty * 10) / 10}px) scale(${Math.round(scale * 10000) / 10000})${rotPart}`,
    filter: blurOf(blur),
  };
}

/** Count-up value with a premium ease (fast start, long soft landing). */
export function countUp(frame: number, from: number, to: number, start: number, len: number): number {
  const t = prog(frame, start, len, Easing.bezier(0.12, 0.8, 0.2, 1));
  return from + (to - from) * t;
}
