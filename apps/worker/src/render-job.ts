import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import {
  getLatestEditPlan,
  startRendering,
  recordRenderAttempt,
  parseTranscriptWords,
  type PrismaClient,
} from "@chris/domain";
import { EditPlanOutputSchema, type EditPlanOutput } from "@chris/agents";
import {
  runTechnicalQC,
  renderTimeline,
  planToTimeline,
  timelineDuration,
  EditTimelineSchema,
  DEFAULT_CAPTIONS_CONFIG,
  chooseOutputFps,
  probeMedia,
  parseSubjectTrack,
  resolveVisualPlacements,
  nodeMeasureText,
  buildVisualInteractions,
  outputEmphasisWords,
  EMPHASIS_TEMPLATES,
  type BuildInteractionsInput,
  type VisualInteraction,
  type WordLoudness,
  type SceneStats,
  type EditTimeline,
  type SfxSound,
  type VisualOverlaySegment,
  type RenderInstructions,
  type TranscriptWord,
} from "@chris/media";
import type { StorageAdapter } from "@chris/media";

/**
 * EditPlan fields the renderer does not execute yet (no approved asset library / transition
 * engine). Listed — never silently dropped — so the gap is visible on the Render row and in
 * the UI. Pure.
 */
export function listUnexecutedPlanInstructions(plan: EditPlanOutput): string[] {
  const out: string[] = [];
  for (const b of plan.bRollRequests) out.push(`B-roll request not executed (no asset library): "${b}"`);
  if (plan.musicTrack) out.push(`Music track not executed (no asset library): "${plan.musicTrack}"`);
  for (const s of plan.sfxEvents) out.push(`SFX not executed (no asset library): "${s.sfx}" at ${s.atSeconds}s`);
  for (const t of plan.transitions) {
    out.push(`Transition not executed (all cuts are hard cuts): "${t.type}" at ${t.atSeconds}s`);
  }
  return out;
}

/**
 * Legacy mapping of an EditPlan onto packages/media's EditPlan renderer (`renderVideo`).
 * The worker now renders through the timeline engine (`timelineForPlan` + `renderTimeline`);
 * this stays for callers/tests of the legacy renderer. Captions: the plan's explicit
 * `captions` config wins; a plan without one gets the default — on, CLEAN, LOWER — whenever
 * the take has word timings.
 */
export function mapEditPlanToRenderInstructions(
  editPlan: EditPlanOutput,
  sourcePath: string,
  outputPath: string,
  fontPath?: string,
  sourceWords?: TranscriptWord[] | null,
): RenderInstructions {
  const captionsConfig = editPlan.captions ?? DEFAULT_CAPTIONS_CONFIG;
  return {
    sourcePath,
    outputPath,
    segments: editPlan.segments,
    targetDimensions: editPlan.targetDimensions,
    textOverlays: editPlan.textOverlays.map((o) => ({
      text: o.text,
      startSeconds: o.startSeconds,
      endSeconds: o.endSeconds,
      position: o.position,
      style: o.style,
    })),
    normalizeAudio: editPlan.normalizeAudio,
    fontPath: fontPath || undefined,
    captions:
      captionsConfig.enabled && (sourceWords?.length ?? 0) > 0
        ? { config: captionsConfig, sourceWords: sourceWords! }
        : editPlan.captions?.enabled
          ? { config: captionsConfig, sourceWords: [] } // renderer reports "no word timings"
          : null,
    punchIns: editPlan.punchIns,
  };
}

/**
 * The timeline with every AUTO visual's placement re-solved by `resolveVisualPlacements` from
 * the clips' takes' subject tracks, source dimensions and word timings (exact caption
 * obstacles via the renderer's glyph measurement). No visuals / no AUTO visuals -> unchanged.
 */
export function withResolvedPlacements(
  timeline: EditTimeline,
  assets: Array<{ id: string; subjectTrack?: unknown; width?: number | null; height?: number | null; matteStorageKey?: string | null }>,
  wordsByAsset: Record<string, TranscriptWord[] | null | undefined>,
): EditTimeline {
  if (!timeline.visuals.some((v) => v.placement.mode === "AUTO")) return timeline;
  const subjectTracks: Record<string, ReturnType<typeof parseSubjectTrack>> = {};
  const sourceDimensions: Record<string, { width: number; height: number } | null> = {};
  const mattes: Record<string, boolean> = {};
  for (const a of assets) {
    subjectTracks[a.id] = parseSubjectTrack(a.subjectTrack);
    sourceDimensions[a.id] = a.width && a.height ? { width: a.width, height: a.height } : null;
    mattes[a.id] = !!a.matteStorageKey;
  }
  // Same solver (incl. the auto-depth rule, which needs to know which takes have a matte) as the editor.
  const visuals = resolveVisualPlacements(timeline, { subjectTracks, sourceDimensions, wordsByAsset, measure: nodeMeasureText, mattes });
  return { ...timeline, visuals };
}

/** The slice of @chris/motion the worker uses (injectable for tests). */
export interface MotionModule {
  renderVisualsLayer(input: {
    timeline: Pick<EditTimeline, "visuals" | "canvas"> & Partial<Pick<EditTimeline, "motionTheme">>;
    fps: number;
    interactions?: Record<string, VisualInteraction> | null;
    durationSeconds: number;
    outputPath: string;
    concurrency?: number | null;
    /** 0..1 over all motion frames (optional — a subprocess host may not forward it). */
    onProgress?: (p: number) => void;
  }): Promise<{ framesRendered: number; segments: VisualOverlaySegment[]; skipped: Array<{ id: string; error: string }>; renderMs: number }>;
  sfxFiles(): Partial<Record<SfxSound, string>>;
}

export interface MotionOptions {
  /** Override how @chris/motion is loaded (tests inject a fake). */
  load?: () => Promise<MotionModule>;
  concurrency?: number | null;
  /** Feature flag: false renders without the motion layer (SFX/music still mix). Default true. */
  visualsEnabled?: boolean;
  /** Feature flag: false skips Motion v2 footage interaction (anchor/camera/scene/emphasis/depth). Default true. */
  interactionEnabled?: boolean;
  /** Computes a missing person matte at render time (tests inject a fake). Default: the real job. */
  computeMatte?: import("./person-matte-job").MatteComputer;
  /** 0..1 progress of the motion-layer render (the heavy-job runner maps it to a stage). */
  onMotionProgress?: (p: number) => void;
}

/** Plain-English progress of one render ("Rendering your graphics…", 0..100). */
export type RenderProgress = (p: { pct: number; message: string; stage: string }) => void;

/**
 * Loaded lazily and through a non-literal specifier so bundlers (apps/web imports this module)
 * never try to pull Remotion/webpack/three into a serverless bundle; only the worker process
 * that actually renders visuals loads it.
 */
async function defaultLoadMotion(): Promise<MotionModule> {
  // A host process can register its own loader. The web app does (apps/web/instrumentation.ts):
  // inside the Next.js server, Node's native ESM loader can't run @chris/motion's TypeScript
  // source (extensionless relative imports), and Remotion must never be bundled into the app,
  // so the web app renders the motion layer in a child process instead.
  const injected = (globalThis as { __chrisMotionLoader?: () => Promise<MotionModule> }).__chrisMotionLoader;
  if (injected) return injected();
  const specifier = ["@chris", "motion"].join("/");
  return (await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)) as MotionModule;
}

export interface PreparedMotion {
  visualsLayer: { segments: VisualOverlaySegment[] } | null;
  musicPath: string | null;
  sfxFiles: Partial<Record<SfxSound, string>> | null;
  framesRendered: number;
  renderMs: number;
}

/**
 * Everything renderTimeline needs for motion + sound design: the rendered visuals layer (only
 * when there are visuals), the SFX kit paths (only when any SFX will play) and the music bed
 * downloaded from storage (only when the timeline has one). Never throws: each part that fails
 * is reported in `warnings` and left out.
 */
export async function prepareMotion(
  db: PrismaClient,
  storage: StorageAdapter,
  timeline: EditTimeline,
  sources: Record<string, string>,
  workDir: string,
  warnings: string[],
  options: MotionOptions = {},
  interactionInput: BuildInteractionsInput | null = null,
): Promise<PreparedMotion> {
  const out: PreparedMotion = { visualsLayer: null, musicPath: null, sfxFiles: null, framesRendered: 0, renderMs: 0 };
  const wantsVisuals = timeline.visuals.length > 0 && options.visualsEnabled !== false;
  const wantsSfx = timeline.audio.sfxEnabled && (timeline.sfx.length > 0 || timeline.visuals.some((v) => v.enterSfx));
  if (timeline.visuals.length > 0 && options.visualsEnabled === false) {
    warnings.push(`Motion visuals not rendered (visuals disabled by flag): ${timeline.visuals.length} visual(s).`);
  }
  let motion: MotionModule | null = null;
  if (wantsVisuals || wantsSfx) {
    try {
      motion = await (options.load ?? defaultLoadMotion)();
    } catch (err) {
      warnings.push(`Motion engine unavailable (${err instanceof Error ? err.message : String(err)}) — rendered without visuals/SFX.`);
    }
  }
  if (motion && wantsSfx) {
    try {
      out.sfxFiles = motion.sfxFiles();
    } catch (err) {
      warnings.push(`SFX kit not found (${err instanceof Error ? err.message : String(err)}) — rendered without SFX.`);
    }
  }
  if (motion && wantsVisuals) {
    try {
      // Same fps rule as renderTimeline (probe of the actual sources), so frames line up.
      const probes = await Promise.all(
        [...new Set(timeline.clips.map((c) => c.mediaAssetId))].map(async (id) =>
          sources[id] ? (await probeMedia(sources[id]!)).frameRate : null,
        ),
      );
      const fps = chooseOutputFps(probes);
      let interactions: Record<string, VisualInteraction> | null = null;
      if (interactionInput) {
        try {
          interactions = buildVisualInteractions(timeline, interactionInput, fps);
        } catch (err) {
          warnings.push(`Footage interaction skipped (${err instanceof Error ? err.message : String(err)}) — graphics rendered static.`);
        }
      }
      const res = await motion.renderVisualsLayer({
        timeline: { visuals: timeline.visuals, canvas: timeline.canvas, motionTheme: timeline.motionTheme ?? null },
        fps,
        interactions,
        durationSeconds: timelineDuration(timeline),
        outputPath: join(workDir, "motion"),
        concurrency: options.concurrency ?? null,
        ...(options.onMotionProgress ? { onProgress: options.onMotionProgress } : {}),
      });
      for (const s of res.skipped) warnings.push(`Motion visual ${s.id} not rendered (invalid): ${s.error}`);
      out.visualsLayer = { segments: res.segments };
      out.framesRendered = res.framesRendered;
      out.renderMs = res.renderMs;
    } catch (err) {
      warnings.push(`Motion visuals failed to render (${err instanceof Error ? err.message : String(err)}) — rendered without them.`);
    }
  }
  const music = timeline.audio.music;
  if (music) {
    try {
      const asset = await db.mediaAsset.findUnique({ where: { id: music.musicAssetId } });
      if (!asset) throw new Error("asset not found");
      if (asset.kind !== "MUSIC") throw new Error(`asset is ${asset.kind}, not MUSIC`);
      const path = join(workDir, `music${extname(asset.originalFilename) || ".m4a"}`);
      await writeFile(path, await storage.get(asset.storageKey));
      out.musicPath = path;
    } catch (err) {
      warnings.push(`Music bed ${music.musicAssetId} unavailable (${err instanceof Error ? err.message : String(err)}) — rendered without music.`);
    }
  }
  return out;
}

export interface PreparedInteraction {
  /** mediaAssetId -> local matte file (only when some visual is behind Chris). */
  mattes: Record<string, string>;
  input: BuildInteractionsInput;
  report: { mattesComputed: number; mattesUsed: number; sceneSampled: number; emphasisWords: number; ms: number };
}

/**
 * Motion v2 inputs measured from the footage before the motion layer renders. Never throws —
 * every part degrades to "graphic behaves like v1" with a warning:
 * - person mattes (only if a visual is BEHIND_SUBJECT): downloaded, or computed now when a take
 *   has none (render-time fallback; the upload path normally computes them);
 * - per-word vocal emphasis (only if an emphasis template / emphasisAt exists);
 * - scene stats behind each graphic (integration look).
 */
export async function prepareInteraction(
  db: PrismaClient,
  storage: StorageAdapter,
  timeline: EditTimeline,
  assets: Array<{ id: string; storageKey: string; subjectTrack?: unknown; matteStorageKey?: string | null; width?: number | null; height?: number | null; hasAudio?: boolean | null }>,
  sources: Record<string, string>,
  sourceWords: Record<string, TranscriptWord[] | null>,
  workDir: string,
  warnings: string[],
  options: MotionOptions = {},
): Promise<PreparedInteraction> {
  const started = Date.now();
  const media = await import("@chris/media");
  const report = { mattesComputed: 0, mattesUsed: 0, sceneSampled: 0, emphasisWords: 0, ms: 0 };
  const subjectTracks: BuildInteractionsInput["subjectTracks"] = {};
  const sourceDimensions: Record<string, { width: number; height: number } | null> = {};
  for (const a of assets) {
    subjectTracks[a.id] = parseSubjectTrack(a.subjectTrack);
    try {
      sourceDimensions[a.id] = sources[a.id] ? await media.displayDimensions(sources[a.id]!) : null;
    } catch {
      sourceDimensions[a.id] = a.width && a.height ? { width: a.width, height: a.height } : null;
    }
  }
  const mattes: Record<string, string> = {};

  // Depth: mattes for every take under a behind-subject graphic.
  const behind = timeline.visuals.filter((v) => v.depth === "BEHIND_SUBJECT");
  if (behind.length > 0) {
    for (const a of assets) {
      let key = a.matteStorageKey ?? null;
      if (!key) {
        try {
          const { computePersonMatteForMediaAsset } = await import("./person-matte-job");
          const r = await computePersonMatteForMediaAsset(db, storage, a.id, { actorId: "render-job" }, { compute: options.computeMatte });
          if (r.status === "SUCCESS" && r.storageKey) {
            key = r.storageKey;
            report.mattesComputed++;
          } else warnings.push(`Person matte for take ${a.id} unavailable (${r.errorMessage ?? r.status}) — its behind-subject graphics render in front.`);
        } catch (err) {
          warnings.push(`Person matte for take ${a.id} failed (${err instanceof Error ? err.message : String(err)}) — its behind-subject graphics render in front.`);
        }
      }
      if (!key) continue;
      try {
        const p = join(workDir, `matte-${a.id}.mp4`);
        await writeFile(p, await storage.get(key));
        mattes[a.id] = p;
        report.mattesUsed++;
      } catch (err) {
        warnings.push(`Person matte for take ${a.id} could not be read (${err instanceof Error ? err.message : String(err)}) — rendered in front.`);
      }
    }
  }

  // Emphasis timing.
  let emphasisWords: BuildInteractionsInput["emphasisWords"] = null;
  if (timeline.visuals.some((v) => EMPHASIS_TEMPLATES.has(v.template) || (v.emphasisAt ?? 0) > 0)) {
    const loud: Record<string, WordLoudness[] | null> = {};
    for (const a of assets) {
      const words = sourceWords[a.id];
      if (!words?.length || !sources[a.id] || a.hasAudio === false) continue;
      try {
        loud[a.id] = await media.measureWordLoudness(sources[a.id]!, words);
      } catch (err) {
        warnings.push(`Vocal emphasis for take ${a.id} not measured (${err instanceof Error ? err.message : String(err)}) — numbers-only emphasis.`);
      }
    }
    emphasisWords = outputEmphasisWords(timeline, loud, sourceWords);
    report.emphasisWords = emphasisWords.length;
  }

  // Scene stats.
  let sceneStats: Record<string, SceneStats | null> = {};
  if (timeline.visuals.some((v) => v.integration.sceneMatch || v.integration.lightWrap || v.integration.shadow)) {
    try {
      sceneStats = await media.sampleSceneStatsForVisuals(timeline, sources, sourceDimensions);
      report.sceneSampled = Object.values(sceneStats).filter(Boolean).length;
    } catch (err) {
      warnings.push(`Scene matching skipped (${err instanceof Error ? err.message : String(err)}) — neutral look.`);
    }
  }
  report.ms = Date.now() - started;
  return { mattes, input: { subjectTracks, sourceDimensions, sceneStats, emphasisWords }, report };
}

export interface RenderJobResult {
  status: "SUCCESS" | "FAILED";
  outputStorageKey?: string;
  technicalQCReport?: unknown;
  errorMessage?: string;
  /** EditPlan instructions present but not executed (also stored inside technicalQCReport). */
  unexecutedInstructions?: string[];
}

export class InvalidFinishingEditError extends Error {
  constructor(detail: string) {
    super(
      `This edit plan carries a finishing-edit timeline that doesn't validate (${detail}). ` +
        `Refusing to render the AI plan in its place — that would silently discard Chris's edit.`,
    );
    this.name = "InvalidFinishingEditError";
  }
}

/**
 * The Timeline a plan row renders: its `plan.timeline` (a finishing edit from the in-app
 * editor) when present, else the deterministic conversion of the AI's EditPlan. A present
 * but invalid timeline is an error, never a silent fallback to the AI plan.
 */
export function timelineForPlan(
  rawPlan: unknown,
  plan: EditPlanOutput,
  ctx: {
    selectedMediaAssetId: string;
    sourceWordsAvailable: boolean;
    sourceDimensions?: { width: number; height: number } | null;
  },
): { timeline: EditTimeline; source: "FINISHING_EDIT" | "EDIT_PLAN" } {
  const raw = (rawPlan ?? {}) as Record<string, unknown>;
  if (raw.timeline != null) {
    const parsed = EditTimelineSchema.safeParse(raw.timeline);
    if (!parsed.success) {
      throw new InvalidFinishingEditError(
        parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      );
    }
    return { timeline: parsed.data, source: "FINISHING_EDIT" };
  }
  const dims = ctx.sourceDimensions;
  // targetDimensions null = keep the source's native framing (even dims for H.264).
  const canvas =
    plan.targetDimensions ??
    (dims ? { width: dims.width - (dims.width % 2), height: dims.height - (dims.height % 2) } : undefined);
  return {
    timeline: planToTimeline(plan, {
      mediaAssetId: ctx.selectedMediaAssetId,
      sourceWordsAvailable: ctx.sourceWordsAvailable,
      canvas,
    }),
    source: "EDIT_PLAN",
  };
}

/**
 * Orchestrates one render attempt end to end for a ContentItem currently in EDIT_PLANNED:
 * fetch the latest EditPlan, build its Timeline (finishing edit, or the converted AI plan),
 * download EVERY take the timeline's clips use, render with the timeline engine, QC, upload,
 * persist. See docs/decisions-pending/timeline-engine.md.
 *
 * `options.fontPath` is accepted for backward compatibility but unused: every font comes from
 * FONT_REGISTRY (packages/media/assets/fonts). `options.encode` overrides the master encoder
 * settings (tests use a fast preset).
 */
export async function renderContentItem(
  db: PrismaClient,
  storage: StorageAdapter,
  contentItemId: string,
  options: {
    fontPath?: string;
    targetVideoCodec?: string;
    targetAudioCodec?: string;
    encode?: { preset?: string; crf?: number };
    motion?: MotionOptions;
    /** Stage progress for a UI (heavy-job runner). Never affects the render. */
    onProgress?: RenderProgress;
  } = {},
  actor: { actorId: string },
): Promise<RenderJobResult> {
  const report: RenderProgress = (p) => {
    try {
      options.onProgress?.(p);
    } catch {
      // progress is best effort
    }
  };
  const editPlanRow = await getLatestEditPlan(db, contentItemId);
  if (!editPlanRow) {
    throw new Error(`No EditPlan found for content item ${contentItemId}.`);
  }

  const takeSelection = await db.takeSelection.findUniqueOrThrow({
    where: { id: editPlanRow.takeSelectionId },
  });
  const selectedAsset = await db.mediaAsset.findUniqueOrThrow({
    where: { id: takeSelection.selectedMediaAssetId },
  });

  const plan = EditPlanOutputSchema.parse(editPlanRow.plan);
  const selectedWords = parseTranscriptWords(selectedAsset.transcriptWords);

  // startRendering only accepts EDIT_PLANNED (the state table has no QC_REPAIR -> EDITING
  // or EDITING -> EDITING transition — see /docs/STATE_MACHINE.md). A repair re-render from
  // QC_REPAIR, or a retry after a technical FAILED attempt that left the item in EDITING
  // (see render-record.ts), both skip straight to the render attempt instead.
  const current = await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (current.currentState === "EDIT_PLANNED") {
    await startRendering(db, contentItemId, actor);
  }

  const fail = async (err: unknown): Promise<RenderJobResult> => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await recordRenderAttempt(
      db,
      { contentItemId, editPlanId: editPlanRow.id, status: "FAILED", errorMessage },
      actor,
    );
    return { status: "FAILED", errorMessage };
  };

  let built: ReturnType<typeof timelineForPlan>;
  try {
    built = timelineForPlan(editPlanRow.plan, plan, {
      selectedMediaAssetId: selectedAsset.id,
      sourceWordsAvailable: (selectedWords?.length ?? 0) > 0,
      sourceDimensions:
        selectedAsset.width && selectedAsset.height
          ? { width: selectedAsset.width, height: selectedAsset.height }
          : null,
    });
  } catch (err) {
    return fail(err);
  }
  const { timeline, source: timelineSource } = built;

  // Every take the clips reference (a finishing edit may mix takes) — all must belong to
  // this content item.
  const assetIds = [...new Set(timeline.clips.map((c) => c.mediaAssetId))];
  const assets = await db.mediaAsset.findMany({ where: { id: { in: assetIds } } });
  const foreign = assetIds.filter(
    (id) => !assets.some((a) => a.id === id && a.contentItemId === contentItemId),
  );
  if (foreign.length > 0) {
    return fail(new Error(`Timeline references media assets that don't belong to this item: ${foreign.join(", ")}.`));
  }

  const workDir = await mkdtemp(join(tmpdir(), "chris-render-"));
  const outputPath = join(workDir, "output.mp4");

  try {
    report({ pct: 3, message: "Getting your footage ready…", stage: "download" });
    const sources: Record<string, string> = {};
    const sourceWords: Record<string, TranscriptWord[] | null> = {};
    for (const [i, asset] of assets.entries()) {
      const path = join(workDir, `source-${i}${extname(asset.originalFilename) || ".mp4"}`);
      await writeFile(path, await storage.get(asset.storageKey));
      sources[asset.id] = path;
      sourceWords[asset.id] = parseTranscriptWords(asset.transcriptWords);
    }

    // Motion graphics + sound design (packages/motion). Graceful: a failed motion render or a
    // missing music file never fails the video — the edit renders without them and says so.
    const motionWarnings: string[] = [];
    // AUTO placements are re-solved against the takes' subject tracks (same solver the editor
    // uses), so the rendered graphics land where the editor showed them. MANUAL ones never move.
    const placedTimeline = withResolvedPlacements(timeline, assets, sourceWords);
    // Motion v2: how graphics interact with the footage (depth, follow, camera, scene, emphasis).
    if (placedTimeline.visuals.length > 0) report({ pct: 8, message: "Measuring the footage for your graphics…", stage: "measure" });
    const interaction =
      placedTimeline.visuals.length > 0 && options.motion?.interactionEnabled !== false && options.motion?.visualsEnabled !== false
        ? await prepareInteraction(db, storage, placedTimeline, assets, sources, sourceWords, workDir, motionWarnings, options.motion)
        : null;
    if (placedTimeline.visuals.length > 0) report({ pct: 15, message: "Rendering your graphics…", stage: "graphics" });
    const motionOptions: MotionOptions = {
      ...options.motion,
      onMotionProgress: (p) => {
        options.motion?.onMotionProgress?.(p);
        report({ pct: 15 + 45 * Math.max(0, Math.min(1, p)), message: "Rendering your graphics…", stage: "graphics" });
      },
    };
    const motionInputs = await prepareMotion(db, storage, placedTimeline, sources, workDir, motionWarnings, motionOptions, interaction?.input ?? null);

    // The compositor reports no progress of its own: ease towards 92% on a clock scaled to the
    // video's length (measured ≈ 1–1.7 s of encode per second of 1080x1920 output).
    const composeFrom = placedTimeline.visuals.length > 0 ? 60 : 10;
    const expectedMs = Math.max(8_000, timelineDuration(timeline) * 1_700);
    const composeStarted = Date.now();
    report({ pct: composeFrom, message: "Putting your video together…", stage: "compose" });
    const ticker = options.onProgress
      ? setInterval(() => {
          const f = 1 - Math.exp(-(Date.now() - composeStarted) / expectedMs);
          report({ pct: composeFrom + (92 - composeFrom) * f, message: "Putting your video together…", stage: "compose" });
        }, 2_000)
      : null;
    let renderResult: Awaited<ReturnType<typeof renderTimeline>>;
    try {
      renderResult = await renderTimeline({
        timeline,
        sources,
        sourceWords,
        outputPath,
        encode: options.encode,
        visualsLayer: motionInputs.visualsLayer,
        musicPath: motionInputs.musicPath,
        sfxFiles: motionInputs.sfxFiles,
        mattes: interaction?.mattes ?? null,
      });
    } catch (err) {
      return fail(err);
    } finally {
      if (ticker) clearInterval(ticker);
    }
    report({ pct: 94, message: "Checking and saving your video…", stage: "save" });

    const unexecutedInstructions = [...listUnexecutedPlanInstructions(plan), ...motionWarnings, ...renderResult.warnings];

    const duration = timelineDuration(timeline);
    const qc = await runTechnicalQC(outputPath, {
      targetWidth: timeline.canvas.width,
      targetHeight: timeline.canvas.height,
      minDurationSeconds: Math.max(0, duration - 2),
      maxDurationSeconds: duration + 2,
      requiredVideoCodec: options.targetVideoCodec ?? "h264",
      requiredAudioCodec: options.targetAudioCodec ?? "aac",
    });
    // Stored alongside the QC report (Render.technicalQCReport is Json) so what the renderer
    // did NOT do is visible on the Render row without a schema change. `overall`/`checks`
    // keep their shape; everything else is an additive key.
    const storedReport = {
      ...qc,
      unexecutedInstructions,
      captions: {
        rendered: renderResult.captionCount,
        // Timeline captions sit at their explicit y (planToTimeline picks a free band); the
        // renderer no longer moves phrases on its own.
        relocatedAroundOverlays: 0,
      },
      renderEngine: "timeline-v2",
      timelineSource,
      renderMs: renderResult.renderMs,
      ffmpegWarnings: renderResult.ffmpegWarnings,
      motion: {
        visuals: timeline.visuals.length,
        overlays: renderResult.motion.overlays,
        framesRendered: motionInputs.framesRendered,
        motionRenderMs: motionInputs.renderMs,
        sfxEvents: renderResult.motion.sfxEvents.length,
        music: renderResult.motion.music ? { mode: renderResult.motion.music.mode, speechRegions: renderResult.motion.music.regions } : null,
        interaction: interaction
          ? { ...interaction.report, behindSubject: renderResult.motion.behindSubject, mattedClips: renderResult.motion.mattedClips }
          : null,
      },
    };

    const outputBytes = await readFile(outputPath);
    const outputStorageKey = `renders/${contentItemId}/${editPlanRow.id}-${Date.now()}.mp4`;
    await storage.put(outputStorageKey, outputBytes, "video/mp4");

    await recordRenderAttempt(
      db,
      {
        contentItemId,
        editPlanId: editPlanRow.id,
        status: "SUCCESS",
        storageKey: outputStorageKey,
        durationSeconds: renderResult.durationSeconds,
        width: renderResult.width,
        height: renderResult.height,
        fileSizeBytes: outputBytes.byteLength,
        technicalQCReport: storedReport,
      },
      actor,
    );

    return {
      status: "SUCCESS",
      outputStorageKey,
      technicalQCReport: storedReport,
      unexecutedInstructions,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
