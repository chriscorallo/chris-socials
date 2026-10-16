import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeMedia } from "../probe";
import { renderVideo, RenderSegmentOutOfBoundsError, RenderFontNotFoundError } from "../render";
import { runTechnicalQC } from "../technical-qc";
import { getSafeArea, rectInsideSafeArea } from "../safe-zones";
import { runFfmpegRaw, grabGrayRegion, countAbove, meanAbsDiff } from "./ffmpeg-test-helpers";

/**
 * Real integration tests against real ffmpeg/ffprobe binaries (ffmpeg-static/ffprobe-static
 * — see /docs/DECISIONS.md) — no mocking, since the whole point is proving the renderer
 * actually renders. Fixtures are synthesized by ffmpeg itself. Fonts: the bundled Inter TTFs
 * (packages/media/assets/fonts) — no system font dependency.
 */
describe("render pipeline (real ffmpeg/ffprobe — no mocking)", () => {
  let workDir: string;
  let fixturePath: string;
  let darkFixturePath: string;
  let gridFixturePath: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "chris-media-test-"));
    fixturePath = join(workDir, "fixture.mp4");
    darkFixturePath = join(workDir, "dark.mp4");
    gridFixturePath = join(workDir, "grid.mp4");

    // A synthetic 6-second, 640x480, 4:3 test pattern with a 1kHz tone.
    await runFfmpegRaw([
      "-y", "-f", "lavfi", "-i", "testsrc=size=640x480:duration=6:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", fixturePath,
    ]);
    // Dark 16:9 source: any bright pixel in the output can only come from our text.
    await runFfmpegRaw([
      "-y", "-f", "lavfi", "-i", "color=c=0x101418:size=1920x1080:duration=4:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", darkFixturePath,
    ]);
    // Static high-detail grid, so a punch-in is measurable as a pixel difference.
    await runFfmpegRaw([
      "-y", "-f", "lavfi", "-i", "color=c=0x202830:size=1920x1080:duration=4:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-vf", "drawgrid=w=40:h=40:t=3:c=white@0.9",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", gridFixturePath,
    ]);
  }, 60000);

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
          { text: "Don't ignore this — it's the hook", startSeconds: 0, endSeconds: 3, position: "BOTTOM" },
        ],
        normalizeAudio: true,
      });

      expect(result.width).toBe(1080);
      expect(result.height).toBe(1920);
      expect(result.durationSeconds).toBeGreaterThan(2.5);
      expect(result.durationSeconds).toBeLessThan(3.5);
      expect(result.ffmpegWarnings).toEqual([]);

      const qc = await runTechnicalQC(outputPath, {
        targetWidth: 1080,
        targetHeight: 1920,
        minDurationSeconds: 2.5,
        maxDurationSeconds: 3.5,
        requiredVideoCodec: "h264",
        requiredAudioCodec: "aac",
      });

      expect(qc.overall).toBe("PASS");
      expect(qc.checks.filter((c) => (c.severity ?? "FAIL") === "FAIL").every((c) => c.passed)).toBe(true);
      // Real EBU R128 measurement, normalised toward -14 LUFS.
      expect(qc.measurements?.integratedLufs).toBeGreaterThan(-17);
      expect(qc.measurements?.integratedLufs).toBeLessThan(-11);
    },
    60000,
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
      });
      // 1s + 1.5s = 2.5s total, concatenated.
      expect(result.durationSeconds).toBeGreaterThan(2.2);
      expect(result.durationSeconds).toBeLessThan(2.8);
    },
    30000,
  );

  it(
    "REGRESSION: text with %, :, commas, quotes, apostrophes, brackets, backslash and accented " +
      "unicode renders verbatim (old inline drawtext rendered nothing for '%')",
    async () => {
      const outputPath = join(workDir, "render-punctuation.mp4");
      const text = `Save 50% more: "don't" [yes], ok; café \\ naïve`;
      const result = await renderVideo({
        sourcePath: darkFixturePath,
        outputPath,
        segments: [{ startSeconds: 0, endSeconds: 2 }],
        targetDimensions: { width: 1080, height: 1920 },
        textOverlays: [{ text, startSeconds: 0, endSeconds: 2, position: "CENTER", style: "HEADLINE" }],
        normalizeAudio: false,
      });

      expect(result.ffmpegWarnings.filter((w) => /Stray %/i.test(w))).toEqual([]);
      expect(result.ffmpegWarnings).toEqual([]);

      const layout = result.overlayLayouts[0]!;
      // Every character survives into the laid-out lines (nothing stripped or substituted).
      expect(layout.lines.map((l) => l.text).join(" ")).toBe(text);

      // Ink check per line: the horizontal extent of white pixels on each line's band must
      // match the font-metric width of the full line text — a dropped "%", ":" or "," would
      // make the rendered line measurably narrower.
      for (const line of layout.lines) {
        const band = {
          x: 0,
          y: line.baselineY - layout.fontSize * 0.78,
          width: 1080,
          height: layout.fontSize * 0.95,
        };
        const px = await grabGrayRegion(outputPath, 1, band);
        const w = Math.round(band.width);
        const h = Math.floor(px.length / w);
        let minX = w;
        let maxX = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (px[y * w + x]! > 180) {
              minX = Math.min(minX, x);
              maxX = Math.max(maxX, x);
            }
          }
        }
        const inkWidth = maxX - minX;
        expect(inkWidth).toBeGreaterThan(line.width * 0.9);
        expect(inkWidth).toBeLessThan(line.width * 1.05);
      }
    },
    60000,
  );

  it(
    "a NUMBER_CALLOUT of just '50%' actually draws pixels (the original silent-failure case)",
    async () => {
      const outputPath = join(workDir, "render-percent.mp4");
      const result = await renderVideo({
        sourcePath: darkFixturePath,
        outputPath,
        segments: [{ startSeconds: 0, endSeconds: 2 }],
        targetDimensions: { width: 1080, height: 1920 },
        textOverlays: [{ text: "50%", startSeconds: 0, endSeconds: 2, position: "CENTER", style: "NUMBER_CALLOUT" }],
        normalizeAudio: false,
      });
      const rect = result.overlayLayouts[0]!.rect;
      const px = await grabGrayRegion(outputPath, 1, rect);
      expect(countAbove(px, 120)).toBeGreaterThan(px.length * 0.08);
    },
    60000,
  );

  it(
    "long overlays wrap and every style's block stays inside the 9:16 platform safe zones",
    async () => {
      const outputPath = join(workDir, "render-wrap.mp4");
      const long =
        "This is a deliberately long headline that would have run straight off both edges of a 1080 wide frame before wrapping existed";
      const result = await renderVideo({
        sourcePath: darkFixturePath,
        outputPath,
        segments: [{ startSeconds: 0, endSeconds: 2 }],
        targetDimensions: { width: 1080, height: 1920 },
        textOverlays: [
          { text: long, startSeconds: 0, endSeconds: 1, position: "TOP", style: "HEADLINE" },
          { text: long, startSeconds: 1, endSeconds: 2, position: "BOTTOM", style: "CAPTION" },
          { text: "1,250,000", startSeconds: 0, endSeconds: 1, position: "CENTER", style: "NUMBER_CALLOUT" },
          { text: "Chris Corallo — personal finance", startSeconds: 1, endSeconds: 2, position: "CENTER", style: "LOWER_THIRD" },
        ],
        normalizeAudio: false,
      });
      const safe = getSafeArea(1080, 1920);
      for (const o of result.overlayLayouts) {
        expect(rectInsideSafeArea(o.rect, safe)).toBe(true);
        expect(o.lines.length).toBeGreaterThanOrEqual(1);
      }
      expect(result.overlayLayouts[0]!.lines.length).toBeGreaterThan(1);
      // Distinct styles really are distinct.
      const sizes = new Set(result.overlayLayouts.map((o) => `${o.fontPath}|${o.fontSize}`));
      expect(sizes.size).toBe(4);
      // Nothing drawn in the right-hand action rail.
      const rail = await grabGrayRegion(outputPath, 0.5, { x: 1080 - 140, y: 0, width: 140, height: 1920 });
      expect(countAbove(rail, 150)).toBe(0);
    },
    60000,
  );

  it(
    "burns in word-level captions on the output timeline, in sync with the words",
    async () => {
      const outputPath = join(workDir, "render-captions.mp4");
      const result = await renderVideo({
        sourcePath: darkFixturePath,
        outputPath,
        // Cut 0.0-0.5 away: source word times shift 0.5s earlier on the output timeline.
        segments: [{ startSeconds: 0.5, endSeconds: 3.5 }],
        targetDimensions: { width: 1080, height: 1920 },
        textOverlays: [],
        normalizeAudio: false,
        captions: {
          config: { enabled: true, style: "CLEAN", position: "LOWER" },
          sourceWords: [
            { word: "Too", start: 0.1, end: 0.3 }, // in the cut region: dropped
            { word: "Hello", start: 0.7, end: 1.0 },
            { word: "world.", start: 1.0, end: 1.4 },
            { word: "Second", start: 2.4, end: 2.8 },
            { word: "phrase.", start: 2.8, end: 3.2 },
          ],
        },
      });
      const caps = result.captionLayout!;
      expect(caps.layouts.map((l) => l.chunk.text)).toEqual(["Hello world.", "Second phrase."]);
      expect(caps.layouts[0]!.chunk.start).toBeCloseTo(0.2, 2);
      const safe = getSafeArea(1080, 1920);
      for (const l of caps.layouts) expect(rectInsideSafeArea(l.rect, safe)).toBe(true);

      const rect = caps.layouts[0]!.rect;
      const during = await grabGrayRegion(outputPath, 0.5, rect);
      const between = await grabGrayRegion(outputPath, 1.5, rect);
      expect(countAbove(during, 200)).toBeGreaterThan(200);
      expect(countAbove(between, 200)).toBe(0);
      expect(result.ffmpegWarnings).toEqual([]);
    },
    60000,
  );

  it(
    "executes a punch-in (zoomed during its window, untouched outside it) and keeps 1080x1920",
    async () => {
      const base = join(workDir, "render-nopunch.mp4");
      const punched = join(workDir, "render-punch.mp4");
      const common = {
        sourcePath: gridFixturePath,
        segments: [{ startSeconds: 0, endSeconds: 3 }],
        targetDimensions: { width: 1080, height: 1920 },
        textOverlays: [],
        normalizeAudio: false,
      };
      await renderVideo({ ...common, outputPath: base });
      const result = await renderVideo({
        ...common,
        outputPath: punched,
        punchIns: [{ startSeconds: 1, endSeconds: 2, zoom: 1.25, focus: "CENTER" }],
      });
      expect(result.width).toBe(1080);
      expect(result.height).toBe(1920);
      expect(result.durationSeconds).toBeGreaterThan(2.8);
      expect(result.durationSeconds).toBeLessThan(3.2);
      const region = { x: 100, y: 300, width: 400, height: 400 };
      const inside = meanAbsDiff(
        await grabGrayRegion(base, 1.5, region),
        await grabGrayRegion(punched, 1.5, region),
      );
      const outside = meanAbsDiff(
        await grabGrayRegion(base, 0.5, region),
        await grabGrayRegion(punched, 0.5, region),
      );
      expect(inside).toBeGreaterThan(10);
      expect(outside).toBeLessThan(3);
    },
    60000,
  );

  it("reports, rather than silently drops, punch-ins it cannot execute", async () => {
    const result = await renderVideo({
      sourcePath: darkFixturePath,
      outputPath: join(workDir, "render-badpunch.mp4"),
      segments: [{ startSeconds: 0, endSeconds: 2 }],
      targetDimensions: { width: 1080, height: 1920 },
      textOverlays: [],
      normalizeAudio: false,
      punchIns: [
        { startSeconds: 0.5, endSeconds: 1.5, zoom: 1.2 },
        { startSeconds: 1.0, endSeconds: 1.8, zoom: 1.2 }, // overlaps
        { startSeconds: 5, endSeconds: 6, zoom: 1.1 }, // past the end
      ],
    });
    expect(result.unexecutedInstructions).toHaveLength(2);
  }, 60000);

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
      });
      const qc = await runTechnicalQC(outputPath, { targetWidth: 1080, targetHeight: 1920 });
      expect(qc.overall).toBe("FAIL");
      expect(qc.checks.find((c) => c.name === "dimensions")?.passed).toBe(false);
    },
    30000,
  );

  it(
    "technical QC fails silent audio on integrated loudness and an opening black stretch",
    async () => {
      const bad = join(workDir, "bad.mp4");
      await runFfmpegRaw([
        "-y",
        "-f", "lavfi",
        "-i", "color=c=black:size=640x480:rate=30:duration=1.5[a];testsrc=size=640x480:rate=30:duration=2[b];[a][b]concat=n=2:v=1:a=0",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-t", "3.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", bad,
      ]);
      const qc = await runTechnicalQC(bad);
      expect(qc.overall).toBe("FAIL");
      expect(qc.checks.find((c) => c.name === "integrated_loudness")?.passed).toBe(false);
      expect(qc.checks.find((c) => c.name === "black_frames")?.passed).toBe(false);
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
      }),
    ).rejects.toThrow();
  });

  it("refuses to render with a fontPath that doesn't exist (no silent fontconfig fallback)", async () => {
    await expect(
      renderVideo({
        sourcePath: fixturePath,
        outputPath: join(workDir, "should-not-exist-font.mp4"),
        segments: [{ startSeconds: 0, endSeconds: 1 }],
        targetDimensions: null,
        textOverlays: [{ text: "x", startSeconds: 0, endSeconds: 1, position: "TOP" }],
        normalizeAudio: false,
        fontPath: "/definitely/not/a/font.ttf",
      }),
    ).rejects.toBeInstanceOf(RenderFontNotFoundError);
  });

  it(
    "rejects a segment ending past the source's actual duration, rather than silently " +
      "producing a shorter clip (ffmpeg's own trim filter clamps instead of erroring)",
    async () => {
      await expect(
        renderVideo({
          sourcePath: fixturePath,
          outputPath: join(workDir, "should-not-exist-2.mp4"),
          segments: [{ startSeconds: 0, endSeconds: 9999 }],
          targetDimensions: null,
          textOverlays: [],
          normalizeAudio: false,
        }),
      ).rejects.toBeInstanceOf(RenderSegmentOutOfBoundsError);
    },
    15000,
  );
});
