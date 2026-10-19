import { z } from "zod";
import { GraphicPropsSchema } from "./graphics/contract";

/**
 * Motion graphics + sound design contract (PURE — browser-safe; no Node/Remotion imports).
 *
 * A `TimelineVisual` is an animated explainer graphic placed on the OUTPUT timeline over the
 * talking-head video: counting numbers, charts (2D/3D), comparisons, kinetic text, 3D objects,
 * cinematic title cards, callouts. Each visual is one TEMPLATE with typed `props`; the
 * motion package (packages/motion, Remotion + three.js) renders every template to a
 * transparent layer that the ffmpeg renderer composites over the edit. The AI Motion Designer
 * proposes visuals from the transcript; Chris edits them in the finishing editor.
 *
 * Factual rule (CLAUDE.md, spec §5 hard gates): any number/claim shown in a visual must come
 * from the fact-checked script/research — the Motion Designer is validated against that, and
 * the Quality Gate's FACTUAL check covers on-screen numbers too.
 *
 * Placement: `placement.x/y` (element CENTER, canvas fractions) and `scale` are always
 * concrete so preview and render agree. `mode: "AUTO"` means the placement engine may
 * re-solve them from the subject track (where Chris's face/body is) + captions/text/safe
 * zones before rendering; "MANUAL" means Chris positioned it and it is never moved.
 */

export const MOTION_TEMPLATES = [
  "KINETIC_TEXT",
  "NUMBER_COUNTER",
  "STAT_CARD",
  "BAR_CHART",
  "LINE_CHART",
  "COMPARISON",
  "PERCENT_RING",
  "LIST_STEPS",
  "ICON_3D",
  "MONEY_STACK_3D",
  "CALLOUT",
  "TIMELINE",
  "DEFINITION",
  "TITLE_CARD",
  /** The composable graphics system (graphics/contract.ts): any of the ~28 parametric base
   * components with fully data-driven props; the 150+ library presets are values of it. */
  "GRAPHIC",
] as const;
export type MotionTemplate = (typeof MOTION_TEMPLATES)[number];

const Label = z.string().min(1).max(60);
const Short = z.string().min(1).max(120);

/** Per-template props. Arrays are bounded so every layout is designable. */
export const MotionPropsSchemas = {
  /** Kinetic typography: the phrase builds word by word; `emphasis` words hit harder (scale, accent color). */
  KINETIC_TEXT: z.object({
    text: Short,
    emphasis: z.array(z.string().min(1).max(30)).max(4).default([]),
    style: z.enum(["PUNCH", "TYPEWRITER", "SLIDE_UP"]).default("PUNCH"),
  }),
  /** A number that counts up (or down) to `value`, with glow and a label. */
  NUMBER_COUNTER: z.object({
    value: z.number(),
    from: z.number().default(0),
    prefix: z.string().max(4).default(""),
    suffix: z.string().max(6).default(""),
    decimals: z.number().int().min(0).max(2).default(0),
    label: Label.nullable().default(null),
  }),
  /** A premium glass card with a big value and context. */
  STAT_CARD: z.object({
    value: z.string().min(1).max(16),
    label: Label,
    sublabel: Label.nullable().default(null),
    trend: z.enum(["UP", "DOWN", "NONE"]).default("NONE"),
  }),
  BAR_CHART: z.object({
    title: Label.nullable().default(null),
    bars: z.array(z.object({ label: z.string().min(1).max(16), value: z.number() })).min(2).max(6),
    unit: z.string().max(6).default(""),
    highlightIndex: z.number().int().min(0).max(5).nullable().default(null),
    depth3d: z.boolean().default(false),
  }),
  /** Growth/decline curve that draws itself (e.g. compound interest). */
  LINE_CHART: z.object({
    title: Label.nullable().default(null),
    points: z.array(z.object({ label: z.string().min(1).max(10), value: z.number() })).min(2).max(12),
    unit: z.string().max(6).default(""),
    highlightLast: z.boolean().default(true),
  }),
  /** Side-by-side A vs B. */
  COMPARISON: z.object({
    left: z.object({ label: Label, value: z.string().min(1).max(16) }),
    right: z.object({ label: Label, value: z.string().min(1).max(16) }),
    verdict: Label.nullable().default(null),
    winner: z.enum(["LEFT", "RIGHT", "NONE"]).default("NONE"),
  }),
  PERCENT_RING: z.object({ percent: z.number().min(0).max(100), label: Label }),
  LIST_STEPS: z.object({
    title: Label.nullable().default(null),
    items: z.array(z.string().min(1).max(48)).min(2).max(5),
    style: z.enum(["NUMBERED", "CHECK"]).default("NUMBERED"),
  }),
  /** A modeled 3D object that animates in (spin/float/settle) — real geometry + lighting. */
  ICON_3D: z.object({
    icon: z.enum(["COIN", "CREDIT_CARD", "HOUSE", "PIGGY_BANK", "CHART_UP", "CALENDAR", "LOCK", "PHONE", "BRIEFCASE", "GRADUATION_CAP", "TROPHY", "ROCKET", "LIGHTBULB", "BRAIN", "GIFT", "KEY", "MAGNIFIER", "MEGAPHONE", "CROWN", "FIRE", "LIGHTNING", "TARGET", "LAPTOP", "CAR", "DIAMOND", "WALLET", "BANK"]),
    caption: Label.nullable().default(null),
  }),
  /** 3D bill stacks that grow to represent an amount. */
  MONEY_STACK_3D: z.object({ amount: z.number().positive(), label: Label.nullable().default(null) }),
  /** Arrow/line + label pointing at a spot on screen (canvas fractions). */
  CALLOUT: z.object({ text: z.string().min(1).max(40), pointTo: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }) }),
  TIMELINE: z.object({
    events: z.array(z.object({ label: z.string().min(1).max(16), sub: z.string().max(40).nullable().default(null) })).min(2).max(5),
  }),
  DEFINITION: z.object({ term: Label, definition: z.string().min(1).max(140) }),
  /** Cinematic full-frame chapter/title moment (background softly blurred/dimmed). */
  TITLE_CARD: z.object({ title: Short, subtitle: Label.nullable().default(null) }),
  /** Composable graphic: base component + universal data model (graphics/contract.ts). */
  GRAPHIC: GraphicPropsSchema,
} satisfies Record<MotionTemplate, z.ZodTypeAny>;

export type MotionProps<T extends MotionTemplate> = z.infer<(typeof MotionPropsSchemas)[T]>;

export const VISUAL_TRANSITIONS = ["AUTO", "FADE", "SCALE", "SLIDE", "BLUR", "SPRING"] as const;
export const SFX_SOUNDS = ["WHOOSH", "SWOOSH_UP", "SOFT_POP", "CLICK", "TICK", "RISER", "IMPACT", "SHIMMER", "CASH"] as const;
export type SfxSound = (typeof SFX_SOUNDS)[number];

export const TimelineVisualSchema = z.object({
  id: z.string().min(1),
  template: z.enum(MOTION_TEMPLATES),
  /** Validated per template with MotionPropsSchemas[template] (see parseVisualProps). */
  props: z.record(z.string(), z.unknown()),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  placement: z.object({
    mode: z.enum(["AUTO", "MANUAL"]).default("AUTO"),
    x: z.number().min(0).max(1).default(0.5),
    y: z.number().min(0).max(1).default(0.3),
    /** 1 = the template's designed size for a 1080x1920 canvas. */
    scale: z.number().min(0.3).max(2.5).default(1),
  }),
  /** Brand palette by default; "MONO" for restraint, "VIVID" for energy. */
  palette: z.enum(["BRAND", "MONO", "VIVID"]).default("BRAND"),
  enter: z.enum(VISUAL_TRANSITIONS).default("AUTO"),
  exit: z.enum(VISUAL_TRANSITIONS).default("AUTO"),
  /** Sound on entrance (null = none). Exits are silent by default (restraint). */
  enterSfx: z.enum(SFX_SOUNDS).nullable().default("WHOOSH"),
  /** Why this visual is here — shown to Chris; the transcript phrase it illustrates. */
  anchorText: z.string().max(200).nullable().default(null),

  // --- Interaction with the footage (v2, 2026-10-17) — all optional with neutral defaults so
  // v1 visuals render exactly as before. Engines: person matte (depth), subject track (anchor),
  // the timeline's zooms (camera), scene sampling (integration). See motion-contract notes.
  /** "BEHIND_SUBJECT" composites the graphic between the background and Chris (using a
   * per-frame person matte) — the "text behind the head" depth look. */
  depth: z.enum(["FRONT", "BEHIND_SUBJECT"]).default("FRONT"),
  /** "SUBJECT" makes the graphic follow Chris's head over time (offset in canvas fractions
   * from the head center); "SCREEN" keeps placement fixed. */
  anchor: z
    .object({ type: z.enum(["SCREEN", "SUBJECT"]).default("SCREEN"), offsetX: z.number().min(-1).max(1).default(0), offsetY: z.number().min(-1).max(1).default(-0.25) })
    .default({ type: "SCREEN", offsetX: 0, offsetY: -0.25 }),
  /** How much the graphic rides the edit's camera moves (zooms/punch-ins): 0 = fixed to screen,
   * 1 = locked to the footage; in between = parallax depth. */
  cameraCoupling: z.number().min(0).max(1).default(0),
  /** Scene integration: soft contact/drop shadow onto the footage, edge light-wrap from the
   * footage's colors, and auto-matching of card tint/contrast to what's behind it. */
  integration: z
    .object({ shadow: z.boolean().default(true), lightWrap: z.boolean().default(false), sceneMatch: z.boolean().default(true) })
    .default({ shadow: true, lightWrap: false, sceneMatch: true }),
  /** Hit timing: land the key moment (counter finish, bar peak, word punch) on the speaker's
   * vocal emphasis nearest to this many seconds after `start` (null = template default). */
  emphasisAt: z.number().nonnegative().nullable().default(null),
});
export type TimelineVisual = z.infer<typeof TimelineVisualSchema>;

/** Neutral v2 interaction fields — spread into hand-built visuals so they behave like v1. */
export const VISUAL_INTERACTION_DEFAULTS = {
  depth: "FRONT",
  anchor: { type: "SCREEN", offsetX: 0, offsetY: -0.25 },
  cameraCoupling: 0,
  integration: { shadow: true, lightWrap: false, sceneMatch: true },
  emphasisAt: null,
} as const satisfies Pick<TimelineVisual, "depth" | "anchor" | "cameraCoupling" | "integration" | "emphasisAt">;

/**
 * Per-video motion theme — chosen by the Motion Designer from the topic (debt ≠ investing ≠
 * lifestyle) so each video has a coherent look and feel instead of one house style for all.
 */
export const MOTION_LANGUAGES = ["CALM", "CRISP", "PUNCHY", "CINEMATIC", "PLAYFUL"] as const;
export const MotionThemeSchema = z.object({
  /** Short human name, e.g. "Debt pressure", "Compounding growth". */
  name: z.string().min(1).max(40),
  motionLanguage: z.enum(MOTION_LANGUAGES).default("CRISP"),
  /** Overrides on top of the chosen palette (#RRGGBB). */
  primary: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  /** Iconography/illustration family for 3D + icons. */
  iconStyle: z.enum(["GOLD_METAL", "SOFT_CLAY", "GLASS", "LINE"]).default("GOLD_METAL"),
  /** Why this theme fits the topic (shown to Chris). */
  rationale: z.string().max(200).nullable().default(null),
});
export type MotionTheme = z.infer<typeof MotionThemeSchema>;

/** Free-standing sound effects on the OUTPUT timeline (visual entrance SFX are implicit). */
export const TimelineSfxSchema = z.object({
  id: z.string().min(1),
  at: z.number().nonnegative(),
  sound: z.enum(SFX_SOUNDS),
  /** Linear gain 0..1 relative to the house mix level. */
  volume: z.number().min(0).max(1).default(0.6),
});
export type TimelineSfx = z.infer<typeof TimelineSfxSchema>;

/** Background music bed, ducked under speech. `musicAssetId` = a MediaAsset of kind MUSIC. */
export const TimelineMusicSchema = z.object({
  musicAssetId: z.string().min(1),
  /** Offset into the track (seconds) where the video's start lands. */
  trackStart: z.number().nonnegative().default(0),
  /** Bed level when nobody is talking, in dB relative to the voice target (e.g. -18). */
  levelDb: z.number().min(-40).max(0).default(-18),
  /** Extra reduction while speech is present (sidechain), dB. */
  duckDb: z.number().min(0).max(30).default(10),
  fadeInSeconds: z.number().min(0).max(5).default(0.6),
  fadeOutSeconds: z.number().min(0).max(8).default(1.5),
});
export type TimelineMusic = z.infer<typeof TimelineMusicSchema>;

export function parseVisualProps<T extends MotionTemplate>(template: T, props: unknown): MotionProps<T> {
  return MotionPropsSchemas[template].parse(props) as MotionProps<T>;
}

/** Brand palette tokens shared by templates, preview and render. */
export const MOTION_PALETTES = {
  BRAND: { primary: "#FFD54A", secondary: "#A78BFA", ink: "#FFFFFF", muted: "#C9C9D1", glass: "#0E0E14B8", positive: "#6EE7B0", negative: "#FB7185" },
  MONO: { primary: "#FFFFFF", secondary: "#D4D4D8", ink: "#FFFFFF", muted: "#A1A1AA", glass: "#0A0A0ACC", positive: "#FFFFFF", negative: "#FFFFFF" },
  VIVID: { primary: "#FACC15", secondary: "#38BDF8", ink: "#FFFFFF", muted: "#E4E4E7", glass: "#111827C2", positive: "#34D399", negative: "#F43F5E" },
} as const;
