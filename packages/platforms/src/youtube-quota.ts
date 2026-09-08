import type { PrismaClient } from "@chris/domain";

/**
 * YouTube Data API v3 quota tracking — deterministic, DB-derived, no external call needed to
 * check. Two independent buckets per Google's current quota-cost table
 * (https://developers.google.com/youtube/v3/determine_quota_cost, verified 2026-09-07 — see
 * /docs/DECISIONS.md's correction entry, which replaced an earlier, wrong 1,600-units-against-
 * a-shared-10,000 assumption carried over uninspected from the original plan):
 *
 * - `videos.insert` (the actual upload) has its own dedicated budget: 100 calls/day, 1 unit
 *   each.
 * - Everything else (status checks via `videos.list` for `verify()`) draws from the shared
 *   general budget: 10,000 units/day.
 *
 * Usage is derived from today's real `Publication` rows rather than a separate counter table —
 * one less piece of state to keep in sync, and it's naturally reset by UTC-day the same way
 * the real quota resets (per Google's docs, quota resets at midnight Pacific Time; this uses
 * UTC as a deliberately conservative approximation — see /docs/DECISIONS.md if this ever needs
 * to be exact down to the hour, which it doesn't at this posting cadence).
 */
export const YOUTUBE_UPLOAD_DAILY_BUDGET = Number(process.env.YOUTUBE_UPLOAD_QUOTA_PER_DAY ?? 100);
export const YOUTUBE_UPLOAD_COST_PER_CALL = 1;
export const YOUTUBE_GENERAL_DAILY_BUDGET = Number(process.env.YOUTUBE_GENERAL_QUOTA_PER_DAY ?? 10000);
export const YOUTUBE_STATUS_CHECK_COST = 1;

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfNextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export interface YouTubeQuotaState {
  uploadCallsUsedToday: number;
  uploadCallsRemainingToday: number;
  canUploadNow: boolean;
}

/** Counts today's real publish *attempts* (every `Publication` row created for YOUTUBE today,
 * success or failure — the upload call itself was made either way, so it still cost quota).
 * Bounded on both ends — `lt: startOfNextUtcDay` matters as much as `gte: startOfUtcDay`: an
 * unbounded-above range here would let a synthetic future-dated test fixture (or a real
 * scheduled-in-advance row) leak into every subsequent real-time quota check from now until
 * real time catches up to it. Found by a real test failure, not by inspection — see
 * /docs/DECISIONS.md. */
export async function getYouTubeQuotaState(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<YouTubeQuotaState> {
  const uploadCallsUsedToday = await prisma.publication.count({
    where: {
      platform: "YOUTUBE",
      createdAt: { gte: startOfUtcDay(now), lt: startOfNextUtcDay(now) },
    },
  });
  const uploadCallsRemainingToday = Math.max(0, YOUTUBE_UPLOAD_DAILY_BUDGET - uploadCallsUsedToday);
  return {
    uploadCallsUsedToday,
    uploadCallsRemainingToday,
    canUploadNow: uploadCallsRemainingToday >= YOUTUBE_UPLOAD_COST_PER_CALL,
  };
}
