import { z } from "zod";
import {
  addDaysYmd,
  formatHhmm,
  minutesInTz,
  mondayOfYmd,
  parseHhmm,
  weekdayOfYmd,
  ymdInTz,
  ymdMinutesToUtc,
} from "./tz";

/**
 * Posting plan — Chris's chosen schedule + frequency, per platform — and the two pure
 * functions everything else ("open slot" placeholders on the calendar, the Stay-on-course
 * nudges) is built on: generatePlanSlots and matchSlotsToSchedule.
 *
 * Pure module (no Prisma import) so the plan editor's live preview can run the exact same
 * slot generator in the browser. Persistence lives in posting-plan.ts.
 */

export const PLAN_PLATFORMS = ["TIKTOK", "INSTAGRAM", "YOUTUBE"] as const;
export type PlanPlatform = (typeof PLAN_PLATFORMS)[number];

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Times are HH:mm");

export const PlatformCadenceSchema = z.object({
  platform: z.enum(PLAN_PLATFORMS),
  enabled: z.boolean(),
  postsPerWeek: z.number().int().min(0).max(21),
  /** JS weekdays, 0 = Sunday … 6 = Saturday. Empty = spread across the whole week. */
  preferredDays: z.array(z.number().int().min(0).max(6)).max(7),
  /** "HH:mm" wall times in the plan's time zone. Empty = 18:00. */
  preferredTimes: z.array(HHMM).max(6),
});
export type PlatformCadence = z.infer<typeof PlatformCadenceSchema>;

export const PostingPlanDataSchema = z.object({
  /** "YYYY-MM-DD" — no slots before this day (so a new plan doesn't flag last month as missed). */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1),
  /** Days before a slot the video should be READY (rendered + gated). */
  readyLeadDays: z.number().int().min(0).max(14),
  /** Days before a slot the video should be filmed. */
  filmLeadDays: z.number().int().min(0).max(21),
  /** UI convenience only: the editor shows one cadence and copies it to every enabled platform. */
  sameForAll: z.boolean(),
  cadences: z.array(PlatformCadenceSchema).min(1).max(PLAN_PLATFORMS.length),
});
export type PostingPlanData = z.infer<typeof PostingPlanDataSchema>;

/** A sensible starting plan (what the editor pre-fills before Chris has saved one). */
export function defaultPostingPlanData(startDate: string, timezone: string): PostingPlanData {
  return {
    startDate,
    timezone,
    readyLeadDays: 1,
    filmLeadDays: 3,
    sameForAll: false,
    cadences: [
      { platform: "TIKTOK", enabled: true, postsPerWeek: 5, preferredDays: [1, 2, 3, 4, 5], preferredTimes: ["18:00"] },
      { platform: "INSTAGRAM", enabled: true, postsPerWeek: 4, preferredDays: [1, 2, 4, 5], preferredTimes: ["18:00"] },
      { platform: "YOUTUBE", enabled: true, postsPerWeek: 3, preferredDays: [1, 3, 5], preferredTimes: ["18:00"] },
    ],
  };
}

export interface PlanSlot {
  /** Stable identity: platform + instant. */
  key: string;
  platform: PlanPlatform;
  at: Date;
  /** Local calendar day in the plan's zone. */
  ymd: string;
  /** Local "HH:mm". */
  time: string;
  /** Monday of the slot's week (local). */
  weekStart: string;
}

/** Monday-first order of JS weekdays. */
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

/**
 * Which of `count` options to use for `n` picks, spread as evenly as possible
 * (n=3 of 7 → indices 0,3,5 → Mon/Thu/Sat; n=5 of 5 → all).
 */
export function spreadIndices(count: number, n: number): number[] {
  if (n <= 0 || count <= 0) return [];
  if (n >= count) return Array.from({ length: count }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(((i + 0.25) * count) / n));
  return out;
}

/**
 * The (weekday, minutes) pairs one cadence asks for in a single week. postsPerWeek is capped
 * at days × times (you can't post more often than the slots you allowed) — the editor shows
 * that cap so it's never silent.
 */
export function weeklyPattern(c: PlatformCadence): { weekday: number; minutes: number }[] {
  if (!c.enabled || c.postsPerWeek <= 0) return [];
  const days = (c.preferredDays.length ? MON_FIRST.filter((d) => c.preferredDays.includes(d)) : MON_FIRST).slice();
  const times = [...new Set(c.preferredTimes)]
    .map(parseHhmm)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);
  if (times.length === 0) times.push(18 * 60);
  const n = Math.min(c.postsPerWeek, days.length * times.length);

  const perDay = new Array<number>(days.length).fill(0);
  if (n <= days.length) {
    for (const i of spreadIndices(days.length, n)) perDay[i] = 1;
  } else {
    const base = Math.floor(n / days.length);
    perDay.fill(base);
    for (const i of spreadIndices(days.length, n % days.length)) perDay[i]! += 1;
  }

  const out: { weekday: number; minutes: number }[] = [];
  days.forEach((weekday, i) => {
    for (let k = 0; k < perDay[i]!; k++) {
      // More posts than times on one day: spread across that day's times too.
      const idx = spreadIndices(times.length, perDay[i]!)[k] ?? k;
      out.push({ weekday, minutes: times[idx]! });
    }
  });
  return out;
}

/** Effective number of posts per week for a cadence after the days×times cap. */
export function effectivePostsPerWeek(c: PlatformCadence): number {
  return weeklyPattern(c).length;
}

/**
 * Every planned posting slot in [from, to), in the plan's time zone. Pure and deterministic:
 * the same plan + window always yields the same slots, which is what lets the calendar draw
 * them, the course logic count them, and a test pin them.
 */
export function generatePlanSlots(plan: PostingPlanData, from: Date, to: Date): PlanSlot[] {
  const tz = plan.timezone;
  if (to <= from) return [];
  const slots: PlanSlot[] = [];
  const patterns = plan.cadences.map((c) => ({ platform: c.platform, pattern: weeklyPattern(c) }));
  const lastYmd = ymdInTz(to, tz);
  for (let monday = mondayOfYmd(ymdInTz(from, tz)); monday <= lastYmd; monday = addDaysYmd(monday, 7)) {
    for (const { platform, pattern } of patterns) {
      for (const { weekday, minutes } of pattern) {
        const ymd = addDaysYmd(monday, MON_FIRST.indexOf(weekday));
        if (ymd < plan.startDate) continue;
        const at = ymdMinutesToUtc(ymd, minutes, tz);
        if (at < from || at >= to) continue;
        slots.push({ key: `${platform}@${at.toISOString()}`, platform, at, ymd, time: formatHhmm(minutes), weekStart: monday });
      }
    }
  }
  slots.sort((a, b) => a.at.getTime() - b.at.getTime() || a.platform.localeCompare(b.platform));
  return slots;
}

export interface SchedulablePost {
  id: string;
  at: Date;
  platforms: string[];
}

export interface SlotMatch<P extends SchedulablePost = SchedulablePost> {
  slot: PlanSlot;
  filledBy: P | null;
}

/**
 * Which slots are already covered by a real post. A post covers a slot when it targets the
 * slot's platform, lands on the same local day, and is within `toleranceMinutes` (default
 * ±3h) — "7pm TikTok" is still filled by a 6:15pm TikTok. Each (post, platform) fills at
 * most one slot; ties go to the nearest post. Slots are matched in time order.
 */
export function matchSlotsToSchedule<P extends SchedulablePost>(
  slots: PlanSlot[],
  posts: P[],
  opts: { tz: string; toleranceMinutes?: number },
): { matches: SlotMatch<P>[]; unmatchedPosts: P[] } {
  const tol = (opts.toleranceMinutes ?? 180) * 60000;
  const used = new Set<string>();
  const postDays = new Map(posts.map((p) => [p.id, ymdInTz(p.at, opts.tz)]));
  const ordered = [...slots].sort((a, b) => a.at.getTime() - b.at.getTime());
  const matches: SlotMatch<P>[] = ordered.map((slot) => {
    let best: P | null = null;
    let bestDelta = Infinity;
    for (const post of posts) {
      if (!post.platforms.includes(slot.platform)) continue;
      if (used.has(`${post.id}:${slot.platform}`)) continue;
      if (postDays.get(post.id) !== slot.ymd) continue;
      const delta = Math.abs(post.at.getTime() - slot.at.getTime());
      if (delta > tol || delta >= bestDelta) continue;
      best = post;
      bestDelta = delta;
    }
    if (best) used.add(`${best.id}:${slot.platform}`);
    return { slot, filledBy: best };
  });
  const unmatchedPosts = posts.filter((p) => !p.platforms.some((pl) => used.has(`${p.id}:${pl}`)));
  return { matches, unmatchedPosts };
}

/** Open slots that share one local day + time — one video posted to all those platforms. */
export interface SlotGroup {
  key: string;
  at: Date;
  ymd: string;
  time: string;
  platforms: PlanPlatform[];
  slots: PlanSlot[];
}

export function groupSlots(slots: PlanSlot[]): SlotGroup[] {
  const map = new Map<string, SlotGroup>();
  for (const s of slots) {
    const k = s.at.toISOString();
    const g = map.get(k);
    if (g) {
      g.platforms.push(s.platform);
      g.slots.push(s);
    } else {
      map.set(k, { key: `group@${k}`, at: s.at, ymd: s.ymd, time: s.time, platforms: [s.platform], slots: [s] });
    }
  }
  return [...map.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Minutes-of-day helper re-exported for UI code that already imports this module. */
export function slotMinutes(slot: { at: Date }, tz: string): number {
  return minutesInTz(slot.at, tz);
}

/** Platform display names used across calendar + nudges. */
export const PLAN_PLATFORM_LABEL: Record<PlanPlatform, string> = {
  TIKTOK: "TikTok",
  INSTAGRAM: "Reels",
  YOUTUBE: "Shorts",
};

export function weekdayShort(ymd: string): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekdayOfYmd(ymd)]!;
}
