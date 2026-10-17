import Link from "next/link";
import type { Nudge } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, Panel } from "../components/ui";
import { loadTodo } from "../../lib/todo-data";
import { CourseStatusPill, CoverageBars, NudgeRow } from "../calendar/nudges";

// To-do — everything that needs doing in one prioritized list: Stay-on-course nudges (gaps in
// the posting plan, pipeline deadlines worked back from lead times, stuck/missed/failed
// items), the NEEDS YOU decisions, platform connection problems, and missing setup. Grouped
// Today / This week / Setup; each item has one action and "Not today". Logic lives in
// packages/domain (course.ts, todo.ts). See docs/decisions-pending/calendar.md.

const GROUPS: { bucket: Nudge["bucket"]; title: string; empty: string }[] = [
  { bucket: "today", title: "Today", empty: "Nothing urgent today." },
  { bucket: "week", title: "This week", empty: "Nothing else this week." },
  { bucket: "setup", title: "Setup", empty: "Setup is complete." },
];

export default async function TodoPage({ searchParams }: { searchParams: Promise<{ calendarError?: string }> }) {
  await requireSession();
  const { calendarError } = await searchParams;
  const { course, todo, now, tz } = await loadTodo();

  return (
    <>
      <NavBar />
      <PageShell maxWidth={760}>
        <header className="mb-5">
          <p className="eyebrow mb-1">Stay on course</p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-2xl">To-do</h1>
            <CourseStatusPill status={course.status} />
          </div>
          <p className="mt-2 text-[15px] leading-snug text-[var(--color-text-muted)] sm:text-sm">{course.headline}</p>
        </header>

        {calendarError && (
          <Panel className="mb-4 !border-[var(--color-rose-500)]/40" padding="p-4">
            <p className="text-sm text-[var(--color-rose-400)]">{calendarError}</p>
          </Panel>
        )}

        {course.weeks.length > 0 && (
          <Panel className="mb-4" padding="p-4 sm:p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              {course.weeks.map((w) => (
                <CoverageBars key={w.weekStart} week={w} />
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
              <Link href="/calendar" className="link-quiet">
                Open calendar →
              </Link>
              <Link href="/calendar/plan" className="link-quiet">
                Posting plan →
              </Link>
              {course.streakWeeks > 0 && <span className="text-[var(--color-emerald-400)]">{course.streakWeeks}-week streak of fully-posted weeks</span>}
            </div>
          </Panel>
        )}

        <div className="flex flex-col gap-4">
          {GROUPS.map((g) => {
            const items = todo.nudges.filter((n) => n.bucket === g.bucket);
            return (
              <Panel key={g.bucket} padding="p-4 sm:p-5">
                <div className="mb-1 flex items-baseline justify-between">
                  <h2 className="text-[17px] font-semibold">{g.title}</h2>
                  <span className="text-[13px] text-[var(--color-text-faint)]">{items.length || ""}</span>
                </div>
                {items.length === 0 ? (
                  <p className="py-2 text-[14px] text-[var(--color-text-muted)]">{g.empty}</p>
                ) : (
                  <ul className="divide-y divide-[var(--color-border)]">
                    {items.map((n) => (
                      <NudgeRow key={n.key} nudge={n} now={now} tz={tz} back="/todo" />
                    ))}
                  </ul>
                )}
              </Panel>
            );
          })}
        </div>
        {todo.dismissedCount > 0 && (
          <p className="mt-4 text-center text-[12.5px] text-[var(--color-text-faint)]">
            {todo.dismissedCount} hidden for today — they come back tomorrow if they&apos;re still true.
          </p>
        )}
      </PageShell>
    </>
  );
}
