import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { WeeklyProgrammingThesisSchema, type WeeklyProgrammingThesisOutput } from "./schemas";
import { formatBacklog, type BacklogItemSummary } from "./backlog-summary";

function buildUserPrompt(backlog: BacklogItemSummary[], referenceContext: string, strategicContext: string): string {
  const evidence = strategicContext
    ? `${strategicContext}\n\n`
    : "## Strategic context\n\n(No learning-system data was provided for this run.)\n\n";
  return `## Current Ideas Backlog (state = IDEA)

${formatBacklog(backlog)}

${evidence}${referenceContext ? `## Reference Intelligence Available\n\n${referenceContext}\n\n` : ""}## Task

Produce this week's Weekly Programming Thesis per your instructions above. Ground it in the
Brand Constitution, the strategic context (accepted beliefs, last week's brief, performance,
audience insights, taste feedback), the backlog, and any reference intelligence. Where a
section says there is no data, plan around that honestly and state in humanDecisionsNeeded
what's missing — never invent performance history or audience signal.`;
}

export async function runCreativeDirectorAgent(
  provider: ModelProvider,
  input: {
    backlog: BacklogItemSummary[];
    referenceContext: string;
    brandContext: string;
    /** packages/domain buildStrategicContext(prisma) — optional for backward compatibility. */
    strategicContext?: string;
  },
): Promise<WeeklyProgrammingThesisOutput> {
  const { systemPrompt, modelClass } = buildSystemPrompt("CREATIVE_DIRECTOR");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext || undefined,
    userPrompt: buildUserPrompt(input.backlog, input.referenceContext, input.strategicContext ?? ""),
    schema: WeeklyProgrammingThesisSchema,
    promptId: "CREATIVE_DIRECTOR",
  });
  return result.output;
}
