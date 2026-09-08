import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prisma,
  createContentItem,
  applyTransition,
  recordPlatformPackage,
  recordApprovedOutcome,
  setAutonomyCeiling,
  getAutonomyState,
  AUTONOMY_LEVEL_THRESHOLDS,
  AUTONOMY_SHADOW_ONLY_FLAG,
  setFlag,
} from "@chris/domain";
import { LocalFsStorageAdapter } from "@chris/media";
import { MockPlatformAdapter } from "@chris/platforms";
import { tryAutonomousPublish } from "../autonomous-publish-job";

/** `AutonomyLevel` is a global row per (subsystem, productionTier) — see
 * /docs/DECISIONS.md's autonomy test-collision entry. Every test that depends on a known
 * starting level resets its own pair first. */
async function resetAutonomyLevel(productionTier: "RAW" | "FAST" | "MEDIUM" | "HERO") {
  await prisma.autonomyLevel.deleteMany({ where: { subsystem: "PUBLISHING", productionTier } });
}

describe("tryAutonomousPublish", () => {
  let storageDir: string;
  let storage: LocalFsStorageAdapter;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "chris-autonomous-publish-test-"));
    storage = new LocalFsStorageAdapter({ baseDir: storageDir });
    await setFlag(prisma, { key: AUTONOMY_SHADOW_ONLY_FLAG, enabled: false, actor: "test", actorType: "HUMAN" });
  });

  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  async function makeReadyItem(productionTier: "RAW" | "FAST" | "MEDIUM" | "HERO", platform: "INSTAGRAM" = "INSTAGRAM") {
    const item = await createContentItem(prisma, { title: `Autonomous publish test (${productionTier})` }, {
      actorId: "test-user",
    });
    for (const to of [
      "SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED",
      "READY_TO_FILM", "FILMED", "MEDIA_INGESTED", "TAKE_SELECTED",
    ] as const) {
      await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
    }
    const asset = await prisma.mediaAsset.create({
      data: { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/${item.id}/t.mp4`, originalFilename: "t.mp4", mimeType: "video/mp4", sizeBytes: 4 },
    });
    const takeSelection = await prisma.takeSelection.create({
      data: { contentItemId: item.id, selectedMediaAssetId: asset.id, confidence: 0.9, reason: "only take", materialDefects: [] },
    });
    const editPlan = await prisma.editPlan.create({
      data: { contentItemId: item.id, takeSelectionId: takeSelection.id, productionTier, targetDurationSeconds: 4, plan: {} },
    });
    await applyTransition(prisma, { contentItemId: item.id, to: "EDIT_PLANNED", actorType: "SYSTEM" });
    await applyTransition(prisma, { contentItemId: item.id, to: "EDITING", actorType: "SYSTEM" });
    const renderKey = `renders/${item.id}/v1.mp4`;
    await storage.put(renderKey, Buffer.from("fake mp4 bytes"));
    await prisma.render.create({
      data: { contentItemId: item.id, editPlanId: editPlan.id, status: "SUCCESS", storageKey: renderKey, technicalQCReport: { overall: "PASS", checks: [] } },
    });
    await applyTransition(prisma, { contentItemId: item.id, to: "RENDERED", actorType: "SYSTEM" });
    await applyTransition(prisma, { contentItemId: item.id, to: "READY", actorType: "SYSTEM" });

    await recordPlatformPackage(
      prisma,
      { contentItemId: item.id, platform, caption: "Autonomous publish test caption.", hashtags: [] },
      { actorId: "chris" },
    );

    return item;
  }

  it("does not publish when the tier hasn't earned PUBLISHING level 3 yet", async () => {
    await resetAutonomyLevel("FAST");
    const item = await makeReadyItem("FAST");
    const instagram = new MockPlatformAdapter("INSTAGRAM");

    const result = await tryAutonomousPublish(prisma, storage, { INSTAGRAM: instagram }, item.id, { actorId: "chris" });

    expect(result.attempted).toBe(false);
    expect(result.reason).toContain("level 3");
    expect(instagram.publishCalls).toHaveLength(0);

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("READY"); // untouched — still needs a human
  });

  it("publishes autonomously once the tier has genuinely earned level 3", async () => {
    await resetAutonomyLevel("FAST");
    for (let i = 0; i < AUTONOMY_LEVEL_THRESHOLDS[3]!; i++) {
      await recordApprovedOutcome(prisma, "PUBLISHING", "FAST", { actorId: "system" });
    }
    const earned = await getAutonomyState(prisma, "PUBLISHING", "FAST");
    expect(earned.level).toBeGreaterThanOrEqual(3);

    const item = await makeReadyItem("FAST");
    const instagram = new MockPlatformAdapter("INSTAGRAM");

    const result = await tryAutonomousPublish(prisma, storage, { INSTAGRAM: instagram }, item.id, { actorId: "chris" });

    expect(result.attempted).toBe(true);
    expect(result.publishResult?.succeededPlatforms).toEqual(["INSTAGRAM"]);
    expect(instagram.publishCalls).toHaveLength(1);

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("PUBLISHED"); // no human click — genuinely autonomous
  });

  /** The literal Phase 8 acceptance criterion, at the worker/orchestration level this time —
   * proving HERO's ceiling actually changes real system behavior, not just a database row. */
  it("HERO stays gated behind manual publish even when FAST has earned autonomy on the same subsystem", async () => {
    await resetAutonomyLevel("HERO");
    await setAutonomyCeiling(prisma, "PUBLISHING", "HERO", 1, { actorId: "chris" });
    for (let i = 0; i < AUTONOMY_LEVEL_THRESHOLDS[3]!; i++) {
      await recordApprovedOutcome(prisma, "PUBLISHING", "HERO", { actorId: "system" });
    }
    const heroState = await getAutonomyState(prisma, "PUBLISHING", "HERO");
    expect(heroState.level).toBe(1); // capped, despite plenty of raw "outcomes"

    const item = await makeReadyItem("HERO");
    const instagram = new MockPlatformAdapter("INSTAGRAM");

    const result = await tryAutonomousPublish(prisma, storage, { INSTAGRAM: instagram }, item.id, { actorId: "chris" });

    expect(result.attempted).toBe(false);
    expect(instagram.publishCalls).toHaveLength(0);
    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("READY"); // still needs Chris, permanently, by policy
  });

  it("the global shadow_only kill switch blocks autonomous publish even at a fully-earned level", async () => {
    await resetAutonomyLevel("RAW");
    for (let i = 0; i < AUTONOMY_LEVEL_THRESHOLDS[4]!; i++) {
      await recordApprovedOutcome(prisma, "PUBLISHING", "RAW", { actorId: "system" });
    }
    const item = await makeReadyItem("RAW");
    const instagram = new MockPlatformAdapter("INSTAGRAM");

    await setFlag(prisma, { key: AUTONOMY_SHADOW_ONLY_FLAG, enabled: true, actor: "test", actorType: "HUMAN" });
    try {
      const result = await tryAutonomousPublish(prisma, storage, { INSTAGRAM: instagram }, item.id, { actorId: "chris" });
      expect(result.attempted).toBe(false);
      expect(instagram.publishCalls).toHaveLength(0);
    } finally {
      await setFlag(prisma, { key: AUTONOMY_SHADOW_ONLY_FLAG, enabled: false, actor: "test", actorType: "HUMAN" });
    }
  });

  it("is a graceful no-op (not a throw) when no PlatformPackage exists yet", async () => {
    await resetAutonomyLevel("MEDIUM");
    for (let i = 0; i < AUTONOMY_LEVEL_THRESHOLDS[3]!; i++) {
      await recordApprovedOutcome(prisma, "PUBLISHING", "MEDIUM", { actorId: "system" });
    }

    const item = await createContentItem(prisma, { title: "No package yet" }, { actorId: "test" });
    for (const to of [
      "SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED",
      "READY_TO_FILM", "FILMED", "MEDIA_INGESTED", "TAKE_SELECTED",
    ] as const) {
      await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
    }
    const asset = await prisma.mediaAsset.create({
      data: { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/${item.id}/t.mp4`, originalFilename: "t.mp4", mimeType: "video/mp4", sizeBytes: 1 },
    });
    const takeSelection = await prisma.takeSelection.create({
      data: { contentItemId: item.id, selectedMediaAssetId: asset.id, confidence: 0.9, reason: "x", materialDefects: [] },
    });
    const editPlan = await prisma.editPlan.create({
      data: { contentItemId: item.id, takeSelectionId: takeSelection.id, productionTier: "MEDIUM", targetDurationSeconds: 4, plan: {} },
    });
    await applyTransition(prisma, { contentItemId: item.id, to: "EDIT_PLANNED", actorType: "SYSTEM" });
    await applyTransition(prisma, { contentItemId: item.id, to: "EDITING", actorType: "SYSTEM" });
    await prisma.render.create({
      data: { contentItemId: item.id, editPlanId: editPlan.id, status: "SUCCESS", storageKey: `renders/${item.id}/v1.mp4`, technicalQCReport: { overall: "PASS", checks: [] } },
    });
    await applyTransition(prisma, { contentItemId: item.id, to: "RENDERED", actorType: "SYSTEM" });
    await applyTransition(prisma, { contentItemId: item.id, to: "READY", actorType: "SYSTEM" });
    // Deliberately no recordPlatformPackage call.

    const result = await tryAutonomousPublish(prisma, storage, {}, item.id, { actorId: "chris" });
    expect(result.attempted).toBe(false);
    expect(result.reason).toContain("PlatformPackage");
  });
});
