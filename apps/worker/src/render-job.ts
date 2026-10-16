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
  renderVideo,
  runTechnicalQC,
  DEFAULT_CAPTIONS_CONFIG,
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
 * The one place that maps packages/agents' rich EditPlanOutput onto packages/media's
 * RenderInstructions. Captions: the plan's explicit `captions` config wins; a plan without
 * one (incl. EditPlans persisted before captions existed) gets the default — on, CLEAN,
 * LOWER — whenever the take has word timings.
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

/**
 * Orchestrates one render attempt end to end for a ContentItem currently in EDIT_PLANNED:
 * fetch the latest EditPlan + its selected take, download the source, render, QC, upload,
 * persist. This is the process apps/worker exists for — see /docs/DECISIONS.md ("Phase 3
 * renderer: ffmpeg-static + ffprobe-static, hosted in apps/worker").
 *
 * `fontPath` is optional: omitted, the renderer uses the bundled Inter weights per overlay
 * style (packages/media/assets/fonts). If given it must exist — the render fails loudly
 * otherwise rather than letting ffmpeg substitute a random system font.
 */
export async function renderContentItem(
  db: PrismaClient,
  storage: StorageAdapter,
  contentItemId: string,
  options: { fontPath?: string; targetVideoCodec?: string; targetAudioCodec?: string } = {},
  actor: { actorId: string },
): Promise<RenderJobResult> {
  const editPlanRow = await getLatestEditPlan(db, contentItemId);
  if (!editPlanRow) {
    throw new Error(`No EditPlan found for content item ${contentItemId}.`);
  }

  const takeSelection = await db.takeSelection.findUniqueOrThrow({
    where: { id: editPlanRow.takeSelectionId },
  });
  const sourceAsset = await db.mediaAsset.findUniqueOrThrow({
    where: { id: takeSelection.selectedMediaAssetId },
  });

  const plan = EditPlanOutputSchema.parse(editPlanRow.plan);
  const sourceWords = parseTranscriptWords(sourceAsset.transcriptWords);

  // startRendering only accepts EDIT_PLANNED (the state table has no QC_REPAIR -> EDITING
  // or EDITING -> EDITING transition — see /docs/STATE_MACHINE.md). A repair re-render from
  // QC_REPAIR, or a retry after a technical FAILED attempt that left the item in EDITING
  // (see render-record.ts), both skip straight to the render attempt instead.
  const current = await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (current.currentState === "EDIT_PLANNED") {
    await startRendering(db, contentItemId, actor);
  }

  const workDir = await mkdtemp(join(tmpdir(), "chris-render-"));
  const sourcePath = join(workDir, `source${extname(sourceAsset.originalFilename) || ".mp4"}`);
  const outputPath = join(workDir, "output.mp4");

  try {
    const sourceBytes = await storage.get(sourceAsset.storageKey);
    await writeFile(sourcePath, sourceBytes);

    const instructions = mapEditPlanToRenderInstructions(
      plan,
      sourcePath,
      outputPath,
      options.fontPath,
      sourceWords,
    );

    let renderResult: Awaited<ReturnType<typeof renderVideo>>;
    try {
      renderResult = await renderVideo(instructions);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await recordRenderAttempt(
        db,
        { contentItemId, editPlanId: editPlanRow.id, status: "FAILED", errorMessage },
        actor,
      );
      return { status: "FAILED", errorMessage };
    }

    const unexecutedInstructions = [
      ...listUnexecutedPlanInstructions(plan),
      ...renderResult.unexecutedInstructions,
    ];

    const qc = await runTechnicalQC(outputPath, {
      targetWidth: plan.targetDimensions?.width,
      targetHeight: plan.targetDimensions?.height,
      minDurationSeconds: Math.max(0, plan.targetDurationSeconds - 2),
      maxDurationSeconds: plan.targetDurationSeconds + 2,
      requiredVideoCodec: options.targetVideoCodec ?? "h264",
      requiredAudioCodec: options.targetAudioCodec ?? "aac",
    });
    // Stored alongside the QC report (Render.technicalQCReport is Json) so what the renderer
    // did NOT do is visible on the Render row without a schema change. `overall`/`checks`
    // keep their shape; these are additive keys.
    const storedReport = {
      ...qc,
      unexecutedInstructions,
      captions: {
        rendered: renderResult.captionLayout?.layouts.length ?? 0,
        relocatedAroundOverlays:
          renderResult.captionLayout?.layouts.filter((l) => l.relocated).length ?? 0,
      },
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
