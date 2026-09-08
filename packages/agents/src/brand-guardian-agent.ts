import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { BrandGuardianReportSchema, type BrandGuardianReport, type ScriptVersion } from "./schemas";

function buildUserPrompt(script: ScriptVersion, brandContext: string): string {
  return `${brandContext}

## Script Under Review

${script.spokenScript}

Follow-up ideas noted by the Script Agent: ${script.followUpIdeas.join("; ") || "(none)"}

## Task

Evaluate this script against the Brand Constitution and Chris Brain per your instructions
above. Return a single BrandGuardianReport.`;
}

export async function runBrandGuardianAgent(
  provider: ModelProvider,
  input: { script: ScriptVersion; brandContext: string },
): Promise<BrandGuardianReport> {
  const { systemPrompt, modelClass } = buildSystemPrompt("BRAND_GUARDIAN");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input.script, input.brandContext),
    schema: BrandGuardianReportSchema,
    promptId: "BRAND_GUARDIAN",
  });
  return result.output;
}
