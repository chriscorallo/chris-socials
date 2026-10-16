import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import type { StructuredCompletionRequest } from "../model-provider";
import {
  runResearchToScriptPipeline,
  toPipelineResultInput,
  PipelineBudgetExceededError,
  defaultMaxModelCalls,
} from "../pipeline";
import { normalizeClaimsGateResult } from "../claims-gate-agent";
import { findUnsourcedClaims } from "../research-agent";
import type { ClaimsGateResult, ScriptVersion, BrandGuardianReport } from "../schemas";
import {
  fixtureContract,
  fixtureResearchPacket,
  fixtureClaimsGateResult,
  fixtureScriptVersion,
  fixtureBrandGuardianReport,
} from "./fixtures";

type Req = StructuredCompletionRequest<unknown>;
const isScriptGate = (req: Req) => req.promptId === "CLAIMS_GATE" && req.userPrompt.includes("MODE: SCRIPT");
const isRevision = (req: Req) => req.promptId === "SCRIPT" && req.userPrompt.includes("## Previous script");

/** Routes mock responses by prompt (and Claims Gate mode), with sequences for repeated calls. */
function routedProvider(o: {
  research?: ReturnType<typeof fixtureResearchPacket>;
  researchGate?: ClaimsGateResult;
  scriptGates?: ClaimsGateResult[];
  scripts?: ScriptVersion[];
  brandReports?: BrandGuardianReport[];
}) {
  let scriptGateN = 0;
  let scriptN = 0;
  let brandN = 0;
  const pick = <T,>(arr: T[] | undefined, n: number, fallback: T): T => (arr ? (arr[Math.min(n, arr.length - 1)] ?? fallback) : fallback);
  return new MockModelProvider((req) => {
    switch (req.promptId) {
      case "RESEARCH":
        return o.research ?? fixtureResearchPacket();
      case "CLAIMS_GATE":
        return isScriptGate(req)
          ? pick(o.scriptGates, scriptGateN++, fixtureClaimsGateResult())
          : (o.researchGate ?? fixtureClaimsGateResult());
      case "SCRIPT":
        return pick(o.scripts, scriptN++, fixtureScriptVersion());
      case "BRAND_GUARDIAN":
        return pick(o.brandReports, brandN++, fixtureBrandGuardianReport());
      default:
        throw new Error(`Unexpected promptId in test: ${req.promptId}`);
    }
  });
}

const run = (provider: MockModelProvider, options = {}) =>
  runResearchToScriptPipeline(provider, { contract: fixtureContract(), brandContext: "brand context" }, options);

describe("Research -> Claims Gate -> Script -> Claims Gate (script) -> Brand Guardian (mock provider — zero cost)", () => {
  it("runs end-to-end to READY, and the Claims Gate checks the FINAL SCRIPT, not just the research", async () => {
    const provider = routedProvider({});
    const result = await run(provider);

    expect(result.status).toBe("READY");
    expect(provider.calls.map((c) => c.promptId)).toEqual(["RESEARCH", "CLAIMS_GATE", "SCRIPT", "CLAIMS_GATE", "BRAND_GUARDIAN"]);
    const scriptGateCall = provider.calls[3]!;
    expect(isScriptGate(scriptGateCall)).toBe(true);
    expect(scriptGateCall.userPrompt).toContain(fixtureScriptVersion().spokenScript);
    if (result.status === "READY") {
      expect(result.scriptClaimsGateResult.result).toBe("PASS");
      expect(result.scriptHistory).toHaveLength(1);
      expect(result.brandNeedsHumanReview).toBe(false);
    }
  });

  it("REGRESSION: a script that adds an unsupported number is caught at the script-level gate (SCRIPT_BLOCKED)", async () => {
    const inventedNumber = fixtureScriptVersion({
      spokenScript: "Paying off a card drops your score by exactly 87 points. Every time.",
    });
    const provider = routedProvider({
      scripts: [inventedNumber],
      scriptGates: [
        fixtureClaimsGateResult({
          result: "BLOCK",
          blockReason: "Script states '87 points' — not in the research packet and unverifiable.",
        }),
      ],
    });
    const result = await run(provider);

    expect(result.status).toBe("SCRIPT_BLOCKED");
    if (result.status === "SCRIPT_BLOCKED") {
      expect(result.blockReason).toContain("87 points");
      expect(result.script.spokenScript).toContain("87 points");
    }
    // Brand Guardian never ran on a factually blocked script.
    expect(provider.calls.map((c) => c.promptId)).not.toContain("BRAND_GUARDIAN");
  });

  it("PASS_WITH_REQUIRED_EDIT on the script -> one bounded revision applying the edits, then re-gated", async () => {
    const edit = "Replace 'always drops' with 'can sometimes dip temporarily'.";
    const provider = routedProvider({
      scripts: [fixtureScriptVersion({ spokenScript: "It always drops." }), fixtureScriptVersion({ spokenScript: "It can sometimes dip temporarily." })],
      scriptGates: [
        fixtureClaimsGateResult({ result: "PASS_WITH_REQUIRED_EDIT", requiredEdits: [edit] }),
        fixtureClaimsGateResult({ result: "PASS" }),
      ],
    });
    const result = await run(provider);

    expect(result.status).toBe("READY");
    const revisionCall = provider.calls.find(isRevision)!;
    expect(revisionCall.userPrompt).toContain(edit);
    expect(revisionCall.userPrompt).toContain("It always drops.");
    if (result.status === "READY") {
      expect(result.script.spokenScript).toBe("It can sometimes dip temporarily.");
      expect(result.scriptHistory).toHaveLength(2);
      expect(result.scriptHistory[1]!.revisionNote).toContain(edit);
    }
  });

  it("required edits still unresolved after the revision budget -> SCRIPT_BLOCKED (no unchecked script is READY)", async () => {
    const needsEdit = fixtureClaimsGateResult({ result: "PASS_WITH_REQUIRED_EDIT", requiredEdits: ["Add the caveat."] });
    const provider = routedProvider({ scriptGates: [needsEdit, needsEdit] });
    const result = await run(provider);
    expect(result.status).toBe("SCRIPT_BLOCKED");
    expect(provider.calls.filter(isRevision)).toHaveLength(1); // bounded: default max 1
  });

  it("research-level required edits and prohibited claims are handed to the first Script draft", async () => {
    const provider = routedProvider({
      researchGate: fixtureClaimsGateResult({ result: "PASS_WITH_REQUIRED_EDIT", requiredEdits: ["Say 'can', never 'will'."] }),
    });
    await run(provider);
    const firstScript = provider.calls.find((c) => c.promptId === "SCRIPT")!;
    expect(firstScript.userPrompt).toContain("Say 'can', never 'will'.");
    expect(firstScript.userPrompt).toContain(fixtureResearchPacket().prohibitedClaims[0]!);
  });

  it("Brand Guardian required changes -> one brand revision, re-gated, then re-reviewed", async () => {
    const provider = routedProvider({
      brandReports: [
        fixtureBrandGuardianReport({ voiceScore: 55, requiredChanges: ["Cut the corporate opener."] }),
        fixtureBrandGuardianReport({ voiceScore: 85 }),
      ],
    });
    const result = await run(provider);
    expect(provider.calls.map((c) => c.promptId)).toEqual([
      "RESEARCH", "CLAIMS_GATE", "SCRIPT", "CLAIMS_GATE", "BRAND_GUARDIAN", "SCRIPT", "CLAIMS_GATE", "BRAND_GUARDIAN",
    ]);
    if (result.status === "READY") {
      expect(result.brandGuardianReport.voiceScore).toBe(85);
      expect(result.brandNeedsHumanReview).toBe(false);
      expect(result.scriptHistory).toHaveLength(2);
    }
  });

  it("a brand revision that fails the Claims Gate is DISCARDED — brand quality never buys back a factual failure", async () => {
    const provider = routedProvider({
      scripts: [fixtureScriptVersion({ spokenScript: "Safe draft." }), fixtureScriptVersion({ spokenScript: "Punchier but adds a 30% stat." })],
      scriptGates: [fixtureClaimsGateResult({ result: "PASS" }), fixtureClaimsGateResult({ result: "BLOCK", blockReason: "30% unsupported" })],
      brandReports: [fixtureBrandGuardianReport({ brandScore: 50, requiredChanges: ["More energy."] })],
    });
    const result = await run(provider);
    expect(result.status).toBe("READY");
    if (result.status === "READY") {
      expect(result.script.spokenScript).toBe("Safe draft.");
      expect(result.scriptClaimsGateResult.result).toBe("PASS");
      expect(result.discardedRevisions).toHaveLength(1);
      expect(result.brandNeedsHumanReview).toBe(true);
    }
  });

  it("enforces the per-run model-call budget before making the call", async () => {
    const provider = routedProvider({});
    await expect(run(provider, { maxModelCalls: 3 })).rejects.toBeInstanceOf(PipelineBudgetExceededError);
    expect(provider.calls).toHaveLength(3);
    expect(defaultMaxModelCalls(1)).toBe(10);
  });

  it("stops after Research when status is NEEDS_MORE_RESEARCH — never calls Claims Gate", async () => {
    const provider = routedProvider({ research: fixtureResearchPacket({ status: "NEEDS_MORE_RESEARCH", stopResearching: false }) });
    const result = await run(provider);
    expect(result.status).toBe("NEEDS_MORE_RESEARCH");
    expect(provider.calls.map((c) => c.promptId)).toEqual(["RESEARCH"]);
  });

  it("a research-level Claims Gate BLOCK stops the pipeline before scripting ever runs — the hard gate holds", async () => {
    const provider = routedProvider({
      researchGate: fixtureClaimsGateResult({ result: "BLOCK", blockReason: "Unsupported numeric claim about score point impact." }),
    });
    const result = await run(provider);
    expect(result.status).toBe("RESEARCH_BLOCKED");
    expect(provider.calls.map((c) => c.promptId)).toEqual(["RESEARCH", "CLAIMS_GATE"]);
  });

  it("toPipelineResultInput carries the script-level gate result and history for persistence", async () => {
    const result = await run(routedProvider({}));
    const input = toPipelineResultInput(result);
    expect(input.scriptClaimsGateResult?.result).toBe("PASS");
    expect(input.scriptHistory).toHaveLength(1);
  });
});

describe("Claims Gate deterministic rules", () => {
  it("normalize: verdicts can only get stricter", () => {
    expect(normalizeClaimsGateResult(fixtureClaimsGateResult({ result: "PASS", requiredEdits: ["x"] })).result).toBe("PASS_WITH_REQUIRED_EDIT");
    expect(normalizeClaimsGateResult(fixtureClaimsGateResult({ result: "PASS_WITH_REQUIRED_EDIT", requiredEdits: [] })).result).toBe("BLOCK");
    expect(normalizeClaimsGateResult(fixtureClaimsGateResult({ result: "BLOCK", blockReason: null })).blockReason).toBeTruthy();
  });

  it("pre-check flags numbers without sources, and the gate prompt receives the findings", async () => {
    const research = fixtureResearchPacket({
      numericInputs: [{ label: "Score drop", value: "87 points", sourceUrl: null, asOfDate: null }],
    });
    expect(findUnsourcedClaims(research)).toEqual([`Numeric input "Score drop: 87 points" has no source URL.`]);
    const provider = routedProvider({ research });
    await run(provider);
    expect(provider.calls[1]!.userPrompt).toContain("Deterministic pre-check findings");
  });
});
