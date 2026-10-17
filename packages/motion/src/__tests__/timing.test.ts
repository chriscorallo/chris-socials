import { describe, expect, it } from "vitest";
import { MOTION_TEMPLATES, MotionPropsSchemas, TimelineVisualSchema } from "@chris/media/timeline";
import {
  AUTO_TRANSITIONS,
  PLACEMENT_MARGIN,
  TEMPLATE_DESIGN_SIZE,
  parseVisual,
  parseVisuals,
  placementBox,
  resolveTransition,
  stackCountFor,
  visualFrameWindow,
  isVisualActive,
} from "../timing";
import { SAMPLE_PROPS, sampleVisual } from "../samples";

describe("template props", () => {
  it("every template has valid sample props, a design size and AUTO transitions", () => {
    for (const t of MOTION_TEMPLATES) {
      expect(MotionPropsSchemas[t].safeParse(SAMPLE_PROPS[t]).success, t).toBe(true);
      expect(TEMPLATE_DESIGN_SIZE[t].width).toBeGreaterThan(0);
      expect(AUTO_TRANSITIONS[t].enter).toBeTruthy();
    }
  });

  it("applies schema defaults through parseVisual", () => {
    const r = parseVisual({ id: "v1", template: "NUMBER_COUNTER", props: { value: 42 }, start: 1, end: 3, placement: {} });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.template !== "NUMBER_COUNTER") throw new Error("expected NUMBER_COUNTER");
    expect(r.value.props).toEqual({ value: 42, from: 0, prefix: "", suffix: "", decimals: 0, label: null });
    expect(r.value.visual.placement).toEqual({ mode: "AUTO", x: 0.5, y: 0.3, scale: 1 });
    expect(r.value.visual.enterSfx).toBe("WHOOSH");
    expect(r.value.visual.palette).toBe("BRAND");
  });

  it("reports invalid props per visual instead of throwing", () => {
    const bad = { id: "bad", template: "BAR_CHART", props: { bars: [{ label: "only one", value: 1 }] }, start: 0, end: 2, placement: {} };
    const good = sampleVisual("STAT_CARD", 0, 2);
    const { parsed, errors } = parseVisuals([bad, good]);
    expect(parsed.map((p) => p.visual.id)).toEqual([good.id]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.id).toBe("bad");
    expect(errors[0]!.error).toMatch(/BAR_CHART props/);
  });

  it("rejects end <= start", () => {
    const r = parseVisual({ ...sampleVisual("CALLOUT"), start: 3, end: 3 });
    expect(r.ok).toBe(false);
  });
});

describe("timing", () => {
  it("frame window uses the renderer's rounding and caps transitions at 40%", () => {
    expect(visualFrameWindow({ start: 1.01, end: 3.49 }, 30)).toEqual({ from: 30, durationInFrames: 75, enterFrames: 21, exitFrames: 14 });
    const short = visualFrameWindow({ start: 0, end: 0.5 }, 30);
    expect(short.durationInFrames).toBe(15);
    expect(short.enterFrames).toBe(6);
    expect(short.exitFrames).toBe(6);
    expect(visualFrameWindow({ start: 2, end: 4 }, 60).from).toBe(120);
  });

  it("is active on [start, end)", () => {
    expect(isVisualActive({ start: 1, end: 2 }, 1)).toBe(true);
    expect(isVisualActive({ start: 1, end: 2 }, 2)).toBe(false);
  });

  it("AUTO resolves per template; explicit wins", () => {
    expect(resolveTransition("KINETIC_TEXT", "enter", "AUTO")).toBe("BLUR");
    expect(resolveTransition("STAT_CARD", "enter", "AUTO")).toBe("SPRING");
    expect(resolveTransition("STAT_CARD", "exit", "SLIDE")).toBe("SLIDE");
  });

  it("stack count grows on a log scale and is bounded", () => {
    expect(stackCountFor(50)).toBe(1);
    expect(stackCountFor(25000)).toBe(5);
    expect(stackCountFor(1e6)).toBe(8);
    expect(stackCountFor(1e12)).toBe(9);
  });
});

describe("placement", () => {
  const canvas = { width: 1080, height: 1920 };
  it("centers the designed box on placement x/y at scale", () => {
    const b = placementBox("STAT_CARD", { x: 0.5, y: 0.3, scale: 1 }, canvas);
    expect(b.clamped).toBe(false);
    expect(b.cx).toBeCloseTo(540);
    expect(b.cy).toBeCloseTo(576);
    expect(b.width).toBe(840);
    expect(b.left).toBeCloseTo(120);
  });

  it("nudges boxes back inside the safe margin and says so", () => {
    const b = placementBox("STAT_CARD", { x: 0.05, y: 0.02, scale: 1 }, canvas);
    expect(b.clamped).toBe(true);
    expect(b.left).toBeCloseTo(PLACEMENT_MARGIN);
    expect(b.top).toBeCloseTo(PLACEMENT_MARGIN);
  });

  it("shrinks boxes larger than the canvas", () => {
    const b = placementBox("COMPARISON", { x: 0.5, y: 0.5, scale: 2.5 }, canvas);
    expect(b.clamped).toBe(true);
    expect(b.width).toBeLessThanOrEqual(1080 - 2 * PLACEMENT_MARGIN + 1e-6);
  });

  it("scales with the canvas short side; TITLE_CARD is full frame", () => {
    const b = placementBox("NUMBER_COUNTER", { x: 0.5, y: 0.5, scale: 1 }, { width: 720, height: 1280 });
    expect(b.scale).toBeCloseTo(720 / 1080);
    expect(placementBox("TITLE_CARD", { x: 0.1, y: 0.1, scale: 2 }, canvas)).toMatchObject({ left: 0, top: 0, width: 1080, height: 1920 });
  });

  it("sample visuals validate against the contract schema", () => {
    for (const t of MOTION_TEMPLATES) expect(TimelineVisualSchema.safeParse(sampleVisual(t)).success, t).toBe(true);
  });
});
