import { describe, it, expect } from "vitest";
import { computeCostUsd, PRICE_PER_MTOK } from "../pricing";

describe("pricing", () => {
  it("computes cost using the per-class MTok rates", () => {
    // 1,000,000 input + 1,000,000 output tokens at MEDIUM should equal exactly input+output rate.
    const cost = computeCostUsd("MEDIUM", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(PRICE_PER_MTOK.MEDIUM.input + PRICE_PER_MTOK.MEDIUM.output, 9);
  });

  it("scales linearly with token count", () => {
    const small = computeCostUsd("HIGH", 1000, 200)!;
    const large = computeCostUsd("HIGH", 10000, 2000)!;
    expect(large).toBeCloseTo(small * 10, 9);
  });

  it("returns undefined (not 0) when token counts are missing — an unknown cost is never fabricated as free", () => {
    expect(computeCostUsd("LOW", undefined, 100)).toBeUndefined();
    expect(computeCostUsd("LOW", 100, undefined)).toBeUndefined();
    expect(computeCostUsd("LOW", undefined, undefined)).toBeUndefined();
  });

  it("HIGH is the most expensive class and LOW the cheapest, both directions", () => {
    expect(PRICE_PER_MTOK.HIGH.input).toBeGreaterThan(PRICE_PER_MTOK.MEDIUM.input);
    expect(PRICE_PER_MTOK.MEDIUM.input).toBeGreaterThan(PRICE_PER_MTOK.LOW.input);
    expect(PRICE_PER_MTOK.HIGH.output).toBeGreaterThan(PRICE_PER_MTOK.MEDIUM.output);
    expect(PRICE_PER_MTOK.MEDIUM.output).toBeGreaterThan(PRICE_PER_MTOK.LOW.output);
  });
});
