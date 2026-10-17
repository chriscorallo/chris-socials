import {
  AnthropicModelProvider,
  CostTrackingModelProvider,
  DEFAULT_DAILY_SPEND_CAP_USD,
  type ModelProvider,
} from "@chris/agents";
import { prisma } from "@chris/domain";

/**
 * Real (Anthropic) model provider — needs ANTHROPIC_API_KEY set to actually call out. See
 * /docs/DECISIONS.md: Phase 2 was built and tested entirely against a mock provider
 * precisely so no real cost was spent proving it works; this is the real path, ready the
 * moment a key is configured.
 *
 * Wrapped in CostTrackingModelProvider so every real call this app makes — every Server
 * Action in apps/web/app/content/[id]/actions.ts routes through this single function —
 * gets logged to ModelCallLog with real tokens/cost (not the estimate in
 * /docs/DECISIONS.md's cost-calculation entry) AND is refused before it ever reaches
 * Anthropic once today's spend hits the daily cap (/docs/DECISIONS.md's spend-cap entry).
 * This is the only place either concern needs to be wired; individual agent files never see
 * or depend on it.
 *
 * MODEL_SPEND_DAILY_CAP_USD overrides the default cap (see packages/agents/src/spend-cap.ts)
 * — set it in .env.local for a different risk tolerance, or to "0" to block everything (e.g.
 * while deliberately keeping the app in a no-real-spend state).
 *
 * Constructed lazily (only when an agent action actually runs), not at module load — so
 * pages that never trigger an agent are unaffected by whether a key is configured at all.
 */
let instance: ModelProvider | undefined;

export function resolveDailyCapUsd(): number {
  const raw = process.env.MODEL_SPEND_DAILY_CAP_USD;
  if (raw === undefined || raw === "") return DEFAULT_DAILY_SPEND_CAP_USD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `MODEL_SPEND_DAILY_CAP_USD is set to "${raw}", which isn't a valid non-negative number.`,
    );
  }
  return parsed;
}

export function getModelProvider(): ModelProvider {
  instance ??= new CostTrackingModelProvider(new AnthropicModelProvider(), prisma, {
    dailyCapUsd: resolveDailyCapUsd(),
  });
  return instance;
}
