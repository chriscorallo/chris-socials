import { prisma, getAiSpendOverview, recordModelCall, ANTHROPIC_CREDIT_ERROR_RE } from "@chris/domain";
import { computeCostUsd, usageFromTokens } from "@chris/agents";

/**
 * "Out of credit" is inferred from the last failed AI call (getAiSpendOverview.creditError)
 * and only clears when an AI call later succeeds. But the gates that read it (Finish's AI
 * check, the Director's AI button, the viewer check) refuse to make a call while it's set —
 * so after Chris tops up, nothing could ever succeed and it stayed "out of credit" forever.
 *
 * This breaks the deadlock: while creditError is set, re-ask Anthropic with the smallest
 * possible real call (Haiku, 1 output token ≈ $0.000002), at most once a minute. A success is
 * logged like any call, which clears creditError for every gate; a credit failure is logged
 * too, so the state stays honest. See /docs/DECISIONS.md ("Stale out-of-credit").
 */
export const CREDIT_PROBE_PROMPT_ID = "AI_CREDIT_PROBE";
const PROBE_MODEL = "claude-haiku-5-5";
const MIN_INTERVAL_MS = 60_000;

export async function recheckAiCreditIfStale(now = new Date(), fetchImpl: typeof fetch = fetch): Promise<"not-needed" | "throttled" | "ok" | "still-failing"> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return "not-needed";
  const o = await getAiSpendOverview(prisma, now);
  if (!o.creditError) return "not-needed";
  const recentProbe = await prisma.modelCallLog.findFirst({
    where: { promptId: CREDIT_PROBE_PROMPT_ID, createdAt: { gte: new Date(now.getTime() - MIN_INTERVAL_MS) } },
    select: { id: true },
  });
  if (recentProbe) return "throttled";

  const started = Date.now();
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as { usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } } | null;
    if (res.ok) {
      const inputTokens = body?.usage?.input_tokens ?? 0;
      const outputTokens = body?.usage?.output_tokens ?? 0;
      await recordModelCall(prisma, {
        promptId: CREDIT_PROBE_PROMPT_ID,
        modelClass: "LOW",
        model: PROBE_MODEL,
        inputTokens,
        outputTokens,
        costUsd: computeCostUsd(PROBE_MODEL, usageFromTokens(inputTokens, outputTokens)) ?? 0,
        latencyMs: Date.now() - started,
        success: true,
      });
      return "ok";
    }
    const errorMessage = `${res.status}: ${body?.error?.message ?? "request failed"}`.slice(0, 500);
    // Only a credit answer is evidence about credit (a busy/overloaded API isn't) — log just that.
    if (ANTHROPIC_CREDIT_ERROR_RE.test(errorMessage)) {
      await recordModelCall(prisma, { promptId: CREDIT_PROBE_PROMPT_ID, modelClass: "LOW", model: PROBE_MODEL, latencyMs: Date.now() - started, success: false, errorMessage });
    }
    return "still-failing";
  } catch {
    // Network trouble isn't evidence either way — leave the state as it was.
    return "still-failing";
  }
}
