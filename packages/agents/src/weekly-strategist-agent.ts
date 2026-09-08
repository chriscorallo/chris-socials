import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import {
  PortfolioAllocationResultSchema,
  type PortfolioAllocationResult,
  type WeeklyProgrammingThesisOutput,
} from "./schemas";
import { formatBacklog, type BacklogItemSummary } from "./backlog-summary";

export class PortfolioAllocationInvalidIdsError extends Error {
  constructor(invalidIds: string[]) {
    super(
      `Weekly Strategist returned contentItemId(s) not present in the provided backlog: ${invalidIds.join(", ")}`,
    );
    this.name = "PortfolioAllocationInvalidIdsError";
  }
}

function buildUserPrompt(
  thesis: WeeklyProgrammingThesisOutput,
  backlog: BacklogItemSummary[],
  editingBudgetMinutesPerWeek: number,
  brandContext: string,
): string {
  return `${brandContext}

## This Week's Programming Thesis

${thesis.thesis}

Primary objectives: ${thesis.primaryObjectives.join("; ") || "(none stated)"}
Areas to exploit: ${thesis.areasToExploit.join("; ") || "(none stated)"}
Areas to explore: ${thesis.areasToExplore.join("; ") || "(none stated)"}
Areas to reduce: ${thesis.areasToReduce.join("; ") || "(none stated)"}

## Candidate Ideas (reference each by its exact id in brackets)

${formatBacklog(backlog)}

## Production Constraint

Human editing budget: approximately ${editingBudgetMinutesPerWeek} minutes/week total (spec
default is ~5 hours/week unless Chris has explicitly changed it) — do not select more than
the week can realistically produce.

## Task

Evaluate this candidate set as ONE coherent weekly portfolio per your instructions above. For
every candidate you consider selecting, return a full per-item allocation with
\`contentItemId\` set to the exact id shown above — never invent an id that isn't listed. Do
not force variety merely for its own sake if evidence supports concentration.`;
}

export async function runWeeklyStrategistAgent(
  provider: ModelProvider,
  input: {
    thesis: WeeklyProgrammingThesisOutput;
    backlog: BacklogItemSummary[];
    editingBudgetMinutesPerWeek: number;
    brandContext: string;
  },
): Promise<PortfolioAllocationResult> {
  const { systemPrompt, modelClass } = buildSystemPrompt("WEEKLY_STRATEGIST");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(
      input.thesis,
      input.backlog,
      input.editingBudgetMinutesPerWeek,
      input.brandContext,
    ),
    schema: PortfolioAllocationResultSchema,
    promptId: "WEEKLY_STRATEGIST",
  });

  const validIds = new Set(input.backlog.map((i) => i.id));
  const invalidIds = result.output.items
    .map((i) => i.contentItemId)
    .filter((id) => !validIds.has(id));
  if (invalidIds.length > 0) {
    throw new PortfolioAllocationInvalidIdsError(invalidIds);
  }

  return result.output;
}
