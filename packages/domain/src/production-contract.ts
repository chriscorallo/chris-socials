import type { PrismaClient, ContentState } from "@prisma/client";
import { z } from "zod";
import { writeTransition } from "./state-machine";

/**
 * Production Contract — spec §9 step 4. Issuing one is what moves a ContentItem
 * SELECTED -> CONTRACTED; the two writes happen in one transaction via writeTransition so
 * there's no window where a contract exists but the state hasn't advanced (or vice versa).
 */
export class ContractRequiresSelectedStateError extends Error {
  constructor(actual: ContentState) {
    super(`A Production Contract can only be issued from SELECTED (current state: ${actual}).`);
    this.name = "ContractRequiresSelectedStateError";
  }
}

export const CreateProductionContractSchema = z
  .object({
    contentItemId: z.string().min(1),
    purpose: z.string().min(1),
    primaryIdea: z.string().min(1),
    audiencePromise: z.string().min(1),
    topic: z.string().min(1),
    format: z.string().min(1),
    productionTier: z.enum(["RAW", "FAST", "MEDIUM", "HERO"]),
    targetLengthMinSeconds: z.number().int().nonnegative(),
    targetLengthMaxSeconds: z.number().int().nonnegative(),
    researchDepth: z.enum(["NONE", "LIGHT", "STANDARD", "DEEP"]),
    factualRisk: z.enum(["LOW", "MEDIUM", "HIGH"]),
    experiment: z.string().optional(),
    platformOpportunities: z.array(z.string()).default([]),
    humanEditingBudgetMinutes: z.number().int().nonnegative().optional(),
    requiredAssets: z.array(z.string()).default([]),
    scope: z.string().min(1),
    // Mandatory per spec §9 step 4 — deliberately not .optional().
    doNotExpandInto: z.string().min(1),
  })
  .refine((data) => data.targetLengthMaxSeconds >= data.targetLengthMinSeconds, {
    message: "targetLengthMaxSeconds must be >= targetLengthMinSeconds",
    path: ["targetLengthMaxSeconds"],
  });

// z.input, not z.infer: several fields use .default(...), which zod makes optional on the
// *input* side (what a caller may omit) but required on the *output* side (post-parse). The
// exported type describes what callers pass in, so it must be the input shape — see
// /docs/DECISIONS.md's z.infer-vs-z.input note (originally hit on ScheduleEntry's date field).
export type CreateProductionContractInput = z.input<typeof CreateProductionContractSchema>;

export async function createProductionContractAndAdvance(
  prisma: PrismaClient,
  input: CreateProductionContractInput,
  actor: { actorId: string },
) {
  const parsed = CreateProductionContractSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const item = await tx.contentItem.findUniqueOrThrow({
      where: { id: parsed.contentItemId },
    });
    if (item.currentState !== "SELECTED") {
      throw new ContractRequiresSelectedStateError(item.currentState);
    }

    const contract = await tx.productionContract.create({
      data: {
        contentItemId: parsed.contentItemId,
        purpose: parsed.purpose,
        primaryIdea: parsed.primaryIdea,
        audiencePromise: parsed.audiencePromise,
        topic: parsed.topic,
        format: parsed.format,
        productionTier: parsed.productionTier,
        targetLengthMinSeconds: parsed.targetLengthMinSeconds,
        targetLengthMaxSeconds: parsed.targetLengthMaxSeconds,
        researchDepth: parsed.researchDepth,
        factualRisk: parsed.factualRisk,
        experiment: parsed.experiment,
        platformOpportunities: parsed.platformOpportunities,
        humanEditingBudgetMinutes: parsed.humanEditingBudgetMinutes,
        requiredAssets: parsed.requiredAssets,
        scope: parsed.scope,
        doNotExpandInto: parsed.doNotExpandInto,
      },
    });

    await writeTransition(tx, {
      contentItemId: parsed.contentItemId,
      fromState: "SELECTED",
      toState: "CONTRACTED",
      reason: "Production Contract issued",
      actorType: "HUMAN",
      actorId: actor.actorId,
      auditAction: "PRODUCTION_CONTRACT_CREATED",
    });

    return contract;
  });
}

export async function getProductionContract(prisma: PrismaClient, contentItemId: string) {
  return prisma.productionContract.findUnique({ where: { contentItemId } });
}
