import type { ActorKind } from "./dsl/schema";

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
  CARD_FAN: { count: 8, labels: [], radius: 1.4 },
  BASELINE: { level: 0.05, label: "", size: 6 },
  COIN_CHART: { values: [], split: [], progress: 0, spacing: 1.25, glow: 0 },
  NUMBER_WALL: { density: 0.6 },
  LIGHT_SHAFT: { width: 1.6, strength: 0.8 },
};

/** Height of an actor's visual center above its position (unscaled), for targeting/focus. */
export function actorCenterHeight(kind: ActorKind, params: Record<string, unknown>): number {
  const n = (k: string, d: number) => (typeof params[k] === "number" ? (params[k] as number) : d);
  switch (kind) {
    case "COIN_STACK":
      return (Math.ceil(Math.max(1, n("count", 10)) / Math.max(1, n("columns", 1))) * COIN_PITCH) / 2;
    case "PEDESTAL":
      return n("height", 0.9) / 2;
    case "BUILDING":
      return (n("floors", 6) * 0.42) / 2;
    case "CAR":
      return 0.35;
    case "BASELINE":
      return n("level", 0);
    case "LIGHT_SHAFT":
      return 2;
    case "COIN_CHART": {
      const vals = Array.isArray(params.values) ? params.values.map(Number) : [];
      const max = vals.length ? Math.max(...vals) : 0;
      return (max * COIN_PITCH * n("progress", 1)) / 2;
    }
    default:
      return 0;
  }
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
    const n = ring * 6;
    for (let k = 0; k < n && out.length < columns; k++) {
      const a = (k / n) * Math.PI * 2 + ring * 0.4;
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
