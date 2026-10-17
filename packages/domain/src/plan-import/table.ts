import { parseDateText, parseTimeText } from "./dates";
import { headerPlatform, isTruthyCell, parsePlatforms } from "./platforms";
import { emptyPartial, finalizeRows, type PartialRow } from "./rows";
import type { PlanPlatform } from "../posting-plan-core";
import type { ParseContext, ParseResult } from "./types";

/**
 * Spreadsheet-shaped plans (CSV/TSV files, .xlsx sheets, Google Sheets exports, pasted cells,
 * markdown tables): header auto-mapping by synonyms, a mapping Chris can correct, then rows.
 */

export type ColumnField =
  | "ignore"
  | "date"
  | "time"
  | "title"
  | "platforms"
  | "hook"
  | "notes"
  | "format"
  | "pillar"
  | "week"
  | `platform:${PlanPlatform}`;

export const FIELD_LABELS: Record<string, string> = {
  ignore: "Ignore",
  date: "Date / day",
  time: "Time",
  title: "Title",
  platforms: "Platforms",
  hook: "Hook",
  notes: "Notes",
  format: "Format",
  pillar: "Pillar",
  week: "Week",
  "platform:TIKTOK": "TikTok (tick)",
  "platform:INSTAGRAM": "Instagram (tick)",
  "platform:YOUTUBE": "YouTube (tick)",
};

const SYNONYMS: [Exclude<ColumnField, "ignore" | `platform:${string}`>, string[]][] = [
  ["date", ["date", "day", "post date", "posting date", "publish date", "publish day", "post day", "when", "scheduled", "schedule", "schedule date", "go live", "live date", "due", "due date", "air date", "release date", "date posted", "upload date"]],
  ["time", ["time", "post time", "posting time", "publish time", "hour", "time to post"]],
  ["title", ["title", "topic", "idea", "video", "video title", "video idea", "concept", "content", "content idea", "subject", "name", "headline", "post", "video topic", "working title"]],
  ["platforms", ["platform", "platforms", "channel", "channels", "where", "network", "networks", "social", "socials", "post on", "post to"]],
  ["hook", ["hook", "hooks", "opening line", "opener", "first line", "hook line", "opening", "intro"]],
  ["notes", ["notes", "note", "description", "talking points", "script", "outline", "details", "key points", "caption", "cta", "call to action", "body", "summary", "angle", "points", "content notes", "bullet points", "b roll", "broll", "visuals", "shots", "comments"]],
  ["format", ["format", "type", "style", "content type", "video type", "video format"]],
  ["pillar", ["pillar", "category", "theme", "bucket", "content pillar", "series", "pillars"]],
  ["week", ["week", "wk", "week number", "week #"]],
];

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[“”"'`*_#()?:.]/g, " ").replace(/\s+/g, " ").trim();
}

export function fieldForHeader(header: string): ColumnField {
  const h = normHeader(header);
  if (!h) return "ignore";
  const plat = headerPlatform(h);
  if (plat) return `platform:${plat}`;
  for (const [field, words] of SYNONYMS) if (words.includes(h)) return field;
  // Partial: "Post Date (PST)", "Video Title / Topic", "Hook idea"
  for (const [field, words] of SYNONYMS) if (words.some((w) => w.length > 2 && (h.startsWith(`${w} `) || h.endsWith(` ${w}`)))) return field;
  return "ignore";
}

/** Auto-maps headers. Each single-value field is used once (the first column wins); notes may repeat. */
export function autoMapColumns(headers: string[]): ColumnField[] {
  const used = new Set<ColumnField>();
  return headers.map((h) => {
    const f = fieldForHeader(h);
    if (f === "ignore" || f === "notes") return f;
    if (used.has(f)) return f === "title" || f === "hook" ? "notes" : "ignore";
    used.add(f);
    return f;
  });
}

/** RFC-4180-ish CSV/TSV parse (quoted fields, doubled quotes, CR/LF), auto-detecting the delimiter. */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const delim = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  const score = (d: string) => {
    const counts = sample.map((l) => l.split(d).length - 1);
    const nonzero = counts.filter((c) => c > 0);
    return nonzero.length >= Math.max(1, Math.ceil(sample.length / 2)) ? Math.min(...nonzero) * nonzero.length : 0;
  };
  const candidates = ["\t", ",", ";", "|"].map((d) => ({ d, s: score(d) }));
  candidates.sort((a, b) => b.s - a.s);
  return candidates[0]!.s > 0 ? candidates[0]!.d : ",";
}

/** Markdown pipe table ("| Date | Title |\n|---|---|\n| … |") → cells; null if it isn't one. */
export function parseMarkdownTable(text: string): string[][] | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("|"));
  if (lines.length < 2) return null;
  const rows = lines
    .filter((l) => !/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l))
    .map((l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.replace(/\*\*/g, "").trim()));
  return rows.length >= 2 ? rows : null;
}

/** Which of the first rows is the header (most recognized column names); -1 when none is. */
export function findHeaderRow(table: string[][]): number {
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < Math.min(6, table.length); i++) {
    const fields = table[i]!.map(fieldForHeader).filter((f) => f !== "ignore");
    const hasCore = fields.some((f) => f === "title" || f === "date");
    const score = fields.length + (hasCore ? 1 : 0);
    if (score > bestScore && (fields.length >= 2 || hasCore)) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

/** No header row: guess columns from their content (dates, platform lists, times, text). */
export function inferMappingFromContent(table: string[][]): ColumnField[] {
  const width = Math.max(...table.map((r) => r.length));
  const fields: ColumnField[] = new Array(width).fill("ignore");
  const stats = Array.from({ length: width }, (_, c) => {
    const cells = table.map((r) => r[c] ?? "").filter(Boolean);
    const n = Math.max(1, cells.length);
    return {
      c,
      date: cells.filter((v) => parseDateText(v)).length / n,
      time: cells.filter((v) => parseTimeText(v)).length / n,
      plat: cells.filter((v) => parsePlatforms(v).pure).length / n,
      avgLen: cells.reduce((s, v) => s + v.length, 0) / n,
      filled: cells.length,
    };
  });
  let dateCol = -1;
  for (const s of stats) {
    if (s.date >= 0.6 && dateCol < 0) {
      fields[s.c] = "date";
      dateCol = s.c;
    } else if (s.time >= 0.6) fields[s.c] = "time";
    else if (s.plat >= 0.6) fields[s.c] = "platforms";
  }
  const text = stats.filter((s) => fields[s.c] === "ignore" && s.filled > 0);
  if (text[0]) fields[text[0].c] = "title";
  for (const s of text.slice(1)) fields[s.c] = "notes";
  return fields;
}

export interface TableMapping {
  headerRow: number;
  fields: ColumnField[];
}

export function suggestTableMapping(table: string[][]): TableMapping {
  const headerRow = findHeaderRow(table);
  if (headerRow >= 0) {
    const fields = autoMapColumns(table[headerRow]!);
    // A header we couldn't name at all but the column is clearly dates/platforms: fill in.
    if (!fields.includes("title") || !fields.some((f) => f === "date" || f === "week")) {
      const inferred = inferMappingFromContent(table.slice(headerRow + 1));
      inferred.forEach((f, i) => {
        if (fields[i] === "ignore" && f !== "ignore" && !fields.includes(f)) fields[i] = f;
      });
    }
    return { headerRow, fields };
  }
  return { headerRow: -1, fields: inferMappingFromContent(table) };
}

/** Rows → drafts using a (possibly Chris-corrected) mapping. */
export function tableToRows(table: string[][], mapping: TableMapping, ctx: ParseContext): ParseResult {
  const headers = mapping.headerRow >= 0 ? table[mapping.headerRow]! : [];
  const body = table.slice(mapping.headerRow + 1);
  const partials: PartialRow[] = [];
  let lastWeek = "";
  let lastDateText = "";
  body.forEach((cells, i) => {
    const p = emptyPartial(mapping.headerRow + 2 + i);
    const dateParts: string[] = [];
    let week = "";
    const platformFlags: PlanPlatform[] = [];
    let anyContent = false;
    mapping.fields.forEach((field, c) => {
      const v = (cells[c] ?? "").trim();
      if (!v) return;
      switch (field) {
        case "ignore":
          return;
        case "date":
          dateParts.push(v);
          break;
        case "week":
          week = /^\d+$/.test(v) ? `Week ${v}` : v;
          break;
        case "time":
          p.time = parseTimeText(v) ?? p.time;
          break;
        case "title":
          p.title = v;
          anyContent = true;
          break;
        case "platforms": {
          const pp = parsePlatforms(v, ctx.enabledPlatforms);
          p.platforms = [...(p.platforms ?? []), ...pp.platforms];
          p.unknownPlatforms.push(...pp.unknown);
          break;
        }
        case "hook":
          p.hook = v;
          anyContent = true;
          break;
        case "notes":
          p.notes.push(headers[c] && mapping.fields.filter((f) => f === "notes").length > 1 ? `${headers[c]}: ${v}` : v);
          anyContent = true;
          break;
        case "format":
          p.format = v;
          break;
        case "pillar":
          p.pillarText = v;
          break;
        default:
          if (field.startsWith("platform:") && isTruthyCell(v)) platformFlags.push(field.slice(9) as PlanPlatform);
      }
    });
    if (!anyContent) {
      // A row with only a week label (merged "Week 2" row) still sets the week for rows below.
      if (week) lastWeek = week;
      return;
    }
    if (week) lastWeek = week;
    if (platformFlags.length) p.platforms = [...new Set([...(p.platforms ?? []), ...platformFlags])];
    let dateText = dateParts.join(" ");
    if (!dateText && lastDateText) {
      // Merged "date" cells: the date sits on the first row of each day only.
      dateText = lastDateText;
      p.inheritedDate = true;
    }
    if (dateText && !p.inheritedDate) lastDateText = dateText;
    const full = [lastWeek && !/\bweek\b|\bwk\b/i.test(dateText) && !/\d{1,2}[/.]\d{1,2}|\d{4}-/.test(dateText) ? lastWeek : "", dateText]
      .filter(Boolean)
      .join(" ");
    p.dateText = full;
    const parsed = full ? parseDateText(full) : null;
    if (parsed) {
      p.spec = parsed.spec;
      p.range = parsed.range;
      p.time ??= parsed.time;
    }
    partials.push(p);
  });
  return finalizeRows(partials, ctx);
}
