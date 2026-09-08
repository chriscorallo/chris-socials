import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma, getModelCallCostSummary } from "@chris/domain";
import { CostTrackingModelProvider } from "../providers/cost-tracking-provider";
import { MockModelProvider } from "../providers/mock-provider";
import { ModelOutputParseError, type ModelProvider } from "../model-provider";
import { SpendCapExceededError, startOfUtcDay } from "../spend-cap";

const schema = z.object({ status: z.string() });

describe("CostTrackingModelProvider — logging", () => {
  it("logs a real ModelCallLog row with computed cost, and returns the delegate's result unchanged", async () => {
    const promptId = `COST_WRAP_TEST.${randomUUID()}`;
    const delegate = new MockModelProvider(() => ({ status: "connected" }));
    // MockModelProvider always reports 0/0 tokens and model "mock" — override via a thin
    // wrapper so this test exercises a realistic non-zero token/cost path, the same shape a
    // real AnthropicModelProvider response has.
    const realisticDelegate: ModelProvider = {
      completeStructured: async (request) => {
        const result = await delegate.completeStructured(request);
        return { ...result, model: "claude-sonnet-5", inputTokens: 5000, outputTokens: 1000 };
      },
    };

    // dailyCapUsd: null — these tests aren't about the cap, and running the same suite many
    // times in one UTC day would otherwise accumulate real costUsd rows toward the default
    // cap across unrelated runs (the same collision-class bug documented repeatedly in
    // /docs/DECISIONS.md, just building slowly instead of colliding on a single date).
    const provider = new CostTrackingModelProvider(realisticDelegate, prisma, {
      contentItemId: "content-abc",
      dailyCapUsd: null,
    });
    const result = await provider.completeStructured({
      modelClass: "MEDIUM",
      systemPrompt: "sys",
      userPrompt: "user",
      schema,
      promptId,
    });

    expect(result.output).toEqual({ status: "connected" });

    const row = await prisma.modelCallLog.findFirstOrThrow({ where: { promptId } });
    expect(row.success).toBe(true);
    expect(row.modelClass).toBe("MEDIUM");
    expect(row.model).toBe("claude-sonnet-5");
    expect(row.inputTokens).toBe(5000);
    expect(row.outputTokens).toBe(1000);
    // 5000/1e6*2.00 + 1000/1e6*10.00 = 0.01 + 0.01 = 0.02
    expect(row.costUsd).toBeCloseTo(0.02, 9);
    expect(row.contentItemId).toBe("content-abc");
  });

  it("still throws the delegate's error to the caller, but logs a failed row on the way out", async () => {
    const promptId = `COST_WRAP_FAIL.${randomUUID()}`;
    const failingDelegate = {
      completeStructured: async () => {
        throw new ModelOutputParseError(promptId, "claude-opus-5");
      },
    };

    const provider = new CostTrackingModelProvider(failingDelegate, prisma, { dailyCapUsd: null });
    await expect(
      provider.completeStructured({
        modelClass: "HIGH",
        systemPrompt: "sys",
        userPrompt: "user",
        schema,
        promptId,
      }),
    ).rejects.toBeInstanceOf(ModelOutputParseError);

    const row = await prisma.modelCallLog.findFirstOrThrow({ where: { promptId } });
    expect(row.success).toBe(false);
    expect(row.costUsd).toBeNull();
    expect(row.errorMessage).toContain(promptId);
  });

  it("a delegate result is returned even if the cap-check read AND the log write both fail (fail open + fail safely)", async () => {
    const promptId = `COST_WRAP_DB_DOWN.${randomUUID()}`;
    const delegate = new MockModelProvider(() => ({ status: "connected" }));
    // No findMany (cap-check read) and a throwing create (log write) — deliberately not
    // passing dailyCapUsd here, so this exercises the default cap's read path failing too.
    const brokenPrisma = {
      modelCallLog: {
        create: async () => {
          throw new Error("simulated DB outage");
        },
      },
    } as unknown as typeof prisma;

    const provider = new CostTrackingModelProvider(delegate, brokenPrisma);
    const result = await provider.completeStructured({
      modelClass: "LOW",
      systemPrompt: "sys",
      userPrompt: "user",
      schema,
      promptId,
    });

    expect(result.output).toEqual({ status: "connected" });
  });
});

describe("CostTrackingModelProvider — spend cap", () => {
  it("blocks a call before it ever reaches the delegate once today's spend has reached the cap", async () => {
    const promptId = `CAP_BLOCK_TEST.${randomUUID()}`;
    // Read the real current baseline the same way the provider itself will, then set the cap
    // to exactly that value — the very next call must see spentTodayUsd >= cap and refuse,
    // regardless of how much unrelated spend already exists today from other tests/usage.
    const baselineUsd = (
      await getModelCallCostSummary(prisma, { since: startOfUtcDay(new Date()) })
    ).totalCostUsd;

    let delegateCalls = 0;
    const delegate: ModelProvider = {
      completeStructured: async () => {
        delegateCalls += 1;
        throw new Error("the delegate must never be called once the cap is reached");
      },
    };

    const provider = new CostTrackingModelProvider(delegate, prisma, { dailyCapUsd: baselineUsd });
    await expect(
      provider.completeStructured({
        modelClass: "HIGH",
        systemPrompt: "sys",
        userPrompt: "user",
        schema,
        promptId,
      }),
    ).rejects.toBeInstanceOf(SpendCapExceededError);

    expect(delegateCalls).toBe(0);
    // A blocked call is not a "call that happened" — no ModelCallLog row for it.
    const rows = await prisma.modelCallLog.findMany({ where: { promptId } });
    expect(rows).toHaveLength(0);
  });

  it("audits the block so a refusal is visible later, not silently invisible", async () => {
    const promptId = `CAP_BLOCK_AUDIT_TEST.${randomUUID()}`;
    const baselineUsd = (
      await getModelCallCostSummary(prisma, { since: startOfUtcDay(new Date()) })
    ).totalCostUsd;

    const delegate: ModelProvider = {
      completeStructured: async () => {
        throw new Error("must not be called");
      },
    };
    const provider = new CostTrackingModelProvider(delegate, prisma, { dailyCapUsd: baselineUsd });
    await expect(
      provider.completeStructured({
        modelClass: "MEDIUM",
        systemPrompt: "sys",
        userPrompt: "user",
        schema,
        promptId,
      }),
    ).rejects.toBeInstanceOf(SpendCapExceededError);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "MODEL_SPEND_CAP_BLOCKED", entityId: promptId },
    });
    expect(audit.actorType).toBe("SYSTEM");
    expect((audit.metadata as { capUsd: number }).capUsd).toBeCloseTo(baselineUsd, 9);
  });

  it("allows the call through when spend is well under the cap", async () => {
    const promptId = `CAP_ALLOW_TEST.${randomUUID()}`;
    const baselineUsd = (
      await getModelCallCostSummary(prisma, { since: startOfUtcDay(new Date()) })
    ).totalCostUsd;

    const delegate = new MockModelProvider(() => ({ status: "connected" }));
    const provider = new CostTrackingModelProvider(delegate, prisma, {
      dailyCapUsd: baselineUsd + 1_000_000,
    });

    const result = await provider.completeStructured({
      modelClass: "LOW",
      systemPrompt: "sys",
      userPrompt: "user",
      schema,
      promptId,
    });
    expect(result.output).toEqual({ status: "connected" });
  });

  it("dailyCapUsd: null disables the cap entirely, even at a cap value ($0) that would otherwise always block", async () => {
    const promptId = `CAP_DISABLED_TEST.${randomUUID()}`;
    const delegate = new MockModelProvider(() => ({ status: "connected" }));
    const provider = new CostTrackingModelProvider(delegate, prisma, { dailyCapUsd: null });

    const result = await provider.completeStructured({
      modelClass: "LOW",
      systemPrompt: "sys",
      userPrompt: "user",
      schema,
      promptId,
    });
    expect(result.output).toEqual({ status: "connected" });
  });

  it("a cap of $0 (not null) blocks immediately, proving null and 0 are meaningfully different", async () => {
    const promptId = `CAP_ZERO_TEST.${randomUUID()}`;
    let delegateCalls = 0;
    const delegate: ModelProvider = {
      completeStructured: async () => {
        delegateCalls += 1;
        throw new Error("must not be called");
      },
    };
    const provider = new CostTrackingModelProvider(delegate, prisma, { dailyCapUsd: 0 });
    await expect(
      provider.completeStructured({
        modelClass: "LOW",
        systemPrompt: "sys",
        userPrompt: "user",
        schema,
        promptId,
      }),
    ).rejects.toBeInstanceOf(SpendCapExceededError);
    expect(delegateCalls).toBe(0);
  });
});
