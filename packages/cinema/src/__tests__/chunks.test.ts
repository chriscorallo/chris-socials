import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFMPEG_PATH } from "@chris/media";
import { chooseChunkCount, chunksCover, estimateFilmRender, planChunks } from "../chunks";
import { assembleFilm, FilmAssemblyError } from "../render";
import { runFfmpeg } from "../audio/ffmpeg";

/** Encodes frames whose gray level encodes their GLOBAL index (lossless), like one render chunk. */
function encodeChunk(path: string, from: number, count: number, w = 64, h = 64, fps = 30): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${w}x${h}`, "-r", String(fps), "-i", "-", "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path]);
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}`))));
    for (let i = 0; i < count; i++) p.stdin.write(Buffer.alloc(w * h, ((from + i) * 5) % 250));
    p.stdin.end();
  });
}

/** Mean gray level of every frame of a video. */
function frameLevels(path: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-i", path, "-vf", "scale=8:8", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    const bufs: Buffer[] = [];
    p.stdout.on("data", (d) => bufs.push(d));
    p.on("error", reject);
    p.on("close", () => {
      const all = Buffer.concat(bufs);
      const out: number[] = [];
      for (let i = 0; i + 64 <= all.length; i += 64) {
        let s = 0;
        for (let k = 0; k < 64; k++) s += all[i + k]!;
        out.push(Math.round(s / 64));
      }
      resolve(out);
    });
  });
}

describe("chunk planning", () => {
  it("covers every frame exactly once, in order, for any length and worker count", () => {
    for (const total of [1, 2, 44, 45, 90, 119, 1190, 1361, 1800]) {
      for (const n of [1, 2, 3, 4, 6, 8, 13]) {
        const c = planChunks(total, n);
        expect(chunksCover(c, total), `${total}/${n}`).toBe(true);
        expect(c.length).toBeLessThanOrEqual(n);
        const lens = c.map((x) => x.end - x.start + 1);
        expect(Math.max(...lens) - Math.min(...lens)).toBeLessThanOrEqual(1);
      }
    }
    expect(planChunks(30, 8, 45)).toHaveLength(1); // never chunks shorter than minFrames
    expect(chunksCover([{ index: 0, start: 0, end: 9 }, { index: 1, start: 9, end: 19 }], 20)).toBe(false); // overlap
    expect(chunksCover([{ index: 0, start: 0, end: 8 }, { index: 1, start: 10, end: 19 }], 20)).toBe(false); // gap
  });

  it("estimates time and cost before anything starts", () => {
    const mac = estimateFilmRender({ durationSeconds: 40, tier: "FINAL", host: "MAC_GPU" });
    expect(mac.usd).toBe(0);
    const one = estimateFilmRender({ durationSeconds: 40, tier: "FINAL", host: "SANDBOX_8VCPU", chunks: 1 });
    const six = estimateFilmRender({ durationSeconds: 40, tier: "FINAL", host: "SANDBOX_8VCPU", chunks: 6 });
    expect(six.wallSeconds).toBeLessThan(one.wallSeconds / 3);
    expect(six.usd).toBeGreaterThan(0.3);
    expect(six.usd).toBeLessThan(3);
    expect(six.summary).toMatch(/\$\d+\.\d\d/);
    expect(chooseChunkCount(40, "FINAL", 4)).toBe(4);
    expect(chooseChunkCount(5, "PREVIEW", 8)).toBe(1);
  });
});

describe("assembly (real ffmpeg)", () => {
  it("concatenates chunks frame-exactly (no duplicated or missing frames) and keeps audio in sync", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cinema-chunks-"));
    try {
      const total = 97;
      const plan = planChunks(total, 3, 10);
      const paths: string[] = [];
      for (const c of plan) {
        const p = join(dir, `c${c.index}.mp4`);
        await encodeChunk(p, c.start, c.end - c.start + 1);
        paths.push(p);
      }
      const audio = join(dir, "mix.wav");
      await runFfmpeg(["-f", "lavfi", "-i", `sine=frequency=330:sample_rate=48000:duration=${(total / 30).toFixed(6)}`, "-ac", "2", audio]);
      const out = join(dir, "film.mp4");
      const r = await assembleFilm({ chunkPaths: paths, audioPath: audio, outPath: out, expectedFrames: total, fps: 30, workDir: join(dir, "asm") });
      expect(r.frames).toBe(total);
      expect(Math.abs((r.audioSeconds ?? 0) - r.videoSeconds)).toBeLessThan(1 / 30 + 0.03);
      const levels = await frameLevels(out);
      expect(levels).toHaveLength(total);
      levels.forEach((v, i) => expect(Math.abs(v - ((i * 5) % 250)), `frame ${i}`).toBeLessThanOrEqual(2));
      // a missing chunk is caught, not shipped
      await expect(assembleFilm({ chunkPaths: paths.slice(0, 2), audioPath: null, outPath: join(dir, "bad.mp4"), expectedFrames: total, fps: 30, workDir: join(dir, "asm2") })).rejects.toBeInstanceOf(FilmAssemblyError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
