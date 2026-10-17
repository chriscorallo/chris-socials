import { describe, it, expect } from "vitest";
import {
  aggregateStyle,
  aggregateOwnSpeech,
  aspectLabel,
  compareOwnToReference,
  describeStyle,
  fmtSeconds,
  median,
  parseReferenceVideoMetrics,
  quantile,
  sampleSizeText,
  shotMetrics,
  speechMetrics,
  splitSentences,
  videoSummary,
  ReferenceVideoMetricsSchema,
  type TimedWord,
} from "../style-metrics";
import { fakeMetrics } from "./style-fixtures";

const w = (word: string, start: number, end: number): TimedWord => ({ word, start, end });

describe("quantile / median", () => {
  it("interpolates and ignores non-finite values", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(quantile([0, 10], 0.9)).toBe(9);
    expect(quantile([], 0.5)).toBeNull();
    expect(median([1, NaN, 3])).toBe(2);
  });
});

describe("aspectLabel", () => {
  it("names common ratios and reduces the rest", () => {
    expect(aspectLabel(1080, 1920)).toBe("9:16");
    expect(aspectLabel(1080, 1350)).toBe("4:5");
    expect(aspectLabel(1920, 1080)).toBe("16:9");
    expect(aspectLabel(1000, 700)).toBe("10:7");
    expect(aspectLabel(null, 100)).toBeNull();
  });
});

describe("shotMetrics", () => {
  it("shot lengths, density and pacing from known cut times", () => {
    // 12 s video, cuts at 1, 2, 3 (fast open), 6, 9 → shots 1,1,1,3,3,3
    const m = shotMetrics([3, 1, 2, 6, 9, 0, 12.5], 12, "test");
    expect(m.count).toBe(5);
    expect(m.times).toEqual([1, 2, 3, 6, 9]);
    expect(m.shotMedianS).toBe(2);
    expect(m.shotP25S).toBe(1);
    expect(m.shotP75S).toBe(3);
    expect(m.cutsPer10s).toBeCloseTo(4.17, 2);
    expect(m.firstCutS).toBe(1);
    expect(m.pacing.first3sPer10s).toBeCloseTo(6.67, 2); // cuts at 1, 2 in [0, 3)
    expect(m.pacing.middlePer10s).toBeCloseTo(3.33, 2); // 3, 6 in [3, 9)
    expect(m.pacing.last3sPer10s).toBeCloseTo(3.33, 2); // 9 in [9, 12]
  });
  it("no cuts → one shot, the whole video", () => {
    const m = shotMetrics([], 8, "test");
    expect(m.count).toBe(0);
    expect(m.shotMedianS).toBe(8);
    expect(m.firstCutS).toBeNull();
  });
});

describe("speech metrics", () => {
  const words = [
    w("Stop", 0.2, 0.4), w("budgeting", 0.4, 0.9), w("like", 0.9, 1.1), w("this.", 1.1, 1.5),
    w("Most", 1.8, 2.0), w("people", 2.0, 2.3), w("get", 2.3, 2.5), w("it", 2.5, 2.6), w("wrong.", 2.6, 3.0),
    w("Here's", 4.0, 4.3), w("why", 4.3, 4.6), w("it", 4.6, 4.7), w("matters.", 4.7, 5.2),
  ];
  it("wpm, gaps, hook and ending", () => {
    const s = speechMetrics(words, 5.6, [1.6, 5.4])!;
    expect(s.wordCount).toBe(13);
    expect(s.speechStartS).toBe(0.2);
    expect(s.wpm).toBe(Math.round((13 / 5) * 60));
    expect(s.longestGapS).toBe(1);
    expect(s.gapP90S).toBeCloseTo(0.27, 3); // 12 gaps: ten 0s, 0.3, 1.0
    expect(s.gapMedianS).toBe(0);
    expect(s.pausesPerMinute).toBeCloseTo((2 / 5) * 60, 1); // gaps 0.3 and 1.0
    expect(s.hookText).toBe("Stop budgeting like this.");
    expect(s.hookDurationS).toBeCloseTo(1.3, 3);
    expect(s.lastSentence).toBe("Here's why it matters.");
    expect(s.tailAfterLastWordS).toBeCloseTo(0.4, 3);
    expect(s.endsRightAfterLastWord).toBe(false);
    expect(s.closingShotAfterSpeech).toBe(true); // a cut at 5.4, after the last word
  });
  it("splits on a long silence when there's no punctuation; caps a run-on hook", () => {
    const run = Array.from({ length: 40 }, (_, i) => w(`word${i}`, i * 0.3, i * 0.3 + 0.25));
    expect(splitSentences([w("a", 0, 0.2), w("b", 1.0, 1.2)])).toHaveLength(2);
    const s = speechMetrics(run, 13, null)!;
    expect(s.hookText.split(" ")).toHaveLength(25);
    expect(s.closingShotAfterSpeech).toBeNull();
  });
  it("a one-word opener runs on into the next sentence for the hook", () => {
    const s = speechMetrics([w("Okay.", 0, 0.4), w("Budgeting", 1.7, 2.5), w("is", 2.5, 2.7), w("easy.", 2.7, 3.1), w("Really.", 3.5, 4)], 5, null)!;
    expect(s.hookText).toBe("Okay. Budgeting is easy.");
    expect(s.hookDurationS).toBeCloseTo(3.1, 3);
  });
  it("no words → null; ends on the last word", () => {
    expect(speechMetrics([], 10, null)).toBeNull();
    expect(speechMetrics([w("Hi.", 0, 0.5), w("Bye.", 0.6, 0.9)], 1.0, null)!.endsRightAfterLastWord).toBe(true);
  });
});

describe("schema", () => {
  it("accepts a well-formed result and rejects malformed ones", () => {
    expect(ReferenceVideoMetricsSchema.safeParse(fakeMetrics()).success).toBe(true);
    expect(parseReferenceVideoMetrics({ ...fakeMetrics(), version: 2 })).toBeNull();
    expect(parseReferenceVideoMetrics({ ...fakeMetrics(), video: { durationS: -1 } })).toBeNull();
    const bad = fakeMetrics();
    (bad.audio as unknown as { background: string }).background = "loud";
    expect(parseReferenceVideoMetrics(bad)).toBeNull();
    expect(parseReferenceVideoMetrics(null)).toBeNull();
    // Nullable sections (no video / no audio / no speech) are valid.
    expect(parseReferenceVideoMetrics({ ...fakeMetrics(), cuts: null, speech: null, audio: null })).not.toBeNull();
  });
});

describe("aggregation + plain English", () => {
  it("medians across videos, each video counted once", () => {
    const p = aggregateStyle([
      { metrics: fakeMetrics({ shot: 1.5, wpm: 170 }), creatorId: "a" },
      { metrics: fakeMetrics({ shot: 2.0, wpm: 185, bg: null }), creatorId: "a" },
      { metrics: fakeMetrics({ shot: 4.0, wpm: 200, bg: 20 }), creatorId: "b" },
    ]);
    expect(p.sampleSize).toBe(3);
    expect(p.creatorCount).toBe(2);
    expect(p.confidence).toBe("fair");
    expect(p.shotMedianS!.value).toBe(2);
    expect(p.wpm!.value).toBe(185);
    expect(p.backgroundPresent).toEqual({ withBackground: 2, measured: 3 });
    expect(p.backgroundUnderVoiceDb!.value).toBe(19); // median of 18 and 20, background videos only
    const lines = describeStyle(p);
    const text = lines.map((l) => l.text);
    expect(text).toContain("Cuts every 2.0 s");
    expect(text).toContain("Talks 185 words a minute");
    expect(text).toContain("Pauses are short — under 0.25 s");
    expect(text).toContain("Music sits 19 dB under the voice");
    expect(text).toContain("Hook lasts 2.1 s");
    expect(text).toContain("Ends 0.4 s after the last word");
    expect(text).toContain("Faster cuts in the first 3 seconds");
  });
  it("no background anywhere → says so; empty → no lines", () => {
    expect(describeStyle(aggregateStyle([{ metrics: fakeMetrics({ bg: null }) }])).map((l) => l.text)).toContain("No background music — just the voice");
    expect(describeStyle(aggregateStyle([]))).toEqual([]);
  });
  it("doesn't overstate small samples", () => {
    expect(aggregateStyle([{ metrics: fakeMetrics() }]).confidence).toBe("early");
    expect(sampleSizeText(1)).toMatch(/only 1 video.*early read/);
    expect(sampleSizeText(2)).toMatch(/only 2 videos/);
    expect(sampleSizeText(5)).toBe("From 5 videos — a fair read");
    expect(sampleSizeText(12)).toBe("From 12 videos");
  });
  it("formats seconds and per-video summaries", () => {
    expect(fmtSeconds(1.84)).toBe("1.8 s");
    expect(fmtSeconds(0.25)).toBe("0.25 s");
    expect(fmtSeconds(0.3)).toBe("0.3 s");
    expect(fmtSeconds(38.4)).toBe("38 s");
    expect(videoSummary(fakeMetrics())).toBe("Cuts every 2.0 s · 185 wpm · hook 2.1 s · music −18 dB");
  });
});

describe("you vs them", () => {
  it("says how Chris's raw takes differ, in plain English", () => {
    const ref = aggregateStyle([{ metrics: fakeMetrics({ gapP90: 0.3, wpm: 190, hook: 2 }) }, { metrics: fakeMetrics({ gapP90: 0.3, wpm: 190, hook: 2 }) }, { metrics: fakeMetrics({ gapP90: 0.3, wpm: 190, hook: 2 }) }]);
    const own = aggregateOwnSpeech([
      { ...fakeMetrics().speech!, gapP90S: 0.6, wpm: 150, hookDurationS: 2.1, speechStartS: 1.2 },
      { ...fakeMetrics().speech!, gapP90S: 0.62, wpm: 152, hookDurationS: 2.0, speechStartS: 1.0 },
    ]);
    const lines = compareOwnToReference(own, ref);
    const byKey = Object.fromEntries(lines.map((l) => [l.key, l.text]));
    expect(byKey.pauses).toBe("Your pauses are 2× longer than your references'");
    expect(byKey.wpm).toBe("You talk 21% slower than your references");
    expect(byKey.hook).toBe("Your opening line is about as long as theirs");
    expect(byKey.start).toMatch(/You start talking 1\.1 s in/);
    expect(compareOwnToReference(aggregateOwnSpeech([]), ref)).toEqual([]);
  });
});
