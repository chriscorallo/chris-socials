import type { PrismaClient, ContentState } from "@prisma/client";
import { z } from "zod";
import { writeTransition, applyTransition } from "./state-machine";
import { recordAudit } from "./audit";

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

/** States from which a NEW plan may replace the current one without a state transition:
 * EDIT_PLANNED (re-plan before rendering — e.g. after the QC_BLOCKED -> EDIT_PLANNED rollback)
 * and QC_REPAIR (the auto-repair loop's revised plan, rendered next straight from QC_REPAIR). */
const REPLAN_STATES = new Set<ContentState>(["EDIT_PLANNED", "QC_REPAIR"]);

export class ReplanNotAllowedError extends Error {
  constructor(actual: ContentState) {
    super(`An Edit Plan can only be revised from EDIT_PLANNED or QC_REPAIR (current state: ${actual}).`);
    this.name = "ReplanNotAllowedError";
  }
}

export const RecordReplannedEditPlanSchema = RecordEditPlanSchema.extend({
  /** The plan this one revises. Set by the automated repair loop, so the revision stays in
   * the same repair chain and shares its MAX_REPAIR_ATTEMPTS budget (render-record.ts).
   * Null for a human-initiated re-plan, which deliberately starts a fresh chain/budget. */
  revisionOfEditPlanId: z.string().min(1).nullable(),
  revisionReason: z.string().min(1),
});
export type RecordReplannedEditPlanInput = z.input<typeof RecordReplannedEditPlanSchema>;

/** Append-only: the previous plan and its renders stay as history. No state transition — the
 * next render reads getLatestEditPlan. See /docs/DECISIONS.md ("Repair loop: revised plans"). */
export async function recordReplannedEditPlan(
  prisma: PrismaClient,
  input: RecordReplannedEditPlanInput,
  actor: { actorId: string; actorType?: "HUMAN" | "SYSTEM" },
) {
  const parsed = RecordReplannedEditPlanSchema.parse(input);
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: parsed.contentItemId } });
  if (!REPLAN_STATES.has(item.currentState)) {
    throw new ReplanNotAllowedError(item.currentState);
  }

  const editPlan = await prisma.editPlan.create({
    data: {
      contentItemId: parsed.contentItemId,
      takeSelectionId: parsed.takeSelectionId,
      productionTier: parsed.productionTier,
      targetDurationSeconds: parsed.targetDurationSeconds,
      doNothingElse: parsed.doNothingElse,
      plan: parsed.plan as never,
      revisionOfEditPlanId: parsed.revisionOfEditPlanId,
      revisionReason: parsed.revisionReason,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: actor.actorType ?? "HUMAN",
    action: parsed.revisionOfEditPlanId ? "EDIT_PLAN_REVISED" : "EDIT_PLAN_REPLANNED",
    entityType: "ContentItem",
    entityId: parsed.contentItemId,
    after: {
      editPlanId: editPlan.id,
      revisionOfEditPlanId: parsed.revisionOfEditPlanId,
      revisionReason: parsed.revisionReason,
    },
  });

  return editPlan;
}

/** Every EditPlan id in the same repair chain as `editPlanId` (its root plus all automated
 * revisions descending from that root). Chains are tiny (bounded by MAX_REPAIR_ATTEMPTS), so
 * a simple walk is fine. */
export async function getRepairChainEditPlanIds(
  prisma: PrismaClient,
  editPlanId: string,
): Promise<string[]> {
  let rootId = editPlanId;
  for (let hops = 0; hops < 50; hops++) {
    const row = await prisma.editPlan.findUniqueOrThrow({
      where: { id: rootId },
      select: { revisionOfEditPlanId: true },
    });
    if (!row.revisionOfEditPlanId) break;
    rootId = row.revisionOfEditPlanId;
  }
  const chain = [rootId];
  for (let i = 0; i < chain.length; i++) {
    const children = await prisma.editPlan.findMany({
      where: { revisionOfEditPlanId: chain[i] },
      select: { id: true },
    });
    chain.push(...children.map((c) => c.id));
  }
  return chain;
}

/** States from which Chris can save a finishing edit (the in-app editor). */
export const FINISHING_EDIT_STATES = new Set<ContentState>([
  "EDIT_PLANNED",
  "RENDERED",
  "QC_REPAIR",
  "QC_BLOCKED",
  "READY",
  "SCHEDULED",
]);

export class FinishingEditNotAllowedError extends Error {
  constructor(actual: ContentState) {
    super(
      `This video can't be edited while it's ${actual}. Finishing edits are possible once it has an edit plan and before it publishes.`,
    );
    this.name = "FinishingEditNotAllowedError";
  }
}

/**
 * Saves Chris's finishing edit (an EditTimeline from the in-app editor — validated by the
 * caller against packages/media's EditTimelineSchema; domain stays dependency-free) as a NEW
 * EditPlan row carrying `plan.timeline`. Append-only: every save is a version.
 *
 * If the item is past planning (RENDERED / QC_REPAIR / QC_BLOCKED / READY / SCHEDULED) it is
 * rolled back to EDIT_PLANNED first — a previous render's hard-gate PASS doesn't cover the new
 * edit, so it must render and pass the gates again before it can be scheduled. A human edit
 * starts a fresh repair chain (revisionOfEditPlanId null).
 */
export async function saveFinishingEdit(
  prisma: PrismaClient,
  input: { contentItemId: string; timeline: unknown; durationSeconds: number; actorId: string; note?: string },
) {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: input.contentItemId } });
  if (!FINISHING_EDIT_STATES.has(item.currentState)) {
    throw new FinishingEditNotAllowedError(item.currentState);
  }
  const base = await getLatestEditPlan(prisma, input.contentItemId);
  if (!base) throw new Error("This item has no edit plan yet — run the Edit Planner first.");

  if (item.currentState !== "EDIT_PLANNED") {
    await applyTransition(prisma, {
      contentItemId: input.contentItemId,
      to: "EDIT_PLANNED",
      actorType: "HUMAN",
      actorId: input.actorId,
      reason: "Finishing edit saved — re-render and re-check before scheduling",
    });
  }

  const basePlan = (base.plan ?? {}) as Record<string, unknown>;
  return recordReplannedEditPlan(
    prisma,
    {
      contentItemId: input.contentItemId,
      takeSelectionId: base.takeSelectionId,
      productionTier: base.productionTier,
      targetDurationSeconds: Math.max(0.1, input.durationSeconds),
      doNothingElse: false,
      plan: { ...basePlan, timeline: input.timeline },
      revisionOfEditPlanId: null,
      revisionReason: input.note?.trim() ? `Finishing edit by Chris: ${input.note.trim()}` : "Finishing edit by Chris",
    },
    { actorId: input.actorId, actorType: "HUMAN" },
  );
}
