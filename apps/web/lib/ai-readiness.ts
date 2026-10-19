import { prisma, getAiSpendOverview } from "@chris/domain";
import { resolveDailyCapUsd } from "./model-provider";

/**
 * Can the AI run right now? Free to ask (no model call): no key → off; the latest AI call
 * failed for lack of credit (and nothing has succeeded since) → out of credit; today's spend
 * at the safety cap → paused. Used by Finish to skip straight past the AI check when the
 * owner allows it, instead of booting a check that can only fail.
 * See docs/decisions-pending/quality-override.md.
 */
export async function aiReadiness(now = new Date()): Promise<{ ready: boolean; reason: string | null }> {
  if (!process.env.ANTHROPIC_API_KEY) return { ready: false, reason: "No Anthropic API key is set up" };
  const o = await getAiSpendOverview(prisma, now);
  if (o.creditError) return { ready: false, reason: "The AI account is out of credit" };
  let cap: number | null;
  try {
    cap = resolveDailyCapUsd();
  } catch {
    cap = null;
  }
  if (cap != null && o.todayUsd >= cap) return { ready: false, reason: "Today's AI spending limit was reached" };
  return { ready: true, reason: null };
}
