import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma, setFlag, getLatestPublication, getCapturedOffsets } from "@chris/domain";
import { LocalFsStorageAdapter } from "@chris/media";
import { MockPlatformAdapter } from "@chris/platforms";
import {
  publishDueScheduledItems,
  captureDueSnapshotsForAll,
  SCHEDULED_PUBLISH_FLAG,
  SCHEDULED_PUBLISH_JOB_KIND,
  SNAPSHOT_SWEEP_JOB_KIND,
} from "../scheduled-jobs";
import { publishContentItem } from "../publish-job";
import { makeScheduledPublishableItem, FAST_PUBLISH_OPTIONS } from "./publish-fixtures";

const HOUR = 60 * 60 * 1000;

async function setScheduledFlag(enabled: boolean) {
  await setFlag(prisma, { key: SCHEDULED_PUBLISH_FLAG, enabled, actor: "test", actorType: "HUMAN" });
}

describe("publishDueScheduledItems", () => {
  let storageDir: string;
  let storage: LocalFsStorageAdapter;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "chris-scheduled-publish-test-"));
    storage = new LocalFsStorageAdapter({ baseDir: storageDir });
  });

  afterAll(async () => {
    await setScheduledFlag(false);
    await rm(storageDir, { recursive: true, force: true });
  });

  it("is a no-op when publishing.scheduled_auto is off (default) — but still records the run", async () => {
    await prisma.featureFlag.deleteMany({ where: { key: SCHEDULED_PUBLISH_FLAG } });
    const item = await makeScheduledPublishableItem(storage, ["TIKTOK"], { scheduledDate: new Date(Date.now() - HOUR) });
    const tiktok = new MockPlatformAdapter("TIKTOK");

    const run = await publishDueScheduledItems({ prisma, storage, adapters: { TIKTOK: tiktok }, ...FAST_PUBLISH_OPTIONS });

    expect(run.status).toBe("SUCCEEDED");
    expect(run.summary?.flagEnabled).toBe(false);
    expect(tiktok.publishCalls).toHaveLength(0);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("SCHEDULED");
    const jobRun = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.jobRunId } });
    expect(jobRun.kind).toBe(SCHEDULED_PUBLISH_JOB_KIND);
    expect(jobRun.status).toBe("SUCCEEDED");
    expect(jobRun.finishedAt).toBeInstanceOf(Date);
  });

  it("with the flag on: publishes due items, leaves future ones, and surfaces >24h-stale ones as missed", async () => {
    await setScheduledFlag(true);
    try {
      const now = new Date();
      const due = await makeScheduledPublishableItem(storage, ["TIKTOK"], { scheduledDate: new Date(now.getTime() - 5 * 60 * 1000) });
      const future = await makeScheduledPublishableItem(storage, ["TIKTOK"], { scheduledDate: new Date(now.getTime() + 3 * HOUR) });
      const stale = await makeScheduledPublishableItem(storage, ["TIKTOK"], { scheduledDate: new Date(now.getTime() - 25 * HOUR) });
      const tiktok = new MockPlatformAdapter("TIKTOK");

      const run = await publishDueScheduledItems({ prisma, storage, adapters: { TIKTOK: tiktok }, now, ...FAST_PUBLISH_OPTIONS });

      expect(run.status).toBe("SUCCEEDED");
      expect(run.summary?.published.map((p) => p.contentItemId)).toContain(due.id);
      expect(run.summary?.published.map((p) => p.contentItemId)).not.toContain(future.id);
      expect(run.summary?.missed.map((m) => m.contentItemId)).toContain(stale.id);

      expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: due.id } })).currentState).toBe("PUBLISHED");
      expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: future.id } })).currentState).toBe("SCHEDULED");
      expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: stale.id } })).currentState).toBe("SCHEDULED");
      expect(tiktok.publishCalls.filter((c) => [future.id, stale.id].includes(c.contentItemId))).toHaveLength(0);

      const jobRun = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.jobRunId } });
      const summary = jobRun.summary as { missed: { contentItemId: string }[] };
      expect(summary.missed.some((m) => m.contentItemId === stale.id)).toBe(true);
    } finally {
      await setScheduledFlag(false);
    }
  });

  it("one item failing never stops the others (isolation)", async () => {
    await setScheduledFlag(true);
    try {
      const now = new Date();
      const good = await makeScheduledPublishableItem(storage, ["YOUTUBE"], { scheduledDate: new Date(now.getTime() - 60 * 1000) });
      const bad = await makeScheduledPublishableItem(storage, ["YOUTUBE"], { scheduledDate: new Date(now.getTime() - 2 * 60 * 1000) });
      // Make the "bad" item's render bytes unreadable -> publishContentItem throws for it.
      const badRender = await prisma.render.findFirstOrThrow({ where: { contentItemId: bad.id } });
      await prisma.render.update({ where: { id: badRender.id }, data: { storageKey: `missing/${bad.id}.mp4` } });
      const youtube = new MockPlatformAdapter("YOUTUBE");

      const run = await publishDueScheduledItems({ prisma, storage, adapters: { YOUTUBE: youtube }, now, ...FAST_PUBLISH_OPTIONS });
      expect(run.summary?.errors.map((e) => e.contentItemId)).toContain(bad.id);
      expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: good.id } })).currentState).toBe("PUBLISHED");
    } finally {
      await setScheduledFlag(false);
    }
  });

  it("resumes a pending-processing platform on a PUBLISHED item, and only that platform", async () => {
    const item = await makeScheduledPublishableItem(storage, ["INSTAGRAM", "TIKTOK"]);
    const tiktok = new MockPlatformAdapter("TIKTOK", {
      publishResult: { status: "FAILED", platformPostId: null, url: null, rawResponse: null, errorMessage: "spam_risk_too_many_posts" },
    });
    const instagram = new MockPlatformAdapter("INSTAGRAM", {
      publishResult: (req) =>
        req.resumeToken
          ? { status: "SUCCESS", platformPostId: "ig-resumed", url: "https://www.instagram.com/reel/R/", rawResponse: {} }
          : { status: "FAILED", platformPostId: null, url: null, rawResponse: {}, errorMessage: "PENDING_PROCESSING: c-9", resumeToken: { containerId: "c-9", createdAt: new Date().toISOString() } },
    });
    // TikTok fails, Instagram pending -> nothing succeeded yet, item stays PUBLISHING.
    await publishContentItem(prisma, storage, { INSTAGRAM: instagram, TIKTOK: tiktok }, item.id, { actorId: "chris" }, FAST_PUBLISH_OPTIONS);

    await setScheduledFlag(true);
    try {
      const run = await publishDueScheduledItems({ prisma, storage, adapters: { INSTAGRAM: instagram, TIKTOK: tiktok }, ...FAST_PUBLISH_OPTIONS });
      const resumed = run.summary?.resumed.find((r) => r.contentItemId === item.id);
      expect(resumed?.platforms).toEqual(["INSTAGRAM"]);
      expect(resumed?.succeeded).toEqual(["INSTAGRAM"]);
      expect(tiktok.publishCalls).toHaveLength(1); // the real failure is NOT blanket-retried
      expect((await getLatestPublication(prisma, item.id, "INSTAGRAM"))?.platformPostId).toBe("ig-resumed");
      expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("PUBLISHED");
    } finally {
      await setScheduledFlag(false);
    }
  });
});

describe("captureDueSnapshotsForAll", () => {
  let storageDir: string;
  let storage: LocalFsStorageAdapter;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "chris-snapshot-sweep-test-"));
    storage = new LocalFsStorageAdapter({ baseDir: storageDir });
  });

  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  it("captures due snapshots across items, re-verifies unverified posts, ingests comments, and writes a JobRun", async () => {
    const item = await makeScheduledPublishableItem(storage, ["YOUTUBE"]);
    const youtube = new MockPlatformAdapter("YOUTUBE", {
      verifyResult: { verified: false, pending: true, rawResponse: {} },
      commentsResult: [{ platformCommentId: `c-${Date.now()}`, authorHandle: "@v", text: "Great", postedAt: null }],
    });
    await publishContentItem(prisma, storage, { YOUTUBE: youtube }, item.id, { actorId: "chris" }, FAST_PUBLISH_OPTIONS);
    const pub = await getLatestPublication(prisma, item.id, "YOUTUBE");
    expect(pub?.verifiedAt).toBeNull();

    const now = new Date(pub!.publishedAt!.getTime() + 1.5 * HOUR);
    const verifyingYoutube = new MockPlatformAdapter("YOUTUBE", {
      commentsResult: [{ platformCommentId: `c-${Date.now()}`, authorHandle: "@v", text: "Great", postedAt: null }],
    });
    const run = await captureDueSnapshotsForAll({ prisma, adapters: { YOUTUBE: verifyingYoutube }, now });

    expect(run.status).toBe("SUCCEEDED");
    expect(run.summary?.verified).toBeGreaterThanOrEqual(1);
    expect(await getCapturedOffsets(prisma, item.id, "YOUTUBE")).toEqual(["T_PLUS_1H"]);
    expect((await getLatestPublication(prisma, item.id, "YOUTUBE"))?.verifiedAt).toBeInstanceOf(Date);
    expect((await getLatestPublication(prisma, item.id, "YOUTUBE"))?.errorMessage ?? "").not.toContain("Not yet verified");
    expect(await prisma.comment.count({ where: { contentItemId: item.id } })).toBe(1);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("MEASURING");

    const jobRun = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.jobRunId } });
    expect(jobRun.kind).toBe(SNAPSHOT_SWEEP_JOB_KIND);
    expect(jobRun.status).toBe("SUCCEEDED");
  });

  it("reports a platform read error per item without failing the sweep", async () => {
    const item = await makeScheduledPublishableItem(storage, ["TIKTOK"]);
    await publishContentItem(prisma, storage, { TIKTOK: new MockPlatformAdapter("TIKTOK") }, item.id, { actorId: "chris" }, FAST_PUBLISH_OPTIONS);
    const pub = await getLatestPublication(prisma, item.id, "TIKTOK");
    const broken = new MockPlatformAdapter("TIKTOK", {
      metricsResult: () => {
        throw new Error("TIKTOK video/query failed (HTTP 401).");
      },
    });
    const run = await captureDueSnapshotsForAll({ prisma, adapters: { TIKTOK: broken }, now: new Date(pub!.publishedAt!.getTime() + 1.5 * HOUR) });
    expect(run.status).toBe("SUCCEEDED");
    expect(run.summary?.errors.some((e) => e.contentItemId === item.id && e.message.includes("HTTP 401"))).toBe(true);
    expect(await getCapturedOffsets(prisma, item.id, "TIKTOK")).toEqual([]);
  });
});
