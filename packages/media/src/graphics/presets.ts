import type { MotionTemplate, SfxSound } from "../motion-contract";
import type { GraphicCategory, GraphicComponent, GraphicProps } from "./contract";
import { FX_PRESETS } from "./library2/fx";
import { LIFE_PRESETS } from "./library2/life";
import { OBJECTS_PRESETS } from "./library2/objects";
import { SIGNATURE_PRESETS } from "./library2/signature";
import { FX2_PRESETS } from "./library2/fx2";
import { PHONE_PRESETS } from "./library2/phone";
import { SOCIAL_PRESETS } from "./library2/social";
import { WEB_PRESETS } from "./library2/web";

/**
 * The graphics LIBRARY: 150+ curated presets. Each is a named, tagged, categorised starting
 * value for a base component's props (a composable GRAPHIC, or one of the 14 classic
 * templates) — never a one-off design. So every preset is fully editable: change any number,
 * label, entity count, layout, format, animation or theme.
 *
 * Numbers are illustrative placeholders — the editor says so, and the Quality Gate refuses any
 * on-screen number that isn't in the fact-checked research/script (CLAUDE.md factual rule).
 */

export interface GraphicPreset {
  id: string;
  name: string;
  description: string;
  category: GraphicCategory;
  tags: string[];
  template: MotionTemplate;
  props: Record<string, unknown>;
  /** Suggested on-screen seconds (a sequenced build needs time). */
  seconds: number;
  placement?: { mode?: "AUTO" | "MANUAL"; x?: number; y?: number; scale?: number };
  palette?: "BRAND" | "MONO" | "VIVID";
  enterSfx?: SfxSound | null;
  /** Shown first in its category. */
  featured?: boolean;
}

// ---------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------

type DeepPartial<T> = { [K in keyof T]?: T[K] extends Array<infer U> ? Array<DeepPartial<U>> : T[K] extends object | null ? DeepPartial<NonNullable<T[K]>> | null : T[K] };
type GInput = DeepPartial<GraphicProps>;

const USD = { kind: "CURRENCY" as const };
const PCT = { kind: "PERCENT" as const };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const Q = ["Q1", "Q2", "Q3", "Q4"];
const k = (n: number) => n * 1000;

function S(label: string, values: number[], extra: Record<string, unknown> = {}) {
  return { label, values, ...extra };
}
function I(text: string, value: number | null = null, extra: Record<string, unknown> = {}) {
  return { text, value, ...extra };
}

let order = 0;
const all: GraphicPreset[] = [];

function graphic(
  id: string,
  name: string,
  description: string,
  category: GraphicCategory,
  tags: string[],
  component: GraphicComponent,
  data: GInput,
  opts: { seconds?: number; featured?: boolean; placement?: GraphicPreset["placement"]; palette?: GraphicPreset["palette"]; enterSfx?: SfxSound | null } = {},
): void {
  order++;
  all.push({
    id,
    name,
    description,
    category,
    tags,
    template: "GRAPHIC",
    props: { ...data, component, preset: id },
    seconds: opts.seconds ?? 4,
    placement: opts.placement,
    palette: opts.palette,
    enterSfx: opts.enterSfx === undefined ? "WHOOSH" : opts.enterSfx,
    featured: opts.featured,
  });
}

function classic(
  id: string,
  name: string,
  description: string,
  category: GraphicCategory,
  tags: string[],
  template: Exclude<MotionTemplate, "GRAPHIC">,
  props: Record<string, unknown>,
  opts: { seconds?: number; featured?: boolean; placement?: GraphicPreset["placement"]; enterSfx?: SfxSound | null } = {},
): void {
  order++;
  all.push({ id, name, description, category, tags, template, props, seconds: opts.seconds ?? 3.5, placement: opts.placement, enterSfx: opts.enterSfx === undefined ? "WHOOSH" : opts.enterSfx, featured: opts.featured });
}

const BY_GROUP = { order: "GROUP_BY_GROUP" as const };
const ONE = { order: "ONE_BY_ONE" as const };

// =======================================================================================
// MONEY & NUMBERS
// =======================================================================================

graphic(
  "income-3-people-12-months",
  "Income comparison — 3 people × 12 months",
  "Employee, then Freelance, then Business owner: each column fills month by month, with the year's total under each.",
  "MONEY",
  ["income", "salary", "freelance", "business", "monthly", "comparison", "employee", "self-employed", "volatility", "chris"],
  "VALUE_COLUMNS",
  {
    title: "Monthly income, one year",
    series: [
      S("Employee", Array(12).fill(k(4)), { icon: "BRIEFCASE" }),
      S("Freelance", [k(2), k(6), 0, k(8), k(3), k(5), k(1), k(7), k(4), k(2), k(9), k(3)], { icon: "LAPTOP" }),
      S("Business owner", [0, k(5), -k(15), -k(5), k(50), k(5), 0, k(100)], { icon: "STORE" }),
    ],
    showTotal: true,
    format: USD,
    animation: { ...BY_GROUP, stagger: 0.06, groupPause: 0.3 },
    screen: "FULL",
  },
  { seconds: 9, featured: true, enterSfx: "SWOOSH_UP" },
);
graphic("salary-freelance-business", "Salary vs freelance vs business", "Three ways to earn, as mini bars per month — steady, lumpy, wild.", "COMPARISONS", ["income", "salary", "freelance", "business", "comparison", "bars"], "VALUE_COLUMNS", {
  title: "Same year, three ways to earn",
  variant: "BARS",
  series: [S("Salary", [k(4), k(4), k(4), k(4), k(4), k(4)]), S("Freelance", [k(2), k(6), 0, k(8), k(3), k(5)]), S("Business", [0, k(5), -k(15), -k(5), k(50), k(5)])],
  format: USD,
  animation: BY_GROUP,
}, { seconds: 7 });
graphic("rent-vs-buy-5-years", "Rent vs buy — 5 years", "Two columns of yearly cost with totals.", "COMPARISONS", ["rent", "buy", "house", "mortgage", "home", "comparison", "housing"], "VALUE_COLUMNS", {
  title: "Five years of housing costs",
  series: [S("Renting", [k(24), k(25), k(26), k(27), k(28)], { icon: "BUILDING" }), S("Buying", [k(62), k(30), k(30), k(31), k(31)], { icon: "HOUSE" })],
  categories: ["Yr 1", "Yr 2", "Yr 3", "Yr 4", "Yr 5"],
  showTotal: true,
  format: USD,
  animation: BY_GROUP,
}, { seconds: 6 });
graphic("one-person-12-months-column", "A year of paychecks", "One column, twelve months, the total at the bottom.", "MONEY", ["income", "paycheck", "salary", "monthly", "year", "total"], "VALUE_COLUMNS", {
  title: "Every paycheck this year",
  series: [S("Take-home", Array(12).fill(3850), { icon: "WALLET" })],
  categories: MONTHS,
  showTotal: true,
  format: USD,
}, { seconds: 6 });
graphic("monthly-income-strip", "Month strip — one year", "Twelve months as a strip of cells.", "MONEY", ["monthly", "income", "year", "calendar", "months"], "MONTH_GRID", {
  title: "Income by month",
  series: [S("Income", [k(4), k(4), k(4), k(4.5), k(4.5), k(4.5), k(4.5), k(4.5), k(5), k(5), k(5), k(6)])],
  categories: MONTHS,
  format: USD,
}, { seconds: 5, featured: true });
graphic("side-hustle-calendar", "Side hustle calendar", "Calendar-style grid of what each month brought in.", "MONEY", ["side hustle", "income", "calendar", "monthly", "extra money"], "MONTH_GRID", {
  title: "Side hustle, month by month",
  variant: "CALENDAR",
  series: [S("Side hustle", [150, 300, 0, 420, 650, 800, 520, 900, 1200, 1100, 1500, 2100])],
  categories: MONTHS,
  highlight: 11,
  format: USD,
  animation: { emphasis: "GLOW" },
}, { seconds: 6 });
graphic("two-incomes-month-grid", "You vs your partner — 12 months", "Two rows of monthly cells with each person's total.", "COMPARISONS", ["couple", "partner", "income", "monthly", "household", "comparison"], "MONTH_GRID", {
  title: "Household income",
  series: [S("You", Array(12).fill(k(4.2)), { icon: "USER" }), S("Partner", [k(3), k(3), k(3), k(3.5), k(3.5), k(3.5), k(3.5), k(5), k(5), k(5), k(5), k(5)], { icon: "USER" })],
  categories: MONTHS,
  showTotal: true,
  format: USD,
  animation: BY_GROUP,
}, { seconds: 7 });
graphic("spending-by-month", "Spending by month (December spike)", "Monthly spend with the holiday month highlighted.", "MONEY", ["spending", "expenses", "monthly", "holiday", "christmas", "budget"], "MONTH_GRID", {
  title: "What I spent each month",
  series: [S("Spending", [2900, 2750, 2800, 3100, 2950, 3300, 3400, 3000, 2850, 3050, 3600, 5200])],
  categories: MONTHS,
  highlight: 11,
  format: USD,
  animation: { emphasis: "PULSE" },
}, { seconds: 6 });
graphic("profit-loss-months", "Business profit & loss — 12 months", "Months in the red and the black, red negatives.", "MONEY", ["profit", "loss", "business", "monthly", "cash flow", "negative"], "MONTH_GRID", {
  title: "Profit by month",
  series: [S("Profit", [-k(2), -k(1.5), k(0.5), k(1), -k(0.8), k(2), k(3.5), k(2.8), k(4), k(5.5), k(4.2), k(7)])],
  categories: MONTHS,
  format: { ...USD, signs: "ALWAYS" },
  showTotal: true,
}, { seconds: 6 });
graphic("three-key-numbers", "Three key numbers", "Three glass tiles that count up together.", "MONEY", ["stats", "numbers", "kpi", "tiles", "summary"], "STAT_TILES", {
  items: [I("Saved", k(12), { icon: "PIGGY" }), I("Invested", k(30), { icon: "CHART_UP" }), I("Debt left", 0, { icon: "CARD" })],
  format: USD,
}, { featured: true });
graphic("net-worth-snapshot", "Net worth snapshot", "Assets, debts, cash and the bottom line on a 2×2 grid.", "MONEY", ["net worth", "assets", "debt", "wealth", "balance sheet"], "STAT_TILES", {
  title: "Net worth snapshot",
  variant: "GRID",
  items: [I("Assets", k(184)), I("Debts", -k(46)), I("Cash", k(18)), I("Net worth", k(138), { color: "PRIMARY" })],
  highlight: 3,
  format: USD,
}, { seconds: 5 });
graphic("budget-breakdown-stack", "Budget breakdown", "Category rows with icons and amounts.", "MONEY", ["budget", "expenses", "spending", "categories", "monthly"], "STAT_TILES", {
  title: "Monthly budget",
  variant: "STACK",
  items: [I("Rent", 1800, { icon: "HOUSE", sub: "Fixed" }), I("Food", 650, { icon: "FOOD", sub: "Groceries + eating out" }), I("Transport", 420, { icon: "CAR" }), I("Savings", 900, { icon: "PIGGY", sub: "Paid first" })],
  highlight: 3,
  format: USD,
}, { seconds: 5 });
graphic("emergency-fund-stat", "Emergency fund target", "One big tile: the number you need.", "MONEY", ["emergency fund", "savings", "safety net", "goal"], "STAT_TILES", {
  items: [I("Six months of expenses", k(18), { icon: "SHIELD", sub: "Your safety net" })],
  format: USD,
});
graphic("savings-rates-tiles", "Savings account rates", "Three rates side by side.", "MONEY", ["interest", "rates", "savings account", "hysa", "apy", "bank"], "STAT_TILES", {
  title: "Where your cash earns",
  items: [I("Big bank", 0.01, { icon: "BANK" }), I("Savings", 0.45, { icon: "PIGGY" }), I("High-yield", 4.3, { icon: "BOLT" })],
  highlight: 2,
  format: { ...PCT, decimals: 2 },
});
graphic("hero-salary", "Big number — salary", "One hero number counting up.", "MONEY", ["salary", "income", "big number", "counter", "pay"], "BIG_NUMBER", {
  items: [I("a year, before tax", 72000)],
  format: { ...USD, compact: "NONE" },
}, { featured: true });
graphic("hero-debt-negative", "Big number — debt (red)", "A negative balance in red.", "MONEY", ["debt", "credit card", "negative", "owe", "balance"], "BIG_NUMBER", {
  items: [I("on the credit card", -4200)],
  format: { ...USD, compact: "NONE" },
});
graphic("raise-from-to", "From → to (a raise)", "Old number to new number with an arrow.", "MONEY", ["raise", "salary", "increase", "before after", "growth"], "BIG_NUMBER", {
  variant: "FROM_TO",
  items: [I("before", k(55)), I("after", k(72))],
  format: USD,
});
graphic("debt-to-zero", "Debt countdown to $0", "A balance counting down to zero.", "MONEY", ["debt", "payoff", "zero", "debt free", "countdown"], "BIG_NUMBER", {
  variant: "FROM_TO",
  title: "Debt free",
  items: [I("start", 18400), I("today", 0)],
  format: { ...USD, compact: "NONE" },
});
graphic("odometer-million", "Odometer — first million", "Digits roll into place.", "MONEY", ["million", "net worth", "milestone", "odometer", "counter"], "BIG_NUMBER", {
  variant: "ODOMETER",
  items: [I("net worth", 1000000)],
  format: { ...USD, compact: "NONE" },
});
graphic("per-day-cost", "Big number — per day", "Reframe a cost as a daily number.", "MONEY", ["per day", "daily", "cost", "reframe", "small amounts"], "BIG_NUMBER", {
  title: "That subscription is",
  items: [I("every single day", 2.74)],
  format: { ...USD, decimals: 2 },
});
graphic("formula-take-home", "Take-home pay formula", "Salary − taxes − retirement = take-home.", "MONEY", ["take home", "paycheck", "taxes", "salary", "net pay", "formula"], "FORMULA", {
  items: [I("Salary", k(72)), I("Taxes", k(14), { op: "MINUS" }), I("401(k)", k(7), { op: "MINUS" }), I("Take-home", k(51), { op: "EQUALS" })],
  format: USD,
}, { seconds: 5, featured: true });
graphic("formula-budget-receipt", "Budget receipt", "Income minus each bill, line by line, to what's left.", "MONEY", ["budget", "receipt", "left over", "bills", "expenses", "monthly"], "FORMULA", {
  title: "Where the paycheck goes",
  variant: "RECEIPT",
  items: [I("Paycheck", 4200, { op: "NONE" }), I("Rent", 1600, { op: "MINUS" }), I("Car + insurance", 560, { op: "MINUS" }), I("Food", 600, { op: "MINUS" }), I("Left over", 1440, { op: "EQUALS" })],
  format: { ...USD, compact: "NONE" },
}, { seconds: 6 });
graphic("formula-contributions", "Contributions math", "$500 a month × 12 × 30 years.", "MONEY", ["investing", "contributions", "monthly", "math", "formula", "retirement"], "FORMULA", {
  items: [I("a month", 500), I("months", 12, { op: "TIMES" }), I("years", 30, { op: "TIMES" }), I("you put in", 180000, { op: "EQUALS" })],
  format: { ...USD },
}, { seconds: 5 });
graphic("formula-net-worth", "Net worth formula", "What you own − what you owe = net worth.", "MONEY", ["net worth", "assets", "liabilities", "formula", "wealth"], "FORMULA", {
  items: [I("What you own", k(184)), I("What you owe", k(46), { op: "MINUS" }), I("Net worth", k(138), { op: "EQUALS" })],
  format: USD,
});
graphic("formula-side-hustle", "Side hustle math", "$/hour × hours × weeks = monthly.", "MONEY", ["side hustle", "hourly", "math", "extra income", "formula"], "FORMULA", {
  items: [I("an hour", 25), I("hours/week", 10, { op: "TIMES" }), I("weeks", 4, { op: "TIMES" }), I("a month", 1000, { op: "EQUALS" })],
  format: { ...USD, compact: "NONE" },
}, { seconds: 5 });
graphic("paycheck-receipt", "Paycheck deductions", "Gross to net, each deduction in red.", "MONEY", ["paycheck", "taxes", "deductions", "gross", "net", "fica"], "FORMULA", {
  title: "One paycheck",
  variant: "RECEIPT",
  items: [I("Gross pay", 3000), I("Federal tax", 330, { op: "MINUS" }), I("State tax", 140, { op: "MINUS" }), I("Social Security + Medicare", 230, { op: "MINUS" }), I("Net pay", 2300, { op: "EQUALS" })],
  format: { ...USD, compact: "NONE" },
}, { seconds: 6 });
graphic("latte-factor", "Small habit, yearly cost", "$6 × 5 days × 52 weeks.", "MONEY", ["coffee", "latte", "habit", "small expenses", "yearly"], "FORMULA", {
  items: [I("coffee", 6), I("days a week", 5, { op: "TIMES" }), I("weeks", 52, { op: "TIMES" }), I("a year", 1560, { op: "EQUALS" })],
  format: { ...USD, compact: "NONE" },
});

// =======================================================================================
// COMPARISONS
// =======================================================================================

graphic("versus-rent-own", "Renting vs owning", "Split screen, metric by metric.", "COMPARISONS", ["rent", "own", "house", "mortgage", "versus", "vs"], "VERSUS", {
  title: "Renting vs owning",
  series: [S("Renting", [2100, 2100, 0], { icon: "BUILDING" }), S("Owning", [2940, 60000, 4000], { icon: "HOUSE" })],
  categories: ["Monthly", "Upfront", "Repairs / yr"],
  format: { ...USD, compact: "AUTO" },
}, { seconds: 5, featured: true });
graphic("versus-roth-traditional", "Roth vs traditional", "Two cards, the same money taxed differently.", "COMPARISONS", ["roth", "traditional", "ira", "401k", "taxes", "retirement", "vs"], "VERSUS", {
  variant: "CARDS",
  title: "Roth vs traditional",
  series: [S("Roth", [k(6.5), k(0)], { icon: "LOCK" }), S("Traditional", [k(6.5), k(1.4)], { icon: "BANK" })],
  categories: ["Put in", "Tax later"],
  format: USD,
});
graphic("versus-avalanche-snowball", "Avalanche vs snowball", "Two debt payoff methods compared.", "COMPARISONS", ["debt", "avalanche", "snowball", "payoff", "method", "vs"], "VERSUS", {
  title: "Paying off $20k of debt",
  series: [S("Avalanche", [26, 3100]), S("Snowball", [27, 3600])],
  categories: ["Months", "Interest paid"],
  highlight: 0,
  format: { kind: "NUMBER" },
});
graphic("versus-lease-buy-car", "Lease vs buy a car", "Split comparison over three years.", "COMPARISONS", ["car", "lease", "buy", "auto", "vs"], "VERSUS", {
  title: "Three years with the car",
  series: [S("Lease", [450, 3000, 0], { icon: "CAR" }), S("Buy", [620, 5000, 14000], { icon: "CAR" })],
  categories: ["Monthly", "Down", "You keep"],
  format: USD,
});
graphic("versus-cash-card", "Cash vs card", "Two options, one verdict.", "COMPARISONS", ["cash", "credit card", "spending", "vs"], "VERSUS", {
  variant: "CARDS",
  series: [S("Cash", [0], { icon: "CASH" }), S("Credit card", [24], { icon: "CARD" })],
  categories: ["Interest %"],
  format: PCT,
});
graphic("three-ways-to-earn", "Three ways to earn (cards)", "Employee, freelancer, owner — one number each.", "COMPARISONS", ["income", "employee", "freelance", "business", "career", "cards"], "ENTITY_CARDS", {
  title: "Average yearly income",
  items: [I("Employee", k(48), { icon: "BRIEFCASE", sub: "Steady" }), I("Freelancer", k(50), { icon: "LAPTOP", sub: "Lumpy" }), I("Business owner", k(140), { icon: "STORE", sub: "Wild" })],
  highlight: 2,
  format: USD,
}, { featured: true });
graphic("where-cash-sits-grid", "Where cash sits (4 accounts)", "A 2×2 of account types and their rates.", "COMPARISONS", ["savings", "accounts", "interest", "bank", "cd", "hysa"], "ENTITY_CARDS", {
  variant: "GRID",
  title: "What your cash earns",
  items: [I("Checking", 0.01, { icon: "CARD" }), I("Savings", 0.45, { icon: "PIGGY" }), I("High-yield", 4.3, { icon: "BOLT" }), I("CD, 1 yr", 4.8, { icon: "LOCK" })],
  highlight: 3,
  format: { ...PCT, decimals: 2 },
}, { seconds: 5 });
graphic("podium-top-3", "Podium — top 3", "Gold, silver, bronze.", "COMPARISONS", ["best", "top 3", "ranking", "podium", "winner"], "ENTITY_CARDS", {
  variant: "PODIUM",
  title: "Best places to keep cash",
  items: [I("High-yield", 4.3, { icon: "BOLT" }), I("Treasury bills", 5.1, { icon: "BANK" }), I("Money market", 4.9, { icon: "COIN" })],
  format: { ...PCT, decimals: 1 },
}, { seconds: 5 });
graphic("rent-in-three-cities", "Rent in three cities", "Three cards with the average rent.", "COMPARISONS", ["rent", "cities", "cost of living", "moving"], "ENTITY_CARDS", {
  title: "Average 1-bed rent",
  items: [I("New York", 3900, { icon: "BUILDING" }), I("Austin", 1700, { icon: "HOUSE" }), I("Denver", 1900, { icon: "HOUSE" })],
  format: { ...USD, compact: "NONE" },
});
graphic("subscriptions-grid", "Subscriptions add up", "Six small charges on a grid.", "COMPARISONS", ["subscriptions", "monthly", "streaming", "small charges"], "ENTITY_CARDS", {
  variant: "GRID",
  title: "Monthly subscriptions",
  items: [I("Streaming", 23, { icon: "PLAY" }), I("Music", 11, { icon: "HEART" }), I("Cloud", 3, { icon: "GLOBE" }), I("Gym", 45, { icon: "HEALTH" }), I("Apps", 15, { icon: "PHONE" }), I("Delivery", 10, { icon: "FOOD" })],
  format: { ...USD, compact: "NONE" },
  animation: { order: "STAGGER", stagger: 0.1 },
}, { seconds: 5 });
graphic("before-after-net-worth", "Before / after — net worth", "Then vs now, side by side.", "COMPARISONS", ["before after", "net worth", "progress", "then now", "transformation"], "BEFORE_AFTER", {
  items: [I("Two years ago", -k(23), { sub: "Student loans + a car note" }), I("Today", k(41), { sub: "Debt free, investing" })],
  format: USD,
}, { featured: true });
graphic("before-after-budget", "Before / after — budget", "Stacked: the old way, then the new way.", "COMPARISONS", ["budget", "before after", "savings", "change"], "BEFORE_AFTER", {
  variant: "STACKED",
  title: "Saved each month",
  items: [I("No budget", 120, { icon: "ALERT" }), I("With a budget", 900, { icon: "CHECK" })],
  format: { ...USD, compact: "NONE" },
});
graphic("before-after-credit-score", "Before / after — credit score", "Score then vs now.", "COMPARISONS", ["credit score", "before after", "fico", "improve"], "BEFORE_AFTER", {
  items: [I("Last year", 580, { icon: "ALERT" }), I("Now", 742, { icon: "SHIELD" })],
  format: { kind: "NUMBER", compact: "NONE" },
});
graphic("before-after-salary", "Then vs now — salary", "First job vs today.", "COMPARISONS", ["salary", "career", "before after", "growth", "raise"], "BEFORE_AFTER", {
  items: [I("First job", k(38), { icon: "BRIEFCASE" }), I("Today", k(95), { icon: "ROCKET" })],
  format: USD,
});
classic("classic-comparison", "A vs B (classic)", "Two values side by side with a verdict.", "COMPARISONS", ["vs", "versus", "compare", "two options"], "COMPARISON", {
  left: { label: "Renting", value: "$2,100" },
  right: { label: "Owning", value: "$2,940" },
  verdict: "Monthly cost, year one",
  winner: "LEFT",
});

// =======================================================================================
// CHARTS
// =======================================================================================

graphic("bars-expenses", "Expense bars", "Categories as bars, one highlighted.", "CHARTS", ["bar chart", "expenses", "spending", "categories"], "BAR_GROUP", {
  title: "Where the money goes",
  series: [S("Monthly", [1800, 650, 520, 300, 240])],
  categories: ["Rent", "Food", "Car", "Fun", "Phone"],
  highlight: 0,
  format: USD,
}, { featured: true });
graphic("bars-two-years", "This year vs last year", "Grouped bars, two series.", "CHARTS", ["bar chart", "grouped", "year over year", "comparison"], "BAR_GROUP", {
  title: "Spending: last year vs this year",
  series: [S("Last year", [2400, 900, 600, 450]), S("This year", [1900, 650, 520, 300])],
  categories: ["Housing", "Food", "Car", "Fun"],
  format: USD,
});
graphic("bars-stacked-budget", "Stacked budget by month", "Needs, wants and savings stacked.", "CHARTS", ["stacked", "budget", "50 30 20", "needs wants savings", "monthly"], "BAR_GROUP", {
  variant: "STACKED",
  title: "Needs, wants, savings",
  series: [S("Needs", [2100, 2100, 2150, 2100]), S("Wants", [1300, 1100, 900, 800]), S("Savings", [600, 800, 950, 1100])],
  categories: ["Jan", "Feb", "Mar", "Apr"],
  format: USD,
}, { seconds: 5 });
graphic("bars-horizontal-spending", "Horizontal spending bars", "Long labels read best sideways.", "CHARTS", ["horizontal", "bar chart", "spending", "ranking"], "BAR_GROUP", {
  variant: "HORIZONTAL",
  title: "Biggest monthly costs",
  series: [S("Monthly", [1800, 650, 520, 300, 180])],
  categories: ["Housing", "Groceries", "Car payment", "Eating out", "Streaming + apps"],
  highlight: 0,
  format: USD,
});
graphic("bars-profit-quarters", "Profit by quarter (negatives)", "Bars below zero in red.", "CHARTS", ["profit", "loss", "quarters", "business", "negative"], "BAR_GROUP", {
  title: "Profit by quarter",
  series: [S("Profit", [-k(8), k(2), k(14), k(31)])],
  categories: Q,
  format: { ...USD, signs: "ALWAYS" },
});
graphic("bars-net-worth-by-age", "Net worth by age", "Bars per age bracket.", "CHARTS", ["net worth", "age", "median", "wealth", "bar chart"], "BAR_GROUP", {
  title: "Median net worth by age",
  series: [S("Median", [39000, 135000, 247000, 364000])],
  categories: ["<35", "35–44", "45–54", "55–64"],
  highlight: 0,
  format: USD,
});
graphic("line-compound-growth", "Compound growth curve", "An area curve that draws itself — slow, then steep.", "CHARTS", ["compound interest", "growth", "investing", "curve", "exponential"], "LINE_AREA", {
  variant: "AREA",
  title: "$500 a month at 7%",
  series: [S("Balance", [0, 35796, 86542, 158481, 260464, 405036, 609985])],
  categories: ["0", "5", "10", "15", "20", "25", "30 yrs"],
  format: USD,
}, { seconds: 5, featured: true });
graphic("line-invest-vs-save", "Investing vs saving", "Two lines pulling apart.", "CHARTS", ["investing", "saving", "growth", "comparison", "line chart"], "LINE_AREA", {
  title: "$300/mo for 30 years",
  series: [S("Invested", [0, 21600, 52000, 95000, 156000, 243000, 365000], { color: "PRIMARY" }), S("Savings", [0, 18500, 37500, 57000, 77000, 97500, 118500], { color: "SECONDARY" })],
  categories: ["0", "5", "10", "15", "20", "25", "30"],
  format: USD,
}, { seconds: 5 });
graphic("line-three-assets", "Stocks vs bonds vs cash", "Three series, one decade.", "CHARTS", ["stocks", "bonds", "cash", "assets", "returns"], "LINE_AREA", {
  title: "$10k over 10 years",
  series: [S("Stocks", [10, 11, 13, 12, 15, 17, 19, 18, 22, 25, 27]), S("Bonds", [10, 10.4, 10.8, 11.2, 11.6, 12, 12.4, 12.9, 13.3, 13.8, 14.3]), S("Cash", [10, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 11])],
  format: { ...USD, suffix: "k" },
}, { seconds: 5 });
graphic("line-inflation", "Purchasing power falling", "What $100 buys over time.", "CHARTS", ["inflation", "purchasing power", "cash", "decline"], "LINE_AREA", {
  title: "What $100 buys",
  series: [S("Value", [100, 97, 94, 91, 89, 86, 83, 81, 78, 76, 74], { color: "NEGATIVE" })],
  categories: ["Now", "", "", "", "", "5 yrs", "", "", "", "", "10 yrs"],
  format: USD,
});
graphic("line-debt-payoff", "Debt payoff timeline", "Balance sloping to zero.", "CHARTS", ["debt", "payoff", "timeline", "balance", "zero"], "LINE_AREA", {
  variant: "AREA",
  title: "Credit card balance",
  series: [S("Balance", [18400, 16200, 13700, 11000, 8100, 5000, 1700, 0], { color: "NEGATIVE" })],
  categories: ["Jan", "Mar", "May", "Jul", "Sep", "Nov", "Jan", "Mar"],
  format: USD,
}, { seconds: 5 });
graphic("cash-flow-rollercoaster", "Cash flow rollercoaster", "Each month up or down from zero — green ins, red outs.", "CHARTS", ["cash flow", "ups and downs", "volatility", "monthly", "business", "freelance"], "WATERFALL", {
  variant: "FLOW",
  title: "Cash flow, month by month",
  series: [S("Net", [k(5), -k(15), -k(5), k(50), k(5), 0, k(100), -k(20)])],
  categories: ["Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"],
  format: { ...USD, signs: "ALWAYS" },
  showTotal: true,
}, { seconds: 6, featured: true });
graphic("waterfall-paycheck", "Paycheck waterfall", "Gross pay stepping down to what you keep.", "CHARTS", ["waterfall", "paycheck", "taxes", "deductions", "take home"], "WATERFALL", {
  title: "Where a $5,000 paycheck goes",
  series: [S("Flow", [5000, -1150, -1800, -650, -400])],
  categories: ["Pay", "Taxes", "Rent", "Food", "Bills"],
  showTotal: true,
  format: USD,
}, { seconds: 6 });
graphic("waterfall-net-worth-year", "Net worth bridge", "Start → contributions → growth → spending → end.", "CHARTS", ["net worth", "waterfall", "bridge", "year", "growth"], "WATERFALL", {
  title: "My net worth this year",
  series: [S("Change", [k(62), k(14), k(9), -k(4)])],
  categories: ["Start", "Saved", "Growth", "Car"],
  showTotal: true,
  format: USD,
}, { seconds: 5 });
graphic("donut-50-30-20", "Budget split donut — 50/30/20", "Needs, wants, savings.", "CHARTS", ["50 30 20", "budget", "donut", "needs wants savings", "rule"], "DONUT", {
  title: "The 50/30/20 rule",
  items: [I("Needs", 50, { color: "PRIMARY" }), I("Wants", 30, { color: "SECONDARY" }), I("Savings", 20, { color: "POSITIVE" })],
  highlight: 2,
  format: PCT,
}, { featured: true });
graphic("donut-portfolio", "Portfolio mix", "Allocation as a donut.", "CHARTS", ["portfolio", "allocation", "stocks", "bonds", "diversification"], "DONUT", {
  title: "A simple portfolio",
  items: [I("US stocks", 60), I("International", 30), I("Bonds", 10)],
  format: PCT,
});
graphic("pie-spending", "Spending pie", "Where the money went, as a pie.", "CHARTS", ["pie chart", "spending", "categories", "expenses"], "DONUT", {
  variant: "PIE",
  items: [I("Housing", 1800), I("Food", 650), I("Transport", 420), I("Fun", 300), I("Other", 250)],
  format: USD,
});
graphic("half-donut-taxes", "Half donut — where taxes go", "A semicircle of shares.", "CHARTS", ["taxes", "half donut", "shares", "breakdown"], "DONUT", {
  variant: "HALF",
  title: "Each tax dollar",
  items: [I("Social Security", 22), I("Health", 25), I("Defense", 13), I("Interest", 13), I("Other", 27)],
  format: PCT,
});
graphic("donut-fixed-flexible", "Fixed vs flexible costs", "Two-slice donut.", "CHARTS", ["fixed costs", "flexible", "budget", "donut"], "DONUT", {
  items: [I("Fixed", 64, { color: "SECONDARY" }), I("Flexible", 36, { color: "PRIMARY" })],
  highlight: 1,
  format: PCT,
});
graphic("ring-savings-goal", "Savings goal ring", "One ring filling toward the goal.", "CHARTS", ["goal", "progress", "savings", "ring", "percent"], "PROGRESS", {
  title: "Emergency fund",
  items: [I("of $18k saved", 72)],
  format: PCT,
}, { featured: true });
graphic("rings-three-goals", "Three goals", "Three rings side by side.", "CHARTS", ["goals", "progress", "rings", "savings"], "PROGRESS", {
  title: "This year's goals",
  items: [I("Emergency", 100), I("Roth IRA", 64), I("House", 23)],
  format: PCT,
}, { seconds: 5 });
graphic("bars-debt-payoff-progress", "Debt payoff progress", "Progress bars for each debt.", "CHARTS", ["debt", "payoff", "progress", "bars", "loans"], "PROGRESS", {
  variant: "BARS",
  title: "Paid off so far",
  items: [I("Credit card", 100, { sub: "$4,200 — done" }), I("Car loan", 55), I("Student loan", 18)],
  format: PCT,
}, { seconds: 5 });
graphic("gauge-credit-score", "Credit score gauge", "A needle swinging to the score.", "CHARTS", ["credit score", "fico", "gauge", "dial"], "GAUGE", {
  title: "Credit score",
  items: [I("Very good", 742)],
  range: { min: 300, max: 850 },
  format: { kind: "NUMBER", compact: "NONE" },
}, { featured: true });
graphic("gauge-risk", "Risk meter", "A segmented dial from low to high.", "CHARTS", ["risk", "gauge", "meter", "volatility"], "GAUGE", {
  variant: "SEGMENTS",
  title: "Risk level",
  subtitle: "100% stocks",
  items: [I("High", 82)],
  format: { kind: "NUMBER" },
});
graphic("gauge-dti", "Debt-to-income gauge", "Ratio on a dial.", "CHARTS", ["debt to income", "dti", "ratio", "mortgage", "gauge"], "GAUGE", {
  title: "Debt-to-income",
  items: [I("Lenders want under 36%", 28)],
  format: PCT,
});
graphic("scatter-risk-return", "Risk vs return", "Assets as dots on two axes.", "CHARTS", ["risk", "return", "scatter", "assets", "investing"], "SCATTER", {
  title: "Risk vs return",
  series: [S("Cash", [1, 2]), S("Bonds", [4, 4]), S("Index funds", [15, 10]), S("Single stocks", [30, 12]), S("Crypto", [70, 15])],
  categories: ["Risk", "Return %"],
  highlight: 2,
}, { seconds: 5 });
graphic("bubbles-side-hustles", "Side hustles — effort vs pay", "Bubbles sized by hours.", "CHARTS", ["side hustle", "effort", "pay", "bubbles", "scatter"], "SCATTER", {
  variant: "BUBBLES",
  title: "Effort vs pay",
  series: [S("Tutoring", [3, 40, 6]), S("Delivery", [2, 18, 10]), S("Freelance design", [7, 60, 8]), S("Reselling", [5, 25, 5])],
  categories: ["Skill needed", "$/hour"],
});
classic("classic-counter", "Number counter (classic)", "One number counting up with a label.", "MONEY", ["counter", "number", "count up", "classic", "big number"], "NUMBER_COUNTER", { value: 1247, from: 0, prefix: "$", suffix: "", decimals: 0, label: "Saved per month" });
classic("classic-stat-card", "Stat card (classic)", "A glass card with one big value and context.", "MONEY", ["stat", "card", "classic", "number"], "STAT_CARD", { value: "7.2%", label: "Average market return", sublabel: "S&P 500, inflation-adjusted", trend: "UP" });
classic("classic-bar-chart", "Bar chart (classic)", "2–6 bars with a highlight.", "CHARTS", ["bar chart", "classic", "compare"], "BAR_CHART", {
  title: "Where the money goes",
  bars: [{ label: "Rent", value: 1800 }, { label: "Food", value: 650 }, { label: "Car", value: 520 }, { label: "Fun", value: 300 }],
  unit: "$",
  highlightIndex: 0,
  depth3d: false,
});
classic("classic-bar-chart-3d", "3D bar chart", "Extruded 3D bars.", "OBJECTS_3D", ["3d", "bar chart", "bars"], "BAR_CHART", {
  title: "Returns by decade",
  bars: [{ label: "80s", value: 17 }, { label: "90s", value: 18 }, { label: "00s", value: 1 }, { label: "10s", value: 14 }],
  unit: "%",
  highlightIndex: 1,
  depth3d: true,
});
classic("classic-line-chart", "Line chart (classic)", "One curve with the last point called out.", "CHARTS", ["line chart", "classic", "growth"], "LINE_CHART", {
  title: "$500/mo invested at 7%",
  points: [{ label: "Y0", value: 0 }, { label: "Y10", value: 86542 }, { label: "Y20", value: 260464 }, { label: "Y30", value: 609985 }],
  unit: "$",
  highlightLast: true,
});
classic("classic-percent-ring", "Percent ring (classic)", "A single percentage.", "CHARTS", ["percent", "ring", "share", "classic"], "PERCENT_RING", { percent: 68, label: "of Americans live paycheck to paycheck" });

// =======================================================================================
// TIMELINES & STEPS
// =======================================================================================

graphic("steps-debt-plan", "Debt payoff plan", "Vertical steps that light up in order.", "TIMELINES", ["steps", "debt", "plan", "how to", "payoff"], "STEPS", {
  title: "The payoff plan",
  items: [I("List every debt", null, { sub: "Balance, rate, minimum" }), I("Pay minimums on all", null), I("Attack the highest rate", null, { sub: "Avalanche" }), I("Roll the payment forward", null)],
  animation: ONE,
}, { seconds: 6, featured: true });
graphic("steps-retirement-roadmap", "Retirement roadmap", "Horizontal milestones by age.", "TIMELINES", ["retirement", "roadmap", "age", "milestones", "timeline"], "STEPS", {
  variant: "HORIZONTAL",
  title: "Retirement roadmap",
  items: [I("Age 25", null, { sub: "Start" }), I("Age 35", null, { sub: "$100k" }), I("Age 45", null, { sub: "$350k" }), I("Age 65", null, { sub: "$1.2M" })],
}, { seconds: 5 });
graphic("roadmap-first-100k", "Road to the first $100k", "A winding roadmap of milestones.", "TIMELINES", ["100k", "milestones", "roadmap", "net worth", "journey"], "STEPS", {
  variant: "ROADMAP",
  title: "Road to $100k",
  items: [I("$1k", null, { sub: "Emergency starter" }), I("$10k", null, { sub: "Debt gone" }), I("$50k", null, { sub: "Investing on autopilot" }), I("$100k", null, { sub: "Compounding kicks in", icon: "TROPHY" })],
}, { seconds: 6 });
graphic("steps-start-investing", "How to start investing", "Steps with icons.", "TIMELINES", ["investing", "how to", "beginner", "steps", "start"], "STEPS", {
  title: "Start investing in 4 steps",
  items: [I("Open a brokerage account", null, { icon: "PHONE" }), I("Set up auto-deposit", null, { icon: "CALENDAR" }), I("Buy a total-market fund", null, { icon: "PIE" }), I("Leave it alone", null, { icon: "LOCK" })],
}, { seconds: 6 });
graphic("steps-pay-yourself-first", "Pay yourself first", "Three steps, horizontal.", "TIMELINES", ["pay yourself first", "savings", "automation", "steps"], "STEPS", {
  variant: "HORIZONTAL",
  items: [I("Payday", null, { icon: "CASH" }), I("Save first", null, { icon: "PIGGY" }), I("Spend the rest", null, { icon: "CART" })],
});
graphic("steps-credit-repair", "Fix your credit", "Four steps to a better score.", "TIMELINES", ["credit score", "repair", "steps", "improve"], "STEPS", {
  title: "Fix your credit",
  items: [I("Pull your free reports", null), I("Dispute the errors", null), I("Pay on time, every time", null), I("Keep usage under 30%", null)],
}, { seconds: 6 });
graphic("timeline-buying-house", "Buying a house timeline", "From pre-approval to keys.", "TIMELINES", ["house", "buying", "mortgage", "timeline", "steps"], "STEPS", {
  variant: "ROADMAP",
  title: "Buying a house",
  items: [I("Month 1", null, { sub: "Pre-approval" }), I("Month 2", null, { sub: "House hunting" }), I("Month 3", null, { sub: "Offer + inspection" }), I("Month 4", null, { sub: "Closing — keys!", icon: "KEY" })],
}, { seconds: 6 });
graphic("timeline-six-month-plan", "The 6-month plan", "Horizontal months with goals.", "TIMELINES", ["plan", "months", "goals", "timeline"], "STEPS", {
  variant: "HORIZONTAL",
  title: "Six months",
  items: [I("Month 1", null, { sub: "Budget" }), I("Month 2", null, { sub: "$1k fund" }), I("Month 4", null, { sub: "Card paid" }), I("Month 6", null, { sub: "Investing" })],
});
classic("classic-timeline", "Milestones (classic)", "A vertical milestone list.", "TIMELINES", ["timeline", "milestones", "classic", "age"], "TIMELINE", {
  events: [{ label: "Age 25", sub: "Start investing $300/mo" }, { label: "Age 35", sub: "Portfolio passes $50k" }, { label: "Age 45", sub: "Compounding takes over" }, { label: "Age 65", sub: "Retire with $790k" }],
});
classic("classic-list-steps", "Numbered steps (classic)", "2–5 steps.", "TIMELINES", ["steps", "list", "classic", "numbered"], "LIST_STEPS", {
  title: "Build your safety net",
  items: ["Save one month of expenses", "Kill high-interest debt", "Grow to six months", "Automate it"],
  style: "NUMBERED",
});

// =======================================================================================
// LISTS & TABLES
// =======================================================================================

graphic("checklist-dos", "Checklist — do this", "Ticks drawing in, one by one.", "LISTS", ["checklist", "do", "tips", "list", "checks"], "CHECKLIST", {
  title: "Before you invest",
  items: [I("Emergency fund", null, { state: "DONE" }), I("No credit card debt", null, { state: "DONE" }), I("Employer match", null, { state: "DONE" }), I("Then index funds", null, { state: "TODO" })],
}, { seconds: 5, featured: true });
graphic("checklist-donts", "Don'ts", "Crosses for what to avoid.", "LISTS", ["don't", "avoid", "mistakes", "list", "warning"], "CHECKLIST", {
  title: "Money mistakes",
  items: [I("Paying only the minimum", null, { state: "NO" }), I("Leasing a new car every 3 years", null, { state: "NO" }), I("Keeping savings at 0.01%", null, { state: "NO" })],
});
graphic("checklist-do-dont", "Do vs don't", "Mixed ticks and crosses.", "LISTS", ["do dont", "checklist", "rules", "compare"], "CHECKLIST", {
  items: [I("Automate savings", null, { state: "DONE" }), I("Pay yourself first", null, { state: "DONE" }), I("Lifestyle creep", null, { state: "NO" }), I("Timing the market", null, { state: "NO" })],
});
graphic("list-three-rules", "Three rules", "A numbered list with sub-lines.", "LISTS", ["rules", "numbered", "list", "tips"], "CHECKLIST", {
  variant: "NUMBERED",
  title: "Three money rules",
  items: [I("Spend less than you earn", null, { sub: "Always" }), I("Invest the difference", null, { sub: "Automatically" }), I("Don't touch it", null, { sub: "For decades" })],
}, { seconds: 5 });
graphic("bullets-key-points", "Key points", "Clean bullets.", "LISTS", ["bullets", "points", "summary", "list"], "CHECKLIST", {
  variant: "BULLETS",
  items: [I("Index funds beat most pros", null), I("Fees compound too", null), I("Time in the market wins", null)],
});
graphic("ranking-savings-accounts", "Leaderboard — savings rates", "Ranked rows with bars.", "LISTS", ["ranking", "leaderboard", "best", "rates", "top"], "RANKING", {
  title: "Best rates this week",
  items: [I("Bank A", 4.6), I("Bank B", 4.4), I("Bank C", 4.25), I("Bank D", 4.1), I("Big bank", 0.01)],
  highlight: 0,
  format: { ...PCT, decimals: 2 },
}, { seconds: 5, featured: true });
graphic("ranking-biggest-expenses", "Biggest expenses ranked", "Leaderboard of costs.", "LISTS", ["ranking", "expenses", "biggest", "costs"], "RANKING", {
  title: "Biggest lifetime costs",
  items: [I("House", 410000, { icon: "HOUSE" }), I("Cars", 230000, { icon: "CAR" }), I("Kids", 310000, { icon: "BABY" }), I("Taxes", 520000, { icon: "RECEIPT" })],
  format: USD,
}, { seconds: 5 });
graphic("medals-index-funds", "Top 3 with medals", "Gold, silver, bronze rows.", "LISTS", ["top 3", "medals", "ranking", "best"], "RANKING", {
  variant: "MEDALS",
  title: "Lowest fees",
  items: [I("Total market fund", 0.03), I("S&P 500 fund", 0.04), I("Target date", 0.12)],
  format: { ...PCT, decimals: 2 },
});
graphic("table-accounts", "Account comparison table", "Rows × columns of numbers and words.", "LISTS", ["table", "accounts", "compare", "rows", "columns"], "TABLE", {
  title: "Retirement accounts",
  series: [S("401(k)", [23000, 0], { texts: ["$23,000", "Pre-tax"] }), S("Roth IRA", [7000, 0], { texts: ["$7,000", "After-tax"] }), S("HSA", [4150, 0], { texts: ["$4,150", "Triple"] })],
  categories: ["Limit", "Tax"],
  highlight: 1,
}, { seconds: 5 });
graphic("table-tax-brackets", "Tax brackets table", "Rate by income band.", "LISTS", ["taxes", "brackets", "table", "income tax"], "TABLE", {
  variant: "ZEBRA",
  title: "Single filer brackets",
  series: [S("10%", [11600], { texts: ["$0–11.6k"] }), S("12%", [47150], { texts: ["to $47k"] }), S("22%", [100525], { texts: ["to $101k"] }), S("24%", [191950], { texts: ["to $192k"] })],
  categories: ["Income"],
});
graphic("table-monthly-budget", "Monthly budget table", "Category, planned, actual.", "LISTS", ["budget", "table", "planned", "actual", "monthly"], "TABLE", {
  variant: "ZEBRA",
  title: "Budget vs actual",
  series: [S("Rent", [1800, 1800]), S("Food", [500, 640]), S("Fun", [250, 310]), S("Savings", [900, 900])],
  categories: ["Plan", "Actual"],
  format: USD,
}, { seconds: 5 });
graphic("table-loan-compare", "Loan comparison", "Rate, term and total cost.", "LISTS", ["loan", "mortgage", "compare", "table", "interest"], "TABLE", {
  title: "15 vs 30 year mortgage",
  series: [S("15-year", [5.6, 2470, 145000]), S("30-year", [6.2, 1840, 362000])],
  categories: ["Rate %", "Monthly", "Interest"],
  highlight: 0,
}, { seconds: 5 });

// =======================================================================================
// TEXT & TITLES
// =======================================================================================

graphic("kinetic-stack", "Stacked statement", "Big words stacking line by line.", "TEXT", ["kinetic", "text", "statement", "stack", "title"], "KINETIC", {
  body: "Pay yourself first",
  animation: { stagger: 0.12 },
}, { featured: true });
graphic("kinetic-highlighter", "Highlighter sweep", "A marker sweeps behind the key words.", "TEXT", ["highlight", "marker", "emphasis", "kinetic"], "KINETIC", {
  variant: "HIGHLIGHT",
  title: "wealthy",
  body: "Rich is a salary. Wealthy is time.",
});
graphic("kinetic-strike-replace", "Strike → replace", "Cross out a word, write the better one.", "TEXT", ["strike", "replace", "reframe", "mindset", "kinetic"], "KINETIC", {
  variant: "STRIKE",
  title: "investment",
  body: "It's not a cost, it's an",
});
graphic("kinetic-outline", "Outline type", "Outlined words that fill in.", "TEXT", ["outline", "type", "kinetic", "bold"], "KINETIC", {
  variant: "OUTLINE",
  body: "Stop guessing.",
});
graphic("kinetic-question", "The big question", "A question that lands.", "TEXT", ["question", "hook", "kinetic", "text"], "KINETIC", {
  body: "Where does your money actually go?",
});
graphic("quote-card", "Quote card", "A quote on glass with a big mark.", "TEXT", ["quote", "card", "saying"], "QUOTE", {
  body: "Do not save what is left after spending. Spend what is left after saving.",
  title: "A rule worth stealing",
}, { seconds: 5, featured: true });
graphic("note-rule-of-thumb", "Rule of thumb", "A note card with a heading.", "TEXT", ["rule of thumb", "note", "tip", "callout"], "QUOTE", {
  variant: "NOTE",
  title: "Rule of thumb",
  body: "Rent should be under 30% of your take-home pay.",
});
graphic("bubble-wait-what", "Speech bubble", "A comic-clean speech bubble.", "TEXT", ["speech bubble", "reaction", "callout", "comment"], "QUOTE", {
  variant: "BUBBLE",
  body: "Wait — that's $1,560 a year?",
});
graphic("lower-third-name", "Lower third — name", "Name + role bar.", "TEXT", ["lower third", "name", "intro", "title bar"], "LOWER_THIRD", {
  title: "Chris",
  subtitle: "Money, made simple",
}, { featured: true, placement: { mode: "AUTO" } });
graphic("lower-third-tag", "Lower third — topic tag", "A pill tag for the topic.", "TEXT", ["tag", "topic", "lower third", "label"], "LOWER_THIRD", {
  variant: "TAG",
  title: "Part 2",
  subtitle: "The debt payoff plan",
});
graphic("lower-third-minimal", "Lower third — minimal", "A thin rule and two lines.", "TEXT", ["lower third", "minimal", "clean", "source"], "LOWER_THIRD", {
  variant: "MINIMAL",
  title: "Source",
  subtitle: "Federal Reserve, 2023",
});
classic("classic-kinetic", "Kinetic punch (classic)", "Words punch in, key words hit harder.", "TEXT", ["kinetic", "punch", "classic", "words"], "KINETIC_TEXT", { text: "Your savings rate matters more than your salary", emphasis: ["savings", "rate"], style: "PUNCH" });
classic("classic-typewriter", "Typewriter (classic)", "Letters type out.", "TEXT", ["typewriter", "type", "classic"], "KINETIC_TEXT", { text: "The part nobody tells you", emphasis: ["nobody"], style: "TYPEWRITER" });
classic("classic-title-card", "Title card", "Cinematic full-frame chapter title.", "TEXT", ["title", "chapter", "cinematic", "intro"], "TITLE_CARD", { title: "The 50/30/20 Rule", subtitle: "Chapter two" });
classic("classic-definition", "Definition", "A term and what it means.", "TEXT", ["definition", "term", "meaning", "explain", "glossary"], "DEFINITION", { term: "Expense ratio", definition: "The yearly fee a fund charges, as a percent of what you have invested in it." });

// =======================================================================================
// CALLOUTS & ANNOTATIONS
// =======================================================================================

graphic("annotate-circle", "Circle it", "A hand-drawn circle around something on screen.", "CALLOUTS", ["circle", "annotation", "highlight", "point"], "ANNOTATION", { title: "This one" }, { featured: true, placement: { mode: "MANUAL", x: 0.5, y: 0.62, scale: 1 }, enterSfx: "SOFT_POP" });
graphic("annotate-arrow", "Arrow pointer", "A curved arrow with a label.", "CALLOUTS", ["arrow", "point", "annotation", "look"], "ANNOTATION", { variant: "ARROW", title: "Look here" }, { placement: { mode: "MANUAL", x: 0.62, y: 0.6, scale: 1 }, enterSfx: "SOFT_POP" });
graphic("annotate-underline", "Underline", "A swoosh underline under a word.", "CALLOUTS", ["underline", "annotation", "emphasis"], "ANNOTATION", { variant: "UNDERLINE", title: null }, { placement: { mode: "MANUAL", x: 0.5, y: 0.66, scale: 1 }, enterSfx: null });
graphic("annotate-box", "Focus box", "Corner brackets framing something.", "CALLOUTS", ["box", "frame", "focus", "brackets", "annotation"], "ANNOTATION", { variant: "BOX", title: "The fee" }, { placement: { mode: "MANUAL", x: 0.5, y: 0.6, scale: 1 }, enterSfx: "CLICK" });
graphic("sticker-new", "Sticker — NEW", "A badge that pops in.", "CALLOUTS", ["sticker", "badge", "new", "pop"], "STICKER", { title: "NEW", items: [I("", null, { icon: "SPARKLE" })] }, { enterSfx: "SOFT_POP", featured: true });
graphic("stamp-paid-off", "Stamp — PAID OFF", "A rubber-stamp slam.", "CALLOUTS", ["stamp", "paid off", "debt free", "done"], "STICKER", { variant: "STAMP", title: "PAID OFF" }, { enterSfx: "IMPACT" });
graphic("bubble-percent-off", "Price bubble — −50%", "A round price bubble.", "CALLOUTS", ["sale", "discount", "percent", "bubble", "price"], "STICKER", { variant: "BUBBLE", title: "off", items: [I("", -50)], format: PCT }, { enterSfx: "SOFT_POP" });
graphic("sticker-hot-tip", "Sticker — hot tip", "Fire icon badge.", "CALLOUTS", ["tip", "hot", "fire", "sticker"], "STICKER", { title: "HOT TIP", items: [I("", null, { icon: "FIRE" })] }, { enterSfx: "SOFT_POP" });
graphic("sticker-warning", "Sticker — warning", "Alert badge.", "CALLOUTS", ["warning", "alert", "careful", "sticker"], "STICKER", { title: "CAREFUL", items: [I("", null, { icon: "ALERT", color: "NEGATIVE" })] }, { enterSfx: "SOFT_POP" });
graphic("map-rent-cities", "Map pins — rent by city", "Pins drop on a minimal map.", "CALLOUTS", ["map", "cities", "rent", "location", "pins"], "MAP_PIN", {
  title: "Rent around the country",
  items: [I("Seattle", 2400), I("Denver", 1900), I("Austin", 1700), I("New York", 3900)],
  highlight: 3,
  format: { ...USD, compact: "NONE" },
}, { seconds: 5, featured: true });
graphic("map-moving-route", "Route — moving", "A route between two places.", "CALLOUTS", ["moving", "route", "relocate", "map"], "MAP_PIN", {
  variant: "ROUTE",
  title: "Moving saved me",
  items: [I("San Francisco", 3400, { sub: "rent" }), I("Raleigh", 1500, { sub: "rent" })],
  format: { ...USD, compact: "NONE" },
});
graphic("icon-burst-money", "Money burst", "Money icons bursting around a word.", "CALLOUTS", ["burst", "icons", "money", "celebration"], "ICON_BURST", { title: "Payday", items: [I("", null, { icon: "COIN" }), I("", null, { icon: "CASH" }), I("", null, { icon: "SPARKLE" }), I("", null, { icon: "CHART_UP" }), I("", null, { icon: "WALLET" }), I("", null, { icon: "PIGGY" })] }, { enterSfx: "CASH" });
graphic("icon-row-subscriptions", "Icon row", "A row of icons popping in.", "CALLOUTS", ["icons", "row", "categories", "list"], "ICON_BURST", { variant: "ROW", title: "Every little charge", items: [I("", null, { icon: "PLAY" }), I("", null, { icon: "PHONE" }), I("", null, { icon: "COFFEE" }), I("", null, { icon: "CART" }), I("", null, { icon: "HEALTH" })] }, { enterSfx: "SOFT_POP" });
graphic("icon-orbit-income-streams", "Income streams orbit", "Icons orbiting a centre word.", "CALLOUTS", ["income streams", "orbit", "multiple", "diversify"], "ICON_BURST", { variant: "ORBIT", title: "7 streams", items: [I("", null, { icon: "BRIEFCASE" }), I("", null, { icon: "HOUSE" }), I("", null, { icon: "CHART_UP" }), I("", null, { icon: "LAPTOP" }), I("", null, { icon: "STORE" }), I("", null, { icon: "COIN" }), I("", null, { icon: "PLAY" })] }, { seconds: 5 });
classic("classic-callout", "Callout arrow (classic)", "Label + leader line to a point.", "CALLOUTS", ["callout", "arrow", "label", "point", "classic"], "CALLOUT", { text: "This is the fee", pointTo: { x: 0.7, y: 0.62 } });

// =======================================================================================
// 3D OBJECTS (classic three.js templates)
// =======================================================================================

const ICONS_3D: Array<[string, string, string, string[]]> = [
  ["COIN", "Gold coin", "Compound interest", ["coin", "money", "gold", "interest"]],
  ["CREDIT_CARD", "Credit card", "Swipe less", ["credit card", "card", "debt", "spending"]],
  ["HOUSE", "House", "Your first home", ["house", "home", "mortgage", "real estate"]],
  ["PIGGY_BANK", "Piggy bank", "Saving", ["piggy bank", "savings", "save"]],
  ["CHART_UP", "Chart going up", "Growth", ["growth", "chart", "stocks", "up"]],
  ["CALENDAR", "Calendar", "Every month", ["calendar", "monthly", "date", "schedule"]],
  ["LOCK", "Lock", "Locked in", ["lock", "secure", "safe", "retirement"]],
  ["PHONE", "Phone", "On your phone", ["phone", "app", "mobile"]],
  ["BRIEFCASE", "Briefcase", "Your job", ["briefcase", "job", "work", "career"]],
  ["GRADUATION_CAP", "Graduation cap", "Student loans", ["graduation", "student loans", "college", "education"]],
];
for (const [icon, name, caption, tags] of ICONS_3D) {
  classic(`3d-${icon.toLowerCase().replace(/_/g, "-")}`, `3D ${name.toLowerCase()}`, `A modeled ${name.toLowerCase()} that spins in.`, "OBJECTS_3D", ["3d", "object", ...tags], "ICON_3D", { icon, caption }, { featured: icon === "COIN" });
}
classic("3d-money-stack-small", "3D cash — small stack", "Bills stacking up to an amount.", "OBJECTS_3D", ["3d", "cash", "money stack", "bills"], "MONEY_STACK_3D", { amount: 1000, label: "Starter emergency fund" });
classic("3d-money-stack", "3D cash stacks", "Stacks growing to represent the amount.", "OBJECTS_3D", ["3d", "cash", "money stack", "bills", "savings"], "MONEY_STACK_3D", { amount: 25000, label: "Emergency fund goal" }, { featured: true });
classic("3d-money-stack-big", "3D cash — a fortune", "A wall of stacks for big numbers.", "OBJECTS_3D", ["3d", "cash", "million", "money stack"], "MONEY_STACK_3D", { amount: 1000000, label: "Your first million" });

// =======================================================================================
// TRANSITIONS & EMPHASIS
// =======================================================================================

graphic("transition-wipe", "Wipe transition", "A full-screen colour wipe with a word.", "EMPHASIS", ["transition", "wipe", "chapter", "section"], "TRANSITION", { title: "Part two" }, { seconds: 1.6, enterSfx: "WHOOSH", featured: true });
graphic("transition-iris", "Iris reveal", "A circle opens on the next scene.", "EMPHASIS", ["transition", "iris", "circle", "reveal"], "TRANSITION", { variant: "IRIS", title: null }, { seconds: 1.4, enterSfx: "SWOOSH_UP" });
graphic("transition-word-slam", "Word slam", "One huge word slams full screen.", "EMPHASIS", ["slam", "word", "emphasis", "impact", "stop"], "TRANSITION", { variant: "SLAM", title: "STOP." }, { seconds: 1.4, enterSfx: "IMPACT" });
graphic("transition-flash", "Flash cut", "A bright flash to punctuate a cut.", "EMPHASIS", ["flash", "cut", "transition", "punch"], "TRANSITION", { variant: "FLASH", title: null }, { seconds: 0.8, enterSfx: "CLICK" });
graphic("emphasis-big-word", "Emphasis word", "One stacked word, centre screen.", "EMPHASIS", ["emphasis", "word", "punch", "kinetic"], "KINETIC", { body: "Every. Single. Month." }, { seconds: 2.4 });
graphic("emphasis-number-pop", "Number pop", "A number pops with a ring.", "EMPHASIS", ["number", "pop", "emphasis", "ring"], "BIG_NUMBER", { items: [I("", 30)], format: PCT, animation: { emphasis: "RING" } }, { seconds: 2.4 });

// =======================================================================================
// SOCIAL & CTA
// =======================================================================================

graphic("cta-follow", "Follow for part 2", "A follow prompt with a bell.", "SOCIAL", ["follow", "subscribe", "cta", "part 2"], "CTA", { title: "Follow for part 2", subtitle: "New one tomorrow" }, { featured: true, enterSfx: "SOFT_POP" });
graphic("cta-save", "Save this", "A save prompt with a bookmark.", "SOCIAL", ["save", "bookmark", "cta", "later"], "CTA", { variant: "SAVE", title: "Save this for later", subtitle: "You'll want it at tax time" }, { enterSfx: "SOFT_POP" });
graphic("cta-comment", "Comment keyword", "Ask for a comment word.", "SOCIAL", ["comment", "keyword", "cta", "engagement"], "CTA", { variant: "COMMENT", title: "Comment “BUDGET”", subtitle: "I'll send you the template" }, { enterSfx: "SOFT_POP" });
graphic("cta-share", "Send to a friend", "A share prompt.", "SOCIAL", ["share", "send", "friend", "cta"], "CTA", { variant: "SHARE", title: "Send this to a friend", subtitle: "who needs a budget" }, { enterSfx: "SOFT_POP" });
graphic("sticker-part-2", "Sticker — Part 2", "A badge teasing the next part.", "SOCIAL", ["part 2", "series", "sticker", "next"], "STICKER", { variant: "BADGE", title: "PART 2", items: [I("", null, { icon: "PLAY" })] }, { enterSfx: "SOFT_POP" });
graphic("lower-third-handle", "Handle tag", "Your handle as a tag.", "SOCIAL", ["handle", "username", "tag", "follow"], "LOWER_THIRD", { variant: "TAG", title: "@chris", subtitle: "Follow for money tips" }, { enterSfx: null });

// More money/compare variety -------------------------------------------------------------

graphic("hourly-vs-salary-columns", "Hourly vs salary — a month", "Two columns, four weeks each.", "COMPARISONS", ["hourly", "salary", "weekly", "income", "comparison"], "VALUE_COLUMNS", {
  title: "One month of pay",
  series: [S("Hourly", [820, 1100, 640, 980], { icon: "CLOCK" }), S("Salary", [900, 900, 900, 900], { icon: "BRIEFCASE" })],
  categories: ["Wk 1", "Wk 2", "Wk 3", "Wk 4"],
  showTotal: true,
  format: USD,
  animation: BY_GROUP,
}, { seconds: 6 });
graphic("four-jobs-columns", "Four careers, five years", "Four columns of yearly income.", "COMPARISONS", ["career", "jobs", "income", "years", "comparison"], "VALUE_COLUMNS", {
  title: "Income in the first five years",
  series: [S("Teacher", [k(45), k(47), k(49), k(51), k(53)]), S("Nurse", [k(68), k(71), k(74), k(77), k(80)]), S("Engineer", [k(85), k(92), k(101), k(110), k(118)]), S("Founder", [0, k(12), k(40), k(95), k(160)])],
  categories: ["Y1", "Y2", "Y3", "Y4", "Y5"],
  format: USD,
  animation: BY_GROUP,
}, { seconds: 7 });
graphic("weekly-spend-strip", "Weekly spending strip", "Seven days as cells.", "MONEY", ["weekly", "daily", "spending", "week"], "MONTH_GRID", {
  title: "One week of spending",
  series: [S("Spent", [12, 48, 6, 23, 85, 140, 30])],
  categories: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  highlight: 5,
  format: { ...USD, compact: "NONE" },
  animation: { emphasis: "PULSE" },
});
graphic("quarterly-tiles", "Quarter by quarter", "Four tiles in a row.", "MONEY", ["quarterly", "tiles", "business", "revenue"], "STAT_TILES", {
  title: "Revenue by quarter",
  items: [I("Q1", k(12)), I("Q2", k(18)), I("Q3", k(25)), I("Q4", k(41))],
  highlight: 3,
  format: USD,
}, { seconds: 5 });
graphic("tiles-negative-months", "Good month, bad month", "Two tiles, one in the red.", "MONEY", ["good bad", "profit", "loss", "negative", "volatility"], "STAT_TILES", {
  items: [I("Best month", k(100), { icon: "ARROW_UP", color: "POSITIVE" }), I("Worst month", -k(15), { icon: "ARROW_DOWN", color: "NEGATIVE" })],
  format: { ...USD, signs: "ALWAYS" },
});
graphic("formula-rule-of-72", "Rule of 72", "72 ÷ rate = years to double.", "MONEY", ["rule of 72", "double", "compound", "formula"], "FORMULA", {
  items: [I("rule", 72), I("% return", 8, { op: "DIVIDE" }), I("years to double", 9, { op: "EQUALS" })],
  format: { kind: "NUMBER" },
});
graphic("formula-employer-match", "Employer match = free money", "Your 5% + their 5%.", "MONEY", ["401k", "match", "employer", "free money", "formula"], "FORMULA", {
  items: [I("you put in", 3500), I("they match", 3500, { op: "PLUS" }), I("a year", 7000, { op: "EQUALS" })],
  format: { ...USD, compact: "NONE" },
});
graphic("bars-grouped-negative-years", "Market years up and down", "Annual returns, red for losses.", "CHARTS", ["returns", "market", "years", "negative", "stocks"], "BAR_GROUP", {
  title: "S&P 500 by year",
  series: [S("Return", [18, -18, 26, 25, 12])],
  categories: ["2020", "2022", "2023", "2024", "2025"],
  format: { ...PCT, signs: "ALWAYS" },
});
graphic("progress-house-down-payment", "House down payment progress", "One bar filling toward the goal.", "CHARTS", ["down payment", "house", "progress", "goal"], "PROGRESS", {
  variant: "BARS",
  title: "Down payment",
  items: [I("$38k of $60k", 63)],
  format: PCT,
});
graphic("steps-paycheck-routine", "Payday routine", "What happens the day you get paid.", "TIMELINES", ["payday", "routine", "steps", "automation"], "STEPS", {
  title: "Every payday",
  items: [I("10% to investing", null, { icon: "CHART_UP" }), I("10% to savings", null, { icon: "PIGGY" }), I("Bills on autopay", null, { icon: "CALENDAR" }), I("The rest is guilt-free", null, { icon: "HEART" })],
}, { seconds: 6 });
graphic("checklist-tax-season", "Tax season checklist", "What to gather.", "LISTS", ["taxes", "checklist", "documents", "tax season"], "CHECKLIST", {
  title: "Gather these",
  items: [I("W-2s and 1099s", null, { state: "DONE" }), I("Receipts for deductions", null, { state: "TODO" }), I("Last year's return", null, { state: "TODO" })],
});
graphic("quote-note-reminder", "Reminder note", "A short note card.", "TEXT", ["reminder", "note", "tip"], "QUOTE", { variant: "NOTE", title: "Reminder", body: "Raise your 401(k) by 1% every time you get a raise." });
graphic("versus-index-vs-picking", "Index funds vs stock picking", "Split comparison.", "COMPARISONS", ["index funds", "stock picking", "active", "passive", "vs"], "VERSUS", {
  title: "Over 15 years",
  series: [S("Index funds", [0.03, 88], { icon: "PIE" }), S("Stock picking", [1, 12], { icon: "TARGET" })],
  categories: ["Fee %", "% that win"],
  highlight: 0,
});
graphic("donut-where-time-goes", "Where your paycheck goes (donut)", "Paycheck slices.", "CHARTS", ["paycheck", "donut", "breakdown", "budget"], "DONUT", {
  title: "A $4,000 paycheck",
  items: [I("Housing", 1400), I("Taxes", 900), I("Food", 600), I("Savings", 600), I("Everything else", 500)],
  format: USD,
});
graphic("ranking-states-tax", "No-income-tax states", "Leaderboard of states.", "LISTS", ["states", "income tax", "ranking", "taxes", "moving"], "RANKING", {
  variant: "MEDALS",
  title: "No state income tax",
  items: [I("Texas", null, { icon: "PIN" }), I("Florida", null, { icon: "PIN" }), I("Washington", null, { icon: "PIN" }), I("Nevada", null, { icon: "PIN" })],
});
graphic("gauge-savings-rate", "Savings rate gauge", "Percent saved on a dial.", "CHARTS", ["savings rate", "percent", "gauge"], "GAUGE", {
  title: "Savings rate",
  items: [I("Aim for 20%+", 23)],
  format: PCT,
});
graphic("big-number-percent", "Big percent", "One big percentage.", "MONEY", ["percent", "big number", "stat"], "BIG_NUMBER", { items: [I("of millionaires are first-generation", 79)], format: PCT });
graphic("from-to-rent", "Rent then → now", "Old rent to new rent.", "MONEY", ["rent", "increase", "before after", "housing"], "BIG_NUMBER", { variant: "FROM_TO", title: "My rent", items: [I("2019", 1400), I("2025", 2150)], format: { ...USD, compact: "NONE" } });
graphic("month-grid-savings-streak", "Savings streak", "12 months of saving the same amount.", "MONEY", ["streak", "savings", "consistency", "monthly", "habit"], "MONTH_GRID", {
  title: "12 months in a row",
  series: [S("Saved", Array(12).fill(500))],
  categories: MONTHS,
  showTotal: true,
  format: { ...USD, compact: "NONE" },
  animation: { order: "STAGGER", stagger: 0.07, enter: "POP" },
}, { seconds: 6 });

// =======================================================================================
// LIBRARY 2 (2026-10-18): platform-style UI, phone & apps, search & web, news & media,
// hooks & quizzes, reactions & FX, life & places, more 3D objects — appended after the
// original library so its order (and every saved preset id) is unchanged.
// =======================================================================================

all.push(...SOCIAL_PRESETS, ...PHONE_PRESETS, ...WEB_PRESETS, ...LIFE_PRESETS, ...FX_PRESETS, ...OBJECTS_PRESETS, ...SIGNATURE_PRESETS, ...FX2_PRESETS);

export const GRAPHIC_PRESETS: readonly GraphicPreset[] = all;

export const GRAPHIC_PRESET_BY_ID: ReadonlyMap<string, GraphicPreset> = new Map(all.map((p) => [p.id, p]));

export function presetById(id: string | null | undefined): GraphicPreset | null {
  return id ? (GRAPHIC_PRESET_BY_ID.get(id) ?? null) : null;
}

/** The base component a preset is built on ("VALUE_COLUMNS", or a classic template id). */
export function presetBase(p: GraphicPreset): string {
  return p.template === "GRAPHIC" ? String(p.props.component) : p.template;
}

/** Fresh, deep-copied props for inserting a preset (callers may mutate). */
export function presetProps(p: GraphicPreset): Record<string, unknown> {
  return structuredClone(p.props);
}

export { MONTHS as GRAPHIC_MONTHS };
void order;
