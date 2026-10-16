import { describe, it, expect } from "vitest";
import { MockModelProvider } from "@chris/agents";
import { loadEvalCases, runEvalSuite, checkAssertions, summarizeByPrompt } from "../runner";

/**
 * Zero-cost self-test of the eval harness (runs in the normal suite). Proves that fixtures
 * parse, every case's known-good mockResponse grades PASS through the real agent functions
 * and real output schemas, and the grader actually fails a wrong answer — so a real-model run's
 * pass/fail table means something.
 */
const cases = loadEvalCases();

describe("eval harness (mock mode)", () => {
  it("loads gold-standard fixtures covering the spec §24 categories under test", () => {
    const categories = new Set(cases.map((c) => c.category));
    for (const c of ["accurate_finance_claim", "misleading_finance_claim", "chris_voice", "non_chris_voice", "cringe_cta", "appropriate_cta", "excessive_reference_copying"]) {
      expect(categories).toContain(c);
    }
  });

  it("every case's known-good mock response passes through the real agent + schema", async () => {
    const byId = new Map(cases.map((c) => [c.id, c]));
    let current = "";
    const provider = new MockModelProvider(() => byId.get(current)?.mockResponse);
    for (const c of cases) {
      current = c.id;
      const { results } = await runEvalSuite(provider, [c], { brandContext: "brand" });
      expect(results[0]?.failures, c.id).toEqual([]);
    }
  });

  it("the grader fails wrong answers (a misleading claim that PASSes is a FAIL)", async () => {
    const misleading = cases.filter((c) => c.category === "misleading_finance_claim");
    const provider = new MockModelProvider(() => ({ claims: [], result: "PASS", requiredEdits: [], blockReason: null }));
    const { results } = await runEvalSuite(provider, misleading, { brandContext: "b" });
    expect(results.every((r) => !r.passed)).toBe(true);
    expect(summarizeByPrompt(results).CLAIMS_GATE?.allPassed).toBe(false);
  });

  it("assertion modes: all vs any, and path/threshold checks", () => {
    const out = { voiceScore: 50, brandScore: 90, requiredChanges: [] };
    expect(checkAssertions(out, [{ path: "voiceScore", lt: 70 }, { path: "brandScore", lt: 70 }], "any")).toEqual([]);
    expect(checkAssertions(out, [{ path: "voiceScore", lt: 70 }, { path: "brandScore", lt: 70 }], "all")).toHaveLength(1);
    expect(checkAssertions(out, [{ path: "requiredChanges", nonEmpty: true }])).toHaveLength(1);
  });

  it("a provider error is a FAIL with the error recorded, not a crash", async () => {
    const provider = new MockModelProvider(() => {
      throw new Error("boom");
    });
    const { results } = await runEvalSuite(provider, [cases[0]!], { brandContext: "b" });
    expect(results[0]).toMatchObject({ passed: false, error: "boom" });
  });
});
