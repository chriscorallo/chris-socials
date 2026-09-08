import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma";
import { recordModelCall, getModelCallCostSummary, listRecentModelCalls } from "../model-call-log";

describe("model call log", () => {
  it("records a successful call with its computed cost", async () => {
    const promptId = `TEST_PROMPT.${randomUUID()}`;
    await recordModelCall(prisma, {
      promptId,
      modelClass: "MEDIUM",
      model: "claude-sonnet-5",
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.0022,
      latencyMs: 450,
      success: true,
    });

    const row = await prisma.modelCallLog.findFirstOrThrow({ where: { promptId } });
    expect(row.success).toBe(true);
    expect(row.costUsd).toBeCloseTo(0.0022, 6);
    expect(row.inputTokens).toBe(1000);
    expect(row.outputTokens).toBe(200);
  });

  it("records a failed call with null cost/tokens, never a fabricated $0", async () => {
    const promptId = `TEST_PROMPT_FAIL.${randomUUID()}`;
    await recordModelCall(prisma, {
      promptId,
      modelClass: "HIGH",
      model: "unresolved:HIGH",
      latencyMs: 0,
      success: false,
      errorMessage: "simulated failure",
    });

    const row = await prisma.modelCallLog.findFirstOrThrow({ where: { promptId } });
    expect(row.success).toBe(false);
    expect(row.costUsd).toBeNull();
    expect(row.inputTokens).toBeNull();
    expect(row.errorMessage).toBe("simulated failure");
  });

  it("a logging call never throws even given odd inputs (best-effort by contract)", async () => {
    // recordModelCall itself has no defensive try/catch (that's CostTrackingModelProvider's
    // job) — this just proves a well-formed call with all-optional fields omitted succeeds.
    const promptId = `TEST_PROMPT_MINIMAL.${randomUUID()}`;
    await expect(
      recordModelCall(prisma, {
        promptId,
        modelClass: "LOW",
        model: "claude-haiku-4-5",
        latencyMs: 10,
        success: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("summarizes cost and tokens across model classes, excluding missing-cost calls from the total", async () => {
    const tag = randomUUID();
    const contentItemId = `content-${tag}`;

    await recordModelCall(prisma, {
      promptId: `SUMMARY_A.${tag}`,
      modelClass: "HIGH",
      model: "claude-opus-5",
      inputTokens: 10000,
      outputTokens: 2000,
      costUsd: 0.1,
      latencyMs: 1000,
      success: true,
      contentItemId,
    });
    await recordModelCall(prisma, {
      promptId: `SUMMARY_B.${tag}`,
      modelClass: "MEDIUM",
      model: "claude-sonnet-5",
      inputTokens: 4000,
      outputTokens: 800,
      costUsd: 0.016,
      latencyMs: 500,
      success: true,
      contentItemId,
    });
    // A failed call with no usage reported — must count toward totalCalls/failedCalls/
    // callsMissingCost but NOT toward totalCostUsd.
    await recordModelCall(prisma, {
      promptId: `SUMMARY_C.${tag}`,
      modelClass: "MEDIUM",
      model: "unresolved:MEDIUM",
      latencyMs: 0,
      success: false,
      contentItemId,
    });

    // Sequential reads only — see /docs/DECISIONS.md's PGlite entries.
    const summary = await getModelCallCostSummary(prisma);
    // Scope assertions to rows this test actually wrote, since the summary is genuinely
    // all-time and other tests/dev-server usage may have written rows too.
    const recent = await listRecentModelCalls(prisma, 500);
    const ours = recent.filter((r) => r.promptId.includes(tag));
    expect(ours).toHaveLength(3);

    expect(summary.totalCalls).toBeGreaterThanOrEqual(3);
    expect(summary.failedCalls).toBeGreaterThanOrEqual(1);
    expect(summary.callsMissingCost).toBeGreaterThanOrEqual(1);
    // 0.1 + 0.016 from the two successful calls above must be included somewhere in the total.
    expect(summary.totalCostUsd).toBeGreaterThanOrEqual(0.116 - 1e-9);
    expect(summary.byModelClass.HIGH.calls).toBeGreaterThanOrEqual(1);
    expect(summary.byModelClass.MEDIUM.calls).toBeGreaterThanOrEqual(2);
  });

  it("since-filtering excludes calls recorded before the cutoff", async () => {
    const tag = randomUUID();
    const future = new Date(Date.now() + 60 * 60 * 1000);

    await recordModelCall(prisma, {
      promptId: `SINCE_TEST.${tag}`,
      modelClass: "LOW",
      model: "claude-haiku-4-5",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.00035,
      latencyMs: 200,
      success: true,
    });

    const summary = await getModelCallCostSummary(prisma, { since: future });
    const recent = await listRecentModelCalls(prisma, 500);
    expect(recent.some((r) => r.promptId === `SINCE_TEST.${tag}`)).toBe(true);
    // Nothing can have been created after `future`, since future is after "now".
    expect(summary.totalCalls).toBe(0);
  });
});
