import { prisma, getActiveHeavyJob, latestWatchRating, latestWatchVerdict, getSeriesAgreement, isEnabled, WATCH_BACK_GATING_FLAG, WATCH_BACK_FIX_LOOP_FLAG, type SeriesAgreement } from "@chris/domain";

/**
 * SERVER-ONLY. What the "Watch-back" card needs: the latest verdict (and whether it is for the
 * current render), Chris's rating of it, the series' agreement, the flags, a running job.
 */
export interface WatchBackView {
  id: string;
  createdAt: string;
  verdict: "PASS" | "FIX" | "HOLD";
  loop: number;
  checklist: Array<{ check: string; ok: boolean; finding: string; evidence: Array<{ t: number; kind: string; detail: string }> }>;
  fixes: Array<Record<string, unknown> & { stage: string; op: string; why: string }>;
  audits: Array<{ stage: string; kind: string; atS: number; detail: string }>;
  hookTest: { wouldKeepWatching: string; firstFrameRead: string; why: string; missing: string | null } | null;
  coldViewer: string;
  contrast: Array<{ t: number; reference: string; ours: string }>;
  model: string;
  costUsd: number | null;
  isForCurrentVersion: boolean;
}

export interface WatchBackData {
  contentItemId: string;
  hasRender: boolean;
  latest: WatchBackView | null;
  rating: { rating: string; action: string; createdAt: string } | null;
  agreement: SeriesAgreement;
  gating: boolean;
  fixLoop: boolean;
  activeJobRunId: string | null;
}

export async function getWatchBackForVideo(contentItemId: string): Promise<WatchBackData> {
  const render = await prisma.render.findFirst({ where: { contentItemId, status: "SUCCESS" }, orderBy: { createdAt: "desc" }, select: { id: true } });
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId }, select: { series: true } });
  const v = await latestWatchVerdict(prisma, { contentItemId });
  const rating = v ? await prisma.watchRating.findFirst({ where: { watchVerdictId: v.id }, orderBy: { createdAt: "desc" } }) : await latestWatchRating(prisma, contentItemId);
  const agreement = await getSeriesAgreement(prisma, item.series);
  const gating = await isEnabled(prisma, WATCH_BACK_GATING_FLAG);
  const fixLoop = await isEnabled(prisma, WATCH_BACK_FIX_LOOP_FLAG);
  const active = await getActiveHeavyJob(prisma, contentItemId).catch(() => null);
  const summary = v ? (v.inputSummary as { contrast?: WatchBackView["contrast"] } | null) : null;
  return {
    contentItemId,
    hasRender: !!render,
    latest: v
      ? {
          id: v.id,
          createdAt: v.createdAt.toISOString(),
          verdict: v.verdict as WatchBackView["verdict"],
          loop: v.loop,
          checklist: (v.checklist as WatchBackView["checklist"]) ?? [],
          fixes: (v.fixes as WatchBackView["fixes"]) ?? [],
          audits: (v.audits as WatchBackView["audits"]) ?? [],
          hookTest: (v.hookTest as WatchBackView["hookTest"]) ?? null,
          coldViewer: v.coldViewer,
          contrast: summary?.contrast ?? [],
          model: v.model,
          costUsd: v.costUsd,
          isForCurrentVersion: !render || v.renderId === render.id,
        }
      : null,
    rating: rating ? { rating: rating.rating, action: rating.action, createdAt: rating.createdAt.toISOString() } : null,
    agreement,
    gating,
    fixLoop,
    activeJobRunId: active && active.summary?.jobKind === "watch-back" ? active.id : null,
  };
}
