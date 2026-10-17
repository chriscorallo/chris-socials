import { describe, it, expect } from "vitest";
import {
  zonedTimeToUtc,
  ymdInTz,
  minutesInTz,
  addDaysYmd,
  addMonthsYmd,
  mondayOfYmd,
  parseYmd,
  parseLocalDateTimeInTz,
  toLocalDateTimeInTz,
  startOfDayInTz,
  tzOffsetMinutes,
} from "../tz";
import {
  generatePlanSlots,
  matchSlotsToSchedule,
  groupSlots,
  weeklyPattern,
  spreadIndices,
  defaultPostingPlanData,
  type PostingPlanData,
} from "../posting-plan-core";

const LA = "America/Los_Angeles";

function plan(overrides: Partial<PostingPlanData> = {}): PostingPlanData {
  return { ...defaultPostingPlanData("2026-01-01", LA), ...overrides };
}

describe("tz helpers (explicit zone, DST-correct)", () => {
  it("converts LA wall time to UTC on both sides of the DST change", () => {
    // PDT (UTC-7) before Nov 1 2026, PST (UTC-8) after.
    expect(zonedTimeToUtc(2026, 10, 30, 19, 0, LA).toISOString()).toBe("2026-10-31T02:00:00.000Z");
    expect(zonedTimeToUtc(2026, 11, 2, 19, 0, LA).toISOString()).toBe("2026-11-03T03:00:00.000Z");
    // Spring forward (Mar 8 2026): 19:00 is PDT.
    expect(zonedTimeToUtc(2026, 3, 8, 19, 0, LA).toISOString()).toBe("2026-03-09T02:00:00.000Z");
    expect(tzOffsetMinutes(new Date("2026-07-01T12:00:00Z"), LA)).toBe(-420);
    expect(tzOffsetMinutes(new Date("2026-12-01T12:00:00Z"), LA)).toBe(-480);
  });

  it("handles the fall-back day (25h) — midnight-to-midnight and an evening slot", () => {
    const start = startOfDayInTz("2026-11-01", LA);
    const next = startOfDayInTz("2026-11-02", LA);
    expect((next.getTime() - start.getTime()) / 3_600_000).toBe(25);
    expect(ymdInTz(zonedTimeToUtc(2026, 11, 1, 18, 0, LA), LA)).toBe("2026-11-01");
    expect(minutesInTz(zonedTimeToUtc(2026, 11, 1, 18, 0, LA), LA)).toBe(18 * 60);
  });

  it("is independent of the process TZ — a late-evening LA time is still that LA day", () => {
    // 23:30 PDT = 06:30Z next day.
    const d = new Date("2026-10-17T06:30:00Z");
    expect(ymdInTz(d, LA)).toBe("2026-10-16");
    expect(ymdInTz(d, "UTC")).toBe("2026-10-17");
    expect(ymdInTz(d, "Asia/Tokyo")).toBe("2026-10-17");
  });

  it("does ymd arithmetic without instants", () => {
    expect(addDaysYmd("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysYmd("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonthsYmd("2026-01-31", 1)).toBe("2026-02-28");
    expect(mondayOfYmd("2026-10-17")).toBe("2026-10-12"); // Sat -> Mon
    expect(mondayOfYmd("2026-10-18")).toBe("2026-10-12"); // Sun -> previous Mon
    expect(mondayOfYmd("2026-10-12")).toBe("2026-10-12");
    expect(parseYmd("2026-02-30")).toBeNull();
    expect(parseYmd("2026-2-3")).toBeNull();
  });

  it("round-trips datetime-local values in the app zone", () => {
    const d = parseLocalDateTimeInTz("2026-10-22T19:00", LA)!;
    expect(d.toISOString()).toBe("2026-10-23T02:00:00.000Z");
    expect(toLocalDateTimeInTz(d, LA)).toBe("2026-10-22T19:00");
    expect(parseLocalDateTimeInTz("garbage", LA)).toBeNull();
  });
});

describe("weeklyPattern / spreadIndices", () => {
  it("spreads fewer posts than days evenly and never repeats a day", () => {
    expect(spreadIndices(7, 3)).toEqual([0, 2, 5]);
    expect(new Set(spreadIndices(7, 5)).size).toBe(5);
    expect(spreadIndices(5, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(spreadIndices(3, 0)).toEqual([]);
  });

  it("uses only the preferred days, Monday-first", () => {
    const p = weeklyPattern({ platform: "TIKTOK", enabled: true, postsPerWeek: 3, preferredDays: [1, 3, 5], preferredTimes: ["19:00"] });
    expect(p).toEqual([
      { weekday: 1, minutes: 1140 },
      { weekday: 3, minutes: 1140 },
      { weekday: 5, minutes: 1140 },
    ]);
  });

  it("doubles up on days using the allowed times when posts > days, capped at days × times", () => {
    const p = weeklyPattern({ platform: "TIKTOK", enabled: true, postsPerWeek: 5, preferredDays: [1, 3], preferredTimes: ["09:00", "18:00"] });
    expect(p).toHaveLength(4); // 2 days × 2 times cap
    const q = weeklyPattern({ platform: "TIKTOK", enabled: true, postsPerWeek: 3, preferredDays: [1, 3], preferredTimes: ["09:00", "18:00"] });
    expect(q).toHaveLength(3);
    expect(q.filter((x) => x.weekday === 1)).toHaveLength(2);
  });

  it("empty days = whole week, empty times = 18:00, disabled = nothing", () => {
    const p = weeklyPattern({ platform: "YOUTUBE", enabled: true, postsPerWeek: 7, preferredDays: [], preferredTimes: [] });
    expect(p).toHaveLength(7);
    expect(p.every((x) => x.minutes === 18 * 60)).toBe(true);
    expect(weeklyPattern({ platform: "YOUTUBE", enabled: false, postsPerWeek: 7, preferredDays: [], preferredTimes: [] })).toEqual([]);
  });
});

describe("generatePlanSlots", () => {
  it("generates the default plan's 12 slots for one LA week at local 6pm", () => {
    const from = startOfDayInTz("2026-10-19", LA);
    const to = startOfDayInTz("2026-10-26", LA);
    const slots = generatePlanSlots(plan(), from, to);
    expect(slots).toHaveLength(5 + 4 + 3);
    expect(slots.every((s) => s.time === "18:00" && s.weekStart === "2026-10-19")).toBe(true);
    expect(slots.filter((s) => s.platform === "TIKTOK").map((s) => s.ymd)).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    // 6pm PDT = 01:00Z next day.
    expect(slots[0]!.at.toISOString()).toBe("2026-10-20T01:00:00.000Z");
  });

  it("keeps the local time fixed across the DST change (6pm stays 6pm)", () => {
    const from = startOfDayInTz("2026-10-26", LA);
    const to = startOfDayInTz("2026-11-09", LA);
    const slots = generatePlanSlots(plan({ cadences: [{ platform: "TIKTOK", enabled: true, postsPerWeek: 1, preferredDays: [1], preferredTimes: ["18:00"] }] }), from, to);
    expect(slots.map((s) => s.at.toISOString())).toEqual(["2026-10-27T01:00:00.000Z", "2026-11-03T02:00:00.000Z"]);
    expect(slots.every((s) => minutesInTz(s.at, LA) === 18 * 60)).toBe(true);
  });

  it("respects the window bounds and the plan start date", () => {
    const from = startOfDayInTz("2026-10-19", LA);
    const to = startOfDayInTz("2026-10-26", LA);
    expect(generatePlanSlots(plan({ startDate: "2026-10-22" }), from, to).every((s) => s.ymd >= "2026-10-22")).toBe(true);
    const midweek = zonedTimeToUtc(2026, 10, 21, 18, 30, LA);
    expect(generatePlanSlots(plan(), midweek, to).every((s) => s.at >= midweek)).toBe(true);
    expect(generatePlanSlots(plan(), to, from)).toEqual([]);
  });

  it("is deterministic and sorted", () => {
    const from = startOfDayInTz("2026-10-01", LA);
    const to = startOfDayInTz("2026-11-30", LA);
    const a = generatePlanSlots(plan(), from, to);
    const b = generatePlanSlots(plan(), from, to);
    expect(a.map((s) => s.key)).toEqual(b.map((s) => s.key));
    for (let i = 1; i < a.length; i++) expect(a[i]!.at.getTime()).toBeGreaterThanOrEqual(a[i - 1]!.at.getTime());
  });
});

describe("matchSlotsToSchedule", () => {
  const from = startOfDayInTz("2026-10-19", LA);
  const to = startOfDayInTz("2026-10-26", LA);
  const slots = generatePlanSlots(plan(), from, to);

  it("fills a slot with a same-platform post on the same local day within ±3h", () => {
    const post = { id: "p1", at: zonedTimeToUtc(2026, 10, 19, 16, 15, LA), platforms: ["TIKTOK", "INSTAGRAM"] };
    const { matches, unmatchedPosts } = matchSlotsToSchedule(slots, [post], { tz: LA });
    const mon = matches.filter((m) => m.slot.ymd === "2026-10-19");
    expect(mon.find((m) => m.slot.platform === "TIKTOK")?.filledBy?.id).toBe("p1");
    expect(mon.find((m) => m.slot.platform === "INSTAGRAM")?.filledBy?.id).toBe("p1");
    expect(mon.find((m) => m.slot.platform === "YOUTUBE")?.filledBy).toBeNull();
    expect(unmatchedPosts).toEqual([]);
  });

  it("doesn't fill outside the tolerance, on another day, or another platform", () => {
    const posts = [
      { id: "early", at: zonedTimeToUtc(2026, 10, 19, 9, 0, LA), platforms: ["TIKTOK"] }, // 9h off
      { id: "nextday", at: zonedTimeToUtc(2026, 10, 20, 0, 30, LA), platforms: ["TIKTOK"] }, // different local day
      { id: "wrongplat", at: zonedTimeToUtc(2026, 10, 19, 18, 0, LA), platforms: ["YOUTUBE"] },
    ];
    const { matches, unmatchedPosts } = matchSlotsToSchedule(slots, posts, { tz: LA });
    expect(matches.find((m) => m.slot.ymd === "2026-10-19" && m.slot.platform === "TIKTOK")?.filledBy).toBeNull();
    expect(matches.find((m) => m.slot.ymd === "2026-10-19" && m.slot.platform === "YOUTUBE")?.filledBy?.id).toBe("wrongplat");
    expect(unmatchedPosts.map((p) => p.id).sort()).toEqual(["early", "nextday"]);
  });

  it("uses each post at most once per platform; the nearer post wins", () => {
    const twoSlotsSameDay = generatePlanSlots(
      plan({ cadences: [{ platform: "TIKTOK", enabled: true, postsPerWeek: 2, preferredDays: [1], preferredTimes: ["12:00", "14:00"] }] }),
      from,
      to,
    );
    const posts = [
      { id: "a", at: zonedTimeToUtc(2026, 10, 19, 13, 50, LA), platforms: ["TIKTOK"] },
      { id: "b", at: zonedTimeToUtc(2026, 10, 19, 12, 5, LA), platforms: ["TIKTOK"] },
    ];
    const { matches } = matchSlotsToSchedule(twoSlotsSameDay, posts, { tz: LA });
    expect(matches.map((m) => m.filledBy?.id)).toEqual(["b", "a"]);
  });

  it("groups open slots that share a time into one video", () => {
    const groups = groupSlots(slots);
    const mon = groups.find((g) => g.ymd === "2026-10-19")!;
    expect(mon.platforms.sort()).toEqual(["INSTAGRAM", "TIKTOK", "YOUTUBE"]);
    expect(groups.length).toBe(5); // Mon–Fri
  });
});

describe("high-volume plan: 4 posts a day on every app", () => {
  it("produces 4 slots per day per platform — 84 a week across TikTok, Instagram, YouTube", () => {
    const fourADay = (platform: "TIKTOK" | "INSTAGRAM" | "YOUTUBE") => ({
      platform,
      enabled: true,
      postsPerWeek: 28,
      preferredDays: [] as number[],
      preferredTimes: ["09:00", "12:00", "17:00", "20:00"],
    });
    const p = plan({ startDate: "2026-01-01", cadences: [fourADay("TIKTOK"), fourADay("INSTAGRAM"), fourADay("YOUTUBE")] });
    const from = new Date("2026-10-19T07:00:00Z"); // Mon 00:00 Pacific
    const to = new Date("2026-10-26T07:00:00Z");
    const slots = generatePlanSlots(p, from, to);
    expect(slots).toHaveLength(84);
    const perDayPerPlatform = new Map<string, number>();
    for (const s of slots) perDayPerPlatform.set(`${s.ymd}|${s.platform}`, (perDayPerPlatform.get(`${s.ymd}|${s.platform}`) ?? 0) + 1);
    expect([...perDayPerPlatform.values()].every((n) => n === 4)).toBe(true);
  });
});

