import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { WeeklyReviewResultSchema, type WeeklyReviewResult } from "./schemas";

function buildUserPrompt(input: {
  weekSummary: string;
  audienceSignalsSummary: string;
  experimentsSummary: string;
  productionCostSummary: string;
  overridesSummary: string;
  brandContext: string;
}): string {
  return `${input.brandContext}

## Prior performance (Analytics Agent evaluations, not raw metrics)

${input.weekSummary}

## Audience intelligence signals

${input.audienceSignalsSummary}

## Experiment results

${input.experimentsSummary}

## Production cost / ROI

${input.productionCostSummary}

## Human overrides this week (Decision Journal)

${input.overridesSummary}

## Task

Produce the executive brief per your instructions above. A quiet week with no strong signal is
a valid, honest output — say so rather than manufacturing a takeaway. Package any
genuinely evidence-backed pattern as a candidate belief (per the Learning Agent's format) —
you do not promote these yourself, only propose them.`;
}

export async function runWeeklyReviewAgent(
  provider: ModelProvider,
  input: {
    weekSummary: string;
    audienceSignalsSummary: string;
    experimentsSummary: string;
    productionCostSummary: string;
    overridesSummary: string;
    brandContext: string;
  },
): Promise<WeeklyReviewResult> {
  const { systemPrompt, modelClass } = buildSystemPrompt("WEEKLY_REVIEW_LEARNING_COUNCIL");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input),
    schema: WeeklyReviewResultSchema,
    promptId: "WEEKLY_REVIEW_LEARNING_COUNCIL",
  });

  return result.output;
}
