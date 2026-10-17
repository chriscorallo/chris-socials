import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { suggestTableMapping, tableToRows } from "@chris/domain/plan-import";
import { readXlsxSheets, cellToString } from "./plan-xlsx";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ctx = { today: "2026-10-17", enabledPlatforms: ["TIKTOK" as const, "INSTAGRAM" as const, "YOUTUBE" as const] };

describe("plan import — .xlsx", () => {
  it("reads the fixture: hidden tab skipped, dates/times/rich text/checkbox columns understood", async () => {
    const buf = readFileSync(join(ROOT, "fixtures", "plans", "november-plan.xlsx"));
    const sheets = await readXlsxSheets(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    expect(sheets.map((s) => s.name)).toEqual(["November plan"]);
    const cells = sheets[0]!.rows;
    expect(cells[1]).toEqual(["Week", "Post date", "Time", "Topic", "Hook", "TikTok", "IG", "YT", "Notes"]);
    expect(cells[2]!.slice(0, 3)).toEqual(["Week 1", "2026-11-02", "18:00"]);
    const mapping = suggestTableMapping(cells);
    expect(mapping.headerRow).toBe(1); // blank rows are dropped by the reader
    const { rows } = tableToRows(cells, mapping, ctx);
    expect(rows.map((r) => [r.ymd, r.time, r.title, r.platforms.join("+")])).toEqual([
      ["2026-11-02", "18:00", "Stop paying for these 5 subscriptions", "TIKTOK+INSTAGRAM"],
      ["2026-11-03", "12:30", "Roth vs Traditional IRA", "YOUTUBE"],
      ["2026-11-05", null, "My biggest money mistake", "TIKTOK"],
      ["2026-11-09", "19:00", "How to negotiate your salary", "TIKTOK+YOUTUBE"],
      ["2026-11-11", null, "The 24-hour rule for spending", "INSTAGRAM"],
      ["2026-11-13", null, "Sinking funds explained", "TIKTOK+INSTAGRAM+YOUTUBE"],
    ]);
    expect(rows[0]!.hook).toBe("You're paying for things you forgot about.");
    expect(rows[0]!.notes).toBe("screen-record the bank app");
  });

  it("cell conversions", () => {
    expect(cellToString(new Date(Date.UTC(2026, 9, 20)))).toBe("2026-10-20");
    expect(cellToString(new Date(Date.UTC(2026, 9, 20, 18, 30)))).toBe("2026-10-20 18:30");
    expect(cellToString(new Date(Date.UTC(1899, 11, 30, 7, 5)))).toBe("07:05");
    expect(cellToString({ formula: "A1", result: "Hi" } as ExcelJS.CellValue)).toBe("Hi");
    expect(cellToString({ text: "Link", hyperlink: "https://x" } as ExcelJS.CellValue)).toBe("Link");
    expect(cellToString(true)).toBe("TRUE");
    expect(cellToString(null)).toBe("");
  });

  it("rejects a non-xlsx file", async () => {
    await expect(readXlsxSheets(new TextEncoder().encode("not a zip").buffer as ArrayBuffer)).rejects.toThrow();
  });
});
