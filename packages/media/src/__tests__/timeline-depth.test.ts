import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderTimeline } from "../timeline-render";
import { EditTimelineSchema, type EditTimelineInput } from "../timeline";
import { mapSourcePointToCanvas, matteDimensionsFor } from "../visual-interaction";
import { cropGeometry, zoomStateAt } from "../timeline-layout";
import { countRgb, grabRgbRegion, runFfmpegRaw } from "./ffmpeg-test-helpers";

/**
 * Real-ffmpeg depth compositing: a synthetic "person" (a red rectangle on a grey wall) with a
 * synthetic matte at HALF the source resolution (exactly like computePersonMatte's output).
 * A green bar across the frame is overlaid BEHIND_SUBJECT: it must be hidden inside the person
 * and visible outside; as FRONT it covers the person too. Then the same with a crop zoom/pan
 * and an output punch-in — the matte must follow the footage exactly (edges ±12 px).
 */
describe("depth compositing (real ffmpeg)", () => {
  let dir: string;
  let take: string;
  let matte: string;
  let bar: string;
  // Person in SOURCE fractions (540x960 source).
  const person = { x0: 0.25, x1: 0.75, y0: 0.25, y1: 1 };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-depth-"));
    take = join(dir, "take.mp4");
    matte = join(dir, "matte.mp4");
    bar = join(dir, "bar.mov");
    const S = { w: 540, h: 960 };
    await runFfmpegRaw([
      "-y", "-f", "lavfi", "-i", `color=c=0x707070:s=${S.w}x${S.h}:r=30:d=4`,
      "-vf", `drawbox=x=${S.w * person.x0}:y=${S.h * person.y0}:w=${S.w * (person.x1 - person.x0)}:h=${S.h * (person.y1 - person.y0)}:color=0xD02020:t=fill`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", take,
    ]);
    const M = matteDimensionsFor({ width: S.w, height: S.h }, 480);
    expect(M).toEqual({ width: 270, height: 480 });
    await runFfmpegRaw([
      "-y", "-f", "lavfi", "-i", `color=c=black:s=${M.width}x${M.height}:r=30:d=4`,
      "-vf", `drawbox=x=${M.width * person.x0}:y=${M.height * person.y0}:w=${M.width * (person.x1 - person.x0)}:h=${M.height * (person.y1 - person.y0)}:color=white:t=fill,format=yuv420p`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_range", "tv", matte,
    ]);
    // Opaque green bar y 700..900 across the whole canvas, 4 s.
    await runFfmpegRaw([
      "-y", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=30:d=4,format=rgba,geq=r=0:g=230:b=0:a='255*between(Y,700,899)'",
      "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", bar,
    ]);
  }, 60000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const tl = (extra: Partial<EditTimelineInput> = {}): EditTimelineInput => ({
    version: 2,
    clips: [{ id: "c1", mediaAssetId: "A", sourceStart: 0, sourceEnd: 3 }],
    captions: { enabled: false, fontId: "inter-display-bold", fontSize: 60, color: "#FFFFFF", highlightColor: "#FFD54A" },
    ...extra,
  });
  const green = (r: number, g: number, b: number) => g > 170 && r < 90 && b < 90;
  const red = (r: number, g: number, b: number) => r > 150 && g < 80 && b < 80;
  const frac = (buf: Buffer, p: (r: number, g: number, b: number) => boolean) => countRgb(buf, p) / (buf.length / 3);

  it("BEHIND_SUBJECT is occluded inside the person and visible outside; FRONT is not occluded", async () => {
    const outB = join(dir, "behind.mp4");
    const res = await renderTimeline({
      timeline: tl(),
      sources: { A: take },
      sourceWords: {},
      outputPath: outB,
      encode: { preset: "ultrafast", crf: 18 },
      visualsLayer: { segments: [{ path: bar, start: 0.5, end: 2.5, id: "bar", depth: "BEHIND_SUBJECT" }] },
      mattes: { A: matte },
    });
    expect(res.warnings.filter((w) => !/no audio track/.test(w))).toEqual([]);
    expect(res.motion.behindSubject).toBe(1);
    expect(res.motion.mattedClips).toBe(1);
    // Person spans canvas x 270..810 (source ×2). Inside the person on the bar's rows: red.
    expect(frac(await grabRgbRegion(outB, 1.5, { x: 360, y: 740, width: 360, height: 120 }), red)).toBeGreaterThan(0.97);
    // Outside the person on the bar's rows: green.
    expect(frac(await grabRgbRegion(outB, 1.5, { x: 40, y: 740, width: 180, height: 120 }), green)).toBeGreaterThan(0.97);
    expect(frac(await grabRgbRegion(outB, 1.5, { x: 860, y: 740, width: 180, height: 120 }), green)).toBeGreaterThan(0.97);
    // Before the window: no green anywhere on those rows.
    expect(frac(await grabRgbRegion(outB, 0.2, { x: 40, y: 740, width: 1000, height: 120 }), green)).toBe(0);

    const outF = join(dir, "front.mp4");
    await renderTimeline({
      timeline: tl(),
      sources: { A: take },
      sourceWords: {},
      outputPath: outF,
      encode: { preset: "ultrafast", crf: 18 },
      visualsLayer: { segments: [{ path: bar, start: 0.5, end: 2.5, id: "bar", depth: "FRONT" }] },
      mattes: { A: matte },
    });
    expect(frac(await grabRgbRegion(outF, 1.5, { x: 360, y: 740, width: 360, height: 120 }), green)).toBeGreaterThan(0.97);
  }, 120000);

  it("no matte for the take → behind renders in front, with a warning", async () => {
    const out = join(dir, "nomatte.mp4");
    const res = await renderTimeline({
      timeline: tl(),
      sources: { A: take },
      sourceWords: {},
      outputPath: out,
      encode: { preset: "ultrafast", crf: 28 },
      visualsLayer: { segments: [{ path: bar, start: 0.5, end: 2.5, id: "bar", depth: "BEHIND_SUBJECT" }] },
    });
    expect(res.warnings.join(" ")).toMatch(/behind-subject needs a person matte/);
    expect(res.motion.behindSubject).toBe(0);
    expect(frac(await grabRgbRegion(out, 1.5, { x: 360, y: 740, width: 360, height: 120 }), green)).toBeGreaterThan(0.97);
  }, 120000);

  it("the matte follows the clip's crop zoom/pan and the output punch-in exactly", async () => {
    const out = join(dir, "zoomed.mp4");
    const crop = { zoom: 1.3, panX: 0.6, panY: -0.2 };
    const zoom = { id: "z1", start: 1.0, end: 2.5, zoom: 1.25, mode: "CUT" as const, easeSeconds: 0, x: 0.4, y: 0.45 };
    const timeline = tl({ clips: [{ id: "c1", mediaAssetId: "A", sourceStart: 0.2, sourceEnd: 3, crop }], zooms: [zoom] });
    await renderTimeline({
      timeline,
      sources: { A: take },
      sourceWords: {},
      outputPath: out,
      encode: { preset: "ultrafast", crf: 18 },
      visualsLayer: { segments: [{ path: bar, start: 0.5, end: 2.5, id: "bar", depth: "BEHIND_SUBJECT" }] },
      mattes: { A: matte },
    });
    const parsed = EditTimelineSchema.parse(timeline);
    const canvas = parsed.canvas;
    const src = { width: 540, height: 960 };
    expect(cropGeometry(src, canvas, crop).scale).toBeGreaterThan(1);
    for (const t of [0.8, 1.8]) {
      const z = zoomStateAt(parsed.zooms, t);
      const left = mapSourcePointToCanvas({ x: person.x0, y: 0.5 }, src, canvas, crop, z).x;
      const right = mapSourcePointToCanvas({ x: person.x1, y: 0.5 }, src, canvas, crop, z).x;
      const row = { y: 760, height: 80 };
      // Just inside each person edge → red (bar hidden); just outside → green.
      if (left > 30) {
        expect(frac(await grabRgbRegion(out, t, { x: left + 12, ...row, width: 16 }), red)).toBeGreaterThan(0.9);
        expect(frac(await grabRgbRegion(out, t, { x: left - 28, ...row, width: 16 }), green)).toBeGreaterThan(0.9);
      }
      if (right < canvas.width - 30) {
        expect(frac(await grabRgbRegion(out, t, { x: right - 28, ...row, width: 16 }), red)).toBeGreaterThan(0.9);
        expect(frac(await grabRgbRegion(out, t, { x: right + 12, ...row, width: 16 }), green)).toBeGreaterThan(0.9);
      }
    }
  }, 120000);
});
