import type { MotionTemplate } from "./motion-contract";

/**
 * Nominal on-screen footprint of every motion template at `placement.scale = 1` on a
 * 1080x1920 canvas (px; scales with canvas width like every other Timeline size). PURE.
 *
 * These are the boxes the placement engine keeps clear of Chris, captions, text and platform
 * chrome — the motion templates (packages/motion) must draw INSIDE them (glow/shadow may
 * bleed a little; the engine's margins absorb that). If a template's design grows, change
 * the number here and placement follows, in the editor and the render alike.
 *
 * `kind`:
 * - BOX         an ordinary panel the engine positions freely;
 * - FULL_FRAME  covers the whole frame by design (TITLE_CARD dims/blurs the background) —
 *               always centred, allowed to overlap the subject;
 * - CALLOUT     a label + arrow: the label box is placed near `props.pointTo`, never on the face.
 */
export interface TemplateFootprint {
  width: number;
  height: number;
  kind: "BOX" | "FULL_FRAME" | "CALLOUT";
  /** Preferred vertical centre (canvas fraction) when several spots are equally free. */
  preferY: number;
}

export const TEMPLATE_FOOTPRINTS: Record<MotionTemplate, TemplateFootprint> = {
  KINETIC_TEXT: { width: 900, height: 320, kind: "BOX", preferY: 0.42 },
  NUMBER_COUNTER: { width: 760, height: 300, kind: "BOX", preferY: 0.3 },
  STAT_CARD: { width: 700, height: 380, kind: "BOX", preferY: 0.32 },
  BAR_CHART: { width: 900, height: 760, kind: "BOX", preferY: 0.4 },
  LINE_CHART: { width: 900, height: 640, kind: "BOX", preferY: 0.38 },
  COMPARISON: { width: 940, height: 520, kind: "BOX", preferY: 0.36 },
  PERCENT_RING: { width: 520, height: 560, kind: "BOX", preferY: 0.34 },
  LIST_STEPS: { width: 860, height: 620, kind: "BOX", preferY: 0.4 },
  ICON_3D: { width: 520, height: 520, kind: "BOX", preferY: 0.32 },
  MONEY_STACK_3D: { width: 600, height: 600, kind: "BOX", preferY: 0.36 },
  CALLOUT: { width: 520, height: 200, kind: "CALLOUT", preferY: 0.4 },
  TIMELINE: { width: 940, height: 420, kind: "BOX", preferY: 0.36 },
  DEFINITION: { width: 880, height: 420, kind: "BOX", preferY: 0.34 },
  TITLE_CARD: { width: 1080, height: 1920, kind: "FULL_FRAME", preferY: 0.5 },
};

/** The engine never shrinks an AUTO visual below this fraction of its requested scale. */
export const MIN_AUTO_SCALE_FACTOR = 0.7;

/** Footprint in canvas px at a given scale. */
export function footprintPx(
  template: MotionTemplate,
  scale: number,
  canvas: { width: number; height: number },
): { width: number; height: number } {
  const fp = TEMPLATE_FOOTPRINTS[template];
  if (fp.kind === "FULL_FRAME") return { width: canvas.width, height: canvas.height };
  const k = canvas.width / 1080;
  return { width: Math.round(fp.width * scale * k), height: Math.round(fp.height * scale * k) };
}
