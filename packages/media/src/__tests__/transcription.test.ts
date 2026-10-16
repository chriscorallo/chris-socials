import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeWhisperChunks,
  extractAudioPcm16k,
  LocalWhisperTranscriptionProvider,
} from "../transcription";
import { runFfmpegRaw } from "./ffmpeg-test-helpers";

describe("normalizeWhisperChunks (pure)", () => {
  it("merges sub-word continuations ('50' + '%') and trims", () => {
    const words = normalizeWhisperChunks(
      [
        { text: " Save", timestamp: [3.44, 3.62] },
        { text: " 50", timestamp: [3.62, 4.0] },
        { text: "%", timestamp: [4.0, 4.02] },
        { text: " more.", timestamp: [4.44, null] },
      ],
      5,
    );
    expect(words).toEqual([
      { word: "Save", start: 3.44, end: 3.62 },
      { word: "50%", start: 3.62, end: 4.02 },
      { word: "more.", start: 4.44, end: 4.74 },
    ]);
  });
});

describe("extractAudioPcm16k", () => {
  it("decodes to 16 kHz mono float32", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chris-pcm-"));
    try {
      const f = join(dir, "tone.wav");
      await runFfmpegRaw(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=44100", f]);
      const pcm = await extractAudioPcm16k(f);
      expect(pcm.length).toBeGreaterThan(31000);
      expect(pcm.length).toBeLessThan(33000);
      expect(Math.max(...pcm.slice(0, 2000))).toBeGreaterThan(0.01);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Loads the real Whisper model (downloads ~300 MB on first run) and transcribes real speech
 * synthesized with macOS `say`. Off by default so `pnpm test` stays fast and offline:
 * RUN_WHISPER_TESTS=1 pnpm vitest run packages/media/src/__tests__/transcription.test.ts
 */
const runWhisper = process.env.RUN_WHISPER_TESTS === "1" && process.platform === "darwin";

describe.skipIf(!runWhisper)("LocalWhisperTranscriptionProvider (real model)", () => {
  it(
    "returns plausible word timings for real speech, including a >30 s chunked take",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "chris-whisper-"));
      try {
        const sentence =
          "Most people think a credit score is a grade. It is not. Save fifty percent more by paying your card twice a month.";
        const aiff = join(dir, "speech.aiff");
        execFileSync("say", ["-o", aiff, `${sentence} [[slnc 1500]] ${sentence} [[slnc 1500]] ${sentence} [[slnc 1500]] ${sentence}`]);
        const mp4 = join(dir, "speech.m4a");
        await runFfmpegRaw(["-y", "-i", aiff, "-c:a", "aac", mp4]);

        const provider = new LocalWhisperTranscriptionProvider();
        const result = await provider.transcribe(mp4);

        expect(result.durationSeconds).toBeGreaterThan(30);
        expect(result.text.toLowerCase()).toContain("credit score");
        expect(result.words.length).toBeGreaterThan(70);
        // Monotonic, inside the audio, plausible per-word durations.
        for (let i = 0; i < result.words.length; i++) {
          const w = result.words[i]!;
          expect(w.end).toBeGreaterThanOrEqual(w.start);
          expect(w.end).toBeLessThanOrEqual(result.durationSeconds + 0.5);
          if (i > 0) expect(w.start).toBeGreaterThanOrEqual(result.words[i - 1]!.start - 0.05);
        }
        // Words from the last repetition land in the last ~quarter of the audio (chunk merge).
        const lastMonth = [...result.words].reverse().find((w) => /month/i.test(w.word));
        expect(lastMonth!.start).toBeGreaterThan(result.durationSeconds * 0.7);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    600000,
  );
});
