import type { EditTimeline } from "../timeline";
import type { TimelineVisual } from "../motion-contract";
import type { Rect } from "../safe-zones";
import { directorPlacementArea } from "./area";
export { directorPlacementArea };
import {
  captionBandRect,
  intersectionArea,

  rectArea,
  subjectRegionsForWindow,
  visualRect,
  type PlacementOptions,
} from "../visual-placement";
import { footprintOf, footprintPx } from "../visual-footprints";
import { layoutTimelineText, type MeasureText } from "../timeline-layout";
import { PROTECTED_HEAD_EXPANSION } from "../subject-track-core";

/**
 * The face itself (brow to chin) inside a protected head region on the canvas. Anchored on the
 * region's BOTTOM and width (the top is often clamped at the frame edge in close selfies, which
 * makes a top-anchored inverse over-estimate the face). Face boxes are ~1.1× taller than wide.
 */
export function faceFromHead(head: Rect): Rect {
  const e = PROTECTED_HEAD_EXPANSION;
  const fw = head.width / (1 + 2 * e.sides);
  const fh = fw * 1.1;
  const bottom = head.y + head.height - e.bottom * fh;
  return { x: head.x + e.sides * fw, y: Math.max(head.y, bottom - fh), width: fw, height: Math.min(fh, bottom - head.y) };
}
import { timelineCaptionChunks } from "../timeline-captions";
import type { DirectorRegion } from "./schema";

/**
 * Region-constrained placement for the Director chat — PURE, deterministic.
 *
 * Chris asks for a side ("the bills on the other side of the screen"): the graphic is solved
 * INSIDE that region around his face — grid search over centres × scales — with his actual face
 * (brow to chin, from the face track, over the graphic's whole time window) as a HARD obstacle,
 * the hair/neck margin and torso as soft costs, captions/texts/other graphics on screen at the
 * same time as hard obstacles, and the platform-safe area as the bounds. If the region has no
 * clear spot even at the smallest legible size, the nearest region is tried and the change list
 * says so. The result is saved as a MANUAL placement (x, y, scale) — the renderer draws MANUAL
 * graphics exactly where they are, so preview and export match.
 */

export interface RegionPlacement {
  x: number;
  y: number;
  scale: number;
  region: DirectorRegion;
  /** The region it ended up in (differs from `region` when it had to move). */
  used: DirectorRegion;
  /** Plain sentence when it had to move / shrink / overlap. */
  note: string | null;
  clear: boolean;
}

/** Smallest scale the Director will shrink a graphic to (legibility on a phone). */
export const DIRECTOR_MIN_SCALE = 0.42;
const SIZE_CAP = { S: 0.55, M: 0.8, L: 1.0 } as const;

const FALLBACKS: Record<DirectorRegion, DirectorRegion[]> = {
  LEFT: ["LEFT", "BOTTOM_LEFT", "TOP_LEFT", "BOTTOM", "TOP"],
  RIGHT: ["RIGHT", "BOTTOM_RIGHT", "TOP_RIGHT", "BOTTOM", "TOP"],
  TOP: ["TOP", "TOP_LEFT", "TOP_RIGHT", "BOTTOM"],
  BOTTOM: ["BOTTOM", "BOTTOM_LEFT", "BOTTOM_RIGHT", "TOP"],
  CENTER: ["CENTER", "BOTTOM", "TOP"],
  TOP_LEFT: ["TOP_LEFT", "LEFT", "TOP", "BOTTOM_LEFT"],
  TOP_RIGHT: ["TOP_RIGHT", "RIGHT", "TOP", "BOTTOM_RIGHT"],
  BOTTOM_LEFT: ["BOTTOM_LEFT", "LEFT", "BOTTOM", "TOP_LEFT"],
  BOTTOM_RIGHT: ["BOTTOM_RIGHT", "RIGHT", "BOTTOM", "TOP_RIGHT"],
  AUTO: ["CENTER", "BOTTOM", "TOP", "LEFT", "RIGHT"],
};

export const REGION_WORD: Record<DirectorRegion, string> = {
  LEFT: "left",
  RIGHT: "right",
  TOP: "top",
  BOTTOM: "bottom",
  CENTER: "centre",
  TOP_LEFT: "upper left",
  TOP_RIGHT: "upper right",
  BOTTOM_LEFT: "lower left",
  BOTTOM_RIGHT: "lower right",
  AUTO: "best free spot",
};

export interface DirectorObstacleContext {
  options: PlacementOptions;
  measure?: MeasureText;
}

function inflate(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m };
}

/** Hard/soft obstacles on screen during [start, end] (except the visual itself). */
export function obstaclesForWindow(
  timeline: EditTimeline,
  selfId: string,
  start: number,
  end: number,
  others: Array<{ id: string; rect: Rect; start: number; end: number; fullFrame: boolean }>,
  ctx: DirectorObstacleContext,
): { face: Rect | null; head: Rect | null; body: Rect | null; hard: Rect[] } {
  const sub = subjectRegionsForWindow(timeline, start, end, ctx.options);
  const face = sub.head ? faceFromHead(sub.head) : null;
  const hard: Rect[] = [];
  const canvas = timeline.canvas;
  // Captions only where words are actually on screen in this window.
  if (timeline.captions.enabled) {
    const chunks = timelineCaptionChunks(timeline, (ctx.options.wordsByAsset ?? {}) as never);
    if (chunks.some((c) => c.start < end && c.end > start)) hard.push(captionBandRect(timeline.captions, canvas));
  }
  for (const t of timeline.texts) {
    if (t.start < end && t.end > start) {
      try {
        if (ctx.measure) hard.push(layoutTimelineText(t, canvas, ctx.measure).rect);
        else hard.push(estimateTextRect(t, canvas));
      } catch {
        hard.push(estimateTextRect(t, canvas));
      }
    }
  }
  for (const o of others) {
    if (o.id !== selfId && !o.fullFrame && o.start < end && o.end > start) hard.push(o.rect);
  }
  return { face, head: sub.head, body: sub.body, hard };
}

function estimateTextRect(t: EditTimeline["texts"][number], canvas: { width: number; height: number }): Rect {
  const k = canvas.width / 1080;
  const fontPx = t.fontSize * k;
  const maxW = t.maxWidth * canvas.width;
  const textW = t.text.length * fontPx * 0.56;
  const lines = Math.max(1, Math.ceil(textW / maxW));
  const pad = t.backgroundColor ? fontPx * 0.5 : fontPx * 0.1;
  const w = Math.min(maxW, textW) + 2 * pad;
  const h = lines * fontPx * 1.2 + 2 * pad;
  return { x: t.x * canvas.width - w / 2, y: t.y * canvas.height - h / 2, width: w, height: h };
}

/** Is a candidate centre inside the requested region (relative to the face)? */
function inRegion(region: DirectorRegion, cx: number, cy: number, rect: Rect, face: Rect | null, safe: Rect): boolean {
  const fcx = face ? face.x + face.width / 2 : safe.x + safe.width / 2;
  const fcy = face ? face.y + face.height / 2 : safe.y + safe.height * 0.35;
  const fBottom = face ? face.y + face.height : fcy;
  const fTop = face ? face.y : fcy;
  const W = safe.width;
  switch (region) {
    case "LEFT":
      return cx <= fcx - W * 0.08 && rect.x + rect.width <= fcx + W * 0.04;
    case "RIGHT":
      return cx >= fcx + W * 0.08 && rect.x >= fcx - W * 0.04;
    case "TOP":
      return rect.y + rect.height <= fTop + 4;
    case "BOTTOM":
      return rect.y >= fBottom - 4;
    case "TOP_LEFT":
      return cx < fcx && cy < fcy;
    case "TOP_RIGHT":
      return cx > fcx && cy < fcy;
    case "BOTTOM_LEFT":
      return cx < fcx && cy > fcy;
    case "BOTTOM_RIGHT":
      return cx > fcx && cy > fcy;
    case "CENTER":
    case "AUTO":
      return true;
  }
}

/** Where in its region a graphic looks best (a point it is pulled towards). */
function idealPoint(region: DirectorRegion, face: Rect | null, safe: Rect): { x: number; y: number } {
  const fcx = face ? face.x + face.width / 2 : safe.x + safe.width / 2;
  const fcy = face ? face.y + face.height / 2 : safe.y + safe.height * 0.35;
  const left = (safe.x + (face ? face.x : fcx)) / 2;
  const right = ((face ? face.x + face.width : fcx) + safe.x + safe.width) / 2;
  const below = face ? (face.y + face.height + safe.y + safe.height) / 2 : safe.y + safe.height * 0.7;
  const above = face ? (safe.y + face.y) / 2 : safe.y + safe.height * 0.15;
  switch (region) {
    case "LEFT":
      return { x: left, y: fcy + safe.height * 0.12 };
    case "RIGHT":
      return { x: right, y: fcy + safe.height * 0.12 };
    case "TOP":
      return { x: fcx, y: above };
    case "BOTTOM":
      return { x: fcx, y: below };
    case "TOP_LEFT":
      return { x: left, y: above };
    case "TOP_RIGHT":
      return { x: right, y: above };
    case "BOTTOM_LEFT":
      return { x: left, y: below };
    case "BOTTOM_RIGHT":
      return { x: right, y: below };
    default:
      return { x: safe.x + safe.width / 2, y: below };
  }
}

/**
 * Solves one visual inside `region` (and fallbacks). `others` are the other graphics' rects
 * (already placed). Returns MANUAL x/y/scale fractions.
 */
export function solveRegionPlacement(
  timeline: EditTimeline,
  v: Pick<TimelineVisual, "id" | "template" | "props" | "start" | "end">,
  region: DirectorRegion,
  size: "S" | "M" | "L" | null,
  others: Array<{ id: string; rect: Rect; start: number; end: number; fullFrame: boolean }>,
  ctx: DirectorObstacleContext,
): RegionPlacement {
  const canvas = timeline.canvas;
  const k = canvas.width / 1080;
  const fp = footprintOf(v.template, v.props);
  if (fp.kind === "FULL_FRAME") return { x: 0.5, y: 0.5, scale: 1, region, used: region, note: null, clear: true };
  const area = directorPlacementArea(canvas);
  const safe = area.bounds;
  const obs = obstaclesForWindow(timeline, v.id, v.start, v.end, others, ctx);
  const margin = Math.round(20 * k);
  const hard = [...obs.hard.map((r) => inflate(r, margin)), ...area.ui, ...(obs.face ? [inflate(obs.face, Math.round(12 * k))] : [])];
  const cap = size ? SIZE_CAP[size] : 1;
  const scales: number[] = [];
  for (let s = cap; s >= DIRECTOR_MIN_SCALE - 1e-6; s -= 0.05) scales.push(Math.round(s * 100) / 100);
  const step = Math.max(6, Math.round(14 * k));

  type Cand = { cx: number; cy: number; scale: number; rect: Rect; score: number; bad: number };
  const tryRegion = (rg: DirectorRegion): { best: Cand | null; leastBad: Cand | null } => {
    const ideal = idealPoint(rg, obs.face, safe);
    let leastBad: Cand | null = null;
    for (const scale of scales) {
      const { width: w, height: h } = footprintPx(v.template, scale, canvas, v.props);
      if (w > safe.width || h > safe.height) continue;
      let best: Cand | null = null;
      for (let cy = safe.y + h / 2; cy <= safe.y + safe.height - h / 2 + 0.5; cy += step) {
        for (let cx = safe.x + w / 2; cx <= safe.x + safe.width - w / 2 + 0.5; cx += step) {
          const rect = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h };
          if (!inRegion(rg, cx, cy, rect, obs.face, safe)) continue;
          let overlap = 0;
          for (const o of hard) overlap += intersectionArea(rect, o);
          const headSoft = obs.head ? intersectionArea(rect, obs.head) / rectArea(rect) : 0;
          const bodySoft = obs.body ? intersectionArea(rect, obs.body) / rectArea(rect) : 0;
          const score = Math.hypot(cx - ideal.x, cy - ideal.y) / canvas.height + 0.6 * headSoft + 0.15 * bodySoft;
          const cand = { cx, cy, scale, rect, score, bad: overlap / rectArea(rect) };
          if (overlap === 0) {
            if (!best || score < best.score) best = cand;
          } else if (!leastBad || cand.bad + score < leastBad.bad + leastBad.score) leastBad = cand;
        }
      }
      if (best) return { best, leastBad };
    }
    return { best: null, leastBad };
  };

  const order = FALLBACKS[region];
  let fallbackBad: { cand: Cand; rg: DirectorRegion } | null = null;
  for (const rg of order) {
    const { best, leastBad } = tryRegion(rg);
    if (best) {
      const notes: string[] = [];
      if (rg !== region && region !== "AUTO") notes.push(`no room ${region === "TOP" || region === "BOTTOM" ? "at the" : "on the"} ${REGION_WORD[region]} beside your face, so it went ${REGION_WORD[rg]}`);
      if (best.scale < 0.55 && best.scale < cap) notes.push(`shrunk to ${Math.round(best.scale * 100)}% to fit`);
      return {
        x: round4(best.cx / canvas.width),
        y: round4(best.cy / canvas.height),
        scale: best.scale,
        region,
        used: rg,
        note: notes.length ? notes.join("; ") : null,
        clear: true,
      };
    }
    if (leastBad && (!fallbackBad || leastBad.bad < fallbackBad.cand.bad)) fallbackBad = { cand: leastBad, rg };
  }
  if (fallbackBad) {
    const c = fallbackBad.cand;
    return {
      x: round4(c.cx / canvas.width),
      y: round4(c.cy / canvas.height),
      scale: c.scale,
      region,
      used: fallbackBad.rg,
      note: "no fully clear spot near your face — it overlaps something; check it",
      clear: false,
    };
  }
  return { x: 0.5, y: 0.75, scale: DIRECTOR_MIN_SCALE, region, used: "BOTTOM", note: "too big to fit anywhere — placed small at the bottom; check it", clear: false };
}

/** Rect of a visual at its saved placement (for others' obstacle lists). */
export function placedRect(v: TimelineVisual, canvas: { width: number; height: number }): Rect {
  return visualRect(v, canvas);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
