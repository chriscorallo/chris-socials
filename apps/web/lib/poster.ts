import { spawn } from "node:child_process";
import { FFMPEG_PATH } from "@chris/media";
import { storage, getLocalStorage } from "./storage";

/**
 * Small JPEG poster frames for video lists (Home, Videos, calendar sheet) and as the `poster`
 * of on-page players — so a list never points a <video> at a full raw take. Before this, every
 * card loaded the actual file (`preload="metadata"` + `#t=` seek): on production a two-card
 * Videos page pulled a 228 MB iPhone .mov + a 12 MB render, held the load event for ~50 s and
 * starved tab navigations of bandwidth. See docs/decisions-pending/app-performance.md.
 *
 * Generated lazily on first request with ffmpeg (seeking reads only the byte ranges it needs,
 * even over HTTPS from the private Blob store), then stored next to the media under
 * `posters/<storageKey>.jpg` so every later request is a small storage read, and served with a
 * long private cache (storage keys are immutable — a new take or render gets a new key).
 */

export const POSTER_WIDTH = 360; // 72px card @3x = 216; 124px phone hero @3x ≈ 372.
const POSTER_VERSION = "v1";

export function posterStorageKey(storageKey: string): string {
  return `posters/${POSTER_VERSION}/${storageKey}.jpg`;
}

/** ffmpeg arguments for one scaled JPEG frame at `atSeconds`, written to stdout. */
export function posterFfmpegArgs(input: string, atSeconds: number, width = POSTER_WIDTH): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    // Input seeking (before -i): jumps to the nearest keyframe without decoding from the start.
    "-ss",
    String(atSeconds),
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    `scale=${width}:-2`,
    "-q:v",
    "5",
    "-f",
    "image2",
    "-c:v",
    "mjpeg",
    "pipe:1",
  ];
}

function runFfmpegToBuffer(args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`ffmpeg poster timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      if (code === 0 && out.length > 0) resolve(out);
      else reject(new Error(`ffmpeg poster failed (code ${code}): ${stderr.slice(-500)}`));
    });
  });
}

// At most two ffmpeg decodes per instance at once (Fluid compute shares an instance between
// requests; a first visit to a long list must not starve page renders), and one generation per
// key — concurrent requests for the same poster wait for the same promise.
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: (() => void)[] = [];
const inFlight = new Map<string, Promise<Buffer>>();

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** One poster JPEG from a local path or URL: a frame at 0.6 s (past any black first frame),
 * else the first frame (clips shorter than the seek point produce no frame at 0.6 s). */
export async function extractPosterJpeg(input: string): Promise<Buffer> {
  try {
    return await withSlot(() => runFfmpegToBuffer(posterFfmpegArgs(input, 0.6), 25_000));
  } catch {
    return await withSlot(() => runFfmpegToBuffer(posterFfmpegArgs(input, 0), 25_000));
  }
}

async function generate(storageKey: string): Promise<Buffer> {
  const local = getLocalStorage();
  const input = local ? local.pathFor(storageKey) : await storage.signedUrl(storageKey, 600);
  const jpeg = await extractPosterJpeg(input);
  // Best effort: a failed write only means the next request regenerates it.
  await storage.put(posterStorageKey(storageKey), jpeg, "image/jpeg").catch((e) => console.warn("[poster] store failed", storageKey, e));
  return jpeg;
}

/** The stored poster, or null if it hasn't been generated yet. A stored poster only ever
 * exists for a key that passed the ownership check when it was generated (getPoster's caller),
 * so serving it needs no database round trip. */
export async function getStoredPoster(storageKey: string): Promise<Buffer | null> {
  try {
    return await storage.get(posterStorageKey(storageKey));
  } catch {
    return null;
  }
}

/** Generates (once per key, concurrently-safe) and stores the poster for a VERIFIED key. */
export async function generatePoster(storageKey: string): Promise<Buffer> {
  const existing = inFlight.get(storageKey);
  if (existing) return existing;
  const p = generate(storageKey).finally(() => inFlight.delete(storageKey));
  inFlight.set(storageKey, p);
  return p;
}
