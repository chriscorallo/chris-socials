import { GraphicPropsSchema, footprintOf, presetById, type GraphicPreset, type MotionTemplate, type TimelineVisual } from "@chris/media/timeline";

/**
 * Sample props per template — used by the per-template Preview compositions, the showcase
 * render (quality loop) and tests. Illustrative copy only; real visuals come from the
 * fact-checked script via the Motion Designer.
 */
export const SAMPLE_PROPS: Record<MotionTemplate, Record<string, unknown>> = {
  KINETIC_TEXT: { text: "Your savings rate matters more than your salary", emphasis: ["savings", "rate"], style: "PUNCH" },
  NUMBER_COUNTER: { value: 1247, prefix: "$", suffix: "", label: "Saved per month" },
  STAT_CARD: { value: "7.2%", label: "Average market return", sublabel: "S&P 500, inflation-adjusted", trend: "UP" },
  BAR_CHART: {
    title: "Where the money goes",
    bars: [
      { label: "Rent", value: 1800 },
      { label: "Food", value: 650 },
      { label: "Car", value: 520 },
      { label: "Fun", value: 300 },
    ],
    unit: "$",
    highlightIndex: 0,
    depth3d: false,
  },
  LINE_CHART: {
    title: "$500/mo invested at 7%",
    points: [
      { label: "Y0", value: 0 },
      { label: "Y5", value: 35796 },
      { label: "Y10", value: 86542 },
      { label: "Y15", value: 158481 },
      { label: "Y20", value: 260464 },
      { label: "Y25", value: 405036 },
      { label: "Y30", value: 609985 },
    ],
    unit: "$",
    highlightLast: true,
  },
  COMPARISON: {
    left: { label: "Renting", value: "$2,100" },
    right: { label: "Owning", value: "$2,940" },
    verdict: "Monthly cost, year one",
    winner: "LEFT",
  },
  PERCENT_RING: { percent: 68, label: "of Americans live paycheck to paycheck" },
  LIST_STEPS: {
    title: "Build your safety net",
    items: ["Save one month of expenses", "Kill high-interest debt", "Grow to six months", "Automate it"],
    style: "NUMBERED",
  },
  ICON_3D: { icon: "COIN", caption: "Compound interest" },
  MONEY_STACK_3D: { amount: 25000, label: "Emergency fund goal" },
  CALLOUT: { text: "This is the fee", pointTo: { x: 0.7, y: 0.62 } },
  TIMELINE: {
    events: [
      { label: "Age 25", sub: "Start investing $300/mo" },
      { label: "Age 35", sub: "Portfolio passes $50k" },
      { label: "Age 45", sub: "Compounding takes over" },
      { label: "Age 65", sub: "Retire with $790k" },
    ],
  },
  DEFINITION: {
    term: "Expense ratio",
    definition: "The yearly fee a fund charges, as a percent of what you have invested in it.",
  },
  TITLE_CARD: { title: "The 50/30/20 Rule", subtitle: "Chapter two" },
  // Chris's own example (the library's flagship preset): Employee · Freelance · Business owner.
  GRAPHIC: GraphicPropsSchema.parse(presetById("income-3-people-12-months")!.props),
};

/** Sensible default placement per template for previews/showcase. */
export const SAMPLE_PLACEMENT: Record<MotionTemplate, { x: number; y: number; scale: number }> = {
  KINETIC_TEXT: { x: 0.5, y: 0.3, scale: 1 },
  NUMBER_COUNTER: { x: 0.5, y: 0.3, scale: 1 },
  STAT_CARD: { x: 0.5, y: 0.3, scale: 1 },
  BAR_CHART: { x: 0.5, y: 0.33, scale: 1 },
  LINE_CHART: { x: 0.5, y: 0.32, scale: 1 },
  COMPARISON: { x: 0.5, y: 0.3, scale: 1 },
  PERCENT_RING: { x: 0.5, y: 0.3, scale: 1 },
  LIST_STEPS: { x: 0.5, y: 0.32, scale: 1 },
  ICON_3D: { x: 0.5, y: 0.3, scale: 1 },
  MONEY_STACK_3D: { x: 0.5, y: 0.32, scale: 1 },
  CALLOUT: { x: 0.36, y: 0.42, scale: 1 },
  TIMELINE: { x: 0.5, y: 0.32, scale: 1 },
  DEFINITION: { x: 0.5, y: 0.3, scale: 1 },
  TITLE_CARD: { x: 0.5, y: 0.5, scale: 1 },
  GRAPHIC: { x: 0.5, y: 0.5, scale: 1 },
};

export function sampleVisual(template: MotionTemplate, start = 0, end = 4, overrides: Partial<TimelineVisual> = {}): TimelineVisual {
  return {
    id: `sample-${template.toLowerCase()}`,
    template,
    props: SAMPLE_PROPS[template],
    start,
    end,
    placement: { mode: "MANUAL", ...SAMPLE_PLACEMENT[template] },
    palette: "BRAND",
    enter: "AUTO",
    exit: "AUTO",
    enterSfx: "WHOOSH",
    anchorText: null,
    depth: "FRONT",
    anchor: { type: "SCREEN", offsetX: 0, offsetY: -0.25 },
    cameraCoupling: 0,
    integration: { shadow: true, lightWrap: false, sceneMatch: true },
    emphasisAt: null,
    ...overrides,
  };
}

/** Full contract props for a library preset (GRAPHIC props parsed with every default filled). */
export function presetVisualProps(p: GraphicPreset): Record<string, unknown> {
  const props = structuredClone(p.props);
  return p.template === "GRAPHIC" ? (GraphicPropsSchema.parse(props) as unknown as Record<string, unknown>) : props;
}

/** A library preset as a visual (previews, posters, the contact sheet, tests). */
export function presetVisual(p: GraphicPreset, start = 0, end = p.seconds, overrides: Partial<TimelineVisual> = {}): TimelineVisual {
  const props = presetVisualProps(p);
  const fp = footprintOf(p.template, props);
  const base = sampleVisual(p.template, start, end);
  return {
    ...base,
    id: `preset-${p.id}`,
    props,
    placement: { mode: "MANUAL", x: p.placement?.x ?? 0.5, y: p.placement?.y ?? (fp.kind === "FULL_FRAME" ? 0.5 : SAMPLE_PLACEMENT[p.template].y), scale: p.placement?.scale ?? 1 },
    palette: p.palette ?? "BRAND",
    enterSfx: p.enterSfx === undefined ? "WHOOSH" : p.enterSfx,
    ...overrides,
  };
}
