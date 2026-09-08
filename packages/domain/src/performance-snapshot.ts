import type { PrismaClient, ContentState, ContentPlatform, SnapshotOffset } from "@prisma/client";
import { z } from "zod";
import { applyTransition } from "./state-machine";
import { recordAudit } from "./audit";

/**
 * Spec §9 step 23 — "T+1h / 6h / 24h / 72h / 7d / 30d... never fabricate an unavailable
 * metric." This file owns exactly two things: the pure due-offset calculation (the literal
 * Phase 6 acceptance criterion lives right on top of this) and the persistence + state
 * transitions. The actual metric *fetch* is real I/O (packages/platforms via an adapter) and
 * belongs in apps/worker, same separation as every other phase's job/domain split.
 */
export const SNAPSHOT_OFFSETS_IN_ORDER: SnapshotOffset[] = [
  "T_PLUS_1H",
  "T_PLUS_6H",
  "T_PLUS_24H",
  "T_PLUS_72H",
  "T_PLUS_7D",
  "T_PLUS_30D",
];

const SNAPSHOT_OFFSET_HOURS: Record<SnapshotOffset, number> = {
  T_PLUS_1H: 1,
  T_PLUS_6H: 6,
  T_PLUS_24H: 24,
  T_PLUS_72H: 72,
  T_PLUS_7D: 24 * 7,
  T_PLUS_30D: 24 * 30,
};

/**
 * Pure, deterministic, no I/O — given when a platform's post actually went live and which
 * offsets are already captured, returns every offset whose target time has passed and hasn't
 * been captured yet, in chronological order. `now` defaults to the real current time but is
 * always overridable — every snapshot test in this repo passes a synthetic `now` rather than
 * waiting on real wall-clock time or risking a real-time collision (see /docs/DECISIONS.md's
 * test-date-collision entries).
 */
export function getDueSnapshotOffsets(
  publishedAt: Date,
  alreadyCaptured: SnapshotOffset[],
  now: Date = new Date(),
): SnapshotOffset[] {
  const captured = new Set(alreadyCaptured);
  const due: SnapshotOffset[] = [];
  for (const offset of SNAPSHOT_OFFSETS_IN_ORDER) {
    if (captured.has(offset)) continue;
    const dueAt = publishedAt.getTime() + SNAPSHOT_OFFSET_HOURS[offset] * 60 * 60 * 1000;
    if (now.getTime() >= dueAt) due.push(offset);
  }
  return due;
}

export class MeasuringRequiresPublishedStateError extends Error {
  constructor(actual: ContentState) {
    super(`Measuring can only start from PUBLISHED (current state: ${actual}).`);
    this.name = "MeasuringRequiresPublishedStateError";
  }
}

/** Called once, the first time any platform's first snapshot is captured — matches
 * /docs/STATE_MACHINE.md's "PUBLISHED -> MEASURING: First metric snapshot job scheduled." A
 * no-op (not an error) if the item is already MEASURING, since the snapshot job runs
 * repeatedly across many offsets and shouldn't need to know whether this is the first call. */
export async function startMeasuring(
  prisma: PrismaClient,
  contentItemId: string,
  actor: { actorId: string },
) {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (item.currentState === "MEASURING") return item;
  if (item.currentState !== "PUBLISHED") {
    throw new MeasuringRequiresPublishedStateError(item.currentState);
  }
  const result = await applyTransition(prisma, {
    contentItemId,
    to: "MEASURING",
    actorType: "SYSTEM",
    actorId: actor.actorId,
    reason: "First metric snapshot captured",
  });
  return result;
}

const RecordPerformanceSnapshotSchema = z.object({
  contentItemId: z.string().min(1),
  platform: z.enum(["INSTAGRAM", "TIKTOK", "YOUTUBE"]),
  offset: z.enum(["T_PLUS_1H", "T_PLUS_6H", "T_PLUS_24H", "T_PLUS_72H", "T_PLUS_7D", "T_PLUS_30D"]),
  viewCount: z.number().int().nullable().optional(),
  likeCount: z.number().int().nullable().optional(),
  commentCount: z.number().int().nullable().optional(),
  shareCount: z.number().int().nullable().optional(),
  saveCount: z.number().int().nullable().optional(),
  reach: z.number().int().nullable().optional(),
  avgWatchTimeSeconds: z.number().nullable().optional(),
  rawResponse: z.unknown().optional(),
});
export type RecordPerformanceSnapshotInput = z.input<typeof RecordPerformanceSnapshotSchema>;

/** Idempotent by design (the schema's `@@unique([contentItemId, platform, offset])`) — capturing
 * the same offset twice updates the one row rather than creating a duplicate, since a snapshot
 * job that runs more than once around the same due time should never produce two rows for what
 * is conceptually one measurement point. */
export async function recordPerformanceSnapshot(
  prisma: PrismaClient,
  input: RecordPerformanceSnapshotInput,
  actor: { actorId: string },
) {
  const parsed = RecordPerformanceSnapshotSchema.parse(input);

  const snapshot = await prisma.performanceSnapshot.upsert({
    where: {
      contentItemId_platform_offset: {
        contentItemId: parsed.contentItemId,
        platform: parsed.platform,
        offset: parsed.offset,
      },
    },
    create: {
      contentItemId: parsed.contentItemId,
      platform: parsed.platform,
      offset: parsed.offset,
      viewCount: parsed.viewCount ?? null,
      likeCount: parsed.likeCount ?? null,
      commentCount: parsed.commentCount ?? null,
      shareCount: parsed.shareCount ?? null,
      saveCount: parsed.saveCount ?? null,
      reach: parsed.reach ?? null,
      avgWatchTimeSeconds: parsed.avgWatchTimeSeconds ?? null,
      rawResponse: (parsed.rawResponse ?? undefined) as never,
    },
    update: {
      capturedAt: new Date(),
      viewCount: parsed.viewCount ?? null,
      likeCount: parsed.likeCount ?? null,
      commentCount: parsed.commentCount ?? null,
      shareCount: parsed.shareCount ?? null,
      saveCount: parsed.saveCount ?? null,
      reach: parsed.reach ?? null,
      avgWatchTimeSeconds: parsed.avgWatchTimeSeconds ?? null,
      rawResponse: (parsed.rawResponse ?? undefined) as never,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "SYSTEM",
    action: "PERFORMANCE_SNAPSHOT_RECORDED",
    entityType: "ContentItem",
    entityId: parsed.contentItemId,
    after: { snapshotId: snapshot.id, platform: parsed.platform, offset: parsed.offset },
  });

  return snapshot;
}

export async function listSnapshotsForContentItem(prisma: PrismaClient, contentItemId: string) {
  return prisma.performanceSnapshot.findMany({
    where: { contentItemId },
    orderBy: [{ platform: "asc" }, { capturedAt: "asc" }],
  });
}

export async function getCapturedOffsets(
  prisma: PrismaClient,
  contentItemId: string,
  platform: ContentPlatform,
): Promise<SnapshotOffset[]> {
  const rows = await prisma.performanceSnapshot.findMany({
    where: { contentItemId, platform },
    select: { offset: true },
  });
  return rows.map((r) => r.offset);
}

export class ArchiveRequiresMeasuringStateError extends Error {
  constructor(actual: ContentState) {
    super(`Archiving can only happen from MEASURING (current state: ${actual}).`);
    this.name = "ArchiveRequiresMeasuringStateError";
  }
}

/** "Final snapshot window closes" (/docs/STATE_MACHINE.md) — every platform this item actually
 * published to (a Publication with status SUCCESS or DRAFT) must have its T_PLUS_30D snapshot
 * captured before the item is done being measured. Returns `false` (no-op, not an error) if
 * some platform's window hasn't closed yet — the snapshot job calls this after every capture
 * and simply keeps not-archiving until it's genuinely time. */
export async function archiveIfMeasurementWindowClosed(
  prisma: PrismaClient,
  contentItemId: string,
  actor: { actorId: string },
): Promise<boolean> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (item.currentState !== "MEASURING") {
    throw new ArchiveRequiresMeasuringStateError(item.currentState);
  }

  const publications = await prisma.publication.findMany({
    where: { contentItemId, status: { in: ["SUCCESS", "DRAFT"] } },
    select: { platform: true },
  });
  const publishedPlatforms = [...new Set(publications.map((p) => p.platform))];
  if (publishedPlatforms.length === 0) return false;

  for (const platform of publishedPlatforms) {
    const captured = await getCapturedOffsets(prisma, contentItemId, platform);
    if (!captured.includes("T_PLUS_30D")) return false;
  }

  await applyTransition(prisma, {
    contentItemId,
    to: "ARCHIVED",
    actorType: "SYSTEM",
    actorId: actor.actorId,
    reason: "Final snapshot window (T+30d) closed for every published platform",
  });
  return true;
}
