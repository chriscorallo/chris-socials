/**
 * Pure date helpers behind the Calendar's week navigation
 * (apps/web/app/calendar/page.tsx) — pulled out into their own module specifically so they're
 * unit-testable. A page component's local helper functions can't be imported by a test file,
 * and this exact class of bug (a date-only string parsed as UTC, then read back with local
 * getters) is exactly the kind of thing that silently regresses without a real test — see
 * /docs/DECISIONS.md's Calendar week-navigation correction entry for the bug this module
 * fixes.
 */

export function mondayOf(date: Date): Date {
  const day = date.getDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/** Formats a Date's LOCAL calendar date as YYYY-MM-DD. Never `.toISOString()` — that
 * serializes in UTC, and callers here always pass local-midnight dates, so in any timezone
 * ahead of UTC that round-trips to the previous calendar day. */
export function toWeekParam(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Parses a `?week=YYYY-MM-DD` param as a LOCAL calendar date (local midnight) — deliberately
 * NOT `new Date(param)`. A date-only ISO string parses per spec as **UTC** midnight, but
 * `mondayOf` reads it back with local getters (`getDay`, `getDate`, ...). In any timezone
 * behind UTC (e.g. PDT, UTC-7) that pair silently rolls the effective date back a day, which
 * cascades into landing on the wrong Monday entirely — this was a real, shipped bug (the
 * Calendar's "Next" button appeared to do nothing; "Prev" appeared to work but actually
 * overshot by an extra day's worth of week). Returns null for anything that isn't a bare
 * YYYY-MM-DD string.
 */
export function parseWeekParam(param: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(param);
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m) - 1;
  const day = Number(d);
  const date = new Date(year, month, day);
  // JS Date silently rolls an out-of-range month/day into the following month/year (e.g.
  // month 12 becomes January of the next year) instead of failing — reject that instead of
  // accepting a value that doesn't mean what was written. Round-tripping the constructed
  // date's own components back against the input catches it.
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function toDatetimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
