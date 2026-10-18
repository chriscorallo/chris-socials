import type { CatalogEntry, FilmCatalog } from "./engine-port";

/**
 * Fallback semantic catalog of the cinema DSL v1 vocabulary (packages/cinema src/dsl/schema.ts:
 * ACTOR_KINDS, ACTION_TYPES, CAMERA_RIGS, LIGHTING_PRESETS, TRANSITIONS, TEXT_STYLES, …), written
 * as "what it depicts" + "good for" so the Meaning-Match first pass can compare a narration line
 * with what a shot shows. The engine's own machine-readable CATALOG (being built alongside the
 * engine) replaces this through FilmEnginePort.getCatalog() — this copy is what the fake engine
 * and an engine without a catalog fall back to. Ids are stable: "<kind>:<NAME>[.<param>]".
 */

const e = (id: string, kind: CatalogEntry["kind"], name: string, depicts: string, goodFor: string[], usage?: string): CatalogEntry => ({ id, kind, name, depicts, goodFor, ...(usage ? { usage } : {}) });

export const FALLBACK_CATALOG_ENTRIES: CatalogEntry[] = [
  // Actors
  e("actor:COIN_STACK", "ACTOR", "Coin stack", "a pile or tower of gold coins; money as a physical amount", ["money", "a raise", "savings", "a paycheck", "how much you have", "income"], "params.count (coins), params.columns (1 = one tower)"),
  e("actor:PEDESTAL", "ACTOR", "Pedestal", "a lit plinth or podium that presents something as precious", ["the prize", "what you want", "showing something off", "the main thing"], "params.radius, params.height"),
  e("actor:BUILDING", "ACTOR", "Miniature building", "a small apartment block with lit windows", ["rent", "the apartment", "housing", "a nicer place", "home", "mortgage"], "params.floors, params.glow"),
  e("actor:CAR", "ACTOR", "Car", "a stylized car", ["the car", "car payment", "car upgrade", "transport", "lease"], "params.color"),
  e("actor:CARD", "ACTOR", "Floating card", "one floating subscription or receipt card with a label and a price", ["a subscription", "a bill", "a receipt", "a charge", "one expense"], "params.label, params.price"),
  e("actor:CARD_FAN", "ACTOR", "Card fan", "many small subscription cards orbiting", ["subscriptions", "small expenses adding up", "bills", "recurring charges"], "params.count, params.labels ['Name|$9.99']"),
  e("actor:BASELINE", "ACTOR", "Baseline plane", "a glowing horizontal plane — a floor or level line that can rise or fall", ["your baseline", "the floor", "minimum lifestyle", "new normal", "standard of living", "lifestyle creep", "fixed costs level"], "params.level (height in m), params.label"),
  e("actor:COIN_CHART", "ACTOR", "Coin chart sculpture", "a chart made of coin columns growing over time, lower part = what you put in", ["compound growth", "investing over years", "growth over time", "returns", "retirement savings"], "params.values, params.split, params.progress 0..1"),
  e("actor:NUMBER_WALL", "ACTOR", "Number wall", "a wall of drifting glowing digits", ["data", "the math", "too many numbers", "complexity"], "params.density"),
  e("actor:LIGHT_SHAFT", "ACTOR", "Light shaft", "a beam of light from above on an empty spot", ["emptiness", "what's missing", "a reveal", "attention", "the secret"], "params.width, params.strength"),
  // Actions
  e("action:ENTER", "ACTION", "Enter", "something appears (rise, drop, grow, fade, build)", ["introducing", "arrives", "you get", "here's"], "style RISE|DROP|GROW|FADE|BUILD"),
  e("action:EXIT", "ACTION", "Exit", "something disappears (dissolve, sink, shrink, fade, shatter)", ["gone", "disappears", "lost", "taken away", "vanishes"], "style DISSOLVE|SINK|SHRINK|FADE|SHATTER"),
  e("action:MOVE", "ACTION", "Move", "an object travels to a new place", ["moves", "shifts", "goes to"], "to [x,y,z]"),
  e("action:TURN", "ACTION", "Turn", "an object rotates", ["turns", "flip", "rotate", "the other way"]),
  e("action:SCALE", "ACTION", "Scale", "an object grows or shrinks", ["grows", "shrinks", "gets bigger", "gets smaller"]),
  e("action:SET.level", "ACTION", "Raise / lower a level", "a baseline plane rises or falls to a new height", ["raised your baseline", "the floor goes up", "lifestyle rises", "new normal", "costs go up permanently"], "SET param level on a BASELINE"),
  e("action:SET.count", "ACTION", "Change a count", "a coin stack gains or loses coins", ["adds up", "drains", "piles up", "shrinks"], "SET param count on a COIN_STACK"),
  e("action:SET.progress", "ACTION", "Grow a chart", "a coin chart grows column by column", ["grows over time", "compounds", "year after year"], "SET param progress on a COIN_CHART"),
  e("action:SET.glow", "ACTION", "Highlight", "part of an object lights up", ["this part", "the growth", "notice"], "SET param glow"),
  e("action:FLOW", "ACTION", "Money flows", "coins stream from one object into another", ["pays for", "goes to", "eats", "takes", "pulls money", "costs", "spends on", "taxes take"], "FLOW into <actor>, amount (coins)"),
  e("action:PULSE", "ACTION", "Pulse", "an object throbs once for emphasis", ["emphasis", "this one", "boom"]),
  e("action:GLOW", "ACTION", "Glow", "an object lights up", ["important", "highlight", "the key"]),
  // Camera
  e("camera:HOLD", "CAMERA", "Hold", "a still, breathing frame", ["a beat", "let it land", "silence", "the reveal holds"]),
  e("camera:PUSH_IN", "CAMERA", "Push in", "the camera moves closer", ["focus", "here's the thing", "tension", "nobody tells you"]),
  e("camera:PULL_OUT", "CAMERA", "Pull out", "the camera moves away to show the whole picture", ["the big picture", "zoom out", "ending", "different life"]),
  e("camera:DOLLY", "CAMERA", "Dolly", "the camera glides past the scene", ["walk through", "reveal side by side"]),
  e("camera:ORBIT", "CAMERA", "Orbit", "the camera circles the subject", ["look at it from all sides", "celebrate", "admire"]),
  e("camera:CRANE_UP", "CAMERA", "Crane up", "the camera rises to look down / reveal height", ["rises", "goes up", "how high", "baseline rises", "growth"]),
  e("camera:CRANE_DOWN", "CAMERA", "Crane down", "the camera descends", ["falls", "drops", "ground level"]),
  e("camera:TRUCK", "CAMERA", "Truck", "the camera slides sideways along a row", ["over the years", "one after another", "timeline"]),
  e("camera:PASS_THROUGH", "CAMERA", "Pass through", "the camera flies into an object to the next scene", ["inside", "what's behind", "transition"]),
  // Lighting
  e("lighting:KEY_RIM", "LIGHTING", "Key + rim", "classic product lighting", ["neutral", "presenting"]),
  e("lighting:TOP_SPOT", "LIGHTING", "Top spot", "one hard spotlight from above", ["spotlight", "the one thing"]),
  e("lighting:LOW_DRAMA", "LIGHTING", "Low drama", "dark, moody, low-key", ["tension", "the twist", "bad news"]),
  e("lighting:SOFT_DAWN", "LIGHTING", "Soft dawn", "warm hopeful light", ["hope", "the fix", "a better way", "payoff"]),
  e("lighting:BLACKOUT_SPOT", "LIGHTING", "Blackout spot", "almost black with a single pool of light", ["gone", "nothing left", "silence"]),
  // Transitions
  e("transition:CUT", "TRANSITION", "Cut", "a straight cut", ["default"]),
  e("transition:MATCH_CUT", "TRANSITION", "Match cut", "the same shape continues into the next shot", ["same thing, different meaning"]),
  e("transition:DIP_TO_BLACK", "TRANSITION", "Dip to black", "fade through black", ["end of a chapter", "silence", "gone"]),
  e("transition:FLASH", "TRANSITION", "Flash", "a white flash", ["impact", "realization"]),
  e("transition:WHIP", "TRANSITION", "Whip pan", "a fast blurred pan", ["energy", "next", "here's where it went"]),
  e("transition:SMASH", "TRANSITION", "Smash cut", "an abrupt hard cut", ["contrast", "punchline"]),
  e("transition:FOCUS_PULL", "TRANSITION", "Focus pull", "blur into the next shot", ["reflection", "softer moment"]),
  // Text
  e("text:HERO_NUMBER", "TEXT_STYLE", "Hero number", "one huge number on screen (≤ 12 characters)", ["the number", "how much", "the total"]),
  e("text:KICKER", "TEXT_STYLE", "Kicker", "small uppercase label", ["section title", "context"]),
  e("text:STATEMENT", "TEXT_STYLE", "Statement", "a short sentence on screen", ["the key line"]),
  e("text:LABEL", "TEXT_STYLE", "Label", "name + gold value ('Rent|+$300/mo')", ["what costs what"]),
  e("text:TITLE", "TEXT_STYLE", "Title", "big serif title", ["the ending line", "title card"]),
  e("text:STAMP", "TEXT_STYLE", "Stamp", "a stamped word", ["verdict", "gone", "approved"]),
  e("text:FOOTNOTE", "TEXT_STYLE", "Footnote", "small print with the math or a caveat (≤ 120 chars)", ["assumptions", "not a guarantee", "how we got the number"]),
  // Sets / looks
  e("set:INFINITY_STUDIO", "SET", "Infinity studio", "a dark seamless studio with a reflective floor", ["default world"]),
  e("set:NUMBERS_VOID", "SET", "Numbers void", "a dark void of floating digits", ["abstract math"]),
  e("look:GOLD_STUDIO", "LOOK", "Gold studio", "warm gold on ink black — premium product film", ["money", "default"]),
  e("look:NOIR_NUMBERS", "LOOK", "Noir numbers", "cool noir with glowing digits", ["data", "mystery"]),
];

export const FALLBACK_CATALOG: FilmCatalog = { version: "fallback-dsl1-2026-10-18", entries: FALLBACK_CATALOG_ENTRIES };

/** Compact text listing for a pack (one line per entry). */
export function catalogForPrompt(catalog: FilmCatalog): string {
  const byKind = new Map<string, CatalogEntry[]>();
  for (const entry of catalog.entries) byKind.set(entry.kind, [...(byKind.get(entry.kind) ?? []), entry]);
  return [...byKind.entries()]
    .map(([kind, list]) => `${kind}:\n${list.map((x) => `- ${x.id} — ${x.depicts}. Good for: ${x.goodFor.join(", ")}${x.usage ? `. Use: ${x.usage}` : ""}`).join("\n")}`)
    .join("\n");
}
