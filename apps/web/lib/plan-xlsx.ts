import ExcelJS from "exceljs";

/**
 * .xlsx → plain string cells, one array per sheet, for the plan importer's table parser.
 * Server-only (exceljs is a Node library; ~1 MB that has no business in the phone bundle).
 * exceljs (MIT) rather than the SheetJS npm package, whose npm releases are years out of date.
 *
 * Cell conversions: dates → "YYYY-MM-DD" (or "YYYY-MM-DD HH:mm" when a time is set), pure
 * times (Excel's 1899-12-30 epoch) → "HH:mm", formulas → their cached result, rich text and
 * hyperlinks → their text, booleans → "TRUE"/"FALSE" (so a checkbox column reads as ticked).
 */
export interface SheetCells {
  name: string;
  rows: string[][];
}

const pad = (n: number) => String(n).padStart(2, "0");

function dateCell(d: Date): string {
  // exceljs returns Excel dates as UTC instants of the wall time written in the sheet.
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (d.getUTCFullYear() <= 1900) return hm; // time-only cell
  return hm === "00:00" ? ymd : `${ymd} ${hm}`;
}

export function cellToString(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return dateCell(value);
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((r) => r.text).join("").trim();
    if ("result" in value) return cellToString((value as { result?: ExcelJS.CellValue }).result ?? null);
    if ("text" in value && typeof value.text === "string") return value.text.trim();
    if ("error" in value) return "";
  }
  return String(value);
}

export const MAX_XLSX_BYTES = 5 * 1024 * 1024;

export async function readXlsxSheets(data: ArrayBuffer): Promise<SheetCells[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const out: SheetCells[] = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== "visible") return;
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      // row.values is 1-based with a hole at 0
      const values = row.values as ExcelJS.CellValue[];
      for (let c = 1; c < values.length; c++) cells.push(cellToString(values[c] ?? null));
      if (cells.some((v) => v !== "")) rows.push(cells);
    });
    if (rows.length) out.push({ name: ws.name, rows: rows.slice(0, 2000) });
  });
  return out;
}
