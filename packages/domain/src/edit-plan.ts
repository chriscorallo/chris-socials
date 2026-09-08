import type { PrismaClient, ContentState } from "@prisma/client";
import { z } from "zod";
import { writeTransition } from "./state-machine";

/** Spec §9 step 12. "The LLM decides, the renderer executes." Creating an EditPlan moves
 * TAKE_SELECTED -> EDIT_PLANNED. `plan` carries the full structured instruction set —
 * packages/agents defines its Zod schema independently (package-boundary rule, see
 * /docs/ARCHITECTURE.md); this module only validates the handful of fields it needs as real
 * columns and passes the rest through as JSON. */
export class EditPlanRequiresTakeSelectedStateError extends Error {
  constructor(actual: ContentState) {
    super(`An EditPlan can only be created from TAKE_SELECTED (current state: ${actual}).`);
    this.name = "EditPlanRequiresTakeSelectedStateError";
  }
}

export const RecordEditPlanSchema = z.object({
  contentItemId: z.string().min(1),
  takeSelectionId: z.string().min(1),
  productionTier: z.enum(["RAW", "FAST", "MEDIUM", "HERO"]),
  targetDurationSeconds: z.number().positive(),
  doNothingElse: z.boolean().default(false),
  plan: z.unknown(),
});
export type RecordEditPlanInput = z.input<typeof RecordEditPlanSchema>;

export async function recordEditPlan(
  prisma: PrismaClient,
  input: RecordEditPlanInput,
  actor: { actorId: string },
) {
  const parsed = RecordEditPlanSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const item = await tx.contentItem.findUniqueOrThrow({
      where: { id: parsed.contentItemId },
    });
    if (item.currentState !== "TAKE_SELECTED") {
      throw new EditPlanRequiresTakeSelectedStateError(item.currentState);
    }

    const editPlan = await tx.editPlan.create({
      data: {
        contentItemId: parsed.contentItemId,
        takeSelectionId: parsed.takeSelectionId,
        productionTier: parsed.productionTier,
        targetDurationSeconds: parsed.targetDurationSeconds,
        doNothingElse: parsed.doNothingElse,
        plan: parsed.plan as never,
      },
    });

    await writeTransition(tx, {
      contentItemId: parsed.contentItemId,
      fromState: "TAKE_SELECTED",
      toState: "EDIT_PLANNED",
      reason: "Edit Plan created",
      actorType: "HUMAN",
      actorId: actor.actorId,
      auditAction: "EDIT_PLAN_CREATED",
    });

    return editPlan;
  });
}

export async function getLatestEditPlan(prisma: PrismaClient, contentItemId: string) {
  return prisma.editPlan.findFirst({
    where: { contentItemId },
    orderBy: { createdAt: "desc" },
  });
}
