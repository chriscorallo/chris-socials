import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FFMPEG_PATH } from "../ffmpeg-paths";
import { analyzeTakeUnderstanding, faceCropGray64, findExpressionModelPath } from "../take-understanding";
import { parseTakeUnderstanding } from "../director";

const run = promisify(execFile);
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "face-portrait-pd.jpg");

describe("take understanding", () => {
  it("crops a face to FER+'s 64×64 grayscale input (bilinear, clamped at the edges)", () => {
    const W = 8;
    const H = 8;
    const rgb = new Uint8Array(W * H * 3).fill(200);
    const crop = faceCropGray64(rgb, { width: W, height: H }, { cw: W, ch: H, padX: 0, padY: 0 }, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(crop).toHaveLength(64 * 64);
    expect(Math.abs(crop[0]! - 200)).toBeLessThan(0.01);
  });

  // The real models (UltraFace + FER+). FER+ (19 MB) isn't committed: it's downloaded by the
  // snapshot build / on first use — the test runs wherever it is on disk.
  it.skipIf(!findExpressionModelPath())(
    "reads a real public-domain smiling portrait as happy, with the face found and a frames sprite",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "chris-understand-"));
      try {
        const clip = join(dir, "face.mp4");
        await run(FFMPEG_PATH, ["-y", "-v", "error", "-loop", "1", "-t", "2", "-i", FIXTURE, "-vf", "scale=540:-2,pad=540:960:(ow-iw)/2:(oh-ih)/2,format=yuv420p", "-r", "10", clip]);
        const r = await analyzeTakeUnderstanding(clip, { mediaAssetId: "t" });
        const u = parseTakeUnderstanding(r.understanding)!;
        expect(u).not.toBeNull();
        expect(u.samples.length).toBeGreaterThanOrEqual(7);
        const withFace = u.samples.filter((s) => s.face && s.probs);
        expect(withFace.length).toBe(u.samples.length);
        // FER+ class 1 = happy
        expect(withFace.every((s) => s.probs![1]! > 0.6)).toBe(true);
        expect(u.sprite).toMatchObject({ stepS: 0.5, cellW: 180 });
        expect(r.spriteJpeg!.subarray(0, 2).toString("hex")).toBe("ffd8");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
