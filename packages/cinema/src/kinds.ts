import type { ActorKind, Verb } from "./dsl/schema";

/**
 * Physical dimensions of the procedural actors — shared by the evaluator (camera targets,
 * focus distances) and the renderer (geometry), so "look at the top of the stack" and the
 * stack's actual top are the same number. Meters.
 */
export const COIN = { radius: 0.5, thickness: 0.075, gap: 0.004 } as const;
export const COIN_PITCH = COIN.thickness + COIN.gap;

export const DEFAULT_PARAMS: Record<ActorKind, Record<string, number | string | boolean | Array<string | number>>> = {
  COIN_STACK: { count: 40, columns: 1, jitter: 0.5 },
  PEDESTAL: { radius: 1.1, height: 0.9 },
  BUILDING: { floors: 6, glow: 0.8, width: 1.4 },
  CAR: { color: "#E5A94A" },
  CARD: { label: "", price: "", glow: 0.6 },
  CARD_FAN: { count: 8, labels: [], radius: 1.4, cardScale: 1 },
  BASELINE: { level: 0.05, label: "", size: 6 },
  COIN_CHART: { values: [], split: [], progress: 0, spacing: 1.25, glow: 0 },
  NUMBER_WALL: { density: 0.6 },
  LIGHT_SHAFT: { width: 1.6, strength: 0.8 },
  FIGURE: { pose: "STAND", height: 1.8, color: "#E9E2D6", accent: "#E5A94A" },
  CROWD: { count: 40, spacing: 0.9, highlight: -1, pose: "STAND", color: "#5B5650", highlightColor: "#F3C46A" },
  PLATFORM: { level: 0, width: 8, depth: 5, label: "", ghost: false, glow: 0.8 },
  STAIRS: { steps: 8, rise: 0.22, run: 0.38, width: 1.4, glow: 0.6 },
  LADDER: { height: 4, rungs: 12, width: 0.7 },
  BALANCE: { tilt: 0, leftCount: 3, rightCount: 8, leftLabel: "", rightLabel: "", auto: false },
  DOOR: { open: 0, label: "", width: 1.2, height: 2.4, glow: 1 },
  WALLS: { closed: 0, height: 3, length: 4, gap: 6 },
  WHEEL: { speed: 0.4, radius: 1.4 },
  SNOWBALL: { growth: 0 },
  TREE: { growth: 1, levels: 5, leaves: true },
  BLOCKS: { generations: 3, size: 0.5 },
  BUCKET: { fill: 0.6, leaks: 3, inflow: 0, radius: 0.8, height: 1.2 },
  HOURGLASS: { progress: 0, height: 1.6 },
  CHAIN: { broken: 0, links: 14, length: 5, height: 1.2 },
  FORK_PATH: { progress: 0, leftLabel: "", rightLabel: "", choose: "NONE", length: 14 },
  MAGNIFIER: { reveal: 0, text: "", size: 0.6 },
  DOCUMENT: { title: "AGREEMENT", lines: 10, fine: "*Fees and terms may apply.", reveal: 0 },
  RECEIPT: { items: [], unroll: 0, total: "" },
  CALENDAR: { page: 0, labels: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] },
  GAUGE: { value: 0, label: "", low: "", high: "" },
  METER: { value: 0, label: "", height: 3 },
  DIVIDER: { leftLabel: "BEFORE", rightLabel: "AFTER", height: 4, length: 10 },
  HOUSE: { size: 1, glow: 0.8, color: "#2A2622" },
  PHONE: { text: "", sub: "", glow: 1 },
  BANK_CARD: { label: "", last4: "4821", color: "#17141C" },
  BAR_CHART: { values: [3, 5, 8], labels: [], progress: 1, highlight: -1, spacing: 1.2, maxHeight: 4 },
  LINE_CHART: { values: [1, 2, 1.6, 3, 4.5], progress: 1, width: 8, maxHeight: 3 },
  PIE_CHART: { values: [60, 25, 15], labels: [], progress: 1, explode: -1, radius: 1.5 },
  TEXT_3D: { text: "", size: 1, style: "GOLD", reveal: 1 },
  ARROW: { direction: "UP", growth: 1, length: 4 },
};

const n = (params: Record<string, unknown>, k: string, d: number) => (typeof params[k] === "number" && Number.isFinite(params[k]) ? (params[k] as number) : d);
const len = (params: Record<string, unknown>, k: string) => (Array.isArray(params[k]) ? (params[k] as unknown[]).length : 0);

export function snowballRadius(growth: number): number {
  return 0.3 + Math.max(0, growth) * 1.2;
}

/** Height of an actor's visual center above its position (unscaled), for targeting/focus. */
export function actorCenterHeight(kind: ActorKind, params: Record<string, unknown>): number {
  switch (kind) {
    case "COIN_STACK":
      return (Math.ceil(Math.max(1, n(params, "count", 10)) / Math.max(1, n(params, "columns", 1))) * COIN_PITCH) / 2;
    case "PEDESTAL":
      return n(params, "height", 0.9) / 2;
    case "BUILDING":
      return (n(params, "floors", 6) * 0.42) / 2;
    case "CAR":
      return 0.35;
    case "BASELINE":
      return n(params, "level", 0);
    case "LIGHT_SHAFT":
      return 2;
    case "COIN_CHART": {
      const vals = Array.isArray(params.values) ? params.values.map(Number) : [];
      const max = vals.length ? Math.max(...vals) : 0;
      return (max * COIN_PITCH * n(params, "progress", 1)) / 2;
    }
    case "FIGURE":
      return n(params, "height", 1.8) * 0.55;
    case "CROWD":
      return 0.9;
    case "PLATFORM":
      return n(params, "level", 0) / 2;
    case "STAIRS":
      return (n(params, "steps", 8) * n(params, "rise", 0.22)) / 2;
    case "LADDER":
      return n(params, "height", 4) / 2;
    case "BALANCE":
      return 1.6;
    case "DOOR":
      return n(params, "height", 2.4) / 2;
    case "WALLS":
      return n(params, "height", 3) / 2;
    case "WHEEL":
      return n(params, "radius", 1.4) + 0.1;
    case "SNOWBALL":
      return snowballRadius(n(params, "growth", 0));
    case "TREE":
      return 2 * Math.max(0.2, n(params, "growth", 1));
    case "BLOCKS":
      return n(params, "size", 0.5) * 2;
    case "BUCKET":
      return n(params, "height", 1.2) / 2;
    case "HOURGLASS":
      return n(params, "height", 1.6) / 2;
    case "CHAIN":
      return n(params, "height", 1.2);
    case "FORK_PATH":
      return 0.2;
    case "MAGNIFIER":
      return 0;
    case "DOCUMENT":
      return 0.95;
    case "RECEIPT":
      return 1.7;
    case "CALENDAR":
      return 0.6;
    case "GAUGE":
      return 1.25;
    case "METER":
      return n(params, "height", 3) / 2;
    case "DIVIDER":
      return n(params, "height", 4) / 2;
    case "HOUSE":
      return n(params, "size", 1);
    case "PHONE":
      return 0.8;
    case "BANK_CARD":
      return 0.6;
    case "BAR_CHART":
      return (n(params, "maxHeight", 4) * n(params, "progress", 1)) / 2;
    case "LINE_CHART":
      return n(params, "maxHeight", 3) / 2;
    case "PIE_CHART":
      return 0.4;
    case "TEXT_3D":
      return n(params, "size", 1) * 0.6;
    case "ARROW":
      return n(params, "length", 4) * 0.4;
    default:
      return 0;
  }
}

/** Where a child actor stands on this one (parent → child "rides on it"): its top surface. */
export function actorTopHeight(kind: ActorKind, params: Record<string, unknown>): number {
  switch (kind) {
    case "PLATFORM":
      return Math.max(0, n(params, "level", 0));
    case "BASELINE":
      return n(params, "level", 0);
    case "PEDESTAL":
      return n(params, "height", 0.9);
    case "STAIRS":
      return n(params, "steps", 8) * n(params, "rise", 0.22);
    default:
      return actorCenterHeight(kind, params) * 2;
  }
}

/**
 * What a semantic verb does to each kind: which param it drives and the natural target when the
 * action gives no `to`. `default: null` = `to` is required. A verb on a kind not listed here is a
 * validation error (the hint lists the kinds it applies to).
 */
export const VERB_TARGETS: Record<Verb, Partial<Record<ActorKind, { param: string; default: number | null }>>> = {
  OPEN: { DOOR: { param: "open", default: 1 }, WALLS: { param: "closed", default: 0 } },
  CLOSE: { DOOR: { param: "open", default: 0 }, WALLS: { param: "closed", default: 1 } },
  FILL: { BUCKET: { param: "fill", default: 1 }, GAUGE: { param: "value", default: 1 }, METER: { param: "value", default: 1 }, HOURGLASS: { param: "progress", default: 1 } },
  DRAIN: { BUCKET: { param: "fill", default: 0 }, GAUGE: { param: "value", default: 0 }, METER: { param: "value", default: 0 } },
  GROW: {
    TREE: { param: "growth", default: 1 },
    SNOWBALL: { param: "growth", default: 1 },
    BLOCKS: { param: "generations", default: 5 },
    BAR_CHART: { param: "progress", default: 1 },
    LINE_CHART: { param: "progress", default: 1 },
    PIE_CHART: { param: "progress", default: 1 },
    COIN_CHART: { param: "progress", default: 1 },
    ARROW: { param: "growth", default: 1 },
    COIN_STACK: { param: "count", default: null },
  },
  BREAK: { CHAIN: { param: "broken", default: 1 } },
  TIP: { BALANCE: { param: "tilt", default: 1 } },
  FLIP: { CALENDAR: { param: "page", default: null } },
  UNROLL: { RECEIPT: { param: "unroll", default: 1 } },
  REVEAL: { MAGNIFIER: { param: "reveal", default: 1 }, DOCUMENT: { param: "reveal", default: 1 }, TEXT_3D: { param: "reveal", default: 1 }, FORK_PATH: { param: "progress", default: 1 } },
  RAISE: { PLATFORM: { param: "level", default: null }, BASELINE: { param: "level", default: null }, METER: { param: "value", default: 1 } },
  LOWER: { PLATFORM: { param: "level", default: 0 }, BASELINE: { param: "level", default: 0 }, METER: { param: "value", default: 0 } },
  SPIN: { WHEEL: { param: "speed", default: 1 } },
};

/** Camera-friendly default framing per kind at scale 1 (where a director would start). */
export interface Framing {
  distance: number;
  focalLength: number;
  elevation: number;
  lift: number;
}

/** Approximate [width, height] an actor occupies (m, scale 1) — what the camera must fit. */
export function actorFootprint(kind: ActorKind, params: Record<string, unknown>): [number, number] {
  const p = { ...DEFAULT_PARAMS[kind], ...params };
  const h = actorCenterHeight(kind, p) * 2;
  switch (kind) {
    case "COIN_STACK":
      return [n(p, "columns", 1) <= 1 ? 1.2 : n(p, "columns", 1) <= 7 ? 3.3 : n(p, "columns", 1) <= 19 ? 5.5 : 7.7, Math.max(0.6, h)];
    case "PEDESTAL":
      return [n(p, "radius", 1.1) * 2.3, n(p, "height", 0.9) + 1];
    case "BUILDING":
      return [n(p, "width", 1.4) * 1.2, h];
    case "CAR":
      return [2.5, 1];
    case "CARD":
      return [1.1, 0.8];
    case "CARD_FAN":
      return [(n(p, "radius", 1.4) + n(p, "cardScale", 1) * 0.5) * 2, 1.6 + n(p, "cardScale", 1) * 0.6];
    case "BASELINE":
      return [n(p, "size", 6) * 0.7, 1];
    case "COIN_CHART":
    case "BAR_CHART":
      return [len(p, "values") * n(p, "spacing", 1.2), Math.max(1, h)];
    case "NUMBER_WALL":
    case "LIGHT_SHAFT":
      return [3, 5];
    case "FIGURE":
      return [0.9, n(p, "height", 1.8)];
    case "CROWD":
      return [Math.sqrt(n(p, "count", 40) * 1.6) * n(p, "spacing", 0.9), 1.8];
    case "PLATFORM":
      return [n(p, "width", 8), Math.max(1, n(p, "level", 0) + 2)];
    case "STAIRS":
      return [n(p, "steps", 8) * n(p, "run", 0.38) + 0.8, h + 1.8];
    case "LADDER":
      return [1.2, n(p, "height", 4) + 0.6];
    case "BALANCE":
      return [3.6, 2.4];
    case "DOOR":
      return [n(p, "width", 1.2) * 2, n(p, "height", 2.4) + 0.8];
    case "WALLS":
      return [n(p, "gap", 6) + 0.8, n(p, "height", 3)];
    case "WHEEL":
      return [n(p, "radius", 1.4) * 2.3, n(p, "radius", 1.4) * 2.3];
    case "SNOWBALL":
      return [snowballRadius(1) * 2, snowballRadius(1) * 2];
    case "TREE":
      return [4.5, 5];
    case "BLOCKS":
      return [n(p, "size", 0.5) * 4.4, n(p, "size", 0.5) * 4];
    case "BUCKET":
      return [n(p, "radius", 0.8) * 3.2, n(p, "height", 1.2) + 1.2];
    case "HOURGLASS":
      return [1.2, n(p, "height", 1.6)];
    case "CHAIN":
      return [n(p, "length", 5) + 0.6, n(p, "height", 1.2) + 0.8];
    case "FORK_PATH":
      return [n(p, "length", 14) * 0.6, 3];
    case "MAGNIFIER":
      return [1.6, 1.6];
    case "DOCUMENT":
      return [1.6, 2.1];
    case "RECEIPT":
      return [1.8, 3.4];
    case "CALENDAR":
      return [1.3, 1.4];
    case "GAUGE":
      return [2.3, 2.9];
    case "METER":
      return [1.4, n(p, "height", 3) + 0.7];
    case "DIVIDER":
      return [6.5, n(p, "height", 4)];
    case "HOUSE":
      return [2.4 * n(p, "size", 1), 2.2 * n(p, "size", 1)];
    case "PHONE":
      return [1, 1.8];
    case "BANK_CARD":
      return [1.9, 1.4];
    case "LINE_CHART":
      return [n(p, "width", 8) + 0.6, n(p, "maxHeight", 3) + 0.6];
    case "PIE_CHART":
      return [n(p, "radius", 1.5) * 2.6, 1.6];
    case "TEXT_3D":
      return [Math.max(1, String(p.text ?? "").length * n(p, "size", 1) * 0.75), n(p, "size", 1) * 1.8];
    case "ARROW":
      return [n(p, "length", 4) * 0.8, n(p, "length", 4)];
    default:
      return [2, Math.max(1, h)];
  }
}

const H_FOV_32 = 2 * Math.atan(10.125 / 32); // 9:16 with a 36 mm long side → 20.25 mm short side
const V_FOV_32 = 2 * Math.atan(18 / 32);

export function defaultFraming(kind: ActorKind, params: Record<string, unknown> = {}): Framing {
  const [w, h] = actorFootprint(kind, params);
  // fit the width to ~70 % of the frame's width and the height to ~55 % of its height
  const dw = w / 0.82 / (2 * Math.tan(H_FOV_32 / 2));
  const dh = h / 0.55 / (2 * Math.tan(V_FOV_32 / 2));
  const distance = Math.round((Math.max(dw, dh) + Math.min(w, 4) * 0.15) * 10) / 10;
  const elevation = kind === "FORK_PATH" || kind === "CROWD" || kind === "PIE_CHART" ? 26 : kind === "CALENDAR" || kind === "BUCKET" || kind === "COIN_STACK" ? 16 : 9;
  return { distance, focalLength: 32, elevation, lift: 0 };
}

/** Top of a stack (for "the coin lands on top" moments). */
export function stackTop(count: number): number {
  return Math.max(0, count) * COIN_PITCH;
}

/** Column centers of a multi-column stack (tight cluster: center + rings), unit coin radius. */
export function stackColumnOffsets(columns: number): Array<[number, number]> {
  const out: Array<[number, number]> = [[0, 0]];
  const d = COIN.radius * 2.06;
  let ring = 1;
  while (out.length < columns) {
    const k = ring * 6;
    for (let i = 0; i < k && out.length < columns; i++) {
      const a = (i / k) * Math.PI * 2 + ring * 0.4;
      out.push([Math.cos(a) * d * ring, Math.sin(a) * d * ring]);
    }
    ring++;
  }
  return out.slice(0, Math.max(1, columns));
}

/** Coin i of a stack → (column, level). Coins fill level by level, so removal comes off the top. */
export function stackSlot(i: number, columns: number): { column: number; level: number } {
  const c = Math.max(1, columns);
  return { column: i % c, level: Math.floor(i / c) };
}

/** Stairs / ladder climbing path in the host's local frame: u 0..1 → [x, y, z] (feet position). */
export function climbLocalPoint(kind: "STAIRS" | "LADDER", params: Record<string, unknown>, u: number): [number, number, number] {
  const k = Math.max(0, Math.min(1, u));
  if (kind === "LADDER") {
    const h = n(params, "height", 4);
    return [0, k * (h - 0.4), 0.42];
  }
  const steps = Math.max(1, Math.round(n(params, "steps", 8)));
  const rise = n(params, "rise", 0.22);
  const run = n(params, "run", 0.38);
  const L = steps * run;
  // from just before the first tread to the middle of the top tread
  const x = -L / 2 - 0.5 * run + k * L;
  const rel = (x + L / 2) / run;
  let level = 0;
  if (rel >= 0) {
    const i = Math.floor(rel);
    const f = Math.min(1, (rel - i) / 0.3);
    level = Math.min(steps, i + f * f * (3 - 2 * f));
  }
  return [x, level * rise, 0];
}
