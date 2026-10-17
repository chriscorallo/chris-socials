import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import {
  getLatestEditPlan,
  startRendering,
  recordRenderAttempt,
  parseTranscriptWords,
  type PrismaClient,
} from "@chris/domain";
import { EditPlanOutputSchema, type EditPlanOutput } from "@chris/agents";
import {
  runTechnicalQC,
  renderTimeline,
  planToTimeline,
  timelineDuration,
  EditTimelineSchema,
  DEFAULT_CAPTIONS_CONFIG,
  type EditTimeline,
  type RenderInstructions,
  type TranscriptWord,
} from "@chris/media";
import type { StorageAdapter } from "@chris/media";

/**
 * EditPlan fields the renderer does not execute yet (no approved asset library / transition
 * engine). Listed — never silently dropped — so the gap is visible on the Render row and in
 * the UI. Pure.
 */
export function listUnexecutedPlanInstructions(plan: EditPlanOutput): string[] {
  const out: string[] = [];
  for (const b of plan.bRollRequests) out.push(`B-roll request not executed (no asset library): "${b}"`);
  if (plan.musicTrack) out.push(`Music track not executed (no asset library): "${plan.musicTrack}"`);
  for (const s of plan.sfxEvents) out.push(`SFX not executed (no asset library): "${s.sfx}" at ${s.atSeconds}s`);
  for (const t of plan.transitions) {
    out.push(`Transition not executed (all cuts are hard cuts): "${t.type}" at ${t.atSeconds}s`);
  }
  return out;
}

/**
 * Legacy mapping of an EditPlan onto packages/media's EditPlan renderer (`renderVideo`).
 * The worker now renders through the timeline engine (`timelineForPlan` + `renderTimeline`);
 * this stays for callers/tests of the legacy renderer. Captions: the plan's explicit
 * `captions` config wins; a plan without one gets the default — on, CLEAN, LOWER — whenever
 * the take has word timings.
 */
export function mapEditPlanToRenderInstructions(
  editPlan: EditPlanOutput,
  sourcePath: string,
  outputPath: string,
  fontPath?: string,
  sourceWords?: TranscriptWord[] | null,
): RenderInstructions {
  const captionsConfig = editPlan.captions ?? DEFAULT_CAPTIONS_CONFIG;
  return {
    sourcePath,
    outputPath,
    segments: editPlan.segments,
    targetDimensions: editPlan.targetDimensions,
    textOverlays: editPlan.textOverlays.map((o) => ({
      text: o.text,
      startSeconds: o.startSeconds,
      endSeconds: o.endSeconds,
      position: o.position,
      style: o.style,
    })),
    normalizeAudio: editPlan.normalizeAudio,
    fontPath: fontPath || undefined,
    captions:
      captionsConfig.enabled && (sourceWords?.length ?? 0) > 0
        ? { config: captionsConfig, sourceWords: sourceWords! }
        : editPlan.captions?.enabled
          ? { config: captionsConfig, sourceWords: [] } // renderer reports "no word timings"
          : null,
    punchIns: editPlan.punchIns,
  };
}

export interface RenderJobResult {
  status: "SUCCESS" | "FAILED";
  outputStorageKey?: string;
  technicalQCReport?: unknown;
  errorMessage?: string;
  /** EditPlan instructions present but not executed (also stored inside technicalQCReport). */
  unexecutedInstructions?: string[];
}

export class InvalidFinishingEditError extends Error {
  constructor(detail: string) {
    super(
      `This edit plan carries a finishing-edit timeline that doesn't validate (${detail}). ` +
        `Refusing to render the AI plan in its place — that would silently discard Chris's edit.`,
    );
    this.name = "InvalidFinishingEditError";
  }
}

/**
 * The Timeline a plan row renders: its `plan.timeline` (a finishing edit from the in-app
 * editor) when present, else the deterministic conversion of the AI's EditPlan. A present
 * but invalid timeline is an error, never a silent fallback to the AI plan.
 */
export function timelineForPlan(
  rawPlan: unknown,
  plan: EditPlanOutput,
  ctx: {
    selectedMediaAssetId: string;
    sourceWordsAvailable: boolean;
    sourceDimensions?: { width: number; height: number } | null;
  },
): { timeline: EditTimeline; source: "FINISHING_EDIT" | "EDIT_PLAN" } {
  const raw = (rawPlan ?? {}) as Record<string, unknown>;
  if (raw.timeline != null) {
    const parsed = EditTimelineSchema.safeParse(raw.timeline);
    if (!parsed.success) {
      throw new InvalidFinishingEditError(
        parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      );
    }
    return { timeline: parsed.data, source: "FINISHING_EDIT" };
  }
  const dims = ctx.sourceDimensions;
  // targetDimensions null = keep the source's native framing (even dims for H.264).
  const canvas =
    plan.targetDimensions ??
    (dims ? { width: dims.width - (dims.width % 2), height: dims.height - (dims.height % 2) } : undefined);
  return {
    timeline: planToTimeline(plan, {
      mediaAssetId: ctx.selectedMediaAssetId,
      sourceWordsAvailable: ctx.sourceWordsAvailable,
      canvas,
    }),
    source: "EDIT_PLAN",
  };
}

/**
 * Orchestrates one render attempt end to end for a ContentItem currently in EDIT_PLANNED:
 * fetch the latest EditPlan, build its Timeline (finishing edit, or the converted AI plan),
 * download EVERY take the timeline's clips use, render with the timeline engine, QC, upload,
 * persist. See docs/decisions-pending/timeline-engine.md.
 *
 * `options.fontPath` is accepted for backward compatibility but unused: every font comes from
 * FONT_REGISTRY (packages/media/assets/fonts). `options.encode` overrides the master encoder
 * settings (tests use a fast preset).
 */
export async function renderContentItem(
  db: PrismaClient,
  storage: StorageAdapter,
  contentItemId: string,
  options: {
    fontPath?: string;
    targetVideoCodec?: string;
    targetAudioCodec?: string;
    encode?: { preset?: string; crf?: number };
  } = {},
  actor: { actorId: string },
): Promise<RenderJobResult> {
  const editPlanRow = await getLatestEditPlan(db, contentItemId);
  if (!editPlanRow) {
    throw new Error(`No EditPlan found for content item ${contentItemId}.`);
  }

  const takeSelection = await db.takeSelection.findUniqueOrThrow({
    where: { id: editPlanRow.takeSelectionId },
  });
  const selectedAsset = await db.mediaAsset.findUniqueOrThrow({
    where: { id: takeSelection.selectedMediaAssetId },
  });

  const plan = EditPlanOutputSchema.parse(editPlanRow.plan);
  const selectedWords = parseTranscriptWords(selectedAsset.transcriptWords);

  // startRendering only accepts EDIT_PLANNED (the state table has no QC_REPAIR -> EDITING
  // or EDITING -> EDITING transition — see /docs/STATE_MACHINE.md). A repair re-render from
  // QC_REPAIR, or a retry after a technical FAILED attempt that left the item in EDITING
  // (see render-record.ts), both skip straight to the render attempt instead.
  const current = await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (current.currentState === "EDIT_PLANNED") {
    await startRendering(db, contentItemId, actor);
  }

  const fail = async (err: unknown): Promise<RenderJobResult> => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await recordRenderAttempt(
      db,
      { contentItemId, editPlanId: editPlanRow.id, status: "FAILED", errorMessage },
      actor,
    );
    return { status: "FAILED", errorMessage };
  };

  let built: ReturnType<typeof timelineForPlan>;
  try {
    built = timelineForPlan(editPlanRow.plan, plan, {
      selectedMediaAssetId: selectedAsset.id,
      sourceWordsAvailable: (selectedWords?.length ?? 0) > 0,
      sourceDimensions:
        selectedAsset.width && selectedAsset.height
          ? { width: selectedAsset.width, height: selectedAsset.height }
          : null,
    });
  } catch (err) {
    return fail(err);
  }
  const { timeline, source: timelineSource } = built;

  // Every take the clips reference (a finishing edit may mix takes) — all must belong to
  // this content item.
  const assetIds = [...new Set(timeline.clips.map((c) => c.mediaAssetId))];
  const assets = await db.mediaAsset.findMany({ where: { id: { in: assetIds } } });
  const foreign = assetIds.filter(
    (id) => !assets.some((a) => a.id === id && a.contentItemId === contentItemId),
  );
  if (foreign.length > 0) {
    return fail(new Error(`Timeline references media assets that don't belong to this item: ${foreign.join(", ")}.`));
  }

  const workDir = await mkdtemp(join(tmpdir(), "chris-render-"));
  const outputPath = join(workDir, "output.mp4");

  try {
    const sources: Record<string, string> = {};
    const sourceWords: Record<string, TranscriptWord[] | null> = {};
    for (const [i, asset] of assets.entries()) {
      const path = join(workDir, `source-${i}${extname(asset.originalFilename) || ".mp4"}`);
      await writeFile(path, await storage.get(asset.storageKey));
      sources[asset.id] = path;
      sourceWords[asset.id] = parseTranscriptWords(asset.transcriptWords);
    }

    let renderResult: Awaited<ReturnType<typeof renderTimeline>>;
    try {
      renderResult = await renderTimeline({ timeline, sources, sourceWords, outputPath, encode: options.encode });
    } catch (err) {
      return fail(err);
    }

    const unexecutedInstructions = [...listUnexecutedPlanInstructions(plan), ...renderResult.warnings];

    const duration = timelineDuration(timeline);
    const qc = await runTechnicalQC(outputPath, {
      targetWidth: timeline.canvas.width,
      targetHeight: timeline.canvas.height,
      minDurationSeconds: Math.max(0, duration - 2),
      maxDurationSeconds: duration + 2,
      requiredVideoCodec: options.targetVideoCodec ?? "h264",
      requiredAudioCodec: options.targetAudioCodec ?? "aac",
    });
    // Stored alongside the QC report (Render.technicalQCReport is Json) so what the renderer
    // did NOT do is visible on the Render row without a schema change. `overall`/`checks`
    // keep their shape; everything else is an additive key.
    const storedReport = {
      ...qc,
      unexecutedInstructions,
      captions: {
        rendered: renderResult.captionCount,
        // Timeline captions sit at their explicit y (planToTimeline picks a free band); the
        // renderer no longer moves phrases on its own.
        relocatedAroundOverlays: 0,
      },
      renderEngine: "timeline-v2",
      timelineSource,
      renderMs: renderResult.renderMs,
      ffmpegWarnings: renderResult.ffmpegWarnings,
    };

    const outputBytes = await readFile(outputPath);
    const outputStorageKey = `renders/${contentItemId}/${editPlanRow.id}-${Date.now()}.mp4`;
    await storage.put(outputStorageKey, outputBytes, "video/mp4");

    await recordRenderAttempt(
      db,
      {
        contentItemId,
        editPlanId: editPlanRow.id,
        status: "SUCCESS",
        storageKey: outputStorageKey,
        durationSeconds: renderResult.durationSeconds,
        width: renderResult.width,
        height: renderResult.height,
        fileSizeBytes: outputBytes.byteLength,
        technicalQCReport: storedReport,
      },
      actor,
    );

    return {
      status: "SUCCESS",
      outputStorageKey,
      technicalQCReport: storedReport,
      unexecutedInstructions,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
