"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma, createStarterEdit, applyManualTransition, getActiveHeavyJob, removeTake, replaceFootage, type RemoveTakeOutcome } from "@chris/domain";
import { storage } from "../../../lib/storage";
import { posterStorageKey } from "../../../lib/poster";
import { requireSession } from "../../../lib/session";
import { autoStyleCutAfterStarter } from "../../../lib/style-cut";
import { heavyJobMode, isAutoTranscriptionEnabled } from "../../../lib/render-config";
import { progressLine } from "../../../lib/heavy-job-text";
import { kickQueuedHeavyJobs } from "../../../lib/heavy-jobs";

/**
 * The simple-flow entry points (docs/decisions-pending/flow.md). Kept out of ./actions.ts on
 * purpose — that file holds the heavy AI/render steps.
 */

/** "Edit video": make the no-AI starter edit if there isn't one yet, then open the editor. */
export async function startEditing(formData: FormData) {
  const session = await requireSession();
  const contentItemId = String(formData.get("contentItemId") ?? "").trim();
  let error: string | null = null;
  try {
    await createStarterEdit(prisma, contentItemId, { actorId: session.user!.id! });
    await autoStyleCutAfterStarter(contentItemId, session.user!.id!);
  } catch (err) {
    error = err instanceof Error ? err.message : "Couldn't open the editor";
  }
  if (error) redirect(`/content/${contentItemId}?pipelineError=${encodeURIComponent(error)}`);
  redirect(`/content/${contentItemId}/edit`);
}

/** Same, for the upload screen (client): returns instead of redirecting. */
export async function startEditingNow(contentItemId: string): Promise<{ ok: true } | { error: string }> {
  const session = await requireSession();
  try {
    await createStarterEdit(prisma, contentItemId, { actorId: session.user!.id! });
    await autoStyleCutAfterStarter(contentItemId, session.user!.id!);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't open the editor" };
  }
}

/** Uploading footage to a video that's still "Ready to film" IS Chris saying he filmed it —
 * apply that allowlisted manual transition (READY_TO_FILM -> FILMED) first so the upload
 * ingests normally. A no-op in any other state. */
export async function markFilmedForUpload(contentItemId: string): Promise<{ ok: true } | { error: string }> {
  const session = await requireSession();
  try {
    const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId }, select: { currentState: true } });
    if (item.currentState === "READY_TO_FILM") {
      await applyManualTransition(prisma, {
        contentItemId,
        to: "FILMED",
        actorId: session.user!.id!,
        reason: "Manual: I've filmed this (uploading the footage)",
      });
    }
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't prepare the upload" };
  }
}

/** Upload screen polling: are the captions (word timings) ready for every take with audio?
 * `waiting` is false when transcription is off here (e.g. on Vercel) — nothing to wait for. */
export async function captionStatus(
  contentItemId: string,
): Promise<{ ready: number; total: number; waiting: boolean; progress: string | null }> {
  await requireSession();
  const takes = await prisma.mediaAsset.findMany({
    where: { contentItemId, kind: "RAW_TAKE", removedAt: null },
    select: { transcript: true, hasAudio: true, createdAt: true },
  });
  const withAudio = takes.filter((t) => t.hasAudio !== false);
  const ready = withAudio.filter((t) => t.transcript != null).length;
  let waiting = isAutoTranscriptionEnabled() && ready < withAudio.length;
  let progress: string | null = null;
  if (waiting && heavyJobMode() === "sandbox") {
    // Live site: captions come from the cloud worker's upload job (lib/heavy-jobs.ts). Follow
    // its progress; stop waiting if no job is running (it failed, or never started) — except in
    // the few seconds between the upload finishing and the job being claimed.
    let job = await getActiveHeavyJob(prisma, contentItemId);
    if (job?.status === "QUEUED") {
      // Waiting for a free cloud worker: start it if a slot has opened.
      await kickQueuedHeavyJobs().catch(() => undefined);
      job = await getActiveHeavyJob(prisma, contentItemId);
    }
    const newest = Math.max(0, ...takes.map((t) => t.createdAt.getTime()));
    if (job) progress = progressLine(job.summary?.jobKind, job.summary?.progress?.message, job.summary?.progress?.pct);
    else if (Date.now() - newest > 45_000) waiting = false;
  }
  return { ready, total: withAudio.length, waiting, progress };
}

/** Best effort: a file that won't delete never blocks the change (it's logged). Each video's
 * cached poster frame (lib/poster.ts) goes with it. */
async function deleteFiles(tag: string, keys: string[]) {
  const all = new Set<string>();
  for (const k of keys) {
    all.add(k);
    if (/\.(mp4|mov|m4v|webm)$/i.test(k)) all.add(posterStorageKey(k));
  }
  for (const key of all) {
    await storage.delete(key).catch((err) => console.warn(`[${tag}] could not delete`, key, err instanceof Error ? err.message : err));
  }
}

function revalidateVideo(contentItemId: string) {
  for (const path of ["/", "/content", "/plan", "/calendar", "/film", `/content/${contentItemId}`, `/content/${contentItemId}/edit`]) revalidatePath(path);
}

/**
 * "Delete this clip" (video page takes list / editor media bin). Removes the take's files; if it
 * was in the current edit, the edit is rebuilt from the remaining take (+ the automatic Full
 * edit / Cuts only); with no takes left the video goes back to "needs footage" — it stays in
 * the plan. docs/decisions-pending/replace-footage.md
 */
export async function deleteTakeNow(
  contentItemId: string,
  mediaAssetId: string,
  inUnsavedEdit = false,
): Promise<{ ok: true; outcome: RemoveTakeOutcome; state: string } | { error: string }> {
  const session = await requireSession();
  const actorId = session.user!.id!;
  try {
    const r = await removeTake(prisma, { contentItemId, mediaAssetId, inUnsavedEdit }, { actorId });
    await deleteFiles("delete-take", r.storageKeys);
    if (r.editPlanId) await autoStyleCutAfterStarter(contentItemId, actorId);
    revalidateVideo(contentItemId);
    return { ok: true, outcome: r.outcome, state: r.state };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't delete the clip" };
  }
}

/**
 * "Replace footage": the new clip (already uploaded into this video) becomes its only footage —
 * old takes, their files and the old edit's renders are removed; the client then runs the
 * normal upload ending (captions → fresh edit → editor). Title, plan, script and schedule slot
 * stay. docs/decisions-pending/replace-footage.md
 */
export async function replaceFootageNow(
  contentItemId: string,
  newMediaAssetId: string,
): Promise<{ ok: true; removed: number; mustRefinish: boolean } | { error: string }> {
  const session = await requireSession();
  try {
    const r = await replaceFootage(prisma, { contentItemId, newMediaAssetId }, { actorId: session.user!.id! });
    await deleteFiles("replace-footage", r.storageKeys);
    revalidateVideo(contentItemId);
    return { ok: true, removed: r.removedTakeIds.length, mustRefinish: r.wasScheduledOrReady || !!r.keptScheduleDate };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't replace the footage" };
  }
}
