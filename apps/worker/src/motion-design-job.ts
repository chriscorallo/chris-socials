import {
  getLatestEditPlan,
  getMotionTasteForDesign,
  classifyMotionTopic,
  creativeBriefTextFor,
  isEnabled,
  isScriptVersionFilmable,
  parseTranscriptWords,
  recordAudit,
  recordReplannedEditPlan,
  saveFinishingEdit,
  type PrismaClient,
} from "@chris/domain";
import {
  EditPlanOutputSchema,
  designVisualsForTimeline,
  getBrandContextText,
  scopeProvider,
  runVisualStrategistAgent,
  buildTranscriptPhrases,
  formatTimestampedTranscript,
  outputTimelineWords,
  type VisualBrief,
  type DesignVisualsResult,
  type ModelProvider,
  type MotionResearchInput,
  type RejectedVisual,
} from "@chris/agents";
import {
  EditTimelineSchema,
  nodeMeasureText,
  parseSubjectTrack,
  timelineDuration,
  type PlacementWarning,
  type StorageAdapter,
  type SubjectTrack,
  type TimelineVisual,
  type TranscriptWord,
} from "@chris/media";
import { timelineForPlan } from "./render-job";
import { ensureSubjectTracks, type SubjectAnalyzer, type SubjectTrackJobResult } from "./subject-track-job";

/** Feature flag gating the AUTOMATIC (pipeline-triggered) Motion Designer pass on a fresh
 * edit. Fail-closed (unknown flag = off). Chris's "Design visuals with AI" button is a human
 * action and isn't gated. CLAUDE.md: risky/new autonomous behaviour ships behind a flag. */
export const MOTION_AUTO_DESIGN_FLAG = "motion.auto_design";

export interface MotionDesignJobResult {
  status: "SUCCESS" | "SKIPPED" | "FAILED";
  /** The new EditPlan row carrying plan.timeline with the visuals. */
  editPlanId?: string;
  visuals?: TimelineVisual[];
  added?: TimelineVisual[];
  rejectedVisuals?: RejectedVisual[];
  warnings?: string[];
  placementWarnings?: PlacementWarning[];
  rationale?: string;
  /** The video's motion theme saved on the timeline, and where it came from. */
  motionTheme?: DesignVisualsResult["motionTheme"];
  themeSource?: DesignVisualsResult["themeSource"];
  subjectTracking?: SubjectTrackJobResult[];
  /** AI edit: the Visual Strategist's plan the visuals were built from. */
  brief?: VisualBrief | null;
  errorMessage?: string;
}

export interface MotionDesignJobOptions {
  /** "HUMAN" = Chris pressed "Design visuals with AI" (saved as his finishing edit, from any
   * editable state); "AUTO" = the pipeline's optional pass right after edit planning (only
   * from EDIT_PLANNED, only with the feature flag on). Default HUMAN. */
  trigger?: "HUMAN" | "AUTO";
  /** Replace the visuals already on the timeline instead of keeping them. */
  replaceExisting?: boolean;
  /** Subject tracker override (tests inject a fake; default = real ONNX tracker). */
  analyze?: SubjectAnalyzer;
  /** Skip subject tracking entirely (placement falls back to assumed framing + warnings). */
  skipTracking?: boolean;
  /** One graphic for one moment ("Suggest with AI" in the editor's graphics library). */
  focus?: { start: number; end: number; phrase?: string | null } | null;
  /** AI edit: run the Visual Strategist first (whole-video understanding + the viewer's
   * moments) and design only what it plans. */
  strategize?: boolean;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Designs motion graphics for a content item's current edit and saves them as a NEW EditPlan
 * version (append-only, plan.timeline = the edit with visuals):
 * 1. builds the current Timeline (finishing edit, or the AI plan converted);
 * 2. ensures every take the clips use has a subject track (runs the tracker if missing —
 *    failures degrade to assumed framing, never block);
 * 3. loads word timings, the latest research packet, the latest Claims-Gate-passed script,
 *    the tier and brand context; runs the Motion Designer (designVisualsForTimeline);
 * 4. saves via the domain's own paths so state/history stay correct — HUMAN: saveFinishingEdit
 *    (rolls a rendered item back to EDIT_PLANNED, like any finishing edit); AUTO:
 *    recordReplannedEditPlan from EDIT_PLANNED (no state change). The state machine is untouched.
 * Rejected visuals (e.g. FACTUAL: an ungrounded number) are audit-logged with reasons.
 */
export async function designMotionForContentItem(
  db: PrismaClient,
  storage: StorageAdapter,
  provider: ModelProvider,
  contentItemId: string,
  actor: { actorId: string },
  options: MotionDesignJobOptions = {},
): Promise<MotionDesignJobResult> {
  const trigger = options.trigger ?? "HUMAN";
  const item = await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (trigger === "AUTO") {
    if (!(await isEnabled(db, MOTION_AUTO_DESIGN_FLAG))) {
      return { status: "SKIPPED", errorMessage: `Feature flag ${MOTION_AUTO_DESIGN_FLAG} is off.` };
    }
    if (item.currentState !== "EDIT_PLANNED") {
      return { status: "SKIPPED", errorMessage: `Automatic motion design runs on a fresh edit (EDIT_PLANNED), not ${item.currentState}.` };
    }
  }

  const row = await getLatestEditPlan(db, contentItemId);
  if (!row) return { status: "SKIPPED", errorMessage: "No edit plan yet — run the Edit Planner first." };

  try {
    const takeSelection = await db.takeSelection.findUniqueOrThrow({ where: { id: row.takeSelectionId } });
    const selected = await db.mediaAsset.findUniqueOrThrow({ where: { id: takeSelection.selectedMediaAssetId } });
    const plan = EditPlanOutputSchema.parse(row.plan);
    const selectedWords = parseTranscriptWords(selected.transcriptWords);
    const { timeline } = timelineForPlan(row.plan, plan, {
      selectedMediaAssetId: selected.id,
      sourceWordsAvailable: (selectedWords?.length ?? 0) > 0,
      sourceDimensions: selected.width && selected.height ? { width: selected.width, height: selected.height } : null,
    });

    const assetIds = [...new Set(timeline.clips.map((c) => c.mediaAssetId))];
    let assets = await db.mediaAsset.findMany({ where: { id: { in: assetIds } } });
    const foreign = assetIds.filter((id) => !assets.some((a) => a.id === id && a.contentItemId === contentItemId));
    if (foreign.length) throw new Error(`Timeline references media assets that don't belong to this item: ${foreign.join(", ")}.`);

    let subjectTracking: SubjectTrackJobResult[] = [];
    if (!options.skipTracking) {
      subjectTracking = await ensureSubjectTracks(db, storage, assetIds, actor, { analyze: options.analyze });
      assets = await db.mediaAsset.findMany({ where: { id: { in: assetIds } } });
    }

    const subjectTracks: Record<string, SubjectTrack | null> = {};
    const wordsByAsset: Record<string, TranscriptWord[] | null> = {};
    const sourceDimensions: Record<string, { width: number; height: number } | null> = {};
    for (const a of assets) {
      subjectTracks[a.id] = parseSubjectTrack(a.subjectTrack);
      wordsByAsset[a.id] = parseTranscriptWords(a.transcriptWords);
      sourceDimensions[a.id] = a.width && a.height ? { width: a.width, height: a.height } : null;
    }

    const packet = await db.researchPacket.findFirst({ where: { contentItemId }, orderBy: { createdAt: "desc" } });
    const research: MotionResearchInput | null = packet
      ? {
          primaryClaim: packet.primaryClaim,
          numericInputs: asArray<{ label: string; value: string; asOfDate?: string | null }>(packet.numericInputs),
          facts: asArray<{ statement: string; type: string }>(packet.facts),
          calculationNotes: packet.calculationNotes,
        }
      : null;
    const scripts = await db.scriptVersion.findMany({ where: { contentItemId }, orderBy: { createdAt: "desc" } });
    const gated = scripts.find((s) => isScriptVersionFilmable(s).ok) ?? null;

    const brandContext = await getBrandContextText(db);
    // Topic + learned taste (best effort: learning must never block designing).
    const topicInput = { title: item.title, description: item.description, pillar: item.pillar };
    const { topic } = classifyMotionTopic({ ...topicInput, script: gated?.spokenScript ?? null });
    const motionTaste = await getMotionTasteForDesign(db, topic).catch(() => null);
    let brief: VisualBrief | null = null;
    if (options.strategize && !options.focus) {
      const phrases = buildTranscriptPhrases(outputTimelineWords(timeline, wordsByAsset));
      brief = await runVisualStrategistAgent(scopeProvider(provider, { contentItemId }), {
        transcript: phrases.length ? formatTimestampedTranscript(phrases) : "(no transcript)",
        durationS: timelineDuration(timeline),
        title: item.title,
        brandContext,
        creativeBrief: await creativeBriefTextFor(db, contentItemId),
        existing: options.replaceExisting ? null : timeline.visuals.map((v) => ({ start: v.start, end: v.end, name: v.anchorText ?? v.template })),
      });
    }
    const designed: DesignVisualsResult = await designVisualsForTimeline(scopeProvider(provider, { contentItemId }), {
      timeline,
      wordsByAsset,
      subjectTracks,
      sourceDimensions,
      research,
      script: gated ? { spokenScript: gated.spokenScript } : null,
      tier: row.productionTier,
      brandContext,
      replaceExisting: options.replaceExisting,
      focus: options.focus ?? null,
      brief,
      measure: nodeMeasureText,
      topic: topicInput,
      motionTaste: motionTaste ? { context: motionTaste.context, capDelta: motionTaste.capDelta, avoidTemplates: motionTaste.avoidTemplates } : null,
    });

    const nextTimeline = EditTimelineSchema.parse({ ...timeline, visuals: designed.visuals, motionTheme: designed.motionTheme });
    const note = `Motion Designer: ${designed.added.length} visual(s) added${designed.rejectedVisuals.length ? `, ${designed.rejectedVisuals.length} rejected` : ""}`;

    let editPlanId: string;
    if (trigger === "HUMAN") {
      const saved = await saveFinishingEdit(db, {
        contentItemId,
        timeline: nextTimeline,
        durationSeconds: timelineDuration(nextTimeline),
        actorId: actor.actorId,
        note: `${note} (Design visuals with AI)`,
      });
      editPlanId = saved.id;
    } else {
      const basePlan = (row.plan ?? {}) as Record<string, unknown>;
      const saved = await recordReplannedEditPlan(
        db,
        {
          contentItemId,
          takeSelectionId: row.takeSelectionId,
          productionTier: row.productionTier,
          targetDurationSeconds: Math.max(0.1, timelineDuration(nextTimeline)),
          doNothingElse: row.doNothingElse,
          plan: { ...basePlan, timeline: nextTimeline },
          revisionOfEditPlanId: null,
          revisionReason: note,
        },
        { actorId: actor.actorId, actorType: "SYSTEM" },
      );
      editPlanId = saved.id;
    }

    await recordAudit(db, {
      actor: actor.actorId,
      actorType: trigger === "HUMAN" ? "HUMAN" : "SYSTEM",
      action: "MOTION_DESIGN_RUN",
      entityType: "ContentItem",
      entityId: contentItemId,
      after: {
        editPlanId,
        added: designed.added.map((v) => ({ id: v.id, template: v.template, start: v.start, end: v.end, anchorText: v.anchorText })),
        rejectedVisuals: designed.rejectedVisuals,
        placementWarnings: designed.placementWarnings.map((w) => `${w.code}: ${w.message}`),
        motionTheme: designed.motionTheme,
        themeSource: designed.themeSource,
      },
      metadata: {
        model: designed.model,
        trigger,
        researchPacketId: packet?.id ?? null,
        scriptVersionId: gated?.id ?? null,
        subjectTracking: subjectTracking.map((r) => ({ mediaAssetId: r.mediaAssetId, status: r.status })),
        topic,
        motionTasteApplied: motionTaste ? { capDelta: motionTaste.capDelta, avoidTemplates: motionTaste.avoidTemplates, hasContext: !!motionTaste.context } : null,
      },
    });

    return {
      status: "SUCCESS",
      editPlanId,
      visuals: designed.visuals,
      added: designed.added,
      rejectedVisuals: designed.rejectedVisuals,
      warnings: [
        ...designed.warnings,
        ...subjectTracking.filter((r) => r.status === "FAILED").map((r) => `Subject tracking failed for take ${r.mediaAssetId}: ${r.errorMessage}`),
      ],
      placementWarnings: designed.placementWarnings,
      rationale: designed.rationale,
      motionTheme: designed.motionTheme,
      themeSource: designed.themeSource,
      subjectTracking,
      brief,
    };
  } catch (err) {
    return { status: "FAILED", errorMessage: err instanceof Error ? err.message : String(err) };
  }
}
