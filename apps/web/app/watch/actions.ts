"use server";

import { revalidatePath } from "next/cache";
import { prisma, recordWatchRating, latestWatchVerdict, type WatchRatingAction, type WatchRatingKind } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { runHeavyJob } from "../../lib/heavy-jobs";

/**
 * The watch-back gate's buttons (docs/PREMIUM_EDITOR_PLAN.md round 2). Start = the `watch-back`
 * heavy job on the latest render. Rate = Chris's one-tap label at post time (UP = posted as-is,
 * DOWN = edited first / rejected) — what autonomy is earned against. Fix it = the job again with
 * the fix loop forced on. Post anyway = a journaled override that lets preflight through when
 * gating is on. Never throws to the client.
 */
export async function startWatchBack(input: { contentItemId: string; applyFixes?: boolean }): Promise<{ jobRunId: string } | { error: string }> {
  const session = await requireSession();
  try {
    const r = await runHeavyJob("watch-back", { contentItemId: input.contentItemId, ...(input.applyFixes ? { applyFixes: true } : {}) }, { actorId: session.user!.id!, background: true });
    if (r.status === "refused") return { error: r.message };
    if (r.status === "busy") return r.jobKind === "watch-back" ? { jobRunId: r.jobRunId } : { error: r.message };
    return { jobRunId: r.jobRunId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't start the watch-back." };
  }
}

export async function rateWatchBack(input: { contentItemId: string; rating: WatchRatingKind; action: WatchRatingAction; note?: string | null }): Promise<{ ok: true } | { error: string }> {
  const session = await requireSession();
  try {
    const verdict = await latestWatchVerdict(prisma, { contentItemId: input.contentItemId });
    if (!verdict) return { error: "Nothing to rate yet — the video hasn't been watched back." };
    await recordWatchRating(prisma, { watchVerdictId: verdict.id, rating: input.rating, action: input.action, note: input.note ?? null }, { actorId: session.user!.id! });
    revalidatePath(`/content/${input.contentItemId}`);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't save that." };
  }
}
