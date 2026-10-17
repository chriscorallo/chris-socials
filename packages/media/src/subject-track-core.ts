import { z } from "zod";

/**
 * Subject track — where Chris is in a raw take over time. PURE (browser-safe): the schema,
 * the deterministic post-processing (dominant-face choice, gap filling, smoothing, expansion
 * to a protected region) and lookups. The detector itself (ONNX, ffmpeg) lives in
 * subject-track.ts (Node only).
 *
 * Stored on MediaAsset.subjectTrack as `[{ t, box }]`:
 * - `t`   seconds on the take's SOURCE timeline;
 * - `box` the PROTECTED HEAD REGION (face + hair + a margin) as fractions of the SOURCE frame
 *         ({x, y} = top-left, {w, h} = size), or null when no face was found at that sample.
 * The approximate body region is derived from the head box (bodyRegionFromHead) rather than
 * stored, so old tracks stay valid if the body heuristic changes.
 */
export const NormBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
});
export type NormBox = z.infer<typeof NormBoxSchema>;

export const SubjectTrackSampleSchema = z.object({
  t: z.number().nonnegative(),
  box: NormBoxSchema.nullable(),
});
export type SubjectTrackSample = z.infer<typeof SubjectTrackSampleSchema>;

export const SubjectTrackSchema = z.array(SubjectTrackSampleSchema);
export type SubjectTrack = z.infer<typeof SubjectTrackSchema>;

/** Parses MediaAsset.subjectTrack (Json) defensively; null when absent or malformed. */
export function parseSubjectTrack(value: unknown): SubjectTrack | null {
  if (value == null) return null;
  const r = SubjectTrackSchema.safeParse(value);
  return r.success ? r.data : null;
}

/** A raw detection in source-frame fractions. */
export interface FaceDetection {
  box: NormBox;
  score: number;
}

export function boxArea(b: NormBox): number {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

export function boxIoU(a: NormBox, b: NormBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy non-maximum suppression, highest score first. */
export function nonMaxSuppression(dets: FaceDetection[], iouThreshold = 0.3): FaceDetection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const kept: FaceDetection[] = [];
  for (const d of sorted) {
    if (kept.every((k) => boxIoU(k.box, d.box) < iouThreshold)) kept.push(d);
  }
  return kept;
}

function center(b: NormBox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/**
 * The dominant face in one frame: the speaker is the biggest, most confident face, with a
 * continuity bonus for staying near where the speaker was a moment ago (so a face on a poster
 * in the background never steals the track for one frame).
 */
export function chooseDominantFace(dets: FaceDetection[], previous: NormBox | null): FaceDetection | null {
  if (dets.length === 0) return null;
  let best: FaceDetection | null = null;
  let bestScore = -Infinity;
  for (const d of dets) {
    let s = Math.sqrt(boxArea(d.box)) * d.score;
    if (previous) {
      const c = center(d.box);
      const p = center(previous);
      const dist = Math.hypot(c.x - p.x, c.y - p.y);
      s *= 1 + Math.max(0, 0.5 - dist); // up to +50% when it hasn't moved
    }
    if (s > bestScore) {
      bestScore = s;
      best = d;
    }
  }
  return best;
}

export interface SmoothOptions {
  /** Gaps (consecutive null samples) up to this long are filled by interpolation. */
  maxGapSeconds?: number;
  /** Odd median window (samples) — removes single-frame jumps. */
  medianWindow?: number;
  /** EMA weight of the new sample after the median (1 = no EMA). */
  emaAlpha?: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Deterministic temporal clean-up of per-frame face boxes:
 * 1. fill short gaps (<= maxGapSeconds) by linear interpolation between the neighbours;
 * 2. median filter each of x/y/w/h over `medianWindow` samples within each detected run;
 * 3. light forward EMA within each run (removes jitter; runs restart fresh after a long gap).
 * Long gaps stay null — "we don't know where he is" is honest; placement treats it as such.
 */
export function smoothFaceTrack(samples: SubjectTrack, options: SmoothOptions = {}): SubjectTrack {
  const maxGap = options.maxGapSeconds ?? 1.0;
  const win = Math.max(1, options.medianWindow ?? 5);
  const alpha = options.emaAlpha ?? 0.6;
  const out: SubjectTrack = samples.map((s) => ({ t: s.t, box: s.box ? { ...s.box } : null }));

  // 1. gap fill
  let i = 0;
  while (i < out.length) {
    if (out[i]!.box !== null) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j]!.box === null) j++;
    const before = i > 0 ? out[i - 1]! : null;
    const after = j < out.length ? out[j]! : null;
    if (before?.box && after?.box && after.t - before.t <= maxGap + 1e-9) {
      for (let k = i; k < j; k++) {
        const f = (out[k]!.t - before.t) / Math.max(1e-9, after.t - before.t);
        out[k]!.box = {
          x: before.box.x + (after.box.x - before.box.x) * f,
          y: before.box.y + (after.box.y - before.box.y) * f,
          w: before.box.w + (after.box.w - before.box.w) * f,
          h: before.box.h + (after.box.h - before.box.h) * f,
        };
      }
    }
    i = j;
  }

  // Runs of non-null boxes.
  const runs: Array<[number, number]> = [];
  let start = -1;
  out.forEach((s, idx) => {
    if (s.box && start < 0) start = idx;
    if (!s.box && start >= 0) {
      runs.push([start, idx]);
      start = -1;
    }
  });
  if (start >= 0) runs.push([start, out.length]);

  const half = Math.floor(win / 2);
  for (const [a, b] of runs) {
    const raw = out.slice(a, b).map((s) => s.box!);
    const med = raw.map((_, k) => {
      const lo = Math.max(0, k - half);
      const hi = Math.min(raw.length, k + half + 1);
      const slice = raw.slice(lo, hi);
      return {
        x: median(slice.map((r) => r.x)),
        y: median(slice.map((r) => r.y)),
        w: median(slice.map((r) => r.w)),
        h: median(slice.map((r) => r.h)),
      };
    });
    let prev: NormBox | null = null;
    med.forEach((m, k) => {
      const v: NormBox = prev
        ? {
            x: prev.x + alpha * (m.x - prev.x),
            y: prev.y + alpha * (m.y - prev.y),
            w: prev.w + alpha * (m.w - prev.w),
            h: prev.h + alpha * (m.h - prev.h),
          }
        : m;
      out[a + k]!.box = v;
      prev = v;
    });
  }
  return out;
}

/**
 * Face box (detector: roughly brow-to-chin) -> PROTECTED HEAD REGION: + hair above, a little
 * neck below, ears/margin on the sides. Factors are fractions of the face box size. Clamped
 * to the frame.
 */
export const PROTECTED_HEAD_EXPANSION = { sides: 0.35, top: 0.6, bottom: 0.25 } as const;

export function expandFaceToProtectedRegion(face: NormBox): NormBox {
  const e = PROTECTED_HEAD_EXPANSION;
  const x1 = clamp01(face.x - face.w * e.sides);
  const y1 = clamp01(face.y - face.h * e.top);
  const x2 = clamp01(face.x + face.w * (1 + e.sides));
  const y2 = clamp01(face.y + face.h * (1 + e.bottom));
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

/**
 * Approximate upper-body region below a protected head region (source fractions): shoulders
 * are ~2.6x the head width, centred under it, down to the bottom of the frame. Used as a SOFT
 * obstacle (graphics may sit over the torso when there's nowhere better; never over the head).
 */
export function bodyRegionFromHead(head: NormBox): NormBox {
  const cx = head.x + head.w / 2;
  const w = head.w * 2.6;
  const x1 = clamp01(cx - w / 2);
  const x2 = clamp01(cx + w / 2);
  const y1 = clamp01(head.y + head.h);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, 1 - y1) };
}

/**
 * The protected head box at source time t: linear interpolation between the bracketing
 * samples when both are present and at most `maxGapSeconds` apart, else the nearest sample
 * within `maxGapSeconds` / 2, else null.
 */
export function subjectBoxAt(track: SubjectTrack, t: number, maxGapSeconds = 1.0): NormBox | null {
  if (track.length === 0) return null;
  let lo = 0;
  let hi = track.length - 1;
  if (t <= track[0]!.t) return track[0]!.t - t <= maxGapSeconds / 2 ? track[0]!.box : null;
  if (t >= track[hi]!.t) return t - track[hi]!.t <= maxGapSeconds / 2 ? track[hi]!.box : null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = track[lo]!;
  const b = track[hi]!;
  if (a.box && b.box && b.t - a.t <= maxGapSeconds) {
    const f = (t - a.t) / Math.max(1e-9, b.t - a.t);
    return {
      x: a.box.x + (b.box.x - a.box.x) * f,
      y: a.box.y + (b.box.y - a.box.y) * f,
      w: a.box.w + (b.box.w - a.box.w) * f,
      h: a.box.h + (b.box.h - a.box.h) * f,
    };
  }
  const nearer = t - a.t <= b.t - t ? a : b;
  return Math.abs(nearer.t - t) <= maxGapSeconds / 2 ? nearer.box : null;
}

/** Rounds every number to 4 decimals (keeps the stored JSON compact and deterministic). */
export function roundTrack(track: SubjectTrack): SubjectTrack {
  const r = (n: number) => Math.round(n * 10000) / 10000;
  return track.map((s) => ({
    t: Math.round(s.t * 1000) / 1000,
    box: s.box ? { x: r(s.box.x), y: r(s.box.y), w: r(s.box.w), h: r(s.box.h) } : null,
  }));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
