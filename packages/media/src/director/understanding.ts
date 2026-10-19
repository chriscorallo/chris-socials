import { z } from "zod";
import { clipDuration, clipStartTimes, timelineDuration, type EditTimeline } from "../timeline";
import { subjectRegionsForWindow, captionBandRect, type PlacementOptions } from "../visual-placement";
import { directorPlacementArea } from "./area";
import { timelineCaptionChunks } from "../timeline-captions";
import type { TranscriptWord } from "../caption-chunking";

/**
 * What the Director chat "sees" of a take — PURE and browser-safe (the Node analyzer that fills
 * it lives in ../take-understanding.ts; the worker computes it ONCE per take and caches it in
 * the TakeUnderstanding table). See docs/decisions-pending/director-chat.md.
 *
 * Honest by construction: expressions come from a small facial-expression classifier (FER+,
 * 8 classes) on face crops — approximate, so every expression carries its confidence and the
 * pack tells the editor (ChatGPT / Claude) to treat them as hints. Motion is a plain frame
 * difference (camera shake counts too). Mouth-open / gaze aren't measured (no landmarks);
 * "surprise" is the closest proxy and is labelled as such.
 */

/** FER+ class order (ONNX Model Zoo emotion_ferplus): the model's output index → label. */
export const EXPRESSIONS = ["neutral", "happy", "surprise", "sad", "angry", "disgust", "fear", "contempt"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export const UNDERSTANDING_VERSION = 1 as const;

export const UnderstandingSampleSchema = z.object({
  /** Source-take seconds. */
  t: z.number().nonnegative(),
  /** Face box (detector, roughly brow-to-chin) in source-frame fractions; null = no face. */
  face: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
  /** Softmax over EXPRESSIONS (3 decimals); null when no face. */
  probs: z.array(z.number()).length(EXPRESSIONS.length).nullable(),
  /** Frame-difference energy vs the previous sample, 0..1 (camera motion counts). */
  motion: z.number().min(0).max(1),
});
export type UnderstandingSample = z.infer<typeof UnderstandingSampleSchema>;

export const SpriteInfoSchema = z.object({
  /** Storage key of the JPEG sprite (null until stored). */
  key: z.string().nullable(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  cellW: z.number().int().positive(),
  cellH: z.number().int().positive(),
  /** Cell i shows source time i * stepS. */
  stepS: z.number().positive(),
  count: z.number().int().positive(),
});
export type SpriteInfo = z.infer<typeof SpriteInfoSchema>;

export const TakeUnderstandingSchema = z.object({
  version: z.literal(UNDERSTANDING_VERSION),
  mediaAssetId: z.string(),
  durationS: z.number().nonnegative(),
  /** Seconds between samples (0.25 by default; larger for very long takes). */
  stepS: z.number().positive(),
  /** Display size of the source frames the fractions refer to. */
  source: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  model: z.object({ id: z.string(), license: z.string(), source: z.string() }),
  samples: z.array(UnderstandingSampleSchema),
  sprite: SpriteInfoSchema.nullable(),
});
export type TakeUnderstanding = z.infer<typeof TakeUnderstandingSchema>;

export function parseTakeUnderstanding(v: unknown): TakeUnderstanding | null {
  const r = TakeUnderstandingSchema.safeParse(v);
  return r.success ? r.data : null;
}

// ---------------------------------------------------------------------------------------
// Expression timeline (smoothed) and events
// ---------------------------------------------------------------------------------------

export interface ExpressionPoint {
  t: number;
  face: boolean;
  /** Smoothed probabilities (moving average over ±1 sample). null without a face. */
  probs: number[] | null;
  expression: Expression | null;
  confidence: number;
  motion: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** ±`radius` samples moving average of the class probabilities (face samples only). */
export function smoothExpressions(samples: UnderstandingSample[], radius = 1): ExpressionPoint[] {
  return samples.map((s, i) => {
    if (!s.probs) return { t: s.t, face: false, probs: null, expression: null, confidence: 0, motion: s.motion };
    const acc = new Array<number>(EXPRESSIONS.length).fill(0);
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(samples.length - 1, i + radius); j++) {
      const p = samples[j]!.probs;
      if (!p) continue;
      for (let k = 0; k < acc.length; k++) acc[k]! += p[k]!;
      n++;
    }
    const probs = acc.map((v) => v / Math.max(1, n));
    let best = 0;
    for (let k = 1; k < probs.length; k++) if (probs[k]! > probs[best]!) best = k;
    return { t: s.t, face: true, probs, expression: EXPRESSIONS[best]!, confidence: r2(probs[best]!), motion: s.motion };
  });
}

export type UnderstandingEventKind =
  | "EXPRESSION_ONSET"
  | "EXPRESSION_CHANGE"
  | "HEAD_MOVE"
  | "LEAN"
  | "FACE_LOST"
  | "FACE_FOUND"
  | "MOTION_SPIKE";

export interface UnderstandingEvent {
  /** Stable within one pack ("e1", "e2", …, in time order). */
  id: string;
  kind: UnderstandingEventKind;
  /** Seconds (source time from detectEvents; output time after mapping). */
  t: number;
  expression?: Expression;
  from?: Expression;
  direction?: "LEFT" | "RIGHT" | "IN" | "OUT";
  confidence: number;
  /** One plain sentence ("starts smiling (happy 0.91)"). */
  label: string;
}

export const ONSET_HIGH = 0.5;
export const ONSET_LOW = 0.3;

/**
 * Deterministic events from the smoothed expression timeline + face boxes + motion:
 * - EXPRESSION_ONSET: a non-neutral class rises above 0.5 after being under 0.3 within the
 *   previous ~1 s (t = where it crosses the midpoint, linearly interpolated);
 * - EXPRESSION_CHANGE: the dominant class changes between two stable stretches (≥ 0.5 s each);
 * - HEAD_MOVE: the face centre moves ≥ 8 % of the frame width within 0.5 s; LEAN: face size ±25 %;
 * - FACE_LOST / FACE_FOUND; MOTION_SPIKE: frame difference ≥ max(0.08, mean + 2.5 σ).
 */
export function detectEvents(u: Pick<TakeUnderstanding, "samples" | "stepS">): UnderstandingEvent[] {
  const pts = smoothExpressions(u.samples);
  const out: Array<Omit<UnderstandingEvent, "id">> = [];
  const lookback = Math.max(1, Math.round(1 / u.stepS));

  // Onsets
  for (let k = 1; k < EXPRESSIONS.length; k++) {
    const name = EXPRESSIONS[k]!;
    let armed = false;
    let lastLow = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!.probs?.[k];
      if (p == null) continue;
      if (p < ONSET_LOW) {
        armed = true;
        lastLow = i;
        continue;
      }
      if (armed && p >= ONSET_HIGH && i - lastLow <= lookback) {
        // crossing of the midpoint between the last low sample and here
        const mid = (ONSET_HIGH + ONSET_LOW) / 2;
        let t = pts[i]!.t;
        // the crossing is measured on the RAW probabilities (smoothing would pull it early)
        for (let j = i; j > lastLow && j > 0; j--) {
          const a = u.samples[j - 1]!.probs?.[k];
          const b = u.samples[j]!.probs?.[k];
          if (a != null && b != null && a < mid && b >= mid) {
            t = pts[j - 1]!.t + ((mid - a) / Math.max(1e-6, b - a)) * (pts[j]!.t - pts[j - 1]!.t);
            break;
          }
        }
        let peak = p;
        for (let j = i; j < Math.min(pts.length, i + lookback); j++) peak = Math.max(peak, pts[j]!.probs?.[k] ?? 0);
        out.push({ kind: "EXPRESSION_ONSET", t: r3(t), expression: name, confidence: r2(peak), label: `${onsetLabel(name)} (${name} ${r2(peak)})` });
        armed = false;
      }
    }
  }

  // Stable-stretch changes
  const minRun = Math.max(2, Math.round(0.5 / u.stepS));
  const runs: Array<{ expression: Expression; start: number; end: number; conf: number }> = [];
  for (const p of pts) {
    if (!p.expression) continue;
    const last = runs[runs.length - 1];
    if (last && last.expression === p.expression) {
      last.end = p.t;
      last.conf = Math.max(last.conf, p.confidence);
    } else runs.push({ expression: p.expression, start: p.t, end: p.t, conf: p.confidence });
  }
  const stable = runs.filter((r) => Math.round((r.end - r.start) / u.stepS) + 1 >= minRun);
  for (let i = 1; i < stable.length; i++) {
    const a = stable[i - 1]!;
    const b = stable[i]!;
    if (a.expression === b.expression) continue;
    // an onset of the same expression right there already says it
    if (out.some((e) => e.kind === "EXPRESSION_ONSET" && e.expression === b.expression && Math.abs(e.t - b.start) <= 0.5)) continue;
    // between the last sample of the old stretch and the first of the new one
    const prevEnd = runs[runs.indexOf(b) - 1]?.end ?? a.end;
    out.push({ kind: "EXPRESSION_CHANGE", t: r3((prevEnd + b.start) / 2), from: a.expression, expression: b.expression, confidence: r2(b.conf), label: `${a.expression} → ${b.expression} (${r2(b.conf)})` });
  }

  // Head moves / leans / face lost-found
  const win = Math.max(1, Math.round(0.5 / u.stepS));
  let lastMoveAt = -Infinity;
  for (let i = 0; i < u.samples.length; i++) {
    const s = u.samples[i]!;
    const prev = u.samples[i - 1];
    if (prev && !!prev.face !== !!s.face) {
      out.push({ kind: s.face ? "FACE_FOUND" : "FACE_LOST", t: r3(s.t), confidence: 1, label: s.face ? "face back in frame" : "face leaves the frame / turns away" });
    }
    const back = u.samples[i - win];
    if (!s.face || !back?.face || s.t - lastMoveAt < 1) continue;
    const dx = s.face.x + s.face.w / 2 - (back.face.x + back.face.w / 2);
    const ds = s.face.w / Math.max(1e-6, back.face.w);
    if (Math.abs(dx) >= 0.08) {
      out.push({ kind: "HEAD_MOVE", t: r3(back.t), direction: dx < 0 ? "LEFT" : "RIGHT", confidence: r2(Math.min(1, Math.abs(dx) / 0.16)), label: `head moves to the ${dx < 0 ? "left" : "right"} of the frame` });
      lastMoveAt = s.t;
    } else if (ds >= 1.25 || ds <= 0.8) {
      out.push({ kind: "LEAN", t: r3(back.t), direction: ds > 1 ? "IN" : "OUT", confidence: r2(Math.min(1, Math.abs(ds - 1) / 0.5)), label: ds > 1 ? "leans in to the camera" : "leans back" });
      lastMoveAt = s.t;
    }
  }

  // Motion spikes
  const m = u.samples.map((s) => s.motion);
  if (m.length > 4) {
    const mean = m.reduce((a, b) => a + b, 0) / m.length;
    const sd = Math.sqrt(m.reduce((a, b) => a + (b - mean) ** 2, 0) / m.length);
    const thr = Math.max(0.08, mean + 2.5 * sd);
    let last = -Infinity;
    u.samples.forEach((s) => {
      if (s.motion >= thr && s.t - last > 1) {
        out.push({ kind: "MOTION_SPIKE", t: r3(s.t), confidence: r2(Math.min(1, s.motion / (thr * 2))), label: "sudden movement (big frame change)" });
        last = s.t;
      }
    });
  }

  return out
    .sort((a, b) => a.t - b.t || a.kind.localeCompare(b.kind))
    .map((e, i) => ({ ...e, id: `e${i + 1}` }));
}

function onsetLabel(e: Expression): string {
  switch (e) {
    case "happy":
      return "starts smiling / looks happy";
    case "surprise":
      return "looks surprised (eyes/mouth open)";
    case "sad":
      return "looks sad / deflated";
    case "angry":
      return "looks angry / frustrated";
    case "disgust":
      return "looks disgusted";
    case "fear":
      return "looks scared / worried";
    case "contempt":
      return "smirks / looks unimpressed";
    default:
      return "neutral face";
  }
}

/** Plain word for an expression in Chris's language ("smile" → happy). Used by the time
 * resolver so "when I smile" in an instruction finds happy onsets. */
export const EXPRESSION_SYNONYMS: Record<string, Expression> = {
  happy: "happy",
  happiness: "happy",
  smile: "happy",
  smiling: "happy",
  smiles: "happy",
  laugh: "happy",
  laughing: "happy",
  joy: "happy",
  excited: "happy",
  surprise: "surprise",
  surprised: "surprise",
  shock: "surprise",
  shocked: "surprise",
  wow: "surprise",
  sad: "sad",
  sadness: "sad",
  deflated: "sad",
  disappointed: "sad",
  angry: "angry",
  anger: "angry",
  mad: "angry",
  frustrated: "angry",
  disgust: "disgust",
  disgusted: "disgust",
  fear: "fear",
  scared: "fear",
  worried: "fear",
  contempt: "contempt",
  smirk: "contempt",
  neutral: "neutral",
  straight: "neutral",
};

// ---------------------------------------------------------------------------------------
// Mapping a take's understanding onto the CURRENT edit (output timeline)
// ---------------------------------------------------------------------------------------

export interface OutputUnderstanding {
  /** Output seconds; one point per sample that is on screen in the edit. */
  points: Array<ExpressionPoint & { assetId: string; sourceT: number }>;
  events: UnderstandingEvent[];
  /** Takes in the edit with no understanding yet. */
  missing: string[];
}

/**
 * Maps each take's (source-time) understanding through the edit's clips onto OUTPUT time:
 * samples inside a kept clip land at clipStart + (t − sourceStart); events likewise (an event in
 * removed footage disappears). Events are re-numbered e1… in output order. Pure.
 */
export function understandingForTimeline(
  timeline: Pick<EditTimeline, "clips">,
  byAsset: Record<string, TakeUnderstanding | null | undefined>,
): OutputUnderstanding {
  const starts = clipStartTimes(timeline);
  const points: OutputUnderstanding["points"] = [];
  const events: Array<Omit<UnderstandingEvent, "id">> = [];
  const missing = new Set<string>();
  const eventsByAsset = new Map<string, UnderstandingEvent[]>();
  const smoothByAsset = new Map<string, ExpressionPoint[]>();
  timeline.clips.forEach((c, i) => {
    const u = byAsset[c.mediaAssetId];
    if (!u) {
      missing.add(c.mediaAssetId);
      return;
    }
    if (!smoothByAsset.has(c.mediaAssetId)) smoothByAsset.set(c.mediaAssetId, smoothExpressions(u.samples));
    if (!eventsByAsset.has(c.mediaAssetId)) eventsByAsset.set(c.mediaAssetId, detectEvents(u));
    const off = starts[i]! - c.sourceStart;
    for (const p of smoothByAsset.get(c.mediaAssetId)!) {
      if (p.t < c.sourceStart - 1e-6 || p.t >= c.sourceEnd - 1e-6) continue;
      points.push({ ...p, assetId: c.mediaAssetId, sourceT: p.t, t: r3(p.t + off) });
    }
    for (const e of eventsByAsset.get(c.mediaAssetId)!) {
      if (e.t < c.sourceStart - 1e-6 || e.t >= c.sourceEnd - 1e-6) continue;
      const { id: _id, ...rest } = e;
      void _id;
      events.push({ ...rest, t: r3(e.t + off) });
    }
    void clipDuration;
  });
  points.sort((a, b) => a.t - b.t);
  return {
    points,
    events: events.sort((a, b) => a.t - b.t).map((e, i) => ({ ...e, id: `e${i + 1}` })),
    missing: [...missing],
  };
}

/** Merged stretches of one dominant expression (output time), for the pack's summary line. */
export function expressionSegments(points: ExpressionPoint[], minSeconds = 0.5): Array<{ start: number; end: number; expression: Expression | null; confidence: number }> {
  const segs: Array<{ start: number; end: number; expression: Expression | null; confidence: number; n: number }> = [];
  for (const p of points) {
    const last = segs[segs.length - 1];
    if (last && last.expression === p.expression && p.t - last.end < 0.6) {
      last.end = p.t;
      last.confidence += p.confidence;
      last.n++;
    } else segs.push({ start: p.t, end: p.t, expression: p.expression, confidence: p.confidence, n: 1 });
  }
  // fold blips shorter than minSeconds into the previous stretch
  const out: typeof segs = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && s.end - s.start < minSeconds && segs.length > 1) {
      prev.end = s.end;
      continue;
    }
    out.push({ ...s });
  }
  return out.map((s) => ({ start: r2(s.start), end: r2(s.end), expression: s.expression, confidence: r2(s.confidence / s.n) }));
}

// ---------------------------------------------------------------------------------------
// Layout facts: where there's room around Chris
// ---------------------------------------------------------------------------------------

export interface LayoutWindow {
  start: number;
  end: number;
  /** Protected head region on the canvas (fractions) — null when no face is known. */
  head: { x: number; y: number; w: number; h: number } | null;
  /** Free space beside/above/below the head inside the platform-safe area (fractions of the
   * canvas width/height). */
  free: { left: number; right: number; top: number; bottom: number };
  tracked: boolean;
}

/** Head position + free regions per window (default 1 s) of the OUTPUT timeline. Pure. */
export function layoutWindows(
  timeline: EditTimeline,
  options: Pick<PlacementOptions, "subjectTracks" | "sourceDimensions" | "wordsByAsset">,
  windowS = 1,
): LayoutWindow[] {
  const D = timelineDuration(timeline);
  const { width: W, height: H } = timeline.canvas;
  const area = directorPlacementArea(timeline.canvas);
  const safe = area.bounds;
  // the apps' caption block (left, bottom) is where "below him" ends
  const textTop = Math.min(safe.y + safe.height, ...area.ui.filter((r) => r.x <= 0).map((r) => r.y));
  const spoken = timeline.captions.enabled && timelineCaptionChunks(timeline, (options.wordsByAsset ?? {}) as Record<string, TranscriptWord[] | null>).length > 0;
  const cap = spoken ? captionBandRect(timeline.captions, timeline.canvas) : null;
  const out: LayoutWindow[] = [];
  for (let s = 0; s < D - 1e-6; s += windowS) {
    const e = Math.min(D, s + windowS);
    const sub = subjectRegionsForWindow(timeline, s, e, options);
    const h = sub.head;
    const bottomLimit = cap ? Math.min(textTop, cap.y) : textTop;
    out.push({
      start: r2(s),
      end: r2(e),
      head: h ? { x: r2(h.x / W), y: r2(h.y / H), w: r2(h.width / W), h: r2(h.height / H) } : null,
      free: h
        ? {
            left: r2(Math.max(0, h.x - safe.x) / W),
            right: r2(Math.max(0, safe.x + safe.width - (h.x + h.width)) / W),
            top: r2(Math.max(0, h.y - safe.y) / H),
            bottom: r2(Math.max(0, bottomLimit - (h.y + h.height)) / H),
          }
        : { left: r2(safe.width / W), right: r2(safe.width / W), top: r2(safe.height / H), bottom: r2(safe.height / H) },
      tracked: sub.tracked,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Contact sheet plan (the image Chris attaches in ChatGPT) — drawn by the browser (canvas)
// ---------------------------------------------------------------------------------------

export interface ContactSheetCell {
  /** Output seconds this cell shows. */
  t: number;
  assetId: string;
  /** Sprite cell index in that take's sprite. */
  spriteIndex: number;
  /** "3.0s" */
  label: string;
  /** "happy 0.91" | "no face" | "" */
  sublabel: string;
}

export interface ContactSheetPlan {
  stepS: number;
  cols: number;
  cells: ContactSheetCell[];
}

/** Which sprite cells to draw for the current edit: every `stepS` output seconds (0.5 s,
 * coarser for long edits so at most `maxCells` fit), each labelled with its OUTPUT time and the
 * expression there. Pure. */
export function contactSheetPlan(
  timeline: Pick<EditTimeline, "clips">,
  byAsset: Record<string, TakeUnderstanding | null | undefined>,
  opts: { maxCells?: number; cols?: number } = {},
): ContactSheetPlan {
  const maxCells = opts.maxCells ?? 30;
  const D = timelineDuration(timeline);
  const stepS = Math.max(0.5, Math.ceil(D / maxCells / 0.5) * 0.5);
  const starts = clipStartTimes(timeline);
  const out = understandingForTimeline(timeline, byAsset);
  const cells: ContactSheetCell[] = [];
  for (let t = 0; t < D - 1e-6 && cells.length < maxCells; t += stepS) {
    let ci = timeline.clips.length - 1;
    for (let i = 0; i < timeline.clips.length; i++) {
      if (t < starts[i]! + clipDuration(timeline.clips[i]!)) {
        ci = i;
        break;
      }
    }
    const clip = timeline.clips[ci]!;
    const u = byAsset[clip.mediaAssetId];
    if (!u?.sprite) continue;
    const src = clip.sourceStart + (t - starts[ci]!);
    const idx = Math.max(0, Math.min(u.sprite.count - 1, Math.round(src / u.sprite.stepS)));
    let near: (typeof out.points)[number] | null = null;
    for (const p of out.points) if (!near || Math.abs(p.t - t) < Math.abs(near.t - t)) near = p;
    cells.push({
      t: r2(t),
      assetId: clip.mediaAssetId,
      spriteIndex: idx,
      label: `${r2(t).toFixed(1)}s`,
      sublabel: near && Math.abs(near.t - t) <= 0.3 ? (near.expression ? `${near.expression} ${near.confidence.toFixed(2)}` : "no face") : "",
    });
  }
  return { stepS, cols: opts.cols ?? 6, cells };
}
