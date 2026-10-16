import type { ProductionContract } from "@chris/domain";
import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { getRetrievalTools, retrievalInstruction } from "./retrieval-config";
import { ResearchPacketSchema, type ResearchPacket } from "./schemas";

function buildUserPrompt(contract: ProductionContract, retrieval: string, today: string): string {
  return `## Production Contract

Purpose: ${contract.purpose}
Primary idea: ${contract.primaryIdea}
Audience promise: ${contract.audiencePromise}
Topic: ${contract.topic}
Factual risk: ${contract.factualRisk}
Research depth: ${contract.researchDepth}
Scope: ${contract.scope}
DO NOT expand into: ${contract.doNotExpandInto}

${retrieval}

Today's date: ${today}

## Task

Research this content idea per your instructions above. Return a single ResearchPacket for
the Production Contract's primary claim. Do not research beyond the contract's scope. Every
numeric input and every FACT must carry the sourceUrl that supports it.`;
}

export async function runResearchAgent(
  provider: ModelProvider,
  input: { contract: ProductionContract; brandContext: string; today?: Date },
): Promise<ResearchPacket> {
  const { systemPrompt, modelClass } = buildSystemPrompt("RESEARCH");
  const tools = getRetrievalTools("RESEARCH");
  const today = (input.today ?? new Date()).toISOString().slice(0, 10);
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext || undefined,
    userPrompt: buildUserPrompt(input.contract, retrievalInstruction(tools), today),
    schema: ResearchPacketSchema,
    promptId: "RESEARCH",
    tools,
  });
  return result.output;
}

/** Deterministic pre-check (no model): numbers with no source can't be factually gated. The
 * findings are handed to the Claims Gate, which must treat them as unsupported. */
export function findUnsourcedClaims(research: ResearchPacket): string[] {
  const issues: string[] = [];
  for (const n of research.numericInputs) {
    if (!n.sourceUrl) issues.push(`Numeric input "${n.label}: ${n.value}" has no source URL.`);
  }
  for (const f of research.facts) {
    if (f.type === "FACT" && !f.sourceUrl) issues.push(`FACT "${f.statement}" has no source URL.`);
  }
  if (research.citations.length === 0) issues.push("The packet cites no sources at all.");
  return issues;
}
