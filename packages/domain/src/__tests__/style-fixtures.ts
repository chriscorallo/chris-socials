import type { ReferenceVideoMetrics } from "../style-metrics";

/** A well-formed measurement with tweakable headline numbers (tests only). */
export function fakeMetrics(over: Partial<{ shot: number; wpm: number; gapP90: number; hook: number; tail: number; bg: number | null; lufs: number; cutsPer10s: number }> = {}): ReferenceVideoMetrics {
  const shot = over.shot ?? 2;
  return {
    version: 1,
    video: { durationS: 30, width: 1080, height: 1920, aspect: "9:16", fps: 30 },
    cuts: {
      count: 14,
      times: [2, 4],
      shotMedianS: shot,
      shotP25S: shot * 0.7,
      shotP75S: shot * 1.3,
      cutsPer10s: over.cutsPer10s ?? 10 / shot,
      firstCutS: 1.2,
      pacing: { first3sPer10s: 6.67, middlePer10s: 4.5, last3sPer10s: 3.33 },
      method: "test",
    },
    speech: {
      wordCount: 90,
      speechStartS: 0.1,
      speechEndS: 29.5,
      wpm: over.wpm ?? 185,
      gapMedianS: 0.05,
      gapP90S: over.gapP90 ?? 0.25,
      longestGapS: 0.6,
      pausesPerMinute: 4,
      hookText: "You're doing your 401k wrong.",
      hookDurationS: over.hook ?? 2.1,
      hookEndS: 2.2,
      lastSentence: "Follow for more.",
      tailAfterLastWordS: over.tail ?? 0.4,
      endsRightAfterLastWord: (over.tail ?? 0.4) <= 0.3,
      closingShotAfterSpeech: false,
    },
    audio: {
      integratedLufs: over.lufs ?? -14,
      loudnessRangeLu: 4,
      truePeakDbtp: -1,
      samplePeakDb: -1.2,
      clipping: false,
      voiceLevelDb: -16,
      backgroundLevelDb: over.bg === null ? -80 : -16 - (over.bg ?? 18),
      backgroundUnderVoiceDb: over.bg === null ? null : (over.bg ?? 18),
      background: over.bg === null ? "none" : "present",
      backgroundMethod: "floor",
    },
    transcript: "You're doing your 401k wrong. …",
    notes: [],
  };
}
