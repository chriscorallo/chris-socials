import { updateHeavyJobProgress, finishHeavyJob, type PrismaClient } from "@chris/domain";
import type { ModelProvider, TranscriptionProvider } from "@chris/agents";
import type { StorageAdapter } from "@chris/media";
import { renderContentItem, type MotionOptions, type RenderJobResult } from "./render-job";
import { runQualityGateForContentItem } from "./quality-gate-job";
import { autoRepairContentItem } from "./auto-repair-job";
import { transcribeMediaAsset, transcribeContentItemTakes, type TranscribeJobResult } from "./transcribe-job";
import { ensureSubjectTracks, type SubjectAnalyzer, type SubjectTrackJobResult } from "./subject-track-job";
import { ensureTakeUnderstandings, isTakeUnderstandingEnabled, type TakeUnderstandingJobResult, type UnderstandingAnalyzer } from "./take-understanding-job";
import { ensurePersonMattes, type MatteComputer, type PersonMatteJobResult } from "./person-matte-job";
import { ensurePreviewProxies, type PreviewMaker, type PreviewProxyJobResult } from "./preview-proxy-job";
import { bakeGraphicsForContentItem } from "./graphics-bake-job";
import { designMotionForContentItem } from "./motion-design-job";
import { analyzePendingReferenceVideos } from "./reference-analysis-job";
import { maybeAutoStyleCut, type StyleCutOutcome } from "./style-cut-job";
import { reviewReferenceAsViewer, reviewRenderAsViewer } from "./viewer-review-job";
import { HEAVY_JOB_LABEL, parseHeavyJobArgs, type HeavyJobArgsByKind, type HeavyJobKind } from "./heavy-job-kinds";
import { runFilmRender, runFilmRenderChunk, runFilmStoryboard, runFilmVoiceAlign, type CinemaEngine, type FilmJobContext } from "./film-jobs";

/**
 * Runs one heavy job against a real database + storage. The SAME function runs in-process
 * (local `next dev`, tests) and inside the Vercel Sandbox (job-runner.ts) — so the cloud path
 * is the local path, not a re-implementation. Every job delegates to the existing worker job
 * (renderContentItem, runQualityGateForContentItem, …), which persists through the domain
 * layer exactly as before; this only sequences, reports progress and shapes a small result.
 * Never throws for an expected failure: `{ ok: false, error }` with a sentence for Chris.
 */

export interface HeavyJobProgressUpdate {
  pct: number;
  message: string;
  stage: string;
}

export interface HeavyJobContext {
  db: PrismaClient;
  storage: StorageAdapter;
  actor: { actorId: string };
  /** Lazily built (only jobs that call a model need it). */
  modelProvider?: () => ModelProvider;
  progress?: (p: HeavyJobProgressUpdate) => void;
  /** Test/host injection points. */
  motion?: MotionOptions;
  transcriptionProvider?: TranscriptionProvider & { model?: string };
  analyze?: SubjectAnalyzer;
  computeMatte?: MatteComputer;
  makePreview?: PreviewMaker;
  /** Director chat take understanding (tests inject a fake). */
  understand?: UnderstandingAnalyzer;
  encode?: { preset?: string; crf?: number };
  fontPath?: string;
  /** The JobRun this execution is recorded on (set by runHeavyJobRecorded). */
  jobRunId?: string;
  /** Mini-movie engine injection (tests); default the real @chris/cinema. */
  cinema?: CinemaEngine;
  /** Mini-movie job options (tests: a fast poll, a scratch dir, a fake registration render). */
  film?: Pick<FilmJobContext, "pollMs" | "workRoot" | "renderItem">;
}

export interface HeavyJobOutcome {
  ok: boolean;
  /** Small JSON result (stored on the JobRun). */
  result: unknown;
  /** Plain-English failure reason (when !ok). */
  error?: string;
  /** Plain-English final line ("Rendered.", "Transcribed 2 takes."). */
  message: string;
}

function needModel(ctx: HeavyJobContext): ModelProvider {
  if (!ctx.modelProvider) throw new Error("This job needs the AI service, but no model provider is configured (ANTHROPIC_API_KEY).");
  return ctx.modelProvider();
}

function slimRender(r: RenderJobResult) {
  return {
    status: r.status,
    outputStorageKey: r.outputStorageKey ?? null,
    errorMessage: r.errorMessage ?? null,
    unexecutedInstructions: r.unexecutedInstructions ?? [],
  };
}

async function stateOf(db: PrismaClient, contentItemId: string) {
  return (await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId }, select: { currentState: true } })).currentState;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export async function executeHeavyJob<K extends HeavyJobKind>(kind: K, rawArgs: unknown, ctx: HeavyJobContext): Promise<HeavyJobOutcome> {
  const args = parseHeavyJobArgs(kind, rawArgs) as HeavyJobArgsByKind[HeavyJobKind];
  const progress = (pct: number, message: string, stage: string) => {
    try {
      ctx.progress?.({ pct, message, stage });
    } catch {
      // best effort
    }
  };
  progress(1, `${HEAVY_JOB_LABEL[kind]}…`, "start");
  const { db, storage, actor } = ctx;

  switch (kind) {
    case "render": {
      const a = args as HeavyJobArgsByKind["render"];
      const check = a.thenQualityGate === true;
      // With a quality check after it, the render is the first ~85% of the job.
      const scale = check ? 0.85 : 1;
      const r = await renderContentItem(
        db,
        storage,
        a.contentItemId,
        {
          fontPath: ctx.fontPath,
          encode: ctx.encode,
          motion: ctx.motion,
          onProgress: (p) => progress(p.pct * scale, p.message, "render"),
        },
        actor,
      );
      const render = slimRender(r);
      if (r.status !== "SUCCESS") {
        return {
          ok: false,
          result: { render, state: await stateOf(db, a.contentItemId) },
          error: `The render didn't pass its technical check: ${(r.errorMessage ?? "see the video page for details").replace(/\.+$/, "")}.`,
          message: "Render failed.",
        };
      }
      if (!check) return { ok: true, result: { render, state: await stateOf(db, a.contentItemId) }, message: "Rendered." };
      progress(87, "Checking facts, brand, picture and sound…", "check");
      try {
        const gate = await runQualityGateForContentItem(db, storage, needModel(ctx), a.contentItemId, actor);
        const state = await stateOf(db, a.contentItemId);
        return {
          ok: true,
          result: { render, state, gate: { overallStatus: gate.overallStatus, gates: gate.gates, reasons: gate.reasons, passed: state === "READY" || gate.overallStatus === "PASS" } },
          message: gate.overallStatus === "PASS" ? "Rendered and passed every check." : "Rendered — the quality check found something to fix.",
        };
      } catch (err) {
        return {
          ok: false,
          result: { render, state: await stateOf(db, a.contentItemId), gateError: { name: err instanceof Error ? err.name : "Error", message: errMsg(err) } },
          error: errMsg(err),
          message: "Rendered, but the quality check couldn't run.",
        };
      }
    }

    case "quality-gate": {
      const a = args as HeavyJobArgsByKind["quality-gate"];
      progress(10, "Checking facts, brand, picture and sound…", "check");
      const gate = await runQualityGateForContentItem(db, storage, needModel(ctx), a.contentItemId, actor, { lateCheck: a.lateCheck === true });
      const state = await stateOf(db, a.contentItemId);
      return {
        ok: true,
        result: { overallStatus: gate.overallStatus, gates: gate.gates, reasons: gate.reasons, state, passed: state === "READY" || gate.overallStatus === "PASS" },
        message: gate.overallStatus === "PASS" ? "Passed every check." : "The quality check found something to fix.",
      };
    }

    case "auto-repair": {
      const a = args as HeavyJobArgsByKind["auto-repair"];
      progress(5, "Fixing what the quality check found, then re-rendering…", "repair");
      const r = await autoRepairContentItem(db, storage, needModel(ctx), a.contentItemId, { fontPath: ctx.fontPath }, actor);
      return {
        ok: r.finalState === "READY",
        result: r,
        error: r.finalState === "READY" ? undefined : `Auto-repair stopped at ${r.finalState}: ${r.stoppedBecause ?? "see the video page"}`,
        message: r.finalState === "READY" ? "Fixed — it passed every check." : "Auto-repair stopped.",
      };
    }

    case "transcribe": {
      const a = args as HeavyJobArgsByKind["transcribe"];
      progress(5, "Transcribing what you said…", "transcribe");
      const results = a.mediaAssetId
        ? [await transcribeMediaAsset(db, storage, a.mediaAssetId, { provider: ctx.transcriptionProvider }, actor)]
        : await transcribeContentItemTakes(db, storage, a.contentItemId, { provider: ctx.transcriptionProvider, force: a.force }, actor);
      if (results.some((r) => r.status === "SUCCESS")) await maybeAutoStyleCut(db, storage, a.contentItemId, actor, { provider: ctx.modelProvider ?? null });
      return outcomeOf("transcribe", results.map(slimTranscribe), "Transcription failed", (n) => `Transcribed ${plural(n, "take")}.`);
    }

    case "subject-track": {
      const a = args as HeavyJobArgsByKind["subject-track"];
      const ids = a.mediaAssetIds ?? (await rawTakeIds(db, a.contentItemId));
      progress(5, "Finding you in the frame…", "track");
      const results = await ensureSubjectTracks(db, storage, ids, actor, { analyze: ctx.analyze, force: a.force });
      return outcomeOf("track", results, "Face tracking failed", (n) => `Tracked ${plural(n, "take")}.`);
    }

    case "take-understand": {
      const a = args as HeavyJobArgsByKind["take-understand"];
      const ids = a.mediaAssetIds ?? (await rawTakeIds(db, a.contentItemId));
      progress(5, "Reading your face and moves…", "understand");
      const results = await ensureTakeUnderstandings(db, storage, ids, actor, { analyze: ctx.understand, force: a.force });
      return outcomeOf("understand", results, "Reading your face failed", (n) => `Read ${plural(n, "take")}.`);
    }

    case "person-matte": {
      const a = args as HeavyJobArgsByKind["person-matte"];
      progress(5, "Cutting you out of the background…", "matte");
      const target = a.mediaAssetIds ? { mediaAssetIds: a.mediaAssetIds } : { contentItemId: a.contentItemId };
      const results = await ensurePersonMattes(db, storage, target, actor, { compute: ctx.computeMatte, force: a.force });
      return outcomeOf("matte", results, "Person cut-out failed", (n) => `Cut out ${plural(n, "take")}.`);
    }

    case "preview-proxy": {
      const a = args as HeavyJobArgsByKind["preview-proxy"];
      progress(5, "Preparing a fast preview of your footage…", "proxy");
      const target = a.mediaAssetIds ? { mediaAssetIds: a.mediaAssetIds } : { contentItemId: a.contentItemId };
      const results = await ensurePreviewProxies(db, storage, target, actor, { make: ctx.makePreview, force: a.force });
      return outcomeOf("proxy", results, "Preview proxy failed", (n) => `Prepared fast previews for ${plural(n, "take")}.`);
    }

    case "graphics-bake": {
      const a = args as HeavyJobArgsByKind["graphics-bake"];
      progress(5, "Preparing your graphics for a smooth preview…", "bake");
      const r = await bakeGraphicsForContentItem(db, storage, a.contentItemId, {
        load: ctx.motion?.load,
        onProgress: (done, total) => progress(5 + (90 * done) / Math.max(1, total), "Preparing your graphics for a smooth preview…", "bake"),
      });
      const ok = r.failed === 0;
      return { ok, result: r, error: ok ? undefined : `${r.failed} graphic(s) couldn't be prepared (the preview shows them live).`, message: `Prepared ${plural(r.baked, "graphic")}.` };
    }

    case "ingest":
      return runIngest(args as HeavyJobArgsByKind["ingest"], ctx, progress);

    case "motion-design": {
      const a = args as HeavyJobArgsByKind["motion-design"];
      progress(5, "Finding you in the frame, reading the script and research…", "design");
      const r = await designMotionForContentItem(db, storage, needModel(ctx), a.contentItemId, actor, {
        trigger: "HUMAN",
        replaceExisting: a.replaceExisting ?? false,
        focus: a.focus ?? null,
        strategize: a.strategize ?? false,
        analyze: ctx.analyze,
      });
      const result = {
        status: r.status,
        editPlanId: r.editPlanId ?? null,
        added: (r.added ?? []).map((v) => ({ id: v.id, template: v.template, start: v.start, end: v.end, anchorText: v.anchorText ?? null })),
        rejected: r.rejectedVisuals ?? [],
        placementWarnings: r.placementWarnings ?? [],
        notes: r.warnings ?? [],
        rationale: r.rationale ?? "",
        understanding: r.brief ? { topic: r.brief.topic, theme: r.brief.theme, coreMessage: r.brief.coreMessage, viewerTakeaway: r.brief.viewerTakeaway, moments: r.brief.moments.map((m) => ({ start: m.start, end: m.end, need: m.need, concept: m.concept })) } : null,
        errorMessage: r.errorMessage ?? null,
      };
      const ok = r.status === "SUCCESS" && !!r.editPlanId;
      return { ok, result, error: ok ? undefined : r.errorMessage ?? "unknown error", message: ok ? `Added ${plural(result.added.length, "graphic")}.` : "Couldn't design visuals." };
    }

    case "reference-analyze": {
      const a = args as HeavyJobArgsByKind["reference-analyze"];
      // In the sandbox, stop starting new videos well before the VM's hard timeout; the rest
      // stay waiting and the page offers to continue.
      const deadline = Number(process.env.SANDBOX_DEADLINE_MS) || 0;
      const timeBudgetMs = deadline ? Math.max(60_000, deadline - Date.now() - 8 * 60_000) : undefined;
      progress(3, "Measuring your reference videos…", "measure");
      const r = await analyzePendingReferenceVideos(
        db,
        storage,
        {
          ids: a.referenceContentIds,
          transcriptionProvider: ctx.transcriptionProvider,
          timeBudgetMs,
          onProgress: (p) => progress(3 + (95 * p.done) / Math.max(1, p.total), p.message, "measure"),
        },
        actor,
      );
      const failed = r.measured.filter((m) => !m.ok);
      const okCount = r.measured.length - failed.length;
      const rest = r.remaining ? ` ${r.remaining} still waiting — press Measure again to continue.` : "";
      return {
        ok: failed.length === 0,
        result: { measured: r.measured, remaining: r.remaining },
        error: failed.length ? `Couldn't measure ${plural(failed.length, "video")}: ${failed.map((f) => f.error).join("; ").slice(0, 600)}` : undefined,
        message: (r.measured.length === 0 ? "Nothing waiting to measure." : `Measured ${plural(okCount, "video")}${failed.length ? `, ${failed.length} failed` : ""}.`) + rest,
      };
    }

    case "film-render":
    case "film-render-chunk":
    case "film-storyboard":
    case "film-voice-align": {
      const fctx: FilmJobContext = { db, storage, actor, jobRunId: ctx.jobRunId, progress, engine: ctx.cinema, ...ctx.film };
      try {
        if (kind === "film-render") return await runFilmRender(args as HeavyJobArgsByKind["film-render"], fctx);
        if (kind === "film-render-chunk") return await runFilmRenderChunk(args as HeavyJobArgsByKind["film-render-chunk"], fctx);
        if (kind === "film-storyboard") return await runFilmStoryboard(args as HeavyJobArgsByKind["film-storyboard"], fctx);
        return await runFilmVoiceAlign(args as HeavyJobArgsByKind["film-voice-align"], fctx);
      } catch (err) {
        return { ok: false, result: { errorName: err instanceof Error ? err.name : "Error" }, error: errMsg(err), message: "The mini-movie job couldn't finish." };
      }
    }

    case "viewer-review": {
      const a = args as HeavyJobArgsByKind["viewer-review"];
      const opts = {
        platform: a.platform,
        persona: a.persona,
        transcriptionProvider: ctx.transcriptionProvider,
        jobRunId: ctx.jobRunId ?? null,
        onProgress: (pct: number, message: string) => progress(pct, message, "viewer"),
      };
      try {
        const r = a.contentItemId
          ? await reviewRenderAsViewer(db, storage, () => needModel(ctx), a.contentItemId, actor, opts)
          : await reviewReferenceAsViewer(db, storage, () => needModel(ctx), a.referenceContentId!, actor, opts);
        return { ok: true, result: r, message: `A new viewer would call it ${r.verdictTier.toLowerCase()}: ${r.headline}` };
      } catch (err) {
        // Spend cap / no key / out of credit / refusal: the errorName lets the page say it plainly.
        return { ok: false, result: { errorName: err instanceof Error ? err.name : "Error" }, error: errMsg(err), message: "The viewer check couldn't run." };
      }
    }
  }
  throw new Error(`unknown heavy job kind: ${String(kind)}`);
}

/**
 * Progress writer for a JobRun: throttled (a write at most every `minIntervalMs` unless the
 * stage changes), serialized (writes never race each other), and never throws.
 */
export function createProgressWriter(db: PrismaClient, jobRunId: string, options: { minIntervalMs?: number } = {}) {
  const minInterval = options.minIntervalMs ?? 2_000;
  let lastAt = 0;
  let lastStage = "";
  let lastPct = -1;
  let pending: HeavyJobProgressUpdate | null = null;
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = (p: HeavyJobProgressUpdate) => {
    lastAt = Date.now();
    lastStage = p.stage;
    lastPct = Math.round(p.pct);
    chain = chain.then(() => updateHeavyJobProgress(db, jobRunId, p).catch(() => undefined));
  };
  const update = (p: HeavyJobProgressUpdate) => {
    const now = Date.now();
    if (p.stage !== lastStage || now - lastAt >= minInterval) {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
      if (Math.round(p.pct) !== lastPct || p.stage !== lastStage) write(p);
      else lastAt = now;
      return;
    }
    pending = p;
    timer ??= setTimeout(() => {
      timer = null;
      if (pending) write(pending);
      pending = null;
    }, minInterval - (now - lastAt));
  };
  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
    await chain;
  };
  return { update, flush };
}

/**
 * Runs a heavy job and records it on its (already-claimed, RUNNING) JobRun: live progress,
 * then SUCCEEDED/FAILED with the result. Used by the sandbox CLI and by the web app's local
 * in-process path. Never throws; returns the outcome.
 */
export async function runHeavyJobRecorded(
  jobRunId: string,
  kind: HeavyJobKind,
  args: unknown,
  ctx: HeavyJobContext,
): Promise<HeavyJobOutcome> {
  const writer = createProgressWriter(ctx.db, jobRunId);
  let outcome: HeavyJobOutcome;
  try {
    outcome = await executeHeavyJob(kind, args, {
      ...ctx,
      jobRunId,
      progress: (p) => {
        writer.update(p);
        ctx.progress?.(p);
      },
    });
  } catch (err) {
    outcome = { ok: false, result: { errorName: err instanceof Error ? err.name : "Error" }, error: errMsg(err), message: "Something went wrong." };
  }
  await writer.flush();
  await finishHeavyJob(ctx.db, jobRunId, {
    status: outcome.ok ? "SUCCEEDED" : "FAILED",
    result: outcome.result,
    error: outcome.ok ? null : (outcome.error ?? "unknown error"),
    message: outcome.message,
  }).catch((err) => console.error(`[heavy-job] could not record the outcome of ${jobRunId}: ${errMsg(err)}`));
  return outcome;
}

function slimTranscribe(r: TranscribeJobResult) {
  // The transcript text is already on the MediaAsset — keep the JobRun row small.
  return { mediaAssetId: r.mediaAssetId, status: r.status, wordCount: r.wordCount ?? null, errorMessage: r.errorMessage ?? null, model: r.model ?? null };
}

async function rawTakeIds(db: PrismaClient, contentItemId: string): Promise<string[]> {
  const rows = await db.mediaAsset.findMany({ where: { contentItemId, kind: "RAW_TAKE", removedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return rows.map((r) => r.id);
}

function outcomeOf(
  key: string,
  results: Array<{ status: string; errorMessage?: string | null }>,
  failLabel: string,
  done: (n: number) => string,
): HeavyJobOutcome {
  const failed = results.filter((r) => r.status === "FAILED");
  const succeeded = results.filter((r) => r.status === "SUCCESS").length;
  return {
    ok: failed.length === 0,
    result: { [key]: results },
    error: failed.length ? `${failLabel}: ${failed.map((r) => r.errorMessage).join("; ")}` : undefined,
    message: failed.length ? `${failLabel}.` : done(succeeded),
  };
}

/**
 * The upload's background analysis, for every take of the item that still lacks it (so takes
 * uploaded while this runs are picked up too — the loop re-reads the item until a pass finds
 * nothing to do): transcribe (word timings) → face track → person matte. Each step fails per
 * take without stopping the others (a missing matte only means graphics render in front).
 */
async function runIngest(
  a: HeavyJobArgsByKind["ingest"],
  ctx: HeavyJobContext,
  progress: (pct: number, message: string, stage: string) => void,
): Promise<HeavyJobOutcome> {
  const { db, storage, actor } = ctx;
  const transcribe: Array<ReturnType<typeof slimTranscribe>> = [];
  const track: SubjectTrackJobResult[] = [];
  const matte: PersonMatteJobResult[] = [];
  const proxy: PreviewProxyJobResult[] = [];
  const understand: TakeUnderstandingJobResult[] = [];
  const wantProxy = a.proxy !== false;
  const styleCut: StyleCutOutcome[] = [];
  const attempted = new Set<string>();
  for (let pass = 0; pass < 5; pass++) {
    const takes = await db.mediaAsset.findMany({ where: { contentItemId: a.contentItemId, kind: "RAW_TAKE", removedAt: null }, orderBy: { createdAt: "asc" } });
    const todo = takes.filter((t) => {
      const needs =
        (a.transcribe && t.hasAudio !== false && t.transcriptWords == null && t.transcriptSource !== "MANUAL") ||
        (a.track && t.width != null && t.subjectTrack == null) ||
        (a.matte && t.width != null && !t.matteStorageKey) ||
        (wantProxy && t.width != null && !t.proxyStorageKey);
      return needs && !attempted.has(t.id);
    });
    if (todo.length === 0) break;
    for (const t of todo) attempted.add(t.id);
    const label = (i: number, n: number) => (n > 1 ? ` (take ${i + 1} of ${n})` : "");
    // Step-major, not take-major: every take's captions first (the upload screen waits for
    // them before opening the editor), then face tracking, then the slow person matte.
    const needT = todo.filter((t) => a.transcribe && t.hasAudio !== false && t.transcriptWords == null && t.transcriptSource !== "MANUAL");
    for (const [i, t] of needT.entries()) {
      progress(5 + (30 * i) / needT.length, `Transcribing what you said${label(i, needT.length)}…`, "transcribe");
      transcribe.push(slimTranscribe(await transcribeMediaAsset(db, storage, t.id, { provider: ctx.transcriptionProvider }, actor)));
    }
    // The editor's fast preview next (a 720p proxy with frequent keyframes — the editor opens
    // right after captions and plays this instead of the camera original).
    const needP = todo.filter((t) => wantProxy && t.width != null && !t.proxyStorageKey);
    for (const [i, t] of needP.entries()) {
      progress(30 + (5 * i) / needP.length, `Preparing a fast preview${label(i, needP.length)}…`, "proxy");
      proxy.push(...(await ensurePreviewProxies(db, storage, { mediaAssetIds: [t.id] }, actor, { make: ctx.makePreview })));
    }
    const needK = todo.filter((t) => a.track && t.width != null && t.subjectTrack == null);
    for (const [i, t] of needK.entries()) {
      progress(35 + (10 * i) / needK.length, `Finding you in the frame${label(i, needK.length)}…`, "track");
      track.push(...(await ensureSubjectTracks(db, storage, [t.id], actor, { analyze: ctx.analyze })));
    }
    // Director chat: what the chat "sees" (face + expressions + motion + frames sprite) — after
    // the proxy (it reads the small proxy). Never fails ingest.
    if (isTakeUnderstandingEnabled() || ctx.understand) {
      const needU = todo.filter((t) => t.width != null);
      if (needU.length) {
        progress(44, "Reading your face and moves…", "understand");
        understand.push(...(await ensureTakeUnderstandings(db, storage, needU.map((t) => t.id), actor, { analyze: ctx.understand })));
      }
    }
    // Captions (and the face) are in: if the video's edit is still the untouched no-AI starter
    // edit, make it a style cut now (no-op otherwise; never touches Chris's own edits).
    if (needT.length || needK.length) styleCut.push(await maybeAutoStyleCut(db, storage, a.contentItemId, actor, { provider: ctx.modelProvider ?? null }));
    const needM = todo.filter((t) => a.matte && t.width != null && !t.matteStorageKey);
    for (const [i, t] of needM.entries()) {
      progress(45 + (50 * i) / needM.length, `Cutting you out of the background${label(i, needM.length)} — the slowest step…`, "matte");
      matte.push(...(await ensurePersonMattes(db, storage, { mediaAssetIds: [t.id] }, actor, { compute: ctx.computeMatte })));
    }
  }
  // Once more at the end: the starter edit may have been made (upload screen) while this job
  // ran, after the in-loop attempt — an untouched cut then picks up the face track. No-op otherwise.
  if (transcribe.length || track.length) styleCut.push(await maybeAutoStyleCut(db, storage, a.contentItemId, actor, { provider: ctx.modelProvider ?? null }));
  const failures = [
    ...transcribe.filter((r) => r.status === "FAILED").map((r) => `transcription: ${r.errorMessage}`),
    ...track.filter((r) => r.status === "FAILED").map((r) => `face tracking: ${r.errorMessage}`),
    ...matte.filter((r) => r.status === "FAILED").map((r) => `cut-out: ${r.errorMessage}`),
    ...proxy.filter((r) => r.status === "FAILED").map((r) => `fast preview: ${r.errorMessage}`),
  ];
  return {
    ok: failures.length === 0,
    result: { transcribe, track, matte, proxy, styleCut, understand },
    error: failures.length ? `Some footage analysis failed — ${failures.join("; ")}` : undefined,
    message: failures.length ? "Footage analyzed, with some problems." : "Footage analyzed.",
  };
}
