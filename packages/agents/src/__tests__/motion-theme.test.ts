import { describe, it, expect } from "vitest";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { EditTimelineSchema, MotionThemeSchema, type EditTimeline } from "@chris/media/timeline";
import { MOTION_TOPICS } from "@chris/domain";
import { MockModelProvider } from "../providers/mock-provider";
import {
  MOTION_THEME_PRESETS,
  THEME_MIN_PRIMARY_CONTRAST,
  THEME_MIN_SECONDARY_CONTRAST,
  fallbackMotionTheme,
  sanitizeMotionTheme,
  themeContrast,
} from "../motion-theme";
import { getAgentPrompt } from "../prompt-context";
import { MotionDesignerOutputSchema, designVisualsForTimeline, type DesignVisualsInput, type MotionDesignerVisual } from "../motion-designer-agent";

describe("topic presets", () => {
  it("every topic has a schema-valid, accessible, on-brand preset", () => {
    for (const t of MOTION_TOPICS) {
      const p = MOTION_THEME_PRESETS[t];
      expect(MotionThemeSchema.safeParse(p).success, t).toBe(true);
      if (p.primary) expect(themeContrast(p.primary), `${t} primary`).toBeGreaterThanOrEqual(THEME_MIN_PRIMARY_CONTRAST);
      if (p.secondary) expect(themeContrast(p.secondary), `${t} secondary`).toBeGreaterThanOrEqual(THEME_MIN_SECONDARY_CONTRAST);
      expect(p.rationale.length).toBeGreaterThan(10);
    }
  });

  it("maps topics to the intended moods", () => {
    expect(fallbackMotionTheme({ title: "I paid off $40k of student loans" }).theme).toMatchObject({ name: "Debt pressure", motionLanguage: "PUNCHY" });
    expect(["CINEMATIC", "CALM"]).toContain(fallbackMotionTheme({ title: "Compounding: why starting at 22 wins" }).theme.motionLanguage);
    expect(fallbackMotionTheme({ title: "How I negotiated a 20% raise" }).theme).toMatchObject({ motionLanguage: "CRISP", secondary: "#5B9DFF" });
    expect(fallbackMotionTheme({ title: "Sunday reset in LA", pillar: "LIFESTYLE" }).theme).toMatchObject({ iconStyle: "SOFT_CLAY" });
    expect(fallbackMotionTheme({ title: "Untitled draft" }).theme).toMatchObject({ name: "Signature", primary: null, secondary: null });
  });
});

describe("sanitizeMotionTheme", () => {
  const base = { name: "X", motionLanguage: "CALM", primary: "#FFD54A", secondary: "#2FBF8F", iconStyle: "GLASS", rationale: "r" };
  it("lightens unreadable colors and keeps hue", () => {
    const r = sanitizeMotionTheme({ ...base, primary: "#8B0000" })!;
    expect(themeContrast(r.theme.primary!)).toBeGreaterThanOrEqual(THEME_MIN_PRIMARY_CONTRAST);
    expect(r.theme.primary).not.toBe("#8B0000");
    expect(r.notes.join(" ")).toMatch(/lightened/);
  });
  it("drops gray / non-accent colors and rejects malformed themes", () => {
    expect(sanitizeMotionTheme({ ...base, secondary: "#888888" })!.theme.secondary).toBeNull();
    expect(sanitizeMotionTheme({ ...base, primary: "gold" })).toBeNull();
    expect(sanitizeMotionTheme({ ...base, motionLanguage: "WILD" })).toBeNull();
  });
});

// ------------------------------------------------------------------ designer integration

const words = Array.from({ length: 60 }, (_, i) => ({ word: ["Your", "debt", "costs", "24,500", "dollars"][i % 5]!, start: i * 0.5, end: i * 0.5 + 0.4 }));
function timeline(extra: Record<string, unknown> = {}): EditTimeline {
  return EditTimelineSchema.parse({
    version: 2,
    clips: [{ id: "c1", mediaAssetId: "take", sourceStart: 0, sourceEnd: 30 }],
    captions: { enabled: true, fontId: "inter-display-bold", fontSize: 62, color: "#FFFFFF", highlightColor: "#FFD84D", y: 0.78 },
    ...extra,
  });
}
const research = { primaryClaim: "Card debt costs $24,500.", numericInputs: [{ label: "Debt", value: "$24,500" }], facts: [], calculationNotes: null };
const base = (o: Partial<DesignVisualsInput> = {}): DesignVisualsInput => ({
  timeline: timeline(),
  wordsByAsset: { take: words },
  research,
  script: { spokenScript: "Your credit card debt costs $24,500." },
  tier: "MEDIUM",
  brandContext: "B",
  topic: { title: "Credit card debt is a trap", pillar: "SKILL" },
  ...o,
});
const common = { palette: "BRAND", enter: "AUTO", exit: "AUTO", enterSfx: "WHOOSH", rationale: "r", anchorText: "debt" } as const;
const counter = (start: number, value = 24500, importance = 3): MotionDesignerVisual =>
  ({ ...common, template: "NUMBER_COUNTER", props: { value, from: 0, prefix: "$", suffix: "", decimals: 0, label: null }, start, end: start + 2.5, importance }) as MotionDesignerVisual;
const bars = (start: number, importance = 3): MotionDesignerVisual =>
  ({ ...common, template: "BAR_CHART", props: { title: null, bars: [{ label: "Debt", value: 24500 }, { label: "Paid", value: 24500 }], unit: "$", highlightIndex: null, depth3d: false }, start, end: start + 2.5, importance }) as MotionDesignerVisual;
const modelTheme = { name: "Hopeful payoff", motionLanguage: "CINEMATIC", primary: "#F2C14E", secondary: "#2FBF8F", iconStyle: "GLASS", rationale: "A debt-freedom story, told big." } as const;

describe("Motion Designer theme + taste", () => {
  it("output schema carries a strict theme and still converts to structured output", () => {
    expect(JSON.stringify(betaZodOutputFormat(MotionDesignerOutputSchema))).toContain("motionLanguage");
    expect(MotionDesignerOutputSchema.safeParse({ rationale: "", theme: { ...modelTheme, extra: 1 }, visuals: [] }).success).toBe(false);
  });

  it("MODEL: uses the model's (sanitized) theme; prompt shows the topic suggestion", async () => {
    const provider = new MockModelProvider(() => ({ rationale: "r", theme: modelTheme, visuals: [counter(1)] }));
    const r = await designVisualsForTimeline(provider, base());
    expect(r.themeSource).toBe("MODEL");
    expect(r.motionTheme).toMatchObject({ name: "Hopeful payoff", motionLanguage: "CINEMATIC" });
    const prompt = provider.calls[0]!.userPrompt;
    expect(prompt).toContain("Deterministic suggestion for topic DEBT");
    expect(prompt).toContain("Debt pressure");
  });

  it("FALLBACK: null or invalid model theme -> topic preset", async () => {
    const r1 = await designVisualsForTimeline(new MockModelProvider(() => ({ rationale: "r", theme: null, visuals: [] })), base());
    expect(r1).toMatchObject({ themeSource: "FALLBACK", motionTheme: { name: "Debt pressure" } });
    const r2 = await designVisualsForTimeline(new MockModelProvider(() => ({ rationale: "r", theme: { ...modelTheme, primary: "not-a-color" }, visuals: [] })), base());
    expect(r2.themeSource).toBe("FALLBACK");
    expect(r2.warnings.join(" ")).toMatch(/invalid/);
  });

  it("KEPT: an existing timeline theme (Chris's decision) is never silently replaced", async () => {
    const mine = { name: "Mine", motionLanguage: "CALM", primary: null, secondary: null, iconStyle: "LINE", rationale: null };
    const provider = new MockModelProvider(() => ({ rationale: "r", theme: modelTheme, visuals: [] }));
    const r = await designVisualsForTimeline(provider, base({ timeline: timeline({ motionTheme: mine }) }));
    expect(r).toMatchObject({ themeSource: "KEPT", motionTheme: { name: "Mine" } });
    expect(provider.calls[0]!.userPrompt).toContain("already has a theme");
    const replaced = await designVisualsForTimeline(provider, base({ timeline: timeline({ motionTheme: mine }), replaceExisting: true }));
    expect(replaced.themeSource).toBe("MODEL");
  });

  it("the FACTUAL hard rule is unchanged by theming", async () => {
    const r = await designVisualsForTimeline(new MockModelProvider(() => ({ rationale: "r", theme: modelTheme, visuals: [counter(1, 31000)] })), base());
    expect(r.added).toHaveLength(0);
    expect(r.rejectedVisuals[0]!.reason).toMatch(/FACTUAL: 31000/);
  });

  it("taste: context reaches the prompt; STRONG fewer-visuals lowers the cap by one; avoided templates are cut first", async () => {
    const visuals = [bars(1, 3), counter(8, 24500, 3), counter(15, 24500, 3), counter(22, 24500, 2)];
    const provider = new MockModelProvider(() => ({ rationale: "r", theme: null, visuals }));
    const plain = await designVisualsForTimeline(provider, base({ tier: "FAST" }));
    expect(plain.added).toHaveLength(4);
    const tasted = await designVisualsForTimeline(provider, base({ tier: "FAST", motionTaste: { context: "- STRONG: Avoid bar charts — 4 edits across 3 videos", capDelta: -1, avoidTemplates: ["BAR_CHART"] } }));
    expect(tasted.added).toHaveLength(3);
    expect(tasted.added.map((v) => v.template)).not.toContain("BAR_CHART");
    expect(tasted.rejectedVisuals.find((x) => x.template === "BAR_CHART")!.reason).toMatch(/usually deletes/);
    expect(provider.calls[1]!.userPrompt).toContain("STRONG: Avoid bar charts");
  });

  it("a WEAK-only taste (no levers) never removes a template", async () => {
    const provider = new MockModelProvider(() => ({ rationale: "r", theme: null, visuals: [bars(1)] }));
    const r = await designVisualsForTimeline(provider, base({ motionTaste: { context: "- WEAK: Avoid bar charts — 1 edit", capDelta: 0, avoidTemplates: [] } }));
    expect(r.added.map((v) => v.template)).toEqual(["BAR_CHART"]);
  });

  it("prompt registry: MOTION_DESIGNER is v1.1.0 with a rollback to 1.0.0", () => {
    const p = getAgentPrompt("MOTION_DESIGNER");
    expect(p.frontmatter.version).toBe("1.1.0");
    expect(p.frontmatter.rollback_version).toBe("1.0.0");
    expect(p.frontmatter.required_context).toContain("MotionTasteProfile");
    expect(p.body).toContain("Motion theme");
  });
});
