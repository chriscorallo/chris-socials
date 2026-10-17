import {
  EditTimelineSchema,
  TIMELINE_VERSION,
  DEFAULT_CAPTION_FONT_ID,
  DEFAULT_TEXT_FONT_ID,
  type TimelineText,
} from "@chris/media/timeline";
import type { EditorDoc } from "../../../../../lib/editor/types";

/**
 * FALLBACK converter: EditPlan JSON -> EditTimeline, used only when the latest EditPlan has no
 * `plan.timeline` yet (i.e. it came straight from the AI Edit Planner).
 *
 * The renderer workstream owns the canonical converter (`planToTimeline` in packages/media)
 * so render and editor agree on the AI plan's look. When it merges, the integrator replaces
 * the body of `planToEditorDoc` with a call to it (keeping the `plan.timeline` passthrough).
 * See docs/decisions-pending/editor-ui.md — INTEGRATION NOTES.
 */

interface PlanLike {
  timeline?: unknown;
  segments?: Array<{ startSeconds: number; endSeconds: number }>;
  textOverlays?: Array<{
    text: string;
    startSeconds: number;
    endSeconds: number;
    position?: "TOP" | "CENTER" | "BOTTOM";
    style?: "HEADLINE" | "CAPTION" | "NUMBER_CALLOUT" | "LOWER_THIRD";
  }>;
  captions?: { enabled: boolean; style?: "CLEAN" | "BOLD_HIGHLIGHT"; position?: "LOWER" | "CENTER" } | null;
  punchIns?: Array<{ startSeconds: number; endSeconds: number; zoom: number; focus?: "CENTER" | "UPPER_THIRD" }>;
  normalizeAudio?: boolean;
  targetDimensions?: { width: number; height: number } | null;
}

const Y_BY_POSITION = { TOP: 0.15, CENTER: 0.42, BOTTOM: 0.78 } as const;

const STYLE_LOOK: Record<string, Omit<TimelineText, "id" | "text" | "start" | "end" | "x" | "y">> = {
  HEADLINE: {
    preset: "HEADLINE",
    fontId: DEFAULT_TEXT_FONT_ID,
    fontSize: 72,
    color: "#FFFFFF",
    backgroundColor: "#000000B3",
    strokeColor: null,
    align: "center",
    maxWidth: 0.84,
    uppercase: false,
  },
  NUMBER_CALLOUT: {
    preset: "NUMBER_CALLOUT",
    fontId: DEFAULT_TEXT_FONT_ID,
    fontSize: 150,
    color: "#FFD54A",
    backgroundColor: null,
    strokeColor: "#000000",
    align: "center",
    maxWidth: 0.9,
    uppercase: false,
  },
  LOWER_THIRD: {
    preset: "LOWER_THIRD",
    fontId: "inter-semibold",
    fontSize: 48,
    color: "#FFFFFF",
    backgroundColor: "#000000B3",
    strokeColor: null,
    align: "center",
    maxWidth: 0.84,
    uppercase: false,
  },
  CAPTION: {
    preset: "CAPTION",
    fontId: "inter-semibold",
    fontSize: 56,
    color: "#FFFFFF",
    backgroundColor: null,
    strokeColor: "#000000",
    align: "center",
    maxWidth: 0.84,
    uppercase: false,
  },
};

const DEFAULT_Y_BY_STYLE: Record<string, number> = { HEADLINE: 0.15, NUMBER_CALLOUT: 0.42, LOWER_THIRD: 0.78, CAPTION: 0.5 };

export function planToEditorDoc(
  planJson: unknown,
  selectedTake: { id: string; duration: number; hasWords: boolean },
): EditorDoc {
  const plan = (planJson ?? {}) as PlanLike;

  // An already-saved finishing edit: use it as-is (keeping not-yet-formalized fields).
  if (plan.timeline && typeof plan.timeline === "object") {
    const parsed = EditTimelineSchema.safeParse(plan.timeline);
    if (parsed.success) {
      const cover = (plan.timeline as { coverFrameSeconds?: unknown }).coverFrameSeconds;
      return { ...parsed.data, coverFrameSeconds: typeof cover === "number" ? cover : null };
    }
  }

  const dur = selectedTake.duration > 0 ? selectedTake.duration : Infinity;
  const segs = (plan.segments ?? []).filter((s) => s.endSeconds > s.startSeconds);
  const clips = (segs.length ? segs : [{ startSeconds: 0, endSeconds: Number.isFinite(dur) ? dur : 10 }]).map((s, i) => ({
    id: `clip_init_${i}`,
    mediaAssetId: selectedTake.id,
    sourceStart: Math.max(0, s.startSeconds),
    sourceEnd: Math.min(dur, s.endSeconds),
    crop: { zoom: 1, panX: 0, panY: 0 },
    volume: 1,
  }));

  const texts: TimelineText[] = (plan.textOverlays ?? [])
    .filter((o) => o.text?.trim() && o.endSeconds > o.startSeconds)
    .map((o, i) => {
      const style = o.style ?? "HEADLINE";
      const look = STYLE_LOOK[style] ?? STYLE_LOOK.HEADLINE!;
      const y = o.position ? Y_BY_POSITION[o.position] : (DEFAULT_Y_BY_STYLE[style] ?? 0.15);
      return { id: `text_init_${i}`, text: o.text.slice(0, 500), start: o.startSeconds, end: o.endSeconds, x: 0.5, y, ...look };
    });

  const capPlan = plan.captions;
  const captions = {
    enabled: capPlan ? capPlan.enabled : selectedTake.hasWords,
    preset: capPlan?.style === "CLEAN" ? ("CLEAN" as const) : ("BOLD_HIGHLIGHT" as const),
    fontId: DEFAULT_CAPTION_FONT_ID,
    fontSize: 64,
    color: "#FFFFFF",
    highlightColor: "#FFD54A",
    strokeColor: "#000000",
    backgroundColor: null,
    y: capPlan?.position === "CENTER" ? 0.5 : 0.72,
    maxWordsPerChunk: 3,
    uppercase: false,
    wordEdits: {},
  };

  const zooms = (plan.punchIns ?? [])
    .filter((p) => p.endSeconds > p.startSeconds)
    .map((p, i) => ({
      id: `zoom_init_${i}`,
      start: p.startSeconds,
      end: p.endSeconds,
      zoom: Math.min(3, Math.max(1, p.zoom)),
      x: 0.5,
      y: p.focus === "UPPER_THIRD" ? 0.33 : 0.5,
      mode: "CUT" as const,
      easeSeconds: 0.4,
    }));

  const doc = EditTimelineSchema.parse({
    version: TIMELINE_VERSION,
    canvas: { width: 1080, height: 1920 },
    clips,
    texts,
    captions,
    zooms,
    grade: { preset: "NONE", brightness: 0, contrast: 1, saturation: 1, temperature: 0, vignette: 0 },
    audio: { normalize: plan.normalizeAudio ?? true },
  });
  return { ...doc, coverFrameSeconds: null };
}
