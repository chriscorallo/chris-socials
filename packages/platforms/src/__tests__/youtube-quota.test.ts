import { describe, it, expect } from "vitest";
import { prisma, createContentItem } from "@chris/domain";
import { getYouTubeQuotaState, YOUTUBE_UPLOAD_DAILY_BUDGET } from "../youtube-quota";

/**
 * `getYouTubeQuotaState` counts real wall-clock "today". Using the actual current date here
 * would mean these tests' own inserted rows accumulate in the persistent dev DB across every
 * `pnpm test` run for the rest of the real day — eventually exhausting the real budget out
 * from under a later, unrelated run. Instead, every describe block picks a synthetic "fake
 * now" derived from `Date.now()` at import time (monotonically increasing across real runs,
 * so two runs never land on the same fake day) — the same pattern used elsewhere in this repo
 * for exactly this reason (see /docs/DECISIONS.md's test-date-collision entries).
 */
/**
 * Snapped to noon UTC on a future day, not "real now + N days" — the latter preserves real
 * now's time-of-day, which is only safe as a base for same-day arithmetic (like "check 1 hour
 * later") when it doesn't land near a UTC day boundary. It can: this was caught by a real test
 * failure where `RUN_BASE_MS` happened to fall late enough in the UTC day that "now + 1 hour"
 * (used to check a window a day-bucketed query considers closed) rolled into the *next* UTC
 * day, landing outside the very bucket the 100 rows below were written into. Noon UTC gives a
 * full 12-hour margin in both directions for any same-day offset this file adds.
 */
const RUN_BASE_DAY_UTC = Math.floor(Date.now() / (24 * 60 * 60 * 1000)) * 24 * 60 * 60 * 1000;
function fakeNowForOffset(dayOffset: number): Date {
  return new Date(RUN_BASE_DAY_UTC + dayOffset * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000);
}

describe("getYouTubeQuotaState (real DB, no mocking)", () => {
  async function makePackage(contentItemId: string) {
    return prisma.platformPackage.create({
      data: { contentItemId, platform: "YOUTUBE", caption: "test", hashtags: [] },
    });
  }

  /** A monotonic `RUN_BASE_MS` alone isn't enough: repeated `pnpm test` invocations within the
   * same real hour still land `fakeNowForOffset(dayOffset)` in the *same UTC calendar day*
   * bucket (day-granularity, not millisecond), so rows from an earlier invocation today would
   * otherwise accumulate under the exact scenario this file exists to avoid — the same
   * class of test-date collision documented elsewhere in this repo (see /docs/DECISIONS.md).
   * Explicit cleanup of this test's own synthetic-day rows before asserting exact counts is
   * the other half of that established fix. */
  async function clearYouTubePublicationsForDay(now: Date) {
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const startOfNextDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    await prisma.publication.deleteMany({
      where: { platform: "YOUTUBE", createdAt: { gte: startOfDay, lt: startOfNextDay } },
    });
  }

  it("reports full budget remaining on a day with no publications yet", async () => {
    const now = fakeNowForOffset(1);
    await clearYouTubePublicationsForDay(now);
    const item = await createContentItem(prisma, { title: "Quota test — clean" }, { actorId: "test" });
    const pkg = await makePackage(item.id);
    // A row on a *different* (real, current) day, and for a *different* platform, must not
    // count against this synthetic day's YouTube budget.
    await prisma.publication.create({
      data: {
        contentItemId: item.id,
        platform: "INSTAGRAM",
        platformPackageId: pkg.id,
        idempotencyKey: `${item.id}:INSTAGRAM`,
        status: "SUCCESS",
      },
    });

    const state = await getYouTubeQuotaState(prisma, now);
    expect(state.uploadCallsUsedToday).toBe(0);
    expect(state.uploadCallsRemainingToday).toBe(YOUTUBE_UPLOAD_DAILY_BUDGET);
    expect(state.canUploadNow).toBe(true);
  });

  it("counts YOUTUBE Publication rows created on that synthetic day, success and failure alike", async () => {
    const now = fakeNowForOffset(2);
    await clearYouTubePublicationsForDay(now);
    const item = await createContentItem(prisma, { title: "Quota test — usage" }, { actorId: "test" });
    const pkg = await makePackage(item.id);

    await prisma.publication.create({
      data: {
        contentItemId: item.id,
        platform: "YOUTUBE",
        platformPackageId: pkg.id,
        idempotencyKey: `${item.id}:YOUTUBE`,
        status: "SUCCESS",
        createdAt: now,
      },
    });
    await prisma.publication.create({
      data: {
        contentItemId: item.id,
        platform: "YOUTUBE",
        platformPackageId: pkg.id,
        attempt: 2,
        idempotencyKey: `${item.id}:YOUTUBE`,
        status: "FAILED",
        errorMessage: "simulated failure — still costs the upload quota call",
        createdAt: new Date(now.getTime() + 1000),
      },
    });

    const state = await getYouTubeQuotaState(prisma, new Date(now.getTime() + 60_000));
    expect(state.uploadCallsUsedToday).toBe(2);
    expect(state.uploadCallsRemainingToday).toBe(YOUTUBE_UPLOAD_DAILY_BUDGET - 2);
  });

  it("canUploadNow flips false once the daily budget is exhausted", async () => {
    const now = fakeNowForOffset(3);
    await clearYouTubePublicationsForDay(now);
    const item = await createContentItem(prisma, { title: "Quota test — exhaustion" }, { actorId: "test" });
    const pkg = await makePackage(item.id);

    for (let i = 0; i < YOUTUBE_UPLOAD_DAILY_BUDGET; i++) {
      await prisma.publication.create({
        data: {
          contentItemId: item.id,
          platform: "YOUTUBE",
          platformPackageId: pkg.id,
          attempt: i + 1,
          idempotencyKey: `${item.id}:YOUTUBE`,
          status: "SUCCESS",
          createdAt: new Date(now.getTime() + i * 1000),
        },
      });
    }

    const state = await getYouTubeQuotaState(prisma, new Date(now.getTime() + 60 * 60 * 1000));
    expect(state.uploadCallsUsedToday).toBe(YOUTUBE_UPLOAD_DAILY_BUDGET);
    expect(state.uploadCallsRemainingToday).toBe(0);
    expect(state.canUploadNow).toBe(false);
  }, 30000);
});
