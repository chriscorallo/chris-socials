import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import { createMediaAsset } from "../media-asset";
import { recordTakeSelection } from "../take-selection";
import { recordEditPlan } from "../edit-plan";
import {
  startRendering,
  recordRenderAttempt,
  listRendersForEditPlan,
  getLatestRender,
  RenderRequiresEditPlannedStateError,
} from "../render-record";

async function makeEditPlannedItem() {
  const item = await createContentItem(prisma, { title: "Render test idea" }, {
    actorId: "test-user",
  });
  for (const to of [
    "SELECTED",
    "CONTRACTED",
    "RESEARCHING",
    "RESEARCHED",
    "SCRIPTING",
    "SCRIPTED",
    "READY_TO_FILM",
    "FILMED",
    "MEDIA_INGESTED",
  ] as const) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
  }
  const take = await createMediaAsset(
    prisma,
    {
      contentItemId: item.id,
      kind: "RAW_TAKE",
      storageKey: `raw/${item.id}/take-1.mp4`,
      originalFilename: "take-1.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1,
    },
    { actorId: "chris" },
  );
  const selection = await recordTakeSelection(
    prisma,
    { contentItemId: item.id, selectedMediaAssetId: take.id, confidence: 0.9, reason: "best" },
    { actorId: "chris" },
  );
  const editPlan = await recordEditPlan(
    prisma,
    {
      contentItemId: item.id,
      takeSelectionId: selection.id,
      productionTier: "FAST",
      targetDurationSeconds: 45,
      plan: { segments: [{ startSeconds: 0, endSeconds: 45 }] },
    },
    { actorId: "chris" },
  );
  return { item, editPlan };
}

describe("rendering + the QC repair loop", () => {
  it("startRendering transitions EDIT_PLANNED -> EDITING; rejects from any other state", async () => {
    const { item } = await makeEditPlannedItem();
    await startRendering(prisma, item.id, { actorId: "chris" });
    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("EDITING");

    await expect(startRendering(prisma, item.id, { actorId: "chris" })).rejects.toBeInstanceOf(
      RenderRequiresEditPlannedStateError,
    );
  });

  it("a successful render with passing QC lands at RENDERED and stays there", async () => {
    const { item, editPlan } = await makeEditPlannedItem();
    await startRendering(prisma, item.id, { actorId: "chris" });

    const render = await recordRenderAttempt(
      prisma,
      {
        contentItemId: item.id,
        editPlanId: editPlan.id,
        status: "SUCCESS",
        storageKey: `renders/${item.id}/v1.mp4`,
        durationSeconds: 45,
        width: 1080,
        height: 1920,
        technicalQCReport: { overall: "PASS", checks: [] },
      },
      { actorId: "chris" },
    );
    expect(render.attempt).toBe(1);

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("RENDERED");
  });

  it("a successful render with failing QC lands at RENDERED then immediately QC_REPAIR", async () => {
    const { item, editPlan } = await makeEditPlannedItem();
    await startRendering(prisma, item.id, { actorId: "chris" });

    await recordRenderAttempt(
      prisma,
      {
        contentItemId: item.id,
        editPlanId: editPlan.id,
        status: "SUCCESS",
        technicalQCReport: {
          overall: "FAIL",
          checks: [{ name: "dimensions", passed: false, detail: "wrong size" }],
        },
      },
      { actorId: "chris" },
    );

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("QC_REPAIR");

    const transitions = await prisma.contentStateTransition.findMany({
      where: { contentItemId: item.id },
      orderBy: { createdAt: "asc" },
    });
    const lastTwo = transitions.slice(-2).map((t) => t.toState);
    expect(lastTwo).toEqual(["RENDERED", "QC_REPAIR"]);
  });

  it("a technical execution failure (status FAILED) does not transition state at all", async () => {
    const { item, editPlan } = await makeEditPlannedItem();
    await startRendering(prisma, item.id, { actorId: "chris" });

    await recordRenderAttempt(
      prisma,
      {
        contentItemId: item.id,
        editPlanId: editPlan.id,
        status: "FAILED",
        errorMessage: "ffmpeg exited with code 1",
      },
      { actorId: "chris" },
    );

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("EDITING");
  });

  it("repeated QC failures hit the repair-iteration limit and land at QC_BLOCKED", async () => {
    const { item, editPlan } = await makeEditPlannedItem();
    await startRendering(prisma, item.id, { actorId: "chris" });

    const failingQC = { overall: "FAIL" as const, checks: [] };

    // Attempt 1: EDITING -> RENDERED -> QC_REPAIR
    await recordRenderAttempt(
      prisma,
      { contentItemId: item.id, editPlanId: editPlan.id, status: "SUCCESS", technicalQCReport: failingQC },
      { actorId: "chris" },
    );
    // Attempt 2: QC_REPAIR -> RENDERED -> QC_REPAIR
    await recordRenderAttempt(
      prisma,
      { contentItemId: item.id, editPlanId: editPlan.id, status: "SUCCESS", technicalQCReport: failingQC },
      { actorId: "chris" },
    );
    // Attempt 3: hits MAX_REPAIR_ATTEMPTS -> RENDERED -> QC_BLOCKED
    await recordRenderAttempt(
      prisma,
      { contentItemId: item.id, editPlanId: editPlan.id, status: "SUCCESS", technicalQCReport: failingQC },
      { actorId: "chris" },
    );

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("QC_BLOCKED");

    const renders = await listRendersForEditPlan(prisma, editPlan.id);
    expect(renders.map((r) => r.attempt)).toEqual([1, 2, 3]);

    const latest = await getLatestRender(prisma, item.id);
    expect(latest?.attempt).toBe(3);
  });
});
