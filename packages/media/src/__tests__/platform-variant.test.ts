import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FFPROBE_PATH } from "../ffmpeg-paths";
import { PLATFORM_PROFILES, type PlatformId } from "../platform-profiles";
import { encodePlatformVariant, isFaststart, measureLoudness, probeVariant, VariantTooLargeError } from "../platform-variant";
import { runFfmpegRaw } from "./ffmpeg-test-helpers";

const execFileAsync = promisify(execFile);

/** Real encodes of a master into each platform profile — probe-verified. */
describe("encodePlatformVariant (real ffmpeg)", () => {
  let dir: string;
  let master30: string;
  let master60: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-variant-test-"));
    master30 = join(dir, "master30.mp4");
    master60 = join(dir, "master60.mp4");
    // Quiet (~-30 LUFS) so normalisation has real work to do; detailed picture so bitrate matters.
    for (const [path, rate] of [[master30, 30], [master60, 60]] as const) {
      await runFfmpegRaw([
        "-y", "-f", "lavfi", "-i", `testsrc2=size=1080x1920:rate=${rate}:duration=4`,
        "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.03:duration=4:sample_rate=48000",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "320k", "-ac", "2", "-shortest", "-movflags", "+faststart", path,
      ]);
    }
  }, 60000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const id of ["INSTAGRAM", "TIKTOK", "YOUTUBE"] as PlatformId[]) {
    it(`${id}: canvas, fps, codecs, audio, loudness, faststart, cover all match the profile`, async () => {
      const profile = PLATFORM_PROFILES[id];
      const out = join(dir, `${id}.mp4`);
      const before = await measureLoudness(master30);
      expect(before.integratedLufs).toBeLessThan(profile.loudness.integratedLufs - 6);
      const res = await encodePlatformVariant({ masterPath: master30, outputPath: out, profile, coverFrameSeconds: 1.5, preset: "veryfast" });
      expect(res.issues).toEqual([]);
      expect(res.width).toBe(1080);
      expect(res.height).toBe(1920);
      expect(res.fps).toBe(30);
      expect(Math.abs(res.durationSeconds - 4)).toBeLessThan(0.1);
      expect(Math.abs(res.integratedLufs - profile.loudness.integratedLufs)).toBeLessThanOrEqual(1);
      expect(res.truePeakDbtp).toBeLessThanOrEqual(profile.loudness.truePeakDbtp + 0.5);
      // ffmpeg's native AAC encoder undershoots high targets on simple material (384k -> ~240k).
      expect(res.audioBitrateKbps).toBeGreaterThan(Math.min(profile.audio.bitrateKbps, 192) * 0.7);
      expect(res.audioBitrateKbps).toBeLessThan(profile.audio.bitrateKbps * 1.15);
      expect(res.videoBitrateKbps).toBeLessThanOrEqual(profile.video.maxrateKbps.upTo30fps * 1.1);
      expect(await isFaststart(out)).toBe(true);
      const p = await probeVariant(out);
      expect(p.videoProfile).toBe("High");
      expect(p.audioSampleRate).toBe(48000);
      expect(p.audioChannels).toBe(2);
      const { stdout } = await execFileAsync(FFPROBE_PATH, [
        "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=level,color_primaries,color_transfer,color_space,profile",
        "-of", "json", out,
      ]);
      const s = (JSON.parse(stdout) as { streams: Array<Record<string, unknown>> }).streams[0]!;
      expect(s.level).toBe(42);
      expect(s.color_primaries).toBe("bt709");
      expect(s.color_space).toBe("bt709");
      expect(res.coverImagePath && existsSync(res.coverImagePath)).toBe(true);
      expect(readFileSync(res.coverImagePath!).subarray(0, 2).toString("hex")).toBe("ffd8"); // JPEG SOI
    }, 120000);
  }

  it("YOUTUBE keeps a 60 fps master at 60 with a closed half-second GOP", async () => {
    const out = join(dir, "yt60.mp4");
    const res = await encodePlatformVariant({ masterPath: master60, outputPath: out, profile: PLATFORM_PROFILES.YOUTUBE, preset: "veryfast" });
    expect(res.fps).toBe(60);
    expect(res.issues).toEqual([]);
    const { stdout } = await execFileAsync(FFPROBE_PATH, [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=key_frame,best_effort_timestamp_time", "-of", "csv=p=0", out,
    ]);
    const keys = stdout
      .trim()
      .split("\n")
      .map((l) => l.split(","))
      .filter(([k]) => k === "1")
      .map(([, t]) => Number(t));
    expect(keys.length).toBeGreaterThanOrEqual(7);
    for (let i = 1; i < keys.length; i++) expect(keys[i]! - keys[i - 1]!).toBeCloseTo(0.5, 2);
  }, 120000);

  it("over the size cap: retries once at a computed bitrate, then fails clearly when it can't fit", async () => {
    const tight = { ...PLATFORM_PROFILES.INSTAGRAM, maxFileSizeBytes: 1_200_000 };
    const first = await encodePlatformVariant({ masterPath: master30, outputPath: join(dir, "tight.mp4"), profile: { ...tight, maxFileSizeBytes: 1e9 }, preset: "veryfast" });
    expect(first.fileSizeBytes).toBeGreaterThan(1_200_000); // the cap really is binding
    const res = await encodePlatformVariant({ masterPath: master30, outputPath: join(dir, "tight2.mp4"), profile: tight, preset: "veryfast" });
    expect(res.retriedForSize).toBe(true);
    expect(res.fileSizeBytes).toBeLessThanOrEqual(1_200_000);
    expect(res.issues).toEqual([]);
    await expect(
      encodePlatformVariant({ masterPath: master30, outputPath: join(dir, "tiny.mp4"), profile: { ...tight, maxFileSizeBytes: 100_000 }, preset: "veryfast" }),
    ).rejects.toBeInstanceOf(VariantTooLargeError);
  }, 180000);
});
