import { combineSpecs, matchDateAt, parseDateText, parseTimeText, type DateSpec, type WeekRef } from "./dates";
import { parsePlatforms } from "./platforms";
import { emptyPartial, finalizeRows, type PartialRow } from "./rows";
import { parseDelimited, parseMarkdownTable, suggestTableMapping, tableToRows } from "./table";
import type { ParseContext, ParseResult } from "./types";
import type { PlanPlatform } from "../posting-plan-core";

/**
 * Free-text plans — whatever Chris pastes from Notes, Docs or a ChatGPT answer:
 *
 *   Week 1 (Oct 20–26)
 *   Mon 10/20 — 5 money myths — TikTok, Reels
 *   - Tue: Why I stopped budgeting (all) 6pm
 *   **Day 3 – Wednesday, Oct 22: "The 50/30/20 rule is broken"**
 *     - Hook: Your budget is lying to you
 *     - Platforms: TikTok, YT Shorts
 *
 * A small line grammar, no model: week headings set a week context, day headings set the
 * current day, an item line is "[date] [sep] title [sep platforms] [(time)]" in any order, and
 * "Label: value" lines (Hook/Notes/Platforms/Time/…) attach to the item above. A pasted
 * table (tabs from a spreadsheet, or a markdown pipe table) is routed to the table parser.
 */

type LabelField = "title" | "hook" | "notes" | "platforms" | "time" | "date" | "format" | "pillar" | "noteLabeled";

const LABELS: [RegExp, LabelField][] = [
  [/^(?:title|video title|topic|idea|video idea|video|concept|headline)$/i, "title"],
  [/^(?:hook|hooks|opening line|opener|first line|hook line|opening)$/i, "hook"],
  [/^(?:notes?|description|talking points?|script|outline|details|key points?|summary|points|body)$/i, "notes"],
  [/^(?:platforms?|channels?|post on|post to|where|networks?)$/i, "platforms"],
  [/^(?:time|post time|posting time|publish time)$/i, "time"],
  [/^(?:date|day|post date|posting date|publish date|when|scheduled)$/i, "date"],
  [/^(?:format|type|style|video type)$/i, "format"],
  [/^(?:pillar|category|theme|content pillar|bucket)$/i, "pillar"],
  [/^(?:cta|call to action|caption|angle|b-?roll|visuals?|shots?|props?|location|filming notes?|why|goal|value)$/i, "noteLabeled"],
];

function labelOf(word: string): LabelField | null {
  const w = word.replace(/[*_]/g, "").trim();
  for (const [re, f] of LABELS) if (re.test(w)) return f;
  return null;
}

const BULLET_RE = /^(?:[-*•·◦▪►–]|\d{1,3}[.)]|\[[ xX]?\])\s+/;
const SEP_SPLIT = /\s+[—–|]\s+|\s+-\s+|\s*\t+\s*|\s+\/\/\s+/;
const SEP_CHARS = /^[\s,:;|()[\]*–—-]+/;

function stripDecor(s: string): string {
  return s
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[^\p{L}\p{N}"“'([*]+/u, (m) => (/[-*•·]/.test(m) ? m : "")) // leading emoji/symbols
    .trim();
}

/** Prefix dates: consumes "Mon 10/20 —", "Day 3 – Wednesday, Oct 22:", "Week 2 Tue:" … */
export function consumeDatePrefix(text: string): { specs: DateSpec[]; consumed: string; rest: string } {
  const specs: DateSpec[] = [];
  let rest = text;
  let consumed = "";
  for (let guard = 0; guard < 5; guard++) {
    const lead = SEP_CHARS.exec(rest)?.[0] ?? "";
    const candidate = rest.slice(lead.length);
    const m = matchDateAt(candidate);
    if (!m) break;
    const after = candidate.slice(m.text.length);
    // A bare weekday/"Day N" counts only when a separator follows ("Monday: …"), not
    // "Monday motivation tips" or "Sunday reset routine".
    const bare = m.spec.kind === "weekday" || m.spec.kind === "dayN" || m.spec.kind === "relative";
    if (bare && /^\s+[\p{L}"“']/u.test(after) && !matchDateAt(after.trimStart())) break;
    if (/^[\p{L}\d]/u.test(after)) break; // glued to a word
    specs.push(m.spec);
    consumed += lead + m.text;
    rest = after;
  }
  return { specs, consumed: consumed.trim(), rest: rest.replace(SEP_CHARS, "").trim() };
}

function applyWeek(spec: DateSpec, week: WeekRef | null): DateSpec {
  if (!week) return spec;
  if (spec.kind === "weekday" && !spec.week) return { ...spec, week };
  if (spec.kind === "dayN" && week.kind === "n") return { kind: "weekDay", week: week.n, day: spec.n };
  return spec;
}

function isWeekOnly(specs: DateSpec[]): boolean {
  return specs.length > 0 && specs.some((s) => s.kind === "week") && !specs.some((s) => s.kind === "weekday" || s.kind === "dayN" || s.kind === "weekDay" || s.kind === "relative");
}

/** Detects a pasted spreadsheet range (tab-separated) or a markdown table. */
export function detectPastedTable(text: string): string[][] | null {
  const md = parseMarkdownTable(text);
  if (md) return md;
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const tabbed = lines.filter((l) => l.includes("\t"));
  if (lines.length >= 2 && tabbed.length >= Math.ceil(lines.length * 0.6)) return parseDelimited(text, "\t");
  return null;
}

export function parseFreeText(text: string, ctx: ParseContext): ParseResult {
  const table = detectPastedTable(text);
  if (table) return tableToRows(table, suggestTableMapping(table), ctx);

  const partials: PartialRow[] = [];
  let week: WeekRef | null = null;
  let day: { spec: DateSpec; text: string } | null = null;
  let current: PartialRow | null = null;
  let currentIndent = -1;
  let weekStartSpec: DateSpec | null = null;
  let datedWeek: { n: number; ref: Extract<WeekRef, { kind: "of" }> } | null = null;

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    if (!raw.trim()) return;
    const indent = raw.replace(/\t/g, "    ").search(/\S/);
    const isHeadingMarkup = /^\s*#{1,6}\s/.test(raw) || /^\s*(\*\*|__)[^*_].*(\*\*|__):?\s*$/.test(raw);
    let t = stripDecor(raw.trim());
    const isBullet = BULLET_RE.test(t);
    t = t.replace(BULLET_RE, "").trim();
    // Whole-line bold "**…**" → plain; keep inner bold markers out of the way.
    t = t.replace(/\*\*|__/g, "").trim();
    const endsWithColon = /:\s*$/.test(t);
    t = t.replace(/:\s*$/, "").trim();
    if (!t) return;

    // "Label: value"
    const lab = /^([A-Za-z][A-Za-z /-]{1,24}?)\s*[:：]\s*(.*)$/.exec(t);
    const field = lab ? labelOf(lab[1]!) : null;
    if (lab && field) {
      const value = lab[2]!.trim();
      if (field === "title") {
        if (current && !current.title && current.sourceLine >= lineNo - 3) current.title = value;
        else {
          current = startItem(lineNo, indent);
          current.title = value;
        }
        return;
      }
      if (!current || (indent <= currentIndent && !isBullet && field !== "noteLabeled" && !isAttachable(current, field))) {
        current = startItem(lineNo, indent);
      }
      applyLabel(current, field, lab[1]!, value, ctx.enabledPlatforms);
      return;
    }

    const { specs, consumed, rest } = consumeDatePrefix(t);

    // Week heading: "Week 2", "Week of Oct 20", "WEEK 1 (Oct 20–26): Money basics"
    if (isWeekOnly(specs) && (!isBullet || !rest)) {
      const abs = specs.find((s) => s.kind === "absolute");
      const w = specs.find((s): s is Extract<DateSpec, { kind: "week" }> => s.kind === "week")!;
      if (abs && abs.kind === "absolute") {
        week = { kind: "of", year: abs.year, month: abs.month, day: abs.day };
        datedWeek = w ? { n: w.week.kind === "n" ? w.week.n : 1, ref: week } : null;
      } else if (w.week.kind === "n" && datedWeek) {
        // "Week 2" after "Week 1 (Oct 20 – 26)": count from the dated week, not from the start date.
        week = { ...datedWeek.ref, plusWeeks: w.week.n - datedWeek.n };
      } else week = w.week;
      weekStartSpec = { kind: "week", week };
      day = null;
      current = null;
      return;
    }

    // Day heading: a line that is only a date ("Monday 10/20:", "**Tuesday**", "Day 3")
    if (specs.length && !rest) {
      const spec = combineSpecs(specs.map((s) => applyWeek(s, week)));
      if (spec) day = { spec, text: consumed };
      current = null;
      return;
    }

    // Noise: "Here's your 30-day plan:", "## Ideas", long prose.
    if (!specs.length && !isBullet && (endsWithColon || isHeadingMarkup || /\?\s*$/.test(t) || /^(?:here(?:'|’)?s|sure|absolutely|of course|great|below is|this plan)\b/i.test(t))) {
      current = null;
      return;
    }
    if (!specs.length && !isBullet && t.split(/\s+/).length >= 14) {
      if (current) current.notes.push(t);
      return;
    }
    // Indented bullet under an item, no date: a detail of that item.
    if (!specs.length && isBullet && current && indent > currentIndent) {
      current.notes.push(t);
      return;
    }

    // An item line.
    const item = startItem(lineNo, indent);
    let body = specs.length ? rest : t;
    // (TikTok, IG) / [6pm] / (Mon 10/20) groups anywhere in the line
    body = body.replace(/[([]([^()[\]]{1,60})[)\]]/g, (whole, inner: string) => {
      const pp = parsePlatforms(inner, ctx.enabledPlatforms);
      if (pp.pure) {
        item.platforms = [...(item.platforms ?? []), ...pp.platforms];
        item.unknownPlatforms.push(...pp.unknown);
        return " ";
      }
      const tm = parseTimeText(inner);
      if (tm) {
        item.time = tm;
        return " ";
      }
      if (!specs.length && !item.spec) {
        const d = parseDateText(inner);
        if (d) {
          specs.push(d.spec);
          item.dateText = inner;
          return " ";
        }
      }
      return whole;
    });
    const texts: string[] = [];
    for (const segRaw of body.split(SEP_SPLIT)) {
      const seg = segRaw.trim();
      if (!seg) continue;
      const sl = /^([A-Za-z][A-Za-z /-]{1,24}?)\s*[:：]\s*(.+)$/.exec(seg);
      const sf = sl ? labelOf(sl[1]!) : null;
      if (sl && sf && sf !== "title") {
        applyLabel(item, sf, sl[1]!, sl[2]!, ctx.enabledPlatforms);
        continue;
      }
      const pp = parsePlatforms(seg, ctx.enabledPlatforms);
      if (pp.pure) {
        item.platforms = [...(item.platforms ?? []), ...pp.platforms];
        item.unknownPlatforms.push(...pp.unknown);
        continue;
      }
      const tm = parseTimeText(seg.replace(/^@\s*/, ""));
      if (tm) {
        item.time = tm;
        continue;
      }
      if (!specs.length && texts.length > 0) {
        const d = parseDateText(seg);
        if (d) {
          specs.push(d.spec);
          item.dateText = seg;
          item.time ??= d.time;
          continue;
        }
      }
      texts.push(seg);
    }
    // "Title @ 6pm" at the end of the title segment
    if (texts[0]) {
      const at = /\s+@\s*(\S.*)$/.exec(texts[0]);
      const tm = at ? parseTimeText(at[1]!) : null;
      if (at && tm) {
        item.time = tm;
        texts[0] = texts[0].slice(0, at.index);
      } else {
        // "Why I stopped budgeting 6pm" — a trailing clock time, unless it's part of the
        // title ("Wake up at 5am").
        const tail = /\s+(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?|\d{1,2}:\d{2})$/i.exec(texts[0]);
        const tt = tail ? parseTimeText(tail[1]!) : null;
        if (tail && tt && !/\b(?:at|by|before|after|until|till|from)$/i.test(texts[0].slice(0, tail.index).trim())) {
          item.time ??= tt;
          texts[0] = texts[0].slice(0, tail.index);
        }
      }
    }
    item.title = texts[0] ?? "";
    if (texts.length > 1) item.notes.push(texts.slice(1).join(" — "));
    if (specs.length) {
      const spec = combineSpecs(specs.map((s) => applyWeek(s, week)));
      item.spec = spec;
      item.dateText ||= consumed;
      if (spec?.kind === "absolute") item.range = spec.range;
    } else if (day) {
      item.spec = day.spec;
      item.dateText = day.text;
    } else if (weekStartSpec) {
      item.spec = weekStartSpec;
      item.dateText = "this week";
    }
    current = item;
  });

  function startItem(lineNo: number, indent: number): PartialRow {
    const p = emptyPartial(lineNo);
    if (day) {
      p.spec = day.spec;
      p.dateText = day.text;
    } else if (weekStartSpec) {
      p.spec = weekStartSpec;
      p.dateText = "this week";
    }
    partials.push(p);
    current = p;
    currentIndent = indent;
    return p;
  }

  return finalizeRows(partials.filter((p) => p.title || p.hook), ctx);
}

function isAttachable(item: PartialRow, field: LabelField): boolean {
  switch (field) {
    case "hook":
      return !item.hook;
    case "platforms":
      return !item.platforms;
    case "time":
      return !item.time;
    case "date":
      return true;
    case "format":
      return !item.format;
    case "pillar":
      return !item.pillarText;
    default:
      return true;
  }
}

function applyLabel(item: PartialRow, field: LabelField, label: string, value: string, enabled: readonly PlanPlatform[]) {
  const v = value.trim();
  if (!v) return;
  switch (field) {
    case "hook":
      item.hook = v;
      break;
    case "notes":
      item.notes.push(v);
      break;
    case "noteLabeled":
      item.notes.push(`${label.trim().replace(/^\w/, (c) => c.toUpperCase())}: ${v}`);
      break;
    case "platforms": {
      const pp = parsePlatforms(v, enabled);
      item.platforms = [...(item.platforms ?? []), ...pp.platforms];
      item.unknownPlatforms.push(...pp.unknown);
      if (pp.platforms.length === 0 && pp.unknown.length === 0) item.notes.push(`Platforms: ${v}`);
      break;
    }
    case "time":
      item.time = parseTimeText(v) ?? item.time;
      break;
    case "date": {
      const d = parseDateText(v);
      item.dateText = v;
      item.spec = d?.spec ?? null;
      item.range = d?.range;
      item.time ??= d?.time ?? null;
      break;
    }
    case "format":
      item.format = v;
      break;
    case "pillar":
      item.pillarText = v;
      break;
    case "title":
      item.title = v;
      break;
  }
}
