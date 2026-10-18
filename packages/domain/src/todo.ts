import type { PrismaClient } from "@prisma/client";
import { computeCourse, sortNudges, type CourseFailure, type CourseInput, type CourseItem, type CourseResult, type Nudge } from "./course";
import { getActivePostingPlan, listDismissedNudgeKeys } from "./posting-plan";
import { PLAN_PLATFORM_LABEL, type PlanPlatform, type PostingPlanData } from "./posting-plan-core";
import { getNeedsYouQueue, type NeedsYouEntry } from "./needs-you";
import { listPlatformConnectionSummaries, type PlatformConnectionSummary } from "./platform-credential";
import { isEnabled } from "./feature-flags";
import { ymdInTz } from "./tz";
import { ANTHROPIC_CREDIT_ERROR_RE } from "./model-call-log";
import { queryAll } from "./db-concurrency";

/**
 * The unified to-do list ("anything else that needs to be done"): Stay-on-course nudges
 * (course.ts) + the NEEDS YOU queue (needs-you.ts) + platform connection problems + missing
 * setup, each with one clear action, prioritized, and dismissible for the rest of the day.
 *
 * `buildTodoList` is pure (tested with fixed inputs); `loadCourseInput` / `getTodoData` are
 * the DB gathers. Independent queries go through queryAll (parallel on Neon, sequential on
 * PGlite — see db-concurrency.ts and /docs/DECISIONS.md's PGlite entries).
 */

// ---- DB gather for computeCourse --------------------------------------------------------

export async function loadCourseInput(prisma: PrismaClient, opts: { now: Date; tz: string; plan?: PostingPlanData | null }): Promise<CourseInput> {
  // All independent (the transitions query filters by the same "not cancelled" condition via
  // the relation instead of an id list, so it needn't wait for `rows`) — one round trip on Neon.
  const [plan, rows, lastTransitions, entries, pubs] = await queryAll([
    () => (opts.plan !== undefined ? Promise.resolve(opts.plan) : getActivePostingPlan(prisma)),
    () =>
      prisma.contentItem.findMany({
        where: { currentState: { not: "CANCELLED" } },
        select: { id: true, title: true, currentState: true, updatedAt: true },
      }),
    () =>
      prisma.contentStateTransition.findMany({
        where: { contentItem: { currentState: { not: "CANCELLED" } } },
        orderBy: [{ contentItemId: "asc" }, { createdAt: "desc" }],
        distinct: ["contentItemId"],
        select: { contentItemId: true, toState: true, createdAt: true },
      }),
    () => prisma.scheduleEntry.findMany({ select: { contentItemId: true, scheduledDate: true, targetPlatforms: true } }),
    () =>
      prisma.publication.findMany({
        select: { contentItemId: true, platform: true, attempt: true, status: true, publishedAt: true, createdAt: true, errorMessage: true },
        orderBy: [{ attempt: "desc" }, { createdAt: "desc" }],
      }),
  ] as const);

  const since = new Map(lastTransitions.map((t) => [t.contentItemId, t]));
  const entryBy = new Map(entries.map((e) => [e.contentItemId, e]));
  const titleBy = new Map(rows.map((r) => [r.id, r.title]));

  // Latest attempt per (item, platform) decides failure; any SUCCESS/DRAFT counts as live.
  const latest = new Map<string, (typeof pubs)[number]>();
  const live = new Map<string, { at: Date; platforms: Set<string> }>();
  for (const p of pubs) {
    const k = `${p.contentItemId}:${p.platform}`;
    if (!latest.has(k)) latest.set(k, p);
    if (p.status === "SUCCESS" || p.status === "DRAFT") {
      const at = p.publishedAt ?? p.createdAt;
      const cur = live.get(p.contentItemId);
      if (!cur) live.set(p.contentItemId, { at, platforms: new Set([p.platform]) });
      else {
        cur.platforms.add(p.platform);
        if (at < cur.at) cur.at = at;
      }
    }
  }
  const failures: CourseFailure[] = [];
  for (const p of latest.values()) {
    if (p.status !== "FAILED" || !titleBy.has(p.contentItemId)) continue;
    failures.push({ contentItemId: p.contentItemId, title: titleBy.get(p.contentItemId)!, platform: p.platform, at: p.createdAt, message: p.errorMessage });
  }

  const items: CourseItem[] = rows.map((r) => {
    const t = since.get(r.id);
    const e = entryBy.get(r.id);
    const l = live.get(r.id);
    return {
      id: r.id,
      title: r.title,
      state: r.currentState,
      stateSince: t && t.toState === r.currentState ? t.createdAt : r.updatedAt,
      scheduledAt: e?.scheduledDate ?? null,
      targetPlatforms: ((e?.targetPlatforms as string[] | undefined) ?? []).map(String),
      publishedAt: l?.at ?? null,
      publishedPlatforms: l ? [...l.platforms] : [],
    };
  });

  return { plan, items, failures, now: opts.now, tz: opts.tz };
}

// ---- Pure build -------------------------------------------------------------------------

export interface SetupSignals {
  connections: PlatformConnectionSummary[];
  autoPublishEnabled: boolean;
  lastScheduledPublishRunAt: Date | null;
  anthropicKeyConfigured: boolean;
  /** Latest model-call failure that looks like an exhausted credit balance, if not since recovered. */
  anthropicCreditError: { at: Date; message: string } | null;
  voiceSamplesEmpty: boolean;
  /** SCHEDULED items due in the next 7 days, per platform. */
  upcomingByPlatform: Record<string, number>;
}

export interface TodoList {
  nudges: Nudge[];
  dismissedCount: number;
}

const NEEDS_YOU_KEPT = new Set(["STRATEGY_DECISION", "SUBJECTIVE_CHOICE", "UNCERTAINTY"]);

export function buildTodoList(input: {
  course: CourseResult;
  plan: PostingPlanData | null;
  needsYou: NeedsYouEntry[];
  setup: SetupSignals;
  dismissed: Set<string>;
  now: Date;
}): TodoList {
  const { course, plan, needsYou, setup, dismissed, now } = input;
  const out: Nudge[] = [...course.nudges];

  // NEEDS YOU — QC/claims/platform failures are already course "stuck" nudges; keep the rest.
  for (const e of needsYou) {
    if (!NEEDS_YOU_KEPT.has(e.category)) continue;
    out.push({
      key: `needs:${e.category}:${e.href}:${e.title.slice(0, 60)}`,
      severity: e.category === "STRATEGY_DECISION" ? "warn" : "info",
      bucket: "week",
      priority: e.category === "STRATEGY_DECISION" ? 30 : 45,
      title: e.title,
      detail: e.description,
      due: null,
      action: { kind: "link", label: "Decide", href: e.href },
    });
  }

  // Connections — only the platforms the plan actually posts to (all three with no plan).
  const planned = new Set(plan ? plan.cadences.filter((c) => c.enabled && c.postsPerWeek > 0).map((c) => c.platform) : ["INSTAGRAM", "TIKTOK", "YOUTUBE"]);
  for (const c of setup.connections) {
    if (!planned.has(c.platform as PlanPlatform)) continue;
    const label = PLAN_PLATFORM_LABEL[c.platform as PlanPlatform] ?? c.platform;
    const dueSoon = (setup.upcomingByPlatform[c.platform] ?? 0) > 0;
    const perWeek = plan?.cadences.find((x) => x.platform === c.platform)?.postsPerWeek;
    if (!c.connected || c.expired) {
      out.push({
        key: `setup:connect:${c.platform}`,
        severity: dueSoon ? "critical" : "warn",
        bucket: dueSoon ? "today" : "setup",
        priority: dueSoon ? 2 : 52,
        title: c.connected ? `Reconnect ${label} — the login expired` : `Connect ${label}`,
        detail: dueSoon
          ? `${setup.upcomingByPlatform[c.platform]} scheduled post(s) can't publish there until it's connected.`
          : perWeek
            ? `Your plan posts ${perWeek}×/week there.`
            : undefined,
        due: null,
        action: { kind: "link", label: c.connected ? "Reconnect" : "Connect", href: "/settings/connections" },
      });
    } else if (c.expiresAt && !c.hasRefreshToken && c.expiresAt.getTime() - now.getTime() < 7 * 86_400_000) {
      out.push({
        key: `setup:expiring:${c.platform}`,
        severity: "warn",
        bucket: "setup",
        priority: 54,
        title: `${label} login expires soon`,
        detail: `Expires ${c.expiresAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })} — reconnect to keep auto-publishing.`,
        due: c.expiresAt,
        action: { kind: "link", label: "Reconnect", href: "/settings/connections" },
      });
    }
  }

  const upcomingTotal = Object.values(setup.upcomingByPlatform).reduce((a, b) => a + b, 0);
  if (setup.autoPublishEnabled) {
    const stale = !setup.lastScheduledPublishRunAt || now.getTime() - setup.lastScheduledPublishRunAt.getTime() > 24 * 3_600_000;
    if (stale) {
      out.push({
        key: "setup:cron",
        severity: "critical",
        bucket: upcomingTotal > 0 ? "today" : "setup",
        priority: upcomingTotal > 0 ? 4 : 51,
        title: "Scheduled publishing hasn't run in 24h",
        detail: "Auto-publish is on, but no scheduled-publish job has run — check the GitHub Actions cron (CRON_SECRET + APP_BASE_URL).",
        due: null,
        action: { kind: "link", label: "Check", href: "/settings/connections" },
      });
    }
  } else if (upcomingTotal > 0) {
    out.push({
      key: "setup:autopublish-off",
      severity: "info",
      bucket: "setup",
      priority: 56,
      title: "Auto-publish is off",
      detail: `${upcomingTotal} scheduled post(s) in the next week won't go out on their own — publish each by hand or turn auto-publish on.`,
      due: null,
      action: { kind: "link", label: "Settings", href: "/settings/connections" },
    });
  }

  if (setup.anthropicCreditError) {
    out.push({
      key: "setup:anthropic-credit",
      severity: "critical",
      bucket: "setup",
      priority: 50,
      title: "Anthropic credit looks exhausted",
      detail: `The last AI call failed: “${setup.anthropicCreditError.message.slice(0, 140)}”. Tap More → AI credit to top up — scripts, edits and Auto-Fill stop until then.`,
      due: null,
    });
  } else if (!setup.anthropicKeyConfigured) {
    out.push({
      key: "setup:anthropic-key",
      severity: "warn",
      bucket: "setup",
      priority: 53,
      title: "AI agents are off",
      detail: "ANTHROPIC_API_KEY isn't set — research, scripts, edit planning and Auto-Fill Week need it.",
      due: null,
    });
  }

  if (setup.voiceSamplesEmpty) {
    out.push({
      key: "setup:voice-samples",
      severity: "info",
      bucket: "setup",
      priority: 58,
      title: "Add your voice samples",
      detail: "brand/VOICE_SAMPLES.md is empty. Paste 3–8 real transcripts of you talking — every script agent writes closer to your voice once it has them.",
      due: null,
    });
  }

  const visible = out.filter((n) => !dismissed.has(n.key));
  return { nudges: sortNudges(visible), dismissedCount: out.length - visible.length };
}

// ---- DB gather for the whole list -------------------------------------------------------


export async function getTodoData(
  prisma: PrismaClient,
  opts: { now: Date; tz: string; anthropicKeyConfigured: boolean; voiceSamplesEmpty: boolean },
): Promise<{ course: CourseResult; todo: TodoList; plan: PostingPlanData | null; today: string }> {
  const { now, tz } = opts;
  const today = ymdInTz(now, tz);
  // Independent gathers — together on Neon, one at a time on PGlite (queryAll). The posting
  // plan is loaded inside loadCourseInput's own batch and read back from its result.
  const [input, needsYou, connections, autoPublishEnabled, lastRun, recentFail, dismissed] = await queryAll([
    () => loadCourseInput(prisma, { now, tz }),
    () => getNeedsYouQueue(prisma, { limit: 12 }),
    () => listPlatformConnectionSummaries(prisma, now),
    () => isEnabled(prisma, "publishing.scheduled_auto"),
    () => prisma.jobRun.findFirst({ where: { kind: "scheduled-publish" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
    () =>
      prisma.modelCallLog.findFirst({
        where: { success: false, createdAt: { gte: new Date(now.getTime() - 3 * 86_400_000) } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, errorMessage: true },
      }),
    () => listDismissedNudgeKeys(prisma, today),
  ] as const);
  const plan = input.plan;
  const course = computeCourse(input);
  let anthropicCreditError: SetupSignals["anthropicCreditError"] = null;
  if (recentFail?.errorMessage && ANTHROPIC_CREDIT_ERROR_RE.test(recentFail.errorMessage)) {
    const recovered = await prisma.modelCallLog.findFirst({ where: { success: true, createdAt: { gt: recentFail.createdAt } }, select: { id: true } });
    if (!recovered) anthropicCreditError = { at: recentFail.createdAt, message: recentFail.errorMessage };
  }

  const weekAhead = new Date(now.getTime() + 7 * 86_400_000);
  const upcomingByPlatform: Record<string, number> = {};
  for (const item of input.items) {
    if (item.state !== "SCHEDULED" || !item.scheduledAt || item.scheduledAt > weekAhead) continue;
    for (const p of item.targetPlatforms) upcomingByPlatform[p] = (upcomingByPlatform[p] ?? 0) + 1;
  }

  const todo = buildTodoList({
    course,
    plan,
    needsYou: needsYou.entries,
    setup: {
      connections,
      autoPublishEnabled,
      lastScheduledPublishRunAt: lastRun?.startedAt ?? null,
      anthropicKeyConfigured: opts.anthropicKeyConfigured,
      anthropicCreditError,
      voiceSamplesEmpty: opts.voiceSamplesEmpty,
      upcomingByPlatform,
    },
    dismissed,
    now,
  });
  return { course, todo, plan, today };
}
