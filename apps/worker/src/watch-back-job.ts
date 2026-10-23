import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  creativeBriefTextFor,
  editorDigest,
  getStyleModel,
  isEnabled,
  parseReferenceVideoMetrics,
  parseTranscriptWords,
  readStoredFullEdit,
  recordWatchVerdict,
  saveFinishingEdit,
  WATCH_BACK_FIX_LOOP_FLAG,
  type PrismaClient,
  type WatchVerdictKind,
} from "@chris/domain";
import {
  estimateViewerReviewCost,
  getAgentPrompt,
  getBrandContextText,
  planViewerFrames,
  runHookTestAgent,
  runWatchBackAgent,
  scopeProvider,
  settleVerdict,
  VIEWER_FRAME_LONG_EDGE,
  type HookTest,
  type ModelProvider,
  type WatchFrame,
} from "@chris/agents";
import {
  applyWatchFixes,
  auditScreen,
  auditSplices,
  auditStory,
  EditTimelineSchema,
  extractScaledFrames,
  nodeMeasureText,
  parseSubjectTrack,
  probeVideo,
  refineWordEdges,
  timelineCaptionWords,
  timelineDuration,
  WatchFixSchema,
  type EditTimeline,
  type StorageAdapter,
  type WatchFix,
} from "@chris/media";
import { EditorPlanSchema } from "@chris/media/timeline";
import { storedSpliceAnalysisFor } from "./splice-store";
import { viewerReviewMaxUsd } from "./viewer-review-job";
import { applyStyleCutChoice } from "./style-cut-job";
import { renderContentItem } from "./render-job";
import { runQualityGateForContentItem } from "./quality-gate-job";

/**
 * The watch-back gate (docs/PREMIUM_EDITOR_PLAN.md round 2; built 2026-10-22). Order: free
 * audits (splice, screen, story — measured, no model) → one HIGH vision watch of the render
 * against a checklist, judged contrastively against a reference's frames at matching
 * timestamps, plus a MEDIUM isolated hook test → PASS / FIX / HOLD with at most five typed
 * fixes. FIX with the loop flag on: the fixes are applied (SCREEN / SPLICE on the timeline, EDITOR
 * as a re-cut), the video is re-rendered, re-gated and watched once more; a second FIX is a
 * HOLD. Shadow by default: the verdict is recorded for Chris and for the agreement score; the
 * hard gate still decides READY. FACTUAL is never touched here.
 */
export interface WatchBackJobOptions {
  jobRunId?: string | null;
  onProgress?: (pct: number, message: string) => void;
  maxFrames?: number;
  /** Override the fix-loop flag (tests). */
  applyFixes?: boolean;
  /** Internal: the second watch after the fixes. */
  loop?: number;
  afterFixes?: string[] | null;
}

export interface WatchBackJobResult {
  watchVerdictId: string;
  verdict: WatchVerdictKind;
  loop: number;
  fixes: WatchFix[];
  applied: string[];
  coldViewer: string;
  hook: HookTest | null;
  costUsd: number | null;
}

export class WatchBackRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchBackRefusedError";
  }
}

async function fetchToFile(storage: StorageAdapter, key: string, filePath: string): Promise<void> {
  const s = storage as StorageAdapter & { downloadToFile?: (k: string, p: string) => Promise<void> };
  if (typeof s.downloadToFile === "function") return s.downloadToFile(key, filePath);
  await writeFile(filePath, await storage.get(key));
}

const FRACTIONS = [0.02, 0.2, 0.4, 0.6, 0.8, 0.98];

/** A reference video with media in the MAIN group (newest measured first), for the contrastive frames. */
async function pickReference(db: PrismaClient): Promise<{ id: string; storageKey: string; durationS: number; label: string } | null> {
  const rows = await db.referenceContent.findMany({ where: { mediaStorageKey: { not: null }, analysisStatus: "DONE" }, orderBy: { analyzedAt: "desc" }, take: 20, include: { referenceCreator: { select: { name: true, formats: true } } } });
  for (const r of rows) {
    const m = parseReferenceVideoMetrics(r.metrics);
    if (!m || !m.speech || !r.mediaStorageKey) continue;
    return { id: r.id, storageKey: r.mediaStorageKey, durationS: m.video.durationS, label: `${r.referenceCreator.name} · ${r.mediaFilename ?? r.id}` };
  }
  return null;
}

export async function watchBackContentItem(
  db: PrismaClient,
  storage: StorageAdapter,
  getModel: () => ModelProvider,
  contentItemId: string,
  actor: { actorId: string },
  options: WatchBackJobOptions = {},
): Promise<WatchBackJobResult> {
  const progress = options.onProgress ?? (() => undefined);
  const loop = options.loop ?? 0;
  const render = await db.render.findFirst({ where: { contentItemId, status: "SUCCESS", storageKey: { not: null } }, orderBy: { createdAt: "desc" } });
  if (!render?.storageKey) throw new WatchBackRefusedError("There's no finished render of this video yet.");
  const provider = scopeProvider(getModel(), { contentItemId });
  const item = await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId }, select: { title: true, series: true } });
  const editPlan = await db.editPlan.findUnique({ where: { id: render.editPlanId } });
  const rawTimeline = (editPlan?.plan as Record<string, unknown> | null)?.timeline;
  const parsed = rawTimeline != null ? EditTimelineSchema.safeParse(rawTimeline) : null;
  const timeline: EditTimeline | null = parsed?.success ? parsed.data : null;
  if (!timeline) throw new WatchBackRefusedError("This render came from an older edit format — the watch-back needs the timeline.");
  const stored = editPlan ? readStoredFullEdit(editPlan.plan) : null;
  const report = (stored?.report ?? null) as { editor?: { beats?: Array<{ role: string; headline: string | null; viewerNeeds: string | null; start: number; end: number }> } | null; screen?: Record<string, unknown> | null; kept?: Array<{ sentenceId: number; text: string }>; removed?: Array<{ sentenceId: number; text: string }> } | null;
  const editorPlanParsed = stored?.choices?.editorPlan ? EditorPlanSchema.safeParse(stored.choices.editorPlan) : null;
  const editorPlan = editorPlanParsed?.success ? editorPlanParsed.data : null;

  const dir = await mkdtemp(join(tmpdir(), "chris-watch-"));
  try {
    progress(5, "Getting the finished video…");
    const file = join(dir, "render.mp4");
    await fetchToFile(storage, render.storageKey, file);
    const probe = await probeVideo(file);
    const durationS = probe.durationS > 0 ? probe.durationS : timelineDuration(timeline);

    // ---- Free audits -------------------------------------------------------------------------
    progress(12, "Measuring the cuts and the screen…");
    const assetIds = [...new Set(timeline.clips.map((c) => c.mediaAssetId))];
    const assets = await db.mediaAsset.findMany({ where: { id: { in: assetIds } } });
    const wordsByAsset = Object.fromEntries(assets.map((a) => [a.id, parseTranscriptWords(a.transcriptWords)]));
    const audits: Array<{ stage: string; kind: string; atS: number; detail: string }> = [];
    for (const a of assets) {
      const words = wordsByAsset[a.id];
      if (!words?.length) continue;
      const analysis = await storedSpliceAnalysisFor(db, contentItemId, a.id);
      const refined = analysis ? refineWordEdges(words, analysis) : words;
      for (const f of auditSplices(timeline, a.id, refined, analysis)) audits.push({ stage: "SPLICE", kind: f.kind, atS: f.atS, detail: `cut ${f.index}: ${f.detail}` });
    }
    const model = await getStyleModel(db, { group: "MAIN" }).catch(() => null);
    const primary = assets.find((a) => a.id === timeline.clips[0]!.mediaAssetId) ?? assets[0];
    if (primary) {
      for (const f of auditScreen(timeline, { mediaAssetId: primary.id, subjectTrack: parseSubjectTrack(primary.subjectTrack), sourceSize: primary.width && primary.height ? { width: primary.width, height: primary.height } : null, measure: nodeMeasureText, hookExpected: timeline.texts.some((t) => t.id === "fe-hook-title"), bands: model ? { headlinesPer10s: model.headlinesPer10s } : null })) {
        audits.push({ stage: "SCREEN", kind: f.kind, atS: f.atS, detail: `${f.elementId ? `${f.elementId}: ` : ""}${f.detail}` });
      }
    }
    if (editorPlan && report?.kept?.length) {
      const lines = [...(report.kept ?? []), ...(report.removed ?? [])].map((l) => ({ id: l.sentenceId, text: l.text })).sort((a, b) => a.id - b.id);
      for (const f of auditStory(editorPlan, report.kept, lines)) audits.push({ stage: "EDITOR", kind: f.kind, atS: 0, detail: f.detail });
    }

    // ---- Frames: ours, and a reference's at the same fractions -----------------------------
    progress(25, "Picking the moments to watch…");
    const cutTimes: number[] = [];
    {
      let acc = 0;
      timeline.clips.forEach((c, i) => {
        if (i > 0) cutTimes.push(Math.round(acc * 1000) / 1000);
        acc += c.sourceEnd - c.sourceStart;
      });
    }
    const eventTimes = [...timeline.texts.map((t) => t.start), ...timeline.visuals.map((v) => v.start), ...timeline.zooms.map((z) => z.start)];
    const plan = planViewerFrames({ durationS, cutTimes, eventTimes }, { maxFrames: options.maxFrames ?? 36 });
    const shot = await extractScaledFrames(file, plan.map((p) => p.t), { longEdge: VIEWER_FRAME_LONG_EDGE, onFrame: (d, t) => progress(25 + (20 * d) / Math.max(1, t), `Picking the moments to watch (${d} of ${t})…`) });
    const byT = new Map(shot.map((f) => [f.atSeconds, f]));
    const frames: WatchFrame[] = plan.flatMap((p) => {
      const f = byT.get(p.t);
      return f ? [{ t: p.t, reason: p.reason, base64: f.base64, mediaType: f.mediaType }] : [];
    });
    if (!frames.length) throw new WatchBackRefusedError("Couldn't read any frames from this video.");

    let referenceFrames: Array<WatchFrame & { ofS: number; referenceLabel: string }> = [];
    const ref = await pickReference(db).catch(() => null);
    if (ref) {
      progress(47, "Taking the reference's frames at the same moments…");
      try {
        const rf = join(dir, "reference.mp4");
        await fetchToFile(storage, ref.storageKey, rf);
        const ours = FRACTIONS.map((f) => frames.reduce((best, x) => (Math.abs(x.t - f * durationS) < Math.abs(best.t - f * durationS) ? x : best), frames[0]!));
        const theirs = await extractScaledFrames(rf, FRACTIONS.map((f) => Math.round(f * ref.durationS * 100) / 100), { longEdge: VIEWER_FRAME_LONG_EDGE });
        referenceFrames = theirs.map((t, i) => ({ t: ours[i]!.t, reason: "PAIR", ofS: t.atSeconds, referenceLabel: ref.label, base64: t.base64, mediaType: t.mediaType }));
      } catch {
        referenceFrames = [];
      }
    }

    // ---- The words, the beats, the screen plan, the digest -----------------------------------
    const words = timelineCaptionWords(timeline, wordsByAsset).filter((w) => w.word.trim());
    const transcript = words.length ? chunkTranscript(words.map((w) => ({ word: w.word, start: w.start, end: w.end }))) : "(no words)";
    const firstWords = words.filter((w) => w.start < 2).map((w) => w.word).join(" ");
    const beats = report?.editor?.beats ?? [];
    const screen = report?.screen ? describeScreen(report.screen, timeline) : describeTimeline(timeline);
    const styleDigest = model ? editorDigest(model) : [];
    const brandContext = (await getBrandContextText(db).catch(() => "")) || "";
    const brief = await creativeBriefTextFor(db, contentItemId).catch(() => null);

    // ---- Cost guard (same cap as the viewer check) ------------------------------------------
    const size = shot[0]?.width ? { width: shot[0].width, height: shot[0].height } : { width: 360, height: 640 };
    const estimate = estimateViewerReviewCost({ frames: frames.length + referenceFrames.length, frameWidth: size.width, frameHeight: size.height, wordCount: words.length, factsChars: transcript.length + screen.length + 2000 });
    const cap = viewerReviewMaxUsd();
    if (estimate.highUsd > cap) throw new WatchBackRefusedError(`This watch would cost up to $${estimate.highUsd.toFixed(2)}, over the $${cap.toFixed(2)} limit per review. Nothing was sent.`);

    // ---- The watch + the isolated hook test --------------------------------------------------
    progress(55, "Watching it back…");
    const watch = await runWatchBackAgent(provider, {
      title: item.title,
      durationS,
      frames,
      referenceFrames,
      transcript,
      beats,
      screen: brief ? `${screen}\n\nCreative brief:\n${brief.slice(0, 1500)}` : screen,
      audits,
      styleDigest,
      cuts: cutTimes.map((t, i) => ({ index: i, atS: t })),
      brandContext,
      afterFixes: options.afterFixes ?? null,
    });
    let hook: HookTest | null = null;
    try {
      progress(80, "Testing the first second alone…");
      hook = (await runHookTestAgent(provider, { firstFrame: frames[0]!, firstWords })).test;
    } catch {
      hook = null;
    }
    const verdict = settleVerdict(watch.verdict, hook, loop);
    const fixes = verdict === "FIX" ? watch.verdict.fixes.filter((f) => WatchFixSchema.safeParse(f).success).slice(0, 5) : [];
    const prompt = getAgentPrompt("WATCH_BACK");
    const row = await recordWatchVerdict(
      db,
      {
        contentItemId,
        renderId: render.id,
        editPlanId: render.editPlanId,
        loop,
        verdict,
        checklist: watch.verdict.checklist,
        fixes,
        audits,
        hookTest: hook,
        coldViewer: watch.verdict.coldViewer,
        promptVersion: prompt.frontmatter.version,
        model: watch.model,
        inputSummary: { frames: frames.map((f) => ({ t: f.t, reason: f.reason })), referenceFrames: referenceFrames.length, reference: ref?.label ?? null, durationS, wordCount: words.length, audits: audits.length, estimate: { costUsd: estimate.costUsd, highUsd: estimate.highUsd }, modelVerdict: watch.verdict.verdict, contrast: watch.verdict.contrast, hook: watch.verdict.hook, latencyMs: watch.latencyMs, series: item.series },
        costUsd: estimate.costUsd,
        jobRunId: options.jobRunId ?? null,
      },
      actor,
    );

    // ---- The one fix loop ------------------------------------------------------------------
    let applied: string[] = [];
    if (verdict === "FIX" && loop === 0 && fixes.length) {
      const allowed = options.applyFixes ?? (await isEnabled(db, WATCH_BACK_FIX_LOOP_FLAG));
      if (allowed) {
        progress(88, "Applying the fixes…");
        const result = applyWatchFixes(timeline, fixes);
        applied = result.applied;
        let fixedTimeline = result.timeline;
        const e = result.editor;
        if (e.forceDrop.length || e.forceKeep.length || e.moveEnding != null) {
          const prev = (stored?.choices ?? {}) as Record<string, unknown>;
          let plan = editorPlan;
          if (plan && e.moveEnding != null) {
            const line = plan.storyline.find((x) => x.sentenceId === e.moveEnding);
            if (line) plan = { ...plan, storyline: [...plan.storyline.filter((x) => x.sentenceId !== e.moveEnding), { ...line, role: "ENDING" }] };
          }
          const recut = await applyStyleCutChoice(db, storage, contentItemId, "FULL", actor.actorId, {
            ...(prev as object),
            ...(plan ? { editorPlan: plan, useEditor: true } : {}),
            forceDrop: [...new Set([...((prev.forceDrop as number[] | undefined) ?? []), ...e.forceDrop])],
            forceKeep: [...new Set([...((prev.forceKeep as number[] | undefined) ?? []), ...e.forceKeep])],
          });
          if (recut.ok) fixedTimeline = applyWatchFixes(recut.timeline, fixes.filter((f) => f.stage !== "EDITOR")).timeline;
          else applied.push(`(re-cut failed: ${recut.error})`);
        } else {
          await saveFinishingEdit(db, { contentItemId, timeline: fixedTimeline, durationSeconds: timelineDuration(fixedTimeline), actorId: actor.actorId, note: `Watch-back fixes (automatic): ${applied.join("; ")}` });
        }
        progress(90, "Rendering again…");
        const r = await renderContentItem(db, storage, contentItemId, { onProgress: (p) => progress(90 + p.pct * 0.05, p.message) }, actor);
        if (r.status === "SUCCESS") {
          await runQualityGateForContentItem(db, storage, getModel(), contentItemId, actor).catch(() => null);
          progress(96, "Watching it back once more…");
          const second = await watchBackContentItem(db, storage, getModel, contentItemId, actor, { ...options, loop: 1, afterFixes: applied, applyFixes: false });
          return { ...second, applied };
        }
        applied.push(`(re-render failed: ${r.errorMessage ?? "unknown"})`);
      }
    }
    return { watchVerdictId: row.id, verdict, loop, fixes, applied, coldViewer: watch.verdict.coldViewer, hook, costUsd: estimate.costUsd };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function chunkTranscript(words: Array<{ word: string; start: number; end: number }>): string {
  const lines: string[] = [];
  let cur: typeof words = [];
  for (const w of words) {
    cur.push(w);
    if (/[.!?]["'”’)]*$/.test(w.word) || cur.length >= 18) {
      lines.push(`[${cur[0]!.start.toFixed(1)}s] ${cur.map((x) => x.word).join(" ")}`);
      cur = [];
    }
  }
  if (cur.length) lines.push(`[${cur[0]!.start.toFixed(1)}s] ${cur.map((x) => x.word).join(" ")}`);
  return lines.join("\n");
}

function describeTimeline(t: EditTimeline): string {
  const texts = t.texts.map((x) => `- text ${x.id} "${x.text}" ${x.start.toFixed(1)}–${x.end.toFixed(1)}s at y=${x.y}`);
  const visuals = t.visuals.map((v) => `- graphic ${v.id} ${v.template} ${v.start.toFixed(1)}–${v.end.toFixed(1)}s`);
  const zooms = t.zooms.map((z) => `- zoom ${z.id} ${z.start.toFixed(1)}–${z.end.toFixed(1)}s ×${z.zoom}`);
  return [...texts, ...visuals, ...zooms, `- captions: ${t.captions.enabled ? `${t.captions.preset} ${t.captions.fontSize}px at y=${t.captions.y}` : "off"}`].join("\n") || "(nothing on screen)";
}

function describeScreen(screen: Record<string, unknown>, t: EditTimeline): string {
  const s = screen as { headlineZone?: string | null; captionZone?: string; captionPreset?: string; leads?: Array<{ beatIndex: number; lead: string; at: number }>; coverFrameSeconds?: number | null; notes?: string[] };
  return [
    `headline zone: ${s.headlineZone ?? "none"} · captions: ${s.captionZone ?? "?"}/${s.captionPreset ?? "?"} · cover frame: ${s.coverFrameSeconds ?? "—"}`,
    `leads per beat: ${(s.leads ?? []).map((l) => `${l.beatIndex}:${l.lead}@${l.at.toFixed(1)}`).join(" ") || "none"}`,
    ...(s.notes?.length ? [`orchestrator notes: ${s.notes.join(" // ")}`] : []),
    describeTimeline(t),
  ].join("\n");
}
