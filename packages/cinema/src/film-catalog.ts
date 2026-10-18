import { VISUAL_CATALOG, type CatalogEntry } from "./catalog";
import { CINEMA_SFX } from "./dsl/schema";

/**
 * FILM_CATALOG — the visual catalog in the studio crew's format (packages/agents/src/studio/
 * engine-port.ts CatalogEntry: { id, kind, name, depicts, goodFor, usage }). The crew's
 * CinemaFilmEngine.getCatalog() picks it up automatically from @chris/cinema/pure; ids follow its
 * "<kind>:<NAME>[.<param>]" convention. Recipes (whole literal metaphors) are listed as ACTIONs
 * named "Recipe: …" (the port has no RECIPE kind) with the example DSL as `usage`.
 */

export type FilmCatalogKind = "ACTOR" | "ACTION" | "CAMERA" | "LIGHTING" | "TRANSITION" | "TEXT_STYLE" | "SET" | "LOOK" | "SFX";
export interface FilmCatalogEntry {
  id: string;
  kind: FilmCatalogKind;
  name: string;
  depicts: string;
  goodFor: string[];
  usage?: string;
}

const F = (id: string, kind: FilmCatalogKind, name: string, depicts: string, goodFor: string[], usage?: string): FilmCatalogEntry => ({ id, kind, name, depicts, goodFor, ...(usage ? { usage } : {}) });

const SFX_GOOD_FOR: Record<(typeof CINEMA_SFX)[number], string[]> = {
  WHOOSH: ["fast move", "whip", "next"],
  SWOOSH_UP: ["something rises", "lift"],
  SOFT_POP: ["appears", "pop in"],
  CLICK: ["a tap", "select"],
  TICK: ["time", "small thing", "every month"],
  RISER: ["tension builds", "here it comes"],
  IMPACT: ["hit", "the reveal lands"],
  SHIMMER: ["magic", "value appears"],
  CASH: ["money in", "payday"],
  SUB_DROP: ["gone", "heavy truth"],
  COIN_CLINK: ["coins land", "money"],
};

const STYLE_ENTRIES: FilmCatalogEntry[] = [
  F("action:SET.level", "ACTION", "Raise / lower a level (SET level)", "a BASELINE plane or a PLATFORM floor moves to a new height; on a PLATFORM everything riding on it goes up with it", ["raised your baseline", "the floor goes up", "lifestyle rises", "new normal", "costs go up permanently"], "SET param level (prefer RAISE on a PLATFORM with the person and their things as children via `parent`)"),
  F("action:SET.count", "ACTION", "Change a coin count", "a coin stack gains coins (they rain in) or loses them (they evaporate into gold dust)", ["adds up", "drains", "piles up", "shrinks", "taxes take"], "SET param count on a COIN_STACK"),
  F("action:SET.progress", "ACTION", "Grow a chart", "a chart (coin columns, bars, line, pie) grows to a fraction of its final size", ["grows over time", "compounds", "year after year"], "SET param progress (or GROW)"),
  F("action:SET.glow", "ACTION", "Highlight", "part of an object lights up brighter", ["this part", "the growth", "notice"], "SET param glow (or GLOW)"),
  F("camera:HOLD", "CAMERA", "Hold", "a still frame that still breathes (subtle drift)", ["a beat", "let it land", "silence", "the reveal holds"]),
  F("camera:PUSH_IN", "CAMERA", "Push in", "the camera moves closer to the subject, decelerating", ["focus", "here's the thing", "tension", "nobody tells you"]),
  F("camera:PULL_OUT", "CAMERA", "Pull out", "the camera moves away to reveal the whole picture", ["the big picture", "zoom out", "ending", "different life"]),
  F("camera:DOLLY", "CAMERA", "Dolly", "the camera glides past the scene in a straight line", ["walk through", "reveal side by side"]),
  F("camera:ORBIT", "CAMERA", "Orbit", "the camera circles the subject", ["look at it from all sides", "celebrate", "admire"]),
  F("camera:CRANE_UP", "CAMERA", "Crane up", "the camera rises, revealing height (keep what rises in frame)", ["rises", "goes up", "how high", "baseline rises", "growth"]),
  F("camera:CRANE_DOWN", "CAMERA", "Crane down", "the camera descends toward the ground", ["falls", "drops", "ground level"]),
  F("camera:TRUCK", "CAMERA", "Truck", "the camera slides sideways along a row of things", ["over the years", "one after another", "timeline"]),
  F("camera:PASS_THROUGH", "CAMERA", "Pass through", "the camera flies into an object and out into the next scene", ["inside", "what's behind", "transition"]),
  F("lighting:KEY_RIM", "LIGHTING", "Key + rim", "classic product lighting: soft warm key, hard rim", ["neutral", "presenting"]),
  F("lighting:TOP_SPOT", "LIGHTING", "Top spot", "one hard spotlight from above", ["spotlight", "the one thing"]),
  F("lighting:LOW_DRAMA", "LIGHTING", "Low drama", "dark, moody, low side light", ["tension", "the twist", "bad news"]),
  F("lighting:SOFT_DAWN", "LIGHTING", "Soft dawn", "warm, bright, hopeful light", ["hope", "the fix", "a better way", "payoff"]),
  F("lighting:BLACKOUT_SPOT", "LIGHTING", "Blackout spot", "almost black with a single pool of light", ["gone", "nothing left", "silence"]),
  F("transition:CUT", "TRANSITION", "Cut", "a straight cut", ["default"]),
  F("transition:MATCH_CUT", "TRANSITION", "Match cut", "the same shape continues into the next shot", ["same thing, different meaning"]),
  F("transition:DIP_TO_BLACK", "TRANSITION", "Dip to black", "fade through black", ["end of a chapter", "silence", "gone"]),
  F("transition:FLASH", "TRANSITION", "Flash", "a white flash", ["impact", "realization"]),
  F("transition:WHIP", "TRANSITION", "Whip pan", "a fast blurred pan that carries into the next shot", ["energy", "next", "here's where it went"]),
  F("transition:PASS_THROUGH", "TRANSITION", "Pass-through blur", "a blur and soft flash as the camera passes through", ["going inside", "deeper"]),
  F("transition:SMASH", "TRANSITION", "Smash cut", "an abrupt hard cut with a small flash", ["contrast", "punchline"]),
  F("transition:FOCUS_PULL", "TRANSITION", "Focus pull", "blur into the next shot", ["reflection", "softer moment"]),
  F("text:HERO_NUMBER", "TEXT_STYLE", "Hero number", "one huge number on screen (≤ 12 characters), can count up/down and be struck through", ["the number", "how much", "the total"]),
  F("text:KICKER", "TEXT_STYLE", "Kicker", "a small uppercase label above the number", ["section title", "context"]),
  F("text:STATEMENT", "TEXT_STYLE", "Statement", "a short serif sentence on screen", ["the key line"]),
  F("text:LABEL", "TEXT_STYLE", "Label", "a pill with a name and a gold value ('Rent|+$300/mo')", ["what costs what"]),
  F("text:TITLE", "TEXT_STYLE", "Title", "a big serif title", ["the ending line", "title card"]),
  F("text:STAMP", "TEXT_STYLE", "Stamp", "a stamped word", ["verdict", "gone", "approved"]),
  F("text:FOOTNOTE", "TEXT_STYLE", "Footnote", "small print with the math or a caveat (≤ 120 chars)", ["assumptions", "not a guarantee", "how we got the number"]),
  F("look:GOLD_STUDIO", "LOOK", "Gold studio", "warm gold on ink black — a premium product film", ["money", "default"]),
  F("look:NOIR_NUMBERS", "LOOK", "Noir numbers", "cool blue-black noir with teal light and glowing digits", ["data", "mystery", "the cold math"]),
  ...CINEMA_SFX.map((s) => F(`sfx:${s}`, "SFX", s.replace("_", " ").toLowerCase(), `a ${s.replace("_", " ").toLowerCase()} sound effect`, SFX_GOOD_FOR[s])),
];

function usageOf(e: CatalogEntry): string | undefined {
  if (e.type === "ACTOR") {
    const p = e.params.map((x) => `params.${x.name}${x.range ? ` (${x.range})` : ""}: ${x.meaning}`).join("; ");
    return `${p}${e.verbs?.length ? ` · verbs: ${e.verbs.join(", ")}` : ""}${e.framing ? ` · framing: distance ${e.framing.distance}, ${e.framing.focalLength} mm` : ""}`.slice(0, 700);
  }
  if (e.type === "RECIPE") return JSON.stringify({ cast: e.example.cast, actions: e.example.actions }).slice(0, 900);
  if (e.type === "ACTION") return e.params.filter((p) => !["actor", "at", "duration", "ease"].includes(p.name)).map((p) => `${p.name}: ${p.meaning}`).join("; ") || undefined;
  return undefined;
}

export const FILM_CATALOG_VERSION = "cinema-1.1-2026-10-18";

export const FILM_CATALOG: { version: string; entries: FilmCatalogEntry[] } = {
  version: FILM_CATALOG_VERSION,
  entries: [
    ...VISUAL_CATALOG.map((e): FilmCatalogEntry => {
      const kind: FilmCatalogKind = e.type === "ACTOR" ? "ACTOR" : e.type === "SET" ? "SET" : "ACTION";
      const id = e.type === "ACTOR" ? `actor:${e.id}` : e.id;
      return F(id, kind, e.type === "RECIPE" ? `Recipe: ${e.title}` : e.title, e.depicts, e.goodFor, usageOf(e));
    }),
    ...STYLE_ENTRIES,
  ],
};

export function getFilmCatalog(): { version: string; entries: FilmCatalogEntry[] } {
  return FILM_CATALOG;
}
