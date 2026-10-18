import type { Look, PostSpec } from "./dsl/schema";

/**
 * Chris's signature looks. Colors come from the app's design system (apps/web/app/globals.css:
 * ink #050506, gold 400/500/600 #F3C46A/#E5A94A/#C98A2C, violet #8F76FF, cream text #F5F4F2) so
 * a mini-movie and the product feel like one brand.
 *
 * GOLD_STUDIO — "the vault at night": a warm, dark infinity studio, polished black floor, gold
 *   objects lit like product photography (soft key, hard rim), honey grade.
 * NOIR_NUMBERS — "inside the spreadsheet": a cool blue-black void, drifting glowing digits,
 *   teal haze, gold as the only warm thing in frame.
 */

export interface LightRig {
  /** Key light (directional-ish spot) — warm in GOLD_STUDIO. */
  key: { color: string; intensity: number; position: [number, number, number] };
  /** Hard back/rim light for edges. */
  rim: { color: string; intensity: number; position: [number, number, number] };
  fill: { color: string; intensity: number; position: [number, number, number] };
  /** Overhead spot (theatrical pool on the subject). */
  spot: { color: string; intensity: number; angle: number; penumbra: number };
  ambient: number;
  /** Environment (reflection) intensity. */
  env: number;
  /** Background glow behind the subject (the "studio sweep" falloff). */
  backGlow: number;
}

export interface LookDef {
  look: Look;
  background: string;
  backGlowColor: string;
  fog: string;
  floor: string;
  gold: string;
  goldLight: string;
  goldDeep: string;
  cream: string;
  muted: string;
  accent: string;
  danger: string;
  /** Default post-processing for the look. */
  post: Required<Omit<PostSpec, "letterbox">> & { letterbox: number };
  lights: Record<string, LightRig>;
}

const GOLD_STUDIO_LIGHTS: Record<string, LightRig> = {
  KEY_RIM: {
    key: { color: "#FFD9A0", intensity: 2.6, position: [-3.5, 5.5, 4.5] },
    rim: { color: "#FFE3B8", intensity: 4.2, position: [3.2, 3.8, -4.5] },
    fill: { color: "#8C7BFF", intensity: 0.35, position: [4, 1.5, 3] },
    spot: { color: "#FFE0B0", intensity: 30, angle: 0.42, penumbra: 0.75 },
    ambient: 0.06,
    env: 1.0,
    backGlow: 0.55,
  },
  TOP_SPOT: {
    key: { color: "#FFD9A0", intensity: 0.8, position: [-3, 6, 3] },
    rim: { color: "#FFE3B8", intensity: 3.2, position: [2.5, 3.5, -4] },
    fill: { color: "#6F63C8", intensity: 0.15, position: [4, 1.5, 3] },
    spot: { color: "#FFE6C2", intensity: 62, angle: 0.34, penumbra: 0.6 },
    ambient: 0.03,
    env: 0.75,
    backGlow: 0.3,
  },
  LOW_DRAMA: {
    key: { color: "#FFB866", intensity: 2.8, position: [-4.5, 1.2, 2.5] },
    rim: { color: "#FFD08A", intensity: 5.0, position: [3.5, 2.0, -3.5] },
    fill: { color: "#5A4FC0", intensity: 0.3, position: [4, 0.8, 3] },
    spot: { color: "#FFD9A6", intensity: 10, angle: 0.5, penumbra: 0.9 },
    ambient: 0.025,
    env: 0.7,
    backGlow: 0.25,
  },
  SOFT_DAWN: {
    key: { color: "#FFE7C4", intensity: 2.2, position: [-2.5, 4, 5] },
    rim: { color: "#FFF1D6", intensity: 3.0, position: [3, 4, -4] },
    fill: { color: "#C9B8FF", intensity: 0.6, position: [4, 2, 3] },
    spot: { color: "#FFF0D8", intensity: 22, angle: 0.55, penumbra: 0.9 },
    ambient: 0.12,
    env: 1.2,
    backGlow: 0.95,
  },
  BLACKOUT_SPOT: {
    key: { color: "#FFD9A0", intensity: 0.15, position: [-3, 6, 3] },
    rim: { color: "#FFE3B8", intensity: 1.2, position: [2.5, 3.5, -4] },
    fill: { color: "#000000", intensity: 0, position: [4, 1.5, 3] },
    spot: { color: "#FFE6C2", intensity: 48, angle: 0.24, penumbra: 0.5 },
    ambient: 0.01,
    env: 0.22,
    backGlow: 0.05,
  },
};

const NOIR_LIGHTS: Record<string, LightRig> = Object.fromEntries(
  Object.entries(GOLD_STUDIO_LIGHTS).map(([k, r]) => [
    k,
    {
      ...r,
      key: { ...r.key, color: "#BFD7FF", intensity: r.key.intensity * 0.8 },
      fill: { ...r.fill, color: "#2BB3A8", intensity: r.fill.intensity * 1.6 },
      backGlow: r.backGlow * 0.8,
    },
  ]),
);

export const LOOK_DEFS: Record<Look, LookDef> = {
  GOLD_STUDIO: {
    look: "GOLD_STUDIO",
    background: "#070506",
    backGlowColor: "#3A2410",
    fog: "#0A0706",
    floor: "#040303",
    gold: "#E5A94A",
    goldLight: "#F3C46A",
    goldDeep: "#C98A2C",
    cream: "#F5F1EA",
    muted: "#A7A39C",
    accent: "#8F76FF",
    danger: "#EE6B52",
    post: { bloom: 0.7, dof: true, vignette: 0.55, grain: 0.35, grade: "WARM_GOLD", exposure: 1.0, aberration: 0.25, letterbox: 0 },
    lights: GOLD_STUDIO_LIGHTS,
  },
  NOIR_NUMBERS: {
    look: "NOIR_NUMBERS",
    background: "#03060A",
    backGlowColor: "#0B2A33",
    fog: "#04080C",
    floor: "#05080B",
    gold: "#E5A94A",
    goldLight: "#F3C46A",
    goldDeep: "#C98A2C",
    cream: "#EEF3F6",
    muted: "#8FA3AE",
    accent: "#2BB3A8",
    danger: "#EE6B52",
    post: { bloom: 1.1, dof: true, vignette: 0.6, grain: 0.4, grade: "TEAL_NIGHT", exposure: 1.0, aberration: 0.3, letterbox: 0 },
    lights: NOIR_LIGHTS,
  },
};

const mixNum = (a: number, b: number, t: number) => a + (b - a) * t;
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (p: number, s: number) => (p >> s) & 255;
  const c = (s: number) => Math.round(mixNum(ch(pa, s), ch(pb, s), t));
  return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, "0")}`;
}
const mixV = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [mixNum(a[0], b[0], t), mixNum(a[1], b[1], t), mixNum(a[2], b[2], t)];

/** Numeric blend of two light rigs (lights change smoothly across a cut when asked to). */
export function mixRigs(a: LightRig, b: LightRig, t: number): LightRig {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const l = <K extends "key" | "rim" | "fill">(k: K) => ({ color: mixHex(a[k].color, b[k].color, t), intensity: mixNum(a[k].intensity, b[k].intensity, t), position: mixV(a[k].position, b[k].position, t) });
  return {
    key: l("key"),
    rim: l("rim"),
    fill: l("fill"),
    spot: { color: mixHex(a.spot.color, b.spot.color, t), intensity: mixNum(a.spot.intensity, b.spot.intensity, t), angle: mixNum(a.spot.angle, b.spot.angle, t), penumbra: mixNum(a.spot.penumbra, b.spot.penumbra, t) },
    ambient: mixNum(a.ambient, b.ambient, t),
    env: mixNum(a.env, b.env, t),
    backGlow: mixNum(a.backGlow, b.backGlow, t),
  };
}

export { mixHex };
