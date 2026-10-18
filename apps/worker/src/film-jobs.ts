import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advancePlannedItemToFilmed,
  analyzeMediaAsset,
  createContentItem,
  createMediaAsset,
  enqueueHeavyJob,
  finishHeavyJob,
  getHeavyJob,
  getHeavyJobs,
  claimQueuedHeavyJob,
  patchHeavyJobSummary,
  recordEditPlan,
  recordTakeSelection,
  type HeavyJobMode,
  type PrismaClient,
} from "@chris/domain";
import { probeMedia as probeMediaFile, type StorageAdapter } from "@chris/media";
import type * as Cinema from "@chris/cinema";
import type { NarratedLine } from "@chris/cinema";
import { chooseChunkCount, estimateFilmRender, formatIssues, planChunks, validateFilm, type Film, type FrameChunk, type LineClip } from "@chris/cinema/pure";
import { filmRenderId, heavyJobSubject, stableHash, type HeavyJobArgsByKind } from "./heavy-job-kinds";
import { renderContentItem } from "./render-job";

/**
 * Mini-movie jobs — the engine the studio crew drives (packages/cinema does the work; this file
 * sequences it against storage + the database):
 *
 *   film-render        prepare (narration + timing + mix) → picture in N frame-range chunks →
 *                      assemble (frame-exact concat + mux) → register as a video. In the cloud the
 *                      chunks run in parallel sandboxes (QUEUED film-render-chunk jobs; this
 *                      worker renders chunk 0 and any it can claim, waits for the rest, retries a
 *                      failed chunk twice, then assembles). On the Mac / locally: one chunk.
 *   film-render-chunk  one frame range of a film-render (manifest in storage).
 *   film-storyboard    keyframe stills per shot + timing + the narration each shot covers.
 *   film-voice-align   Chris's recording → per-shot clips + word timings + a report.
 *
 * Idempotent: everything is keyed by a stable id (filmRenderId / content hash). A finished render
 * is returned as-is; a re-run after a crash reuses the manifest, the mix and every finished chunk.
 * Storage layout: films/<renderId>/{manifest.json, film.json, clips.json, mix.wav, chunks/…,
 * <film>-<tier>.mp4, result.json}; films/storyboards/<id>/…; films/voice/<id>/…
 */

export type CinemaEngine = Pick<typeof Cinema, "prepareFilm" | "renderFilmFrames" | "assembleFilm" | "renderStoryboard" | "narrationFromRecording" | "narrationFromShotRecordings" | "narrateFilm" | "framesFromVideo" | "measureLoudness">;

/** A URL the phone can show for a film file in storage (served by apps/web/app/api/films/file, `films/` keys only). */
export function filmFileUrl(key: string): string {
  return `/api/films/file?key=${encodeURIComponent(key)}`;
}

/** The studio crew's Still shape (packages/agents/src/studio/engine-port.ts). */
export interface PortStill {
  id: string;
  shotId: string;
  point: number;
  url: string;
  caption?: string;
  metrics?: Record<string, unknown>;
}

/** Where the studio's narration recorder keeps Chris's takes for a film (apps/web/app/api/films/narration). */
export const studioNarrationIndexKey = (filmId: string) => `films/studio/${filmId}/narration/index.json`;
export interface StudioNarrationIndex {
  /** One take of the whole script. */
  recordingKey?: string;
  /** Or one take per shot. */
  shots?: Record<string, string>;
  /** Set by a film-voice-align run on the latest take (pre-aligned lines). */
  linesKey?: string;
  updatedAt: string;
}

export interface FilmJobContext {
  db: PrismaClient;
  storage: StorageAdapter;
  actor: { actorId: string };
  jobRunId?: string;
  progress: (pct: number, message: string, stage: string) => void;
  /** Test/host injection (defaults: the real @chris/cinema). */
  engine?: CinemaEngine;
  /** Registration render (default renderContentItem). */
  renderItem?: typeof renderContentItem;
  /** Poll interval while waiting for other chunk workers (ms). */
  pollMs?: number;
  /** Scratch root (default os.tmpdir()). */
  workRoot?: string;
}

export interface FilmJobOutcome {
  ok: boolean;
  result: unknown;
  error?: string;
  message: string;
}

/**
 * The engine is loaded lazily through a non-literal specifier (like the motion engine in
 * render-job.ts) so a bundler that includes this module (apps/web) never pulls Remotion /
 * three / Kokoro into a serverless bundle. Hosts that render register a literal loader
 * (job-runner.ts for the sandbox bundle, film-worker.ts on the Mac).
 */
async function engineOf(ctx: FilmJobContext): Promise<CinemaEngine> {
  if (ctx.engine) return ctx.engine;
  const injected = (globalThis as { __chrisCinemaLoader?: () => Promise<CinemaEngine> }).__chrisCinemaLoader;
  if (injected) return injected();
  const specifier = ["@chris", "cinema"].join("/");
  return (await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)) as CinemaEngine;
}

async function tryGet(storage: StorageAdapter, key: string): Promise<Buffer | null> {
  try {
    return await storage.get(key);
  } catch {
    return null;
  }
}

async function tryGetJson<T>(storage: StorageAdapter, key: string): Promise<T | null> {
  const b = await tryGet(storage, key);
  if (!b) return null;
  try {
    return JSON.parse(b.toString("utf8")) as T;
  } catch {
    return null;
  }
}

const putJson = (storage: StorageAdapter, key: string, v: unknown) => storage.put(key, Buffer.from(JSON.stringify(v, null, 1)), "application/json");

async function download(storage: StorageAdapter, key: string, path: string): Promise<string> {
  if (!existsSync(path)) await writeFile(path, await storage.get(key));
  return path;
}

/** The film from the job args: inline object, or a JSON document in storage. Validated. */
export async function loadFilm(storage: StorageAdapter, src: { film?: unknown; filmKey?: string }): Promise<Film> {
  const raw = src.film ?? JSON.parse((await storage.get(src.filmKey!)).toString("utf8"));
  const v = validateFilm(raw);
  if (!v.ok) throw new FilmInvalidError(formatIssues(v.errors));
  return v.film;
}

export class FilmInvalidError extends Error {
  constructor(details: string) {
    super(`The film script has problems:\n${details}`);
    this.name = "FilmInvalidError";
  }
}

async function jobMode(ctx: FilmJobContext): Promise<HeavyJobMode> {
  if (!ctx.jobRunId) return "inline";
  const j = await getHeavyJob(ctx.db, ctx.jobRunId).catch(() => null);
  return (j?.summary?.mode as HeavyJobMode | undefined) ?? "inline";
}

// ---------------------------------------------------------------------------------------------
// film-render

export interface FilmRenderManifest {
  version: 1;
  renderId: string;
  filmId: string;
  title: string;
  tier: "PREVIEW" | "FINAL";
  fps: number;
  totalFrames: number;
  durationSeconds: number;
  chunks: FrameChunk[];
  filmKey: string;
  clipsKey: string;
  audioKey: string | null;
  createdAt: string;
  estimate: ReturnType<typeof estimateFilmRender>;
  chunkJobRunIds?: Record<string, string>;
}

export interface FilmRenderResult {
  renderId: string;
  videoKey: string;
  frameCount: number;
  durationSeconds: number;
  width: number;
  height: number;
  chunks: number;
  tier: "PREVIEW" | "FINAL";
  contentItemId: string | null;
  mediaAssetId: string | null;
  state: string | null;
  renderStatus: string | null;
  msByStage: Record<string, number>;
  // the studio crew's RenderResult fields
  videoUrl: string;
  posterUrl: string | null;
  loudnessLufs: number | null;
  truePeakDbtp: number | null;
  frames: PortStill[];
  contactSheetUrl: string | null;
}

const prefixOf = (renderId: string) => `films/${renderId}`;
const chunkKey = (m: Pick<FilmRenderManifest, "renderId" | "tier" | "chunks">, i: number) => `${prefixOf(m.renderId)}/chunks/${m.tier.toLowerCase()}-${i}-of-${m.chunks.length}.mp4`;

function maxCloudWorkers(): number {
  const n = Number(process.env.FILM_RENDER_MAX_CHUNKS ?? process.env.HEAVY_JOB_MAX_SANDBOXES);
  return Number.isFinite(n) && n >= 1 ? Math.min(16, Math.floor(n)) : 4;
}

/** Downloads Chris's aligned narration (the film-voice-align output) to local files. */
async function downloadNarration(storage: StorageAdapter, linesKey: string, dir: string): Promise<Record<string, NarratedLine>> {
  const doc = await tryGetJson<{ lines: Record<string, { key: string; durationSeconds: number; words: LineClip["words"]; heard: string }> }>(storage, linesKey);
  if (!doc) throw new Error(`The aligned narration (${linesKey}) wasn't found — sync the recording again.`);
  await mkdir(dir, { recursive: true });
  const out: Record<string, NarratedLine> = {};
  for (const [shotId, l] of Object.entries(doc.lines)) {
    const path = await download(storage, l.key, join(dir, `${shotId}.wav`));
    out[shotId] = { path, durationSeconds: l.durationSeconds, words: l.words, heard: l.heard };
  }
  return out;
}

/**
 * Chris's own voice for a render, from (in order): pre-aligned lines (narrationKey), the studio's
 * per-shot / whole-script takes passed as chrisNarration, or the studio narration recorder's index
 * for this film (films/studio/<filmId>/narration/index.json).
 */
async function resolveChrisNarration(
  args: HeavyJobArgsByKind["film-render"],
  film: Film,
  ctx: FilmJobContext,
  engine: CinemaEngine,
  work: string,
): Promise<{ ok: true; lines: Record<string, NarratedLine> } | { ok: false; error: string; report?: unknown }> {
  const dir = join(work, "chris-voice");
  await mkdir(dir, { recursive: true });
  let linesKey = args.narrationKey ?? null;
  let takes: Record<string, string> | null = args.chrisNarration ?? null;
  if (!linesKey && !takes && args.filmId) {
    const idx = await tryGetJson<StudioNarrationIndex>(ctx.storage, studioNarrationIndexKey(args.filmId));
    if (idx?.linesKey) linesKey = idx.linesKey;
    else if (idx?.shots && Object.keys(idx.shots).length) takes = idx.shots;
    else if (idx?.recordingKey) takes = { "*": idx.recordingKey };
  }
  if (linesKey) return { ok: true, lines: await downloadNarration(ctx.storage, linesKey, dir) };
  if (!takes) return { ok: false, error: "This film is narrated by you — record (or upload) the narration on the film page first, then render." };
  ctx.progress(4, "Syncing the picture to your voice…", "narration");
  const ext = (k: string) => (k.match(/\.[a-z0-9]{2,4}$/i)?.[0] ?? ".m4a").toLowerCase();
  if (takes["*"]) {
    const rec = await download(ctx.storage, takes["*"], join(dir, `take${ext(takes["*"])}`));
    const r = await engine.narrationFromRecording({ film, recordingPath: rec, outDir: dir });
    return r.report.ok ? { ok: true, lines: r.lines } : { ok: false, error: r.report.problems[0] ?? "Your recording didn't line up with the script.", report: r.report };
  }
  const local: Record<string, string> = {};
  for (const [shotId, key] of Object.entries(takes)) local[shotId] = await download(ctx.storage, key, join(dir, `src-${shotId}${ext(key)}`));
  const r = await engine.narrationFromShotRecordings({ film, recordings: local, outDir: dir });
  return r.report.ok ? { ok: true, lines: r.lines } : { ok: false, error: r.report.problems[0] ?? "Some recorded lines didn't match the script.", report: r.report };
}

export async function runFilmRender(args: HeavyJobArgsByKind["film-render"], ctx: FilmJobContext): Promise<FilmJobOutcome> {
  const engine = await engineOf(ctx);
  const renderId = filmRenderId(args);
  const prefix = prefixOf(renderId);
  const msByStage: Record<string, number> = {};
  const t = async <T>(name: string, fn: () => Promise<T>) => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      msByStage[name] = (msByStage[name] ?? 0) + Date.now() - t0;
    }
  };

  const done = await tryGetJson<FilmRenderResult>(ctx.storage, `${prefix}/result.json`);
  // "Send to Videos": attach the finished film to the studio's ContentItem through the normal path
  if (args.attachRenderId) {
    if (!done) return { ok: false, result: { renderId }, error: "That render isn't finished (or was never made) — render the film first.", message: "Nothing to attach yet." };
    if (done.contentItemId === args.contentItemId) return { ok: true, result: { ...done, reused: true }, message: "Already in Videos." };
    const work = join(ctx.workRoot ?? tmpdir(), `chris-film-${renderId}-attach`);
    await mkdir(work, { recursive: true });
    const file = await download(ctx.storage, done.videoKey, join(work, "film.mp4"));
    const film = await loadFilm(ctx.storage, { filmKey: `${prefix}/film.json` });
    ctx.progress(20, "Adding it to your videos…", "register");
    const reg = await registerFilmVideo(ctx.db, ctx.storage, { filePath: file, film, title: film.title, contentItemId: args.contentItemId, renderId, renderItem: ctx.renderItem }, ctx.actor);
    const updated: FilmRenderResult = { ...done, contentItemId: reg.contentItemId, mediaAssetId: reg.mediaAssetId, state: reg.state, renderStatus: reg.renderStatus };
    await putJson(ctx.storage, `${prefix}/result.json`, updated);
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    const okReg = reg.renderStatus === "SUCCESS" && reg.state !== "QC_REPAIR" && reg.state !== "QC_BLOCKED";
    return { ok: okReg, result: updated, error: okReg ? undefined : `Added, but the video's technical check needs a look (${reg.renderError ?? reg.state}).`, message: okReg ? "Your mini-movie is in Videos." : "Added — check the video page." };
  }
  if (done) return { ok: true, result: { ...done, reused: true }, message: "Already rendered — here it is." };

  let film: Film;
  try {
    film = await loadFilm(ctx.storage, args);
  } catch (err) {
    return { ok: false, result: { renderId }, error: (err as Error).message, message: "The film script needs fixing before it can render." };
  }
  const work = join(ctx.workRoot ?? tmpdir(), `chris-film-${renderId}`);
  await mkdir(work, { recursive: true });
  const mode = await jobMode(ctx);

  let manifest = await tryGetJson<FilmRenderManifest>(ctx.storage, `${prefix}/manifest.json`);
  let clips: Record<string, LineClip> | null = null;
  let audioPath: string | null = null;
  if (!manifest) {
    let narration: Record<string, NarratedLine> | undefined;
    if (film.narration?.engine === "CHRIS" || args.narrationKey || args.chrisNarration) {
      const r = await resolveChrisNarration(args, film, ctx, engine, work);
      if (!r.ok) return { ok: false, result: { renderId, report: r.report ?? null }, error: r.error, message: "Waiting for your narration." };
      narration = r.lines;
    }
    ctx.progress(3, film.narration?.engine === "CHRIS" ? "Laying in your narration and the music…" : "Recording the narration and the music…", "prepare");
    const prep = await t("prepare", () => engine.prepareFilm({ film, workDir: work, narration }));
    clips = prep.clips;
    audioPath = prep.audioPath;
    const n = args.chunks ?? (mode === "sandbox" ? chooseChunkCount(prep.rf.durationSeconds, args.tier, maxCloudWorkers()) : 1);
    const chunks = planChunks(prep.rf.totalFrames, n);
    await putJson(ctx.storage, `${prefix}/film.json`, film);
    await putJson(ctx.storage, `${prefix}/clips.json`, clips);
    if (audioPath) await ctx.storage.put(`${prefix}/mix.wav`, await readFile(audioPath), "audio/wav");
    manifest = {
      version: 1,
      renderId,
      filmId: film.id,
      title: args.title ?? film.title,
      tier: args.tier,
      fps: film.format.fps,
      totalFrames: prep.rf.totalFrames,
      durationSeconds: prep.rf.durationSeconds,
      chunks,
      filmKey: `${prefix}/film.json`,
      clipsKey: `${prefix}/clips.json`,
      audioKey: audioPath ? `${prefix}/mix.wav` : null,
      createdAt: new Date().toISOString(),
      estimate: estimateFilmRender({ durationSeconds: prep.rf.durationSeconds, tier: args.tier, host: mode === "sandbox" ? "SANDBOX_8VCPU" : "MAC_GPU", chunks: chunks.length }),
    };
    await putJson(ctx.storage, `${prefix}/manifest.json`, manifest);
  } else {
    clips = await tryGetJson<Record<string, LineClip> | null>(ctx.storage, manifest.clipsKey);
    if (manifest.audioKey) audioPath = await download(ctx.storage, manifest.audioKey, join(work, "mix.wav"));
  }
  const m = manifest;
  if (ctx.jobRunId) await patchHeavyJobSummary(ctx.db, ctx.jobRunId, { result: { renderId, estimate: m.estimate, chunks: m.chunks.length } }).catch(() => undefined);

  // --- picture: chunk 0 here; the others in parallel workers (cloud) or here too (Mac / local)
  const chunkFile = (i: number) => join(work, "chunks", `${i}.mp4`);
  const have = new Set<number>();
  for (const c of m.chunks) if (await tryGet(ctx.storage, chunkKey(m, c.index)).then((b) => !!b)) have.add(c.index);
  const chunkJobs: Record<number, { id: string; attempt: number }> = {};
  const parallel = mode === "sandbox" && m.chunks.length > 1;
  if (parallel) {
    for (const c of m.chunks.slice(1)) {
      if (have.has(c.index)) continue;
      const q = await enqueueHeavyJob(ctx.db, { subject: heavyJobSubject("film-render-chunk", { renderId, chunkIndex: c.index }), jobKind: "film-render-chunk", args: { renderId, chunkIndex: c.index }, mode: "sandbox", actorId: ctx.actor.actorId, message: `Waiting for a cloud worker (part ${c.index + 1} of ${m.chunks.length})…` });
      chunkJobs[c.index] = { id: q.queued ? q.jobRunId : q.activeJobRunId, attempt: 1 };
    }
  }
  const framesDone = () => m.chunks.filter((c) => have.has(c.index)).reduce((s, c) => s + c.end - c.start + 1, 0);
  let current = 0;
  const report = (extra = 0) => ctx.progress(10 + (82 * (framesDone() + extra)) / m.totalFrames, `Rendering the picture… ${Math.round(((framesDone() + extra) / m.totalFrames) * 100)}%${m.chunks.length > 1 ? ` (${have.size}/${m.chunks.length} parts)` : ""}`, "picture");
  const renderHere = async (c: FrameChunk) => {
    await mkdir(join(work, "chunks"), { recursive: true });
    await t("picture", () =>
      engine.renderFilmFrames({ film, clips, tier: m.tier, frameRange: [c.start, c.end], outPath: chunkFile(c.index), onProgress: (f) => {
        current = f * (c.end - c.start + 1);
        report(current);
      } }),
    );
    current = 0;
    await ctx.storage.put(chunkKey(m, c.index), await readFile(chunkFile(c.index)), "video/mp4");
    have.add(c.index);
    report();
  };
  const deadline = Number(process.env.SANDBOX_DEADLINE_MS) || 0;
  const pollMs = ctx.pollMs ?? 5000;
  while (have.size < m.chunks.length) {
    const mine = m.chunks.find((c) => !have.has(c.index) && (!parallel || c.index === 0 || !chunkJobs[c.index]));
    if (mine) {
      await renderHere(mine);
      continue;
    }
    // claim one of this film's queued chunks and render it here (no idle VM while parts wait)
    const subjects = m.chunks.filter((c) => !have.has(c.index)).map((c) => heavyJobSubject("film-render-chunk", { renderId, chunkIndex: c.index }));
    const claimed = parallel ? await claimQueuedHeavyJob(ctx.db, { kinds: ["film-render-chunk"], subjects }).catch(() => null) : null;
    if (claimed) {
      const idx = Number((claimed.args as { chunkIndex: number }).chunkIndex);
      const c = m.chunks[idx]!;
      try {
        await renderHere(c);
        await finishHeavyJob(ctx.db, claimed.jobRunId, { status: "SUCCEEDED", result: { renderId, chunkIndex: idx, renderedBy: ctx.jobRunId ?? null }, message: "Rendered." });
      } catch (err) {
        await finishHeavyJob(ctx.db, claimed.jobRunId, { status: "FAILED", error: (err as Error).message });
        throw err;
      }
      continue;
    }
    // wait for the other workers; re-queue a failed part (twice), then render it here
    for (const c of m.chunks) if (!have.has(c.index) && (await tryGet(ctx.storage, chunkKey(m, c.index)))) have.add(c.index);
    const views = await getHeavyJobs(ctx.db, Object.values(chunkJobs).map((j) => j.id));
    for (const [k, j] of Object.entries(chunkJobs)) {
      const idx = Number(k);
      if (have.has(idx)) continue;
      const v = views.find((x) => x.id === j.id);
      if (v?.status === "FAILED") {
        if (j.attempt < 3) {
          const q = await enqueueHeavyJob(ctx.db, { subject: heavyJobSubject("film-render-chunk", { renderId, chunkIndex: idx }), jobKind: "film-render-chunk", args: { renderId, chunkIndex: idx, attempt: j.attempt + 1 }, mode: "sandbox", actorId: ctx.actor.actorId });
          chunkJobs[idx] = { id: q.queued ? q.jobRunId : q.activeJobRunId, attempt: j.attempt + 1 };
        } else {
          delete chunkJobs[idx];
        }
      }
    }
    if (deadline && Date.now() > deadline - 4 * 60_000) {
      return { ok: false, result: { renderId, partsDone: have.size, parts: m.chunks.length }, error: `Ran out of cloud time with ${have.size} of ${m.chunks.length} parts rendered. Start it again — finished parts are kept.`, message: "Not finished yet — run it again to continue." };
    }
    report();
    await new Promise((r) => setTimeout(r, pollMs));
  }

  // --- assemble
  ctx.progress(93, "Putting the film together…", "assemble");
  const paths: string[] = [];
  await mkdir(join(work, "chunks"), { recursive: true });
  for (const c of m.chunks) paths.push(await download(ctx.storage, chunkKey(m, c.index), chunkFile(c.index)));
  const outPath = join(work, `${m.filmId}-${m.tier.toLowerCase()}.mp4`);
  const asm = await t("assemble", () => engine.assembleFilm({ chunkPaths: paths, audioPath, outPath, expectedFrames: m.totalFrames, fps: m.fps, workDir: join(work, "assemble") }));
  const videoKey = `${prefix}/${m.filmId}-${m.tier.toLowerCase()}.mp4`;
  await ctx.storage.put(videoKey, await readFile(outPath), "video/mp4");
  const probe = await probeMediaFile(outPath);
  // review material for the crew: a measured frame per shot, a captioned contact sheet, a poster, loudness
  ctx.progress(95, "Checking the frames and the sound…", "review");
  const review = await t("review", () => engine.framesFromVideo({ film, clips, videoPath: outPath, outDir: join(work, "review") }));
  const frames: PortStill[] = [];
  for (const s of review.shots) {
    const st = s.stills[0]!;
    const key = `${prefix}/review/${s.shotId}-${st.frame}.jpg`;
    await ctx.storage.put(key, await readFile(st.path), "image/jpeg");
    frames.push({ id: `${renderId}:${s.shotId}:${st.frame}`, shotId: s.shotId, point: st.point, url: filmFileUrl(key), ...(s.line ? { caption: s.line } : {}), ...(st.metrics ? { metrics: st.metrics as unknown as Record<string, unknown> } : {}) });
  }
  const sheetKey = `${prefix}/review/contact-sheet.jpg`;
  await ctx.storage.put(sheetKey, await readFile(review.sheet), "image/jpeg");
  const posterKey = `${prefix}/poster.jpg`;
  await ctx.storage.put(posterKey, await readFile(review.poster), "image/jpeg");
  const loud = audioPath ? await engine.measureLoudness(outPath).catch(() => null) : null;

  // --- register as a video
  let reg: Awaited<ReturnType<typeof registerFilmVideo>> | null = null;
  if (args.register ?? !args.filmId) {
    ctx.progress(96, "Adding it to your videos…", "register");
    reg = await t("register", () => registerFilmVideo(ctx.db, ctx.storage, { filePath: outPath, film, title: m.title, contentItemId: args.contentItemId, renderId, renderItem: ctx.renderItem }, ctx.actor));
  }
  const result: FilmRenderResult = {
    renderId,
    videoKey,
    frameCount: asm.frames,
    durationSeconds: asm.videoSeconds,
    width: probe.width ?? 0,
    height: probe.height ?? 0,
    chunks: m.chunks.length,
    tier: m.tier,
    contentItemId: reg?.contentItemId ?? null,
    mediaAssetId: reg?.mediaAssetId ?? null,
    state: reg?.state ?? null,
    renderStatus: reg?.renderStatus ?? null,
    msByStage,
    videoUrl: filmFileUrl(videoKey),
    posterUrl: filmFileUrl(posterKey),
    loudnessLufs: loud && Number.isFinite(loud.integratedLufs) ? loud.integratedLufs : null,
    truePeakDbtp: loud && Number.isFinite(loud.truePeakDb) ? loud.truePeakDb : null,
    frames,
    contactSheetUrl: filmFileUrl(sheetKey),
  };
  await putJson(ctx.storage, `${prefix}/result.json`, result);
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
  const registered = !reg || (reg.renderStatus === "SUCCESS" && reg.state !== "QC_REPAIR" && reg.state !== "QC_BLOCKED");
  return {
    ok: registered,
    result,
    error: registered ? undefined : `The film rendered, but adding it to your videos failed its technical check (${reg?.renderError ?? "see the video page"}).`,
    message: reg ? (registered ? "Your mini-movie is in Videos." : "Rendered — the video's technical check needs a look.") : "Rendered.",
  };
}

// ---------------------------------------------------------------------------------------------
// film-render-chunk

export async function runFilmRenderChunk(args: HeavyJobArgsByKind["film-render-chunk"], ctx: FilmJobContext): Promise<FilmJobOutcome> {
  const engine = await engineOf(ctx);
  const m = await tryGetJson<FilmRenderManifest>(ctx.storage, `${prefixOf(args.renderId)}/manifest.json`);
  if (!m) return { ok: false, result: args, error: `No render ${args.renderId} to render a part of.`, message: "Nothing to render." };
  const c = m.chunks[args.chunkIndex];
  if (!c) return { ok: false, result: args, error: `Render ${args.renderId} has no part ${args.chunkIndex}.`, message: "Nothing to render." };
  const key = chunkKey(m, c.index);
  if (await tryGet(ctx.storage, key)) return { ok: true, result: { ...args, key, reused: true }, message: "Already rendered." };
  const work = join(ctx.workRoot ?? tmpdir(), `chris-film-${args.renderId}-part${c.index}`);
  await mkdir(work, { recursive: true });
  const film = await loadFilm(ctx.storage, { filmKey: m.filmKey });
  const clips = await tryGetJson<Record<string, LineClip> | null>(ctx.storage, m.clipsKey);
  const out = join(work, "part.mp4");
  const t0 = Date.now();
  await engine.renderFilmFrames({ film, clips, tier: m.tier, frameRange: [c.start, c.end], outPath: out, onProgress: (f) => ctx.progress(5 + 90 * f, `Rendering part ${c.index + 1} of ${m.chunks.length}… ${Math.round(f * 100)}%`, "picture") });
  await ctx.storage.put(key, await readFile(out), "video/mp4");
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
  return { ok: true, result: { ...args, key, frames: c.end - c.start + 1, ms: Date.now() - t0 }, message: `Rendered part ${c.index + 1} of ${m.chunks.length}.` };
}

// ---------------------------------------------------------------------------------------------
// film-storyboard

export async function runFilmStoryboard(args: HeavyJobArgsByKind["film-storyboard"], ctx: FilmJobContext): Promise<FilmJobOutcome> {
  const engine = await engineOf(ctx);
  let film: Film;
  try {
    film = await loadFilm(ctx.storage, args);
  } catch (err) {
    return { ok: false, result: {}, error: (err as Error).message, message: "The film script needs fixing first." };
  }
  const id = `sb-${stableHash(JSON.stringify([film, args.tier ?? "PREVIEW", args.stillsPerShot ?? 1, args.shots ?? null, args.points ?? null, args.narrate ?? false, args.scale ?? 0.5]))}`;
  const prefix = `films/storyboards/${id}`;
  const done = await tryGetJson<Record<string, unknown>>(ctx.storage, `${prefix}/result.json`);
  if (done) return { ok: true, result: { ...done, reused: true }, message: "Storyboard ready." };
  const work = join(ctx.workRoot ?? tmpdir(), `chris-${id}`);
  await mkdir(work, { recursive: true });
  let clips: Record<string, LineClip> | null = null;
  if (args.narrate && film.narration?.engine === "KOKORO") {
    ctx.progress(5, "Timing the narration…", "narration");
    const lines = await engine.narrateFilm(film, join(work, ".cinema-cache"));
    clips = Object.fromEntries(Object.entries(lines).map(([k, l]) => [k, { durationSeconds: l.durationSeconds, words: l.words }]));
  }
  ctx.progress(15, "Sketching each shot…", "storyboard");
  const sb = await engine.renderStoryboard({ film, clips, outDir: join(work, "stills"), tier: args.tier ?? "PREVIEW", stillsPerShot: args.stillsPerShot, points: args.points, shots: args.shots, scale: args.scale, onProgress: (d, total) => ctx.progress(15 + (75 * d) / Math.max(1, total), `Sketching… ${d} of ${total}`, "storyboard") });
  ctx.progress(92, "Saving the storyboard…", "upload");
  const shots = [];
  for (const s of sb.shots) {
    const stills = [];
    for (const st of s.stills) {
      const key = `${prefix}/${s.shotId}-${st.frame}.jpg`;
      await ctx.storage.put(key, await readFile(st.path), "image/jpeg");
      stills.push({ frame: st.frame, time: st.time, key, point: st.point, ...(st.metrics ? { metrics: st.metrics } : {}) });
    }
    shots.push({ shotId: s.shotId, index: s.index, sceneId: s.sceneId, startSec: s.startSec, endSec: s.endSec, purpose: s.purpose, line: s.line, words: s.words, stills });
  }
  const sheetKey = `${prefix}/storyboard.jpg`;
  if (existsSync(sb.sheet)) await ctx.storage.put(sheetKey, await readFile(sb.sheet), "image/jpeg");
  // the studio crew's StoryboardResult: { stills: Still[], contactSheetUrl } (+ the engine's richer per-shot view)
  const portStills: PortStill[] = shots.flatMap((s) => s.stills.map((st) => ({ id: `${id}:${s.shotId}:${st.frame}`, shotId: s.shotId, point: st.point, url: filmFileUrl(st.key), ...(s.line ? { caption: s.line } : {}), ...(st.metrics ? { metrics: st.metrics as unknown as Record<string, unknown> } : {}) })));
  const result = { storyboardId: id, stills: portStills, contactSheetUrl: existsSync(sb.sheet) ? filmFileUrl(sheetKey) : null, shots, sheetKey, timingMeasured: sb.timingMeasured, durationSeconds: sb.durationSeconds, ms: sb.ms };
  await putJson(ctx.storage, `${prefix}/result.json`, result);
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
  return { ok: true, result, message: `Storyboard ready (${shots.length} shots).` };
}

// ---------------------------------------------------------------------------------------------
// film-voice-align

export async function runFilmVoiceAlign(args: HeavyJobArgsByKind["film-voice-align"], ctx: FilmJobContext): Promise<FilmJobOutcome> {
  const engine = await engineOf(ctx);
  let film: Film;
  try {
    film = await loadFilm(ctx.storage, args);
  } catch (err) {
    return { ok: false, result: {}, error: (err as Error).message, message: "The film script needs fixing first." };
  }
  const id = `va-${stableHash(JSON.stringify([film.scenes.flatMap((s) => s.shots.map((x) => [x.id, x.line ?? null])), args.recordingKey]))}`;
  const prefix = `films/voice/${id}`;
  const work = join(ctx.workRoot ?? tmpdir(), `chris-${id}`);
  await mkdir(work, { recursive: true });
  ctx.progress(5, "Listening to your recording…", "transcribe");
  const ext = (args.recordingKey.match(/\.[a-z0-9]{2,4}$/i)?.[0] ?? ".m4a").toLowerCase();
  const rec = await download(ctx.storage, args.recordingKey, join(work, `recording${ext}`));
  const { lines, report } = await engine.narrationFromRecording({ film, recordingPath: rec, outDir: work });
  if (!report.ok) {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, result: { report }, error: report.problems[0] ?? "The recording didn't match the script.", message: "Your recording didn't line up with the script." };
  }
  ctx.progress(80, "Saving your lines…", "upload");
  const doc: { lines: Record<string, { key: string; durationSeconds: number; words: LineClip["words"]; heard: string }>; report: typeof report; recordingKey: string } = { lines: {}, report, recordingKey: args.recordingKey };
  for (const [shotId, l] of Object.entries(lines)) {
    const key = `${prefix}/${shotId}.wav`;
    await ctx.storage.put(key, await readFile(l.path), "audio/wav");
    doc.lines[shotId] = { key, durationSeconds: l.durationSeconds, words: l.words, heard: l.heard };
  }
  const linesKey = `${prefix}/lines.json`;
  await putJson(ctx.storage, linesKey, doc);
  // the studio's recorder: remember the aligned lines for this film's latest take (render reuses them)
  if (args.filmId) {
    const idx = await tryGetJson<StudioNarrationIndex>(ctx.storage, studioNarrationIndexKey(args.filmId));
    if (idx && idx.recordingKey === args.recordingKey) await putJson(ctx.storage, studioNarrationIndexKey(args.filmId), { ...idx, linesKey, updatedAt: new Date().toISOString() });
  }
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
  const warn = report.problems.length ? ` ${report.problems.join(" ")}` : "";
  return { ok: true, result: { linesKey, report }, message: `Synced ${Object.keys(lines).length} lines (${Math.round(report.matchedRatio * 100)}% of the script heard).${warn}` };
}

// ---------------------------------------------------------------------------------------------
// registration: the finished film becomes a video, through the normal path

/** The edit plan for an already-finished film: the whole take, no cuts, no captions (they're in
 * the picture), no added graphics/music, audio left as mastered (−14 LUFS). */
export function filmPassthroughPlan(durationSeconds: number, filmTitle: string) {
  const d = Math.max(0.5, Math.round(durationSeconds * 1000) / 1000);
  return {
    origin: "MINI_MOVIE",
    segments: [{ startSeconds: 0, endSeconds: d }],
    targetDimensions: null,
    textOverlays: [],
    captions: { enabled: false, style: "CLEAN", position: "LOWER" },
    punchIns: [],
    normalizeAudio: false,
    bRollRequests: [],
    musicTrack: null,
    sfxEvents: [],
    transitions: [],
    targetDurationSeconds: d,
    productionTier: "RAW",
    doNothingElse: true,
    rationale: `Mini-movie "${filmTitle}" rendered by the studio engine: the finished film is used as-is (captions, score and mix are already in it).`,
  };
}

/**
 * Registers a finished film as a video Chris can schedule — the same steps an uploaded take
 * goes through, no state shortcuts:
 *   ContentItem (format "Mini-movie", footage-first walk to FILMED — its contract keeps
 *   STANDARD research / MEDIUM risk, so the FACTUAL hard gate still needs the narration's claims
 *   checked before publishing) → RAW_TAKE MediaAsset (raw/<item>/film-<renderId>.mp4) →
 *   analyzed (→ MEDIA_INGESTED) → take selected (→ TAKE_SELECTED) → a no-cuts EditPlan
 *   (→ EDIT_PLANNED) → the normal render + technical QC (→ RENDERED).
 * Stops at RENDERED: READY needs the quality gate (facts, brand, creative) like every video.
 * Idempotent per renderId: an item that already has this film as a take is reused.
 */
export async function registerFilmVideo(
  db: PrismaClient,
  storage: StorageAdapter,
  input: { filePath: string; film: Film; title: string; contentItemId?: string; renderId: string; renderItem?: typeof renderContentItem },
  actor: { actorId: string },
): Promise<{ contentItemId: string; mediaAssetId: string; state: string; renderStatus: string | null; renderError: string | null }> {
  const fileName = `film-${input.renderId}.mp4`;
  const existing = await db.mediaAsset.findFirst({ where: { storageKey: { endsWith: `/${fileName}` }, kind: "RAW_TAKE", ...(input.contentItemId ? { contentItemId: input.contentItemId } : {}) }, orderBy: { createdAt: "desc" } });
  let itemId = existing?.contentItemId ?? input.contentItemId ?? null;
  if (!itemId) {
    const item = await createContentItem(db, { title: input.title.slice(0, 200), description: [input.film.logline, `Mini-movie made in the studio (film "${input.film.id}", render ${input.renderId}).`].filter(Boolean).join(" "), format: "Mini-movie" }, actor);
    itemId = item.id;
  }
  await advancePlannedItemToFilmed(db, itemId, actor);
  let asset = existing;
  if (!asset) {
    const key = `raw/${itemId}/${fileName}`;
    const bytes = await readFile(input.filePath);
    await storage.put(key, bytes, "video/mp4");
    asset = await createMediaAsset(db, { contentItemId: itemId, kind: "RAW_TAKE", storageKey: key, originalFilename: `${input.film.id}.mp4`, mimeType: "video/mp4", sizeBytes: bytes.length }, actor);
    const p = await probeMediaFile(input.filePath);
    await analyzeMediaAsset(db, asset.id, { durationSeconds: p.durationSeconds, width: p.width, height: p.height, frameRate: p.frameRate, hasAudio: p.hasAudio, videoCodec: p.videoCodec, audioCodec: p.audioCodec, transcript: input.film.scenes.flatMap((s) => s.shots.map((x) => x.line).filter(Boolean)).join(" ") }, actor);
  }
  let item = await db.contentItem.findUniqueOrThrow({ where: { id: itemId } });
  if (item.currentState === "MEDIA_INGESTED") {
    await recordTakeSelection(db, { contentItemId: itemId, selectedMediaAssetId: asset.id, confidence: 1, reason: "Mini-movie: the finished film is the take", materialDefects: [] }, actor);
    item = await db.contentItem.findUniqueOrThrow({ where: { id: itemId } });
  }
  if (item.currentState === "TAKE_SELECTED") {
    const sel = await db.takeSelection.findFirstOrThrow({ where: { contentItemId: itemId }, orderBy: { createdAt: "desc" } });
    const plan = filmPassthroughPlan(asset.durationSeconds ?? 0, input.film.title);
    await recordEditPlan(db, { contentItemId: itemId, takeSelectionId: sel.id, productionTier: "RAW", targetDurationSeconds: plan.targetDurationSeconds, doNothingElse: true, plan }, actor);
    item = await db.contentItem.findUniqueOrThrow({ where: { id: itemId } });
  }
  let renderStatus: string | null;
  let renderError: string | null = null;
  if (item.currentState === "EDIT_PLANNED") {
    const r = await (input.renderItem ?? renderContentItem)(db, storage, itemId, {}, actor);
    renderStatus = r.status;
    renderError = r.errorMessage ?? null;
    item = await db.contentItem.findUniqueOrThrow({ where: { id: itemId } });
  } else {
    const last = await db.render.findFirst({ where: { contentItemId: itemId }, orderBy: { createdAt: "desc" } });
    renderStatus = last?.status ?? null;
  }
  return { contentItemId: itemId, mediaAssetId: asset.id, state: item.currentState, renderStatus, renderError };
}
