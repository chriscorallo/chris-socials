/**
 * Pure, explicit-time-zone date math for the calendar / posting plan / course logic.
 *
 * Why not just `new Date(y, m, d, h)`: that uses the *process* time zone, which the web app
 * re-points to APP_TIMEZONE in instrumentation.ts — but tests, the worker, and any other
 * process don't, and a function whose answer depends on an env var set in some other file is
 * exactly the kind of thing that silently breaks across DST. Every function here takes the
 * IANA zone explicitly and uses Intl (which knows the tz database) — no process-TZ reads.
 *
 * Calendar days are carried around as "YYYY-MM-DD" strings ("ymd") — a plain local date with
 * no instant attached, so day arithmetic never crosses a DST boundary by accident.
 */

export const DEFAULT_APP_TIMEZONE = "America/Los_Angeles";

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday (JS convention). */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(date: Date, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday ?? "Sun"] ?? 0,
  };
}

/** Offset of `tz` from UTC at instant `date`, in minutes (e.g. PDT = -420). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const whole = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - whole) / 60000);
}

/**
 * The instant at which the wall clock in `tz` reads y-m-d h:mi. Correct across DST: the
 * offset is evaluated at the candidate instant and re-checked once. A wall time that doesn't
 * exist (spring-forward gap) resolves to the instant one hour later; an ambiguous one
 * (fall-back) resolves to the first occurrence.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off1 = tzOffsetMinutes(new Date(guess), tz);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(t), tz);
  if (off2 !== off1) {
    const t2 = guess - off2 * 60000;
    // Accept t2 only if it actually round-trips to the requested wall time; otherwise we're in
    // a gap — keep the first candidate (which lands an hour later on the wall clock).
    const p = zonedParts(new Date(t2), tz);
    if (p.hour === hour && p.minute === minute) t = t2;
  }
  return new Date(t);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function toYmd(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Strict "YYYY-MM-DD" parse; null for anything else or an impossible date. */
export function parseYmd(s: string | null | undefined): { year: number; month: number; day: number } | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return { year, month, day };
}

function ymdOrThrow(s: string) {
  const p = parseYmd(s);
  if (!p) throw new Error(`Invalid date "${s}" (expected YYYY-MM-DD)`);
  return p;
}

/** The calendar date `date` falls on, in `tz`. */
export function ymdInTz(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return toYmd(p.year, p.month, p.day);
}

/** Minutes since local midnight in `tz` (0..1439). */
export function minutesInTz(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  return p.hour * 60 + p.minute;
}

export function addDaysYmd(s: string, days: number): string {
  const p = ymdOrThrow(s);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return toYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function addMonthsYmd(s: string, months: number): string {
  const p = ymdOrThrow(s);
  const target = new Date(Date.UTC(p.year, p.month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return toYmd(target.getUTCFullYear(), target.getUTCMonth() + 1, Math.min(p.day, lastDay));
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOfYmd(s: string): number {
  const p = ymdOrThrow(s);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** The Monday on or before `s` (weeks run Monday–Sunday everywhere in this app). */
export function mondayOfYmd(s: string): string {
  const wd = weekdayOfYmd(s);
  return addDaysYmd(s, wd === 0 ? -6 : 1 - wd);
}

/** Whole days from a to b (b - a). */
export function diffDaysYmd(a: string, b: string): number {
  const pa = ymdOrThrow(a);
  const pb = ymdOrThrow(b);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86_400_000);
}

/** The instant of local midnight starting day `s` in `tz`. */
export function startOfDayInTz(s: string, tz: string): Date {
  const p = ymdOrThrow(s);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, tz);
}

/** "HH:mm" -> minutes; null when malformed. */
export function parseHhmm(s: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatHhmm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** The instant at wall time ymd + minutes-of-day in `tz`. */
export function ymdMinutesToUtc(s: string, minutes: number, tz: string): Date {
  const p = ymdOrThrow(s);
  return zonedTimeToUtc(p.year, p.month, p.day, Math.floor(minutes / 60), minutes % 60, tz);
}

/** Parses "YYYY-MM-DDTHH:mm" (a datetime-local input's value) as wall time in `tz`. */
export function parseLocalDateTimeInTz(value: string, tz: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  if (!m) return null;
  const minutes = parseHhmm(m[2]!);
  if (minutes === null || !parseYmd(m[1]!)) return null;
  return ymdMinutesToUtc(m[1]!, minutes, tz);
}

/** "YYYY-MM-DDTHH:mm" in `tz` — for a datetime-local input's defaultValue. */
export function toLocalDateTimeInTz(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${toYmd(p.year, p.month, p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
