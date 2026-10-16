import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prisma,
  getLatestPublication,
  listPublicationsForContentItem,
  acquirePublishLease,
  releasePublishLease,
  publishLeaseKind,
  AMBIGUOUS_PUBLISH_PREFIX,
} from "@chris/domain";
import { LocalFsStorageAdapter } from "@chris/media";
import { MockPlatformAdapter, AmbiguousPublishError, YOUTUBE_UPLOAD_DAILY_BUDGET } from "@chris/platforms";
import { publishContentItem } from "../publish-job";
import { makeScheduledPublishableItem, FAST_PUBLISH_OPTIONS } from "./publish-fixtures";

/** A synthetic future day, snapped to noon UTC — see /docs/DECISIONS.md's youtube-quota
 * date-range fix (real "today" must never be polluted by quota filler rows). */
const FUTURE_QUOTA_DAY = new Date(
  Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000)) * 24 * 60 * 60 * 1000 +
    12 * 60 * 60 * 1000,
);

async function clearYouTubeQuotaDayFillerRows() {
  const startOfDay = new Date(
    Date.UTC(FUTURE_QUOTA_DAY.getUTCFullYear(), FUTURE_QUOTA_DAY.getUTCMonth(), FUTURE_QUOTA_DAY.getUTCDate()),
  );
  const startOfNextDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  await prisma.publication.deleteMany({
    where: { platform: "YOUTUBE", createdAt: { gte: startOfDay, lt: startOfNextDay } },
  });
}

const ACTOR = { actorId: "chris" };

/**
 * Phase 5 acceptance criteria plus the 2026-10-16 hardening (lease, verify, ambiguity, resume,
 * retry-after-PUBLISHED, QC requirement). Real DB + state machine + local storage; only the
 * platform adapters are mocked.
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

  it("all platforms succeeding reaches PUBLISHED; each adapter is called once and every post is verified", async () => {
    const item = await makeScheduledPublishableItem(storage, ["INSTAGRAM", "TIKTOK"]);
    const instagram = new MockPlatformAdapter("INSTAGRAM");
    const tiktok = new MockPlatformAdapter("TIKTOK");

    const result = await publishContentItem(prisma, storage, { INSTAGRAM: instagram, TIKTOK: tiktok }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);

    expect(result.succeededPlatforms.sort()).toEqual(["INSTAGRAM", "TIKTOK"]);
    expect(result.verifiedPlatforms.sort()).toEqual(["INSTAGRAM", "TIKTOK"]);
    expect(result.transitioned).toBe(true);
    expect(instagram.publishCalls).toHaveLength(1);
    expect(tiktok.publishCalls).toHaveLength(1);
    expect(instagram.verifyCalls).toEqual(["mock-instagram-1"]);
    expect(instagram.publishCalls[0]?.publicVideoUrl).toBe(`https://blob.example.invalid/renders/${item.id}/v1.mp4`);
    expect(instagram.publishCalls[0]?.durationSeconds).toBe(30);

    const igPub = await getLatestPublication(prisma, item.id, "INSTAGRAM");
    expect(igPub?.verifiedAt).toBeInstanceOf(Date);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("PUBLISHED");

    // The publish lease was released (SUCCEEDED), not left RUNNING.
    const lease = await prisma.jobRun.findFirstOrThrow({ where: { kind: publishLeaseKind(item.id, "INSTAGRAM") } });
    expect(lease.status).toBe("SUCCEEDED");
  });

  it("one platform failing does not block the others — they still publish and the item still reaches PUBLISHED", async () => {
    await clearYouTubeQuotaDayFillerRows();
    const item = await makeScheduledPublishableItem(storage, ["INSTAGRAM", "TIKTOK", "YOUTUBE"]);
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
      ACTOR,
      { ...FAST_PUBLISH_OPTIONS, now: FUTURE_QUOTA_DAY },
    );

    expect(result.succeededPlatforms.sort()).toEqual(["INSTAGRAM", "YOUTUBE"]);
    expect(result.failedPlatforms).toEqual(["TIKTOK"]);
    expect(result.transitioned).toBe(true);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("PUBLISHED");
    const tiktokPub = await getLatestPublication(prisma, item.id, "TIKTOK");
    expect(tiktokPub?.status).toBe("FAILED");
    expect(tiktokPub?.errorMessage).toContain("simulated TikTok API outage");
  });

  it("retrying a publish call is idempotent — an already-succeeded platform is never re-called", async () => {
    const item = await makeScheduledPublishableItem(storage, ["INSTAGRAM"]);
    const instagram = new MockPlatformAdapter("INSTAGRAM");

    const first = await publishContentItem(prisma, storage, { INSTAGRAM: instagram }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(first.succeededPlatforms).toEqual(["INSTAGRAM"]);
    const second = await publishContentItem(prisma, storage, { INSTAGRAM: instagram }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(second.succeededPlatforms).toEqual(["INSTAGRAM"]);
    expect(second.transitioned).toBe(false);
    expect(instagram.publishCalls).toHaveLength(1);
    expect(await listPublicationsForContentItem(prisma, item.id)).toHaveLength(1);
  });

  it("a failed platform IS retried — and can be retried after the item already reached PUBLISHED (no state regression)", async () => {
    const item = await makeScheduledPublishableItem(storage, ["INSTAGRAM", "TIKTOK"]);
    const instagram = new MockPlatformAdapter("INSTAGRAM");
    let calls = 0;
    const tiktok = new MockPlatformAdapter("TIKTOK", {
      publishResult: () => {
        calls++;
        return calls === 1
          ? { status: "FAILED" as const, platformPostId: null, url: null, rawResponse: null, errorMessage: "transient" }
          : { status: "SUCCESS" as const, platformPostId: "tiktok-post-2", url: null, rawResponse: null };
      },
    });

    const first = await publishContentItem(prisma, storage, { INSTAGRAM: instagram, TIKTOK: tiktok }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(first.failedPlatforms).toEqual(["TIKTOK"]);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("PUBLISHED");

    const second = await publishContentItem(prisma, storage, { INSTAGRAM: instagram, TIKTOK: tiktok }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(second.succeededPlatforms.sort()).toEqual(["INSTAGRAM", "TIKTOK"]);
    expect(second.transitioned).toBe(false);
    expect(tiktok.publishCalls).toHaveLength(2);
    expect(instagram.publishCalls).toHaveLength(1);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("PUBLISHED");
    expect((await prisma.publication.findMany({ where: { contentItemId: item.id, platform: "TIKTOK" } })).length).toBe(2);
  });

  it("an unaudited TikTok adapter's DRAFT outcome counts as reaching PUBLISHED, not a failure", async () => {
    const item = await makeScheduledPublishableItem(storage, ["TIKTOK"]);
    const tiktok = new MockPlatformAdapter("TIKTOK", {
      publishResult: { status: "DRAFT", platformPostId: "draft-1", url: null, rawResponse: null, errorMessage: "Sent to inbox." },
    });
    const result = await publishContentItem(prisma, storage, { TIKTOK: tiktok }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(result.succeededPlatforms).toEqual(["TIKTOK"]);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("PUBLISHED");
  });

  it(
    "YouTube's daily upload quota gates the adapter call — exhausted quota fails without ever touching the network",
    async () => {
      await clearYouTubeQuotaDayFillerRows();
      const item = await makeScheduledPublishableItem(storage, ["YOUTUBE"]);
      const youtube = new MockPlatformAdapter("YOUTUBE");
      const filler = await makeScheduledPublishableItem(storage, ["YOUTUBE"]);
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
      const result = await publishContentItem(prisma, storage, { YOUTUBE: youtube }, item.id, ACTOR, {
        ...FAST_PUBLISH_OPTIONS,
        now: new Date(FUTURE_QUOTA_DAY.getTime() + 60 * 60 * 1000),
      });
      expect(result.failedPlatforms).toEqual(["YOUTUBE"]);
      expect(youtube.publishCalls).toHaveLength(0);
      const pub = await getLatestPublication(prisma, item.id, "YOUTUBE");
      expect(pub?.errorMessage).toContain("quota exhausted");
      await clearYouTubeQuotaDayFillerRows();
    },
    30000,
  );

  it("a target platform with no PlatformPackage is skipped, not silently ignored", async () => {
    const item = await makeScheduledPublishableItem(storage, ["INSTAGRAM"]);
    await prisma.publication.deleteMany({ where: { contentItemId: item.id } });
    await prisma.platformPackage.deleteMany({ where: { contentItemId: item.id } });
    const instagram = new MockPlatformAdapter("INSTAGRAM");
    const result = await publishContentItem(prisma, storage, { INSTAGRAM: instagram }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(result.skippedPlatforms.map((s) => s.platform)).toEqual(["INSTAGRAM"]);
    expect(instagram.publishCalls).toHaveLength(0);
  });

  // --- hardening ---------------------------------------------------------------------------

  it("CRITICAL: a render with no passing QC report is never published (gate-skipped video)", async () => {
    const item = await makeScheduledPublishableItem(storage, ["TIKTOK"], { qc: null });
    const tiktok = new MockPlatformAdapter("TIKTOK");
    const result = await publishContentItem(prisma, storage, { TIKTOK: tiktok }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(result.failedPlatforms).toEqual(["TIKTOK"]);
    expect(tiktok.publishCalls).toHaveLength(0);
    const pub = await getLatestPublication(prisma, item.id, "TIKTOK");
    expect(pub?.errorMessage).toContain("No QC report");
  });

  it("Instagram without a public URL provider fails with a clear reason and never calls the adapter", async () => {
    const item = await makeScheduledPublishableItem(storage, ["INSTAGRAM"]);
    const instagram = new MockPlatformAdapter("INSTAGRAM");
    const result = await publishContentItem(prisma, storage, { INSTAGRAM: instagram }, item.id, ACTOR, {
      verifyDelaysMs: [0],
      sleep: async () => {},
    });
    expect(result.failedPlatforms).toEqual(["INSTAGRAM"]);
    expect(instagram.publishCalls).toHaveLength(0);
    expect((await getLatestPublication(prisma, item.id, "INSTAGRAM"))?.errorMessage).toContain("public video URL");
  });

  it("an unverifiable post stays unverified with a note (re-checked later), and a resolved id replaces the publish id", async () => {
    const item = await makeScheduledPublishableItem(storage, ["YOUTUBE", "TIKTOK"]);
    const youtube = new MockPlatformAdapter("YOUTUBE", {
      verifyResult: { verified: false, pending: true, rawResponse: { processing: true } },
    });
    const tiktok = new MockPlatformAdapter("TIKTOK", {
      publishResult: { status: "SUCCESS", platformPostId: "v_pub_file~123", url: null, rawResponse: { init: true } },
      verifyResult: { verified: true, rawResponse: { status: "PUBLISH_COMPLETE" }, resolvedPostId: "7400000000000000001", url: "https://www.tiktok.com/@chris/video/7400000000000000001" },
    });
    const result = await publishContentItem(prisma, storage, { YOUTUBE: youtube, TIKTOK: tiktok }, item.id, ACTOR, {
      ...FAST_PUBLISH_OPTIONS,
      verifyDelaysMs: [0, 0],
    });
    expect(result.verifiedPlatforms).toEqual(["TIKTOK"]);
    expect(youtube.verifyCalls).toHaveLength(2);

    const yt = await getLatestPublication(prisma, item.id, "YOUTUBE");
    expect(yt?.verifiedAt).toBeNull();
    expect(yt?.errorMessage).toContain("Not yet verified");

    const tt = await getLatestPublication(prisma, item.id, "TIKTOK");
    expect(tt?.verifiedAt).toBeInstanceOf(Date);
    expect(tt?.platformPostId).toBe("7400000000000000001");
    expect(tt?.url).toContain("/video/7400000000000000001");
    expect((tt?.rawResponse as { originalPlatformPostId?: string }).originalPlatformPostId).toBe("v_pub_file~123");
  });

  it("a verification caveat (YouTube uploaded-but-private) is recorded on the attempt", async () => {
    const item = await makeScheduledPublishableItem(storage, ["YOUTUBE"]);
    const youtube = new MockPlatformAdapter("YOUTUBE", {
      verifyResult: { verified: true, rawResponse: {}, note: "Uploaded but private — YouTube API audit required." },
    });
    await publishContentItem(prisma, storage, { YOUTUBE: youtube }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    const pub = await getLatestPublication(prisma, item.id, "YOUTUBE");
    expect(pub?.status).toBe("SUCCESS");
    expect(pub?.errorMessage).toContain("Uploaded but private");
  });

  it("a held publish lease (another tab / cron already publishing) skips the platform instead of double-posting", async () => {
    const item = await makeScheduledPublishableItem(storage, ["TIKTOK"]);
    const lease = await acquirePublishLease(prisma, item.id, "TIKTOK");
    expect(lease.acquired).toBe(true);
    const tiktok = new MockPlatformAdapter("TIKTOK");

    const result = await publishContentItem(prisma, storage, { TIKTOK: tiktok }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(result.skippedPlatforms[0]?.reason).toContain("already in progress");
    expect(tiktok.publishCalls).toHaveLength(0);

    if (lease.acquired) await releasePublishLease(prisma, lease.leaseId, { status: "SUCCEEDED" });
    const after = await publishContentItem(prisma, storage, { TIKTOK: tiktok }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(after.succeededPlatforms).toEqual(["TIKTOK"]);
    expect(tiktok.publishCalls).toHaveLength(1);
  });

  it("a stale lease (crashed process) is taken over", async () => {
    const item = await makeScheduledPublishableItem(storage, ["TIKTOK"]);
    await prisma.jobRun.create({
      data: { kind: publishLeaseKind(item.id, "TIKTOK"), status: "RUNNING", startedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const tiktok = new MockPlatformAdapter("TIKTOK");
    const result = await publishContentItem(prisma, storage, { TIKTOK: tiktok }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(result.succeededPlatforms).toEqual(["TIKTOK"]);
    const stale = await prisma.jobRun.findFirstOrThrow({ where: { kind: publishLeaseKind(item.id, "TIKTOK"), status: "FAILED" } });
    expect(stale.error).toContain("Stale publish lease");
  });

  it("two concurrent publish calls for the same item post each platform exactly once", async () => {
    const item = await makeScheduledPublishableItem(storage, ["TIKTOK"]);
    const tiktok = new MockPlatformAdapter("TIKTOK", { publishDelayMs: 150 });
    const results = await Promise.all([
      publishContentItem(prisma, storage, { TIKTOK: tiktok }, item.id, ACTOR, FAST_PUBLISH_OPTIONS).catch((e: unknown) => e),
      publishContentItem(prisma, storage, { TIKTOK: tiktok }, item.id, ACTOR, FAST_PUBLISH_OPTIONS).catch((e: unknown) => e),
    ]);
    expect(tiktok.publishCalls).toHaveLength(1);
    const successes = await prisma.publication.count({ where: { contentItemId: item.id, platform: "TIKTOK", status: "SUCCESS" } });
    expect(successes).toBe(1);
    void results;
  });

  it("an ambiguous failure is marked, and the retry finds the existing post instead of re-posting", async () => {
    const item = await makeScheduledPublishableItem(storage, ["INSTAGRAM"]);
    let first = true;
    const instagram = new MockPlatformAdapter("INSTAGRAM", {
      publishResult: () => {
        if (first) {
          first = false;
          throw new AmbiguousPublishError("INSTAGRAM", "media_publish got no response — it may have been published.");
        }
        return { status: "SUCCESS", platformPostId: "should-not-happen", url: null, rawResponse: null };
      },
      existingPost: { platformPostId: "ig-media-77", url: "https://www.instagram.com/reel/ABC/", rawResponse: { id: "ig-media-77" } },
    });

    const r1 = await publishContentItem(prisma, storage, { INSTAGRAM: instagram }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(r1.failedPlatforms).toEqual(["INSTAGRAM"]);
    const ambiguous = await getLatestPublication(prisma, item.id, "INSTAGRAM");
    expect(ambiguous?.errorMessage?.startsWith(AMBIGUOUS_PUBLISH_PREFIX)).toBe(true);

    const r2 = await publishContentItem(prisma, storage, { INSTAGRAM: instagram }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(r2.succeededPlatforms).toEqual(["INSTAGRAM"]);
    expect(instagram.publishCalls).toHaveLength(1); // never re-posted
    expect(instagram.findExistingPostCalls).toHaveLength(1);
    const recovered = await getLatestPublication(prisma, item.id, "INSTAGRAM");
    expect(recovered?.platformPostId).toBe("ig-media-77");
    expect(recovered?.url).toBe("https://www.instagram.com/reel/ABC/");
    expect(recovered?.verifiedAt).toBeInstanceOf(Date);
  });

  it("after an ambiguous failure, a confirmed-absent post is published normally", async () => {
    const item = await makeScheduledPublishableItem(storage, ["YOUTUBE"]);
    let first = true;
    const youtube = new MockPlatformAdapter("YOUTUBE", {
      publishResult: () => {
        if (first) {
          first = false;
          throw new AmbiguousPublishError("YOUTUBE", "upload interrupted");
        }
        return { status: "SUCCESS", platformPostId: "yt-1", url: "https://www.youtube.com/shorts/yt-1", rawResponse: null };
      },
      existingPost: null,
    });
    await publishContentItem(prisma, storage, { YOUTUBE: youtube }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    const r2 = await publishContentItem(prisma, storage, { YOUTUBE: youtube }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(r2.succeededPlatforms).toEqual(["YOUTUBE"]);
    expect(youtube.publishCalls).toHaveLength(2);
  });

  it("after an ambiguous failure, if the platform can't be checked the retry stops for a human; a further retry posts", async () => {
    const item = await makeScheduledPublishableItem(storage, ["TIKTOK"]);
    let first = true;
    const tiktok = new MockPlatformAdapter("TIKTOK", {
      publishResult: () => {
        if (first) {
          first = false;
          throw new AmbiguousPublishError("TIKTOK", "final chunk got no response");
        }
        return { status: "DRAFT", platformPostId: "pub-2", url: null, rawResponse: null };
      },
      existingPost: () => {
        throw new Error("TikTok inbox drafts can't be looked up");
      },
    });
    await publishContentItem(prisma, storage, { TIKTOK: tiktok }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    const r2 = await publishContentItem(prisma, storage, { TIKTOK: tiktok }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(r2.failedPlatforms).toEqual(["TIKTOK"]);
    expect(tiktok.publishCalls).toHaveLength(1);
    expect((await getLatestPublication(prisma, item.id, "TIKTOK"))?.errorMessage).toContain("check the account");

    const r3 = await publishContentItem(prisma, storage, { TIKTOK: tiktok }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(r3.succeededPlatforms).toEqual(["TIKTOK"]);
    expect(tiktok.publishCalls).toHaveLength(2);
  });

  it("a pending-processing attempt stores its resume token and the retry resumes with it (no re-upload)", async () => {
    const item = await makeScheduledPublishableItem(storage, ["INSTAGRAM"]);
    const instagram = new MockPlatformAdapter("INSTAGRAM", {
      publishResult: (req) =>
        req.resumeToken
          ? { status: "SUCCESS", platformPostId: "ig-9", url: "https://www.instagram.com/reel/X/", rawResponse: {} }
          : {
              status: "FAILED",
              platformPostId: null,
              url: null,
              rawResponse: { container: "IN_PROGRESS" },
              errorMessage: "PENDING_PROCESSING: still processing container c-1",
              resumeToken: { containerId: "c-1", createdAt: new Date().toISOString() },
            },
    });
    const r1 = await publishContentItem(prisma, storage, { INSTAGRAM: instagram }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(r1.failedPlatforms).toEqual(["INSTAGRAM"]);
    const pending = await getLatestPublication(prisma, item.id, "INSTAGRAM");
    expect((pending?.rawResponse as { resumeToken?: { containerId: string } }).resumeToken?.containerId).toBe("c-1");

    const r2 = await publishContentItem(prisma, storage, { INSTAGRAM: instagram }, item.id, ACTOR, FAST_PUBLISH_OPTIONS);
    expect(r2.succeededPlatforms).toEqual(["INSTAGRAM"]);
    expect(instagram.publishCalls[1]?.resumeToken).toEqual({ containerId: "c-1", createdAt: expect.any(String) });
  });
});
