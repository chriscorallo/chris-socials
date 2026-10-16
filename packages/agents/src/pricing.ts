import type { ModelUsage } from "./model-provider";

/**
 * Snapshot of Anthropic's published per-MODEL pricing (claude-api reference, cached
 * 2026-10-06; re-verified 2026-10-16 — see docs/decisions-pending/ai.md). Keyed by concrete
 * model ID, not routing class, so a MODEL_HIGH/MODEL_MEDIUM/MODEL_LOW env override is still
 * costed at that model's real price. Deliberately NOT auto-fetched at runtime: a ModelCallLog
 * row's costUsd is a point-in-time calculation; when prices change, edit this table and log
 * the change.
 *
 * Units: USD per 1,000,000 tokens, standard (non-batch, non-fast-mode) inference.
 * cacheWrite is the 5-minute-TTL write price (1.25x input); cacheRead is the published read
 * price (not uniformly 0.1x — Opus 5.5 reads are $0.20 = 0.05x).
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Some models charge a higher rate once a single prompt exceeds a size threshold. */
  longContext?: { aboveInputTokens: number; input: number; output: number };
}

function price(input: number, output: number, cacheRead: number, extra: Partial<ModelPrice> = {}): ModelPrice {
  return { input, output, cacheWrite: input * 1.25, cacheRead, ...extra };
}

export const PRICE_PER_MTOK_BY_MODEL: Record<string, ModelPrice> = {
  "claude-fable-5-1": price(10, 50, 0.25),
  "claude-fable-5": price(10, 50, 1.0),
  "claude-opus-5-5": price(4, 20, 0.2),
  "claude-opus-5": price(5, 25, 0.5),
  "claude-opus-4-8": price(5, 25, 0.5),
  "claude-opus-4-7": price(5, 25, 0.5),
  "claude-sonnet-5-5": price(2, 10, 0.2),
  "claude-sonnet-5": price(2, 10, 0.2),
  "claude-sonnet-4-6": price(3, 15, 0.3),
  "claude-haiku-5-5": price(0.1, 0.5, 0.01, {
    longContext: { aboveInputTokens: 100_000, input: 0.5, output: 2.5 },
  }),
  "claude-haiku-4-5": price(1, 5, 0.1),
};

/** Applied (with a warning) to any model ID missing from the table above — deliberately the
 * most expensive known price, so an unknown model can only ever be over-counted against the
 * spend cap, never under-counted. */
export const CONSERVATIVE_FALLBACK_PRICE: ModelPrice = price(10, 50, 1.0);

/** Server-side web search: $10 per 1,000 searches. Web fetch has no per-use fee (its fetched
 * content is billed as ordinary input tokens). */
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;

const warnedUnknownModels = new Set<string>();

/** Strips a date suffix (claude-haiku-4-5-20251001 -> claude-haiku-4-5) so dated aliases
 * still resolve to their family's price. */
function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

export function getModelPrice(model: string): ModelPrice {
  const known = PRICE_PER_MTOK_BY_MODEL[normalizeModelId(model)];
  if (known) return known;
  if (!warnedUnknownModels.has(model)) {
    warnedUnknownModels.add(model);
    console.warn(
      `[pricing] No price on file for model "${model}" — costing it at the conservative fallback ` +
        `($${CONSERVATIVE_FALLBACK_PRICE.input}/$${CONSERVATIVE_FALLBACK_PRICE.output} per MTok). ` +
        `Add it to PRICE_PER_MTOK_BY_MODEL.`,
    );
  }
  return CONSERVATIVE_FALLBACK_PRICE;
}

/**
 * Returns undefined (never 0) when usage is missing — an unknown cost must never be silently
 * recorded as free. Matches CLAUDE.md's "never fabricate" spirit applied to spend.
 */
export function computeCostUsd(model: string, usage: ModelUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const p = getModelPrice(model);
  const totalInput = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  const long = p.longContext && totalInput > p.longContext.aboveInputTokens ? p.longContext : undefined;
  const inputRate = long?.input ?? p.input;
  const outputRate = long?.output ?? p.output;
  const scale = inputRate / p.input; // cache rates scale with the long-context tier too
  const tokensUsd =
    (usage.inputTokens * inputRate +
      usage.cacheCreationInputTokens * p.cacheWrite * scale +
      usage.cacheReadInputTokens * p.cacheRead * scale +
      usage.outputTokens * outputRate) /
    1_000_000;
  return tokensUsd + usage.webSearchRequests * WEB_SEARCH_USD_PER_REQUEST;
}

/** Convenience for providers that only report plain input/output token counts. */
export function usageFromTokens(inputTokens: number, outputTokens: number): ModelUsage {
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
  };
}
