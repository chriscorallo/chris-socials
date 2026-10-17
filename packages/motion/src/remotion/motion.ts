import { Easing, interpolate, spring } from "remotion";
import type { ConcreteTransition } from "../timing";

/**
 * Motion vocabulary. Springs are tuned for a calm, expensive feel: critically-damped-ish
 * settles (no wobble) for UI, one soft overshoot only where it means "arrival" (SPRING).
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
 * a move, gone by the time it settles.
 */
export function enterExitStyle(
  frame: number,
  fps: number,
  durationInFrames: number,
  enter: ConcreteTransition,
  exit: ConcreteTransition,
  enterFrames: number,
  exitFrames: number,
): ContainerStyle {
  let opacity = 1;
  let ty = 0;
  let scale = 1;
  let blur = 0;

  // Entrance
  const e = prog(frame, 0, enterFrames, EASE_OUT);
  switch (enter) {
    case "FADE":
      opacity *= prog(frame, 0, enterFrames, EASE_IN_OUT);
      scale *= 1.02 - 0.02 * e;
      break;
    case "SCALE":
      opacity *= prog(frame, 0, enterFrames * 0.6, EASE_OUT);
      scale *= 0.88 + 0.12 * e;
      blur += (1 - e) * 10;
      break;
    case "SLIDE":
      opacity *= prog(frame, 0, enterFrames * 0.6, EASE_OUT);
      ty += (1 - e) * 90;
      blur += (1 - e) * 8;
      break;
    case "BLUR":
      opacity *= prog(frame, 0, enterFrames * 0.8, EASE_OUT);
      blur += (1 - e) * 28;
      scale *= 1.06 - 0.06 * e;
      break;
    case "SPRING": {
      const s = springAt(frame, fps, 0, SPRINGS.soft, enterFrames * 1.6);
      opacity *= prog(frame, 0, enterFrames * 0.45, EASE_OUT);
      scale *= 0.7 + 0.3 * s;
      blur += Math.max(0, 1 - s) * 10;
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
        blur += x * 6;
        break;
      case "SLIDE":
        opacity *= 1 - x;
        ty -= x * 70;
        blur += x * 6;
        break;
      case "BLUR":
        opacity *= 1 - x;
        blur += x * 24;
        scale *= 1 + 0.04 * x;
        break;
      case "SPRING":
        opacity *= 1 - x;
        scale *= 1 - 0.25 * x;
        break;
    }
  }
  return {
    opacity: clamp01(opacity),
    transform: `translateY(${Math.round(ty * 10) / 10}px) scale(${Math.round(scale * 10000) / 10000})`,
    filter: blurOf(blur),
  };
}

/** Count-up value with a premium ease (fast start, long soft landing). */
export function countUp(frame: number, from: number, to: number, start: number, len: number): number {
  const t = prog(frame, start, len, Easing.bezier(0.12, 0.8, 0.2, 1));
  return from + (to - from) * t;
}
