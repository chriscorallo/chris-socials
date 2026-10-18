import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { measureViewerAudio } from "../viewer-audio";
import { extractScaledFrames, jpegSize } from "../frame-extractor";
import { FFMPEG_PATH } from "../ffmpeg-paths";

const run = promisify(execFile);
const SR = 16000;

/** Mono PCM: `level` (linear amplitude) per second. */
function pcmOf(levels: number[]): Float32Array {
  const pcm = new Float32Array(levels.length * SR);
  levels.forEach((a, s) => {
    for (let i = 0; i < SR; i++) pcm[s * SR + i] = a * Math.sin((2 * Math.PI * 220 * i) / SR);
  });
  return pcm;
}

describe("measureViewerAudio (pure)", () => {
  const talk = Array.from({ length: 6 }, (_, s) => ({ start: s + 0.05, end: s + 0.95 }));

  it("reports per-second level and a ≥ 6 dB jump while talking", () => {
    const m = measureViewerAudio(pcmOf([0.3, 0.3, 0.3, 0.08, 0.08, 0.08]), SR, { words: talk, cutTimes: [], durationS: 6 });
    expect(m.levelPerSecond).toHaveLength(6);
    expect(m.levelJumps).toHaveLength(1);
    expect(m.levelJumps[0]!.t).toBe(3);
    expect(m.levelJumps[0]!.fromDb - m.levelJumps[0]!.toDb).toBeGreaterThan(10);
  });

  it("ignores level changes when nobody is talking", () => {
    const m = measureViewerAudio(pcmOf([0.3, 0.3, 0.3, 0.05, 0.05, 0.05]), SR, { words: talk.slice(0, 2), cutTimes: [], durationS: 6 });
    expect(m.levelJumps).toEqual([]);
  });

  it("flags a level change across a cut with speech on both sides, not a steady one", () => {
    const pcm = pcmOf([0.3, 0.3, 0.06, 0.06]);
    const words = [{ start: 0, end: 4 }];
    const m = measureViewerAudio(pcm, SR, { words, cutTimes: [2, 1], durationS: 4 });
    expect(m.cutJumps).toHaveLength(1);
    expect(m.cutJumps[0]!.t).toBe(2);
    expect(m.cutJumps[0]!.deltaDb).toBeLessThan(-6);
  });
});

describe("extractScaledFrames (real ffmpeg)", () => {
  let dir: string;
  let clip: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-vframes-test-"));
    clip = join(dir, "c.mp4");
    await run(FFMPEG_PATH, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip]);
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns downscaled JPEGs (long edge 640, 9:16 kept) and skips times past the end", async () => {
    const frames = await extractScaledFrames(clip, [0, 1.5, 2.9, 9]);
    expect(frames.map((f) => f.atSeconds)).toEqual([0, 1.5, 2.9]);
    for (const f of frames) {
      expect(f.mediaType).toBe("image/jpeg");
      expect({ w: f.width, h: f.height }).toEqual({ w: 360, h: 640 });
      expect(jpegSize(Buffer.from(f.base64, "base64"))).toEqual({ width: 360, height: 640 });
      // ≈ 308 image tokens each instead of ≈ 2 765 for the full-HD frame.
      expect(f.base64.length).toBeLessThan(200_000);
    }
  }, 60_000);

  it("jpegSize rejects non-JPEG bytes", () => {
    expect(jpegSize(Buffer.from("not a jpeg"))).toBeNull();
  });
});
