import { GRAPHIC_COMPONENT_SPECS, GraphicPropsSchema, type GraphicComponent, type GraphicItem, type GraphicProps, type GraphicSeries } from "./contract";
import { GRAPHIC_PRESETS, presetById, type GraphicPreset } from "./presets";

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
  /** What to call it in the editor when a topic-named preset is used generically ("Big number"
   * rather than "Big number — salary" for a rent figure). */
  name?: string;
}

function graphicFrom(presetId: string, patch: (p: GraphicProps) => GraphicProps): { preset: GraphicPreset; props: Record<string, unknown> } | null {
  const preset = presetById(presetId);
  if (!preset || preset.template !== "GRAPHIC") return null;
  const base = GraphicPropsSchema.parse(structuredClone(preset.props));
  const r = GraphicPropsSchema.safeParse(patch(base));
  return r.success ? { preset, props: r.data as unknown as Record<string, unknown> } : null;
}

/** The library's preset for a component (+ variant) — featured first — pre-filled by `patch`.
 * Library-2 suggestions go through this so they don't depend on individual preset ids. */
function graphicFromComponent(component: GraphicComponent, variant: string | null, patch: (p: GraphicProps) => GraphicProps): { preset: GraphicPreset; props: Record<string, unknown> } | null {
  const pick = (pred: (p: GraphicPreset) => boolean) => GRAPHIC_PRESETS.filter((p) => p.template === "GRAPHIC" && p.props.component === component && pred(p)).sort((a, b) => Number(!!b.featured) - Number(!!a.featured))[0];
  const variantOf = (p: GraphicPreset) => (p.props.variant as string | null | undefined) ?? GRAPHIC_COMPONENT_SPECS[component].variants[0]![0];
  const preset = (variant ? pick((p) => variantOf(p) === variant) : undefined) ?? pick(() => true);
  return preset ? graphicFrom(preset.id, patch) : null;
}

/** Words after a trigger up to the end of the clause ("I googled how to … " → "how to …"). */
function phraseAfter(text: string, re: RegExp, max = 60): string | null {
  const m = re.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length).replace(/^[\s:,"“'‘]+/, "");
  const q = /^["“'‘](.+?)["”'’]/.exec(text.slice(m.index + m[0].length).trim());
  const raw = q ? q[1]! : rest.split(/[.!?;]|,\s(?:and|but|so)\b|\s(?:and then|but)\s/)[0]!;
  const s = raw.trim().replace(/["”'’]+$/, "");
  if (s.length < 3) return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** A quoted bit of speech ("she said 'are you up'") or null. */
function quoted(text: string): string | null {
  const m = /["“‘']([^"”’']{3,90})["”’']/.exec(text);
  return m ? m[1]!.trim() : null;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * Library 2 — moments that call for platform/phone/news/hook graphics, detected from explicit
 * words ("I googled…", "she texted me", "breaking news", "went viral", "subscribe", "myth",
 * "plot twist", "wait for it", "pros and cons"…). Pre-filled with the words/numbers said.
 */
function library2Suggestions(text: string, lower: string, nums: DetectedNumber[], push: (s: { preset: GraphicPreset; props: Record<string, unknown> } | null, reason: string) => void): void {
  const money = nums.filter((n) => n.kind === "MONEY");
  const said = quoted(text);
  // Search
  const searchRe = /\b(?:i\s+)?(?:googled|google(?:d)? it|searched(?: for| up)?|looked up|typed in(?:to google)?|search(?:ed)? online for)\b/i;
  if (searchRe.test(text) || /\bgoogle\b/.test(lower)) {
    const q = phraseAfter(text, searchRe) ?? said;
    push(graphicFromComponent("SEARCH_BAR", "TYPING", (p) => (q ? { ...p, title: q.toLowerCase() } : p)), q ? `You searched “${q}”` : "You talked about searching");
    push(graphicFromComponent("SEARCH_BAR", "ASK", (p) => p), "“People also ask”");
  }
  // Texts / DMs
  if (/\b(?:texted|texting|text(?:ed)? me|messaged|dm'?d|dmed|sent me a (?:text|message|dm)|group chat|replied)\b/.test(lower)) {
    const who = /\b(my (?:mom|dad|boss|friend|landlord|ex|sister|brother|girlfriend|boyfriend|wife|husband)|she|he|they)\b/.exec(lower)?.[1];
    const name = who && who.startsWith("my ") ? capitalize(who.slice(3)) : null;
    push(
      graphicFromComponent("DM_CHAT", "MESSAGES", (p) => ({
        ...p,
        title: name ?? p.title,
        items: said ? [{ text: said, sub: null, value: null, icon: null, color: "AUTO", op: "NONE", state: "NONE", side: "THEM", meta: null }, ...p.items.filter((i) => i.side === "ME").slice(0, 1)] : p.items,
      })),
      said ? `A text: “${said}”` : "Sounds like a text conversation",
    );
  }
  // Notifications / alerts / payments
  if (/\bnotification|\bgot an? (?:email|alert|text) from|\bmy bank\b|\bdirect deposit|\bpaycheck (?:hit|landed)/.test(lower)) {
    push(graphicFromComponent("NOTIFICATION", "BANNER", (p) => p), "A notification moment");
  }
  if (/\b(?:venmo(?:ed)?|zelle(?:d)?|paid me|sent me|cash ?app)\b/.test(lower) && money.length) {
    const v = Math.abs(money[0]!.value);
    push(graphicFromComponent("PAYMENT", "RECEIVED", (p) => ({ ...p, items: p.items.length ? [{ ...p.items[0]!, value: v }, ...p.items.slice(1)] : [item("", v)] })), `${fmtShort(money[0]!)} received`);
  }
  if (/\b(?:called me|phone rang|calling me|got a call|facetime)\b/.test(lower)) push(graphicFromComponent("CALL", "INCOMING", (p) => p), "An incoming call");
  // News
  if (/\bbreaking news\b|\bin the news\b|\bheadlines?\b|\bjust announced\b/.test(lower)) {
    const h = phraseAfter(text, /\b(?:breaking news|headline(?:s)?|just announced)\b:?/i, 70);
    push(graphicFromComponent("NEWS", "BREAKING", (p) => (h ? { ...p, title: capitalize(h) } : p)), "Breaking-news moment");
    push(graphicFromComponent("NEWS", "HEADLINE", (p) => (h ? { ...p, title: capitalize(h) } : p)), "As a headline");
  }
  // Viral / trending / posts
  if (/\bwent viral\b|\bviral\b|\btrending\b|\bblew up\b|\bfor you page\b|\bfyp\b/.test(lower)) push(graphicFromComponent("TRENDING", "LIST", (p) => p), "Went viral / trending");
  if (/\btweet(?:ed)?\b|\bposted\b|\bthread\b|\bcomments? section\b/.test(lower)) {
    push(graphicFromComponent("SOCIAL_POST", "MICRO", (p) => ({ ...p, body: (said ?? text).slice(0, 220) })), "As a post");
    if (/\bcomment/.test(lower)) push(graphicFromComponent("COMMENT", "REPLY", (p) => (said ? { ...p, items: [{ ...p.items[0]!, text: said }] } : p)), "Reply to a comment");
  }
  // Subscribe / follow / milestones
  if (/\bsubscribe(?:d|rs)?\b|\bfollow (?:me|for)\b|\bhit follow\b|\bturn on (?:post )?notifications\b/.test(lower)) {
    push(graphicFromComponent("VIDEO_CARD", "SUBSCRIBE", (p) => p), "Subscribe / follow");
    push(presetById("cta-follow") ? graphicFrom("cta-follow", (p) => p) : null, "Follow prompt");
  }
  const milestone = /\b(?:hit|reached|crossed|at)\s+(\d[\d.,]*\s*(?:k|m|thousand|million)?)\s+(?:followers|subscribers|subs|views)\b/i.exec(text);
  if (milestone) {
    const n = detectNumbers(milestone[1]!)[0];
    if (n) push(graphicFromComponent("SOCIAL_COUNTER", "MILESTONE", (p) => ({ ...p, items: p.items.length ? [{ ...p.items[0]!, value: Math.abs(n.value) }, ...p.items.slice(1)] : [item("", Math.abs(n.value))] })), `${milestone[1]} milestone`);
  }
  // Hooks & verdicts
  if (/\bmyth\b|\bthat'?s (?:false|a lie|wrong|not true)\b|\bdebunk|\bbusted\b/.test(lower)) push(graphicFromComponent("VERDICT", "STAMP", (p) => ({ ...p, title: /\bmyth\b/.test(lower) ? "MYTH" : /\bwrong\b/.test(lower) ? "WRONG" : "FALSE" })), "Call it out");
  else if (/\bthat'?s (?:true|a fact|right)\b|\bfact:/.test(lower)) push(graphicFromComponent("VERDICT", "STAMP", (p) => ({ ...p, title: /\bfact\b/.test(lower) ? "FACT" : "TRUE" })), "Stamp it true");
  if (/\bwait for it\b/.test(lower)) push(graphicFromComponent("HOOK_TEXT", "WAIT", (p) => p), "Wait for it…");
  if (/\bplot twist\b/.test(lower)) push(graphicFromComponent("HOOK_TEXT", "PLOT_TWIST", (p) => p), "Plot twist");
  if (/\bpov\b/.test(lower)) {
    const pov = phraseAfter(text, /\bpov\b:?/i, 120);
    push(graphicFromComponent("HOOK_TEXT", "POV", (p) => (pov ? { ...p, body: pov } : p)), "POV title");
  }
  if (/\bstory ?time\b/.test(lower)) push(graphicFromComponent("HOOK_TEXT", "CHAPTER", (p) => p), "Storytime");
  if (/\bquiz\b|\bguess (?:what|how much|which)\b|\bquestion for you\b|\bcan you guess\b/.test(lower)) push(graphicFromComponent("QUIZ", "QUESTION", (p) => p), "Quiz the viewer");
  if (/\brate (?:it|this|them)\b|\bout of (?:10|ten)\b/.test(lower)) push(graphicFromComponent("QUIZ", "SLIDER", (p) => p), "Rate it 1–10");
  if (/\bpros and cons\b|\bupsides? and downsides?\b/.test(lower)) push(graphicFromComponent("LIST_SPLIT", "PROS_CONS", (p) => p), "Pros and cons");
  if (/\bdo'?s and don'?ts\b/.test(lower)) push(graphicFromComponent("LIST_SPLIT", "DOS_DONTS", (p) => p), "Do's and don'ts");
  if (/\bthree,? two,? one\b|\b3,? 2,? 1\b|\bcountdown\b/.test(lower)) push(graphicFromComponent("COUNTDOWN", "NUMBERS", (p) => p), "Countdown");
  // Life
  if (/\bweather\b|\bdegrees\b|\bheat ?wave\b/.test(lower)) push(graphicFromComponent("WEATHER", "CARD", (p) => p), "Weather");
  if (/\bflew\b|\bflight\b|\bairport\b|\bboarding\b/.test(lower)) push(graphicFromComponent("MAP_NAV", "FLIGHT", (p) => p), "A flight");
  const city = /\b(los angeles|new york|miami|chicago|austin|san francisco|seattle|denver|nashville|boston|atlanta|dallas|houston|london|paris|tokyo)\b/i.exec(text);
  if (city || /\bin la\b|\bl\.a\.\b/.test(lower)) push(graphicFromComponent("MAP_NAV", "PIN", (p) => ({ ...p, title: city ? city[1]!.replace(/\b\w/g, (c) => c.toUpperCase()) : "Los Angeles" })), "A place");
  if (/\bscreen ?time\b|\bon my phone for\b|\bdoom ?scroll/.test(lower)) push(graphicFromComponent("SCREEN_TIME", "REPORT", (p) => p), "Screen time");
  if (/\bgym\b|\bworkout\b|\bsets?\b.*\breps?\b|\bbench\b|\bsquat/.test(lower)) push(graphicFromComponent("TRACKER", "SETS", (p) => p), "Workout sets");
  if (/\bstreak\b|\bevery (?:single )?day for\b|\bdays? in a row\b|\bhabit\b/.test(lower)) push(graphicFromComponent("TRACKER", "HABIT", (p) => p), "Habit streak");
  if (/\bpodcast\b|\bepisode\b/.test(lower)) push(graphicFromComponent("MEDIA_PLAYER", "PODCAST", (p) => p), "Podcast");
  if (/\buber\b|\blyft\b|\bride ?share\b/.test(lower)) push(graphicFromComponent("TRAVEL", "RIDE", (p) => p), "A ride");
  if (/\bdeclined\b/.test(lower)) push(graphicFromComponent("PAYMENT", "DECLINED", (p) => p), "Card declined");
}

function item(text: string, value: number | null, prev?: GraphicItem): GraphicItem {
  return { text, value, sub: null, icon: prev?.icon ?? null, color: prev?.color ?? "AUTO", op: prev?.op ?? "NONE", state: prev?.state ?? "NONE", side: prev?.side ?? "NONE", meta: prev?.meta ?? null };
}

function money(fmt: GraphicProps["format"], kind: DetectedNumber["kind"]): GraphicProps["format"] {
  return { ...fmt, kind: kind === "MONEY" ? "CURRENCY" : kind === "PERCENT" ? "PERCENT" : "NUMBER", signs: "NEGATIVE" };
}

function fmtShort(d: DetectedNumber): string {
  return d.raw.replace(/\s+/g, " ").replace(/\$(?:\s*\$)+/g, "$");
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
  const push = (s: { preset: GraphicPreset; props: Record<string, unknown> } | null, reason: string, name?: string) => {
    if (s && !out.some((o) => o.preset.id === s.preset.id)) out.push({ ...s, reason, ...(name ? { name } : {}) });
  };

  // Library 2: explicit platform/phone/news/hook language ("I googled…", "she texted me").
  library2Suggestions(text, lower, nums, push);

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
    // Generic uses of topic-named presets: the salary hero is just a big number here, and the
    // emergency-fund card loses its shield icon unless he is actually talking about a fund.
    const aboutFund = /\b(emergency|fund|cushion|rainy day)\b/i.test(text);
    const aboutPay = /\b(salary|income|paycheck|take.?home|making|earn)/i.test(text);
    push(graphicFrom("hero-salary", (p) => ({ ...p, items: [item(monthly ? "a month" : yearly ? "a year" : "", d.value)] })), `You said ${fmtShort(d)}`, aboutPay ? undefined : "Big number");
    push(graphicFrom("emergency-fund-stat", (p) => ({ ...p, items: [{ ...item(text.length <= 60 ? text : roles[0]?.label ?? "", d.value, p.items[0]), ...(aboutFund ? {} : { icon: null }) }] })), `${fmtShort(d)} on a card`, aboutFund ? undefined : "Number card");
  }
  if (nums.length === 1 && nums[0]!.kind === "NUMBER") push(graphicFrom("hero-salary", (p) => ({ ...p, items: [item("", nums[0]!.value)], format: { ...p.format, kind: "NUMBER" } })), `You said ${fmtShort(nums[0]!)}`, "Big number");
  if (listy) push(graphicFrom("steps-debt-plan", (p) => ({ ...p, title: null })), "Sounds like a list of steps");
  if (versus && moneyNums.length < 2) push(graphicFrom("versus-rent-own", (p) => p), "A comparison");
  // Always: the words themselves.
  push(graphicFrom("kinetic-stack", (p) => ({ ...p, body: text.slice(0, 220) })), "Put these words on screen");
  return out.slice(0, limit);
}
