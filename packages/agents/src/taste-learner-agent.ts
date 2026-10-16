import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { TasteLearnerResultSchema, compactTasteContext, type TasteLearnerResult } from "./schemas";

export interface TasteFeedbackSummary {
  artifactType: string;
  rawFeedback: string;
  normalizedTag: string;
  productionTier: string | null;
}

function buildUserPrompt(input: { artifactType: string; feedback: TasteFeedbackSummary[]; brandContext: string }): string {
  const feedbackList = input.feedback
    .map((f) => `- [${f.normalizedTag}${f.productionTier ? `, tier=${f.productionTier}` : ""}] "${f.rawFeedback}"`)
    .join("\n");

  return `${input.brandContext}

## Chris's real feedback on ${input.artifactType} artifacts (${input.feedback.length} instances)

${feedbackList}

## Task

Learn from this per your instructions above. Do not convert one preference into a universal
rule — only report a probability for a tag once you have enough accumulated evidence across
contexts, and say explicitly whether you think it's context-specific or generalizing.`;
}

export async function runTasteLearnerAgent(
  provider: ModelProvider,
  input: { artifactType: string; feedback: TasteFeedbackSummary[]; brandContext: string },
): Promise<TasteLearnerResult> {
  if (input.feedback.length === 0) {
    throw new Error("runTasteLearnerAgent requires at least one TasteFeedback instance.");
  }

  const { systemPrompt, modelClass } = buildSystemPrompt("TASTE_LEARNER");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input),
    schema: TasteLearnerResultSchema,
    promptId: "TASTE_LEARNER",
  });

  return result.output;
}

/** Shape ready for packages/domain recordChrisAcceptanceProbability (context compacted to
 * just the dimensions the probability is scoped to). */
export function toAcceptanceProbabilityInputs(artifactType: string, result: TasteLearnerResult) {
  return result.probabilities.map((p) => ({
    artifactType,
    tag: p.tag,
    context: compactTasteContext(p.context),
    probability: p.probability,
    sampleSize: p.sampleSize,
    generalizes: p.generalizes,
    confidence: p.confidence,
  }));
}
