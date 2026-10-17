import { describe, it, expect } from "vitest";
import {
  assignDefaultTimes,
  matchClipsToPlan,
  parseDelimited,
  parseFreeText,
  suggestTableMapping,
  summarizeRows,
  summaryLine,
  tableToRows,
  validateRows,
} from "../plan-import";
import { addDaysYmd, ownerStarterPostingPlanData } from "../planning";

// Chris's real volume: 4 videos a day, each cross-posted to TikTok, Instagram and YouTube
// (12 posts/day). A month plan ≈ 120 videos × 3 platforms.
const ctx = { today: "2026-10-17", enabledPlatforms: ["TIKTOK" as const, "INSTAGRAM" as const, "YOUTUBE" as const] };
const plan = ownerStarterPostingPlanData("2026-10-19", "America/Los_Angeles");

function monthCsv(days = 30, perDay = 4): string {
  const lines = ["Date,Title,Platforms,Hook"];
  for (let d = 0; d < days; d++) {
    const ymd = addDaysYmd("2026-10-19", d);
    const [, m, day] = ymd.split("-").map(Number) as [number, number, number];
    for (let k = 1; k <= perDay; k++) lines.push(`${m}/${day},Day ${d + 1} video ${k} about topic ${d * perDay + k},all,Hook ${k}`);
  }
  return lines.join("\n");
}

describe("plan import at Chris's volume (4/day × 3 apps)", () => {
  it("parses a 120-video month quickly and spreads untimed videos over the 4 daily slots", () => {
    const t0 = performance.now();
    const table = parseDelimited(monthCsv());
    const { rows } = tableToRows(table, suggestTableMapping(table), ctx);
    const v = validateRows(rows, []);
    const ms = performance.now() - t0;
    expect(rows).toHaveLength(120);
    expect(summaryLine(summarizeRows(v))).toBe("120 videos over Oct 19 – Nov 17 · TikTok 120 · Reels 120 · Shorts 120");
    expect(ms).toBeLessThan(500);

    const times = assignDefaultTimes(rows, plan);
    expect(times.slice(0, 5)).toEqual(["09:00", "12:00", "17:00", "20:00", "09:00"]);
    // every day gets exactly the 4 slots
    const perDay = new Map<string, string[]>();
    rows.forEach((r, i) => perDay.set(r.ymd!, [...(perDay.get(r.ymd!) ?? []), times[i]!]));
    expect([...perDay.values()].every((ts) => ts.join() === "09:00,12:00,17:00,20:00")).toBe(true);
  });

  it("explicit times win; the remaining videos take the free slots", () => {
    const rows = [
      { ymd: "2026-10-19", time: "12:00", platforms: ctx.enabledPlatforms },
      { ymd: "2026-10-19", time: null, platforms: ctx.enabledPlatforms },
      { ymd: "2026-10-19", time: null, platforms: ctx.enabledPlatforms },
      { ymd: "2026-10-19", time: null, platforms: ctx.enabledPlatforms },
      { ymd: "2026-10-19", time: null, platforms: ctx.enabledPlatforms }, // a 5th: cycles
    ];
    expect(assignDefaultTimes(rows, plan)).toEqual(["12:00", "09:00", "17:00", "20:00", "09:00"]);
  });

  it("free text with 4 numbered videos under each day heading", () => {
    const parts: string[] = [];
    for (let d = 0; d < 7; d++) {
      parts.push(`${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][d]} ${10}/${19 + d}`);
      for (let k = 1; k <= 4; k++) parts.push(`${k}. Video ${d}-${k} on budgeting`);
    }
    const { rows } = parseFreeText(parts.join("\n"), ctx);
    expect(rows).toHaveLength(28);
    expect(rows.filter((r) => r.ymd === "2026-10-19")).toHaveLength(4);
    expect(rows.every((r) => r.warnings.length === 0)).toBe(true);
  });

  it("matching 60 clips against 400 planned videos stays fast", () => {
    const planned = Array.from({ length: 400 }, (_, i) => ({ id: `v${i}`, title: `Video ${i} about ${["money", "budget", "invest", "credit", "rent"][i % 5]} ${["myths", "tips", "mistakes", "rules"][i % 4]}`, ymd: addDaysYmd("2026-10-19", Math.floor(i / 4)) }));
    const files = Array.from({ length: 60 }, (_, i) => ({ name: i % 2 ? `IMG_${4000 + i}.MOV` : `budget tips take ${i}.mov`, lastModified: Date.parse("2026-10-18T18:00:00Z") + i * 60_000, size: 1 }));
    const t0 = performance.now();
    const res = matchClipsToPlan(files, planned, { tz: "America/Los_Angeles", now: Date.parse("2026-10-25T00:00:00Z") });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(res).toHaveLength(60);
    expect(res.filter((r) => r.contentItemId).length).toBeGreaterThan(50);
  });
});
