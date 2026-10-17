"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import {
  prisma,
  listUnscheduledReadyItems,
  listScheduleEntries,
  scheduleContentItemForPublishing,
  parseLocalDateTimeInTz,
  ymdMinutesToUtc,
  parseYmd,
  savePostingPlan,
  dismissNudge,
  ymdInTz,
  PostingPlanDataSchema,
  computeCourse,
  loadCourseInput,
  getActivePostingPlan,
  type PostingPlanData,
} from "@chris/domain";
import { runSchedulerAgent, getBrandContextText, type PackagingPlatform } from "@chris/agents";
import { getYouTubeQuotaState } from "@chris/platforms";
import { requireSession } from "../../lib/session";
import { getModelProvider } from "../../lib/model-provider";
import { APP_TZ } from "../../lib/calendar-data";

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/** Only ever redirect back inside the calendar / to-do / home — never an arbitrary URL. */
function safeBack(back: string, fallback = "/calendar"): string {
  return /^\/(calendar|todo)?(\?|$|\/)/.test(back) && !back.startsWith("//") ? back : fallback;
}

function withParam(url: string, key: string, value: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

const PLATFORMS = new Set(["INSTAGRAM", "TIKTOK", "YOUTUBE"]);

/**
 * Manual placement/reschedule from a form (the "+ Add" / reschedule sheet forms). Works for
 * both an unscheduled READY item (first placement) and an already-SCHEDULED one (moving it) —
 * see schedule.ts's scheduleContentItemForPublishing for why one function covers both.
 *
 * The datetime-local value is read as wall time in APP_TIMEZONE explicitly (not the process
 * zone). `redirect()` is called exactly once, after the try/catch — Next's redirect() throws,
 * so calling it inside the try would be misreported as a failure (see /docs/DECISIONS.md's
 * tryAutonomousPublishAction entry).
 */
export async function placeOnCalendar(formData: FormData) {
  const session = await requireSession();
  const contentItemId = str(formData, "contentItemId");
  const raw = str(formData, "scheduledDate");
  const atIso = str(formData, "atIso");
  const targetPlatforms = formData.getAll("targetPlatforms").map(String).filter((p) => PLATFORMS.has(p)) as PackagingPlatform[];
  const back = safeBack(str(formData, "back") || (str(formData, "week") ? `/calendar?view=week&date=${str(formData, "week")}` : "/calendar"));
  let errorMessage: string | null = null;

  try {
    if (!contentItemId) throw new Error("Pick a video.");
    if (targetPlatforms.length === 0) throw new Error("Select at least one target platform.");
    const scheduledDate = atIso ? new Date(atIso) : parseLocalDateTimeInTz(raw, APP_TZ);
    if (!scheduledDate || Number.isNaN(scheduledDate.getTime())) throw new Error("Pick a valid date/time.");
    await scheduleContentItemForPublishing(prisma, { contentItemId, scheduledDate, targetPlatforms }, { actorId: session.user!.id! });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "Unknown scheduling error";
  }

  redirect(errorMessage ? withParam(back, "calendarError", errorMessage) : back);
}

export type MoveResult = { ok: true } | { ok: false; error: string };

/**
 * Drag-to-reschedule (and the sheet's quick reschedule): moves an event to local day `ymd`
 * at `minutes` past midnight in APP_TIMEZONE. Same domain path (and audit) as every other
 * placement; returns a result instead of redirecting so the client can keep its view state.
 */
export async function moveEvent(input: { contentItemId: string; ymd: string; minutes: number; platforms: string[] }): Promise<MoveResult> {
  const session = await requireSession();
  try {
    if (!parseYmd(input.ymd)) throw new Error("Invalid day.");
    if (!Number.isInteger(input.minutes) || input.minutes < 0 || input.minutes >= 24 * 60) throw new Error("Invalid time.");
    const platforms = input.platforms.filter((p) => PLATFORMS.has(p)) as PackagingPlatform[];
    if (platforms.length === 0) throw new Error("Select at least one target platform.");
    await scheduleContentItemForPublishing(
      prisma,
      { contentItemId: input.contentItemId, scheduledDate: ymdMinutesToUtc(input.ymd, input.minutes, APP_TZ), targetPlatforms: platforms },
      { actorId: session.user!.id! },
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't reschedule." };
  }
  refresh();
  return { ok: true };
}

/** "Fill this slot" / a one-tap nudge: schedule a READY video at an exact instant. */
export async function scheduleAt(input: { contentItemId: string; atIso: string; platforms: string[] }): Promise<MoveResult> {
  const session = await requireSession();
  try {
    const at = new Date(input.atIso);
    if (Number.isNaN(at.getTime())) throw new Error("Invalid time.");
    const platforms = input.platforms.filter((p) => PLATFORMS.has(p)) as PackagingPlatform[];
    if (platforms.length === 0) throw new Error("Select at least one target platform.");
    await scheduleContentItemForPublishing(prisma, { contentItemId: input.contentItemId, scheduledDate: at, targetPlatforms: platforms }, { actorId: session.user!.id! });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't schedule." };
  }
  refresh();
  return { ok: true };
}

/** Form version of scheduleAt for server-rendered nudge lists (home, /todo). */
export async function scheduleFromNudge(formData: FormData) {
  const back = safeBack(str(formData, "back"), "/todo");
  const result = await scheduleAt({
    contentItemId: str(formData, "contentItemId"),
    atIso: str(formData, "atIso"),
    platforms: formData.getAll("platforms").map(String),
  });
  redirect(result.ok ? back : withParam(back, "calendarError", result.error));
}

/** "Not today" on a nudge — comes back tomorrow if it's still true. */
export async function dismissNudgeAction(formData: FormData) {
  await requireSession();
  const key = str(formData, "key");
  if (key) await dismissNudge(prisma, key.slice(0, 300), ymdInTz(new Date(), APP_TZ));
  refresh();
}

export async function savePostingPlanAction(data: PostingPlanData): Promise<MoveResult> {
  const session = await requireSession();
  try {
    const parsed = PostingPlanDataSchema.parse({ ...data, timezone: APP_TZ });
    await savePostingPlan(prisma, parsed, { actorId: session.user!.id! });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't save the plan." };
  }
  refresh();
  return { ok: true };
}

/**
 * Spec §9 step 19, "Auto-Fill Week" — schedule coherently using topic spacing, format spacing,
 * tone, funnel role, experiments, newsletter timing, platform evidence, and content expiry.
 * Requires ANTHROPIC_API_KEY. Gathers the real unscheduled-READY pool, real recent scheduling
 * history, and real YouTube quota state (Instagram/TikTok don't have a modeled hard quota in
 * this app yet — see /docs/DECISIONS.md), then persists every proposal exactly like a manual
 * placement would (same scheduleContentItemForPublishing call, same READY -> SCHEDULED
 * transition). Same single-redirect-after-try discipline as placeOnCalendar above.
 */
export async function runAutoFillWeek(formData: FormData) {
  const session = await requireSession();
  const back = safeBack(str(formData, "back") || (str(formData, "week") ? `/calendar?view=week&date=${str(formData, "week")}` : "/calendar"));
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

      // Chris's posting plan, as plain-language per-platform notes: the agent should aim for
      // the open plan slots rather than invent its own cadence.
      const now = new Date();
      const course = computeCourse(await loadCourseInput(prisma, { now, tz: APP_TZ }));
      const plan = await getActivePostingPlan(prisma);
      const planNote = (platform: string) => {
        const c = plan?.cadences.find((x) => x.platform === platform && x.enabled && x.postsPerWeek > 0);
        if (!c) return plan ? " Posting plan: not posting on this platform — avoid it unless clearly better." : "";
        const open = course.openSlots
          .filter((s) => (s.platforms as string[]).includes(platform))
          .slice(0, 10)
          .map((s) => `${s.at.toISOString()} (${s.ymd} ${s.time} ${APP_TZ})`);
        return ` Posting plan: ${c.postsPerWeek}/week. Open plan slots to fill first: ${open.length ? open.join(", ") : "none"}.`;
      };

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
            note: `${youtubeQuota.uploadCallsUsedToday}/${youtubeQuota.uploadCallsUsedToday + youtubeQuota.uploadCallsRemainingToday} YouTube uploads used today${youtubeQuota.canUploadNow ? "" : " — NONE remaining, do not place a YouTube upload today"}${planNote("YOUTUBE")}`,
          },
          { platform: "INSTAGRAM", note: `No hard daily cap modeled yet — use judgment on posting cadence.${planNote("INSTAGRAM")}` },
          { platform: "TIKTOK", note: `No hard daily cap modeled yet — use judgment on posting cadence.${planNote("TIKTOK")}` },
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

  redirect(errorMessage ? withParam(back, "calendarError", errorMessage) : back);
}
