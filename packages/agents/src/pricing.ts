import type { LlmModelClass } from "./model-provider";

/**
 * Snapshot of Anthropic's published per-model-class pricing (verified live against
 * claude.com/pricing — see /docs/DECISIONS.md's cost-calculation entry, dated 2026-09-07).
 * Deliberately NOT auto-fetched at runtime: a real invoice must reflect the price that was
 * actually in effect when the call happened, not whatever the page says today. When Anthropic
 * changes pricing, bump this table and log the change in /docs/DECISIONS.md — existing
 * ModelCallLog rows keep the costUsd they were written with (see that table's schema comment:
 * "a point-in-time calculation, not a live join").
 *
 * Units: USD per 1,000,000 tokens, standard (non-cached, non-fast-mode) inference.
 */
export const PRICE_PER_MTOK: Record<LlmModelClass, { input: number; output: number }> = {
  HIGH: { input: 5.0, output: 25.0 }, // claude-opus-5
  MEDIUM: { input: 2.0, output: 10.0 }, // claude-sonnet-5
  LOW: { input: 1.0, output: 5.0 }, // claude-haiku-4-5
};

/**
 * Returns undefined (never 0) when either token count is missing — an unknown cost must never
 * be silently recorded as free. Matches CLAUDE.md's "never fabricate" spirit applied to spend
 * instead of factual claims: a call whose usage the provider didn't report is a call whose
 * cost is genuinely unknown, not a $0.00 call.
 */
export function computeCostUsd(
  modelClass: LlmModelClass,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | undefined {
  if (inputTokens == null || outputTokens == null) return undefined;
  const price = PRICE_PER_MTOK[modelClass];
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}
