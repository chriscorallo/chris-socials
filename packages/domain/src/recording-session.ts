import type { ContentState, MediaAsset, Prisma, PrismaClient, RecordingSegment, RecordingSession } from "@prisma/client";
import { recordAudit } from "./audit";
import { advancePlannedItemToFilmed } from "./footage-first";

/**
 * Segmented recording + drafts (docs/decisions-pending/segmented-recording-drafts.md).
 *
 * The teleprompter's "Record here" records a video in SEGMENTS (record → pause → record …,
 * like TikTok / Reels / Shorts). Every segment is uploaded as soon as it's recorded and becomes
 * a RAW_TAKE MediaAsset linked to a RecordingSegment of the video's RecordingSession — the
 * DRAFT. Chris can leave and come back hours or days later ("Continue filming"); "Finish" ends
 * the session and only THEN do the starter edit + style cut run, over every active segment in
 * order. "Discard draft" marks the session DISCARDED.
 *
 * Rules:
 *  - At most one DRAFT per video (find-or-create under a per-video advisory lock).
 *  - Session/segment rows are never deleted. "Delete last segment" / "Discard" mark segments
 *    DELETED and delete the segment's MediaAsset row (the media is Chris's to remove —
 *    SECURITY.md: media may go, history stays); the caller deletes the stored file. The
 *    AuditLog keeps what was removed.
 *  - Segment registration is idempotent by the client's `clientKey` (an upload retried after a
 *    lost response returns the first registration, never a duplicate take).
 *  - While a DRAFT is open the automatic downstream steps (starter edit, style cut, "open the
 *    editor") are refused — partial segments are not the finished video. Transcription /
 *    face tracking of uploaded segments still run (they only fill in MediaAsset fields), so
 *    captions are ready sooner when Chris finishes.
 *  - States: the video is walked to FILMED when the session starts (the first segment was
 *    recorded — honest SYSTEM steps, as for any upload) and the first analysed segment moves
 *    it to MEDIA_INGESTED (the canonical ingest trigger). No new transitions, no shortcuts.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** States a recording session may be opened in (after walking to FILMED). */
export const RECORDABLE_STATES: ReadonlySet<ContentState> = new Set<ContentState>(["FILMED", "MEDIA_INGESTED", "TAKE_SELECTED"]);

export class RecordingDraftOpenError extends Error {
  constructor() {
    super("This video is still a draft — finish filming it first (or discard the draft).");
    this.name = "RecordingDraftOpenError";
  }
}

export class RecordingSessionClosedError extends Error {
  constructor(status: string) {
    super(status === "DISCARDED" ? "This draft was discarded — refused." : "This recording was already finished — refused.");
    this.name = "RecordingSessionClosedError";
  }
}

export class RecordingSessionNotFoundError extends Error {
  constructor() {
    super("That recording draft wasn't found (404).");
    this.name = "RecordingSessionNotFoundError";
  }
}

export class CannotRecordHereError extends Error {
  constructor(state: ContentState) {
    super(`This video can't take new footage right now (it's ${state.toLowerCase().replace(/_/g, " ")}) — refused.`);
    this.name = "CannotRecordHereError";
  }
}

export type SegmentWithAsset = RecordingSegment & {
  mediaAsset: Pick<MediaAsset, "id" | "storageKey" | "durationSeconds" | "transcript" | "hasAudio" | "originalFilename"> | null;
};
export type SessionWithSegments = RecordingSession & { segments: SegmentWithAsset[] };

const segmentInclude = {
  segments: {
    where: { status: "ACTIVE" as const },
    orderBy: [{ segmentIndex: "asc" as const }, { createdAt: "asc" as const }],
    include: { mediaAsset: { select: { id: true, storageKey: true, durationSeconds: true, transcript: true, hasAudio: true, originalFilename: true } } },
  },
};

async function lockItem(tx: Prisma.TransactionClient, contentItemId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`recording-session:${contentItemId}`}))::text AS locked`;
}

/** The video's open draft (active segments in order), or null. */
export async function getOpenRecordingSession(db: Db, contentItemId: string): Promise<SessionWithSegments | null> {
  return db.recordingSession.findFirst({
    where: { contentItemId, status: "DRAFT" },
    orderBy: { createdAt: "desc" },
    include: segmentInclude,
  }) as Promise<SessionWithSegments | null>;
}

export async function hasOpenRecordingDraft(db: Db, contentItemId: string): Promise<boolean> {
  return (await db.recordingSession.count({ where: { contentItemId, status: "DRAFT" } })) > 0;
}

/** Throws RecordingDraftOpenError while the video has an open draft (gate for auto steps). */
export async function assertNoOpenRecordingDraft(db: Db, contentItemId: string): Promise<void> {
  if (await hasOpenRecordingDraft(db, contentItemId)) throw new RecordingDraftOpenError();
}

/**
 * Starts the video's recording draft, or returns the open one (idempotent). Walks a planned
 * video to FILMED first (the same honest SYSTEM steps as any upload; a no-op if already filmed).
 */
export async function openRecordingSession(
  prisma: PrismaClient,
  input: { contentItemId: string; scriptFingerprint?: string | null },
  actor: { actorId: string },
): Promise<{ session: SessionWithSegments; created: boolean }> {
  const { item } = await advancePlannedItemToFilmed(prisma, input.contentItemId, actor);
  if (!RECORDABLE_STATES.has(item.currentState)) throw new CannotRecordHereError(item.currentState);
  return prisma.$transaction(async (tx) => {
    await lockItem(tx, input.contentItemId);
    const open = await getOpenRecordingSession(tx, input.contentItemId);
    if (open) return { session: open, created: false };
    const session = await tx.recordingSession.create({
      data: { contentItemId: input.contentItemId, createdBy: actor.actorId, scriptFingerprint: input.scriptFingerprint ?? null },
    });
    await recordAudit(tx, {
      actor: actor.actorId,
      actorType: "HUMAN",
      action: "RECORDING_SESSION_STARTED",
      entityType: "ContentItem",
      entityId: input.contentItemId,
      after: { recordingSessionId: session.id },
    });
    return { session: { ...session, segments: [] }, created: true };
  });
}

/** Loads a session and checks it belongs to the video and is still a DRAFT. */
async function draftFor(db: Db, recordingSessionId: string, contentItemId?: string): Promise<RecordingSession> {
  const s = await db.recordingSession.findUnique({ where: { id: recordingSessionId } });
  if (!s || (contentItemId && s.contentItemId !== contentItemId)) throw new RecordingSessionNotFoundError();
  if (s.status !== "DRAFT") throw new RecordingSessionClosedError(s.status);
  return s;
}

/** A segment already registered under this client key (retried upload), with its take. */
export async function findRegisteredSegment(db: Db, recordingSessionId: string, clientKey: string) {
  return db.recordingSegment.findUnique({
    where: { recordingSessionId_clientKey: { recordingSessionId, clientKey } },
    include: { mediaAsset: true },
  });
}

/** Pre-upload check: the draft is open and belongs to this video (throws otherwise). */
export async function assertSegmentUploadAllowed(db: Db, input: { recordingSessionId: string; contentItemId: string }) {
  await draftFor(db, input.recordingSessionId, input.contentItemId);
}

export interface SegmentMeta {
  recordingSessionId: string;
  clientKey: string;
  /** Client's order for the segment (continues after the existing ones). Null → next index. */
  segmentIndex?: number | null;
  durationSeconds?: number | null;
  scriptPositionStart?: number | null;
  scriptPositionEnd?: number | null;
}

/**
 * Links a freshly created take to its session as a segment. Idempotent by clientKey: when the
 * same segment was registered meanwhile (two retries racing), returns `{ duplicateOf }` and the
 * caller deletes its own extra asset. Also saves the teleprompter position (auto-save).
 */
export async function attachRecordingSegment(
  prisma: PrismaClient,
  input: SegmentMeta & { mediaAssetId: string; originalFilename?: string | null; sizeBytes?: number | null },
  actor: { actorId: string },
): Promise<{ segment: RecordingSegment; duplicateOf: string | null }> {
  return prisma.$transaction(async (tx) => {
    const asset = await tx.mediaAsset.findUniqueOrThrow({ where: { id: input.mediaAssetId }, select: { contentItemId: true } });
    await lockItem(tx, asset.contentItemId);
    const session = await draftFor(tx, input.recordingSessionId, asset.contentItemId);
    const existing = await tx.recordingSegment.findUnique({ where: { recordingSessionId_clientKey: { recordingSessionId: session.id, clientKey: input.clientKey } } });
    if (existing) return { segment: existing, duplicateOf: existing.mediaAssetId };
    const max = await tx.recordingSegment.aggregate({ where: { recordingSessionId: session.id }, _max: { segmentIndex: true } });
    const next = (max._max.segmentIndex ?? -1) + 1;
    const segmentIndex = Number.isInteger(input.segmentIndex) && (input.segmentIndex as number) >= 0 ? (input.segmentIndex as number) : next;
    const segment = await tx.recordingSegment.create({
      data: {
        recordingSessionId: session.id,
        clientKey: input.clientKey,
        segmentIndex,
        mediaAssetId: input.mediaAssetId,
        durationSeconds: finiteOrNull(input.durationSeconds),
        scriptPositionStart: unitOrNull(input.scriptPositionStart),
        scriptPositionEnd: unitOrNull(input.scriptPositionEnd),
        originalFilename: input.originalFilename ?? null,
        sizeBytes: input.sizeBytes ?? null,
      },
    });
    const pos = unitOrNull(input.scriptPositionEnd);
    await tx.recordingSession.update({ where: { id: session.id }, data: pos != null ? { scriptPosition: pos } : { updatedAt: new Date() } });
    await recordAudit(tx, {
      actor: actor.actorId,
      actorType: "HUMAN",
      action: "RECORDING_SEGMENT_ADDED",
      entityType: "ContentItem",
      entityId: asset.contentItemId,
      after: { recordingSessionId: session.id, segmentId: segment.id, segmentIndex, mediaAssetId: input.mediaAssetId, durationSeconds: segment.durationSeconds },
    });
    return { segment, duplicateOf: null };
  });
}

/** "Save as draft" / auto-save: where the teleprompter is. */
export async function saveRecordingDraftPosition(
  db: Db,
  input: { recordingSessionId: string; contentItemId: string; scriptPosition: number; scriptFingerprint?: string | null },
) {
  await draftFor(db, input.recordingSessionId, input.contentItemId);
  return db.recordingSession.update({
    where: { id: input.recordingSessionId },
    data: { scriptPosition: unitOrNull(input.scriptPosition) ?? 0, ...(input.scriptFingerprint !== undefined ? { scriptFingerprint: input.scriptFingerprint } : {}) },
  });
}

/** Removes a segment's take (row) — the caller deletes `storageKeys` from storage. */
async function removeSegmentMedia(tx: Prisma.TransactionClient, seg: RecordingSegment): Promise<string[]> {
  if (!seg.mediaAssetId) return [];
  const asset = await tx.mediaAsset.findUnique({ where: { id: seg.mediaAssetId }, include: { _count: { select: { takeSelections: true } } } });
  if (!asset) return [];
  if (asset._count.takeSelections > 0) return []; // referenced by a past selection: keep it (history)
  await tx.recordingSegment.update({ where: { id: seg.id }, data: { mediaAssetId: null } });
  await tx.mediaAsset.delete({ where: { id: asset.id } });
  return [asset.storageKey, asset.matteStorageKey].filter((k): k is string => !!k);
}

/**
 * "Delete last segment" (or any one segment) of an open draft. Marks it DELETED (row kept) and
 * deletes its take. Idempotent: deleting an already-deleted segment is a no-op.
 */
export async function deleteRecordingSegment(
  prisma: PrismaClient,
  input: { recordingSessionId: string; contentItemId: string; segmentId?: string; clientKey?: string },
  actor: { actorId: string },
): Promise<{ deleted: boolean; storageKeys: string[] }> {
  return prisma.$transaction(async (tx) => {
    await lockItem(tx, input.contentItemId);
    const session = await draftFor(tx, input.recordingSessionId, input.contentItemId);
    const seg = input.segmentId
      ? await tx.recordingSegment.findUnique({ where: { id: input.segmentId } })
      : input.clientKey
        ? await tx.recordingSegment.findUnique({ where: { recordingSessionId_clientKey: { recordingSessionId: session.id, clientKey: input.clientKey } } })
        : null;
    if (!seg || seg.recordingSessionId !== session.id) return { deleted: false, storageKeys: [] };
    if (seg.status === "DELETED") return { deleted: false, storageKeys: [] };
    const storageKeys = await removeSegmentMedia(tx, seg);
    await tx.recordingSegment.update({ where: { id: seg.id }, data: { status: "DELETED", deletedAt: new Date() } });
    await tx.recordingSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
    await recordAudit(tx, {
      actor: actor.actorId,
      actorType: "HUMAN",
      action: "RECORDING_SEGMENT_DELETED",
      entityType: "ContentItem",
      entityId: input.contentItemId,
      before: { segmentId: seg.id, segmentIndex: seg.segmentIndex, mediaAssetId: seg.mediaAssetId, durationSeconds: seg.durationSeconds, originalFilename: seg.originalFilename },
      after: { status: "DELETED", mediaDeleted: storageKeys.length > 0 },
    });
    return { deleted: true, storageKeys };
  });
}

/**
 * "Finish": the draft becomes the video. Requires at least one segment with its take uploaded.
 * Idempotent (already FINISHED → returns it). After this the normal ending runs (captions →
 * starter edit of ALL segments in order → style cut → editor).
 */
export async function finishRecordingSession(
  prisma: PrismaClient,
  input: { recordingSessionId: string; contentItemId: string; scriptPosition?: number | null },
  actor: { actorId: string },
): Promise<RecordingSession> {
  return prisma.$transaction(async (tx) => {
    await lockItem(tx, input.contentItemId);
    const s = await tx.recordingSession.findUnique({ where: { id: input.recordingSessionId } });
    if (!s || s.contentItemId !== input.contentItemId) throw new RecordingSessionNotFoundError();
    if (s.status === "FINISHED") return s;
    if (s.status === "DISCARDED") throw new RecordingSessionClosedError(s.status);
    const usable = await tx.recordingSegment.count({ where: { recordingSessionId: s.id, status: "ACTIVE", mediaAssetId: { not: null } } });
    if (usable === 0) throw new Error("Record at least one part before finishing.");
    const done = await tx.recordingSession.update({
      where: { id: s.id },
      data: { status: "FINISHED", finishedAt: new Date(), ...(input.scriptPosition != null ? { scriptPosition: unitOrNull(input.scriptPosition) ?? s.scriptPosition } : {}) },
    });
    await recordAudit(tx, {
      actor: actor.actorId,
      actorType: "HUMAN",
      action: "RECORDING_SESSION_FINISHED",
      entityType: "ContentItem",
      entityId: input.contentItemId,
      before: { status: "DRAFT" },
      after: { recordingSessionId: s.id, status: "FINISHED", segments: usable },
    });
    return done;
  });
}

/**
 * "Discard draft": DISCARDED, every active segment DELETED and its take removed (the caller
 * deletes `storageKeys`). History (session/segment rows, AuditLog) is kept. Idempotent.
 */
export async function discardRecordingSession(
  prisma: PrismaClient,
  input: { recordingSessionId: string; contentItemId: string },
  actor: { actorId: string },
): Promise<{ discarded: boolean; storageKeys: string[] }> {
  return prisma.$transaction(async (tx) => {
    await lockItem(tx, input.contentItemId);
    const s = await tx.recordingSession.findUnique({ where: { id: input.recordingSessionId } });
    if (!s || s.contentItemId !== input.contentItemId) throw new RecordingSessionNotFoundError();
    if (s.status === "DISCARDED") return { discarded: false, storageKeys: [] };
    if (s.status === "FINISHED") throw new RecordingSessionClosedError(s.status);
    const segs = await tx.recordingSegment.findMany({ where: { recordingSessionId: s.id, status: "ACTIVE" } });
    const storageKeys: string[] = [];
    for (const seg of segs) {
      storageKeys.push(...(await removeSegmentMedia(tx, seg)));
      await tx.recordingSegment.update({ where: { id: seg.id }, data: { status: "DELETED", deletedAt: new Date() } });
    }
    await tx.recordingSession.update({ where: { id: s.id }, data: { status: "DISCARDED", discardedAt: new Date() } });
    await recordAudit(tx, {
      actor: actor.actorId,
      actorType: "HUMAN",
      action: "RECORDING_SESSION_DISCARDED",
      entityType: "ContentItem",
      entityId: input.contentItemId,
      before: { status: "DRAFT", segments: segs.length },
      after: { recordingSessionId: s.id, status: "DISCARDED", mediaDeleted: storageKeys.length },
    });
    return { discarded: true, storageKeys };
  });
}

/**
 * The finished recording a starter edit should use: the video's most recent FINISHED session
 * whose active segments all have their take (in order). Null when there is none.
 */
export async function getFinishedRecordingSequence(db: Db, contentItemId: string) {
  const s = (await db.recordingSession.findFirst({
    where: { contentItemId, status: "FINISHED" },
    orderBy: { finishedAt: "desc" },
    include: segmentInclude,
  })) as SessionWithSegments | null;
  if (!s) return null;
  const segments = s.segments.filter((g) => g.mediaAsset);
  if (segments.length === 0) return null;
  return { session: s, mediaAssetIds: segments.map((g) => g.mediaAsset!.id) };
}

export interface RecordingDraftSummary {
  recordingSessionId: string;
  contentItemId: string;
  parts: number;
  seconds: number;
  scriptPosition: number;
  scriptFingerprint: string | null;
  updatedAt: Date;
}

/** Pure: "3 parts · 0:41 filmed". */
export function draftLabel(d: Pick<RecordingDraftSummary, "parts" | "seconds">): string {
  const s = Math.max(0, Math.round(d.seconds));
  const time = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${d.parts} ${d.parts === 1 ? "part" : "parts"} · ${time} filmed`;
}

function summarize(s: SessionWithSegments): RecordingDraftSummary {
  const seconds = s.segments.reduce((a, g) => a + (g.mediaAsset?.durationSeconds ?? g.durationSeconds ?? 0), 0);
  return {
    recordingSessionId: s.id,
    contentItemId: s.contentItemId,
    parts: s.segments.length,
    seconds,
    scriptPosition: s.scriptPosition,
    scriptFingerprint: s.scriptFingerprint,
    updatedAt: s.updatedAt,
  };
}

/** Open drafts (for badges / "Continue: …"), newest first; optionally only for some videos. */
export async function listOpenRecordingDrafts(db: Db, contentItemIds?: string[]): Promise<RecordingDraftSummary[]> {
  const rows = (await db.recordingSession.findMany({
    where: { status: "DRAFT", ...(contentItemIds ? { contentItemId: { in: contentItemIds } } : {}) },
    orderBy: { updatedAt: "desc" },
    include: segmentInclude,
  })) as SessionWithSegments[];
  return rows.map(summarize);
}

export async function getRecordingDraftSummary(db: Db, contentItemId: string): Promise<RecordingDraftSummary | null> {
  const s = await getOpenRecordingSession(db, contentItemId);
  return s ? summarize(s) : null;
}

function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}
function unitOrNull(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}
