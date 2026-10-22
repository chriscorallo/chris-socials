import type { PrismaClient } from "@prisma/client";
import { FULL_EDIT_AUTO_REASON, STYLE_CUT_AUTO_REASON } from "./style-cut-plan";

/**
 * Upload → ready latency (docs/PREMIUM_EDITOR_HANDOFF.md §3.3). "Ready" = the first automatic
 * edit (Editor / Full edit / style cut) recorded after the footage arrived. Budget: 8 minutes —
 * slower than that and Chris goes back to editing by hand.
 */
export const READY_BUDGET_MINUTES = 8;

export interface UploadLatency {
  uploadedAt: Date;
  transcribedAt: Date | null;
  readyAt: Date | null;
  minutes: number | null;
  overBudget: boolean;
}

const AUTO_REASONS = new Set([FULL_EDIT_AUTO_REASON, STYLE_CUT_AUTO_REASON]);

/** Pure: the latency from the take rows and plan rows (any order). Null when nothing was uploaded. */
export function computeUploadLatency(
  takes: Array<{ createdAt: Date; transcribedAt: Date | null }>,
  plans: Array<{ createdAt: Date; revisionReason: string | null }>,
): UploadLatency | null {
  if (takes.length === 0) return null;
  const first = [...takes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]!;
  const uploadedAt = first.createdAt;
  const ready = plans
    .filter((p) => p.revisionReason != null && AUTO_REASONS.has(p.revisionReason) && p.createdAt.getTime() >= uploadedAt.getTime())
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  const minutes = ready ? Math.round(((ready.createdAt.getTime() - uploadedAt.getTime()) / 60_000) * 10) / 10 : null;
  return { uploadedAt, transcribedAt: first.transcribedAt, readyAt: ready?.createdAt ?? null, minutes, overBudget: minutes != null && minutes > READY_BUDGET_MINUTES };
}

export async function uploadToReadyLatency(prisma: PrismaClient, contentItemId: string): Promise<UploadLatency | null> {
  const takes = await prisma.mediaAsset.findMany({
    where: { contentItemId, kind: "RAW_TAKE", removedAt: null },
    select: { createdAt: true, transcribedAt: true },
  });
  if (takes.length === 0) return null;
  const plans = await prisma.editPlan.findMany({
    where: { contentItemId, revisionReason: { in: [...AUTO_REASONS] } },
    select: { createdAt: true, revisionReason: true },
  });
  return computeUploadLatency(takes, plans);
}
