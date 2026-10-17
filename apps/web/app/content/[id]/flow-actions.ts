"use server";

import { redirect } from "next/navigation";
import { prisma, createStarterEdit } from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { isAutoTranscriptionEnabled } from "../../../lib/render-config";

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
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't open the editor" };
  }
}

/** Upload screen polling: are the captions (word timings) ready for every take with audio?
 * `waiting` is false when transcription is off here (e.g. on Vercel) — nothing to wait for. */
export async function captionStatus(contentItemId: string): Promise<{ ready: number; total: number; waiting: boolean }> {
  await requireSession();
  const takes = await prisma.mediaAsset.findMany({
    where: { contentItemId, kind: "RAW_TAKE" },
    select: { transcript: true, hasAudio: true },
  });
  const withAudio = takes.filter((t) => t.hasAudio !== false);
  const ready = withAudio.filter((t) => t.transcript != null).length;
  return { ready, total: withAudio.length, waiting: isAutoTranscriptionEnabled() && ready < withAudio.length };
}
