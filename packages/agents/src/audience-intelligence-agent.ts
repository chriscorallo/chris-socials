import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { AudienceIntelligenceResultSchema, type AudienceIntelligenceResult } from "./schemas";

export interface CommentForAnalysis {
  platform: "INSTAGRAM" | "TIKTOK" | "YOUTUBE";
  authorHandle: string | null;
  text: string;
}

function buildUserPrompt(input: { comments: CommentForAnalysis[]; brandContext: string }): string {
  const commentList = input.comments
    .map((c, i) => `${i + 1}. [${c.platform}${c.authorHandle ? ` — ${c.authorHandle}` : ""}] "${c.text}"`)
    .join("\n");

  return `${input.brandContext}

## Comment batch (${input.comments.length} real comments — a single one is an anecdote, not a signal)

${commentList}

## Task

Classify and extract signal per your instructions above. Only surface a pattern as an insight
once it recurs across multiple comments — state exactly how many instances support each one.`;
}

/** The prompt's own stated policy: "a single comment is an anecdote, not a signal — only
 * surface a pattern... once it recurs." Enforced here as defense-in-depth (same pattern as
 * Take Selector's id validation, Edit Planner's bounds check) rather than trusted purely on
 * the model following instructions. */
export class AudienceInsightNotRecurringError extends Error {
  constructor(description: string, supportingCommentCount: number) {
    super(
      `Audience Intelligence returned an insight ("${description}") backed by only ` +
        `${supportingCommentCount} comment(s) — a single comment is an anecdote, not a pattern.`,
    );
    this.name = "AudienceInsightNotRecurringError";
  }
}

export async function runAudienceIntelligenceAgent(
  provider: ModelProvider,
  input: { comments: CommentForAnalysis[]; brandContext: string },
): Promise<AudienceIntelligenceResult> {
  if (input.comments.length === 0) {
    throw new Error("runAudienceIntelligenceAgent requires at least one comment.");
  }

  const { systemPrompt, modelClass } = buildSystemPrompt("AUDIENCE_INTELLIGENCE");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input),
    schema: AudienceIntelligenceResultSchema,
    promptId: "AUDIENCE_INTELLIGENCE",
  });

  for (const insight of result.output.insights) {
    if (insight.supportingCommentCount < 2) {
      throw new AudienceInsightNotRecurringError(insight.description, insight.supportingCommentCount);
    }
  }

  return result.output;
}
