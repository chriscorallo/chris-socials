import { consumeDatePrefix, detectPastedTable, parseFreeText } from "../plan-import/freetext";
import { normalizeTitleKey } from "../plan-import/rows";
import { suggestTableMapping, tableToRows } from "../plan-import/table";
import type { ParseContext, ParseResult, PlanDraftRow } from "../plan-import/types";
import type { PlanContextMessage } from "./types";

/**
 * Finding the video plan inside the conversation — with the SAME deterministic parsers as
 * `/plan/import` (markdown tables, pasted cells, "Mon 10/19 — title" lists, Week/Day
 * headings). A message is a plan candidate when it yields at least 3 titled rows and most of
 * them carry a date (absolute or "Day 3" / "Week 2 Mon"). ChatGPT usually revises a plan
 * several times or delivers it week by week: candidates whose titles are mostly repeated in
 * a NEWER candidate are marked superseded, so the default selection is "the latest version
 * of every part" — Chris can change it. Nothing is created here; rows go to the normal import
 * preview, which de-duplicates against what's already planned.
 */

export interface PlanCandidate {
  messageIndex: number;
  at: string | null;
  kind: "table" | "list";
  rowCount: number;
  datedCount: number;
  firstYmd: string | null;
  lastYmd: string | null;
  usesRelativeDates: boolean;
  sampleTitles: string[];
  /** A newer candidate repeats most of these titles (an older draft of the same plan). */
  supersededBy: number | null;
}

export const MIN_PLAN_ROWS = 3;

/**
 * ChatGPT wraps plans in chat prose ("That keeps the pillars balanced across the week.") that
 * the plan parser would read as a row ("the week" looks like a date). Drop plain sentence
 * lines: not a bullet/number/table/heading/"Label:" line, no leading date, ≥ 6 words, ending
 * in . ! or ?. Plan lines ("Mon 10/19 — Why I stopped budgeting.") start with a date or a
 * bullet and are kept.
 */
export function stripChatProse(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^([-*•+]|\d+[.)]|\||#|>)/.test(t)) return true;
      if (/^[A-Za-z][A-Za-z /-]{0,24}[:：]/.test(t)) return true;
      if (consumeDatePrefix(t).specs.length > 0) return true;
      const words = t.split(/\s+/).length;
      return !(words >= 6 && /[.!?]["”')]?$/.test(t));
    })
    .join("\n");
}

function parseOne(raw: string, ctx: ParseContext): { res: ParseResult; kind: "table" | "list" } {
  const text = stripChatProse(raw);
  const table = detectPastedTable(text);
  if (table) return { res: tableToRows(table, suggestTableMapping(table), ctx), kind: "table" };
  return { res: parseFreeText(text, ctx), kind: "list" };
}

export function findPlanCandidates(messages: PlanContextMessage[], ctx: ParseContext): PlanCandidate[] {
  const found: (PlanCandidate & { keys: Set<string> })[] = [];
  messages.forEach((m, messageIndex) => {
    if (m.text.length < 40) return;
    const { res, kind } = parseOne(m.text, ctx);
    const titled = res.rows.filter((r) => r.title.trim().length > 0);
    const dated = titled.filter((r) => r.spec || r.ymd);
    if (titled.length < MIN_PLAN_ROWS || dated.length < MIN_PLAN_ROWS || dated.length < titled.length * 0.5) return;
    const ymds = dated.map((r) => r.ymd).filter((y): y is string => !!y).sort();
    found.push({
      messageIndex,
      at: m.at,
      kind,
      rowCount: titled.length,
      datedCount: dated.length,
      firstYmd: ymds[0] ?? null,
      lastYmd: ymds[ymds.length - 1] ?? null,
      usesRelativeDates: res.usesRelativeDates,
      sampleTitles: titled.slice(0, 3).map((r) => r.title),
      supersededBy: null,
      keys: new Set(titled.map((r) => normalizeTitleKey(r.title))),
    });
  });
  // Newest first; an older candidate is superseded when ≥ 50% of its titles reappear in a
  // newer, not-itself-superseded candidate.
  for (let i = found.length - 1; i >= 0; i--) {
    const c = found[i]!;
    for (let j = found.length - 1; j > i; j--) {
      const newer = found[j]!;
      if (newer.supersededBy !== null) continue;
      let shared = 0;
      for (const k of c.keys) if (newer.keys.has(k)) shared++;
      if (shared >= Math.max(2, c.keys.size * 0.5)) {
        c.supersededBy = newer.messageIndex;
        break;
      }
    }
  }
  return found
    .map((c): PlanCandidate => ({
      messageIndex: c.messageIndex,
      at: c.at,
      kind: c.kind,
      rowCount: c.rowCount,
      datedCount: c.datedCount,
      firstYmd: c.firstYmd,
      lastYmd: c.lastYmd,
      usesRelativeDates: c.usesRelativeDates,
      sampleTitles: c.sampleTitles,
      supersededBy: c.supersededBy,
    }))
    .reverse();
}

/**
 * Rows from several messages, each parsed on its own (a table in one and a list in another
 * must not confuse each other), re-keyed so they can't collide in the preview.
 */
export function parsePlanSegments(texts: string[], ctx: ParseContext): ParseResult {
  const rows: PlanDraftRow[] = [];
  let usesRelativeDates = false;
  texts.forEach((t, si) => {
    const { res } = parseOne(t, ctx);
    if (res.usesRelativeDates) usesRelativeDates = true;
    for (const r of res.rows) rows.push({ ...r, key: texts.length > 1 ? `s${si + 1}${r.key}` : r.key });
  });
  return { rows, usesRelativeDates };
}
