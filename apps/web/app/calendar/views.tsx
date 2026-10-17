"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { CalEvent } from "../../lib/calendar-data";
import {
  formatMinutes,
  hourLabel,
  isSameMonth,
  layoutOverlaps,
  monthDayLabel,
  monthGrid,
  weekdayName,
} from "../../lib/calendar-views";
import { STATUS_COLOR, STATUS_LABEL, PLATFORM_NAME, PlatformDots, eventStyle, eventTitle } from "./calendar-ui";
import type { DragPayload, DragState } from "./useEventDrag";

/** Visual length of an event block — posts are instants; one hour reads well and stacks cleanly. */
export const DISPLAY_MIN = 60;

export interface Deadline {
  id: string;
  ymd: string;
  label: string;
  atRisk: boolean;
  href: string;
}

export interface ViewProps {
  events: CalEvent[];
  today: string;
  nowMin: number;
  onOpen: (e: CalEvent) => void;
  onAdd: (ymd: string, minutes: number) => void;
  startDrag: (e: React.PointerEvent, p: DragPayload) => void;
  guardClick: (fn: () => void) => () => void;
  drag: DragState | null;
  deadlines: Deadline[];
  dayHref: (ymd: string) => string;
}

function payloadFor(e: CalEvent, grabOffsetMin = 0): DragPayload {
  return {
    id: e.id,
    contentItemId: e.contentItemId!,
    platforms: e.platforms,
    ymd: e.ymd,
    startMin: e.startMin,
    title: e.title,
    grabOffsetMin,
  };
}

const NO_CALLOUT = { WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" } as const;

// ---------------------------------------------------------------------------------------
// Week / Day time grid
// ---------------------------------------------------------------------------------------

export function TimeGrid({
  days,
  variant,
  ...p
}: ViewProps & { days: string[]; variant: "week" | "day" }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hourPx = variant === "day" ? 64 : 52;
  const byDay = new Map<string, CalEvent[]>();
  for (const e of p.events) byDay.set(e.ymd, [...(byDay.get(e.ymd) ?? []), e]);
  const deadlinesIn = p.deadlines.filter((d) => days.includes(d.ymd));

  // Initial scroll: an hour before now (today visible) / the first event / 8am; and on a
  // phone's 3-day week, horizontally to today's column.
  const firstMin = Math.min(...days.flatMap((d) => (byDay.get(d) ?? []).map((e) => e.startMin)), 24 * 60);
  const focusMin = days.includes(p.today) ? Math.max(0, p.nowMin - 90) : firstMin < 24 * 60 ? Math.max(0, firstMin - 60) : 8 * 60;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = (focusMin / 60) * hourPx;
    const col = el.querySelector<HTMLElement>(`[data-col="${p.today}"]`) ?? el.querySelector<HTMLElement>(`[data-col="${days[0]}"]`);
    const gutter = el.querySelector<HTMLElement>("[data-gutter]")?.offsetWidth ?? 0;
    if (col) el.scrollLeft = Math.max(0, col.offsetLeft - gutter);
    // Only on mount / when the shown days change — not on every refresh.
  }, [days.join(",")]);

  const colW = variant === "day" ? "calc(100cqw - var(--gw))" : "var(--dayw)";
  return (
    <div
      ref={scrollRef}
      className="relative overflow-auto overscroll-contain rounded-2xl border border-[var(--color-border)] bg-[#0b0b0e] [--gw:44px] [--dayw:calc((100cqw_-_44px)/3)] [container-type:inline-size] [scroll-snap-type:x_proximity] lg:[--gw:56px] lg:[--dayw:calc((100cqw_-_56px)/7)]"
      style={{ height: "min(72dvh, 760px)", minHeight: 420 }}
    >
      <div style={{ width: `calc(var(--gw) + ${days.length} * ${colW})` }}>
        {/* Header */}
        <div className="sticky top-0 z-20 flex border-b border-[var(--color-border)] bg-[#0b0b0e]/95 backdrop-blur">
          <div data-gutter className="sticky left-0 z-30 shrink-0 bg-[#0b0b0e]" style={{ width: "var(--gw)" }} />
          {days.map((d) => {
            const isToday = d === p.today;
            return (
              <Link
                key={d}
                href={p.dayHref(d)}
                className="flex shrink-0 flex-col items-center justify-center gap-0.5 py-2 [scroll-snap-align:start] active:opacity-60"
                style={{ width: colW }}
              >
                <span className={`text-[11px] font-semibold uppercase tracking-wide ${isToday ? "text-[var(--color-gold-400)]" : "text-[var(--color-text-faint)]"}`}>
                  {weekdayName(d, true)}
                </span>
                <span
                  className={`flex h-8 min-w-8 items-center justify-center rounded-full px-1 text-[17px] font-semibold ${
                    isToday ? "bg-[var(--color-gold-400)] text-[#14100a]" : "text-[var(--color-text)]"
                  }`}
                >
                  {Number(d.slice(8, 10))}
                </span>
              </Link>
            );
          })}
        </div>

        {/* All-day lane: pipeline deadlines ("Film 2 by Wed") on the day they fall due. */}
        {deadlinesIn.length > 0 && (
          <div className="sticky top-[61px] z-20 flex border-b border-[var(--color-border)] bg-[#0b0b0e]/95 backdrop-blur">
            <div className="sticky left-0 z-30 flex shrink-0 items-center justify-end bg-[#0b0b0e] pr-1.5 text-[10px] text-[var(--color-text-faint)]" style={{ width: "var(--gw)" }}>
              due
            </div>
            {days.map((d) => (
              <div key={d} className="flex shrink-0 flex-col gap-1 p-1" style={{ width: colW }}>
                {deadlinesIn
                  .filter((x) => x.ymd === d)
                  .map((x) => (
                    <Link
                      key={x.id}
                      href={x.href}
                      className="truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                      style={{
                        color: x.atRisk ? "var(--color-rose-400)" : "var(--color-gold-400)",
                        background: `color-mix(in srgb, ${x.atRisk ? "var(--color-rose-500)" : "var(--color-gold-500)"} 14%, transparent)`,
                      }}
                      title={x.label}
                    >
                      {x.label}
                    </Link>
                  ))}
              </div>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="flex">
          <div data-gutter className="sticky left-0 z-10 shrink-0 bg-[#0b0b0e]" style={{ width: "var(--gw)", height: 24 * hourPx }}>
            {Array.from({ length: 24 }, (_, h) =>
              h === 0 ? null : (
                <span
                  key={h}
                  className="absolute right-1.5 -translate-y-1/2 whitespace-nowrap text-[10px] font-medium text-[var(--color-text-faint)] lg:right-2 lg:text-[11px]"
                  style={{ top: h * hourPx }}
                >
                  {hourLabel(h)}
                </span>
              ),
            )}
          </div>
          {days.map((d) => (
            <DayColumn key={d} {...p} ymd={d} events={byDay.get(d) ?? []} hourPx={hourPx} width={colW} variant={variant} />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayColumn({
  ymd,
  events,
  hourPx,
  width,
  variant,
  ...p
}: ViewProps & { ymd: string; events: CalEvent[]; hourPx: number; width: string; variant: "week" | "day" }) {
  const layout = layoutOverlaps(events.map((e) => ({ id: e.id, startMin: e.startMin, endMin: e.startMin + DISPLAY_MIN })));
  const isToday = ymd === p.today;
  const ghost = p.drag?.target?.grid && p.drag.target.ymd === ymd ? p.drag : null;
  return (
    <div
      data-col={ymd}
      data-drop-ymd={ymd}
      data-drop-grid=""
      data-hour-px={hourPx}
      className={`relative shrink-0 border-l border-[var(--color-border)] [scroll-snap-align:start] ${isToday ? "bg-[var(--color-gold-500)]/[0.035]" : ""}`}
      style={{
        width,
        height: 24 * hourPx,
        backgroundImage: `repeating-linear-gradient(to bottom, rgba(255,255,255,0.07) 0 1px, transparent 1px ${hourPx}px)`,
      }}
      onClick={(ev) => {
        if (ev.target !== ev.currentTarget) return;
        const rect = ev.currentTarget.getBoundingClientRect();
        const min = Math.floor((((ev.clientY - rect.top) / hourPx) * 60) / 30) * 30;
        p.guardClick(() => p.onAdd(ymd, Math.min(min, 23 * 60 + 30)))();
      }}
    >
      {events.map((e) => {
        const l = layout.get(e.id) ?? { col: 0, cols: 1 };
        const dragging = p.drag?.payload.id === e.id;
        const draggable = e.canReschedule && !!e.contentItemId;
        const h = (DISPLAY_MIN / 60) * hourPx - 3;
        return (
          <button
            key={e.id}
            type="button"
            onClick={p.guardClick(() => p.onOpen(e))}
            onPointerDown={
              draggable
                ? (ev) => {
                    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                    p.startDrag(ev, payloadFor(e, ((ev.clientY - rect.top) / hourPx) * 60));
                  }
                : undefined
            }
            className={`absolute overflow-hidden rounded-lg px-1.5 py-1 text-left transition-opacity active:brightness-125 ${draggable ? "cursor-grab" : ""}`}
            style={{
              ...eventStyle(e.status),
              ...NO_CALLOUT,
              top: (e.startMin / 60) * hourPx + 1,
              height: h,
              left: `calc(${(l.col / l.cols) * 100}% + 2px)`,
              width: `calc(${100 / l.cols}% - 4px)`,
              opacity: dragging ? 0.35 : 1,
              zIndex: 2,
            }}
          >
            <span className={`block font-semibold leading-tight ${variant === "day" ? "text-[14px]" : "text-[11.5px] lg:text-[12px]"} line-clamp-2`}>
              {eventTitle(e)}
            </span>
            <span className="mt-0.5 flex items-center gap-1 text-[10.5px] text-[var(--color-text-muted)]">
              <PlatformDots platforms={e.platforms} size={5} />
              <span className="truncate">
                {formatMinutes(e.startMin, true)}
                {variant === "day" && ` · ${STATUS_LABEL[e.status]} · ${e.platforms.map((x) => PLATFORM_NAME[x]).join(", ")}`}
              </span>
            </span>
          </button>
        );
      })}

      {ghost && (
        <div
          className="pointer-events-none absolute inset-x-0.5 z-10 rounded-lg border-2 border-[var(--color-gold-400)] bg-[var(--color-gold-500)]/25 px-1.5 py-1 text-[11px] font-semibold text-[var(--color-gold-400)] shadow-lg"
          style={{ top: (ghost.target!.minutes / 60) * hourPx + 1, height: (DISPLAY_MIN / 60) * hourPx - 3 }}
        >
          {formatMinutes(ghost.target!.minutes, true)} · {ghost.payload.title}
        </div>
      )}

      {isToday && (
        <div className="pointer-events-none absolute inset-x-0 z-[5] flex items-center" style={{ top: (p.nowMin / 60) * hourPx }}>
          <span className="-ml-[5px] h-2.5 w-2.5 rounded-full bg-[var(--color-rose-500)]" />
          <span className="h-[2px] flex-1 bg-[var(--color-rose-500)]" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Month
// ---------------------------------------------------------------------------------------

const WEEK_HEAD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_CHIPS = 3;

export function MonthDesktop({ anchor, ...p }: ViewProps & { anchor: string }) {
  const weeks = monthGrid(anchor);
  const byDay = groupByDay(p.events);
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[#0b0b0e]">
      <div className="grid grid-cols-7 border-b border-[var(--color-border)]">
        {WEEK_HEAD.map((w) => (
          <div key={w} className="px-2.5 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">
            {w}
          </div>
        ))}
      </div>
      {weeks.map((week) => (
        <div key={week[0]} className="grid grid-cols-7 border-b border-[var(--color-border)] last:border-b-0">
          {week.map((d) => {
            const evs = byDay.get(d) ?? [];
            const inMonth = isSameMonth(d, anchor);
            const isToday = d === p.today;
            const isDrop = p.drag?.target && !p.drag.target.grid && p.drag.target.ymd === d;
            return (
              <div
                key={d}
                data-drop-ymd={d}
                className={`group relative flex min-h-[124px] min-w-0 flex-col gap-[3px] border-l border-[var(--color-border)] p-1.5 first:border-l-0 ${
                  inMonth ? "" : "bg-white/[0.015]"
                } ${isDrop ? "!bg-[var(--color-gold-500)]/15 outline outline-1 outline-[var(--color-gold-500)]/60" : ""}`}
                onClick={(ev) => {
                  if (ev.target === ev.currentTarget) p.guardClick(() => p.onAdd(d, 18 * 60))();
                }}
              >
                <div className="flex justify-end">
                  <Link
                    href={p.dayHref(d)}
                    className={`flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-[13px] font-semibold hover:bg-white/10 ${
                      isToday ? "bg-[var(--color-gold-400)] text-[#14100a] hover:bg-[var(--color-gold-400)]" : inMonth ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)]"
                    }`}
                  >
                    {Number(d.slice(8, 10)) === 1 ? monthDayLabel(d) : Number(d.slice(8, 10))}
                  </Link>
                </div>
                {evs.slice(0, MAX_CHIPS).map((e) => (
                  <MonthChip key={e.id} e={e} {...p} />
                ))}
                {evs.length > MAX_CHIPS && (
                  <Link href={p.dayHref(d)} className="px-1.5 text-[11.5px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                    +{evs.length - MAX_CHIPS} more
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function MonthChip({ e, ...p }: ViewProps & { e: CalEvent }) {
  const draggable = e.canReschedule && !!e.contentItemId;
  return (
    <button
      type="button"
      onClick={p.guardClick(() => p.onOpen(e))}
      onPointerDown={draggable ? (ev) => p.startDrag(ev, payloadFor(e)) : undefined}
      className={`flex h-[24px] w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] hover:brightness-125 ${draggable ? "cursor-grab" : ""}`}
      style={{ ...eventStyle(e.status), ...NO_CALLOUT, opacity: p.drag?.payload.id === e.id ? 0.35 : 1 }}
      title={`${formatMinutes(e.startMin)} · ${eventTitle(e)} · ${STATUS_LABEL[e.status]}`}
    >
      <PlatformDots platforms={e.platforms} size={5} />
      <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{formatMinutes(e.startMin, true)}</span>
      <span className="min-w-0 truncate font-medium">{eventTitle(e)}</span>
    </button>
  );
}

/** iPhone month: compact grid with status dots (Apple Calendar style) + the selected day's list. */
export function MonthCompact({
  anchor,
  selected,
  onSelect,
  ...p
}: ViewProps & { anchor: string; selected: string; onSelect: (ymd: string) => void }) {
  const weeks = monthGrid(anchor);
  const byDay = groupByDay(p.events);
  return (
    <div>
      <div className="grid grid-cols-7 pb-1">
        {WEEK_HEAD.map((w) => (
          <div key={w} className="text-center text-[11px] font-semibold uppercase text-[var(--color-text-faint)]">
            {w.slice(0, 1)}
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-[var(--color-border)] bg-[#0b0b0e] py-1">
        {weeks.map((week) => (
          <div key={week[0]} className="grid grid-cols-7">
            {week.map((d) => {
              const evs = byDay.get(d) ?? [];
              const inMonth = isSameMonth(d, anchor);
              const isToday = d === p.today;
              const isSel = d === selected;
              const posts = evs.filter((e) => e.kind === "post");
              const hasSlot = evs.some((e) => e.kind === "slot");
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => onSelect(d)}
                  className="flex h-[54px] flex-col items-center justify-start gap-[3px] pt-1.5 active:opacity-60"
                  aria-label={`${weekdayName(d)} ${monthDayLabel(d)}: ${posts.length} post${posts.length === 1 ? "" : "s"}${hasSlot ? ", open slot" : ""}`}
                  aria-pressed={isSel}
                >
                  <span
                    className={`flex h-[30px] w-[30px] items-center justify-center rounded-full text-[16px] ${
                      isSel
                        ? isToday
                          ? "bg-[var(--color-gold-400)] font-bold text-[#14100a]"
                          : "bg-[var(--color-text)] font-bold text-[#0b0b0e]"
                        : isToday
                          ? "font-bold text-[var(--color-gold-400)]"
                          : inMonth
                            ? "text-[var(--color-text)]"
                            : "text-[var(--color-text-faint)]/70"
                    }`}
                  >
                    {Number(d.slice(8, 10))}
                  </span>
                  <span className="flex h-[6px] items-center gap-[3px]">
                    {posts.slice(0, 3).map((e) => (
                      <span key={e.id} className="h-[5px] w-[5px] rounded-full" style={{ background: STATUS_COLOR[e.status] }} />
                    ))}
                    {posts.length < 3 && hasSlot && <span className="h-[5px] w-[5px] rounded-full border border-[var(--color-gold-400)]" />}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-4">
        <DayHeader ymd={selected} today={p.today} count={(byDay.get(selected) ?? []).filter((e) => e.kind === "post").length} />
        <DayList {...p} ymd={selected} events={byDay.get(selected) ?? []} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Lists (iPhone month's selected day, Agenda)
// ---------------------------------------------------------------------------------------

export function DayHeader({ ymd, today, count, sticky = false }: { ymd: string; today: string; count?: number; sticky?: boolean }) {
  const rel = ymd === today ? "Today" : null;
  return (
    <div
      className={`flex items-baseline justify-between gap-3 px-1 pb-2 pt-1 ${sticky ? "sticky z-10 bg-[color-mix(in_srgb,var(--color-ink)_94%,transparent)] backdrop-blur-xl" : ""}`}
      style={sticky ? { top: "calc(var(--safe-top) + 48px)" } : undefined}
    >
      <p className="text-[15px] font-semibold">
        {rel && <span className="text-[var(--color-gold-400)]">{rel} · </span>}
        {weekdayName(ymd)}, {monthDayLabel(ymd)}
      </p>
      {count !== undefined && <p className="text-[13px] text-[var(--color-text-faint)]">{count === 0 ? "No posts" : `${count} post${count === 1 ? "" : "s"}`}</p>}
    </div>
  );
}

export function DayList({ ymd, events, ...p }: ViewProps & { ymd: string; events: CalEvent[] }) {
  return (
    <ul className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-white/[0.02]">
      {events.map((e) => (
        <li key={e.id} className="border-b border-[var(--color-border)] last:border-b-0">
          <button type="button" onClick={() => p.onOpen(e)} className="flex min-h-[60px] w-full items-center gap-3 px-3.5 py-2.5 text-left active:bg-white/[0.05]">
            <span className="w-[54px] shrink-0 text-[13px] font-medium tabular-nums text-[var(--color-text-muted)]">{formatMinutes(e.startMin)}</span>
            <span
              className="w-[3px] shrink-0 self-stretch rounded-full"
              style={e.kind === "slot" ? { borderLeft: `2px dashed ${STATUS_COLOR.slot}` } : { background: STATUS_COLOR[e.status] }}
            />
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-[15px] font-medium ${e.kind === "slot" ? "text-[var(--color-text-muted)]" : ""}`}>
                {e.kind === "slot" ? `Open slot · ${e.platforms.map((x) => PLATFORM_NAME[x]).join(" + ")}` : e.title}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-[var(--color-text-faint)]">
                <PlatformDots platforms={e.platforms} />
                <span style={{ color: e.kind === "slot" ? undefined : STATUS_COLOR[e.status] }}>
                  {e.kind === "slot" ? (e.suggestion ? `Fill with “${e.suggestion.title}”` : "Nothing ready to fill it") : STATUS_LABEL[e.status]}
                </span>
              </span>
            </span>
            <svg width="7" height="12" viewBox="0 0 7 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="shrink-0 text-[var(--color-text-faint)]" aria-hidden>
              <path d="m1 1 5 5-5 5" />
            </svg>
          </button>
        </li>
      ))}
      <li>
        <button
          type="button"
          onClick={() => p.onAdd(ymd, 18 * 60)}
          className="flex min-h-[48px] w-full items-center gap-2 px-3.5 text-[14px] font-medium text-[var(--color-gold-400)] active:bg-white/[0.05]"
        >
          <span className="text-[18px] leading-none">+</span> Add a video to {ymd === p.today ? "today" : `${weekdayName(ymd, true)} ${Number(ymd.slice(8, 10))}`}
        </button>
      </li>
    </ul>
  );
}

export function Agenda({ days, ...p }: ViewProps & { days: string[] }): ReactNode {
  const byDay = groupByDay(p.events);
  const shown = days.filter((d) => (byDay.get(d)?.length ?? 0) > 0 || d === p.today);
  if (shown.length === 0) {
    return <p className="rounded-2xl border border-[var(--color-border)] p-6 text-center text-[15px] text-[var(--color-text-muted)]">Nothing in these four weeks yet.</p>;
  }
  return (
    <div className="flex flex-col gap-5">
      {shown.map((d) => (
        <section key={d}>
          <DayHeader ymd={d} today={p.today} count={(byDay.get(d) ?? []).filter((e) => e.kind === "post").length} sticky />
          <DayList {...p} ymd={d} events={byDay.get(d) ?? []} />
        </section>
      ))}
    </div>
  );
}

function groupByDay(events: CalEvent[]) {
  const m = new Map<string, CalEvent[]>();
  for (const e of events) m.set(e.ymd, [...(m.get(e.ymd) ?? []), e]);
  for (const list of m.values()) list.sort((a, b) => a.startMin - b.startMin || (a.kind === "slot" ? 1 : -1));
  return m;
}
