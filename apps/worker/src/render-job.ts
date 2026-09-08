import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import {
  getLatestEditPlan,
  startRendering,
  recordRenderAttempt,
  type PrismaClient,
} from "@chris/domain";
import { EditPlanOutputSchema, type EditPlanOutput } from "@chris/agents";
import { renderVideo, runTechnicalQC, type RenderInstructions } from "@chris/media";
import type { StorageAdapter } from "@chris/media";

/**
 * The one place that maps packages/agents' rich EditPlanOutput onto packages/media's leaner
 * RenderInstructions. Only the fields the renderer currently executes are used — see
 * /docs/DECISIONS.md for exactly which EditPlan capabilities are implemented vs. gracefully
 * skipped (B-roll, music/SFX, transitions).
 *
 * Known simplification: EditPlanOutput's textOverlays carry a `style`
 * (HEADLINE/CAPTION/NUMBER_CALLOUT/LOWER_THIRD) meant to drive different visual treatment
 * per style; the renderer doesn't yet differentiate — every overlay renders with the same
 * plain white-on-black-box treatment regardless of style. Worth real styling once there's a
 * BrandAsset-backed typography preset to apply.
 */
export function mapEditPlanToRenderInstructions(
  editPlan: EditPlanOutput,
  sourcePath: string,
  outputPath: string,
  fontPath: string,
): RenderInstructions {
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
    })),
    normalizeAudio: editPlan.normalizeAudio,
    fontPath,
  };
}

export interface RenderJobResult {
  status: "SUCCESS" | "FAILED";
  outputStorageKey?: string;
  technicalQCReport?: unknown;
  errorMessage?: string;
}

/**
 * Orchestrates one render attempt end to end for a ContentItem currently in EDIT_PLANNED:
 * fetch the latest EditPlan + its selected take, download the source, render, QC, upload,
 * persist. This is the process apps/worker exists for — see /docs/DECISIONS.md ("Phase 3
 * renderer: ffmpeg-static + ffprobe-static, hosted in apps/worker").
 */
export async function renderContentItem(
  db: PrismaClient,
  storage: StorageAdapter,
  contentItemId: string,
  options: { fontPath: string; targetVideoCodec?: string; targetAudioCodec?: string },
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

  // startRendering only accepts EDIT_PLANNED (the state table has no QC_REPAIR -> EDITING
  // or EDITING -> EDITING transition — see /docs/STATE_MACHINE.md). A repair re-render from
  // QC_REPAIR, or a retry after a technical FAILED attempt that left the item in EDITING
  // (see render-record.ts), both skip straight to the render attempt instead. Found while
  // wiring the UI's "Render again" action, which is reachable from all three states.
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

    const qc = await runTechnicalQC(outputPath, {
      targetWidth: plan.targetDimensions?.width,
      targetHeight: plan.targetDimensions?.height,
      minDurationSeconds: Math.max(0, plan.targetDurationSeconds - 2),
      maxDurationSeconds: plan.targetDurationSeconds + 2,
      requiredVideoCodec: options.targetVideoCodec ?? "h264",
      requiredAudioCodec: options.targetAudioCodec ?? "aac",
    });

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
        technicalQCReport: qc,
      },
      actor,
    );

    return { status: "SUCCESS", outputStorageKey, technicalQCReport: qc };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
