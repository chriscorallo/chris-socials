/**
 * The enforcement half of /docs/ARCHITECTURE.md §16's "cost & latency governor" — the half
 * `ModelCallLog`/`CostTrackingModelProvider` deliberately didn't build (see
 * /docs/DECISIONS.md's cost-logging entry: "this is the logging half... nothing yet stops a
 * real run from spending freely"). This file is the part that actually stops one.
 *
 * Design: a single rolling-UTC-day USD ceiling across every real model call, checked by
 * CostTrackingModelProvider *before* it ever calls the delegate provider — a blocked call
 * never reaches Anthropic, so it never spends anything. Deliberately simple (one number, one
 * period, no per-agent/per-model-class sub-budgets) because a single-operator tool doesn't
 * need a granular governor to get real protection against a runaway loop or a fat-fingered
 * batch job; a per-job call-count/vision-pass governor (the rest of §16's list) is real future
 * work, not something this file pretends to also cover.
 *
 * Known limitation: the check-then-act between "read today's spend" and "write this call's
 * cost" isn't atomic, so a handful of calls fired genuinely concurrently could all pass the
 * check before any of them lands. Acceptable for a single-operator tool driving sequential
 * Server Actions (and PGlite itself can't reliably handle concurrent queries anyway — see
 * /docs/DECISIONS.md's PGlite entries) — this is a ceiling against runaway/accidental spend,
 * not a perfectly precise billing gate.
 */

/** Applies when MODEL_SPEND_DAILY_CAP_USD is unset. Roughly 2x a full week's expected spend
 * (~$14/wk per /docs/DECISIONS.md's cost-calculation entry) concentrated into one day —
 * generous enough that a normal day of real pipeline work never trips it, tight enough that a
 * genuine runaway (retry loop, accidental batch-of-batches) gets stopped well short of real
 * money. Override via env for a different risk tolerance. */
export const DEFAULT_DAILY_SPEND_CAP_USD = 30;

export class SpendCapExceededError extends Error {
  constructor(
    public readonly promptId: string,
    public readonly capUsd: number,
    public readonly spentTodayUsd: number,
  ) {
    super(
      `Blocked before calling the model: today's spend ($${spentTodayUsd.toFixed(2)}) has ` +
        `already reached the daily cap ($${capUsd.toFixed(2)}). Prompt "${promptId}" was not ` +
        `sent — no tokens were spent on this call. Raise MODEL_SPEND_DAILY_CAP_USD to lift ` +
        `this for the rest of today, or wait until the next UTC day when the cap resets.`,
    );
    this.name = "SpendCapExceededError";
  }
}

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
