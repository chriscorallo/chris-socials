import {
  isEnabled,
  runRecordedJob,
  getResumeToken,
  markPublicationVerified,
  notePublicationVerificationPending,
  verificationPendingNote,
  listUnverifiedPublications,
  type PrismaClient,
  type ContentPlatform,
} from "@chris/domain";
import type { PlatformAdapter } from "@chris/platforms";
import type { StorageAdapter } from "@chris/media";
import { publishContentItem, type PublishJobResult } from "./publish-job";
import { captureDueSnapshots } from "./snapshot-job";
import { ingestCommentsForContentItem } from "./comment-ingestion-job";

/**
 * Cron-driven sweeps (exposed by apps/web as /api/cron/* routes). Every run writes a JobRun row
 * (RUNNING -> SUCCEEDED/FAILED with a summary) and isolates each item: one item's failure is
 * recorded in the summary and never stops the rest.
 */

/** Feature flag gating scheduled auto-publishing. A human scheduled the item (so the content
 * is human-approved), but publishing *at the scheduled time with nobody clicking* is new
 * autonomous behavior — CLAUDE.md: risky/new autonomy is flagged and off by default (an
 * absent flag row is OFF, see feature-flags.ts). */
export const SCHEDULED_PUBLISH_FLAG = "publishing.scheduled_auto";
export const SCHEDULED_PUBLISH_JOB_KIND = "scheduled-publish";
export const SNAPSHOT_SWEEP_JOB_KIND = "snapshot-sweep";

/** A scheduled item more than this overdue is surfaced as missed, not auto-posted: posting a
 * day late at an arbitrary hour is a different decision than the one Chris made. */
export const SCHEDULED_PUBLISH_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Matches publish-job's resume horizon (Instagram containers expire after 24h). */
const RESUME_WINDOW_MS = 23 * 60 * 60 * 1000;

export interface ScheduledPublishSummary {
  flagEnabled: boolean;
  published: { contentItemId: string; succeeded: ContentPlatform[]; failed: ContentPlatform[]; skipped: string[] }[];
  resumed: { contentItemId: string; platforms: ContentPlatform[]; succeeded: ContentPlatform[]; failed: ContentPlatform[] }[];
  missed: { contentItemId: string; scheduledDate: string }[];
  notYetDue: number;
  errors: { contentItemId: string; message: string }[];
}

export async function publishDueScheduledItems(input: {
  prisma: PrismaClient;
  storage: StorageAdapter;
  adapters: Partial<Record<ContentPlatform, PlatformAdapter>>;
  now?: Date;
  getPublicVideoUrl?: (storageKey: string) => Promise<string | null>;
  actorId?: string;
  staleAfterMs?: number;
  verifyDelaysMs?: number[];
}): Promise<{ jobRunId: string; status: "SUCCEEDED" | "FAILED"; summary: ScheduledPublishSummary | null; error: string | null }> {
  const { prisma } = input;
  const now = input.now ?? new Date();
  const actor = { actorId: input.actorId ?? "system:scheduled-publish" };
  const staleAfterMs = input.staleAfterMs ?? SCHEDULED_PUBLISH_STALE_AFTER_MS;

  const run = await runRecordedJob(prisma, SCHEDULED_PUBLISH_JOB_KIND, async (): Promise<ScheduledPublishSummary> => {
    const summary: ScheduledPublishSummary = {
      flagEnabled: await isEnabled(prisma, SCHEDULED_PUBLISH_FLAG),
      published: [],
      resumed: [],
      missed: [],
      notYetDue: 0,
      errors: [],
    };
    if (!summary.flagEnabled) return summary;

    const publishOptions = { now, getPublicVideoUrl: input.getPublicVideoUrl, verifyDelaysMs: input.verifyDelaysMs };

    // 1. SCHEDULED items whose time has come. Sequential queries (PGlite — /docs/DECISIONS.md).
    const scheduledItems = await prisma.contentItem.findMany({ where: { currentState: "SCHEDULED" }, select: { id: true } });
    const entries =
      scheduledItems.length === 0
        ? []
        : await prisma.scheduleEntry.findMany({
            where: { contentItemId: { in: scheduledItems.map((i) => i.id) } },
            orderBy: { scheduledDate: "asc" },
          });
    for (const entry of entries) {
      const dueMs = entry.scheduledDate.getTime();
      if (dueMs > now.getTime()) {
        summary.notYetDue++;
        continue;
      }
      if (now.getTime() - dueMs > staleAfterMs) {
        summary.missed.push({ contentItemId: entry.contentItemId, scheduledDate: entry.scheduledDate.toISOString() });
        continue;
      }
      try {
        const result: PublishJobResult = await publishContentItem(
          prisma,
          input.storage,
          input.adapters,
          entry.contentItemId,
          actor,
          publishOptions,
        );
        summary.published.push({
          contentItemId: entry.contentItemId,
          succeeded: result.succeededPlatforms,
          failed: result.failedPlatforms,
          skipped: result.skippedPlatforms.map((s) => `${s.platform}: ${s.reason}`),
        });
      } catch (err) {
        summary.errors.push({ contentItemId: entry.contentItemId, message: err instanceof Error ? err.message : String(err) });
      }
    }

    // 2. Resume platform-side processing left pending by an earlier run (e.g. an Instagram
    //    container still processing) — only those platforms, never a blanket retry of failures.
    const recentFailures = await prisma.publication.findMany({
      where: { status: "FAILED", createdAt: { gte: new Date(now.getTime() - RESUME_WINDOW_MS) } },
      orderBy: { createdAt: "desc" },
    });
    const resumable = new Map<string, Set<ContentPlatform>>();
    const seen = new Set<string>();
    for (const pub of recentFailures) {
      const key = `${pub.contentItemId}:${pub.platform}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const latest = await prisma.publication.findFirst({
        where: { contentItemId: pub.contentItemId, platform: pub.platform },
        orderBy: { createdAt: "desc" },
      });
      if (!latest || latest.id !== pub.id || !getResumeToken(pub)) continue;
      const set = resumable.get(pub.contentItemId) ?? new Set<ContentPlatform>();
      set.add(pub.platform);
      resumable.set(pub.contentItemId, set);
    }
    for (const [contentItemId, platformSet] of resumable) {
      const platforms = [...platformSet];
      try {
        const result = await publishContentItem(prisma, input.storage, input.adapters, contentItemId, actor, {
          ...publishOptions,
          onlyPlatforms: platforms,
        });
        summary.resumed.push({ contentItemId, platforms, succeeded: result.succeededPlatforms, failed: result.failedPlatforms });
      } catch (err) {
        summary.errors.push({ contentItemId, message: err instanceof Error ? err.message : String(err) });
      }
    }

    return summary;
  });

  return { jobRunId: run.jobRunId, status: run.status, summary: run.result, error: run.error };
}

export interface SnapshotSweepSummary {
  items: number;
  captured: number;
  missed: number;
  archived: number;
  commentsIngested: number;
  verified: number;
  errors: { contentItemId: string; platform?: ContentPlatform; message: string }[];
}

/**
 * Sweeps every PUBLISHED/MEASURING item: captures due snapshots (within their honest windows),
 * archives finished items, ingests comments for items that just hit a measurement point, and
 * re-verifies publications the publish job couldn't confirm in its short budget (e.g. TikTok
 * resolving the real video id after moderation). Read-only toward the platforms — no flag.
 * Run it hourly: the T+1h window is [1h, 2h).
 */
export async function captureDueSnapshotsForAll(input: {
  prisma: PrismaClient;
  adapters: Partial<Record<ContentPlatform, PlatformAdapter>>;
  now?: Date;
  actorId?: string;
}): Promise<{ jobRunId: string; status: "SUCCEEDED" | "FAILED"; summary: SnapshotSweepSummary | null; error: string | null }> {
  const { prisma, adapters } = input;
  const now = input.now ?? new Date();
  const actor = { actorId: input.actorId ?? "system:snapshot-sweep" };

  const run = await runRecordedJob(prisma, SNAPSHOT_SWEEP_JOB_KIND, async (): Promise<SnapshotSweepSummary> => {
    const summary: SnapshotSweepSummary = { items: 0, captured: 0, missed: 0, archived: 0, commentsIngested: 0, verified: 0, errors: [] };

    // Re-verify first, so TikTok metrics can use a freshly-resolved video id.
    const unverified = await listUnverifiedPublications(prisma, { since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) });
    for (const pub of unverified) {
      const adapter = adapters[pub.platform];
      if (!adapter || !pub.platformPostId) continue;
      try {
        const result = await adapter.verify(pub.platformPostId);
        if (result.verified) {
          await markPublicationVerified(
            prisma,
            {
              publicationId: pub.id,
              resolvedPostId: result.resolvedPostId ?? null,
              url: result.url ?? null,
              verificationResponse: result.rawResponse,
              note: result.note ?? null,
            },
            actor,
          );
          summary.verified++;
        } else {
          await notePublicationVerificationPending(prisma, pub.id, verificationPendingNote(result.note ?? null), result.rawResponse);
        }
      } catch (err) {
        summary.errors.push({ contentItemId: pub.contentItemId, platform: pub.platform, message: `verify: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    const items = await prisma.contentItem.findMany({
      where: { currentState: { in: ["PUBLISHED", "MEASURING"] } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    summary.items = items.length;
    for (const item of items) {
      try {
        const result = await captureDueSnapshots(prisma, adapters, item.id, actor, { now });
        summary.captured += result.captured.length;
        summary.missed += result.missed.length;
        if (result.archived) summary.archived++;
        for (const e of result.errors) summary.errors.push({ contentItemId: item.id, platform: e.platform, message: e.message });
        if (result.captured.length > 0) {
          const comments = await ingestCommentsForContentItem(prisma, adapters, item.id, actor);
          summary.commentsIngested += comments.ingestedCount;
          for (const e of comments.errors) summary.errors.push({ contentItemId: item.id, platform: e.platform, message: `comments: ${e.message}` });
        }
      } catch (err) {
        summary.errors.push({ contentItemId: item.id, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return summary;
  });

  return { jobRunId: run.jobRunId, status: run.status, summary: run.result, error: run.error };
}
