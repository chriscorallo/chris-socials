import { Prisma, type PrismaClient } from "@prisma/client";
import { recordAudit } from "./audit";
import { getLatestEditPlan, saveFinishingEdit } from "./edit-plan";

/**
 * Persistence for the Director chat (docs/decisions-pending/director-chat.md). The chat's brain
 * (ChatGPT round trip or Claude) and the deterministic applier live elsewhere
 * (@chris/media/director, apps/web); this module only stores:
 *  - TakeUnderstanding rows (what the chat sees of each take — computed once by the worker);
 *  - the conversation (DirectorMessage, append-only);
 *  - each applied answer as a NEW EditPlan version via saveFinishingEdit (never an overwrite;
 *    "undo" = the previous version saved again as a new one), with `plan.director` carrying the
 *    refs, requested placements and number provenance ("Chris via Director chat").
 * Structural JSON types only — the domain package stays free of @chris/media.
 */

export type DirectorRole = "CHRIS" | "EDITOR" | "SYSTEM";
export type DirectorKind = "MESSAGE" | "ANSWER" | "APPLIED" | "REJECTED" | "UNDONE" | "NOTE";
export type DirectorProvider = "FREE_CHATGPT" | "AI";

export const DIRECTOR_EDIT_NOTE_PREFIX = "Director chat";

// ---------------------------------------------------------------------------------------
// Take understanding
// ---------------------------------------------------------------------------------------

export async function recordTakeUnderstanding(
  prisma: PrismaClient,
  input: { mediaAssetId: string; data: unknown; spriteKey: string | null; model: string; ms?: number | null },
  actor: { actorId: string },
) {
  const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: input.mediaAssetId }, select: { contentItemId: true } });
  const data = { ...(input.data as Record<string, unknown>) };
  const sprite = data.sprite as Record<string, unknown> | null | undefined;
  if (sprite && input.spriteKey) data.sprite = { ...sprite, key: input.spriteKey };
  const row = await prisma.takeUnderstanding.create({
    data: {
      mediaAssetId: input.mediaAssetId,
      contentItemId: asset.contentItemId,
      model: input.model,
      data: data as Prisma.InputJsonValue,
      spriteKey: input.spriteKey,
      ms: input.ms ?? null,
    },
  });
  const samples = Array.isArray(data.samples) ? (data.samples as Array<{ face?: unknown }>) : [];
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "JOB",
    action: "MEDIA_ASSET_UNDERSTOOD",
    entityType: "MediaAsset",
    entityId: input.mediaAssetId,
    after: { takeUnderstandingId: row.id, model: input.model, samples: samples.length, withFace: samples.filter((s) => s.face).length, spriteKey: input.spriteKey },
  });
  return row;
}

/** Latest understanding per take (null when a take has none yet). Sprite key folded into data. */
export async function getLatestTakeUnderstandings(prisma: PrismaClient, mediaAssetIds: string[]): Promise<Record<string, unknown | null>> {
  const out: Record<string, unknown | null> = Object.fromEntries(mediaAssetIds.map((id) => [id, null]));
  if (!mediaAssetIds.length) return out;
  const rows = await prisma.takeUnderstanding.findMany({ where: { mediaAssetId: { in: mediaAssetIds } }, orderBy: { createdAt: "desc" } });
  for (const r of rows) {
    if (out[r.mediaAssetId]) continue;
    const data = { ...(r.data as Record<string, unknown>) };
    const sprite = data.sprite as Record<string, unknown> | null | undefined;
    if (sprite) data.sprite = { ...sprite, key: r.spriteKey ?? (sprite.key as string | null) ?? null };
    out[r.mediaAssetId] = data;
  }
  return out;
}

/** Raw takes of an item that have no understanding yet. */
export async function takesMissingUnderstanding(prisma: PrismaClient, contentItemId: string): Promise<string[]> {
  const takes = await prisma.mediaAsset.findMany({ where: { contentItemId, kind: "RAW_TAKE" }, select: { id: true, width: true }, orderBy: { createdAt: "asc" } });
  if (!takes.length) return [];
  const have = new Set((await prisma.takeUnderstanding.findMany({ where: { mediaAssetId: { in: takes.map((t) => t.id) } }, select: { mediaAssetId: true } })).map((r) => r.mediaAssetId));
  return takes.filter((t) => t.width != null && !have.has(t.id)).map((t) => t.id);
}

/** Is `key` the sprite of a take of this item? (media route authorisation) */
export async function isDirectorSpriteKey(prisma: PrismaClient, key: string): Promise<boolean> {
  return (await prisma.takeUnderstanding.count({ where: { spriteKey: key } })) > 0;
}

// ---------------------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------------------

export interface AppendDirectorMessageInput {
  contentItemId: string;
  role: DirectorRole;
  kind: DirectorKind;
  text: string;
  provider?: DirectorProvider | null;
  payload?: unknown;
  baseEditPlanId?: string | null;
  resultEditPlanId?: string | null;
  replyToId?: string | null;
  costUsd?: number | null;
  idempotencyKey?: string | null;
  createdBy?: string | null;
}

/** Appends one message (idempotent on `idempotencyKey`: a retry returns the existing row). */
export async function appendDirectorMessage(prisma: PrismaClient, input: AppendDirectorMessageInput) {
  if (input.idempotencyKey) {
    const existing = await prisma.directorMessage.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return existing;
  }
  try {
    return await prisma.directorMessage.create({
      data: {
        contentItemId: input.contentItemId,
        role: input.role,
        kind: input.kind,
        text: input.text.slice(0, 20_000),
        provider: input.provider ?? null,
        payload: input.payload === undefined ? undefined : (input.payload as Prisma.InputJsonValue),
        baseEditPlanId: input.baseEditPlanId ?? null,
        resultEditPlanId: input.resultEditPlanId ?? null,
        replyToId: input.replyToId ?? null,
        costUsd: input.costUsd ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdBy: input.createdBy ?? null,
      },
    });
  } catch (err) {
    if (input.idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return prisma.directorMessage.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
    }
    throw err;
  }
}

export async function listDirectorMessages(prisma: PrismaClient, contentItemId: string, limit = 200) {
  const rows = await prisma.directorMessage.findMany({ where: { contentItemId }, orderBy: { createdAt: "desc" }, take: limit });
  return rows.reverse();
}

// ---------------------------------------------------------------------------------------
// Applying = a new EditPlan version
// ---------------------------------------------------------------------------------------

/**
 * Saves the applied timeline as a NEW finishing-edit version (state rollback rules of
 * saveFinishingEdit apply), with `plan.director` = the record (refs, placements, provenance),
 * then logs the APPLIED message (change list) and an audit row. Idempotent on `idempotencyKey`
 * (the APPLIED message's key): a retried apply returns the first result, no second version.
 */
export async function saveDirectorEdit(
  prisma: PrismaClient,
  input: {
    contentItemId: string;
    timeline: unknown;
    durationSeconds: number;
    actorId: string;
    record: unknown;
    /** The timeline the answer was applied to (what Undo restores). */
    baseTimeline?: unknown;
    changes: Array<{ kind: string; text: string; id?: string }>;
    notes: string[];
    answerMessageId: string;
    provider: DirectorProvider;
    idempotencyKey: string;
  },
) {
  const done = await prisma.directorMessage.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (done) return { editPlanId: done.resultEditPlanId, message: done, alreadyApplied: true as const };
  const base = await getLatestEditPlan(prisma, input.contentItemId);
  const summary = input.changes.filter((c) => c.kind !== "NOTE").map((c) => c.text).join(" · ");
  const plan = await saveFinishingEdit(prisma, {
    contentItemId: input.contentItemId,
    timeline: input.timeline,
    durationSeconds: input.durationSeconds,
    actorId: input.actorId,
    note: `${DIRECTOR_EDIT_NOTE_PREFIX} — ${summary || "no changes"}`.slice(0, 400),
    planExtras: { director: input.record },
  });
  const message = await appendDirectorMessage(prisma, {
    contentItemId: input.contentItemId,
    role: "EDITOR",
    kind: "APPLIED",
    provider: input.provider,
    text: summary || "Nothing to change.",
    // the exact timeline the answer was applied to (a starter plan has no stored timeline) — Undo restores it
    payload: { changes: input.changes, notes: input.notes, baseTimeline: input.baseTimeline ?? null },
    baseEditPlanId: base?.id ?? null,
    resultEditPlanId: plan.id,
    replyToId: input.answerMessageId,
    idempotencyKey: input.idempotencyKey,
    createdBy: input.actorId,
  });
  await recordAudit(prisma, {
    actor: input.actorId,
    actorType: "HUMAN",
    action: "DIRECTOR_EDIT_APPLIED",
    entityType: "ContentItem",
    entityId: input.contentItemId,
    before: { editPlanId: base?.id ?? null },
    after: { editPlanId: plan.id, changes: input.changes.length, provider: input.provider, answerMessageId: input.answerMessageId },
  });
  return { editPlanId: plan.id, message, alreadyApplied: false as const };
}

/**
 * "Undo" a Director change: the version it was applied on is saved again as a NEW version
 * (history is never rewritten). Refused (needsConfirm) when the edit changed after that apply,
 * unless `force` — undoing would also drop those later changes.
 */
export async function undoDirectorEdit(
  prisma: PrismaClient,
  input: { contentItemId: string; appliedMessageId: string; actorId: string; force?: boolean },
): Promise<{ ok: true; editPlanId: string; timeline: unknown } | { ok: false; error: string; needsConfirm?: boolean }> {
  const applied = await prisma.directorMessage.findUnique({ where: { id: input.appliedMessageId } });
  if (!applied || applied.contentItemId !== input.contentItemId || applied.kind !== "APPLIED") return { ok: false, error: "That change isn't in this video's chat." };
  if (!applied.baseEditPlanId) return { ok: false, error: "There's no earlier version to go back to." };
  const undone = await prisma.directorMessage.findFirst({ where: { contentItemId: input.contentItemId, kind: "UNDONE", replyToId: applied.id } });
  if (undone?.resultEditPlanId) {
    const plan = await prisma.editPlan.findUnique({ where: { id: undone.resultEditPlanId } });
    return { ok: true, editPlanId: undone.resultEditPlanId, timeline: (plan?.plan as Record<string, unknown> | null)?.timeline ?? null };
  }
  const latest = await getLatestEditPlan(prisma, input.contentItemId);
  if (latest && latest.id !== applied.resultEditPlanId && !input.force) {
    return { ok: false, needsConfirm: true, error: "You've changed the edit since then — going back also drops those later changes." };
  }
  const base = await prisma.editPlan.findUniqueOrThrow({ where: { id: applied.baseEditPlanId } });
  const basePlan = (base.plan ?? {}) as Record<string, unknown>;
  const restore = ((applied.payload ?? {}) as { baseTimeline?: unknown }).baseTimeline ?? basePlan.timeline ?? null;
  if (!restore) return { ok: false, error: "There's no earlier edit to go back to." };
  const plan = await saveFinishingEdit(prisma, {
    contentItemId: input.contentItemId,
    timeline: restore,
    durationSeconds: base.targetDurationSeconds,
    actorId: input.actorId,
    note: `${DIRECTOR_EDIT_NOTE_PREFIX} — undo: back to the version before “${applied.text.slice(0, 120)}”`,
    planExtras: { director: basePlan.director ?? null },
  });
  await appendDirectorMessage(prisma, {
    contentItemId: input.contentItemId,
    role: "SYSTEM",
    kind: "UNDONE",
    text: `Undid: ${applied.text}`.slice(0, 2000),
    baseEditPlanId: latest?.id ?? null,
    resultEditPlanId: plan.id,
    replyToId: applied.id,
    createdBy: input.actorId,
  });
  await recordAudit(prisma, {
    actor: input.actorId,
    actorType: "HUMAN",
    action: "DIRECTOR_EDIT_UNDONE",
    entityType: "ContentItem",
    entityId: input.contentItemId,
    before: { editPlanId: latest?.id ?? null },
    after: { editPlanId: plan.id, restoredFrom: base.id, appliedMessageId: applied.id },
  });
  return { ok: true, editPlanId: plan.id, timeline: restore };
}

// ---------------------------------------------------------------------------------------
// Paid brain gating
// ---------------------------------------------------------------------------------------

export interface DirectorAiAvailability {
  available: boolean;
  /** Plain sentence when not available ("Needs AI credit — …"). */
  reason: string | null;
  todayUsd: number;
  capUsd: number;
}

/**
 * The paid "Ask Claude" button is only enabled when the key is set, the account isn't out of
 * credit (latest call in 3 days failed with a credit error and nothing succeeded since), the
 * daily cap isn't reached, and the kill switch DIRECTOR_AI isn't "off".
 */
export async function getDirectorAiAvailability(
  prisma: PrismaClient,
  env: { apiKeySet: boolean; capUsd: number; killSwitchOff?: boolean },
  now: Date,
  creditErrorRe: RegExp,
): Promise<DirectorAiAvailability> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const today = await prisma.modelCallLog.aggregate({ _sum: { costUsd: true }, where: { createdAt: { gte: dayStart } } });
  const todayUsd = today._sum.costUsd ?? 0;
  const base = { todayUsd, capUsd: env.capUsd };
  if (env.killSwitchOff) return { ...base, available: false, reason: "The AI director is switched off (DIRECTOR_AI=off)." };
  if (!env.apiKeySet) return { ...base, available: false, reason: "Needs AI credit — the AI isn't set up (no Anthropic key). The free ChatGPT way works now." };
  const lastSuccess = await prisma.modelCallLog.findFirst({ where: { success: true }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const recentFail = await prisma.modelCallLog.findFirst({
    where: { success: false, createdAt: { gte: new Date(now.getTime() - 3 * 86_400_000) } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, errorMessage: true },
  });
  if (recentFail?.errorMessage && creditErrorRe.test(recentFail.errorMessage) && !(lastSuccess && lastSuccess.createdAt > recentFail.createdAt)) {
    return { ...base, available: false, reason: "Needs AI credit — the AI account is out of credit (More → AI credit). The free ChatGPT way works now." };
  }
  if (env.capUsd <= 0 || todayUsd >= env.capUsd) return { ...base, available: false, reason: "Today's AI spending limit is reached — try tomorrow, or use the free ChatGPT way." };
  return { ...base, available: true, reason: null };
}
