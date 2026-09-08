import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import { recordPlatformPackage, PlatformPackageRequiresRenderError } from "../platform-package";
import { runPreflight, computePublishIdempotencyKey } from "../preflight";
import { scheduleContentItemForPublishing, ScheduleForPublishingRequiresReadyStateError } from "../schedule";
import {
  startPublishing,
  recordPublicationAttempt,
  finalizePublishing,
  getLatestPublication,
  listPublicationsForContentItem,
  PublishingRequiresScheduledStateError,
} from "../publication";
import { getAutonomyState } from "../autonomy";

/** Drives a ContentItem all the way to READY, the real prerequisite for everything in this
 * file — Phase 5 builds on top of Phase 3/4's real render + quality-gate machinery, not a
 * shortcut past it. */
async function makeReadyItem() {
  const item = await createContentItem(prisma, { title: "Publish pipeline test idea" }, {
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
    "TAKE_SELECTED",
    "EDIT_PLANNED",
    "EDITING",
    "RENDERED",
  ] as const) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
  }

  const takeSelection = await prisma.takeSelection.create({
    data: { contentItemId: item.id, selectedMediaAssetId: (await prisma.mediaAsset.create({
      data: { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/${item.id}/t.mp4`, originalFilename: "t.mp4", mimeType: "video/mp4", sizeBytes: 1 },
    })).id, confidence: 0.9, reason: "only take", materialDefects: [] },
  });
  const editPlan = await prisma.editPlan.create({
    data: { contentItemId: item.id, takeSelectionId: takeSelection.id, productionTier: "FAST", targetDurationSeconds: 4, plan: {} },
  });
  await prisma.render.create({
    data: {
      contentItemId: item.id,
      editPlanId: editPlan.id,
      status: "SUCCESS",
      storageKey: `renders/${item.id}/v1.mp4`,
      technicalQCReport: { overall: "PASS", checks: [] },
    },
  });

  await applyTransition(prisma, { contentItemId: item.id, to: "READY", actorType: "SYSTEM" });
  return item;
}

describe("recordPlatformPackage", () => {
  it("requires READY or SCHEDULED — rejects earlier states", async () => {
    const item = await createContentItem(prisma, { title: "Too early for packaging" }, { actorId: "test" });
    await expect(
      recordPlatformPackage(
        prisma,
        { contentItemId: item.id, platform: "INSTAGRAM", caption: "x", hashtags: [] },
        { actorId: "chris" },
      ),
    ).rejects.toBeInstanceOf(PlatformPackageRequiresRenderError);
  });

  it("records a package once the item is READY", async () => {
    const item = await makeReadyItem();
    const pkg = await recordPlatformPackage(
      prisma,
      { contentItemId: item.id, platform: "INSTAGRAM", caption: "A real caption.", hashtags: ["#money"] },
      { actorId: "chris" },
    );
    expect(pkg.platform).toBe("INSTAGRAM");
    expect(pkg.caption).toBe("A real caption.");
  });
});

describe("scheduleContentItemForPublishing", () => {
  it("rejects from any state other than READY or SCHEDULED", async () => {
    const item = await createContentItem(prisma, { title: "Not ready" }, { actorId: "test" });
    await expect(
      scheduleContentItemForPublishing(
        prisma,
        { contentItemId: item.id, scheduledDate: new Date(), targetPlatforms: ["INSTAGRAM"] },
        { actorId: "chris" },
      ),
    ).rejects.toBeInstanceOf(ScheduleForPublishingRequiresReadyStateError);
  });

  it("transitions READY -> SCHEDULED and records target platforms", async () => {
    const item = await makeReadyItem();
    const entry = await scheduleContentItemForPublishing(
      prisma,
      { contentItemId: item.id, scheduledDate: new Date(), targetPlatforms: ["INSTAGRAM", "YOUTUBE"] },
      { actorId: "chris" },
    );
    expect(entry.targetPlatforms).toEqual(["INSTAGRAM", "YOUTUBE"]);
    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("SCHEDULED");
  });

  it("re-placing an already-SCHEDULED item updates the slot without a state transition (the Calendar reschedule path)", async () => {
    const item = await makeReadyItem();
    const firstDate = new Date("2026-09-14T15:00:00Z");
    await scheduleContentItemForPublishing(
      prisma,
      { contentItemId: item.id, scheduledDate: firstDate, targetPlatforms: ["INSTAGRAM"] },
      { actorId: "chris" },
    );
    const transitionCountBefore = await prisma.contentStateTransition.count({
      where: { contentItemId: item.id },
    });

    const secondDate = new Date("2026-09-21T18:00:00Z");
    const entry = await scheduleContentItemForPublishing(
      prisma,
      { contentItemId: item.id, scheduledDate: secondDate, targetPlatforms: ["TIKTOK", "YOUTUBE"] },
      { actorId: "chris" },
    );

    expect(entry.scheduledDate.toISOString()).toBe(secondDate.toISOString());
    expect(entry.targetPlatforms).toEqual(["TIKTOK", "YOUTUBE"]);
    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("SCHEDULED"); // unchanged — still SCHEDULED, not re-transitioned
    const transitionCountAfter = await prisma.contentStateTransition.count({
      where: { contentItemId: item.id },
    });
    expect(transitionCountAfter).toBe(transitionCountBefore); // no new transition row

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: item.id, action: "SCHEDULE_RESCHEDULED" },
    });
    expect(audit).not.toBeNull();
  });
});

async function makeScheduledItemWithPackage(platforms: ("INSTAGRAM" | "TIKTOK" | "YOUTUBE")[]) {
  const item = await makeReadyItem();
  const packages: Record<string, string> = {};
  for (const platform of platforms) {
    const pkg = await recordPlatformPackage(
      prisma,
      { contentItemId: item.id, platform, caption: `Caption for ${platform}`, hashtags: [] },
      { actorId: "chris" },
    );
    packages[platform] = pkg.id;
  }
  await scheduleContentItemForPublishing(
    prisma,
    { contentItemId: item.id, scheduledDate: new Date(), targetPlatforms: platforms },
    { actorId: "chris" },
  );
  return { item, packages };
}

describe("runPreflight", () => {
  it("PASSes when everything required is present", async () => {
    const { item, packages } = await makeScheduledItemWithPackage(["INSTAGRAM"]);
    const result = await runPreflight(prisma, {
      contentItemId: item.id,
      platform: "INSTAGRAM",
      credentialsOk: true,
      mediaHash: "abc123",
    });
    expect(result.status).toBe("PASS");
    void packages;
  });

  it("BLOCKs (with specific reasons) when credentials aren't configured", async () => {
    const { item } = await makeScheduledItemWithPackage(["TIKTOK"]);
    const result = await runPreflight(prisma, {
      contentItemId: item.id,
      platform: "TIKTOK",
      credentialsOk: false,
      credentialsReason: "No TikTok credentials configured.",
      mediaHash: "abc123",
    });
    expect(result.status).toBe("BLOCK");
    if (result.status === "BLOCK") {
      expect(result.reasons).toContain("No TikTok credentials configured.");
    }
  });

  it("BLOCKs when the platform wasn't actually scheduled as a target", async () => {
    const { item } = await makeScheduledItemWithPackage(["INSTAGRAM"]);
    // TIKTOK was never scheduled or packaged for this item.
    const result = await runPreflight(prisma, {
      contentItemId: item.id,
      platform: "TIKTOK",
      credentialsOk: true,
      mediaHash: "abc123",
    });
    expect(result.status).toBe("BLOCK");
    if (result.status === "BLOCK") {
      expect(result.reasons.some((r) => r.includes("target platforms"))).toBe(true);
      expect(result.reasons.some((r) => r.includes("packaging"))).toBe(true);
    }
  });

  it("BLOCKs when no media hash was computed", async () => {
    const { item } = await makeScheduledItemWithPackage(["YOUTUBE"]);
    const result = await runPreflight(prisma, {
      contentItemId: item.id,
      platform: "YOUTUBE",
      credentialsOk: true,
      mediaHash: null,
    });
    expect(result.status).toBe("BLOCK");
    if (result.status === "BLOCK") {
      expect(result.reasons.some((r) => r.toLowerCase().includes("hash"))).toBe(true);
    }
  });

  it("computePublishIdempotencyKey is stable per (item, platform)", async () => {
    const key1 = computePublishIdempotencyKey("item-1", "INSTAGRAM");
    const key2 = computePublishIdempotencyKey("item-1", "INSTAGRAM");
    const key3 = computePublishIdempotencyKey("item-1", "TIKTOK");
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
  });
});

describe("startPublishing / recordPublicationAttempt / finalizePublishing", () => {
  it("startPublishing rejects from any state other than SCHEDULED", async () => {
    const item = await createContentItem(prisma, { title: "Not scheduled" }, { actorId: "test" });
    await expect(startPublishing(prisma, item.id, { actorId: "chris" })).rejects.toBeInstanceOf(
      PublishingRequiresScheduledStateError,
    );
  });

  it("all platforms succeeding lands the item at PUBLISHED", async () => {
    const { item, packages } = await makeScheduledItemWithPackage(["INSTAGRAM", "YOUTUBE"]);
    await startPublishing(prisma, item.id, { actorId: "chris" });

    for (const platform of ["INSTAGRAM", "YOUTUBE"] as const) {
      await recordPublicationAttempt(
        prisma,
        {
          contentItemId: item.id,
          platform,
          platformPackageId: packages[platform]!,
          idempotencyKey: computePublishIdempotencyKey(item.id, platform),
          status: "SUCCESS",
          platformPostId: `${platform}-post-1`,
          url: `https://example.invalid/${platform}`,
        },
        { actorId: "chris" },
      );
    }

    const result = await finalizePublishing(prisma, item.id, { actorId: "chris" });
    expect(result.transitioned).toBe(true);
    expect(result.succeededPlatforms.sort()).toEqual(["INSTAGRAM", "YOUTUBE"]);
    expect(result.failedPlatforms).toEqual([]);

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("PUBLISHED");
  });

  /** Phase 8 wiring — every target platform succeeding is the real reliability signal,
   * feeding AutonomyLevel automatically as a side effect of the real pipeline. */
  it("all-platforms-succeeded records an approved outcome for PUBLISHING at this item's tier", async () => {
    const before = await getAutonomyState(prisma, "PUBLISHING", "FAST");
    const { item, packages } = await makeScheduledItemWithPackage(["INSTAGRAM"]);
    await startPublishing(prisma, item.id, { actorId: "chris" });
    await recordPublicationAttempt(
      prisma,
      {
        contentItemId: item.id,
        platform: "INSTAGRAM",
        platformPackageId: packages.INSTAGRAM!,
        idempotencyKey: computePublishIdempotencyKey(item.id, "INSTAGRAM"),
        status: "SUCCESS",
        platformPostId: "ig-post-1",
      },
      { actorId: "chris" },
    );
    await finalizePublishing(prisma, item.id, { actorId: "chris" });

    const after = await getAutonomyState(prisma, "PUBLISHING", "FAST");
    expect(after.approvedOutcomeCount).toBe(before.approvedOutcomeCount + 1);
  });

  /** The literal Phase 5 acceptance criterion: "partial platform failure (the other platforms
   * still proceed)." One platform failing must not prevent the others from succeeding, and
   * must not prevent the item from reaching PUBLISHED overall. */
  it("one platform failing does not block the others, and the item still reaches PUBLISHED", async () => {
    const before = await getAutonomyState(prisma, "PUBLISHING", "FAST");
    const { item, packages } = await makeScheduledItemWithPackage(["INSTAGRAM", "TIKTOK", "YOUTUBE"]);
    await startPublishing(prisma, item.id, { actorId: "chris" });

    await recordPublicationAttempt(
      prisma,
      {
        contentItemId: item.id,
        platform: "INSTAGRAM",
        platformPackageId: packages.INSTAGRAM!,
        idempotencyKey: computePublishIdempotencyKey(item.id, "INSTAGRAM"),
        status: "SUCCESS",
        platformPostId: "ig-post-1",
      },
      { actorId: "chris" },
    );
    await recordPublicationAttempt(
      prisma,
      {
        contentItemId: item.id,
        platform: "TIKTOK",
        platformPackageId: packages.TIKTOK!,
        idempotencyKey: computePublishIdempotencyKey(item.id, "TIKTOK"),
        status: "FAILED",
        errorMessage: "simulated TikTok outage",
      },
      { actorId: "chris" },
    );
    await recordPublicationAttempt(
      prisma,
      {
        contentItemId: item.id,
        platform: "YOUTUBE",
        platformPackageId: packages.YOUTUBE!,
        idempotencyKey: computePublishIdempotencyKey(item.id, "YOUTUBE"),
        status: "SUCCESS",
        platformPostId: "yt-post-1",
      },
      { actorId: "chris" },
    );

    const result = await finalizePublishing(prisma, item.id, { actorId: "chris" });
    expect(result.succeededPlatforms.sort()).toEqual(["INSTAGRAM", "YOUTUBE"]);
    expect(result.failedPlatforms).toEqual(["TIKTOK"]);
    expect(result.transitioned).toBe(true); // PUBLISHED anyway — 2 of 3 succeeded

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("PUBLISHED");

    // TikTok's failure is real, queryable evidence, not silently dropped.
    const tiktokPub = await getLatestPublication(prisma, item.id, "TIKTOK");
    expect(tiktokPub?.status).toBe("FAILED");
    expect(tiktokPub?.errorMessage).toContain("simulated TikTok outage");

    // Phase 8 wiring — a partial-failure publish is a real success (graceful degradation
    // working as designed) but deliberately not the "reliability" signal AutonomyLevel tracks.
    const after = await getAutonomyState(prisma, "PUBLISHING", "FAST");
    expect(after.approvedOutcomeCount).toBe(before.approvedOutcomeCount);
  });

  it("every platform failing leaves the item at PUBLISHING, not silently stuck with no signal", async () => {
    const { item, packages } = await makeScheduledItemWithPackage(["TIKTOK"]);
    await startPublishing(prisma, item.id, { actorId: "chris" });
    await recordPublicationAttempt(
      prisma,
      {
        contentItemId: item.id,
        platform: "TIKTOK",
        platformPackageId: packages.TIKTOK!,
        idempotencyKey: computePublishIdempotencyKey(item.id, "TIKTOK"),
        status: "FAILED",
        errorMessage: "simulated outage",
      },
      { actorId: "chris" },
    );

    const result = await finalizePublishing(prisma, item.id, { actorId: "chris" });
    expect(result.transitioned).toBe(false);
    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("PUBLISHING");
  });

  it("a DRAFT outcome (TikTok's audit-gated fallback) counts as success, not failure", async () => {
    const { item, packages } = await makeScheduledItemWithPackage(["TIKTOK"]);
    await startPublishing(prisma, item.id, { actorId: "chris" });
    await recordPublicationAttempt(
      prisma,
      {
        contentItemId: item.id,
        platform: "TIKTOK",
        platformPackageId: packages.TIKTOK!,
        idempotencyKey: computePublishIdempotencyKey(item.id, "TIKTOK"),
        status: "DRAFT",
        platformPostId: "draft-1",
        errorMessage: "App is not TikTok-audited — posted as private.",
      },
      { actorId: "chris" },
    );

    const result = await finalizePublishing(prisma, item.id, { actorId: "chris" });
    expect(result.succeededPlatforms).toEqual(["TIKTOK"]);
    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("PUBLISHED");
  });

  it("recordPublicationAttempt is append-only — attempt numbers increment per platform", async () => {
    const { item, packages } = await makeScheduledItemWithPackage(["INSTAGRAM"]);
    await startPublishing(prisma, item.id, { actorId: "chris" });

    await recordPublicationAttempt(
      prisma,
      {
        contentItemId: item.id,
        platform: "INSTAGRAM",
        platformPackageId: packages.INSTAGRAM!,
        idempotencyKey: computePublishIdempotencyKey(item.id, "INSTAGRAM"),
        status: "FAILED",
        errorMessage: "transient error",
      },
      { actorId: "chris" },
    );
    await recordPublicationAttempt(
      prisma,
      {
        contentItemId: item.id,
        platform: "INSTAGRAM",
        platformPackageId: packages.INSTAGRAM!,
        idempotencyKey: computePublishIdempotencyKey(item.id, "INSTAGRAM"),
        status: "SUCCESS",
        platformPostId: "ig-post-retry-1",
      },
      { actorId: "chris" },
    );

    const all = await listPublicationsForContentItem(prisma, item.id);
    expect(all.map((p) => p.attempt)).toEqual([2, 1]); // most recent first
    const latest = await getLatestPublication(prisma, item.id, "INSTAGRAM");
    expect(latest?.status).toBe("SUCCESS");
    expect(latest?.attempt).toBe(2);
  });
});
