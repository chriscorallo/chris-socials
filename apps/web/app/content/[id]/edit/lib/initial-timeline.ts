import { EditPlanOutputSchema } from "@chris/agents";
import { EditTimelineSchema, TIMELINE_VERSION, DEFAULT_CAPTION_FONT_ID } from "@chris/media/timeline";
import { timelineForPlan } from "@chris/worker";
import type { EditorDoc } from "../../../../../lib/editor/types";

/**
 * SERVER-ONLY. The timeline the editor opens with — exactly the one the renderer would render
 * for this EditPlan row: `plan.timeline` (a saved finishing edit) when present, else the
 * renderer's deterministic `planToTimeline` conversion of the AI plan (via the worker's own
 * `timelineForPlan`, so editor and render can never disagree about the starting point).
 *
 * Last resort — a plan that doesn't parse as an EditPlan and has no valid timeline (legacy or
 * hand-edited rows) — opens the whole selected take with default captions rather than
 * refusing to open the editor.
 */
export function initialEditorDoc(
  planJson: unknown,
  selectedTake: { id: string; duration: number; hasWords: boolean; width: number | null; height: number | null },
): EditorDoc {
  const raw = (planJson ?? {}) as Record<string, unknown>;
  if (raw.timeline != null) {
    const parsed = EditTimelineSchema.safeParse(raw.timeline);
    if (parsed.success) return parsed.data;
  }
  const plan = EditPlanOutputSchema.safeParse(planJson);
  if (plan.success) {
    try {
      return timelineForPlan(planJson, plan.data, {
        selectedMediaAssetId: selectedTake.id,
        sourceWordsAvailable: selectedTake.hasWords,
        sourceDimensions: selectedTake.width && selectedTake.height ? { width: selectedTake.width, height: selectedTake.height } : null,
      }).timeline;
    } catch {
      // fall through to the whole-take timeline
    }
  }
  return EditTimelineSchema.parse({
    version: TIMELINE_VERSION,
    canvas: { width: 1080, height: 1920 },
    clips: [
      {
        id: "clip-1",
        mediaAssetId: selectedTake.id,
        sourceStart: 0,
        sourceEnd: selectedTake.duration > 0 ? selectedTake.duration : 10,
      },
    ],
    captions: {
      enabled: selectedTake.hasWords,
      preset: "BOLD_HIGHLIGHT",
      fontId: DEFAULT_CAPTION_FONT_ID,
      fontSize: 64,
      color: "#FFFFFF",
      highlightColor: "#FFD84D",
    },
  });
}
