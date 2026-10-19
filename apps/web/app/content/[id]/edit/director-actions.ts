"use server";

import { prisma, takesMissingUnderstanding } from "@chris/domain";
import { requireSession } from "../../../../lib/session";
import { runHeavyJob } from "../../../../lib/heavy-jobs";
import {
  directorState,
  loadDirectorContext,
  packForMessage,
  prepareDirectorTurn,
  submitDirectorAnswer,
  undoDirectorChange,
  type DirectorApplyOutcome,
  type DirectorStateView,
  type PreparedTurn,
} from "../../../../lib/director/server";

/**
 * Director chat Server Actions (thin: auth + the shared server module). The paid "Ask AI" call is
 * a Route Handler (/api/director/ask). Every action returns a plain result worded for Chris.
 * See docs/decisions-pending/director-chat.md.
 */

type R<T> = ({ ok: true } & T) | { ok: false; error: string };

function plain(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/FinishingEditNotAllowed|can't be edited/i.test(msg)) return "This video can't be edited right now.";
  return msg.length < 200 ? msg : "Something went wrong — try again.";
}

export async function loadDirectorAction(itemId: string): Promise<R<{ state: DirectorStateView }>> {
  await requireSession();
  try {
    return { ok: true, state: await directorState(prisma, itemId) };
  } catch (err) {
    return { ok: false, error: plain(err) };
  }
}

/** Reads his face/moves for takes that don't have it yet (background job, free). */
export async function requestUnderstandingAction(itemId: string): Promise<R<{ started: boolean; message: string }>> {
  const session = await requireSession();
  try {
    const missing = await takesMissingUnderstanding(prisma, itemId);
    if (!missing.length) return { ok: true, started: false, message: "Already read." };
    const r = await runHeavyJob("take-understand", { contentItemId: itemId, mediaAssetIds: missing }, { actorId: session.user!.id!, background: true });
    if (r.status === "refused") return { ok: false, error: r.message };
    if (r.status === "busy") return { ok: true, started: false, message: "Your footage is still being analysed — the face read starts after that." };
    return { ok: true, started: true, message: "Reading your face and moves…" };
  } catch (err) {
    return { ok: false, error: plain(err) };
  }
}

/** Chris's message → stored + the ChatGPT pack. `clientKey` makes a double tap harmless. */
export async function sendDirectorMessageAction(input: { itemId: string; message: string; clientKey: string }): Promise<R<{ turn: PreparedTurn }>> {
  const session = await requireSession();
  try {
    return { ok: true, turn: await prepareDirectorTurn(prisma, { ...input, actorId: session.user!.id! }) };
  } catch (err) {
    return { ok: false, error: plain(err) };
  }
}

/** The pack for an earlier message again (copy it again after a follow-up or a fix). */
export async function directorPackAction(input: { itemId: string; messageId: string }): Promise<R<{ turn: PreparedTurn }>> {
  await requireSession();
  try {
    const m = await prisma.directorMessage.findUnique({ where: { id: input.messageId } });
    if (!m || m.contentItemId !== input.itemId) return { ok: false, error: "That message isn't in this video's chat." };
    const ctx = await loadDirectorContext(prisma, input.itemId);
    return { ok: true, turn: await packForMessage(prisma, ctx, m.id, m.text) };
  } catch (err) {
    return { ok: false, error: plain(err) };
  }
}

/** ChatGPT's pasted answer → validated → applied as a new version. */
export async function submitDirectorAnswerAction(input: { itemId: string; replyToId: string; text: string }): Promise<DirectorApplyOutcome | { ok: false; errors: string[]; repairMessage: string }> {
  const session = await requireSession();
  try {
    return await submitDirectorAnswer(prisma, { ...input, provider: "FREE_CHATGPT", actorId: session.user!.id! });
  } catch (err) {
    return { ok: false, errors: [plain(err)], repairMessage: "" };
  }
}

export async function undoDirectorAction(input: { itemId: string; appliedMessageId: string; force?: boolean }) {
  const session = await requireSession();
  try {
    return await undoDirectorChange(prisma, { ...input, actorId: session.user!.id! });
  } catch (err) {
    return { ok: false as const, error: plain(err) };
  }
}
