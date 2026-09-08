import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { WeeklyProgrammingThesisSchema, type WeeklyProgrammingThesisOutput } from "./schemas";
import { formatBacklog, type BacklogItemSummary } from "./backlog-summary";

function buildUserPrompt(
  backlog: BacklogItemSummary[],
  referenceContext: string,
  brandContext: string,
): string {
  return `${brandContext}

## Current Ideas Backlog (state = IDEA)

${formatBacklog(backlog)}

${referenceContext ? `## Reference Intelligence Available\n\n${referenceContext}\n\n` : ""}## Task

Produce this week's Weekly Programming Thesis per your instructions above. Historical
performance data and audience intelligence are not yet available in this system (early
phase, before Phase 6/7) — ground the thesis in the Brand Constitution, the backlog above,
and any reference intelligence provided. State explicitly in humanDecisionsNeeded where you
lack data rather than inventing performance history or audience signal that doesn't exist.`;
}

export async function runCreativeDirectorAgent(
  provider: ModelProvider,
  input: { backlog: BacklogItemSummary[]; referenceContext: string; brandContext: string },
): Promise<WeeklyProgrammingThesisOutput> {
  const { systemPrompt, modelClass } = buildSystemPrompt("CREATIVE_DIRECTOR");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input.backlog, input.referenceContext, input.brandContext),
    schema: WeeklyProgrammingThesisSchema,
    promptId: "CREATIVE_DIRECTOR",
  });
  return result.output;
}
