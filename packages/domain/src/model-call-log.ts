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

/** An Anthropic error that means "out of credit" rather than a transient failure. */
export const ANTHROPIC_CREDIT_ERROR_RE = /credit balance|billing|insufficient[_ ]?(funds|credit|quota)|payment required|quota/i;

export interface AiSpendOverview {
  /** Since 00:00 UTC — the same window the daily spend cap uses. */
  todayUsd: number;
  last30Usd: number;
  last30Calls: number;
  /** Distinct videos that had at least one AI call in the last 30 days. */
  last30Videos: number;
  /** last30Usd spent on video work ÷ last30Videos; null with no videos yet. */
  perVideoUsd: number | null;
  /** Latest out-of-credit failure in the last 3 days with no successful call since. */
  creditError: { at: Date; message: string } | null;
  lastSuccessAt: Date | null;
}

/** What the AI has cost — for the "AI credit" screen. Sequential reads (PGlite). */
export async function getAiSpendOverview(prisma: PrismaClient, now: Date): Promise<AiSpendOverview> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const calls = await prisma.modelCallLog.findMany({
    where: { createdAt: { gte: since30 } },
    select: { costUsd: true, contentItemId: true, createdAt: true },
  });
  let todayUsd = 0;
  let last30Usd = 0;
  let videoUsd = 0;
  const videos = new Set<string>();
  for (const c of calls) {
    const cost = c.costUsd ?? 0;
    last30Usd += cost;
    if (c.createdAt >= dayStart) todayUsd += cost;
    if (c.contentItemId) {
      videos.add(c.contentItemId);
      videoUsd += cost;
    }
  }
  const lastSuccess = await prisma.modelCallLog.findFirst({
    where: { success: true },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const recentFail = await prisma.modelCallLog.findFirst({
    where: { success: false, createdAt: { gte: new Date(now.getTime() - 3 * 86_400_000) } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, errorMessage: true },
  });
  let creditError: AiSpendOverview["creditError"] = null;
  if (
    recentFail?.errorMessage &&
    ANTHROPIC_CREDIT_ERROR_RE.test(recentFail.errorMessage) &&
    !(lastSuccess && lastSuccess.createdAt > recentFail.createdAt)
  ) {
    creditError = { at: recentFail.createdAt, message: recentFail.errorMessage };
  }
  return {
    todayUsd,
    last30Usd,
    last30Calls: calls.length,
    last30Videos: videos.size,
    perVideoUsd: videos.size ? videoUsd / videos.size : null,
    creditError,
    lastSuccessAt: lastSuccess?.createdAt ?? null,
  };
}
