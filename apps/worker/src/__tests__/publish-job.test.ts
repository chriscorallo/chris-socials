import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prisma,
  createContentItem,
  applyTransition,
  recordPlatformPackage,
  scheduleContentItemForPublishing,
  getLatestPublication,
  listPublicationsForContentItem,
} from "@chris/domain";
import { LocalFsStorageAdapter } from "@chris/media";
import { MockPlatformAdapter, YOUTUBE_UPLOAD_DAILY_BUDGET } from "@chris/platforms";
import { publishContentItem } from "../publish-job";

/** A synthetic future day, snapped to noon UTC — see /docs/DECISIONS.md's youtube-quota
 * date-range fix. Using real "today" for the quota-exhaustion test below would mean
 * pre-filling ~100 real rows that pollute every other real-time YouTube quota check for the
 * rest of the actual day. Noon UTC (not "real now + 30 days", which preserves real now's
 * time-of-day) avoids a second, related bug this file originally had: when real now happens
 * to fall late in the UTC day, "+30 days" lands near that same late hour, and this test's own
 * "check 1 hour later" then rolls into the *next* UTC day — outside the very day-bucket the
 * quota query and the 100 filler rows below both live in. Caught by a real test failure, not
 * inspection — see /docs/DECISIONS.md. */
const FUTURE_QUOTA_DAY = new Date(
  Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000)) * 24 * 60 * 60 * 1000 +
    12 * 60 * 60 * 1000,
);

/** `FUTURE_QUOTA_DAY` floors to a calendar day, so repeated invocations of this file *within
 * the same real day* keep landing on the exact same synthetic day rather than a fresh one —
 * the same class of same-day accumulation already documented (and fixed) in
 * packages/platforms/src/__tests__/youtube-quota.test.ts. Both tests below that rely on
 * FUTURE_QUOTA_DAY having known-clean quota state call this first. */
async function clearYouTubeQuotaDayFillerRows() {
  const startOfDay = new Date(
    Date.UTC(FUTURE_QUOTA_DAY.getUTCFullYear(), FUTURE_QUOTA_DAY.getUTCMonth(), FUTURE_QUOTA_DAY.getUTCDate()),
  );
  const startOfNextDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  await prisma.publication.deleteMany({
    where: { platform: "YOUTUBE", createdAt: { gte: startOfDay, lt: startOfNextDay } },
  });
}

/**
 * The real proof of Phase 5's acceptance criteria (/docs/PHASE_PLAN.md): "publishing-mock
 * tests cover success, partial platform failure (the other platforms still proceed), and
 * idempotent retry of a publish call." Everything up through the render is real (real DB, real
 * state machine, a real file in real local storage); only the platform adapters are mocked —
 * exactly analogous to every other phase mocking its one genuinely-external dependency
 * (Anthropic API calls) while keeping everything else real.
 */
describe("publishContentItem (mock adapters, real everything else)", () => {
  let storageDir: string;
  let storage: LocalFsStorageAdapter;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "chris-publish-test-storage-"));
    storage = new LocalFsStorageAdapter({ baseDir: storageDir });
  });

  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  async function makeScheduledItem(platforms: ("INSTAGRAM" | "TIKTOK" | "YOUTUBE")[]) {
    const item = await createContentItem(prisma, { title: "Publish job test idea" }, {
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

    const asset = await prisma.mediaAsset.create({
      data: { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/${item.id}/t.mp4`, originalFilename: "t.mp4", mimeType: "video/mp4", sizeBytes: 4 },
    });
    const takeSelection = await prisma.takeSelection.create({
      data: { contentItemId: item.id, selectedMediaAssetId: asset.id, confidence: 0.9, reason: "only take", materialDefects: [] },
    });
    const editPlan = await prisma.editPlan.create({
      data: { contentItemId: item.id, takeSelectionId: takeSelection.id, productionTier: "FAST", targetDurationSeconds: 4, plan: {} },
    });
    const renderKey = `renders/${item.id}/v1.mp4`;
    await storage.put(renderKey, Buffer.from("fake mp4 bytes for publish-job test"));
    await prisma.render.create({
      data: {
        contentItemId: item.id,
        editPlanId: editPlan.id,
        status: "SUCCESS",
        storageKey: renderKey,
        technicalQCReport: { overall: "PASS", checks: [] },
      },
    });

    await applyTransition(prisma, { contentItemId: item.id, to: "READY", actorType: "SYSTEM" });

    for (const platform of platforms) {
      await recordPlatformPackage(
        prisma,
        { contentItemId: item.id, platform, caption: `Caption for ${platform}`, hashtags: [] },
        { actorId: "chris" },
      );
    }
    await scheduleContentItemForPublishing(
      prisma,
      { contentItemId: item.id, scheduledDate: new Date(), targetPlatforms: platforms },
      { actorId: "chris" },
    );

    return item;
  }

  // These two orchestration tests deliberately use INSTAGRAM+TIKTOK, not YOUTUBE — YOUTUBE's
  // publish path is gated by a real, wall-clock-scoped daily quota check
  // (packages/platforms/src/youtube-quota.ts), and `recordPublicationAttempt` always
  // timestamps the `Publication` row it creates with real `now()` (no synthetic-date
  // override, unlike other domain functions in this repo written with tests in mind) — so
  // every real run of a YOUTUBE-touching test against this persistent dev DB permanently adds
  // to *real* today's quota usage. Enough repeated `pnpm test` runs in one real day
  // eventually exhausts real "today"'s simulated 100-upload budget, breaking any test that
  // expects a YOUTUBE publish to succeed by default — caught by exactly that failure, not
  // inspection. YOUTUBE's own quota *behavior* still gets full, dedicated coverage below,
  // using synthetic filler rows created directly (not through this real path) so that test
  // never touches real "today" at all. See /docs/DECISIONS.md.
  it("all platforms succeeding reaches PUBLISHED, and each adapter is called exactly once", async () => {
    const item = await makeScheduledItem(["INSTAGRAM", "TIKTOK"]);
    const instagram = new MockPlatformAdapter("INSTAGRAM");
    const tiktok = new MockPlatformAdapter("TIKTOK");

    const result = await publishContentItem(
      prisma,
      storage,
      { INSTAGRAM: instagram, TIKTOK: tiktok },
      item.id,
      { actorId: "chris" },
    );

    expect(result.succeededPlatforms.sort()).toEqual(["INSTAGRAM", "TIKTOK"]);
    expect(result.failedPlatforms).toEqual([]);
    expect(result.transitioned).toBe(true);
    expect(instagram.publishCalls).toHaveLength(1);
    expect(tiktok.publishCalls).toHaveLength(1);

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("PUBLISHED");
  });

  /** The literal acceptance criterion. */
  it("one platform failing does not block the others — they still publish and the item still reaches PUBLISHED", async () => {
    await clearYouTubeQuotaDayFillerRows();
    const item = await makeScheduledItem(["INSTAGRAM", "TIKTOK", "YOUTUBE"]);
    const instagram = new MockPlatformAdapter("INSTAGRAM");
    const tiktok = new MockPlatformAdapter("TIKTOK", {
      publishResult: { status: "FAILED", platformPostId: null, url: null, rawResponse: null, errorMessage: "simulated TikTok API outage" },
    });
    const youtube = new MockPlatformAdapter("YOUTUBE");

    const result = await publishContentItem(
      prisma,
      storage,
      { INSTAGRAM: instagram, TIKTOK: tiktok, YOUTUBE: youtube },
      item.id,
      { actorId: "chris" },
      // Real "today" may already be at/near YouTube's real quota ceiling purely from this
      // suite's own repeated runs (see the comment above) — this test is about TikTok's
      // failure not blocking the others, not about YouTube's quota gate, so give YouTube a
      // guaranteed-clean day rather than depending on real "today" having room left.
      { now: FUTURE_QUOTA_DAY },
    );

    expect(result.succeededPlatforms.sort()).toEqual(["INSTAGRAM", "YOUTUBE"]);
    expect(result.failedPlatforms).toEqual(["TIKTOK"]);
    expect(result.transitioned).toBe(true);

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("PUBLISHED");

    const tiktokPub = await getLatestPublication(prisma, item.id, "TIKTOK");
    expect(tiktokPub?.status).toBe("FAILED");
    expect(tiktokPub?.errorMessage).toContain("simulated TikTok API outage");
  });

  /** The other literal acceptance criterion. */
  it("retrying a publish call is idempotent — an already-succeeded platform is never re-called", async () => {
    const item = await makeScheduledItem(["INSTAGRAM"]);
    const instagram = new MockPlatformAdapter("INSTAGRAM");

    const first = await publishContentItem(prisma, storage, { INSTAGRAM: instagram }, item.id, { actorId: "chris" });
    expect(first.succeededPlatforms).toEqual(["INSTAGRAM"]);
    expect(instagram.publishCalls).toHaveLength(1);

    // Retry the exact same publish call — e.g. a worker retry after a crash, or a human
    // clicking "publish" again out of caution.
    const second = await publishContentItem(prisma, storage, { INSTAGRAM: instagram }, item.id, { actorId: "chris" });
    expect(second.succeededPlatforms).toEqual(["INSTAGRAM"]);
    expect(instagram.publishCalls).toHaveLength(1); // still 1 — no second real call

    const publications = await listPublicationsForContentItem(prisma, item.id);
    expect(publications).toHaveLength(1); // no duplicate row either
  });

  it("a failed platform IS retried (idempotency protects successes, not failures)", async () => {
    const item = await makeScheduledItem(["TIKTOK"]);
    let callCount = 0;
    const tiktok = new MockPlatformAdapter("TIKTOK", {
      publishResult: () => {
        callCount++;
        return callCount === 1
          ? { status: "FAILED" as const, platformPostId: null, url: null, rawResponse: null, errorMessage: "transient" }
          : { status: "SUCCESS" as const, platformPostId: "tiktok-post-2", url: null, rawResponse: null };
      },
    });

    const first = await publishContentItem(prisma, storage, { TIKTOK: tiktok }, item.id, { actorId: "chris" });
    expect(first.failedPlatforms).toEqual(["TIKTOK"]);

    const second = await publishContentItem(prisma, storage, { TIKTOK: tiktok }, item.id, { actorId: "chris" });
    expect(second.succeededPlatforms).toEqual(["TIKTOK"]);
    expect(tiktok.publishCalls).toHaveLength(2); // real retry happened

    const publications = await listPublicationsForContentItem(prisma, item.id);
    expect(publications).toHaveLength(2); // both attempts kept as audit trail
  });

  it("an unaudited TikTok adapter's DRAFT outcome counts as reaching PUBLISHED, not a failure", async () => {
    const item = await makeScheduledItem(["TIKTOK"]);
    const tiktok = new MockPlatformAdapter("TIKTOK", {
      publishResult: {
        status: "DRAFT",
        platformPostId: "draft-1",
        url: null,
        rawResponse: null,
        errorMessage: "App is not TikTok-audited — posted as private.",
      },
    });

    const result = await publishContentItem(prisma, storage, { TIKTOK: tiktok }, item.id, { actorId: "chris" });
    expect(result.succeededPlatforms).toEqual(["TIKTOK"]);
    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("PUBLISHED");
  });

  it(
    "YouTube's daily upload quota gates the adapter call — exhausted quota fails without ever touching the network",
    async () => {
      await clearYouTubeQuotaDayFillerRows();
      const item = await makeScheduledItem(["YOUTUBE"]);
      const youtube = new MockPlatformAdapter("YOUTUBE");

      // Pre-fill this synthetic day's YouTube budget via a *different* item so it's already
      // exhausted before this item's own publish attempt.
      const filler = await makeScheduledItem(["YOUTUBE"]);
      const fillerPkg = await prisma.platformPackage.findFirstOrThrow({ where: { contentItemId: filler.id, platform: "YOUTUBE" } });
      for (let i = 0; i < YOUTUBE_UPLOAD_DAILY_BUDGET; i++) {
        await prisma.publication.create({
          data: {
            contentItemId: filler.id,
            platform: "YOUTUBE",
            platformPackageId: fillerPkg.id,
            attempt: i + 1,
            idempotencyKey: `${filler.id}:YOUTUBE:filler`,
            status: "SUCCESS",
            createdAt: new Date(FUTURE_QUOTA_DAY.getTime() + i * 1000),
          },
        });
      }

      const result = await publishContentItem(
        prisma,
        storage,
        { YOUTUBE: youtube },
        item.id,
        { actorId: "chris" },
        { now: new Date(FUTURE_QUOTA_DAY.getTime() + 60 * 60 * 1000) },
      );

      expect(result.failedPlatforms).toEqual(["YOUTUBE"]);
      expect(youtube.publishCalls).toHaveLength(0); // never called — quota gate caught it first

      const pub = await getLatestPublication(prisma, item.id, "YOUTUBE");
      expect(pub?.status).toBe("FAILED");
      expect(pub?.errorMessage).toContain("quota exhausted");
    },
    30000,
  );

  it("a target platform with no PlatformPackage is skipped, not silently ignored", async () => {
    const item = await createContentItem(prisma, { title: "Missing package test" }, { actorId: "test" });
    for (const to of [
      "SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED",
      "READY_TO_FILM", "FILMED", "MEDIA_INGESTED", "TAKE_SELECTED", "EDIT_PLANNED", "EDITING", "RENDERED",
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
      data: { contentItemId: item.id, takeSelectionId: takeSelection.id, productionTier: "FAST", targetDurationSeconds: 4, plan: {} },
    });
    await prisma.render.create({
      data: { contentItemId: item.id, editPlanId: editPlan.id, status: "SUCCESS", storageKey: `renders/${item.id}/v1.mp4`, technicalQCReport: { overall: "PASS", checks: [] } },
    });
    await applyTransition(prisma, { contentItemId: item.id, to: "READY", actorType: "SYSTEM" });
    // Deliberately skip recordPlatformPackage — scheduled for INSTAGRAM with no package ever made.
    await scheduleContentItemForPublishing(
      prisma,
      { contentItemId: item.id, scheduledDate: new Date(), targetPlatforms: ["INSTAGRAM"] },
      { actorId: "chris" },
    );
    await storage.put(`renders/${item.id}/v1.mp4`, Buffer.from("bytes"));

    const instagram = new MockPlatformAdapter("INSTAGRAM");
    const result = await publishContentItem(prisma, storage, { INSTAGRAM: instagram }, item.id, { actorId: "chris" });

    expect(result.skippedPlatforms).toHaveLength(1);
    expect(result.skippedPlatforms[0]?.platform).toBe("INSTAGRAM");
    expect(instagram.publishCalls).toHaveLength(0);
  });
});
