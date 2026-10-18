import { GraphicPropsSchema, type GraphicItem, type GraphicProps, type GraphicSeries } from "./contract";
import { presetById, type GraphicPreset } from "./presets";

/**
 * Deterministic suggestions from what Chris is saying at the playhead (no AI, $0): detects
 * money amounts, percentages, plain numbers, comparisons ("vs", "compared to", "instead of"),
 * named roles ("as an employee… as a freelancer"), from→to changes, lists ("first… second"),
 * time words ("a month", "every year", month names) and topics (debt, compounding, budget),
 * then proposes library presets PRE-FILLED with the detected values. Numbers come only from
 * the transcript, so they are Chris's own words — the Quality Gate still checks them.
 */

export interface DetectedNumber {
  value: number;
  kind: "MONEY" | "PERCENT" | "NUMBER";
  /** Character offset in the text (for ordering / nearby words). */
  at: number;
  raw: string;
}

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};
const SCALE: Record<string, number> = { thousand: 1e3, grand: 1e3, k: 1e3, million: 1e6, mil: 1e6, m: 1e6, billion: 1e9, b: 1e9 };

export function detectNumbers(text: string): DetectedNumber[] {
  const out: DetectedNumber[] = [];
  const re = /(\$\s*)?(-|−|minus\s+|negative\s+)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|m|b|thousand|grand|million|mil|billion)?\b\s*(%|percent)?(\s*dollars|\s*bucks)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let v = Number(m[3]!.replace(/,/g, ""));
    if (!Number.isFinite(v)) continue;
    if (m[4]) v *= SCALE[m[4].toLowerCase()] ?? 1;
    if (m[2] || /\b(lost|lose|losing|down|minus|negative|in the red)\s+(about\s+)?$/i.test(text.slice(Math.max(0, m.index - 22), m.index))) v = -v;
    const pct = !!m[5];
    const money = !!m[1] || !!m[6] || (!!m[4] && !pct);
    // Skip years like "2024" spoken as dates (no $, no scale, 1900–2100).
    if (!money && !pct && !m[4] && v >= 1900 && v <= 2100 && Number.isInteger(v)) continue;
    out.push({ value: Math.round(v * 100) / 100, kind: pct ? "PERCENT" : money ? "MONEY" : "NUMBER", at: m.index, raw: m[0].trim() });
  }
  // Spelled-out amounts: "five thousand dollars", "a hundred bucks", "ten percent".
  const words = /\b(a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\s+(hundred\s+)?(thousand|grand|million|billion)?\s*(dollars|bucks|percent)\b/gi;
  while ((m = words.exec(text))) {
    let v = m[1]!.toLowerCase() === "a" ? 1 : SMALL[m[1]!.toLowerCase()]!;
    if (m[2]) v *= 100;
    if (m[3]) v *= SCALE[m[3].toLowerCase()]!;
    const pct = /percent/i.test(m[4]!);
    if (!out.some((d) => Math.abs(d.at - m!.index) < 3)) out.push({ value: v, kind: pct ? "PERCENT" : "MONEY", at: m.index, raw: m[0] });
  }
  return out.sort((a, b) => a.at - b.at);
}

const ROLE_WORDS: Array<[RegExp, string, GraphicSeries["icon"]]> = [
  [/\bemployees?\b|\b9 ?(?:to|-) ?5\b|\bw-?2\b/i, "Employee", "BRIEFCASE"],
  [/\bfreelanc(?:e|er|ers|ing)\b|\bcontractor\b|\b1099\b/i, "Freelance", "LAPTOP"],
  [/\bbusiness owners?\b|\bentrepreneurs?\b|\bfounders?\b|\bown(?:ed)? (?:a|my) business\b/i, "Business owner", "STORE"],
  [/\brent(?:ing|er)?\b/i, "Renting", "BUILDING"],
  [/\bbuy(?:ing)? (?:a )?(?:house|home)\b|\bown(?:ing)? (?:a )?home\b|\bhomeowners?\b/i, "Owning", "HOUSE"],
  [/\bsav(?:e|ing|ings)\b(?! \d)/i, "Saving", "PIGGY"],
  [/\binvest(?:ing|ed|ment)?\b/i, "Investing", "CHART_UP"],
];

export interface GraphicSuggestion {
  preset: GraphicPreset;
  /** Props pre-filled with what was detected (contract-complete for GRAPHIC). */
  props: Record<string, unknown>;
  /** Why ("You said $4k a month"). */
  reason: string;
}

function graphicFrom(presetId: string, patch: (p: GraphicProps) => GraphicProps): { preset: GraphicPreset; props: Record<string, unknown> } | null {
  const preset = presetById(presetId);
  if (!preset || preset.template !== "GRAPHIC") return null;
  const base = GraphicPropsSchema.parse(structuredClone(preset.props));
  const r = GraphicPropsSchema.safeParse(patch(base));
  return r.success ? { preset, props: r.data as unknown as Record<string, unknown> } : null;
}

function item(text: string, value: number | null, prev?: GraphicItem): GraphicItem {
  return { text, value, sub: null, icon: prev?.icon ?? null, color: prev?.color ?? "AUTO", op: prev?.op ?? "NONE", state: prev?.state ?? "NONE", side: prev?.side ?? "NONE", meta: prev?.meta ?? null };
}

function money(fmt: GraphicProps["format"], kind: DetectedNumber["kind"]): GraphicProps["format"] {
  return { ...fmt, kind: kind === "MONEY" ? "CURRENCY" : kind === "PERCENT" ? "PERCENT" : "NUMBER", signs: "NEGATIVE" };
}

function fmtShort(d: DetectedNumber): string {
  return d.raw.replace(/\s+/g, " ");
}

/**
 * Suggestions for a phrase (typically the sentence under the playhead). Ordered by fit;
 * always returns at least one (kinetic text of the phrase) when the phrase has words.
 */
export function suggestGraphics(phrase: string, limit = 6): GraphicSuggestion[] {
  const text = phrase.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const nums = detectNumbers(text);
  const moneyNums = nums.filter((n) => n.kind === "MONEY");
  const pcts = nums.filter((n) => n.kind === "PERCENT");
  const lower = text.toLowerCase();
  const monthly = /\b(a|per|every|each) month\b|\bmonthly\b|\/ ?mo\b|\ba mo\b/.test(lower);
  const yearly = /\b(a|per|every|each) year\b|\byearly\b|\bannual(ly)?\b|\/ ?yr\b/.test(lower);
  const versus = /\bvs\.?\b|\bversus\b|\bcompared (to|with)\b|\binstead of\b|\bwhile\b|\bbut\b|\bthan\b/.test(lower);
  const change = /\bfrom\b.*\bto\b|\bwent (up|down)\b|\bnow\b|\bbefore\b|\bafter\b|\bused to\b|\bturned into\b/.test(lower);
  const listy = /\b(first|second|third|step one|step two|number one|three things|two things|four things|tips?|rules?)\b/.test(lower);
  const growth = /\bcompound|grow(s|th|ing)?\b|\bexponential|\bover (\d+|ten|twenty|thirty) years\b/.test(lower);
  const debt = /\bdebt|\bowe\b|\bcredit card|\bloan|\bpay(ing)? (it )?off\b/.test(lower);
  const budget = /\bbudget|\bspend|\bexpenses?\b|\bbills?\b|\brent\b/.test(lower);
  const roles = ROLE_WORDS.flatMap(([re, label, icon]) => {
    const m = re.exec(text);
    return m ? [{ label, icon, at: m.index }] : [];
  }).sort((a, b) => a.at - b.at);
  const out: GraphicSuggestion[] = [];
  const push = (s: { preset: GraphicPreset; props: Record<string, unknown> } | null, reason: string) => {
    if (s && !out.some((o) => o.preset.id === s.preset.id)) out.push({ ...s, reason });
  };

  // Roles × amounts → Chris's comparison. Each role gets the amounts said between its mention
  // and the next role's ("as a business owner: zero, then 5k, then lost 15k…"); one amount said
  // "a month" becomes a year of it.
  if (roles.length >= 2 && moneyNums.length >= 1) {
    const at = roles.map((r) => r.at);
    const perRole = roles.map((_, i) => moneyNums.filter((n) => n.at >= at[i]! && (i === roles.length - 1 || n.at < at[i + 1]!)).map((n) => n.value));
    const vals = perRole.map((v) => v[0] ?? 0);
    push(
      graphicFrom("income-3-people-12-months", (p) => ({
        ...p,
        title: monthly ? "Monthly income, one year" : p.title,
        series: roles.slice(0, 4).map((r, i) => {
          const own = perRole[i]!;
          const values = own.length > 1 ? own.slice(0, 12) : monthly ? Array(12).fill(own[0] ?? 0) : [own[0] ?? 0];
          return { label: r.label, values, icon: r.icon, color: "AUTO" as const, note: null, texts: [] };
        }),
        showTotal: monthly,
      })),
      `You compared ${roles.map((r) => r.label.toLowerCase()).join(" vs ")} (${moneyNums.map(fmtShort).join(", ")})`,
    );
    push(
      graphicFrom("three-ways-to-earn", (p) => ({ ...p, items: roles.slice(0, 6).map((r, i) => ({ ...item(r.label, vals[i]!), icon: r.icon })), highlight: null })),
      `${roles.length} options with their amounts`,
    );
  }
  // One amount said "a month" → a year of it (12 cells), and the hero number.
  if (moneyNums.length >= 1 && monthly) {
    const v = moneyNums[0]!.value;
    push(graphicFrom("monthly-income-strip", (p) => ({ ...p, title: null, series: [{ ...p.series[0]!, label: roles[0]?.label ?? "Each month", values: Array(12).fill(v) }], showTotal: false })), `You said ${fmtShort(moneyNums[0]!)} a month — a year of it`);
  }
  if (moneyNums.length >= 2 && (versus || roles.length >= 2)) {
    const [a, b] = moneyNums;
    push(
      graphicFrom("versus-rent-own", (p) => ({
        ...p,
        title: null,
        series: [
          { ...p.series[0]!, label: roles[0]?.label ?? "Option A", values: [a!.value], icon: roles[0]?.icon ?? null },
          { ...p.series[1]!, label: roles[1]?.label ?? "Option B", values: [b!.value], icon: roles[1]?.icon ?? null },
        ],
        categories: [monthly ? "Monthly" : yearly ? "Yearly" : "Amount"],
      })),
      `${fmtShort(a!)} vs ${fmtShort(b!)}`,
    );
  }
  if (nums.length >= 2 && change && !versus) {
    const [a, b] = nums;
    push(graphicFrom("raise-from-to", (p) => ({ ...p, items: [item("before", a!.value), item("after", b!.value)], format: money(p.format, a!.kind) })), `From ${fmtShort(a!)} to ${fmtShort(b!)}`);
    push(graphicFrom("before-after-net-worth", (p) => ({ ...p, items: [item("Before", a!.value, p.items[0]), item("After", b!.value, p.items[1])], format: money(p.format, a!.kind) })), "Before and after");
  }
  if (moneyNums.length >= 3 && budget) {
    push(graphicFrom("bars-expenses", (p) => ({ ...p, series: [{ ...p.series[0]!, values: moneyNums.slice(0, 8).map((n) => n.value) }], categories: moneyNums.slice(0, 8).map((_, i) => `#${i + 1}`), highlight: null })), `${moneyNums.length} amounts — as bars`);
  }
  if (pcts.length >= 1) {
    const v = pcts[0]!.value;
    if (v >= 0 && v <= 100) {
      push(graphicFrom("ring-savings-goal", (p) => ({ ...p, title: null, items: [item(text.length <= 40 ? text : "", v)] })), `You said ${fmtShort(pcts[0]!)}`);
      if (pcts.length >= 2 && pcts.reduce((a, n) => a + n.value, 0) <= 100.5) {
        push(graphicFrom("donut-50-30-20", (p) => ({ ...p, title: null, items: pcts.slice(0, 7).map((n, i) => item(p.items[i]?.text ?? `Part ${i + 1}`, n.value, p.items[i])), highlight: null })), `${pcts.map(fmtShort).join(" / ")} — shares of a whole`);
      }
    }
    push(graphicFrom("big-number-percent", (p) => ({ ...p, items: [item("", v)], format: { ...p.format, kind: "PERCENT" } })), `${fmtShort(pcts[0]!)} as a big number`);
  }
  if (growth && moneyNums.length >= 1) push(graphicFrom("line-compound-growth", (p) => p), "You talked about growth over time");
  else if (growth) push(graphicFrom("line-compound-growth", (p) => p), "Growth over time");
  if (debt && moneyNums.length >= 1) {
    const v = Math.abs(moneyNums[0]!.value);
    push(graphicFrom("debt-to-zero", (p) => ({ ...p, items: [item("start", v), item("today", 0)] })), `${fmtShort(moneyNums[0]!)} of debt, counting down`);
  }
  if (moneyNums.length >= 1) {
    const d = moneyNums[0]!;
    push(graphicFrom("hero-salary", (p) => ({ ...p, items: [item(monthly ? "a month" : yearly ? "a year" : "", d.value)] })), `You said ${fmtShort(d)}`);
    push(graphicFrom("emergency-fund-stat", (p) => ({ ...p, items: [item(text.length <= 60 ? text : roles[0]?.label ?? "", d.value, p.items[0])] })), `${fmtShort(d)} on a card`);
  }
  if (nums.length === 1 && nums[0]!.kind === "NUMBER") push(graphicFrom("hero-salary", (p) => ({ ...p, items: [item("", nums[0]!.value)], format: { ...p.format, kind: "NUMBER" } })), `You said ${fmtShort(nums[0]!)}`);
  if (listy) push(graphicFrom("steps-debt-plan", (p) => ({ ...p, title: null })), "Sounds like a list of steps");
  if (versus && moneyNums.length < 2) push(graphicFrom("versus-rent-own", (p) => p), "A comparison");
  // Always: the words themselves.
  push(graphicFrom("kinetic-stack", (p) => ({ ...p, body: text.slice(0, 220) })), "Put these words on screen");
  return out.slice(0, limit);
}
