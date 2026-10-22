import type { TranscriptWord } from "../caption-chunking";
import type { SpliceAnalysis } from "./analysis";
import { padsFor, type SpliceModel } from "./model";

/**
 * Where a cut lands, given where the voice is (analysis) and how much air a hand edit leaves
 * (model). No frame grid: the picture snaps to a frame on its own at render time; the audio is
 * cut where the voice says.
 */

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Pure. Whisper's word edges (±0.2–0.4 s) refined to the voice: the first word of a voice span
 * starts where the voice starts, the last word of a span ends where the voice ends — when
 * Whisper had it within `maxShiftS`. Words inside a span keep their Whisper times (Whisper is
 * good at which word, the envelope at when the voice moves).
 */
export function refineWordEdges(words: TranscriptWord[], analysis: SpliceAnalysis, maxShiftS = 0.15): TranscriptWord[] {
  if (!analysis.voice.length || !words.length) return words;
  const spans = analysis.voice;
  // Each word → the span it overlaps most, else the nearest one.
  const spanOf = words.map((w) => {
    let best = -1;
    let bestScore = -Infinity;
    const mid = (w.start + w.end) / 2;
    for (let k = 0; k < spans.length; k++) {
      const s = spans[k]!;
      if (s.start > w.end + 1) break;
      const overlap = Math.min(w.end, s.end) - Math.max(w.start, s.start);
      const score = overlap > 0 ? overlap : -Math.min(Math.abs(s.start - mid), Math.abs(s.end - mid));
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    return best;
  });
  const out = words.map((w) => ({ ...w }));
  for (let i = 0; i < out.length; i++) {
    const k = spanOf[i]!;
    if (k < 0) continue;
    const s = spans[k]!;
    const first = i === 0 || spanOf[i - 1] !== k;
    const last = i === out.length - 1 || spanOf[i + 1] !== k;
    if (first && Math.abs(out[i]!.start - s.start) <= maxShiftS) out[i]!.start = s.start;
    if (last && Math.abs(out[i]!.end - s.end) <= maxShiftS) out[i]!.end = s.end;
    if (out[i]!.end < out[i]!.start) out[i]!.end = out[i]!.start;
  }
  return out;
}

export interface PlacedCut {
  cutOut: number;
  cutIn: number;
  /** The cut-in was pulled earlier to sit before a plosive burst. */
  beforeBurst: boolean;
}

/** How far before a burst the cut-in sits (s). */
export const BURST_LEAD_S = 0.015;

/**
 * Pure. A pause from voice offset `offset` to onset `onset` → the cut. Tail/lead pads from the
 * model; a plosive burst near the onset pulls the cut-in to 15 ms before it; null when the
 * pause is shorter than the pads (nothing to remove).
 */
export function placePauseCut(offset: number, onset: number, sentenceEnd: boolean, model: SpliceModel, bursts: number[], minRemovalS = 0.02): PlacedCut | null {
  const pads = padsFor(model, sentenceEnd);
  const cutOut = offset + pads.tailS;
  let cutIn = onset - pads.leadS;
  let beforeBurst = false;
  // A release burst comes up to ~90 ms before voicing (aspirated p/t/k) or right on it.
  const burst = bursts.find((b) => b >= onset - 0.09 && b <= onset + 0.06);
  if (burst != null && burst - BURST_LEAD_S < cutIn) {
    cutIn = burst - BURST_LEAD_S;
    beforeBurst = true;
  }
  if (cutIn - cutOut < minRemovalS) return null;
  return { cutOut: r3(cutOut), cutIn: r3(cutIn), beforeBurst };
}
