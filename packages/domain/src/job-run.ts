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

// ---------------------------------------------------------------------------------------------
// Heavy jobs (render / transcribe / matte / ... — run in-process locally, in a Vercel Sandbox
// on Vercel). One JobRun row per job; its `summary` JSON carries the job's kind, args, live
// progress and result so the web app can poll it. No schema change: the row's `kind` is
// `heavy:<contentItemId>` (exact-match lookups use the existing (kind, startedAt) index, the
// same trick as the publish lease) and everything else lives in `summary`.
// ---------------------------------------------------------------------------------------------

export const HEAVY_JOB_KIND_PREFIX = "heavy:";

/** A heavy job still RUNNING after this long is from a crashed/killed worker (the sandbox's own
 * hard timeout is shorter) and may be taken over. */
export const HEAVY_JOB_STALE_AFTER_MS = 60 * 60 * 1000;

export function heavyJobRunKind(contentItemId: string): string {
  return `${HEAVY_JOB_KIND_PREFIX}${contentItemId}`;
}

/** inline = in the web process; sandbox = a Vercel Sandbox; worker = Chris's Mac render worker
 * (apps/worker/src/film-worker.ts) picks it up from the queue. */
export type HeavyJobMode = "inline" | "sandbox" | "worker";

/** Who may run a queued job: "mac" = only the Mac render worker; anything else (or unset) = the cloud/web. */
export type HeavyJobTarget = "mac" | "cloud";

export interface HeavyJobProgress {
  /** 0..100 */
  pct: number;
  /** Plain-English line for Chris ("Rendering your graphics…"). */
  message: string;
  /** Machine-readable step (e.g. "render", "check") — the Finish modal keys its steps on it. */
  stage?: string;
  updatedAt?: string;
}

export interface HeavyJobSummary {
  jobKind: string;
  contentItemId: string;
  args: unknown;
  mode: HeavyJobMode;
  actorId: string;
  progress: HeavyJobProgress;
  /** Sandbox name (sandbox mode) — used to stop it. */
  sandboxName?: string | null;
  sandboxStopped?: boolean;
  /** The job's typed result (on success; partial results may be present on failure). */
  result?: unknown;
  /** Queued for a specific kind of worker (see HeavyJobTarget). Unset = cloud/web. */
  target?: HeavyJobTarget;
}

/** A heavy job can also wait for a free cloud worker (QUEUED) — see acquireHeavyJobLease. */
export type HeavyJobStatus = JobRunStatus | "QUEUED";

/** A QUEUED heavy job that no worker picked up within this window is given up (FAILED). */
export const HEAVY_JOB_QUEUE_EXPIRES_MS = 2 * 60 * 60 * 1000;

export interface HeavyJobView {
  id: string;
  status: HeavyJobStatus;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
  summary: HeavyJobSummary | null;
}

export function parseHeavyJobRun(row: {
  id: string;
  kind: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
  summary: unknown;
}): HeavyJobView | null {
  if (!row.kind.startsWith(HEAVY_JOB_KIND_PREFIX)) return null;
  const s = (row.summary ?? null) as HeavyJobSummary | null;
  return {
    id: row.id,
    status: row.status as HeavyJobStatus,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    error: row.error,
    summary: s && typeof s === "object" ? s : null,
  };
}

export type HeavyJobLeaseResult =
  | { acquired: true; jobRunId: string }
  | { acquired: false; reason: "BUSY"; activeJobRunId: string; activeJobKind: string | null; heldSince: Date }
  | { acquired: false; reason: "CAPACITY"; running: number; limit: number }
  /** At capacity, `queueIfFull`: recorded as QUEUED — a worker or the next poll starts it. */
  | { acquired: false; reason: "QUEUED"; jobRunId: string; ahead: number };

/**
 * Claims the right to run one heavy job for a content item and records it as a RUNNING JobRun.
 * Serialized by one transaction-scoped advisory lock (all heavy claims queue on it — they are
 * rare and the critical section is one read and an insert), so double taps / two tabs / an
 * upload's background job and a button can never both start work on the same item, and the
 * global sandbox cap can't be overshot by a race.
 * - BUSY: a non-stale heavy job is already RUNNING for this item.
 * - CAPACITY: `maxConcurrentSandboxes` sandbox-mode jobs are already RUNNING (any item) — or,
 *   with `queueIfFull`, QUEUED: the job is recorded and waits its turn (first in, first out:
 *   while anything is queued, new jobs queue behind it).
 * A RUNNING row older than `staleAfterMs` is marked FAILED and ignored; so is a QUEUED row older
 * than HEAVY_JOB_QUEUE_EXPIRES_MS.
 */
export async function acquireHeavyJobLease(
  prisma: PrismaClient,
  input: {
    contentItemId: string;
    jobKind: string;
    args: unknown;
    mode: HeavyJobMode;
    actorId: string;
    maxConcurrentSandboxes?: number;
    staleAfterMs?: number;
    queueIfFull?: boolean;
    now?: Date;
  },
): Promise<HeavyJobLeaseResult> {
  const kind = heavyJobRunKind(input.contentItemId);
  const staleAfterMs = input.staleAfterMs ?? HEAVY_JOB_STALE_AFTER_MS;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('heavy-jobs'))::text AS locked`;
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - staleAfterMs);
    const active = await tx.jobRun.findMany({
      where: { kind: { startsWith: HEAVY_JOB_KIND_PREFIX }, status: { in: ["RUNNING", "QUEUED"] } },
      orderBy: { startedAt: "desc" },
    });
    await expireHeavyJobs(tx as unknown as PrismaClient, active, now, staleAfterMs);
    const queueCutoff = new Date(now.getTime() - HEAVY_JOB_QUEUE_EXPIRES_MS);
    const live = active.filter((r) => r.startedAt >= cutoff && r.status === "RUNNING");
    const queued = active.filter((r) => r.status === "QUEUED" && r.startedAt >= queueCutoff);
    const mine = [...live, ...queued].find((r) => r.kind === kind);
    if (mine) {
      const s = (mine.summary ?? null) as HeavyJobSummary | null;
      return {
        acquired: false as const,
        reason: "BUSY" as const,
        activeJobRunId: mine.id,
        activeJobKind: s?.jobKind ?? null,
        heldSince: mine.startedAt,
      };
    }
    if (input.mode === "sandbox" && input.maxConcurrentSandboxes != null) {
      const sandboxes = live.filter((r) => ((r.summary ?? null) as HeavyJobSummary | null)?.mode === "sandbox").length;
      if (sandboxes >= input.maxConcurrentSandboxes || (input.queueIfFull && queued.length > 0)) {
        if (!input.queueIfFull) {
          return { acquired: false as const, reason: "CAPACITY" as const, running: sandboxes, limit: input.maxConcurrentSandboxes };
        }
        const waiting: HeavyJobSummary = {
          jobKind: input.jobKind,
          contentItemId: input.contentItemId,
          args: input.args,
          mode: input.mode,
          actorId: input.actorId,
          progress: { pct: 0, message: "Waiting for a free cloud worker…", stage: "queued", updatedAt: now.toISOString() },
          sandboxName: null,
        };
        const row = await tx.jobRun.create({ data: { kind, status: "QUEUED", startedAt: now, summary: waiting as never } });
        return { acquired: false as const, reason: "QUEUED" as const, jobRunId: row.id, ahead: queued.length };
      }
    }
    const summary: HeavyJobSummary = {
      jobKind: input.jobKind,
      contentItemId: input.contentItemId,
      args: input.args,
      mode: input.mode,
      actorId: input.actorId,
      progress: { pct: 0, message: "Starting…", stage: "queued", updatedAt: now.toISOString() },
      sandboxName: null,
    };
    const row = await tx.jobRun.create({ data: { kind, status: "RUNNING", summary: summary as never } });
    return { acquired: true as const, jobRunId: row.id };
  });
}

async function expireHeavyJobs(
  tx: PrismaClient,
  rows: Array<{ id: string; status: string; startedAt: Date }>,
  now: Date,
  staleAfterMs: number,
): Promise<void> {
  const deadRunning = rows.filter((r) => r.status === "RUNNING" && r.startedAt.getTime() < now.getTime() - staleAfterMs).map((r) => r.id);
  const deadQueued = rows.filter((r) => r.status === "QUEUED" && r.startedAt.getTime() < now.getTime() - HEAVY_JOB_QUEUE_EXPIRES_MS).map((r) => r.id);
  if (deadRunning.length > 0) {
    await tx.jobRun.updateMany({
      where: { id: { in: deadRunning }, status: "RUNNING" },
      data: { status: "FAILED", finishedAt: now, error: "The job stopped responding (its worker likely crashed or timed out)." },
    });
  }
  if (deadQueued.length > 0) {
    await tx.jobRun.updateMany({
      where: { id: { in: deadQueued }, status: "QUEUED" },
      data: { status: "FAILED", finishedAt: now, error: "No cloud worker became free in time — try again." },
    });
  }
}

export interface ClaimedHeavyJob {
  jobRunId: string;
  jobKind: string;
  contentItemId: string;
  args: unknown;
  actorId: string;
}

/**
 * Takes the oldest QUEUED heavy job and marks it RUNNING (startedAt = now), under the same
 * advisory lock as acquireHeavyJobLease. `maxConcurrentSandboxes` (the web app starting a new
 * sandbox for it) respects the cap; a worker reusing its own sandbox passes none. `kinds`
 * restricts which jobs the caller can run (a worker without the model key takes only non-AI
 * jobs). null = nothing to do.
 */
export async function claimQueuedHeavyJob(
  prisma: PrismaClient,
  options: {
    maxConcurrentSandboxes?: number;
    kinds?: string[];
    staleAfterMs?: number;
    now?: Date;
    sandboxName?: string | null;
    /** "mac": only jobs queued for the Mac render worker; otherwise those are never claimed. */
    target?: HeavyJobTarget;
    /** Only these lease subjects (e.g. one film's chunks). */
    subjects?: string[];
  } = {},
): Promise<ClaimedHeavyJob | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('heavy-jobs'))::text AS locked`;
    const now = options.now ?? new Date();
    const staleAfterMs = options.staleAfterMs ?? HEAVY_JOB_STALE_AFTER_MS;
    const active = await tx.jobRun.findMany({
      where: { kind: { startsWith: HEAVY_JOB_KIND_PREFIX }, status: { in: ["RUNNING", "QUEUED"] } },
      orderBy: { startedAt: "asc" },
    });
    await expireHeavyJobs(tx as unknown as PrismaClient, active, now, staleAfterMs);
    const live = active.filter((r) => r.status === "RUNNING" && r.startedAt.getTime() >= now.getTime() - staleAfterMs);
    if (options.maxConcurrentSandboxes != null) {
      const sandboxes = live.filter((r) => ((r.summary ?? null) as HeavyJobSummary | null)?.mode === "sandbox").length;
      if (sandboxes >= options.maxConcurrentSandboxes) return null;
    }
    const busyItems = new Set(live.map((r) => r.kind));
    const next = active.find((r) => {
      if (r.status !== "QUEUED" || r.startedAt.getTime() < now.getTime() - HEAVY_JOB_QUEUE_EXPIRES_MS || busyItems.has(r.kind)) return false;
      const s = (r.summary ?? null) as HeavyJobSummary | null;
      if (!s) return false;
      const forMac = s.target === "mac";
      if (options.target === "mac" ? !forMac : forMac) return false;
      if (options.subjects && !options.subjects.includes(s.contentItemId)) return false;
      return !options.kinds || options.kinds.includes(s.jobKind);
    });
    if (!next) return null;
    const s = next.summary as unknown as HeavyJobSummary;
    const progress: HeavyJobProgress = { pct: 0, message: "Starting…", stage: "start", updatedAt: now.toISOString() };
    const patch = JSON.stringify({ progress, ...(options.sandboxName ? { sandboxName: options.sandboxName } : {}) });
    const n = await tx.$executeRaw`UPDATE "JobRun" SET "status" = 'RUNNING', "startedAt" = ${now}, "summary" = COALESCE("summary", '{}'::jsonb) || ${patch}::jsonb WHERE "id" = ${next.id} AND "status" = 'QUEUED'`;
    if (n === 0) return null;
    return { jobRunId: next.id, jobKind: s.jobKind, contentItemId: s.contentItemId, args: s.args, actorId: s.actorId };
  });
}

/**
 * Records a heavy job as QUEUED regardless of capacity — for work that is split into parts
 * (a film's render chunks) or that waits for a specific worker (target "mac"). Same lease rule
 * as acquireHeavyJobLease: a subject that already has a RUNNING/QUEUED job is BUSY (returns it).
 */
export async function enqueueHeavyJob(
  prisma: PrismaClient,
  input: { subject: string; jobKind: string; args: unknown; mode: HeavyJobMode; actorId: string; target?: HeavyJobTarget; message?: string; now?: Date },
): Promise<{ queued: true; jobRunId: string } | { queued: false; reason: "BUSY"; activeJobRunId: string }> {
  const kind = heavyJobRunKind(input.subject);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('heavy-jobs'))::text AS locked`;
    const now = input.now ?? new Date();
    const existing = await tx.jobRun.findFirst({ where: { kind, status: { in: ["RUNNING", "QUEUED"] } }, orderBy: { startedAt: "desc" } });
    const fresh = existing && (existing.status === "QUEUED" ? existing.startedAt.getTime() > now.getTime() - HEAVY_JOB_QUEUE_EXPIRES_MS : existing.startedAt.getTime() > now.getTime() - HEAVY_JOB_STALE_AFTER_MS);
    if (existing && fresh) return { queued: false as const, reason: "BUSY" as const, activeJobRunId: existing.id };
    const summary: HeavyJobSummary = {
      jobKind: input.jobKind,
      contentItemId: input.subject,
      args: input.args,
      mode: input.mode,
      actorId: input.actorId,
      progress: { pct: 0, message: input.message ?? (input.target === "mac" ? "Waiting for your Mac…" : "Waiting for a free cloud worker…"), stage: "queued", updatedAt: now.toISOString() },
      sandboxName: null,
      ...(input.target ? { target: input.target } : {}),
    };
    const row = await tx.jobRun.create({ data: { kind, status: "QUEUED", startedAt: now, summary: summary as never } });
    return { queued: true as const, jobRunId: row.id };
  });
}

/** Status of several heavy jobs at once (a film's chunks). */
export async function getHeavyJobs(prisma: PrismaClient, ids: string[]): Promise<HeavyJobView[]> {
  if (!ids.length) return [];
  const rows = await prisma.jobRun.findMany({ where: { id: { in: ids } } });
  return rows.map((r) => parseHeavyJobRun(r)).filter((v): v is HeavyJobView => v !== null);
}

// ---------------------------------------------------------------------------------------------
// Render workers (Chris's Mac): presence by heartbeat, no schema change — one JobRun row per
// worker session, kind `render-worker:<workerId>`, RUNNING while alive, summary.lastSeen updated.
// ---------------------------------------------------------------------------------------------

export const RENDER_WORKER_KIND_PREFIX = "render-worker:";
/** A worker that hasn't checked in for this long is offline. */
export const RENDER_WORKER_ONLINE_WITHIN_MS = 90_000;

export interface RenderWorkerInfo {
  workerId: string;
  host: string;
  gpu: boolean;
  kinds: string[];
  lastSeen: string;
  busyJobRunId?: string | null;
}

export async function recordRenderWorkerHeartbeat(prisma: PrismaClient, info: Omit<RenderWorkerInfo, "lastSeen">, now = new Date()): Promise<string> {
  const kind = `${RENDER_WORKER_KIND_PREFIX}${info.workerId}`;
  const summary = JSON.stringify({ ...info, lastSeen: now.toISOString() });
  const row = await prisma.jobRun.findFirst({ where: { kind, status: "RUNNING" }, orderBy: { startedAt: "desc" } });
  if (row) {
    await prisma.$executeRaw`UPDATE "JobRun" SET "summary" = COALESCE("summary", '{}'::jsonb) || ${summary}::jsonb WHERE "id" = ${row.id}`;
    return row.id;
  }
  const created = await prisma.jobRun.create({ data: { kind, status: "RUNNING", startedAt: now, summary: JSON.parse(summary) as never } });
  return created.id;
}

export async function markRenderWorkerOffline(prisma: PrismaClient, workerId: string): Promise<void> {
  await prisma.jobRun.updateMany({ where: { kind: `${RENDER_WORKER_KIND_PREFIX}${workerId}`, status: "RUNNING" }, data: { status: "SUCCEEDED", finishedAt: new Date() } });
}

export async function listOnlineRenderWorkers(prisma: PrismaClient, options: { withinMs?: number; now?: Date } = {}): Promise<RenderWorkerInfo[]> {
  const now = options.now ?? new Date();
  const within = options.withinMs ?? RENDER_WORKER_ONLINE_WITHIN_MS;
  const rows = await prisma.jobRun.findMany({ where: { kind: { startsWith: RENDER_WORKER_KIND_PREFIX }, status: "RUNNING" }, orderBy: { startedAt: "desc" }, take: 20 });
  return rows
    .map((r) => r.summary as unknown as RenderWorkerInfo)
    .filter((s) => s && typeof s.lastSeen === "string" && now.getTime() - Date.parse(s.lastSeen) <= within);
}

/** Shallow-merges `patch` into a heavy job's summary (jsonb `||` in one statement — no lost
 * update between the worker's progress writes and the web app's bookkeeping writes). */
export async function patchHeavyJobSummary(prisma: PrismaClient, jobRunId: string, patch: Partial<HeavyJobSummary>): Promise<void> {
  const json = JSON.stringify(patch);
  await prisma.$executeRaw`UPDATE "JobRun" SET "summary" = COALESCE("summary", '{}'::jsonb) || ${json}::jsonb WHERE "id" = ${jobRunId}`;
}

/** Progress write from the worker. Clamped to 0..99 until the job actually finishes. Only
 * touches a RUNNING row (a late write never resurrects a finished or taken-over job). */
export async function updateHeavyJobProgress(prisma: PrismaClient, jobRunId: string, progress: HeavyJobProgress): Promise<void> {
  const p: HeavyJobProgress = {
    ...progress,
    pct: Math.max(0, Math.min(99, Math.round(progress.pct))),
    updatedAt: new Date().toISOString(),
  };
  const json = JSON.stringify({ progress: p });
  await prisma.$executeRaw`UPDATE "JobRun" SET "summary" = COALESCE("summary", '{}'::jsonb) || ${json}::jsonb WHERE "id" = ${jobRunId} AND "status" = 'RUNNING'`;
}

/** Terminal write. Idempotent, first writer wins: a row already SUCCEEDED/FAILED is left alone
 * (returns false) — e.g. the web app already marked a vanished sandbox's job FAILED. */
export async function finishHeavyJob(
  prisma: PrismaClient,
  jobRunId: string,
  outcome: { status: "SUCCEEDED" | "FAILED"; result?: unknown; error?: string | null; message?: string },
): Promise<boolean> {
  const progress: HeavyJobProgress = {
    pct: outcome.status === "SUCCEEDED" ? 100 : 0,
    message: outcome.message ?? (outcome.status === "SUCCEEDED" ? "Done." : "Something went wrong."),
    stage: outcome.status === "SUCCEEDED" ? "done" : "failed",
    updatedAt: new Date().toISOString(),
  };
  const json = JSON.stringify({ progress, ...(outcome.result !== undefined ? { result: outcome.result } : {}) });
  const n = await prisma.$executeRaw`UPDATE "JobRun" SET "summary" = COALESCE("summary", '{}'::jsonb) || ${json}::jsonb, "status" = ${outcome.status}, "finishedAt" = NOW(), "error" = ${outcome.error ?? null} WHERE "id" = ${jobRunId} AND "status" IN ('RUNNING', 'QUEUED')`;
  return n > 0;
}

export async function getHeavyJob(prisma: PrismaClient, jobRunId: string): Promise<HeavyJobView | null> {
  const row = await prisma.jobRun.findUnique({ where: { id: jobRunId } });
  return row ? parseHeavyJobRun(row) : null;
}

/** The RUNNING (non-stale) or QUEUED heavy job for a content item, if any. */
export async function getActiveHeavyJob(
  prisma: PrismaClient,
  contentItemId: string,
  options: { staleAfterMs?: number; now?: Date } = {},
): Promise<HeavyJobView | null> {
  const now = options.now ?? new Date();
  const row = await prisma.jobRun.findFirst({
    where: {
      kind: heavyJobRunKind(contentItemId),
      OR: [
        { status: "RUNNING", startedAt: { gte: new Date(now.getTime() - (options.staleAfterMs ?? HEAVY_JOB_STALE_AFTER_MS)) } },
        { status: "QUEUED", startedAt: { gte: new Date(now.getTime() - HEAVY_JOB_QUEUE_EXPIRES_MS) } },
      ],
    },
    orderBy: { startedAt: "desc" },
  });
  return row ? parseHeavyJobRun(row) : null;
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
