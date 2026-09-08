import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFMPEG_PATH } from "../ffmpeg-paths";
import { extractFrames, pickSampleTimestamps, FrameExtractionError } from "../frame-extractor";

function runFfmpegRaw(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args);
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-1000)))));
  });
}

describe("pickSampleTimestamps (pure)", () => {
  it("always includes t=0 (first-frame comprehension check)", () => {
    const timestamps = pickSampleTimestamps(10, 4);
    expect(timestamps[0]).toBe(0);
  });

  it("returns the same timestamps for the same inputs — reproducible sampling", () => {
    expect(pickSampleTimestamps(8, 5)).toEqual(pickSampleTimestamps(8, 5));
  });

  it("never returns more than maxFrames timestamps", () => {
    expect(pickSampleTimestamps(60, 6).length).toBeLessThanOrEqual(6);
  });

  it("returns nothing for a non-positive duration", () => {
    expect(pickSampleTimestamps(0, 4)).toEqual([]);
    expect(pickSampleTimestamps(-1, 4)).toEqual([]);
  });
});

describe("extractFrames (real ffmpeg — no mocking)", () => {
  let workDir: string;
  let fixturePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "chris-frame-extractor-test-"));
    fixturePath = join(workDir, "fixture.mp4");
    await runFfmpegRaw([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:duration=4:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:duration=4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      fixturePath,
    ]);
  }, 30000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it(
    "extracts a real, decodable PNG per requested timestamp, in order",
    async () => {
      const frames = await extractFrames(fixturePath, [0, 1, 2]);
      expect(frames).toHaveLength(3);
      expect(frames.map((f) => f.atSeconds)).toEqual([0, 1, 2]);
      for (const frame of frames) {
        expect(frame.mediaType).toBe("image/png");
        const bytes = Buffer.from(frame.base64, "base64");
        // Real PNG signature — proves this is actual decoded image data, not an empty/error
        // file silently treated as success.
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        expect(bytes.byteLength).toBeGreaterThan(500);
      }
    },
    20000,
  );

  it("returns an empty array for an empty timestamp list without touching ffmpeg", async () => {
    expect(await extractFrames(fixturePath, [])).toEqual([]);
  });

  it(
    "a timestamp past the end of the video fails loudly rather than returning a blank/garbage frame",
    async () => {
      await expect(extractFrames(fixturePath, [999])).rejects.toBeInstanceOf(FrameExtractionError);
    },
    20000,
  );
});
