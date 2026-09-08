import { describe, it, expect } from "vitest";
import { mondayOf, toWeekParam, parseWeekParam, toDatetimeLocal } from "./calendar-week";

describe("calendar-week — the Calendar navigation date bug, pinned down", () => {
  it("parseWeekParam followed by mondayOf lands on the exact requested Monday, not one week off", () => {
    // The literal bug report: Next's target href was "?week=2026-09-14" (a Monday) but the
    // page rendered "Week of September 7" — a full week short. This is the regression test
    // for that exact case, run in this process's actual timezone (whatever CI/dev uses),
    // not a specific hardcoded one — the bug was timezone-*dependent*, so a test that only
    // passes by coincidence in UTC wouldn't have caught it.
    const parsed = parseWeekParam("2026-09-14");
    expect(parsed).not.toBeNull();
    const monday = mondayOf(parsed!);
    expect(toWeekParam(monday)).toBe("2026-09-14");
  });

  it("Prev's target (a date one week before 'this week') round-trips exactly too", () => {
    // The other half of the bug report: "Prev works" was also wrong — it silently overshot
    // by landing on August 24 instead of the requested August 31.
    const parsed = parseWeekParam("2026-08-31");
    expect(parsed).not.toBeNull();
    const monday = mondayOf(parsed!);
    expect(toWeekParam(monday)).toBe("2026-08-31");
  });

  it("mondayOf is idempotent on a date that's already a Monday", () => {
    const monday = new Date(2026, 8, 14); // September 14, 2026 is a Monday
    expect(toWeekParam(mondayOf(monday))).toBe("2026-09-14");
  });

  it("mondayOf resolves a Sunday to the Monday six days earlier, not the next Monday", () => {
    const sunday = new Date(2026, 8, 20); // September 20, 2026 is a Sunday
    expect(toWeekParam(mondayOf(sunday))).toBe("2026-09-14");
  });

  it("mondayOf resolves a mid-week date to that same week's Monday", () => {
    const thursday = new Date(2026, 8, 17); // September 17, 2026 is a Thursday
    expect(toWeekParam(mondayOf(thursday))).toBe("2026-09-14");
  });

  it("a chain of week params (simulating repeated Next clicks) advances by exactly 7 days each hop", () => {
    let current = parseWeekParam("2026-09-07")!;
    const weeks = [toWeekParam(current)];
    for (let i = 0; i < 4; i++) {
      const next = new Date(current.getTime() + 7 * 24 * 60 * 60 * 1000);
      current = mondayOf(next);
      weeks.push(toWeekParam(current));
    }
    expect(weeks).toEqual(["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"]);
  });

  it("toWeekParam never goes through UTC serialization — same local date in, same string out, regardless of time-of-day", () => {
    const midnight = new Date(2026, 8, 14, 0, 0, 0);
    const almostMidnight = new Date(2026, 8, 14, 23, 59, 59);
    expect(toWeekParam(midnight)).toBe("2026-09-14");
    expect(toWeekParam(almostMidnight)).toBe("2026-09-14");
  });

  it("parseWeekParam rejects malformed input instead of silently misparsing it", () => {
    expect(parseWeekParam("not-a-date")).toBeNull();
    expect(parseWeekParam("2026-13-01")).toBeNull(); // month 13 doesn't exist
    expect(parseWeekParam("")).toBeNull();
  });

  it("toDatetimeLocal formats using local getters, matching toWeekParam's date portion", () => {
    const date = new Date(2026, 8, 14, 9, 5);
    expect(toDatetimeLocal(date)).toBe("2026-09-14T09:05");
  });
});
