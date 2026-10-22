import type { SpliceAnalysis } from "../splice/analysis";

/**
 * The pads a reference leaves at its cuts (round 3/4): at every detected cut with voice close on
 * both sides, offset→cut (the tail the editor kept) and cut→onset (the lead). These are THEIR
 * splice pads, measured on their own envelope — the one reference signal that maps straight
 * onto the splice engine. PURE.
 */
export interface ReferencePads {
  /** Cuts with voice within `nearS` on both sides (the only ones that say anything about pads). */
  n: number;
  tailMedianMs: number | null;
  leadMedianMs: number | null;
  tailP75Ms: number | null;
  leadP75Ms: number | null;
  /** The kept pause at those cuts (tail + lead), median. */
  airMedianMs: number | null;
  samples: Array<{ cutS: number; tailMs: number; leadMs: number }>;
}

const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1) + 0.5))]! : null);

export function referencePads(analysis: SpliceAnalysis, cutTimes: number[], nearS = 0.6): ReferencePads {
  const samples: ReferencePads["samples"] = [];
  for (const c of cutTimes) {
    const before = [...analysis.voice].reverse().find((v) => v.start < c);
    const after = analysis.voice.find((v) => v.end > c);
    if (!before || !after) continue;
    // A cut inside continuous voice carries no pad information; one with a long silence either
    // side is a scene change, not a splice.
    const tail = c - before.end;
    const lead = after.start - c;
    if (tail < -0.02 || lead < -0.02 || tail > nearS || lead > nearS) continue;
    samples.push({ cutS: Math.round(c * 1000) / 1000, tailMs: Math.round(Math.max(0, tail) * 1000), leadMs: Math.round(Math.max(0, lead) * 1000) });
  }
  const tails = samples.map((s) => s.tailMs);
  const leads = samples.map((s) => s.leadMs);
  return {
    n: samples.length,
    tailMedianMs: q(tails, 0.5),
    leadMedianMs: q(leads, 0.5),
    tailP75Ms: q(tails, 0.75),
    leadP75Ms: q(leads, 0.75),
    airMedianMs: q(samples.map((s) => s.tailMs + s.leadMs), 0.5),
    samples: samples.slice(0, 200),
  };
}
