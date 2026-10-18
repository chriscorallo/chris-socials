/**
 * Pure layout math behind the Calendar's Month / Week / Day / Agenda views
 * (apps/web/app/calendar). Calendar days are "YYYY-MM-DD" strings in APP_TIMEZONE, so
 * nothing here depends on the process or browser time zone — see packages/domain/src/tz.ts.
 * Weeks run Monday–Sunday, matching the rest of the app (Auto-Fill Week, coverage).
 */
import { addDaysYmd, addMonthsYmd, mondayOfYmd, parseYmd, toYmd, weekdayOfYmd } from "@chris/domain/tz";

export const CALENDAR_VIEWS = ["month", "week", "day", "agenda"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];
export const VIEW_COOKIE = "cal_view";
export const AGENDA_DAYS = 28;

export function parseView(v: string | null | undefined): CalendarView | null {
  return (CALENDAR_VIEWS as readonly string[]).includes(v ?? "") ? (v as CalendarView) : null;
}

/** Month grid: whole Monday-first weeks covering the anchor's month (leading/trailing days included). */
export function monthGrid(anchor: string): string[][] {
  const p = parseYmd(anchor);
  if (!p) throw new Error(`bad date ${anchor}`);
  const first = toYmd(p.year, p.month, 1);
  const last = addDaysYmd(addMonthsYmd(first, 1), -1);
  const weeks: string[][] = [];
  for (let monday = mondayOfYmd(first); monday <= last; monday = addDaysYmd(monday, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDaysYmd(monday, i)));
  }
  return weeks;
}

export function weekDays(anchor: string): string[] {
  const monday = mondayOfYmd(anchor);
  return Array.from({ length: 7 }, (_, i) => addDaysYmd(monday, i));
}

export function isSameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** The [start, endExclusive) day range a view shows. */
export function viewRange(view: CalendarView, anchor: string): { start: string; end: string } {
  switch (view) {
    case "month": {
      const g = monthGrid(anchor);
      return { start: g[0]![0]!, end: addDaysYmd(g[g.length - 1]![6]!, 1) };
    }
    case "week": {
      const m = mondayOfYmd(anchor);
      return { start: m, end: addDaysYmd(m, 7) };
    }
    case "day":
      return { start: anchor, end: addDaysYmd(anchor, 1) };
    case "agenda":
      return { start: anchor, end: addDaysYmd(anchor, AGENDA_DAYS) };
  }
}

/** Prev/next anchor for a view. */
export function shiftAnchor(view: CalendarView, anchor: string, dir: 1 | -1): string {
  switch (view) {
    case "month":
      return addMonthsYmd(toYmd(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)), 1), dir);
    case "week":
      return addDaysYmd(anchor, 7 * dir);
    case "day":
      return addDaysYmd(anchor, dir);
    case "agenda":
      return addDaysYmd(anchor, AGENDA_DAYS * dir);
  }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function weekdayName(ymd: string, short = false): string {
  const w = WEEKDAYS[weekdayOfYmd(ymd)]!;
  return short ? w.slice(0, 3) : w;
}

export function monthDayLabel(ymd: string): string {
  return `${MONTHS_SHORT[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}`;
}

export function viewTitle(view: CalendarView, anchor: string): string {
  const y = anchor.slice(0, 4);
  if (view === "month") return `${MONTHS[Number(anchor.slice(5, 7)) - 1]} ${y}`;
  if (view === "day") return `${weekdayName(anchor)}, ${monthDayLabel(anchor)}`;
  const { start, end } = viewRange(view, anchor);
  const last = addDaysYmd(end, -1);
  const sameMonth = isSameMonth(start, last);
  return `${monthDayLabel(start)} – ${sameMonth ? Number(last.slice(8, 10)) : monthDayLabel(last)}${last.slice(0, 4) === y ? `, ${y}` : `, ${last.slice(0, 4)}`}`;
}

/** Phone-width title: no year when it's the current year, short weekday on Day view. */
export function shortViewTitle(view: CalendarView, anchor: string, todayYmd: string): string {
  if (view === "month") return viewTitle(view, anchor);
  if (view === "day") return `${weekdayName(anchor, true)}, ${monthDayLabel(anchor)}`;
  const t = viewTitle(view, anchor);
  return t.endsWith(`, ${todayYmd.slice(0, 4)}`) ? t.slice(0, -6) : t;
}

/** "6:30 PM" style from minutes-of-day; compact drops ":00" and uses lowercase a/p ("6:30p"). */
export function formatMinutes(min: number, compact = false): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const h12 = h % 12 || 12;
  if (compact) return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "a" : "p"}`;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function hourLabel(h: number): string {
  if (h === 0) return "12 AM";
  if (h === 12) return "Noon";
  return `${h % 12} ${h < 12 ? "AM" : "PM"}`;
}

export interface TimedBlock {
  id: string;
  startMin: number;
  endMin: number;
}

/**
 * Side-by-side layout for overlapping timed events (Google/Apple style): events that overlap
 * transitively form a cluster; each event gets the first free column in its cluster; every
 * event in a cluster shares the cluster's column count so widths line up.
 */
export function layoutOverlaps(blocks: TimedBlock[]): Map<string, { col: number; cols: number }> {
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin || a.id.localeCompare(b.id));
  const out = new Map<string, { col: number; cols: number }>();
  let cluster: { block: TimedBlock; col: number }[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const cols = colEnds.length;
    for (const c of cluster) out.set(c.block.id, { col: c.col, cols });
    cluster = [];
    colEnds = [];
    clusterEnd = -Infinity;
  };

  for (const b of sorted) {
    if (b.startMin >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= b.startMin);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(b.endMin);
    } else {
      colEnds[col] = b.endMin;
    }
    cluster.push({ block: b, col });
    clusterEnd = Math.max(clusterEnd, b.endMin);
  }
  flush();
  return out;
}

/** Snap minutes to a step (default 15), clamped to the day. */
export function snapMinutes(min: number, step = 15): number {
  return Math.max(0, Math.min(24 * 60 - step, Math.round(min / step) * step));
}
