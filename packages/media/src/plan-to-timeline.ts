import { getSafeArea, rectsIntersect, type Rect } from "./safe-zones";
import { EditTimelineSchema, type EditTimeline, type TimelineCaptions, type TimelineText } from "./timeline";
import { layoutTimelineText, LAYOUT, type MeasureText } from "./timeline-layout";
import { nodeMeasureText } from "./timeline-render";

/**
 * Deterministic EditPlan -> EditTimeline converter. The Edit Planner (AI) keeps emitting its
 * EditPlanOutput; this expresses it as an explicit Timeline whose visual values reproduce the
 * current style presets (fonts, sizes, colours, plates, positions), so a plain AI plan and a
 * finishing-edit Timeline render through one engine. If a plan row already carries
 * `plan.timeline` (a finishing edit), callers use that instead.
 *
 * Structural input type (packages/media does not depend on packages/agents).
 */
export interface PlanLike {
  segments: Array<{ startSeconds: number; endSeconds: number }>;
  targetDimensions: { width: number; height: number } | null;
  textOverlays: Array<{
    text: string;
    startSeconds: number;
    endSeconds: number;
    position: "TOP" | "CENTER" | "BOTTOM";
    style: "HEADLINE" | "CAPTION" | "NUMBER_CALLOUT" | "LOWER_THIRD";
  }>;
  captions?: { enabled: boolean; style: "CLEAN" | "BOLD_HIGHLIGHT"; position: "LOWER" | "CENTER" } | null;
  punchIns?: Array<{ startSeconds: number; endSeconds: number; zoom: number; focus?: "CENTER" | "UPPER_THIRD" }>;
  normalizeAudio: boolean;
}

export interface PlanToTimelineContext {
  /** The selected take every segment comes from. */
  mediaAssetId: string;
  /** Whether that take has word timings (captions are disabled without them). */
  sourceWordsAvailable: boolean;
  /** Defaults to plan.targetDimensions, then 1080x1920. */
  canvas?: { width: number; height: number };
  /** Glyph measurement (defaults to the server's opentype measure). */
  measureText?: MeasureText;
}

/** Today's overlay presets as explicit Timeline text values (px at 1080 wide). */
export const PLAN_TEXT_PRESETS = {
  HEADLINE: { fontId: "inter-display-bold", maxSize: 78, minSize: 50, maxLines: 3, color: "#FFFFFF", backgroundColor: "#00000094", strokeColor: null, align: "center", maxWidth: 0.74 },
  CAPTION: { fontId: "inter-semibold", maxSize: 54, minSize: 40, maxLines: 3, color: "#FFFFFF", backgroundColor: "#0000007A", strokeColor: null, align: "center", maxWidth: 0.74 },
  NUMBER_CALLOUT: { fontId: "inter-display-extrabold", maxSize: 170, minSize: 92, maxLines: 2, color: "#FFD84D", backgroundColor: null, strokeColor: "#00000099", align: "center", maxWidth: 0.74 },
  LOWER_THIRD: { fontId: "inter-semibold", maxSize: 46, minSize: 36, maxLines: 2, color: "#FFFFFF", backgroundColor: "#0000009E", strokeColor: null, align: "left", maxWidth: 0.668 },
} as const;

/**
 * Today's caption presets as explicit Timeline caption values. BOLD_HIGHLIGHT was 72 px until
 * 2026-10-17: a 3-word chunk at 72 px is up to ~740 px wide, which reaches TikTok's action rail
 * (x ≥ 860 at 1080 wide, platform-ui.ts); 64 px keeps typical chunks clear
 * (docs/decisions-pending/editor-smoothness-fullscreen-platform-ui.md).
 */
export const PLAN_CAPTION_PRESETS = {
  CLEAN: { preset: "CLEAN", fontId: "inter-display-bold", fontSize: 62, color: "#FFFFFF", highlightColor: "#FFD84D", strokeColor: "#000000BF", backgroundColor: null },
  BOLD_HIGHLIGHT: { preset: "BOLD_HIGHLIGHT", fontId: "inter-display-extrabold", fontSize: 64, color: "#FFFFFF", highlightColor: "#FFD84D", strokeColor: "#000000EF", backgroundColor: null },
} as const;

function r4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function planToTimeline(plan: PlanLike, ctx: PlanToTimelineContext): EditTimeline {
  const canvas = ctx.canvas ?? plan.targetDimensions ?? { width: 1080, height: 1920 };
  const measure = ctx.measureText ?? nodeMeasureText;
  const W = canvas.width;
  const H = canvas.height;
  const k = W / 1080;
  const safe = getSafeArea(W, H);

  const clips = plan.segments.map((s, i) => ({
    id: `clip-${i + 1}`,
    mediaAssetId: ctx.mediaAssetId,
    sourceStart: s.startSeconds,
    sourceEnd: s.endSeconds,
    crop: { zoom: 1, panX: 0, panY: 0 },
    volume: 1,
  }));

  const texts: TimelineText[] = plan.textOverlays
    .filter((o) => o.text.trim().length > 0 && o.endSeconds > o.startSeconds)
    .map((o, i) => {
      const p = PLAN_TEXT_PRESETS[o.style];
      const base: TimelineText = {
        id: `text-${i + 1}`,
        text: o.text,
        start: o.startSeconds,
        end: o.endSeconds,
        preset: o.style,
        fontId: p.fontId,
        fontSize: p.maxSize,
        color: p.color,
        backgroundColor: p.backgroundColor,
        strokeColor: p.strokeColor,
        align: p.align,
        x: 0.5,
        y: 0.5,
        maxWidth: p.maxWidth,
        uppercase: false,
      };
      // Largest size in [min, max] that fits in maxLines (the old auto-fit), then fixed.
      let size: number = p.maxSize;
      let layout = layoutTimelineText({ ...base, fontSize: size }, canvas, measure);
      while (layout.lines.length > p.maxLines && size > p.minSize) {
        size = Math.max(p.minSize, Math.floor(size * 0.94));
        layout = layoutTimelineText({ ...base, fontSize: size }, canvas, measure);
      }
      const blockH = layout.rect.height;
      const blockW = layout.rect.width;
      let top: number;
      if (o.position === "TOP") top = safe.top + Math.round(40 * k);
      else if (o.position === "CENTER") top = Math.round((safe.top + safe.bottom) / 2 - blockH / 2);
      else top = safe.bottom - Math.round(20 * k) - blockH;
      top = Math.max(safe.top, Math.min(top, safe.bottom - blockH));
      const x = p.align === "left" ? (safe.left + blockW / 2) / W : 0.5;
      return { ...base, fontSize: size, x: r4(x), y: r4((top + blockH / 2) / H) };
    });

  const capCfg = plan.captions ?? { enabled: true, style: "CLEAN" as const, position: "LOWER" as const };
  const cp = PLAN_CAPTION_PRESETS[capCfg.style];
  const capLine = Math.round(cp.fontSize * k * LAYOUT.captions.lineHeight);
  const bandCenter = (position: "LOWER" | "CENTER") =>
    position === "LOWER"
      ? safe.bottom - Math.round(40 * k) - capLine / 2
      : Math.round(safe.top + (safe.bottom - safe.top) * 0.72) - capLine / 2;
  // Captions have one y for the whole video: pick the default band unless a text sits in
  // it, then the other band, then just above the colliding text. (The old renderer moved
  // individual phrases; a Timeline is explicit, and the quality gate flags any residual.)
  const textRects = texts.map((t) => layoutTimelineText(t, canvas, measure).rect);
  const bandRect = (center: number): Rect => ({
    x: Math.round(W * (1 - LAYOUT.captions.maxWidth) / 2),
    y: Math.round(center - capLine / 2 - 16 * k),
    width: Math.round(W * LAYOUT.captions.maxWidth),
    height: Math.round(capLine + 32 * k),
  });
  const free = (center: number) => {
    const r = bandRect(center);
    return r.y >= safe.top && r.y + r.height <= safe.bottom && textRects.every((t) => !rectsIntersect(r, t));
  };
  const defaultCenter = bandCenter(capCfg.position);
  let center = defaultCenter;
  if (!free(center)) {
    const other = bandCenter(capCfg.position === "LOWER" ? "CENTER" : "LOWER");
    const hits = textRects.filter((t) => rectsIntersect(bandRect(defaultCenter), t));
    const above = Math.min(...hits.map((t) => t.y)) - Math.round(32 * k) - capLine / 2;
    center = [other, above].find((c) => free(c)) ?? defaultCenter;
  }
  const captions: TimelineCaptions = {
    enabled: capCfg.enabled && ctx.sourceWordsAvailable,
    preset: cp.preset,
    fontId: cp.fontId,
    fontSize: cp.fontSize,
    color: cp.color,
    highlightColor: cp.highlightColor,
    strokeColor: cp.strokeColor,
    backgroundColor: cp.backgroundColor,
    y: r4(center / H),
    maxWordsPerChunk: 3,
    uppercase: false,
    wordEdits: {},
  };

  const zooms = (plan.punchIns ?? []).map((p, i) => ({
    id: `zoom-${i + 1}`,
    start: p.startSeconds,
    end: p.endSeconds,
    zoom: Math.min(3, Math.max(1, p.zoom)),
    x: 0.5,
    y: p.focus === "UPPER_THIRD" ? 0.33 : 0.5,
    mode: "CUT" as const,
    easeSeconds: 0.4,
  }));

  return EditTimelineSchema.parse({
    version: 2,
    canvas,
    clips,
    texts,
    captions,
    zooms,
    grade: { preset: "NONE", brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0 },
    audio: { normalize: plan.normalizeAudio },
  });
}
