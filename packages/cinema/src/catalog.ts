import {
  ACTION_TYPES,
  ACTOR_KINDS,
  SET_KINDS,
  type Action,
  type Actor,
  type ActorKind,
  type CameraSpec,
  type Film,
  type SetSpec,
} from "./dsl/schema";
import { DEFAULT_PARAMS, VERB_TARGETS, defaultFraming } from "./kinds";

/**
 * The VISUAL CATALOG — a machine-readable vocabulary of everything the engine can show, written
 * for the crew's Visual and Meaning bots: what each actor / action / set / recipe DEPICTS, which
 * phrases and money/mindset concepts it is GOOD FOR, its parameters, camera-friendly framing and
 * a runnable EXAMPLE (a one-shot film that validates and renders — test-enforced).
 *
 * Rule of thumb for the bots: pick a RECIPE when the line states a metaphor ("you raised your
 * baseline", "money leaks"), then adjust the actors' params; check that the picture LITERALLY
 * shows what the words say (the floor rises under the person when the line says "raised your
 * baseline"; the chain snaps on "break free").
 *
 * Deterministic keyword search: `searchCatalog`. Semantic match (local embedding model, $0):
 * `matchLineToCatalog` in src/catalog-match.ts.
 */

export type CatalogEntryType = "ACTOR" | "ACTION" | "SET" | "RECIPE";

export interface CatalogParam {
  name: string;
  type: "number" | "string" | "boolean" | "string[]" | "number[]";
  default: unknown;
  /** Allowed range / values, in words. */
  range?: string;
  meaning: string;
}

export interface CatalogExample {
  /** Cast for the example (ids are local to the example). */
  cast: Actor[];
  /** Actions of the one example shot (anchors in seconds). */
  actions: Action[];
  /** The actor the camera frames. */
  focus: string;
  set?: SetSpec;
  /** Optional explicit camera (default: a slow orbit at the focus actor's default framing). */
  camera?: CameraSpec;
  duration?: number;
}

export interface CatalogEntry {
  id: string;
  type: CatalogEntryType;
  title: string;
  /** What the viewer literally sees — rich plain English (embedded for semantic matching). */
  depicts: string;
  /** Phrases, idioms and concepts this visual expresses well (embedded too). */
  goodFor: string[];
  /** When NOT to use it (keeps the Meaning bot honest). */
  avoid?: string;
  params: CatalogParam[];
  /** Verbs / actions that animate it (ACTOR entries). */
  verbs?: string[];
  /** Camera-friendly default framing (ACTOR entries, at scale 1). */
  framing?: { distance: number; focalLength: number; elevation: number; lift: number };
  example: CatalogExample;
}

// ---------------------------------------------------------------------------------------------
// helpers

const P = (name: string, meaning: string, range?: string): Omit<CatalogParam, "type" | "default"> => ({ name, meaning, ...(range ? { range } : {}) });

function paramsFor(kind: ActorKind, specs: Array<Omit<CatalogParam, "type" | "default">>): CatalogParam[] {
  const defs = DEFAULT_PARAMS[kind] as Record<string, unknown>;
  return specs.map((sp) => {
    const d = defs[sp.name];
    const type: CatalogParam["type"] = Array.isArray(d) ? (d.length && typeof d[0] === "number" ? "number[]" : "string[]") : typeof d === "number" ? "number" : typeof d === "boolean" ? "boolean" : "string";
    return { ...sp, type, default: d };
  });
}

function verbsFor(kind: ActorKind): string[] {
  return Object.entries(VERB_TARGETS)
    .filter(([, m]) => (m as Record<string, unknown>)[kind])
    .map(([v, m]) => `${v} (${(m as Record<string, { param: string }>)[kind]!.param})`);
}

const A = (id: string, kind: ActorKind, extra: Partial<Actor> = {}): Actor => ({ id, kind, visible: true, position: [0, 0, 0], ...extra });

interface ActorDoc {
  title: string;
  depicts: string;
  goodFor: string[];
  avoid?: string;
  params: Array<Omit<CatalogParam, "type" | "default">>;
  example: CatalogExample;
}

// ---------------------------------------------------------------------------------------------
// ACTORS

const ACTOR_DOCS: Record<ActorKind, ActorDoc> = {
  COIN_STACK: {
    title: "Stack of gold coins",
    depicts: "A tight cluster of polished gold coins stacked level by level; coins rain in when the count rises, lift off and evaporate into gold dust when it falls, or fly in arcs into another object (FLOW).",
    goodFor: ["your paycheck", "a raise", "savings piling up", "money disappearing", "taxes take a cut", "where the money goes", "100 coins = the whole amount", "spending pulls money away"],
    params: [P("count", "number of coins (each coin can stand for a fixed amount, e.g. $100)", "0..420"), P("columns", "1 = one tall tower, 7+ = a wide pile", "1..37"), P("jitter", "how messy the stacking is", "0..1")],
    example: { cast: [A("pile", "COIN_STACK", { params: { count: 30, columns: 7 } })], actions: [{ do: "SET", actor: "pile", param: "count", to: 80, at: 0.3, duration: 2 }], focus: "pile" },
  },
  PEDESTAL: {
    title: "Pedestal / plinth",
    depicts: "A dark lacquered round plinth with a thin glowing gold ring — a stage that presents whatever stands on it.",
    goodFor: ["putting something on a pedestal", "the prize", "the thing you want", "showcase", "the empty spot where money used to be"],
    params: [P("radius", "plinth radius (m)"), P("height", "plinth height (m); things parented to it stand on top")],
    example: { cast: [A("ped", "PEDESTAL"), A("c", "COIN_STACK", { parent: "ped", params: { count: 20, columns: 4 } })], actions: [], focus: "ped" },
  },
  BUILDING: {
    title: "Miniature apartment building",
    depicts: "A miniature dark apartment block with warm lit windows and a gold cornice; can BUILD up floor by floor.",
    goodFor: ["rent", "a nicer apartment", "housing costs", "the city", "landlord", "moving to a bigger place"],
    params: [P("floors", "number of floors"), P("glow", "window light 0..1"), P("width", "footprint width (m)")],
    example: { cast: [A("b", "BUILDING", { visible: false })], actions: [{ do: "ENTER", actor: "b", style: "BUILD", at: 0.2, duration: 1.6 }], focus: "b" },
  },
  CAR: {
    title: "Stylized car",
    depicts: "A sleek extruded miniature coupe with clear-coat paint, glowing head- and tail-lights and turning wheels.",
    goodFor: ["car payment", "a car upgrade", "car loan", "lifestyle upgrade", "commute", "depreciation"],
    params: [P("color", "paint color (hex)")],
    example: { cast: [A("car", "CAR", { position: [-2, 0, 0], params: { color: "#26252B" } })], actions: [{ do: "MOVE", actor: "car", to: [1, 0, 0], at: 0.2, duration: 2.5 }], focus: "car" },
  },
  CARD: {
    title: "Subscription / price card",
    depicts: "A single floating dark glass card with a label and a gold price, like a subscription tile.",
    goodFor: ["one subscription", "a monthly fee", "a price tag", "a single charge"],
    params: [P("label", "top text"), P("price", "gold price text"), P("glow", "brightness 0..1")],
    example: { cast: [A("card", "CARD", { position: [0, 1, 0], params: { label: "Streaming", price: "$15.99" } })], actions: [{ do: "PULSE", actor: "card", at: 1 }], focus: "card" },
  },
  CARD_FAN: {
    title: "Orbiting subscription cards",
    depicts: "A ring of small price cards orbiting slowly around a center (subscriptions circling your money); cards pop in one by one.",
    goodFor: ["subscriptions", "small monthly charges", "little expenses add up", "recurring payments", "death by a thousand cuts"],
    params: [P("count", "number of cards"), P("labels", 'cards as "Label|$9.99"'), P("radius", "orbit radius (m)"), P("cardScale", "card size multiplier (1.6–2.4 reads well on a phone)")],
    example: { cast: [A("subs", "CARD_FAN", { visible: false, position: [0, 0.6, 0], params: { count: 5, cardScale: 1.8, radius: 1.8, labels: ["Streaming|$15.99", "Music|$10.99", "Cloud|$2.99", "Fitness|$12.99", "News|$4.99"] } })], actions: [{ do: "ENTER", actor: "subs", style: "GROW", at: 0.2, duration: 1.2 }], focus: "subs" },
  },
  BASELINE: {
    title: "Glowing baseline grid",
    depicts: "A thin, glowing gold grid plane hovering at a height — an abstract 'level' or 'your new normal'. For a literal rising floor under people/things use PLATFORM.",
    goodFor: ["a level", "the bar", "a threshold", "new normal (abstract)"],
    avoid: "When the line says the floor/baseline rises UNDER you or your things, use the PLATFORM recipe (raise-baseline) so the picture literally lifts them.",
    params: [P("level", "height of the plane (m)"), P("size", "plane size (m)"), P("label", "text on the plane")],
    example: { cast: [A("base", "BASELINE", { params: { level: 0.1, size: 8, label: "THE BAR" } })], actions: [{ do: "RAISE", actor: "base", to: 1.2, at: 0.3 }], focus: "base" },
  },
  COIN_CHART: {
    title: "Coin column chart (sculpture)",
    depicts: "A chart built from gold coin columns, one column per period, growing left to right; the upper (growth) part of each column can glow brighter than the lower (principal) part.",
    goodFor: ["compound interest", "investing over 20 years", "what you put in vs what it grew", "growth", "retirement savings"],
    params: [P("values", "coins per column"), P("split", "coins of the lower 'principal' part per column"), P("progress", "growth 0..1 (columns rise in a wave)"), P("spacing", "column spacing (m)"), P("glow", "growth glow 0..1")],
    example: { cast: [A("chart", "COIN_CHART", { params: { values: [4, 8, 13, 19, 26], split: [4, 7, 10, 13, 16], spacing: 1.2, progress: 0 } })], actions: [{ do: "GROW", actor: "chart", at: 0.2, duration: 2.5 }, { do: "GLOW", actor: "chart", to: 1, at: 2.5 }], focus: "chart" },
  },
  NUMBER_WALL: {
    title: "Wall of drifting digits",
    depicts: "Glowing teal digits drifting upward in the dark background (NOIR look) — 'inside the spreadsheet'.",
    goodFor: ["the math", "data", "numbers don't lie", "spreadsheet", "the algorithm"],
    params: [P("density", "how many digits 0..1")],
    example: { cast: [A("wall", "NUMBER_WALL")], actions: [], focus: "wall", camera: { rig: "HOLD", target: [0, 3, -8], from: { distance: 10, elevation: 5 }, lens: { focalLength: 35 } } },
  },
  LIGHT_SHAFT: {
    title: "Light shaft",
    depicts: "A soft volumetric beam of warm light from above — a spotlight on a spot (often an empty one).",
    goodFor: ["the moment of truth", "spotlight", "the empty spot", "nothing left", "attention here"],
    params: [P("width", "beam width at the floor (m)"), P("strength", "brightness 0..1")],
    example: { cast: [A("shaft", "LIGHT_SHAFT", { visible: false }), A("ped", "PEDESTAL")], actions: [{ do: "ENTER", actor: "shaft", style: "FADE", at: 0.4, duration: 0.8 }], focus: "ped" },
  },
  FIGURE: {
    title: "Person (faceless mannequin)",
    depicts: "A tasteful, faceless artist's-mannequin person in matte ceramic with gold joints; stands, walks, runs, sits, climbs, cheers, slumps, thinks, reaches, pushes, carries, points or balances. Reads as 'you' or 'a person' without being a character.",
    goodFor: ["you", "a person", "the viewer", "someone", "a worker", "the investor", "walking toward", "climbing", "defeated", "celebrating", "thinking it over"],
    params: [P("pose", "starting pose", "STAND WALK RUN SIT CLIMB CHEER SLUMP THINK REACH PUSH CARRY POINT BALANCE"), P("height", "height in meters (1.8)"), P("color", "body color"), P("accent", "joint color"), P("cycle", "RUN/WALK/CLIMB in place (treadmill, wheel); with cadence")],
    example: { cast: [A("me", "FIGURE", { position: [-1.5, 0, 0] })], actions: [{ do: "WALK", actor: "me", to: [1.5, 0, 0], at: 0.2 }, { do: "POSE", actor: "me", pose: "CHEER", at: 2.8 }], focus: "me", duration: 4 },
  },
  CROWD: {
    title: "Crowd (many vs one)",
    depicts: "A field of many simple dark figures with one full gold mannequin standing out among them.",
    goodFor: ["most people", "everyone else", "the average person", "1 in 10", "stand out", "the majority", "the other 90%"],
    params: [P("count", "number of people", "1..400"), P("spacing", "spacing (m)"), P("highlight", "index of the highlighted person (-1 none)"), P("color", "crowd color"), P("highlightColor", "the one's color")],
    example: { cast: [A("crowd", "CROWD", { params: { count: 60, highlight: 27 } })], actions: [], focus: "crowd" },
  },
  PLATFORM: {
    title: "Rising floor / platform",
    depicts: "A solid dark slab with a glowing gold edge whose top is the floor level; when it RAISEs, everything parented to it (a person, their house, car, phone) rides up with it. ghost: a dashed outline keeps the old floor level visible. Optional label on its front face.",
    goodFor: ["you raised your baseline", "lifestyle creep", "your new normal", "the floor rises", "raising the bar", "level up", "the minimum you need", "cost of living goes up", "stepping up"],
    params: [P("level", "height of the top surface (m); RAISE / LOWER animate it"), P("width", "width (m)"), P("depth", "depth (m)"), P("label", "text on the front face (shows once it's tall enough)"), P("ghost", "dashed outline of the old floor (true/false)"), P("glow", "edge glow 0..2")],
    example: { cast: [A("floor", "PLATFORM", { params: { width: 6, depth: 4, label: "YOUR BASELINE", ghost: true } }), A("me", "FIGURE", { parent: "floor", position: [-1, 0, 0] }), A("house", "HOUSE", { parent: "floor", position: [1.4, 0, -0.6], params: { size: 0.8 } })], actions: [{ do: "RAISE", actor: "floor", to: 1.4, at: 0.5, duration: 2 }, { do: "POSE", actor: "me", pose: "BALANCE", at: 0.5 }], focus: "floor", duration: 4 },
  },
  STAIRS: {
    title: "Staircase",
    depicts: "A dark stone staircase rising to the right with glowing gold nosing on every step; a FIGURE can CLIMB it step by step.",
    goodFor: ["step by step", "one step at a time", "climbing out of debt", "progress", "the next level", "small steps", "career ladder"],
    params: [P("steps", "number of steps"), P("rise", "step height (m)"), P("run", "step depth (m)"), P("width", "stair width (m)"), P("glow", "nosing glow")],
    example: { cast: [A("stairs", "STAIRS"), A("me", "FIGURE", { position: [-2, 0, 0] })], actions: [{ do: "CLIMB", actor: "me", on: "stairs", at: 0.2, duration: 3.5 }], focus: "stairs", duration: 4 },
  },
  LADDER: {
    title: "Ladder",
    depicts: "A tall gold ladder; a FIGURE CLIMBs it hand over hand.",
    goodFor: ["climbing the ladder", "corporate ladder", "moving up", "reach the top", "the climb"],
    params: [P("height", "height (m)"), P("rungs", "number of rungs"), P("width", "width (m)")],
    example: { cast: [A("ladder", "LADDER"), A("me", "FIGURE")], actions: [{ do: "CLIMB", actor: "me", on: "ladder", from: 0, to: 0.7, at: 0.2, duration: 3.5 }], focus: "ladder", duration: 4 },
  },
  BALANCE: {
    title: "Balance scale",
    depicts: "A gold balance scale with two pans of coins; it TIPs toward the heavier side (auto) or to a given tilt; labels under each pan.",
    goodFor: ["weighing options", "trade-off", "balance", "tipping the scales", "outweighs", "costs vs benefits", "needs vs wants", "income vs expenses"],
    params: [P("tilt", "-1 left side down .. 1 right side down"), P("leftCount", "coins on the left pan"), P("rightCount", "coins on the right pan"), P("leftLabel", "label under the left pan"), P("rightLabel", "label under the right pan"), P("auto", "tilt from the coin counts")],
    example: { cast: [A("scale", "BALANCE", { params: { leftCount: 4, rightCount: 12, leftLabel: "WANTS", rightLabel: "NEEDS" } })], actions: [{ do: "TIP", actor: "scale", to: 0.8, at: 0.5 }], focus: "scale" },
  },
  DOOR: {
    title: "Door with light behind it",
    depicts: "A dark door in a frame; when it OPENs, warm light pours out across the floor; a sign can sit above it. CLOSE shuts it.",
    goodFor: ["opportunity", "a new door opens", "doors closing", "options", "the way out", "a fresh start", "access", "locked out"],
    params: [P("open", "0 shut .. 1 wide open"), P("label", "sign above the door"), P("width", "width (m)"), P("height", "height (m)"), P("glow", "light intensity")],
    example: { cast: [A("door", "DOOR", { params: { label: "OPTIONS" } }), A("me", "FIGURE", { position: [0, 0, 2.5], rotation: [0, 180, 0] })], actions: [{ do: "OPEN", actor: "door", at: 0.5 }, { do: "WALK", actor: "me", to: [0, 0, 0.6], at: 1.6 }], focus: "door", duration: 4 },
  },
  WALLS: {
    title: "Walls closing in",
    depicts: "Two tall dark walls facing each other that slide together (CLOSE), a red warning line glowing brighter as the gap shrinks.",
    goodFor: ["walls closing in", "pressure", "squeezed", "trapped", "no room to breathe", "debt piling up", "running out of options", "paycheck to paycheck"],
    params: [P("closed", "0 open .. 1 almost touching"), P("gap", "open gap (m)"), P("height", "wall height (m)"), P("length", "wall length (m)")],
    example: { cast: [A("walls", "WALLS"), A("me", "FIGURE", { params: { pose: "PUSH" } })], actions: [{ do: "CLOSE", actor: "walls", at: 0.3, duration: 3 }, { do: "POSE", actor: "me", pose: "SLUMP", at: 2.4 }], focus: "walls", duration: 4 },
  },
  WHEEL: {
    title: "Hamster wheel / treadmill",
    depicts: "A big gold hamster wheel on a dark stand, spinning; put a FIGURE inside with cycle RUN to show running in place.",
    goodFor: ["rat race", "running in place", "hamster wheel", "treadmill", "working harder to stay in the same place", "burnout", "the grind"],
    params: [P("speed", "turns per second (SPIN animates it; rotation is integrated, so speeding up is smooth)"), P("radius", "wheel radius (m)")],
    example: { cast: [A("wheel", "WHEEL"), A("me", "FIGURE", { position: [0, 0.1, 0], rotation: [0, 90, 0], params: { cycle: "RUN", cadence: 1.4 } })], actions: [{ do: "SPIN", actor: "wheel", to: 0.6, at: 0 }], focus: "wheel" },
  },
  SNOWBALL: {
    title: "Snowball (growing as it rolls)",
    depicts: "A gold-white snowball that grows (GROW) while it rolls across the floor — its spin follows the distance it travels.",
    goodFor: ["snowball effect", "debt snowball", "momentum", "it keeps growing", "compounding", "small start, big result"],
    params: [P("growth", "0 small .. 1 huge (radius 0.3 → 1.5 m)")],
    example: { cast: [A("ball", "SNOWBALL", { position: [-3, 0, 0] })], actions: [{ do: "MOVE", actor: "ball", to: [2, 0, 0], at: 0.2, duration: 3, ease: "EASE_IN" }, { do: "GROW", actor: "ball", to: 0.8, at: 0.2, duration: 3, ease: "EASE_IN" }], focus: "ball", duration: 3.6 },
  },
  TREE: {
    title: "Money tree (compounding growth)",
    depicts: "A bronze tree that grows branch by branch — every branch splits again — and sprouts gold coin-leaves at the tips.",
    goodFor: ["compounding", "growth", "planting a seed", "money doesn't grow on trees", "let it grow", "long term", "patience pays", "your money working for you"],
    params: [P("growth", "0 sapling .. 1 full tree"), P("levels", "branching depth 2..7"), P("leaves", "gold leaves on/off")],
    example: { cast: [A("tree", "TREE", { params: { growth: 0 } })], actions: [{ do: "GROW", actor: "tree", at: 0.2, duration: 3 }], focus: "tree", duration: 3.8 },
  },
  BLOCKS: {
    title: "Doubling blocks",
    depicts: "Gold cubes that keep doubling — 1, 2, 4, 8, 16 … — new ones popping in each generation.",
    goodFor: ["doubles", "exponential", "multiplies", "rule of 72", "2x", "it grows faster and faster"],
    params: [P("generations", "how many doublings (float animates the next one in)", "0..8"), P("size", "cube size (m)")],
    example: { cast: [A("blocks", "BLOCKS", { params: { generations: 0 } })], actions: [{ do: "GROW", actor: "blocks", to: 6, at: 0.2, duration: 3 }], focus: "blocks", duration: 3.8 },
  },
  BUCKET: {
    title: "Leaky bucket",
    depicts: "A dark metal bucket filling with gold; coins stream in from above (inflow) and keep leaking out of holes in its side.",
    goodFor: ["money leaks", "where does it all go", "leaky bucket", "small expenses drain you", "earning more but saving nothing", "spending leaks", "plug the leaks"],
    params: [P("fill", "fill level 0..1 (FILL / DRAIN)"), P("leaks", "number of holes 0..6"), P("inflow", "coins pouring in 0..1"), P("radius", "radius (m)"), P("height", "height (m)")],
    example: { cast: [A("bucket", "BUCKET", { params: { fill: 0.5, leaks: 4, inflow: 1 } })], actions: [{ do: "DRAIN", actor: "bucket", to: 0.2, at: 0.5, duration: 3 }], focus: "bucket" },
  },
  HOURGLASS: {
    title: "Hourglass",
    depicts: "A glass hourglass in a gold frame; gold sand falls from the top bulb into the bottom (FILL = time passing).",
    goodFor: ["time is running out", "time in the market", "it takes time", "the clock is ticking", "deadline", "waiting", "years go by"],
    params: [P("progress", "0 all sand on top .. 1 all fallen"), P("height", "height (m)")],
    example: { cast: [A("glass", "HOURGLASS", { params: { progress: 0.1 } })], actions: [{ do: "FILL", actor: "glass", to: 0.8, at: 0.2, duration: 3 }], focus: "glass" },
  },
  CHAIN: {
    title: "Chain that breaks",
    depicts: "A heavy steel chain strung between two posts; on BREAK the middle link snaps with a flash and the halves swing down.",
    goodFor: ["break free", "debt free", "break the cycle", "freedom", "chained to your job", "shackles", "finally free"],
    params: [P("broken", "0 intact .. 1 snapped"), P("links", "number of links"), P("length", "span (m)"), P("height", "height (m)")],
    example: { cast: [A("chain", "CHAIN"), A("me", "FIGURE", { position: [0, 0, 1.2] })], actions: [{ do: "BREAK", actor: "chain", at: 1 }, { do: "POSE", actor: "me", pose: "CHEER", at: 1.2 }], focus: "chain", duration: 3.5 },
  },
  FORK_PATH: {
    title: "Fork in the road (two futures)",
    depicts: "A dark road with gold edges that splits into two branches toward the horizon, each with a label; a light travels down the trunk and into the chosen branch while the other dims.",
    goodFor: ["two futures", "a choice", "fork in the road", "decision", "which path", "same raise, different life", "two versions of you", "crossroads"],
    params: [P("progress", "the light's journey 0..1 (REVEAL)"), P("choose", "LEFT, RIGHT or NONE"), P("leftLabel", "left branch label"), P("rightLabel", "right branch label"), P("length", "road length (m)")],
    example: { cast: [A("fork", "FORK_PATH", { params: { leftLabel: "SPEND IT", rightLabel: "INVEST IT", choose: "RIGHT" } })], actions: [{ do: "REVEAL", actor: "fork", at: 0.2, duration: 3 }], focus: "fork", set: { kind: "HORIZON" }, camera: { rig: "PUSH_IN", target: [0, 0.3, -2], from: { distance: 11, elevation: 22 }, to: { distance: 9, elevation: 18 }, lens: { focalLength: 28 } } },
  },
  MAGNIFIER: {
    title: "Magnifying glass (reveal)",
    depicts: "A gold magnifying glass; inside its lens enlarged words appear (REVEAL) — usually held over a DOCUMENT's fine print.",
    goodFor: ["read the fine print", "hidden fees", "look closer", "the catch", "what they don't tell you", "zoom in"],
    params: [P("text", "the enlarged words shown in the lens"), P("reveal", "0..1"), P("size", "lens radius (m)")],
    example: { cast: [A("doc", "DOCUMENT", { params: { title: "LOAN AGREEMENT", fine: "*APR rises to 29.99% after 12 months." } }), A("lens", "MAGNIFIER", { position: [0.2, 0.35, 0.5], params: { text: "APR rises to 29.99% after 12 months" } })], actions: [{ do: "REVEAL", actor: "lens", at: 0.5 }, { do: "REVEAL", actor: "doc", at: 0.5 }], focus: "doc" },
  },
  DOCUMENT: {
    title: "Contract / statement page",
    depicts: "A cream paper page leaning back slightly: a bold title, gray lines of text and a tiny line of fine print at the bottom that can be underlined in gold (REVEAL).",
    goodFor: ["contract", "terms and conditions", "the agreement", "statement", "paperwork", "the fine print", "loan offer"],
    params: [P("title", "heading"), P("lines", "lines of text"), P("fine", "the fine print line"), P("reveal", "gold underline under the fine print 0..1")],
    example: { cast: [A("doc", "DOCUMENT")], actions: [{ do: "REVEAL", actor: "doc", at: 0.5 }], focus: "doc" },
  },
  RECEIPT: {
    title: "Receipt unrolling",
    depicts: "A paper receipt printing out of a dark slot and unrolling downward line by line, ending with a TOTAL in gold.",
    goodFor: ["it adds up", "the real cost", "the bill", "itemized", "add it all up", "the total", "what it actually costs"],
    params: [P("items", 'lines as "Rent|$300"'), P("unroll", "0..1 (UNROLL)"), P("total", "total text")],
    example: { cast: [A("rcpt", "RECEIPT", { params: { items: ["Rent|$300", "Car|$180", "Subscriptions|$60"], total: "$540/mo" } })], actions: [{ do: "UNROLL", actor: "rcpt", at: 0.2, duration: 2.6 }], focus: "rcpt" },
  },
  CALENDAR: {
    title: "Flip calendar",
    depicts: "A desk calendar on a dark stand whose pages flip over one after another (FLIP to a page number), each page a big month/day label under a gold header.",
    goodFor: ["every month", "month after month", "time passes", "a year later", "deadlines", "recurring", "every payday"],
    params: [P("page", "current page (float; FLIP to N flips through pages)"), P("labels", "page labels")],
    example: { cast: [A("cal", "CALENDAR")], actions: [{ do: "FLIP", actor: "cal", to: 5, at: 0.2, duration: 3 }], focus: "cal" },
  },
  GAUGE: {
    title: "Dial gauge",
    depicts: "A round gold-rimmed dial with tick marks running gold into red and a glowing needle that sweeps as the value FILLs.",
    goodFor: ["credit score", "risk level", "stress", "pressure rising", "speed", "how close you are", "a meter"],
    params: [P("value", "0..1 needle position (FILL / DRAIN)"), P("label", "caption under the dial"), P("low", "left end label"), P("high", "right end label")],
    example: { cast: [A("g", "GAUGE", { params: { label: "CREDIT SCORE", low: "300", high: "850" } })], actions: [{ do: "FILL", actor: "g", to: 0.82, at: 0.3, duration: 2.2 }], focus: "g" },
  },
  METER: {
    title: "Tube meter / thermometer",
    depicts: "A tall glass tube on a dark base filling with glowing gold liquid (turning red near the top), with tick marks and a label.",
    goodFor: ["progress toward a goal", "emergency fund", "savings goal", "filling up", "how full", "debt level", "temperature rising"],
    params: [P("value", "fill 0..1 (FILL / DRAIN / RAISE)"), P("label", "label above"), P("height", "tube height (m)")],
    example: { cast: [A("m", "METER", { params: { label: "EMERGENCY FUND" } })], actions: [{ do: "FILL", actor: "m", to: 0.6, at: 0.3, duration: 2.4 }], focus: "m" },
  },
  DIVIDER: {
    title: "Before / after divider",
    depicts: "A glowing vertical light-wall splitting the floor in two: a cool, dim left half and a warm right half, labeled (e.g. BEFORE / AFTER). Put contrasting scenes on each side.",
    goodFor: ["before and after", "then vs now", "with vs without", "comparison", "two versions", "the difference"],
    params: [P("leftLabel", "left label"), P("rightLabel", "right label"), P("height", "wall height (m)"), P("length", "length (m)")],
    example: { cast: [A("div", "DIVIDER"), A("a", "FIGURE", { position: [-1.6, 0, 0], params: { pose: "SLUMP" } }), A("b", "FIGURE", { position: [1.6, 0, 0], params: { pose: "CHEER" } })], actions: [], focus: "div" },
  },
  HOUSE: {
    title: "House",
    depicts: "A miniature dark house with a gabled roof, a chimney, warm lit windows and a glowing door.",
    goodFor: ["buying a house", "mortgage", "home", "down payment", "rent vs buy", "family", "housing"],
    params: [P("size", "scale"), P("glow", "window light"), P("color", "wall color")],
    example: { cast: [A("house", "HOUSE")], actions: [{ do: "PULSE", actor: "house", at: 1 }], focus: "house" },
  },
  PHONE: {
    title: "Smartphone",
    depicts: "A giant black smartphone standing upright with a lit screen showing a big gold number/word and a line under it (a balance, a notification).",
    goodFor: ["your bank app", "a notification", "checking your balance", "a payment alert", "screen time", "phone bill", "one tap"],
    params: [P("text", "big screen text (e.g. $2,413)"), P("sub", "line under it"), P("glow", "screen brightness")],
    example: { cast: [A("phone", "PHONE", { params: { text: "$2,413", sub: "Available balance" } })], actions: [{ do: "PULSE", actor: "phone", at: 1 }], focus: "phone" },
  },
  BANK_CARD: {
    title: "Bank card (unbranded)",
    depicts: "An original unbranded dark metal bank card with a gold chip, fine gold diagonal lines and •••• last-four digits.",
    goodFor: ["credit card", "debit card", "swipe", "credit card debt", "paying with plastic", "interest charges"],
    params: [P("label", "gold text on the card"), P("last4", "last four digits"), P("color", "card color")],
    example: { cast: [A("card", "BANK_CARD", { params: { label: "CREDIT" } })], actions: [{ do: "TURN", actor: "card", to: [0, 25, 0], at: 0.3, duration: 2 }], focus: "card" },
  },
  BAR_CHART: {
    title: "3D bar chart",
    depicts: "Solid gold bars rising from the floor in a staggered wave, labels on the floor in front; one bar can glow while the others go dark (highlight).",
    goodFor: ["comparison", "breakdown", "which one is bigger", "statistics", "data", "growth over years", "average vs you"],
    params: [P("values", "bar values"), P("labels", "labels"), P("progress", "growth 0..1 (GROW)"), P("highlight", "index to highlight (-1 none)"), P("spacing", "bar spacing (m)"), P("maxHeight", "tallest bar (m)")],
    example: { cast: [A("bars", "BAR_CHART", { params: { values: [2, 4, 9], labels: ["Save", "Invest", "Both"], progress: 0, highlight: 2 } })], actions: [{ do: "GROW", actor: "bars", at: 0.2, duration: 2.4 }], focus: "bars" },
  },
  LINE_CHART: {
    title: "3D line chart (glowing ribbon)",
    depicts: "A glowing gold tube tracing a line chart in the air in front of a faint grid, drawing itself left to right.",
    goodFor: ["the trend", "the market goes up and down", "over time", "growth curve", "a stock chart", "volatility"],
    params: [P("values", "points"), P("progress", "how much is drawn 0..1 (GROW)"), P("width", "width (m)"), P("maxHeight", "height (m)")],
    example: { cast: [A("line", "LINE_CHART", { params: { values: [1, 1.6, 1.2, 2.4, 2.1, 3.6, 4.4], progress: 0 } })], actions: [{ do: "GROW", actor: "line", at: 0.2, duration: 2.6 }], focus: "line" },
  },
  PIE_CHART: {
    title: "3D donut / pie chart",
    depicts: "An extruded donut chart lying on the floor in brand colors (gold, violet, teal, coral); slices sweep in and one can be pulled out (explode).",
    goodFor: ["where your money goes", "budget breakdown", "50/30/20", "share", "a slice of", "percentage"],
    params: [P("values", "slice values"), P("labels", "slice labels"), P("progress", "sweep 0..1 (GROW)"), P("explode", "index of the slice pulled out (-1 none)"), P("radius", "radius (m)")],
    example: { cast: [A("pie", "PIE_CHART", { params: { values: [50, 30, 20], labels: ["Needs", "Wants", "Save"], progress: 0, explode: 2 } })], actions: [{ do: "GROW", actor: "pie", at: 0.2, duration: 2.4 }], focus: "pie" },
  },
  TEXT_3D: {
    title: "Text in the world",
    depicts: "Big words or a number standing in the 3D world as a layered, extruded-looking sign (GOLD, NEON or STONE), rising in as it REVEALs.",
    goodFor: ["a key word", "the number", "a label in the scene", "title in the world", "a big statistic", "the name of the thing"],
    avoid: "Not a substitute for on-screen typography (shot.text) — use it when the word should live IN the scene.",
    params: [P("text", "the words"), P("size", "cap height (m)"), P("style", "GOLD | NEON | STONE"), P("reveal", "0..1")],
    example: { cast: [A("word", "TEXT_3D", { params: { text: "$140,650", size: 0.8, reveal: 0 } })], actions: [{ do: "REVEAL", actor: "word", at: 0.3 }], focus: "word" },
  },
  ARROW: {
    title: "Trend arrow",
    depicts: "A chunky extruded arrow angled like a chart trend — gold pointing up, coral pointing down — growing out of the floor.",
    goodFor: ["going up", "going down", "rising prices", "falling value", "inflation", "trend", "up and to the right"],
    params: [P("direction", "UP | DOWN"), P("growth", "0..1 (GROW)"), P("length", "length (m)")],
    example: { cast: [A("arrow", "ARROW", { params: { growth: 0 } })], actions: [{ do: "GROW", actor: "arrow", at: 0.2, duration: 1.8 }], focus: "arrow" },
  },
};

// ---------------------------------------------------------------------------------------------
// ACTIONS

interface ActionDoc {
  title: string;
  depicts: string;
  goodFor: string[];
  params: CatalogParam[];
  /** Index into an actor example to reuse (the action's example). */
  exampleFrom: ActorKind;
}

const ap = (name: string, type: CatalogParam["type"], meaning: string, def: unknown = undefined, range?: string): CatalogParam => ({ name, type, default: def, meaning, ...(range ? { range } : {}) });
const common = [ap("actor", "string", "the actor id"), ap("at", "string", 'anchor: seconds, "start"/"end", {"word":"…"} or {"fraction":0.5}'), ap("duration", "number", "seconds"), ap("ease", "string", "CINEMATIC EASE_IN_OUT EASE_OUT EASE_IN LINEAR SNAP SPRING")];

const ACTION_DOCS: Record<(typeof ACTION_TYPES)[number], ActionDoc> = {
  ENTER: { title: "Enter", depicts: "The actor appears: RISE from below, DROP in from above, GROW from nothing, FADE in, or BUILD piece by piece.", goodFor: ["introduce", "appears", "arrives", "here comes"], params: [...common, ap("style", "string", "RISE DROP GROW FADE BUILD", "RISE")], exampleFrom: "BUILDING" },
  EXIT: { title: "Exit", depicts: "The actor leaves: DISSOLVE, SINK into the floor, SHRINK, FADE or SHATTER apart.", goodFor: ["gone", "disappears", "vanishes", "lost"], params: [...common, ap("style", "string", "DISSOLVE SINK SHRINK FADE SHATTER", "DISSOLVE")], exampleFrom: "COIN_STACK" },
  MOVE: { title: "Move", depicts: "Glide the actor smoothly across the stage to an absolute point in the world (cinematic ease in and out).", goodFor: ["moves", "slides", "goes to"], params: [...common, ap("to", "number[]", "[x,y,z] meters")], exampleFrom: "CAR" },
  TURN: { title: "Turn", depicts: "Rotate the actor in place to new Euler angles in degrees — turn a card to face the camera, spin a car around.", goodFor: ["turns", "spins around", "faces"], params: [...common, ap("to", "number[]", "[x,y,z] degrees")], exampleFrom: "BANK_CARD" },
  SCALE: { title: "Scale", depicts: "Grow or shrink the whole actor uniformly — something gets bigger or smaller than life.", goodFor: ["gets bigger", "shrinks", "blows up"], params: [...common, ap("to", "number", "scale factor")], exampleFrom: "HOUSE" },
  SET: { title: "Set a parameter", depicts: "Animate any numeric parameter (count, level, glow, progress…) or switch a string/boolean one.", goodFor: ["changes", "goes from X to Y", "count down", "count up"], params: [...common, ap("param", "string", "parameter name"), ap("to", "number", "new value")], exampleFrom: "COIN_STACK" },
  FLOW: { title: "Flow coins into", depicts: "Coins lift off a COIN_STACK and fly in arcs into another actor (the source count drops, a target stack's count rises).", goodFor: ["money goes to", "pays for", "pulls money away", "feeds", "transfers"], params: [...common, ap("into", "string", "target actor id"), ap("amount", "number", "coins")], exampleFrom: "COIN_STACK" },
  PULSE: { title: "Pulse", depicts: "A quick emphasis bump: the actor swells slightly and settles, like a nod to the viewer — look at this one.", goodFor: ["this one", "emphasis", "notice"], params: [...common, ap("strength", "number", "0..2", 1)], exampleFrom: "HOUSE" },
  GLOW: { title: "Glow", depicts: "Animate the actor's glow — its light/emissive level brightens or fades (e.g. the growth part of the chart lights up).", goodFor: ["lights up", "shines", "highlight"], params: [...common, ap("to", "number", "0..3")], exampleFrom: "COIN_CHART" },
  SHIFT: { title: "Shift (relative move)", depicts: "Move the actor BY an offset — lift it, drop it, slide it sideways.", goodFor: ["lifted", "raised up", "pushed back", "moves up"], params: [...common, ap("by", "number[]", "[dx,dy,dz] meters")], exampleFrom: "HOUSE" },
  POSE: { title: "Pose (person)", depicts: "Blend a FIGURE/CROWD into a pose: STAND WALK RUN SIT CLIMB CHEER SLUMP THINK REACH PUSH CARRY POINT BALANCE.", goodFor: ["celebrates", "gives up", "thinks", "reaches for", "sits down", "points at", "pushes against", "defeated", "relieved"], params: [...common, ap("pose", "string", "pose name")], exampleFrom: "FIGURE" },
  WALK: { title: "Walk / run to", depicts: "A FIGURE walks (or runs) to a point, turning to face the way it goes, legs and arms cycling in step with the distance.", goodFor: ["walks toward", "walks away", "runs", "heads to", "moves on", "the journey"], params: [...common, ap("to", "number[]", "[x,y,z]"), ap("pace", "number", "m/s (walk 1.25, run 3.2)"), ap("run", "boolean", "run instead of walk", false)], exampleFrom: "FIGURE" },
  CLIMB: { title: "Climb", depicts: "A FIGURE climbs a STAIRS (step by step) or a LADDER (hand over hand) from `from` to `to` (0 bottom, 1 top).", goodFor: ["climbs", "step by step", "moves up", "works their way up", "gets out of a hole"], params: [...common, ap("on", "string", "STAIRS or LADDER actor id"), ap("from", "number", "0..1", 0), ap("to", "number", "0..1", 1)], exampleFrom: "STAIRS" },
  PATH: { title: "Follow a path", depicts: "Any actor travels a smooth curve through points (orient: face the way it moves).", goodFor: ["winding road", "the journey", "rolls along", "flies around"], params: [...common, ap("points", "number[]", "list of [x,y,z]"), ap("orient", "boolean", "face along the path", false)], exampleFrom: "SNOWBALL" },
  OPEN: { title: "Open", depicts: "Open a DOOR (light pours out) or pull WALLS apart.", goodFor: ["opens up", "a door opens", "opportunity", "room to breathe"], params: [...common, ap("to", "number", "target (default: fully open)")], exampleFrom: "DOOR" },
  CLOSE: { title: "Close", depicts: "Shut a DOOR so its light disappears, or push two WALLS together until there is almost no room left.", goodFor: ["closes", "shut out", "walls closing in", "trapped"], params: [...common, ap("to", "number", "target")], exampleFrom: "WALLS" },
  FILL: { title: "Fill", depicts: "Fill a BUCKET, GAUGE, METER or HOURGLASS (sand falls).", goodFor: ["fills up", "rising", "adds up", "time passes"], params: [...common, ap("to", "number", "0..1 (default 1)")], exampleFrom: "METER" },
  DRAIN: { title: "Drain", depicts: "Empty a BUCKET of its gold, swing a GAUGE needle back down, or drain a METER tube toward zero.", goodFor: ["drains", "empties", "runs out", "leaks away"], params: [...common, ap("to", "number", "0..1 (default 0)")], exampleFrom: "BUCKET" },
  GROW: { title: "Grow", depicts: "Grow a TREE, SNOWBALL, BLOCKS (doubling), a chart (BAR/LINE/PIE/COIN_CHART), an ARROW, or a COIN_STACK's count.", goodFor: ["grows", "compounds", "multiplies", "builds up", "gets bigger over time"], params: [...common, ap("to", "number", "target (default: full)")], exampleFrom: "TREE" },
  BREAK: { title: "Break", depicts: "Snap a CHAIN: the middle link flashes and flies, the halves swing down.", goodFor: ["break free", "breaks the cycle", "freedom", "snap"], params: [...common], exampleFrom: "CHAIN" },
  TIP: { title: "Tip the scale", depicts: "Tilt a BALANCE: -1 left side down, 1 right side down.", goodFor: ["tips the scales", "outweighs", "the balance shifts"], params: [...common, ap("to", "number", "-1..1 (default 1)")], exampleFrom: "BALANCE" },
  FLIP: { title: "Flip calendar pages", depicts: "Flip a CALENDAR to page N (each whole number is one page turning over).", goodFor: ["months go by", "every month", "time flies"], params: [...common, ap("to", "number", "page number (required)")], exampleFrom: "CALENDAR" },
  UNROLL: { title: "Unroll", depicts: "Print/unroll a RECEIPT line by line down to its total.", goodFor: ["it adds up", "the bill comes", "itemized"], params: [...common, ap("to", "number", "0..1 (default 1)")], exampleFrom: "RECEIPT" },
  REVEAL: { title: "Reveal", depicts: "Reveal the MAGNIFIER's enlarged words, underline a DOCUMENT's fine print, raise a TEXT_3D, or send the light down a FORK_PATH.", goodFor: ["reveals", "the truth", "look closer", "here's the catch", "which path"], params: [...common, ap("to", "number", "0..1 (default 1)")], exampleFrom: "MAGNIFIER" },
  RAISE: { title: "Raise", depicts: "Raise a PLATFORM (and everything riding on it), a BASELINE plane or a METER.", goodFor: ["raised your baseline", "raise the bar", "lifts", "goes up", "the floor rises"], params: [...common, ap("to", "number", "new level in meters (required for PLATFORM/BASELINE)")], exampleFrom: "PLATFORM" },
  LOWER: { title: "Lower", depicts: "Lower a PLATFORM (and everything riding on it) back toward the floor, or bring a BASELINE plane / METER level down.", goodFor: ["lowers", "drops", "comes down", "cut back"], params: [...common, ap("to", "number", "new level (default 0)")], exampleFrom: "PLATFORM" },
  SPIN: { title: "Spin", depicts: "Change a WHEEL's speed (turns per second); rotation is integrated so it speeds up/slows smoothly.", goodFor: ["faster and faster", "spinning", "the grind speeds up", "slows down"], params: [...common, ap("to", "number", "turns per second (default 1)")], exampleFrom: "WHEEL" },
};

// ---------------------------------------------------------------------------------------------
// SETS

const SET_DOCS: Record<(typeof SET_KINDS)[number], { title: string; depicts: string; goodFor: string[] }> = {
  INFINITY_STUDIO: { title: "Infinity studio", depicts: "A dark, warm product-photography studio: endless black floor with a soft reflection, a background sweep with a warm glow, haze and floating dust.", goodFor: ["default", "premium", "focus on one object", "money as an object"] },
  NUMBERS_VOID: { title: "Numbers void", depicts: "A cool blue-black void with a teal floor grid (use the NOIR_NUMBERS look) — inside the spreadsheet.", goodFor: ["the math", "data", "statistics", "cold truth"] },
  CITY_NIGHT: { title: "City at night", depicts: "The studio floor with a distant procedural skyline of dark towers with warm lit windows all around.", goodFor: ["city life", "cost of living", "rent", "work", "commute", "everyone around you"] },
  ROOM: { title: "Minimal room", depicts: "A minimal dark interior: a back wall with a tall bright window of warm light and a side wall.", goodFor: ["at home", "your apartment", "the kitchen table conversation", "late at night", "personal"] },
  HORIZON: { title: "Open horizon", depicts: "An open dark plain with a glowing gold horizon band and a violet sky above — space for journeys and futures.", goodFor: ["the future", "two paths", "the journey", "long term", "retirement", "freedom"] },
};

// ---------------------------------------------------------------------------------------------
// RECIPES — metaphors composed from the vocabulary

interface RecipeDoc {
  id: string;
  title: string;
  depicts: string;
  goodFor: string[];
  avoid?: string;
  example: CatalogExample;
}

const RECIPES: RecipeDoc[] = [
  {
    id: "raise-baseline",
    title: "The floor rises under your life",
    depicts: "A person stands with their house, car and phone on a wide dark platform level with the floor; the platform rises, lifting all of them, while a dashed outline stays at the old floor level and the front face reads YOUR BASELINE.",
    goodFor: ["you raised your baseline", "lifestyle creep", "lifestyle inflation", "your new normal", "now you need more just to feel normal", "the cost of your life went up", "you can't go back"],
    example: {
      cast: [
        A("floor", "PLATFORM", { params: { width: 7, depth: 4.5, label: "YOUR BASELINE", ghost: true } }),
        A("me", "FIGURE", { parent: "floor", position: [0, 0, 0.6] }),
        A("house", "HOUSE", { parent: "floor", position: [-2, 0, -0.8], params: { size: 0.75 } }),
        A("car", "CAR", { parent: "floor", position: [2, 0, -0.2], rotation: [0, -30, 0], params: { color: "#26252B" } }),
      ],
      actions: [
        { do: "RAISE", actor: "floor", to: 1.6, at: 0.6, duration: 2.2 },
        { do: "POSE", actor: "me", pose: "BALANCE", at: 0.6, duration: 0.5 },
        { do: "POSE", actor: "me", pose: "STAND", at: 2.9, duration: 0.6 },
      ],
      focus: "floor",
      camera: { rig: "CRANE_UP", target: [0, 1, 0], from: { distance: 13, azimuth: 20, elevation: 3 }, to: { distance: 13.5, azimuth: 28, elevation: 12 }, lens: { focalLength: 30, fStop: 3.2 } },
      duration: 4,
    },
  },
  {
    id: "money-evaporates",
    title: "Money evaporates",
    depicts: "A pile of gold coins loses a share of its coins: they lift, spin and dissolve into gold dust.",
    goodFor: ["taxes take 35%", "gone", "it disappears", "inflation eats it", "fees take a cut"],
    example: { cast: [A("pile", "COIN_STACK", { params: { count: 100, columns: 7 } })], actions: [{ do: "SET", actor: "pile", param: "count", to: 65, at: 0.4, duration: 1.4 }], focus: "pile" },
  },
  {
    id: "spending-pulls-money",
    title: "Spending pulls money away",
    depicts: "Coins fly in arcs off a pile into the thing that costs money (a building for rent, a car, a phone).",
    goodFor: ["rent takes", "the car payment eats", "money goes to", "where it went", "every bill takes a bite"],
    example: { cast: [A("pile", "COIN_STACK", { params: { count: 60, columns: 7 } }), A("b", "BUILDING", { position: [-3, 0, -1] })], actions: [{ do: "FLOW", actor: "pile", into: "b", amount: 24, at: 0.3, duration: 1.6 }], focus: "pile", camera: { rig: "HOLD", target: [-1.5, 1, -0.4], from: { distance: 9, azimuth: -20, elevation: 10 }, lens: { focalLength: 30 } } },
  },
  {
    id: "climb-out",
    title: "Step by step climb",
    depicts: "A person climbs a glowing staircase step by step and stands at the top.",
    goodFor: ["step by step", "one step at a time", "climb out of debt", "progress not perfection", "build it slowly"],
    example: { cast: [A("stairs", "STAIRS", { params: { steps: 10 } }), A("me", "FIGURE", { position: [-2.5, 0, 0] })], actions: [{ do: "CLIMB", actor: "me", on: "stairs", at: 0.2, duration: 3.4 }, { do: "POSE", actor: "me", pose: "CHEER", at: 3.6 }], focus: "stairs", duration: 4.4 },
  },
  {
    id: "rat-race",
    title: "Running in place",
    depicts: "A person runs inside a spinning gold hamster wheel, going nowhere, the wheel speeding up.",
    goodFor: ["rat race", "running in place", "paycheck to paycheck", "working harder, getting nowhere", "the grind"],
    example: { cast: [A("wheel", "WHEEL", { params: { speed: 0.3 } }), A("me", "FIGURE", { position: [0, 0.1, 0], rotation: [0, 90, 0], params: { cycle: "RUN", cadence: 1.5 } })], actions: [{ do: "SPIN", actor: "wheel", to: 0.8, at: 0.5, duration: 2.5 }], focus: "wheel" },
  },
  {
    id: "walls-closing",
    title: "Walls closing in",
    depicts: "Two walls slide toward a person who pushes back and then slumps.",
    goodFor: ["debt closing in", "pressure", "squeezed", "trapped", "no room in the budget"],
    example: { cast: [A("walls", "WALLS"), A("me", "FIGURE", { params: { pose: "PUSH" } })], actions: [{ do: "CLOSE", actor: "walls", at: 0.3, duration: 3 }, { do: "POSE", actor: "me", pose: "SLUMP", at: 2.6 }], focus: "walls", duration: 4 },
  },
  {
    id: "leaky-bucket",
    title: "Leaky bucket",
    depicts: "Coins pour into a bucket while streams of coins leak out of holes in its side — it never fills.",
    goodFor: ["money leaks", "where does it go", "earning more, saving nothing", "plug the leaks", "small expenses"],
    example: { cast: [A("bucket", "BUCKET", { params: { fill: 0.35, leaks: 5, inflow: 1 } })], actions: [], focus: "bucket" },
  },
  {
    id: "snowball",
    title: "Snowball effect",
    depicts: "A small ball rolls across the floor and grows huge as it goes.",
    goodFor: ["snowball effect", "debt snowball", "momentum", "compounding", "it builds on itself"],
    example: ACTOR_DOCS.SNOWBALL.example,
  },
  {
    id: "compound-tree",
    title: "Money tree grows",
    depicts: "A tree grows branch by branch and sprouts gold coin-leaves.",
    goodFor: ["compounding", "let your money grow", "plant it now", "long-term investing", "patience"],
    example: ACTOR_DOCS.TREE.example,
  },
  {
    id: "doubling",
    title: "Doubling",
    depicts: "Gold cubes double again and again: 1, 2, 4, 8, 16, 32.",
    goodFor: ["doubles every 10 years", "rule of 72", "exponential", "multiplies"],
    example: ACTOR_DOCS.BLOCKS.example,
  },
  {
    id: "break-free",
    title: "Break the chain",
    depicts: "A chain snaps in front of a person who throws their arms up.",
    goodFor: ["debt free", "break free", "break the cycle", "freedom", "you don't have to stay stuck"],
    example: ACTOR_DOCS.CHAIN.example,
  },
  {
    id: "two-futures",
    title: "Two futures",
    depicts: "A road splits in two toward a glowing horizon; the light travels down one branch (e.g. INVEST IT) while the other (SPEND IT) dims.",
    goodFor: ["same raise, different life", "two choices", "fork in the road", "the decision", "two versions of you"],
    example: ACTOR_DOCS.FORK_PATH.example,
  },
  {
    id: "fine-print",
    title: "Read the fine print",
    depicts: "A contract page with a magnifying glass over its fine print; enlarged words appear in the lens and the line is underlined in gold.",
    goodFor: ["read the fine print", "hidden fees", "the catch", "what the bank doesn't tell you", "terms apply"],
    example: ACTOR_DOCS.MAGNIFIER.example,
  },
  {
    id: "it-adds-up",
    title: "It adds up",
    depicts: "A receipt prints out line by line ending in a gold total.",
    goodFor: ["it adds up", "the real monthly cost", "itemized", "add it all up"],
    example: ACTOR_DOCS.RECEIPT.example,
  },
  {
    id: "time-passes",
    title: "Time passes",
    depicts: "Calendar pages flip month after month (or an hourglass empties).",
    goodFor: ["every month", "month after month", "years go by", "time in the market"],
    example: ACTOR_DOCS.CALENDAR.example,
  },
  {
    id: "weigh-it",
    title: "Tip the scales",
    depicts: "A balance scale tips toward the heavier pan of coins.",
    goodFor: ["needs vs wants", "the trade-off", "outweighs", "is it worth it"],
    example: ACTOR_DOCS.BALANCE.example,
  },
  {
    id: "door-opens",
    title: "A door opens",
    depicts: "A door swings open, light pours out, a person walks toward it.",
    goodFor: ["opportunity", "options open up", "a way out", "a fresh start"],
    example: ACTOR_DOCS.DOOR.example,
  },
  {
    id: "many-vs-one",
    title: "Most people vs you",
    depicts: "A crowd of dark figures with one gold figure standing out.",
    goodFor: ["most people", "the average person", "everyone else", "be the one", "only 1 in 10"],
    example: ACTOR_DOCS.CROWD.example,
  },
  {
    id: "before-after",
    title: "Before / after",
    depicts: "A light-wall splits the floor: a slumped person in the cool BEFORE half, a celebrating one in the warm AFTER half.",
    goodFor: ["before and after", "then vs now", "with vs without a budget"],
    example: ACTOR_DOCS.DIVIDER.example,
  },
];

// ---------------------------------------------------------------------------------------------
// assembled catalog

function actorEntry(kind: ActorKind): CatalogEntry {
  const d = ACTOR_DOCS[kind];
  const focusActor = d.example.cast.find((a) => a.id === d.example.focus);
  return {
    id: kind,
    type: "ACTOR",
    title: d.title,
    depicts: d.depicts,
    goodFor: d.goodFor,
    ...(d.avoid ? { avoid: d.avoid } : {}),
    params: paramsFor(kind, d.params.filter((p) => p.name in DEFAULT_PARAMS[kind])).concat(
      d.params.filter((p) => !(p.name in DEFAULT_PARAMS[kind])).map((p) => ({ ...p, type: "string" as const, default: undefined })),
    ),
    verbs: verbsFor(kind),
    framing: defaultFraming(kind, focusActor?.params ?? {}),
    example: d.example,
  };
}

export const VISUAL_CATALOG: CatalogEntry[] = [
  ...ACTOR_KINDS.map(actorEntry),
  ...ACTION_TYPES.map((t): CatalogEntry => {
    const d = ACTION_DOCS[t];
    return { id: `action:${t}`, type: "ACTION", title: d.title, depicts: d.depicts, goodFor: d.goodFor, params: d.params, example: ACTOR_DOCS[d.exampleFrom].example };
  }),
  ...SET_KINDS.map((k): CatalogEntry => {
    const d = SET_DOCS[k];
    return {
      id: `set:${k}`,
      type: "SET",
      title: d.title,
      depicts: d.depicts,
      goodFor: d.goodFor,
      params: [],
      example: { cast: [A("me", "FIGURE"), A("house", "HOUSE", { position: [2.4, 0, -1.5], params: { size: 0.7 } })], actions: [], focus: "me", set: { kind: k }, camera: { rig: "HOLD", target: [0.8, 1, -0.5], from: { distance: 9, azimuth: 12, elevation: 8 }, lens: { focalLength: 28 } } },
    };
  }),
  ...RECIPES.map((r): CatalogEntry => ({ id: `recipe:${r.id}`, type: "RECIPE", title: r.title, depicts: r.depicts, goodFor: r.goodFor, ...(r.avoid ? { avoid: r.avoid } : {}), params: [], example: r.example })),
];

/** Text a model embeds for an entry (depicts + good-for + title). */
export function catalogEntryText(e: CatalogEntry): string {
  return `${e.title}. ${e.depicts} Good for: ${e.goodFor.join("; ")}.`;
}

export function getCatalogEntry(id: string): CatalogEntry | undefined {
  return VISUAL_CATALOG.find((e) => e.id === id);
}

// ---------------------------------------------------------------------------------------------
// examples → runnable one-shot films

/** A one-shot, validating film that shows a catalog entry's example (also used by tests/storyboards). */
export function catalogExampleFilm(entry: CatalogEntry, opts: { width?: number; height?: number } = {}): Film {
  const ex = entry.example;
  const focus = ex.cast.find((a) => a.id === ex.focus) ?? ex.cast[0]!;
  const fr = defaultFraming(focus.kind, focus.params ?? {});
  const camera: CameraSpec = ex.camera ?? {
    rig: "ORBIT",
    // track the actor (it may walk, roll or rise during the example)
    target: focus.id,
    from: { distance: fr.distance, azimuth: -14, elevation: fr.elevation },
    to: { distance: fr.distance * 0.94, azimuth: 10, elevation: fr.elevation + 4 },
    lens: { focalLength: fr.focalLength, fStop: 4 },
    drift: 0.08,
  };
  const safeId = entry.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return {
    dsl: 1,
    id: `cat-${safeId}`.slice(0, 48),
    title: entry.title.slice(0, 80),
    format: { width: opts.width ?? 1080, height: opts.height ?? 1920, fps: 30 },
    look: entry.id === "NUMBER_WALL" || entry.id === "set:NUMBERS_VOID" ? "NOIR_NUMBERS" : "GOLD_STUDIO",
    captions: "OFF",
    seed: 7,
    cast: ex.cast,
    scenes: [{ id: "s", set: ex.set ?? { kind: "INFINITY_STUDIO", floorGloss: 0.5, haze: 0.3, particles: 0.3 }, shots: [{ id: "shot", duration: ex.duration ?? 3.4, camera, actions: ex.actions }] }],
  };
}

// ---------------------------------------------------------------------------------------------
// deterministic keyword search (no model)

const STOP = new Set("a an the and or of to in on for your you it is are was be with that this at by from as its it's".split(" "));
const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9%$ ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ""));

/** Keyword relevance of entries to a phrase (cheap, deterministic): phrase hits in goodFor weigh most. */
export function searchCatalog(query: string, opts: { types?: CatalogEntryType[]; limit?: number } = {}): Array<{ entry: CatalogEntry; score: number }> {
  const q = new Set(tokens(query));
  const ql = query.toLowerCase();
  const out: Array<{ entry: CatalogEntry; score: number }> = [];
  for (const e of VISUAL_CATALOG) {
    if (opts.types && !opts.types.includes(e.type)) continue;
    let score = 0;
    for (const g of e.goodFor) {
      const gl = g.toLowerCase();
      if (ql.includes(gl)) score += 3 + gl.split(" ").length;
      const gt = tokens(g);
      const hit = gt.filter((t) => q.has(t)).length;
      if (hit) score += (hit / gt.length) * 2;
    }
    const dt = new Set(tokens(`${e.title} ${e.depicts}`));
    for (const t of q) if (dt.has(t)) score += 0.4;
    // a recipe is a whole literal metaphor — prefer it over its parts when it matches as well
    if (score > 0 && e.type === "RECIPE") score *= 1.25;
    if (score > 0) out.push({ entry: e, score: Math.round(score * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, opts.limit ?? 10);
}
