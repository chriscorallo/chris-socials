import type { PrismaClient, LlmModelClass } from "@prisma/client";

/**
 * The cost & latency governor's raw data (/docs/ARCHITECTURE.md §16). One row per model call,
 * written by packages/agents' CostTrackingModelProvider — see that file for why this lives
 * behind a provider decorator instead of being called from every agent individually.
 *
 * Never throws on its own account: a logging failure must never take down the real agent call
 * it's trying to observe (CLAUDE.md's "fail safely"). The caller (CostTrackingModelProvider)
 * wraps this in its own try/catch too, but this function stays defensive independently so any
 * future caller inherits the same guarantee without having to remember it.
 */
export async function recordModelCall(
  prisma: PrismaClient,
  input: {
    promptId: string;
    modelClass: LlmModelClass;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    latencyMs: number;
    success: boolean;
    errorMessage?: string;
    contentItemId?: string;
  },
): Promise<void> {
  await prisma.modelCallLog.create({
    data: {
      promptId: input.promptId,
      modelClass: input.modelClass,
      model: input.model,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      costUsd: input.costUsd ?? null,
      latencyMs: input.latencyMs,
      success: input.success,
      errorMessage: input.errorMessage ?? null,
      contentItemId: input.contentItemId ?? null,
    },
  });
}

export interface ModelCallCostSummary {
  totalCalls: number;
  failedCalls: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Calls whose cost couldn't be computed (provider returned no usage) — the total above
   * excludes them, so this count is how much the total is likely an undercount. */
  callsMissingCost: number;
  byModelClass: Record<LlmModelClass, { calls: number; costUsd: number }>;
}

const EMPTY_CLASS_BUCKET = { calls: 0, costUsd: 0 };

/**
 * Real spend, replacing the estimate in /docs/DECISIONS.md's cost-calculation entry once
 * calls actually happen. `since` narrows to a window (e.g. "this week") — omit for
 * all-time. Sequential reads only (see /docs/DECISIONS.md — PGlite can't handle concurrent
 * queries), so this is a few small round trips, not a single aggregate query.
 */
export async function getModelCallCostSummary(
  prisma: PrismaClient,
  opts: { since?: Date } = {},
): Promise<ModelCallCostSummary> {
  const where = opts.since ? { createdAt: { gte: opts.since } } : {};

  const calls = await prisma.modelCallLog.findMany({
    where,
    select: {
      modelClass: true,
      costUsd: true,
      inputTokens: true,
      outputTokens: true,
      success: true,
    },
  });

  const byModelClass: Record<LlmModelClass, { calls: number; costUsd: number }> = {
    HIGH: { ...EMPTY_CLASS_BUCKET },
    MEDIUM: { ...EMPTY_CLASS_BUCKET },
    LOW: { ...EMPTY_CLASS_BUCKET },
  };

  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let failedCalls = 0;
  let callsMissingCost = 0;

  for (const call of calls) {
    if (!call.success) failedCalls += 1;
    if (call.costUsd == null) {
      callsMissingCost += 1;
    } else {
      totalCostUsd += call.costUsd;
      byModelClass[call.modelClass].costUsd += call.costUsd;
    }
    byModelClass[call.modelClass].calls += 1;
    totalInputTokens += call.inputTokens ?? 0;
    totalOutputTokens += call.outputTokens ?? 0;
  }

  return {
    totalCalls: calls.length,
    failedCalls,
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    callsMissingCost,
    byModelClass,
  };
}

export async function listRecentModelCalls(prisma: PrismaClient, limit = 20) {
  return prisma.modelCallLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
