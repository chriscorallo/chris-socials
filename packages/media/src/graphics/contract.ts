import { z } from "zod";

/**
 * The composable graphics system (PURE — browser-safe; no Node/React/Remotion).
 *
 * One motion-contract template, `GRAPHIC`, renders any of the parametric BASE COMPONENTS
 * below. Every component reads the SAME universal, fully editable data model:
 *
 * - `series`     entities / data series — each a label, an optional icon + colour, and its own
 *                list of numbers (e.g. "Employee": 12 monthly incomes). Charts, comparison
 *                columns, month grids, tables and waterfalls read these.
 * - `categories` labels along the value axis (months, years, column headers).
 * - `items`      list-shaped content — tiles, steps, checklist rows, ranking rows, donut
 *                slices, formula terms, before/after sides — each text + optional sub, value,
 *                icon, colour, operator and state.
 * - `title` / `subtitle` / `body` text, `highlight` (an index into the component's main list),
 *   `format` (currency / percent / k-M / signs / red negatives / prefix-suffix), `animation`
 *   (entrance style, sequencing order, stagger, speed, count-up, emphasis, exit) and `screen`
 *   (an overlay box, or a FULL-screen scene with its own backdrop).
 *
 * A PRESET (graphics/presets.ts) is just a named, tagged starting value for these props, so
 * every one of the 150+ presets is fully editable — any data, any labels, any number of
 * entities/values within each component's designable bounds.
 *
 * Factual rule: `graphicShownNumbers` lists every number a graphic would put on screen
 * (including derived totals), so the Motion Designer's grounding check and the Quality Gate's
 * FACTUAL check cover graphics exactly like the 14 classic templates.
 */

export const GRAPHIC_COMPONENTS = [
  // Money & numbers
  "STAT_TILES",
  "BIG_NUMBER",
  "MONTH_GRID",
  "VALUE_COLUMNS",
  "FORMULA",
  // Comparisons
  "VERSUS",
  "ENTITY_CARDS",
  "BEFORE_AFTER",
  // Charts
  "BAR_GROUP",
  "LINE_AREA",
  "WATERFALL",
  "DONUT",
  "PROGRESS",
  "GAUGE",
  "SCATTER",
  // Timelines, lists, tables
  "STEPS",
  "CHECKLIST",
  "RANKING",
  "TABLE",
  // Text & titles
  "KINETIC",
  "QUOTE",
  "LOWER_THIRD",
  // Callouts & annotations
  "ANNOTATION",
  "STICKER",
  "MAP_PIN",
  "ICON_BURST",
  // Social / CTA
  "CTA",
  // Transitions / emphasis
  "TRANSITION",
] as const;
export type GraphicComponent = (typeof GRAPHIC_COMPONENTS)[number];

/** Original line icons (packages/motion draws them; 24-unit grid). Never system emoji —
 * emoji fonts differ between the iPhone preview and the Linux render host. */
export const GRAPHIC_ICONS = [
  "BRIEFCASE", "LAPTOP", "STORE", "BUILDING", "USER", "USERS", "HOUSE", "CAR", "CARD", "COIN",
  "CASH", "WALLET", "BANK", "PIGGY", "CHART_UP", "CHART_DOWN", "PIE", "CALENDAR", "CLOCK", "LOCK",
  "SHIELD", "PHONE", "CAP", "GIFT", "CART", "PLANE", "HEART", "STAR", "FIRE", "BOLT",
  "TARGET", "TROPHY", "CHECK", "CROSS", "ALERT", "PERCENT", "RECEIPT", "KEY", "GLOBE", "PIN",
  "ROCKET", "SPARKLE", "THUMBS_UP", "BELL", "BOOKMARK", "CHAT", "SHARE", "PLAY", "LINK", "ARROW_UP",
  "ARROW_DOWN", "ARROW_RIGHT", "FOOD", "COFFEE", "HEALTH", "TOOLS", "BABY", "LEAF",
] as const;
export type GraphicIcon = (typeof GRAPHIC_ICONS)[number];

/** Colour tokens resolve against the video's palette/theme (never raw hex: themes recolour). */
export const GRAPHIC_COLORS = ["AUTO", "PRIMARY", "SECONDARY", "POSITIVE", "NEGATIVE", "INK", "MUTED"] as const;
export type GraphicColor = (typeof GRAPHIC_COLORS)[number];

export const GRAPHIC_ENTRANCES = ["RISE", "POP", "FADE", "SLIDE", "WIPE", "DROP", "FLIP", "BLUR"] as const;
export const GRAPHIC_ORDERS = ["TOGETHER", "STAGGER", "GROUP_BY_GROUP", "ONE_BY_ONE"] as const;
export const GRAPHIC_EMPHASES = ["NONE", "PULSE", "GLOW", "RING", "SHAKE"] as const;
export const GRAPHIC_EXITS = ["CONTAINER", "REVERSE", "DROP", "FADE_UP"] as const;
export const GRAPHIC_OPS = ["NONE", "PLUS", "MINUS", "TIMES", "DIVIDE", "EQUALS"] as const;
export const GRAPHIC_STATES = ["NONE", "DONE", "TODO", "NO"] as const;

/** Text limits are sized for legibility at phone size (>= 34 px type at scale 1). */
export const GRAPHIC_LIMITS = {
  title: 80,
  subtitle: 120,
  body: 220,
  seriesLabel: 24,
  seriesNote: 48,
  cellText: 24,
  category: 16,
  itemText: 80,
  itemSub: 100,
  maxSeries: 8,
  maxValues: 36,
  maxCategories: 36,
  maxItems: 12,
} as const;

const finite = z.number().refine((n) => Number.isFinite(n), "must be a number");

export const GraphicSeriesSchema = z.object({
  label: z.string().max(GRAPHIC_LIMITS.seriesLabel).default(""),
  values: z.array(finite).max(GRAPHIC_LIMITS.maxValues).default([]),
  icon: z.enum(GRAPHIC_ICONS).nullable().default(null),
  color: z.enum(GRAPHIC_COLORS).default("AUTO"),
  note: z.string().max(GRAPHIC_LIMITS.seriesNote).nullable().default(null),
  /** Optional text cells (tables): a non-empty string here is shown instead of values[i]. */
  texts: z.array(z.string().max(GRAPHIC_LIMITS.cellText)).max(GRAPHIC_LIMITS.maxValues).default([]),
});
export type GraphicSeries = z.infer<typeof GraphicSeriesSchema>;

export const GraphicItemSchema = z.object({
  text: z.string().max(GRAPHIC_LIMITS.itemText).default(""),
  sub: z.string().max(GRAPHIC_LIMITS.itemSub).nullable().default(null),
  value: finite.nullable().default(null),
  icon: z.enum(GRAPHIC_ICONS).nullable().default(null),
  color: z.enum(GRAPHIC_COLORS).default("AUTO"),
  /** FORMULA: the operator BEFORE this term ("PLUS" → "+ term"); EQUALS marks the result. */
  op: z.enum(GRAPHIC_OPS).default("NONE"),
  /** CHECKLIST: done ✓ / todo ○ / no ✕. */
  state: z.enum(GRAPHIC_STATES).default("NONE"),
});
export type GraphicItem = z.infer<typeof GraphicItemSchema>;

export const GraphicFormatSchema = z.object({
  kind: z.enum(["NUMBER", "CURRENCY", "PERCENT"]).default("NUMBER"),
  currency: z.string().max(3).default("$"),
  /** AUTO: 4000 → 4k, 4250 → 4,250, 2.4M; NONE: always full digits; K/M/B: forced unit. */
  compact: z.enum(["AUTO", "NONE", "K", "M", "B"]).default("AUTO"),
  /** null = smart (as many as the value needs, max 2). */
  decimals: z.number().int().min(0).max(2).nullable().default(null),
  /** NEGATIVE: only negatives get a sign; ALWAYS: "+5k" / "−15k". */
  signs: z.enum(["NEGATIVE", "ALWAYS"]).default("NEGATIVE"),
  /** Negative values in the palette's negative colour (red). */
  negativeRed: z.boolean().default(true),
  prefix: z.string().max(4).default(""),
  suffix: z.string().max(8).default(""),
});
export type GraphicFormat = z.infer<typeof GraphicFormatSchema>;
export const DEFAULT_GRAPHIC_FORMAT: GraphicFormat = GraphicFormatSchema.parse({});

export const GraphicAnimationSchema = z.object({
  /** How each element (cell, bar, card, row…) comes in. */
  enter: z.enum(GRAPHIC_ENTRANCES).default("RISE"),
  /** TOGETHER all at once · STAGGER one after another in reading order · GROUP_BY_GROUP entity
   * after entity (e.g. Employee, then Freelance, then Business owner) · ONE_BY_ONE strictly
   * sequential. */
  order: z.enum(GRAPHIC_ORDERS).default("STAGGER"),
  /** Seconds between elements. Compressed automatically if the build wouldn't fit. */
  stagger: z.number().min(0).max(1).default(0.08),
  /** Extra pause (s) between groups in GROUP_BY_GROUP. */
  groupPause: z.number().min(0).max(3).default(0.35),
  /** Overall tempo (2 = twice as fast). */
  speed: z.number().min(0.5).max(2).default(1),
  /** Numbers count up as they appear. */
  countUp: z.boolean().default(true),
  /** What the highlighted element does once revealed (on the speaker's emphasis if set). */
  emphasis: z.enum(GRAPHIC_EMPHASES).default("GLOW"),
  /** CONTAINER = the graphic's own exit; REVERSE / DROP / FADE_UP = elements leave in turn. */
  exit: z.enum(GRAPHIC_EXITS).default("CONTAINER"),
});
export type GraphicAnimation = z.infer<typeof GraphicAnimationSchema>;
export const DEFAULT_GRAPHIC_ANIMATION: GraphicAnimation = GraphicAnimationSchema.parse({});

// ---------------------------------------------------------------------------------------
// Component specs: variants, which parts of the data model they read, bounds, design size
// ---------------------------------------------------------------------------------------

export type GraphicCategory =
  | "MONEY"
  | "CHARTS"
  | "COMPARISONS"
  | "TIMELINES"
  | "LISTS"
  | "TEXT"
  | "CALLOUTS"
  | "OBJECTS_3D"
  | "EMPHASIS"
  | "SOCIAL";

export const GRAPHIC_CATEGORIES: Array<{ id: GraphicCategory; label: string }> = [
  { id: "MONEY", label: "Money & numbers" },
  { id: "CHARTS", label: "Charts" },
  { id: "COMPARISONS", label: "Comparisons" },
  { id: "TIMELINES", label: "Timelines & steps" },
  { id: "LISTS", label: "Lists & tables" },
  { id: "TEXT", label: "Text & titles" },
  { id: "CALLOUTS", label: "Callouts & annotations" },
  { id: "OBJECTS_3D", label: "3D objects" },
  { id: "EMPHASIS", label: "Transitions & emphasis" },
  { id: "SOCIAL", label: "Social & CTA" },
];

type Range = readonly [number, number];

export interface GraphicComponentSpec {
  id: GraphicComponent;
  label: string;
  blurb: string;
  category: GraphicCategory;
  /** [id, label]; the first is the default. */
  variants: ReadonlyArray<readonly [string, string]>;
  /** Which parts of the data model the component reads (drives the edit sheet + validation). */
  uses: {
    title?: boolean;
    subtitle?: boolean;
    body?: boolean;
    /** series count bounds + values-per-series bounds. */
    series?: { count: Range; values: Range; label: "ENTITY" | "SERIES" | "ROW" };
    categories?: Range;
    items?: { count: Range; value?: boolean; sub?: boolean; icon?: boolean; op?: boolean; state?: boolean };
    highlight?: "SERIES" | "ITEMS" | "VALUES";
    total?: boolean;
    range?: boolean;
    /** Body is required (quotes, kinetic text). */
    bodyRequired?: boolean;
    /** Title is required (lower thirds, transitions). */
    titleRequired?: boolean;
  };
  /** Default overlay vs full-screen scene. FULL_FRAME components are always full screen. */
  kind: "BOX" | "FULL_FRAME";
  preferY: number;
}

const S = (
  id: GraphicComponent,
  label: string,
  blurb: string,
  category: GraphicCategory,
  variants: ReadonlyArray<readonly [string, string]>,
  uses: GraphicComponentSpec["uses"],
  preferY = 0.38,
  kind: GraphicComponentSpec["kind"] = "BOX",
): GraphicComponentSpec => ({ id, label, blurb, category, variants, uses, kind, preferY });

export const GRAPHIC_COMPONENT_SPECS: Record<GraphicComponent, GraphicComponentSpec> = {
  STAT_TILES: S("STAT_TILES", "Stat tiles", "1–6 numbers on glass tiles", "MONEY", [["ROW", "Row"], ["GRID", "Grid"], ["STACK", "Stack"]], {
    title: true,
    items: { count: [1, 6], value: true, sub: true, icon: true },
    highlight: "ITEMS",
  }, 0.32),
  BIG_NUMBER: S("BIG_NUMBER", "Big number", "A hero number that counts — or two, from → to", "MONEY", [["SOLO", "Solo"], ["FROM_TO", "From → to"], ["ODOMETER", "Odometer"]], {
    title: true,
    subtitle: true,
    items: { count: [1, 2], value: true },
  }, 0.3),
  MONTH_GRID: S("MONTH_GRID", "Month grid", "Every month as a cell — one row per person", "MONEY", [["STRIP", "Strip"], ["CALENDAR", "Calendar"]], {
    title: true,
    series: { count: [1, 4], values: [1, 24], label: "ENTITY" },
    categories: [0, 24],
    highlight: "VALUES",
    total: true,
  }, 0.4),
  VALUE_COLUMNS: S("VALUE_COLUMNS", "Value columns", "People side by side, each with their own stack of values", "COMPARISONS", [["CELLS", "Cells"], ["BARS", "Mini bars"]], {
    title: true,
    series: { count: [1, 4], values: [1, 12], label: "ENTITY" },
    highlight: "SERIES",
    total: true,
  }, 0.45),
  FORMULA: S("FORMULA", "Formula", "A + B − C = D, built term by term", "MONEY", [["ROW", "Row"], ["RECEIPT", "Receipt"]], {
    title: true,
    items: { count: [2, 6], value: true, sub: true, op: true },
    highlight: "ITEMS",
  }, 0.36),
  VERSUS: S("VERSUS", "Versus", "A vs B split, metric by metric", "COMPARISONS", [["SPLIT", "Split"], ["CARDS", "Cards"]], {
    title: true,
    series: { count: [2, 2], values: [1, 5], label: "ENTITY" },
    categories: [0, 5],
    highlight: "SERIES",
  }, 0.36),
  ENTITY_CARDS: S("ENTITY_CARDS", "Comparison cards", "2–6 options, each with an icon and a value", "COMPARISONS", [["ROW", "Row"], ["GRID", "Grid"], ["PODIUM", "Podium"]], {
    title: true,
    items: { count: [2, 6], value: true, sub: true, icon: true },
    highlight: "ITEMS",
  }, 0.36),
  BEFORE_AFTER: S("BEFORE_AFTER", "Before / after", "Then vs now with the change", "COMPARISONS", [["SIDE", "Side by side"], ["STACKED", "Stacked"]], {
    title: true,
    items: { count: [2, 2], value: true, sub: true, icon: true },
  }, 0.36),
  BAR_GROUP: S("BAR_GROUP", "Bar chart+", "Grouped or stacked bars, negatives welcome", "CHARTS", [["GROUPED", "Grouped"], ["STACKED", "Stacked"], ["HORIZONTAL", "Horizontal"]], {
    title: true,
    series: { count: [1, 4], values: [1, 12], label: "SERIES" },
    categories: [1, 12],
    highlight: "VALUES",
  }, 0.4),
  LINE_AREA: S("LINE_AREA", "Line / area chart", "Multi-series lines that draw themselves", "CHARTS", [["LINE", "Line"], ["AREA", "Area"]], {
    title: true,
    series: { count: [1, 4], values: [2, 36], label: "SERIES" },
    categories: [0, 36],
  }, 0.38),
  WATERFALL: S("WATERFALL", "Cash flow", "Ups and downs with a running total", "CHARTS", [["STEPS", "Waterfall"], ["FLOW", "Flow"]], {
    title: true,
    series: { count: [1, 1], values: [2, 16], label: "SERIES" },
    categories: [0, 16],
    highlight: "VALUES",
    total: true,
  }, 0.4),
  DONUT: S("DONUT", "Donut / pie", "Shares of a whole", "CHARTS", [["DONUT", "Donut"], ["PIE", "Pie"], ["HALF", "Half"]], {
    title: true,
    items: { count: [2, 7], value: true },
    highlight: "ITEMS",
  }, 0.38),
  PROGRESS: S("PROGRESS", "Progress", "Rings or bars filling toward a goal", "CHARTS", [["RING", "Rings"], ["BARS", "Bars"]], {
    title: true,
    items: { count: [1, 5], value: true, sub: true },
    range: true,
    highlight: "ITEMS",
  }, 0.36),
  GAUGE: S("GAUGE", "Gauge", "A needle on a dial — scores, risk, ratios", "CHARTS", [["DIAL", "Dial"], ["SEGMENTS", "Segments"]], {
    title: true,
    subtitle: true,
    items: { count: [1, 1], value: true },
    range: true,
  }, 0.34),
  SCATTER: S("SCATTER", "Scatter", "Dots on two axes — risk vs return", "CHARTS", [["DOTS", "Dots"], ["BUBBLES", "Bubbles"]], {
    title: true,
    series: { count: [1, 6], values: [2, 3], label: "SERIES" },
    categories: [0, 2],
    highlight: "SERIES",
  }, 0.38),
  STEPS: S("STEPS", "Steps / timeline", "Ordered steps or dated milestones", "TIMELINES", [["VERTICAL", "Vertical"], ["HORIZONTAL", "Horizontal"], ["ROADMAP", "Roadmap"]], {
    title: true,
    items: { count: [2, 6], sub: true, icon: true, value: true },
    highlight: "ITEMS",
  }, 0.38),
  CHECKLIST: S("CHECKLIST", "Checklist", "Do's, don'ts, ticks and bullets", "LISTS", [["CHECK", "Checks"], ["NUMBERED", "Numbered"], ["BULLETS", "Bullets"]], {
    title: true,
    items: { count: [1, 7], sub: true, state: true },
    highlight: "ITEMS",
  }, 0.38),
  RANKING: S("RANKING", "Ranking", "A leaderboard with bars", "LISTS", [["BARS", "Bars"], ["MEDALS", "Medals"]], {
    title: true,
    items: { count: [2, 7], value: true, icon: true },
    highlight: "ITEMS",
  }, 0.38),
  TABLE: S("TABLE", "Table", "Rows × columns of numbers or words", "LISTS", [["CLEAN", "Clean"], ["ZEBRA", "Zebra"]], {
    title: true,
    series: { count: [1, 6], values: [1, 4], label: "ROW" },
    categories: [1, 4],
    highlight: "SERIES",
  }, 0.38),
  KINETIC: S("KINETIC", "Kinetic text+", "Stacked, highlighted, struck-through type", "TEXT", [["STACK", "Stack"], ["HIGHLIGHT", "Highlighter"], ["STRIKE", "Strike → replace"], ["OUTLINE", "Outline"]], {
    title: true,
    body: true,
    bodyRequired: true,
  }, 0.4),
  QUOTE: S("QUOTE", "Quote / callout", "A quote, rule or note on a card", "TEXT", [["QUOTE", "Quote"], ["NOTE", "Note"], ["BUBBLE", "Speech bubble"]], {
    title: true,
    body: true,
    bodyRequired: true,
  }, 0.36),
  LOWER_THIRD: S("LOWER_THIRD", "Lower third", "Name + title bar", "TEXT", [["BAR", "Bar"], ["TAG", "Tag"], ["MINIMAL", "Minimal"]], {
    title: true,
    subtitle: true,
    titleRequired: true,
  }, 0.62),
  ANNOTATION: S("ANNOTATION", "Annotation", "Circle, arrow, underline or box on screen", "CALLOUTS", [["CIRCLE", "Circle"], ["ARROW", "Arrow"], ["UNDERLINE", "Underline"], ["BOX", "Box"]], {
    title: true,
  }, 0.5),
  STICKER: S("STICKER", "Sticker", "A badge that pops: icon + word", "CALLOUTS", [["BADGE", "Badge"], ["STAMP", "Stamp"], ["BUBBLE", "Bubble"]], {
    title: true,
    items: { count: [0, 1], icon: true, value: true },
  }, 0.3),
  MAP_PIN: S("MAP_PIN", "Map pins", "Places with values on a minimal map", "CALLOUTS", [["PINS", "Pins"], ["ROUTE", "Route"]], {
    title: true,
    items: { count: [1, 5], value: true, sub: true },
    highlight: "ITEMS",
  }, 0.38),
  ICON_BURST: S("ICON_BURST", "Icon burst", "Icons bursting around a word", "CALLOUTS", [["BURST", "Burst"], ["ROW", "Row"], ["ORBIT", "Orbit"]], {
    title: true,
    items: { count: [1, 8], icon: true },
  }, 0.34),
  CTA: S("CTA", "Call to action", "Follow / save / comment prompt", "SOCIAL", [["FOLLOW", "Follow"], ["SAVE", "Save"], ["COMMENT", "Comment"], ["SHARE", "Share"]], {
    title: true,
    subtitle: true,
    titleRequired: true,
  }, 0.62),
  TRANSITION: S("TRANSITION", "Transition", "Full-screen wipe, flash or word slam", "EMPHASIS", [["WIPE", "Wipe"], ["IRIS", "Iris"], ["SLAM", "Word slam"], ["FLASH", "Flash"]], {
    title: true,
  }, 0.5, "FULL_FRAME"),
};

// ---------------------------------------------------------------------------------------
// Props schema
// ---------------------------------------------------------------------------------------

const GraphicPropsBase = z.object({
  component: z.enum(GRAPHIC_COMPONENTS),
  /** One of the component's variants (first = default). */
  variant: z.string().max(24).nullable().default(null),
  /** The preset this started from (labels, favourites/recents, taste) — informational only. */
  preset: z.string().max(80).nullable().default(null),
  title: z.string().max(GRAPHIC_LIMITS.title).nullable().default(null),
  subtitle: z.string().max(GRAPHIC_LIMITS.subtitle).nullable().default(null),
  body: z.string().max(GRAPHIC_LIMITS.body).nullable().default(null),
  series: z.array(GraphicSeriesSchema).max(GRAPHIC_LIMITS.maxSeries).default([]),
  categories: z.array(z.string().max(GRAPHIC_LIMITS.category)).max(GRAPHIC_LIMITS.maxCategories).default([]),
  items: z.array(GraphicItemSchema).max(GRAPHIC_LIMITS.maxItems).default([]),
  /** Index into the component's main list (entity / item / value) — null = none. */
  highlight: z.number().int().min(0).max(35).nullable().default(null),
  /** Show derived totals (sum of each entity / running total) where the component has them. */
  showTotal: z.boolean().default(false),
  /** Gauge / progress scale (null = 0..100 for progress, auto for gauge). */
  range: z.object({ min: finite, max: finite }).nullable().default(null),
  format: GraphicFormatSchema.default(DEFAULT_GRAPHIC_FORMAT),
  animation: GraphicAnimationSchema.default(DEFAULT_GRAPHIC_ANIMATION),
  /** OVERLAY = a box placed around Chris; FULL = a full-screen scene with its own backdrop. */
  screen: z.enum(["OVERLAY", "FULL"]).default("OVERLAY"),
});

/** Plain-English problems with a GRAPHIC's props (component bounds). Empty = renders. */
export function graphicPropsIssues(p: z.infer<typeof GraphicPropsBase>): Array<{ path: Array<string | number>; message: string }> {
  const spec = GRAPHIC_COMPONENT_SPECS[p.component];
  const out: Array<{ path: Array<string | number>; message: string }> = [];
  const u = spec.uses;
  if (p.variant !== null && !spec.variants.some(([id]) => id === p.variant)) out.push({ path: ["variant"], message: `isn't a ${spec.label} layout` });
  if (u.series) {
    const [lo, hi] = u.series.count;
    if (p.series.length < lo) out.push({ path: ["series"], message: lo === 1 ? "needs at least one row of values" : `needs at least ${lo} rows` });
    if (p.series.length > hi) out.push({ path: ["series"], message: `can show at most ${hi} rows` });
    const [vlo, vhi] = u.series.values;
    p.series.slice(0, hi).forEach((s, i) => {
      if (s.values.length < vlo) out.push({ path: ["series", i, "values"], message: vlo === 1 ? "needs at least one value" : `needs at least ${vlo} values` });
      if (s.values.length > vhi) out.push({ path: ["series", i, "values"], message: `can show at most ${vhi} values` });
    });
  }
  if (u.items) {
    const [lo, hi] = u.items.count;
    if (p.items.length < lo) out.push({ path: ["items"], message: lo === 1 ? "needs at least one entry" : `needs at least ${lo} entries` });
    if (p.items.length > hi) out.push({ path: ["items"], message: `can show at most ${hi} entries` });
    if (u.items.value && ["DONUT", "PROGRESS", "GAUGE", "BIG_NUMBER"].includes(p.component)) {
      p.items.forEach((it, i) => {
        if (it.value === null) out.push({ path: ["items", i, "value"], message: "needs a number" });
      });
    }
  }
  if (p.component === "DONUT" && p.items.some((it) => (it.value ?? 0) < 0)) out.push({ path: ["items"], message: "slices can't be negative" });
  if (u.categories && p.categories.length > u.categories[1]) out.push({ path: ["categories"], message: `can show at most ${u.categories[1]} labels` });
  if (u.bodyRequired && !(p.body && p.body.trim())) out.push({ path: ["body"], message: "can't be empty" });
  if (u.titleRequired && !(p.title && p.title.trim())) out.push({ path: ["title"], message: "can't be empty" });
  if (p.range && !(p.range.max > p.range.min)) out.push({ path: ["range"], message: "max must be above min" });
  return out;
}

export const GraphicPropsSchema = GraphicPropsBase.superRefine((p, ctx) => {
  for (const i of graphicPropsIssues(p)) ctx.addIssue({ code: "custom", path: i.path, message: i.message });
});
export type GraphicProps = z.infer<typeof GraphicPropsSchema>;

/** The variant actually used (null / unknown → the component's default). */
export function graphicVariant(p: Pick<GraphicProps, "component" | "variant">): string {
  const spec = GRAPHIC_COMPONENT_SPECS[p.component];
  return p.variant && spec.variants.some(([id]) => id === p.variant) ? p.variant : spec.variants[0]![0];
}

export function isFullScreenGraphic(p: Pick<GraphicProps, "component" | "screen">): boolean {
  return GRAPHIC_COMPONENT_SPECS[p.component].kind === "FULL_FRAME" || p.screen === "FULL";
}

// ---------------------------------------------------------------------------------------
// Design size — the box (px at a 1080-wide canvas, scale 1) the component lays out in. The
// placement engine keeps exactly this box clear of Chris/captions/UI (footprintOf).
// ---------------------------------------------------------------------------------------

const ceil = Math.ceil;

export function graphicDesignSize(p: GraphicProps): { width: number; height: number } {
  const v = graphicVariant(p);
  const head = p.title ? (p.subtitle ? 150 : 104) : 0;
  const nS = p.series.length;
  const nI = p.items.length;
  const maxVals = p.series.reduce((a, s) => Math.max(a, s.values.length), 0);
  switch (p.component) {
    case "STAT_TILES": {
      if (v === "STACK") return { width: 760, height: head + Math.max(1, nI) * 176 + 40 };
      if (v === "GRID") return { width: 960, height: head + ceil(Math.max(1, nI) / 2) * 250 + 40 };
      return { width: 980, height: head + (nI <= 4 ? 300 : 2 * 250) + 40 };
    }
    case "BIG_NUMBER":
      return v === "FROM_TO" ? { width: 980, height: 300 + head + (p.subtitle ? 0 : 0) } : { width: 860, height: 280 + head };
    case "MONTH_GRID": {
      const cols = v === "CALENDAR" ? 4 : 6;
      const block = (n: number) => (nS > 1 || p.showTotal ? 62 : 0) + ceil(Math.max(1, n) / cols) * ((v === "CALENDAR" ? 150 : 118) + 12) - 12;
      const body = p.series.reduce((a, s) => a + block(s.values.length) + 22, 0);
      return { width: 980, height: head + body + 58 };
    }
    case "VALUE_COLUMNS": {
      const rows = Math.max(1, maxVals);
      const cell = valueColumnsCell(rows, p.screen === "FULL");
      return { width: nS >= 4 ? 1000 : 980, height: head + rows * cell + 210 + (p.showTotal ? 96 : 0) + 40 };
    }
    case "FORMULA":
      return v === "RECEIPT" ? { width: 780, height: head + nI * 108 + 120 } : { width: 1000, height: head + (nI > 3 ? 440 : 300) + 40 };
    case "VERSUS":
      return { width: 980, height: head + 230 + Math.max(1, maxVals) * 112 + 40 };
    case "ENTITY_CARDS": {
      if (v === "GRID") return { width: 960, height: head + ceil(nI / 2) * 300 + 40 };
      if (v === "PODIUM") return { width: 980, height: head + 620 };
      return { width: 1000, height: head + (nI > 3 ? 2 * 330 : 420) + 40 };
    }
    case "BEFORE_AFTER":
      return v === "STACKED" ? { width: 780, height: head + 700 } : { width: 1000, height: head + 520 };
    case "BAR_GROUP":
      return v === "HORIZONTAL" ? { width: 940, height: head + Math.max(2, Math.max(p.categories.length, maxVals)) * (nS > 1 ? 104 : 86) + 110 } : { width: 960, height: head + 700 };
    case "LINE_AREA":
      return { width: 960, height: head + 640 + (nS > 1 ? 70 : 0) };
    case "WATERFALL":
      return { width: 980, height: head + 720 };
    case "DONUT":
      return v === "HALF" ? { width: 940, height: head + 560 + ceil(nI / 2) * 64 } : { width: 960, height: head + 560 + ceil(nI / 2) * 64 };
    case "PROGRESS":
      return v === "BARS" ? { width: 920, height: head + Math.max(1, nI) * 140 + 50 } : { width: nI <= 1 ? 600 : 980, height: head + 470 };
    case "GAUGE":
      return { width: 800, height: head + 560 };
    case "SCATTER":
      return { width: 940, height: head + 780 };
    case "STEPS":
      if (v === "HORIZONTAL") return { width: 1000, height: head + 470 };
      if (v === "ROADMAP") return { width: 960, height: head + Math.max(2, nI) * 160 + 60 };
      return { width: 860, height: head + Math.max(2, nI) * 150 + 40 };
    case "CHECKLIST":
      return { width: 880, height: head + Math.max(1, nI) * (p.items.some((i) => i.sub) ? 140 : 112) + 50 };
    case "RANKING":
      return { width: 920, height: head + Math.max(2, nI) * 116 + 50 };
    case "TABLE":
      return { width: 980, height: head + (Math.max(1, nS) + 1) * 96 + 60 };
    case "KINETIC":
      return { width: 960, height: 560 };
    case "QUOTE":
      return v === "BUBBLE" ? { width: 880, height: 520 } : { width: 920, height: 600 };
    case "LOWER_THIRD":
      return { width: 900, height: 230 };
    case "ANNOTATION":
      if (v === "ARROW") return { width: 560, height: 360 };
      if (v === "UNDERLINE") return { width: 640, height: 200 };
      if (v === "BOX") return { width: 640, height: 420 };
      return { width: 480, height: 480 };
    case "STICKER":
      return { width: 560, height: 560 };
    case "MAP_PIN":
      return { width: 940, height: head + 760 };
    case "ICON_BURST":
      return v === "ROW" ? { width: 980, height: 420 } : { width: 800, height: 800 };
    case "CTA":
      return { width: 900, height: 260 };
    case "TRANSITION":
      return { width: 1080, height: 1920 };
  }
}

/** VALUE_COLUMNS row height (a full-screen scene has room for taller rows). */
export function valueColumnsCell(rows: number, full: boolean): number {
  if (full) return rows > 8 ? 74 : rows > 5 ? 88 : 104;
  return rows > 8 ? 60 : rows > 5 ? 72 : 92;
}

// ---------------------------------------------------------------------------------------
// Number formatting (shared by the renderer, the editor and summaries)
// ---------------------------------------------------------------------------------------

export interface NumberPlan {
  divisor: number;
  unit: "" | "k" | "M" | "B";
  decimals: number;
}

const MINUS = "−";

function decimalsNeeded(x: number, max = 2): number {
  for (let d = 0; d <= max; d++) {
    const k = 10 ** d;
    if (Math.abs(Math.round(x * k) - x * k) < 1e-6) return d;
  }
  return max;
}

/** How a value is shown (unit + decimals) — decided from the FINAL value, so a count-up never
 * changes format mid-count ("1k, 2k, 3k, 4k", not "1,250 … 4k"). */
export function numberPlan(value: number, fmt: Pick<GraphicFormat, "compact" | "decimals" | "kind">): NumberPlan {
  const a = Math.abs(value);
  const forced = fmt.compact === "K" ? 1e3 : fmt.compact === "M" ? 1e6 : fmt.compact === "B" ? 1e9 : 0;
  let divisor = 1;
  if (fmt.kind !== "PERCENT") {
    if (forced) divisor = forced;
    else if (fmt.compact === "AUTO") {
      if (a >= 1e9) divisor = 1e9;
      else if (a >= 1e6) divisor = 1e6;
      else if (a >= 1e3) {
        const k = a / 1e3;
        divisor = decimalsNeeded(k, 2) <= 1 || a >= 1e5 ? 1e3 : 1;
      }
    }
  }
  const unit = divisor === 1e9 ? "B" : divisor === 1e6 ? "M" : divisor === 1e3 ? "k" : "";
  const scaled = a / divisor;
  const decimals = fmt.decimals ?? Math.min(divisor === 1 ? 2 : 1, decimalsNeeded(scaled, divisor === 1 ? 2 : 1));
  return { divisor, unit, decimals };
}

export interface FormattedNumber {
  text: string;
  negative: boolean;
}

/** "−$15k", "+12%", "$4k/mo", "1,250" — with a true minus sign. */
export function formatGraphicNumber(value: number, fmt: GraphicFormat, plan: NumberPlan = numberPlan(value, fmt)): FormattedNumber {
  const negative = value < 0 && Math.abs(value) >= 0.5 * 10 ** -plan.decimals * plan.divisor;
  const a = Math.abs(value) / plan.divisor;
  const core = a.toLocaleString("en-US", { minimumFractionDigits: plan.decimals, maximumFractionDigits: plan.decimals });
  const sign = negative ? MINUS : fmt.signs === "ALWAYS" && value > 0 ? "+" : "";
  const money = fmt.kind === "CURRENCY" ? fmt.currency : "";
  const pct = fmt.kind === "PERCENT" ? "%" : "";
  return { text: `${sign}${fmt.prefix}${money}${core}${plan.unit}${pct}${fmt.suffix}`, negative };
}

export function formatGraphicValue(value: number, fmt: GraphicFormat): string {
  return formatGraphicNumber(value, fmt).text;
}

// ---------------------------------------------------------------------------------------
// Derived values + the numbers a graphic shows (factual gate)
// ---------------------------------------------------------------------------------------

export function seriesTotal(s: Pick<GraphicSeries, "values">): number {
  return round6(s.values.reduce((a, b) => a + b, 0));
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** WATERFALL running totals after each step. */
export function runningTotals(values: number[]): number[] {
  let acc = 0;
  return values.map((v) => (acc = round6(acc + v)));
}

/** DONUT shares (percent, rounded to 1 dp) of each item's value. */
export function donutShares(items: Array<Pick<GraphicItem, "value">>): number[] {
  const sum = items.reduce((a, it) => a + Math.max(0, it.value ?? 0), 0);
  return items.map((it) => (sum > 0 ? Math.round((Math.max(0, it.value ?? 0) / sum) * 1000) / 10 : 0));
}

/** Gauge / progress scale. */
export function graphicRange(p: Pick<GraphicProps, "component" | "range" | "items">): { min: number; max: number } {
  if (p.range && p.range.max > p.range.min) return p.range;
  if (p.component === "GAUGE") {
    const v = p.items[0]?.value ?? 0;
    return { min: 0, max: v <= 100 ? 100 : 10 ** Math.ceil(Math.log10(Math.max(1, v))) };
  }
  return { min: 0, max: 100 };
}

/**
 * Every number the graphic puts on screen, with its source field. Includes DERIVED numbers
 * (entity totals, running totals, donut shares, gauge/progress scale ends) — a computed total
 * is still a number on screen and must be grounded. Structural fields (animation timings,
 * decimals, highlight index, range when not drawn) are excluded. Digits inside text are
 * extracted by the caller (it owns number-word parsing): `texts` lists every string shown.
 */
export function graphicShownNumbers(props: GraphicProps): { numbers: Array<{ value: number; field: string }>; texts: Array<{ text: string; field: string }> } {
  const numbers: Array<{ value: number; field: string }> = [];
  const texts: Array<{ text: string; field: string }> = [];
  const spec = GRAPHIC_COMPONENT_SPECS[props.component];
  const u = spec.uses;
  const t = (text: string | null, field: string) => {
    if (text && text.trim()) texts.push({ text, field });
  };
  if (u.title || props.title) t(props.title, "title");
  if (u.subtitle) t(props.subtitle, "subtitle");
  if (u.body) t(props.body, "body");
  // Components that are pure prefab (no numbers in their design) still show their text.
  if (u.series) {
    props.series.forEach((s, i) => {
      t(s.label, `series[${i}].label`);
      t(s.note, `series[${i}].note`);
      s.values.forEach((v, j) => {
        const cell = s.texts[j];
        if (cell && cell.trim()) t(cell, `series[${i}].texts[${j}]`);
        else numbers.push({ value: v, field: `series[${i}].values[${j}]` });
      });
      if (props.showTotal && u.total && props.component !== "WATERFALL") numbers.push({ value: seriesTotal(s), field: `series[${i}] total` });
    });
    if (props.component === "WATERFALL" && props.series[0]) {
      const rt = runningTotals(props.series[0].values);
      if (props.showTotal && rt.length) numbers.push({ value: rt[rt.length - 1]!, field: "running total" });
    }
  }
  if (u.categories) props.categories.forEach((c, i) => t(c, `categories[${i}]`));
  if (u.items) {
    props.items.forEach((it, i) => {
      t(it.text, `items[${i}].text`);
      if (u.items!.sub) t(it.sub, `items[${i}].sub`);
      if (u.items!.value && it.value !== null) numbers.push({ value: it.value, field: `items[${i}].value` });
    });
    if (props.component === "DONUT") donutShares(props.items).forEach((s, i) => numbers.push({ value: s, field: `items[${i}] share %` }));
  }
  if (props.component === "GAUGE") {
    const r = graphicRange(props);
    numbers.push({ value: r.min, field: "range.min" }, { value: r.max, field: "range.max" });
  }
  if (props.component === "PROGRESS" && props.range) numbers.push({ value: props.range.max, field: "range.max" });
  return { numbers, texts };
}

/** A short human summary for timeline labels and lists ("Value columns · Employee, Freelance…"). */
export function graphicSummary(p: GraphicProps, presetName?: string | null): string {
  const spec = GRAPHIC_COMPONENT_SPECS[p.component];
  const name = presetName ?? spec.label;
  const what =
    p.title ||
    p.body ||
    (p.series.length ? p.series.map((s) => s.label).filter(Boolean).join(", ") : "") ||
    p.items.map((i) => i.text).filter(Boolean).join(", ");
  const s = what.length > 26 ? `${what.slice(0, 25).trimEnd()}…` : what;
  return s ? `${name} · ${s}` : name;
}
