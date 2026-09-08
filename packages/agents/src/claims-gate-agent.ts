import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { ClaimsGateResultSchema, type ClaimsGateResult, type ResearchPacket } from "./schemas";

function buildUserPrompt(research: ResearchPacket, brandContext: string): string {
  return `${brandContext}

## Research Packet Under Review

Primary claim: ${research.primaryClaim}
Facts: ${JSON.stringify(research.facts, null, 2)}
Citations: ${research.citations.join("; ") || "(none)"}
Numeric inputs: ${JSON.stringify(research.numericInputs, null, 2)}
Confidence: ${research.confidence}
Contradictory evidence: ${research.contradictoryEvidence.join("; ") || "(none)"}
Content-safe wording: ${research.contentSafeWording}

## Task

Independently evaluate every externally verifiable claim in this Research Packet per your
instructions above. Do not assume the Research Agent is correct. Return a single
ClaimsGateResult.`;
}

export async function runClaimsGateAgent(
  provider: ModelProvider,
  input: { research: ResearchPacket; brandContext: string },
): Promise<ClaimsGateResult> {
  const { systemPrompt, modelClass } = buildSystemPrompt("CLAIMS_GATE");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input.research, input.brandContext),
    schema: ClaimsGateResultSchema,
    promptId: "CLAIMS_GATE",
  });
  return result.output;
}
