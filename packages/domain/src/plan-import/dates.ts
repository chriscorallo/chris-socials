import { addDaysYmd, diffDaysYmd, mondayOfYmd, parseYmd, toYmd, weekdayOfYmd } from "../tz";

/**
 * Date/time/platform understanding for imported video plans — deterministic, no model call.
 *
 * Dates are parsed into a `DateSpec` first (what the text *said*), and only then resolved to a
 * calendar day (`resolveDateSpec`) against a context (today, the plan's start date, the week
 * heading it sat under). Keeping the two apart is what lets the preview re-resolve "Week 2 /
 * Day 3"-style plans instantly when Chris changes the start date, without re-parsing.
 *
 * Conventions (see docs/decisions-pending/plan-import.md):
 *  - numeric dates are US month/day ("10/20" = October 20);
 *  - a date with no year resolves to the nearest upcoming occurrence (this year, unless that
 *    is more than 60 days in the past — then next year), so a December import of "Jan 3"
 *    lands in January, while a plan that started last week still lands last week;
 *  - a range ("Oct 20–24") resolves to its first day; the row is flagged so the preview says so.
 */

export type WeekRef =
  | { kind: "n"; n: number }
  | { kind: "monday"; ymd: string }
  /** "Week of Oct 20" — year resolved like any other month/day. */
  | { kind: "of"; year: number | null; month: number; day: number };

export type DateSpec =
  | { kind: "absolute"; year: number | null; month: number; day: number; range?: boolean }
  | { kind: "weekday"; weekday: number; week: WeekRef | null }
  | { kind: "dayN"; n: number }
  | { kind: "weekDay"; week: number; day: number }
  | { kind: "relative"; offset: number }
  /** A heading/cell that only names a week ("Week 2", "Week of Oct 20") — no day. */
  | { kind: "week"; week: WeekRef };

export interface DateContext {
  /** "YYYY-MM-DD" — the day the import happens (in the app time zone). */
  today: string;
  /** "YYYY-MM-DD" — Day 1 / Week 1 of a relative plan. Defaults to `today`. */
  startDate?: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const WEEKDAY_WORDS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const WEEKDAY_RE = "(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\\.?";
const ORD = "(?:st|nd|rd|th)?";
const DASH = "\\s*(?:-|–|—|to|through|thru)\\s*";

function monthNum(word: string): number {
  return MONTHS[word.toLowerCase().replace(/\.$/, "")] ?? 0;
}
function weekdayNum(word: string): number {
  return WEEKDAY_WORDS[word.toLowerCase().replace(/\.$/, "")] ?? -1;
}
function year4(y: string | undefined): number | null {
  if (!y) return null;
  const n = Number(y);
  if (y.length === 2) return 2000 + n;
  return n >= 1900 && n <= 2200 ? n : null;
}
function validMd(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

export interface DateMatch {
  spec: DateSpec;
  /** The exact matched text, so callers can remove it from the line. */
  text: string;
  index: number;
}

/** Patterns tried at a given position, most specific first. Each returns a spec or null. */
type Pattern = { re: RegExp; build: (m: RegExpExecArray) => DateSpec | null };

const RANGE_TAIL_MD = `(?:${DASH}(?:${MONTH_RE}\\s*)?\\d{1,2}${ORD})?`;
const RANGE_TAIL_NUM = `(?:${DASH}\\d{1,2}(?:[/.]\\d{1,2})?(?:[/.]\\d{2,4})?)?`;

const PATTERNS: Pattern[] = [
  // 2026-10-20, 2026/10/20 (optionally with a weekday in front)
  {
    re: new RegExp(`^(?:${WEEKDAY_RE},?\\s+)?(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})\\b`, "i"),
    build: (m) => {
      const month = Number(m[3]), day = Number(m[4]);
      return validMd(month, day) ? { kind: "absolute", year: Number(m[2]), month, day } : null;
    },
  },
  // Mon, Oct 20th, 2026  /  October 20  /  Oct. 20 – 24
  {
    re: new RegExp(`^(?:${WEEKDAY_RE},?\\s+)?${MONTH_RE}\\s*(\\d{1,2})${ORD}(?:,?\\s+(\\d{4}))?(${RANGE_TAIL_MD})`, "i"),
    build: (m) => {
      const month = monthNum(m[2]!), day = Number(m[3]);
      if (!validMd(month, day)) return null;
      return { kind: "absolute", year: year4(m[4]), month, day, ...(m[5] ? { range: true } : {}) };
    },
  },
  // Mon 20 Oct / 20th October 2026
  {
    re: new RegExp(`^(?:${WEEKDAY_RE},?\\s+)?(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?`, "i"),
    build: (m) => {
      const month = monthNum(m[3]!), day = Number(m[2]);
      return validMd(month, day) ? { kind: "absolute", year: year4(m[4]), month, day } : null;
    },
  },
  // Mon 10/20, 10/20/2026, 10/20/26, 10.20 — US month/day; 10/20-10/24 ranges
  {
    re: new RegExp(`^(?:${WEEKDAY_RE},?\\s+)?(\\d{1,2})[/.](\\d{1,2})(?:[/.](\\d{4}|\\d{2}))?(?![\\d/.])(${RANGE_TAIL_NUM})`, "i"),
    build: (m) => {
      const month = Number(m[2]), day = Number(m[3]);
      if (!validMd(month, day)) return null;
      return { kind: "absolute", year: year4(m[4]), month, day, ...(m[5] ? { range: true } : {}) };
    },
  },
  // Week 2 Day 3, Week 2, Day 3, W2D3, Wk 2 / D3
  {
    re: /^w(?:ee)?k?\s*(\d{1,2})\s*[,/:\-–—]?\s*d(?:ay)?\s*(\d{1,2})\b/i,
    build: (m) => ({ kind: "weekDay", week: Number(m[1]), day: Number(m[2]) }),
  },
  // Week 2 Mon / Week 2 — Monday
  {
    re: new RegExp(`^w(?:ee)?k\\s*(\\d{1,2})\\s*[,/:\\-–—]?\\s*${WEEKDAY_RE}(?![a-z])`, "i"),
    build: (m) => {
      const wd = weekdayNum(m[2]!);
      return wd < 0 ? null : { kind: "weekday", weekday: wd, week: { kind: "n", n: Number(m[1]) } };
    },
  },
  // Week of Oct 20 / Week of 10/20
  {
    re: new RegExp(`^week\\s+(?:of|starting|beginning)\\s+(.+)$`, "i"),
    build: (m) => {
      const inner = matchDateAt(m[1]!.trim());
      if (!inner || inner.spec.kind !== "absolute") return null;
      const { year, month, day } = inner.spec;
      return { kind: "week", week: { kind: "of", year, month, day } };
    },
  },
  // Week 2 / Wk 2
  { re: /^w(?:ee)?k\s*(\d{1,2})\b/i, build: (m) => ({ kind: "week", week: { kind: "n", n: Number(m[1]) } }) },
  // Day 3 / D3
  { re: /^(?:day|d)\s*(\d{1,3})\b/i, build: (m) => ({ kind: "dayN", n: Number(m[1]) }) },
  // today / tomorrow / tonight
  { re: /^(today|tonight|tomorrow|tmrw)\b/i, build: (m) => ({ kind: "relative", offset: /^to(day|night)/i.test(m[1]!) ? 0 : 1 }) },
  // Monday / Mon. (weekday alone — callers decide whether it's really a date)
  {
    re: new RegExp(`^${WEEKDAY_RE}(?![a-z])`, "i"),
    build: (m) => {
      const wd = weekdayNum(m[1]!);
      return wd < 0 ? null : { kind: "weekday", weekday: wd, week: null };
    },
  },
];

/** Tries every pattern at the start of `s`. */
export function matchDateAt(s: string): DateMatch | null {
  for (const p of PATTERNS) {
    const m = p.re.exec(s);
    if (!m) continue;
    const spec = p.build(m);
    if (spec) return { spec, text: m[0], index: 0 };
  }
  return null;
}

/** Excel stores dates as days since 1899-12-30. Only plausible modern serials are accepted. */
export function excelSerialToYmd(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 30000 || serial > 80000) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
  const d = new Date(ms);
  return toYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Parses a whole date cell / date text ("Mon 10/20", "Oct 20 6pm", "Week 2 Day 3", "45950").
 * Returns the spec plus any time found in the same text, or null when it isn't a date.
 */
export function parseDateText(text: string): { spec: DateSpec; time: string | null; range: boolean } | null {
  let s = text.trim().replace(/\s+/g, " ");
  if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const ymd = excelSerialToYmd(Number(s));
    if (!ymd) return null;
    const p = parseYmd(ymd)!;
    return { spec: { kind: "absolute", year: p.year, month: p.month, day: p.day }, time: null, range: false };
  }
  // Pull a time out first ("10/20 6pm", "2026-10-20 18:00", "2026-10-20T18:00:00").
  let time: string | null = null;
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(s);
  if (iso) {
    time = `${iso[2]}:${iso[3]}`;
    s = iso[1]!;
  } else {
    const t = findTime(s);
    if (t) {
      time = t.time;
      s = (s.slice(0, t.index) + " " + s.slice(t.index + t.text.length)).trim();
    }
  }
  // Two specs in one cell ("Week 2 / Monday", "Monday, Oct 20"): take the most specific.
  const specs: DateSpec[] = [];
  let rest = s;
  for (let guard = 0; guard < 4 && rest; guard++) {
    rest = rest.replace(/^[\s,:;|/()[\]*–—-]+/, "");
    const m = matchDateAt(rest);
    if (!m) break;
    specs.push(m.spec);
    rest = rest.slice(m.text.length);
  }
  if (specs.length === 0) return null;
  // Anything substantial left over means this wasn't a pure date ("Monday motivation").
  if (rest.replace(/[\s,:;|/()[\]*.–—-]+/g, "").length > 0) return null;
  const spec = combineSpecs(specs);
  return spec ? { spec, time, range: spec.kind === "absolute" && !!spec.range } : null;
}

/** Most specific wins: absolute > week+day > day N > weekday (with any week ref) > relative > week. */
export function combineSpecs(specs: DateSpec[]): DateSpec | null {
  const abs = specs.find((s) => s.kind === "absolute");
  if (abs) return abs;
  const wd = specs.find((s) => s.kind === "weekDay");
  if (wd) return wd;
  const week = specs.find((s): s is Extract<DateSpec, { kind: "week" }> => s.kind === "week");
  const weekday = specs.find((s): s is Extract<DateSpec, { kind: "weekday" }> => s.kind === "weekday");
  if (weekday) return week && !weekday.week ? { ...weekday, week: week.week } : weekday;
  const dayN = specs.find((s) => s.kind === "dayN");
  if (dayN) return week && dayN.kind === "dayN" && week.week.kind === "n" ? { kind: "weekDay", week: week.week.n, day: dayN.n } : dayN;
  return specs.find((s) => s.kind === "relative") ?? week ?? null;
}

/** Year for a month/day with no year: nearest upcoming, with a 60-day look-back. */
export function nearestYear(month: number, day: number, today: string): number {
  const t = parseYmd(today)!;
  const candidate = toYmd(t.year, month, day);
  if (!parseYmd(candidate)) return parseYmd(toYmd(t.year + 1, month, day)) ? t.year + 1 : t.year;
  return diffDaysYmd(today, candidate) > 60 ? t.year + 1 : t.year;
}

function realYmd(year: number, month: number, day: number): string | null {
  const ymd = toYmd(year, month, day);
  const p = parseYmd(ymd);
  // parseYmd validates the day exists (no Feb 30).
  return p && p.month === month && p.day === day ? ymd : null;
}

export function resolveWeekRef(week: WeekRef, ctx: DateContext): string | null {
  if (week.kind === "n") {
    const start = ctx.startDate ?? ctx.today;
    return addDaysYmd(start, 7 * (Math.max(1, week.n) - 1));
  }
  if (week.kind === "of") {
    const ymd = resolveDateSpec({ kind: "absolute", year: week.year, month: week.month, day: week.day }, ctx);
    return ymd ? mondayOfYmd(ymd) : null;
  }
  return week.ymd;
}

/** First day on/after `from` that falls on `weekday`. */
export function nextWeekdayOnOrAfter(from: string, weekday: number): string {
  const delta = (weekday - weekdayOfYmd(from) + 7) % 7;
  return addDaysYmd(from, delta);
}

/**
 * Turns a spec into a calendar day. `cursor` is the previous row's day — a bare weekday with no
 * week context ("Mon", "Tue", … "Mon") rolls forward from it, so a list of weekdays reads as
 * consecutive days, not all crammed into the first week.
 */
export function resolveDateSpec(spec: DateSpec, ctx: DateContext, cursor?: string | null): string | null {
  const start = ctx.startDate ?? ctx.today;
  switch (spec.kind) {
    case "absolute": {
      const year = spec.year ?? nearestYear(spec.month, spec.day, ctx.today);
      return realYmd(year, spec.month, spec.day);
    }
    case "dayN":
      return spec.n >= 1 ? addDaysYmd(start, spec.n - 1) : null;
    case "weekDay":
      return spec.week >= 1 && spec.day >= 1 ? addDaysYmd(start, 7 * (spec.week - 1) + (spec.day - 1)) : null;
    case "relative":
      return addDaysYmd(ctx.today, spec.offset);
    case "weekday": {
      if (spec.week) {
        const weekStart = resolveWeekRef(spec.week, ctx);
        if (!weekStart) return null;
        // A "Week N" ref starts on the plan's start day (any weekday); a "Week of" ref on a Monday.
        return nextWeekdayOnOrAfter(weekStart, spec.weekday);
      }
      const from = cursor && cursor > start ? cursor : start;
      return nextWeekdayOnOrAfter(from, spec.weekday);
    }
    case "week":
      return resolveWeekRef(spec.week, ctx);
  }
}

/** True when resolving this spec depends on the plan's start date (so the preview asks for one). */
export function specIsRelative(spec: DateSpec | null): boolean {
  if (!spec) return false;
  if (spec.kind === "dayN" || spec.kind === "weekDay") return true;
  if (spec.kind === "weekday") return !spec.week || spec.week.kind === "n";
  if (spec.kind === "week") return spec.week.kind === "n";
  return false;
}

// --- time ---

const TIME_RES: { re: RegExp; build: (m: RegExpExecArray) => number | null }[] = [
  // 6pm, 6 pm, 6:30PM, 6:30 p.m., 6p
  {
    re: /(?:^|[\s@(,])(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?(?:m\.?)?(?![a-z])/i,
    build: (m) => {
      let h = Number(m[1]);
      const min = m[2] ? Number(m[2]) : 0;
      if (h < 1 || h > 12 || min > 59) return null;
      if (m[3]!.toLowerCase() === "p" && h !== 12) h += 12;
      if (m[3]!.toLowerCase() === "a" && h === 12) h = 0;
      return h * 60 + min;
    },
  },
  // 18:00, 7:30 (24h)
  {
    re: /(?:^|[\s@(,T])(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?::\d{2})?(?![\d/])/,
    build: (m) => Number(m[1]) * 60 + Number(m[2]),
  },
  { re: /(?:^|[\s@(,])(noon|midday)\b/i, build: () => 12 * 60 },
];

export function findTime(s: string): { time: string; text: string; index: number } | null {
  for (const t of TIME_RES) {
    const m = t.re.exec(s);
    if (!m) continue;
    const minutes = t.build(m);
    if (minutes === null) continue;
    const lead = m[0].length - m[0].trimStart().length;
    const text = m[0].slice(lead);
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    return { time: `${hh}:${mm}`, text, index: m.index + lead };
  }
  return null;
}

/** A whole cell/segment that is only a time ("6pm", "18:00", "@ 7:30 PM"). */
export function parseTimeText(s: string): string | null {
  const t = findTime(` ${s.trim()}`);
  if (!t) return null;
  const rest = (` ${s.trim()}`.slice(0, t.index) + ` ${s.trim()}`.slice(t.index + t.text.length)).replace(/[\s@()]|at/gi, "");
  return rest.length === 0 ? t.time : null;
}

/** "18:00" → "6:00 PM" */
export function formatTime12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}
