import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
import { runFfmpeg } from "./audio/ffmpeg";
import { narrateFilm, type NarratedLine } from "./narration/narrate";
import { resolveFilm, type LineClip, type ResolvedFilm } from "./timing";
import type { Tier } from "./remotion/world/World";

/**
 * Node pipeline: validate → narrate (Kokoro + Whisper word timings) → resolve timing →
 * score + SFX + mix (−14 LUFS) → Remotion render (picture) → mux. Every stage is timed and
 * written to report.json next to the film.
 */

export interface RenderFilmOptions {
  film: Film;
  outDir: string;
  tier: Tier;
  /** Remotion tabs in parallel (cloud: 2 on 8 vCPU with swangle). */
  concurrency?: number;
  /** Render only these frames (inclusive) — for quick looks. */
  frameRange?: [number, number];
  /** Skip narration (estimated timing, no voice). */
  silent?: boolean;
  log?: (m: string) => void;
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

export async function renderFilm(opts: RenderFilmOptions): Promise<RenderFilmReport> {
  const log = opts.log ?? (() => undefined);
  const stagesMs: Record<string, number> = {};
  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    log(`▶ ${name}`);
    const r = await fn();
    stagesMs[name] = Date.now() - t0;
    log(`  ${name}: ${(stagesMs[name] / 1000).toFixed(1)} s`);
    return r;
  };
  const v = validateFilm(opts.film);
  if (!v.ok) throw new Error(`film is invalid:\n${formatIssues(v.errors)}`);
  if (v.warnings.length) log(`warnings:\n${formatIssues(v.warnings)}`);
  const film = v.film;
  await mkdir(opts.outDir, { recursive: true });
  const cacheDir = join(opts.outDir, "..", ".cinema-cache");

  // 1. narration
  let lines: Record<string, NarratedLine> = {};
  if (!opts.silent && film.narration) lines = await stage("narration", () => narrateFilm(film, cacheDir, { log }));
  const clips: Record<string, LineClip> | null = Object.keys(lines).length ? Object.fromEntries(Object.entries(lines).map(([k, l]) => [k, { durationSeconds: l.durationSeconds, words: l.words }])) : null;
  const rf = resolveFilm(film, clips);
  await writeFile(join(opts.outDir, "timing.json"), JSON.stringify({ measured: rf.measured, durationSeconds: rf.durationSeconds, shots: rf.shots.map((s) => ({ id: s.shot.id, start: s.startSec, end: s.endSec, words: s.words.map((w) => ({ w: w.raw, s: w.start, e: w.end, i: w.interpolated })) })) }, null, 1));

  // 2. sound
  let mix: MixReport | null = null;
  const audioPath = join(opts.outDir, "mix.wav");
  if (!opts.silent) {
    mix = await stage("sound", async () => {
      const work = join(opts.outDir, "audio-work");
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
      return mixFilm({ workDir: work, voice, music, musicUnderVoiceDb: (film.music?.levelDb ?? -18) + 8, sfx: hits, duration: rf.durationSeconds, out: audioPath });
    });
  }

  // 3. picture
  const picture = join(opts.outDir, `picture-${opts.tier.toLowerCase()}.mp4`);
  const { renderMedia, selectComposition, openBrowser, ensureBrowser } = await import("@remotion/renderer");
  const { findLocalHeadlessShell } = await import("@chris/motion");
  const serveUrl = await stage("bundle", () => getCinemaBundle());
  const gl = rendererGl();
  const browserExecutable = findLocalHeadlessShell();
  if (!browserExecutable) await ensureBrowser();
  const browser = await openBrowser("chrome", { browserExecutable, chromiumOptions: { gl } });
  const inputProps = { film, clips, tier: opts.tier, fontBaseUrl: null };
  const concurrency = opts.concurrency ?? (Number(process.env.REMOTION_CONCURRENCY) > 0 ? Number(process.env.REMOTION_CONCURRENCY) : null);
  let width = 0;
  let height = 0;
  let frames = 0;
  try {
    await stage("picture", async () => {
      const composition = await selectComposition({ serveUrl, id: "MiniMovie", inputProps, puppeteerInstance: browser, chromiumOptions: { gl }, logLevel: "error", timeoutInMilliseconds: 120000 });
      width = composition.width;
      height = composition.height;
      frames = opts.frameRange ? opts.frameRange[1] - opts.frameRange[0] + 1 : composition.durationInFrames;
      let last = 0;
      await renderMedia({
        serveUrl,
        composition,
        inputProps,
        codec: "h264",
        crf: opts.tier === "FINAL" ? 16 : 22,
        x264Preset: opts.tier === "FINAL" ? "slow" : "veryfast",
        pixelFormat: "yuv420p",
        colorSpace: "bt709",
        imageFormat: "jpeg",
        jpegQuality: opts.tier === "FINAL" ? 95 : 85,
        muted: true,
        frameRange: opts.frameRange ?? null,
        concurrency,
        puppeteerInstance: browser,
        chromiumOptions: { gl },
        timeoutInMilliseconds: 120000,
        logLevel: "error",
        outputLocation: picture,
        onProgress: ({ progress, renderedFrames }) => {
          if (progress - last >= 0.1) {
            last = progress;
            log(`  picture ${(progress * 100).toFixed(0)}% (${renderedFrames} frames)`);
          }
        },
      });
    });
  } finally {
    await browser.close({ silent: true }).catch(() => undefined);
  }

  // 4. mux
  const output = join(opts.outDir, `${film.id}-${opts.tier.toLowerCase()}.mp4`);
  await stage("mux", async () => {
    // Delivery encode: the picture is a near-lossless mezzanine (film grain makes it ~75 Mbps);
    // platforms re-encode anyway, so deliver high-profile H.264 capped at 12 Mbps (≈ 60 MB/40 s).
    const video = opts.tier === "FINAL" ? ["-c:v", "libx264", "-preset", "slow", "-crf", "19", "-maxrate", "12M", "-bufsize", "24M", "-profile:v", "high", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"] : ["-c:v", "copy"];
    if (mix && !opts.frameRange) await runFfmpeg(["-i", picture, "-i", audioPath, "-map", "0:v", "-map", "1:a", ...video, "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-shortest", "-movflags", "+faststart", output]);
    else await runFfmpeg(["-i", picture, ...video, "-movflags", "+faststart", output]);
    if (opts.tier === "FINAL" && !process.env.CINEMA_KEEP_MEZZANINE) await rm(picture, { force: true });
  });
  const videoSeconds = frames / film.format.fps;
  const report: RenderFilmReport = {
    film: film.id,
    tier: opts.tier,
    output,
    durationSeconds: rf.durationSeconds,
    frames,
    width,
    height,
    timingMeasured: rf.measured,
    stagesMs,
    renderMsPerVideoSecond: Math.round((stagesMs.picture ?? 0) / Math.max(0.001, videoSeconds)),
    mix,
    narration: Object.fromEntries(Object.entries(lines).map(([k, l]) => [k, { seconds: Number(l.durationSeconds.toFixed(3)), heard: l.heard }])),
    host: { cpus: (await import("node:os")).cpus().length, gl, concurrency },
  };
  await writeFile(join(opts.outDir, `report-${opts.tier.toLowerCase()}.json`), JSON.stringify(report, null, 2));
  return report;
}
