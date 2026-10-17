import type { ContentState } from "@prisma/client";
import {
  PLAN_PLATFORMS,
  PLAN_PLATFORM_LABEL,
  generatePlanSlots,
  groupSlots,
  matchSlotsToSchedule,
  type PlanPlatform,
  type PostingPlanData,
  type SlotGroup,
} from "./posting-plan-core";
import { addDaysYmd, diffDaysYmd, mondayOfYmd, startOfDayInTz, ymdInTz, zonedParts } from "./tz";

/**
 * "Stay on course" — pure logic that compares Chris's posting plan against what actually
 * exists (scheduled, published, in the pipeline) and turns the gap into a short, prioritized
 * list of concrete nudges with one obvious action each. Deterministic by design (CLAUDE.md:
 * prefer code over model judgment when the check is arithmetic): counting slots, working
 * deadlines backwards from lead times, and spotting items stuck too long are all arithmetic.
 *
 * No Prisma here — the DB gather lives in todo.ts — so every rule is unit-testable with a
 * fixed `now`.
 */

export interface CourseItem {
  id: string;
  title: string;
  state: ContentState;
  /** When the item entered its current state (latest transition, else updatedAt). */
  stateSince: Date;
  /** ScheduleEntry date, if any. */
  scheduledAt: Date | null;
  targetPlatforms: string[];
  /** Earliest successful/draft publication time, if published anywhere. */
  publishedAt: Date | null;
  publishedPlatforms: string[];
}

export interface CourseFailure {
  contentItemId: string;
  title: string;
  platform: string;
  at: Date;
  message: string | null;
}

export interface CourseInput {
  plan: PostingPlanData | null;
  items: CourseItem[];
  /** Latest attempt per (item, platform) that is FAILED. */
  failures: CourseFailure[];
  now: Date;
  tz: string;
}

export type NudgeSeverity = "critical" | "warn" | "info";
export type NudgeBucket = "today" | "week" | "setup";

export type NudgeAction =
  | { kind: "link"; label: string; href: string }
  | { kind: "schedule"; label: string; contentItemId: string; atIso: string; platforms: string[] };

export interface Nudge {
  /** Stable identity — what a "dismiss for today" is keyed on. */
  key: string;
  severity: NudgeSeverity;
  bucket: NudgeBucket;
  /** Sort key within the list: lower first. */
  priority: number;
  title: string;
  detail?: string;
  /** When this becomes a problem (for "due" labels); null for setup items. */
  due: Date | null;
  action?: NudgeAction;
  secondary?: NudgeAction;
}

export interface PlatformCoverage {
  platform: PlanPlatform;
  planned: number;
  /** Scheduled or published into a planned slot. */
  filled: number;
  published: number;
  /** Planned slots whose time has passed with nothing in them. */
  missed: number;
  /** Future slots still empty. */
  open: number;
}

export interface WeekCoverage {
  weekStart: string;
  label: "This week" | "Next week";
  platforms: PlatformCoverage[];
  planned: number;
  filled: number;
  published: number;
  missed: number;
  open: number;
}

export interface OpenSlot extends SlotGroup {
  suggestion: { contentItemId: string; title: string } | null;
}

export type PipelineStage = "ready" | "editing" | "filmed" | "toFilm" | "writing" | "uncovered";

export interface PipelineStep {
  stage: PipelineStage;
  count: number;
  /** Deadline for the earliest slot this step feeds. */
  deadline: Date;
  label: string;
  href: string;
  atRisk: boolean;
}

export interface PipelinePlan {
  /** Open slot groups (one video each) between now and the end of next week. */
  needed: number;
  horizonEnd: string;
  readyBy: Date | null;
  supply: Record<Exclude<PipelineStage, "uncovered">, number>;
  steps: PipelineStep[];
  summary: string;
}

export type StuckKind =
  | "MISSED"
  | "PUBLISH_FAILED"
  | "PUBLISH_STALLED"
  | "QC_BLOCKED"
  | "RESEARCH_BLOCKED"
  | "FILMED_IDLE"
  | "EDIT_STALLED"
  | "RESERVED_NOT_READY";

export interface StuckItem {
  contentItemId: string;
  title: string;
  kind: StuckKind;
  detail: string;
  since: Date;
  severity: NudgeSeverity;
}

export type CourseStatus = "NO_PLAN" | "ON_TRACK" | "BEHIND" | "AT_RISK";

export interface CourseResult {
  status: CourseStatus;
  headline: string;
  weeks: WeekCoverage[];
  streakWeeks: number;
  openSlots: OpenSlot[];
  pipeline: PipelinePlan | null;
  stuck: StuckItem[];
  nudges: Nudge[];
}

const EDIT_STATES: ReadonlySet<ContentState> = new Set([
  "MEDIA_INGESTED",
  "TAKE_SELECTED",
  "EDIT_PLANNED",
  "EDITING",
  "RENDERED",
  "QC_REPAIR",
]);
const WRITING_STATES: ReadonlySet<ContentState> = new Set([
  "SELECTED",
  "CONTRACTED",
  "RESEARCHING",
  "RESEARCHED",
  "SCRIPTING",
  "SCRIPTED",
]);
const LIVE_STATES: ReadonlySet<ContentState> = new Set(["PUBLISHED", "MEASURING", "ARCHIVED"]);
const ON_CALENDAR_STATES: ReadonlySet<ContentState> = new Set(["SCHEDULED", "PUBLISHING"]);
const DEAD_STATES: ReadonlySet<ContentState> = new Set(["CANCELLED"]);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Thresholds, in one place so the doc and the code can't drift. */
export const COURSE_THRESHOLDS = {
  filmedIdleDays: 2,
  editStalledDays: 2,
  missedGraceMinutes: 30,
  publishingStalledMinutes: 60,
  /** Open slots this close get the "today" bucket. */
  todayWindowHours: 48,
  streakLookbackWeeks: 26,
} as const;

function fmtDay(d: Date, tz: string): string {
  return d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
}
function fmtDayTime(d: Date, tz: string): string {
  return `${d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })} ${d
    .toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
    .replace(":00", "")}`;
}
function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
function platformsLabel(ps: string[]): string {
  return ps.map((p) => PLAN_PLATFORM_LABEL[p as PlanPlatform] ?? p).join(" + ");
}

/** The posts that can fill slots: live, on the calendar, or reserved (dated but not ready). */
function postsFor(items: CourseItem[], now: Date) {
  const missedBefore = now.getTime() - COURSE_THRESHOLDS.missedGraceMinutes * 60000;
  const posts: { id: string; at: Date; platforms: string[]; kind: "published" | "scheduled" | "reserved"; item: CourseItem }[] = [];
  for (const item of items) {
    if (DEAD_STATES.has(item.state)) continue;
    if (item.publishedAt && (LIVE_STATES.has(item.state) || item.publishedPlatforms.length > 0)) {
      posts.push({ id: item.id, at: item.publishedAt, platforms: item.publishedPlatforms, kind: "published", item });
    } else if (item.scheduledAt && ON_CALENDAR_STATES.has(item.state)) {
      // A SCHEDULED post whose time passed without publishing doesn't fill its slot — it's
      // surfaced as MISSED instead.
      if (item.state === "SCHEDULED" && item.scheduledAt.getTime() < missedBefore) continue;
      posts.push({ id: item.id, at: item.scheduledAt, platforms: item.targetPlatforms, kind: "scheduled", item });
    } else if (item.scheduledAt && !LIVE_STATES.has(item.state)) {
      posts.push({ id: item.id, at: item.scheduledAt, platforms: item.targetPlatforms, kind: "reserved", item });
    }
  }
  return posts;
}

export function computeCourse(input: CourseInput): CourseResult {
  const { plan, items, failures, now, tz } = input;
  const todayYmd = ymdInTz(now, tz);
  const thisMonday = mondayOfYmd(todayYmd);
  const stuck = findStuck(items, failures, now, tz);

  const enabled = plan ? plan.cadences.filter((c) => c.enabled && c.postsPerWeek > 0) : [];
  if (!plan || enabled.length === 0) {
    const nudges = stuckNudges(stuck, tz);
    nudges.push({
      key: "setup:posting-plan",
      severity: "warn",
      bucket: "setup",
      priority: 50,
      title: "Pick a posting schedule",
      detail: "Choose how often you post on each platform — the calendar then shows open slots and nudges you before you fall behind.",
      due: null,
      action: { kind: "link", label: "Set posting plan", href: "/calendar/plan" },
    });
    return {
      status: "NO_PLAN",
      headline: "No posting plan yet — set one so the calendar can keep you on course.",
      weeks: [],
      streakWeeks: 0,
      openSlots: [],
      pipeline: null,
      stuck,
      nudges: sortNudges(nudges),
    };
  }

  const planTz = plan.timezone || tz;
  const posts = postsFor(items, now);

  // ---- Coverage: this week + next week -------------------------------------------------
  const windowStart = startOfDayInTz(thisMonday, planTz);
  const windowEnd = startOfDayInTz(addDaysYmd(thisMonday, 14), planTz);
  const slots = generatePlanSlots(plan, windowStart, windowEnd);
  const { matches } = matchSlotsToSchedule(slots, posts, { tz: planTz });

  const weeks: WeekCoverage[] = [0, 1].map((w) => {
    const weekStart = addDaysYmd(thisMonday, w * 7);
    const inWeek = matches.filter((m) => m.slot.weekStart === weekStart);
    const platforms: PlatformCoverage[] = PLAN_PLATFORMS.filter((p) => enabled.some((c) => c.platform === p)).map((platform) => {
      const ms = inWeek.filter((m) => m.slot.platform === platform);
      return {
        platform,
        planned: ms.length,
        filled: ms.filter((m) => m.filledBy).length,
        published: ms.filter((m) => m.filledBy?.kind === "published").length,
        missed: ms.filter((m) => !m.filledBy && m.slot.at < now).length,
        open: ms.filter((m) => !m.filledBy && m.slot.at >= now).length,
      };
    });
    const sum = (k: keyof Omit<PlatformCoverage, "platform">) => platforms.reduce((a, p) => a + p[k], 0);
    return {
      weekStart,
      label: w === 0 ? "This week" : "Next week",
      platforms,
      planned: sum("planned"),
      filled: sum("filled"),
      published: sum("published"),
      missed: sum("missed"),
      open: sum("open"),
    };
  });

  // ---- Streak: consecutive complete weeks where every planned slot got a live post -------
  let streakWeeks = 0;
  for (let w = 1; w <= COURSE_THRESHOLDS.streakLookbackWeeks; w++) {
    const weekStart = addDaysYmd(thisMonday, -7 * w);
    if (addDaysYmd(weekStart, 6) < plan.startDate) break;
    const ws = generatePlanSlots(plan, startOfDayInTz(weekStart, planTz), startOfDayInTz(addDaysYmd(weekStart, 7), planTz));
    if (ws.length === 0) break;
    const live = posts.filter((p) => p.kind === "published");
    const { matches: wm } = matchSlotsToSchedule(ws, live, { tz: planTz });
    if (wm.every((m) => m.filledBy)) streakWeeks++;
    else break;
  }

  // ---- Open slots (future, unfilled), grouped per local time, with a READY suggestion ----
  const openGroups = groupSlots(matches.filter((m) => !m.filledBy && m.slot.at >= now).map((m) => m.slot));
  const reservedIds = new Set(posts.map((p) => p.id));
  const readyPool = items
    .filter((i) => i.state === "READY" && !reservedIds.has(i.id))
    .sort((a, b) => a.stateSince.getTime() - b.stateSince.getTime());
  const openSlots: OpenSlot[] = openGroups.map((g, i) => {
    const r = readyPool[i];
    return { ...g, suggestion: r ? { contentItemId: r.id, title: r.title } : null };
  });

  // ---- Pipeline, worked backwards from lead times ---------------------------------------
  const pipeline = planPipeline(openGroups, items, reservedIds, plan, now, planTz, addDaysYmd(thisMonday, 13));

  // ---- Nudges ----------------------------------------------------------------------------
  const nudges: Nudge[] = stuckNudges(stuck, tz);

  for (const slot of openSlots.slice(0, 6)) {
    const soon = slot.at.getTime() - now.getTime() <= COURSE_THRESHOLDS.todayWindowHours * HOUR;
    const where = `${fmtDayTime(slot.at, planTz)} ${platformsLabel(slot.platforms)}`;
    if (slot.suggestion) {
      nudges.push({
        key: `slot:${slot.key}`,
        severity: soon ? "warn" : "info",
        bucket: soon ? "today" : "week",
        priority: soon ? 20 : 40,
        title: `Schedule “${slot.suggestion.title}” into ${where}`,
        detail: "It's ready and not on the calendar yet.",
        due: slot.at,
        action: {
          kind: "schedule",
          label: "Schedule it",
          contentItemId: slot.suggestion.contentItemId,
          atIso: slot.at.toISOString(),
          platforms: slot.platforms,
        },
      });
    }
  }

  if (pipeline) {
    for (const step of pipeline.steps) {
      if (step.stage === "ready") continue; // covered by the per-slot "Schedule it" nudges above
      const hoursLeft = (step.deadline.getTime() - now.getTime()) / HOUR;
      const urgent = step.atRisk || hoursLeft <= COURSE_THRESHOLDS.todayWindowHours;
      nudges.push({
        key: `pipeline:${step.stage}:${ymdInTz(step.deadline, planTz)}:${step.count}`,
        severity: step.atRisk ? "critical" : urgent ? "warn" : "info",
        bucket: urgent ? "today" : "week",
        priority: step.atRisk ? 5 : urgent ? 15 : 35,
        title: step.label,
        detail: step.atRisk ? "This deadline has already passed — the slot it feeds is at risk." : undefined,
        due: step.deadline,
        action: { kind: "link", label: STAGE_ACTION_LABEL[step.stage], href: step.href },
      });
    }
  }

  const missedThisWeek = weeks[0]?.missed ?? 0;
  const atRisk =
    stuck.some((s) => s.severity === "critical") || (pipeline?.steps.some((s) => s.atRisk) ?? false);
  const behind = missedThisWeek > 0 || (pipeline?.steps.some((s) => s.stage === "uncovered") ?? false);
  const status: CourseStatus = atRisk ? "AT_RISK" : behind ? "BEHIND" : "ON_TRACK";

  const thisWeek = weeks[0]!;
  const headline =
    status === "ON_TRACK"
      ? thisWeek.open === 0 && (weeks[1]?.open ?? 0) === 0
        ? `On track — every slot through next week is filled (${thisWeek.filled}/${thisWeek.planned} this week).`
        : `On track — ${thisWeek.filled}/${thisWeek.planned} slots filled this week, and the pipeline covers what's open.`
      : pipeline?.summary ??
        `${thisWeek.filled}/${thisWeek.planned} slots filled this week${missedThisWeek ? `, ${missedThisWeek} missed` : ""}.`;

  return {
    status,
    headline,
    weeks,
    streakWeeks,
    openSlots,
    pipeline,
    stuck,
    nudges: sortNudges(nudges),
  };
}

const STAGE_ACTION_LABEL: Record<PipelineStage, string> = {
  ready: "Schedule",
  editing: "Open editing queue",
  filmed: "Upload footage",
  toFilm: "Open film list",
  writing: "Open scripts",
  uncovered: "Pick ideas",
};

function planPipeline(
  openGroups: SlotGroup[],
  items: CourseItem[],
  reservedIds: Set<string>,
  plan: PostingPlanData,
  now: Date,
  tz: string,
  horizonEndYmd: string,
): PipelinePlan | null {
  const groups = openGroups.filter((g) => g.ymd <= horizonEndYmd);
  const free = items.filter((i) => !reservedIds.has(i.id));
  const supply = {
    ready: free.filter((i) => i.state === "READY").length,
    editing: free.filter((i) => EDIT_STATES.has(i.state)).length,
    filmed: free.filter((i) => i.state === "FILMED").length,
    toFilm: free.filter((i) => i.state === "READY_TO_FILM").length,
    writing: free.filter((i) => WRITING_STATES.has(i.state)).length,
  };
  if (groups.length === 0) {
    return { needed: 0, horizonEnd: horizonEndYmd, readyBy: null, supply, steps: [], summary: "Every slot through next week is filled." };
  }

  const readyBy = (g: SlotGroup) => new Date(g.at.getTime() - plan.readyLeadDays * DAY);
  const filmBy = (g: SlotGroup) => new Date(g.at.getTime() - plan.filmLeadDays * DAY);

  // Earliest slots get the most-finished videos.
  const order: Exclude<PipelineStage, "uncovered">[] = ["ready", "editing", "filmed", "toFilm", "writing"];
  const remaining = { ...supply };
  const alloc = new Map<PipelineStage, SlotGroup[]>();
  for (const g of groups) {
    const stage = order.find((s) => remaining[s] > 0) ?? "uncovered";
    if (stage !== "uncovered") remaining[stage] -= 1;
    alloc.set(stage, [...(alloc.get(stage) ?? []), g]);
  }

  const steps: PipelineStep[] = [];
  const push = (stage: PipelineStage, deadline: Date, label: string, href: string) => {
    const count = alloc.get(stage)?.length ?? 0;
    steps.push({ stage, count, deadline, label, href, atRisk: deadline.getTime() < now.getTime() });
  };
  const first = (s: PipelineStage) => alloc.get(s)![0]!;
  if (alloc.has("ready")) {
    const n = alloc.get("ready")!.length;
    push("ready", first("ready").at, `Schedule ${plural(n, "ready video")}`, "/calendar?view=agenda");
  }
  if (alloc.has("editing")) {
    const n = alloc.get("editing")!.length;
    const d = readyBy(first("editing"));
    push("editing", d, `Finish editing ${n} by ${fmtDay(d, tz)}`, "/content?stage=edit");
  }
  if (alloc.has("filmed")) {
    const n = alloc.get("filmed")!.length;
    const d = readyBy(first("filmed"));
    push("filmed", d, `Upload footage for ${plural(n, "filmed video")} by ${fmtDay(d, tz)}`, "/upload");
  }
  if (alloc.has("toFilm")) {
    const n = alloc.get("toFilm")!.length;
    const d = filmBy(first("toFilm"));
    push("toFilm", d, `Film ${n} by ${fmtDay(d, tz)}`, "/film");
  }
  if (alloc.has("writing")) {
    const n = alloc.get("writing")!.length;
    const d = new Date(filmBy(first("writing")).getTime() - DAY);
    push("writing", d, `Get ${plural(n, "script")} ready to film by ${fmtDay(d, tz)}`, "/content?stage=write");
  }
  if (alloc.has("uncovered")) {
    const n = alloc.get("uncovered")!.length;
    const d = new Date(filmBy(first("uncovered")).getTime() - 2 * DAY);
    push("uncovered", d, `${plural(n, "slot")} have nothing in the pipeline — pick ${plural(n, "idea")} by ${fmtDay(d, tz)}`, "/ideas");
  }

  const earliestReadyBy = readyBy(groups[0]!);
  const haveParts = [
    `${supply.ready} ready`,
    supply.editing ? `${supply.editing} in editing` : null,
    supply.filmed ? `${supply.filmed} filmed (not uploaded)` : null,
    supply.toFilm ? `${supply.toFilm} to film` : null,
    supply.writing ? `${supply.writing} being written` : null,
  ].filter(Boolean);
  // The most urgent thing to do next = the earliest deadline among the non-"schedule it" steps.
  const nextAction = steps
    .filter((s) => s.stage !== "ready")
    .sort((a, b) => a.deadline.getTime() - b.deadline.getTime())[0];
  const summary =
    `To fill ${plural(groups.length, "open slot")} through ${fmtDay(startOfDayInTz(horizonEndYmd, tz), tz)} you need ` +
    `${plural(groups.length, "video")} ready, the first by ${fmtDay(earliestReadyBy, tz)}. You have ${haveParts.join(", ")}` +
    (nextAction ? ` → ${nextAction.label.charAt(0).toLowerCase()}${nextAction.label.slice(1)}.` : ".");

  return { needed: groups.length, horizonEnd: horizonEndYmd, readyBy: earliestReadyBy, supply, steps, summary };
}

export function findStuck(items: CourseItem[], failures: CourseFailure[], now: Date, tz: string): StuckItem[] {
  const out: StuckItem[] = [];
  const age = (d: Date) => now.getTime() - d.getTime();
  const days = (d: Date) => Math.floor(age(d) / DAY);
  for (const item of items) {
    const base = { contentItemId: item.id, title: item.title, since: item.stateSince };
    switch (item.state) {
      case "SCHEDULED":
        if (item.scheduledAt && age(item.scheduledAt) > COURSE_THRESHOLDS.missedGraceMinutes * 60000) {
          out.push({
            ...base,
            since: item.scheduledAt,
            kind: "MISSED",
            severity: "critical",
            detail: `Was due ${fmtDayTime(item.scheduledAt, tz)} and never went out — publish now or reschedule.`,
          });
        }
        break;
      case "PUBLISHING":
        if (age(item.stateSince) > COURSE_THRESHOLDS.publishingStalledMinutes * 60000) {
          out.push({ ...base, kind: "PUBLISH_STALLED", severity: "critical", detail: "Publishing started over an hour ago and hasn't finished — retry it." });
        }
        break;
      case "QC_BLOCKED":
        out.push({ ...base, kind: "QC_BLOCKED", severity: "critical", detail: "Quality gate blocked after repair attempts — decide: rework or cancel." });
        break;
      case "RESEARCH_BLOCKED":
        out.push({ ...base, kind: "RESEARCH_BLOCKED", severity: "warn", detail: "Claims Gate blocked a claim — needs a new angle or re-research." });
        break;
      case "FILMED":
        if (age(item.stateSince) > COURSE_THRESHOLDS.filmedIdleDays * DAY) {
          out.push({ ...base, kind: "FILMED_IDLE", severity: "warn", detail: `Filmed ${days(item.stateSince)} days ago but the footage isn't uploaded.` });
        }
        break;
      default:
        if (EDIT_STATES.has(item.state) && age(item.stateSince) > COURSE_THRESHOLDS.editStalledDays * DAY) {
          out.push({ ...base, kind: "EDIT_STALLED", severity: "warn", detail: `Sitting in editing for ${days(item.stateSince)} days — run Autopilot or finish it.` });
        }
    }
    // Dated on the calendar but not finished in time.
    if (item.scheduledAt && !ON_CALENDAR_STATES.has(item.state) && !LIVE_STATES.has(item.state) && !DEAD_STATES.has(item.state) && item.state !== "READY") {
      const hoursLeft = (item.scheduledAt.getTime() - now.getTime()) / HOUR;
      if (hoursLeft < 48) {
        out.push({
          ...base,
          since: item.scheduledAt,
          kind: "RESERVED_NOT_READY",
          severity: hoursLeft < 0 ? "critical" : "warn",
          detail:
            hoursLeft < 0
              ? `Was planned for ${fmtDayTime(item.scheduledAt, tz)} but isn't finished.`
              : `Planned for ${fmtDayTime(item.scheduledAt, tz)} and still ${item.state.toLowerCase().replace(/_/g, " ")}.`,
        });
      }
    }
  }
  for (const f of failures) {
    out.push({
      contentItemId: f.contentItemId,
      title: f.title,
      since: f.at,
      kind: "PUBLISH_FAILED",
      severity: "critical",
      detail: `${PLAN_PLATFORM_LABEL[f.platform as PlanPlatform] ?? f.platform} publish failed${f.message ? `: ${f.message}` : ""}.`,
    });
  }
  return out;
}

const STUCK_TITLE: Record<StuckKind, (t: string) => string> = {
  MISSED: (t) => `Missed post: ${t}`,
  PUBLISH_FAILED: (t) => `Publish failed: ${t}`,
  PUBLISH_STALLED: (t) => `Publishing stuck: ${t}`,
  QC_BLOCKED: (t) => `Quality gate blocked: ${t}`,
  RESEARCH_BLOCKED: (t) => `Claim blocked: ${t}`,
  FILMED_IDLE: (t) => `Upload footage: ${t}`,
  EDIT_STALLED: (t) => `Stalled in editing: ${t}`,
  RESERVED_NOT_READY: (t) => `Not ready for its date: ${t}`,
};
const STUCK_ACTION: Record<StuckKind, (id: string, ymd: string) => NudgeAction> = {
  MISSED: (id, ymd) => ({ kind: "link", label: "Reschedule", href: `/calendar?view=day&date=${ymd}&event=${id}` }),
  PUBLISH_FAILED: (id) => ({ kind: "link", label: "Open & retry", href: `/content/${id}` }),
  PUBLISH_STALLED: (id) => ({ kind: "link", label: "Open & retry", href: `/content/${id}` }),
  QC_BLOCKED: (id) => ({ kind: "link", label: "Review", href: `/content/${id}` }),
  RESEARCH_BLOCKED: (id) => ({ kind: "link", label: "Review", href: `/content/${id}` }),
  FILMED_IDLE: () => ({ kind: "link", label: "Upload", href: "/upload" }),
  EDIT_STALLED: (id) => ({ kind: "link", label: "Open", href: `/content/${id}` }),
  RESERVED_NOT_READY: (id) => ({ kind: "link", label: "Open", href: `/content/${id}` }),
};

function stuckNudges(stuck: StuckItem[], tz: string): Nudge[] {
  return stuck.map((s) => ({
    key: `stuck:${s.kind}:${s.contentItemId}`,
    severity: s.severity,
    bucket: s.severity === "critical" ? "today" : "week",
    priority: s.severity === "critical" ? (s.kind === "MISSED" || s.kind === "PUBLISH_FAILED" ? 1 : 3) : 25,
    title: STUCK_TITLE[s.kind](s.title),
    detail: s.detail,
    // Only time-bound problems get a "due"; for stuck-in-state items the age is in the detail (an
    // "overdue" label on "filmed 4 days ago" would read as a missed deadline).
    due: s.kind === "MISSED" || s.kind === "PUBLISH_FAILED" || s.kind === "RESERVED_NOT_READY" ? s.since : null,
    action: STUCK_ACTION[s.kind](s.contentItemId, ymdInTz(s.since, tz)),
  }));
}

const SEVERITY_RANK: Record<NudgeSeverity, number> = { critical: 0, warn: 1, info: 2 };

export function sortNudges(nudges: Nudge[]): Nudge[] {
  return [...nudges].sort(
    (a, b) =>
      a.priority - b.priority ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity) ||
      a.key.localeCompare(b.key),
  );
}

/** "Due today" / "Due Thu" / "2 days overdue" — shared by the course panel and /todo. */
export function dueLabel(due: Date | null, now: Date, tz: string): string | null {
  if (!due) return null;
  const d = diffDaysYmd(ymdInTz(now, tz), ymdInTz(due, tz));
  if (d < -1) return `${-d} days overdue`;
  if (d === -1) return "Since yesterday";
  if (d === 0) {
    const p = zonedParts(due, tz);
    return due < now ? "Overdue today" : `Today ${p.hour % 12 || 12}${p.minute ? `:${String(p.minute).padStart(2, "0")}` : ""}${p.hour < 12 ? "am" : "pm"}`;
  }
  if (d === 1) return "Tomorrow";
  if (d < 7) return due.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  return due.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
}
