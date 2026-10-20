import { describe, expect, it } from "vitest";
import {
  GRAPHIC_CATEGORIES,
  GRAPHIC_COMPONENTS,
  GRAPHIC_COMPONENT_SPECS,
  GRAPHIC_PRESETS,
  GraphicPropsSchema,
  applyQuickText,
  graphicDesignSize,
  graphicShownNumbers,
  graphicTone,
  parseQuickText,
  searchPresets,
  suggestGraphics,
  toQuickEntry,
  type GraphicProps,
} from "../timeline-browser";

/**
 * Library 2 (2026-10-18): platform-style UI, phone & apps, search & web, news & media, hooks,
 * reactions & FX, life & places — additive to the original library.
 */

const parse = (p: Record<string, unknown>): GraphicProps => GraphicPropsSchema.parse(p);
const LIB2 = GRAPHIC_COMPONENTS.slice(28);
const comp = (id: string) => GRAPHIC_PRESETS.find((p) => p.id === id)?.props.component;

describe("library 2 — contract (additive, backward compatible)", () => {
  it("adds 25–40 base components, each with a spec, variants and at least one preset", () => {
    expect(LIB2.length).toBeGreaterThanOrEqual(25);
    expect(LIB2.length).toBeLessThanOrEqual(40);
    for (const c of LIB2) {
      const s = GRAPHIC_COMPONENT_SPECS[c];
      expect(s.id).toBe(c);
      expect(s.variants.length).toBeGreaterThan(0);
      expect(GRAPHIC_CATEGORIES.some((k) => k.id === s.category), c).toBe(true);
      expect(GRAPHIC_PRESETS.some((p) => p.template === "GRAPHIC" && p.props.component === c), c).toBe(true);
    }
  });
  it("200+ new presets; the original library keeps its ids and order at the front", () => {
    const original = ["income-3-people-12-months", "salary-freelance-business", "rent-vs-buy-5-years"];
    expect(GRAPHIC_PRESETS.slice(0, 3).map((p) => p.id)).toEqual(original);
    const lib2 = GRAPHIC_PRESETS.filter((p) => (p.template === "GRAPHIC" && LIB2.includes(p.props.component as (typeof LIB2)[number])) || (p.template === "ICON_3D" && GRAPHIC_PRESETS.indexOf(p) >= 171));
    expect(lib2.length).toBeGreaterThanOrEqual(200);
    expect(GRAPHIC_PRESETS.length).toBeGreaterThanOrEqual(371);
  });
  it("props saved before library 2 still parse (meta/tone/side default in)", () => {
    const old = parse({ component: "CHECKLIST", items: [{ text: "a", state: "DONE" }] });
    expect(old.meta).toBeNull();
    expect(old.tone).toBe("AUTO");
    expect(old.items[0]!.side).toBe("NONE");
    expect(old.items[0]!.meta).toBeNull();
    expect(graphicTone(old)).toBe("DARK");
  });
  it("tone: AUTO follows the component's default; explicit wins", () => {
    const chat = parse({ component: "DM_CHAT", items: [{ text: "hey", side: "THEM" }] });
    expect(graphicTone(chat)).toBe(GRAPHIC_COMPONENT_SPECS.DM_CHAT.toneDefault ?? "DARK");
    expect(graphicTone({ ...chat, tone: "DARK" })).toBe("DARK");
  });
  it("every library-2 preset fits the canvas", () => {
    for (const p of GRAPHIC_PRESETS.filter((x) => x.template === "GRAPHIC" && LIB2.includes(x.props.component as (typeof LIB2)[number]))) {
      const s = graphicDesignSize(parse(p.props));
      expect(s.width, p.id).toBeLessThanOrEqual(1080);
      expect(s.height, p.id).toBeLessThanOrEqual(1920);
      expect(s.width * s.height, p.id).toBeGreaterThan(0);
    }
  });
  it("brand-safe: no real platform/brand names in anything a library-2 preset puts on screen", () => {
    // Tags may carry platform words (search); names/descriptions/props (what's shown or read
    // as the graphic) must not.
    const brands = /\b(lambo(rghini)?|tesla|starbucks|netflix|amazon|google|iphone|apple|spotify|venmo|uber|lyft|tiktok|youtube|instagram|reddit|linkedin|twitter|costco|chipotle|disney|nike|airbnb|facebook|whatsapp|snapchat|zelle|cash ?app|paypal|chase bank|vanguard|fidelity|robinhood|coinbase|gmail|outlook|safari|chrome|facetime|imessage|siri|android|samsung|bing|wikipedia|new york times|wsj|forbes|cnbc|bloomberg|cnn|espn|hulu|hbo|doordash|grubhub|peloton|walmart|mcdonald'?s|rolex|gucci|prius|toyota|bmw|porsche)\b/i;
    const hits: string[] = [];
    const walk = (v: unknown, path: string, id: string): void => {
      if (typeof v === "string") {
        if (brands.test(v)) hits.push(`${id} ${path}: ${v}`);
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, id));
      else if (v && typeof v === "object") for (const [key, x] of Object.entries(v)) walk(x, `${path}.${key}`, id);
    };
    for (const p of GRAPHIC_PRESETS.slice(171)) {
      walk(p.props, "props", p.id);
      walk(p.name, "name", p.id);
      walk(p.description, "description", p.id);
    }
    expect(hits).toEqual([]);
  });
  it("text in meta fields is on screen, so the factual gate sees it", () => {
    const p = parse({ component: "NOTIFICATION", meta: "now", items: [{ text: "Deposit", sub: "You received $4,000", meta: "Bank" }] });
    const shown = graphicShownNumbers(p);
    expect(shown.texts.map((t) => t.field)).toEqual(expect.arrayContaining(["meta", "items[0].sub", "items[0].meta"]));
  });
});

describe("library 2 — quick entry dialects", () => {
  it("CHAT: Me / names / alternating", () => {
    const r = parseQuickText("Me: running late | Mom: again?? | Me: rent went up $300, again", "CHAT");
    expect(r.items.map((i) => i.side)).toEqual(["ME", "THEM", "ME"]);
    expect(r.items[1]!.sub).toBe("Mom");
    expect(r.items[2]!.text).toBe("rent went up $300, again");
    const alt = parseQuickText("you up?\nno\nok", "CHAT");
    expect(alt.items.map((i) => i.side)).toEqual(["THEM", "ME", "THEM"]);
  });
  it("LINES: ranks dropped, trailing counts → value, ' — ' → second line", () => {
    const r = parseQuickText("1. Rent prices 120K | 2. #budget — Trending in Finance 48K | 3) Index funds", "LINES");
    expect(r.items).toHaveLength(3);
    expect(r.items[0]).toMatchObject({ text: "Rent prices", value: 120000 });
    expect(r.items[1]).toMatchObject({ text: "#budget", sub: "Trending in Finance", value: 48000 });
    expect(r.items[2]).toMatchObject({ text: "Index funds", value: null });
  });
  it("QUERY: the first group is the title; numbers stay text when the component has no values", () => {
    const r = parseQuickText("best savings account 2026 | best savings account reddit", "QUERY", { values: false });
    expect(r.title).toBe("best savings account 2026");
    expect(r.items[0]!.text).toBe("best savings account reddit");
  });
  it("applies onto a conversation and round-trips", () => {
    const p = parse({ component: "DM_CHAT", title: "Mom", items: [{ text: "x", side: "THEM" }] });
    const r = applyQuickText(p, "Mom: did you pay rent | Me: yes | Me: twice, apparently")!;
    expect(r.summary).toMatch(/3 messages/);
    expect(GraphicPropsSchema.safeParse(r.props).success).toBe(true);
    expect(r.props.items.map((i) => i.side)).toEqual(["THEM", "ME", "ME"]);
    const again = applyQuickText(r.props, toQuickEntry(r.props))!;
    expect(again.props.items.map((i) => [i.text, i.side])).toEqual(r.props.items.map((i) => [i.text, i.side]));
  });
  it("applies a ranked list and a query + options, capped at the component's bounds", () => {
    const t = parse({ component: "TRENDING", items: [{ text: "a" }] });
    const r = applyQuickText(t, Array.from({ length: 9 }, (_, i) => `${i + 1}. Topic ${i} ${i + 1}K`).join(" | "))!;
    expect(r.props.items.length).toBe(GRAPHIC_COMPONENT_SPECS.TRENDING.uses.items!.count[1]);
    expect(r.summary).toMatch(/only/);
    const s = parse({ component: "SEARCH_BAR", title: "x", items: [] });
    const q = applyQuickText(s, "is a 401k worth it | is a 401k worth it reddit | is a 401k a scam")!;
    expect(q.props.title).toBe("is a 401k worth it");
    expect(q.props.items.map((i) => i.text)).toEqual(["is a 401k worth it reddit", "is a 401k a scam"]);
  });
  it("components without a dialect return null (numbers quick entry still applies)", () => {
    expect(applyQuickText(parse({ component: "STAT_TILES", items: [{ text: "a", value: 1 }] }), "x")).toBeNull();
  });
});

describe("library 2 — search synonyms", () => {
  const top = (q: string, n = 8) => searchPresets(q, { limit: n }).map((h) => h.preset.props.component ?? h.preset.template);
  it.each([
    ["google", "SEARCH_BAR"],
    ["googled", "SEARCH_BAR"],
    ["tweet", "SOCIAL_POST"],
    ["text message", "DM_CHAT"],
    ["imessage", "DM_CHAT"],
    ["notification", "NOTIFICATION"],
    ["breaking news", "NEWS"],
    ["map", "MAP_NAV"],
    ["subscribe", "VIDEO_CARD"],
    ["trending", "TRENDING"],
    ["myth", "VERDICT"],
    ["countdown", "COUNTDOWN"],
    ["venmo", "PAYMENT"],
    ["boarding pass", "TRAVEL"],
  ])("“%s” finds %s", (q, c) => {
    expect(top(q)).toContain(c);
  });
});

describe("library 2 — suggestions from the transcript", () => {
  const comps = (s: string) => suggestGraphics(s, 8).map((x) => x.props.component);
  it("“I googled …” → a search bar typing that query", () => {
    const s = suggestGraphics("So I googled is a 401k worth it, and the first result was a scam.", 8);
    const search = s.find((x) => x.props.component === "SEARCH_BAR")!;
    expect(search).toBeDefined();
    expect(search.props.title).toBe("is a 401k worth it");
  });
  it("texts, breaking news, viral, subscribe, myths, plot twists", () => {
    expect(comps("Then my landlord texted me 'rent is going up again'")).toContain("DM_CHAT");
    expect(comps("Breaking news: the Fed just cut rates")).toContain("NEWS");
    expect(comps("That video went viral overnight")).toContain("TRENDING");
    expect(comps("Subscribe if you want part two")).toContain("VIDEO_CARD");
    expect(comps("That's a myth. Renting is not throwing money away.")).toContain("VERDICT");
    expect(comps("Plot twist: the expensive one was cheaper")).toContain("HOOK_TEXT");
    expect(comps("We hit 100k followers this week")).toContain("SOCIAL_COUNTER");
  });
  it("“subscriptions” (money) does not trigger the subscribe CTA", () => {
    expect(comps("Cancel the subscriptions you forgot about")).not.toContain("VIDEO_CARD");
  });
  it("suggested props always validate", () => {
    for (const phrase of ["I googled how to buy a house with no money", "she texted me at 2am", "breaking news: rates are up", "pros and cons of renting", "wait for it", "POV: you checked your bank account"]) {
      for (const s of suggestGraphics(phrase, 8)) expect(GraphicPropsSchema.safeParse(s.props).success, `${phrase} → ${s.preset.id}`).toBe(true);
    }
  });
});

void comp;


describe("graphicFillTooThin — a graphic must be as full as its preset", () => {
  it("every preset passes against itself; a numbers graphic with its numbers blanked, or a two-sided one with one side, fails", async () => {
    const { graphicFillTooThin } = await import("../graphics/contract");
    const { GRAPHIC_PRESETS } = await import("../graphics/presets");
    type Fill = Parameters<typeof graphicFillTooThin>[0];
    const graphics = GRAPHIC_PRESETS.filter((p) => p.template === "GRAPHIC").map((p) => ({ id: p.id, props: p.props as unknown as Fill }));
    for (const p of graphics) expect(graphicFillTooThin(p.props, p.props), p.id).toBeNull();
    const numeric = graphics.find((p) => (p.props.items ?? []).filter((i) => i.value != null).length >= 2)!;
    const blanked: Fill = { ...numeric.props, items: (numeric.props.items ?? []).map((i) => ({ ...i, value: null })) };
    expect(graphicFillTooThin(blanked, numeric.props)).toMatch(/numbers; this fills 0/);
    const oneSide: Fill = { ...numeric.props, items: (numeric.props.items ?? []).slice(0, 1) };
    expect(graphicFillTooThin(oneSide, numeric.props)).not.toBeNull();
    // No preset to compare with → never judged thin.
    expect(graphicFillTooThin(blanked, null)).toBeNull();
  });
});
