import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";

/** Adversarial Evaluator's output — advisory only (ADVERSARIAL_EVALUATOR.md: "you report
 * risks; the Creative Director and hard gates decide what happens next"). Persisted so a past
 * critique is real, queryable evidence rather than a recomputed-and-discarded read. */
const ConcernSchema = z.object({
  description: z.string(),
  whyItMatters: z.string(),
  evidence: z.string(),
});

export const RecordAdversarialCritiqueSchema = z.object({
  artifactType: z.string().min(1),
  artifactId: z.string().min(1),
  contentItemId: z.string().nullable().optional(),
  concerns: z.array(ConcernSchema),
  noMaterialWeaknessesFound: z.boolean(),
});
export type RecordAdversarialCritiqueInput = z.input<typeof RecordAdversarialCritiqueSchema>;

export async function recordAdversarialCritique(
  prisma: PrismaClient,
  input: RecordAdversarialCritiqueInput,
  actor: { actorId: string },
) {
  const parsed = RecordAdversarialCritiqueSchema.parse(input);

  const critique = await prisma.adversarialCritique.create({
    data: {
      artifactType: parsed.artifactType,
      artifactId: parsed.artifactId,
      contentItemId: parsed.contentItemId ?? null,
      concerns: parsed.concerns,
      noMaterialWeaknessesFound: parsed.noMaterialWeaknessesFound,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "SYSTEM",
    action: "ADVERSARIAL_CRITIQUE_RECORDED",
    entityType: "AdversarialCritique",
    entityId: critique.id,
    after: { artifactType: critique.artifactType, concernCount: parsed.concerns.length },
  });

  return critique;
}

export async function listAdversarialCritiques(prisma: PrismaClient, contentItemId?: string) {
  return prisma.adversarialCritique.findMany({
    where: contentItemId ? { contentItemId } : undefined,
    orderBy: { createdAt: "desc" },
  });
}
