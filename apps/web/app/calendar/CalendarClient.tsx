"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import type { CalEvent, PoolItem } from "../../lib/calendar-data";
import {
  AGENDA_DAYS,
  CALENDAR_VIEWS,
  VIEW_COOKIE,
  isSameMonth,
  shiftAnchor,
  viewTitle,
  weekDays,
  type CalendarView,
} from "../../lib/calendar-views";
import { addDaysYmd } from "@chris/domain/planning";
import { Legend } from "./calendar-ui";
import { Agenda, MonthCompact, MonthDesktop, TimeGrid, type Deadline, type ViewProps } from "./views";
import { EventSheetBody, Sheet, type SheetState } from "./EventSheet";
import { useEventDrag, type DragPayload } from "./useEventDrag";
import { moveEvent } from "./actions";

const VIEW_LABEL: Record<CalendarView, string> = { month: "Month", week: "Week", day: "Day", agenda: "List" };

export interface CalendarClientProps {
  view: CalendarView;
  anchor: string;
  today: string;
  nowMin: number;
  events: CalEvent[];
  deadlines: Deadline[];
  readyPool: PoolItem[];
  autopilot: PoolItem[];
  defaultPlatforms: string[];
  openEventId: string | null;
}

function href(view: CalendarView, date: string) {
  return `/calendar?view=${view}&date=${date}`;
}

export function CalendarClient(props: CalendarClientProps) {
  const { view, anchor, today, events } = props;
  const router = useRouter();
  const [sheet, setSheet] = useState<SheetState | null>(() => {
    const e = props.openEventId ? events.find((x) => x.contentItemId === props.openEventId) : null;
    return e ? { kind: "event", event: e } : null;
  });
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
  const [overrides, setOverrides] = useState<{ base: CalEvent[]; map: Record<string, { ymd: string; startMin: number }> }>({ base: events, map: {} });
  const [, startTransition] = useTransition();
  const [nowMin, setNowMin] = useState(props.nowMin);
  const [selected, setSelected] = useState(anchor);

  // Live now-line.
  useEffect(() => {
    const t = setInterval(() => setNowMin((m) => Math.min(m + 1, 24 * 60 - 1)), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // Optimistic moves apply only to the event list they were made against; a server refresh
  // (new `events` array) supersedes them.
  const shown = useMemo(() => {
    const map = overrides.base === events ? overrides.map : {};
    return events.map((e) => (map[e.id] ? { ...e, ...map[e.id] } : e));
  }, [events, overrides]);

  const onDrop = useCallback(
    (p: DragPayload, ymd: string, minutes: number) => {
      setOverrides({ base: events, map: { ...(overrides.base === events ? overrides.map : {}), [p.id]: { ymd, startMin: minutes } } });
      startTransition(async () => {
        const r = await moveEvent({ contentItemId: p.contentItemId, ymd, minutes, platforms: p.platforms });
        if (r.ok) setToast({ msg: "Rescheduled" });
        else {
          setOverrides({ base: events, map: {} });
          setToast({ msg: r.error, error: true });
        }
      });
    },
    [events, overrides],
  );
  const { drag, start, guardClick } = useEventDrag(onDrop);

  const rememberView = (v: CalendarView) => {
    document.cookie = `${VIEW_COOKIE}=${v}; path=/; max-age=31536000; samesite=lax`;
  };

  const viewProps: ViewProps = {
    events: shown,
    today,
    nowMin,
    onOpen: (e) => setSheet({ kind: "event", event: e }),
    onAdd: (ymd, minutes) => setSheet({ kind: "add", ymd, minutes }),
    startDrag: start,
    guardClick,
    drag,
    deadlines: props.deadlines,
    dayHref: (d) => href("day", d),
  };

  const selectDay = (ymd: string) => {
    setSelected(ymd);
    window.history.replaceState(null, "", href("month", ymd));
  };

  const title = viewTitle(view, anchor);
  const prev = shiftAnchor(view, anchor, -1);
  const next = shiftAnchor(view, anchor, 1);

  return (
    <div>
      {/* Toolbar — phone: title row + segmented control; desktop: one row. */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <Link href={href(view, prev)} aria-label="Previous" className="flex h-11 w-9 shrink-0 items-center justify-center rounded-full text-[var(--color-gold-400)] active:bg-white/10 lg:w-10">
              <Chevron dir="left" />
            </Link>
            <h1 className="min-w-0 truncate text-[22px] font-semibold tracking-tight sm:text-[24px]">{title}</h1>
            <Link href={href(view, next)} aria-label="Next" className="flex h-11 w-9 shrink-0 items-center justify-center rounded-full text-[var(--color-gold-400)] active:bg-white/10 lg:w-10">
              <Chevron dir="right" />
            </Link>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 lg:hidden">
            <JumpToDate view={view} anchor={anchor} onJump={(d) => router.push(href(view, d))} />
            <Link href={href(view, today)} className="btn btn-ghost !min-h-[38px] !px-3.5 !text-[13px]">
              Today
            </Link>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Calendar view" className="grid flex-1 grid-cols-4 rounded-xl bg-white/[0.06] p-[3px] lg:w-[320px] lg:flex-none">
            {CALENDAR_VIEWS.map((v) => (
              <Link
                key={v}
                role="tab"
                aria-selected={v === view}
                href={href(v, v === "agenda" && view !== "agenda" ? today : anchor)}
                onClick={() => rememberView(v)}
                className={`flex h-9 items-center justify-center rounded-[9px] text-[13.5px] font-semibold transition-colors ${
                  v === view ? "bg-[#2a2a31] text-[var(--color-text)] shadow-[0_1px_3px_rgba(0,0,0,0.5)]" : "text-[var(--color-text-muted)] active:text-[var(--color-text)]"
                }`}
              >
                {VIEW_LABEL[v]}
              </Link>
            ))}
          </div>
          <div className="hidden items-center gap-2 lg:flex">
            <JumpToDate view={view} anchor={anchor} onJump={(d) => router.push(href(view, d))} />
            <Link href={href(view, today)} className="btn btn-ghost">
              Today
            </Link>
          </div>
        </div>
      </div>

      {view === "month" && (
        <>
          <div className="lg:hidden">
            <MonthCompact anchor={anchor} selected={isSameMonth(selected, anchor) ? selected : anchor} onSelect={selectDay} {...viewProps} />
          </div>
          <div className="hidden lg:block">
            <MonthDesktop anchor={anchor} {...viewProps} />
          </div>
        </>
      )}
      {view === "week" && <TimeGrid days={weekDays(anchor)} variant="week" {...viewProps} />}
      {view === "day" && (
        <>
          <DayStrip anchor={anchor} today={today} events={shown} />
          <TimeGrid days={[anchor]} variant="day" {...viewProps} />
        </>
      )}
      {view === "agenda" && <Agenda days={Array.from({ length: AGENDA_DAYS }, (_, i) => addDaysYmd(anchor, i))} {...viewProps} />}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Legend />
        {view === "week" && <p className="text-[12px] text-[var(--color-text-faint)] lg:hidden">Swipe sideways for the rest of the week</p>}
      </div>

      {drag && (
        <div
          className="pointer-events-none fixed z-[70] max-w-[220px] -translate-x-1/2 -translate-y-[130%] truncate rounded-lg bg-[var(--color-gold-400)] px-2.5 py-1 text-[12px] font-semibold text-[#14100a] shadow-xl"
          style={{ left: drag.x, top: drag.y }}
        >
          {drag.target ? `Move to ${drag.target.ymd.slice(5).replace("-", "/")} · ${Math.floor(drag.target.minutes / 60) % 12 || 12}:${String(drag.target.minutes % 60).padStart(2, "0")}${drag.target.minutes < 720 ? "a" : "p"}` : drag.payload.title}
        </div>
      )}

      {sheet && (
        <Sheet onClose={() => setSheet(null)} label={sheet.kind === "add" ? "Add a video" : sheet.event.title}>
          <EventSheetBody
            state={sheet}
            readyPool={props.readyPool}
            autopilot={props.autopilot}
            defaultPlatforms={props.defaultPlatforms}
            onDone={(msg) => {
              setSheet(null);
              if (msg) setToast({ msg });
            }}
          />
        </Sheet>
      )}

      {toast && (
        <div
          role="status"
          className={`fixed left-1/2 z-[80] -translate-x-1/2 rounded-full px-4 py-2 text-[14px] font-semibold shadow-2xl ${
            toast.error ? "bg-[var(--color-rose-500)] text-[#2a0e08]" : "bg-[#f5f4f2] text-[#111]"
          }`}
          style={{ bottom: "calc(var(--tabbar-h) + 18px)" }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="10" height="17" viewBox="0 0 10 17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={dir === "left" ? "M8.5 1.5 1.5 8.5l7 7" : "m1.5 1.5 7 7-7 7"} />
    </svg>
  );
}

/** A calendar-icon button wrapping a native date input — the OS date picker on iPhone. */
function JumpToDate({ view, anchor, onJump }: { view: CalendarView; anchor: string; onJump: (ymd: string) => void }) {
  return (
    <label className="relative flex h-[38px] w-[38px] cursor-pointer items-center justify-center rounded-full border border-[var(--color-border)] bg-white/[0.06] text-[var(--color-text-muted)] lg:h-[38px] lg:w-[38px]" aria-label={`Jump to a date (${view})`}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
        <path d="M3.5 10h17M8 3v4M16 3v4" />
      </svg>
      <input
        type="date"
        defaultValue={anchor}
        onChange={(e) => e.target.value && onJump(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="Jump to date"
      />
    </label>
  );
}

/** Day view header: the week's days as a strip (Apple's day view), dots where posts exist. */
function DayStrip({ anchor, today, events }: { anchor: string; today: string; events: CalEvent[] }) {
  const days = weekDays(anchor);
  return (
    <div className="mb-3 grid grid-cols-7 gap-1">
      {days.map((d) => {
        const sel = d === anchor;
        const isToday = d === today;
        const has = events.some((e) => e.ymd === d && e.kind === "post");
        return (
          <Link
            key={d}
            href={href("day", d)}
            className={`flex h-[58px] flex-col items-center justify-center rounded-xl ${sel ? "bg-white/[0.08]" : "active:bg-white/[0.05]"}`}
          >
            <span className={`text-[11px] font-semibold uppercase ${isToday ? "text-[var(--color-gold-400)]" : "text-[var(--color-text-faint)]"}`}>
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][days.indexOf(d)]!.slice(0, 1)}
            </span>
            <span
              className={`mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-[15px] font-semibold ${
                sel ? (isToday ? "bg-[var(--color-gold-400)] text-[#14100a]" : "bg-[var(--color-text)] text-[#0b0b0e]") : isToday ? "text-[var(--color-gold-400)]" : ""
              }`}
            >
              {Number(d.slice(8, 10))}
            </span>
            <span className={`mt-0.5 h-1 w-1 rounded-full ${has ? "bg-[var(--color-text-muted)]" : ""}`} />
          </Link>
        );
      })}
    </div>
  );
}
