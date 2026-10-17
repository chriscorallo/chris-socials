import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeMedia } from "../probe";
import { renderTimeline } from "../timeline-render";
import { easeInOutCubic } from "../timeline-layout";
import { RenderSegmentOutOfBoundsError } from "../render";
import type { EditTimelineInput } from "../timeline";
import { runFfmpegRaw, grabRgbRegion, countRgb, meanRgb } from "./ffmpeg-test-helpers";

/**
 * Real ffmpeg renders of EditTimelines — no mocking. Two synthetic takes with different
 * resolutions / frame rates (one without audio), crop pans, a CUT and an EASE zoom, a grade
 * preset, two texts in different registered fonts/colours/plates, and every caption preset.
 */
describe("renderTimeline (real ffmpeg)", () => {
  let dir: string;
  let takeA: string; // 1280x720 @30, left half red / right half blue, with audio
  let takeB: string; // 720x1280 @25, neutral gray + one white vertical stripe, NO audio

  const wordsA = [
    { word: "red", start: 0.3, end: 0.7 },
    { word: "side", start: 0.8, end: 1.4 },
    { word: "blue", start: 2.3, end: 2.8 },
    { word: "side.", start: 2.9, end: 3.5 },
  ];
  const wordsB = [
    { word: "gray", start: 1.2, end: 1.6 },
    { word: "take", start: 1.7, end: 2.2 },
    { word: "here.", start: 2.3, end: 2.9 },
  ];
  const isGreen = (r: number, g: number, b: number) => g > 180 && r < 120 && b < 120;
  const isWhite = (r: number, g: number, b: number) => r > 220 && g > 220 && b > 220;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-timeline-test-"));
    takeA = join(dir, "takeA.mp4");
    takeB = join(dir, "takeB.mp4");
    await runFfmpegRaw([
      "-y", "-f", "lavfi", "-i", "color=c=0xFF0000:s=640x720:r=30:d=6",
      "-f", "lavfi", "-i", "color=c=0x0000FF:s=640x720:r=30:d=6",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-filter_complex", "[0:v][1:v]hstack[v]", "-map", "[v]", "-map", "2:a",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", takeA,
    ]);
    await runFfmpegRaw([
      "-y", "-f", "lavfi", "-i", "color=c=0x808080:s=720x1280:r=25:d=5",
      "-vf", "drawbox=x=480:y=0:w=8:h=1280:color=white:t=fill",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", takeB,
    ]);
  }, 60000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const baseTimeline = (preset: "CLEAN" | "BOLD_HIGHLIGHT" | "BOXED" | "KARAOKE"): EditTimelineInput => ({
    version: 2,
    clips: [
      { id: "c1", mediaAssetId: "A", sourceStart: 0, sourceEnd: 2, crop: { zoom: 1, panX: -1, panY: 0 } },
      { id: "c2", mediaAssetId: "A", sourceStart: 2, sourceEnd: 4, crop: { zoom: 1, panX: 1, panY: 0 } },
      { id: "c3", mediaAssetId: "B", sourceStart: 1, sourceEnd: 4 },
    ],
    texts: [
      { id: "t1", text: "Three rules nobody tells you", start: 0, end: 7, fontId: "montserrat-black", fontSize: 72, color: "#FF00FF", backgroundColor: "#000000CC", y: 0.18, uppercase: true },
      { id: "t2", text: "73%", start: 4, end: 7, fontId: "anton", fontSize: 160, color: "#00FFFF", strokeColor: "#000000", y: 0.42 },
    ],
    captions: { enabled: true, preset, fontId: "poppins-extrabold", fontSize: 70, color: "#FFFFFF", highlightColor: "#00FF00", strokeColor: preset === "BOXED" ? null : "#000000", y: 0.75 },
    zooms: [
      { id: "cut", start: 4.5, end: 5.5, zoom: 2, mode: "CUT", x: 0.5, y: 0.5 },
      { id: "ease", start: 5.6, end: 6.95, zoom: 1.5, mode: "EASE", easeSeconds: 1, x: 0.5, y: 0.5 },
    ],
    grade: { preset: "WARM" },
    audio: { normalize: true },
  });

  let main: Awaited<ReturnType<typeof renderTimeline>>;
  let mainPath: string;

  it(
    "renders a 2-take timeline (mixed size/fps, one silent take) at 1080x1920 with exact duration and no ffmpeg warnings",
    async () => {
      mainPath = join(dir, "main.mp4");
      main = await renderTimeline({
        timeline: baseTimeline("BOLD_HIGHLIGHT"),
        sources: { A: takeA, B: takeB },
        sourceWords: { A: wordsA, B: wordsB },
        outputPath: mainPath,
        encode: { preset: "veryfast", crf: 18 },
      });
      expect(main.width).toBe(1080);
      expect(main.height).toBe(1920);
      expect(main.fps).toBe(30);
      expect(Math.abs(main.durationSeconds - 7)).toBeLessThan(0.06);
      expect(main.ffmpegWarnings).toEqual([]);
      expect(main.warnings).toEqual(["clip 3 (c3): source has no audio track — silence used."]);
      expect(main.captionCount).toBeGreaterThanOrEqual(3);
      const probe = await probeMedia(mainPath);
      expect(probe.hasAudio).toBe(true);
      expect(probe.videoCodec).toBe("h264");
      expect(probe.audioCodec).toBe("aac");
    },
    180000,
  );

  it("crop pan: pan -1 shows the take's left (red) edge, pan +1 its right (blue) edge", async () => {
    const mid = { x: 440, y: 1100, width: 200, height: 100 };
    const left = meanRgb(await grabRgbRegion(mainPath, 1.0, mid));
    const right = meanRgb(await grabRgbRegion(mainPath, 3.0, mid));
    expect(left.r).toBeGreaterThan(180);
    expect(left.b).toBeLessThan(60);
    expect(right.b).toBeGreaterThan(180);
    expect(right.r).toBeLessThan(60);
  }, 30000);

  it("grade: WARM shifts a neutral gray take toward red/orange, vignette darkens the corners", async () => {
    const centre = meanRgb(await grabRgbRegion(mainPath, 4.2, { x: 200, y: 1000, width: 200, height: 120 }));
    expect(centre.r - centre.b).toBeGreaterThan(6);
    const corner = meanRgb(await grabRgbRegion(mainPath, 4.2, { x: 0, y: 1800, width: 80, height: 80 }));
    expect(corner.r + corner.g + corner.b).toBeLessThan(centre.r + centre.g + centre.b - 10);
  }, 30000);

  it("texts: each lands in its laid-out rect in its own colour (magenta plate text, cyan stroked number)", async () => {
    const [t1, t2] = main.textLayouts;
    const magenta = await grabRgbRegion(mainPath, 1.0, t1!.rect);
    expect(countRgb(magenta, (r, g, b) => r > 200 && b > 200 && g < 80)).toBeGreaterThan(500);
    // The plate is dark (#000000CC over red) — the red take barely shows through.
    expect(countRgb(magenta, (r, g, b) => r < 70 && g < 40 && b < 40)).toBeGreaterThan(t1!.rect.width * t1!.rect.height * 0.4);
    const cyan = await grabRgbRegion(mainPath, 4.2, t2!.rect);
    expect(countRgb(cyan, (r, g, b) => g > 200 && b > 200 && r < 80)).toBeGreaterThan(2000);
    expect(countRgb(cyan, (r, g, b) => r + g + b < 90)).toBeGreaterThan(300); // stroke
    // Not visible before its start.
    const before = await grabRgbRegion(mainPath, 3.0, t2!.rect);
    expect(countRgb(before, (r, g, b) => g > 200 && b > 200 && r < 80)).toBe(0);
  }, 30000);

  it("captions: BOLD_HIGHLIGHT lights the spoken word (take B words, shifted onto clip 3's output time)", async () => {
    const chunk = main.captionLayouts.find((c) => c.chunk.words[0]!.key === "B:0")!;
    expect(chunk.chunk.start).toBeCloseTo(4.2, 3);
    const rect = chunk.layout.rect;
    const during = await grabRgbRegion(mainPath, 4.4, rect);
    expect(countRgb(during, isGreen)).toBeGreaterThan(200);
    expect(countRgb(during, isWhite)).toBeGreaterThan(200);
    const before = await grabRgbRegion(mainPath, 4.1, rect);
    expect(countRgb(before, isGreen)).toBe(0);
  }, 30000);

  it("zooms: CUT starts on its exact frame; EASE follows the eased curve frame by frame with no jitter", async () => {
    // Stripe at source x 480..488 -> canvas 720..732 (cover scale 1.5), centre ~726.
    const row = { x: 0, y: 958, width: 1080, height: 4 };
    const centroid = async (frame: number) => {
      const buf = await grabRgbRegion(mainPath, { frame }, row);
      let sum = 0;
      let wsum = 0;
      for (let i = 0; i < buf.length; i += 3) {
        const x = (i / 3) % 1080;
        const lum = (buf[i]! + buf[i + 1]! + buf[i + 2]!) / 3;
        const w = Math.max(0, lum - 190);
        sum += w * x;
        wsum += w;
      }
      return wsum > 0 ? sum / wsum : NaN;
    };
    const base = await centroid(130);
    expect(Math.abs(base - 726)).toBeLessThan(2.5);
    expect(Math.abs((await centroid(134)) - base)).toBeLessThan(1); // last unzoomed frame
    expect(Math.abs((await centroid(135)) - (540 + (base - 540) * 2))).toBeLessThan(3); // first CUT frame
    expect(Math.abs((await centroid(164)) - (540 + (base - 540) * 2))).toBeLessThan(3);
    expect(Math.abs((await centroid(165)) - base)).toBeLessThan(1); // cut back at 5.5s

    const residuals: number[] = [];
    for (let f = 168; f <= 200; f += 2) {
      const z = 1 + 0.5 * easeInOutCubic((f / 30 - 5.6) / 1);
      const expected = 540 + (base - 540) * z;
      residuals.push((await centroid(f)) - expected);
    }
    for (const r of residuals) expect(Math.abs(r)).toBeLessThan(2.5);
  }, 120000);

  for (const preset of ["CLEAN", "BOXED", "KARAOKE"] as const) {
    it(
      `captions preset ${preset} renders its look`,
      async () => {
        const out = join(dir, `cap-${preset}.mp4`);
        const t = baseTimeline(preset);
        const res = await renderTimeline({
          timeline: { ...t, clips: [{ id: "c3", mediaAssetId: "B", sourceStart: 1, sourceEnd: 3.2 }], texts: [], zooms: [], grade: { preset: "NONE" } },
          sources: { B: takeB },
          sourceWords: { B: wordsB },
          outputPath: out,
          encode: { preset: "ultrafast", crf: 18 },
        });
        expect(res.ffmpegWarnings).toEqual([]);
        const chunk = res.captionLayouts[0]!;
        // B:0 "gray" at source 1.2 -> output 0.2.
        expect(chunk.chunk.start).toBeCloseTo(0.2, 3);
        const rect = chunk.layout.rect;
        if (preset === "CLEAN") {
          const px = await grabRgbRegion(out, 0.5, rect);
          expect(countRgb(px, isWhite)).toBeGreaterThan(300);
          expect(countRgb(px, isGreen)).toBe(0);
        } else if (preset === "BOXED") {
          const px = await grabRgbRegion(out, 0.5, rect);
          expect(chunk.layout.plate).not.toBeNull();
          expect(countRgb(px, (r, g, b) => r + g + b < 120)).toBeGreaterThan(rect.width * rect.height * 0.3);
          expect(countRgb(px, isWhite)).toBeGreaterThan(300);
        } else {
          // KARAOKE: early in the phrase only the first word has started filling; later more.
          const early = countRgb(await grabRgbRegion(out, 0.35, rect), isGreen);
          const late = countRgb(await grabRgbRegion(out, 1.2, rect), isGreen);
          expect(early).toBeGreaterThan(0);
          expect(late).toBeGreaterThan(early * 2);
          expect(countRgb(await grabRgbRegion(out, 0.35, rect), isWhite)).toBeGreaterThan(200);
        }
      },
      120000,
    );
  }

  it("refuses a clip past its source's end and an unknown font; clamps late texts with a warning", async () => {
    const t = baseTimeline("CLEAN");
    await expect(
      renderTimeline({
        timeline: { ...t, clips: [{ id: "x", mediaAssetId: "B", sourceStart: 0, sourceEnd: 30 }] },
        sources: { B: takeB },
        sourceWords: {},
        outputPath: join(dir, "oob.mp4"),
      }),
    ).rejects.toBeInstanceOf(RenderSegmentOutOfBoundsError);
    await expect(
      renderTimeline({
        timeline: { ...t, texts: [{ id: "x", text: "hi", start: 0, end: 1, fontId: "comic-sans", fontSize: 50, color: "#FFFFFF" }] },
        sources: { A: takeA, B: takeB },
        sourceWords: {},
        outputPath: join(dir, "font.mp4"),
      }),
    ).rejects.toThrow(/comic-sans/);
    const res = await renderTimeline({
      timeline: {
        ...t,
        clips: [{ id: "c", mediaAssetId: "B", sourceStart: 0, sourceEnd: 1 }],
        texts: [{ id: "late", text: "late", start: 0.5, end: 9, fontId: "bebas-neue", fontSize: 80, color: "#FFFFFF" }],
        zooms: [],
      },
      sources: { B: takeB },
      sourceWords: {},
      outputPath: join(dir, "clamp.mp4"),
      encode: { preset: "ultrafast" },
    });
    expect(res.warnings.some((w) => /late: end 9s clamped/.test(w))).toBe(true);
    expect(res.warnings.some((w) => /no take in this timeline has word timings/.test(w))).toBe(true);
  }, 120000);
});
