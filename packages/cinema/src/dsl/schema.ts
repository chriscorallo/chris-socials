import { z } from "zod";

/**
 * The mini-movie Story/Scene DSL (v1).
 *
 * film → scenes → shots. One film is ONE procedural 3D world (a "set" per scene) populated by a
 * cast of actors; shots are what the camera does, what the actors do and what is said while it
 * happens. Everything is data: an LLM (or Chris via ChatGPT copy-paste) can author it, `validateFilm`
 * explains every mistake in plain words, and the renderer is a pure function of (film, timing,
 * frame).
 *
 * Units: meters, degrees, seconds. Y is up. The stage floor is y = 0.
 *
 * Timing: a shot with a `line` lasts as long as its narration takes to say (+ `hold`); a shot
 * without one needs `duration`. Anything inside a shot that happens "when" uses an Anchor:
 *   - a number: seconds from the shot's start
 *   - "start" | "end"
 *   - { word: "raise" }  — the moment that word of the shot's `line` is spoken
 *     (occurrence: n-th time in the line; edge: start|end of the word; offset: ± seconds)
 *   - { fraction: 0.5 } — halfway through the shot
 */

export const CINEMA_DSL_VERSION = 1 as const;

const id = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,47}$/, "ids are lowercase letters/digits/_/- and start with a letter (e.g. \"raise_stack\")");

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

export const WordAnchorSchema = z
  .object({
    word: z.string().min(1),
    occurrence: z.number().int().min(1).optional(),
    edge: z.enum(["start", "end"]).optional(),
    offset: z.number().min(-5).max(5).optional(),
  })
  .strict();

export const AnchorSchema = z.union([
  z.number().min(0),
  z.enum(["start", "end"]),
  WordAnchorSchema,
  z.object({ fraction: z.number().min(0).max(1) }).strict(),
]);
export type Anchor = z.infer<typeof AnchorSchema>;
export type WordAnchor = z.infer<typeof WordAnchorSchema>;

export const EASES = ["CINEMATIC", "EASE_IN_OUT", "EASE_OUT", "EASE_IN", "LINEAR", "SNAP", "SPRING"] as const;
export const EaseSchema = z.enum(EASES);
export type Ease = z.infer<typeof EaseSchema>;

// ---------------------------------------------------------------------------------------------
// Looks, sets, lighting, post

/** Signature looks — Chris's brand worlds. See src/looks.ts for what each one sets. */
export const LOOKS = ["GOLD_STUDIO", "NOIR_NUMBERS"] as const;
export const LookSchema = z.enum(LOOKS);
export type Look = z.infer<typeof LookSchema>;

/** INFINITY_STUDIO = dark product-photo studio; NUMBERS_VOID = teal digits void; CITY_NIGHT = the
 * studio floor with a distant procedural skyline; ROOM = a minimal interior (back wall, window
 * light); HORIZON = an open plain with a glowing horizon (futures, paths, journeys). */
export const SET_KINDS = ["INFINITY_STUDIO", "NUMBERS_VOID", "CITY_NIGHT", "ROOM", "HORIZON"] as const;
export const SetSchema = z
  .object({
    kind: z.enum(SET_KINDS),
    /** Floor reflectivity 0..1 (glossy studio floor). */
    floorGloss: z.number().min(0).max(1).optional(),
    /** Atmospheric haze 0..1 (depth cue; cheap exponential fog). */
    haze: z.number().min(0).max(1).optional(),
    /** Floating dust / embers in the air, 0..1. */
    particles: z.number().min(0).max(1).optional(),
  })
  .strict();
export type SetSpec = z.infer<typeof SetSchema>;

export const LIGHTING_PRESETS = ["KEY_RIM", "TOP_SPOT", "LOW_DRAMA", "SOFT_DAWN", "BLACKOUT_SPOT"] as const;
export const LightingSchema = z
  .object({
    preset: z.enum(LIGHTING_PRESETS),
    /** Overall exposure multiplier 0.2..2. */
    intensity: z.number().min(0.2).max(2).optional(),
    /** Actor the spot/key is aimed at (defaults to the camera target). */
    focusOn: id.optional(),
    /** Seconds the lights take to change into this preset at the shot start (default 0.6; 0 = hard cut). */
    blendSeconds: z.number().min(0).max(4).optional(),
  })
  .strict();
export type Lighting = z.infer<typeof LightingSchema>;

export const GRADES = ["WARM_GOLD", "TEAL_NIGHT", "NEUTRAL", "BLEACH"] as const;
export const PostSchema = z
  .object({
    bloom: z.number().min(0).max(3).optional(),
    /** Depth of field on/off (lens fStop + focus decide how strong). */
    dof: z.boolean().optional(),
    vignette: z.number().min(0).max(1).optional(),
    grain: z.number().min(0).max(1).optional(),
    grade: z.enum(GRADES).optional(),
    exposure: z.number().min(0.3).max(2.5).optional(),
    /** Lens chromatic fringing at the edges 0..1. */
    aberration: z.number().min(0).max(1).optional(),
    /** Letterbox bars 0..1 (fraction of a 2.39:1 crop); used sparingly for "movie" moments. */
    letterbox: z.number().min(0).max(1).optional(),
  })
  .strict();
export type PostSpec = z.infer<typeof PostSchema>;

// ---------------------------------------------------------------------------------------------
// Actors (procedural objects — no external models)

export const ACTOR_KINDS = [
  "COIN_STACK", // gold coins stacked level by level in a tight cluster; params.count (coins), params.columns (1 = a single tower)
  "PEDESTAL", // a plinth/podium; params.radius, params.height
  "BUILDING", // a miniature apartment block; params.floors, params.glow (window light 0..1)
  "CAR", // a stylized car; params.color
  "CARD", // a floating subscription/receipt card; params.label, params.price
  "CARD_FAN", // many small cards orbiting; params.count, params.labels
  "BASELINE", // a glowing horizontal plane/ring = "your baseline"; params.level (height), params.label
  "COIN_CHART", // a chart as a sculpture: columns of coins; params.values (coins per column), params.split (values of the lower "principal" part), params.progress 0..1 growth, params.spacing
  "NUMBER_WALL", // a wall of drifting glowing digits (NOIR world); params.density
  "LIGHT_SHAFT", // a volumetric-looking beam from above; params.width, params.strength
  // --- v1.1 vocabulary (additive; see src/catalog.ts for what each one means and when to use it)
  "FIGURE", // a faceless stylized mannequin person (~1.8 m); params.pose, params.color, params.height
  "CROWD", // many simple figures (instanced) + optional highlighted one; params.count, params.highlight
  "PLATFORM", // a solid slab/floor whose top sits at params.level — children (parent) ride on it
  "STAIRS", // a staircase climbing along +x; params.steps, params.rise, params.run
  "LADDER", // a vertical ladder; params.height, params.rungs
  "BALANCE", // a balance scale; params.tilt (-1 left down .. 1 right down), leftLabel/rightLabel, leftCount/rightCount
  "DOOR", // a door in a frame with light behind it; params.open 0..1, params.label
  "WALLS", // two walls closing in; params.closed 0..1, params.height
  "WHEEL", // a hamster wheel / treadmill drum; params.speed (turns/s, integrated), params.radius
  "SNOWBALL", // a gold snowball that grows as it rolls; params.growth 0..1
  "TREE", // a procedural tree whose branches grow and sprout gold coin-leaves; params.growth 0..1
  "BLOCKS", // cubes that keep doubling (1,2,4,8…); params.generations (float)
  "BUCKET", // a bucket filling with coins and leaking through holes; params.fill 0..1, params.leaks
  "HOURGLASS", // an hourglass; params.progress 0..1 (sand fallen)
  "CHAIN", // a chain of links across the frame that can snap; params.broken 0..1, params.links
  "FORK_PATH", // a road that splits into two futures; params.progress (light travelling), leftLabel/rightLabel, choose
  "MAGNIFIER", // a magnifying glass that reveals enlarged fine print; params.text, params.reveal 0..1
  "DOCUMENT", // a contract/statement page with lines and fine print; params.title, params.fine
  "RECEIPT", // a receipt that unrolls line by line; params.items ["Rent|$300"], params.unroll 0..1, params.total
  "CALENDAR", // a desk calendar whose pages flip; params.page (float), params.labels
  "GAUGE", // a dial meter; params.value 0..1, params.label
  "METER", // a glass tube/thermometer that fills; params.value 0..1, params.label
  "DIVIDER", // a glowing wall splitting the floor into BEFORE / AFTER halves; params.leftLabel/rightLabel
  "HOUSE", // a miniature house with lit windows; params.size, params.glow
  "PHONE", // a smartphone with a lit screen; params.text, params.sub
  "BANK_CARD", // an original (unbranded) bank card; params.label, params.last4, params.color
  "BAR_CHART", // 3D bar sculpture; params.values, params.labels, params.progress, params.highlight
  "LINE_CHART", // 3D ribbon line chart; params.values, params.progress
  "PIE_CHART", // extruded donut chart; params.values, params.labels, params.progress, params.explode
  "TEXT_3D", // text standing in the world (layered, extruded look); params.text, params.size, params.style
  "ARROW", // a 3D trend arrow; params.direction UP|DOWN, params.growth 0..1, params.length
] as const;
export const ActorKindSchema = z.enum(ACTOR_KINDS);
export type ActorKind = z.infer<typeof ActorKindSchema>;

export const ParamValueSchema = z.union([z.number(), z.string(), z.boolean(), z.array(z.union([z.string(), z.number()]))]);

export const ActorSchema = z
  .object({
    id,
    kind: ActorKindSchema,
    position: Vec3Schema.optional(),
    /** Euler degrees. */
    rotation: Vec3Schema.optional(),
    scale: z.number().positive().max(50).optional(),
    /** Visible at the film's start (default false: actors ENTER when the story needs them). */
    visible: z.boolean().optional(),
    params: z.record(z.string(), ParamValueSchema).optional(),
    /** Human note for authors/storyboards; ignored by the renderer. */
    note: z.string().max(200).optional(),
    /** Ride on another actor: position becomes relative to the parent's top surface (a PLATFORM's
     * level, a PEDESTAL's top…) and follows it when it moves or rises. No rotation inheritance. */
    parent: id.optional(),
  })
  .strict();
export type Actor = z.infer<typeof ActorSchema>;

export const ACTION_TYPES = [
  "ENTER", "EXIT", "MOVE", "TURN", "SCALE", "SET", "FLOW", "PULSE", "GLOW",
  // v1.1
  "SHIFT", "POSE", "WALK", "CLIMB", "PATH",
  "OPEN", "CLOSE", "FILL", "DRAIN", "GROW", "BREAK", "TIP", "FLIP", "UNROLL", "REVEAL", "RAISE", "LOWER", "SPIN",
] as const;
/** Semantic verbs: each drives the actor kind's own parameter (see VERB_TARGETS in src/kinds.ts). */
export const VERBS = ["OPEN", "CLOSE", "FILL", "DRAIN", "GROW", "BREAK", "TIP", "FLIP", "UNROLL", "REVEAL", "RAISE", "LOWER", "SPIN"] as const;
export type Verb = (typeof VERBS)[number];
export const FIGURE_POSES = ["STAND", "WALK", "RUN", "SIT", "CLIMB", "CHEER", "SLUMP", "THINK", "REACH", "PUSH", "CARRY", "POINT", "BALANCE"] as const;
export type FigurePose = (typeof FIGURE_POSES)[number];
export const ENTER_STYLES = ["RISE", "DROP", "GROW", "FADE", "BUILD"] as const;
export const EXIT_STYLES = ["DISSOLVE", "SINK", "SHRINK", "FADE", "SHATTER"] as const;

const actionBase = {
  actor: id,
  at: AnchorSchema,
  /** Seconds (default depends on the action: ENTER/EXIT 0.8, MOVE 1.2, PULSE 0.5 …). */
  duration: z.number().min(0).max(30).optional(),
  ease: EaseSchema.optional(),
};

export const ActionSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("ENTER"), style: z.enum(ENTER_STYLES).optional(), ...actionBase }).strict(),
  z.object({ do: z.literal("EXIT"), style: z.enum(EXIT_STYLES).optional(), ...actionBase }).strict(),
  z.object({ do: z.literal("MOVE"), to: Vec3Schema, ...actionBase }).strict(),
  z.object({ do: z.literal("TURN"), to: Vec3Schema, ...actionBase }).strict(),
  z.object({ do: z.literal("SCALE"), to: z.number().positive().max(50), ...actionBase }).strict(),
  /** Animate a numeric param (count, level, glow…) to a value; strings/bools switch at `at`. */
  z.object({ do: z.literal("SET"), param: z.string().min(1), to: ParamValueSchema, ...actionBase }).strict(),
  /** Stream `amount` units (coins) from this actor into another actor. */
  z.object({ do: z.literal("FLOW"), into: id, amount: z.number().positive(), ...actionBase }).strict(),
  z.object({ do: z.literal("PULSE"), strength: z.number().min(0).max(2).optional(), ...actionBase }).strict(),
  z.object({ do: z.literal("GLOW"), to: z.number().min(0).max(3), ...actionBase }).strict(),
  /** Move BY an offset (relative MOVE): "lift it 1.5 m" = by [0, 1.5, 0]. */
  z.object({ do: z.literal("SHIFT"), by: Vec3Schema, ...actionBase }).strict(),
  /** FIGURE/CROWD: blend into a pose. */
  z.object({ do: z.literal("POSE"), pose: z.enum(FIGURE_POSES), ...actionBase }).strict(),
  /** FIGURE: walk (or run) to a point, facing the way it goes; duration defaults to distance / pace. */
  z.object({ do: z.literal("WALK"), to: Vec3Schema, pace: z.number().min(0.3).max(6).optional(), run: z.boolean().optional(), ...actionBase }).strict(),
  /** FIGURE: climb a STAIRS or LADDER actor from `from` to `to` (0 = bottom, 1 = top). */
  z.object({ do: z.literal("CLIMB"), on: id, from: z.number().min(0).max(1).optional(), to: z.number().min(0).max(1).optional(), ...actionBase }).strict(),
  /** Any actor: travel a smooth path through points (world coords). `orient` turns it to face the way it moves. */
  z.object({ do: z.literal("PATH"), points: z.array(Vec3Schema).min(1).max(24), orient: z.boolean().optional(), ...actionBase }).strict(),
  /** Semantic verbs (OPEN a door, FILL a gauge, BREAK a chain, RAISE a platform…): drive the kind's own
   * parameter to `to` (or the verb's natural default — see VERB_TARGETS in src/kinds.ts). */
  z.object({ do: z.enum(["OPEN", "CLOSE", "FILL", "DRAIN", "GROW", "BREAK", "TIP", "FLIP", "UNROLL", "REVEAL", "RAISE", "LOWER", "SPIN"]), to: z.number().min(-1000).max(1000).optional(), ...actionBase }).strict(),
]);
export type Action = z.infer<typeof ActionSchema>;

// ---------------------------------------------------------------------------------------------
// Camera

export const CAMERA_RIGS = ["HOLD", "DOLLY", "PUSH_IN", "PULL_OUT", "ORBIT", "CRANE_UP", "CRANE_DOWN", "TRUCK", "PASS_THROUGH"] as const;

/** Where the camera is, as a spherical offset from the target (what directors think in) or an
 * absolute position. Azimuth 0 = in front (+Z), positive = to the right; elevation = degrees up. */
export const CameraPoseSchema = z
  .object({
    distance: z.number().positive().max(200).optional(),
    azimuth: z.number().min(-720).max(720).optional(),
    elevation: z.number().min(-89).max(89).optional(),
    position: Vec3Schema.optional(),
    /** Look-at point override for this pose (default: the camera target). */
    lookAt: z.union([id, Vec3Schema]).optional(),
    /** Vertical framing offset of the look-at point (meters), e.g. 0.3 to frame a stack's top. */
    lift: z.number().min(-20).max(20).optional(),
  })
  .strict();
export type CameraPose = z.infer<typeof CameraPoseSchema>;

export const LensSchema = z
  .object({
    /** Full-frame-equivalent focal length in mm (the 9:16 frame's long side = 36 mm). */
    focalLength: z.number().min(12).max(300),
    fStop: z.number().min(0.95).max(22).optional(),
    /** What is in focus: an actor id, a world point, or "target" (default). */
    focus: z.union([id, Vec3Schema, z.literal("target")]).optional(),
  })
  .strict();
export type Lens = z.infer<typeof LensSchema>;

export const CameraSchema = z
  .object({
    rig: z.enum(CAMERA_RIGS),
    /** What the camera looks at / orbits: an actor id or a world point. */
    target: z.union([id, Vec3Schema]),
    /** Start pose. "CONTINUE" = exactly where the previous shot's camera ended (one-take feel). */
    from: z.union([CameraPoseSchema, z.literal("CONTINUE")]),
    /** End pose (omit for HOLD — a held frame still breathes, see `drift`). */
    to: CameraPoseSchema.optional(),
    lens: LensSchema,
    /** Optional lens change during the shot (a slow zoom/"dolly zoom" when combined with a dolly). */
    lensTo: LensSchema.partial().optional(),
    rackFocus: z.object({ to: z.union([id, Vec3Schema]), at: AnchorSchema, duration: z.number().min(0.1).max(5).optional() }).strict().optional(),
    ease: EaseSchema.optional(),
    /** 0..1 organic handheld/breathing drift (seeded noise; 0.15 is a "living" tripod). */
    drift: z.number().min(0).max(1).optional(),
    /** Dutch roll in degrees. */
    roll: z.number().min(-30).max(30).optional(),
    /** Camera shake impulse on a hit (e.g. an IMPACT). */
    shake: z.object({ at: AnchorSchema, strength: z.number().min(0).max(1) }).strict().optional(),
  })
  .strict();
export type CameraSpec = z.infer<typeof CameraSchema>;

// ---------------------------------------------------------------------------------------------
// Text, transitions, sound

export const TEXT_STYLES = ["HERO_NUMBER", "KICKER", "STATEMENT", "LABEL", "TITLE", "STAMP", "FOOTNOTE"] as const;
export const TextBeatSchema = z
  .object({
    /** For LABEL, "Rent|+$300/mo" sets the part after | in gold. FOOTNOTE allows up to 120 chars. */
    text: z.string().min(1).max(120),
    at: AnchorSchema,
    until: AnchorSchema.optional(),
    style: z.enum(TEXT_STYLES),
    /** UPPER / CENTER / LOWER band of the 9:16 frame (all inside platform safe zones). */
    position: z.enum(["UPPER", "CENTER", "LOWER"]).optional(),
    /** Gold accent instead of cream. */
    accent: z.boolean().optional(),
    /** For numbers: count up/down from this value to the number in `text` while entering. */
    countFrom: z.number().optional(),
    /** Strike the text through at this anchor (e.g. a price that's gone). */
    strikeAt: AnchorSchema.optional(),
  })
  .strict();
export type TextBeat = z.infer<typeof TextBeatSchema>;

export const TRANSITIONS = ["CUT", "MATCH_CUT", "DIP_TO_BLACK", "FLASH", "WHIP", "PASS_THROUGH", "FOCUS_PULL", "SMASH"] as const;
export const TransitionSchema = z
  .object({
    type: z.enum(TRANSITIONS),
    /** Seconds the transition straddles the cut (half before, half after). */
    duration: z.number().min(0).max(2).optional(),
  })
  .strict();
export type Transition = z.infer<typeof TransitionSchema>;

export const CINEMA_SFX = ["WHOOSH", "SWOOSH_UP", "SOFT_POP", "CLICK", "TICK", "RISER", "IMPACT", "SHIMMER", "CASH", "SUB_DROP", "COIN_CLINK"] as const;
export const SfxCueSchema = z
  .object({
    sound: z.enum(CINEMA_SFX),
    at: AnchorSchema,
    /** dB relative to the house SFX level (−24..+6). */
    gainDb: z.number().min(-24).max(6).optional(),
  })
  .strict();
export type SfxCue = z.infer<typeof SfxCueSchema>;

export const ShotMusicSchema = z
  .object({
    /** 0 = near silence, 1 = full score. The score follows this per shot. */
    intensity: z.number().min(0).max(1),
    /** A musical hit (low boom + chord) at the shot start. */
    hit: z.boolean().optional(),
    /** Drop everything to silence for this shot (the "beat of silence" before a twist). */
    drop: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Shots, scenes, film

export const ShotSchema = z
  .object({
    id,
    /** Narration spoken during this shot, exactly as it should read on screen/in the script. */
    line: z.string().min(1).max(400).optional(),
    /** Pronunciation override for TTS ("ten thousand dollars" for "$10,000"). Word anchors and
     * captions always use `line`. */
    say: z.string().min(1).max(500).optional(),
    /** Fixed length in seconds (required without a `line`; overrides the narration length). */
    duration: z.number().min(0.3).max(30).optional(),
    /** Extra seconds after the line ends before the next shot (a breath / a held beat). */
    hold: z.number().min(0).max(6).optional(),
    /** Seconds of picture before the line starts (lets an image land before words). */
    leadIn: z.number().min(0).max(4).optional(),
    camera: CameraSchema,
    actions: z.array(ActionSchema).max(60).optional(),
    text: z.array(TextBeatSchema).max(8).optional(),
    lighting: LightingSchema.optional(),
    post: PostSchema.optional(),
    transitionOut: TransitionSchema.optional(),
    sfx: z.array(SfxCueSchema).max(16).optional(),
    music: ShotMusicSchema.optional(),
    /** What this shot is for — storyboard note (hook / setup / twist / payoff…). */
    purpose: z.string().max(200).optional(),
  })
  .strict();
export type Shot = z.infer<typeof ShotSchema>;

export const SceneSchema = z
  .object({
    id,
    set: SetSchema,
    shots: z.array(ShotSchema).min(1).max(40),
  })
  .strict();
export type Scene = z.infer<typeof SceneSchema>;

export const NarrationSchema = z
  .object({
    /** "KOKORO" = local open-weights TTS (Apache-2.0). "CHRIS" = Chris records the lines (future). */
    engine: z.enum(["KOKORO", "CHRIS"]),
    voice: z.string().min(1).max(40),
    /** Speaking rate multiplier 0.7..1.3. */
    speed: z.number().min(0.7).max(1.3).optional(),
    /** Seconds of silence between consecutive lines (default 0.18). */
    gapSeconds: z.number().min(0).max(2).optional(),
    /** Natural pauses: a line with several sentences is spoken sentence by sentence with this much
     * silence between them (default 0.32 s); `[pause]` / `[pause 0.6]` in `say` adds an explicit beat. */
    sentencePause: z.number().min(0).max(2).optional(),
  })
  .strict();

export const MusicSchema = z
  .object({
    /** PROCEDURAL = the in-repo generative score (src/audio/score.ts). NONE = no music. */
    source: z.enum(["PROCEDURAL", "NONE"]),
    bpm: z.number().min(50).max(160).optional(),
    /** Root note + mode, e.g. "D minor", "F major". */
    key: z.string().regex(/^[A-G](#|b)? (major|minor)$/, "key looks like \"D minor\"").optional(),
    /** Music level under the narration, in dB (−30..−6, default −18). */
    levelDb: z.number().min(-30).max(-6).optional(),
    seed: z.number().int().optional(),
  })
  .strict();

export const FilmSchema = z
  .object({
    dsl: z.literal(CINEMA_DSL_VERSION),
    id,
    title: z.string().min(1).max(80),
    logline: z.string().max(300).optional(),
    format: z
      .object({
        width: z.number().int().min(270).max(2160),
        height: z.number().int().min(480).max(3840),
        fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]),
      })
      .strict(),
    look: LookSchema,
    narration: NarrationSchema.optional(),
    music: MusicSchema.optional(),
    /** Word-synced captions of the narration (phrase at a time, active word lit). */
    captions: z.enum(["PHRASES", "OFF"]).optional(),
    /** Add tasteful SFX for transitions/enters automatically (explicit cues always play). */
    autoSfx: z.boolean().optional(),
    /** Seed for every random choice (drift noise, particles, coin jitter). Same seed → same film. */
    seed: z.number().int().optional(),
    cast: z.array(ActorSchema).max(40),
    scenes: z.array(SceneSchema).min(1).max(20),
  })
  .strict();
export type Film = z.infer<typeof FilmSchema>;
