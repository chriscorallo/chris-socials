import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { ingestComments, listCommentsForContentItem } from "../comment";
import { recordAudienceInsight, listAudienceInsights } from "../audience-insight";

describe("ingestComments", () => {
  it("ingests new comments and persists their real fields", async () => {
    const item = await createContentItem(prisma, { title: "Comment test idea" }, { actorId: "test" });
    const result = await ingestComments(
      prisma,
      [
        {
          contentItemId: item.id,
          platform: "YOUTUBE",
          platformCommentId: "yt-c1",
          authorHandle: "@viewer1",
          text: "This was really helpful, thank you!",
          postedAt: "2026-09-01T00:00:00Z",
        },
      ],
      { actorId: "chris" },
    );
    expect(result).toEqual({ ingestedCount: 1, skippedCount: 0 });

    const comments = await listCommentsForContentItem(prisma, item.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.text).toContain("really helpful");
    expect(comments[0]?.authorHandle).toBe("@viewer1");
  });

  it("re-ingesting the same platformCommentId is a no-op, not a duplicate", async () => {
    const item = await createContentItem(prisma, { title: "Idempotent comment test" }, { actorId: "test" });
    const comment = {
      contentItemId: item.id,
      platform: "INSTAGRAM" as const,
      platformCommentId: "ig-c1",
      authorHandle: "@viewer2",
      text: "Original text.",
      postedAt: null,
    };
    await ingestComments(prisma, [comment], { actorId: "chris" });
    const second = await ingestComments(prisma, [comment], { actorId: "chris" });

    expect(second).toEqual({ ingestedCount: 0, skippedCount: 1 });
    const comments = await listCommentsForContentItem(prisma, item.id);
    expect(comments).toHaveLength(1);
  });

  it("the same platformCommentId on a different platform is a distinct comment", async () => {
    const item = await createContentItem(prisma, { title: "Cross-platform id test" }, { actorId: "test" });
    await ingestComments(
      prisma,
      [
        { contentItemId: item.id, platform: "INSTAGRAM", platformCommentId: "shared-id", text: "IG comment" },
        { contentItemId: item.id, platform: "TIKTOK", platformCommentId: "shared-id", text: "TikTok comment" },
      ],
      { actorId: "chris" },
    );
    const comments = await listCommentsForContentItem(prisma, item.id);
    expect(comments).toHaveLength(2);
  });

  it("filters by platform when asked", async () => {
    const item = await createContentItem(prisma, { title: "Platform filter test" }, { actorId: "test" });
    await ingestComments(
      prisma,
      [
        { contentItemId: item.id, platform: "YOUTUBE", platformCommentId: "yt-1", text: "yt" },
        { contentItemId: item.id, platform: "TIKTOK", platformCommentId: "tt-1", text: "tt" },
      ],
      { actorId: "chris" },
    );
    const ytOnly = await listCommentsForContentItem(prisma, item.id, "YOUTUBE");
    expect(ytOnly).toHaveLength(1);
    expect(ytOnly[0]?.text).toBe("yt");
  });
});

describe("recordAudienceInsight", () => {
  it("persists a cross-video insight, not tied to a single ContentItem", async () => {
    const insight = await recordAudienceInsight(
      prisma,
      {
        category: "questions",
        description: "Viewers repeatedly ask how this applies to a Roth IRA specifically.",
        supportingCommentCount: 7,
        exampleQuotes: ["does this work for a Roth?", "what about Roth accounts"],
        actionableSuggestion: "Make a dedicated Roth IRA follow-up video.",
      },
      { actorId: "chris" },
    );
    expect(insight.category).toBe("questions");
    expect(insight.supportingCommentCount).toBe(7);

    const all = await listAudienceInsights(prisma);
    expect(all.some((i) => i.id === insight.id)).toBe(true);
  });
});
