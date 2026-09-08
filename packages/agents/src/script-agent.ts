import type { ProductionContract } from "@chris/domain";
import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { ScriptVersionSchema, type ScriptVersion, type ResearchPacket } from "./schemas";

function buildUserPrompt(
  contract: ProductionContract,
  research: ResearchPacket,
  brandContext: string,
): string {
  return `${brandContext}

## Production Contract

Purpose: ${contract.purpose}
Primary idea: ${contract.primaryIdea}
Audience promise: ${contract.audiencePromise}
Target length: ${contract.targetLengthMinSeconds}-${contract.targetLengthMaxSeconds} seconds
DO NOT expand into: ${contract.doNotExpandInto}

## Verified Research Packet

Primary claim: ${research.primaryClaim}
Content-safe wording: ${research.contentSafeWording}
Caveats: ${research.caveats.join("; ") || "(none)"}
Numeric inputs: ${JSON.stringify(research.numericInputs, null, 2)}

## Task

Write a spoken script for Chris per your instructions above, delivering the Production
Contract's audience promise using only the verified Research Packet's claim. Return a single
ScriptVersion.`;
}

export async function runScriptAgent(
  provider: ModelProvider,
  input: { contract: ProductionContract; research: ResearchPacket; brandContext: string },
): Promise<ScriptVersion> {
  const { systemPrompt, modelClass } = buildSystemPrompt("SCRIPT");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input.contract, input.research, input.brandContext),
    schema: ScriptVersionSchema,
    promptId: "SCRIPT",
  });
  return result.output;
}
