import type { PrismaClient, ContentPlatform } from "@prisma/client";

/**
 * `JobRun` — one row per background/cron job run (spec §22 observability: job IDs, retries,
 * errors), plus the per-(ContentItem, platform) publish lease that prevents double-posting.
 */

export type JobRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED";

export async function startJobRun(prisma: PrismaClient, kind: string, summary?: Record<string, unknown>) {
  return prisma.jobRun.create({
    data: { kind, status: "RUNNING", summary: (summary ?? undefined) as never },
  });
}

export async function finishJobRun(
  prisma: PrismaClient,
  id: string,
  outcome: { status: Exclude<JobRunStatus, "RUNNING">; summary?: unknown; error?: string | null },
) {
  return prisma.jobRun.update({
    where: { id },
    data: {
      status: outcome.status,
      finishedAt: new Date(),
      summary: (outcome.summary ?? undefined) as never,
      error: outcome.error ?? null,
    },
  });
}

/** Wraps a job body: writes RUNNING, then SUCCEEDED with the body's summary, or FAILED with
 * the error message (and rethrows nothing — a cron handler gets the row back either way). */
export async function runRecordedJob<T>(
  prisma: PrismaClient,
  kind: string,
  body: () => Promise<T>,
): Promise<{ jobRunId: string; status: "SUCCEEDED" | "FAILED"; result: T | null; error: string | null }> {
  const run = await startJobRun(prisma, kind);
  try {
    const result = await body();
    await finishJobRun(prisma, run.id, { status: "SUCCEEDED", summary: result });
    return { jobRunId: run.id, status: "SUCCEEDED", result, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await finishJobRun(prisma, run.id, { status: "FAILED", error });
    return { jobRunId: run.id, status: "FAILED", result: null, error };
  }
}

export async function listRecentJobRuns(prisma: PrismaClient, options: { kind?: string; limit?: number } = {}) {
  return prisma.jobRun.findMany({
    where: options.kind ? { kind: options.kind } : undefined,
    orderBy: { startedAt: "desc" },
    take: options.limit ?? 20,
  });
}

// ---------------------------------------------------------------------------------------------
// Publish lease
// ---------------------------------------------------------------------------------------------

/** A publish attempt (upload + bounded processing poll + verify) is far shorter than this; a
 * lease older than this is from a crashed process and may be taken over. */
export const PUBLISH_LEASE_STALE_AFTER_MS = 20 * 60 * 1000;

export function publishLeaseKind(contentItemId: string, platform: ContentPlatform): string {
  return `publish-lease:${contentItemId}:${platform}`;
}

export type PublishLeaseResult =
  | { acquired: true; leaseId: string }
  | { acquired: false; heldSince: Date; leaseId: string };

/**
 * Mutual exclusion per (ContentItem, platform) without a schema change: the claim runs in a
 * short transaction serialized by `pg_advisory_xact_lock(hashtext(kind))` — so two concurrent
 * claimers (double-click, two tabs, cron + human) can never both see "no active lease" — and
 * the lease itself is a `JobRun` row (status RUNNING) that outlives the transaction while the
 * slow network work happens outside any DB transaction. Released by `releasePublishLease`;
 * a lease older than PUBLISH_LEASE_STALE_AFTER_MS is treated as abandoned.
 */
export async function acquirePublishLease(
  prisma: PrismaClient,
  contentItemId: string,
  platform: ContentPlatform,
  options: { staleAfterMs?: number; now?: Date } = {},
): Promise<PublishLeaseResult> {
  const kind = publishLeaseKind(contentItemId, platform);
  const staleAfterMs = options.staleAfterMs ?? PUBLISH_LEASE_STALE_AFTER_MS;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${kind}))::text AS locked`;
    const now = options.now ?? new Date();
    const active = await tx.jobRun.findFirst({
      where: { kind, status: "RUNNING" },
      orderBy: { startedAt: "desc" },
    });
    if (active && now.getTime() - active.startedAt.getTime() < staleAfterMs) {
      return { acquired: false as const, heldSince: active.startedAt, leaseId: active.id };
    }
    if (active) {
      await tx.jobRun.update({
        where: { id: active.id },
        data: { status: "FAILED", finishedAt: now, error: "Stale publish lease taken over (process likely crashed)." },
      });
    }
    const lease = await tx.jobRun.create({
      data: { kind, status: "RUNNING", summary: { contentItemId, platform } },
    });
    return { acquired: true as const, leaseId: lease.id };
  });
}

export async function releasePublishLease(
  prisma: PrismaClient,
  leaseId: string,
  outcome: { status: "SUCCEEDED" | "FAILED"; summary?: Record<string, unknown>; error?: string | null },
) {
  await prisma.jobRun.update({
    where: { id: leaseId },
    data: {
      status: outcome.status,
      finishedAt: new Date(),
      summary: (outcome.summary ?? undefined) as never,
      error: outcome.error ?? null,
    },
  });
}
