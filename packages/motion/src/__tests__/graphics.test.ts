import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_GRAPHIC_ANIMATION,
  GRAPHIC_COMPONENTS,
  GRAPHIC_PRESETS,
  GraphicPropsSchema,
  MOTION_LANGUAGES,
  type GraphicProps,
} from "@chris/media/timeline";
import { GraphicTemplate, graphicComponentFor } from "../remotion/graphics/Graphic";
import { elementExitProgress, emphasisFrame, graphicSequence, listSequence } from "../graphics-timing";
import { MOTION_FEELS, resolveMotionStyle } from "../style";
import { designSizeOf, isFullFrameVisual, parseVisual, placementBox, visualFrameWindow } from "../timing";
import { presetVisual } from "../samples";

const canvas = { width: 1080, height: 1920 };

function renderAt(props: GraphicProps, frac: number, seconds = 4, feel = MOTION_FEELS.CRISP, hitAtFrame: number | null = null): string {
  const v = presetVisual({ id: "t", name: "t", description: "", category: "MONEY", tags: [], template: "GRAPHIC", props: props as unknown as Record<string, unknown>, seconds }, 0, seconds);
  const win = visualFrameWindow(v, 30);
  const ms = resolveMotionStyle(v, null);
  return renderToStaticMarkup(
    createElement(GraphicTemplate, {
      props,
      palette: ms.palette,
      feel,
      iconStyle: ms.iconStyle,
      frame: Math.round(win.durationInFrames * frac),
      fps: 30,
      durationInFrames: win.durationInFrames,
      enterFrames: win.enterFrames,
      exitFrames: win.exitFrames,
      box: placementBox("GRAPHIC", v.placement, canvas, props),
      canvas,
      hitAtFrame,
    }),
  );
}

describe("graphic sequencing (pure)", () => {
  const anim = { ...DEFAULT_GRAPHIC_ANIMATION };
  it("GROUP_BY_GROUP: each group starts after the previous one finished, plus the pause", () => {
    const s = graphicSequence([3, 3], { ...anim, order: "GROUP_BY_GROUP", stagger: 0.1, groupPause: 0.3 }, { fps: 30, durationInFrames: 600, exitFrames: 14 });
    expect(s.at(0, 1) - s.at(0, 0)).toBe(3);
    expect(s.at(1, 0)).toBe(s.at(0, 2) + s.len + 9);
    expect(s.count).toBe(6);
    expect(s.flat(1, 2)).toBe(5);
  });
  it("TOGETHER starts everything at once; ONE_BY_ONE never overlaps more than a quarter", () => {
    const t = graphicSequence([4], { ...anim, order: "TOGETHER" }, { fps: 30, durationInFrames: 300, exitFrames: 14 });
    expect(new Set([0, 1, 2, 3].map((i) => t.at(0, i))).size).toBe(1);
    const o = listSequence(4, { ...anim, order: "ONE_BY_ONE", stagger: 0 }, { fps: 30, durationInFrames: 600, exitFrames: 14 });
    expect(o.at(0, 1) - o.at(0, 0)).toBeGreaterThanOrEqual(Math.floor(o.len * 0.75));
  });
  it("always fits: a long build is compressed to finish before the exit with a hold", () => {
    const D = 120;
    const s = graphicSequence([12, 12, 12], { ...anim, order: "GROUP_BY_GROUP", stagger: 0.2, groupPause: 1 }, { fps: 30, durationInFrames: D, exitFrames: 14 });
    expect(s.done).toBeLessThanOrEqual(D - 14 - 18 + 1);
    expect(s.at(2, 11)).toBeGreaterThan(s.at(0, 0));
    // monotone in reading order
    let prev = -1;
    for (let g = 0; g < 3; g++) for (let i = 0; i < 12; i++) {
      expect(s.at(g, i)).toBeGreaterThanOrEqual(prev);
      prev = s.at(g, i);
    }
  });
  it("emphasis waits for the speaker's hit but never fires before the reveal", () => {
    expect(emphasisFrame(40, null)).toBe(42);
    expect(emphasisFrame(40, 70)).toBe(70);
    expect(emphasisFrame(40, 20)).toBe(42);
  });
  it("element exits run in the last ~0.6 s, REVERSE last-in first-out", () => {
    const o = { fps: 30, durationInFrames: 120 };
    expect(elementExitProgress("CONTAINER", 119, 0, 3, o)).toBe(0);
    expect(elementExitProgress("REVERSE", 60, 0, 3, o)).toBe(0);
    expect(elementExitProgress("REVERSE", 112, 2, 3, o)).toBeGreaterThan(elementExitProgress("REVERSE", 112, 0, 3, o));
    expect(elementExitProgress("DROP", 119, 2, 3, o)).toBeGreaterThan(0);
  });
});

describe("every base component + every preset renders (headless, no Remotion runtime)", () => {
  it("has an implementation for every base component", () => {
    for (const c of GRAPHIC_COMPONENTS) expect(graphicComponentFor(c), c).not.toBeNull();
  });
  const graphics = GRAPHIC_PRESETS.filter((p) => p.template === "GRAPHIC");
  it.each(graphics.map((p) => [p.id, p] as const))("%s renders at entrance, mid, settled and exit", (_, p) => {
    const props = GraphicPropsSchema.parse(p.props);
    for (const frac of [0, 0.15, 0.5, 0.8, 0.99]) {
      const html = renderAt(props, frac, p.seconds);
      expect(html.length, `${p.id}@${frac}`).toBeGreaterThan(100);
      expect(html, `${p.id}@${frac}`).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
  it("renders under every motion language and with a speaker hit", () => {
    const props = GraphicPropsSchema.parse(GRAPHIC_PRESETS.find((p) => p.id === "income-3-people-12-months")!.props);
    for (const l of MOTION_LANGUAGES) expect(renderAt(props, 0.6, 9, MOTION_FEELS[l], 120)).not.toMatch(/NaN/);
  });
  it("survives edge data: zeros, all negatives, a single value, long labels", () => {
    const cases: Array<Record<string, unknown>> = [
      { component: "VALUE_COLUMNS", series: [{ label: "A", values: [0] }] },
      { component: "VALUE_COLUMNS", series: [{ label: "Business owner (LLC) co", values: [-1, -2, -3] }, { label: "B", values: [0, 0, 0] }], variant: "BARS", showTotal: true },
      { component: "MONTH_GRID", series: [{ label: "x", values: [-5] }], showTotal: true },
      { component: "BAR_GROUP", series: [{ label: "x", values: [0, 0] }], categories: ["a", "b"] },
      { component: "BAR_GROUP", series: [{ label: "x", values: [-3, -9] }], categories: ["a", "b"], variant: "STACKED" },
      { component: "LINE_AREA", series: [{ label: "x", values: [5, 5] }] },
      { component: "WATERFALL", series: [{ label: "x", values: [0, 0] }], showTotal: true },
      { component: "DONUT", items: [{ text: "a", value: 0 }, { text: "b", value: 0 }] },
      { component: "GAUGE", items: [{ text: "", value: 2000 }] },
      { component: "PROGRESS", items: [{ text: "over", value: 180 }] },
      { component: "SCATTER", series: [{ label: "x", values: [1, 1] }, { label: "y", values: [1, 1] }] },
      { component: "TABLE", series: [{ label: "r", values: [1] }], categories: ["c"] },
      { component: "STEPS", items: [{ text: "a" }, { text: "b" }], variant: "ROADMAP" },
      { component: "RANKING", items: [{ text: "a" }, { text: "b" }], variant: "BARS" },
      { component: "FORMULA", items: [{ text: "a", value: 1 }, { text: "b", value: 2, op: "EQUALS" }] },
      { component: "KINETIC", body: "x" },
      { component: "STICKER", title: "OK", items: [] },
      { component: "ICON_BURST", title: "x", items: [{ text: "", icon: "COIN" }] },
      { component: "TRANSITION", title: null, variant: "SLAM" },
    ];
    for (const c of cases) {
      const props = GraphicPropsSchema.parse(c);
      for (const frac of [0.1, 0.6]) expect(renderAt(props, frac), JSON.stringify(c)).not.toMatch(/NaN|Infinity/);
    }
  });
});

describe("timing + placement for GRAPHIC visuals", () => {
  it("design size follows the data; full-screen scenes fill the frame", () => {
    const p = GRAPHIC_PRESETS.find((x) => x.id === "income-3-people-12-months")!;
    const v = presetVisual(p);
    expect(isFullFrameVisual("GRAPHIC", v.props)).toBe(true);
    expect(placementBox("GRAPHIC", v.placement, canvas, v.props)).toMatchObject({ left: 0, top: 0, width: 1080, height: 1920 });
    const overlay = { ...v.props, screen: "OVERLAY" };
    const box = placementBox("GRAPHIC", { x: 0.5, y: 0.4, scale: 1 }, canvas, overlay);
    expect(box.width).toBe(designSizeOf("GRAPHIC", overlay).width);
    expect(parseVisual(v).ok).toBe(true);
  });
  it("invalid GRAPHIC props are reported, never rendered wrong", () => {
    const v = presetVisual(GRAPHIC_PRESETS.find((x) => x.id === "hero-salary")!);
    const r = parseVisual({ ...v, props: { component: "DONUT", items: [] } });
    expect(r.ok).toBe(false);
  });
});

describe("money math is never wrong on screen (live finding 2026-10-19: formulas counted through wrong sums)", () => {
  const strip = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\s+/g, " ");
  // [preset, the correct answer, intermediates the 34 % frame used to show]
  const checks: Array<[string, string, string[]]> = [
    ["formula-take-home", "$51k", ["$47k", "$43k", "$35k"]],
    ["paycheck-receipt", "$2,300", ["$1,853", "$1,500", "$900"]],
    ["formula-net-worth", "$138k", ["$131k", "$120k"]],
    ["formula-contributions", "$180k", ["$164k", "$150k"]],
    ["formula-side-hustle", "$1,000", ["$913", "$800"]],
  ];
  it.each(checks)("%s shows only %s as the answer, never a counted intermediate", (id, final, wrong) => {
    const preset = GRAPHIC_PRESETS.find((p) => p.id === id)!;
    const props = GraphicPropsSchema.parse(preset.props);
    let seenFinal = false;
    for (let frac = 0.02; frac < 0.96; frac += 0.02) {
      const t = strip(renderAt(props, frac, preset.seconds));
      if (t.includes(final)) seenFinal = true;
      for (const w of wrong) expect(t, `${id}@${frac.toFixed(2)}`).not.toContain(w);
    }
    expect(seenFinal, id).toBe(true);
  });
});
