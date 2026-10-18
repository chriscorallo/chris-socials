import type { GraphicAnimation } from "@chris/media/timeline";

/**
 * PURE sequencing for composable graphics (`@chris/motion/pure`): when each element (cell,
 * bar, card, row, slice…) of a GRAPHIC starts its entrance, from the animation settings.
 *
 * Elements are given as GROUPS in reading order — e.g. Chris's income comparison is three
 * groups (Employee, Freelance, Business owner) of 12 cells each. Orders:
 * - TOGETHER        everything at once;
 * - STAGGER         one after another in reading order (`stagger` s apart);
 * - GROUP_BY_GROUP  group after group: a group's cells stagger, then `groupPause`, then the
 *                   next group ("Employee, then Freelance, then Business owner");
 * - ONE_BY_ONE      strictly sequential — each lands before the next starts.
 *
 * The build always FITS: if the requested timing would still be revealing when the graphic
 * starts to leave (minus a short hold so the last value can be read), every offset is
 * compressed proportionally. Deterministic, frame-based — identical in preview and render.
 */

export interface GraphicSequence {
  /** Start frame (local to the visual) of element i of group g. */
  at(g: number, i: number): number;
  /** Frames each element's entrance takes. */
  len: number;
  /** Frame at which group g's last element has finished revealing. */
  groupDone(g: number): number;
  /** Frame at which everything has been revealed. */
  done: number;
  /** Frame of the first element's start. */
  first: number;
  /** Total element count. */
  count: number;
  /** Flat reading-order index of (g, i). */
  flat(g: number, i: number): number;
}

export interface SequenceOptions {
  fps: number;
  durationInFrames: number;
  exitFrames: number;
  /** First element's start (default 0.18 s, while the container settles). */
  startFrame?: number;
  /** Motion-language tempo multiplier (MotionFeel.tempo). */
  tempo?: number;
  /** Seconds the fully built graphic should hold before its exit (default 0.6). */
  holdSeconds?: number;
}

export function graphicSequence(groups: number[], anim: Pick<GraphicAnimation, "order" | "stagger" | "groupPause" | "speed">, o: SequenceOptions): GraphicSequence {
  const { fps } = o;
  const speed = Math.max(0.25, anim.speed || 1);
  const tempo = o.tempo ?? 1;
  const s0 = Math.max(0, Math.round(o.startFrame ?? 0.18 * fps));
  let len = Math.max(6, Math.round((0.55 * fps) / speed));
  const st = Math.max(0, (anim.stagger * fps * tempo) / speed);
  const pause = (anim.groupPause * fps * tempo) / speed;
  const sizes = groups.map((n) => Math.max(0, Math.floor(n)));
  const offsets: number[][] = [];
  let k = 0;
  let cursor = 0;
  for (let g = 0; g < sizes.length; g++) {
    const row: number[] = [];
    for (let i = 0; i < sizes[g]!; i++) {
      switch (anim.order) {
        case "TOGETHER":
          row.push(0);
          break;
        case "STAGGER":
          row.push(k * st);
          break;
        case "ONE_BY_ONE":
          row.push(k * Math.max(st, len * 0.75));
          break;
        case "GROUP_BY_GROUP":
          row.push(cursor + i * st);
          break;
      }
      k++;
    }
    if (anim.order === "GROUP_BY_GROUP" && row.length) cursor = row[row.length - 1]! + len + pause;
    offsets.push(row);
  }
  const maxOff = offsets.reduce((a, r) => Math.max(a, ...r, 0), 0);
  const hold = Math.round((o.holdSeconds ?? 0.6) * fps);
  // Latest frame by which everything must be revealed.
  const budget = Math.max(s0 + 6, o.durationInFrames - o.exitFrames - hold);
  if (s0 + len > budget) len = Math.max(4, budget - s0);
  let scale = 1;
  if (maxOff > 0 && s0 + maxOff + len > budget) scale = Math.max(0, (budget - s0 - len) / maxOff);
  const starts = offsets.map((r) => r.map((x) => Math.round(s0 + x * scale)));
  const flatIndex: number[][] = [];
  let n = 0;
  for (const r of starts) flatIndex.push(r.map(() => n++));
  const groupDone = (g: number) => {
    const r = starts[g];
    if (!r || !r.length) return s0;
    return Math.max(...r) + len;
  };
  return {
    at: (g, i) => starts[g]?.[i] ?? s0,
    len,
    groupDone,
    done: starts.reduce((a, r) => Math.max(a, ...r.map((x) => x + len)), s0),
    first: s0,
    count: n,
    flat: (g, i) => flatIndex[g]?.[i] ?? 0,
  };
}

/** Single list of `n` elements (one group). */
export function listSequence(n: number, anim: Pick<GraphicAnimation, "order" | "stagger" | "groupPause" | "speed">, o: SequenceOptions): GraphicSequence {
  // A single list treats GROUP_BY_GROUP like STAGGER (there is only one group).
  const order = anim.order === "GROUP_BY_GROUP" ? "STAGGER" : anim.order;
  return graphicSequence([n], { ...anim, order }, o);
}

/**
 * Frame the highlighted element's emphasis fires: after it has been revealed, and — when the
 * speaker's vocal emphasis (Motion v2 `hitAtFrame`) comes later — on that word.
 */
export function emphasisFrame(revealedAt: number, hitAtFrame: number | null | undefined): number {
  return hitAtFrame != null && hitAtFrame > revealedAt ? Math.round(hitAtFrame) : revealedAt + 2;
}

/**
 * Element-level exit progress 0..1 for REVERSE / DROP / FADE_UP: elements leave in turn over
 * the last ~0.6 s (REVERSE = last-in first-out). CONTAINER → always 0 (the graphic's own exit).
 */
export function elementExitProgress(
  mode: GraphicAnimation["exit"],
  frame: number,
  flatIndex: number,
  count: number,
  o: { fps: number; durationInFrames: number },
): number {
  if (mode === "CONTAINER") return 0;
  const win = Math.max(4, Math.min(Math.round(0.6 * o.fps), Math.floor(o.durationInFrames * 0.25)));
  const start = o.durationInFrames - win;
  const each = Math.max(3, Math.round(win * 0.55));
  const spread = win - each;
  const order = mode === "REVERSE" ? count - 1 - flatIndex : flatIndex;
  const s = start + (count > 1 ? (order / (count - 1)) * spread : 0);
  const t = (frame - s) / each;
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t;
}
