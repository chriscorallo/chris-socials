import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import { createMediaAsset } from "../media-asset";
import { recordTakeSelection } from "../take-selection";
import {
  recordEditPlan,
  getLatestEditPlan,
  EditPlanRequiresTakeSelectedStateError,
} from "../edit-plan";

async function makeTakeSelectedItem() {
  const item = await createContentItem(prisma, { title: "Edit plan test idea" }, {
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
  return { item, take, selection };
}

describe("edit plan", () => {
  it("creating an edit plan transitions TAKE_SELECTED -> EDIT_PLANNED", async () => {
    const { item, selection } = await makeTakeSelectedItem();

    const plan = await recordEditPlan(
      prisma,
      {
        contentItemId: item.id,
        takeSelectionId: selection.id,
        productionTier: "FAST",
        targetDurationSeconds: 45,
        doNothingElse: false,
        plan: {
          segments: [{ startSeconds: 0, endSeconds: 45 }],
          textOverlays: [],
        },
      },
      { actorId: "chris" },
    );
    expect(plan.targetDurationSeconds).toBe(45);

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("EDIT_PLANNED");

    const latest = await getLatestEditPlan(prisma, item.id);
    expect(latest?.id).toBe(plan.id);
    expect((latest?.plan as { segments: unknown[] }).segments).toHaveLength(1);
  });

  it("rejects an edit plan from a state other than TAKE_SELECTED", async () => {
    const item = await createContentItem(prisma, { title: "Wrong state for edit plan" }, {
      actorId: "test-user",
    });
    await expect(
      recordEditPlan(
        prisma,
        {
          contentItemId: item.id,
          takeSelectionId: "does-not-matter",
          productionTier: "FAST",
          targetDurationSeconds: 30,
          plan: {},
        },
        { actorId: "chris" },
      ),
    ).rejects.toBeInstanceOf(EditPlanRequiresTakeSelectedStateError);
  });
});
