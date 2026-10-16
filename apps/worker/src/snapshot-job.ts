import {
  getCapturedOffsets,
  getDueSnapshotOffsets,
  getMissedSnapshotOffsets,
  recordPerformanceSnapshot,
  startMeasuring,
  archiveIfMeasurementWindowClosed,
  isMeasurementWindowClosed,
  type PrismaClient,
  type ContentPlatform,
  type SnapshotOffset,
} from "@chris/domain";
import type { PlatformAdapter } from "@chris/platforms";

export interface CaptureDueSnapshotsResult {
  captured: { platform: ContentPlatform; offset: SnapshotOffset }[];
  /** Offsets whose capture window passed uncaptured — honest gaps, never backfilled. */
  missed: { platform: ContentPlatform; offset: SnapshotOffset }[];
  /** Per-platform fetch errors (HTTP 401, network…) — the due offset stays due. */
  errors: { platform: ContentPlatform; message: string }[];
  archived: boolean;
}

/**
 * Spec §9 step 23 — metric capture + the PUBLISHED -> MEASURING -> ARCHIVED transitions.
 *
 * Honesty rules:
 * - An offset is only captured inside its own window (packages/domain getDueSnapshotOffsets):
 *   clicking on day 8 records T+7d at most, never "T+1h" with day-8 numbers.
 * - A platform read error records nothing (adapters throw on non-2xx) and is reported.
 * - Archiving happens once every published platform's T+30d window has closed, captured or
 *   not — missed offsets don't hold an item in MEASURING forever.
 * - All offsets due in the same run share one metrics read (they are the same moment).
 */
export async function captureDueSnapshots(
  db: PrismaClient,
  adapters: Partial<Record<ContentPlatform, PlatformAdapter>>,
  contentItemId: string,
  actor: { actorId: string },
  options: { now?: Date } = {},
): Promise<CaptureDueSnapshotsResult> {
  const now = options.now ?? new Date();

  const publications = await db.publication.findMany({
    where: { contentItemId, status: { in: ["SUCCESS", "DRAFT"] } },
    orderBy: { createdAt: "desc" },
  });
  const latestByPlatform = new Map<ContentPlatform, (typeof publications)[number]>();
  for (const pub of publications) {
    if (!latestByPlatform.has(pub.platform)) latestByPlatform.set(pub.platform, pub);
  }

  const captured: { platform: ContentPlatform; offset: SnapshotOffset }[] = [];
  const missed: { platform: ContentPlatform; offset: SnapshotOffset }[] = [];
  const errors: { platform: ContentPlatform; message: string }[] = [];

  for (const [platform, pub] of latestByPlatform) {
    if (!pub.publishedAt || !pub.platformPostId) continue;
    const alreadyCaptured = await getCapturedOffsets(db, contentItemId, platform);
    for (const offset of getMissedSnapshotOffsets(pub.publishedAt, alreadyCaptured, now)) missed.push({ platform, offset });

    const adapter = adapters[platform];
    if (!adapter) continue;
    const due = getDueSnapshotOffsets(pub.publishedAt, alreadyCaptured, now);
    if (due.length === 0) continue;

    try {
      const metrics = await adapter.getMetrics(pub.platformPostId);
      for (const offset of due) {
        await recordPerformanceSnapshot(
          db,
          {
            contentItemId,
            platform,
            offset,
            viewCount: metrics.viewCount,
            likeCount: metrics.likeCount,
            commentCount: metrics.commentCount,
            shareCount: metrics.shareCount,
            saveCount: metrics.saveCount,
            reach: metrics.reach,
            avgWatchTimeSeconds: metrics.avgWatchTimeSeconds,
            rawResponse: metrics.rawResponse,
          },
          actor,
        );
        captured.push({ platform, offset });
      }
    } catch (err) {
      errors.push({ platform, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const current = await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (current.currentState === "PUBLISHED") {
    // First capture, or the whole measurement period passed with nothing capturable (every
    // read failed / never polled) — move on rather than strand the item at PUBLISHED.
    if (captured.length > 0 || (await isMeasurementWindowClosed(db, contentItemId, now))) {
      await startMeasuring(db, contentItemId, actor);
    }
  }

  let archived = false;
  const afterCapture = await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (afterCapture.currentState === "MEASURING") {
    archived = await archiveIfMeasurementWindowClosed(db, contentItemId, actor, { now });
  }

  return { captured, missed, errors, archived };
}
