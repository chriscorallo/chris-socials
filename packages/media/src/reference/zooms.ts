import type { SubjectTrack } from "../subject-track-core";

/**
 * Zoom usage in a reference (round 4): the subject track's head width drifts within one shot
 * when the picture pushes in or out — a monotonic change of ≥ `minAmount` over ≤ `maxRampS`,
 * then a hold, is a zoom. Between cuts only (a cut changes the framing instantly and is not a
 * zoom). PURE. The amount is the ratio of head widths (1.08 = an 8 % push-in); shape = how long
 * the ramp took; hold = how long the new framing stayed before the next change or cut.
 */
export interface ReferenceZoom {
  start: number;
  /** When the ramp finished. */
  settled: number;
  /** When the framing changed again or the shot ended. */
  end: number;
  amount: number;
  direction: "IN" | "OUT";
}

export interface ZoomUsage {
  count: number;
  per10s: number;
  amountMedian: number | null;
  rampMedianS: number | null;
  holdMedianS: number | null;
  /** Zooms that ease back out before the shot ends (in-hold-out), as a share. */
  inOutShare: number | null;
  zooms: ReferenceZoom[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);

export function detectReferenceZooms(track: SubjectTrack, cutTimes: number[], durationS: number, opts: { minAmount?: number; maxRampS?: number; minHoldS?: number } = {}): ZoomUsage {
  const minAmount = opts.minAmount ?? 0.06;
  const maxRampS = opts.maxRampS ?? 1.5;
  const minHoldS = opts.minHoldS ?? 0.4;
  const samples = track.filter((s) => s.box && s.box.w > 0).map((s) => ({ t: s.t, w: s.box!.w }));
  const bounds = [0, ...cutTimes.filter((c) => c > 0 && c < durationS).sort((a, b) => a - b), durationS];
  const zooms: ReferenceZoom[] = [];
  for (let b = 0; b < bounds.length - 1; b++) {
    const shot = samples.filter((s) => s.t >= bounds[b]! && s.t < bounds[b + 1]!);
    if (shot.length < 4) continue;
    // Light smoothing (3-sample median) so detector jitter never reads as a zoom.
    const sm = shot.map((s, i) => {
      const win = shot.slice(Math.max(0, i - 1), i + 2).map((x) => x.w).sort((x, y) => x - y);
      return { t: s.t, w: win[Math.floor(win.length / 2)]! };
    });
    let i = 0;
    while (i < sm.length - 1) {
      // A run of same-direction changes.
      const dir = Math.sign(sm[i + 1]!.w - sm[i]!.w);
      let j = i + 1;
      while (j < sm.length - 1 && Math.sign(sm[j + 1]!.w - sm[j]!.w) === dir && dir !== 0) j++;
      const ratio = sm[j]!.w / sm[i]!.w;
      const amount = dir > 0 ? ratio : 1 / ratio;
      const rampS = sm[j]!.t - sm[i]!.t;
      if (dir !== 0 && amount >= 1 + minAmount && rampS <= maxRampS) {
        // Hold: until the width moves by more than a third of the amount again, or the shot ends.
        let k = j;
        while (k < sm.length - 1 && Math.abs(sm[k + 1]!.w / sm[j]!.w - 1) < (amount - 1) / 3) k++;
        const end = k < sm.length - 1 ? sm[k]!.t : bounds[b + 1]!;
        if (end - sm[j]!.t >= minHoldS) zooms.push({ start: r3(sm[i]!.t), settled: r3(sm[j]!.t), end: r3(end), amount: r3(amount), direction: dir > 0 ? "IN" : "OUT" });
        i = Math.max(j, k);
        continue;
      }
      i = j > i ? j : i + 1;
    }
  }
  const ins = zooms.filter((z) => z.direction === "IN");
  const inOut = ins.filter((z) => zooms.some((o) => o.direction === "OUT" && o.start >= z.end - 0.2 && o.start < z.end + 1.5));
  return {
    count: ins.length,
    per10s: durationS > 0 ? r3((ins.length / durationS) * 10) : 0,
    amountMedian: median(ins.map((z) => z.amount)),
    rampMedianS: median(ins.map((z) => r3(z.settled - z.start))),
    holdMedianS: median(ins.map((z) => r3(z.end - z.settled))),
    inOutShare: ins.length ? r3(inOut.length / ins.length) : null,
    zooms,
  };
}
