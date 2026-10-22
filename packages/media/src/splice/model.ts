import type { TranscriptWord } from "../caption-chunking";
import type { EditTimeline } from "../timeline";
import type { SpliceAnalysis } from "./analysis";

/**
 * The SpliceModel: how much air a cut leaves after the voice stops (tail) and before it starts
 * again (lead), mid-sentence and at a sentence end. Learned, not copied — the prior comes from
 * Chris's two hand edits (DECISIONS 2026-10-19: ~0.09 s true tail, ~0.05 s lead, internal
 * pauses ~0.11 s median), and `learnSpliceModel` re-fits it from hand-edited timelines
 * measured against the voice envelope. Pads never leave the hand-edit band.
 */
export interface SplicePads {
  tailS: number;
  leadS: number;
}

export interface SpliceModel {
  version: 1;
  mid: SplicePads;
  sentence: SplicePads;
  source: "PRIOR" | "LEARNED";
  /** Hand-edit splices the pads were fitted on (0 for the prior). */
  samples: number;
}

/** The hand-edit band: a cut outside it reads as a machine (clipped) or as a gap. */
export const SPLICE_PAD_BAND = { tailS: [0.03, 0.2], leadS: [0.02, 0.16] } as const;

/** Before any measurement: the two pad numbers copied by hand in DECISIONS 2026-10-19. */
export const PRIOR_SPLICE_MODEL: SpliceModel = {
  version: 1,
  mid: { tailS: 0.08, leadS: 0.05 },
  sentence: { tailS: 0.11, leadS: 0.06 },
  source: "PRIOR",
  samples: 0,
};

/**
 * Fitted 2026-10-21 by the golden harness from 57 pause cuts in five of Chris's hand edits
 * (car-payment, 100k-not-spending, two-people-100k, look-rich, img-4128), each measured
 * against the voice: mid-sentence tail p25/50/75 = 76/96/112 ms, lead 59/72/77 ms; sentence
 * end tail 99/146/175 ms, lead 91/121/151 ms. Re-fit with `scripts/golden` when hand edits
 * are added (`spliceSamplesFromTimeline` → `learnSpliceModel`).
 */
export const LEARNED_SPLICE_MODEL: SpliceModel = {
  version: 1,
  mid: { tailS: 0.096, leadS: 0.072 },
  sentence: { tailS: 0.146, leadS: 0.121 },
  source: "LEARNED",
  samples: 57,
};

export const DEFAULT_SPLICE_MODEL: SpliceModel = LEARNED_SPLICE_MODEL;

export interface SpliceSample {
  tailS: number;
  leadS: number;
  sentenceEnd: boolean;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

function clamp(v: number, [lo, hi]: readonly [number, number]): number {
  return Math.min(hi, Math.max(lo, v));
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function padsFor(model: SpliceModel, sentenceEnd: boolean): SplicePads {
  return sentenceEnd ? model.sentence : model.mid;
}

/**
 * Pure. Fits pads from hand-edit splices: the median per class when there are at least
 * `minPerClass` samples, clamped to the band; a class without enough samples keeps the prior.
 */
export function learnSpliceModel(samples: SpliceSample[], prior: SpliceModel = PRIOR_SPLICE_MODEL, minPerClass = 6): SpliceModel {
  const fit = (cls: SpliceSample[], base: SplicePads): SplicePads =>
    cls.length >= minPerClass
      ? { tailS: r3(clamp(median(cls.map((s) => s.tailS)), SPLICE_PAD_BAND.tailS)), leadS: r3(clamp(median(cls.map((s) => s.leadS)), SPLICE_PAD_BAND.leadS)) }
      : base;
  const mid = samples.filter((s) => !s.sentenceEnd);
  const sentence = samples.filter((s) => s.sentenceEnd);
  const learned = mid.length >= minPerClass || sentence.length >= minPerClass;
  return { version: 1, mid: fit(mid, prior.mid), sentence: fit(sentence, prior.sentence), source: learned ? "LEARNED" : prior.source, samples: samples.length };
}

/**
 * Pure. Measures a hand-edited timeline's splices against the voice: for every cut between two
 * clips of the take, the air left after the last voice offset before the cut-out and before the
 * first voice onset after the cut-in. Cuts that aren't pause cuts (more than 0.4 s from the
 * voice on either side — a dropped line, a reorder) are not samples.
 */
export function spliceSamplesFromTimeline(timeline: EditTimeline, analysis: SpliceAnalysis, words: TranscriptWord[], mediaAssetId: string): SpliceSample[] {
  const out: SpliceSample[] = [];
  const offsets = analysis.voice.map((v) => v.end);
  const onsets = analysis.voice.map((v) => v.start);
  for (let i = 1; i < timeline.clips.length; i++) {
    const a = timeline.clips[i - 1]!;
    const b = timeline.clips[i]!;
    if (a.mediaAssetId !== mediaAssetId || b.mediaAssetId !== mediaAssetId) continue;
    const outS = a.sourceEnd;
    const inS = b.sourceStart;
    if (inS <= outS) continue; // not a pause removal
    const offset = [...offsets].reverse().find((t) => t <= outS + 0.03);
    const onset = onsets.find((t) => t >= inS - 0.03);
    if (offset == null || onset == null) continue;
    const tailS = outS - offset;
    const leadS = onset - inS;
    if (Math.abs(tailS) > 0.4 || Math.abs(leadS) > 0.4) continue;
    const before = [...words].reverse().find((w) => w.end <= outS + 0.1);
    out.push({ tailS: r3(tailS), leadS: r3(leadS), sentenceEnd: !!before && SENTENCE_END.test(before.word) });
  }
  return out;
}
