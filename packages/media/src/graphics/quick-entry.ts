import {
  GRAPHIC_COMPONENT_SPECS,
  GRAPHIC_LIMITS,
  type GraphicFormat,
  type GraphicItem,
  type GraphicProps,
  type GraphicSeries,
} from "./contract";

/**
 * Quick entry — a DETERMINISTIC parser (no AI) for typing a graphic's data the way Chris
 * would say it:
 *
 *   Employee: 4k x12 | Freelance: 2k,6k,0,8k,3k | Business owner: 0, 5k, -15k, -5k, 50k, 5k, 0, 100k
 *   Rent 1800, Food 650, Car 520
 *   Jan, Feb, Mar | Income: 4k, 4.5k, 5k
 *   45%   ·   $24,500   ·   (15k)   ·   −$5k   ·   1.2M   ·   4k ×12
 *
 * Groups are separated by `|`, `;` or new lines. A group is `Label: values` (a SERIES), a list of
 * `word number` pairs (ITEMS), or only words (CATEGORIES, e.g. month names). Values: digits with
 * thousands commas, k/m/b suffixes, $ € £, %, + / − / -, (accounting negatives), repeats
 * (`4k x12`, `4k × 12`, `4k*12`, `x12 4k`), and ellipses (`…`, `...`) are ignored.
 */

export interface QuickEntryResult {
  series: Array<{ label: string; values: number[] }>;
  items: Array<{ text: string; value: number | null }>;
  categories: string[];
  hints: { currency: string | null; percent: boolean; negative: boolean };
  /** Things that couldn't be read, worded for Chris. */
  warnings: string[];
}

const SUFFIX: Record<string, number> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, mm: 1e6, MM: 1e6, b: 1e9, B: 1e9, bn: 1e9 };
const MAX_REPEAT = 36;

/** One numeric token → number (null when it isn't a number). */
export function parseQuickNumber(raw: string): { value: number; currency: string | null; percent: boolean } | null {
  let s = raw.trim().replace(/−|–|—/g, "-");
  if (!s) return null;
  let neg = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    neg = true;
    s = paren[1]!.trim();
  }
  const m = /^([+-])?\s*([$€£])?\s*([+-])?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.?\d+)\s*(k|K|mm|MM|m|M|bn|b|B)?\s*(%)?\s*([$€£])?$/.exec(s);
  if (!m) return null;
  if (m[1] === "-" || m[3] === "-") neg = !neg;
  const currency = m[2] ?? m[7] ?? null;
  let v = Number(m[4]!.replace(/,/g, ""));
  if (!Number.isFinite(v)) return null;
  if (m[5]) v *= SUFFIX[m[5]]!;
  v = Math.round(v * 1e6) / 1e6;
  return { value: neg ? -v : v, currency, percent: m[6] === "%" };
}

/** Split a value list on commas/whitespace, keeping thousands commas ("1,200") intact. */
function splitValues(s: string): string[] {
  // Protect thousands separators: a comma between digits followed by exactly 3 digits and then
  // a non-digit (and not a k/m suffix on the left piece).
  const protectedS = s.replace(/(\d),(?=\d{3}(?!\d))/g, (whole, d: string, offset: number, all: string) => {
    // "0,800" style is ambiguous; treat as thousands only if the left run has no suffix.
    const left = all.slice(0, offset + 1);
    return /[kmb]\s*$/i.test(left) ? whole : `${d}\u2063`;
  });
  return protectedS
    .split(/[,\s]+/)
    .map((x) => x.replace(/\u2063/g, ",").trim())
    .filter((x) => x.length > 0);
}

/** Expand repeats inside a token list: ["4k", "x12"] / ["4k","x","12"] / ["4kx12"] / ["x12","4k"]. */
function expandTokens(tokens: string[], warnings: string[]): Array<{ value: number; currency: string | null; percent: boolean }> {
  const out: Array<{ value: number; currency: string | null; percent: boolean }> = [];
  const rep = (n: number) => Math.max(1, Math.min(MAX_REPEAT, Math.floor(n)));
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i]!;
    if (/^(…|\.{2,})$/.test(t)) continue;
    t = t.replace(/(…|\.{3,})$/, "");
    // "4kx12", "4k×12", "4k*12"
    const glued = /^(.+?)\s*[x×*]\s*(\d{1,2})$/i.exec(t);
    if (glued && parseQuickNumber(glued[1]!)) {
      const n = parseQuickNumber(glued[1]!)!;
      for (let k = 0; k < rep(Number(glued[2])); k++) out.push(n);
      continue;
    }
    // "x12" following a value (or "x" "12")
    const xs = /^[x×*](\d{1,2})?$/i.exec(t);
    if (xs) {
      const count = xs[1] ? Number(xs[1]) : Number(tokens[i + 1]);
      if (!xs[1]) i++;
      const prev = out[out.length - 1];
      if (prev && Number.isFinite(count)) {
        for (let k = 1; k < rep(count); k++) out.push(prev);
      } else if (!prev && Number.isFinite(count)) {
        // "x12 4k": repeat the NEXT value.
        const next = parseQuickNumber(tokens[i + 1] ?? "");
        if (next) {
          i++;
          for (let k = 0; k < rep(count); k++) out.push(next);
        }
      }
      continue;
    }
    const n = parseQuickNumber(t);
    if (n) out.push(n);
    else if (t.trim()) warnings.push(`Couldn't read “${t}” as a number.`);
  }
  return out;
}

function cleanLabel(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

const WORDY = /[A-Za-z]/;

export function parseQuickEntry(text: string): QuickEntryResult {
  const res: QuickEntryResult = { series: [], items: [], categories: [], hints: { currency: null, percent: false, negative: false }, warnings: [] };
  const groups = text
    .split(/\||;|\n/)
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
  const note = (n: { currency: string | null; percent: boolean; value: number }) => {
    if (n.currency && !res.hints.currency) res.hints.currency = n.currency;
    if (n.percent) res.hints.percent = true;
    if (n.value < 0) res.hints.negative = true;
  };
  for (const g of groups) {
    const colon = /^([^:]{1,40}):\s*(.*)$/.exec(g);
    if (colon && WORDY.test(colon[1]!)) {
      const label = cleanLabel(colon[1]!, GRAPHIC_LIMITS.seriesLabel);
      const tokens = splitValues(colon[2]!);
      const numeric = tokens.some((t) => parseQuickNumber(t) || /^\d.*[x×*]\s*\d+$/i.test(t));
      const nums = numeric ? expandTokens(tokens, res.warnings) : [];
      if (nums.length === 0 && tokens.length > 0) {
        // "Months: Jan, Feb, …" → categories
        res.categories = colon[2]!.split(/,/).map((x) => cleanLabel(x, GRAPHIC_LIMITS.category)).filter(Boolean);
        continue;
      }
      nums.forEach(note);
      res.series.push({ label, values: nums.slice(0, GRAPHIC_LIMITS.maxValues).map((n) => n.value) });
      if (nums.length > GRAPHIC_LIMITS.maxValues) res.warnings.push(`${label}: only the first ${GRAPHIC_LIMITS.maxValues} values fit.`);
      continue;
    }
    const parts = g.split(/,(?!\d{3}(?!\d))/).map((x) => x.trim()).filter(Boolean);
    // "Rent 1800, Food 650" → label/value pairs
    const pairs = parts.map((p) => {
      const m = /^(.*?[A-Za-z][^\d$€£+\-−(]*?)\s+([+\-−]?\s*[$€£(]?[\d.,]+.*)$/.exec(p);
      if (!m) return null;
      const n = parseQuickNumber(m[2]!);
      return n ? { text: cleanLabel(m[1]!, GRAPHIC_LIMITS.itemText), n } : null;
    });
    if (pairs.length > 1 && pairs.every((x) => x !== null)) {
      for (const p of pairs) {
        note(p!.n);
        res.items.push({ text: p!.text, value: p!.n.value });
      }
      continue;
    }
    const tokens = splitValues(g);
    const allWords = tokens.every((t) => WORDY.test(t) && !parseQuickNumber(t) && !/^[x×*]\d+$/i.test(t) && !/^\d/.test(t));
    if (allWords) {
      const cats = g.split(/,/).map((x) => cleanLabel(x, GRAPHIC_LIMITS.category)).filter(Boolean);
      // A single phrase without commas is a label for the next group, else categories.
      res.categories = cats.length > 1 ? cats : g.split(/\s+/).map((x) => cleanLabel(x, GRAPHIC_LIMITS.category));
      continue;
    }
    // Leading words then numbers without a colon: "Employee 4k x12"
    const lead = /^([A-Za-z][A-Za-z '&/.-]*?)\s+([+\-−$€£(\d].*)$/.exec(g);
    const label = lead ? cleanLabel(lead[1]!, GRAPHIC_LIMITS.seriesLabel) : "";
    const nums = expandTokens(splitValues(lead ? lead[2]! : g), res.warnings);
    nums.forEach(note);
    if (nums.length) res.series.push({ label, values: nums.slice(0, GRAPHIC_LIMITS.maxValues).map((n) => n.value) });
  }
  return res;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function blankSeries(label: string, values: number[], prev?: GraphicSeries): GraphicSeries {
  return { label, values, icon: prev?.icon ?? null, color: prev?.color ?? "AUTO", note: prev?.note ?? null, texts: [] };
}
function blankItem(text: string, value: number | null, prev?: GraphicItem): GraphicItem {
  return { text, value, icon: prev?.icon ?? null, color: prev?.color ?? "AUTO", op: prev?.op ?? "NONE", state: prev?.state ?? "NONE", sub: prev?.sub ?? null };
}

/**
 * Applies parsed quick entry to a graphic: series-shaped components get series (labels kept
 * from the existing rows when a group has none; 12 values with no labels → month names),
 * list-shaped components get items. Format hints ($, %) switch the format kind. Returns the
 * new props and what happened ("3 rows × up to 12 values").
 */
export function applyQuickEntry(props: GraphicProps, q: QuickEntryResult): { props: GraphicProps; summary: string } {
  const spec = GRAPHIC_COMPONENT_SPECS[props.component];
  const u = spec.uses;
  const next: GraphicProps = { ...props };
  const fmt: GraphicFormat = { ...props.format };
  if (q.hints.currency) {
    fmt.kind = "CURRENCY";
    fmt.currency = q.hints.currency;
  } else if (q.hints.percent) fmt.kind = "PERCENT";
  next.format = fmt;
  let summary = "Nothing to apply";
  if (u.series && (q.series.length > 0 || q.items.length > 0)) {
    const src = q.series.length > 0 ? q.series : [{ label: "", values: q.items.map((i) => i.value ?? 0) }];
    const cats = q.series.length === 0 && q.items.length > 0 ? q.items.map((i) => i.text.slice(0, GRAPHIC_LIMITS.category)) : null;
    const max = u.series.count[1];
    next.series = src.slice(0, max).map((s, i) => blankSeries(s.label || props.series[i]?.label || `Row ${i + 1}`, s.values, props.series[i]));
    const longest = Math.max(...next.series.map((s) => s.values.length));
    if (q.categories.length) next.categories = q.categories.slice(0, GRAPHIC_LIMITS.maxCategories);
    else if (cats) next.categories = cats;
    else if (u.categories && longest === 12 && (props.categories.length === 0 || props.categories.length !== 12)) next.categories = [...MONTHS];
    else if (u.categories && props.categories.length && props.categories.length < longest) {
      next.categories = props.categories; // keep — editor shows the mismatch
    }
    summary = `${next.series.length} row${next.series.length === 1 ? "" : "s"} × up to ${longest} value${longest === 1 ? "" : "s"}`;
    if (src.length > max) summary += ` (only ${max} rows fit this layout)`;
  } else if (u.items && (q.items.length > 0 || q.series.length > 0)) {
    const max = u.items.count[1];
    let items: GraphicItem[];
    if (q.items.length) items = q.items.map((it, i) => blankItem(it.text, it.value, props.items[i]));
    else if (q.series.length > 1 && q.series.every((s) => s.values.length === 1)) items = q.series.map((s, i) => blankItem(s.label, s.values[0]!, props.items[i]));
    else {
      const s = q.series[0]!;
      const labels = q.categories.length ? q.categories : props.items.map((i) => i.text);
      items = s.values.map((v, i) => blankItem(labels[i] ?? (s.label && s.values.length === 1 ? s.label : `Item ${i + 1}`), v, props.items[i]));
    }
    next.items = items.slice(0, max);
    summary = `${next.items.length} entr${next.items.length === 1 ? "y" : "ies"}${items.length > max ? ` (only ${max} fit)` : ""}`;
  }
  return { props: next, summary };
}

function short(v: number): string {
  const a = Math.abs(v);
  const s = a >= 1e6 && a % 1e5 === 0 ? `${a / 1e6}m` : a >= 1e3 && a % 100 === 0 ? `${a / 1e3}k` : String(a);
  return v < 0 ? `-${s}` : s;
}

/** The current data as quick-entry text (round-trips through parseQuickEntry). */
export function toQuickEntry(props: GraphicProps): string {
  const u = GRAPHIC_COMPONENT_SPECS[props.component].uses;
  if (u.series && props.series.length) {
    return props.series
      .map((s) => {
        const parts: string[] = [];
        for (let i = 0; i < s.values.length; ) {
          let j = i;
          while (j + 1 < s.values.length && s.values[j + 1] === s.values[i]) j++;
          const run = j - i + 1;
          if (run >= 3) parts.push(`${short(s.values[i]!)} x${run}`);
          else for (let k = i; k <= j; k++) parts.push(short(s.values[k]!));
          i = j + 1;
        }
        return `${s.label || "Row"}: ${parts.join(", ")}`;
      })
      .join(" | ");
  }
  if (u.items && props.items.length) {
    return props.items.map((it) => (it.value === null ? it.text : `${it.text || "Item"} ${short(it.value)}`)).join(", ");
  }
  return "";
}
