import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { createContentItemFromFootage } from "../footage-first";
import { createMediaAsset } from "../media-asset";
import { deleteVideo } from "../delete-video";

const actor = { actorId: "chris" };

describe("deleteVideo", () => {
  it("cancels a planned (no footage) video, keeps history, idempotent", async () => {
    const item = await createContentItem(prisma, { title: "Delete me (planned)" }, actor);
    const r = await deleteVideo(prisma, { contentItemId: item.id }, actor);
    expect(r.deleted).toBe(true);
    const after = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.currentState).toBe("CANCELLED");
    expect(await prisma.contentStateTransition.count({ where: { contentItemId: item.id, toState: "CANCELLED" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: item.id, action: "VIDEO_DELETED" } })).toBe(1);
    const again = await deleteVideo(prisma, { contentItemId: item.id }, actor);
    expect(again.deleted).toBe(false);
  });

  it("returns every media storage key of a filmed video for removal", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "Delete me (filmed)" }, actor);
    await createMediaAsset(prisma, { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/${item.id}/a.mp4`, originalFilename: "a.mp4", mimeType: "video/mp4", sizeBytes: 10 }, actor);
    const r = await deleteVideo(prisma, { contentItemId: item.id }, actor);
    expect(r.storageKeys).toContain(`raw/${item.id}/a.mp4`);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("CANCELLED");
    expect(await prisma.mediaAsset.count({ where: { contentItemId: item.id } })).toBe(1); // history rows kept
  });
});
