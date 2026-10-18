import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Film } from "../dsl/schema";
import { splitForSpeech, stripPauseMarkers } from "../narration/speech-text";
import { KOKORO_ENGLISH_VOICES, NARRATION_VOICES, DEFAULT_NARRATION_VOICE } from "../narration/voices";
import { alignRecordingWords, narrationFromRecording } from "../narration/recording";
import { runFfmpeg, probeDurationSeconds } from "../audio/ffmpeg";
import { resolveFilm } from "../timing";
import { NarrationSchema } from "../dsl/schema";

const film: Film = {
  dsl: 1,
  id: "rec",
  title: "Recording",
  format: { width: 1080, height: 1920, fps: 30 },
  look: "GOLD_STUDIO",
  narration: { engine: "CHRIS", voice: "chris" },
  cast: [],
  scenes: [
    {
      id: "s",
      set: { kind: "INFINITY_STUDIO" },
      shots: [
        { id: "one", line: "Your raise is already gone.", camera: { rig: "HOLD", target: [0, 0, 0], from: { distance: 5 }, lens: { focalLength: 32 } } },
        { id: "two", line: "You raised your baseline.", camera: { rig: "HOLD", target: [0, 0, 0], from: { distance: 5 }, lens: { focalLength: 32 } } },
      ],
    },
  ],
};

/** What Whisper might hear from Chris: an ad-lib ("so"), a dropped word ("already"), a filler ("um"). */
const heard = [
  { word: "So", start: 0.3, end: 0.45 },
  { word: "your", start: 0.6, end: 0.8 },
  { word: "raise", start: 0.8, end: 1.2 },
  { word: "is", start: 1.2, end: 1.35 },
  { word: "gone.", start: 1.6, end: 2.0 },
  { word: "um", start: 2.6, end: 2.8 },
  { word: "You", start: 3.1, end: 3.3 },
  { word: "raised", start: 3.3, end: 3.7 },
  { word: "your", start: 3.7, end: 3.85 },
  { word: "baseline.", start: 3.85, end: 4.5 },
];

describe("natural pauses", () => {
  it("speaks sentence by sentence with a pause between, and honours [pause] beats", () => {
    expect(splitForSpeech("So flip it. Invest half of every raise.", 0.3)).toEqual([
      { text: "So flip it.", pauseAfter: 0.3 },
      { text: "Invest half of every raise.", pauseAfter: 0 },
    ]);
    expect(splitForSpeech("It costs $6.50 a day. That's it.")).toHaveLength(2); // "$6.50" is not a sentence end
    const beats = splitForSpeech("Your raise [pause 0.6] is already gone.", 0.3);
    expect(beats).toEqual([
      { text: "Your raise", pauseAfter: 0.6 },
      { text: "is already gone.", pauseAfter: 0 },
    ]);
    expect(stripPauseMarkers("Gone [pause]. Really [pause 1.2] gone.")).toBe("Gone . Really gone.");
    expect(NarrationSchema.safeParse({ engine: "KOKORO", voice: "af_heart", sentencePause: 0.4 }).success).toBe(true);
  });
});

describe("voices", () => {
  it("offers a curated list of real Kokoro English voices, each with a playable sample", () => {
    expect(NARRATION_VOICES.length).toBeGreaterThanOrEqual(6);
    expect(NARRATION_VOICES.length).toBeLessThanOrEqual(10);
    const ids = new Set(KOKORO_ENGLISH_VOICES.map((v) => v.id));
    expect(KOKORO_ENGLISH_VOICES).toHaveLength(28);
    for (const v of NARRATION_VOICES) {
      expect(ids.has(v.id), v.id).toBe(true);
      expect(v.vibe.length).toBeGreaterThan(20);
      expect(v.suggestedSpeed).toBeGreaterThanOrEqual(0.7);
      expect(existsSync(resolve(__dirname, "../../../..", v.sample)), v.sample).toBe(true);
    }
    expect(new Set(NARRATION_VOICES.map((v) => v.gender)).size).toBe(2);
    expect(new Set(NARRATION_VOICES.map((v) => v.accent)).size).toBe(2);
    expect(NARRATION_VOICES[0]!.id).toBe(DEFAULT_NARRATION_VOICE);
  });
});

describe("Chris's own voice: aligning a recording to the script", () => {
  it("tolerates ad-libs and dropped words, reports them, and times each shot from the real recording", () => {
    const { shots, report } = alignRecordingWords(film, heard, 5);
    expect(report.ok).toBe(true);
    expect(report.missedWords).toEqual([{ shotId: "one", word: "already" }]);
    expect(report.extraWords.map((e) => e.word)).toEqual(["So", "um"]);
    expect(report.matchedRatio).toBeCloseTo(8 / 9, 2);
    expect(report.problems.join(" ")).toMatch(/already/);
    const [one, two] = shots;
    expect(one!.start).toBeCloseTo(0.48, 2); // 0.12 s of air before "your"
    expect(two!.start).toBeGreaterThanOrEqual(one!.end); // clips never overlap
    expect(two!.words.map((w) => w.word)).toEqual(["You", "raised", "your", "baseline."]);
    expect(two!.words[1]!.start).toBeCloseTo(3.3 - two!.start, 3); // clip-relative
    // the missed word is interpolated inside its neighbours
    const already = one!.words[3]!;
    expect(already.start).toBeGreaterThan(one!.words[2]!.start);
    expect(already.end).toBeLessThanOrEqual(one!.words[4]!.start + 1e-9);
    // drives timing like synthesized narration
    const clips = Object.fromEntries(shots.map((s) => [s.shotId, { durationSeconds: s.end - s.start, words: s.words }]));
    const rf = resolveFilm(film, clips);
    expect(rf.measured).toBe(true);
    expect(rf.shots[1]!.words[1]!.raw).toBe("raised");
  });

  it("refuses the wrong take", () => {
    const { report } = alignRecordingWords(film, [{ word: "completely", start: 0, end: 1 }, { word: "different", start: 1, end: 2 }], 3);
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toMatch(/right take/);
  });

  it("cuts one clip per shot out of an uploaded recording (any format)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cinema-rec-"));
    try {
      const rec = join(dir, "take.m4a");
      await runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=5", "-c:a", "aac", rec]);
      const r = await narrationFromRecording({ film, recordingPath: rec, outDir: dir, transcriber: { transcribe: async () => ({ text: "", words: heard }) } });
      expect(r.report.ok).toBe(true);
      expect(Object.keys(r.lines)).toEqual(["one", "two"]);
      const d = await probeDurationSeconds(r.lines.two!.path);
      expect(Math.abs(d - r.lines.two!.durationSeconds)).toBeLessThan(0.05);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
