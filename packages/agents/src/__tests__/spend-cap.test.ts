import { describe, it, expect } from "vitest";
import { startOfUtcDay, SpendCapExceededError, DEFAULT_DAILY_SPEND_CAP_USD } from "../spend-cap";

describe("spend-cap", () => {
  it("startOfUtcDay snaps to UTC midnight of the given date, not local midnight", () => {
    const d = new Date("2026-09-08T23:59:59.999Z");
    const start = startOfUtcDay(d);
    expect(start.toISOString()).toBe("2026-09-08T00:00:00.000Z");
  });

  it("startOfUtcDay is idempotent on an already-midnight timestamp", () => {
    const d = new Date("2026-09-08T00:00:00.000Z");
    expect(startOfUtcDay(d).toISOString()).toBe(d.toISOString());
  });

  it("SpendCapExceededError carries the structured fields and a human-readable message", () => {
    const err = new SpendCapExceededError("MY_PROMPT", 30, 31.5);
    expect(err.promptId).toBe("MY_PROMPT");
    expect(err.capUsd).toBe(30);
    expect(err.spentTodayUsd).toBe(31.5);
    expect(err.name).toBe("SpendCapExceededError");
    expect(err.message).toContain("MY_PROMPT");
    expect(err.message).toContain("30.00");
    expect(err.message).toContain("31.50");
  });

  it("has a positive, finite default cap", () => {
    expect(DEFAULT_DAILY_SPEND_CAP_USD).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_DAILY_SPEND_CAP_USD)).toBe(true);
  });
});
