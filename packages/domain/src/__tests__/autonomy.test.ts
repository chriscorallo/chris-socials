import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { setFlag } from "../feature-flags";
import {
  getAutonomyState,
  recordApprovedOutcome,
  setAutonomyCeiling,
  canActAutonomously,
  listAutonomyLevels,
  AUTONOMY_LEVEL_THRESHOLDS,
  AUTONOMY_SHADOW_ONLY_FLAG,
  AutonomyCeilingBelowZeroError,
} from "../autonomy";

/**
 * The real proof of Phase 8's acceptance criterion (/docs/PHASE_PLAN.md): "a content class
 * only reaches autonomy level ≥2 after a configured reliability threshold of prior
 * human-approved outcomes, evaluated per subsystem, never globally — HERO/high-risk content
 * can remain at level 0/1 indefinitely even after RAW/FAST content earns higher autonomy."
 *
 * `AutonomyLevel` is a global row per (subsystem, productionTier) — a small, *closed* enum
 * space (5 subsystems × 4 tiers), so unlike almost everything else in this repo there's no way
 * to sidestep collisions with a fresh id or a synthetic future date; the same
 * (subsystem, tier) pair really is the same row across every run. Every test below deletes its
 * own pair's row before running, the same cleanup-before-insert pattern already established
 * for other global/finite state in this repo (see /docs/DECISIONS.md).
 */
async function resetAutonomyLevel(subsystem: string, productionTier: string) {
  await prisma.autonomyLevel.deleteMany({ where: { subsystem: subsystem as never, productionTier: productionTier as never } });
}
describe("getAutonomyState", () => {
  it("defaults to level 0 for a (subsystem, tier) pair that's never been touched", async () => {
    await resetAutonomyLevel("TAKE_SELECTION", "MEDIUM");
    const state = await getAutonomyState(prisma, "TAKE_SELECTION", "MEDIUM");
    expect(state.level).toBe(0);
    expect(state.approvedOutcomeCount).toBe(0);
    expect(state.ceilingLevel).toBe(4);
  });

  it("is idempotent — fetching twice returns the same row, not two", async () => {
    const first = await getAutonomyState(prisma, "EDIT_PLANNING", "FAST");
    const second = await getAutonomyState(prisma, "EDIT_PLANNING", "FAST");
    expect(first.id).toBe(second.id);
  });
});

describe("recordApprovedOutcome — escalation", () => {
  it("does not escalate before the level-1 threshold is reached", async () => {
    await resetAutonomyLevel("SCHEDULING", "RAW");
    for (let i = 0; i < AUTONOMY_LEVEL_THRESHOLDS[1]! - 1; i++) {
      await recordApprovedOutcome(prisma, "SCHEDULING", "RAW", { actorId: "system" });
    }
    const state = await getAutonomyState(prisma, "SCHEDULING", "RAW");
    expect(state.level).toBe(0);
    expect(state.approvedOutcomeCount).toBe(AUTONOMY_LEVEL_THRESHOLDS[1]! - 1);
  });

  it("escalates to level 1 exactly at the configured threshold, and records why", async () => {
    await resetAutonomyLevel("QUALITY_GATE", "FAST");
    let state;
    for (let i = 0; i < AUTONOMY_LEVEL_THRESHOLDS[1]!; i++) {
      state = await recordApprovedOutcome(prisma, "QUALITY_GATE", "FAST", { actorId: "system" });
    }
    expect(state!.level).toBe(1);
    expect(state!.lastEscalatedAt).toBeInstanceOf(Date);
    expect(state!.lastEscalationReason).toContain("QUALITY_GATE");
  });

  it("escalates through multiple levels as outcomes accumulate, in order", async () => {
    await resetAutonomyLevel("PUBLISHING", "FAST");
    let state;
    for (let i = 0; i < AUTONOMY_LEVEL_THRESHOLDS[2]!; i++) {
      state = await recordApprovedOutcome(prisma, "PUBLISHING", "FAST", { actorId: "system" });
    }
    expect(state!.level).toBe(2);
  });

  /** The literal example from the acceptance criterion. */
  it("HERO content stays at level 0 while RAW/FAST content on the same subsystem advances", async () => {
    await resetAutonomyLevel("EDIT_PLANNING", "RAW");
    await resetAutonomyLevel("EDIT_PLANNING", "HERO");
    for (let i = 0; i < AUTONOMY_LEVEL_THRESHOLDS[2]!; i++) {
      await recordApprovedOutcome(prisma, "EDIT_PLANNING", "RAW", { actorId: "system" });
    }
    const rawState = await getAutonomyState(prisma, "EDIT_PLANNING", "RAW");
    const heroState = await getAutonomyState(prisma, "EDIT_PLANNING", "HERO");

    expect(rawState.level).toBeGreaterThanOrEqual(2);
    expect(heroState.level).toBe(0); // never touched — genuinely independent, not dragged up
  });
});

describe("setAutonomyCeiling — permanent human-set caps", () => {
  it("rejects a negative ceiling", async () => {
    await expect(
      setAutonomyCeiling(prisma, "PUBLISHING", "HERO", -1, { actorId: "chris" }),
    ).rejects.toBeInstanceOf(AutonomyCeilingBelowZeroError);
  });

  it("a ceiling below MAX_AUTONOMY_LEVEL prevents ever reaching higher levels, however many outcomes accumulate", async () => {
    await resetAutonomyLevel("TAKE_SELECTION", "HERO");
    await setAutonomyCeiling(prisma, "TAKE_SELECTION", "HERO", 1, { actorId: "chris" });

    for (let i = 0; i < AUTONOMY_LEVEL_THRESHOLDS[3]!; i++) {
      await recordApprovedOutcome(prisma, "TAKE_SELECTION", "HERO", { actorId: "system" });
    }

    const state = await getAutonomyState(prisma, "TAKE_SELECTION", "HERO");
    expect(state.level).toBe(1); // capped, even though the raw count would justify level 3
    expect(state.approvedOutcomeCount).toBeGreaterThanOrEqual(AUTONOMY_LEVEL_THRESHOLDS[3]!);
  });

  it("lowering the ceiling below the current level immediately clamps the functional level down", async () => {
    await resetAutonomyLevel("SCHEDULING", "MEDIUM");
    for (let i = 0; i < AUTONOMY_LEVEL_THRESHOLDS[2]!; i++) {
      await recordApprovedOutcome(prisma, "SCHEDULING", "MEDIUM", { actorId: "system" });
    }
    const before = await getAutonomyState(prisma, "SCHEDULING", "MEDIUM");
    expect(before.level).toBeGreaterThanOrEqual(2);

    const after = await setAutonomyCeiling(prisma, "SCHEDULING", "MEDIUM", 0, { actorId: "chris" });
    expect(after.level).toBe(0); // clamped immediately, not just capped going forward
  });
});

describe("canActAutonomously — the global kill switch", () => {
  it("returns false below the required level even with shadow_only off", async () => {
    await resetAutonomyLevel("PUBLISHING", "HERO");
    await setFlag(prisma, { key: AUTONOMY_SHADOW_ONLY_FLAG, enabled: false, actor: "test", actorType: "HUMAN" });
    const allowed = await canActAutonomously(prisma, "PUBLISHING", "HERO", 1);
    expect(allowed).toBe(false); // HERO/PUBLISHING was just reset — nothing earned
  });

  it("returns true once the level is reached and shadow_only is off", async () => {
    await resetAutonomyLevel("SCHEDULING", "FAST");
    await setFlag(prisma, { key: AUTONOMY_SHADOW_ONLY_FLAG, enabled: false, actor: "test", actorType: "HUMAN" });
    for (let i = 0; i < AUTONOMY_LEVEL_THRESHOLDS[1]!; i++) {
      await recordApprovedOutcome(prisma, "SCHEDULING", "FAST", { actorId: "system" });
    }
    const allowed = await canActAutonomously(prisma, "SCHEDULING", "FAST", 1);
    expect(allowed).toBe(true);
  });

  /** The master kill switch — proves it overrides genuinely earned autonomy, not just the
   * default state. */
  it("forces false regardless of earned level when shadow_only is on", async () => {
    await resetAutonomyLevel("QUALITY_GATE", "RAW");
    for (let i = 0; i < AUTONOMY_LEVEL_THRESHOLDS[2]!; i++) {
      await recordApprovedOutcome(prisma, "QUALITY_GATE", "RAW", { actorId: "system" });
    }
    const earnedState = await getAutonomyState(prisma, "QUALITY_GATE", "RAW");
    expect(earnedState.level).toBeGreaterThanOrEqual(2); // genuinely earned

    await setFlag(prisma, { key: AUTONOMY_SHADOW_ONLY_FLAG, enabled: true, actor: "test", actorType: "HUMAN" });
    const allowed = await canActAutonomously(prisma, "QUALITY_GATE", "RAW", 1);
    expect(allowed).toBe(false); // still false — the kill switch wins

    // Restore for any other test in this run that also checks this flag.
    await setFlag(prisma, { key: AUTONOMY_SHADOW_ONLY_FLAG, enabled: false, actor: "test", actorType: "HUMAN" });
  });
});

describe("listAutonomyLevels", () => {
  it("lists every (subsystem, tier) row that has been touched", async () => {
    await getAutonomyState(prisma, "TAKE_SELECTION", "RAW");
    const all = await listAutonomyLevels(prisma);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((a) => typeof a.level === "number")).toBe(true);
  });
});
