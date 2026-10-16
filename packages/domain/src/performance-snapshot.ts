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

const HOUR_MS = 60 * 60 * 1000;

export function snapshotDueAt(publishedAt: Date, offset: SnapshotOffset): Date {
  return new Date(publishedAt.getTime() + SNAPSHOT_OFFSET_HOURS[offset] * HOUR_MS);
}

/** How long after its target time an offset may still be captured honestly: max(1h, 25% of
 * the offset). T+1h -> [1h, 2h), T+6h -> [6h, 7.5h), T+24h -> [24h, 30h), T+72h -> [72h, 90h),
 * T+7d -> [7d, 8.75d), T+30d -> [30d, 37.5d). No window overlaps the next offset's, so a
 * single capture can never be recorded under two labels. */
export function snapshotCaptureWindowMs(offset: SnapshotOffset): number {
  return Math.max(HOUR_MS, 0.25 * SNAPSHOT_OFFSET_HOURS[offset] * HOUR_MS);
}

/**
 * Pure, deterministic, no I/O — the offsets that may be captured *right now*: target time
 * reached, still inside that offset's capture window, not yet captured. An offset whose window
 * has passed is NOT returned (see `getMissedSnapshotOffsets`): capturing day-8 numbers and
 * labelling them "T+1h" would fabricate history (spec §23: never fabricate a metric). A missed
 * offset stays an honest gap. `now` is always overridable for tests.
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
    const dueAt = snapshotDueAt(publishedAt, offset).getTime();
    if (now.getTime() >= dueAt && now.getTime() < dueAt + snapshotCaptureWindowMs(offset)) due.push(offset);
  }
  return due;
}

/** Offsets whose capture window closed without a capture — surfaced as gaps, never backfilled. */
export function getMissedSnapshotOffsets(
  publishedAt: Date,
  alreadyCaptured: SnapshotOffset[],
  now: Date = new Date(),
): SnapshotOffset[] {
  const captured = new Set(alreadyCaptured);
  return SNAPSHOT_OFFSETS_IN_ORDER.filter((offset) => {
    if (captured.has(offset)) return false;
    return now.getTime() >= snapshotDueAt(publishedAt, offset).getTime() + snapshotCaptureWindowMs(offset);
  });
}

/** When the final (T+30d) capture window closes — the measurement period is over whether or
 * not every offset was captured. */
export function measurementWindowClosesAt(publishedAt: Date): Date {
  return new Date(snapshotDueAt(publishedAt, "T_PLUS_30D").getTime() + snapshotCaptureWindowMs("T_PLUS_30D"));
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

/** "Final snapshot window closes" (/docs/STATE_MACHINE.md) — for every platform this item
 * actually published to (latest SUCCESS/DRAFT Publication), either its T+30d snapshot is
 * captured or its T+30d capture window has passed. Missed offsets never block archiving
 * forever — they are honest gaps. Returns `false` (no-op) while any platform is still inside
 * its measurement period. */
export async function archiveIfMeasurementWindowClosed(
  prisma: PrismaClient,
  contentItemId: string,
  actor: { actorId: string },
  options: { now?: Date } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (item.currentState !== "MEASURING") {
    throw new ArchiveRequiresMeasuringStateError(item.currentState);
  }

  const closed = await isMeasurementWindowClosed(prisma, contentItemId, now);
  if (!closed) return false;

  await applyTransition(prisma, {
    contentItemId,
    to: "ARCHIVED",
    actorType: "SYSTEM",
    actorId: actor.actorId,
    reason: "Final snapshot window (T+30d) closed for every published platform",
  });
  return true;
}

export async function isMeasurementWindowClosed(
  prisma: PrismaClient,
  contentItemId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const publications = await prisma.publication.findMany({
    where: { contentItemId, status: { in: ["SUCCESS", "DRAFT"] } },
    orderBy: { createdAt: "desc" },
    select: { platform: true, publishedAt: true },
  });
  const latestByPlatform = new Map<ContentPlatform, Date | null>();
  for (const pub of publications) {
    if (!latestByPlatform.has(pub.platform)) latestByPlatform.set(pub.platform, pub.publishedAt);
  }
  if (latestByPlatform.size === 0) return false;

  for (const [platform, publishedAt] of latestByPlatform) {
    const captured = await getCapturedOffsets(prisma, contentItemId, platform);
    if (captured.includes("T_PLUS_30D")) continue;
    if (publishedAt && now.getTime() >= measurementWindowClosesAt(publishedAt).getTime()) continue;
    return false;
  }
  return true;
}
