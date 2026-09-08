import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { AdversarialCritiqueOutputSchema, type AdversarialCritiqueOutput } from "./schemas";

function buildUserPrompt(input: { artifactType: string; artifactSummary: string; brandContext: string }): string {
  return `${input.brandContext}

## Artifact under review: ${input.artifactType}

${input.artifactSummary}

## Task

Actively look for meaningful weaknesses per your instructions above. A genuinely solid
artifact gets a short, honest "no material weaknesses found" — do not manufacture criticism
where none is warranted, and do not pile on stylistic nitpicks.`;
}

/** Independent second opinion — advisory only (ADVERSARIAL_EVALUATOR.md: "you report risks;
 * the Creative Director and hard gates decide what happens next"). This function never blocks
 * anything; it only ever returns a critique for a human/Creative Director to weigh. */
export async function runAdversarialEvaluatorAgent(
  provider: ModelProvider,
  input: { artifactType: string; artifactSummary: string; brandContext: string },
): Promise<AdversarialCritiqueOutput> {
  const { systemPrompt, modelClass } = buildSystemPrompt("ADVERSARIAL_EVALUATOR");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input),
    schema: AdversarialCritiqueOutputSchema,
    promptId: "ADVERSARIAL_EVALUATOR",
  });

  return result.output;
}
