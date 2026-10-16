import {
  prisma,
  createContentItem,
  applyTransition,
  recordPlatformPackage,
  scheduleContentItemForPublishing,
} from "@chris/domain";
import type { LocalFsStorageAdapter } from "@chris/media";

export type TestPlatform = "INSTAGRAM" | "TIKTOK" | "YOUTUBE";

export const PRE_RENDER_STATES = [
  "SELECTED",
  "CONTRACTED",
  "RESEARCHING",
  "RESEARCHED",
  "SCRIPTING",
  "SCRIPTED",
  "READY_TO_FILM",
  "FILMED",
  "MEDIA_INGESTED",
  "TAKE_SELECTED",
  "EDIT_PLANNED",
  "EDITING",
  "RENDERED",
] as const;

/** Fast publish-path defaults for tests: no real sleeps, a fake public URL provider. */
export const FAST_PUBLISH_OPTIONS = {
  verifyDelaysMs: [0],
  sleep: async () => {},
  getPublicVideoUrl: async (key: string) => `https://blob.example.invalid/${key}`,
};

/**
 * A READY item with a real render file in storage, a 1080x1920 30s render, a QC report (PASS
 * unless overridden), one PlatformPackage per platform — then scheduled (READY -> SCHEDULED).
 */
export async function makeScheduledPublishableItem(
  storage: LocalFsStorageAdapter,
  platforms: TestPlatform[],
  options: {
    qc?: "PASS" | "BLOCK" | null;
    scheduledDate?: Date;
    schedule?: boolean;
    productionTier?: "FAST" | "STANDARD" | "PREMIUM";
  } = {},
) {
  const item = await createContentItem(prisma, { title: "Publish test idea" }, { actorId: "test-user" });
  for (const to of PRE_RENDER_STATES) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
  }
  const asset = await prisma.mediaAsset.create({
    data: { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/${item.id}/t.mp4`, originalFilename: "t.mp4", mimeType: "video/mp4", sizeBytes: 4 },
  });
  const takeSelection = await prisma.takeSelection.create({
    data: { contentItemId: item.id, selectedMediaAssetId: asset.id, confidence: 0.9, reason: "only take", materialDefects: [] },
  });
  const editPlan = await prisma.editPlan.create({
    data: {
      contentItemId: item.id,
      takeSelectionId: takeSelection.id,
      productionTier: options.productionTier ?? "FAST",
      targetDurationSeconds: 30,
      plan: {},
    },
  });
  const renderKey = `renders/${item.id}/v1.mp4`;
  await storage.put(renderKey, Buffer.from("fake mp4 bytes for publish-job test"));
  const render = await prisma.render.create({
    data: {
      contentItemId: item.id,
      editPlanId: editPlan.id,
      status: "SUCCESS",
      storageKey: renderKey,
      technicalQCReport: { overall: "PASS", checks: [] },
      width: 1080,
      height: 1920,
      durationSeconds: 30,
      fileSizeBytes: 5_000_000,
    },
  });
  const qc = options.qc === undefined ? "PASS" : options.qc;
  if (qc !== null) {
    await prisma.qCReport.create({
      data: {
        contentItemId: item.id,
        renderId: render.id,
        factualStatus: "PASS",
        technicalStatus: qc,
        brandStatus: "PASS",
        creativeStatus: "PASS",
        overallStatus: qc,
        reasons: [],
      },
    });
  }
  await applyTransition(prisma, { contentItemId: item.id, to: "READY", actorType: "SYSTEM" });

  for (const platform of platforms) {
    await recordPlatformPackage(
      prisma,
      { contentItemId: item.id, platform, caption: `Caption for ${platform}`, hashtags: ["#learn"] },
      { actorId: "chris" },
    );
  }
  if (options.schedule !== false) {
    await scheduleContentItemForPublishing(
      prisma,
      { contentItemId: item.id, scheduledDate: options.scheduledDate ?? new Date(), targetPlatforms: platforms },
      { actorId: "chris" },
    );
  }
  return item;
}
