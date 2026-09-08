import type { PrismaClient, BeliefStatus } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";
import { getEvidenceEntriesByIds } from "./evidence";

/**
 * Semantic memory (spec §6 memory type 3) — the Belief system. This file is the literal
 * enforcement point for the Phase 7 acceptance criterion (/docs/PHASE_PLAN.md): "a
 * BeliefProposal requires evidence + confidence + confounders before it can be promoted to
 * Belief status," and "the promotion path never writes to BrandConstitutionVersion or
 * BrandMemory directly."
 *
 * One table (`Belief`), not two — `status` moving PROPOSED -> ACCEPTED/REJECTED is what
 * "promotion" means, the same pattern already established for `WeeklyPortfolioItem`. The
 * Learning Agent (packages/agents) only ever calls `proposeBelief`; it has no function in this
 * file (or anywhere else) that could accept its own proposal — `acceptBelief` always records
 * `actorType: "HUMAN"`, hardcoded, never taking an actor-type parameter a caller could set to
 * SYSTEM. See /docs/ARCHITECTURE.md's authority-enforcement rules and
 * packages/domain/src/__tests__/belief.test.ts's regression test for both halves of this.
 */
export class BeliefRequiresRealEvidenceError extends Error {
  constructor(missingIds: string[]) {
    super(
      `Belief cites evidenceIds that don't exist in the Evidence Ledger: ${missingIds.join(", ")}. ` +
        `Every belief must cite real, existing evidence — never an invented id.`,
    );
    this.name = "BeliefRequiresRealEvidenceError";
  }
}

export const ProposeBeliefSchema = z.object({
  statement: z.string().min(1),
  causalClaim: z.string().nullable().optional(),
  isExperimentalEvidence: z.boolean(),
  // .min(1): the literal "requires evidence" rule — a belief proposal citing zero evidence
  // entries fails validation before it ever reaches the database.
  evidenceIds: z.array(z.string()).min(1),
  sampleSize: z.number().int().positive(),
  applicablePlatform: z.enum(["INSTAGRAM", "TIKTOK", "YOUTUBE"]).nullable().optional(),
  applicableTopic: z.string().nullable().optional(),
  applicableFormat: z.string().nullable().optional(),
  dateRangeStart: z.coerce.date().nullable().optional(),
  dateRangeEnd: z.coerce.date().nullable().optional(),
  // Required (not optional): "requires ... confidence."
  confidence: z.number().min(0).max(1),
  // Required array field (may be empty — "no confounders identified" is a real, statable
  // claim), but the field itself can never be omitted: "requires ... confounders."
  confounders: z.array(z.string()),
  contradictoryEvidence: z.array(z.string()).default([]),
  firstObserved: z.coerce.date().nullable().optional(),
  lastEvaluated: z.coerce.date().nullable().optional(),
  retestConditions: z.string().nullable().optional(),
});
export type ProposeBeliefInput = z.input<typeof ProposeBeliefSchema>;

export async function proposeBelief(
  prisma: PrismaClient,
  input: ProposeBeliefInput,
  actor: { actorId: string },
) {
  const parsed = ProposeBeliefSchema.parse(input);

  // Defense in depth beyond the schema's shape check: every cited id must be *real* evidence,
  // not just a non-empty array of arbitrary strings (the same "validate against real
  // candidates" pattern as Take Selector's id validation).
  const found = await getEvidenceEntriesByIds(prisma, parsed.evidenceIds);
  const foundIds = new Set(found.map((e) => e.id));
  const missingIds = parsed.evidenceIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    throw new BeliefRequiresRealEvidenceError(missingIds);
  }

  const belief = await prisma.belief.create({
    data: {
      statement: parsed.statement,
      causalClaim: parsed.causalClaim ?? null,
      isExperimentalEvidence: parsed.isExperimentalEvidence,
      status: "PROPOSED",
      evidenceIds: parsed.evidenceIds,
      sampleSize: parsed.sampleSize,
      applicablePlatform: parsed.applicablePlatform ?? null,
      applicableTopic: parsed.applicableTopic ?? null,
      applicableFormat: parsed.applicableFormat ?? null,
      dateRangeStart: parsed.dateRangeStart ?? null,
      dateRangeEnd: parsed.dateRangeEnd ?? null,
      confidence: parsed.confidence,
      confounders: parsed.confounders,
      contradictoryEvidence: parsed.contradictoryEvidence,
      firstObserved: parsed.firstObserved ?? null,
      lastEvaluated: parsed.lastEvaluated ?? null,
      retestConditions: parsed.retestConditions ?? null,
      proposedBy: actor.actorId,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "SYSTEM",
    action: "BELIEF_PROPOSED",
    entityType: "Belief",
    entityId: belief.id,
    after: { statement: belief.statement, status: belief.status },
  });

  return belief;
}

export class BeliefReviewRequiresProposedStatusError extends Error {
  constructor(actual: BeliefStatus) {
    super(`A Belief can only be accepted/rejected from PROPOSED (current status: ${actual}).`);
    this.name = "BeliefReviewRequiresProposedStatusError";
  }
}

/**
 * The one and only promotion path. Note what this function does *not* do: it never touches
 * `BrandConstitutionVersion` or `BrandMemory` — there is no code path here, or anywhere else
 * in this file, that writes to either table. `actorType: "HUMAN"` is hardcoded, not a
 * parameter — this function cannot be called in a way that records itself as a system/agent
 * action, which is the actual mechanism (not just a docstring) behind "you have no write path
 * ... by design."
 */
export async function acceptBelief(prisma: PrismaClient, beliefId: string, actor: { actorId: string }) {
  const belief = await prisma.belief.findUniqueOrThrow({ where: { id: beliefId } });
  if (belief.status !== "PROPOSED") {
    throw new BeliefReviewRequiresProposedStatusError(belief.status);
  }

  const updated = await prisma.belief.update({
    where: { id: beliefId },
    data: { status: "ACCEPTED", reviewedBy: actor.actorId, reviewedAt: new Date() },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "BELIEF_ACCEPTED",
    entityType: "Belief",
    entityId: beliefId,
    after: { status: "ACCEPTED" },
  });

  return updated;
}

export async function rejectBelief(prisma: PrismaClient, beliefId: string, actor: { actorId: string }) {
  const belief = await prisma.belief.findUniqueOrThrow({ where: { id: beliefId } });
  if (belief.status !== "PROPOSED") {
    throw new BeliefReviewRequiresProposedStatusError(belief.status);
  }

  const updated = await prisma.belief.update({
    where: { id: beliefId },
    data: { status: "REJECTED", reviewedBy: actor.actorId, reviewedAt: new Date() },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "BELIEF_REJECTED",
    entityType: "Belief",
    entityId: beliefId,
    after: { status: "REJECTED" },
  });

  return updated;
}

export class BeliefRetirementRequiresAcceptedStatusError extends Error {
  constructor(actual: BeliefStatus) {
    super(`A Belief can only be retired from ACCEPTED (current status: ${actual}).`);
    this.name = "BeliefRetirementRequiresAcceptedStatusError";
  }
}

/** A belief that later turns out stale/contradicted is retired, never deleted — permanent
 * history, same rationale as every other episodic record in this system. */
export async function retireBelief(prisma: PrismaClient, beliefId: string, actor: { actorId: string }) {
  const belief = await prisma.belief.findUniqueOrThrow({ where: { id: beliefId } });
  if (belief.status !== "ACCEPTED") {
    throw new BeliefRetirementRequiresAcceptedStatusError(belief.status);
  }

  const updated = await prisma.belief.update({ where: { id: beliefId }, data: { status: "RETIRED" } });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "BELIEF_RETIRED",
    entityType: "Belief",
    entityId: beliefId,
    after: { status: "RETIRED" },
  });

  return updated;
}

export async function listBeliefs(prisma: PrismaClient, opts?: { status?: BeliefStatus; limit?: number }) {
  return prisma.belief.findMany({
    where: opts?.status ? { status: opts.status } : undefined,
    orderBy: { createdAt: "desc" },
    take: opts?.limit,
  });
}

export async function countBeliefs(prisma: PrismaClient, opts?: { status?: BeliefStatus }) {
  return prisma.belief.count({ where: opts?.status ? { status: opts.status } : undefined });
}

export async function getBelief(prisma: PrismaClient, id: string) {
  return prisma.belief.findUnique({ where: { id } });
}
