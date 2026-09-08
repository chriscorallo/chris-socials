import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { ExperimentAgentResultSchema, type ExperimentAgentResult } from "./schemas";

export interface PriorExperimentSummary {
  hypothesis: string;
  status: string;
  conclusion: string | null;
}

function buildUserPrompt(input: {
  weeklySlateSummary: string;
  priorExperiments: PriorExperimentSummary[];
  brandContext: string;
}): string {
  const priorList =
    input.priorExperiments.length === 0
      ? "(no prior experiments yet)"
      : input.priorExperiments.map((e) => `- [${e.status}] ${e.hypothesis}${e.conclusion ? ` — ${e.conclusion}` : ""}`).join("\n");

  return `${input.brandContext}

## This week's slate (summary)

${input.weeklySlateSummary}

## Prior experiment results

${priorList}

## Task

Design practical, honest tests per your instructions above — falsifiable hypotheses, real
confounders, a minimum sample/duration before drawing a conclusion. Do not propose an
experiment Chris can't actually run inside a real ~30-video/week production cadence.`;
}

export async function runExperimentAgent(
  provider: ModelProvider,
  input: { weeklySlateSummary: string; priorExperiments: PriorExperimentSummary[]; brandContext: string },
): Promise<ExperimentAgentResult> {
  const { systemPrompt, modelClass } = buildSystemPrompt("EXPERIMENT_AGENT");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input),
    schema: ExperimentAgentResultSchema,
    promptId: "EXPERIMENT_AGENT",
  });

  return result.output;
}
