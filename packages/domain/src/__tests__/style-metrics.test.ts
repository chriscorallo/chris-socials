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
  REFERENCE_METRICS_VERSION,
  audioMix,
  classifySpeech,
  isLexicalWord,
  sanitizeReferenceMetrics,
  type TimedWord,
} from "../style-metrics";
import { fakeMetrics, fakeMusicLedMetrics } from "./style-fixtures";

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
    expect(parseReferenceVideoMetrics({ ...fakeMetrics(), version: 4 })).toBeNull();
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

describe("is anyone talking? (v2)", () => {
  // ~2.5 words a second over 8 s, like a real talking clip.
  const talking = Array.from({ length: 20 }, (_, i) => w(i % 6 === 5 ? `word${i}.` : `word${i}`, 0.3 + i * 0.4, 0.3 + i * 0.4 + 0.3));

  it("real talking → present, with the real words", () => {
    const c = classifySpeech(talking, 9, 12);
    expect(c.present).toBe(true);
    expect(c.wordCount).toBe(20);
    expect(c.coverage).toBeGreaterThan(0.6);
    // No acoustic check available → words alone decide.
    expect(classifySpeech(talking, 9, null).present).toBe(true);
  });

  it("Whisper's invented words on an 11 s music video (timings past the end, zero length) → not talking", () => {
    // What production showed: "Starts talking at 19 s" / "Hook lasts 0.0 s" on ~11 s videos.
    const invented = [w("You", 19.2, 19.2), w("know", 19.2, 19.2), w("what", 19.4, 19.4), w("I", 21, 21), w("mean.", 21, 21), w("Thank", 10.6, 10.6), w("you.", 10.6, 10.6)];
    const c = classifySpeech(invented, 11, null);
    expect(c.present).toBe(false);
    expect(c.words.every((x) => x.start < 11)).toBe(true);
    // And even the old speech math, given those words, no longer reports talking past the end.
    const s = speechMetrics(invented, 11, null);
    expect(s == null || (s.speechStartS < 11 && (s.hookDurationS == null || s.hookDurationS > 0))).toBe(true);
  });

  it("sparse words over music → not talking (no fake WPM)", () => {
    const sparse = [w("Remember", 1.0, 1.4), w("this", 1.4, 1.6), w("always.", 1.6, 2.0), w("Never", 7.0, 7.3), w("quit.", 7.3, 7.7)];
    const c = classifySpeech(sparse, 15, 6);
    expect(c.present).toBe(false);
    expect(c.reason).toMatch(/cover only/);
  });

  it("words that aren't louder than the music between them → not talking", () => {
    const c = classifySpeech(talking, 9, 0.8);
    expect(c.present).toBe(false);
    expect(c.reason).toMatch(/aren't louder/);
  });

  it("music tags, loops and sung (drawn-out) words aren't talking", () => {
    expect(isLexicalWord("[Music]")).toBe(false);
    expect(isLexicalWord("(upbeat")).toBe(false);
    expect(isLexicalWord("music)")).toBe(false);
    expect(isLexicalWord("♪")).toBe(false);
    expect(isLexicalWord("...")).toBe(false);
    expect(isLexicalWord("don't")).toBe(true);
    expect(isLexicalWord("401k")).toBe(true);
    expect(classifySpeech([w("[Music]", 0, 10)], 10, null).reason).toMatch(/only music/);
    const loop = Array.from({ length: 12 }, (_, i) => w(i % 2 ? "you." : "Thank", i * 0.5, i * 0.5 + 0.3));
    expect(classifySpeech(loop, 7, null).present).toBe(false);
    const sung = Array.from({ length: 10 }, (_, i) => w(`la${i}`, i * 1.0, i * 1.0 + 0.9));
    expect(classifySpeech(sung, 10, null).reason).toMatch(/drawn out/);
  });

  it("soundtrack label", () => {
    expect(audioMix(true, "none", { activeShare: 0.8, integratedLufs: -14 })).toBe("voice");
    expect(audioMix(true, "present", { activeShare: 1, integratedLufs: -14 })).toBe("voice-over-music");
    expect(audioMix(false, "unknown", { activeShare: 0.97, integratedLufs: -15 })).toBe("music-led");
    expect(audioMix(false, "unknown", { activeShare: 0.1, integratedLufs: -50 })).toBe("quiet");
    expect(audioMix(false, "unknown", { activeShare: null, integratedLufs: null })).toBe("unknown");
  });
});

describe("versions + impossible values", () => {
  it("v3 is current; v1 and v2 rows still parse", () => {
    expect(REFERENCE_METRICS_VERSION).toBe(3);
    expect(parseReferenceVideoMetrics(fakeMetrics())!.version).toBe(1);
    expect(parseReferenceVideoMetrics(fakeMusicLedMetrics())!.version).toBe(2);
    expect(parseReferenceVideoMetrics({ ...fakeMetrics(), version: 2, video: { ...fakeMetrics().video, endCardS: 3.1, sourceDurationS: 33.1 } })!.video.endCardS).toBe(3.1);
  });

  it("drops speech that starts after the video ends and zero-length hooks (old v1 music rows)", () => {
    const m = fakeMetrics();
    const bad = { ...m, video: { ...m.video, durationS: 11 }, speech: { ...m.speech!, speechStartS: 19, speechEndS: 21, hookDurationS: 0 } };
    expect(parseReferenceVideoMetrics(bad)!.speech).toBeNull();
    const zeroHook = { ...m, speech: { ...m.speech!, hookDurationS: 0 } };
    expect(sanitizeReferenceMetrics(zeroHook).speech!.hookDurationS).toBeNull();
    expect(sanitizeReferenceMetrics(m)).toBe(m); // sane rows pass through untouched
  });
});

describe("aggregation skips what doesn't apply (v2)", () => {
  it("a no-face music-led group: no speech lines, no 'just the voice', says music-led", () => {
    const p = aggregateStyle([{ metrics: fakeMusicLedMetrics({ endCard: 3 }) }, { metrics: fakeMusicLedMetrics({ shot: 1.6, durationS: 10 }) }, { metrics: fakeMusicLedMetrics({ durationS: 12 }) }]);
    expect(p.wpm).toBeNull();
    expect(p.speechStartS).toBeNull();
    expect(p.hookDurationS).toBeNull();
    expect(p.tailAfterLastWordS).toBeNull();
    expect(p.musicLed).toEqual({ yes: 3, measured: 3 });
    expect(p.talking).toEqual({ yes: 0, measured: 3 });
    expect(p.endCardsRemoved).toBe(1);
    expect(p.durationS!.value).toBe(11);
    const text = describeStyle(p).map((l) => l.text);
    expect(text).toContain("Music-led — no talking");
    expect(text.join(" ")).not.toMatch(/Talks|Hook|Starts talking|last word|just the voice|under the voice/);
    expect(text).toContain("Cuts every 1.2 s");
    expect(text).toContain("Loudness -15 LUFS");
    expect(describeStyle(p).find((l) => l.key === "length")!.detail).toMatch(/end card.*1 of 3/);
    expect(videoSummary(fakeMusicLedMetrics())).toBe("Cuts every 1.2 s · music-led, no talking");
  });

  it("a mixed group: speech medians come from talking videos only — never averaged with zeros", () => {
    const p = aggregateStyle([
      { metrics: fakeMetrics({ wpm: 170, bg: null }) },
      { metrics: fakeMetrics({ wpm: 190, bg: null }) },
      { metrics: fakeMusicLedMetrics() },
    ]);
    expect(p.wpm).toMatchObject({ value: 180, n: 2 });
    expect(p.hookDurationS!.n).toBe(2);
    // Background-under-voice is about talking videos; the music video doesn't turn it into "music".
    expect(p.backgroundPresent).toEqual({ withBackground: 0, measured: 2 });
    const text = describeStyle(p).map((l) => l.text);
    expect(text).toContain("No background music — just the voice");
    expect(text).not.toContain("Music-led — no talking");
  });

  it("old v1 rows with impossible speech are skipped, not averaged", () => {
    const m = fakeMetrics({ wpm: 400 });
    const v1Music = { ...m, video: { ...m.video, durationS: 11 }, speech: { ...m.speech!, speechStartS: 19, speechEndS: 21, hookDurationS: 0 } };
    const p = aggregateStyle([{ metrics: v1Music }, { metrics: fakeMetrics({ wpm: 180 }) }]);
    expect(p.wpm).toMatchObject({ value: 180, n: 1 });
    expect(p.speechStartS).toMatchObject({ value: 0.1, n: 1 });
  });
});
