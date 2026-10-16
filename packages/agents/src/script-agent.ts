import type { ProductionContract } from "@chris/domain";
import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { ScriptVersionSchema, type ScriptVersion, type ResearchPacket } from "./schemas";

/** A bounded revision request: rewrite `previousScript` applying exactly these edits. */
export interface ScriptRevisionRequest {
  previousScript: ScriptVersion;
  source: "CLAIMS_GATE" | "BRAND_GUARDIAN";
  requiredEdits: string[];
}

export interface ScriptAgentInput {
  contract: ProductionContract;
  research: ResearchPacket;
  brandContext: string;
  /** Required edits the Claims Gate attached to the RESEARCH verdict (PASS_WITH_REQUIRED_EDIT)
   * — the script must honour them from the first draft. */
  claimsGateRequiredEdits?: string[];
  revision?: ScriptRevisionRequest;
}

function bullets(items: string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : "(none)";
}

function buildUserPrompt(input: ScriptAgentInput): string {
  const { contract, research } = input;
  const base = `## Production Contract

Purpose: ${contract.purpose}
Primary idea: ${contract.primaryIdea}
Audience promise: ${contract.audiencePromise}
Target length: ${contract.targetLengthMinSeconds}-${contract.targetLengthMaxSeconds} seconds
DO NOT expand into: ${contract.doNotExpandInto}

## Verified Research Packet (the ONLY facts you may state)

Primary claim: ${research.primaryClaim}
Content-safe wording: ${research.contentSafeWording}
Facts:
${bullets(research.facts.filter((f) => f.type === "FACT").map((f) => f.statement))}
Numeric inputs (use these exact values — never round into a different claim, never add a number not listed):
${bullets(research.numericInputs.map((n) => `${n.label}: ${n.value}${n.asOfDate ? ` (as of ${n.asOfDate})` : ""}`))}
Caveats the script must keep:
${bullets(research.caveats)}

## PROHIBITED claims (never say these, in any wording)

${bullets(research.prohibitedClaims)}

## Claims Gate required edits (mandatory)

${bullets(input.claimsGateRequiredEdits ?? [])}`;

  if (!input.revision) {
    return `${base}

## Task

Write a spoken script for Chris per your instructions above, delivering the Production
Contract's audience promise using only the verified Research Packet. Any number or rule not in
the packet must not appear — the final script is independently fact-checked. Return a single
ScriptVersion.`;
  }

  const r = input.revision;
  return `${base}

## Previous script (revise THIS — keep what works)

${r.previousScript.spokenScript}

## Required edits from the ${r.source === "CLAIMS_GATE" ? "Claims Gate (factual hard gate)" : "Brand Guardian"} — apply every one

${bullets(r.requiredEdits)}

## Task

Revise the previous script applying every required edit above. Change only what the edits
require plus the minimum surrounding wording to keep it natural in Chris's voice. Do not add
new facts, numbers, or claims. Return a single ScriptVersion (the full revised script).`;
}

export async function runScriptAgent(provider: ModelProvider, input: ScriptAgentInput): Promise<ScriptVersion> {
  const { systemPrompt, modelClass } = buildSystemPrompt("SCRIPT");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext || undefined,
    userPrompt: buildUserPrompt(input),
    schema: ScriptVersionSchema,
    promptId: "SCRIPT",
  });
  return result.output;
}
