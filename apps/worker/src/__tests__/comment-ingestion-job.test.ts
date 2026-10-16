import { describe, it, expect } from "vitest";
import { prisma, createContentItem, applyTransition, listCommentsForContentItem } from "@chris/domain";
import { MockPlatformAdapter } from "@chris/platforms";
import { ingestCommentsForContentItem } from "../comment-ingestion-job";

async function makePublishedItem(platforms: ("INSTAGRAM" | "TIKTOK" | "YOUTUBE")[]) {
  const item = await createContentItem(prisma, { title: "Comment ingestion job test idea" }, {
    actorId: "test-user",
  });
  for (const to of [
    "SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED",
    "READY_TO_FILM", "FILMED", "MEDIA_INGESTED", "TAKE_SELECTED", "EDIT_PLANNED", "EDITING",
    "RENDERED", "READY", "SCHEDULED", "PUBLISHING", "PUBLISHED",
  ] as const) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
  }
  for (const platform of platforms) {
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
        platformPostId: `real-post-${platform}`,
        publishedAt: new Date(),
      },
    });
  }
  return item;
}

describe("ingestCommentsForContentItem", () => {
  it("ingests real comments from each published platform", async () => {
    const item = await makePublishedItem(["YOUTUBE", "INSTAGRAM"]);
    const youtube = new MockPlatformAdapter("YOUTUBE", {
      commentsResult: [{ platformCommentId: "yt-1", authorHandle: "@a", text: "Great video!", postedAt: new Date() }],
    });
    const instagram = new MockPlatformAdapter("INSTAGRAM", {
      commentsResult: [{ platformCommentId: "ig-1", authorHandle: "@b", text: "Very helpful.", postedAt: null }],
    });

    const result = await ingestCommentsForContentItem(
      prisma,
      { YOUTUBE: youtube, INSTAGRAM: instagram },
      item.id,
      { actorId: "chris" },
    );

    expect(result).toMatchObject({ ingestedCount: 2, skippedCount: 0 });
    const comments = await listCommentsForContentItem(prisma, item.id);
    expect(comments).toHaveLength(2);
  });

  it("TikTok's empty comment list (no accessible endpoint at this tier) doesn't error — just nothing to ingest", async () => {
    const item = await makePublishedItem(["TIKTOK"]);
    const tiktok = new MockPlatformAdapter("TIKTOK"); // default commentsResult: []

    const result = await ingestCommentsForContentItem(prisma, { TIKTOK: tiktok }, item.id, { actorId: "chris" });
    expect(result).toMatchObject({ ingestedCount: 0, skippedCount: 0 });
  });

  it("re-running ingestion is idempotent — already-ingested comments are skipped, not duplicated", async () => {
    const item = await makePublishedItem(["YOUTUBE"]);
    const youtube = new MockPlatformAdapter("YOUTUBE", {
      commentsResult: [{ platformCommentId: "yt-1", authorHandle: "@a", text: "Nice.", postedAt: null }],
    });

    const first = await ingestCommentsForContentItem(prisma, { YOUTUBE: youtube }, item.id, { actorId: "chris" });
    expect(first).toMatchObject({ ingestedCount: 1, skippedCount: 0 });

    const second = await ingestCommentsForContentItem(prisma, { YOUTUBE: youtube }, item.id, { actorId: "chris" });
    expect(second).toMatchObject({ ingestedCount: 0, skippedCount: 1 });

    const comments = await listCommentsForContentItem(prisma, item.id);
    expect(comments).toHaveLength(1);
  });

  it("one platform's comment fetch failing does not stop ingesting the others", async () => {
    const item = await makePublishedItem(["YOUTUBE", "INSTAGRAM"]);
    const youtube = new MockPlatformAdapter("YOUTUBE", {
      commentsResult: [{ platformCommentId: "yt-1", authorHandle: null, text: "ok", postedAt: null }],
    });
    const instagram = new MockPlatformAdapter("INSTAGRAM", {
      commentsResult: () => {
        throw new Error("simulated Instagram API outage");
      },
    });

    const result = await ingestCommentsForContentItem(
      prisma,
      { YOUTUBE: youtube, INSTAGRAM: instagram },
      item.id,
      { actorId: "chris" },
    );
    expect(result).toMatchObject({ ingestedCount: 1, skippedCount: 0 });
    // The failure is reported, not silently treated as "no comments".
    expect(result.errors).toEqual([{ platform: "INSTAGRAM", message: "simulated Instagram API outage" }]);

    const comments = await listCommentsForContentItem(prisma, item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.platform).toBe("YOUTUBE");
  });
});
