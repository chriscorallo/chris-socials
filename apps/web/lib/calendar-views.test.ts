import { describe, it, expect } from "vitest";
import {
  monthGrid,
  weekDays,
  viewRange,
  shiftAnchor,
  viewTitle,
  layoutOverlaps,
  parseView,
  formatMinutes,
  snapMinutes,
} from "./calendar-views";

describe("monthGrid", () => {
  it("covers the month with whole Monday-first weeks incl. leading/trailing days", () => {
    const g = monthGrid("2026-10-17");
    // Oct 1 2026 is a Thursday → grid starts Mon Sep 28; Oct 31 is Saturday → ends Sun Nov 1.
    expect(g[0]![0]).toBe("2026-09-28");
    expect(g[0]![3]).toBe("2026-10-01");
    expect(g[g.length - 1]![6]).toBe("2026-11-01");
    expect(g).toHaveLength(5);
    expect(g.every((w) => w.length === 7)).toBe(true);
  });

  it("produces 6 rows when the month needs them and 4 for a perfect February", () => {
    expect(monthGrid("2026-08-01")).toHaveLength(6); // Aug 1 2026 = Saturday, 31 days
    expect(monthGrid("2027-02-10")).toHaveLength(4); // Feb 1 2027 = Monday, 28 days
  });
});

describe("ranges, navigation, titles", () => {
  it("week is Monday–Sunday around the anchor", () => {
    expect(weekDays("2026-10-18")[0]).toBe("2026-10-12");
    expect(viewRange("week", "2026-10-17")).toEqual({ start: "2026-10-12", end: "2026-10-19" });
    expect(viewRange("day", "2026-10-17")).toEqual({ start: "2026-10-17", end: "2026-10-18" });
    expect(viewRange("month", "2026-10-17")).toEqual({ start: "2026-09-28", end: "2026-11-02" });
  });

  it("prev/next move by the view's unit (month clamps to the 1st)", () => {
    expect(shiftAnchor("month", "2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftAnchor("week", "2026-10-17", -1)).toBe("2026-10-10");
    expect(shiftAnchor("day", "2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftAnchor("agenda", "2026-10-17", 1)).toBe("2026-11-14");
  });

  it("titles read like a calendar app", () => {
    expect(viewTitle("month", "2026-10-17")).toBe("October 2026");
    expect(viewTitle("week", "2026-10-17")).toBe("Oct 12 – 18, 2026");
    expect(viewTitle("week", "2026-10-28")).toBe("Oct 26 – Nov 1, 2026");
    expect(viewTitle("day", "2026-10-17")).toBe("Saturday, Oct 17");
  });

  it("parses views and formats times", () => {
    expect(parseView("month")).toBe("month");
    expect(parseView("year")).toBeNull();
    expect(formatMinutes(18 * 60)).toBe("6:00 PM");
    expect(formatMinutes(9 * 60 + 30, true)).toBe("9:30a");
    expect(formatMinutes(0, true)).toBe("12a");
    expect(snapMinutes(127)).toBe(120);
    expect(snapMinutes(-5)).toBe(0);
    expect(snapMinutes(24 * 60 + 10)).toBe(24 * 60 - 15);
  });
});

describe("layoutOverlaps", () => {
  it("leaves non-overlapping events full width", () => {
    const m = layoutOverlaps([
      { id: "a", startMin: 60, endMin: 120 },
      { id: "b", startMin: 120, endMin: 180 },
    ]);
    expect(m.get("a")).toEqual({ col: 0, cols: 1 });
    expect(m.get("b")).toEqual({ col: 0, cols: 1 });
  });

  it("puts overlapping events side by side and shares the cluster's column count", () => {
    const m = layoutOverlaps([
      { id: "a", startMin: 60, endMin: 180 },
      { id: "b", startMin: 90, endMin: 150 },
      { id: "c", startMin: 160, endMin: 220 }, // overlaps a only → reuses b's column
      { id: "d", startMin: 300, endMin: 360 }, // separate cluster
    ]);
    expect(m.get("a")).toEqual({ col: 0, cols: 2 });
    expect(m.get("b")).toEqual({ col: 1, cols: 2 });
    expect(m.get("c")).toEqual({ col: 1, cols: 2 });
    expect(m.get("d")).toEqual({ col: 0, cols: 1 });
  });

  it("three at the same time → three columns", () => {
    const m = layoutOverlaps(["x", "y", "z"].map((id) => ({ id, startMin: 600, endMin: 660 })));
    expect([...m.values()].map((v) => v.col).sort()).toEqual([0, 1, 2]);
    expect([...m.values()].every((v) => v.cols === 3)).toBe(true);
  });
});
