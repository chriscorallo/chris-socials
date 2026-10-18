/**
 * Baked preview graphics (docs/decisions-pending/editor-rebuild.md) — PURE, browser-safe.
 *
 * The editor preview no longer runs every motion graphic as live Remotion DOM (CSS/SVG
 * filters, three.js) on Chris's phone: WebKit rasterises those filters on the CPU — measured
 * at 0.5–1 s of main thread PER FRAME in WebKit, 0 in Chrome. Instead the real renderer
 * pre-renders each graphic once ("bake") at half size into one H.264 stream with the alpha
 * stacked under the colour, and the preview composites that decoded video in WebGL.
 *
 * A bake is identified by a key over EVERYTHING that changes the graphic's pixels: the visual
 * itself (minus its id — ids never reach pixels), its interaction track (follow-Chris /
 * camera-ride positions, which depend on clips and zooms), the canvas, the motion theme, the
 * fps and the bake format version. Change any of them and the key changes, so a stale bake is
 * never shown (it's simply a cache miss → live preview until the new bake lands).
 */

/** Bump when the bake format or the renderer's look changes (invalidates every bake). */
export const GRAPHIC_BAKE_VERSION = 1;
/** Bakes are rendered at this fraction of the canvas (1080x1920 → 540x960). */
export const GRAPHIC_BAKE_SCALE = 0.5;
export const GRAPHIC_BAKE_FPS = 30;

/** JSON with object keys sorted (stable across engines / key order). `undefined` dropped. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** 64-bit (two 32-bit lanes) FNV-1a/murmur-mix string hash as 16 hex chars — a cache key, not crypto. */
export function hash64(s: string): string {
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

export interface GraphicBakeInput {
  /** The TimelineVisual (any shape — validated by the job before rendering). */
  visual: { id: string; start: number; end: number } & Record<string, unknown>;
  /** Its VisualInteraction track at `fps`, or null. */
  interaction: unknown;
  canvas: { width: number; height: number };
  motionTheme: unknown;
  fps: number;
}

/**
 * The bake's identity. The visual's absolute `start`/`end` are reduced to its DURATION in
 * frames: moving a graphic along the timeline doesn't change its pixels (its animation is
 * relative to its own first frame), so it keeps its bake.
 */
export function graphicBakeKey(input: GraphicBakeInput): string {
  const { id: _id, start, end, ...rest } = input.visual;
  void _id;
  const from = Math.max(0, Math.round(start * input.fps));
  const frames = Math.max(1, Math.round(end * input.fps) - from);
  return `g${GRAPHIC_BAKE_VERSION}-${hash64(
    stableStringify({ v: GRAPHIC_BAKE_VERSION, visual: rest, frames, interaction: input.interaction ?? null, canvas: input.canvas, motionTheme: input.motionTheme ?? null, fps: input.fps }),
  )}`;
}

/**
 * The bake frame to show at OUTPUT time t, or null when the graphic isn't on screen — the
 * same frame math as the renderer (visualFrameWindow: from = round(start·fps), frames =
 * round(end·fps) − from; the composition's frame n is output frame from + n).
 */
export function bakeFrameAt(visual: { start: number; end: number }, t: number, fps: number, frames: number | null = null): number | null {
  const from = Math.max(0, Math.round(visual.start * fps));
  const n = Math.max(1, frames ?? Math.round(visual.end * fps) - from);
  const f = Math.floor(t * fps + 1e-6) - from;
  return f >= 0 && f < n ? f : null;
}
