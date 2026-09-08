import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { ReferenceIntelligenceResultSchema, type ReferenceIntelligenceResult } from "./schemas";

export interface ReferenceContentInput {
  creatorName: string;
  description: string;
  platform?: string | null;
  topic?: string | null;
  hook?: string | null;
}

function buildUserPrompt(content: ReferenceContentInput, brandContext: string): string {
  return `${brandContext}

## Reference Content Under Review

Creator: ${content.creatorName}
Platform: ${content.platform ?? "unspecified"}
Topic: ${content.topic ?? "unspecified"}
Hook: ${content.hook ?? "unspecified"}

Description / transcript / notes:
${content.description}

## Task

Analyze this reference content per your instructions above. Return one or more
ReferenceObservations. Do not say "this performs because..." unless evidence supports
causation — prefer "this pattern is present and may be worth testing." Never propose
imitating this creator's identity — only transferable principles.`;
}

export async function runReferenceIntelligenceAgent(
  provider: ModelProvider,
  input: { content: ReferenceContentInput; brandContext: string },
): Promise<ReferenceIntelligenceResult> {
  const { systemPrompt, modelClass } = buildSystemPrompt("REFERENCE_INTELLIGENCE");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input.content, input.brandContext),
    schema: ReferenceIntelligenceResultSchema,
    promptId: "REFERENCE_INTELLIGENCE",
  });
  return result.output;
}
