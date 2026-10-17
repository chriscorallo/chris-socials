import { describe, it, expect } from "vitest";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { EditTimelineSchema, MotionPropsSchemas, MOTION_TEMPLATES, visualRect, intersectionArea, type EditTimeline } from "@chris/media/timeline";
import { MockModelProvider } from "../providers/mock-provider";
import {
  designVisualsForTimeline,
  extractNumbers,
  numberIsGrounded,
  groundedNumbers,
  snapVisualTiming,
  MotionDesignerOutputSchema,
  MotionDesignerPropsSchemas,
  type MotionDesignerVisual,
  type DesignVisualsInput,
} from "../motion-designer-agent";

// 30 s take, one word every 0.5 s (0.4 s long) — "w0 w1 ..." with a few real words.
const SPOKEN = [
  "If", "you", "save", "twenty", "percent", "of", "your", "income", "you", "hit",
  "24,500", "dollars", "in", "three", "years.", "Here", "are", "the", "rules.", "First",
  "automate", "it.", "Second", "never", "touch", "it.", "Third", "invest", "the", "rest.",
];
const words = Array.from({ length: 60 }, (_, i) => ({
  word: SPOKEN[i % SPOKEN.length]!,
  start: i * 0.5,
  end: i * 0.5 + 0.4,
}));

function timeline(): EditTimeline {
  return EditTimelineSchema.parse({
    version: 2,
    clips: [{ id: "c1", mediaAssetId: "take", sourceStart: 0, sourceEnd: 30 }],
    captions: { enabled: true, fontId: "inter-display-bold", fontSize: 62, color: "#FFFFFF", highlightColor: "#FFD84D", y: 0.78 },
  });
}

const research = {
  primaryClaim: "Saving 20% of income builds a $24,500 cushion in about three years.",
  numericInputs: [
    { label: "Target emergency fund", value: "$24,500", asOfDate: "2026-01-01" },
    { label: "Savings rate", value: "20%", asOfDate: null },
  ],
  facts: [{ statement: "Median household savings were $8,000 in 2025.", type: "FACT" }],
  calculationNotes: null,
};
const script = { spokenScript: "If you save 20% of your income you hit $24,500 in three years. Here are the three rules." };

function base(overrides: Partial<DesignVisualsInput> = {}): DesignVisualsInput {
  return {
    timeline: timeline(),
    wordsByAsset: { take: words },
    research,
    script,
    tier: "MEDIUM",
    brandContext: "BRAND CONTEXT",
    ...overrides,
  };
}

const common = { palette: "BRAND", enter: "AUTO", exit: "AUTO", enterSfx: "WHOOSH", rationale: "clarifies", importance: 3 } as const;

function v(partial: Partial<MotionDesignerVisual> & Pick<MotionDesignerVisual, "template" | "props" | "start" | "end">): MotionDesignerVisual {
  return { ...common, anchorText: "phrase", ...partial } as MotionDesignerVisual;
}

const counter = (start: number, end: number, value = 24500, importance = 3) =>
  v({ template: "NUMBER_COUNTER", props: { value, from: 0, prefix: "$", suffix: "", decimals: 0, label: "in three years" }, start, end, importance });

function provider(visuals: MotionDesignerVisual[]) {
  return new MockModelProvider(() => ({ rationale: "Numbers where he says numbers.", visuals }));
}

describe("Motion Designer output schema", () => {
  it("is an explicit union whose props keys mirror the contract's MotionPropsSchemas", () => {
    for (const t of MOTION_TEMPLATES) {
      const mine = Object.keys((MotionDesignerPropsSchemas[t] as unknown as { shape: object }).shape).sort();
      const contract = Object.keys((MotionPropsSchemas[t] as unknown as { shape: object }).shape).sort();
      expect(mine, t).toEqual(contract);
    }
  });

  it("converts to a structured-output JSON schema (no network)", () => {
    const format = betaZodOutputFormat(MotionDesignerOutputSchema);
    expect(JSON.stringify(format)).toContain("NUMBER_COUNTER");
  });

  it("rejects free-form props (no z.record escape hatch)", () => {
    const bad = { rationale: "", visuals: [{ ...counter(1, 3), props: { value: 1, from: 0, prefix: "", suffix: "", decimals: 0, label: null, extra: 1 } }] };
    expect(MotionDesignerOutputSchema.safeParse(bad).success).toBe(false);
  });
});

describe("number grounding", () => {
  it("extracts formatted and spelled-out numbers", () => {
    expect(extractNumbers("$24,500")).toEqual([24500]);
    expect(extractNumbers("$24.5K a year")).toEqual([24500]);
    expect(extractNumbers("1.2 million people")).toEqual([1200000]);
    expect(extractNumbers("7% and 10x")).toEqual([7, 10]);
    expect(extractNumbers("three rules")).toEqual([3]);
    expect(extractNumbers("twenty five thousand dollars")).toEqual([25000]);
    expect(extractNumbers("3 months")).toEqual([3]);
  });

  it("accepts formatting variants and honest rounding, rejects inventions", () => {
    const allowed = groundedNumbers(research, script);
    expect(numberIsGrounded(24500, allowed)).toBe(true);
    expect(numberIsGrounded(24000, [24480])).toBe(true); // "$24K"
    expect(numberIsGrounded(0.2, allowed)).toBe(true); // 20% as a fraction
    expect(numberIsGrounded(100, [149])).toBe(false); // too lossy a rounding
    expect(numberIsGrounded(31000, allowed)).toBe(false);
    expect(numberIsGrounded(3, allowed)).toBe(true); // "three" in the script
  });
});

describe("snapVisualTiming", () => {
  it("snaps the start to the onset of the word being spoken, enforces 1.5-5 s", () => {
    expect(snapVisualTiming(5.2, 5.6, words, 30)).toEqual({ start: 4.92, end: 6.42 }); // inside "24,500" (5.0-5.4); 1.5 s minimum
    const long = snapVisualTiming(2, 12, words, 30);
    expect(long.end - long.start).toBeLessThanOrEqual(5);
    expect(snapVisualTiming(29.5, 31, words, 30)).toEqual({ start: 28.5, end: 30 }); // pulled back to keep 1.5 s before the end
  });
});

describe("designVisualsForTimeline", () => {
  it("returns contract-valid, timed, placed visuals for a valid proposal", async () => {
    const p = provider([
      counter(5.0, 8.0, 24500, 5),
      v({ template: "LIST_STEPS", props: { title: "The rules", items: ["Automate it", "Never touch it", "Invest the rest"], style: "NUMBERED" }, start: 9.5, end: 14 }),
    ]);
    const track = Array.from({ length: 91 }, (_, i) => ({ t: i / 3, box: { x: 0.3, y: 0.15, w: 0.4, h: 0.15 } }));
    const res = await designVisualsForTimeline(p, base({ subjectTracks: { take: track } }));
    expect(p.calls[0]!.promptId).toBe("MOTION_DESIGNER");
    expect(p.calls[0]!.modelClass).toBe("MEDIUM");
    expect(p.calls[0]!.userPrompt).toContain("24500");
    expect(res.rejectedVisuals).toEqual([]);
    expect(res.visuals.map((x) => x.id)).toEqual(["mv-1", "mv-2"]);
    expect(res.visuals[0]!.props).toMatchObject({ value: 24500, prefix: "$" });
    expect(res.visuals.every((x) => x.placement.mode === "AUTO")).toBe(true);
    // Placed off Chris's face.
    const head = { x: 0.3 * 1080, y: 0.15 * 1920, width: 0.4 * 1080, height: 0.15 * 1920 };
    for (const x of res.visuals) expect(intersectionArea(visualRect(x, { width: 1080, height: 1920 }), head)).toBe(0);
  });

  it("FACTUAL: drops a visual with an invented number and reports it", async () => {
    const res = await designVisualsForTimeline(
      provider([
        counter(5, 8, 31000),
        v({ template: "KINETIC_TEXT", props: { text: "Save 15% today", emphasis: ["15%"], style: "PUNCH" }, start: 12, end: 14 }),
        v({ template: "STAT_CARD", props: { value: "$24.5K", label: "your cushion", sublabel: null, trend: "UP" }, start: 16, end: 19 }),
      ]),
      base(),
    );
    expect(res.visuals.map((x) => x.template)).toEqual(["STAT_CARD"]);
    expect(res.rejectedVisuals).toHaveLength(2);
    expect(res.rejectedVisuals[0]!.reason).toMatch(/FACTUAL: 31000/);
    expect(res.rejectedVisuals[1]!.reason).toMatch(/FACTUAL: 15/);
  });

  it("shows no numbers at all when there is no research or script", async () => {
    const res = await designVisualsForTimeline(provider([counter(5, 8)]), base({ research: null, script: null }));
    expect(res.visuals).toEqual([]);
    expect(res.rejectedVisuals[0]!.reason).toMatch(/FACTUAL/);
  });

  it("removes overlaps: trims the earlier one when it can, else keeps the more important", async () => {
    const res = await designVisualsForTimeline(
      provider([
        counter(2, 7, 24500, 3),
        v({ template: "PERCENT_RING", props: { percent: 20, label: "of income" }, start: 5, end: 8, importance: 4 }),
        v({ template: "ICON_3D", props: { icon: "PIGGY_BANK", caption: null }, start: 8.2, end: 10, importance: 1 }),
        v({ template: "ICON_3D", props: { icon: "LOCK", caption: "never touch it" }, start: 8.4, end: 11, importance: 5 }),
      ]),
      base(),
    );
    const vis = res.visuals;
    for (let i = 1; i < vis.length; i++) expect(vis[i]!.start).toBeGreaterThanOrEqual(vis[i - 1]!.end + 0.4 - 1e-9);
    expect(vis.map((x) => x.template)).toEqual(["NUMBER_COUNTER", "PERCENT_RING", "ICON_3D"]);
    expect((vis[2]!.props as { icon: string }).icon).toBe("LOCK");
    expect(res.rejectedVisuals.map((r) => r.reason).join(" ")).toMatch(/overlap/);
  });

  it("RAW tier: at most 2 visuals (most important kept), no TITLE_CARD", async () => {
    const res = await designVisualsForTimeline(
      provider([
        v({ template: "TITLE_CARD", props: { title: "Three rules", subtitle: null }, start: 0, end: 2, importance: 5 }),
        counter(5, 7, 24500, 2),
        v({ template: "KINETIC_TEXT", props: { text: "Automate it", emphasis: [], style: "PUNCH" }, start: 10, end: 12, importance: 5 }),
        v({ template: "KINETIC_TEXT", props: { text: "Never touch it", emphasis: [], style: "PUNCH" }, start: 13, end: 15, importance: 4 }),
        v({ template: "KINETIC_TEXT", props: { text: "Invest the rest", emphasis: [], style: "PUNCH" }, start: 16, end: 18, importance: 1 }),
      ]),
      base({ tier: "RAW" }),
    );
    expect(res.visuals).toHaveLength(2);
    expect(res.visuals.map((x) => (x.props as { text?: string }).text)).toEqual(["Automate it", "Never touch it"]);
    expect(res.rejectedVisuals.find((r) => r.template === "TITLE_CARD")!.reason).toMatch(/RAW/);
    expect(res.rejectedVisuals.filter((r) => /limit/.test(r.reason))).toHaveLength(2);
  });

  it("keeps existing visuals, avoids them in time and never reuses their ids", async () => {
    const tl = timeline();
    tl.visuals = [
      {
        id: "mv-1",
        template: "KINETIC_TEXT",
        props: { text: "Mine", emphasis: [], style: "PUNCH" },
        start: 4,
        end: 7,
        placement: { mode: "MANUAL", x: 0.5, y: 0.3, scale: 1 },
        palette: "BRAND",
        enter: "AUTO",
        exit: "AUTO",
        enterSfx: null,
        anchorText: null,
      },
    ];
    const res = await designVisualsForTimeline(provider([counter(5, 9)]), base({ timeline: tl }));
    expect(res.visuals[0]!.id).toBe("mv-1");
    const added = res.added[0]!;
    expect(added.id).toBe("mv-2");
    expect(added.start).toBeGreaterThanOrEqual(7.4);
  });

  it("drops props that violate the template contract", async () => {
    const res = await designVisualsForTimeline(
      provider([v({ template: "LIST_STEPS", props: { title: null, items: ["only one"], style: "CHECK" }, start: 9, end: 12 })]),
      base(),
    );
    expect(res.visuals).toEqual([]);
    expect(res.rejectedVisuals[0]!.reason).toMatch(/props/);
  });
});
