import type { PrismaClient } from "@chris/domain";
import { listTasteFeedback, recordChrisAcceptanceProbability, recordAudit } from "@chris/domain";
import type { ModelProvider } from "./model-provider";
import { getBrandContextText } from "./brand-context";
import { runTasteLearnerAgent, toAcceptanceProbabilityInputs } from "./taste-learner-agent";

/** Below this many instances for an artifact type, a model call can't responsibly learn
 * anything (TASTE_LEARNER.md: "a single rejection is one data point") — skipped, not called. */
export const MIN_FEEDBACK_FOR_TASTE_REFRESH = 2;

/**
 * Closes the taste loop: reads Chris's raw TasteFeedback per artifact type, runs the Taste
 * Learner once per type that has enough evidence, and appends the resulting
 * ChrisAcceptanceProbability rows (append-only — newer reads supersede by recency). One model
 * call per qualifying artifact type; types are processed sequentially and one failing type
 * doesn't stop the others (fail safely).
 */
export async function refreshTasteModel(
  prisma: PrismaClient,
  provider: ModelProvider,
  opts: { maxFeedbackPerType?: number; actorId?: string } = {},
) {
  const maxPerType = opts.maxFeedbackPerType ?? 50;
  const groups = await prisma.tasteFeedback.groupBy({ by: ["artifactType"], _count: { _all: true } });
  const brandContext = await getBrandContextText(prisma);

  const results: { artifactType: string; status: "UPDATED" | "SKIPPED" | "FAILED"; recorded: number; error?: string }[] = [];
  for (const g of groups) {
    if (g._count._all < MIN_FEEDBACK_FOR_TASTE_REFRESH) {
      results.push({ artifactType: g.artifactType, status: "SKIPPED", recorded: 0 });
      continue;
    }
    try {
      const feedback = await listTasteFeedback(prisma, { artifactType: g.artifactType, limit: maxPerType });
      const learned = await runTasteLearnerAgent(provider, {
        artifactType: g.artifactType,
        feedback: feedback.map((f) => ({
          artifactType: f.artifactType,
          rawFeedback: f.rawFeedback,
          normalizedTag: f.normalizedTag,
          productionTier: f.productionTier,
        })),
        brandContext,
      });
      const inputs = toAcceptanceProbabilityInputs(g.artifactType, learned);
      for (const input of inputs) await recordChrisAcceptanceProbability(prisma, input);
      results.push({ artifactType: g.artifactType, status: "UPDATED", recorded: inputs.length });
    } catch (err) {
      results.push({ artifactType: g.artifactType, status: "FAILED", recorded: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await recordAudit(prisma, {
    actor: opts.actorId ?? "system",
    actorType: opts.actorId ? "HUMAN" : "SYSTEM",
    action: "TASTE_MODEL_REFRESHED",
    entityType: "ChrisAcceptanceProbability",
    entityId: "taste-model",
    metadata: { results },
  });
  return results;
}
