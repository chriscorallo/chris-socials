import type { ProductionContract } from "@chris/domain";
import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { ResearchPacketSchema, type ResearchPacket } from "./schemas";

function buildUserPrompt(contract: ProductionContract, brandContext: string): string {
  return `${brandContext}

## Production Contract

Purpose: ${contract.purpose}
Primary idea: ${contract.primaryIdea}
Audience promise: ${contract.audiencePromise}
Topic: ${contract.topic}
Factual risk: ${contract.factualRisk}
Research depth: ${contract.researchDepth}
Scope: ${contract.scope}
DO NOT expand into: ${contract.doNotExpandInto}

## Task

Research this content idea per your instructions above. Return a single ResearchPacket for
the Production Contract's primary claim. Do not research beyond the contract's scope.`;
}

export async function runResearchAgent(
  provider: ModelProvider,
  input: { contract: ProductionContract; brandContext: string },
): Promise<ResearchPacket> {
  const { systemPrompt, modelClass } = buildSystemPrompt("RESEARCH");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input.contract, input.brandContext),
    schema: ResearchPacketSchema,
    promptId: "RESEARCH",
  });
  return result.output;
}
