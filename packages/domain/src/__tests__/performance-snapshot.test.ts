import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import {
  getDueSnapshotOffsets,
  SNAPSHOT_OFFSETS_IN_ORDER,
  startMeasuring,
  recordPerformanceSnapshot,
  getCapturedOffsets,
  listSnapshotsForContentItem,
  archiveIfMeasurementWindowClosed,
  getMissedSnapshotOffsets,
  snapshotCaptureWindowMs,
  measurementWindowClosesAt,
  MeasuringRequiresPublishedStateError,
  ArchiveRequiresMeasuringStateError,
} from "../performance-snapshot";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("getDueSnapshotOffsets (pure, deterministic — no I/O)", () => {
  it("nothing is due immediately at publish time", () => {
    const publishedAt = new Date("2026-01-01T00:00:00Z");
    const due = getDueSnapshotOffsets(publishedAt, [], new Date(publishedAt.getTime()));
    expect(due).toEqual([]);
  });

  it("T+1h becomes due exactly at the 1-hour mark, nothing later yet", () => {
    const publishedAt = new Date("2026-01-01T00:00:00Z");
    const due = getDueSnapshotOffsets(publishedAt, [], new Date(publishedAt.getTime() + HOUR));
    expect(due).toEqual(["T_PLUS_1H"]);
  });

  it("a long gap does not back-fill earlier offsets — only the offset whose window is open is due", () => {
    const publishedAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date(publishedAt.getTime() + 25 * HOUR);
    expect(getDueSnapshotOffsets(publishedAt, [], now)).toEqual(["T_PLUS_24H"]);
    expect(getMissedSnapshotOffsets(publishedAt, [], now)).toEqual(["T_PLUS_1H", "T_PLUS_6H"]);
  });

  it("already-captured offsets are excluded even if their window is open", () => {
    const publishedAt = new Date("2026-01-01T00:00:00Z");
    const due = getDueSnapshotOffsets(publishedAt, ["T_PLUS_24H"], new Date(publishedAt.getTime() + 25 * HOUR));
    expect(due).toEqual([]);
  });

  it("each window is max(1h, 25% of the offset) and windows never overlap", () => {
    expect(snapshotCaptureWindowMs("T_PLUS_1H")).toBe(HOUR);
    expect(snapshotCaptureWindowMs("T_PLUS_6H")).toBe(1.5 * HOUR);
    expect(snapshotCaptureWindowMs("T_PLUS_24H")).toBe(6 * HOUR);
    expect(snapshotCaptureWindowMs("T_PLUS_30D")).toBe(7.5 * DAY);
    const publishedAt = new Date("2026-01-01T00:00:00Z");
    for (let h = 0; h < 40 * 24; h += 0.25) {
      expect(getDueSnapshotOffsets(publishedAt, [], new Date(publishedAt.getTime() + h * HOUR)).length).toBeLessThanOrEqual(1);
    }
  });

  it("T+1h is no longer due at exactly 2h (window closed) — it's missed", () => {
    const publishedAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date(publishedAt.getTime() + 2 * HOUR);
    expect(getDueSnapshotOffsets(publishedAt, [], now)).toEqual([]);
    expect(getMissedSnapshotOffsets(publishedAt, [], now)).toEqual(["T_PLUS_1H"]);
  });

  it("day 8 can only capture T+7d", () => {
    const publishedAt = new Date("2026-01-01T00:00:00Z");
    expect(getDueSnapshotOffsets(publishedAt, [], new Date(publishedAt.getTime() + 8 * DAY))).toEqual(["T_PLUS_7D"]);
  });

  it("the measurement window closes at T+37.5d", () => {
    const publishedAt = new Date("2026-01-01T00:00:00Z");
    expect(measurementWindowClosesAt(publishedAt).getTime() - publishedAt.getTime()).toBe(37.5 * DAY);
    expect(getMissedSnapshotOffsets(publishedAt, [], new Date(publishedAt.getTime() + 38 * DAY))).toEqual(SNAPSHOT_OFFSETS_IN_ORDER);
  });

  it("nothing is due one second before a boundary", () => {
    const publishedAt = new Date("2026-01-01T00:00:00Z");
    const due = getDueSnapshotOffsets(publishedAt, [], new Date(publishedAt.getTime() + HOUR - 1000));
    expect(due).toEqual([]);
  });
});

async function makePublishedItem() {
  const item = await createContentItem(prisma, { title: "Snapshot test idea" }, { actorId: "test" });
  for (const to of [
    "SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED",
    "READY_TO_FILM", "FILMED", "MEDIA_INGESTED", "TAKE_SELECTED", "EDIT_PLANNED", "EDITING",
    "RENDERED", "READY", "SCHEDULED", "PUBLISHING", "PUBLISHED",
  ] as const) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
  }
  return item;
}

describe("startMeasuring", () => {
  it("rejects from any state other than PUBLISHED", async () => {
    const item = await createContentItem(prisma, { title: "Not published" }, { actorId: "test" });
    await expect(startMeasuring(prisma, item.id, { actorId: "chris" })).rejects.toBeInstanceOf(
      MeasuringRequiresPublishedStateError,
    );
  });

  it("transitions PUBLISHED -> MEASURING", async () => {
    const item = await makePublishedItem();
    await startMeasuring(prisma, item.id, { actorId: "chris" });
    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("MEASURING");
  });

  it("is a no-op (not an error) if already MEASURING", async () => {
    const item = await makePublishedItem();
    await startMeasuring(prisma, item.id, { actorId: "chris" });
    await expect(startMeasuring(prisma, item.id, { actorId: "chris" })).resolves.toBeTruthy();
  });
});

describe("recordPerformanceSnapshot", () => {
  it("persists only the fields given, leaving the rest null — never fabricated", async () => {
    const item = await makePublishedItem();
    await startMeasuring(prisma, item.id, { actorId: "chris" });

    const snapshot = await recordPerformanceSnapshot(
      prisma,
      {
        contentItemId: item.id,
        platform: "YOUTUBE",
        offset: "T_PLUS_1H",
        viewCount: 42,
        likeCount: 5,
        commentCount: 1,
        // shareCount/saveCount/reach/avgWatchTimeSeconds deliberately omitted — YouTube's
        // Data API v3 genuinely doesn't return them (see /docs/DECISIONS.md).
      },
      { actorId: "chris" },
    );

    expect(snapshot.viewCount).toBe(42);
    expect(snapshot.shareCount).toBeNull();
    expect(snapshot.saveCount).toBeNull();
    expect(snapshot.avgWatchTimeSeconds).toBeNull();
  });

  it("is idempotent per (contentItemId, platform, offset) — re-capturing updates, not duplicates", async () => {
    const item = await makePublishedItem();
    await startMeasuring(prisma, item.id, { actorId: "chris" });

    await recordPerformanceSnapshot(
      prisma,
      { contentItemId: item.id, platform: "INSTAGRAM", offset: "T_PLUS_1H", viewCount: 10 },
      { actorId: "chris" },
    );
    await recordPerformanceSnapshot(
      prisma,
      { contentItemId: item.id, platform: "INSTAGRAM", offset: "T_PLUS_1H", viewCount: 15 },
      { actorId: "chris" },
    );

    const snapshots = await listSnapshotsForContentItem(prisma, item.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.viewCount).toBe(15);
  });

  it("getCapturedOffsets reflects exactly what was recorded", async () => {
    const item = await makePublishedItem();
    await startMeasuring(prisma, item.id, { actorId: "chris" });
    await recordPerformanceSnapshot(
      prisma,
      { contentItemId: item.id, platform: "TIKTOK", offset: "T_PLUS_1H", viewCount: 1 },
      { actorId: "chris" },
    );
    await recordPerformanceSnapshot(
      prisma,
      { contentItemId: item.id, platform: "TIKTOK", offset: "T_PLUS_6H", viewCount: 2 },
      { actorId: "chris" },
    );
    const captured = await getCapturedOffsets(prisma, item.id, "TIKTOK");
    expect(captured.sort()).toEqual(["T_PLUS_1H", "T_PLUS_6H"]);
  });
});

describe("archiveIfMeasurementWindowClosed", () => {
  it("rejects from any state other than MEASURING", async () => {
    const item = await createContentItem(prisma, { title: "Not measuring" }, { actorId: "test" });
    await expect(
      archiveIfMeasurementWindowClosed(prisma, item.id, { actorId: "chris" }),
    ).rejects.toBeInstanceOf(ArchiveRequiresMeasuringStateError);
  });

  it("does not archive while T+30d is still missing for a published platform", async () => {
    const item = await makePublishedItem();
    const pkg = await prisma.platformPackage.create({
      data: { contentItemId: item.id, platform: "YOUTUBE", caption: "x", hashtags: [] },
    });
    await prisma.publication.create({
      data: {
        contentItemId: item.id,
        platform: "YOUTUBE",
        platformPackageId: pkg.id,
        idempotencyKey: "k",
        status: "SUCCESS",
        publishedAt: new Date(Date.now() - 8 * DAY),
      },
    });
    await startMeasuring(prisma, item.id, { actorId: "chris" });
    await recordPerformanceSnapshot(
      prisma,
      { contentItemId: item.id, platform: "YOUTUBE", offset: "T_PLUS_7D", viewCount: 100 },
      { actorId: "chris" },
    );

    const archived = await archiveIfMeasurementWindowClosed(prisma, item.id, { actorId: "chris" });
    expect(archived).toBe(false);
    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("MEASURING");
  });

  it("archives once the T+30d window has passed even with T+30d (and others) never captured", async () => {
    const item = await makePublishedItem();
    const pkg = await prisma.platformPackage.create({
      data: { contentItemId: item.id, platform: "YOUTUBE", caption: "x", hashtags: [] },
    });
    const publishedAt = new Date("2026-01-01T00:00:00Z");
    await prisma.publication.create({
      data: { contentItemId: item.id, platform: "YOUTUBE", platformPackageId: pkg.id, idempotencyKey: "k", status: "SUCCESS", publishedAt },
    });
    await startMeasuring(prisma, item.id, { actorId: "chris" });

    expect(
      await archiveIfMeasurementWindowClosed(prisma, item.id, { actorId: "chris" }, { now: new Date(publishedAt.getTime() + 37 * DAY) }),
    ).toBe(false);
    expect(
      await archiveIfMeasurementWindowClosed(prisma, item.id, { actorId: "chris" }, { now: new Date(publishedAt.getTime() + 38 * DAY) }),
    ).toBe(true);
  });

  it("archives once every published platform's T+30d snapshot is in", async () => {
    const item = await makePublishedItem();
    const igPkg = await prisma.platformPackage.create({
      data: { contentItemId: item.id, platform: "INSTAGRAM", caption: "x", hashtags: [] },
    });
    const ytPkg = await prisma.platformPackage.create({
      data: { contentItemId: item.id, platform: "YOUTUBE", caption: "x", hashtags: [] },
    });
    await prisma.publication.create({
      data: { contentItemId: item.id, platform: "INSTAGRAM", platformPackageId: igPkg.id, idempotencyKey: "k1", status: "SUCCESS" },
    });
    await prisma.publication.create({
      data: { contentItemId: item.id, platform: "YOUTUBE", platformPackageId: ytPkg.id, idempotencyKey: "k2", status: "FAILED" },
    });
    await startMeasuring(prisma, item.id, { actorId: "chris" });
    await recordPerformanceSnapshot(
      prisma,
      { contentItemId: item.id, platform: "INSTAGRAM", offset: "T_PLUS_30D", viewCount: 500 },
      { actorId: "chris" },
    );
    // YOUTUBE's Publication is FAILED, not SUCCESS/DRAFT — it never actually published there,
    // so its snapshot window doesn't gate archiving at all.

    const archived = await archiveIfMeasurementWindowClosed(prisma, item.id, { actorId: "chris" });
    expect(archived).toBe(true);
    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("ARCHIVED");
  });
});
