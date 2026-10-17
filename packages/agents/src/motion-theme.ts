import { classifyMotionTopic, type MotionTopic, type MotionTopicInput } from "@chris/domain";
import { MotionThemeSchema, type MotionTheme } from "@chris/media/timeline";

/**
 * Topic -> motion theme. The Motion Designer proposes a theme per video (semantic judgment);
 * this file is the deterministic side: on-brand presets per topic (used as the fallback when
 * no model is available or the model's theme is unusable, and shown to the model as the
 * suggested starting point), and a sanitizer that keeps any theme on-brand and readable.
 *
 * Accessibility: theme colors are drawn on the dark glass surface (#12121A) — primary carries
 * text (values, emphasis words) so it must reach WCAG 4.5:1; secondary carries shapes (bars,
 * lines, rims) so it must reach 3:1. Too-dark colors are lightened (hue kept), never rejected.
 * The same guard runs again at render time (packages/motion resolveMotionStyle), so a color
 * Chris picks in the editor is protected too.
 */

export interface MotionThemePreset extends MotionTheme {
  topic: MotionTopic;
}

const preset = (topic: MotionTopic, t: Omit<MotionTheme, "rationale"> & { rationale: string }): MotionThemePreset => ({ topic, ...t });

/** On-brand presets: brand gold stays the anchor accent; the secondary carries the topic mood. */
export const MOTION_THEME_PRESETS: Record<MotionTopic, MotionThemePreset> = {
  DEBT: preset("DEBT", {
    name: "Debt pressure",
    motionLanguage: "PUNCHY",
    primary: "#FFB547",
    secondary: "#F0505F",
    iconStyle: "GOLD_METAL",
    rationale: "Debt is tension: amber-to-red warmth and snappy, hard-landing motion make the numbers feel urgent.",
  }),
  CREDIT: preset("CREDIT", {
    name: "Credit discipline",
    motionLanguage: "CRISP",
    primary: "#FFC857",
    secondary: "#E5484D",
    iconStyle: "GOLD_METAL",
    rationale: "Credit rewards precision: clean, fast settles with a red caution accent.",
  }),
  INVESTING: preset("INVESTING", {
    name: "Compounding growth",
    motionLanguage: "CINEMATIC",
    primary: "#F2C14E",
    secondary: "#2FBF8F",
    iconStyle: "GLASS",
    rationale: "Investing is patience: emerald growth with gold, slow cinematic pushes and glass objects.",
  }),
  SAVING: preset("SAVING", {
    name: "Steady growth",
    motionLanguage: "CALM",
    primary: "#FFD54A",
    secondary: "#34C796",
    iconStyle: "GOLD_METAL",
    rationale: "Saving is calm consistency: gentle fades and a reassuring green.",
  }),
  CAREER: preset("CAREER", {
    name: "Confident career",
    motionLanguage: "CRISP",
    primary: "#FFD54A",
    secondary: "#5B9DFF",
    iconStyle: "GOLD_METAL",
    rationale: "Career and business read as confident and professional: gold on a clear blue, crisp motion.",
  }),
  LIFESTYLE: preset("LIFESTYLE", {
    name: "Golden hour",
    motionLanguage: "PLAYFUL",
    primary: "#FFA567",
    secondary: "#F27BB0",
    iconStyle: "SOFT_CLAY",
    rationale: "Lifestyle/LA is warm and human: sunset tones, bouncy motion and soft clay objects.",
  }),
  MINDSET: preset("MINDSET", {
    name: "Clear thinking",
    motionLanguage: "CALM",
    primary: "#FFD54A",
    secondary: "#A78BFA",
    iconStyle: "LINE",
    rationale: "Mindset is ideas, not objects: calm motion and clean line icons keep the focus on the thought.",
  }),
  GENERAL: preset("GENERAL", {
    name: "Signature",
    motionLanguage: "CRISP",
    primary: null,
    secondary: null,
    iconStyle: "GOLD_METAL",
    rationale: "No clear topic: Chris's house style.",
  }),
};

// ------------------------------------------------------------------------- color safety

const SURFACE = "#12121A";
export const THEME_MIN_PRIMARY_CONTRAST = 4.5;
export const THEME_MIN_SECONDARY_CONTRAST = 3;

function lum(hex: string): number {
  const c = (i: number) => {
    const v = parseInt(hex.slice(1 + i, 3 + i), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * c(0) + 0.7152 * c(2) + 0.0722 * c(4);
}

export function themeContrast(a: string, b: string = SURFACE): number {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function lighten(hex: string, t: number): string {
  const c = (i: number) => Math.round(parseInt(hex.slice(1 + i, 3 + i), 16) * (1 - t) + 255 * t).toString(16).padStart(2, "0");
  return `#${c(0)}${c(2)}${c(4)}`.toUpperCase();
}

/** Lightens (hue kept) until the color reaches `min` contrast on the dark glass surface. */
export function ensureThemeContrast(hex: string, min: number): string {
  const h = hex.toUpperCase();
  if (themeContrast(h) >= min) return h;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = lighten(h, t);
    if (themeContrast(c) >= min) return c;
  }
  return "#FFFFFF";
}

function saturation(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return 0;
  return (max - min) / (1 - Math.abs(2 * l - 1));
}

/**
 * Makes any proposed theme safe to render: schema-valid, colors readable on the glass,
 * gray/near-white "accents" dropped (they'd erase the accent hierarchy — the palette's own
 * color is used instead), and a primary identical to the secondary separated.
 * Returns the cleaned theme plus notes on what changed (shown in warnings).
 */
export function sanitizeMotionTheme(input: unknown): { theme: MotionTheme; notes: string[] } | null {
  const parsed = MotionThemeSchema.safeParse(input);
  if (!parsed.success) return null;
  const t = { ...parsed.data };
  const notes: string[] = [];
  const fix = (key: "primary" | "secondary", min: number) => {
    const v = t[key];
    if (!v) return;
    const up = v.toUpperCase();
    if (saturation(up) < 0.25 || themeContrast(up, "#FFFFFF") < 1.15) {
      notes.push(`theme ${key} ${v} dropped (not an accent color)`);
      t[key] = null;
      return;
    }
    const safe = ensureThemeContrast(up, min);
    if (safe !== up) notes.push(`theme ${key} ${v} lightened to ${safe} for contrast`);
    t[key] = safe;
  };
  fix("primary", THEME_MIN_PRIMARY_CONTRAST);
  fix("secondary", THEME_MIN_SECONDARY_CONTRAST);
  if (t.primary && t.secondary && t.primary === t.secondary) {
    t.secondary = null;
    notes.push("theme secondary equal to primary dropped");
  }
  t.name = t.name.trim().slice(0, 40) || "Custom";
  if (t.rationale) t.rationale = t.rationale.slice(0, 200);
  return { theme: t, notes };
}

/** Deterministic theme for a video (no model): topic classification -> preset. */
export function fallbackMotionTheme(input: MotionTopicInput): { theme: MotionTheme; topic: MotionTopic } {
  const { topic } = classifyMotionTopic(input);
  const { topic: _t, ...theme } = MOTION_THEME_PRESETS[topic];
  void _t;
  return { theme: { ...theme }, topic };
}

