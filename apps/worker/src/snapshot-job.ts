import {
  getCapturedOffsets,
  getDueSnapshotOffsets,
  recordPerformanceSnapshot,
  startMeasuring,
  archiveIfMeasurementWindowClosed,
  type PrismaClient,
  type ContentPlatform,
  type SnapshotOffset,
} from "@chris/domain";
import type { PlatformAdapter } from "@chris/platforms";

export interface CaptureDueSnapshotsResult {
  captured: { platform: ContentPlatform; offset: SnapshotOffset }[];
  archived: boolean;
}

/**
 * Spec §9 step 23 — the actual metric fetch (real I/O against a platform adapter) plus the
 * state-machine side effects it drives: `PUBLISHED -> MEASURING` the first time anything is
 * captured, `MEASURING -> ARCHIVED` once every published platform's T+30d window has closed.
 * The due-offset math itself is pure (packages/domain's `getDueSnapshotOffsets`); this file's
 * only job is wiring that to a real adapter call per platform, one platform's outage never
 * stopping the others (same graceful-failure shape as the publish job).
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

  for (const [platform, pub] of latestByPlatform) {
    if (!pub.publishedAt || !pub.platformPostId) continue;
    const adapter = adapters[platform];
    if (!adapter) continue;

    const alreadyCaptured = await getCapturedOffsets(db, contentItemId, platform);
    const due = getDueSnapshotOffsets(pub.publishedAt, alreadyCaptured, now);
    if (due.length === 0) continue;

    try {
      for (const offset of due) {
        const metrics = await adapter.getMetrics(pub.platformPostId);
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
    } catch {
      // One platform's metrics fetch failing (network error, expired token) never stops the
      // others — the offsets simply remain "due" and get retried on the next run, same
      // graceful-failure shape as the publish job.
      continue;
    }
  }

  if (captured.length > 0) {
    const current = await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
    if (current.currentState === "PUBLISHED") {
      await startMeasuring(db, contentItemId, actor);
    }
  }

  let archived = false;
  const afterCapture = await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (afterCapture.currentState === "MEASURING") {
    archived = await archiveIfMeasurementWindowClosed(db, contentItemId, actor);
  }

  return { captured, archived };
}
