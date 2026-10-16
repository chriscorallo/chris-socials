import { describe, it, expect } from "vitest";
import {
  buildTranscriptPhrases,
  formatTimestampedTranscript,
  snapSegmentsToWordBoundaries,
} from "../transcript-timing";
import type { TranscriptWord } from "../transcription-provider";

const words: TranscriptWord[] = [
  { word: "Okay", start: 0.5, end: 0.8 },
  { word: "so.", start: 0.8, end: 1.0 },
  { word: "Most", start: 2.0, end: 2.2 },
  { word: "people", start: 2.2, end: 2.5 },
  { word: "think", start: 2.5, end: 2.9 },
  { word: "wrong.", start: 2.9, end: 3.3 },
  { word: "Here's", start: 4.5, end: 4.8 },
  { word: "why.", start: 4.8, end: 5.1 },
];

describe("buildTranscriptPhrases / formatTimestampedTranscript", () => {
  it("splits at sentence punctuation and pauses, with real start/end times", () => {
    const phrases = buildTranscriptPhrases(words);
    expect(phrases).toEqual([
      { start: 0.5, end: 1.0, text: "Okay so." },
      { start: 2.0, end: 3.3, text: "Most people think wrong." },
      { start: 4.5, end: 5.1, text: "Here's why." },
    ]);
    const text = formatTimestampedTranscript(phrases);
    expect(text).toContain("[2.00-3.30] (pause 1.00s before) Most people think wrong.");
  });
});

describe("snapSegmentsToWordBoundaries", () => {
  it("moves a mid-word start to the word edge and keeps pre/post-roll inside the silence", () => {
    const { segments, adjustments } = snapSegmentsToWordBoundaries(
      [{ startSeconds: 2.1, endSeconds: 3.1 }], // starts mid "Most", ends mid "wrong."
      words,
      { sourceDurationSeconds: 6 },
    );
    expect(segments[0]!.startSeconds).toBeCloseTo(1.92, 3); // 2.0 - 0.08 pre-roll
    expect(segments[0]!.endSeconds).toBeCloseTo(3.45, 3); // 3.3 + 0.15 post-roll
    expect(adjustments).toHaveLength(1);
  });

  it("never lets roll reach into the neighbouring word", () => {
    const tight: TranscriptWord[] = [
      { word: "a", start: 1.0, end: 1.5 },
      { word: "b", start: 1.52, end: 2.0 },
    ];
    const { segments } = snapSegmentsToWordBoundaries([{ startSeconds: 1.5, endSeconds: 1.98 }], tight);
    expect(segments[0]!.startSeconds).toBeGreaterThanOrEqual(1.5);
    expect(segments[0]!.endSeconds).toBeLessThanOrEqual(2.15);
  });

  it("leaves a cut that is already deep in silence alone, and clamps to the source duration", () => {
    const { segments } = snapSegmentsToWordBoundaries(
      [{ startSeconds: 0, endSeconds: 6 }],
      words,
      { sourceDurationSeconds: 6 },
    );
    expect(segments[0]!.startSeconds).toBe(0);
    expect(segments[0]!.endSeconds).toBe(6);
  });

  it("is a no-op without word timings", () => {
    const segs = [{ startSeconds: 1.234, endSeconds: 2.345 }];
    expect(snapSegmentsToWordBoundaries(segs, []).segments).toEqual(segs);
  });
});
