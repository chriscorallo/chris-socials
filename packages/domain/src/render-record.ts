import type { PrismaClient, ContentState } from "@prisma/client";
import { z } from "zod";
import { applyTransition } from "./state-machine";

/**
 * Render persistence + the EDITING -> RENDERED -> (QC_REPAIR | READY) loop — spec §9 steps
 * 13-16. Render rows are append-only (one per attempt, including repair re-renders); the
 * `attempt` counter feeds the repair-iteration limit (spec §9 step 15's "use maximum repair
 * iteration limits"). Deliberately does NOT auto-advance RENDERED -> READY — that requires
 * ALL hard gates (factual, brand, technical) per /docs/ARCHITECTURE.md, and only Technical
 * QC exists so far (Phase 4 builds the rest). A technical QC FAIL, though, is real and
 * deterministic today, so it *does* drive RENDERED -> QC_REPAIR/QC_BLOCKED autonomously —
 * consistent with hard gates having that authority per spec §5.
 */
/** Only EDIT_PLANNED -> EDITING needs this explicit "start" step. A repair re-render goes
 * directly from QC_REPAIR (there's no QC_REPAIR -> EDITING transition in the state table —
 * see /docs/STATE_MACHINE.md) straight into a new recordRenderAttempt call. */
export class RenderRequiresEditPlannedStateError extends Error {
  constructor(actual: ContentState) {
    super(`Rendering can only start from EDIT_PLANNED (current state: ${actual}).`);
    this.name = "RenderRequiresEditPlannedStateError";
  }
}

/** Shared with quality-gate.ts — a Quality Gate BLOCK re-enters the same
 * EDIT -> RENDER -> INSPECT -> REPAIR loop (spec §9 step 15) as a technical-QC FAIL, keyed off
 * the same per-EditPlan Render `attempt` counter, not a second independent counter. */
export const MAX_REPAIR_ATTEMPTS = 3;

export async function startRendering(
  prisma: PrismaClient,
  contentItemId: string,
  actor: { actorId: string },
) {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (item.currentState !== "EDIT_PLANNED") {
    throw new RenderRequiresEditPlannedStateError(item.currentState);
  }
  return applyTransition(prisma, {
    contentItemId,
    to: "EDITING",
    actorType: "HUMAN",
    actorId: actor.actorId,
    reason: "Render started",
  });
}

const RecordRenderAttemptSchema = z.object({
  contentItemId: z.string().min(1),
  editPlanId: z.string().min(1),
  status: z.enum(["SUCCESS", "FAILED"]),
  storageKey: z.string().nullable().optional(),
  durationSeconds: z.number().nullable().optional(),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  fileSizeBytes: z.number().int().nullable().optional(),
  technicalQCReport: z.unknown().optional(),
  errorMessage: z.string().nullable().optional(),
});
export type RecordRenderAttemptInput = z.input<typeof RecordRenderAttemptSchema>;

export async function recordRenderAttempt(
  prisma: PrismaClient,
  input: RecordRenderAttemptInput,
  actor: { actorId: string },
) {
  const parsed = RecordRenderAttemptSchema.parse(input);

  const priorAttempts = await prisma.render.count({
    where: { contentItemId: parsed.contentItemId, editPlanId: parsed.editPlanId },
  });
  const attempt = priorAttempts + 1;

  const render = await prisma.render.create({
    data: {
      contentItemId: parsed.contentItemId,
      editPlanId: parsed.editPlanId,
      attempt,
      status: parsed.status,
      storageKey: parsed.storageKey ?? null,
      durationSeconds: parsed.durationSeconds ?? null,
      width: parsed.width ?? null,
      height: parsed.height ?? null,
      fileSizeBytes: parsed.fileSizeBytes ?? null,
      technicalQCReport: (parsed.technicalQCReport ?? undefined) as never,
      errorMessage: parsed.errorMessage ?? null,
    },
  });

  if (parsed.status !== "SUCCESS") {
    // A technical execution failure (ffmpeg crashed, bad input) is not a QC finding — stays
    // wherever it was (EDITING or QC_REPAIR) for a retry, no transition.
    return render;
  }

  const item = await prisma.contentItem.findUniqueOrThrow({
    where: { id: parsed.contentItemId },
  });
  if (item.currentState === "EDITING" || item.currentState === "QC_REPAIR") {
    await applyTransition(prisma, {
      contentItemId: parsed.contentItemId,
      to: "RENDERED",
      actorType: "SYSTEM",
      actorId: actor.actorId,
      reason: `Render attempt ${attempt} succeeded`,
    });
  }

  const qc = parsed.technicalQCReport as { overall?: "PASS" | "FAIL" } | undefined;
  if (qc?.overall === "FAIL") {
    // RENDERED -> QC_BLOCKED isn't a valid transition (see /docs/STATE_MACHINE.md) —
    // QC_BLOCKED is only reachable via QC_REPAIR. Always land in QC_REPAIR first; only then,
    // if the repair-iteration limit is already hit, immediately follow with the second
    // documented transition QC_REPAIR -> QC_BLOCKED.
    await applyTransition(prisma, {
      contentItemId: parsed.contentItemId,
      to: "QC_REPAIR",
      actorType: "SYSTEM",
      actorId: actor.actorId,
      reason: "Technical QC failed",
    });

    if (attempt >= MAX_REPAIR_ATTEMPTS) {
      await applyTransition(prisma, {
        contentItemId: parsed.contentItemId,
        to: "QC_BLOCKED",
        actorType: "SYSTEM",
        actorId: actor.actorId,
        reason: `Technical QC failed after ${attempt} attempts (repair limit reached)`,
      });
    }
  }

  return render;
}

export async function listRendersForEditPlan(prisma: PrismaClient, editPlanId: string) {
  return prisma.render.findMany({
    where: { editPlanId },
    orderBy: { attempt: "asc" },
  });
}

export async function getLatestRender(prisma: PrismaClient, contentItemId: string) {
  return prisma.render.findFirst({
    where: { contentItemId },
    orderBy: { createdAt: "desc" },
  });
}
