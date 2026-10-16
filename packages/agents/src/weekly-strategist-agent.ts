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

/** Spec §9 step 3: "build ~30 videos as one coherent portfolio." */
export const DEFAULT_TARGET_PORTFOLIO_SIZE = 30;

interface WeeklyStrategistInput {
  thesis: WeeklyProgrammingThesisOutput;
  backlog: BacklogItemSummary[];
  editingBudgetMinutesPerWeek: number;
  brandContext: string;
  /** packages/domain buildStrategicContext(prisma) — optional for backward compatibility. */
  strategicContext?: string;
  /** Target number of videos for the week (default 30). */
  targetPortfolioSize?: number;
}

function buildUserPrompt(input: WeeklyStrategistInput): string {
  const { thesis, backlog } = input;
  const target = input.targetPortfolioSize ?? DEFAULT_TARGET_PORTFOLIO_SIZE;
  return `## This Week's Programming Thesis

${thesis.thesis}

Primary objectives: ${thesis.primaryObjectives.join("; ") || "(none stated)"}
Active experiments: ${thesis.activeExperiments.join("; ") || "(none stated)"}
Areas to exploit: ${thesis.areasToExploit.join("; ") || "(none stated)"}
Areas to explore: ${thesis.areasToExplore.join("; ") || "(none stated)"}
Areas to reduce: ${thesis.areasToReduce.join("; ") || "(none stated)"}

## Candidate Ideas (reference each by its exact id in brackets)

${formatBacklog(backlog)}

${input.strategicContext ? `${input.strategicContext}\n\n` : ""}## Production Constraint

Human editing budget: approximately ${input.editingBudgetMinutesPerWeek} minutes/week total (spec
default is ~5 hours/week unless Chris has explicitly changed it) — do not select more than
the week can realistically produce.

## Portfolio target

Aim for a coherent portfolio of about ${target} videos (fewer if the editing budget can't
support it). The backlog has ${backlog.length} candidate(s). If the selected existing ideas
fall short of the target or leave a real gap (pillar, funnel role, format, experiment), propose
new ideas in proposedNewIdeas to close it — they are proposals for Chris to approve, never
auto-created. Propose nothing when the backlog already covers the week well.

## Task

Evaluate this candidate set as ONE coherent weekly portfolio per your instructions above. For
every candidate you consider selecting, return a full per-item allocation with
\`contentItemId\` set to the exact id shown above — never invent an id that isn't listed. Do
not force variety merely for its own sake if evidence supports concentration.`;
}

export async function runWeeklyStrategistAgent(
  provider: ModelProvider,
  input: WeeklyStrategistInput,
): Promise<PortfolioAllocationResult> {
  const { systemPrompt, modelClass } = buildSystemPrompt("WEEKLY_STRATEGIST");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    stableContext: input.brandContext || undefined,
    userPrompt: buildUserPrompt(input),
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
