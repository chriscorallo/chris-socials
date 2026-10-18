import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FFPROBE_PATH } from "../ffmpeg-paths";
import { filmstripTileAt, peaksFromPcm, planPreviewAssets, proxySize, PROXY_KEYFRAME_S } from "../preview-plan";
import { makePreviewAssets, proxyFfmpegArgs } from "../preview-proxy";
import { probeMedia } from "../probe";
import { runFfmpegRaw } from "./ffmpeg-test-helpers";

const execFileAsync = promisify(execFile);

describe("preview proxy planning (pure)", () => {
  it("fits inside 720x1280 / 1280x720, even sizes, never upscales", () => {
    expect(proxySize({ width: 2160, height: 3840 })).toEqual({ width: 720, height: 1280 });
    expect(proxySize({ width: 1080, height: 1920 })).toEqual({ width: 720, height: 1280 });
    expect(proxySize({ width: 3840, height: 2160 })).toEqual({ width: 1280, height: 720 });
    expect(proxySize({ width: 540, height: 960 })).toEqual({ width: 540, height: 960 });
    const odd = proxySize({ width: 1442, height: 2560 });
    expect(odd.width % 2).toBe(0);
    expect(odd.height % 2).toBe(0);
    expect(odd.height).toBeLessThanOrEqual(1280);
  });

  it("keyframe every 0.5 s at ≤ 30 fps, ≤ 120 filmstrip tiles", () => {
    const p = planPreviewAssets({ width: 2160, height: 3840, fps: 59.94, durationSeconds: 80 });
    expect(p.proxy.fps).toBe(30);
    expect(p.proxy.gopFrames).toBe(Math.round(30 * PROXY_KEYFRAME_S));
    expect(p.filmstrip.count).toBe(80);
    expect(p.filmstrip.step).toBeCloseTo(1, 6);
    expect(p.filmstrip.cols * p.filmstrip.rows).toBeGreaterThanOrEqual(p.filmstrip.count);
    const long = planPreviewAssets({ width: 1080, height: 1920, fps: 30, durationSeconds: 600 });
    expect(long.filmstrip.count).toBe(120);
    expect(long.filmstrip.step).toBeCloseTo(5, 6);
    const p24 = planPreviewAssets({ width: 1080, height: 1920, fps: 24, durationSeconds: 10 });
    expect(p24.proxy.gopFrames).toBe(12);
  });

  it("maps a source time to its sprite tile", () => {
    const f = planPreviewAssets({ width: 1080, height: 1920, fps: 30, durationSeconds: 80 }).filmstrip;
    expect(filmstripTileAt(f, 0)).toEqual({ index: 0, x: 0, y: 0 });
    expect(filmstripTileAt(f, 12.4)).toEqual({ index: 12, x: 2 * f.tileW, y: f.tileH });
    expect(filmstripTileAt(f, 999).index).toBe(f.count - 1);
    expect(filmstripTileAt(f, -1).index).toBe(0);
  });

  it("peak envelope: max |sample| per window, 0–255", () => {
    const pcm = new Int16Array(400);
    pcm[10] = 16384;
    pcm[250] = -32768;
    expect(peaksFromPcm(pcm, 4000, 20)).toEqual([128, 255]);
  });

  it("ffmpeg args: closed short GOP, no scene-cut keyframes, faststart, audio optional", () => {
    const plan = planPreviewAssets({ width: 2160, height: 3840, fps: 30, durationSeconds: 10 });
    const a = proxyFfmpegArgs("in.mov", "out.mp4", plan, true).join(" ");
    expect(a).toContain("-g 15");
    expect(a).toContain("-keyint_min 15");
    expect(a).toContain("-sc_threshold 0");
    expect(a).toContain("+faststart");
    expect(a).toContain("scale=720:1280");
    expect(a).toContain("-c:a aac");
    expect(proxyFfmpegArgs("in.mov", "out.mp4", plan, false)).toContain("-an");
  });
});

describe("makePreviewAssets (real ffmpeg)", () => {
  let dir: string;
  let src: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-proxy-test-"));
    src = join(dir, "take.mp4");
    // A 4 s "camera original": 1080x1920, sparse keyframes (like a phone), with sound.
    await runFfmpegRaw([
      "-y", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=48000",
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "120", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", "-movflags", "+faststart", src,
    ]);
  }, 60000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("makes a 720x1280 proxy with a keyframe every 0.5 s, a sprite and peaks", async () => {
    const out = join(dir, "out");
    await runFfmpegRaw(["-version"]).catch(() => undefined);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(out, { recursive: true });
    const r = await makePreviewAssets(src, out, { width: 1080, height: 1920, fps: 30, durationSeconds: 4, hasAudio: true });
    const probe = await probeMedia(r.proxyPath);
    expect(probe.width).toBe(720);
    expect(probe.height).toBe(1280);
    expect(probe.videoCodec).toBe("h264");
    expect(probe.audioCodec).toBe("aac");
    // keyframes every 15 frames (0.5 s at 30 fps): frames 0, 15, 30 … 105
    const { stdout } = await execFileAsync(FFPROBE_PATH, ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=key_frame", "-of", "csv=p=0", r.proxyPath]);
    // (ffprobe prints an empty line for side data after some frames — skip those.)
    const flags = stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.startsWith("1"));
    expect(flags.length).toBe(120);
    const keys = flags.flatMap((k, i) => (k ? [i] : []));
    expect(keys).toEqual([0, 15, 30, 45, 60, 75, 90, 105]);
    expect(existsSync(r.filmstripPath)).toBe(true);
    const sprite = await probeMedia(r.filmstripPath);
    expect(sprite.width).toBe(r.plan.filmstrip.cols * r.plan.filmstrip.tileW);
    expect(sprite.height).toBe(r.plan.filmstrip.rows * r.plan.filmstrip.tileH);
    expect(r.peaks!.values.length).toBeGreaterThanOrEqual(79);
    expect(Math.max(...r.peaks!.values)).toBeGreaterThan(20); // lavfi sine = amplitude 1/8
    expect(statSync(r.proxyPath).size).toBeLessThan(statSync(src).size * 2);
  }, 60000);
});
