import { describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { createMediaAsset, recordPersonMatte } from "../media-asset";

async function makeAsset(kind: "RAW_TAKE" | "MUSIC" = "RAW_TAKE") {
  const item = await createContentItem(prisma, { title: "Person matte test" }, { actorId: "test-user" });
  const asset = await createMediaAsset(
    prisma,
    {
      contentItemId: item.id,
      kind,
      storageKey: `${kind === "MUSIC" ? "music" : "raw"}/${item.id}/a.${kind === "MUSIC" ? "m4a" : "mp4"}`,
      originalFilename: kind === "MUSIC" ? "a.m4a" : "a.mp4",
      mimeType: kind === "MUSIC" ? "audio/mp4" : "video/mp4",
      sizeBytes: 10,
    },
    { actorId: "chris" },
  );
  return { item, asset };
}

describe("recordPersonMatte", () => {
  it("stores the matte key and audit-logs before/after with provenance", async () => {
    const { item, asset } = await makeAsset();
    const key = `mattes/${item.id}/${asset.id}.mp4`;
    const updated = await recordPersonMatte(prisma, asset.id, key, { actorId: "worker" }, { model: "modnet", fps: 30, coverage: 0.4 });
    expect(updated.matteStorageKey).toBe(key);
    const again = await recordPersonMatte(prisma, asset.id, key, { actorId: "worker" });
    expect(again.matteStorageKey).toBe(key);
    const audits = await prisma.auditLog.findMany({ where: { entityId: item.id, action: "MEDIA_ASSET_PERSON_MATTED" }, orderBy: { createdAt: "asc" } });
    expect(audits).toHaveLength(2);
    expect(audits[0]!.before).toMatchObject({ mediaAssetId: asset.id, matteStorageKey: null });
    expect(audits[1]!.before).toMatchObject({ matteStorageKey: key });
    expect(audits[0]!.metadata).toMatchObject({ model: "modnet", fps: 30 });
  });

  it("refuses keys outside the item's mattes/ prefix and non-takes", async () => {
    const { item, asset } = await makeAsset();
    await expect(recordPersonMatte(prisma, asset.id, `raw/${item.id}/x.mp4`, { actorId: "w" })).rejects.toThrow(/must live under/);
    await expect(recordPersonMatte(prisma, asset.id, `mattes/other/x.mp4`, { actorId: "w" })).rejects.toThrow(/must live under/);
    const music = await makeAsset("MUSIC");
    await expect(recordPersonMatte(prisma, music.asset.id, `mattes/${music.item.id}/x.mp4`, { actorId: "w" })).rejects.toThrow(/raw takes only/);
  });
});
