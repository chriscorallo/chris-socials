import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFMPEG_PATH } from "../ffmpeg-paths";
import { probeMedia } from "../probe";
import { renderVideo, sanitizeDrawtextValue, RenderSegmentOutOfBoundsError } from "../render";
import { runTechnicalQC } from "../technical-qc";

/**
 * Real integration tests against real ffmpeg/ffprobe binaries (ffmpeg-static/ffprobe-static
 * — see /docs/DECISIONS.md) — no mocking, since the whole point of Phase 3's acceptance
 * criterion is proving the renderer actually renders. The fixture video is synthesized by
 * ffmpeg itself (a color pattern + tone), so no real Chris footage is needed to prove this.
 *
 * Font: a macOS system font, dev/test-only — see /docs/DECISIONS.md ("Phase 3 renderer").
 * A real bundled/licensed brand font is deferred pending the BrandAsset asset library.
 */
const DEV_FONT_PATH = "/System/Library/Fonts/Supplemental/Arial.ttf";

function runFfmpegRaw(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args);
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-1000)))));
  });
}

describe("render pipeline (real ffmpeg/ffprobe — no mocking)", () => {
  let workDir: string;
  let fixturePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "chris-media-test-"));
    fixturePath = join(workDir, "fixture.mp4");

    // A synthetic 6-second, 640x480, 4:3 test pattern with a 1kHz tone — stands in for a
    // raw take without needing any real footage.
    await runFfmpegRaw([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x480:duration=6:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:duration=6",
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
    "probeMedia reports accurate technical metadata for the fixture",
    async () => {
      const result = await probeMedia(fixturePath);
      expect(result.hasVideo).toBe(true);
      expect(result.hasAudio).toBe(true);
      expect(result.width).toBe(640);
      expect(result.height).toBe(480);
      expect(result.videoCodec).toBe("h264");
      expect(result.audioCodec).toBe("aac");
      expect(result.durationSeconds).toBeGreaterThan(5.5);
      expect(result.durationSeconds).toBeLessThan(6.5);
    },
    15000,
  );

  it(
    "renders a single trimmed segment, cropped to a 9:16 target, with a text overlay, and passes technical QC",
    async () => {
      const outputPath = join(workDir, "render-single.mp4");

      const result = await renderVideo({
        sourcePath: fixturePath,
        outputPath,
        segments: [{ startSeconds: 1, endSeconds: 4 }],
        targetDimensions: { width: 1080, height: 1920 },
        textOverlays: [
          {
            text: "Don't ignore this — it's the hook",
            startSeconds: 0,
            endSeconds: 3,
            position: "BOTTOM",
          },
        ],
        normalizeAudio: true,
        fontPath: DEV_FONT_PATH,
      });

      expect(result.width).toBe(1080);
      expect(result.height).toBe(1920);
      expect(result.durationSeconds).toBeGreaterThan(2.5);
      expect(result.durationSeconds).toBeLessThan(3.5);

      const qc = await runTechnicalQC(outputPath, {
        targetWidth: 1080,
        targetHeight: 1920,
        minDurationSeconds: 2.5,
        maxDurationSeconds: 3.5,
        requiredVideoCodec: "h264",
        requiredAudioCodec: "aac",
      });

      expect(qc.overall).toBe("PASS");
      expect(qc.checks.every((c) => c.passed)).toBe(true);
    },
    30000,
  );

  it(
    "renders multiple non-contiguous segments concatenated as hard cuts",
    async () => {
      const outputPath = join(workDir, "render-multi.mp4");

      const result = await renderVideo({
        sourcePath: fixturePath,
        outputPath,
        segments: [
          { startSeconds: 0, endSeconds: 1 },
          { startSeconds: 3, endSeconds: 4.5 },
        ],
        targetDimensions: null,
        textOverlays: [],
        normalizeAudio: false,
        fontPath: DEV_FONT_PATH,
      });

      // 1s + 1.5s = 2.5s total, concatenated.
      expect(result.durationSeconds).toBeGreaterThan(2.2);
      expect(result.durationSeconds).toBeLessThan(2.8);
    },
    30000,
  );

  it(
    "technical QC fails (not silently averages away) when dimensions don't match",
    async () => {
      const outputPath = join(workDir, "render-wrong-dims.mp4");
      await renderVideo({
        sourcePath: fixturePath,
        outputPath,
        segments: [{ startSeconds: 0, endSeconds: 1 }],
        targetDimensions: { width: 640, height: 480 },
        textOverlays: [],
        normalizeAudio: false,
        fontPath: DEV_FONT_PATH,
      });

      const qc = await runTechnicalQC(outputPath, {
        targetWidth: 1080,
        targetHeight: 1920,
      });

      expect(qc.overall).toBe("FAIL");
      const dimCheck = qc.checks.find((c) => c.name === "dimensions");
      expect(dimCheck?.passed).toBe(false);
    },
    30000,
  );

  it("rejects an empty segments array before touching ffmpeg", async () => {
    await expect(
      renderVideo({
        sourcePath: fixturePath,
        outputPath: join(workDir, "should-not-exist.mp4"),
        segments: [],
        targetDimensions: null,
        textOverlays: [],
        normalizeAudio: false,
        fontPath: DEV_FONT_PATH,
      }),
    ).rejects.toThrow();
  });

  it(
    "rejects a segment ending past the source's actual duration, rather than silently " +
      "producing a shorter clip (ffmpeg's own trim filter clamps instead of erroring — " +
      "found via an integration test that expected a failure and got a truncated success)",
    async () => {
      await expect(
        renderVideo({
          sourcePath: fixturePath,
          outputPath: join(workDir, "should-not-exist-2.mp4"),
          segments: [{ startSeconds: 0, endSeconds: 9999 }],
          targetDimensions: null,
          textOverlays: [],
          normalizeAudio: false,
          fontPath: DEV_FONT_PATH,
        }),
      ).rejects.toBeInstanceOf(RenderSegmentOutOfBoundsError);
    },
    15000,
  );
});

describe("sanitizeDrawtextValue", () => {
  it("replaces structurally-significant characters rather than attempting fragile escaping", () => {
    expect(sanitizeDrawtextValue("Don't")).toBe("Don’t");
    expect(sanitizeDrawtextValue("a:b")).toBe("a–b");
    expect(sanitizeDrawtextValue("a[b];c,d")).toBe("abcd");
    expect(sanitizeDrawtextValue("back\\slash")).toBe("backslash");
  });

  it("bounds length so a runaway headline can't blow up the ffmpeg command", () => {
    const long = "x".repeat(500);
    expect(sanitizeDrawtextValue(long).length).toBe(200);
  });
});
