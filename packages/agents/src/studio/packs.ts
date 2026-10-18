import { z } from "zod";
import { BRAND_GUIDANCE } from "@chris/domain/script-import";
import { getAgentPrompt } from "../prompt-context";
import { catalogForPrompt } from "./catalog";
import type { FilmCatalog, NarratorVoice } from "./engine-port";
import type { StudioFilm } from "./film-types";
import {
  FinalPackResponseSchema,
  FixPackResponseSchema,
  ReviewPackResponseSchema,
  WritePackResponseSchema,
  type FilmBrief,
  type FilmScript,
} from "./schemas";

/**
 * Round-trip packs — how the creative crew runs for $0. Instead of a billed model call, the
 * orchestrator builds ONE message (crew prompts from the versioned registry + Chris's brand + the
 * film so far + the exact JSON shape) that Chris pastes into his ChatGPT (free with his
 * subscription; it accepts the storyboard image), then pastes ChatGPT's JSON answer back. The
 * answer is parsed tolerantly, validated against the crew's zod schemas, and every section is
 * persisted as that crew member's own artifact. The same pack can be answered automatically by the
 * optional local model (local-ai-provider.ts) — the prompt and schema are identical.
 *
 * Two required round trips per film: WRITE (Director brief + Hook + Screenwriter +
 * Cinematographer) and REVIEW (Meaning-Match + Cohesion + Retention + Quality + fact check +
 * Director decision, with the storyboard contact sheet attached). FIX (repair / redo a shot) and
 * FINAL (rendered-film quality + analysis) are only used when needed.
 */

export const PACK_KINDS = ["WRITE", "REVIEW", "FIX", "FINAL"] as const;
export type PackKind = (typeof PACK_KINDS)[number];

export const PACK_SCHEMAS = {
  WRITE: WritePackResponseSchema,
  REVIEW: ReviewPackResponseSchema,
  FIX: FixPackResponseSchema,
  FINAL: FinalPackResponseSchema,
} as const;

export const PACK_CREW: Record<PackKind, string[]> = {
  WRITE: ["FILM_DIRECTOR", "FILM_HOOK", "FILM_SCREENWRITER", "FILM_CINEMATOGRAPHER"],
  REVIEW: ["FILM_MEANING_MATCH", "FILM_COHESION", "FILM_RETENTION", "FILM_QUALITY", "CLAIMS_GATE", "FILM_DIRECTOR"],
  FIX: ["FILM_CINEMATOGRAPHER", "FILM_SCREENWRITER"],
  FINAL: ["FILM_QUALITY", "FILM_ANALYSIS"],
};

export interface Pack {
  kind: PackKind;
  /** What Chris sees on the button / step. */
  title: string;
  prompt: string;
  /** Attach this image in ChatGPT (storyboard / rendered-frame contact sheet). */
  imageUrl: string | null;
  promptVersions: Array<{ id: string; version: string }>;
  chars: number;
}

/** Compact DSL reference (cinema DSL v1) — the shape, not every option. The engine's validator
 * explains any mistake in a FIX round trip. */
export const DSL_REFERENCE = `FILM DSL (v1) — JSON. Units: meters, degrees, seconds. Y up, floor y=0.
film = {"dsl":1,"id":"kebab-id","title":"…","logline":"…","format":{"width":1080,"height":1920,"fps":30},
  "look":"GOLD_STUDIO"|"NOIR_NUMBERS","narration":{"engine":"KOKORO"|"CHRIS","voice":"<voice id>","speed":0.92},
  "music":{"source":"PROCEDURAL","bpm":84,"key":"D minor","levelDb":-20},"captions":"PHRASES","autoSfx":true,"seed":7,
  "cast":[actor…], "scenes":[{"id":"…","set":{"kind":"INFINITY_STUDIO","floorGloss":0.5,"haze":0.3,"particles":0.5},"shots":[shot…]}]}
actor = {"id":"lowercase_id","kind":"COIN_STACK|PEDESTAL|BUILDING|CAR|CARD|CARD_FAN|BASELINE|COIN_CHART|NUMBER_WALL|LIGHT_SHAFT",
  "position":[x,y,z],"rotation":[x,y,z],"scale":1,"visible":false,"params":{…}}   (actors are hidden until ENTER unless visible:true)
shot = {"id":"…","line":"exact narration","say":"tts pronunciation (optional)","leadIn":0.4,"hold":0.6,
  "camera":{"rig":"HOLD|DOLLY|PUSH_IN|PULL_OUT|ORBIT|CRANE_UP|CRANE_DOWN|TRUCK|PASS_THROUGH","target":"actor_id"|[x,y,z],
    "from":{"distance":9,"azimuth":0,"elevation":8,"lift":0.5}|"CONTINUE","to":{…same…},   ("to" required unless HOLD)
    "lens":{"focalLength":35,"fStop":2.8,"focus":"actor_id"},"drift":0.1},
  "actions":[{"do":"ENTER","actor":"id","style":"RISE|DROP|GROW|FADE|BUILD","at":ANCHOR,"duration":0.8},
    {"do":"EXIT","actor":"id","style":"DISSOLVE|SINK|SHRINK|FADE|SHATTER","at":ANCHOR},
    {"do":"SET","actor":"id","param":"level|count|progress|glow","to":1.8,"at":ANCHOR,"duration":1.5},
    {"do":"FLOW","actor":"from_id","into":"to_id","amount":35,"at":ANCHOR,"duration":1.2},
    {"do":"MOVE","actor":"id","to":[x,y,z],"at":ANCHOR},{"do":"PULSE","actor":"id","at":ANCHOR},{"do":"GLOW","actor":"id","to":1,"at":ANCHOR}],
  "text":[{"text":"$6,500","style":"HERO_NUMBER|KICKER|STATEMENT|LABEL|TITLE|STAMP|FOOTNOTE","at":ANCHOR,"until":ANCHOR,
    "position":"UPPER|CENTER|LOWER","accent":true,"countFrom":10000,"strikeAt":ANCHOR}],   (≤ 60 chars; FOOTNOTE ≤ 120; LABEL "Rent|+$300/mo")
  "lighting":{"preset":"KEY_RIM|TOP_SPOT|LOW_DRAMA|SOFT_DAWN|BLACKOUT_SPOT","blendSeconds":0.6},
  "post":{"letterbox":0.5,"grade":"WARM_GOLD|TEAL_NIGHT|NEUTRAL|BLEACH"},
  "transitionOut":{"type":"CUT|MATCH_CUT|DIP_TO_BLACK|FLASH|WHIP|PASS_THROUGH|FOCUS_PULL|SMASH","duration":0.4},
  "sfx":[{"sound":"WHOOSH|SWOOSH_UP|SOFT_POP|CLICK|TICK|RISER|IMPACT|SHIMMER|CASH|SUB_DROP|COIN_CLINK","at":ANCHOR}],
  "music":{"intensity":0.6,"hit":true,"drop":false},"purpose":"HOOK / TWIST / PAYOFF …"}
ANCHOR = seconds from shot start (1.2) | "start" | "end" | {"word":"raised"} (a word of THIS shot's line) | {"fraction":0.5}
Params: COIN_STACK count, columns · BASELINE level (height m), label · COIN_CHART values[], split[], progress 0..1 · BUILDING floors, glow · CARD label, price · CARD_FAN count, labels["Name|$9.99"].
Scale: a 100-coin stack with 7 columns is ~1 m tall; a building ~3 m; frame a subject with distance 8–14 at 32–40 mm.`;

function section(promptId: string): { text: string; version: string } {
  const p = getAgentPrompt(promptId);
  return { text: p.body.trim(), version: p.frontmatter.version };
}

function crewSections(kind: PackKind): { text: string; versions: Pack["promptVersions"] } {
  const versions: Pack["promptVersions"] = [];
  const parts = PACK_CREW[kind].map((id) => {
    const s = section(id);
    versions.push({ id, version: s.version });
    return id === "CLAIMS_GATE" ? `## FACT CHECK (the Claims Gate's rules — fill \`factCheck\`)\n\n${s.text}` : s.text;
  });
  const base = section("SYSTEM_BASE");
  versions.unshift({ id: "SYSTEM_BASE", version: base.version });
  return { text: parts.join("\n\n"), versions };
}

const JSON_RULES = `HOW TO ANSWER
- Reply with ONE JSON object only, in ONE code block, exactly in the shape below — no prose before or after.
- Keep every key. Use null where a value is unknown/not applicable. Arrays may be empty unless the shape needs items.
- Every "evidence" array needs at least one item: {"kind":"LINE|SHOT|STILL|DSL|FACT|CALC|MEASURED|REPORT","ref":"shot or line id","detail":"what exactly"}.
- Estimates are {"kind":"ESTIMATE","score":0-100,"uncertainty":"LOW|MEDIUM|HIGH"} — never predict views.`;

type JS = { type?: string | string[]; properties?: Record<string, JS>; items?: JS; enum?: unknown[]; const?: unknown; anyOf?: JS[]; oneOf?: JS[]; $ref?: string; minItems?: number; description?: string; additionalProperties?: unknown; $defs?: Record<string, JS> };

/** A compact, TypeScript-like rendering of the answer schema — ~5× shorter than raw JSON Schema,
 * which matters on a phone clipboard and in ChatGPT's context. Descriptions become // notes. */
export function compactShape(schema: z.ZodType): string {
  let root: JS;
  try {
    root = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }) as JS;
  } catch {
    return "(see the crew instructions)";
  }
  const defs = root.$defs ?? {};
  const seen = new Map<string, string>();
  const render = (s: JS, indent: string): string => {
    if (s.$ref) {
      const name = s.$ref.split("/").pop()!;
      if (!seen.has(name)) {
        seen.set(name, "");
        seen.set(name, render(defs[name] ?? {}, "  "));
      }
      return name;
    }
    const alts = s.anyOf ?? s.oneOf;
    if (alts) return alts.map((a) => render(a, indent)).join(" | ");
    if (s.const !== undefined) return JSON.stringify(s.const);
    if (s.enum) return s.enum.map((e) => JSON.stringify(e)).join("|");
    const t = Array.isArray(s.type) ? s.type : [s.type];
    if (t.includes("array")) return `[${render(s.items ?? {}, indent)}]${s.minItems ? ` (≥${s.minItems})` : ""}`;
    if (t.includes("object") && s.properties) {
      const keys = Object.keys(s.properties).join(",");
      if (keys === "kind,ref,detail") return "Evidence";
      if (keys === "kind,score,uncertainty") return "Estimate";
      const entries = Object.entries(s.properties);
      const inner = entries
        .map(([k, v], i) => `${indent}  "${k}": ${render(v, indent + "  ")}${i < entries.length - 1 ? "," : ""}${v.description ? `  // ${v.description.replace(/\s+/g, " ").slice(0, 90)}` : ""}`)
        .join("\n");
      return `{\n${inner}\n${indent}}`;
    }
    if (t.includes("object")) return "{…object…}";
    if (t.includes("null") && t.length === 2) return `${t.find((x) => x !== "null")}|null`;
    return t.filter(Boolean).join("|") || "any";
  };
  const body = render(root, "");
  const defsText = [...seen.entries()].map(([k, v]) => `${k} = ${v}`).join("\n");
  const common = [
    body.includes("Evidence") ? 'Evidence = {"kind": "LINE"|"SHOT"|"STILL"|"DSL"|"FACT"|"CALC"|"MEASURED"|"REPORT", "ref": string /* shot id, line id (l3), still id (shot@0.6), DSL path or report */, "detail": string /* quote what is said / shown / computed */}' : "",
    body.includes("Estimate") ? 'Estimate = {"kind": "ESTIMATE", "score": number /* 0–100, never a view forecast */, "uncertainty": "LOW"|"MEDIUM"|"HIGH"}' : "",
  ].filter(Boolean);
  return `${[...common, defsText].filter(Boolean).join("\n")}\n\nANSWER = ${body}`;
}

const shapeOf = compactShape;

function header(kind: PackKind, title: string): string {
  return `CHRIS'S MINI-MOVIE STUDIO — ${title}
You are my film crew for one short animated film (9:16, faceless, procedural 3D, narrated). You play several crew roles below, each with ONE goal. Use my brand and voice. Don't invent facts or numbers. (Pack: ${kind}.)`;
}

function brandBlock(brandContext: string | null): string {
  return `## WHO I AM (brand — follow it)\n\n${BRAND_GUIDANCE}${brandContext ? `\n\n${brandContext.slice(0, 6000)}` : ""}`;
}

export interface WritePackInput {
  idea: string;
  targetSeconds: number;
  look: string;
  voice: NarratorVoice | null;
  catalog: FilmCatalog;
  brandContext: string | null;
  /** Measured pacing of Chris's reference style (optional). */
  referencePacing?: string | null;
}

export function buildWritePack(input: WritePackInput): Pack {
  const crew = crewSections("WRITE");
  const narration = input.voice ? `{"engine":"${input.voice.engine}","voice":"${input.voice.id}"}` : `{"engine":"KOKORO","voice":"am_michael"}`;
  const prompt = [
    header("WRITE", "WRITE THE FILM"),
    brandBlock(input.brandContext),
    `## THE FILM\n\nIdea (from Chris): ${input.idea.trim()}\nLength: about ${input.targetSeconds} seconds (30–60 s lands best). Look: ${input.look}. Narration: ${narration}.${input.referencePacing ? `\nPacing reference (Chris's favourite creators, measured): ${input.referencePacing}` : ""}`,
    `## THE CREW (play every role, in this order)\n\n${crew.text}`,
    `## WHAT THE ENGINE CAN SHOW (use ONLY this vocabulary)\n\n${catalogForPrompt(input.catalog)}`,
    `## ${DSL_REFERENCE}`,
    `${JSON_RULES}\n- "shots.film" is the complete film JSON (DSL above); one shot per script line, line text identical.\n\nSHAPE (every key required; // notes explain fields):\n${shapeOf(WritePackResponseSchema)}`,
  ].join("\n\n");
  return { kind: "WRITE", title: "Write the film", prompt, imageUrl: null, promptVersions: crew.versions, chars: prompt.length };
}

export interface ReviewPackInput {
  brief: FilmBrief;
  script: FilmScript;
  film: StudioFilm;
  catalog: FilmCatalog;
  contactSheetUrl: string | null;
  /** Plain-text summaries of the automatic crew (first-pass Meaning-Match, Continuity, Quality basics, Verification). */
  automaticFindings: string;
  iteration: number;
  maxIterations: number;
  brandContext: string | null;
  /** Chris's own notes (authority 1) to apply, if any. */
  chrisNotes?: string[];
}

export function buildReviewPack(input: ReviewPackInput): Pack {
  const crew = crewSections("REVIEW");
  const prompt = [
    header("REVIEW", `REVIEW THE STORYBOARD (round ${input.iteration} of ${input.maxIterations})`),
    `I've attached the storyboard: one still per shot with the narration line under it. If the image is missing, say so in every evidence item you'd have taken from it and judge from the DSL.`,
    brandBlock(input.brandContext),
    `## THE BRIEF\n\n${JSON.stringify(input.brief)}`,
    `## THE SCRIPT\n\n${JSON.stringify(input.script)}`,
    `## THE FILM (DSL)\n\n${JSON.stringify(input.film)}`,
    `## WHAT THE AUTOMATIC CREW ALREADY FOUND (code — measured or rule-based; don't contradict a measurement)\n\n${input.automaticFindings}`,
    input.chrisNotes?.length ? `## CHRIS'S NOTES (he outranks the whole crew — apply them)\n\n${input.chrisNotes.map((n) => `- ${n}`).join("\n")}` : "",
    `## THE CREW (play every role, Director last)\n\n${crew.text}`,
    `## WHAT THE ENGINE CAN SHOW (replacements must use ONLY this)\n\n${catalogForPrompt(input.catalog)}`,
    `## ${DSL_REFERENCE}`,
    `${JSON_RULES}\n- If director.decision is "REVISE", put the COMPLETE revised film in "revisedFilm" (and the complete revised script in "revisedScript" if any line or number changed); otherwise both null.\n\nSHAPE (every key required; // notes explain fields):\n${shapeOf(ReviewPackResponseSchema.extend({ revisedFilm: z.unknown().describe("the COMPLETE revised film DSL (same shape as THE FILM above), or null"), revisedScript: z.unknown().describe("the COMPLETE revised script (same shape as THE SCRIPT above), or null") }))}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { kind: "REVIEW", title: "Review the storyboard", prompt, imageUrl: input.contactSheetUrl, promptVersions: crew.versions, chars: prompt.length };
}

export interface FixPackInput {
  reason: "VALIDATION" | "REDO_SHOT" | "CHRIS_EDIT" | "REVISION";
  script: FilmScript | null;
  film: unknown;
  problems: string;
  catalog: FilmCatalog;
}

export function buildFixPack(input: FixPackInput): Pack {
  const crew = crewSections("FIX");
  const why = {
    VALIDATION: "The engine couldn't read the film — fix exactly these problems and keep everything else the same.",
    REDO_SHOT: "Chris wants these shots redone — change only those shots (and anything that must change with them for continuity).",
    CHRIS_EDIT: "Chris changed narration — update the affected shots (word anchors must use words of the new line) and the script.",
    REVISION: "Apply these revisions.",
  }[input.reason];
  const prompt = [
    header("FIX", "FIX THE FILM"),
    `## WHAT TO FIX\n\n${why}\n\n${input.problems}`,
    input.script ? `## THE SCRIPT\n\n${JSON.stringify(input.script)}` : "",
    `## THE FILM (DSL)\n\n${typeof input.film === "string" ? input.film : JSON.stringify(input.film)}`,
    `## THE CREW\n\n${crew.text}`,
    `## WHAT THE ENGINE CAN SHOW\n\n${catalogForPrompt(input.catalog)}`,
    `## ${DSL_REFERENCE}`,
    `${JSON_RULES}\n- "film" is the COMPLETE fixed film; "script" the complete script if any line/number changed, else null.\n\nSHAPE (every key required; // notes explain fields):\n${shapeOf(FixPackResponseSchema.extend({ script: z.unknown().describe("the COMPLETE script (same shape as THE SCRIPT above) if any line or number changed, else null") }))}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { kind: "FIX", title: input.reason === "VALIDATION" ? "Fix what the engine couldn't read" : "Redo shots", prompt, imageUrl: null, promptVersions: crew.versions, chars: prompt.length };
}

export function buildFinalPack(input: { script: FilmScript; film: StudioFilm; contactSheetUrl: string | null; automaticFindings: string }): Pack {
  const crew = crewSections("FINAL");
  const prompt = [
    header("FINAL", "CHECK THE FINISHED FILM"),
    `I've attached frames of the RENDERED film (in order, each with its time and line).`,
    `## THE SCRIPT\n\n${JSON.stringify(input.script)}`,
    `## AUTOMATIC CHECKS\n\n${input.automaticFindings}`,
    `## THE CREW\n\n${crew.text}`,
    `${JSON_RULES}\n- quality.stage is "RENDER".\n\nSHAPE (every key required; // notes explain fields):\n${shapeOf(FinalPackResponseSchema)}`,
  ].join("\n\n");
  return { kind: "FINAL", title: "Check the finished film", prompt, imageUrl: input.contactSheetUrl, promptVersions: crew.versions, chars: prompt.length };
}

// ---------------------------------------------------------------------------------------------
// Parsing what Chris pastes back

export type PackParse<K extends PackKind> =
  | { ok: true; value: z.infer<(typeof PACK_SCHEMAS)[K]>; repaired: string[] }
  | { ok: false; errors: string[]; repairMessage: string };

/** Pulls the JSON object out of a ChatGPT answer: code fences, chatter before/after, smart
 * quotes, trailing commas, a stray BOM. Returns null if there's no object at all. */
export function extractJsonObject(text: string): { value: unknown; repaired: string[] } | null {
  const repaired: string[] = [];
  let s = text.replace(/^\uFEFF/, "").replace(/[\u200B-\u200D\u00A0]/g, " ");
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(s);
  if (fence) {
    s = fence[1]!;
    repaired.push("took the JSON from the code block");
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  if (start > 0 || end < s.length - 1) repaired.push("ignored text around the JSON");
  s = s.slice(start, end + 1);
  const attempts: Array<[string, (x: string) => string]> = [
    ["as is", (x) => x],
    ["straightened smart quotes", (x) => x.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")],
    ["removed trailing commas", (x) => x.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, "$1")],
  ];
  for (const [label, fix] of attempts) {
    try {
      const value = JSON.parse(fix(s)) as unknown;
      if (label !== "as is") repaired.push(label);
      return { value, repaired };
    } catch {
      /* next */
    }
  }
  return null;
}

export function parsePackAnswer<K extends PackKind>(kind: K, text: string): PackParse<K> {
  const extracted = extractJsonObject(text);
  if (!extracted) {
    const errors = ["I couldn't find a JSON object in what was pasted."];
    return { ok: false, errors, repairMessage: repairMessageFor(errors) };
  }
  const parsed = PACK_SCHEMAS[kind].safeParse(extracted.value);
  if (!parsed.success) {
    const errors = parsed.error.issues.slice(0, 15).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { ok: false, errors, repairMessage: repairMessageFor(errors) };
  }
  return { ok: true, value: parsed.data as z.infer<(typeof PACK_SCHEMAS)[K]>, repaired: extracted.repaired };
}

/** The one short message Chris sends back to ChatGPT when its JSON didn't fit. */
export function repairMessageFor(errors: string[]): string {
  return `Your JSON didn't match the shape I asked for. Fix exactly these problems and resend the COMPLETE JSON object (all keys), in one code block, nothing else:\n${errors.map((e) => `- ${e}`).join("\n")}`;
}
