import Link from "next/link";
import { prisma, listScheduleEntries, listUnscheduledReadyItems, FINISHING_EDIT_STATES } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel, Badge, Button, EmptyState, contentStateTone, stateLabel } from "../components/ui";
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
//
// Mobile: the same markup renders as a day-by-day agenda with a sticky, swipeable day strip
// on phones, and as the 7-column week grid from lg up — see
// /docs/decisions-pending/mobile-app.md.
const ALL_PLATFORMS = ["INSTAGRAM", "TIKTOK", "YOUTUBE"] as const;
const MAX_PER_DAY = 8;
const MAX_POOL_SHOWN = 30;
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PLATFORM_SHORT: Record<string, string> = { INSTAGRAM: "IG", TIKTOK: "TT", YOUTUBE: "YT" };
// Scheduled items link straight into the finishing editor (app/content/[id]/edit).
const EDITABLE_STATES: ReadonlySet<string> = FINISHING_EDIT_STATES;

function dayId(date: Date) {
  return `day-${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

// Platform toggles shared by the reschedule + add forms: thumb-sized, whole tile tappable.
function PlatformChecks({ checked }: { checked: (p: string) => boolean }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {ALL_PLATFORMS.map((p) => (
        <label
          key={p}
          className="flex min-h-[44px] cursor-pointer items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-white/[0.03] px-2 text-[13px] has-[:checked]:border-[var(--color-gold-500)]/60 has-[:checked]:bg-[var(--color-gold-500)]/10"
        >
          <input type="checkbox" name="targetPlatforms" value={p} defaultChecked={checked(p)} />
          {PLATFORM_SHORT[p]}
        </label>
      ))}
    </div>
  );
}

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
  const todayKey = new Date().toDateString();

  return (
    <>
      <NavBar />
      <PageShell maxWidth={1360}>
        <PageHeader
          eyebrow="Distribution"
          title="Calendar"
          description={`Week of ${weekStart.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}${isCurrentWeek ? " (this week)" : ""}`}
          actions={
            <>
              <Link href={`/calendar?week=${prevWeekParam}`} className="btn btn-ghost !px-4" aria-label="Previous week">
                ‹<span className="hidden sm:inline"> Prev</span>
              </Link>
              {!isCurrentWeek && (
                <Link href={`/calendar?week=${toWeekParam(mondayOf(new Date()))}`} className="btn btn-ghost">
                  Today
                </Link>
              )}
              <Link href={`/calendar?week=${nextWeekParam}`} className="btn btn-ghost !px-4" aria-label="Next week">
                <span className="hidden sm:inline">Next </span>›
              </Link>
            </>
          }
        />

        {calendarError && (
          <Panel className="mb-5 !border-[var(--color-rose-500)]/40">
            <p className="text-sm text-[var(--color-rose-400)]">{calendarError}</p>
          </Panel>
        )}

        {/* Phones/tablets: a day strip that jumps to each day in the agenda below. Sticks
            under the top bar so the whole week is always one tap away. */}
        <nav
          aria-label="Days this week"
          className="sticky z-30 mb-4 flex gap-1.5 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-ink)_94%,transparent)] py-2 backdrop-blur-xl lg:hidden"
          style={{
            top: "calc(var(--safe-top) + 48px)",
            marginLeft: "calc(-1 * var(--gutter))",
            marginRight: "calc(-1 * var(--gutter))",
            paddingLeft: "var(--gutter)",
            paddingRight: "var(--gutter)",
          }}
        >
          {days.map(({ date, entries }) => {
            const isToday = date.toDateString() === todayKey;
            return (
              <a
                key={date.toISOString()}
                href={`#${dayId(date)}`}
                className={`flex min-h-[58px] min-w-0 flex-1 flex-col items-center justify-center rounded-xl border active:opacity-70 ${
                  isToday
                    ? "border-[var(--color-gold-500)]/60 bg-[var(--color-gold-500)]/10 text-[var(--color-gold-400)]"
                    : "border-[var(--color-border)] bg-white/[0.03]"
                }`}
              >
                <span className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{DAY_LABELS[(date.getDay() + 6) % 7]}</span>
                <span className="text-[17px] font-semibold leading-tight">{date.getDate()}</span>
                <span className="mt-0.5 flex h-1.5 items-center gap-0.5" aria-label={`${entries.length} scheduled`}>
                  {entries.slice(0, 3).map((e) => (
                    <span key={e.id} className="h-1 w-1 rounded-full bg-current opacity-80" />
                  ))}
                </span>
              </a>
            );
          })}
        </nav>

        <Panel className="mb-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="eyebrow mb-1">Auto-Fill Week</p>
              <p className="text-[14px] leading-snug text-[var(--color-text-muted)] sm:text-[13px]">
                The Scheduler Agent places every unscheduled READY item using topic/format spacing,
                funnel role, experiments, and platform quota.{" "}
                <span className="text-[var(--color-text)]">
                  {unscheduled.length} item{unscheduled.length === 1 ? "" : "s"} waiting to be placed.
                </span>
              </p>
            </div>
            <form action={runAutoFillWeek} className="shrink-0">
              <input type="hidden" name="week" value={weekParam} />
              <Button tone="primary" disabled={unscheduled.length === 0} className="w-full sm:w-auto" pendingLabel="Filling the week…">
                Auto-Fill Week
              </Button>
            </form>
          </div>
        </Panel>

        {/* One markup, two layouts: a vertical day-by-day agenda on phones, the 7-column week
            grid from lg up. */}
        <div className="flex flex-col gap-3 lg:grid lg:grid-cols-7">
          {days.map(({ date, entries }) => {
            const isToday = date.toDateString() === todayKey;
            return (
              <div key={date.toISOString()} id={dayId(date)} className="min-w-0" style={{ scrollMarginTop: "calc(var(--safe-top) + 48px + 86px)" }}>
                <Panel padding="p-0" className={isToday ? "panel-action" : ""}>
                  <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3 lg:flex-col lg:justify-center lg:gap-0 lg:px-3 lg:py-2.5">
                    <p className="text-[15px] font-semibold lg:hidden">
                      {date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
                    </p>
                    <div className="hidden text-center lg:block">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">
                        {DAY_LABELS[(date.getDay() + 6) % 7]}
                      </p>
                      <p className="text-sm font-semibold">{date.getDate()}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 lg:hidden">
                      {isToday && <Badge tone="gold">Today</Badge>}
                      <span className="text-[13px] text-[var(--color-text-faint)]">
                        {entries.length === 0 ? "Nothing yet" : `${entries.length} post${entries.length === 1 ? "" : "s"}`}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 p-2.5 lg:p-2">
                    {entries.slice(0, MAX_PER_DAY).map((entry) => (
                      <details key={entry.id} className="rounded-xl border border-[var(--color-border)] bg-white/[0.03]">
                        <summary className="flex min-h-[56px] cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 active:bg-white/[0.04] lg:block lg:px-2.5 lg:py-2">
                          <p className="w-[4.25rem] shrink-0 pt-0.5 text-[13px] font-medium text-[var(--color-gold-400)] lg:w-auto lg:pt-0 lg:text-[11px] lg:font-normal lg:text-[var(--color-text-faint)]">
                            {entry.scheduledDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                          </p>
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 text-[15px] font-medium leading-snug lg:text-[13px]">{entry.contentItem.title}</p>
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {(entry.targetPlatforms as string[]).map((p) => (
                                <Badge key={p} tone="violet">
                                  {PLATFORM_SHORT[p] ?? p}
                                </Badge>
                              ))}
                              <Badge tone={contentStateTone(entry.contentItem.currentState)}>{stateLabel(entry.contentItem.currentState)}</Badge>
                            </div>
                          </div>
                          <svg width="12" height="8" viewBox="0 0 14 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="chevron mt-1.5 shrink-0 text-[var(--color-text-faint)] lg:hidden" aria-hidden>
                            <path d="m1 1.5 6 6 6-6" />
                          </svg>
                        </summary>
                        <div className="border-t border-[var(--color-border)] p-3 lg:p-2.5">
                          <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
                            <Link href={`/content/${entry.contentItemId}`} className="btn btn-ghost !px-3 !text-[13px]">
                              Open item
                            </Link>
                            {EDITABLE_STATES.has(entry.contentItem.currentState) && (
                              <Link href={`/content/${entry.contentItemId}/edit`} className="btn btn-ghost !px-3 !text-[13px] !text-[var(--color-gold-400)]">
                                Edit video
                              </Link>
                            )}
                          </div>
                          <form action={placeOnCalendar} className="mt-3 flex flex-col gap-2">
                            <input type="hidden" name="contentItemId" value={entry.contentItemId} />
                            <input type="hidden" name="week" value={weekParam} />
                            <label className="block">
                              <span className="field-label">Date &amp; time</span>
                              <input
                                type="datetime-local"
                                name="scheduledDate"
                                defaultValue={toDatetimeLocal(entry.scheduledDate)}
                                className="field-input"
                              />
                            </label>
                            <PlatformChecks checked={(p) => (entry.targetPlatforms as string[]).includes(p)} />
                            <Button className="w-full !text-[13px]" pendingLabel="Saving…">
                              Reschedule
                            </Button>
                          </form>
                        </div>
                      </details>
                    ))}
                    {entries.length > MAX_PER_DAY && (
                      <p className="px-1 text-[12px] text-[var(--color-text-faint)]">+{entries.length - MAX_PER_DAY} more</p>
                    )}

                    {unscheduled.length > 0 && (
                      <details className="rounded-xl border border-dashed border-[var(--color-border-strong)]">
                        <summary className="flex min-h-[44px] cursor-pointer items-center justify-center rounded-xl px-2.5 text-center text-[14px] text-[var(--color-text-muted)] active:bg-white/[0.04] lg:text-[12px]">
                          + Add
                        </summary>
                        <form action={placeOnCalendar} className="flex flex-col gap-2 border-t border-[var(--color-border)] p-3 lg:p-2.5">
                          <input type="hidden" name="week" value={weekParam} />
                          <label className="block">
                            <span className="field-label">Video</span>
                            <select name="contentItemId" required className="field-input">
                              <option value="">Pick a READY item…</option>
                              {unscheduled.slice(0, MAX_POOL_SHOWN).map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.title}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="block">
                            <span className="field-label">Date &amp; time</span>
                            <input
                              type="datetime-local"
                              name="scheduledDate"
                              defaultValue={toDatetimeLocal(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0))}
                              className="field-input"
                            />
                          </label>
                          <PlatformChecks checked={() => false} />
                          <Button tone="primary" className="w-full !text-[13px]" pendingLabel="Placing…">
                            Place
                          </Button>
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
            <p className="mb-3 text-[14px] text-[var(--color-text-muted)] sm:text-[13px]">
              Passed every hard gate, nowhere on the calendar yet. Place one via any day&apos;s
              &quot;+ Add,&quot; or run Auto-Fill Week above.
            </p>
            <ul className="flex flex-wrap gap-2">
              {unscheduled.slice(0, MAX_POOL_SHOWN).map((item) => (
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
            {unscheduled.length > MAX_POOL_SHOWN && (
              <p className="mt-3 text-xs text-[var(--color-text-faint)]">+{unscheduled.length - MAX_POOL_SHOWN} more — see Content.</p>
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
