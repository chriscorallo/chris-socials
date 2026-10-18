import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import {
  getReferenceStyleProfile,
  parseReferenceVideoMetrics,
  parseTranscriptWords,
  recordViewerReview,
  type PrismaClient,
  type ContentPlatform,
} from "@chris/domain";
import {
  computeCostUsd,
  getBrandContextText,
  estimateViewerReviewCost,
  getAgentPrompt,
  planViewerFrames,
  runViewerPanelAgent,
  scopeProvider,
  viewerFrameSize,
  viewerUserPromptText,
  VIEWER_FRAME_LONG_EDGE,
  type ModelProvider,
  type TranscriptionProvider,
  type ViewerCut,
  type ViewerFrameImage,
  type ViewerPersona,
  type ViewerPlatform,
  type ViewerReviewFacts,
  type ViewerReview,
} from "@chris/agents";
import {
  EditTimelineSchema,
  clipDuration,
  clipStartTimes,
  detectCuts,
  extractScaledFrames,
  measureFrameChanges,
  measureStyleLoudness,
  measureViewerAudio,
  measureVoiceBackground,
  probeVideo,
  timelineCaptionWords,
  type EditTimeline,
  type StorageAdapter,
} from "@chris/media";

/**
 * Viewer Panel job ("Watch it like a new viewer"). Builds the input DETERMINISTICALLY — frames
 * (dense hook, both sides of every cut, graphic/text changes, ~1 fps), the word-timed
 * transcript, the edit's exact facts (cuts and their kind, punch-ins, captions, text, graphics,
 * music) and measured sound (loudness, level jumps, voice vs background, level change at cuts) —
 * estimates the price, refuses above the per-review ceiling, then makes ONE HIGH-class vision
 * call through the cost-tracking provider (daily spend cap, fails closed) and stores the review
 * as a new ViewerReview row tied to exactly what was watched. Advisory only: no state
 * transition, no gate. See docs/decisions-pending/viewer-panel.md.
 */

const PCM_RATE = 16000;

/** Per-review ceiling on the ESTIMATED high end; above it nothing is sent. */
export function viewerReviewMaxUsd(): number {
  const n = Number(process.env.VIEWER_REVIEW_MAX_USD);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

type Provider = TranscriptionProvider & { model?: string };

export interface ViewerReviewJobOptions {
  platform?: ViewerPlatform;
  persona?: ViewerPersona;
  transcriptionProvider?: Provider;
  maxFrames?: number;
  jobRunId?: string | null;
  onProgress?: (pct: number, message: string) => void;
}

export interface ViewerReviewJobResult {
  viewerReviewId: string;
  verdictTier: ViewerReview["verdict"]["tier"];
  headline: string;
  frames: number;
  estimatedCostUsd: number;
  costUsd: number | null;
  warnings: string[];
}

/** Thrown for an expected refusal (no render, estimate too high, …) — a sentence for Chris. */
export class ViewerReviewRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewerReviewRefusedError";
  }
}

async function fetchToFile(storage: StorageAdapter, key: string, filePath: string): Promise<void> {
  const s = storage as StorageAdapter & { downloadToFile?: (k: string, p: string) => Promise<void> };
  if (typeof s.downloadToFile === "function") return s.downloadToFile(key, filePath);
  await writeFile(filePath, await storage.get(key));
}

/** Cuts of an edit timeline, in OUTPUT time, with what each one does. Pure. */
export function timelineCuts(timeline: Pick<EditTimeline, "clips">): ViewerCut[] {
  const starts = clipStartTimes(timeline);
  const cuts: ViewerCut[] = [];
  for (let i = 1; i < timeline.clips.length; i++) {
    const prev = timeline.clips[i - 1]!;
    const clip = timeline.clips[i]!;
    const t = Math.round(starts[i]! * 1000) / 1000;
    const zoomFrom = prev.crop?.zoom ?? 1;
    const zoomTo = clip.crop?.zoom ?? 1;
    if (clip.mediaAssetId !== prev.mediaAssetId) cuts.push({ t, kind: "TAKE", zoomFrom, zoomTo });
    else if (Math.abs(clip.sourceStart - prev.sourceEnd) < 0.02) cuts.push({ t, kind: "FRAMING", zoomFrom, zoomTo });
    else if (clip.sourceStart > prev.sourceEnd) cuts.push({ t, kind: "PAUSE_REMOVED", removedS: Math.round((clip.sourceStart - prev.sourceEnd) * 100) / 100, zoomFrom, zoomTo });
    else cuts.push({ t, kind: "TAKE", zoomFrom, zoomTo });
  }
  return cuts;
}

interface FileFacts {
  durationS: number;
  width: number | null;
  height: number | null;
  words: Array<{ word: string; start: number; end: number }>;
  wordsSource: string;
  talking: boolean;
  cuts: ViewerCut[];
  cutsSource: "EDIT" | "DETECTED";
}

/** Shared tail: measure the sound, plan + extract frames, estimate, call, record. */
async function reviewFile(
  modelProvider: ModelProvider,
  file: string,
  base: Omit<ViewerReviewFacts, "audio" | "durationS" | "width" | "height" | "words" | "wordsSource" | "talking" | "cuts" | "cutsSource">,
  fileFacts: FileFacts,
  extra: { eventTimes: number[]; brandContext: string | null; options: ViewerReviewJobOptions },
): Promise<{ facts: ViewerReviewFacts; result: Awaited<ReturnType<typeof runViewerPanelAgent>>; frames: ViewerFrameImage[]; estimate: ReturnType<typeof estimateViewerReviewCost>; inputSummary: Record<string, unknown> }> {
  const progress = extra.options.onProgress ?? (() => undefined);
  const d = fileFacts.durationS;
  const cutTimes = fileFacts.cuts.map((c) => c.t);

  progress(22, "Listening to the sound…");
  let audio: ViewerReviewFacts["audio"];
  try {
    const loud = await measureStyleLoudness(file, { endS: d });
    const { extractAudioPcm16k } = await import("@chris/media/transcription");
    const pcm = await extractAudioPcm16k(file).catch(() => null);
    const vb = pcm && fileFacts.words.length ? measureVoiceBackground(pcm.subarray(0, Math.floor(d * PCM_RATE)), PCM_RATE, fileFacts.words, d) : null;
    const lv = pcm ? measureViewerAudio(pcm, PCM_RATE, { words: fileFacts.words, cutTimes, durationS: d }) : null;
    audio = {
      integratedLufs: loud.integratedLufs,
      truePeakDbtp: loud.truePeakDbtp,
      clipping: loud.clipping,
      voiceLevelDb: vb?.voiceLevelDb ?? null,
      backgroundLevelDb: vb?.backgroundLevelDb ?? null,
      backgroundUnderVoiceDb: vb?.differenceDb ?? null,
      background: vb?.background ?? "unknown",
      levelPerSecond: lv?.levelPerSecond ?? [],
      levelJumps: lv?.levelJumps ?? [],
      cutJumps: lv?.cutJumps ?? [],
    };
  } catch {
    // No audio stream (or ffmpeg couldn't read it): the viewer gets "no audio measurements".
    audio = null;
  }

  const facts: ViewerReviewFacts = {
    ...base,
    durationS: d,
    width: fileFacts.width,
    height: fileFacts.height,
    words: fileFacts.words,
    wordsSource: fileFacts.wordsSource,
    talking: fileFacts.talking,
    cuts: fileFacts.cuts,
    cutsSource: fileFacts.cutsSource,
    audio,
  };

  progress(32, "Picking the moments to watch…");
  const plan = planViewerFrames({ durationS: d, cutTimes, eventTimes: extra.eventTimes }, extra.options.maxFrames ? { maxFrames: extra.options.maxFrames } : {});
  const shot = await extractScaledFrames(file, plan.map((p) => p.t), {
    longEdge: VIEWER_FRAME_LONG_EDGE,
    onFrame: (done, total) => progress(32 + (25 * done) / Math.max(1, total), `Picking the moments to watch (${done} of ${total})…`),
  });
  const byT = new Map(shot.map((f) => [f.atSeconds, f]));
  const frames: ViewerFrameImage[] = plan.flatMap((p) => {
    const f = byT.get(p.t);
    return f ? [{ ...p, base64: f.base64, mediaType: f.mediaType }] : [];
  });
  if (frames.length === 0) throw new ViewerReviewRefusedError("Couldn't read any frames from this video, so nothing was sent to the AI.");

  const size = shot[0]?.width ? { width: shot[0].width, height: shot[0].height } : viewerFrameSize(fileFacts.width, fileFacts.height);
  const userText = viewerUserPromptText(facts, frames, extra.brandContext);
  const estimate = estimateViewerReviewCost({ frames: frames.length, frameWidth: size.width, frameHeight: size.height, wordCount: facts.words.length, factsChars: userText.length });
  const cap = viewerReviewMaxUsd();
  if (estimate.highUsd > cap) {
    throw new ViewerReviewRefusedError(
      `This review would cost up to $${estimate.highUsd.toFixed(2)}, over the $${cap.toFixed(2)} limit per review (VIEWER_REVIEW_MAX_USD). Nothing was sent.`,
    );
  }

  progress(60, "Watching it like a new viewer…");
  const result = await runViewerPanelAgent(modelProvider, { facts, frames, brandContext: extra.brandContext });

  const inputSummary = {
    frames: frames.map((f) => ({ t: f.t, reason: f.reason })),
    frameSize: size,
    wordCount: facts.words.length,
    wordsSource: facts.wordsSource,
    cutCount: facts.cuts.length,
    cutsSource: facts.cutsSource,
    durationS: d,
    platform: facts.platform,
    persona: facts.persona,
    audioMeasured: facts.audio != null,
    referenceStyleSampleSize: facts.referenceStyle?.sampleSize ?? 0,
    estimate: { inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens, costUsd: estimate.costUsd, highUsd: estimate.highUsd, model: estimate.model },
    latencyMs: result.latencyMs,
  };
  return { facts, result, frames, estimate, inputSummary };
}

function costOf(model: string, usage: Awaited<ReturnType<typeof runViewerPanelAgent>>["usage"]): number | null {
  if (!usage) return null;
  const total = usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  if (total === 0) return null; // the zero-cost test provider
  return computeCostUsd(model, usage) ?? null;
}

function tokensOf(usage: Awaited<ReturnType<typeof runViewerPanelAgent>>["usage"]) {
  if (!usage) return { input: null, output: null };
  const input = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  return input + usage.outputTokens === 0 ? { input: null, output: null } : { input, output: usage.outputTokens };
}

async function defaultProvider(): Promise<Provider> {
  const { LocalWhisperTranscriptionProvider } = await import("@chris/media/transcription");
  return new LocalWhisperTranscriptionProvider();
}

/** Measured file facts when the edit doesn't tell us (a legacy render, a reference video). */
async function measuredCutsAndWords(
  file: string,
  durationS: number,
  options: { cuts?: number[] | null; transcribe: boolean; provider?: Provider },
): Promise<Pick<FileFacts, "cuts" | "cutsSource" | "words" | "wordsSource" | "talking">> {
  let cutTimes = options.cuts ?? null;
  if (!cutTimes) cutTimes = detectCuts(await measureFrameChanges(file));
  const cuts: ViewerCut[] = cutTimes.filter((t) => t > 0 && t < durationS - 0.05).map((t) => ({ t, kind: "DETECTED" }));
  let words: FileFacts["words"] = [];
  if (options.transcribe) {
    const provider = options.provider ?? (await defaultProvider());
    const t = await provider.transcribe(file);
    words = (t.words ?? []).filter((w) => w.word.trim() && w.start < durationS).map((w) => ({ word: w.word.trim(), start: w.start, end: Math.min(w.end, durationS) }));
  }
  return { cuts, cutsSource: "DETECTED", words, wordsSource: "Whisper on the file", talking: words.length >= 4 };
}

/** "Watch it like a new viewer" for Chris's latest successful render. */
export async function reviewRenderAsViewer(
  db: PrismaClient,
  storage: StorageAdapter,
  getModel: () => ModelProvider,
  contentItemId: string,
  actor: { actorId: string },
  options: ViewerReviewJobOptions = {},
): Promise<ViewerReviewJobResult> {
  const progress = options.onProgress ?? (() => undefined);
  const render = await db.render.findFirst({ where: { contentItemId, status: "SUCCESS", storageKey: { not: null } }, orderBy: { createdAt: "desc" } });
  if (!render?.storageKey) throw new ViewerReviewRefusedError("There's no finished render of this video yet — render it first, then a new viewer can watch it.");
  // Fail fast (before minutes of work) when the AI isn't configured.
  const provider = scopeProvider(getModel(), { contentItemId });
  const item = await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId }, select: { title: true, scheduleEntry: { select: { targetPlatforms: true } } } });
  const editPlan = await db.editPlan.findUnique({ where: { id: render.editPlanId } });
  const rawTimeline = (editPlan?.plan as Record<string, unknown> | null)?.timeline;
  const parsed = rawTimeline != null ? EditTimelineSchema.safeParse(rawTimeline) : null;
  const timeline = parsed?.success ? parsed.data : null;
  const scheduled = Array.isArray(item.scheduleEntry?.targetPlatforms) ? (item.scheduleEntry.targetPlatforms as string[]) : [];
  const platform: ViewerPlatform = options.platform ?? ((["TIKTOK", "INSTAGRAM", "YOUTUBE"].find((p) => scheduled.includes(p)) as ViewerPlatform | undefined) ?? "INSTAGRAM");

  const dir = await mkdtemp(join(tmpdir(), "chris-viewer-"));
  try {
    progress(5, "Getting the finished video…");
    const file = join(dir, "render.mp4");
    await fetchToFile(storage, render.storageKey, file);
    const probe = await probeVideo(file);
    const durationS = probe.durationS > 0 ? probe.durationS : (render.durationSeconds ?? 0);
    if (!(durationS > 0)) throw new ViewerReviewRefusedError("Couldn't read the length of the rendered video.");

    progress(12, "Reading the edit…");
    let fileFacts: FileFacts;
    let eventTimes: number[] = [];
    const base: Parameters<typeof reviewFile>[2] = {
      subject: "CHRIS_RENDER",
      title: item.title,
      platform,
      persona: options.persona ?? "COLD",
      zooms: [],
      captions: null,
      texts: [],
      graphics: [],
      music: null,
      sfxCount: null,
      referenceStyle: null,
      notes: [],
    };
    if (timeline) {
      const assetIds = [...new Set(timeline.clips.map((c) => c.mediaAssetId))];
      const assets = await db.mediaAsset.findMany({ where: { id: { in: assetIds } }, select: { id: true, transcriptWords: true } });
      const wordsByAsset = Object.fromEntries(assets.map((a) => [a.id, parseTranscriptWords(a.transcriptWords)]));
      const words = timelineCaptionWords(timeline, wordsByAsset)
        .filter((w) => w.word.trim())
        .map((w) => ({ word: w.word.trim(), start: w.start, end: w.end }));
      const editLen = timeline.clips.reduce((s, c) => s + clipDuration(c), 0);
      if (Math.abs(editLen - durationS) > 0.5) base.notes.push(`The edit is ${editLen.toFixed(1)} s long but the rendered file is ${durationS.toFixed(1)} s.`);
      fileFacts = {
        durationS,
        width: probe.width,
        height: probe.height,
        words,
        wordsSource: "from the edit's transcript",
        talking: words.length >= 4,
        cuts: timelineCuts(timeline),
        cutsSource: "EDIT",
      };
      base.zooms = timeline.zooms.map((z) => ({ start: z.start, end: z.end, zoom: z.zoom, mode: z.mode }));
      base.captions = { enabled: timeline.captions.enabled, preset: timeline.captions.preset, uppercase: timeline.captions.uppercase };
      base.texts = timeline.texts.map((t) => ({ text: t.text, start: t.start, end: t.end }));
      base.graphics = timeline.visuals.map((v) => ({ template: v.template, start: v.start, end: v.end, label: v.anchorText ?? null }));
      base.music = timeline.audio.music ? { present: true, levelDb: timeline.audio.music.levelDb, duckDb: timeline.audio.music.duckDb } : { present: false, levelDb: null, duckDb: null };
      base.sfxCount = timeline.sfx.length + (timeline.audio.sfxEnabled ? timeline.visuals.filter((v) => v.enterSfx).length : 0);
      eventTimes = [...timeline.texts.map((t) => t.start), ...timeline.visuals.map((v) => v.start), ...timeline.zooms.map((z) => z.start)];
    } else {
      progress(14, "Reading the edit (transcribing the render)…");
      const m = await measuredCutsAndWords(file, durationS, { transcribe: true, provider: options.transcriptionProvider });
      fileFacts = { durationS, width: probe.width, height: probe.height, ...m };
      base.notes.push("This render came from an older edit format, so cuts were detected from the picture and words transcribed from the file.");
    }

    const style = await getReferenceStyleProfile(db, { group: "MAIN" }).catch(() => null);
    if (style && style.sampleSize > 0) {
      base.referenceStyle = {
        sampleSize: style.sampleSize,
        shotMedianS: style.shotMedianS?.value ?? null,
        firstCutS: style.firstCutS?.value ?? null,
        wpm: style.wpm?.value ?? null,
        gapP90S: style.gapP90S?.value ?? null,
        hookDurationS: style.hookDurationS?.value ?? null,
        backgroundUnderVoiceDb: style.backgroundUnderVoiceDb?.value ?? null,
      };
    }
    const brandContext = (await getBrandContextText(db).catch(() => "")) || null;

    const out = await reviewFile(provider, file, base, fileFacts, { eventTimes, brandContext, options });
    progress(96, "Saving what the viewer thought…");
    const prompt = getAgentPrompt("VIEWER_PANEL");
    const tokens = tokensOf(out.result.usage);
    const row = await recordViewerReview(
      db,
      {
        subject: { kind: "RENDER", contentItemId, renderId: render.id, editPlanId: render.editPlanId },
        mediaStorageKey: render.storageKey,
        platform: platform as ContentPlatform,
        persona: out.facts.persona,
        promptId: "VIEWER_PANEL",
        promptVersion: prompt.frontmatter.version,
        model: out.result.model,
        review: out.result.review,
        warnings: out.result.warnings,
        inputSummary: out.inputSummary,
        estimatedCostUsd: out.estimate.costUsd,
        costUsd: costOf(out.result.model, out.result.usage),
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        jobRunId: options.jobRunId ?? null,
      },
      actor,
    );
    return {
      viewerReviewId: row.id,
      verdictTier: out.result.review.verdict.tier,
      headline: out.result.review.verdict.headline,
      frames: out.frames.length,
      estimatedCostUsd: out.estimate.costUsd,
      costUsd: row.costUsd,
      warnings: out.result.warnings,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** "What a viewer thinks" for one reference video (another creator's — never Chris). */
export async function reviewReferenceAsViewer(
  db: PrismaClient,
  storage: StorageAdapter,
  getModel: () => ModelProvider,
  referenceContentId: string,
  actor: { actorId: string },
  options: ViewerReviewJobOptions = {},
): Promise<ViewerReviewJobResult> {
  const progress = options.onProgress ?? (() => undefined);
  const row = await db.referenceContent.findUnique({ where: { id: referenceContentId }, include: { referenceCreator: { select: { name: true } } } });
  if (!row) throw new ViewerReviewRefusedError("That reference video doesn't exist any more.");
  if (!row.mediaStorageKey) throw new ViewerReviewRefusedError("This reference video's file was deleted, so a viewer can't watch it.");
  const provider = getModel();
  const metrics = parseReferenceVideoMetrics(row.metrics);
  const platform: ViewerPlatform = options.platform ?? ((row.platform as ViewerPlatform | null) ?? "INSTAGRAM");

  const dir = await mkdtemp(join(tmpdir(), "chris-viewer-ref-"));
  try {
    progress(5, "Getting the reference video…");
    const file = join(dir, `ref${extname(row.mediaFilename ?? "") || ".mp4"}`);
    await fetchToFile(storage, row.mediaStorageKey, file);
    const probe = await probeVideo(file);
    // The app's end card (Instagram/TikTok outro) isn't the creator's edit — stop before it.
    const durationS = metrics?.video.durationS && metrics.video.durationS > 0 ? metrics.video.durationS : probe.durationS;
    if (!(durationS > 0)) throw new ViewerReviewRefusedError("Couldn't read the length of this video.");
    progress(10, metrics?.speech === null ? "Reading the cuts…" : "Reading the cuts and words…");
    const talking = metrics ? metrics.speech != null : true;
    const m = await measuredCutsAndWords(file, durationS, { cuts: metrics?.cuts?.times ?? null, transcribe: talking, provider: options.transcriptionProvider });
    const notes: string[] = [];
    if (metrics?.video.endCardS) notes.push(`The app's end card (${metrics.video.endCardS.toFixed(1)} s) was cut off — it isn't the creator's edit.`);
    if (!talking) notes.push("Measured as a no-talking video (music/sound only).");
    const base: Parameters<typeof reviewFile>[2] = {
      subject: "REFERENCE_VIDEO",
      title: null,
      creatorName: row.referenceCreator.name,
      platform,
      persona: options.persona ?? "COLD",
      zooms: [],
      captions: null,
      texts: [],
      graphics: [],
      music: null,
      sfxCount: null,
      referenceStyle: null,
      notes,
    };
    const fileFacts: FileFacts = { durationS, width: probe.width, height: probe.height, ...m, talking: talking && m.talking };
    const out = await reviewFile(provider, file, base, fileFacts, { eventTimes: [], brandContext: null, options });
    progress(96, "Saving what the viewer thought…");
    const prompt = getAgentPrompt("VIEWER_PANEL");
    const tokens = tokensOf(out.result.usage);
    const saved = await recordViewerReview(
      db,
      {
        subject: { kind: "REFERENCE_VIDEO", referenceContentId },
        mediaStorageKey: row.mediaStorageKey,
        platform: platform as ContentPlatform,
        persona: out.facts.persona,
        promptId: "VIEWER_PANEL",
        promptVersion: prompt.frontmatter.version,
        model: out.result.model,
        review: out.result.review,
        warnings: out.result.warnings,
        inputSummary: out.inputSummary,
        estimatedCostUsd: out.estimate.costUsd,
        costUsd: costOf(out.result.model, out.result.usage),
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        jobRunId: options.jobRunId ?? null,
      },
      actor,
    );
    return {
      viewerReviewId: saved.id,
      verdictTier: out.result.review.verdict.tier,
      headline: out.result.review.verdict.headline,
      frames: out.frames.length,
      estimatedCostUsd: out.estimate.costUsd,
      costUsd: saved.costUsd,
      warnings: out.result.warnings,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
