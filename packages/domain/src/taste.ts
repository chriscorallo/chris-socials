import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";

/**
 * Human Taste Model (spec §7) — TASTE_LEARNER.md: "preserve the original wording alongside
 * the tag — the raw feedback is evidence; the tag is your interpretation of it." Raw feedback
 * (`TasteFeedback`) and the derived, accumulated read (`ChrisAcceptanceProbability`) are
 * deliberately separate: the Taste Learner agent reads a batch of `TasteFeedback` and produces
 * `ChrisAcceptanceProbability` rows, but nothing here lets one rejection silently become a
 * universal rule — that judgment belongs to the agent (packages/agents), which is instructed
 * to require accumulated evidence across contexts, not to this persistence layer.
 */
export const RecordTasteFeedbackSchema = z.object({
  contentItemId: z.string().nullable().optional(),
  artifactType: z.string().min(1),
  rawFeedback: z.string().min(1),
  normalizedTag: z.string().min(1),
  productionTier: z.enum(["RAW", "FAST", "MEDIUM", "HERO"]).nullable().optional(),
});
export type RecordTasteFeedbackInput = z.input<typeof RecordTasteFeedbackSchema>;

export async function recordTasteFeedback(
  prisma: PrismaClient,
  input: RecordTasteFeedbackInput,
  actor: { actorId: string },
) {
  const parsed = RecordTasteFeedbackSchema.parse(input);

  const feedback = await prisma.tasteFeedback.create({
    data: {
      contentItemId: parsed.contentItemId ?? null,
      artifactType: parsed.artifactType,
      rawFeedback: parsed.rawFeedback,
      normalizedTag: parsed.normalizedTag,
      productionTier: parsed.productionTier ?? null,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "TASTE_FEEDBACK_RECORDED",
    entityType: "TasteFeedback",
    entityId: feedback.id,
    after: { artifactType: feedback.artifactType, normalizedTag: feedback.normalizedTag },
  });

  return feedback;
}

export async function listTasteFeedback(
  prisma: PrismaClient,
  opts?: { artifactType?: string; normalizedTag?: string; limit?: number },
) {
  return prisma.tasteFeedback.findMany({
    where: { artifactType: opts?.artifactType, normalizedTag: opts?.normalizedTag },
    orderBy: { createdAt: "desc" },
    take: opts?.limit,
  });
}

export async function countTasteFeedback(
  prisma: PrismaClient,
  opts?: { artifactType?: string; normalizedTag?: string },
) {
  return prisma.tasteFeedback.count({
    where: { artifactType: opts?.artifactType, normalizedTag: opts?.normalizedTag },
  });
}

const RecordAcceptanceProbabilitySchema = z.object({
  artifactType: z.string().min(1),
  tag: z.string().min(1),
  context: z.record(z.string(), z.unknown()).default({}),
  probability: z.number().min(0).max(1),
  sampleSize: z.number().int().positive(),
  generalizes: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type RecordAcceptanceProbabilityInput = z.input<typeof RecordAcceptanceProbabilitySchema>;

/** Append-only, like everything else derived from episodic memory — a later, better-evidenced
 * read supersedes an earlier one by being more recent (`getLatestAcceptanceProbability`), not
 * by overwriting it. */
export async function recordChrisAcceptanceProbability(
  prisma: PrismaClient,
  input: RecordAcceptanceProbabilityInput,
) {
  const parsed = RecordAcceptanceProbabilitySchema.parse(input);
  return prisma.chrisAcceptanceProbability.create({
    data: {
      artifactType: parsed.artifactType,
      tag: parsed.tag,
      context: parsed.context as never,
      probability: parsed.probability,
      sampleSize: parsed.sampleSize,
      generalizes: parsed.generalizes,
      confidence: parsed.confidence,
    },
  });
}

export async function listAcceptanceProbabilities(prisma: PrismaClient, artifactType?: string) {
  return prisma.chrisAcceptanceProbability.findMany({
    where: artifactType ? { artifactType } : undefined,
    orderBy: { createdAt: "desc" },
  });
}

export async function getLatestAcceptanceProbability(
  prisma: PrismaClient,
  artifactType: string,
  tag: string,
) {
  return prisma.chrisAcceptanceProbability.findFirst({
    where: { artifactType, tag },
    orderBy: { createdAt: "desc" },
  });
}
