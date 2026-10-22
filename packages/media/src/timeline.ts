import { z } from "zod";
import { TimelineVisualSchema, TimelineSfxSchema, TimelineMusicSchema, MotionThemeSchema } from "./motion-contract";

/**
 * EditTimeline v2 — the finishing editor's document, and the renderer's input.
 *
 * The Edit Planner (AI) still outputs an `EditPlanOutput` (packages/agents schemas.ts); a
 * deterministic converter turns it into a Timeline (`planToTimeline`). Chris's finishing edits
 * in the in-app editor are saved as a Timeline on a NEW EditPlan row (append-only — every save
 * is a version, nothing is overwritten). The renderer renders a Timeline; what the editor
 * previews is what renders. See /docs/DECISIONS.md ("In-app finishing editor").
 *
 * Conventions (shared by renderer and browser preview — keep them identical):
 * - All times on the OUTPUT timeline are seconds from the start of the finished video, except
 *   `clips[].sourceStart/sourceEnd`, which are on that clip's SOURCE media.
 * - Output order of clips = array order; output duration = sum of clip durations.
 * - Positions (`x`, `y`) are fractions of the canvas: (0,0) top-left, (1,1) bottom-right, and
 *   refer to the CENTER of the element.
 * - Sizes in px are at the canvas size (1080x1920 by default) and scale with it.
 * - Colors are #RRGGBB (or #RRGGBBAA for backgrounds).
 */

export const TIMELINE_VERSION = 2 as const;

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, "Use #RRGGBB or #RRGGBBAA");
const Fraction = z.number().min(0).max(1);

/** Reframe inside the 9:16 canvas. zoom 1 = the source scaled to COVER the canvas (current
 * center-crop behavior); >1 zooms in further. panX/panY in [-1, 1] slide the visible window
 * across the available overflow (0 = centered; -1 = left/top edge; 1 = right/bottom edge). */
export const TimelineCropSchema = z.object({
  zoom: z.number().min(1).max(4).default(1),
  panX: z.number().min(-1).max(1).default(0),
  panY: z.number().min(-1).max(1).default(0),
});
export type TimelineCrop = z.infer<typeof TimelineCropSchema>;

export const TimelineClipSchema = z.object({
  id: z.string().min(1),
  /** Which raw take this clip comes from (MediaAsset id) — clips may mix takes. */
  mediaAssetId: z.string().min(1),
  sourceStart: z.number().nonnegative(),
  sourceEnd: z.number().positive(),
  crop: TimelineCropSchema.default({ zoom: 1, panX: 0, panY: 0 }),
  /** Linear gain, 0 = mute, 1 = unchanged, up to 2. */
  volume: z.number().min(0).max(2).default(1),
});
export type TimelineClip = z.infer<typeof TimelineClipSchema>;

export const TEXT_STYLE_PRESETS = ["HEADLINE", "CAPTION", "NUMBER_CALLOUT", "LOWER_THIRD", "CUSTOM"] as const;

/** Where the Screen Orchestrator anchored a text (screen/anchors.ts): the top zone above the
 * head, a side band beside it, near the speaker (chest), or FREE (placed by hand / unknown).
 * Informational — `x`/`y` are already resolved; the editor shows it and the audit checks it. */
export const TEXT_ANCHORS = ["TOP", "SIDE_L", "SIDE_R", "NEAR_SPEAKER", "FREE"] as const;
export type TextAnchor = (typeof TEXT_ANCHORS)[number];

export const TimelineTextSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(500),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  /** Look the element started from; every visual field below can override it. */
  preset: z.enum(TEXT_STYLE_PRESETS).default("CUSTOM"),
  fontId: z.string().min(1),
  /** px at canvas width 1080 */
  fontSize: z.number().min(12).max(400),
  color: Hex,
  /** Plate behind the text; null = none. */
  backgroundColor: Hex.nullable().default(null),
  /** Outline; null = none. */
  strokeColor: Hex.nullable().default(null),
  align: z.enum(["left", "center", "right"]).default("center"),
  x: Fraction.default(0.5),
  y: Fraction.default(0.15),
  /** Max line width as a fraction of canvas width; text wraps inside it. */
  maxWidth: z.number().min(0.2).max(1).default(0.84),
  uppercase: z.boolean().default(false),
  anchor: z.enum(TEXT_ANCHORS).default("FREE"),
  /** Entrance / exit as a fade (seconds, 0 = hard). Renderer (drawtext alpha, ASS \fad) and the
   * browser preview (opacity) use the same curve: linear over the window. Exits are quicker
   * than entrances by convention (the orchestrator sets 0.2 / 0.12). */
  fadeIn: z.number().min(0).max(1).default(0),
  fadeOut: z.number().min(0).max(1).default(0),
});
export type TimelineText = z.infer<typeof TimelineTextSchema>;

/** Opacity of a text at output time t (0–1); 0 outside [start, end). Shared by the renderer's
 * expressions and the preview. */
export function textOpacityAt(t: Pick<TimelineText, "start" | "end" | "fadeIn" | "fadeOut">, time: number): number {
  if (time < t.start || time >= t.end) return 0;
  let a = 1;
  if (t.fadeIn > 0) a = Math.min(a, (time - t.start) / t.fadeIn);
  if (t.fadeOut > 0) a = Math.min(a, (t.end - time) / t.fadeOut);
  return Math.max(0, Math.min(1, a));
}

/** QUIET (2026-10-21): the orchestrator's support captions — small, white, thin stroke, no
 * plate, no spoken-word highlight; the headline is the loud layer. */
export const CAPTION_PRESETS = ["CLEAN", "BOLD_HIGHLIGHT", "BOXED", "KARAOKE", "QUIET"] as const;

/** A stretch of the output where the caption chunk size differs from `maxWordsPerChunk`: one
 * word at a time for a short emotional line, phrases for a line with amounts (screen/captions.ts). */
export const CaptionChunkWindowSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().positive(),
  maxWords: z.number().int().min(1).max(8),
});
export type CaptionChunkWindow = z.infer<typeof CaptionChunkWindowSchema>;

export const TimelineCaptionsSchema = z.object({
  enabled: z.boolean().default(true),
  preset: z.enum(CAPTION_PRESETS).default("BOLD_HIGHLIGHT"),
  fontId: z.string().min(1),
  fontSize: z.number().min(24).max(200),
  color: Hex,
  /** The currently-spoken word's color (BOLD_HIGHLIGHT / KARAOKE). */
  highlightColor: Hex,
  strokeColor: Hex.nullable().default("#000000"),
  backgroundColor: Hex.nullable().default(null),
  /** Vertical center of the caption block as a fraction of canvas height. */
  y: Fraction.default(0.72),
  maxWordsPerChunk: z.number().int().min(1).max(8).default(3),
  uppercase: z.boolean().default(false),
  /** Adaptive chunking by stretch (non-overlapping, output seconds); empty = one size throughout. */
  chunking: z.array(CaptionChunkWindowSchema).default([]),
  /**
   * Caption text corrections, keyed `${mediaAssetId}:${wordIndex}` into that take's
   * transcriptWords. Value = replacement text; "" hides the word. Timing always comes from the
   * real word timings — only the displayed text changes.
   */
  wordEdits: z.record(z.string(), z.string()).default({}),
});
export type TimelineCaptions = z.infer<typeof TimelineCaptionsSchema>;

/** Punch-in / zoom on the OUTPUT timeline, on top of each clip's own crop. */
export const TimelineZoomSchema = z.object({
  id: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  zoom: z.number().min(1).max(3),
  /** Zoom focal point as canvas fractions. */
  x: Fraction.default(0.5),
  y: Fraction.default(0.4),
  /** "CUT" = jump zoom (instant); "EASE" = smooth push-in over `easeSeconds`. */
  mode: z.enum(["CUT", "EASE"]).default("CUT"),
  easeSeconds: z.number().min(0).max(3).default(0.4),
  /** In-hold-out: ease back to 1 over the last `easeOutSeconds` of the window (0 = snap back,
   * the pre-2026-10-21 behaviour). */
  easeOutSeconds: z.number().min(0).max(3).default(0),
});
export type TimelineZoom = z.infer<typeof TimelineZoomSchema>;

export const GRADE_PRESETS = ["NONE", "WARM", "COOL", "PUNCHY", "MATTE", "BW", "CINEMATIC"] as const;

/** Whole-video color grade. Neutral values = no change. */
export const TimelineGradeSchema = z.object({
  preset: z.enum(GRADE_PRESETS).default("NONE"),
  /** -1..1, 0 neutral */
  brightness: z.number().min(-1).max(1).default(0),
  /** 0..2, 1 neutral */
  contrast: z.number().min(0).max(2).default(1),
  /** 0..2, 1 neutral (0 = black & white) */
  saturation: z.number().min(0).max(2).default(1),
  /** -1 (cool/blue) .. 1 (warm/orange), 0 neutral */
  temperature: z.number().min(-1).max(1).default(0),
  /** 0..1 */
  vignette: z.number().min(0).max(1).default(0),
});
export type TimelineGrade = z.infer<typeof TimelineGradeSchema>;

export const EditTimelineSchema = z.object({
  version: z.literal(TIMELINE_VERSION),
  canvas: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .default({ width: 1080, height: 1920 }),
  clips: z.array(TimelineClipSchema).min(1),
  texts: z.array(TimelineTextSchema).default([]),
  captions: TimelineCaptionsSchema,
  zooms: z.array(TimelineZoomSchema).default([]),
  grade: TimelineGradeSchema.default({ preset: "NONE", brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0 }),
  audio: z
    .object({
      normalize: z.boolean().default(true),
      /** Background music bed (null = none). See motion-contract.ts. */
      music: TimelineMusicSchema.nullable().default(null),
      /** Master switch for sound design (visual entrance SFX + free SFX). */
      sfxEnabled: z.boolean().default(true),
    })
    .default({ normalize: true, music: null, sfxEnabled: true }),
  /** Animated explainer graphics (motion-contract.ts) — rendered by packages/motion. */
  visuals: z.array(TimelineVisualSchema).default([]),
  /** Per-video motion theme (null = brand default). */
  motionTheme: MotionThemeSchema.nullable().default(null),
  /** Free-standing sound effects (visual entrances carry their own enterSfx). */
  sfx: z.array(TimelineSfxSchema).default([]),
  /** Thumbnail frame (OUTPUT timeline seconds) — sent to each platform the way its API takes
   * a cover (Instagram thumb_offset, TikTok video_cover_timestamp_ms). Null = platform default. */
  coverFrameSeconds: z.number().nonnegative().nullable().default(null),
});
export type EditTimeline = z.infer<typeof EditTimelineSchema>;
export type EditTimelineInput = z.input<typeof EditTimelineSchema>;

export function clipDuration(clip: Pick<TimelineClip, "sourceStart" | "sourceEnd">): number {
  return Math.max(0, clip.sourceEnd - clip.sourceStart);
}

export function timelineDuration(timeline: Pick<EditTimeline, "clips">): number {
  return timeline.clips.reduce((sum, c) => sum + clipDuration(c), 0);
}

/** Output-timeline start time of each clip, in order. */
export function clipStartTimes(timeline: Pick<EditTimeline, "clips">): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const c of timeline.clips) {
    starts.push(t);
    t += clipDuration(c);
  }
  return starts;
}

/** Which clip is on screen at output time `t`, and the matching source time. */
export function locateOutputTime(
  timeline: Pick<EditTimeline, "clips">,
  t: number,
): { clipIndex: number; sourceTime: number } | null {
  let acc = 0;
  for (let i = 0; i < timeline.clips.length; i++) {
    const c = timeline.clips[i]!;
    const d = clipDuration(c);
    if (t < acc + d || i === timeline.clips.length - 1) {
      return { clipIndex: i, sourceTime: Math.min(c.sourceEnd, c.sourceStart + Math.max(0, t - acc)) };
    }
    acc += d;
  }
  return null;
}

/** Named grade presets resolved to concrete values (renderer and preview both use this). */
export const GRADE_PRESET_VALUES: Record<(typeof GRADE_PRESETS)[number], Omit<TimelineGrade, "preset">> = {
  NONE: { brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0 },
  WARM: { brightness: 0.02, contrast: 1.05, saturation: 1.1, temperature: 0.35, vignette: 0.15 },
  COOL: { brightness: 0, contrast: 1.05, saturation: 0.95, temperature: -0.35, vignette: 0.1 },
  PUNCHY: { brightness: 0.02, contrast: 1.2, saturation: 1.3, temperature: 0.05, vignette: 0.2 },
  MATTE: { brightness: 0.05, contrast: 0.85, saturation: 0.85, temperature: 0.05, vignette: 0 },
  BW: { brightness: 0, contrast: 1.15, saturation: 0, temperature: 0, vignette: 0.25 },
  CINEMATIC: { brightness: -0.03, contrast: 1.15, saturation: 0.9, temperature: -0.1, vignette: 0.35 },
};
