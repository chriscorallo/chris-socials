"use server";

import { prisma, saveFinishingEdit, scheduleContentItemForPublishing, getLatestEditPlan, recordMotionEditSignals, getHeavyJob, getGraphicPrefs, setGraphicFavorite, recordGraphicPresetUse, parsePreviewMeta, PREVIEW_META_VERSION, requestGraphicBakes, pruneGraphicBakes, type ContentState, type GraphicPrefs, type GraphicBakeState } from "@chris/domain";
import { EditTimelineSchema, graphicBakeKey, type EditTimeline, type PlacementWarning, type GraphicBakeInput } from "@chris/media/timeline";
import { designMotionForContentItem } from "@chris/worker/motion-design-job";
import { renderContentItem } from "@chris/worker";
import { runQualityGateForContentItem } from "@chris/worker/quality-gate-job";
import { applyStyleCutChoice } from "@chris/worker/style-cut-job";
import { requireSession } from "../../../../lib/session";
import { storage } from "../../../../lib/storage";
import { getModelProvider } from "../../../../lib/model-provider";
import { getRenderFontPath, heavyJobMode, isAutoSubjectTrackingEnabled } from "../../../../lib/render-config";
import { runHeavyJob, type RunHeavyJobResult } from "../../../../lib/heavy-jobs";
import { plainJobError } from "../../../../lib/heavy-job-text";
import type { EditorAsset, EditorMusicAsset } from "../../../../lib/editor/types";
import { editorAssetsFrom } from "../../../../lib/editor/editor-assets";

/**
 * Server Actions for the finishing editor. "Finish & schedule" is deliberately FOUR actions
 * the client calls in sequence (save → render → quality check → schedule) rather than one:
 * each is its own request, so the modal shows real progress per step, and a failure at any
 * step leaves everything before it done (the edit stays saved; a failed gate never schedules).
 * Every action returns a plain result instead of throwing, worded for Chris.
 */

export type StepResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; state?: ContentState };

/** A step handed to the cloud worker (Vercel): the client polls /api/jobs/<jobRunId>. */
export interface PendingJob {
  pending: true;
  jobRunId: string;
}

function notStarted(r: Exclude<RunHeavyJobResult, { status: "done" | "started" }>): { ok: false; error: string } {
  return { ok: false, error: r.message };
}

async function stateOf(contentItemId: string): Promise<ContentState> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId }, select: { currentState: true } });
  return item.currentState;
}

/** Turns internal/agent errors into a sentence a non-technical owner can act on. */
function plainError(err: unknown, step: string): string {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "SpendCapExceededError") {
    return "Today's AI spending limit has been reached, so the AI quality check couldn't run. Your edit is saved — try again tomorrow, or raise MODEL_SPEND_DAILY_CAP_USD.";
  }
  // Credit first: Anthropic's out-of-credit message mentions "Anthropic API", which the key
  // check below would otherwise misread as "no key".
  if (/credit balance|billing|insufficient|quota/i.test(msg)) {
    return "The AI account is out of credit, so the quality check couldn't run. Your edit is saved and rendered — add credit (More → AI credit) and press Finish again.";
  }
  if (/api[_ ]?key|authentication|x-api-key|401/i.test(msg)) {
    return "The quality check needs the AI service, which isn't set up (no Anthropic API key). Your edit is saved and rendered.";
  }
  return `${step} failed: ${msg}`;
}

/** Same idea for the Motion Designer ("Design visuals with AI"). */
function plainDesignError(msg: string): string {
  if (/SpendCap|spending limit|spend cap/i.test(msg)) {
    return "Today's AI spending limit has been reached, so the AI couldn't design visuals. Your edit is unchanged — try again tomorrow, or add graphics by hand from the gallery below.";
  }
  if (/credit balance|billing|insufficient|quota/i.test(msg)) {
    return "The AI account is out of credit, so it couldn't design visuals. Your edit is unchanged — add credit (More → AI credit) and try again, or add graphics by hand from the gallery below.";
  }
  if (/api[_ ]?key|authentication|x-api-key|ANTHROPIC|401/i.test(msg)) {
    return "Designing visuals needs the AI service, which isn't set up (no Anthropic API key). Your edit is unchanged — you can still add graphics by hand from the gallery below.";
  }
  if (/overloaded|rate.?limit|529|503|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(msg)) {
    return "The AI service is busy or unreachable right now. Your edit is unchanged — try again in a minute.";
  }
  if (/No edit plan/i.test(msg)) return "This video doesn't have an edit yet, so there's nothing to design visuals for.";
  return `The AI couldn't design visuals: ${msg.replace(/\.+$/, "")}. Your edit is unchanged.`;
}

export interface DesignVisualsStepResult {
  editPlanId: string;
  state: ContentState;
  /** The newly saved timeline (with the visuals) — the editor loads it as the saved version. */
  timeline: EditTimeline;
  added: Array<{ id: string; template: string; start: number; end: number; anchorText: string | null }>;
  rejected: Array<{ template: string; start: number; end: number; anchorText: string; reason: string }>;
  placementWarnings: PlacementWarning[];
  notes: string[];
  rationale: string;
}

/**
 * "Design visuals with AI": runs the Motion Designer on the item's CURRENT saved edit (the
 * client saves unsaved changes first) and saves the result as a new finishing-edit version
 * (trigger HUMAN — saveFinishingEdit, so a rendered item rolls back to EDIT_PLANNED like any
 * edit). Subject tracking runs first where it's allowed (local; ONNX is too heavy for a Vercel
 * function — placement then assumes a centred framing and says so). Never throws: errors come
 * back worded for Chris.
 */
export async function designVisualsAction(input: {
  contentItemId: string;
  replaceExisting?: boolean;
  /** "Suggest with AI" in the graphics library: one graphic for this moment. */
  focus?: { start: number; end: number; phrase?: string | null } | null;
}): Promise<StepResult<DesignVisualsStepResult> | ({ ok: true } & PendingJob)> {
  const session = await requireSession();
  if (heavyJobMode() === "sandbox") {
    // Vercel: face tracking (ONNX) + the Motion Designer run in the cloud worker; the client
    // polls the job, then calls designVisualsResultAction for the saved version.
    const r = await runHeavyJob("motion-design", { contentItemId: input.contentItemId, replaceExisting: input.replaceExisting ?? false, focus: input.focus ?? null }, { actorId: session.user!.id! });
    if (r.status === "started") return { ok: true, pending: true, jobRunId: r.jobRunId };
    if (r.status === "done") return designResultFromJob(input.contentItemId, r.outcome.ok, r.outcome.result, r.outcome.error ?? null);
    return notStarted(r);
  }
  try {
    const result = await designMotionForContentItem(
      prisma,
      storage,
      getModelProvider(),
      input.contentItemId,
      { actorId: session.user!.id! },
      { trigger: "HUMAN", replaceExisting: input.replaceExisting ?? false, focus: input.focus ?? null, skipTracking: !isAutoSubjectTrackingEnabled() },
    );
    if (result.status !== "SUCCESS" || !result.editPlanId) {
      return { ok: false, error: plainDesignError(result.errorMessage ?? "unknown error"), state: await stateOf(input.contentItemId).catch(() => undefined) };
    }
    const row = await getLatestEditPlan(prisma, input.contentItemId);
    const parsed = EditTimelineSchema.safeParse((row?.plan as Record<string, unknown> | null)?.timeline);
    if (!row || !parsed.success) {
      return { ok: false, error: "The visuals were saved, but the editor couldn't read them back — reload the page." };
    }
    return {
      ok: true,
      editPlanId: row.id,
      state: await stateOf(input.contentItemId),
      timeline: parsed.data,
      added: (result.added ?? []).map((v) => ({ id: v.id, template: v.template, start: v.start, end: v.end, anchorText: v.anchorText })),
      rejected: result.rejectedVisuals ?? [],
      placementWarnings: result.placementWarnings ?? [],
      notes: result.warnings ?? [],
      rationale: result.rationale ?? "",
    };
  } catch (err) {
    return { ok: false, error: plainDesignError(err instanceof Error ? err.message : String(err)) };
  }
}

/** The finished cloud "Design visuals with AI" job → the same result the in-process path returns. */
export async function designVisualsResultAction(contentItemId: string, jobRunId: string): Promise<StepResult<DesignVisualsStepResult>> {
  await requireSession();
  const job = await getHeavyJob(prisma, jobRunId);
  if (!job || job.summary?.contentItemId !== contentItemId || job.summary.jobKind !== "motion-design") return { ok: false, error: "That design job wasn't found — try again." };
  if (job.status === "RUNNING" || job.status === "QUEUED") return { ok: false, error: "Still designing — give it a moment." };
  return designResultFromJob(contentItemId, job.status === "SUCCEEDED", job.summary.result, job.error);
}

async function designResultFromJob(contentItemId: string, ok: boolean, raw: unknown, error: string | null): Promise<StepResult<DesignVisualsStepResult>> {
  const r = (raw ?? {}) as {
    status?: string;
    editPlanId?: string | null;
    added?: DesignVisualsStepResult["added"];
    rejected?: DesignVisualsStepResult["rejected"];
    placementWarnings?: PlacementWarning[];
    notes?: string[];
    rationale?: string;
    errorMessage?: string | null;
  };
  if (!ok || r.status !== "SUCCESS" || !r.editPlanId) {
    return { ok: false, error: plainDesignError(r.errorMessage ?? error ?? "unknown error"), state: await stateOf(contentItemId).catch(() => undefined) };
  }
  const row = await getLatestEditPlan(prisma, contentItemId);
  const parsed = EditTimelineSchema.safeParse((row?.plan as Record<string, unknown> | null)?.timeline);
  if (!row || !parsed.success) return { ok: false, error: "The visuals were saved, but the editor couldn't read them back — reload the page." };
  return {
    ok: true,
    editPlanId: row.id,
    state: await stateOf(contentItemId),
    timeline: parsed.data,
    added: r.added ?? [],
    rejected: r.rejected ?? [],
    placementWarnings: r.placementWarnings ?? [],
    notes: r.notes ?? [],
    rationale: r.rationale ?? "",
  };
}

/**
 * "Style cut" sheet: STYLE re-applies the reference-paced cut (pauses out, cuts on the
 * references' rhythm); PLAIN goes back to the whole take. Either is saved as a new version
 * (the client loads it as the saved doc — undo brings the previous edit back). No AI.
 */
export async function styleCutAction(input: {
  contentItemId: string;
  mode: "STYLE" | "PLAIN";
}): Promise<StepResult<{ editPlanId: string; state: ContentState; timeline: EditTimeline; summary: string | null; profileNote: string | null }>> {
  const session = await requireSession();
  try {
    const r = await applyStyleCutChoice(prisma, storage, input.contentItemId, input.mode, session.user!.id!);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, editPlanId: r.editPlanId, state: await stateOf(input.contentItemId), timeline: r.timeline, summary: r.summary, profileNote: r.profileNote };
  } catch (err) {
    return { ok: false, error: plainError(err, input.mode === "STYLE" ? "The style cut" : "Going back to the full take") };
  }
}

/** The item's music beds (after an upload from the Sound sheet). */
export async function listMusicAction(contentItemId: string): Promise<EditorMusicAsset[]> {
  await requireSession();
  const rows = await prisma.mediaAsset.findMany({ where: { contentItemId, kind: "MUSIC" }, orderBy: { createdAt: "desc" } });
  return rows.map((m) => ({
    id: m.id,
    name: m.originalFilename.replace(/\.[^.]+$/, ""),
    url: `/api/media/${m.storageKey}`,
    duration: m.durationSeconds ?? 0,
  }));
}

export async function saveFinishingEditAction(input: {
  contentItemId: string;
  timeline: unknown;
  note?: string;
}): Promise<StepResult<{ editPlanId: string; state: ContentState; savedAt: string }>> {
  const session = await requireSession();
  const parsed = EditTimelineSchema.safeParse(input.timeline);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `The edit couldn't be saved — ${first ? `${first.path.join(".")}: ${first.message}` : "invalid timeline"}.` };
  }
  const duration = parsed.data.clips.reduce((s, c) => s + Math.max(0, c.sourceEnd - c.sourceStart), 0);
  const cover = parsed.data.coverFrameSeconds;
  const timeline = { ...parsed.data, coverFrameSeconds: cover == null ? null : Math.min(Math.max(0, cover), duration) };
  try {
    // Motion taste (additive): remember the version being replaced so the save can be diffed.
    const previous = await getLatestEditPlan(prisma, input.contentItemId).catch(() => null);
    const plan = await saveFinishingEdit(prisma, {
      contentItemId: input.contentItemId,
      timeline,
      durationSeconds: duration,
      actorId: session.user!.id!,
      note: input.note,
    });
    await learnMotionTaste(input.contentItemId, previous, timeline, plan.id, session.user!.id!);
    return { ok: true, editPlanId: plan.id, state: await stateOf(input.contentItemId), savedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: plainError(err, "Saving"), state: await stateOf(input.contentItemId).catch(() => undefined) };
  }
}

/** What Chris kept / edited / deleted in the motion graphics becomes taste evidence
 * (packages/domain motion-taste.ts). Best effort: learning never blocks or fails a save. */
async function learnMotionTaste(
  contentItemId: string,
  previous: { plan: unknown; revisionReason: string | null } | null,
  after: EditTimeline,
  planId: string,
  actorId: string,
): Promise<void> {
  try {
    const before = EditTimelineSchema.safeParse((previous?.plan as { timeline?: unknown } | null)?.timeline);
    await recordMotionEditSignals(prisma, {
      contentItemId,
      before: before.success ? before.data : null,
      after,
      actorId,
      planId,
      beforeWasAiDesign: /Motion Designer:/.test(previous?.revisionReason ?? ""),
    });
  } catch (err) {
    console.warn("[motion-taste] signals not recorded:", err instanceof Error ? err.message : err);
  }
}

export async function renderStepAction(
  contentItemId: string,
  options: { thenQualityGate?: boolean } = {},
): Promise<StepResult<{ state: ContentState; renderKey: string | null }> | ({ ok: true } & PendingJob)> {
  const session = await requireSession();
  if (heavyJobMode() === "sandbox") {
    // Vercel: render (+ the quality check right after it, same worker — one boot) in the cloud.
    const r = await runHeavyJob("render", { contentItemId, thenQualityGate: options.thenQualityGate ?? false }, { actorId: session.user!.id! });
    if (r.status === "started") return { ok: true, pending: true, jobRunId: r.jobRunId };
    // A render already running for this video (a second tap, another tab): follow it.
    if (r.status === "busy" && r.jobKind === "render") return { ok: true, pending: true, jobRunId: r.jobRunId };
    if (r.status === "busy" || r.status === "refused") return notStarted(r);
    return { ok: false, error: plainJobError(r.outcome.error), state: await stateOf(contentItemId).catch(() => undefined) };
  }
  try {
    const result = await renderContentItem(prisma, storage, contentItemId, { fontPath: getRenderFontPath() }, { actorId: session.user!.id! });
    const state = await stateOf(contentItemId);
    if (result.status !== "SUCCESS") {
      return { ok: false, error: `The render didn't pass its technical check: ${(result.errorMessage ?? "see the item page for details").replace(/\.+$/, "")}. Your edit is saved.`, state };
    }
    return { ok: true, state, renderKey: result.outputStorageKey ?? null };
  } catch (err) {
    return { ok: false, error: plainError(err, "Rendering"), state: await stateOf(contentItemId).catch(() => undefined) };
  }
}

/**
 * The cloud render(+check) job's outcome in the Finish modal's terms (render, then check).
 * `gateErrorText` uses the same wording as the in-process check.
 */
export async function finishJobResultAction(contentItemId: string, jobRunId: string): Promise<
  StepResult<{
    state: ContentState;
    render: { ok: boolean; error: string | null };
    check: null | { ok: true; passed: boolean; reasons: string[] } | { ok: false; error: string };
  }>
> {
  await requireSession();
  const job = await getHeavyJob(prisma, jobRunId);
  if (!job || job.summary?.contentItemId !== contentItemId) return { ok: false, error: "That render wasn't found — try again." };
  const state = await stateOf(contentItemId);
  const r = (job.summary.result ?? {}) as {
    render?: { status: string; errorMessage: string | null };
    gate?: { passed: boolean; reasons: string[] };
    gateError?: { name: string; message: string };
    errorName?: string;
  };
  if (!r.render) {
    return { ok: false, error: job.status === "FAILED" ? plainJobError(job.error, r.errorName) : "The render didn't report a result.", state };
  }
  const renderOk = r.render.status === "SUCCESS";
  const renderError = renderOk
    ? null
    : `The render didn't pass its technical check: ${(r.render.errorMessage ?? "see the item page for details").replace(/\.+$/, "")}. Your edit is saved.`;
  let check: { ok: true; passed: boolean; reasons: string[] } | { ok: false; error: string } | null = null;
  if (r.gate) check = { ok: true, passed: r.gate.passed, reasons: r.gate.reasons };
  else if (r.gateError) {
    const e = new Error(r.gateError.message);
    e.name = r.gateError.name;
    check = { ok: false, error: plainError(e, "The quality check") };
  }
  return { ok: true, state, render: { ok: renderOk, error: renderError }, check };
}

export async function qualityGateStepAction(
  contentItemId: string,
): Promise<StepResult<{ state: ContentState; passed: boolean; reasons: string[] }>> {
  const session = await requireSession();
  try {
    const result = await runQualityGateForContentItem(prisma, storage, getModelProvider(), contentItemId, { actorId: session.user!.id! });
    const state = await stateOf(contentItemId);
    return { ok: true, state, passed: state === "READY" || result.overallStatus === "PASS", reasons: result.reasons };
  } catch (err) {
    return { ok: false, error: plainError(err, "The quality check"), state: await stateOf(contentItemId).catch(() => undefined) };
  }
}

const PLATFORMS = new Set(["INSTAGRAM", "TIKTOK", "YOUTUBE"]);

export async function scheduleStepAction(input: {
  contentItemId: string;
  /** `datetime-local` value; interpreted in the server's (= app's) time zone. */
  scheduledDate: string;
  platforms: string[];
}): Promise<StepResult<{ state: ContentState; scheduledFor: string }>> {
  const session = await requireSession();
  const platforms = input.platforms.filter((p) => PLATFORMS.has(p)) as Array<"INSTAGRAM" | "TIKTOK" | "YOUTUBE">;
  if (platforms.length === 0) return { ok: false, error: "Pick at least one platform." };
  const when = new Date(input.scheduledDate);
  if (Number.isNaN(when.getTime())) return { ok: false, error: "Pick a date and time." };
  try {
    await scheduleContentItemForPublishing(
      prisma,
      { contentItemId: input.contentItemId, scheduledDate: when, targetPlatforms: platforms },
      { actorId: session.user!.id! },
    );
    return {
      ok: true,
      state: await stateOf(input.contentItemId),
      scheduledFor: when.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    };
  } catch (err) {
    return { ok: false, error: plainError(err, "Scheduling"), state: await stateOf(input.contentItemId).catch(() => undefined) };
  }
}


/**
 * Editor preview proxies (docs/decisions-pending/editor-smoothness-fullscreen-platform-ui.md):
 * takes uploaded before proxies existed get one lazily — the editor calls this once when it
 * opens on a take without a proxy, then polls `previewAssetsAction` and switches to the proxy
 * while paused. Background job (never blocks the editor); a busy video (another job running,
 * e.g. the upload's own analysis, which makes the proxy too) just means "try later".
 */
export async function ensurePreviewProxiesAction(contentItemId: string): Promise<{ started: boolean; message?: string }> {
  const session = await requireSession();
  const takes = await prisma.mediaAsset.findMany({ where: { contentItemId, kind: "RAW_TAKE", width: { not: null } }, select: { proxyStorageKey: true, previewMeta: true } });
  // Missing, or made before rotation-aware sizing (v1 could be squashed sideways).
  const missing = takes.filter((t) => !t.proxyStorageKey || parsePreviewMeta(t.previewMeta)?.v !== PREVIEW_META_VERSION).length;
  if (missing === 0) return { started: false };
  const r = await runHeavyJob("preview-proxy", { contentItemId }, { actorId: session.user!.id!, background: true });
  return r.status === "started" || r.status === "done" ? { started: true } : { started: false, message: r.message };
}

/**
 * Baked preview graphics (docs/decisions-pending/editor-rebuild.md): the editor sends the
 * graphics it shows (each with the inputs that decide its pixels); missing ones are queued and a
 * background `graphics-bake` job renders them. Returns every key's state. The key is recomputed
 * here from the input (a row is only ever filled with what its key names). Never throws.
 */
export async function graphicBakesAction(
  contentItemId: string,
  wanted: Array<{ key: string; input: GraphicBakeInput }>,
): Promise<{ states: GraphicBakeState[]; started: boolean; message?: string }> {
  const session = await requireSession();
  try {
    const ok = wanted
      .slice(0, 30)
      .filter((w) => JSON.stringify(w.input).length < 60_000 && graphicBakeKey(w.input) === w.key)
      .map((w) => ({ key: w.key, input: w.input as unknown as Record<string, unknown> }));
    if (ok.length < Math.min(30, wanted.length)) console.warn(`[graphic-bakes] ${wanted.length - ok.length} of ${wanted.length} requests rejected (key mismatch or too large)`);
    const { states, needsJob } = await requestGraphicBakes(prisma, contentItemId, ok);
    let started = false;
    let message: string | undefined;
    if (needsJob) {
      const r = await runHeavyJob("graphics-bake", { contentItemId }, { actorId: session.user!.id!, background: true });
      // "busy" = a bake job for this video is already running (polls land here) — fine.
      started = r.status === "started" || r.status === "done" || r.status === "busy";
      if (r.status === "refused") message = r.message;
    }
    const stale = await pruneGraphicBakes(prisma, contentItemId).catch(() => [] as string[]);
    for (const k of stale) await storage.delete(k).catch(() => undefined);
    return { states, started, message };
  } catch (err) {
    return { states: [], started: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** The editor's assets as they are now (picks up proxies made since the editor opened). */
export async function previewAssetsAction(contentItemId: string): Promise<EditorAsset[]> {
  await requireSession();
  const rows = await prisma.mediaAsset.findMany({ where: { contentItemId, kind: "RAW_TAKE" }, orderBy: { createdAt: "asc" } });
  return editorAssetsFrom(rows);
}

// ---------------------------------------------------------------------------------------
// Graphics library: favourites + recently used (per signed-in user). Best-effort — the
// library works without them, so failures return the empty/unchanged lists.
// ---------------------------------------------------------------------------------------

export async function graphicPrefsAction(): Promise<GraphicPrefs> {
  const session = await requireSession();
  try {
    return await getGraphicPrefs(prisma, session.user!.id!);
  } catch {
    return { favorites: [], recents: [] };
  }
}

export async function setGraphicFavoriteAction(presetId: string, favorite: boolean): Promise<GraphicPrefs | null> {
  const session = await requireSession();
  try {
    return await setGraphicFavorite(prisma, session.user!.id!, presetId, favorite);
  } catch {
    return null;
  }
}

export async function recordGraphicUseAction(presetId: string): Promise<GraphicPrefs | null> {
  const session = await requireSession();
  try {
    return await recordGraphicPresetUse(prisma, session.user!.id!, presetId);
  } catch {
    return null;
  }
}

/**
 * "Behind me" on a take with no person cut-out yet: make the cut-out now, in the background.
 * Uploads no longer cut Chris out of every take up front (it's the slowest, costliest cloud
 * step and most videos never put a graphic behind him) — docs/DECISIONS.md ("Person cut-out
 * on demand"). Renders also compute a missing cut-out themselves when a graphic is behind him.
 */
export async function ensurePersonCutoutAction(contentItemId: string): Promise<{ started: boolean; message?: string }> {
  const session = await requireSession();
  const missing = await prisma.mediaAsset.count({ where: { contentItemId, kind: "RAW_TAKE", matteStorageKey: null, width: { not: null } } });
  if (missing === 0) return { started: false };
  const r = await runHeavyJob("person-matte", { contentItemId }, { actorId: session.user!.id!, background: true });
  return r.status === "started" || r.status === "done" ? { started: true } : { started: false, message: r.message };
}
