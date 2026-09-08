import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { createMediaAsset, listMediaAssetsForContentItem, getMediaAsset } from "../media-asset";

describe("media assets (raw upload)", () => {
  it("records an uploaded raw take against a content item", async () => {
    const item = await createContentItem(prisma, { title: "Upload test idea" }, {
      actorId: "test-user",
    });

    const asset = await createMediaAsset(
      prisma,
      {
        contentItemId: item.id,
        kind: "RAW_TAKE",
        storageKey: `raw/${item.id}/take-1.mp4`,
        originalFilename: "take-1.mp4",
        mimeType: "video/mp4",
        sizeBytes: 12_345,
      },
      { actorId: "chris" },
    );

    expect(asset.contentItemId).toBe(item.id);

    const listed = await listMediaAssetsForContentItem(prisma, item.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(asset.id);

    const fetched = await getMediaAsset(prisma, asset.id);
    expect(fetched?.originalFilename).toBe("take-1.mp4");
  });

  it("audit-logs the upload against the content item", async () => {
    const item = await createContentItem(prisma, { title: "Upload audit test" }, {
      actorId: "test-user",
    });
    await createMediaAsset(
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

    const audit = await prisma.auditLog.findMany({
      where: { entityType: "ContentItem", entityId: item.id, action: "MEDIA_ASSET_UPLOADED" },
    });
    expect(audit).toHaveLength(1);
  });
});
