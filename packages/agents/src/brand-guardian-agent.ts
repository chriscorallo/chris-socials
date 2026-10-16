import { DEFAULT_BRAND_SCORE_THRESHOLD } from "@chris/domain";
import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { BrandGuardianReportSchema, type BrandGuardianReport } from "./schemas";

function buildUserPrompt(script: { spokenScript: string; followUpIdeas?: string[] }, strategyContext?: string): string {
  return `## Script Under Review

${script.spokenScript}

Follow-up ideas noted by the Script Agent: ${script.followUpIdeas?.join("; ") || "(none)"}
${strategyContext ? `\n## Current strategy\n\n${strategyContext}\n` : ""}
## Task

Evaluate this script against the Brand Constitution and Chris Brain per your instructions
above. Put only changes that genuinely must happen before filming in requiredChanges (each a
concrete, self-contained instruction); nice-to-haves go in optionalImprovements. Return a
single BrandGuardianReport.`;
}

export async function runBrandGuardianAgent(
  provider: ModelProvider,
  input: { script: { spokenScript: string; followUpIdeas?: string[] }; brandContext: string; strategyContext?: string },
): Promise<BrandGuardianReport> {
  const { systemPrompt, modelClass } = buildSystemPrompt("BRAND_GUARDIAN");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext || undefined,
    userPrompt: buildUserPrompt(input.script, input.strategyContext),
    schema: BrandGuardianReportSchema,
    promptId: "BRAND_GUARDIAN",
  });
  return result.output;
}

/** Deterministic: does this report call for a revision before filming? Uses the same
 * thresholds as the BRAND hard gate (packages/domain quality-gate.ts). */
export function brandReportNeedsRevision(
  report: BrandGuardianReport,
  threshold: number = DEFAULT_BRAND_SCORE_THRESHOLD,
): boolean {
  return report.requiredChanges.length > 0 || report.brandScore < threshold || report.voiceScore < threshold;
}
