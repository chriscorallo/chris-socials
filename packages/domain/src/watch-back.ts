import type { PrismaClient, WatchVerdict as WatchVerdictRow, WatchRating as WatchRatingRow } from "@prisma/client";
import { recordAudit } from "./audit";
import { isEnabled } from "./feature-flags";

/**
 * Watch-back gate persistence + autonomy as agreement (docs/PREMIUM_EDITOR_PLAN.md round 2,
 * built 2026-10-22). Verdicts are append-only per render; Chris's one-tap rating at post time
 * (or his HOLD choice) is the label. Shadow accuracy per series = agreement between the
 * watch's verdict and his rating over the last ten rated videos; a series earns hands-off
 * posting at ≥ 90 % agreement with no "post anyway" override in those ten, and loses it on any
 * pulled post or rejected auto-post. The global kill switch (autonomy.shadow_only) and the
 * ceiling stay human-only and sit above all of this.
 */
export type WatchVerdictKind = "PASS" | "FIX" | "HOLD";
export type WatchRatingKind = "UP" | "DOWN";
export type WatchRatingAction = "POSTED_UNCHANGED" | "EDITED_FIRST" | "REJECTED" | "POST_ANYWAY" | "FIX_IT" | "PULLED";

/** Apply the watch's typed fixes and re-watch once (default off: shadow). */
export const WATCH_BACK_FIX_LOOP_FLAG = "watch_back.fix_loop";
/** A HOLD blocks READY like a technical BLOCK (default off: shadow). */
export const WATCH_BACK_GATING_FLAG = "watch_back.gating";
/** Run the watch automatically after every quality-gate PASS (default off until trusted). */
export const WATCH_BACK_AUTO_FLAG = "watch_back.auto";

export const WATCH_AGREEMENT_WINDOW = 10;
export const WATCH_AGREEMENT_PROMOTE = 0.9;

export interface RecordWatchVerdictInput {
  contentItemId: string;
  renderId: string;
  editPlanId: string | null;
  loop: number;
  verdict: WatchVerdictKind;
  checklist: unknown;
  fixes: unknown[];
  audits: unknown;
  hookTest: unknown | null;
  coldViewer: string;
  promptVersion: string;
  model: string;
  inputSummary: Record<string, unknown>;
  costUsd: number | null;
  jobRunId: string | null;
}

export async function recordWatchVerdict(prisma: PrismaClient, input: RecordWatchVerdictInput, actor: { actorId: string }): Promise<WatchVerdictRow> {
  const row = await prisma.watchVerdict.create({
    data: {
      contentItemId: input.contentItemId,
      renderId: input.renderId,
      editPlanId: input.editPlanId,
      loop: input.loop,
      verdict: input.verdict,
      checklist: input.checklist as object,
      fixes: input.fixes as object[],
      audits: input.audits as object,
      hookTest: (input.hookTest as object | null) ?? undefined,
      coldViewer: input.coldViewer,
      promptVersion: input.promptVersion,
      model: input.model,
      inputSummary: input.inputSummary as object,
      costUsd: input.costUsd,
      jobRunId: input.jobRunId,
      createdBy: actor.actorId,
    },
  });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "SYSTEM",
    action: "WATCH_BACK_VERDICT",
    entityType: "WatchVerdict",
    entityId: row.id,
    after: { contentItemId: input.contentItemId, renderId: input.renderId, loop: input.loop, verdict: input.verdict, fixes: input.fixes.length, model: input.model, costUsd: input.costUsd },
  });
  return row;
}

export async function latestWatchVerdict(prisma: PrismaClient, where: { contentItemId: string } | { renderId: string }): Promise<WatchVerdictRow | null> {
  return prisma.watchVerdict.findFirst({ where, orderBy: { createdAt: "desc" } });
}

export async function listWatchVerdicts(prisma: PrismaClient, contentItemId: string, limit = 10): Promise<WatchVerdictRow[]> {
  return prisma.watchVerdict.findMany({ where: { contentItemId }, orderBy: { createdAt: "desc" }, take: limit });
}

/** Videos whose latest watch said HOLD (or FIX with the loop spent) and that Chris hasn't
 * answered yet: the HOLD queue. */
export async function listWatchHolds(prisma: PrismaClient, limit = 20): Promise<Array<{ verdict: WatchVerdictRow; title: string | null; state: string }>> {
  const rows = await prisma.watchVerdict.findMany({ where: { verdict: { in: ["HOLD", "FIX"] } }, orderBy: { createdAt: "desc" }, take: 200 });
  const out: Array<{ verdict: WatchVerdictRow; title: string | null; state: string }> = [];
  const seen = new Set<string>();
  for (const v of rows) {
    if (seen.has(v.contentItemId) || out.length >= limit) continue;
    seen.add(v.contentItemId);
    const latest = await prisma.watchVerdict.findFirst({ where: { contentItemId: v.contentItemId }, orderBy: { createdAt: "desc" } });
    if (!latest || latest.verdict === "PASS") continue;
    if (latest.verdict === "FIX" && latest.loop === 0) continue; // the loop may still run
    const rated = await prisma.watchRating.findFirst({ where: { watchVerdictId: latest.id } });
    if (rated) continue;
    const item = await prisma.contentItem.findUnique({ where: { id: v.contentItemId }, select: { title: true, currentState: true } });
    if (!item || ["PUBLISHED", "MEASURING", "ARCHIVED", "CANCELLED"].includes(item.currentState)) continue;
    out.push({ verdict: latest, title: item.title, state: item.currentState });
  }
  return out;
}

export async function recordWatchRating(
  prisma: PrismaClient,
  input: { watchVerdictId: string; rating: WatchRatingKind; action: WatchRatingAction; note?: string | null },
  actor: { actorId: string },
): Promise<WatchRatingRow> {
  const verdict = await prisma.watchVerdict.findUniqueOrThrow({ where: { id: input.watchVerdictId } });
  const row = await prisma.watchRating.create({
    data: { watchVerdictId: verdict.id, contentItemId: verdict.contentItemId, rating: input.rating, action: input.action, note: input.note ?? null, createdBy: actor.actorId },
  });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "WATCH_BACK_RATED",
    entityType: "WatchRating",
    entityId: row.id,
    after: { contentItemId: verdict.contentItemId, verdict: verdict.verdict, rating: input.rating, action: input.action, note: input.note ?? null },
  });
  return row;
}

/** The latest rating for a video (any verdict), or null. */
export async function latestWatchRating(prisma: PrismaClient, contentItemId: string): Promise<WatchRatingRow | null> {
  return prisma.watchRating.findFirst({ where: { contentItemId }, orderBy: { createdAt: "desc" } });
}

export interface SeriesAgreement {
  series: string | null;
  rated: number;
  agreed: number;
  /** 0–1 over the last WATCH_AGREEMENT_WINDOW rated videos; null with none rated. */
  agreement: number | null;
  overrides: number;
  pulled: number;
  earned: boolean;
  why: string;
}

/** Pure: does a (verdict, rating) pair agree? PASS ↔ UP, FIX/HOLD ↔ DOWN. */
export function watchAgrees(verdict: string, rating: string): boolean {
  return (verdict === "PASS" && rating === "UP") || (verdict !== "PASS" && rating === "DOWN");
}

/** Pure: the promotion rule on a window of (verdict, rating, action) triples, newest first. */
export function seriesAgreementFrom(series: string | null, rows: Array<{ verdict: string; rating: string; action: string }>): SeriesAgreement {
  const window = rows.slice(0, WATCH_AGREEMENT_WINDOW);
  const rated = window.length;
  const agreed = window.filter((r) => watchAgrees(r.verdict, r.rating)).length;
  const overrides = window.filter((r) => r.action === "POST_ANYWAY").length;
  const pulled = window.filter((r) => r.action === "PULLED" || (r.action === "REJECTED" && r.verdict === "PASS")).length;
  const agreement = rated ? Math.round((agreed / rated) * 100) / 100 : null;
  const enough = rated >= WATCH_AGREEMENT_WINDOW;
  const earned = enough && (agreement ?? 0) >= WATCH_AGREEMENT_PROMOTE && overrides === 0 && pulled === 0;
  const why = !enough
    ? `${rated} of ${WATCH_AGREEMENT_WINDOW} rated videos so far`
    : pulled
      ? "a post was pulled or an auto-post rejected — demoted until ten clean ratings"
      : overrides
        ? `${overrides} "post anyway" override${overrides === 1 ? "" : "s"} in the last ${WATCH_AGREEMENT_WINDOW}`
        : (agreement ?? 0) >= WATCH_AGREEMENT_PROMOTE
          ? `${Math.round((agreement ?? 0) * 100)} % agreement over the last ${WATCH_AGREEMENT_WINDOW}`
          : `${Math.round((agreement ?? 0) * 100)} % agreement — needs ${Math.round(WATCH_AGREEMENT_PROMOTE * 100)} %`;
  return { series, rated, agreed, agreement, overrides, pulled, earned, why };
}

/** Shadow accuracy and the earned flag for one series (null series = videos without one). */
export async function getSeriesAgreement(prisma: PrismaClient, series: string | null): Promise<SeriesAgreement> {
  const items = await prisma.contentItem.findMany({ where: { series: series ?? null }, select: { id: true } });
  const ids = items.map((i) => i.id);
  if (!ids.length) return seriesAgreementFrom(series, []);
  const ratings = await prisma.watchRating.findMany({ where: { contentItemId: { in: ids } }, orderBy: { createdAt: "desc" }, take: 100, include: { verdict: { select: { verdict: true } } } });
  // One rating per video: the latest.
  const seen = new Set<string>();
  const rows: Array<{ verdict: string; rating: string; action: string }> = [];
  for (const r of ratings) {
    if (seen.has(r.contentItemId)) continue;
    seen.add(r.contentItemId);
    rows.push({ verdict: r.verdict.verdict, rating: r.rating, action: r.action });
  }
  return seriesAgreementFrom(series, rows);
}

/**
 * May this video post without a click? The series must have earned it (agreement), the global
 * kill switch must be off and PUBLISHING must have its level — all three, never fewer.
 */
export async function watchBackEarnedFor(prisma: PrismaClient, contentItemId: string): Promise<{ earned: boolean; agreement: SeriesAgreement; shadowOnly: boolean }> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId }, select: { series: true } });
  const agreement = await getSeriesAgreement(prisma, item.series);
  const shadowOnly = await isEnabled(prisma, "autonomy.shadow_only");
  return { earned: agreement.earned && !shadowOnly, agreement, shadowOnly };
}
