import { describe, expect, it } from "vitest";
import {
  TimelineVisualSchema,
  GRAPHIC_CATEGORIES,
  GRAPHIC_COMPONENTS,
  GRAPHIC_COMPONENT_SPECS,
  GRAPHIC_PRESETS,
  GraphicPropsSchema,
  MotionPropsSchemas,
  TEMPLATE_FOOTPRINTS,
  applyQuickEntry,
  detectNumbers,
  footprintOf,
  formatGraphicValue,
  formatGraphicNumber,
  graphicDesignSize,
  graphicShownNumbers,
  numberPlan,
  parseQuickEntry,
  parseQuickNumber,
  presetById,
  searchPresets,
  suggestGraphics,
  toQuickEntry,
  DEFAULT_GRAPHIC_FORMAT,
  type GraphicProps,
} from "../timeline-browser";

const USD = { ...DEFAULT_GRAPHIC_FORMAT, kind: "CURRENCY" as const };
const parse = (p: Record<string, unknown>): GraphicProps => GraphicPropsSchema.parse(p);

describe("graphics contract", () => {
  it("every preset validates against its template schema and is unique", () => {
    expect(GRAPHIC_PRESETS.length).toBeGreaterThanOrEqual(150);
    const ids = new Set<string>();
    for (const p of GRAPHIC_PRESETS) {
      expect(ids.has(p.id), p.id).toBe(false);
      ids.add(p.id);
      const r = MotionPropsSchemas[p.template].safeParse(p.props);
      expect(r.success, `${p.id}: ${r.success ? "" : JSON.stringify(r.error.issues)}`).toBe(true);
      expect(p.name.length).toBeGreaterThan(3);
      expect(p.tags.length).toBeGreaterThan(1);
      expect(GRAPHIC_CATEGORIES.some((c) => c.id === p.category)).toBe(true);
    }
  });
  it("every category and every base component has presets", () => {
    for (const c of GRAPHIC_CATEGORIES) expect(GRAPHIC_PRESETS.some((p) => p.category === c.id), c.id).toBe(true);
    for (const c of GRAPHIC_COMPONENTS) expect(GRAPHIC_PRESETS.some((p) => p.template === "GRAPHIC" && p.props.component === c), c).toBe(true);
  });
  it("design sizes fit the canvas and footprints follow the data", () => {
    for (const p of GRAPHIC_PRESETS.filter((x) => x.template === "GRAPHIC")) {
      const props = parse(p.props);
      const s = graphicDesignSize(props);
      expect(s.width, p.id).toBeLessThanOrEqual(1080);
      expect(s.height, p.id).toBeLessThanOrEqual(1920);
      expect(s.width * s.height, p.id).toBeGreaterThan(0);
    }
    const chris = parse(presetById("income-3-people-12-months")!.props);
    expect(footprintOf("GRAPHIC", chris).kind).toBe("FULL_FRAME");
    const overlay = footprintOf("GRAPHIC", { ...chris, screen: "OVERLAY" });
    expect(overlay.kind).toBe("BOX");
    const fewer = footprintOf("GRAPHIC", { ...chris, screen: "OVERLAY", series: chris.series.map((s) => ({ ...s, values: s.values.slice(0, 3) })) });
    expect(fewer.height).toBeLessThan(overlay.height);
    // Invalid GRAPHIC props fall back to the nominal box; classic templates are unchanged.
    expect(footprintOf("GRAPHIC", { component: "NOPE" })).toEqual(TEMPLATE_FOOTPRINTS.GRAPHIC);
    expect(footprintOf("STAT_CARD", {})).toEqual(TEMPLATE_FOOTPRINTS.STAT_CARD);
  });
  it("validates component bounds in plain English", () => {
    const r = GraphicPropsSchema.safeParse({ component: "VALUE_COLUMNS", series: [] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/at least one row/);
    const v = GraphicPropsSchema.safeParse({ component: "DONUT", items: [{ text: "a", value: 1 }, { text: "b", value: -1 }] });
    expect(JSON.stringify(v.error?.issues)).toMatch(/can't be negative/);
    expect(GraphicPropsSchema.safeParse({ component: "STAT_TILES", variant: "NOPE", items: [{ text: "x", value: 1 }] }).success).toBe(false);
  });
  it("Chris's example is a preset with his exact numbers", () => {
    const p = parse(presetById("income-3-people-12-months")!.props);
    expect(p.component).toBe("VALUE_COLUMNS");
    expect(p.series.map((s) => s.label)).toEqual(["Employee", "Freelance", "Business owner"]);
    expect(p.series[0]!.values).toEqual(Array(12).fill(4000));
    expect(p.series[2]!.values).toEqual([0, 5000, -15000, -5000, 50000, 5000, 0, 100000]);
    expect(p.animation.order).toBe("GROUP_BY_GROUP");
  });
  it("visuals with GRAPHIC props and legacy v1 visuals both parse", () => {
    const g = TimelineVisualSchema.safeParse({ id: "g1", template: "GRAPHIC", props: presetById("income-3-people-12-months")!.props, start: 0, end: 8, placement: { mode: "AUTO", x: 0.5, y: 0.5, scale: 1 } });
    expect(g.success, JSON.stringify(g.error?.issues)).toBe(true);
    const legacy = TimelineVisualSchema.safeParse({ id: "v1", template: "STAT_CARD", props: { value: "7%", label: "x" }, start: 0, end: 3, placement: { x: 0.5, y: 0.3, scale: 1 } });
    expect(legacy.success).toBe(true);
    expect(MotionPropsSchemas.STAT_CARD.safeParse({ value: "7%", label: "x" }).success).toBe(true);
  });
});

describe("number formatting", () => {
  it("formats currency, compact units, signs and true minus", () => {
    expect(formatGraphicValue(4000, USD)).toBe("$4k");
    expect(formatGraphicValue(-15000, USD)).toBe("−$15k");
    expect(formatGraphicValue(4250, USD)).toBe("$4,250");
    expect(formatGraphicValue(24480, USD)).toBe("$24,480");
    expect(formatGraphicValue(2_400_000, USD)).toBe("$2.4M");
    expect(formatGraphicValue(0, USD)).toBe("$0");
    expect(formatGraphicValue(5000, { ...USD, signs: "ALWAYS" })).toBe("+$5k");
    expect(formatGraphicValue(7.25, { ...DEFAULT_GRAPHIC_FORMAT, kind: "PERCENT" })).toBe("7.25%");
    expect(formatGraphicValue(4000, { ...USD, compact: "NONE" })).toBe("$4,000");
    expect(formatGraphicValue(500, { ...USD, suffix: "/mo" })).toBe("$500/mo");
    expect(formatGraphicNumber(0, USD, { divisor: 1000, unit: "k", decimals: 0 }).text).toBe("$0");
    expect(formatGraphicNumber(0, { ...USD, signs: "ALWAYS" }, { divisor: 1000, unit: "k", decimals: 0 }).text).toBe("$0");
    expect(formatGraphicValue(609985, USD)).toBe("$610k");
  });
  it("plans count-up format from the final value", () => {
    const plan = numberPlan(4000, USD);
    expect(plan).toMatchObject({ divisor: 1000, unit: "k", decimals: 0 });
  });
  it("lists every shown number including derived totals", () => {
    const p = parse({ ...presetById("income-3-people-12-months")!.props });
    const shown = graphicShownNumbers(p).numbers.map((n) => n.value);
    expect(shown).toContain(-15000);
    expect(shown).toContain(48000);
    expect(shown).toContain(140000);
    const donut = parse({ component: "DONUT", items: [{ text: "a", value: 1 }, { text: "b", value: 3 }] });
    expect(graphicShownNumbers(donut).numbers.map((n) => n.value)).toEqual([1, 3, 25, 75]);
  });
});

describe("quick entry parser", () => {
  it("parses Chris's comparison line", () => {
    const q = parseQuickEntry("Employee: 4k x12 | Freelance: 2k,6k,0,8k,3k,… | Business owner: 0, 5k, -15k, -5k, 50k, 5k, 0, 100k");
    expect(q.series).toEqual([
      { label: "Employee", values: Array(12).fill(4000) },
      { label: "Freelance", values: [2000, 6000, 0, 8000, 3000] },
      { label: "Business owner", values: [0, 5000, -15000, -5000, 50000, 5000, 0, 100000] },
    ]);
    expect(q.hints.negative).toBe(true);
    expect(q.warnings).toEqual([]);
  });
  it.each([
    ["4k", 4000],
    ["$4,500", 4500],
    ["1,200,000", 1200000],
    ["-$15k", -15000],
    ["$-15k", -15000],
    ["−$5k", -5000],
    ["(15k)", -15000],
    ["+5k", 5000],
    ["1.2M", 1200000],
    ["2.5mm", 2500000],
    ["45%", 45],
    ["0.5", 0.5],
    ["3bn", 3e9],
  ])("number %s", (raw, v) => {
    expect(parseQuickNumber(raw)?.value).toBe(v);
  });
  it("rejects non-numbers", () => {
    expect(parseQuickNumber("abc")).toBeNull();
    expect(parseQuickNumber("")).toBeNull();
    expect(parseQuickNumber("4k4")).toBeNull();
  });
  it("supports repeat forms", () => {
    for (const s of ["A: 4k x12", "A: 4k ×12", "A: 4k*12", "A: 4k x 12", "A: 4kx12", "A: x12 4k"]) {
      expect(parseQuickEntry(s).series[0]!.values, s).toEqual(Array(12).fill(4000));
    }
    expect(parseQuickEntry("A: 1k x99").series[0]!.values.length).toBe(36);
    expect(parseQuickEntry("A: 1, 2 x3, 5").series[0]!.values).toEqual([1, 2, 2, 2, 5]);
  });
  it("keeps thousands commas and splits list commas", () => {
    expect(parseQuickEntry("A: 4,000, 5,500, 6,000").series[0]!.values).toEqual([4000, 5500, 6000]);
    expect(parseQuickEntry("A: 1,2,3").series[0]!.values).toEqual([1, 2, 3]);
    expect(parseQuickEntry("A: $1,200 $900").series[0]!.values).toEqual([1200, 900]);
  });
  it("reads label/value pairs, categories, unlabeled rows, newlines and semicolons", () => {
    const pairs = parseQuickEntry("Rent 1800, Food 650, Car + insurance 560");
    expect(pairs.items).toEqual([
      { text: "Rent", value: 1800 },
      { text: "Food", value: 650 },
      { text: "Car + insurance", value: 560 },
    ]);
    const cats = parseQuickEntry("Jan, Feb, Mar\nIncome: 4k, 4.5k, 5k");
    expect(cats.categories).toEqual(["Jan", "Feb", "Mar"]);
    expect(cats.series[0]).toEqual({ label: "Income", values: [4000, 4500, 5000] });
    expect(parseQuickEntry("5, 10, 15").series[0]).toEqual({ label: "", values: [5, 10, 15] });
    expect(parseQuickEntry("Employee 4k x3; Owner 1k").series).toEqual([
      { label: "Employee", values: [4000, 4000, 4000] },
      { label: "Owner", values: [1000] },
    ]);
    expect(parseQuickEntry("Months: Jan, Feb").categories).toEqual(["Jan", "Feb"]);
  });
  it("warns about unreadable tokens instead of guessing", () => {
    const q = parseQuickEntry("A: 4k, lots, 5k");
    expect(q.series[0]!.values).toEqual([4000, 5000]);
    expect(q.warnings.join(" ")).toMatch(/lots/);
  });
  it("detects currency / percent hints", () => {
    expect(parseQuickEntry("A: $4k, $5k").hints.currency).toBe("$");
    expect(parseQuickEntry("A: 4%, 5%").hints.percent).toBe(true);
  });
  it("applies to series components (months auto-labelled) and item components", () => {
    const vc = parse(presetById("income-3-people-12-months")!.props);
    const r = applyQuickEntry({ ...vc, categories: [] }, parseQuickEntry("Me: 4k x12 | You: 3k x12"));
    expect(r.props.series.map((s) => s.label)).toEqual(["Me", "You"]);
    expect(r.props.series[0]!.icon).toBe("BRIEFCASE"); // kept from the row it replaces
    expect(r.summary).toMatch(/2 rows/);
    expect(GraphicPropsSchema.safeParse(r.props).success).toBe(true);
    const grid = parse(presetById("monthly-income-strip")!.props);
    const g2 = applyQuickEntry({ ...grid, categories: [] }, parseQuickEntry("Income: $4k x12"));
    expect(g2.props.categories).toHaveLength(12);
    expect(g2.props.format.kind).toBe("CURRENCY");
    const tiles = parse(presetById("three-key-numbers")!.props);
    const t2 = applyQuickEntry(tiles, parseQuickEntry("Saved 12k, Invested 30k, Debt 0"));
    expect(t2.props.items.map((i) => [i.text, i.value])).toEqual([["Saved", 12000], ["Invested", 30000], ["Debt", 0]]);
    const t3 = applyQuickEntry(tiles, parseQuickEntry("1k, 2k, 3k, 4k, 5k, 6k, 7k"));
    expect(t3.props.items).toHaveLength(6);
    expect(t3.summary).toMatch(/only 6 fit/);
  });
  it("round-trips the data as quick-entry text", () => {
    const vc = parse(presetById("income-3-people-12-months")!.props);
    const text = toQuickEntry(vc);
    expect(text).toContain("Employee: 4k x12");
    const back = parseQuickEntry(text);
    expect(back.series.map((s) => s.values)).toEqual(vc.series.map((s) => s.values));
  });
});

describe("library search", () => {
  const top = (q: string, n = 5) => searchPresets(q, { limit: n }).map((h) => h.preset.id);
  it("finds by name, tags and synonyms", () => {
    expect(top("income comparison")[0]).toBe("income-3-people-12-months");
    expect(top("paycheck", 12)).toEqual(expect.arrayContaining(["paycheck-receipt"]));
    expect(top("salary vs freelance")).toContain("salary-freelance-business");
    expect(top("cash flow")[0]).toBe("cash-flow-rollercoaster");
    expect(top("donut")).toContain("donut-50-30-20");
    expect(top("credit score gauge")[0]).toBe("gauge-credit-score");
  });
  it("tolerates typos", () => {
    expect(top("compund growth")).toContain("line-compound-growth");
    expect(top("waterfal")).toEqual(expect.arrayContaining(["waterfall-paycheck"]));
  });
  it("requires every word to match", () => {
    expect(searchPresets("zzzz qqqq")).toEqual([]);
    expect(searchPresets("donut zzzzzz")).toEqual([]);
  });
  it("filters by category and boosts favourites and recents", () => {
    const charts = searchPresets("", { category: "CHARTS" });
    expect(charts.every((h) => h.preset.category === "CHARTS")).toBe(true);
    const fav = searchPresets("", { favorites: new Set(["cta-share"]) });
    expect(fav[0]!.preset.id).toBe("cta-share");
    const q = searchPresets("income", { recents: ["hero-salary"] });
    const plain = searchPresets("income");
    const rank = (hits: typeof q) => hits.findIndex((h) => h.preset.id === "hero-salary");
    expect(rank(q)).toBeLessThanOrEqual(rank(plain));
  });
});

describe("transcript suggestions", () => {
  it("detects money, percents, scales and spelled amounts", () => {
    const d = detectNumbers("I made $4,000 a month, then 5k, then -15k, about 20% and five thousand dollars in 2024");
    expect(d.map((x) => [x.value, x.kind])).toEqual([
      [4000, "MONEY"],
      [5000, "MONEY"],
      [-15000, "MONEY"],
      [20, "PERCENT"],
      [5000, "MONEY"],
    ]);
  });
  it("suggests Chris's comparison pre-filled when he names roles and amounts", () => {
    const s = suggestGraphics("As an employee I made $4,000 a month, as a freelancer maybe $6,000, as a business owner zero");
    expect(s[0]!.preset.id).toBe("income-3-people-12-months");
    const p = GraphicPropsSchema.parse(s[0]!.props);
    expect(p.series.map((x) => x.label)).toEqual(["Employee", "Freelance", "Business owner"]);
    expect(p.series[0]!.values).toEqual(Array(12).fill(4000));
    expect(s[0]!.reason).toMatch(/employee/);
  });
  it("attributes amounts to the role they were said after, and 'lost' is negative", () => {
    const s = suggestGraphics("As an employee I made $4,000 a month. As a freelancer it was up and down. As a business owner I made 5k, then lost 15k, then one month 100k.");
    const p = GraphicPropsSchema.parse(s[0]!.props);
    expect(p.series.map((x) => x.values)).toEqual([Array(12).fill(4000), Array(12).fill(0), [5000, -15000, 100000]]);
  });
  it("suggests from→to, percent and debt graphics", () => {
    expect(suggestGraphics("My rent went from $1,400 to $2,150").map((x) => x.preset.id)).toContain("raise-from-to");
    expect(suggestGraphics("save 20% of what you make").map((x) => x.preset.id)).toContain("ring-savings-goal");
    expect(suggestGraphics("I had $18,400 of credit card debt").map((x) => x.preset.id)).toContain("debt-to-zero");
    expect(suggestGraphics("50% needs, 30% wants and 20% savings").map((x) => x.preset.id)).toContain("donut-50-30-20");
  });
  it("always offers the words, and every suggestion validates", () => {
    const s = suggestGraphics("Nobody tells you this");
    expect(s.map((x) => x.preset.id)).toEqual(["kinetic-stack"]);
    for (const phrase of ["$5 a day", "compound interest over 30 years", "first, open an account. second, automate it", "renting vs buying a home: $2,100 vs $2,940"]) {
      for (const x of suggestGraphics(phrase)) expect(MotionPropsSchemas[x.preset.template].safeParse(x.props).success, `${phrase} → ${x.preset.id}`).toBe(true);
    }
    expect(suggestGraphics("")).toEqual([]);
  });
});

describe("component specs", () => {
  it("every component has variants and a label", () => {
    for (const c of GRAPHIC_COMPONENTS) {
      expect(GRAPHIC_COMPONENT_SPECS[c].variants.length, c).toBeGreaterThan(0);
      expect(GRAPHIC_COMPONENT_SPECS[c].label.length).toBeGreaterThan(2);
    }
  });
});
