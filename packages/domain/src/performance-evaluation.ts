import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";

/**
 * Persists the Analytics Agent's per-video judgment (spec §9 step 25) — same rationale as
 * every other specialist output in this system: a judgment worth showing Chris is worth
 * keeping, not silently recomputed and thrown away on every page load. Append-only: a re-run
 * after more snapshots come in is a new row (episodic memory), not an overwrite.
 */
const CategoryEvaluationSchema = z.object({
  category: z.enum([
    "ATTENTION",
    "CONSUMPTION",
    "AMPLIFICATION",
    "CONVERSATION",
    "IDENTITY_CONVERSION",
    "RELATIONSHIP",
    "BUSINESS_VALUE",
    "PRODUCTION_ROI",
  ]),
  assessment: z.string(),
  confidence: z.number().min(0).max(1),
  dataCompleteness: z.enum(["COMPLETE", "PARTIAL", "MISSING"]),
});

const RecordPerformanceEvaluationSchema = z.object({
  contentItemId: z.string().min(1),
  overallSummary: z.string().min(1),
  strategicallyValuableDespiteLowerViews: z.boolean(),
  categories: z.array(CategoryEvaluationSchema).min(1),
});
export type RecordPerformanceEvaluationInput = z.input<typeof RecordPerformanceEvaluationSchema>;

export async function recordPerformanceEvaluation(
  prisma: PrismaClient,
  input: RecordPerformanceEvaluationInput,
  actor: { actorId: string },
) {
  const parsed = RecordPerformanceEvaluationSchema.parse(input);

  const evaluation = await prisma.performanceEvaluation.create({
    data: {
      contentItemId: parsed.contentItemId,
      overallSummary: parsed.overallSummary,
      strategicallyValuableDespiteLowerViews: parsed.strategicallyValuableDespiteLowerViews,
      categories: parsed.categories,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "SYSTEM",
    action: "PERFORMANCE_EVALUATION_RECORDED",
    entityType: "ContentItem",
    entityId: parsed.contentItemId,
    after: { evaluationId: evaluation.id },
  });

  return evaluation;
}

export async function getLatestPerformanceEvaluation(prisma: PrismaClient, contentItemId: string) {
  return prisma.performanceEvaluation.findFirst({
    where: { contentItemId },
    orderBy: { createdAt: "desc" },
  });
}
