import { z } from "zod";
import { SFX_SOUNDS, VISUAL_TRANSITIONS } from "../motion-contract";
import { CAPTION_PRESETS } from "../timeline";
import { EXPRESSIONS } from "./understanding";

/**
 * The Director chat's answer — STRICT typed "edit instructions" (CLAUDE.md: no unrestricted
 * prose for downstream parsing). Whoever answers (Chris's ChatGPT via copy-paste, or Claude when
 * he has AI credit) returns exactly this shape; code validates it, then applies it
 * deterministically (apply.ts). Times are OUTPUT seconds of the current edit.
 *
 * Tolerance lives in the PARSER (parse.ts: code fences, chatter, smart quotes, "3.1s" strings,
 * op-name aliases); the schema itself stays strict so a misfit answer changes nothing and gets a
 * precise fix-up message.
 */

export const DIRECTOR_REGIONS = [
  "LEFT",
  "RIGHT",
  "TOP",
  "BOTTOM",
  "CENTER",
  "TOP_LEFT",
  "TOP_RIGHT",
  "BOTTOM_LEFT",
  "BOTTOM_RIGHT",
  "AUTO",
] as const;
export type DirectorRegion = (typeof DIRECTOR_REGIONS)[number];

/** A time: seconds, "end", or a reference to what Chris's face does ("when I smile"). */
export const DirectorTimeSchema = z.union([
  z.number().min(0).max(3600),
  z.literal("end"),
  z
    .object({
      /** An event id from the pack's EVENTS list ("e2"). */
      event: z.string().regex(/^e\d+$/).optional(),
      /** …or the nth onset of an expression ("happy" = when he smiles). */
      expression: z.enum(EXPRESSIONS).optional(),
      nth: z.number().int().min(1).max(50).optional(),
      /** …the expression onset nearest to this time (seconds). */
      near: z.number().min(0).max(3600).optional(),
      /** Seconds added after resolving (may be negative). */
      offset: z.number().min(-30).max(30).optional(),
    })
    .strict()
    .refine((o) => o.event !== undefined || o.expression !== undefined, "needs \"event\" or \"expression\""),
]);
export type DirectorTime = z.infer<typeof DirectorTimeSchema>;

export const DirectorPlacementSchema = z.union([
  z.enum(DIRECTOR_REGIONS),
  z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      scale: z.number().min(0.3).max(2.5).optional(),
    })
    .strict(),
]);
export type DirectorPlacement = z.infer<typeof DirectorPlacementSchema>;

const Ref = z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/, "use letters, numbers, - or _");
const Why = z.string().max(240).optional();
const Size = z.enum(["S", "M", "L"]);

/** Partial graphic data on top of the preset (any GraphicProps field; validated after merge). */
const GraphicPatch = z.record(z.string(), z.unknown());

export const AddGraphicOp = z
  .object({
    op: z.literal("addGraphic"),
    /** Your own short name for it, used to refer to it later ("paycheck", "rent"). */
    ref: Ref,
    presetId: z.string().min(1).max(80),
    /** Data in quick-entry form ("Rent -1450, Car -520") — optional. */
    quick: z.string().max(600).optional(),
    /** Lines/chat text for list/chat components (one entry per line) — optional. */
    lines: z.string().max(1200).optional(),
    /** Field overrides (title, subtitle, body, items, series, format, meta, tone, variant…). */
    props: GraphicPatch.optional(),
    start: DirectorTimeSchema,
    end: DirectorTimeSchema.optional(),
    duration: z.number().min(0.3).max(60).optional(),
    placement: DirectorPlacementSchema.optional(),
    size: Size.optional(),
    enter: z.enum(VISUAL_TRANSITIONS).optional(),
    exit: z.enum(VISUAL_TRANSITIONS).optional(),
    /** Sound when it appears (null = silent). */
    sfx: z.enum(SFX_SOUNDS).nullable().optional(),
    /** Animation tempo, 0.5–2 (2 = twice as fast). */
    speed: z.number().min(0.5).max(2).optional(),
    why: Why,
  })
  .strict();

export const TEXT_STYLES = ["HEADLINE", "PUNCH", "CAPTION", "LOWER_THIRD", "NUMBER"] as const;

export const AddTextOp = z
  .object({
    op: z.literal("addText"),
    ref: Ref,
    text: z.string().min(1).max(200),
    start: DirectorTimeSchema,
    end: DirectorTimeSchema.optional(),
    duration: z.number().min(0.3).max(60).optional(),
    placement: DirectorPlacementSchema.optional(),
    style: z.enum(TEXT_STYLES).optional(),
    size: Size.optional(),
    /** #RRGGBB */
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    uppercase: z.boolean().optional(),
    why: Why,
  })
  .strict();

export const AddZoomOp = z
  .object({
    op: z.literal("addZoom"),
    ref: Ref,
    start: DirectorTimeSchema,
    end: DirectorTimeSchema.optional(),
    duration: z.number().min(0.2).max(30).optional(),
    /** 1.05–2.5 (1.15 = a punch-in). */
    amount: z.number().min(1.05).max(2.5),
    mode: z.enum(["CUT", "EASE"]).optional(),
    /** "face" (default) follows where his face is; or a canvas point. */
    focus: z.union([z.literal("face"), z.literal("center"), z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict()]).optional(),
    why: Why,
  })
  .strict();

export const AddSfxOp = z
  .object({
    op: z.literal("addSfx"),
    ref: Ref,
    at: DirectorTimeSchema,
    sound: z.enum(SFX_SOUNDS),
    volume: z.number().min(0.05).max(1).optional(),
    why: Why,
  })
  .strict();

export const CutOp = z
  .object({
    op: z.literal("cut"),
    /** Remove this stretch of the video (output seconds). */
    start: DirectorTimeSchema,
    end: DirectorTimeSchema,
    why: Why,
  })
  .strict();

export const TrimOp = z
  .object({
    op: z.literal("trim"),
    /** Keep only [start, end] (output seconds). Omit one to keep that edge. */
    start: DirectorTimeSchema.optional(),
    end: DirectorTimeSchema.optional(),
    why: Why,
  })
  .strict();

export const SetCaptionsOp = z
  .object({
    op: z.literal("setCaptions"),
    enabled: z.boolean(),
    style: z.enum(CAPTION_PRESETS).optional(),
    why: Why,
  })
  .strict();

export const RemoveOp = z
  .object({
    op: z.literal("remove"),
    /** An id from CURRENT EDIT (a graphic, text, zoom or sound), or a ref you gave earlier. */
    target: z.string().min(1).max(80),
    why: Why,
  })
  .strict();

export const MoveOp = z
  .object({
    op: z.literal("move"),
    target: z.string().min(1).max(80),
    start: DirectorTimeSchema.optional(),
    end: DirectorTimeSchema.optional(),
    duration: z.number().min(0.2).max(60).optional(),
    placement: DirectorPlacementSchema.optional(),
    size: Size.optional(),
    why: Why,
  })
  .strict();

export const UpdateOp = z
  .object({
    op: z.literal("update"),
    target: z.string().min(1).max(80),
    /** Swap the graphic for another preset (keeps its timing/placement). */
    presetId: z.string().min(1).max(80).optional(),
    quick: z.string().max(600).optional(),
    lines: z.string().max(1200).optional(),
    props: GraphicPatch.optional(),
    /** New wording (texts). */
    text: z.string().min(1).max(200).optional(),
    enter: z.enum(VISUAL_TRANSITIONS).optional(),
    exit: z.enum(VISUAL_TRANSITIONS).optional(),
    sfx: z.enum(SFX_SOUNDS).nullable().optional(),
    speed: z.number().min(0.5).max(2).optional(),
    style: z.enum(TEXT_STYLES).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    amount: z.number().min(1.05).max(2.5).optional(),
    volume: z.number().min(0.05).max(1).optional(),
    why: Why,
  })
  .strict();

export const NoteOp = z
  .object({
    op: z.literal("note"),
    /** Something to tell Chris (a question, a limitation) — changes nothing. */
    text: z.string().min(1).max(400),
  })
  .strict();

export const DirectorOpSchema = z.discriminatedUnion("op", [AddGraphicOp, AddTextOp, AddZoomOp, AddSfxOp, CutOp, TrimOp, SetCaptionsOp, RemoveOp, MoveOp, UpdateOp, NoteOp]);
export type DirectorOp = z.infer<typeof DirectorOpSchema>;
export const DIRECTOR_OP_NAMES = ["addGraphic", "addText", "addZoom", "addSfx", "cut", "trim", "setCaptions", "remove", "move", "update", "note"] as const;

export const DirectorAnswerSchema = z
  .object({
    /** One or two sentences to Chris about what you did (his language, no jargon). */
    reply: z.string().min(1).max(600),
    /** Applied in order. Empty = nothing to change (e.g. you need to ask something). */
    operations: z.array(DirectorOpSchema).max(40),
  })
  .strict();
export type DirectorAnswer = z.infer<typeof DirectorAnswerSchema>;

/** The answer shape printed in the pack — compact, TypeScript-like, with examples. */
export const DIRECTOR_ANSWER_SHAPE = `ANSWER = {
  "reply": string,            // 1–2 sentences to Chris: what you changed (plain words)
  "operations": [Op, ...]     // applied in order; [] if you only need to ask something (then use "note")
}
Time = number (seconds of the CURRENT edit, e.g. 3.1) | "end"
     | {"expression": "happy"|"surprise"|"sad"|"angry"|"disgust"|"fear"|"contempt"|"neutral", "nth": 1, "offset": 0.2}   // e.g. when he smiles (happy onset)
     | {"event": "e2", "offset": 0}            // an event id from FACE & MOVES
     | {"expression": "happy", "near": 3.0}    // the onset of that expression closest to 3.0 s
Placement = "LEFT"|"RIGHT"|"TOP"|"BOTTOM"|"CENTER"|"TOP_LEFT"|"TOP_RIGHT"|"BOTTOM_LEFT"|"BOTTOM_RIGHT"|"AUTO" | {"x": 0-1, "y": 0-1, "scale": 0.3-2.5}
   (regions are around HIS FACE; the app keeps every graphic off his eyes/mouth and says if it had to move it)
Size = "S"|"M"|"L"
Op =
 {"op":"addGraphic","ref":"paycheck","presetId":"<id from GRAPHICS>","start":Time,"end":Time?,"duration":sec?,"placement":Placement?,"size":Size?,
   "quick":"Rent -1450, Car -520"?,   // quick-entry data (see QUICK ENTRY)
   "lines":"one entry per line"?,     // chats / lists / notifications text
   "props":{ "title":"…","subtitle":"…","body":"…","meta":"…","items":[{"text":"…","sub":"…","value":2400,"icon":"BANK","meta":"Bank","color":"POSITIVE"}], "format":{"kind":"CURRENCY"} }?,
   "enter":"AUTO|FADE|SCALE|SLIDE|BLUR|SPRING"?,"exit":…?,"sfx":"CASH|WHOOSH|SWOOSH_UP|SOFT_POP|CLICK|TICK|RISER|IMPACT|SHIMMER"|null?,"speed":0.5-2?,"why":"…"?}
 {"op":"addText","ref":"ending","text":"…","start":Time,"end":Time?,"duration":sec?,"placement":Placement?,"style":"HEADLINE|PUNCH|CAPTION|LOWER_THIRD|NUMBER"?,"size":Size?,"color":"#RRGGBB"?,"uppercase":bool?}
 {"op":"addZoom","ref":"punch1","start":Time,"end":Time?,"duration":sec?,"amount":1.05-2.5,"mode":"CUT|EASE"?,"focus":"face"|"center"|{"x":0-1,"y":0-1}?}
 {"op":"addSfx","ref":"ching","at":Time,"sound":"CASH|…","volume":0.05-1?}
 {"op":"cut","start":Time,"end":Time}              // remove that stretch (later things slide earlier)
 {"op":"trim","start":Time?,"end":Time?}           // keep only that part
 {"op":"setCaptions","enabled":bool,"style":"CLEAN|BOLD_HIGHLIGHT|BOXED|KARAOKE"?}
 {"op":"remove","target":"<id or ref>"}
 {"op":"move","target":"<id or ref>","start":Time?,"end":Time?,"duration":sec?,"placement":Placement?,"size":Size?}
 {"op":"update","target":"<id or ref>","presetId"?,"quick"?,"lines"?,"props"?,"text"?,"enter"?,"exit"?,"sfx"?,"speed"?,"style"?,"color"?,"amount"?,"volume"?}
 {"op":"note","text":"…"}                           // tell Chris something (changes nothing)`;
