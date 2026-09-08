import { ingestComments, type PrismaClient, type ContentPlatform } from "@chris/domain";
import type { PlatformAdapter } from "@chris/platforms";

export interface IngestCommentsForContentItemResult {
  ingestedCount: number;
  skippedCount: number;
}

/**
 * Spec §9 step 24's raw material — real comments pulled per platform (real I/O), then
 * persisted via packages/domain's idempotent `ingestComments`. One platform's fetch failing
 * (or, for TikTok, genuinely having no accessible comment endpoint at this app's tier — see
 * /docs/DECISIONS.md) never blocks ingesting the others.
 */
export async function ingestCommentsForContentItem(
  db: PrismaClient,
  adapters: Partial<Record<ContentPlatform, PlatformAdapter>>,
  contentItemId: string,
  actor: { actorId: string },
): Promise<IngestCommentsForContentItemResult> {
  const publications = await db.publication.findMany({
    where: { contentItemId, status: { in: ["SUCCESS", "DRAFT"] } },
    orderBy: { createdAt: "desc" },
  });
  const latestByPlatform = new Map<ContentPlatform, (typeof publications)[number]>();
  for (const pub of publications) {
    if (!latestByPlatform.has(pub.platform)) latestByPlatform.set(pub.platform, pub);
  }

  let ingestedCount = 0;
  let skippedCount = 0;

  for (const [platform, pub] of latestByPlatform) {
    if (!pub.platformPostId) continue;
    const adapter = adapters[platform];
    if (!adapter) continue;

    try {
      const comments = await adapter.listComments(pub.platformPostId);
      if (comments.length === 0) continue;
      const result = await ingestComments(
        db,
        comments.map((c) => ({
          contentItemId,
          platform,
          platformCommentId: c.platformCommentId,
          authorHandle: c.authorHandle,
          text: c.text,
          postedAt: c.postedAt,
        })),
        actor,
      );
      ingestedCount += result.ingestedCount;
      skippedCount += result.skippedCount;
    } catch {
      continue;
    }
  }

  return { ingestedCount, skippedCount };
}
