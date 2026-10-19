import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { PerformanceEvaluationSchema, type PerformanceEvaluation } from "./schemas";

export interface SnapshotSummary {
  platform: "INSTAGRAM" | "TIKTOK" | "YOUTUBE";
  offset: string;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  saveCount: number | null;
  reach: number | null;
  avgWatchTimeSeconds: number | null;
  followsGained?: number | null;
  profileVisits?: number | null;
}

/** New followers per 1,000 views (the brand's conversion metric) — null unless both are known. */
export function followersPerThousandViews(s: Pick<SnapshotSummary, "viewCount" | "followsGained">): number | null {
  if (s.followsGained == null || s.viewCount == null || s.viewCount <= 0) return null;
  return Math.round((s.followsGained / s.viewCount) * 1000 * 100) / 100;
}

export interface ProductionCostContext {
  estimatedFilmingMinutes: number | null;
  humanEditingBudgetMinutes: number | null;
}

function formatMetric(value: number | null): string {
  // "not available" is a materially different fact than "zero" — spec: never fabricate an
  // unavailable metric, and that distinction must survive into what the model actually reads.
  return value === null ? "not available from this platform" : String(value);
}

function buildUserPrompt(input: {
  title: string;
  snapshots: SnapshotSummary[];
  productionCost: ProductionCostContext;
  brandContext: string;
  creativeBrief?: string | null;
}): string {
  const snapshotTable = input.snapshots
    .map(
      (s) =>
        `- ${s.platform} @ ${s.offset}: views=${formatMetric(s.viewCount)}, likes=${formatMetric(s.likeCount)}, ` +
        `comments=${formatMetric(s.commentCount)}, shares=${formatMetric(s.shareCount)}, saves=${formatMetric(s.saveCount)}, ` +
        `reach=${formatMetric(s.reach)}, avgWatchTimeSeconds=${formatMetric(s.avgWatchTimeSeconds)}, ` +
        `followsGained=${formatMetric(s.followsGained ?? null)}, profileVisits=${formatMetric(s.profileVisits ?? null)}, ` +
        `followersPer1000Views=${formatMetric(followersPerThousandViews(s))}`,
    )
    .join("\n");

  const costLine = `Estimated filming minutes: ${formatMetric(input.productionCost.estimatedFilmingMinutes)}; ` +
    `human editing budget minutes: ${formatMetric(input.productionCost.humanEditingBudgetMinutes)}.`;

  return `${input.brandContext}

## "${input.title}" — real performance snapshots (every absent field truly was not returned by that platform — do not treat it as zero)

${snapshotTable || "(no snapshots captured yet)"}

## Production cost context (for PRODUCTION_ROI)

${costLine}${input.creativeBrief ? `\n\n## What this video was made to do (its Creative Brief)\n\n${input.creativeBrief}\n\nJudge IDENTITY CONVERSION against the brief's ending objective and its "what to test" hypothesis: did the result support it, contradict it, or say nothing (data missing)? One video is directional, never proof.` : ""}

## Task

Evaluate this video's performance per your instructions above, across all eight categories.`;
}

export async function runAnalyticsAgent(
  provider: ModelProvider,
  input: {
    title: string;
    snapshots: SnapshotSummary[];
    productionCost: ProductionCostContext;
    brandContext: string;
    creativeBrief?: string | null;
  },
): Promise<PerformanceEvaluation> {
  if (input.snapshots.length === 0) {
    throw new Error("runAnalyticsAgent requires at least one captured snapshot.");
  }

  const { systemPrompt, modelClass } = buildSystemPrompt("ANALYTICS_AGENT");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input),
    schema: PerformanceEvaluationSchema,
    promptId: "ANALYTICS_AGENT",
  });

  return result.output;
}
