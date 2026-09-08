import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runResearchToScriptPipeline } from "../pipeline";
import {
  fixtureContract,
  fixtureResearchPacket,
  fixtureClaimsGateResult,
  fixtureScriptVersion,
  fixtureBrandGuardianReport,
} from "./fixtures";

/** Routes a mock response by which prompt is being called, so one provider can drive the
 * whole pipeline through all four agents in sequence. */
function routedProvider(overrides: {
  research?: ReturnType<typeof fixtureResearchPacket>;
  claimsGate?: ReturnType<typeof fixtureClaimsGateResult>;
  script?: ReturnType<typeof fixtureScriptVersion>;
  brandGuardian?: ReturnType<typeof fixtureBrandGuardianReport>;
}) {
  return new MockModelProvider((req) => {
    switch (req.promptId) {
      case "RESEARCH":
        return overrides.research ?? fixtureResearchPacket();
      case "CLAIMS_GATE":
        return overrides.claimsGate ?? fixtureClaimsGateResult();
      case "SCRIPT":
        return overrides.script ?? fixtureScriptVersion();
      case "BRAND_GUARDIAN":
        return overrides.brandGuardian ?? fixtureBrandGuardianReport();
      default:
        throw new Error(`Unexpected promptId in test: ${req.promptId}`);
    }
  });
}

describe("Research -> Claims Gate -> Script pipeline (mock provider — zero cost)", () => {
  it("runs end-to-end to READY when research is sufficient and claims pass", async () => {
    const provider = routedProvider({});
    const result = await runResearchToScriptPipeline(provider, {
      contract: fixtureContract(),
      brandContext: "brand context",
    });

    expect(result.status).toBe("READY");
    if (result.status === "READY") {
      expect(result.script.spokenScript.length).toBeGreaterThan(0);
      expect(result.brandGuardianReport.brandScore).toBeGreaterThan(0);
    }
    // All four agents actually ran.
    expect(provider.calls.map((c) => c.promptId)).toEqual([
      "RESEARCH",
      "CLAIMS_GATE",
      "SCRIPT",
      "BRAND_GUARDIAN",
    ]);
  });

  it("stops after Research when status is NEEDS_MORE_RESEARCH — never calls Claims Gate", async () => {
    const provider = routedProvider({
      research: fixtureResearchPacket({ status: "NEEDS_MORE_RESEARCH", stopResearching: false }),
    });
    const result = await runResearchToScriptPipeline(provider, {
      contract: fixtureContract(),
      brandContext: "",
    });

    expect(result.status).toBe("NEEDS_MORE_RESEARCH");
    expect(provider.calls.map((c) => c.promptId)).toEqual(["RESEARCH"]);
  });

  it("stops after Research when status is UNSUPPORTED", async () => {
    const provider = routedProvider({
      research: fixtureResearchPacket({ status: "UNSUPPORTED" }),
    });
    const result = await runResearchToScriptPipeline(provider, {
      contract: fixtureContract(),
      brandContext: "",
    });
    expect(result.status).toBe("UNSUPPORTED");
    expect(provider.calls).toHaveLength(1);
  });

  it("a Claims Gate BLOCK stops the pipeline before scripting ever runs — the hard gate holds", async () => {
    const provider = routedProvider({
      claimsGate: fixtureClaimsGateResult({
        result: "BLOCK",
        blockReason: "Unsupported numeric claim about score point impact.",
      }),
    });
    const result = await runResearchToScriptPipeline(provider, {
      contract: fixtureContract(),
      brandContext: "",
    });

    expect(result.status).toBe("RESEARCH_BLOCKED");
    // Critically: SCRIPT and BRAND_GUARDIAN never ran. A creative step must never see
    // content that failed the factual hard gate — this is the regression test called for by
    // /docs/PHASE_PLAN.md Phase 4 ("a hard-gate BLOCK is never averaged away"), verified here
    // at the earliest point it applies.
    expect(provider.calls.map((c) => c.promptId)).toEqual(["RESEARCH", "CLAIMS_GATE"]);
  });

  it("PASS_WITH_REQUIRED_EDIT still proceeds to scripting (it is not a BLOCK)", async () => {
    const provider = routedProvider({
      claimsGate: fixtureClaimsGateResult({
        result: "PASS_WITH_REQUIRED_EDIT",
        requiredEdits: ["Soften the certainty of the utilization claim."],
      }),
    });
    const result = await runResearchToScriptPipeline(provider, {
      contract: fixtureContract(),
      brandContext: "",
    });
    expect(result.status).toBe("READY");
    expect(provider.calls.map((c) => c.promptId)).toContain("SCRIPT");
  });
});
