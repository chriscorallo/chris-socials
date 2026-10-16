import type { PrismaClient } from "@chris/domain";
import { recordModelCall, getModelCallCostSummary, recordAudit } from "@chris/domain";
import type {
  ModelCallContext,
  ModelProvider,
  ModelUsage,
  StructuredCompletionRequest,
  StructuredCompletionResult,
} from "../model-provider";
import { BilledModelCallError } from "../model-provider";
import { computeCostUsd, WEB_SEARCH_USD_PER_REQUEST } from "../pricing";
import {
  DEFAULT_DAILY_SPEND_CAP_USD,
  SpendCapCheckFailedError,
  SpendCapExceededError,
  startOfUtcDay,
} from "../spend-cap";

export interface CostTrackingModelProviderOptions {
  /** Attaches every call in this provider instance's lifetime to one content item, when
   * known. Prefer `withContext({contentItemId})` on a shared instance for per-call scoping. */
  contentItemId?: string;
  /** Rolling-UTC-day USD ceiling across every real call this provider makes — see
   * /packages/agents/src/spend-cap.ts. Omit to use DEFAULT_DAILY_SPEND_CAP_USD; pass `null`
   * to explicitly disable the cap (e.g. a one-off script that wants no ceiling). */
  dailyCapUsd?: number | null;
}

/**
 * Decorates any ModelProvider with the cost & latency governor's logging AND enforcement
 * (/docs/ARCHITECTURE.md §16). This is the one seam every real agent call passes through —
 * apps/web/lib/model-provider.ts wraps AnthropicModelProvider with this before anything ever
 * calls completeStructured. MockModelProvider is never wrapped in production code.
 *
 * Spend cap: checked BEFORE the delegate is called. If today's spend can't be read (DB error)
 * the call is refused — fail CLOSED (SpendCapCheckFailedError). A governor that can't see its
 * own state must not let spend through unmetered; a DB outage would break persistence of the
 * agent's result anyway, so refusing costs nothing real.
 *
 * Logging: a failed call that still consumed tokens (parse failure, max_tokens truncation,
 * refusal — any BilledModelCallError) is logged WITH its tokens and cost, so it counts toward
 * the cap. Log-write failures never mask the delegate's own result or error.
 */
export class CostTrackingModelProvider implements ModelProvider {
  private readonly contentItemId: string | undefined;
  private readonly dailyCapUsd: number | null;

  constructor(
    private readonly delegate: ModelProvider,
    private readonly prisma: PrismaClient,
    options: CostTrackingModelProviderOptions = {},
  ) {
    this.contentItemId = options.contentItemId;
    this.dailyCapUsd = options.dailyCapUsd === undefined ? DEFAULT_DAILY_SPEND_CAP_USD : options.dailyCapUsd;
  }

  withContext(context: ModelCallContext): ModelProvider {
    return new CostTrackingModelProvider(this.delegate, this.prisma, {
      contentItemId: context.contentItemId ?? this.contentItemId,
      dailyCapUsd: this.dailyCapUsd,
    });
  }

  async completeStructured<T>(
    request: StructuredCompletionRequest<T>,
  ): Promise<StructuredCompletionResult<T>> {
    if (this.dailyCapUsd !== null) {
      let spentTodayUsd: number;
      try {
        spentTodayUsd = await this.getSpentTodayUsd();
      } catch (err) {
        await this.logBlocked(request, "MODEL_SPEND_CAP_CHECK_FAILED", { error: String(err) });
        throw new SpendCapCheckFailedError(request.promptId, err);
      }
      if (spentTodayUsd >= this.dailyCapUsd) {
        await this.logBlocked(request, "MODEL_SPEND_CAP_BLOCKED", { spentTodayUsd });
        throw new SpendCapExceededError(request.promptId, this.dailyCapUsd, spentTodayUsd);
      }
    }

    try {
      const result = await this.delegate.completeStructured(request);
      await this.log(request, {
        model: result.model,
        usage: result.usage ?? legacyUsage(result),
        latencyMs: result.latencyMs,
        success: true,
      });
      return result;
    } catch (err) {
      const billed = err instanceof BilledModelCallError ? err : undefined;
      await this.log(request, {
        model: billed?.model ?? `unresolved:${request.modelClass}`,
        usage: billed?.usage,
        latencyMs: billed?.latencyMs ?? 0,
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Sequential read of everything logged since UTC midnight. Throws on DB failure — the
   * caller decides (fail closed). */
  private async getSpentTodayUsd(): Promise<number> {
    const summary = await getModelCallCostSummary(this.prisma, { since: startOfUtcDay(new Date()) });
    return summary.totalCostUsd;
  }

  private async logBlocked(
    request: StructuredCompletionRequest<unknown>,
    action: "MODEL_SPEND_CAP_BLOCKED" | "MODEL_SPEND_CAP_CHECK_FAILED",
    extra: Record<string, unknown>,
  ): Promise<void> {
    try {
      await recordAudit(this.prisma, {
        actor: "system",
        actorType: "SYSTEM",
        action,
        entityType: "ModelCallLog",
        entityId: request.promptId,
        metadata: {
          modelClass: request.modelClass,
          capUsd: this.dailyCapUsd,
          contentItemId: this.contentItemId ?? null,
          ...extra,
        },
      });
    } catch {
      // Best-effort — the refusal itself is what matters.
    }
  }

  private async log(
    request: StructuredCompletionRequest<unknown>,
    outcome: {
      model: string;
      usage: ModelUsage | undefined;
      latencyMs: number;
      success: boolean;
      errorMessage?: string;
    },
  ): Promise<void> {
    try {
      const usage = outcome.usage;
      const costUsd = usage ? computeCostUsd(outcome.model, usage) : undefined;
      await recordModelCall(this.prisma, {
        promptId: request.promptId,
        modelClass: request.modelClass,
        model: outcome.model,
        // Total input processed (uncached + cache write + cache read); costUsd prices each
        // component at its own rate.
        inputTokens: usage
          ? usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
          : undefined,
        outputTokens: usage?.outputTokens,
        costUsd,
        latencyMs: outcome.latencyMs,
        success: outcome.success,
        errorMessage: outcome.errorMessage,
        contentItemId: this.contentItemId,
      });
      // ModelCallLog has no columns for the cache/retrieval breakdown; record it in the audit
      // trail only when retrieval was used (research/claims calls), so it isn't noise.
      if (usage && (usage.webSearchRequests > 0 || usage.webFetchRequests > 0)) {
        await recordAudit(this.prisma, {
          actor: "system",
          actorType: "SYSTEM",
          action: "MODEL_SERVER_TOOL_USAGE",
          entityType: "ModelCallLog",
          entityId: request.promptId,
          metadata: {
            model: outcome.model,
            contentItemId: this.contentItemId ?? null,
            webSearchRequests: usage.webSearchRequests,
            webFetchRequests: usage.webFetchRequests,
            webSearchCostUsd: usage.webSearchRequests * WEB_SEARCH_USD_PER_REQUEST,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            totalCostUsd: costUsd ?? null,
          },
        });
      }
    } catch {
      // Best-effort. A failed cost-log write must never mask the real outcome above.
    }
  }
}

/** Delegates that only report plain token counts (older/mock providers). */
function legacyUsage(result: StructuredCompletionResult<unknown>): ModelUsage | undefined {
  if (result.inputTokens == null || result.outputTokens == null) return undefined;
  return {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
  };
}
