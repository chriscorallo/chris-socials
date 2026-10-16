import { describe, it, expect } from "vitest";
import {
  prisma,
  createContentItem,
  applyTransition,
  getCapturedOffsets,
  listSnapshotsForContentItem,
} from "@chris/domain";
import { MockPlatformAdapter } from "@chris/platforms";
import { captureDueSnapshots } from "../snapshot-job";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The real proof of Phase 6's acceptance criterion (/docs/PHASE_PLAN.md): "the snapshot job
 * at each defined offset records only metrics the connected platform actually returns — absent
 * fields stay null, never defaulted or fabricated." Real state machine, real DB; only the
 * platform adapter is mocked (same pattern as every other phase's one genuinely-external
 * dependency).
 */
async function makePublishedItemWithPublication(
  platform: "INSTAGRAM" | "TIKTOK" | "YOUTUBE",
  publishedAt: Date,
) {
  const item = await createContentItem(prisma, { title: "Snapshot job test idea" }, {
    actorId: "test-user",
  });
  for (const to of [
    "SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED",
    "READY_TO_FILM", "FILMED", "MEDIA_INGESTED", "TAKE_SELECTED", "EDIT_PLANNED", "EDITING",
    "RENDERED", "READY", "SCHEDULED", "PUBLISHING", "PUBLISHED",
  ] as const) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
  }

  const pkg = await prisma.platformPackage.create({
    data: { contentItemId: item.id, platform, caption: "x", hashtags: [] },
  });
  await prisma.publication.create({
    data: {
      contentItemId: item.id,
      platform,
      platformPackageId: pkg.id,
      idempotencyKey: `${item.id}:${platform}`,
      status: "SUCCESS",
      platformPostId: "real-post-1",
      publishedAt,
    },
  });

  return item;
}

describe("captureDueSnapshots", () => {
  it(
    "captures only the metrics the adapter actually returns — absent fields stay null",
    async () => {
      const publishedAt = new Date(Date.now() - 1.5 * HOUR);
      const item = await makePublishedItemWithPublication("YOUTUBE", publishedAt);
      // Mirrors YouTube's real API: no shareCount/saveCount/reach/avgWatchTimeSeconds.
      const youtube = new MockPlatformAdapter("YOUTUBE", {
        metricsResult: {
          viewCount: 250,
          likeCount: 20,
          commentCount: 3,
          shareCount: null,
          saveCount: null,
          reach: null,
          avgWatchTimeSeconds: null,
          rawResponse: { mock: true },
        },
      });

      const result = await captureDueSnapshots(prisma, { YOUTUBE: youtube }, item.id, { actorId: "chris" });

      expect(result.captured).toEqual([{ platform: "YOUTUBE", offset: "T_PLUS_1H" }]);
      const snapshots = await listSnapshotsForContentItem(prisma, item.id);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.viewCount).toBe(250);
      expect(snapshots[0]?.shareCount).toBeNull();
      expect(snapshots[0]?.saveCount).toBeNull();
      expect(snapshots[0]?.avgWatchTimeSeconds).toBeNull();

      const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(updated.currentState).toBe("MEASURING");
    },
  );

  it("after a gap, captures only the offset whose window is open — earlier missed offsets stay honest gaps", async () => {
    const publishedAt = new Date(Date.now() - 25 * HOUR);
    const item = await makePublishedItemWithPublication("INSTAGRAM", publishedAt);
    const instagram = new MockPlatformAdapter("INSTAGRAM");

    const first = await captureDueSnapshots(prisma, { INSTAGRAM: instagram }, item.id, { actorId: "chris" });
    expect(first.captured.map((c) => c.offset)).toEqual(["T_PLUS_24H"]);
    expect(first.missed.map((m) => m.offset)).toEqual(["T_PLUS_1H", "T_PLUS_6H"]);
    expect(instagram.getMetricsCalls).toHaveLength(1);

    // A second call right away has nothing new due.
    const second = await captureDueSnapshots(prisma, { INSTAGRAM: instagram }, item.id, { actorId: "chris" });
    expect(second.captured).toEqual([]);
    expect(instagram.getMetricsCalls).toHaveLength(1); // no redundant re-capture

    const captured = await getCapturedOffsets(prisma, item.id, "INSTAGRAM");
    expect(captured).toEqual(["T_PLUS_24H"]);
  });

  it("a day-8 capture is recorded as T+7d only — never back-labelled as T+1h/6h/24h/72h", async () => {
    const publishedAt = new Date(Date.now() - 8 * DAY);
    const item = await makePublishedItemWithPublication("YOUTUBE", publishedAt);
    const youtube = new MockPlatformAdapter("YOUTUBE");

    const result = await captureDueSnapshots(prisma, { YOUTUBE: youtube }, item.id, { actorId: "chris" });
    expect(result.captured.map((c) => c.offset)).toEqual(["T_PLUS_7D"]);
    expect(result.missed.map((m) => m.offset)).toEqual(["T_PLUS_1H", "T_PLUS_6H", "T_PLUS_24H", "T_PLUS_72H"]);
    expect(await getCapturedOffsets(prisma, item.id, "YOUTUBE")).toEqual(["T_PLUS_7D"]);
  });

  it("an HTTP error records nothing, reports the error, and leaves the offset due for the next run", async () => {
    const publishedAt = new Date(Date.now() - 1.5 * HOUR);
    const item = await makePublishedItemWithPublication("INSTAGRAM", publishedAt);
    let fail = true;
    const instagram = new MockPlatformAdapter("INSTAGRAM", {
      metricsResult: () => {
        if (fail) throw new Error("INSTAGRAM insights failed (HTTP 401).");
        return { viewCount: 5, likeCount: 1, commentCount: 0, shareCount: 0, saveCount: 0, reach: 4, avgWatchTimeSeconds: 2.5, rawResponse: {} };
      },
    });

    const first = await captureDueSnapshots(prisma, { INSTAGRAM: instagram }, item.id, { actorId: "chris" });
    expect(first.captured).toEqual([]);
    expect(first.errors).toEqual([{ platform: "INSTAGRAM", message: "INSTAGRAM insights failed (HTTP 401)." }]);
    expect(await getCapturedOffsets(prisma, item.id, "INSTAGRAM")).toEqual([]);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("PUBLISHED");

    fail = false;
    const second = await captureDueSnapshots(prisma, { INSTAGRAM: instagram }, item.id, { actorId: "chris" });
    expect(second.captured).toEqual([{ platform: "INSTAGRAM", offset: "T_PLUS_1H" }]);
  });

  it("archives once the T+30d window has passed even if nothing could ever be captured", async () => {
    const publishedAt = new Date(Date.now() - 38 * DAY);
    const item = await makePublishedItemWithPublication("YOUTUBE", publishedAt);
    const youtube = new MockPlatformAdapter("YOUTUBE", {
      metricsResult: () => {
        throw new Error("never reachable");
      },
    });

    const result = await captureDueSnapshots(prisma, { YOUTUBE: youtube }, item.id, { actorId: "chris" });
    expect(result.captured).toEqual([]);
    expect(result.missed).toHaveLength(6);
    expect(result.archived).toBe(true);
    expect(youtube.getMetricsCalls).toHaveLength(0); // nothing due — no pointless call
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("ARCHIVED");
  });

  it("one platform's metrics fetch failing does not stop capturing the others", async () => {
    const publishedAt = new Date(Date.now() - 1.5 * HOUR);
    const item = await createContentItem(prisma, { title: "Multi-platform snapshot test" }, {
      actorId: "test-user",
    });
    for (const to of [
      "SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED",
      "READY_TO_FILM", "FILMED", "MEDIA_INGESTED", "TAKE_SELECTED", "EDIT_PLANNED", "EDITING",
      "RENDERED", "READY", "SCHEDULED", "PUBLISHING", "PUBLISHED",
    ] as const) {
      await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
    }
    const igPkg = await prisma.platformPackage.create({
      data: { contentItemId: item.id, platform: "INSTAGRAM", caption: "x", hashtags: [] },
    });
    const ytPkg = await prisma.platformPackage.create({
      data: { contentItemId: item.id, platform: "YOUTUBE", caption: "x", hashtags: [] },
    });
    await prisma.publication.create({
      data: { contentItemId: item.id, platform: "INSTAGRAM", platformPackageId: igPkg.id, idempotencyKey: "k1", status: "SUCCESS", platformPostId: "p1", publishedAt },
    });
    await prisma.publication.create({
      data: { contentItemId: item.id, platform: "YOUTUBE", platformPackageId: ytPkg.id, idempotencyKey: "k2", status: "SUCCESS", platformPostId: "p2", publishedAt },
    });

    const instagram = new MockPlatformAdapter("INSTAGRAM", {
      metricsResult: () => {
        throw new Error("simulated Instagram API outage");
      },
    });
    const youtube = new MockPlatformAdapter("YOUTUBE");

    const result = await captureDueSnapshots(
      prisma,
      { INSTAGRAM: instagram, YOUTUBE: youtube },
      item.id,
      { actorId: "chris" },
    );

    expect(result.captured).toEqual([{ platform: "YOUTUBE", offset: "T_PLUS_1H" }]);
    const igOffsets = await getCapturedOffsets(prisma, item.id, "INSTAGRAM");
    expect(igOffsets).toEqual([]); // never recorded — real failure, not a fabricated snapshot
  });

  it(
    "archives once every published platform's T+30d snapshot is captured",
    async () => {
      const publishedAt = new Date(Date.now() - 31 * DAY);
      const item = await makePublishedItemWithPublication("TIKTOK", publishedAt);
      const tiktok = new MockPlatformAdapter("TIKTOK");

      const result = await captureDueSnapshots(prisma, { TIKTOK: tiktok }, item.id, { actorId: "chris" });

      expect(result.captured.map((c) => c.offset)).toContain("T_PLUS_30D");
      expect(result.archived).toBe(true);
      const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(updated.currentState).toBe("ARCHIVED");
    },
    30000,
  );
});
