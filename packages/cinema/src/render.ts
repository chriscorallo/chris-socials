import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveBundledFontsDir } from "@chris/media";
import type { Film } from "./dsl/schema";
import { formatIssues, validateFilm } from "./dsl/validate";
import { sfxTimeline } from "./evaluate";
import { encodeStereoWav, renderScore, SCORE_SAMPLE_RATE, type ScorePlan } from "./audio/score";
import { mixFilm, type MixReport } from "./audio/mix";
import { cinemaSfxFiles } from "./audio/sfx";
import { probeMedia, runFfmpeg } from "./audio/ffmpeg";
import { narrateFilm, type NarratedLine, type WordTranscriber } from "./narration/narrate";
import { resolveFilm, type LineClip, type ResolvedFilm } from "./timing";
import { planChunks, type FrameChunk } from "./chunks";
import type { FilmTier as Tier } from "./chunks";

/**
 * Node pipeline, in three stages that the cloud job splits across workers:
 *   1. prepareFilm   — validate → narration (Kokoro + Whisper word timings, or Chris's aligned
 *                      recording) → timing → score + SFX + mix (−14 LUFS). Cheap; one worker.
 *   2. renderFilmFrames — one frame range of the picture (Remotion + three.js), encoded straight to
 *                      delivery quality. Expensive; parallel across chunks.
 *   3. assembleFilm  — concat the chunks (stream copy, frame-exact, verified) + mux the one mix.
 * `renderFilm` runs all three locally (Chris's Mac / dev / tests).
 */

export interface RenderFilmOptions {
  film: Film;
  outDir: string;
  tier: Tier;
  /** Remotion tabs in parallel (cloud: 2 on 8 vCPU with swangle). */
  concurrency?: number;
  /** Render only these frames (inclusive) — for quick looks. Skips the audio mux. */
  frameRange?: [number, number];
  /** Skip narration (estimated timing, no voice). */
  silent?: boolean;
  /** Pre-made narration (Chris's aligned recording, or lines from an earlier prepare). */
  narration?: Record<string, NarratedLine>;
  /** Render the picture in this many sequential chunks (exercises the cloud path locally). */
  chunks?: number;
  log?: (m: string) => void;
  onProgress?: (p: { pct: number; message: string; stage: string }) => void;
  transcriber?: WordTranscriber;
}

export interface RenderFilmReport {
  film: string;
  tier: Tier;
  output: string;
  durationSeconds: number;
  frames: number;
  width: number;
  height: number;
  timingMeasured: boolean;
  stagesMs: Record<string, number>;
  renderMsPerVideoSecond: number;
  mix: MixReport | null;
  narration: Record<string, { seconds: number; heard: string }>;
  host: { cpus: number; gl: string; concurrency: number | null };
  chunks: number;
}

function findUp(sub: string, probe: string): string {
  const starts: string[] = [];
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // bundled
  }
  starts.push(process.cwd());
  for (const s of starts) {
    let dir = s;
    for (let i = 0; i < 8; i++) {
      for (const c of [join(dir, sub), join(dir, "packages", "cinema", sub)]) if (existsSync(join(c, probe))) return c;
      const p = resolve(dir, "..");
      if (p === dir) break;
      dir = p;
    }
  }
  throw new Error(`@chris/cinema: ${sub}/${probe} not found`);
}

type GlRenderer = "angle" | "swangle" | "egl" | "swiftshader" | "vulkan" | "angle-egl";
/** Same rule as @chris/motion: GPU-less hosts (Vercel Sandbox) set REMOTION_GL=swangle. */
export function rendererGl(): GlRenderer {
  const v = process.env.REMOTION_GL as GlRenderer | undefined;
  return v && ["angle", "swangle", "egl", "swiftshader", "vulkan", "angle-egl"].includes(v) ? v : "angle";
}

let bundlePromise: Promise<string> | null = null;
/** The Remotion bundle: CINEMA_BUNDLE_DIR (pre-bundled in the snapshot) or bundled once per process. */
export async function getCinemaBundle(): Promise<string> {
  if (process.env.CINEMA_BUNDLE_DIR) return process.env.CINEMA_BUNDLE_DIR;
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const { bundle } = await import("@remotion/bundler");
      const entry = join(findUp("src/remotion", "entry.ts"), "entry.ts");
      return bundle({ entryPoint: entry, publicDir: dirname(resolveBundledFontsDir()), enableCaching: true, outDir: join(tmpdir(), `chris-cinema-bundle-${process.pid}`) });
    })();
    bundlePromise.catch(() => (bundlePromise = null));
  }
  return bundlePromise;
}

export function scorePlanFor(rf: ResolvedFilm): ScorePlan {
  const m = rf.film.music;
  return {
    durationSeconds: rf.durationSeconds,
    bpm: m?.bpm ?? 84,
    key: m?.key ?? "D minor",
    seed: m?.seed ?? rf.film.seed ?? 1,
    duckDb: -14,
    sections: rf.shots.map((rs) => ({ start: rs.startSec, end: rs.endSec, intensity: rs.shot.music?.intensity ?? 0.5, hit: rs.shot.music?.hit, drop: rs.shot.music?.drop })),
    speech: rf.shots.flatMap((rs) => (rs.words.length ? [{ start: rs.words[0]!.start, end: rs.words[rs.words.length - 1]!.end }] : [])),
  };
}

const timed = async <T>(stagesMs: Record<string, number>, name: string, log: (m: string) => void, fn: () => Promise<T>): Promise<T> => {
  const t0 = Date.now();
  log(`▶ ${name}`);
  const r = await fn();
  stagesMs[name] = (stagesMs[name] ?? 0) + Date.now() - t0;
  log(`  ${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return r;
};

// ---------------------------------------------------------------------------------------------
// 1. prepare

export class ChrisNarrationMissingError extends Error {
  constructor() {
    super("This film is narrated by Chris (engine CHRIS) but no recording has been aligned yet — upload the narration and run the voice alignment first.");
    this.name = "ChrisNarrationMissingError";
  }
}

export interface PreparedFilm {
  film: Film;
  /** Per-shot measured timing (null = estimated / silent). */
  clips: Record<string, LineClip> | null;
  lines: Record<string, NarratedLine>;
  rf: ResolvedFilm;
  /** Full-length mix (WAV), or null when silent. */
  audioPath: string | null;
  mix: MixReport | null;
  stagesMs: Record<string, number>;
}

export async function prepareFilm(opts: { film: Film; workDir: string; silent?: boolean; narration?: Record<string, NarratedLine>; log?: (m: string) => void; transcriber?: WordTranscriber }): Promise<PreparedFilm> {
  const log = opts.log ?? (() => undefined);
  const stagesMs: Record<string, number> = {};
  const v = validateFilm(opts.film);
  if (!v.ok) throw new Error(`film is invalid:\n${formatIssues(v.errors)}`);
  if (v.warnings.length) log(`warnings:\n${formatIssues(v.warnings)}`);
  const film = v.film;
  await mkdir(opts.workDir, { recursive: true });
  const cacheDir = join(opts.workDir, ".cinema-cache");
  let lines: Record<string, NarratedLine> = opts.narration ?? {};
  if (!opts.silent && film.narration && !opts.narration) {
    if (film.narration.engine === "CHRIS") throw new ChrisNarrationMissingError();
    lines = await timed(stagesMs, "narration", log, () => narrateFilm(film, cacheDir, { log, transcriber: opts.transcriber }));
  }
  const clips: Record<string, LineClip> | null = Object.keys(lines).length ? Object.fromEntries(Object.entries(lines).map(([k, l]) => [k, { durationSeconds: l.durationSeconds, words: l.words }])) : null;
  const rf = resolveFilm(film, clips);
  await writeFile(join(opts.workDir, "timing.json"), JSON.stringify({ measured: rf.measured, durationSeconds: rf.durationSeconds, totalFrames: rf.totalFrames, shots: rf.shots.map((s) => ({ id: s.shot.id, start: s.startSec, end: s.endSec, words: s.words.map((w) => ({ w: w.raw, s: w.start, e: w.end, i: w.interpolated })) })) }, null, 1));
  await writeFile(join(opts.workDir, "clips.json"), JSON.stringify(clips));
  let mix: MixReport | null = null;
  let audioPath: string | null = null;
  if (!opts.silent) {
    audioPath = join(opts.workDir, "mix.wav");
    const out = audioPath;
    mix = await timed(stagesMs, "sound", log, async () => {
      const work = join(opts.workDir, "audio-work");
      await mkdir(work, { recursive: true });
      let music: string | null = null;
      if ((film.music?.source ?? "PROCEDURAL") === "PROCEDURAL") {
        music = join(work, "score.wav");
        await writeFile(music, encodeStereoWav(renderScore(scorePlanFor(rf)), SCORE_SAMPLE_RATE, -1));
      }
      const sfxFiles = await cinemaSfxFiles(join(cacheDir, "sfx"));
      const hits = sfxTimeline(rf)
        .filter((h) => sfxFiles[h.sound])
        .map((h) => ({ path: sfxFiles[h.sound]!, time: h.time, gainDb: h.gainDb }));
      const voice = rf.shots.filter((s) => s.lineStartSec !== null && lines[s.shot.id]).map((s) => ({ path: lines[s.shot.id]!.path, start: s.lineStartSec! }));
      return mixFilm({ workDir: work, voice, music, musicUnderVoiceDb: (film.music?.levelDb ?? -18) + 8, sfx: hits, duration: rf.durationSeconds, out });
    });
  }
  return { film, clips, lines, rf, audioPath, mix, stagesMs };
}

// ---------------------------------------------------------------------------------------------
// 2. picture (one frame range)

/** Encoding per tier: straight to delivery quality (no mezzanine re-encode). */
export function tierEncoding(tier: Tier) {
  return tier === "FINAL"
    ? { crf: 19, x264Preset: "slow" as const, encodingMaxRate: "12M" as const, encodingBufferSize: "24M" as const, jpegQuality: 95 }
    : tier === "PREVIEW"
      ? { crf: 22, x264Preset: "veryfast" as const, encodingMaxRate: "8M" as const, encodingBufferSize: "16M" as const, jpegQuality: 88 }
      : { crf: 26, x264Preset: "veryfast" as const, encodingMaxRate: null, encodingBufferSize: null, jpegQuality: 80 };
}

export async function renderFilmFrames(opts: {
  film: Film;
  clips: Record<string, LineClip> | null;
  tier: Tier;
  frameRange: [number, number] | null;
  outPath: string;
  concurrency?: number | null;
  log?: (m: string) => void;
  onProgress?: (fraction: number, renderedFrames: number) => void;
}): Promise<{ frames: number; width: number; height: number; ms: number }> {
  const t0 = Date.now();
  const { renderMedia, selectComposition, openBrowser, ensureBrowser } = await import("@remotion/renderer");
  const { findLocalHeadlessShell } = await import("@chris/motion");
  const serveUrl = await getCinemaBundle();
  const gl = rendererGl();
  const browserExecutable = findLocalHeadlessShell();
  if (!browserExecutable) await ensureBrowser();
  const browser = await openBrowser("chrome", { browserExecutable, chromiumOptions: { gl } });
  const inputProps = { film: opts.film, clips: opts.clips, tier: opts.tier, fontBaseUrl: null };
  const concurrency = opts.concurrency ?? (Number(process.env.REMOTION_CONCURRENCY) > 0 ? Number(process.env.REMOTION_CONCURRENCY) : null);
  const enc = tierEncoding(opts.tier);
  await mkdir(dirname(opts.outPath), { recursive: true });
  try {
    const composition = await selectComposition({ serveUrl, id: "MiniMovie", inputProps, puppeteerInstance: browser, chromiumOptions: { gl }, logLevel: "error", timeoutInMilliseconds: 120000 });
    const frames = opts.frameRange ? opts.frameRange[1] - opts.frameRange[0] + 1 : composition.durationInFrames;
    let last = 0;
    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      codec: "h264",
      crf: enc.crf,
      x264Preset: enc.x264Preset,
      encodingMaxRate: enc.encodingMaxRate,
      encodingBufferSize: enc.encodingBufferSize,
      pixelFormat: "yuv420p",
      colorSpace: "bt709",
      imageFormat: "jpeg",
      jpegQuality: enc.jpegQuality,
      muted: true,
      frameRange: opts.frameRange,
      concurrency,
      puppeteerInstance: browser,
      chromiumOptions: { gl },
      timeoutInMilliseconds: 120000,
      logLevel: "error",
      outputLocation: opts.outPath,
      onProgress: ({ progress, renderedFrames }) => {
        opts.onProgress?.(progress, renderedFrames);
        if (progress - last >= 0.1) {
          last = progress;
          opts.log?.(`  picture ${(progress * 100).toFixed(0)}% (${renderedFrames} frames)`);
        }
      },
    });
    return { frames, width: composition.width, height: composition.height, ms: Date.now() - t0 };
  } finally {
    await browser.close({ silent: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// 3. assemble

export class FilmAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilmAssemblyError";
  }
}

/**
 * Concatenates rendered chunks (in order) without re-encoding and muxes the film's one mix.
 * Verifies the result is frame-exact (frame count == expectedFrames) and that audio and picture
 * end together (within one frame); throws FilmAssemblyError otherwise.
 */
export async function assembleFilm(opts: { chunkPaths: string[]; audioPath: string | null; outPath: string; expectedFrames: number; fps: number; workDir: string }): Promise<{ frames: number; videoSeconds: number; audioSeconds: number | null; bytes: number }> {
  await mkdir(opts.workDir, { recursive: true });
  await mkdir(dirname(opts.outPath), { recursive: true });
  const seconds = opts.expectedFrames / opts.fps;
  const inputs: string[] = [];
  if (opts.chunkPaths.length === 1) inputs.push("-i", opts.chunkPaths[0]!);
  else {
    const list = join(opts.workDir, "concat.txt");
    await writeFile(list, opts.chunkPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
    inputs.push("-f", "concat", "-safe", "0", "-i", list);
  }
  if (opts.audioPath) {
    await runFfmpeg([...inputs, "-i", opts.audioPath, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-t", seconds.toFixed(6), "-movflags", "+faststart", opts.outPath]);
  } else {
    await runFfmpeg([...inputs, "-map", "0:v:0", "-c:v", "copy", "-movflags", "+faststart", opts.outPath]);
  }
  const m = await probeMedia(opts.outPath);
  if (m.videoFrames !== opts.expectedFrames) throw new FilmAssemblyError(`assembled film has ${m.videoFrames} frames, expected ${opts.expectedFrames}`);
  if (m.audioSeconds !== null && Math.abs(m.audioSeconds - m.videoSeconds) > 1.5 / opts.fps + 0.03) throw new FilmAssemblyError(`audio (${m.audioSeconds.toFixed(3)} s) and picture (${m.videoSeconds.toFixed(3)} s) don't end together`);
  return { frames: m.videoFrames, videoSeconds: m.videoSeconds, audioSeconds: m.audioSeconds, bytes: (await stat(opts.outPath)).size };
}

// ---------------------------------------------------------------------------------------------
// all three, locally

export async function renderFilm(opts: RenderFilmOptions): Promise<RenderFilmReport> {
  const log = opts.log ?? (() => undefined);
  const progress = (pct: number, message: string, stage: string) => opts.onProgress?.({ pct, message, stage });
  await mkdir(opts.outDir, { recursive: true });
  progress(2, "Writing the narration and the music…", "prepare");
  const prep = await prepareFilm({ film: opts.film, workDir: opts.outDir, silent: opts.silent, narration: opts.narration, log, transcriber: opts.transcriber });
  const stagesMs = { ...prep.stagesMs };
  const { film, rf } = prep;
  const range: [number, number] = opts.frameRange ?? [0, rf.totalFrames - 1];
  const chunks: FrameChunk[] = opts.frameRange ? [{ index: 0, start: range[0], end: range[1] }] : planChunks(rf.totalFrames, opts.chunks ?? 1);
  const chunkPaths: string[] = [];
  let width = 0;
  let height = 0;
  const totalFrames = range[1] - range[0] + 1;
  let done = 0;
  for (const c of chunks) {
    const p = join(opts.outDir, "chunks", `${opts.tier.toLowerCase()}-${c.index}-of-${chunks.length}.mp4`);
    const r = await timed(stagesMs, "picture", log, () =>
      renderFilmFrames({ film, clips: prep.clips, tier: opts.tier, frameRange: [c.start, c.end], outPath: p, concurrency: opts.concurrency, log, onProgress: (f) => progress(10 + (85 * (done + f * (c.end - c.start + 1))) / totalFrames, `Rendering the picture… ${Math.round(((done + f * (c.end - c.start + 1)) / totalFrames) * 100)}%`, "picture") }),
    );
    done += c.end - c.start + 1;
    width = r.width;
    height = r.height;
    chunkPaths.push(p);
  }
  const output = join(opts.outDir, `${film.id}-${opts.tier.toLowerCase()}.mp4`);
  progress(96, "Putting it together…", "assemble");
  await timed(stagesMs, "mux", log, () => assembleFilm({ chunkPaths, audioPath: opts.frameRange ? null : prep.audioPath, outPath: output, expectedFrames: totalFrames, fps: film.format.fps, workDir: join(opts.outDir, "assemble") }));
  if (!process.env.CINEMA_KEEP_CHUNKS) await rm(join(opts.outDir, "chunks"), { recursive: true, force: true });
  const videoSeconds = totalFrames / film.format.fps;
  const report: RenderFilmReport = {
    film: film.id,
    tier: opts.tier,
    output,
    durationSeconds: rf.durationSeconds,
    frames: totalFrames,
    width,
    height,
    timingMeasured: rf.measured,
    stagesMs,
    renderMsPerVideoSecond: Math.round((stagesMs.picture ?? 0) / Math.max(0.001, videoSeconds)),
    mix: prep.mix,
    narration: Object.fromEntries(Object.entries(prep.lines).map(([k, l]) => [k, { seconds: Number(l.durationSeconds.toFixed(3)), heard: l.heard }])),
    host: { cpus: (await import("node:os")).cpus().length, gl: rendererGl(), concurrency: opts.concurrency ?? null },
    chunks: chunks.length,
  };
  await writeFile(join(opts.outDir, `report-${opts.tier.toLowerCase()}.json`), JSON.stringify(report, null, 2));
  return report;
}

/** Copies a file (helper for job outputs). */
export async function copyTo(src: string, dst: string): Promise<void> {
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(src, dst);
}
