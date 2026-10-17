import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseDateText,
  resolveDateSpec,
  nearestYear,
  parseTimeText,
  findTime,
  parsePlatforms,
  headerPlatform,
  parseDelimited,
  detectDelimiter,
  parseMarkdownTable,
  autoMapColumns,
  suggestTableMapping,
  tableToRows,
  parseFreeText,
  consumeDatePrefix,
  validateRows,
  summarizeRows,
  summaryLine,
  defaultTimeFor,
  enabledPlatformsOf,
  googleSheetCsvUrl,
  googleSheetFetchError,
  looksLikeGoogleSheetLink,
  reresolveRows,
  canonicalCommitRows,
  plannedDescription,
  excelSerialToYmd,
  plannedVideoStatus,
  type ParseContext,
} from "../plan-import";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const fixture = (name: string) => readFileSync(join(ROOT, "fixtures", "plans", name), "utf8");

// Saturday, Oct 17 2026.
const ctx: ParseContext = { today: "2026-10-17", enabledPlatforms: ["TIKTOK", "INSTAGRAM", "YOUTUBE"] };
const ymdOf = (text: string, c: ParseContext = ctx) => {
  const p = parseDateText(text);
  return p ? resolveDateSpec(p.spec, c) : null;
};

describe("plan import — dates", () => {
  it("reads ISO, US numeric, month names, weekday prefixes and Excel serials", () => {
    expect(ymdOf("2026-10-20")).toBe("2026-10-20");
    expect(ymdOf("2026/10/20")).toBe("2026-10-20");
    expect(ymdOf("10/20")).toBe("2026-10-20");
    expect(ymdOf("10/20/2026")).toBe("2026-10-20");
    expect(ymdOf("10/20/26")).toBe("2026-10-20");
    expect(ymdOf("Tue 10/20")).toBe("2026-10-20");
    expect(ymdOf("Oct 20")).toBe("2026-10-20");
    expect(ymdOf("October 20th")).toBe("2026-10-20");
    expect(ymdOf("Tuesday, Oct. 20, 2026")).toBe("2026-10-20");
    expect(ymdOf("20 Oct")).toBe("2026-10-20");
    expect(ymdOf("20th of October")).toBe("2026-10-20");
    expect(ymdOf("46315")).toBe(excelSerialToYmd(46315));
    expect(excelSerialToYmd(46315)).toBe("2026-10-20");
  });

  it("missing years resolve to the nearest upcoming date (60-day look-back)", () => {
    expect(nearestYear(1, 3, "2026-12-20")).toBe(2027);
    expect(nearestYear(10, 10, "2026-10-17")).toBe(2026); // a plan that started last week stays put
    expect(nearestYear(6, 1, "2026-10-17")).toBe(2027);
    expect(ymdOf("Jan 3", { ...ctx, today: "2026-12-20" })).toBe("2027-01-03");
  });

  it("rejects impossible dates and non-dates", () => {
    expect(ymdOf("2/30")).toBeNull();
    expect(parseDateText("someday")).toBeNull();
    expect(parseDateText("Monday motivation")).toBeNull();
    expect(parseDateText("")).toBeNull();
  });

  it("reads relative plans against the start date (Week N / Day N / weekdays)", () => {
    const c = { ...ctx, startDate: "2026-11-02" }; // a Monday
    expect(ymdOf("Day 1", c)).toBe("2026-11-02");
    expect(ymdOf("Day 10", c)).toBe("2026-11-11");
    expect(ymdOf("Week 2 Day 3", c)).toBe("2026-11-11");
    expect(ymdOf("W2D3", c)).toBe("2026-11-11");
    expect(ymdOf("Week 2 Mon", c)).toBe("2026-11-09");
    expect(ymdOf("Week 2, Friday", c)).toBe("2026-11-13");
    expect(ymdOf("Week of Nov 9", c)).toBe("2026-11-09");
    expect(ymdOf("Wed", c)).toBe("2026-11-04");
    expect(ymdOf("today")).toBe("2026-10-17");
    expect(ymdOf("tomorrow")).toBe("2026-10-18");
  });

  it("ranges use the first day and are flagged", () => {
    const p = parseDateText("Oct 20 - 24")!;
    expect(p.range).toBe(true);
    expect(resolveDateSpec(p.spec, ctx)).toBe("2026-10-20");
    expect(parseDateText("10/20-10/24")!.range).toBe(true);
  });

  it("pulls a time out of a date cell", () => {
    expect(parseDateText("10/20 6pm")).toMatchObject({ time: "18:00" });
    expect(parseDateText("2026-10-20T07:30:00")).toMatchObject({ time: "07:30" });
  });
});

describe("plan import — time & platforms", () => {
  it("parses common time spellings", () => {
    expect(parseTimeText("6pm")).toBe("18:00");
    expect(parseTimeText("6:30 PM")).toBe("18:30");
    expect(parseTimeText("6:30 p.m.")).toBe("18:30");
    expect(parseTimeText("12am")).toBe("00:00");
    expect(parseTimeText("12pm")).toBe("12:00");
    expect(parseTimeText("18:00")).toBe("18:00");
    expect(parseTimeText("@ 7pm")).toBe("19:00");
    expect(parseTimeText("noon")).toBe("12:00");
    expect(parseTimeText("6 money tips")).toBeNull();
    expect(findTime("post at 9am sharp")?.time).toBe("09:00");
  });

  it("normalizes platform words; 'all' means the plan's enabled platforms", () => {
    expect(parsePlatforms("TikTok, Reels").platforms).toEqual(["TIKTOK", "INSTAGRAM"]);
    expect(parsePlatforms("TT/IG/YT").platforms).toEqual(["TIKTOK", "INSTAGRAM", "YOUTUBE"]);
    expect(parsePlatforms("IG Reels & YT Shorts").platforms).toEqual(["INSTAGRAM", "YOUTUBE"]);
    expect(parsePlatforms("tiktok reels").platforms).toEqual(["TIKTOK", "INSTAGRAM"]);
    expect(parsePlatforms("all", ["TIKTOK", "YOUTUBE"]).platforms).toEqual(["TIKTOK", "YOUTUBE"]);
    expect(parsePlatforms("Facebook")).toEqual({ platforms: [], unknown: ["facebook"], pure: true });
    expect(parsePlatforms("My morning routine").pure).toBe(false);
    expect(headerPlatform("YT Shorts")).toBe("YOUTUBE");
  });
});

describe("plan import — tables", () => {
  it("CSV parse handles quotes, embedded commas/newlines, CRLF, BOM; detects tabs/semicolons", () => {
    expect(parseDelimited('﻿a,"b, c","d ""q"""\r\n1,"line\nbreak",3\r\n')).toEqual([
      ["a", "b, c", 'd "q"'],
      ["1", "line\nbreak", "3"],
    ]);
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
  });

  it("auto-maps headers by synonym", () => {
    expect(autoMapColumns(["Post Date", "Video Idea", "Platform(s)", "Hook", "Talking Points / Notes", "When to post?", "Pillar"])).toEqual([
      "date", "title", "platforms", "hook", "notes", "ignore", "pillar",
    ]);
    expect(autoMapColumns(["Week", "Day", "Topic", "TikTok", "IG", "YT"])).toEqual([
      "week", "date", "title", "platform:TIKTOK", "platform:INSTAGRAM", "platform:YOUTUBE",
    ]);
  });

  it("parses the messy real-world CSV fixture", () => {
    const table = parseDelimited(fixture("october-plan-messy.csv"));
    const mapping = suggestTableMapping(table);
    expect(mapping.headerRow).toBe(1); // title row + blank row skipped
    const { rows } = tableToRows(table, mapping, ctx);
    expect(rows).toHaveLength(23);
    const first = rows[0]!;
    expect(first).toMatchObject({ title: "5 Money Myths Nobody Tells You", ymd: "2026-10-19", time: "18:00", platforms: ["TIKTOK", "INSTAGRAM"], hook: "Your parents lied to you about money." });
    expect(rows.find((r) => r.title.startsWith("Hot take"))).toMatchObject({ ymd: "2026-10-22", warnings: [expect.stringContaining("same day")] });
    expect(rows.find((r) => r.title.startsWith("Q&A"))!.warnings.join()).toContain("Facebook");
    expect(rows.find((r) => r.title.startsWith("Ask me"))).toMatchObject({ ymd: null });
    expect(rows.find((r) => r.title.startsWith("Why I Stopped"))!.platforms).toEqual(["TIKTOK", "INSTAGRAM", "YOUTUBE"]);
    const v = validateRows(rows, []);
    expect(summaryLine(summarizeRows(v))).toBe("22 videos over Oct 19 – Nov 18 · TikTok 16 · Reels 15 · Shorts 12");
  });

  it("checkbox platform columns + a week column carried down + relative weekdays", () => {
    const table = [
      ["Week", "Day", "Topic", "TikTok", "IG", "YT"],
      ["1", "Mon", "Intro video", "x", "", "✓"],
      ["", "Wed", "Second", "", "yes", ""],
      ["2", "Mon", "Third", "x", "x", "x"],
    ];
    const { rows, usesRelativeDates } = tableToRows(table, suggestTableMapping(table), { ...ctx, startDate: "2026-11-02" });
    expect(usesRelativeDates).toBe(true);
    expect(rows.map((r) => [r.ymd, r.platforms.join("+")])).toEqual([
      ["2026-11-02", "TIKTOK+YOUTUBE"],
      ["2026-11-04", "INSTAGRAM"],
      ["2026-11-09", "TIKTOK+INSTAGRAM+YOUTUBE"],
    ]);
  });

  it("headerless sheets: columns inferred from content", () => {
    const table = [
      ["10/20", "Money myths", "TikTok", "6pm"],
      ["10/21", "Budget hacks", "Reels", "7pm"],
    ];
    const m = suggestTableMapping(table);
    expect(m.headerRow).toBe(-1);
    expect(m.fields).toEqual(["date", "title", "platforms", "time"]);
    expect(tableToRows(table, m, ctx).rows[1]).toMatchObject({ title: "Budget hacks", ymd: "2026-10-21", time: "19:00", platforms: ["INSTAGRAM"] });
  });

  it("markdown pipe tables (ChatGPT) parse as tables", () => {
    const md = "| Date | Title | Platforms |\n|---|---|---|\n| Oct 20 | **Money myths** | TikTok |\n| Oct 21 | Budget hacks | All |";
    expect(parseMarkdownTable(md)).toHaveLength(3);
    const { rows } = parseFreeText(md, ctx);
    expect(rows.map((r) => r.title)).toEqual(["Money myths", "Budget hacks"]);
  });

  it("pasted spreadsheet cells (tab-separated) parse as a table", () => {
    const { rows } = parseFreeText("Date\tTitle\n10/20\tMoney myths\n10/21\tBudget hacks", ctx);
    expect(rows.map((r) => r.ymd)).toEqual(["2026-10-20", "2026-10-21"]);
  });
});

describe("plan import — free text", () => {
  it("parses the ChatGPT-style fixture (week headings, day headings, labeled bullets, trailing chatter)", () => {
    const { rows } = parseFreeText(fixture("chatgpt-plan.txt"), ctx);
    expect(rows.map((r) => [r.ymd, r.title])).toEqual([
      ["2026-10-19", "5 Money Myths Nobody Tells You"],
      ["2026-10-20", "Why I Stopped Budgeting"],
      ["2026-10-21", "The 50/30/20 Rule Is Broken"],
      ["2026-10-21", "Hot take: emergency funds are overrated"],
      ["2026-10-22", "My $0 Morning Routine"],
      ["2026-10-26", "How I'd invest my first $1000"],
      ["2026-10-27", "Credit score in 60 seconds"],
      ["2026-10-28", "The latte factor is a lie"],
      ["2026-10-30", "What I spend in a week (NYC)"],
    ]);
    expect(rows[0]).toMatchObject({ hook: "Your parents lied to you about money.", platforms: ["TIKTOK", "INSTAGRAM"], notes: "Quick-fire list, one myth per cut." });
    expect(rows[1]!.notes).toContain("CTA:");
    expect(rows[2]).toMatchObject({ time: "19:30", platforms: ["TIKTOK", "YOUTUBE"] });
    expect(rows[5]).toMatchObject({ time: "18:00", platforms: ["TIKTOK", "INSTAGRAM", "YOUTUBE"] });
    expect(rows[6]).toMatchObject({ hook: "Your credit score is a game. Here are the rules.", platformsDefaulted: true });
  });

  it("simple Notes-app lists", () => {
    const text = `Mon 10/19 — 5 money myths — TikTok, Reels
10/20 Why I stopped budgeting (all) 6pm
- 10/21: Sunday reset routine | IG
Monday motivation tips`;
    const { rows } = parseFreeText(text, ctx);
    expect(rows[0]).toMatchObject({ ymd: "2026-10-19", title: "5 money myths", platforms: ["TIKTOK", "INSTAGRAM"] });
    expect(rows[1]).toMatchObject({ ymd: "2026-10-20", title: "Why I stopped budgeting", time: "18:00" });
    expect(rows[2]).toMatchObject({ ymd: "2026-10-21", title: "Sunday reset routine", platforms: ["INSTAGRAM"] });
    // "Monday motivation tips" is a title, not a date
    expect(rows[3]).toMatchObject({ title: "Monday motivation tips", ymd: null });
  });

  it("relative 'Day N' plans and bare weekday lists roll forward", () => {
    const { rows, usesRelativeDates } = parseFreeText("Day 1: Intro\nDay 2: Second\nDay 8: Third", { ...ctx, startDate: "2026-11-02" });
    expect(usesRelativeDates).toBe(true);
    expect(rows.map((r) => r.ymd)).toEqual(["2026-11-02", "2026-11-03", "2026-11-09"]);
    const wk = parseFreeText("Mon: A\nWed: B\nMon: C", { ...ctx, startDate: "2026-11-02" });
    expect(wk.rows.map((r) => r.ymd)).toEqual(["2026-11-02", "2026-11-04", "2026-11-09"]);
  });

  it("re-resolves relative dates when the start date changes, keeping hand-set dates", () => {
    const { rows } = parseFreeText("Day 1: Intro\nDay 3: Third", { ...ctx, startDate: "2026-11-02" });
    const edited = [{ ...rows[0]!, spec: null, ymd: "2026-12-25" }, rows[1]!];
    expect(reresolveRows(edited, { ...ctx, startDate: "2026-11-09" }).map((r) => r.ymd)).toEqual(["2026-12-25", "2026-11-11"]);
  });

  it("warns when the weekday written doesn't match the date", () => {
    const { rows } = parseFreeText("Mon 10/20 — Money myths", ctx);
    expect(rows[0]!.ymd).toBe("2026-10-20");
    expect(rows[0]!.warnings.join()).toContain("is a Tuesday");
  });

  it("date prefix consumption stops at title words", () => {
    expect(consumeDatePrefix("Day 1 – Monday, Oct 19: Title").rest).toBe("Title");
    expect(consumeDatePrefix("Sunday reset routine").specs).toHaveLength(0);
    expect(consumeDatePrefix("Money tips").specs).toHaveLength(0);
  });
});

describe("plan import — preview, defaults, sheets", () => {
  it("flags duplicates (existing and within the import) and rows that need fixing", () => {
    const { rows } = parseFreeText("10/20 Money myths\n10/20 money MYTHS!\n10/21 Old one\nNo date here - TikTok", ctx);
    const v = validateRows(rows, [{ title: "Old one", ymd: "2026-10-21", contentItemId: "x" }]);
    expect(v.map((r) => r.status)).toEqual(["ok", "duplicate", "duplicate", "needsDate"]);
    expect(v[2]!.existingId).toBe("x");
    expect(summarizeRows(v)).toMatchObject({ count: 1, duplicates: 2, needsFix: 1 });
  });

  it("default time comes from the posting plan, else Chris's 4 daily slots", () => {
    const plan = {
      cadences: [
        { platform: "TIKTOK" as const, enabled: true, postsPerWeek: 5, preferredDays: [1, 2, 3], preferredTimes: ["19:00", "08:00"] },
        { platform: "YOUTUBE" as const, enabled: true, postsPerWeek: 3, preferredDays: [], preferredTimes: ["12:00"] },
        { platform: "INSTAGRAM" as const, enabled: false, postsPerWeek: 0, preferredDays: [], preferredTimes: [] },
      ],
    };
    expect(defaultTimeFor("2026-10-19", ["TIKTOK"], plan)).toBe("08:00");
    expect(defaultTimeFor("2026-10-23", ["TIKTOK", "YOUTUBE"], plan)).toBe("12:00"); // Friday: TikTok doesn't post
    expect(defaultTimeFor("2026-10-23", ["INSTAGRAM"], plan)).toBe("09:00");
    expect(defaultTimeFor("2026-10-23", ["TIKTOK"], null)).toBe("09:00");
    expect(enabledPlatformsOf(plan)).toEqual(["TIKTOK", "YOUTUBE"]);
  });

  it("Google Sheets links → CSV export URLs", () => {
    const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    expect(googleSheetCsvUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=123`)).toBe(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=123`);
    expect(googleSheetCsvUrl(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`)).toBe(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv`);
    expect(googleSheetCsvUrl(`https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml?gid=7&single=true`)).toBe(`https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv&gid=7`);
    expect(googleSheetCsvUrl("https://evil.example.com/spreadsheets/d/x")).toBeNull();
    expect(googleSheetCsvUrl("http://docs.google.com/spreadsheets/d/" + id)).toBeNull();
    expect(looksLikeGoogleSheetLink(` https://docs.google.com/spreadsheets/d/${id}/edit `)).toBe(true);
    expect(googleSheetFetchError(200, "text/csv")).toBeNull();
    expect(googleSheetFetchError(200, "text/html; charset=utf-8")).toContain("Anyone with the link");
    expect(googleSheetFetchError(404, null)).toContain("doesn't exist");
  });

  it("commit helpers: order-independent canonical rows, description keeps hook + notes only", () => {
    const a = { title: "A", ymd: "2026-10-20", time: null, platforms: ["TIKTOK" as const], hook: null, notes: null, format: null, pillar: null };
    const b = { ...a, title: "B", ymd: "2026-10-21" };
    expect(canonicalCommitRows([a, b])).toBe(canonicalCommitRows([b, a]));
    expect(plannedDescription({ hook: "Hi", notes: "Note" })).toBe("Hook: Hi\n\nNote");
    expect(plannedDescription({ hook: null, notes: " " })).toBeUndefined();
  });

  it("plan board status: anything not filmed yet → Upload footage", () => {
    expect(plannedVideoStatus("SELECTED")).toMatchObject({ label: "Not filmed yet", action: { kind: "UPLOAD" }, canUpload: true });
    expect(plannedVideoStatus("SCRIPTED").action.kind).toBe("UPLOAD");
    expect(plannedVideoStatus("MEDIA_INGESTED")).toMatchObject({ action: { kind: "START_EDIT" }, filmed: true });
    expect(plannedVideoStatus("SCHEDULED")).toMatchObject({ label: "Scheduled", canUpload: false });
  });
});
