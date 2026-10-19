import { Prisma, type ContentState, type PrismaClient } from "@prisma/client";
import { recordAudit } from "./audit";
import { FOOTAGE_ROLLBACK_SOURCES, isValidTransition, writeTransition } from "./state-machine";
import { FINISHING_EDIT_STATES } from "./edit-plan";
import { createStarterEdit } from "./starter-edit";
import { deleteRecordingSegment, discardRecordingSession } from "./recording-session";

/**
 * "Delete this clip" and "Replace footage" (docs/decisions-pending/replace-footage.md) — Chris
 * deletes the FOOTAGE, never the video: title, plan date, schedule slot, script and history all
 * stay. (Deleting the whole video idea is delete-video.ts.)
 *
 * Data rules:
 *  - A removed take is SOFT-removed (`MediaAsset.removedAt`): TakeSelection rows have an FK to
 *    it and edit plans / the audit trail name it, so the row stays as history. Its files (the
 *    original, preview proxy, filmstrip, person matte, director sprite) are returned for the
 *    caller to delete from storage, and the derived-file pointers are cleared. Every list, edit
 *    builder and the editor ignore removed takes.
 *  - When the removed footage was in the current edit, that edit (and every render of it) is
 *    stale: the video rolls back — `-> MEDIA_INGESTED` when a usable take remains (the edit is
 *    rebuilt from it through the normal MEDIA_INGESTED -> TAKE_SELECTED -> EDIT_PLANNED path,
 *    new TakeSelection + new EditPlan rows), `-> FILMED` when none does ("needs footage"). Both
 *    are explicit rollbacks in the state machine (FOOTAGE_ROLLBACK_SOURCES). Old renders' files
 *    are deleted and their `storageKey` cleared; their rows (status, QC reports) stay.
 *  - A ScheduleEntry is KEPT (the video stays on its calendar day) but the item is no longer
 *    SCHEDULED, so the publish job never picks it up until it is finished and passes every
 *    gate again.
 *  - Audited: TAKE_REMOVED (per take) and FOOTAGE_REPLACED. Serialized with the automatic
 *    style cut / full edit by the same advisory lock, so a racing auto edit can't land on a
 *    video whose footage just changed.
 */

export class FootageChangeNotAllowedError extends Error {
  constructor(state: ContentState) {
    super(
      state === "PUBLISHING" || state === "PUBLISHED" || state === "MEASURING" || state === "ARCHIVED"
        ? "This video has already been posted — its footage can't be changed."
        : state === "CANCELLED"
          ? "This video was deleted."
          : "This video has no footage to change yet — upload it first.",
    );
    this.name = "FootageChangeNotAllowedError";
  }
}

export class TakeNotFoundError extends Error {
  constructor() {
    super("That clip isn't part of this video (it may already be deleted).");
    this.name = "TakeNotFoundError";
  }
}

export class ReplacementTakeNotReadyError extends Error {
  constructor() {
    super("The new clip didn't finish processing — try uploading it again.");
    this.name = "ReplacementTakeNotReadyError";
  }
}

/** States a single clip can be deleted from (FILMED: a take that never finished analysis). */
const REMOVABLE_STATES = new Set<ContentState>(["FILMED", ...FOOTAGE_ROLLBACK_SOURCES]);

type Tx = Prisma.TransactionClient;

/** Pure: every take id the latest plan's edit uses (selected take, recorded parts, timeline
 * clips, the take a style cut / full edit was cut from). */
export function takesUsedByPlan(plan: unknown, selectedMediaAssetId: string | null): Set<string> {
  const used = new Set<string>();
  if (selectedMediaAssetId) used.add(selectedMediaAssetId);
  const p = (plan ?? {}) as Record<string, unknown>;
  const seq = p.sequence as { takes?: Array<{ mediaAssetId?: unknown }> } | undefined;
  for (const t of seq?.takes ?? []) if (typeof t?.mediaAssetId === "string") used.add(t.mediaAssetId);
  const tl = p.timeline as { clips?: Array<{ mediaAssetId?: unknown }> } | undefined;
  for (const c of Array.isArray(tl?.clips) ? tl!.clips : []) if (typeof c?.mediaAssetId === "string") used.add(c.mediaAssetId);
  for (const k of ["styleCut", "fullEdit"]) {
    const x = p[k] as { mediaAssetId?: unknown; mediaAssetIds?: unknown } | null | undefined;
    if (x && typeof x.mediaAssetId === "string") used.add(x.mediaAssetId);
    if (x && Array.isArray(x.mediaAssetIds)) for (const id of x.mediaAssetIds) if (typeof id === "string") used.add(id);
  }
  return used;
}

async function lock(tx: Tx, contentItemId: string) {
  // Same lock as the automatic style cut / full edit (style-cut-plan.ts).
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`style-cut:${contentItemId}`}))::text AS locked`;
}

/** Soft-removes takes; returns their storage keys (original + derived files). */
async function softRemoveTakes(tx: Tx, contentItemId: string, ids: string[], reason: string, actorId: string): Promise<string[]> {
  if (ids.length === 0) return [];
  const keys: string[] = [];
  const now = new Date();
  for (const id of ids) {
    const a = await tx.mediaAsset.findUniqueOrThrow({ where: { id } });
    if (a.removedAt) continue;
    const files = [a.storageKey, a.proxyStorageKey, a.filmstripStorageKey, a.matteStorageKey].filter((k): k is string => !!k);
    for (const u of await tx.takeUnderstanding.findMany({ where: { mediaAssetId: id, spriteKey: { not: null } }, select: { spriteKey: true } })) files.push(u.spriteKey!);
    keys.push(...files);
    await tx.mediaAsset.update({
      where: { id },
      data: { removedAt: now, removedReason: reason, proxyStorageKey: null, filmstripStorageKey: null, matteStorageKey: null, previewMeta: Prisma.DbNull },
    });
    await recordAudit(tx, {
      actor: actorId,
      actorType: "HUMAN",
      action: "TAKE_REMOVED",
      entityType: "ContentItem",
      entityId: contentItemId,
      before: { mediaAssetId: id, originalFilename: a.originalFilename, durationSeconds: a.durationSeconds, storageKey: a.storageKey },
      after: { mediaAssetId: id, removedAt: now.toISOString(), reason, filesDeleted: files.length },
    });
  }
  return keys;
}

/** The item's renders are stale (their edit used removed footage): files out, rows kept. */
async function staleRenderKeys(tx: Tx, contentItemId: string): Promise<string[]> {
  const keys: string[] = [];
  const renders = await tx.render.findMany({ where: { contentItemId, storageKey: { not: null } }, select: { id: true, storageKey: true } });
  for (const r of renders) keys.push(r.storageKey!);
  if (renders.length) await tx.render.updateMany({ where: { id: { in: renders.map((r) => r.id) } }, data: { storageKey: null } });
  for (const v of await tx.renderVariant.findMany({ where: { contentItemId }, select: { storageKey: true, coverStorageKey: true } })) {
    keys.push(v.storageKey);
    if (v.coverStorageKey) keys.push(v.coverStorageKey);
  }
  return keys;
}

async function rollBack(tx: Tx, contentItemId: string, from: ContentState, to: "MEDIA_INGESTED" | "FILMED", reason: string, actorId: string) {
  if (from === to) return;
  if (!isValidTransition(from, to)) throw new FootageChangeNotAllowedError(from);
  await writeTransition(tx, { contentItemId, fromState: from, toState: to, reason, actorType: "HUMAN", actorId });
}

async function activeTakes(db: Tx | PrismaClient, contentItemId: string) {
  return db.mediaAsset.findMany({ where: { contentItemId, kind: "RAW_TAKE", removedAt: null }, orderBy: { createdAt: "asc" } });
}

export type RemoveTakeOutcome =
  /** The clip wasn't in the current edit — the edit is untouched. */
  | "KEPT_EDIT"
  /** It was: the edit was rebuilt from the remaining take (or the video waits at "Edit video"
   * if the rebuild couldn't run). */
  | "REBUILT"
  /** No takes left: the video needs footage again (Upload / Film). */
  | "NEEDS_FOOTAGE";

export interface RemoveTakeResult {
  removed: boolean;
  outcome: RemoveTakeOutcome;
  state: ContentState;
  storageKeys: string[];
  /** The new edit plan when the edit was rebuilt (the caller may run the automatic style cut). */
  editPlanId: string | null;
}

/**
 * "Delete this clip". `inUnsavedEdit`: the editor says the take is in Chris's current
 * (unsaved) timeline — treated like being in the saved edit, so the editor never keeps a
 * timeline pointing at a deleted file. Idempotent: an already-removed take is a no-op.
 */
export async function removeTake(
  prisma: PrismaClient,
  input: { contentItemId: string; mediaAssetId: string; inUnsavedEdit?: boolean },
  actor: { actorId: string },
): Promise<RemoveTakeResult> {
  const asset = await prisma.mediaAsset.findUnique({ where: { id: input.mediaAssetId }, include: { recordingSegment: { include: { session: { select: { id: true, status: true } } } } } });
  if (!asset || asset.contentItemId !== input.contentItemId || asset.kind !== "RAW_TAKE") throw new TakeNotFoundError();
  const item0 = await prisma.contentItem.findUniqueOrThrow({ where: { id: input.contentItemId }, select: { currentState: true } });
  if (asset.removedAt) return { removed: false, outcome: "KEPT_EDIT", state: item0.currentState, storageKeys: [], editPlanId: null };
  if (!REMOVABLE_STATES.has(item0.currentState)) throw new FootageChangeNotAllowedError(item0.currentState);

  // A part of a recording that's still a draft: the draft's own "delete part" (keeps its order).
  const seg = asset.recordingSegment;
  if (seg && seg.session.status === "DRAFT" && seg.status === "ACTIVE") {
    const r = await deleteRecordingSegment(prisma, { recordingSessionId: seg.session.id, contentItemId: input.contentItemId, segmentId: seg.id }, actor);
    // A part kept for history (an earlier take selection references it) is soft-removed here.
    const extra = await prisma.$transaction((tx) => softRemoveTakes(tx, input.contentItemId, [asset.id], "Deleted by Chris (recording part)", actor.actorId)).catch(() => []);
    const state = (await prisma.contentItem.findUniqueOrThrow({ where: { id: input.contentItemId }, select: { currentState: true } })).currentState;
    return { removed: r.deleted, outcome: "KEPT_EDIT", state, storageKeys: [...r.storageKeys, ...extra], editPlanId: null };
  }

  const result = await prisma.$transaction(async (tx) => {
    await lock(tx, input.contentItemId);
    const item = await tx.contentItem.findUniqueOrThrow({ where: { id: input.contentItemId }, select: { currentState: true } });
    if (!REMOVABLE_STATES.has(item.currentState)) throw new FootageChangeNotAllowedError(item.currentState);
    const state = item.currentState;

    // Is it in the current edit (or the current take pick)?
    let inEdit = !!input.inUnsavedEdit;
    if (FINISHING_EDIT_STATES.has(state)) {
      const latest = await tx.editPlan.findFirst({ where: { contentItemId: input.contentItemId }, orderBy: { createdAt: "desc" } });
      const sel = latest ? await tx.takeSelection.findUnique({ where: { id: latest.takeSelectionId }, select: { selectedMediaAssetId: true } }) : null;
      if (latest && takesUsedByPlan(latest.plan, sel?.selectedMediaAssetId ?? null).has(asset.id)) inEdit = true;
    } else if (state === "TAKE_SELECTED") {
      const sel = await tx.takeSelection.findFirst({ where: { contentItemId: input.contentItemId }, orderBy: { createdAt: "desc" } });
      if (sel?.selectedMediaAssetId === asset.id) inEdit = true;
    }

    const keys = await softRemoveTakes(tx, input.contentItemId, [asset.id], "Deleted by Chris", actor.actorId);
    const remaining = (await activeTakes(tx, input.contentItemId)).filter((t) => (t.durationSeconds ?? 0) > 0);
    const hadEdit = FINISHING_EDIT_STATES.has(state) || state === "TAKE_SELECTED";

    if (remaining.length === 0 && state !== "FILMED") {
      if (FINISHING_EDIT_STATES.has(state)) keys.push(...(await staleRenderKeys(tx, input.contentItemId)));
      await rollBack(tx, input.contentItemId, state, "FILMED", "Footage removed — every clip was deleted; upload or film it again", actor.actorId);
      return { outcome: "NEEDS_FOOTAGE" as const, keys, rebuild: false };
    }
    if (inEdit && hadEdit) {
      if (FINISHING_EDIT_STATES.has(state)) keys.push(...(await staleRenderKeys(tx, input.contentItemId)));
      await rollBack(tx, input.contentItemId, state, "MEDIA_INGESTED", "Footage removed — a clip in the edit was deleted; the edit is rebuilt from the remaining footage", actor.actorId);
      return { outcome: "REBUILT" as const, keys, rebuild: true };
    }
    return { outcome: remaining.length === 0 ? ("NEEDS_FOOTAGE" as const) : ("KEPT_EDIT" as const), keys, rebuild: false };
  });

  let editPlanId: string | null = null;
  if (result.rebuild) {
    // The fresh edit, through the normal path (new TakeSelection + EditPlan). If it can't run
    // (e.g. a recording draft), the video waits at "Edit video" — nothing is lost.
    try {
      editPlanId = (await createStarterEdit(prisma, input.contentItemId, actor)).editPlan.id;
    } catch (err) {
      console.warn("[remove-take] rebuild deferred:", err instanceof Error ? err.message : err);
    }
  }
  const state = (await prisma.contentItem.findUniqueOrThrow({ where: { id: input.contentItemId }, select: { currentState: true } })).currentState;
  return { removed: true, outcome: result.outcome, state, storageKeys: result.keys, editPlanId };
}

export interface ReplaceFootageResult {
  /** Takes removed (all of the video's footage except the new clip). */
  removedTakeIds: string[];
  storageKeys: string[];
  state: ContentState;
  /** Calendar date kept (the video must be finished again before it can post). */
  keptScheduleDate: Date | null;
  wasScheduledOrReady: boolean;
}

/**
 * "Replace footage": `newMediaAssetId` (already uploaded + analyzed into this video) becomes the
 * video's only footage. Every other take is removed, any recording draft is discarded, the old
 * edit and its renders are invalidated (state -> MEDIA_INGESTED), and the caller then builds the
 * fresh edit the way any upload does (captions → createStarterEdit → automatic Full edit / Cuts
 * only → editor). Title, plan, script, schedule slot and history are untouched. Idempotent:
 * replacing again with the same clip is a no-op.
 */
export async function replaceFootage(
  prisma: PrismaClient,
  input: { contentItemId: string; newMediaAssetId: string },
  actor: { actorId: string },
): Promise<ReplaceFootageResult> {
  const fresh = await prisma.mediaAsset.findUnique({ where: { id: input.newMediaAssetId } });
  if (!fresh || fresh.contentItemId !== input.contentItemId || fresh.kind !== "RAW_TAKE" || fresh.removedAt) throw new TakeNotFoundError();
  if (!((fresh.durationSeconds ?? 0) > 0)) throw new ReplacementTakeNotReadyError();
  const before = await prisma.contentItem.findUniqueOrThrow({ where: { id: input.contentItemId }, select: { currentState: true } });
  if (!FOOTAGE_ROLLBACK_SOURCES.includes(before.currentState)) throw new FootageChangeNotAllowedError(before.currentState);

  // An unfinished teleprompter recording is part of the old footage: discard it (its own path).
  const keys: string[] = [];
  for (const s of await prisma.recordingSession.findMany({ where: { contentItemId: input.contentItemId, status: "DRAFT" }, select: { id: true } })) {
    keys.push(...(await discardRecordingSession(prisma, { recordingSessionId: s.id, contentItemId: input.contentItemId }, actor)).storageKeys);
  }

  return prisma.$transaction(async (tx) => {
    await lock(tx, input.contentItemId);
    const item = await tx.contentItem.findUniqueOrThrow({ where: { id: input.contentItemId }, select: { currentState: true, title: true } });
    if (!FOOTAGE_ROLLBACK_SOURCES.includes(item.currentState)) throw new FootageChangeNotAllowedError(item.currentState);
    const old = (await activeTakes(tx, input.contentItemId)).filter((t) => t.id !== input.newMediaAssetId);
    const latestSel = await tx.takeSelection.findFirst({ where: { contentItemId: input.contentItemId }, orderBy: { createdAt: "desc" }, select: { selectedMediaAssetId: true } });
    const alreadyDone = old.length === 0 && (item.currentState === "MEDIA_INGESTED" || latestSel?.selectedMediaAssetId === input.newMediaAssetId);
    const entry = await tx.scheduleEntry.findUnique({ where: { contentItemId: input.contentItemId } });
    const wasScheduledOrReady = item.currentState === "SCHEDULED" || item.currentState === "READY";
    if (alreadyDone) {
      return { removedTakeIds: [], storageKeys: keys, state: item.currentState, keptScheduleDate: entry?.scheduledDate ?? null, wasScheduledOrReady };
    }

    keys.push(...(await softRemoveTakes(tx, input.contentItemId, old.map((t) => t.id), "Replaced by new footage", actor.actorId)));
    if (FINISHING_EDIT_STATES.has(item.currentState)) keys.push(...(await staleRenderKeys(tx, input.contentItemId)));
    await rollBack(
      tx,
      input.contentItemId,
      item.currentState,
      "MEDIA_INGESTED",
      `Footage replaced with “${fresh.originalFilename}” — the edit is rebuilt from it${wasScheduledOrReady ? "; it must be finished again before it can post" : ""}`,
      actor.actorId,
    );
    await recordAudit(tx, {
      actor: actor.actorId,
      actorType: "HUMAN",
      action: "FOOTAGE_REPLACED",
      entityType: "ContentItem",
      entityId: input.contentItemId,
      before: { state: item.currentState, takeIds: old.map((t) => t.id), scheduledDate: entry?.scheduledDate ?? null },
      after: { state: "MEDIA_INGESTED", newMediaAssetId: fresh.id, originalFilename: fresh.originalFilename, filesDeleted: keys.length, scheduleKept: !!entry },
    });
    return {
      removedTakeIds: old.map((t) => t.id),
      storageKeys: keys,
      state: "MEDIA_INGESTED" as ContentState,
      keptScheduleDate: entry?.scheduledDate ?? null,
      wasScheduledOrReady,
    };
  });
}

/** Whether "Replace footage" / "Delete this clip" apply to a video in this state. */
export function canChangeFootage(state: ContentState): boolean {
  return FOOTAGE_ROLLBACK_SOURCES.includes(state);
}
