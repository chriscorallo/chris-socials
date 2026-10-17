import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { getAiSpendOverview } from "../model-call-log";
import { createContentItem } from "../content-item";

const NOW = new Date("2026-10-17T15:00:00Z");
const at = (iso: string) => new Date(iso);

async function log(createdAt: Date, opts: { cost?: number | null; success?: boolean; error?: string; item?: string } = {}) {
  await prisma.modelCallLog.create({
    data: {
      promptId: "TEST",
      modelClass: "MEDIUM",
      model: "test",
      latencyMs: 1,
      costUsd: opts.cost === undefined ? 0.1 : opts.cost,
      success: opts.success ?? true,
      errorMessage: opts.error,
      contentItemId: opts.item,
      createdAt,
    },
  });
}

describe("getAiSpendOverview", () => {
  beforeEach(async () => {
    await prisma.modelCallLog.deleteMany({});
  });
  afterAll(async () => {
    await prisma.modelCallLog.deleteMany({});
  });

  it("sums today (UTC day), last 30 days, and per-video average", async () => {
    const a = await createContentItem(prisma, { title: "A" }, { actorId: "t" });
    const b = await createContentItem(prisma, { title: "B" }, { actorId: "t" });
    await log(at("2026-10-17T01:00:00Z"), { cost: 0.4, item: a.id });
    await log(at("2026-10-16T23:00:00Z"), { cost: 0.2, item: a.id });
    await log(at("2026-10-10T12:00:00Z"), { cost: 0.6, item: b.id });
    await log(at("2026-10-12T12:00:00Z"), { cost: 0.3 }); // not tied to a video
    await log(at("2026-09-01T12:00:00Z"), { cost: 9 }); // outside 30 days
    const o = await getAiSpendOverview(prisma, NOW);
    expect(o.todayUsd).toBeCloseTo(0.4);
    expect(o.last30Usd).toBeCloseTo(1.5);
    expect(o.last30Videos).toBe(2);
    expect(o.perVideoUsd).toBeCloseTo(0.6); // (0.4 + 0.2 + 0.6) / 2
    expect(o.creditError).toBeNull();
  });

  it("reports out-of-credit until a later call succeeds", async () => {
    await log(at("2026-10-17T10:00:00Z"), { cost: null, success: false, error: "Your credit balance is too low to access the Anthropic API." });
    let o = await getAiSpendOverview(prisma, NOW);
    expect(o.creditError?.message).toMatch(/credit balance/);
    expect(o.perVideoUsd).toBeNull();

    await log(at("2026-10-17T11:00:00Z"), { cost: 0.05 });
    o = await getAiSpendOverview(prisma, NOW);
    expect(o.creditError).toBeNull();
    expect(o.lastSuccessAt?.toISOString()).toBe("2026-10-17T11:00:00.000Z");
  });

  it("ignores failures that aren't about credit", async () => {
    await log(at("2026-10-17T10:00:00Z"), { cost: null, success: false, error: "overloaded_error" });
    expect((await getAiSpendOverview(prisma, NOW)).creditError).toBeNull();
  });
});
