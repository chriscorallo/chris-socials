import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import { createMediaAsset, analyzeMediaAsset } from "../media-asset";

async function makeFilmedItem() {
  const item = await createContentItem(prisma, { title: "Media analysis test idea" }, {
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
  ] as const) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
  }
  return item;
}

describe("media analysis", () => {
  it("analyzing a take for a FILMED item transitions it to MEDIA_INGESTED", async () => {
    const item = await makeFilmedItem();
    const asset = await createMediaAsset(
      prisma,
      {
        contentItemId: item.id,
        kind: "RAW_TAKE",
        storageKey: `raw/${item.id}/take-1.mp4`,
        originalFilename: "take-1.mp4",
        mimeType: "video/mp4",
        sizeBytes: 12345,
      },
      { actorId: "chris" },
    );

    const analyzed = await analyzeMediaAsset(
      prisma,
      asset.id,
      {
        durationSeconds: 45.2,
        width: 1080,
        height: 1920,
        frameRate: 30,
        hasAudio: true,
        videoCodec: "h264",
        audioCodec: "aac",
        transcript: "Okay so here's the thing about credit scores...",
      },
      { actorId: "chris" },
    );
    expect(analyzed.durationSeconds).toBeCloseTo(45.2);
    expect(analyzed.transcript).toContain("credit scores");

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("MEDIA_INGESTED");
  });

  it("analyzing a second take for an already-MEDIA_INGESTED item does not re-transition or error", async () => {
    const item = await makeFilmedItem();
    const asset1 = await createMediaAsset(
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
    await analyzeMediaAsset(
      prisma,
      asset1.id,
      {
        durationSeconds: 10,
        width: 1080,
        height: 1920,
        frameRate: 30,
        hasAudio: true,
        videoCodec: "h264",
        audioCodec: "aac",
      },
      { actorId: "chris" },
    );

    const asset2 = await createMediaAsset(
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
    await analyzeMediaAsset(
      prisma,
      asset2.id,
      {
        durationSeconds: 12,
        width: 1080,
        height: 1920,
        frameRate: 30,
        hasAudio: true,
        videoCodec: "h264",
        audioCodec: "aac",
      },
      { actorId: "chris" },
    );

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("MEDIA_INGESTED");

    const transitions = await prisma.contentStateTransition.findMany({
      where: { contentItemId: item.id, toState: "MEDIA_INGESTED" },
    });
    expect(transitions).toHaveLength(1);
  });
});
