import { clipDuration, type EditTimeline } from "@chris/media/timeline";

/**
 * Playback planning for the compositor engine — PURE (tested in engine.test.ts).
 *
 * The edit is a list of clips (source spans of takes) played back to back. The engine needs,
 * from any output time t onwards: which source spans to decode in what order (the decode plan),
 * which are continuations (same take, next span starts where the last ended → keep decoding)
 * versus jumps (restart at the key frame before the new span), and the audio pieces to
 * schedule on the AudioContext timeline so every cut is sample-accurate.
 */

export interface PlanSegment {
  /** index in planSegments() (stable id of the segment for the engine's plan) */
  segIndex: number;
  clipIndex: number;
  assetId: string;
  /** output seconds */
  outStart: number;
  outEnd: number;
  /** source seconds (outStart ↔ srcStart) */
  srcStart: number;
  srcEnd: number;
  volume: number;
  /** true when the previous segment is the same take ending (within 1/60 s) where this starts */
  continues: boolean;
}

const CONT_EPS = 1 / 60;

/** Every clip as a segment in output order. */
export function planSegments(doc: Pick<EditTimeline, "clips">): PlanSegment[] {
  const out: PlanSegment[] = [];
  let t = 0;
  doc.clips.forEach((c, i) => {
    const d = clipDuration(c);
    const prev = out[out.length - 1];
    out.push({
      segIndex: -1,
      clipIndex: i,
      assetId: c.mediaAssetId,
      outStart: t,
      outEnd: t + d,
      srcStart: c.sourceStart,
      srcEnd: c.sourceEnd,
      volume: c.volume,
      continues: !!prev && prev.assetId === c.mediaAssetId && Math.abs(prev.srcEnd - c.sourceStart) <= CONT_EPS,
    });
    t += d;
  });
  return out.filter((s) => s.outEnd > s.outStart).map((s, k) => ({ ...s, segIndex: k }));
}

/** Index of the segment on screen at output time t (the last one at/after the end). */
export function segmentAt(segs: PlanSegment[], t: number): number {
  if (!segs.length) return -1;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t < segs[mid]!.outEnd) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Source time shown at output time t (clamped into its segment). */
export function sourceTimeAt(segs: PlanSegment[], t: number): { seg: number; src: number } | null {
  const i = segmentAt(segs, t);
  const s = segs[i];
  if (!s) return null;
  return { seg: i, src: Math.min(s.srcEnd, s.srcStart + Math.max(0, t - s.outStart)) };
}

/**
 * The segments from output time t on, the first one trimmed to start at t, covering at least
 * `horizon` seconds (or to the end).
 */
export function segmentsFrom(segs: PlanSegment[], t: number, horizon = Infinity): PlanSegment[] {
  const i = segmentAt(segs, t);
  if (i < 0) return [];
  const out: PlanSegment[] = [];
  for (let k = i; k < segs.length; k++) {
    const s = segs[k]!;
    if (k === i) {
      const cut = Math.max(0, Math.min(s.outEnd, t) - s.outStart);
      out.push({ ...s, outStart: s.outStart + cut, srcStart: s.srcStart + cut, continues: false });
    } else out.push(s);
    if (s.outEnd - t >= horizon) break;
  }
  // drop slivers (a span cut down to nothing at its end)
  return out.filter((s) => s.outEnd > s.outStart + 1e-4);
}

export interface AudioPiece {
  assetId: string;
  /** output seconds where this piece starts */
  outStart: number;
  /** source seconds to start playing from */
  srcStart: number;
  duration: number;
  gain: number;
  /** fade (s) at each end — 0 at a continuation so joined spans stay seamless */
  fadeIn: number;
  fadeOut: number;
}

/** Hard cuts get a 4 ms ramp each side (inaudible, kills the click); continuations none. */
export const CUT_FADE_S = 0.004;

export function audioPieces(segs: PlanSegment[]): AudioPiece[] {
  return segs.map((s, k) => {
    const next = segs[k + 1];
    return {
      assetId: s.assetId,
      outStart: s.outStart,
      srcStart: s.srcStart,
      duration: s.outEnd - s.outStart,
      gain: Math.max(0, s.volume),
      fadeIn: s.continues ? 0 : CUT_FADE_S,
      fadeOut: next?.continues ? 0 : CUT_FADE_S,
    };
  });
}

/** Map an output time onto the AudioContext timeline given the playback anchor. */
export function ctxTimeFor(outT: number, anchor: { out: number; ctx: number }): number {
  return anchor.ctx + (outT - anchor.out);
}
