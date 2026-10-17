import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG_PATH, FFPROBE_PATH, probeMedia, renderTimeline, type TimelineVisual } from "@chris/media";
import { renderVisualsLayer, sampleVisual, sfxFiles } from "../index";
import { placementBox } from "../timing";

/**
 * REAL end-to-end: Remotion (headless Chrome, WebGL for the 3D template) renders three visuals
 * to ProRes 4444 alpha clips; renderTimeline composites them over a synthetic take with the
 * procedural SFX kit and a ducked music bed. Slow (bundle + browser): generous timeouts.
 * Set MOTION_SKIP_REAL_RENDER=1 to skip on machines without Chrome/network.
 */
const SKIP = process.env.MOTION_SKIP_REAL_RENDER === "1";

function run(bin: string, args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (c: Buffer) => out.push(c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => (code === 0 ? resolve({ stdout: Buffer.concat(out), stderr: err }) : reject(new Error(err.slice(-1500)))));
  });
}

async function rgbRegion(file: string, at: number, r: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
  const { stdout } = await run(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", `crop=${r.w}:${r.h}:${r.x}:${r.y},format=rgb24`, "-f", "rawvideo", "-"]);
  return stdout;
}
/** Fraction of pixels that differ from the flat gray background by more than `tol`. */
function changedFraction(buf: Buffer, bg: [number, number, number], tol = 24): number {
  let n = 0;
  for (let i = 0; i + 2 < buf.length; i += 3) {
    if (Math.abs(buf[i]! - bg[0]) + Math.abs(buf[i + 1]! - bg[1]) + Math.abs(buf[i + 2]! - bg[2]) > tol) n++;
  }
  return n / (buf.length / 3);
}
async function pcm(file: string, af: string): Promise<Float32Array> {
  const { stdout } = await run(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-af", `${af},aresample=16000`, "-ac", "1", "-f", "f32le", "-"]);
  return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
}
function rms(x: Float32Array, from: number, to: number): number {
  let s = 0;
  const a = Math.round(from * 16000);
  const b = Math.min(x.length, Math.round(to * 16000));
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, b - a));
}

describe.skipIf(SKIP)("renderVisualsLayer + renderTimeline (real Remotion + ffmpeg)", () => {
  let dir: string;
  let take: string;
  let music: string;
  const canvas = { width: 1080, height: 1920 };
  // Speech (a 150 Hz tone) at [0.2, 1.1) and [2.0, 2.9); visuals enter in the gaps.
  const words = [
    { word: "money", start: 0.2, end: 1.1 },
    { word: "matters", start: 2.0, end: 2.9 },
  ];
  const visuals: TimelineVisual[] = [
    sampleVisual("STAT_CARD", 1.2, 2.4, { id: "card", placement: { mode: "MANUAL", x: 0.5, y: 0.25, scale: 1 }, enterSfx: "SOFT_POP" }),
    sampleVisual("ICON_3D", 3.0, 4.4, { id: "coin", placement: { mode: "MANUAL", x: 0.5, y: 0.7, scale: 0.8 }, enterSfx: "SHIMMER" }),
    sampleVisual("NUMBER_COUNTER", 4.5, 5.6, { id: "num", placement: { mode: "MANUAL", x: 0.5, y: 0.25, scale: 1 }, enterSfx: "WHOOSH" }),
  ];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-motion-it-"));
    take = join(dir, "take.mp4");
    music = join(dir, "music.wav");
    await run(FFMPEG_PATH, [
      "-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=0x505050:s=1080x1920:r=30:d=6",
      "-f", "lavfi", "-i", "sine=frequency=150:sample_rate=48000:duration=6",
      "-filter_complex", "[1:a]volume='0.5*(between(t,0.2,1.1)+between(t,2.0,2.9))':eval=frame[a]",
      "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", take,
    ]);
    await run(FFMPEG_PATH, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=6000:sample_rate=48000:duration=10", "-ac", "2", music]);
  }, 60000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renders alpha clips and composites them only inside their windows, with SFX and ducked music", async () => {
    const t0 = Date.now();
    const layer = await renderVisualsLayer({ timeline: { visuals, canvas }, fps: 30, durationSeconds: 6, outputPath: join(dir, "layer") });
    const layerMs = Date.now() - t0;
    expect(layer.skipped).toEqual([]);
    expect(layer.segments.map((s) => s.id)).toEqual(["card", "coin", "num"]);
    expect(layer.framesRendered).toBe(36 + 42 + 33);
    // Alpha survives: ProRes 4444 with an alpha pixel format.
    const { stdout } = await run(FFPROBE_PATH, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,width,height", "-of", "json", layer.segments[1]!.path]);
    const st = JSON.parse(stdout.toString()).streams[0];
    expect(st.codec_name).toBe("prores");
    expect(st.pix_fmt).toMatch(/^yuva/);
    expect([st.width, st.height]).toEqual([1080, 1920]);

    const out = join(dir, "out.mp4");
    const t1 = Date.now();
    const res = await renderTimeline({
      timeline: {
        version: 2,
        clips: [{ id: "c", mediaAssetId: "A", sourceStart: 0, sourceEnd: 6 }],
        captions: { enabled: false, fontId: "inter-display-bold", fontSize: 60, color: "#FFFFFF", highlightColor: "#FFD54A" },
        visuals,
        audio: { normalize: true, sfxEnabled: true, music: { musicAssetId: "M", levelDb: -16, duckDb: 12, fadeInSeconds: 0, fadeOutSeconds: 0 } },
      },
      sources: { A: take },
      sourceWords: { A: words },
      outputPath: out,
      encode: { preset: "ultrafast", crf: 23 },
      visualsLayer: { segments: layer.segments },
      musicPath: music,
      sfxFiles: sfxFiles(),
    });
    const compositeMs = Date.now() - t1;
    console.log(`[motion IT] layer ${layer.framesRendered} frames in ${layerMs} ms (bundle ${layer.bundleMs} ms); composite ${compositeMs} ms`);
    expect(res.warnings).toEqual([]);
    const p = await probeMedia(out);
    expect([p.width, p.height]).toEqual([1080, 1920]);
    expect(p.durationSeconds).toBeCloseTo(6, 1);

    const bg: [number, number, number] = [0x50, 0x50, 0x50];
    const card = placementBox("STAT_CARD", visuals[0]!.placement, canvas);
    const cardRect = { x: Math.round(card.left + 40), y: Math.round(card.top + 40), w: Math.round(card.width - 80), h: Math.round(card.height - 80) };
    expect(changedFraction(await rgbRegion(out, 1.9, cardRect), bg)).toBeGreaterThan(0.5); // card on screen
    expect(changedFraction(await rgbRegion(out, 0.8, cardRect), bg)).toBeLessThan(0.01); // before
    expect(changedFraction(await rgbRegion(out, 2.7, cardRect), bg)).toBeLessThan(0.01); // between visuals

    const coin = placementBox("ICON_3D", visuals[1]!.placement, canvas);
    const coinRect = { x: Math.round(coin.cx - 120), y: Math.round(coin.top + coin.height * 0.25), w: 240, h: Math.round(coin.height * 0.35) };
    expect(changedFraction(await rgbRegion(out, 3.9, coinRect), bg)).toBeGreaterThan(0.25); // 3D coin rendered (WebGL)
    expect(changedFraction(await rgbRegion(out, 2.8, coinRect), bg)).toBeLessThan(0.01);
    // A region no visual covers stays untouched while visuals are on screen.
    expect(changedFraction(await rgbRegion(out, 1.9, { x: 40, y: 1700, w: 200, h: 150 }), bg)).toBeLessThan(0.01);

    // SFX energy rises at each visual start (600-3000 Hz: away from the 150 Hz voice and the 6 kHz music).
    const band = await pcm(out, "highpass=f=600,highpass=f=600,lowpass=f=3000,lowpass=f=3000");
    for (const v of visuals) {
      expect(rms(band, v.start, v.start + 0.25), v.id).toBeGreaterThan(rms(band, v.start - 0.3, v.start - 0.05) * 2);
    }
    // Music ducks under speech.
    const bed = await pcm(out, "bandpass=f=6000:width_type=q:w=8,bandpass=f=6000:width_type=q:w=8,bandpass=f=6000:width_type=q:w=8");
    expect(rms(bed, 0.5, 1.0)).toBeLessThan(rms(bed, 1.5, 1.8) * 0.5);
    expect(rms(bed, 2.3, 2.8)).toBeLessThan(rms(bed, 3.4, 3.8) * 0.5);
  }, 900000);
});
