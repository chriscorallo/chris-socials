import { mkdtemp, readFile, rm, writeFile, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, basename, extname } from "node:path";
import type { PrismaClient } from "@chris/domain";
import {
  EditTimelineSchema,
  LocalFsStorageAdapter,
  analyzeSubjectTrackDetailed,
  computePersonMatte,
  probeMedia,
  renderTimeline,
  timelineDuration,
  type TranscriptWord,
} from "@chris/media";
import { prepareInteraction, prepareMotion, withResolvedPlacements } from "./render-job";

/**
 * Offline mode of the job runner: the heavy computations without a database or storage —
 * inputs are local files named by a job.json, outputs are written next to it. This is how a
 * snapshot is verified end to end inside a real sandbox (the sandbox can't reach a laptop's
 * database), and it runs the SAME functions the online render uses (withResolvedPlacements →
 * prepareInteraction → prepareMotion → renderTimeline), including MODNet mattes and
 * behind-subject compositing.
 *
 * render job.json:
 *   { "timeline": EditTimeline, "output": "out.mp4",
 *     "assets": [{ "id", "file", "words"?, "subjectTrack"?, "matteFile"? }],
 *     "encode"?: { "preset", "crf" }, "computeMattes"?: true, "trackSubjects"?: true }
 * transcribe / subject-track / person-matte job.json: { "file": "take.mp4", "output"?: "…" }
 * Relative paths resolve against job.json's directory.
 */

type Progress = (p: { pct: number; message: string; stage: string }) => void;

/** A database stand-in: offline jobs never touch the DB; anything that tries is a bug. */
const NO_DB = new Proxy({}, {
  get(_t, prop) {
    throw new Error(`offline mode has no database (tried db.${String(prop)})`);
  },
}) as unknown as PrismaClient;

interface OfflineAsset {
  id: string;
  file: string;
  words?: TranscriptWord[] | null;
  subjectTrack?: unknown;
  matteFile?: string | null;
}

export async function runOffline(kind: string, jobPath: string, progress: Progress = () => undefined): Promise<unknown> {
  const jobDir = dirname(resolve(jobPath));
  const job = JSON.parse(await readFile(jobPath, "utf8")) as Record<string, unknown>;
  const at = (p: unknown) => resolve(jobDir, String(p));
  const started = Date.now();
  let result: unknown;
  switch (kind) {
    case "render":
      result = await offlineRender(job, at, jobDir, progress);
      break;
    case "transcribe": {
      const { LocalWhisperTranscriptionProvider } = await import("@chris/media/transcription");
      const r = await new LocalWhisperTranscriptionProvider().transcribe(at(job.file));
      result = { text: r.text, words: r.words, durationSeconds: r.durationSeconds, model: r.model };
      break;
    }
    case "subject-track": {
      const r = await analyzeSubjectTrackDetailed(at(job.file));
      result = { track: r.track, framesAnalyzed: r.framesAnalyzed, framesWithFace: r.framesWithFace, fps: r.fps, model: r.model, source: r.source };
      break;
    }
    case "person-matte": {
      const out = at(job.output ?? "matte.mp4");
      const r = await computePersonMatte(at(job.file), out);
      result = { ...r, outPath: basename(out) };
      break;
    }
    case "reference-analyze": {
      // { "file": "clip.mp4" } → the measured style metrics (verifies the snapshot can do it).
      const { analyzeReferenceVideoFile } = await import("./reference-analysis-job");
      result = await analyzeReferenceVideoFile(at(job.file));
      break;
    }
    case "film-render": {
      // { "film"?: Film | "proof", "tier"?: "DRAFT"|"PREVIEW"|"FINAL", "chunks"?: n, "frames"?: [a,b], "silent"?: bool, "outDir"?: "film" }
      // Renders a mini-movie end to end with the local pipeline (narration → chunks → assemble).
      const cinema = await loadCinema();
      const film = job.film === "proof" || job.film == null ? cinema.PROOF_FILM : (job.film as import("@chris/cinema").Film);
      const r = await cinema.renderFilm({
        film,
        outDir: at(job.outDir ?? "film"),
        tier: (job.tier as "DRAFT" | "PREVIEW" | "FINAL" | undefined) ?? "PREVIEW",
        chunks: typeof job.chunks === "number" ? job.chunks : 1,
        frameRange: Array.isArray(job.frames) ? (job.frames as [number, number]) : undefined,
        silent: job.silent === true,
        onProgress: progress,
      });
      result = { output: basename(r.output), frames: r.frames, seconds: r.durationSeconds, width: r.width, height: r.height, chunks: r.chunks, stagesMs: r.stagesMs, msPerVideoSecond: r.renderMsPerVideoSecond, mix: r.mix?.final ?? null, host: r.host };
      break;
    }
    case "film-storyboard": {
      // { "film"?: Film | "proof", "stillsPerShot"?: n, "scale"?: 0.5 } → stills + per-shot timing
      const cinema = await loadCinema();
      const film = job.film === "proof" || job.film == null ? cinema.PROOF_FILM : (job.film as import("@chris/cinema").Film);
      const r = await cinema.renderStoryboard({ film, outDir: at(job.outDir ?? "storyboard"), stillsPerShot: typeof job.stillsPerShot === "number" ? job.stillsPerShot : 1, scale: typeof job.scale === "number" ? job.scale : undefined });
      result = { shots: r.shots.map((s) => ({ shotId: s.shotId, startSec: s.startSec, endSec: s.endSec, line: s.line, stills: s.stills.map((x) => basename(x.path)) })), ms: r.ms };
      break;
    }
    default:
      throw new Error(`offline mode supports render, transcribe, subject-track, person-matte, reference-analyze, film-render, film-storyboard (got "${kind}")`);
  }
  const wrapped = { kind, ms: Date.now() - started, result };
  await writeFile(join(jobDir, "result.json"), JSON.stringify(wrapped, null, 2));
  return wrapped;
}

async function offlineRender(job: Record<string, unknown>, at: (p: unknown) => string, jobDir: string, progress: Progress) {
  const timings: Record<string, number> = {};
  const t = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const s = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - s;
    }
  };
  const timeline = EditTimelineSchema.parse(job.timeline);
  const inputs = (job.assets as OfflineAsset[]) ?? [];
  const store = join(jobDir, "store");
  await mkdir(store, { recursive: true });
  const storage = new LocalFsStorageAdapter({ baseDir: store });
  const workDir = await mkdtemp(join(tmpdir(), "chris-offline-"));
  try {
    const sources: Record<string, string> = {};
    const sourceWords: Record<string, TranscriptWord[] | null> = {};
    const assets: Array<{ id: string; storageKey: string; subjectTrack?: unknown; matteStorageKey?: string | null; width?: number | null; height?: number | null; hasAudio?: boolean | null }> = [];
    const needsMatte = timeline.visuals.some((v) => v.depth === "BEHIND_SUBJECT");
    for (const a of inputs) {
      const file = at(a.file);
      const key = `raw/${a.id}${extname(file) || ".mp4"}`;
      await storage.put(key, await readFile(file));
      sources[a.id] = file;
      sourceWords[a.id] = a.words ?? null;
      const probe = await probeMedia(file);
      let subjectTrack = a.subjectTrack ?? null;
      if (subjectTrack == null && job.trackSubjects !== false && timeline.visuals.length > 0) {
        progress({ pct: 5, message: "Finding you in the frame…", stage: "track" });
        subjectTrack = (await t(`track:${a.id}`, () => analyzeSubjectTrackDetailed(file))).track;
      }
      let matteKey: string | null = null;
      if (a.matteFile) {
        matteKey = `mattes/${a.id}.mp4`;
        await storage.put(matteKey, await readFile(at(a.matteFile)));
      } else if (needsMatte && job.computeMattes !== false && probe.width != null) {
        progress({ pct: 8, message: "Cutting you out of the background…", stage: "matte" });
        const out = join(workDir, `matte-src-${a.id}.mp4`);
        await t(`matte:${a.id}`, () => computePersonMatte(file, out));
        matteKey = `mattes/${a.id}.mp4`;
        await storage.put(matteKey, await readFile(out));
        await copyFile(out, join(jobDir, `matte-${a.id}.mp4`));
      }
      assets.push({ id: a.id, storageKey: key, subjectTrack, matteStorageKey: matteKey, width: probe.width, height: probe.height, hasAudio: probe.hasAudio });
    }

    const warnings: string[] = [];
    const placed = withResolvedPlacements(timeline, assets, sourceWords);
    progress({ pct: 10, message: "Measuring the footage for your graphics…", stage: "measure" });
    const interaction =
      placed.visuals.length > 0
        ? await t("interaction", () => prepareInteraction(NO_DB, storage, placed, assets, sources, sourceWords, workDir, warnings, {}))
        : null;
    progress({ pct: 15, message: "Rendering your graphics…", stage: "graphics" });
    const motion = await t("motion", () =>
      prepareMotion(NO_DB, storage, placed, sources, workDir, warnings, { onMotionProgress: (p) => progress({ pct: 15 + 45 * p, message: "Rendering your graphics…", stage: "graphics" }) }, interaction?.input ?? null),
    );
    progress({ pct: 60, message: "Putting your video together…", stage: "compose" });
    const output = at(job.output ?? "out.mp4");
    const r = await t("compose", () =>
      renderTimeline({
        timeline,
        sources,
        sourceWords,
        outputPath: output,
        encode: job.encode as { preset?: string; crf?: number } | undefined,
        visualsLayer: motion.visualsLayer,
        musicPath: motion.musicPath,
        sfxFiles: motion.sfxFiles,
        mattes: interaction?.mattes ?? null,
      }),
    );
    return {
      output: basename(output),
      durationSeconds: r.durationSeconds,
      expectedDurationSeconds: timelineDuration(timeline),
      width: r.width,
      height: r.height,
      warnings: [...warnings, ...r.warnings],
      motion: { ...r.motion, framesRendered: motion.framesRendered, motionRenderMs: motion.renderMs, interaction: interaction?.report ?? null },
      placements: placed.visuals.map((v) => ({ id: v.id, template: v.template, depth: v.depth ?? "FRONT", placement: v.placement })),
      timings,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Snapshot build step: fetch everything a job could need at runtime so a job never downloads
 * (Chrome headless shell, Whisper base.en timestamped, MODNet), then load each once.
 */
export async function warmup(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const s0 = Date.now();
  // @remotion/renderer is a dependency of @chris/motion (installed next to the runner bundle).
  const remotionRenderer = "@remotion/renderer";
  const { ensureBrowser } = (await import(remotionRenderer)) as { ensureBrowser: () => Promise<unknown> };
  await ensureBrowser();
  out.chromeMs = Date.now() - s0;

  const s1 = Date.now();
  const { ensureMatteModel } = await import("@chris/media");
  out.matteModel = await ensureMatteModel({ allowDownload: true });
  out.matteMs = Date.now() - s1;

  // Whisper: transcribe one second of generated tone — loads (downloads) the pipeline.
  const s2 = Date.now();
  const dir = await mkdtemp(join(tmpdir(), "chris-warmup-"));
  try {
    const wav = join(dir, "tone.wav");
    await writeFile(wav, toneWav(1));
    const { LocalWhisperTranscriptionProvider } = await import("@chris/media/transcription");
    const provider = new LocalWhisperTranscriptionProvider();
    await provider.transcribe(wav);
    out.whisperModel = provider.model;
    out.whisperCacheDir = provider.cacheDir;
    out.whisperCached = existsSync(provider.cacheDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  out.whisperMs = Date.now() - s2;

  // Mini-movies: Kokoro (q8 ONNX + tokenizer → TRANSCRIPTION_CACHE_DIR; voices ship in kokoro-js)
  // and the catalog's sentence-embedding model.
  const s3 = Date.now();
  try {
    const cinema = await loadCinema();
    const dir2 = await mkdtemp(join(tmpdir(), "chris-warmup-tts-"));
    try {
      const line = await cinema.synthesizeLine("Warm up.", join(dir2, "warm.wav"), "af_heart", 1, { force: true });
      out.kokoroSeconds = Math.round(line.durationSeconds * 100) / 100;
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
    out.kokoroMs = Date.now() - s3;
    const s4 = Date.now();
    out.catalogMatcher = await cinema.warmCatalogMatcher();
    out.catalogMatcherMs = Date.now() - s4;
  } catch (err) {
    out.cinemaWarmupError = err instanceof Error ? err.message : String(err);
  }
  return out;
}

/** The mini-movie engine through the host's loader (job-runner registers a literal import). */
async function loadCinema(): Promise<typeof import("@chris/cinema")> {
  const injected = (globalThis as { __chrisCinemaLoader?: () => Promise<typeof import("@chris/cinema")> }).__chrisCinemaLoader;
  if (injected) return injected();
  const specifier = ["@chris", "cinema"].join("/");
  return (await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)) as typeof import("@chris/cinema");
}

/** 16 kHz mono 16-bit PCM WAV of a quiet 440 Hz tone. */
function toneWav(seconds: number): Buffer {
  const rate = 16_000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000), 44 + i * 2);
  return buf;
}
