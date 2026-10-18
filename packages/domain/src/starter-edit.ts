import type { ContentState, MediaAsset, PrismaClient } from "@prisma/client";
import { recordTakeSelection, getLatestTakeSelection } from "./take-selection";
import { recordEditPlan, getLatestEditPlan, FINISHING_EDIT_STATES } from "./edit-plan";
import { assertNoOpenRecordingDraft, getFinishedRecordingSequence } from "./recording-session";

/**
 * "Upload → straight into the editor, no AI required."
 *
 * Before this, the editor only existed once the Take Selector and Edit Planner (both model
 * calls) had run — so with no Anthropic credit an uploaded video never reached an editor. This
 * makes the starting edit deterministically, with zero model calls, through the normal state
 * machine (MEDIA_INGESTED -> TAKE_SELECTED -> EDIT_PLANNED via recordTakeSelection /
 * recordEditPlan — no shortcuts, full audit trail):
 *
 *  - Take: the only take, or with several the LONGEST (ties -> the most recent upload). The
 *    footage-first upload says "several takes of the same video is fine" — those are retakes,
 *    so stitching them all together would repeat the video; the longest is the most likely to
 *    be complete. Every other take is still in the editor's media bin to swap in or add.
 *  - Edit: the whole take as one clip, vertical 1080x1920, loudness-normalized, captions ON in
 *    the house BOLD_HIGHLIGHT style. The plan is a plain EditPlanOutput (no `plan.timeline`),
 *    so the editor and the renderer convert it with `planToTimeline` at LOAD time — captions
 *    therefore appear as soon as the take's word timings land from the background
 *    transcription (they are switched off only while no word timings exist yet).
 *
 *  - A video recorded in PARTS with the teleprompter (a FINISHED RecordingSession): the take is
 *    the recording, i.e. ALL its active segments in order (`plan.sequence`, converted to one
 *    clip per part by the worker's `timelineForPlan`). Refused while the recording is still a
 *    DRAFT — partial parts are not the video (docs/decisions-pending/segmented-recording-drafts.md).
 *
 * "Improve with AI" (the Edit Planner's re-plan from EDIT_PLANNED) still works afterwards.
 * Idempotent: an item that already has an edit plan in an editable state just returns it.
 * See docs/decisions-pending/flow.md.
 */

export const STARTER_EDIT_ORIGIN = "STARTER_EDIT";

export class StarterEditNotAvailableError extends Error {
  constructor(state: ContentState) {
    super(
      state === "FILMED" || state === "READY_TO_FILM"
        ? "Upload the footage first — then the editor opens."
        : `This video can't start an edit right now (it's past or before the editing step).`,
    );
    this.name = "StarterEditNotAvailableError";
  }
}

export class StarterEditNoFootageError extends Error {
  constructor() {
    super("There's no usable footage yet — upload a video first (or wait for it to finish processing).");
    this.name = "StarterEditNoFootageError";
  }
}

/** Pure: which take a starter edit uses. Longest wins; ties go to the most recent upload. */
export function pickStarterTake<T extends Pick<MediaAsset, "id" | "durationSeconds" | "createdAt">>(takes: T[]): T | null {
  const usable = takes.filter((t) => (t.durationSeconds ?? 0) > 0);
  if (usable.length === 0) return null;
  return usable.reduce((best, t) => {
    const d = t.durationSeconds ?? 0;
    const bd = best.durationSeconds ?? 0;
    if (d > bd + 1e-6) return t;
    if (Math.abs(d - bd) <= 1e-6 && t.createdAt.getTime() >= best.createdAt.getTime()) return t;
    return best;
  });
}

/** Pure: the starter plan JSON — a valid EditPlanOutput (packages/agents' schema, kept in sync
 * by a test in apps/web) for the whole take. */
export function buildStarterPlan(input: { durationSeconds: number; productionTier: "RAW" | "FAST" | "MEDIUM" | "HERO"; takeCount: number }) {
  const d = Math.round(input.durationSeconds * 1000) / 1000;
  return {
    origin: STARTER_EDIT_ORIGIN,
    segments: [{ startSeconds: 0, endSeconds: d }],
    targetDimensions: { width: 1080, height: 1920 },
    textOverlays: [],
    captions: { enabled: true, style: "BOLD_HIGHLIGHT" as const, position: "LOWER" as const },
    punchIns: [],
    normalizeAudio: true,
    bRollRequests: [],
    musicTrack: null,
    sfxEvents: [],
    transitions: [],
    targetDurationSeconds: d,
    productionTier: input.productionTier,
    doNothingElse: false,
    rationale:
      input.takeCount > 1
        ? `Starter edit (no AI): the longest of your ${input.takeCount} takes, whole, with captions. Trim, swap takes and add text in the editor.`
        : "Starter edit (no AI): your whole take with captions. Trim and add text in the editor.",
  };
}

/** `plan.sequence` of a multi-part recording: the parts, in playback order. */
export interface StarterSequence {
  recordingSessionId: string;
  takes: Array<{ mediaAssetId: string; durationSeconds: number }>;
}

export function readStarterSequence(plan: unknown): StarterSequence | null {
  const seq = (plan as { sequence?: unknown } | null)?.sequence as Partial<StarterSequence> | undefined;
  if (!seq || typeof seq !== "object" || !Array.isArray(seq.takes) || seq.takes.length === 0) return null;
  const takes = seq.takes.filter(
    (t): t is { mediaAssetId: string; durationSeconds: number } =>
      !!t && typeof t.mediaAssetId === "string" && typeof t.durationSeconds === "number" && t.durationSeconds > 0,
  );
  if (takes.length === 0) return null;
  return { recordingSessionId: typeof seq.recordingSessionId === "string" ? seq.recordingSessionId : "", takes };
}

/** Pure: the starter plan for a recording — every part whole, in order, captions on.
 * `segments` describe the first part (the selected take) so the plan stays a valid
 * EditPlanOutput; the editor/renderer use `sequence`. */
export function buildSequenceStarterPlan(input: { sequence: StarterSequence; productionTier: "RAW" | "FAST" | "MEDIUM" | "HERO" }) {
  const takes = input.sequence.takes.map((t) => ({ mediaAssetId: t.mediaAssetId, durationSeconds: Math.round(t.durationSeconds * 1000) / 1000 }));
  const total = Math.round(takes.reduce((a, t) => a + t.durationSeconds, 0) * 1000) / 1000;
  const first = buildStarterPlan({ durationSeconds: takes[0]!.durationSeconds, productionTier: input.productionTier, takeCount: 1 });
  return {
    ...first,
    targetDurationSeconds: total,
    sequence: { recordingSessionId: input.sequence.recordingSessionId, takes },
    rationale:
      takes.length === 1
        ? "Starter edit (no AI): the take you recorded with the teleprompter, with captions. Trim and add text in the editor."
        : `Starter edit (no AI): your ${takes.length} recorded parts in order, with captions. Trim and add text in the editor.`,
  };
}

export async function createStarterEdit(
  prisma: PrismaClient,
  contentItemId: string,
  actor: { actorId: string },
) {
  const item = await prisma.contentItem.findUniqueOrThrow({
    where: { id: contentItemId },
    include: { productionContract: { select: { productionTier: true } } },
  });

  const existing = await getLatestEditPlan(prisma, contentItemId);
  if (existing && FINISHING_EDIT_STATES.has(item.currentState)) {
    return { editPlan: existing, created: false as const };
  }
  // Recording in parts and not finished yet: the parts so far are not the video.
  await assertNoOpenRecordingDraft(prisma, contentItemId);
  if (item.currentState !== "MEDIA_INGESTED" && item.currentState !== "TAKE_SELECTED") {
    throw new StarterEditNotAvailableError(item.currentState);
  }

  const takes = await prisma.mediaAsset.findMany({
    where: { contentItemId, kind: "RAW_TAKE" },
    orderBy: { createdAt: "asc" },
  });

  // A finished teleprompter recording: all its parts, in order (not "the longest take").
  const recorded = await getFinishedRecordingSequence(prisma, contentItemId);
  const parts = recorded
    ? recorded.mediaAssetIds
        .map((id) => takes.find((t) => t.id === id))
        .filter((t): t is (typeof takes)[number] => !!t && (t.durationSeconds ?? 0) > 0)
    : [];
  if (recorded && parts.length > 0) {
    let selection = item.currentState === "TAKE_SELECTED" ? await getLatestTakeSelection(prisma, contentItemId) : null;
    if (!selection) {
      selection = await recordTakeSelection(
        prisma,
        {
          contentItemId,
          selectedMediaAssetId: parts[0]!.id,
          backupMediaAssetId: null,
          confidence: 1,
          reason:
            parts.length === 1
              ? "Auto: no AI needed — the take you recorded with the teleprompter."
              : `Auto: no AI needed — your ${parts.length} recorded parts, in order.`,
          materialDefects: [],
        },
        actor,
      );
    }
    // A single part that IS the selected take is an ordinary one-take starter edit; anything
    // else (several parts, or an older AI selection of another take) carries `sequence`.
    const plan =
      parts.length === 1 && selection.selectedMediaAssetId === parts[0]!.id
        ? buildStarterPlan({ durationSeconds: parts[0]!.durationSeconds!, productionTier: item.productionContract?.productionTier ?? "FAST", takeCount: 1 })
        : buildSequenceStarterPlan({
            sequence: { recordingSessionId: recorded.session.id, takes: parts.map((t) => ({ mediaAssetId: t.id, durationSeconds: t.durationSeconds! })) },
            productionTier: item.productionContract?.productionTier ?? "FAST",
          });
    const editPlan = await recordEditPlan(
      prisma,
      { contentItemId, takeSelectionId: selection.id, productionTier: plan.productionTier, targetDurationSeconds: plan.targetDurationSeconds, doNothingElse: false, plan },
      actor,
    );
    return { editPlan, created: true as const };
  }

  let selection = item.currentState === "TAKE_SELECTED" ? await getLatestTakeSelection(prisma, contentItemId) : null;
  let take = selection ? takes.find((t) => t.id === selection!.selectedMediaAssetId) ?? null : null;

  if (!selection) {
    take = pickStarterTake(takes);
    if (!take) throw new StarterEditNoFootageError();
    const usable = takes.filter((t) => (t.durationSeconds ?? 0) > 0).length;
    selection = await recordTakeSelection(
      prisma,
      {
        contentItemId,
        selectedMediaAssetId: take.id,
        backupMediaAssetId: null,
        // Deterministic pick, not a quality judgment: certain when there's one take.
        confidence: usable === 1 ? 1 : 0.5,
        reason:
          usable === 1
            ? "Auto: no AI needed — the only take."
            : `Auto: no AI needed — the longest of ${usable} takes (the others are in the editor to swap in).`,
        materialDefects: [],
      },
      actor,
    );
  }
  if (!take || !(take.durationSeconds && take.durationSeconds > 0)) throw new StarterEditNoFootageError();

  const plan = buildStarterPlan({
    durationSeconds: take.durationSeconds,
    productionTier: item.productionContract?.productionTier ?? "FAST",
    takeCount: takes.filter((t) => (t.durationSeconds ?? 0) > 0).length,
  });
  const editPlan = await recordEditPlan(
    prisma,
    {
      contentItemId,
      takeSelectionId: selection.id,
      productionTier: plan.productionTier,
      targetDurationSeconds: plan.targetDurationSeconds,
      doNothingElse: false,
      plan,
    },
    actor,
  );
  return { editPlan, created: true as const };
}

/** Whether an item at this state needs createStarterEdit before the editor can open. */
export function canStartEdit(state: ContentState): boolean {
  return state === "MEDIA_INGESTED" || state === "TAKE_SELECTED";
}
