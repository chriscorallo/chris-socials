import Link from "next/link";
import { prisma, listScheduleEntries, listUnscheduledReadyItems } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel, Badge, EmptyState, contentStateTone } from "../components/ui";
import { mondayOf, toWeekParam, parseWeekParam, toDatetimeLocal } from "../../lib/calendar-week";
import { placeOnCalendar, runAutoFillWeek } from "./actions";

// Server Actions on this page run model calls / ffmpeg synchronously — allow up to the
// Vercel Fluid Compute ceiling instead of the platform default. See /docs/DECISIONS.md.
export const maxDuration = 300;

// Real week-grid Calendar — spec §9 step 19 ("Auto-Fill Week") and §20 (CALENDAR is one of
// five primary nav items). Rebuilt from a flat date-grouped list into what the spec actually
// describes: a week at a time, real time slots (not just dates), a pool of unplaced READY
// content to draw from, and a wired-up "Auto-Fill Week" that actually calls the Scheduler
// Agent (packages/agents/src/scheduler-agent.ts existed since an earlier phase but had zero
// callers anywhere in the app until this page — see /docs/DECISIONS.md). The date-math
// helpers live in lib/calendar-week.ts, not here — see that file and its test for the
// week-navigation bug (and fix) they exist to pin down.
const ALL_PLATFORMS = ["INSTAGRAM", "TIKTOK", "YOUTUBE"] as const;
const MAX_PER_DAY = 8;
const MAX_POOL_SHOWN = 30;
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; calendarError?: string }>;
}) {
  await requireSession();
  const { week, calendarError } = await searchParams;

  const requestedWeek = week ? parseWeekParam(week) : null;
  const weekStart = mondayOf(requestedWeek ?? new Date());
  const weekParam = toWeekParam(weekStart);
  const prevWeekParam = toWeekParam(new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000));
  const nextWeekParam = toWeekParam(new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000));
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Only ever one week's worth of entries rendered at a time — the structural fix for the
  // "43,000px tall page" problem found in the previous pass (/docs/DECISIONS.md's list-page
  // bounding entry), not just a band-aid cap on top of an unbounded query.
  const allEntries = await listScheduleEntries(prisma);
  const weekEntries = allEntries.filter((e) => e.scheduledDate >= weekStart && e.scheduledDate < weekEnd);
  const unscheduled = await listUnscheduledReadyItems(prisma);

  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(weekStart.getTime() + i * 24 * 60 * 60 * 1000);
    const entries = weekEntries
      .filter((e) => e.scheduledDate.toDateString() === date.toDateString())
      .sort((a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime());
    return { date, entries };
  });

  const isCurrentWeek = mondayOf(new Date()).getTime() === weekStart.getTime();

  return (
    <>
      <NavBar />
      <PageShell maxWidth={1360}>
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <PageHeader
            eyebrow="Distribution"
            title="Calendar"
            description={`Week of ${weekStart.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}${isCurrentWeek ? " (this week)" : ""}`}
          />
          <div className="mb-1 flex items-center gap-2">
            <Link href={`/calendar?week=${prevWeekParam}`} className="btn btn-ghost">
              ← Prev
            </Link>
            {!isCurrentWeek && (
              <Link href={`/calendar?week=${toWeekParam(mondayOf(new Date()))}`} className="btn btn-ghost">
                Today
              </Link>
            )}
            <Link href={`/calendar?week=${nextWeekParam}`} className="btn btn-ghost">
              Next →
            </Link>
          </div>
        </div>

        {calendarError && (
          <Panel className="mb-5 !border-[var(--color-rose-500)]/40">
            <p className="text-sm text-[var(--color-rose-400)]">{calendarError}</p>
          </Panel>
        )}

        <Panel className="mb-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="eyebrow mb-1">Auto-Fill Week</p>
              <p className="text-[13px] text-[var(--color-text-muted)]">
                Spec §9 step 19 — the Scheduler Agent places every unscheduled READY item using
                topic/format spacing, funnel role, experiments, and platform quota. Requires
                ANTHROPIC_API_KEY. {unscheduled.length} item{unscheduled.length === 1 ? "" : "s"} waiting to be
                placed.
              </p>
            </div>
            <form action={runAutoFillWeek}>
              <input type="hidden" name="week" value={weekParam} />
              <button type="submit" className="btn btn-primary" disabled={unscheduled.length === 0}>
                Auto-Fill Week
              </button>
            </form>
          </div>
        </Panel>

        <div className="grid grid-cols-7 gap-3 overflow-x-auto">
          {days.map(({ date, entries }) => {
            const isToday = date.toDateString() === new Date().toDateString();
            return (
              <div key={date.toISOString()} className="min-w-[170px]">
                <Panel padding="p-0" className={isToday ? "panel-action" : ""}>
                  <div className="border-b border-[var(--color-border)] px-3 py-2.5 text-center">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">
                      {DAY_LABELS[(date.getDay() + 6) % 7]}
                    </p>
                    <p className="text-sm font-semibold">{date.getDate()}</p>
                  </div>
                  <div className="flex flex-col gap-2 p-2">
                    {entries.slice(0, MAX_PER_DAY).map((entry) => (
                      <details key={entry.id} className="group rounded-lg border border-[var(--color-border)] bg-white/[0.03]">
                        <summary className="cursor-pointer list-none px-2.5 py-2">
                          <p className="text-[11px] text-[var(--color-text-faint)]">
                            {entry.scheduledDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                          </p>
                          <p className="truncate text-[13px] font-medium leading-snug">{entry.contentItem.title}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {(entry.targetPlatforms as string[]).map((p) => (
                              <Badge key={p} tone="violet">
                                {p.slice(0, 2)}
                              </Badge>
                            ))}
                            <Badge tone={contentStateTone(entry.contentItem.currentState)}>{entry.contentItem.currentState}</Badge>
                          </div>
                        </summary>
                        <div className="border-t border-[var(--color-border)] p-2.5">
                          <Link href={`/content/${entry.contentItemId}`} className="link-quiet text-xs underline">
                            Open item →
                          </Link>
                          <form action={placeOnCalendar} className="mt-2 flex flex-col gap-2">
                            <input type="hidden" name="contentItemId" value={entry.contentItemId} />
                            <input type="hidden" name="week" value={weekParam} />
                            <input
                              type="datetime-local"
                              name="scheduledDate"
                              defaultValue={toDatetimeLocal(entry.scheduledDate)}
                              className="field-input !py-1 !text-xs"
                            />
                            <div className="flex flex-wrap gap-2 text-[11px]">
                              {ALL_PLATFORMS.map((p) => (
                                <label key={p} className="flex items-center gap-1">
                                  <input
                                    type="checkbox"
                                    name="targetPlatforms"
                                    value={p}
                                    defaultChecked={(entry.targetPlatforms as string[]).includes(p)}
                                  />
                                  {p.slice(0, 2)}
                                </label>
                              ))}
                            </div>
                            <button type="submit" className="btn btn-ghost !py-1 text-[11px]">
                              Reschedule
                            </button>
                          </form>
                        </div>
                      </details>
                    ))}
                    {entries.length > MAX_PER_DAY && (
                      <p className="px-1 text-[11px] text-[var(--color-text-faint)]">
                        +{entries.length - MAX_PER_DAY} more
                      </p>
                    )}

                    {unscheduled.length > 0 && (
                      <details className="rounded-lg border border-dashed border-[var(--color-border-strong)]">
                        <summary className="cursor-pointer list-none px-2.5 py-2 text-center text-[11px] text-[var(--color-text-faint)]">
                          + Add
                        </summary>
                        <form action={placeOnCalendar} className="flex flex-col gap-2 border-t border-[var(--color-border)] p-2.5">
                          <input type="hidden" name="week" value={weekParam} />
                          <select name="contentItemId" required className="field-input !py-1 !text-xs">
                            <option value="">Pick a READY item…</option>
                            {unscheduled.slice(0, MAX_POOL_SHOWN).map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.title}
                              </option>
                            ))}
                          </select>
                          <input
                            type="datetime-local"
                            name="scheduledDate"
                            defaultValue={toDatetimeLocal(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0))}
                            className="field-input !py-1 !text-xs"
                          />
                          <div className="flex flex-wrap gap-2 text-[11px]">
                            {ALL_PLATFORMS.map((p) => (
                              <label key={p} className="flex items-center gap-1">
                                <input type="checkbox" name="targetPlatforms" value={p} />
                                {p.slice(0, 2)}
                              </label>
                            ))}
                          </div>
                          <button type="submit" className="btn btn-primary !py-1 text-[11px]">
                            Place
                          </button>
                        </form>
                      </details>
                    )}
                  </div>
                </Panel>
              </div>
            );
          })}
        </div>

        {unscheduled.length > 0 && (
          <Panel className="mt-5">
            <p className="eyebrow mb-1">Unscheduled READY pool</p>
            <p className="mb-3 text-[13px] text-[var(--color-text-muted)]">
              Passed every hard gate, nowhere on the calendar yet. Place one via any day's
              &quot;+ Add,&quot; or run Auto-Fill Week above.
            </p>
            <ul className="flex flex-wrap gap-2">
              {unscheduled.slice(0, MAX_POOL_SHOWN).map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/content/${item.id}`}
                    className="inline-block rounded-full border border-[var(--color-border)] bg-white/[0.03] px-3 py-1 text-xs hover:bg-white/[0.06]"
                  >
                    {item.title}
                  </Link>
                </li>
              ))}
            </ul>
            {unscheduled.length > MAX_POOL_SHOWN && (
              <p className="mt-3 text-xs text-[var(--color-text-faint)]">
                +{unscheduled.length - MAX_POOL_SHOWN} more — see Content.
              </p>
            )}
          </Panel>
        )}

        {weekEntries.length === 0 && unscheduled.length === 0 && (
          <Panel className="mt-5">
            <EmptyState>
              Nothing scheduled this week and nothing READY to place yet — items become
              placeable once they pass every hard gate (see a content item&apos;s own page).
            </EmptyState>
          </Panel>
        )}
      </PageShell>
    </>
  );
}
