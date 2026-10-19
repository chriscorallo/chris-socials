import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma, recordModelCall, getAiSpendOverview } from "@chris/domain";
import { recheckAiCreditIfStale, CREDIT_PROBE_PROMPT_ID } from "./ai-credit-probe";

const okFetch = (async () => new Response(JSON.stringify({ usage: { input_tokens: 8, output_tokens: 1 } }), { status: 200 })) as typeof fetch;
const noCreditFetch = (async () => new Response(JSON.stringify({ error: { message: "Your credit balance is too low to access the Anthropic API." } }), { status: 400 })) as typeof fetch;

describe("recheckAiCreditIfStale — a top-up un-grays the AI buttons", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    await prisma.modelCallLog.deleteMany({});
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  const outOfCredit = () =>
    recordModelCall(prisma, { promptId: "QUALITY_GATE", modelClass: "HIGH", model: "claude-opus-5-5", latencyMs: 10, success: false, errorMessage: "400: Your credit balance is too low" });

  it("does nothing when credit isn't in doubt", async () => {
    expect(await recheckAiCreditIfStale(new Date(), okFetch)).toBe("not-needed");
  });

  it("after a top-up, one tiny call clears the stale out-of-credit state", async () => {
    await outOfCredit();
    expect((await getAiSpendOverview(prisma, new Date())).creditError).not.toBeNull();
    expect(await recheckAiCreditIfStale(new Date(), okFetch)).toBe("ok");
    expect((await getAiSpendOverview(prisma, new Date())).creditError).toBeNull();
  });

  it("still out of credit stays out of credit, and re-asks at most once a minute", async () => {
    await outOfCredit();
    expect(await recheckAiCreditIfStale(new Date(), noCreditFetch)).toBe("still-failing");
    expect((await getAiSpendOverview(prisma, new Date())).creditError).not.toBeNull();
    expect(await recheckAiCreditIfStale(new Date(), okFetch)).toBe("throttled");
    expect(await prisma.modelCallLog.count({ where: { promptId: CREDIT_PROBE_PROMPT_ID } })).toBe(1);
  });
});
