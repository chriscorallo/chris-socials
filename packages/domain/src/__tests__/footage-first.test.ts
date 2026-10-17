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

describe("unschedule (Remove from calendar)", () => {
  it("moves SCHEDULED back to READY, removes the schedule entry, keeps history; refuses otherwise", async () => {
    const { applyTransition } = await import("../state-machine");
    const { scheduleContentItemForPublishing, unscheduleContentItem, UnscheduleRequiresScheduledStateError } = await import("../schedule");
    const item = await createContentItemFromFootage(prisma, { title: "Unschedule me" }, { actorId: "chris" });
    for (const to of ["MEDIA_INGESTED", "TAKE_SELECTED", "EDIT_PLANNED", "EDITING", "RENDERED", "READY"] as const) {
      await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
    }
    await scheduleContentItemForPublishing(prisma, { contentItemId: item.id, scheduledDate: new Date(Date.now() + 86400000), targetPlatforms: ["TIKTOK"] }, { actorId: "chris" });
    await unscheduleContentItem(prisma, item.id, { actorId: "chris" });
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("READY");
    expect(await prisma.scheduleEntry.findUnique({ where: { contentItemId: item.id } })).toBeNull();
    const last = await prisma.contentStateTransition.findFirst({ where: { contentItemId: item.id }, orderBy: { createdAt: "desc" } });
    expect(last?.fromState).toBe("SCHEDULED");
    await expect(unscheduleContentItem(prisma, item.id, { actorId: "chris" })).rejects.toBeInstanceOf(UnscheduleRequiresScheduledStateError);
  });
});
