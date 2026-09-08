import type { PrismaClient, AutonomySubsystem, ProductionTier } from "@prisma/client";
import { recordAudit } from "./audit";
import { isEnabled } from "./feature-flags";

/**
 * Autonomy levels (spec §23) — the literal Phase 8 acceptance criterion
 * (/docs/PHASE_PLAN.md): "a content class only reaches autonomy level ≥2 after a configured
 * reliability threshold of prior human-approved outcomes, evaluated per subsystem, never
 * globally." One `AutonomyLevel` row per (subsystem, productionTier) — HERO staying at
 * level 0/1 while RAW/FAST advances is a direct consequence of the composite key, not an
 * emergent property of low usage: HERO's row simply accumulates its own count independently.
 *
 * Deterministic throughout — escalation is a threshold comparison, not a judgment call, per
 * CLAUDE.md's "prefer deterministic code over LLM judgment when the check is actually
 * deterministic."
 */
export const AUTONOMY_LEVEL_THRESHOLDS: Record<number, number> = {
  1: 3, // Level 0 -> 1: 3 prior human-approved outcomes
  2: 10, // Level 1 -> 2: 10
  3: 25, // Level 2 -> 3: 25
  4: 50, // Level 3 -> 4: 50
};
export const MAX_AUTONOMY_LEVEL = 4;

/** The global kill switch seeded in Phase 0 (/docs/DECISIONS.md) — while enabled, every
 * subsystem behaves as level 0 regardless of what it has actually earned. Flipping it off is
 * the one action that turns on any earned autonomy at all; flipping it back on is instant and
 * total, the emergency stop this system is required to have (CLAUDE.md: "use feature flags for
 * risky/new autonomous behavior"). */
export const AUTONOMY_SHADOW_ONLY_FLAG = "autonomy.shadow_only";

export async function getAutonomyState(
  prisma: PrismaClient,
  subsystem: AutonomySubsystem,
  productionTier: ProductionTier,
) {
  const existing = await prisma.autonomyLevel.findUnique({
    where: { subsystem_productionTier: { subsystem, productionTier } },
  });
  if (existing) return existing;
  return prisma.autonomyLevel.create({ data: { subsystem, productionTier } });
}

export async function listAutonomyLevels(prisma: PrismaClient) {
  return prisma.autonomyLevel.findMany({ orderBy: [{ subsystem: "asc" }, { productionTier: "asc" }] });
}

/**
 * Records one real, human-approved (or system-observed-clean, per the caller's own judgment
 * of what counts — see callers in quality-gate.ts/publication.ts) outcome for a
 * (subsystem, productionTier) pair, and escalates the level if the next threshold is crossed
 * *and* the configured ceiling allows it. A `while` loop (not a single `if`) so a count that
 * jumps past more than one threshold in one call still lands at the correct level, not one
 * level behind.
 */
export async function recordApprovedOutcome(
  prisma: PrismaClient,
  subsystem: AutonomySubsystem,
  productionTier: ProductionTier,
  actor: { actorId: string },
) {
  const state = await getAutonomyState(prisma, subsystem, productionTier);
  const newCount = state.approvedOutcomeCount + 1;

  let newLevel = state.level;
  while (
    newLevel < MAX_AUTONOMY_LEVEL &&
    newLevel < state.ceilingLevel &&
    newCount >= (AUTONOMY_LEVEL_THRESHOLDS[newLevel + 1] ?? Infinity)
  ) {
    newLevel += 1;
  }

  const escalated = newLevel > state.level;
  const updated = await prisma.autonomyLevel.update({
    where: { id: state.id },
    data: {
      approvedOutcomeCount: newCount,
      level: newLevel,
      ...(escalated
        ? {
            lastEscalatedAt: new Date(),
            lastEscalationReason: `Reached ${newCount} approved outcomes for ${subsystem}/${productionTier}`,
          }
        : {}),
    },
  });

  if (escalated) {
    await recordAudit(prisma, {
      actor: actor.actorId,
      actorType: "SYSTEM",
      action: "AUTONOMY_LEVEL_ESCALATED",
      entityType: "AutonomyLevel",
      entityId: updated.id,
      before: { level: state.level },
      after: { level: newLevel, approvedOutcomeCount: newCount },
    });
  }

  return updated;
}

export class AutonomyCeilingBelowZeroError extends Error {
  constructor() {
    super("Autonomy ceiling cannot be set below 0.");
    this.name = "AutonomyCeilingBelowZeroError";
  }
}

/** Human-only, by convention of every caller (like `acceptBelief`, this function itself
 * doesn't take an actor-type parameter that could be set to SYSTEM elsewhere, but callers are
 * expected to only expose this via a real human-driven Server Action) — the one way to
 * implement spec's "HERO/high-risk/ambiguous content may require human review permanently":
 * set HERO's ceiling to 0 or 1 and no amount of accumulated approved outcomes can escalate it
 * past that. Lowering the ceiling below the current level also clamps the functional level
 * down immediately, not just the future ceiling. */
export async function setAutonomyCeiling(
  prisma: PrismaClient,
  subsystem: AutonomySubsystem,
  productionTier: ProductionTier,
  ceilingLevel: number,
  actor: { actorId: string },
) {
  if (ceilingLevel < 0) throw new AutonomyCeilingBelowZeroError();

  const state = await getAutonomyState(prisma, subsystem, productionTier);
  const updated = await prisma.autonomyLevel.update({
    where: { id: state.id },
    data: {
      ceilingLevel,
      level: Math.min(state.level, ceilingLevel),
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "AUTONOMY_CEILING_SET",
    entityType: "AutonomyLevel",
    entityId: updated.id,
    before: { ceilingLevel: state.ceilingLevel, level: state.level },
    after: { ceilingLevel: updated.ceilingLevel, level: updated.level },
  });

  return updated;
}

/** The one function real orchestration code should call before acting without a human click —
 * folds in the global kill switch, so no caller can accidentally forget to check it. */
export async function canActAutonomously(
  prisma: PrismaClient,
  subsystem: AutonomySubsystem,
  productionTier: ProductionTier,
  requiredLevel: number,
): Promise<boolean> {
  const shadowOnly = await isEnabled(prisma, AUTONOMY_SHADOW_ONLY_FLAG);
  if (shadowOnly) return false;

  const state = await getAutonomyState(prisma, subsystem, productionTier);
  return state.level >= requiredLevel;
}
