import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFMPEG_PATH } from "@chris/media";
import { extractPosterJpeg, posterFfmpegArgs, posterStorageKey, POSTER_WIDTH } from "./poster";
import { thumbUrlFor, thumbUrlForMediaUrl, mediaUrlFor } from "./media-urls";

const run = promisify(execFile);

describe("poster URLs and keys", () => {
  it("maps a media key to its thumb URL and stored poster key", () => {
    expect(thumbUrlFor("raw/abc/take.mov")).toBe("/api/thumb/raw/abc/take.mov");
    expect(mediaUrlFor("raw/abc/take.mov")).toBe("/api/media/raw/abc/take.mov");
    expect(posterStorageKey("renders/x/y.mp4")).toBe("posters/v1/renders/x/y.mp4.jpg");
  });

  it("derives a poster URL from a player's media URL (dropping any #t= fragment)", () => {
    expect(thumbUrlForMediaUrl("/api/media/renders/x/y.mp4#t=0.1")).toBe("/api/thumb/renders/x/y.mp4");
    expect(thumbUrlForMediaUrl("https://elsewhere.example/video.mp4")).toBeUndefined();
  });

  it("seeks on the input side and scales to the poster width", () => {
    const args = posterFfmpegArgs("/in.mov", 0.6);
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain(`scale=${POSTER_WIDTH}:-2`);
    expect(args.at(-1)).toBe("pipe:1");
  });
});

describe("extractPosterJpeg (real ffmpeg)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "poster-test-"));
    // A 2 s portrait clip and a 0.3 s one (shorter than the 0.6 s seek point).
    for (const [name, secs] of [["long.mp4", "2"], ["short.mp4", "0.3"]] as const) {
      await run(FFMPEG_PATH, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30", "-t", secs, "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, name)]);
    }
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns a small JPEG for a normal clip", async () => {
    const jpeg = await extractPosterJpeg(join(dir, "long.mp4"));
    expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8"); // JPEG SOI marker
    expect(jpeg.length).toBeLessThan(100_000);
  }, 30_000);

  it("falls back to the first frame for a clip shorter than the seek point", async () => {
    const jpeg = await extractPosterJpeg(join(dir, "short.mp4"));
    expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
  }, 30_000);

  it("rejects for an unreadable input (the route then serves a transparent pixel)", async () => {
    await expect(extractPosterJpeg(join(dir, "missing.mp4"))).rejects.toThrow();
  }, 30_000);
});
