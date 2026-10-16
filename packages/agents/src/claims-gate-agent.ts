import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { getRetrievalTools, retrievalInstruction } from "./retrieval-config";
import { findUnsourcedClaims } from "./research-agent";
import { ClaimsGateResultSchema, type ClaimsGateResult, type ResearchPacket } from "./schemas";

/** The script text under review — only what a viewer will actually hear/see matters. */
export interface ScriptUnderReview {
  spokenScript: string;
  requiredFactualCaveats?: string[];
  /** On-screen text, when known (numbers on screen are claims too). */
  visualBeats?: string[];
}

function formatResearch(research: ResearchPacket): string {
  return `Primary claim: ${research.primaryClaim}
Facts: ${JSON.stringify(research.facts, null, 2)}
Citations: ${JSON.stringify(research.citations, null, 2)}
Numeric inputs: ${JSON.stringify(research.numericInputs, null, 2)}
Caveats: ${research.caveats.join("; ") || "(none)"}
Confidence: ${research.confidence}
Contradictory evidence: ${research.contradictoryEvidence.join("; ") || "(none)"}
Prohibited / unsupported claims: ${research.prohibitedClaims.join("; ") || "(none)"}
Content-safe wording: ${research.contentSafeWording}`;
}

function buildUserPrompt(
  research: ResearchPacket,
  script: ScriptUnderReview | undefined,
  retrieval: string,
  today: string,
): string {
  const precheck = findUnsourcedClaims(research);
  const precheckBlock = precheck.length
    ? `## Deterministic pre-check findings (code, not judgment — treat each as unsupported unless you independently verify it)\n\n${precheck.map((p) => `- ${p}`).join("\n")}\n\n`
    : "";

  if (!script) {
    return `## Research Packet Under Review

${formatResearch(research)}

${precheckBlock}${retrieval}

Today's date: ${today}

## Task

MODE: RESEARCH. Independently evaluate every externally verifiable claim in this Research
Packet per your instructions above. Do not assume the Research Agent is correct. Return a
single ClaimsGateResult.`;
  }

  return `## Final Script Under Review (what the viewer will actually hear)

${script.spokenScript}

On-screen / visual beats: ${script.visualBeats?.join("; ") || "(none provided)"}
Caveats the script claims to include: ${script.requiredFactualCaveats?.join("; ") || "(none)"}

## Verified Research Packet (the evidence the script is allowed to rely on)

${formatResearch(research)}

${precheckBlock}${retrieval}

Today's date: ${today}

## Task

MODE: SCRIPT. Evaluate the SCRIPT's wording, not the packet. Extract every externally
verifiable claim the script makes (spoken or on screen) — every number, limit, rate, rule,
date, return, and causal statement. For each, check it against the Research Packet:
- A number or rule in the script that is absent from, or different from, the packet is
  unsupported unless you independently verify it with a primary source. Unsupported
  material claim -> BLOCK, or PASS_WITH_REQUIRED_EDIT with the exact replacement wording.
- A caveat the packet requires but the script drops -> omittedCaveatRisk, required edit.
- Wording that overstates the packet (always/never/guaranteed/can't lose) -> required edit.
- A prohibited claim from the packet appearing in any form -> BLOCK.
Each requiredEdits entry must be a concrete, self-contained instruction the Script Agent can
apply (quote the offending words and give the replacement). Return a single ClaimsGateResult.`;
}

export async function runClaimsGateAgent(
  provider: ModelProvider,
  input: { research: ResearchPacket; brandContext: string; script?: ScriptUnderReview; today?: Date },
): Promise<ClaimsGateResult> {
  const { systemPrompt, modelClass } = buildSystemPrompt("CLAIMS_GATE");
  const tools = getRetrievalTools("CLAIMS_GATE");
  const today = (input.today ?? new Date()).toISOString().slice(0, 10);
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext || undefined,
    userPrompt: buildUserPrompt(input.research, input.script, retrievalInstruction(tools), today),
    schema: ClaimsGateResultSchema,
    promptId: "CLAIMS_GATE",
    tools,
  });
  return normalizeClaimsGateResult(result.output);
}

/**
 * Deterministic consistency rules on the gate's own output (the model's verdict can only be
 * made STRICTER here, never looser):
 * - PASS with required edits listed is really PASS_WITH_REQUIRED_EDIT.
 * - PASS_WITH_REQUIRED_EDIT with no edits is unactionable -> BLOCK (nothing to apply).
 * - BLOCK always carries a reason.
 */
export function normalizeClaimsGateResult(result: ClaimsGateResult): ClaimsGateResult {
  if (result.result === "PASS" && result.requiredEdits.length > 0) {
    return { ...result, result: "PASS_WITH_REQUIRED_EDIT" };
  }
  if (result.result === "PASS_WITH_REQUIRED_EDIT" && result.requiredEdits.length === 0) {
    return {
      ...result,
      result: "BLOCK",
      blockReason: result.blockReason ?? "Claims Gate required edits but listed none — unactionable, treated as BLOCK.",
    };
  }
  if (result.result === "BLOCK" && !result.blockReason) {
    return { ...result, blockReason: "Claims Gate BLOCK (no reason given)." };
  }
  return result;
}
