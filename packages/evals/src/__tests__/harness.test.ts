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

  it("motion-design cases: theme fits topic, taste respected, no invented numbers — and the grader catches a misfit", async () => {
    const categories = new Set(cases.map((c) => c.category));
    for (const c of ["motion_theme_fits_topic", "motion_taste_respected", "motion_no_invented_numbers"]) expect(categories).toContain(c);
    const debt = cases.find((c) => c.id === "md-debt-theme")!;
    const playful = { ...(debt.mockResponse as Record<string, unknown>), theme: { name: "Party", motionLanguage: "PLAYFUL", primary: null, secondary: null, iconStyle: "SOFT_CLAY", rationale: "fun" } };
    const { results } = await runEvalSuite(new MockModelProvider(() => playful), [debt], { brandContext: "b" });
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.failures.join(" ")).toContain("theme.motionLanguage");
  });

  it("viewer-panel cases: audio balance, cut rhythm, calibration — and the grader catches a viewer who missed the music", async () => {
    const categories = new Set(cases.map((c) => c.category));
    for (const c of ["viewer_audio_balance", "viewer_cut_rhythm", "viewer_calibration"]) expect(categories).toContain(c);
    const music = cases.find((c) => c.id === "vp-music-over-voice")!;
    const missed = structuredClone(cases.find((c) => c.id === "vp-clean-calibrated")!.mockResponse);
    const { results } = await runEvalSuite(new MockModelProvider(() => missed), [music], { brandContext: "b" });
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.failures.join(" ")).toContain("flagsMusicOverVoice");
    const loud = structuredClone(missed) as { verdict: { headline: string } };
    loud.verdict.headline = "This will go viral for sure.";
    const calib = cases.find((c) => c.id === "vp-clean-calibrated")!;
    const r2 = await runEvalSuite(new MockModelProvider(() => loud), [calib], { brandContext: "b" });
    expect(r2.results[0]!.failures.join(" ")).toContain("certaintyWarnings");
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
