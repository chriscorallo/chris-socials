import {
  MOTION_TEMPLATES,
  MotionPropsSchemas,
  TEMPLATE_FOOTPRINTS,
  TimelineVisualSchema,
  type MotionProps,
  type MotionTemplate,
  type TimelineVisual,
  type VisualInteraction,
} from "@chris/media/timeline";

/**
 * PURE timing / placement / parsing math for motion visuals — no React, no Remotion, no Node.
 * Shared by the Remotion compositions (render), the browser preview (`@chris/motion/player`)
 * and the worker, so all three agree on when and where every visual is.
 */

export type ConcreteTransition = "FADE" | "SCALE" | "SLIDE" | "BLUR" | "SPRING";

/** What "AUTO" means per template — chosen for how each graphic reads, not at random. */
export const AUTO_TRANSITIONS: Record<MotionTemplate, { enter: ConcreteTransition; exit: ConcreteTransition }> = {
  KINETIC_TEXT: { enter: "BLUR", exit: "BLUR" },
  NUMBER_COUNTER: { enter: "SCALE", exit: "BLUR" },
  STAT_CARD: { enter: "SPRING", exit: "SCALE" },
  BAR_CHART: { enter: "SLIDE", exit: "FADE" },
  LINE_CHART: { enter: "SLIDE", exit: "FADE" },
  COMPARISON: { enter: "SCALE", exit: "SCALE" },
  PERCENT_RING: { enter: "SPRING", exit: "SCALE" },
  LIST_STEPS: { enter: "SLIDE", exit: "FADE" },
  ICON_3D: { enter: "FADE", exit: "SCALE" },
  MONEY_STACK_3D: { enter: "FADE", exit: "FADE" },
  CALLOUT: { enter: "SPRING", exit: "FADE" },
  TIMELINE: { enter: "SLIDE", exit: "FADE" },
  DEFINITION: { enter: "BLUR", exit: "BLUR" },
  TITLE_CARD: { enter: "FADE", exit: "BLUR" },
};

export function resolveTransition(
  template: MotionTemplate,
  which: "enter" | "exit",
  value: TimelineVisual["enter"] | undefined,
): ConcreteTransition {
  if (!value || value === "AUTO") return AUTO_TRANSITIONS[template][which];
  return value;
}

/** Designed entrance / exit lengths (seconds) before clamping to the visual's duration. */
export const ENTER_SECONDS = 0.7;
export const EXIT_SECONDS = 0.45;

export interface VisualFrameWindow {
  /** First output frame the visual is on screen. */
  from: number;
  durationInFrames: number;
  enterFrames: number;
  exitFrames: number;
}

/**
 * Frame window of a visual at `fps`: from = round(start*fps), duration = round(end*fps) - from
 * (same rounding as the renderer's clip frame counts, so the overlay never drifts). Entrance
 * and exit each get at most 40% of the visual's length, so a short visual still holds.
 */
export function visualFrameWindow(v: Pick<TimelineVisual, "start" | "end">, fps: number): VisualFrameWindow {
  const from = Math.max(0, Math.round(v.start * fps));
  const durationInFrames = Math.max(1, Math.round(v.end * fps) - from);
  const cap = Math.max(1, Math.floor(durationInFrames * 0.4));
  return {
    from,
    durationInFrames,
    enterFrames: Math.max(1, Math.min(cap, Math.round(ENTER_SECONDS * fps))),
    exitFrames: Math.max(1, Math.min(cap, Math.round(EXIT_SECONDS * fps))),
  };
}

/** Is the visual on screen at output time t (seconds)? Half-open [start, end). */
export function isVisualActive(v: Pick<TimelineVisual, "start" | "end">, t: number): boolean {
  return t >= v.start && t < v.end;
}

export type ParsedVisual = {
  [T in MotionTemplate]: { visual: TimelineVisual; template: T; props: MotionProps<T> };
}[MotionTemplate];

export type VisualParseResult = { ok: true; value: ParsedVisual } | { ok: false; id: string; error: string };

/** Validates the visual and its template props (defaults applied). Never throws. */
export function parseVisual(input: unknown): VisualParseResult {
  const v = TimelineVisualSchema.safeParse(input);
  const id = (input as { id?: unknown } | null)?.id;
  if (!v.success) {
    return { ok: false, id: typeof id === "string" ? id : "?", error: v.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const p = MotionPropsSchemas[v.data.template].safeParse(v.data.props);
  if (!p.success) {
    return {
      ok: false,
      id: v.data.id,
      error: `${v.data.template} props: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    };
  }
  if (!(v.data.end > v.data.start)) return { ok: false, id: v.data.id, error: "end must be after start" };
  return { ok: true, value: { visual: v.data, template: v.data.template, props: p.data } as ParsedVisual };
}

/** Parses every visual; invalid ones are reported, never silently rendered wrong. */
export function parseVisuals(visuals: unknown[]): { parsed: ParsedVisual[]; errors: Array<{ id: string; error: string }> } {
  const parsed: ParsedVisual[] = [];
  const errors: Array<{ id: string; error: string }> = [];
  for (const v of visuals) {
    const r = parseVisual(v);
    if (r.ok) parsed.push(r.value);
    else errors.push({ id: r.id, error: r.error });
  }
  return { parsed, errors };
}

/**
 * Designed box (px at a 1080-wide canvas, scale 1) each template is laid out in — exactly the
 * placement engine's TEMPLATE_FOOTPRINTS (packages/media/src/visual-footprints.ts), so the
 * box the engine keeps clear of Chris/captions/UI is the box the template draws in.
 * `placement.x/y` is its CENTER. TITLE_CARD is full-frame and ignores placement.
 */
export const TEMPLATE_DESIGN_SIZE: Record<MotionTemplate, { width: number; height: number }> = Object.fromEntries(
  MOTION_TEMPLATES.map((t) => [t, { width: TEMPLATE_FOOTPRINTS[t].width, height: TEMPLATE_FOOTPRINTS[t].height }]),
) as Record<MotionTemplate, { width: number; height: number }>;

/** Safe margin (px at unit scale) a placed box is kept inside. */
export const PLACEMENT_MARGIN = 36;

export interface PlacementBox {
  /** Canvas px of the box's top-left (after clamping) and its scaled size. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Total CSS scale applied to the designed box: unit * placement.scale (maybe reduced to fit). */
  scale: number;
  /** Center actually used (px) — differs from the requested one only when clamped. */
  cx: number;
  cy: number;
  clamped: boolean;
}

/** Canvas unit: templates are designed at 1080 px canvas WIDTH (same rule as footprintPx). */
export function canvasUnit(canvas: { width: number; height: number }): number {
  return canvas.width / 1080;
}

/**
 * Where a visual's designed box lands on the canvas. Respects placement exactly unless the box
 * would leave the canvas — then it's shrunk to fit (if larger than the canvas) and nudged
 * inside the safe margin, and `clamped` says so. Full-frame templates fill the canvas.
 */
export function placementBox(
  template: MotionTemplate,
  placement: Pick<TimelineVisual["placement"], "x" | "y" | "scale">,
  canvas: { width: number; height: number },
): PlacementBox {
  const unit = canvasUnit(canvas);
  if (template === "TITLE_CARD") {
    return { left: 0, top: 0, width: canvas.width, height: canvas.height, scale: 1, cx: canvas.width / 2, cy: canvas.height / 2, clamped: false };
  }
  const d = TEMPLATE_DESIGN_SIZE[template];
  const margin = PLACEMENT_MARGIN * unit;
  let scale = unit * placement.scale;
  const fit = Math.min((canvas.width - 2 * margin) / d.width, (canvas.height - 2 * margin) / d.height);
  let clamped = false;
  if (scale > fit) {
    scale = fit;
    clamped = true;
  }
  const w = d.width * scale;
  const h = d.height * scale;
  const reqX = placement.x * canvas.width;
  const reqY = placement.y * canvas.height;
  const cx = Math.min(canvas.width - margin - w / 2, Math.max(margin + w / 2, reqX));
  const cy = Math.min(canvas.height - margin - h / 2, Math.max(margin + h / 2, reqY));
  if (Math.abs(cx - reqX) > 0.5 || Math.abs(cy - reqY) > 0.5) clamped = true;
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h, scale, cx, cy, clamped };
}

/** MONEY_STACK_3D: how many bill stacks represent an amount — log scale, 1 (<= ~$100) .. 9 (>= ~$5M). */
export function stackCountFor(amount: number): number {
  return Math.max(1, Math.min(9, Math.round(Math.log10(Math.max(1, amount)) * 1.6 - 2)));
}

export { MOTION_TEMPLATES };

/** A visual's tracked centre/scale at a local frame (Motion v2 follow/camera), or null when static. */
export function trackAt(ix: Pick<VisualInteraction, "track"> | null | undefined, frame: number): { x: number; y: number; s: number } | null {
  const tr = ix?.track;
  if (!tr || tr.x.length === 0) return null;
  const i = Math.max(0, Math.min(tr.x.length - 1, Math.round(frame)));
  return { x: tr.x[i]!, y: tr.y[i]!, s: tr.s[i] ?? 1 };
}
