import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../prisma";
import { recordEvidenceEntry } from "../evidence";
import {
  proposeBelief,
  acceptBelief,
  rejectBelief,
  retireBelief,
  getBelief,
  listBeliefs,
  BeliefRequiresRealEvidenceError,
  BeliefReviewRequiresProposedStatusError,
  BeliefRetirementRequiresAcceptedStatusError,
} from "../belief";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The real proof of Phase 7's acceptance criterion (/docs/PHASE_PLAN.md): "a BeliefProposal
 * requires evidence + confidence + confounders before it can be promoted to Belief status; a
 * test asserts the promotion path never writes to BrandConstitutionVersion or BrandMemory
 * directly."
 */
async function makeEvidence(statement = "Videos posted Tuesday got 20% more views over 8 weeks.") {
  return recordEvidenceEntry(prisma, {
    statement,
    sourceType: "PERFORMANCE_SNAPSHOT",
    confidence: 0.7,
  });
}

describe("proposeBelief — requires evidence + confidence + confounders", () => {
  it("rejects a proposal with zero evidence — 'requires evidence' enforced at the schema level", async () => {
    await expect(
      proposeBelief(
        prisma,
        {
          statement: "Tuesday posting performs better.",
          isExperimentalEvidence: false,
          evidenceIds: [], // empty — the literal violation
          sampleSize: 10,
          confidence: 0.7,
          confounders: [],
        },
        { actorId: "chris" },
      ),
    ).rejects.toThrow(); // zod .min(1) — ZodError
  });

  it("rejects a proposal citing evidence ids that don't actually exist", async () => {
    await expect(
      proposeBelief(
        prisma,
        {
          statement: "Tuesday posting performs better.",
          isExperimentalEvidence: false,
          evidenceIds: ["not-a-real-evidence-id"],
          sampleSize: 10,
          confidence: 0.7,
          confounders: [],
        },
        { actorId: "chris" },
      ),
    ).rejects.toBeInstanceOf(BeliefRequiresRealEvidenceError);
  });

  it("requires confidence and confounders to be explicitly provided (TypeScript enforces this at the call site — schema requires both fields)", async () => {
    const evidence = await makeEvidence();
    // A well-formed proposal with real evidence, real confidence, and an explicit (even if
    // empty) confounders array succeeds — proving the three requirements are jointly
    // sufficient, not just individually blocking.
    const belief = await proposeBelief(
      prisma,
      {
        statement: "Tuesday posting performs better for finance content.",
        causalClaim: "Tuesday may have less short-form competition in this niche.",
        isExperimentalEvidence: false,
        evidenceIds: [evidence.id],
        sampleSize: 12,
        confidence: 0.65,
        confounders: ["Only tested across 3 pillars", "No control for posting time-of-day"],
        contradictoryEvidence: [],
      },
      { actorId: "chris" },
    );
    expect(belief.status).toBe("PROPOSED");
    expect(belief.confounders).toEqual(["Only tested across 3 pillars", "No control for posting time-of-day"]);
  });
});

describe("acceptBelief / rejectBelief — the promotion path", () => {
  it("rejects from any status other than PROPOSED", async () => {
    const evidence = await makeEvidence();
    const belief = await proposeBelief(
      prisma,
      {
        statement: "x",
        isExperimentalEvidence: false,
        evidenceIds: [evidence.id],
        sampleSize: 5,
        confidence: 0.5,
        confounders: [],
      },
      { actorId: "chris" },
    );
    await acceptBelief(prisma, belief.id, { actorId: "chris" });
    await expect(acceptBelief(prisma, belief.id, { actorId: "chris" })).rejects.toBeInstanceOf(
      BeliefReviewRequiresProposedStatusError,
    );
  });

  it("promotes PROPOSED -> ACCEPTED and records who reviewed it", async () => {
    const evidence = await makeEvidence();
    const belief = await proposeBelief(
      prisma,
      {
        statement: "Tuesday posting performs better.",
        isExperimentalEvidence: false,
        evidenceIds: [evidence.id],
        sampleSize: 8,
        confidence: 0.6,
        confounders: [],
      },
      { actorId: "chris" },
    );

    const accepted = await acceptBelief(prisma, belief.id, { actorId: "chris" });
    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.reviewedBy).toBe("chris");
    expect(accepted.reviewedAt).toBeInstanceOf(Date);

    const fetched = await getBelief(prisma, belief.id);
    expect(fetched?.status).toBe("ACCEPTED");
  });

  it("rejects a proposal — REJECTED is a terminal, real outcome, not deleted", async () => {
    const evidence = await makeEvidence();
    const belief = await proposeBelief(
      prisma,
      {
        statement: "A weak, likely-spurious correlation.",
        isExperimentalEvidence: false,
        evidenceIds: [evidence.id],
        sampleSize: 3,
        confidence: 0.2,
        confounders: ["Tiny sample size"],
      },
      { actorId: "chris" },
    );

    const rejected = await rejectBelief(prisma, belief.id, { actorId: "chris" });
    expect(rejected.status).toBe("REJECTED");

    const all = await listBeliefs(prisma, { status: "REJECTED" });
    expect(all.some((b) => b.id === belief.id)).toBe(true);
  });

  /**
   * THE literal acceptance-criterion regression test: promotion never writes to
   * BrandConstitutionVersion or BrandMemory. Verified two ways — behaviorally (row counts
   * genuinely unchanged after a real promotion) and structurally (the source file that
   * implements promotion contains no reference to either table at all, so there is no code
   * path that *could* write to them, not just one that happens not to today).
   */
  it("never writes to BrandConstitutionVersion or BrandMemory when accepting a belief", async () => {
    const beforeConstitutionCount = await prisma.brandConstitutionVersion.count();
    const beforeMemoryCount = await prisma.brandMemory.count();

    const evidence = await makeEvidence();
    const belief = await proposeBelief(
      prisma,
      {
        statement: "Tuesday posting performs better.",
        isExperimentalEvidence: true,
        evidenceIds: [evidence.id],
        sampleSize: 20,
        confidence: 0.8,
        confounders: [],
      },
      { actorId: "chris" },
    );
    await acceptBelief(prisma, belief.id, { actorId: "chris" });

    const afterConstitutionCount = await prisma.brandConstitutionVersion.count();
    const afterMemoryCount = await prisma.brandMemory.count();
    expect(afterConstitutionCount).toBe(beforeConstitutionCount);
    expect(afterMemoryCount).toBe(beforeMemoryCount);

    // Structural check: the promotion path's own source code has no *Prisma call* against
    // either table — this stays true regardless of what future code elsewhere in the file
    // might do, catching a regression the behavioral check alone might miss if a no-op write
    // were added. Matches the actual client-property-access pattern (`prisma.brandMemory.…`),
    // not a bare mention of the table name — this file's own doc comments legitimately
    // *explain* why it never touches either table, which would otherwise false-positive.
    const source = readFileSync(join(__dirname, "..", "belief.ts"), "utf-8");
    expect(source).not.toMatch(/\.brandConstitutionVersion\s*\./);
    expect(source).not.toMatch(/\.brandMemory\s*\./);
  });
});

describe("retireBelief", () => {
  it("rejects from any status other than ACCEPTED", async () => {
    const evidence = await makeEvidence();
    const belief = await proposeBelief(
      prisma,
      { statement: "x", isExperimentalEvidence: false, evidenceIds: [evidence.id], sampleSize: 5, confidence: 0.5, confounders: [] },
      { actorId: "chris" },
    );
    await expect(retireBelief(prisma, belief.id, { actorId: "chris" })).rejects.toBeInstanceOf(
      BeliefRetirementRequiresAcceptedStatusError,
    );
  });

  it("retires an accepted belief without deleting it", async () => {
    const evidence = await makeEvidence();
    const belief = await proposeBelief(
      prisma,
      { statement: "x", isExperimentalEvidence: false, evidenceIds: [evidence.id], sampleSize: 5, confidence: 0.5, confounders: [] },
      { actorId: "chris" },
    );
    await acceptBelief(prisma, belief.id, { actorId: "chris" });
    const retired = await retireBelief(prisma, belief.id, { actorId: "chris" });
    expect(retired.status).toBe("RETIRED");
    expect(await getBelief(prisma, belief.id)).not.toBeNull();
  });
});
