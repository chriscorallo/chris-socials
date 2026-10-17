import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItemFromFootage } from "../footage-first";
import { createMediaAsset, analyzeMediaAsset } from "../media-asset";

describe("footage-first upload", () => {
  it("creates an item ready for takes, with honest history and a contract that is NOT fact-check-exempt", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "My filmed video" }, { actorId: "chris" });
    expect(item.currentState).toBe("FILMED");
    const contract = await prisma.productionContract.findUniqueOrThrow({ where: { contentItemId: item.id } });
    expect(contract.researchDepth === "NONE" && contract.factualRisk === "LOW").toBe(false);
    const transitions = await prisma.contentStateTransition.findMany({ where: { contentItemId: item.id } });
    expect(transitions.filter((t) => t.reason?.startsWith("Footage-first")).length).toBeGreaterThanOrEqual(7);

    const take = await createMediaAsset(prisma, { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/${item.id}/a.mp4`, originalFilename: "a.mp4", mimeType: "video/mp4", sizeBytes: 1 }, { actorId: "chris" });
    await analyzeMediaAsset(prisma, take.id, { durationSeconds: 10, width: 1080, height: 1920, frameRate: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }, { actorId: "chris" });
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("MEDIA_INGESTED");
  });

  it("falls back to a title when given a blank one", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "   " }, { actorId: "chris" });
    expect(item.title).toBe("Untitled video");
  });
});
