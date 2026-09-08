import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";

/**
 * Spec §9 step 24's Audience Intelligence output. Deliberately not scoped to one ContentItem —
 * "only surface a pattern once it recurs across multiple comments/videos" (§12) means an
 * insight is cross-video by construction; tying it to a single `contentItemId` would misrepresent
 * what the Audience Intelligence agent is actually allowed to claim.
 */
const RecordAudienceInsightSchema = z.object({
  category: z.string().min(1),
  description: z.string().min(1),
  supportingCommentCount: z.number().int().positive(),
  exampleQuotes: z.array(z.string()).default([]),
  actionableSuggestion: z.string().nullable().optional(),
});
export type RecordAudienceInsightInput = z.input<typeof RecordAudienceInsightSchema>;

export async function recordAudienceInsight(
  prisma: PrismaClient,
  input: RecordAudienceInsightInput,
  actor: { actorId: string },
) {
  const parsed = RecordAudienceInsightSchema.parse(input);

  const insight = await prisma.audienceInsight.create({
    data: {
      category: parsed.category,
      description: parsed.description,
      supportingCommentCount: parsed.supportingCommentCount,
      exampleQuotes: parsed.exampleQuotes,
      actionableSuggestion: parsed.actionableSuggestion ?? null,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "SYSTEM",
    action: "AUDIENCE_INSIGHT_RECORDED",
    entityType: "AudienceInsight",
    entityId: insight.id,
    after: { category: insight.category, supportingCommentCount: insight.supportingCommentCount },
  });

  return insight;
}

export async function listAudienceInsights(prisma: PrismaClient, opts?: { limit?: number }) {
  return prisma.audienceInsight.findMany({ orderBy: { createdAt: "desc" }, take: opts?.limit });
}

export async function countAudienceInsights(prisma: PrismaClient) {
  return prisma.audienceInsight.count();
}
