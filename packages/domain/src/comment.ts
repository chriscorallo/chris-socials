import type { PrismaClient, ContentPlatform } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";

/**
 * Spec §9 step 24 — real, platform-sourced comments. Ingestion is idempotent per
 * (contentItemId, platform, platformCommentId): re-ingesting the same comment is a no-op, not
 * a duplicate row or an overwrite of already-stored text (a comment's text on the platform
 * could theoretically change, but treating our own copy as the historical record of what we
 * ingested is the more defensible default — see CLAUDE.md's provenance rule).
 */
const IngestCommentSchema = z.object({
  contentItemId: z.string().min(1),
  platform: z.enum(["INSTAGRAM", "TIKTOK", "YOUTUBE"]),
  platformCommentId: z.string().min(1),
  authorHandle: z.string().nullable().optional(),
  text: z.string().min(1),
  postedAt: z.coerce.date().nullable().optional(),
});
export type IngestCommentInput = z.input<typeof IngestCommentSchema>;

export interface IngestCommentsResult {
  ingestedCount: number;
  skippedCount: number;
}

/** Sequential, not `Promise.all` — this sandbox's PGlite dev database can't reliably handle
 * concurrently dispatched Prisma queries (see /docs/DECISIONS.md); a comment batch is small
 * enough that sequential upserts cost nothing that matters. */
export async function ingestComments(
  prisma: PrismaClient,
  comments: IngestCommentInput[],
  actor: { actorId: string },
): Promise<IngestCommentsResult> {
  let ingestedCount = 0;
  let skippedCount = 0;

  for (const raw of comments) {
    const parsed = IngestCommentSchema.parse(raw);
    const existing = await prisma.comment.findUnique({
      where: {
        contentItemId_platform_platformCommentId: {
          contentItemId: parsed.contentItemId,
          platform: parsed.platform,
          platformCommentId: parsed.platformCommentId,
        },
      },
    });
    if (existing) {
      skippedCount++;
      continue;
    }
    await prisma.comment.create({
      data: {
        contentItemId: parsed.contentItemId,
        platform: parsed.platform,
        platformCommentId: parsed.platformCommentId,
        authorHandle: parsed.authorHandle ?? null,
        text: parsed.text,
        postedAt: parsed.postedAt ?? null,
      },
    });
    ingestedCount++;
  }

  if (ingestedCount > 0) {
    await recordAudit(prisma, {
      actor: actor.actorId,
      actorType: "SYSTEM",
      action: "COMMENTS_INGESTED",
      entityType: "ContentItem",
      entityId: comments[0]?.contentItemId ?? "unknown",
      after: { ingestedCount, skippedCount },
    });
  }

  return { ingestedCount, skippedCount };
}

export async function listCommentsForContentItem(
  prisma: PrismaClient,
  contentItemId: string,
  platform?: ContentPlatform,
) {
  return prisma.comment.findMany({
    where: { contentItemId, ...(platform ? { platform } : {}) },
    orderBy: { ingestedAt: "desc" },
  });
}
