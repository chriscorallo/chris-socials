import Link from "next/link";
import { cookies } from "next/headers";
import { prisma, listUnscheduledReadyItems, parseYmd, ymdInTz, minutesInTz, mondayOfYmd, PLAN_PLATFORMS } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, Panel, Button } from "../components/ui";
import { parseView, viewRange, VIEW_COOKIE, type CalendarView } from "../../lib/calendar-views";
import { APP_TZ, loadAutopilotCandidates, loadCalendarEvents } from "../../lib/calendar-data";
import { loadTodo } from "../../lib/todo-data";
import { CalendarClient } from "./CalendarClient";
import { CourseStatusPill, CoverageBars, NudgeRow } from "./nudges";
import { runAutoFillWeek } from "./actions";
import type { Deadline } from "./views";

// Server Actions on this page run model calls synchronously (Auto-Fill) — allow up to the
// Vercel Fluid Compute ceiling instead of the platform default. See /docs/DECISIONS.md.
export const maxDuration = 300;

// Calendar — Month / Week / Day / List views (Apple/Google-style), URL-addressable
// (?view=month&date=2026-10-17; the old ?week=YYYY-MM-DD links still work), the chosen view
// remembered in a cookie. Shows every scheduled, published, failed and missed post, plus the
// posting plan's open slots as tappable placeholders; a "Stay on course" panel on top turns
// the plan-vs-reality gap into concrete next steps. Layout math: lib/calendar-views.ts; data
// gather: lib/calendar-data.ts; plan/course logic: packages/domain (posting-plan-core.ts,
// course.ts). See docs/decisions-pending/calendar.md.

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; week?: string; event?: string; calendarError?: string }>;
}) {
  await requireSession();
  const sp = await searchParams;
  const now = new Date();
  const today = ymdInTz(now, APP_TZ);

  const cookieView = parseView((await cookies()).get(VIEW_COOKIE)?.value);
  const legacyWeek = sp.week && parseYmd(sp.week) ? sp.week : null;
  const view: CalendarView = parseView(sp.view) ?? (legacyWeek ? "week" : cookieView ?? "month");
  const anchor = (sp.date && parseYmd(sp.date) ? sp.date : null) ?? legacyWeek ?? today;
  const range = viewRange(view, anchor);

  // Sequential — see /docs/DECISIONS.md (PGlite can't take concurrent queries).
  const { course, todo, plan } = await loadTodo(now);
  const ready = await listUnscheduledReadyItems(prisma);
  const readyPool = ready.map((r) => ({ id: r.id, title: r.title, state: r.currentState }));
  const events = await loadCalendarEvents({ startYmd: range.start, endYmd: range.end, now, tz: APP_TZ, plan, readyPool });
  const autopilot = readyPool.length === 0 ? await loadAutopilotCandidates() : [];

  const deadlines: Deadline[] = (course.pipeline?.steps ?? [])
    .filter((s) => s.stage !== "ready")
    .map((s) => ({ id: `${s.stage}`, ymd: ymdInTz(s.deadline, APP_TZ), label: s.label.replace(/ by .*$/, ""), atRisk: s.atRisk, href: s.href }));

  const defaultPlatforms = plan ? plan.cadences.filter((c) => c.enabled && c.postsPerWeek > 0).map((c) => c.platform) : [...PLAN_PLATFORMS];
  const back = `/calendar?view=${view}&date=${anchor}`;
  const topNudges = todo.nudges.slice(0, 4);

  return (
    <>
      <NavBar />
      <PageShell maxWidth={1360}>
        {sp.calendarError && (
          <Panel className="mb-4 !border-[var(--color-rose-500)]/40" padding="p-4">
            <p className="text-sm text-[var(--color-rose-400)]">{sp.calendarError}</p>
          </Panel>
        )}

        {/* Stay on course — status + this/next week coverage + the top next steps. Open by
            default when something needs attention; one line when on track. */}
        <details open={course.status !== "ON_TRACK"} className="panel mb-5 min-w-0">
          <summary className="flex min-h-[56px] cursor-pointer items-center gap-3 rounded-2xl px-4 py-3 active:bg-white/[0.03] sm:px-5">
            <CourseStatusPill status={course.status} />
            <p className="min-w-0 flex-1 truncate text-[14px] text-[var(--color-text-muted)]">
              <span className="font-semibold text-[var(--color-text)]">Stay on course</span>
              <span className="hidden sm:inline"> · {course.headline}</span>
            </p>
            {course.streakWeeks > 0 && <span className="hidden shrink-0 text-[12.5px] text-[var(--color-emerald-400)] sm:inline">{course.streakWeeks}-week streak</span>}
            <svg width="14" height="9" viewBox="0 0 14 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="chevron shrink-0 text-[var(--color-text-faint)]" aria-hidden>
              <path d="m1 1.5 6 6 6-6" />
            </svg>
          </summary>
          <div className="grid gap-5 px-4 pb-4 sm:px-5 sm:pb-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div className="min-w-0">
              <p className="text-[14.5px] leading-snug text-[var(--color-text)] sm:hidden">{course.headline}</p>
              {course.weeks.length > 0 ? (
                <div className="mt-3 flex flex-col gap-4 sm:mt-0">
                  {course.weeks.map((w) => (
                    <CoverageBars key={w.weekStart} week={w} />
                  ))}
                  {course.pipeline && course.pipeline.needed > 0 && (
                    <p className="hidden text-[13px] leading-snug text-[var(--color-text-muted)] sm:block">{course.pipeline.summary}</p>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-[14px] text-[var(--color-text-muted)]">Set how often you post on each platform and the calendar will show open slots and keep you on pace.</p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href="/calendar/plan" className="btn btn-ghost !min-h-[38px] !text-[13px]">
                  {plan ? "Posting plan" : "Set posting plan"}
                </Link>
                <Link href="/todo" className="btn btn-ghost !min-h-[38px] !text-[13px]">
                  Full to-do list{todo.nudges.length ? ` (${todo.nudges.length})` : ""}
                </Link>
              </div>
            </div>
            <div className="min-w-0">
              {topNudges.length === 0 ? (
                <p className="text-[14px] text-[var(--color-text-muted)]">Nothing needs you right now.</p>
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {topNudges.map((n) => (
                    <NudgeRow key={n.key} nudge={n} now={now} tz={APP_TZ} back={back} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </details>

        <CalendarClient
          view={view}
          anchor={anchor}
          today={today}
          nowMin={minutesInTz(now, APP_TZ)}
          events={events}
          deadlines={deadlines}
          readyPool={readyPool}
          autopilot={autopilot}
          defaultPlatforms={defaultPlatforms}
          openEventId={sp.event ?? null}
        />

        <Panel className="mt-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="eyebrow mb-1">Auto-Fill Week</p>
              <p className="text-[14px] leading-snug text-[var(--color-text-muted)] sm:text-[13px]">
                The Scheduler Agent places every unscheduled READY video — aiming at your posting plan&apos;s open slots — using
                topic/format spacing, funnel role, experiments, and platform quota.{" "}
                <span className="text-[var(--color-text)]">
                  {readyPool.length} video{readyPool.length === 1 ? "" : "s"} waiting to be placed.
                </span>
              </p>
            </div>
            <form action={runAutoFillWeek} className="shrink-0">
              <input type="hidden" name="back" value={back} />
              <input type="hidden" name="week" value={mondayOfYmd(anchor)} />
              <Button tone="primary" disabled={readyPool.length === 0} className="w-full sm:w-auto" pendingLabel="Filling the week…">
                Auto-Fill Week
              </Button>
            </form>
          </div>
          {readyPool.length > 0 && (
            <ul className="mt-4 flex flex-wrap gap-2">
              {readyPool.slice(0, 30).map((item) => (
                <li key={item.id} className="min-w-0 max-w-full">
                  <Link
                    href={`/content/${item.id}`}
                    className="flex min-h-[40px] max-w-full items-center rounded-full border border-[var(--color-border)] bg-white/[0.03] px-3.5 text-[14px] hover:bg-white/[0.06] active:bg-white/[0.08] sm:text-xs"
                  >
                    <span className="truncate">{item.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </PageShell>
    </>
  );
}
