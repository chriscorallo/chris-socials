import {
  prisma,
  getActiveHeavyJob,
  getAiSpendOverview,
  getLatestViewerReview,
  latestViewerReviewsForReferences,
  parseReferenceVideoMetrics,
  type ViewerReviewRow,
} from "@chris/domain";
import { estimateViewerReviewForVideo, formatEstimateUsd, getBrandContextText, ViewerReviewSchema } from "@chris/agents";
import { EditTimelineSchema, clipStartTimes } from "@chris/media/timeline";
import { referenceVideoSubject } from "@chris/worker/heavy-job-kinds";
import { resolveDailyCapUsd } from "./model-provider";
import { aiAvailability, type ViewerCheckData, type ViewerReviewView } from "./viewer-check-view";

/**
 * SERVER-ONLY. Everything the "Viewer check" card needs, read in one place (sequential reads —
 * PGlite): whether there's something to watch, the price BEFORE running (same frame plan the
 * job builds), whether the AI can run right now (key / credit / daily cap), the latest review
 * and a job already running. See docs/decisions-pending/viewer-panel.md.
 */

function toView(row: ViewerReviewRow, currentRenderId: string | null): ViewerReviewView | null {
  const parsed = ViewerReviewSchema.safeParse(row.review);
  if (!parsed.success) return null;
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    review: parsed.data,
    warnings: Array.isArray(row.warnings) ? (row.warnings as string[]) : [],
    platform: row.platform,
    persona: row.persona,
    model: row.model,
    costUsd: row.costUsd,
    estimatedCostUsd: row.estimatedCostUsd,
    durationS: Number((row.inputSummary as { durationS?: number } | null)?.durationS ?? 0) || null,
    frames: Array.isArray((row.inputSummary as { frames?: unknown[] } | null)?.frames) ? (row.inputSummary as { frames: unknown[] }).frames.length : null,
    isForCurrentVersion: currentRenderId == null || row.renderId == null || row.renderId === currentRenderId,
  };
}

async function aiState() {
  let cap: number | null;
  try {
    cap = resolveDailyCapUsd();
  } catch {
    cap = null;
  }
  const o = await getAiSpendOverview(prisma, new Date()).catch(() => null);
  return aiAvailability({ keySet: Boolean(process.env.ANTHROPIC_API_KEY), creditError: !!o?.creditError, todayUsd: o?.todayUsd ?? 0, capUsd: cap });
}

async function activeViewerJob(subject: string): Promise<string | null> {
  const active = await getActiveHeavyJob(prisma, subject).catch(() => null);
  return active && active.summary?.jobKind === "viewer-review" ? active.id : null;
}

export async function getViewerCheckForVideo(contentItemId: string): Promise<ViewerCheckData> {
  const render = await prisma.render.findFirst({ where: { contentItemId, status: "SUCCESS", storageKey: { not: null } }, orderBy: { createdAt: "desc" } });
  const entry = await prisma.scheduleEntry.findUnique({ where: { contentItemId }, select: { targetPlatforms: true } }).catch(() => null);
  const scheduled = Array.isArray(entry?.targetPlatforms) ? (entry.targetPlatforms as string[]) : [];
  const defaultPlatform = (["TIKTOK", "INSTAGRAM", "YOUTUBE"].find((p) => scheduled.includes(p)) ?? "INSTAGRAM") as ViewerCheckData["defaultPlatform"];
  const latestRow = await getLatestViewerReview(prisma, { contentItemId });
  const latest = latestRow ? toView(latestRow, render?.id ?? null) : null;
  const ai = await aiState();
  const activeJobRunId = await activeViewerJob(contentItemId);
  if (!render?.storageKey) {
    return { subject: { kind: "RENDER", contentItemId }, mediaUrl: null, unavailable: "Once the video is rendered, a new viewer can watch it here.", estimate: null, ai, defaultPlatform, latest, activeJobRunId };
  }
  const plan = await prisma.editPlan.findUnique({ where: { id: render.editPlanId }, select: { plan: true } });
  const raw = (plan?.plan as Record<string, unknown> | null)?.timeline;
  const tl = raw != null ? EditTimelineSchema.safeParse(raw) : null;
  const timeline = tl?.success ? tl.data : null;
  const cutTimes = timeline ? clipStartTimes(timeline).slice(1) : [];
  const eventTimes = timeline ? [...timeline.texts.map((t) => t.start), ...timeline.visuals.map((v) => v.start), ...timeline.zooms.map((z) => z.start)] : [];
  const brandChars = (await getBrandContextText(prisma).catch(() => "")).length;
  const est = estimateViewerReviewForVideo({
    durationS: render.durationSeconds ?? 30,
    cutTimes,
    eventTimes,
    width: render.width,
    height: render.height,
    brandContextChars: brandChars,
  });
  return {
    subject: { kind: "RENDER", contentItemId },
    mediaUrl: `/api/media/${render.storageKey}`,
    unavailable: null,
    estimate: { label: formatEstimateUsd(est.costUsd), usd: est.costUsd, highUsd: est.highUsd, frames: est.frames },
    ai,
    defaultPlatform,
    latest,
    activeJobRunId,
  };
}

export async function getViewerCheckForReference(referenceContentId: string): Promise<ViewerCheckData> {
  const latestRow = await getLatestViewerReview(prisma, { referenceContentId });
  return referenceCheck(referenceContentId, latestRow, await aiState());
}

/** Every reference video on a creator page at once (the AI status is read once). */
export async function getViewerChecksForReferences(referenceContentIds: string[]): Promise<Map<string, ViewerCheckData>> {
  const out = new Map<string, ViewerCheckData>();
  if (referenceContentIds.length === 0) return out;
  const ai = await aiState();
  const latest = await latestViewerReviewsForReferences(prisma, referenceContentIds);
  for (const id of referenceContentIds) out.set(id, await referenceCheck(id, latest.get(id) ?? null, ai));
  return out;
}

async function referenceCheck(referenceContentId: string, latestRow: ViewerReviewRow | null, ai: ViewerCheckData["ai"]): Promise<ViewerCheckData> {
  const row = await prisma.referenceContent.findUnique({ where: { id: referenceContentId } });
  const defaultPlatform = ((row?.platform as string | null) ?? "INSTAGRAM") as ViewerCheckData["defaultPlatform"];
  const latest = latestRow ? toView(latestRow, null) : null;
  const activeJobRunId = await activeViewerJob(referenceVideoSubject(referenceContentId));
  const subject = { kind: "REFERENCE_VIDEO" as const, referenceContentId };
  if (!row?.mediaStorageKey) {
    return { subject, mediaUrl: null, unavailable: "The video file was deleted, so a viewer can't watch it.", estimate: null, ai, defaultPlatform, latest, activeJobRunId };
  }
  const m = parseReferenceVideoMetrics(row.metrics);
  const est = estimateViewerReviewForVideo({
    durationS: m?.video.durationS ?? 45,
    cutTimes: m?.cuts?.times ?? [],
    width: m?.video.width ?? null,
    height: m?.video.height ?? null,
    wordCount: m ? (m.speech?.wordCount ?? 0) : null,
  });
  return {
    subject,
    mediaUrl: `/api/media/${row.mediaStorageKey.split("/").map(encodeURIComponent).join("/")}`,
    unavailable: null,
    estimate: { label: formatEstimateUsd(est.costUsd), usd: est.costUsd, highUsd: est.highUsd, frames: est.frames },
    ai,
    defaultPlatform,
    latest,
    activeJobRunId,
  };
}
