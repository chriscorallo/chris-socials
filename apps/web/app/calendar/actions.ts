"use server";

import { redirect } from "next/navigation";
import {
  prisma,
  listUnscheduledReadyItems,
  listScheduleEntries,
  scheduleContentItemForPublishing,
} from "@chris/domain";
import { runSchedulerAgent, getBrandContextText, type PackagingPlatform } from "@chris/agents";
import { getYouTubeQuotaState } from "@chris/platforms";
import { requireSession } from "../../lib/session";
import { getModelProvider } from "../../lib/model-provider";

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * Manual placement/reschedule — the click-to-assign mechanic on the Calendar grid. Works for
 * both an unscheduled READY item (first placement) and an already-SCHEDULED one (moving it to
 * a new slot) — see schedule.ts's scheduleContentItemForPublishing for why one function covers
 * both.
 *
 * `redirect()` is called exactly once, after the try/catch fully resolves — never from inside
 * the try itself. Next's redirect() works by throwing, so calling it inside a try block would
 * be caught by this function's own catch and misreported as a failure — see
 * /docs/DECISIONS.md's tryAutonomousPublishAction entry, the first time this exact bug was
 * caught (there) before it shipped.
 */
export async function placeOnCalendar(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  const scheduledDate = new Date(str(formData, "scheduledDate"));
  const targetPlatforms = formData.getAll("targetPlatforms").map(String) as PackagingPlatform[];
  const week = str(formData, "week");
  let errorMessage: string | null = null;

  try {
    if (targetPlatforms.length === 0) {
      throw new Error("Select at least one target platform.");
    }
    if (Number.isNaN(scheduledDate.getTime())) {
      throw new Error("Pick a valid date/time.");
    }
    await scheduleContentItemForPublishing(
      prisma,
      { contentItemId, scheduledDate, targetPlatforms },
      { actorId: session.user!.id! },
    );
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "Unknown scheduling error";
  }

  redirect(
    errorMessage
      ? `/calendar?week=${week}&calendarError=${encodeURIComponent(errorMessage)}`
      : `/calendar?week=${week}`,
  );
}

/**
 * Spec §9 step 19, "Auto-Fill Week" — schedule coherently using topic spacing, format spacing,
 * tone, funnel role, experiments, newsletter timing, platform evidence, and content expiry.
 * The Scheduler Agent itself (packages/agents/src/scheduler-agent.ts) has existed since an
 * earlier phase but had no caller anywhere in the app — this is that caller. Requires
 * ANTHROPIC_API_KEY. Gathers the real unscheduled-READY pool, real recent scheduling history,
 * and real YouTube quota state (Instagram/TikTok don't have a modeled hard quota in this app
 * yet — see /docs/DECISIONS.md), then persists every proposal exactly like a manual placement
 * would (same scheduleContentItemForPublishing call, same READY -> SCHEDULED transition).
 *
 * Same single-redirect-after-try discipline as placeOnCalendar above.
 */
export async function runAutoFillWeek(formData: FormData) {
  const session = await requireSession();
  const week = str(formData, "week");
  let errorMessage: string | null = null;

  try {
    const unscheduled = await listUnscheduledReadyItems(prisma);

    if (unscheduled.length > 0) {
      const history = await listScheduleEntries(prisma);
      const recentHistory = history.slice(-30).map((h) => ({
        contentItemId: h.contentItemId,
        scheduledDate: h.scheduledDate.toISOString(),
        platforms: h.targetPlatforms as string[],
      }));

      const youtubeQuota = await getYouTubeQuotaState(prisma);
      const brandContext = await getBrandContextText(prisma);

      const result = await runSchedulerAgent(getModelProvider(), {
        readyItems: unscheduled.map((item) => ({
          contentItemId: item.id,
          title: item.title,
          pillar: item.pillar,
          format: item.format,
        })),
        history: recentHistory,
        quota: [
          {
            platform: "YOUTUBE",
            note: `${youtubeQuota.uploadCallsUsedToday}/${youtubeQuota.uploadCallsUsedToday + youtubeQuota.uploadCallsRemainingToday} YouTube uploads used today${youtubeQuota.canUploadNow ? "" : " — NONE remaining, do not place a YouTube upload today"}`,
          },
          { platform: "INSTAGRAM", note: "No hard daily cap modeled yet — use judgment on posting cadence." },
          { platform: "TIKTOK", note: "No hard daily cap modeled yet — use judgment on posting cadence." },
        ],
        brandContext,
      });

      for (const proposal of result.items) {
        await scheduleContentItemForPublishing(
          prisma,
          {
            contentItemId: proposal.contentItemId,
            scheduledDate: new Date(proposal.scheduledDate),
            targetPlatforms: proposal.platforms,
          },
          { actorId: session.user!.id! },
        );
      }
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "Unknown Auto-Fill error";
  }

  redirect(
    errorMessage
      ? `/calendar?week=${week}&calendarError=${encodeURIComponent(errorMessage)}`
      : `/calendar?week=${week}`,
  );
}
