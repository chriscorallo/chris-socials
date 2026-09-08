import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import { createMediaAsset } from "../media-asset";
import {
  recordTakeSelection,
  getLatestTakeSelection,
  TakeSelectionRequiresMediaIngestedStateError,
} from "../take-selection";

async function makeMediaIngestedItemWithTakes() {
  const item = await createContentItem(prisma, { title: "Take selection test idea" }, {
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
  const take1 = await createMediaAsset(
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
  const take2 = await createMediaAsset(
    prisma,
    {
      contentItemId: item.id,
      kind: "RAW_TAKE",
      storageKey: `raw/${item.id}/take-2.mp4`,
      originalFilename: "take-2.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1,
    },
    { actorId: "chris" },
  );
  return { item, take1, take2 };
}

describe("take selection", () => {
  it("selecting a take transitions MEDIA_INGESTED -> TAKE_SELECTED", async () => {
    const { item, take1, take2 } = await makeMediaIngestedItemWithTakes();

    const selection = await recordTakeSelection(
      prisma,
      {
        contentItemId: item.id,
        selectedMediaAssetId: take1.id,
        backupMediaAssetId: take2.id,
        confidence: 0.85,
        reason: "Clearer delivery, no verbal stumbles.",
        materialDefects: [],
      },
      { actorId: "chris" },
    );
    expect(selection.selectedMediaAssetId).toBe(take1.id);

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("TAKE_SELECTED");

    const latest = await getLatestTakeSelection(prisma, item.id);
    expect(latest?.id).toBe(selection.id);
  });

  it("rejects take selection from a state other than MEDIA_INGESTED", async () => {
    const item = await createContentItem(prisma, { title: "Wrong state idea" }, {
      actorId: "test-user",
    });
    const asset = await createMediaAsset(
      prisma,
      {
        contentItemId: item.id,
        kind: "RAW_TAKE",
        storageKey: `raw/${item.id}/x.mp4`,
        originalFilename: "x.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1,
      },
      { actorId: "chris" },
    );

    await expect(
      recordTakeSelection(
        prisma,
        {
          contentItemId: item.id,
          selectedMediaAssetId: asset.id,
          confidence: 0.5,
          reason: "x",
        },
        { actorId: "chris" },
      ),
    ).rejects.toBeInstanceOf(TakeSelectionRequiresMediaIngestedStateError);
  });
});
