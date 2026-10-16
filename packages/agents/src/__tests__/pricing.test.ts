import { describe, it, expect, vi } from "vitest";
import {
  computeCostUsd,
  getModelPrice,
  CONSERVATIVE_FALLBACK_PRICE,
  PRICE_PER_MTOK_BY_MODEL,
  usageFromTokens,
} from "../pricing";
import { DEFAULT_MODEL_BY_CLASS } from "../providers/anthropic-provider";

describe("pricing (keyed by model ID)", () => {
  it("every default routing model has a price on file", () => {
    for (const model of Object.values(DEFAULT_MODEL_BY_CLASS)) {
      expect(PRICE_PER_MTOK_BY_MODEL[model]).toBeDefined();
    }
  });

  it("prices plain input/output at the model's own rates", () => {
    // claude-sonnet-5-5: $2 in / $10 out per MTok.
    expect(computeCostUsd("claude-sonnet-5-5", usageFromTokens(1_000_000, 1_000_000))).toBeCloseTo(12, 9);
    // claude-opus-5-5: $4 / $20.
    expect(computeCostUsd("claude-opus-5-5", usageFromTokens(5000, 1000))).toBeCloseTo(0.04, 9);
  });

  it("an env-overridden model is costed at ITS price, not the class's default", () => {
    expect(computeCostUsd("claude-opus-5", usageFromTokens(1_000_000, 0))).toBeCloseTo(5, 9);
    expect(computeCostUsd("claude-opus-5-5", usageFromTokens(1_000_000, 0))).toBeCloseTo(4, 9);
  });

  it("prices cache writes at 1.25x input, cache reads at the published read rate, and web searches per use", () => {
    const cost = computeCostUsd("claude-opus-5-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      webSearchRequests: 3,
      webFetchRequests: 5,
    });
    // 1M * $5 (write) + 1M * $0.20 (read) + 3 * $0.01 (search) + fetch is free
    expect(cost).toBeCloseTo(5 + 0.2 + 0.03, 9);
  });

  it("applies Haiku 5.5's long-context tier above 100K input tokens", () => {
    expect(computeCostUsd("claude-haiku-5-5", usageFromTokens(100_000, 0))).toBeCloseTo(0.01, 9);
    expect(computeCostUsd("claude-haiku-5-5", usageFromTokens(200_000, 0))).toBeCloseTo(0.1, 9);
  });

  it("resolves dated aliases to their family price", () => {
    expect(getModelPrice("claude-haiku-4-5-20251001")).toBe(PRICE_PER_MTOK_BY_MODEL["claude-haiku-4-5"]);
  });

  it("an unknown model warns and is costed conservatively (never under-counted)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(getModelPrice("some-future-model")).toBe(CONSERVATIVE_FALLBACK_PRICE);
    expect(warn).toHaveBeenCalledOnce();
    for (const p of Object.values(PRICE_PER_MTOK_BY_MODEL)) {
      expect(CONSERVATIVE_FALLBACK_PRICE.input).toBeGreaterThanOrEqual(p.input);
      expect(CONSERVATIVE_FALLBACK_PRICE.output).toBeGreaterThanOrEqual(p.output);
    }
    warn.mockRestore();
  });

  it("returns undefined (not 0) when usage is missing — an unknown cost is never fabricated as free", () => {
    expect(computeCostUsd("claude-sonnet-5-5", undefined)).toBeUndefined();
  });
});
