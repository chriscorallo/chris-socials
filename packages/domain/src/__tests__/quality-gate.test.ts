import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import { createMediaAsset } from "../media-asset";
import { recordTakeSelection } from "../take-selection";
import { recordEditPlan } from "../edit-plan";
import { startRendering, recordRenderAttempt } from "../render-record";
import { getAutonomyState } from "../autonomy";
import {
  aggregateHardGates,
  brandGateFromScores,
  creativeGateFromScore,
  technicalGateFromIssues,
  recordQualityGateResult,
  getLatestQCReport,
  getQCIssuesForReport,
  QualityGateRequiresRenderedStateError,
  type HardGateInputs,
} from "../quality-gate";

describe("aggregateHardGates (pure, deterministic — no I/O)", () => {
  it("PASS across all four gates yields an overall PASS with no reasons", () => {
    const result = aggregateHardGates({
      factual: "PASS",
      technical: "PASS",
      brand: "PASS",
      creative: "PASS",
    });
    expect(result.overall).toBe("PASS");
    expect(result.reasons).toEqual([]);
  });

  /**
   * This is the literal Phase 4 acceptance criterion from /docs/PHASE_PLAN.md: "a regression
   * test asserts directly that a hard-gate BLOCK is never averaged away by a high creative
   * score." Three gates PASS outright and CREATIVE only just BLOCKs — if the aggregator did
   * anything resembling averaging, this would read as "mostly fine." It must not.
   */
  it("a single BLOCK forces an overall BLOCK, however strongly the other gates PASS", () => {
    const gates: HardGateInputs = {
      factual: "PASS",
      technical: "PASS",
      brand: "PASS",
      creative: "BLOCK",
    };
    const result = aggregateHardGates(gates, { creative: "Originality score below threshold" });
    expect(result.overall).toBe("BLOCK");
    expect(result.reasons).toEqual(["Originality score below threshold"]);
  });

  it("FACTUAL BLOCK forces an overall BLOCK even with three other PASSes", () => {
    const result = aggregateHardGates({
      factual: "BLOCK",
      technical: "PASS",
      brand: "PASS",
      creative: "PASS",
    });
    expect(result.overall).toBe("BLOCK");
  });

  it("multiple simultaneous BLOCKs are all surfaced, not collapsed to one", () => {
    const result = aggregateHardGates(
      { factual: "BLOCK", technical: "BLOCK", brand: "PASS", creative: "PASS" },
      { factual: "Claims Gate BLOCK", technical: "Technical QC FAIL" },
    );
    expect(result.overall).toBe("BLOCK");
    expect(result.reasons).toEqual(["Claims Gate BLOCK", "Technical QC FAIL"]);
  });
});

describe("threshold helpers", () => {
  it("brandGateFromScores requires both brand and voice to clear the threshold", () => {
    expect(brandGateFromScores(85, 80)).toBe("PASS");
    expect(brandGateFromScores(85, 50)).toBe("BLOCK"); // voice alone drags it down
    expect(brandGateFromScores(50, 85)).toBe("BLOCK"); // brand alone drags it down
  });

  it("creativeGateFromScore is a single threshold on originality", () => {
    expect(creativeGateFromScore(75)).toBe("PASS");
    expect(creativeGateFromScore(30)).toBe("BLOCK");
  });

  it("technicalGateFromIssues escalates on any BLOCKING-severity issue even if the base status PASSed", () => {
    expect(technicalGateFromIssues("PASS", [{ severity: "MINOR" }])).toBe("PASS");
    expect(technicalGateFromIssues("PASS", [{ severity: "BLOCKING" }])).toBe("BLOCK");
    expect(technicalGateFromIssues("BLOCK", [])).toBe("BLOCK"); // an already-blocked base stays blocked
  });
});

async function makeRenderedItem() {
  const item = await createContentItem(prisma, { title: "Quality gate test idea" }, {
    actorId: "test-user",
  });
  for (const to of [
    "SELECTED",
    "CONTRACTED",
    "RESEARCHING",
    "RESEARCHED",
    "SCRIPTING",
    "SCRIPTED",
    "READY_TO_FILM",
    "FILMED",
    "MEDIA_INGESTED",
  ] as const) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
  }
  const take = await createMediaAsset(
    prisma,
    {
      contentItemId: item.id,
      kind: "RAW_TAKE",
      storageKey: `raw/${item.id}/take-1.mp4`,
      originalFilename: "take-1.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1,
    },
    { actorId: "chris" },
  );
  const selection = await recordTakeSelection(
    prisma,
    { contentItemId: item.id, selectedMediaAssetId: take.id, confidence: 0.9, reason: "best" },
    { actorId: "chris" },
  );
  const editPlan = await recordEditPlan(
    prisma,
    {
      contentItemId: item.id,
      takeSelectionId: selection.id,
      productionTier: "FAST",
      targetDurationSeconds: 45,
      plan: { segments: [{ startSeconds: 0, endSeconds: 45 }] },
    },
    { actorId: "chris" },
  );
  await startRendering(prisma, item.id, { actorId: "chris" });
  const render = await recordRenderAttempt(
    prisma,
    {
      contentItemId: item.id,
      editPlanId: editPlan.id,
      status: "SUCCESS",
      storageKey: `renders/${item.id}/v1.mp4`,
      technicalQCReport: { overall: "PASS", checks: [] },
    },
    { actorId: "chris" },
  );
  return { item, editPlan, render };
}

describe("recordQualityGateResult", () => {
  it("rejects when the content item is not at RENDERED", async () => {
    const item = await createContentItem(prisma, { title: "Not rendered yet" }, {
      actorId: "test-user",
    });
    await expect(
      recordQualityGateResult(
        prisma,
        {
          contentItemId: item.id,
          renderId: "does-not-matter",
          gates: { factual: "PASS", technical: "PASS", brand: "PASS", creative: "PASS" },
          issues: [],
        },
        { actorId: "chris" },
      ),
    ).rejects.toBeInstanceOf(QualityGateRequiresRenderedStateError);
  });

  it("an all-PASS gate result transitions RENDERED -> READY and persists a queryable QCReport", async () => {
    const { item, render } = await makeRenderedItem();

    const qcReport = await recordQualityGateResult(
      prisma,
      {
        contentItemId: item.id,
        renderId: render.id,
        gates: { factual: "PASS", technical: "PASS", brand: "PASS", creative: "PASS" },
        visualQAImpression: "Clean render, no defects observed.",
        issues: [
          {
            category: "LEGIBILITY",
            description: "Caption font slightly small on final frame.",
            severity: "INFO",
            timestampSeconds: 3.5,
            recommendedRepair: null,
            source: "VISUAL_QA",
          },
        ],
      },
      { actorId: "chris" },
    );

    expect(qcReport.overallStatus).toBe("PASS");

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("READY");

    const latest = await getLatestQCReport(prisma, item.id);
    expect(latest?.id).toBe(qcReport.id);

    const issues = await getQCIssuesForReport(prisma, qcReport.id);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("INFO");
  });

  /** Phase 8 wiring — a clean first-attempt PASS is a real reliability signal, feeding
   * AutonomyLevel automatically as a side effect of the real pipeline, not just in
   * autonomy.test.ts's isolated unit tests. */
  it("a clean first-attempt PASS records an approved outcome for EDIT_PLANNING at this item's tier", async () => {
    const before = await getAutonomyState(prisma, "EDIT_PLANNING", "FAST");
    const { item, render } = await makeRenderedItem(); // productionTier: "FAST", attempt 1

    await recordQualityGateResult(
      prisma,
      {
        contentItemId: item.id,
        renderId: render.id,
        gates: { factual: "PASS", technical: "PASS", brand: "PASS", creative: "PASS" },
        issues: [],
      },
      { actorId: "chris" },
    );

    const after = await getAutonomyState(prisma, "EDIT_PLANNING", "FAST");
    expect(after.approvedOutcomeCount).toBe(before.approvedOutcomeCount + 1);
  });

  it("a BLOCK on any single gate transitions RENDERED -> QC_REPAIR, not READY", async () => {
    const { item, render } = await makeRenderedItem();

    await recordQualityGateResult(
      prisma,
      {
        contentItemId: item.id,
        renderId: render.id,
        gates: { factual: "PASS", technical: "PASS", brand: "PASS", creative: "BLOCK" },
        issues: [],
      },
      { actorId: "chris" },
    );

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("QC_REPAIR");
  });

  it("a BLOCKING Visual QA issue is persisted even though it doesn't change gate status by itself", async () => {
    const { item, render } = await makeRenderedItem();

    const qcReport = await recordQualityGateResult(
      prisma,
      {
        contentItemId: item.id,
        renderId: render.id,
        // Caller is responsible for folding BLOCKING-severity issues into `technical` via
        // technicalGateFromIssues before calling this — this test proves the issue itself
        // still gets written to the audit trail regardless of how the caller resolved it.
        gates: { factual: "PASS", technical: "BLOCK", brand: "PASS", creative: "PASS" },
        issues: [
          {
            category: "FACE_OBSTRUCTION",
            description: "Caption fully covers the speaker's mouth from 1.2s-2.4s.",
            severity: "BLOCKING",
            timestampSeconds: 1.2,
            recommendedRepair: "Move caption to TOP position for this range.",
            source: "VISUAL_QA",
          },
        ],
      },
      { actorId: "chris" },
    );

    const issues = await getQCIssuesForReport(prisma, qcReport.id);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("BLOCKING");
    expect(issues[0]?.recommendedRepair).toContain("TOP position");

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("QC_REPAIR");
  });
});
