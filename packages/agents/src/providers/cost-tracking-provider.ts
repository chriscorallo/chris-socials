import type { PrismaClient } from "@chris/domain";
import { recordModelCall, getModelCallCostSummary, recordAudit } from "@chris/domain";
import type {
  ModelProvider,
  StructuredCompletionRequest,
  StructuredCompletionResult,
} from "../model-provider";
import { computeCostUsd } from "../pricing";
import { DEFAULT_DAILY_SPEND_CAP_USD, SpendCapExceededError, startOfUtcDay } from "../spend-cap";

export interface CostTrackingModelProviderOptions {
  /** Attaches every call in this provider instance's lifetime to one content item, when
   * known — optional because plenty of real calls (weekly slate, learning council) aren't
   * scoped to a single item. */
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
 * calls completeStructured, so no individual agent file needs to know either concern exists.
 * MockModelProvider is never wrapped (tests stay free and don't need a database), which is
 * also why "everything is logged/capped" is actually true for real calls specifically, not
 * test calls.
 *
 * Logging failures never surface to the caller: the delegate's result (or thrown error) is
 * always what the agent sees, unmodified, UNLESS the spend cap itself is what stops the call —
 * that's a deliberate throw, before the delegate is ever invoked, not an observability
 * accident. See CLAUDE.md's "fail safely": an observability gap must never become a pipeline
 * failure, but a spend cap is supposed to stop the pipeline — that's its entire job.
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

  async completeStructured<T>(
    request: StructuredCompletionRequest<T>,
  ): Promise<StructuredCompletionResult<T>> {
    if (this.dailyCapUsd !== null) {
      // undefined here means "couldn't determine today's spend" (e.g. the DB read itself
      // failed) — deliberately fails OPEN, not closed. A brief window with no cap enforcement
      // during a DB hiccup is a better outcome for a single-operator tool than every real
      // agent call breaking outright because the governor couldn't read its own state; see
      // spend-cap.ts's "ceiling against runaway spend, not a perfectly precise billing gate."
      const spentTodayUsd = await this.getSpentTodayUsdSafe();
      if (spentTodayUsd !== undefined && spentTodayUsd >= this.dailyCapUsd) {
        // Best-effort, but this one matters enough to be worth trying even though the request
        // itself is about to be refused — it's how "the cap tripped N times today" becomes
        // visible later rather than silently invisible refusals.
        await this.logBlocked(request, spentTodayUsd);
        throw new SpendCapExceededError(request.promptId, this.dailyCapUsd, spentTodayUsd);
      }
    }

    try {
      const result = await this.delegate.completeStructured(request);
      // Awaited, not fire-and-forget: this is a single small insert, not a hot loop, and
      // awaiting it means a caller who awaits completeStructured can rely on the log row
      // already existing (useful for tests, and safe in a serverless function that might
      // otherwise be frozen/torn down before a detached write flushes).
      await this.log(request, {
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs,
        success: true,
      });
      return result;
    } catch (err) {
      // We don't know the concrete model id or latency on a hard failure before the request
      // even resolves in some error paths, so fall back to what the request itself told us
      // rather than guessing at a resolved model id (that resolution logic lives in the
      // delegate, not here).
      await this.log(request, {
        model: `unresolved:${request.modelClass}`,
        inputTokens: undefined,
        outputTokens: undefined,
        latencyMs: 0,
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Sequential read (see /docs/DECISIONS.md's PGlite entries) of everything logged since UTC
   * midnight — cheap at real-world volume (tens of rows/day, not thousands). Returns
   * undefined (never throws) on any read failure — see the fail-open comment above. */
  private async getSpentTodayUsd(): Promise<number> {
    const summary = await getModelCallCostSummary(this.prisma, { since: startOfUtcDay(new Date()) });
    return summary.totalCostUsd;
  }

  private async getSpentTodayUsdSafe(): Promise<number | undefined> {
    try {
      return await this.getSpentTodayUsd();
    } catch {
      return undefined;
    }
  }

  private async logBlocked(request: StructuredCompletionRequest<unknown>, spentTodayUsd: number): Promise<void> {
    try {
      await recordAudit(this.prisma, {
        actor: "system",
        actorType: "SYSTEM",
        action: "MODEL_SPEND_CAP_BLOCKED",
        entityType: "ModelCallLog",
        entityId: request.promptId,
        metadata: {
          modelClass: request.modelClass,
          capUsd: this.dailyCapUsd,
          spentTodayUsd,
          contentItemId: this.contentItemId ?? null,
        },
      });
    } catch {
      // Best-effort — see the class doc comment.
    }
  }

  private async log(
    request: StructuredCompletionRequest<unknown>,
    outcome: {
      model: string;
      inputTokens: number | undefined;
      outputTokens: number | undefined;
      latencyMs: number;
      success: boolean;
      errorMessage?: string;
    },
  ): Promise<void> {
    try {
      const costUsd = computeCostUsd(request.modelClass, outcome.inputTokens, outcome.outputTokens);
      await recordModelCall(this.prisma, {
        promptId: request.promptId,
        modelClass: request.modelClass,
        model: outcome.model,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        costUsd,
        latencyMs: outcome.latencyMs,
        success: outcome.success,
        errorMessage: outcome.errorMessage,
        contentItemId: this.contentItemId,
      });
    } catch {
      // Best-effort. A failed cost-log write must never mask (or throw over) the real
      // completeStructured outcome above.
    }
  }
}
