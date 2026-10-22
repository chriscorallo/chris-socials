import { describe, it, expect } from "vitest";
import { buildStyleModel, describeStyleModel, editorDigest, excludedSignals, sampleFromReferenceMetrics, sampleFromTimeline, type StyleSample } from "../style-model";
import type { ReferenceVideoMetrics } from "../style-metrics";

function metrics(over: Partial<ReferenceVideoMetrics> = {}): ReferenceVideoMetrics {
  return {
    version: 3,
    video: { durationS: 40, sourceDurationS: 40, endCardS: null, width: 1080, height: 1920, aspect: "9:16", fps: 30 },
    cuts: { count: 10, times: [], shotMedianS: 3.2, shotP25S: 2, shotP75S: 5, cutsPer10s: 2.5, firstCutS: 2.1, pacing: { first3sPer10s: 3, middlePer10s: 2, last3sPer10s: 2 }, method: "x" },
    speech: { wordCount: 120, speechStartS: 0.3, speechEndS: 39, wpm: 180, gapMedianS: 0.12, gapP90S: 0.4, longestGapS: 0.8, pausesPerMinute: 10, hookText: "h", hookDurationS: 2, hookEndS: 2, lastSentence: "l", tailAfterLastWordS: 0.2, endsRightAfterLastWord: true, closingShotAfterSpeech: false },
    audio: { integratedLufs: -14, loudnessRangeLu: 5, truePeakDbtp: -1, samplePeakDb: -1, clipping: false, voiceLevelDb: -18, backgroundLevelDb: -40, backgroundUnderVoiceDb: 22, background: "present", backgroundMethod: "floor", mix: "voice-over-music", activeShare: 0.9 },
    voice: { present: true, wordCount: 120, coverage: 0.9, contrastDb: 20, reason: "" },
    screen: {
      method: "fake",
      frames: 160,
      headlines: { count: 8, per10s: 2, holdMedianS: 4.5, wordsMedian: 3, band: "TOP", uppercaseShare: 1 },
      captions: { present: true, wordsPerChunk: 1, band: "LOW", oneWordShare: 0.9, uppercaseShare: 1, coverage: 0.8 },
      hook: { text: "SAME SALARY", byS: 0.8 },
      longestBareS: 3,
      events: [],
    },
    zooms: { method: "fake", count: 4, per10s: 1, amountMedian: 1.1, rampMedianS: 0.4, holdMedianS: 3, inOutShare: 0.75 },
    pads: { n: 6, tailMedianMs: 90, leadMedianMs: 70, tailP75Ms: 120, leadP75Ms: 90, airMedianMs: 160 },
    rhythm: { thirdsPer10s: [3, 2, 2.5], jumpCutShare: 0.6 },
    transcript: null,
    notes: [],
    ...over,
  };
}

describe("StyleModel — bands from references and his own edits", () => {
  it("builds p25–p75 bands, modes and shares; his edits weigh double; a 'don't copy' note excludes a creator from that signal", () => {
    const a = sampleFromReferenceMetrics(metrics(), "c1", "a");
    const b = sampleFromReferenceMetrics(metrics({ screen: { ...metrics().screen!, headlines: { ...metrics().screen!.headlines, per10s: 1, holdMedianS: 6 }, captions: { ...metrics().screen!.captions, oneWordShare: 0.1, wordsPerChunk: 3 } } }), "c2", "b");
    const mine = sampleFromTimeline(
      {
        clips: [{ sourceStart: 0, sourceEnd: 5, mediaAssetId: "t" }, { sourceStart: 6, sourceEnd: 20, mediaAssetId: "t" }, { sourceStart: 21, sourceEnd: 40, mediaAssetId: "t" }],
        texts: [{ text: "SAME SALARY", start: 0, end: 4, y: 0.2, uppercase: true }, { text: "$733 VS $4,133", start: 10, end: 16, y: 0.2, uppercase: true }],
        captions: { enabled: true, maxWordsPerChunk: 1, y: 0.72, uppercase: false, chunking: [] },
        zooms: [{ start: 8, end: 12, zoom: 1.08, easeOutSeconds: 0.4 }],
        audio: { music: null },
      },
      "my edit",
    );
    expect(mine.source).toBe("MINE");
    expect(mine.weight).toBe(2);
    expect(mine.headlinesPer10s).toBeCloseTo(0.53, 1);
    expect(mine.captionPreset).toBe("ONE_WORD");
    const m = buildStyleModel([a, b, mine], { exclusions: [{ creatorId: "c2", name: "Creator two", signals: excludedSignals("don't copy their captions") }] });
    expect(m.sampleSize).toBe(3);
    expect(m.mineCount).toBe(1);
    expect(m.creatorCount).toBe(2);
    // c2 excluded from captions → one-word wins (a + mine)
    expect(m.captions.preset).toBe("ONE_WORD");
    expect(m.exclusions[0]).toMatch(/Creator two left out of captions/);
    // headlines: a (2/10 s), b (1/10 s), mine ×2 (0.53) → band covers them
    expect(m.headlinesPer10s!.p25).toBeLessThanOrEqual(1);
    expect(m.headlinesPer10s!.p75).toBeGreaterThanOrEqual(1);
    expect(m.headlineBand).toBe("TOP");
    expect(m.pads).toEqual({ tailMs: { p25: 90, p50: 90, p75: 90, n: 2 }, leadMs: { p25: 70, p50: 70, p75: 70, n: 2 } });
    expect(m.zoomInOutShare).toBeGreaterThan(0.5);
    // music: both references have a bed, his edit (weight 2) has none → half
    expect(m.musicShare).toBe(0.5);
  });

  it("the paragraph and the Editor's digest read as sentences, never raw numbers", () => {
    const m = buildStyleModel([sampleFromReferenceMetrics(metrics(), "c1", "a"), sampleFromReferenceMetrics(metrics(), "c1", "b"), sampleFromReferenceMetrics(metrics(), "c3", "c")]);
    const p = describeStyleModel(m);
    expect(p).toMatch(/^Your references run 40 s/);
    expect(p).toMatch(/open with text on screen by 0\.8 s/);
    expect(p).toMatch(/headline up every 5\.0 s, 3 words, held 4\.5 s, in the top of the frame/);
    expect(p).toMatch(/caption one word at a time low/);
    expect(p).toMatch(/leave 90 ms before a cut and 70 ms after/);
    expect(p).toMatch(/3 reference videos from 2 creators/);
    const d = editorDigest(m);
    expect(d.length).toBeLessThanOrEqual(10);
    expect(d[0]).toMatch(/^Length:/);
    expect(d.some((l) => /Headlines: one every 5\.0 s/.test(l))).toBe(true);
    expect(d.some((l) => /Captions: one word at a time/.test(l))).toBe(true);
  });

  it("without screen measurements (v2 rows) the model still carries cuts, pauses and sound", () => {
    const old = metrics({ version: 2, screen: undefined, zooms: undefined, pads: undefined, rhythm: undefined });
    const m = buildStyleModel([sampleFromReferenceMetrics(old, "c1", "a")]);
    expect(m.headlinesPer10s).toBeNull();
    expect(m.captions.preset).toBeNull();
    expect(m.shotS?.p50).toBe(3.2);
    expect(m.pauseKeepS?.p50).toBe(0.12);
    expect(describeStyleModel(m)).toMatch(/cut every 3\.2 s/);
  });

  it("excludedSignals reads the 'don't copy' note", () => {
    expect(excludedSignals("Don't copy the music or the jump cuts")).toEqual(["cuts", "pads", "music"]);
    expect(excludedSignals(null)).toEqual([]);
    const s: StyleSample[] = [];
    expect(buildStyleModel(s).sampleSize).toBe(0);
  });
});
