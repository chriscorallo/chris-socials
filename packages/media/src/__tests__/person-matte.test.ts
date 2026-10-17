import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computePersonMatte, resolveMatteModelPath } from "../person-matte";
import { probeMedia } from "../probe";
import { grabGrayRegion, runFfmpegRaw } from "./ffmpeg-test-helpers";

/**
 * SLOW / real model: MODNet on a real portrait (the public-domain fixture, placed on a flat
 * wall with a little drift). Skipped when the model isn't cached locally (no network in CI) —
 * set MATTE_CACHE_DIR / MATTE_MODEL_PATH, or MATTE_TEST=1 to allow the one-time download.
 */
const model = resolveMatteModelPath();
const run = model.exists || process.env.MATTE_TEST === "1";

describe.skipIf(!run)("computePersonMatte (real MODNet, slow)", () => {
  let dir: string;
  let clip: string;
  const face = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "face-portrait-pd.jpg");

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-matte-"));
    clip = join(dir, "portrait.mp4");
    // 540x960 portrait: grey wall, the 500x625 portrait at the bottom, slow sideways drift.
    await runFfmpegRaw([
      "-y", "-f", "lavfi", "-i", "color=c=0x8A8F96:s=540x960:r=30:d=2",
      "-loop", "1", "-i", face,
      "-filter_complex", "[1:v]scale=500:625[p];[0:v][p]overlay=x='20+10*sin(t*2)':y=335:shortest=1,format=yuv420p",
      "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip,
    ]);
  }, 60000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("produces an aligned H.264 matte: person white, wall black, same duration/fps", async () => {
    const out = join(dir, "matte.mp4");
    const r = await computePersonMatte(clip, out, { size: 480 });
    expect(r.width).toBe(270);
    expect(r.height).toBe(480);
    expect(r.fps).toBe(30);
    expect(r.frames).toBeGreaterThanOrEqual(59);
    expect(r.coverage).toBeGreaterThan(0.1);
    const p = await probeMedia(out);
    expect(p.videoCodec).toBe("h264");
    expect(p.durationSeconds).toBeCloseTo(2, 0);
    // Matte is 270x480 for a 540x960 source (scale 0.5). Face centre ≈ source (270, 560) → matte (135, 280).
    const mean = (b: Buffer) => b.reduce((a, v) => a + v, 0) / b.length;
    expect(mean(await grabGrayRegion(out, 1, { x: 115, y: 250, width: 40, height: 40 }))).toBeGreaterThan(200);
    // Top of the frame is wall only.
    expect(mean(await grabGrayRegion(out, 1, { x: 20, y: 20, width: 230, height: 60 }))).toBeLessThan(25);
  }, 240000);
});
