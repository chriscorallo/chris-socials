import { describe, it, expect } from "vitest";
import { matchClipsToPlan, nameSimilarity, jaroWinkler, tokens, dateCloseness, type PlannedTarget } from "../plan-import";

const TZ = "America/Los_Angeles";
// Saturday Oct 17 2026, 10:00 local
const NOW = Date.parse("2026-10-17T17:00:00Z");
const at = (iso: string) => Date.parse(iso);

const planned: PlannedTarget[] = [
  { id: "myths", title: "5 Money Myths Nobody Tells You", ymd: "2026-10-19" },
  { id: "budget", title: "Why I Stopped Budgeting", ymd: "2026-10-20" },
  { id: "rule", title: "The 50/30/20 Rule Is Broken", ymd: "2026-10-21" },
  { id: "routine", title: "My $0 Morning Routine", ymd: "2026-10-22" },
  { id: "later", title: "Roth vs Traditional IRA", ymd: "2026-11-03" },
];

describe("matchClipsToPlan — helpers", () => {
  it("tokenizes filenames, dropping camera noise and numbers", () => {
    expect(tokens("IMG_4031.MOV")).toEqual([]);
    expect(tokens("VID_20261016_183012.mp4")).toEqual([]);
    expect(tokens("money-myths take 2.mov")).toEqual(["money", "myth"]);
    expect(tokens("StoppedBudgeting_final.mp4")).toEqual(["stopped", "budgeting"]);
  });

  it("Jaro-Winkler basics", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961, 2);
    expect(jaroWinkler("", "x")).toBe(0);
    expect(jaroWinkler("abc", "abc")).toBe(1);
  });

  it("name similarity: partial names match their title, camera names don't", () => {
    expect(nameSimilarity("money-myths take 2.mov", "5 Money Myths Nobody Tells You")).toBeGreaterThan(0.8);
    expect(nameSimilarity("morning routine.mov", "My $0 Morning Routine")).toBeGreaterThan(0.8);
    expect(nameSimilarity("budgetting.mov", "Why I Stopped Budgeting")).toBeGreaterThan(0.5);
    expect(nameSimilarity("IMG_4031.MOV", "5 Money Myths Nobody Tells You")).toBe(0);
    expect(nameSimilarity("money-myths.mov", "Roth vs Traditional IRA")).toBeLessThan(0.3);
  });

  it("date closeness favours filming on/just before the post day", () => {
    expect(dateCloseness("2026-10-19", "2026-10-19", 5, 2)).toBe(1);
    expect(dateCloseness("2026-10-17", "2026-10-19", 5, 2)).toBeGreaterThan(dateCloseness("2026-10-14", "2026-10-19", 5, 2));
    expect(dateCloseness("2026-10-20", "2026-10-19", 5, 2)).toBeGreaterThan(0);
    expect(dateCloseness("2026-10-25", "2026-10-19", 5, 2)).toBe(0);
    expect(dateCloseness(null, "2026-10-19", 5, 2)).toBe(0);
  });
});

describe("matchClipsToPlan", () => {
  it("matches by name with high confidence; several takes can map to one video", () => {
    const res = matchClipsToPlan(
      [
        { name: "money myths take 1.mov", lastModified: at("2026-10-16T20:00:00Z"), size: 1 },
        { name: "money myths take 2.mov", lastModified: at("2026-10-16T20:05:00Z"), size: 1 },
        { name: "morning-routine.mp4", lastModified: at("2026-10-16T21:00:00Z"), size: 1 },
      ],
      planned,
      { tz: TZ, now: NOW },
    );
    expect(res.map((r) => r.contentItemId)).toEqual(["myths", "myths", "routine"]);
    expect(res.every((r) => r.confidence === "high")).toBe(true);
    expect(res[0]!.reason).toMatch(/Name matches · Filmed 3 days before/);
  });

  it("camera-named clips: matched by capture date, in order within the day", () => {
    const res = matchClipsToPlan(
      [
        // picked out of order on purpose — order is by capture time
        { name: "IMG_4033.MOV", lastModified: at("2026-10-16T19:30:00Z"), size: 1 },
        { name: "IMG_4031.MOV", lastModified: at("2026-10-16T18:00:00Z"), size: 1 },
        { name: "IMG_4032.MOV", lastModified: at("2026-10-16T18:45:00Z"), size: 1 },
      ],
      planned,
      { tz: TZ, now: NOW },
    );
    expect(res.map((r) => r.contentItemId)).toEqual(["rule", "myths", "budget"]);
    expect(res.every((r) => r.confidence === "low")).toBe(true);
    expect(res[1]!.reason).toContain("by order");
  });

  it("a name match claims its video first; date-only clips take the remaining ones", () => {
    const res = matchClipsToPlan(
      [
        { name: "IMG_1.MOV", lastModified: at("2026-10-18T18:00:00Z"), size: 1 },
        { name: "myths.mov", lastModified: at("2026-10-18T19:00:00Z"), size: 1 },
      ],
      planned,
      { tz: TZ, now: NOW },
    );
    expect(res[1]!.contentItemId).toBe("myths");
    expect(res[0]!.contentItemId).toBe("budget");
  });

  it("a single planned video in the date window → medium confidence", () => {
    const res = matchClipsToPlan([{ name: "IMG_9.MOV", lastModified: at("2026-11-02T18:00:00Z"), size: 1 }], planned, { tz: TZ, now: NOW });
    expect(res[0]).toMatchObject({ contentItemId: "later", confidence: "medium" });
  });

  it("iOS pick-time timestamps (≈ now) are ignored, not read as 'filmed today'", () => {
    const res = matchClipsToPlan([{ name: "IMG_5.MOV", lastModified: NOW - 60_000, size: 1 }], [{ id: "today", title: "X", ymd: "2026-10-17" }], { tz: TZ, now: NOW });
    expect(res[0]).toMatchObject({ contentItemId: null, confidence: "none", reason: "No name or date to go on" });
  });

  it("nothing near → unmatched (UI offers New video / Skip)", () => {
    const res = matchClipsToPlan([{ name: "vacation.mov", lastModified: at("2026-09-01T18:00:00Z"), size: 1 }], planned, { tz: TZ, now: NOW });
    expect(res[0]).toMatchObject({ contentItemId: null, confidence: "none", reason: "No planned video near its date" });
  });

  it("ambiguous names → low confidence", () => {
    const res = matchClipsToPlan(
      [{ name: "money.mov", lastModified: 0, size: 1 }],
      [
        { id: "a", title: "Money myths", ymd: "2026-10-19" },
        { id: "b", title: "Money mistakes", ymd: "2026-10-20" },
      ],
      { tz: TZ, now: NOW },
    );
    expect(res[0]!.confidence).toBe("low");
  });

  it("empty inputs", () => {
    expect(matchClipsToPlan([], planned, { tz: TZ, now: NOW })).toEqual([]);
    expect(matchClipsToPlan([{ name: "a.mov", lastModified: 0, size: 1 }], [], { tz: TZ, now: NOW })[0]!.contentItemId).toBeNull();
  });
});
