import type { TranscriptWord } from "../caption-chunking";
import type { EditTimeline } from "../timeline";
import type { SpliceAnalysis } from "./analysis";
import { DEFAULT_SPLICE_MODEL, padsFor, type SpliceModel } from "./model";

/**
 * The free splice audit (gate G1, docs/PREMIUM_EDITOR_PLAN.md round 2): every cut of a timeline
 * checked against the voice, no model call. A finding names the cut and the stage to fix
 * (SPLICE) with a machine delta, so the fix loop can retime it.
 */
export type SpliceFindingKind = "GAP" | "CLIPPED_WORD" | "LEVEL_STEP";

export interface SpliceFinding {
  kind: SpliceFindingKind;
  stage: "SPLICE";
  /** Index of the cut (between clip `index` and `index + 1`). */
  index: number;
  outS: number;
  inS: number;
  /** Output time of the cut (s). */
  atS: number;
  /** How far off (ms): the extra air, the clipped voice, or the level step in dB×10. */
  deltaMs: number;
  detail: string;
}

export const SPLICE_AUDIT_THRESHOLDS = {
  /** Air beyond the model's pads that reads as a gap (s). */
  extraAirS: 0.06,
  /** Voice cut away inside a word that reads as clipped (s). */
  clippedS: 0.04,
  /** Level difference across a cut with voice on both sides (dB). */
  levelStepDb: 4,
  /** A voice span this close to the cut counts as "voice on both sides" (s). */
  nearS: 0.3,
} as const;

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Pure. Audits the cuts between consecutive clips of `mediaAssetId`. With a voice analysis the
 * gap, clipped and level checks run; with words only (no analysis), only the clipped-word check
 * on Whisper's edges (coarser; a 40 ms tolerance already applied).
 */
export function auditSplices(
  timeline: EditTimeline,
  mediaAssetId: string,
  words: TranscriptWord[],
  analysis: SpliceAnalysis | null,
  model: SpliceModel = DEFAULT_SPLICE_MODEL,
  t = SPLICE_AUDIT_THRESHOLDS,
): SpliceFinding[] {
  const findings: SpliceFinding[] = [];
  let atS = 0;
  for (let i = 0; i < timeline.clips.length - 1; i++) {
    const a = timeline.clips[i]!;
    const b = timeline.clips[i + 1]!;
    atS += Math.max(0, a.sourceEnd - a.sourceStart);
    if (a.mediaAssetId !== mediaAssetId || b.mediaAssetId !== mediaAssetId) continue;
    const outS = a.sourceEnd;
    const inS = b.sourceStart;
    if (Math.abs(inS - outS) < 1e-3) continue; // contiguous: a framing-only cut, no splice
    const at = r3(atS);
    const push = (kind: SpliceFindingKind, deltaMs: number, detail: string) => findings.push({ kind, stage: "SPLICE", index: i, outS: r3(outS), inS: r3(inS), atS: at, deltaMs: Math.round(deltaMs), detail });

    if (analysis && analysis.voice.length) {
      const before = analysis.voice.filter((v) => v.start < outS).pop() ?? null;
      const after = analysis.voice.find((v) => v.end > inS) ?? null;
      // Clipped: the cut sits inside a voice span by more than the tolerance AND inside a word
      // (continuous speech is one long span; a cut between two of its words is not clipping).
      const inWord = (x: number) => words.some((w) => w.start + t.clippedS < x && x < w.end - t.clippedS);
      if (before && before.end - outS > t.clippedS && inWord(outS)) push("CLIPPED_WORD", (before.end - outS) * 1000, `the voice runs ${Math.round((before.end - outS) * 1000)} ms past the cut-out at ${at}s`);
      if (after && inS - after.start > t.clippedS && inWord(inS)) push("CLIPPED_WORD", (inS - after.start) * 1000, `the cut-in at ${at}s lands ${Math.round((inS - after.start) * 1000)} ms into the voice`);
      // Gap: more air than the hand edits leave.
      const tailAir = before ? Math.max(0, outS - before.end) : 0;
      const leadAir = after ? Math.max(0, after.start - inS) : 0;
      const w = [...words].reverse().find((x) => x.end <= outS + 0.1);
      const pads = padsFor(model, !!w && SENTENCE_END.test(w.word));
      const allowed = pads.tailS + pads.leadS + t.extraAirS;
      if (tailAir + leadAir > allowed) push("GAP", (tailAir + leadAir - (pads.tailS + pads.leadS)) * 1000, `${Math.round((tailAir + leadAir) * 1000)} ms of air at the cut at ${at}s (hand edits leave ~${Math.round((pads.tailS + pads.leadS) * 1000)} ms)`);
      // Level step: voice right on both sides at different levels.
      if (before && after && outS - before.end <= t.nearS && after.start - inS <= t.nearS && Math.abs(before.db - after.db) >= t.levelStepDb) {
        push("LEVEL_STEP", Math.abs(before.db - after.db) * 10, `the voice steps ${Math.abs(before.db - after.db).toFixed(1)} dB across the cut at ${at}s`);
      }
    } else {
      const straddleOut = words.find((x) => x.start < outS - 0.02 && x.end > outS + t.clippedS);
      const straddleIn = words.find((x) => x.start < inS - t.clippedS && x.end > inS + 0.02);
      if (straddleOut) push("CLIPPED_WORD", (straddleOut.end - outS) * 1000, `"${straddleOut.word}" is cut at ${at}s`);
      if (straddleIn) push("CLIPPED_WORD", (inS - straddleIn.start) * 1000, `"${straddleIn.word}" is cut into at ${at}s`);
    }
  }
  return findings;
}
