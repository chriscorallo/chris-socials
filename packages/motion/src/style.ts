import {
  MOTION_LANGUAGES,
  MOTION_PALETTES,
  type MotionTemplate,
  type MotionTheme,
  type TimelineVisual,
} from "@chris/media/timeline";
import { AUTO_TRANSITIONS, type ConcreteTransition } from "./timing";

/**
 * PURE motion-style resolution (no React, no Remotion, no Node) — `@chris/motion/pure`.
 *
 * A visual's look = its palette (`visual.palette`: BRAND / MONO / VIVID) + the video's motion
 * theme (`EditTimeline.motionTheme`, chosen per topic by the Motion Designer or by Chris):
 * - theme `primary` / `secondary` override the palette's accent colors (BRAND and VIVID only —
 *   MONO is a deliberate "restraint" choice and stays monochrome), contrast-guarded so a
 *   theme color can never make text unreadable on the dark glass;
 * - `motionLanguage` picks a MotionFeel — the physical character of every animation (spring
 *   stiffness/damping, entrance distances, overshoot, blur, stagger, push, rotation);
 * - `iconStyle` picks the 3D material family (or 2D line icons).
 *
 * No theme (null) = the original house style exactly: BRAND colors + CRISP + GOLD_METAL, so
 * every v1 timeline renders as before. Renderer, editor preview and tests all call this one
 * function, so preview == render.
 */

export type MotionLanguage = (typeof MOTION_LANGUAGES)[number];
export type IconStyle = MotionTheme["iconStyle"];
export type PaletteName = TimelineVisual["palette"];

/** A palette as templates consume it (same keys as MOTION_PALETTES entries). */
export interface Palette {
  primary: string;
  secondary: string;
  ink: string;
  muted: string;
  glass: string;
  positive: string;
  negative: string;
}

export interface SpringConfig {
  damping: number;
  stiffness: number;
  mass: number;
}

/**
 * The physical character of motion for one motion language. Templates multiply their
 * designed values by these — they never re-time their key "hit" moments (a counter landing,
 * the peak bar), which stay where the timing engine puts them.
 */
export interface MotionFeel {
  language: MotionLanguage;
  springs: {
    /** UI settles: cards, values. */
    settle: SpringConfig;
    /** Arrivals: badges, chips, pills. */
    soft: SpringConfig;
    /** Kinetic word hits. */
    punch: SpringConfig;
    /** Bars / stacks / growth. */
    grow: SpringConfig;
    /** 3D object entrance. */
    object: SpringConfig;
  };
  /** Cubic-bezier of the main "out" ease (entrances, reveals). */
  ease: [number, number, number, number];
  /** Stagger / secondary-delay multiplier (>1 = more leisurely). */
  tempo: number;
  /** Entrance travel distance multiplier. */
  distance: number;
  /** Motion-blur / defocus multiplier on entrances. */
  blur: number;
  /** Arrival scale-hit multiplier for emphasis (kinetic emphasis words, counter landing pulse). */
  hitScale: number;
  /** Degrees of rotation accent on arrivals (playful tilt); 0 = none. */
  rotate: number;
  /** Container entrance / exit length multipliers (capped to the visual's length). */
  enterStretch: number;
  exitStretch: number;
  /** Slow push-in over the visual's life (scale gain at the end; cinematic). */
  push: number;
  /** TITLE_CARD letterbox depth multiplier. */
  letterbox: number;
  /** Letter-spacing (em) titles settle from. */
  tracking: number;
  /** Glow intensity multiplier. */
  glow: number;
  /** Radians a 3D object spins through on entrance. */
  spin: number;
}

const s = (damping: number, stiffness: number, mass: number): SpringConfig => ({ damping, stiffness, mass });

/** Tuned by measuring each spring (frames to 90 % / settle / peak at 30 fps) — see the
 * motion-themes decision doc for the table. */
export const MOTION_FEELS: Record<MotionLanguage, MotionFeel> = {
  /** Slow, elegant fades; no overshoot; small travel; long holds. */
  CALM: {
    language: "CALM",
    springs: { settle: s(200, 70, 1.2), soft: s(30, 70, 1), punch: s(24, 110, 0.8), grow: s(34, 60, 1.1), object: s(26, 48, 1.1) },
    ease: [0.22, 0.61, 0.36, 1],
    tempo: 1.3,
    distance: 0.55,
    blur: 0.5,
    hitScale: 0.55,
    rotate: 0,
    enterStretch: 1.45,
    exitStretch: 1.4,
    push: 0.012,
    letterbox: 0.9,
    tracking: 0.08,
    glow: 0.8,
    spin: 1.3,
  },
  /** The original house style: clean, fast, critically damped settles. */
  CRISP: {
    language: "CRISP",
    springs: { settle: s(200, 120, 1), soft: s(18, 140, 0.9), punch: s(14, 220, 0.6), grow: s(26, 90, 1), object: s(15, 70, 1) },
    ease: [0.16, 1, 0.3, 1],
    tempo: 1,
    distance: 1,
    blur: 1,
    hitScale: 1,
    rotate: 0,
    enterStretch: 1,
    exitStretch: 1,
    push: 0,
    letterbox: 1,
    tracking: 0.1,
    glow: 1,
    spin: 2.6,
  },
  /** Snappy, overshooting arrivals and bigger scale hits — energy and tension. */
  PUNCHY: {
    language: "PUNCHY",
    springs: { settle: s(16, 220, 0.7), soft: s(11, 240, 0.7), punch: s(9, 340, 0.5), grow: s(14, 170, 0.8), object: s(10, 130, 0.8) },
    ease: [0.2, 1.25, 0.35, 1],
    tempo: 0.75,
    distance: 1.25,
    blur: 1.15,
    hitScale: 1.6,
    rotate: 0,
    enterStretch: 0.75,
    exitStretch: 0.8,
    push: 0,
    letterbox: 1,
    tracking: 0.03,
    glow: 1.2,
    spin: 3.0,
  },
  /** Slow push, defocus-to-sharp (depth-of-field feel), wide-tracked titles, deep letterbox. */
  CINEMATIC: {
    language: "CINEMATIC",
    springs: { settle: s(200, 55, 1.4), soft: s(36, 60, 1.2), punch: s(30, 90, 1), grow: s(40, 45, 1.2), object: s(30, 40, 1.3) },
    ease: [0.45, 0, 0.1, 1],
    tempo: 1.25,
    distance: 0.7,
    blur: 1.8,
    hitScale: 0.7,
    rotate: 0,
    enterStretch: 1.5,
    exitStretch: 1.5,
    push: 0.04,
    letterbox: 1.45,
    tracking: 0.22,
    glow: 1.15,
    spin: 1.6,
  },
  /** Bouncy springs and small rotation accents — light, warm, human. */
  PLAYFUL: {
    language: "PLAYFUL",
    springs: { settle: s(11, 150, 0.8), soft: s(8, 160, 0.8), punch: s(8, 240, 0.6), grow: s(10, 120, 0.9), object: s(8, 90, 0.9) },
    ease: [0.34, 1.45, 0.64, 1],
    tempo: 0.95,
    distance: 1.1,
    blur: 0.6,
    hitScale: 1.35,
    rotate: 6,
    enterStretch: 1.1,
    exitStretch: 1,
    push: 0,
    letterbox: 0.8,
    tracking: 0.05,
    glow: 1,
    spin: 3.2,
  },
};

export const DEFAULT_FEEL: MotionFeel = MOTION_FEELS.CRISP;

/**
 * What "AUTO" enter/exit means per motion language. CRISP is the original per-template
 * table (AUTO_TRANSITIONS); the others override the templates whose default would fight the
 * language (a CALM video never SPRINGs in; a PLAYFUL one does).
 */
const LANGUAGE_AUTO: Record<MotionLanguage, Partial<Record<MotionTemplate, { enter: ConcreteTransition; exit: ConcreteTransition }>>> = {
  CRISP: {},
  CALM: {
    NUMBER_COUNTER: { enter: "FADE", exit: "FADE" },
    STAT_CARD: { enter: "FADE", exit: "FADE" },
    COMPARISON: { enter: "FADE", exit: "FADE" },
    PERCENT_RING: { enter: "FADE", exit: "FADE" },
    CALLOUT: { enter: "FADE", exit: "FADE" },
    KINETIC_TEXT: { enter: "FADE", exit: "FADE" },
    DEFINITION: { enter: "FADE", exit: "FADE" },
    TITLE_CARD: { enter: "FADE", exit: "FADE" },
    ICON_3D: { enter: "FADE", exit: "FADE" },
  },
  PUNCHY: {
    NUMBER_COUNTER: { enter: "SCALE", exit: "SCALE" },
    COMPARISON: { enter: "SPRING", exit: "SCALE" },
    KINETIC_TEXT: { enter: "FADE", exit: "SCALE" },
    LIST_STEPS: { enter: "SLIDE", exit: "SCALE" },
    BAR_CHART: { enter: "SLIDE", exit: "SCALE" },
    ICON_3D: { enter: "FADE", exit: "SCALE" },
    DEFINITION: { enter: "SCALE", exit: "SCALE" },
  },
  CINEMATIC: {
    NUMBER_COUNTER: { enter: "BLUR", exit: "BLUR" },
    STAT_CARD: { enter: "BLUR", exit: "BLUR" },
    COMPARISON: { enter: "BLUR", exit: "BLUR" },
    PERCENT_RING: { enter: "BLUR", exit: "BLUR" },
    BAR_CHART: { enter: "FADE", exit: "BLUR" },
    LINE_CHART: { enter: "FADE", exit: "BLUR" },
    LIST_STEPS: { enter: "FADE", exit: "BLUR" },
    TIMELINE: { enter: "FADE", exit: "BLUR" },
    ICON_3D: { enter: "FADE", exit: "BLUR" },
    MONEY_STACK_3D: { enter: "FADE", exit: "BLUR" },
  },
  PLAYFUL: {
    NUMBER_COUNTER: { enter: "SPRING", exit: "SCALE" },
    BAR_CHART: { enter: "SPRING", exit: "SCALE" },
    LINE_CHART: { enter: "SPRING", exit: "SCALE" },
    LIST_STEPS: { enter: "SPRING", exit: "SCALE" },
    TIMELINE: { enter: "SPRING", exit: "SCALE" },
    DEFINITION: { enter: "SPRING", exit: "SCALE" },
    KINETIC_TEXT: { enter: "FADE", exit: "SCALE" },
    ICON_3D: { enter: "FADE", exit: "SCALE" },
  },
};

/** resolveTransition, motion-language aware: explicit choices always win; AUTO follows the
 * language (CRISP = the original per-template table). */
export function resolveThemedTransition(
  template: MotionTemplate,
  which: "enter" | "exit",
  value: TimelineVisual["enter"] | undefined,
  language: MotionLanguage = "CRISP",
): ConcreteTransition {
  if (value && value !== "AUTO") return value;
  return (LANGUAGE_AUTO[language][template] ?? AUTO_TRANSITIONS[template])[which];
}

// ------------------------------------------------------------------------- color safety

function channel(hex: string, i: number): number {
  return parseInt(hex.replace("#", "").slice(i, i + 2), 16);
}

/** WCAG relative luminance of #RRGGBB. */
export function relativeLuminance(hex: string): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(channel(hex, 0)) + 0.7152 * lin(channel(hex, 2)) + 0.0722 * lin(channel(hex, 4));
}

/** WCAG contrast ratio between two #RRGGBB colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mixHex(a: string, b: string, t: number): string {
  const c = (i: number) => Math.round(channel(a, i) * (1 - t) + channel(b, i) * t).toString(16).padStart(2, "0");
  return `#${c(0)}${c(2)}${c(4)}`.toUpperCase();
}

/** The darkest surface accents are drawn on (glass card body). */
export const MOTION_SURFACE = "#12121A";
/** Accent used for text (values, emphasis words) — WCAG AA for large text and then some. */
export const MIN_PRIMARY_CONTRAST = 4.5;
/** Accent used for shapes (bars, lines, rims) — WCAG non-text contrast. */
export const MIN_SECONDARY_CONTRAST = 3;

/** Lightens `hex` toward white (smallest step that works) until it reaches `min` contrast
 * against `surface`. Hue is kept; only lightness moves. */
export function ensureContrast(hex: string, min: number, surface: string = MOTION_SURFACE): string {
  const norm = hex.toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(norm)) return norm;
  if (contrastRatio(norm, surface) >= min) return norm;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mixHex(norm, "#FFFFFF", t);
    if (contrastRatio(c, surface) >= min) return c;
  }
  return "#FFFFFF";
}

// ------------------------------------------------------------------------- resolution

export interface MotionStyle {
  palette: Palette;
  feel: MotionFeel;
  iconStyle: IconStyle;
  /** Theme name, or null for the house style. */
  themeName: string | null;
}

/**
 * The one place a visual's look is decided: palette (with theme color overrides,
 * contrast-guarded), motion feel and icon material family. Pure and deterministic.
 */
export function resolveMotionStyle(
  visual: { palette?: PaletteName | null } | null | undefined,
  theme: Partial<MotionTheme> | null | undefined,
): MotionStyle {
  const name: PaletteName = visual?.palette ?? "BRAND";
  const base: Palette = { ...(MOTION_PALETTES[name] ?? MOTION_PALETTES.BRAND) };
  const language: MotionLanguage = theme?.motionLanguage && theme.motionLanguage in MOTION_FEELS ? theme.motionLanguage : "CRISP";
  const iconStyle: IconStyle = theme?.iconStyle ?? "GOLD_METAL";
  if (theme && name !== "MONO") {
    if (theme.primary) base.primary = ensureContrast(theme.primary, MIN_PRIMARY_CONTRAST);
    if (theme.secondary) base.secondary = ensureContrast(theme.secondary, MIN_SECONDARY_CONTRAST);
  }
  return { palette: base, feel: MOTION_FEELS[language], iconStyle, themeName: theme?.name ?? null };
}
