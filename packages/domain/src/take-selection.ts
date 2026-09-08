import type { PrismaClient, ContentState } from "@prisma/client";
import { z } from "zod";
import { writeTransition } from "./state-machine";

/** Spec §9 step 11. Choosing a take moves MEDIA_INGESTED -> TAKE_SELECTED — same
 * "issuing X advances state" pattern as ProductionContract/CreatorCard (atomic write via
 * writeTransition, see /docs/DECISIONS.md). Not unique per ContentItem: a take can be
 * re-selected (new footage, a bad first pick), and each attempt is a permanent record. */
export class TakeSelectionRequiresMediaIngestedStateError extends Error {
  constructor(actual: ContentState) {
    super(`A take can only be selected from MEDIA_INGESTED (current state: ${actual}).`);
    this.name = "TakeSelectionRequiresMediaIngestedStateError";
  }
}

export const RecordTakeSelectionSchema = z.object({
  contentItemId: z.string().min(1),
  selectedMediaAssetId: z.string().min(1),
  backupMediaAssetId: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  materialDefects: z.array(z.string()).default([]),
});
export type RecordTakeSelectionInput = z.input<typeof RecordTakeSelectionSchema>;

export async function recordTakeSelection(
  prisma: PrismaClient,
  input: RecordTakeSelectionInput,
  actor: { actorId: string },
) {
  const parsed = RecordTakeSelectionSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const item = await tx.contentItem.findUniqueOrThrow({
      where: { id: parsed.contentItemId },
    });
    if (item.currentState !== "MEDIA_INGESTED") {
      throw new TakeSelectionRequiresMediaIngestedStateError(item.currentState);
    }

    const takeSelection = await tx.takeSelection.create({
      data: {
        contentItemId: parsed.contentItemId,
        selectedMediaAssetId: parsed.selectedMediaAssetId,
        backupMediaAssetId: parsed.backupMediaAssetId ?? null,
        confidence: parsed.confidence,
        reason: parsed.reason,
        materialDefects: parsed.materialDefects,
      },
    });

    await writeTransition(tx, {
      contentItemId: parsed.contentItemId,
      fromState: "MEDIA_INGESTED",
      toState: "TAKE_SELECTED",
      reason: "Take selected",
      actorType: "HUMAN",
      actorId: actor.actorId,
      auditAction: "TAKE_SELECTED",
    });

    return takeSelection;
  });
}

export async function getLatestTakeSelection(prisma: PrismaClient, contentItemId: string) {
  return prisma.takeSelection.findFirst({
    where: { contentItemId },
    orderBy: { createdAt: "desc" },
  });
}
