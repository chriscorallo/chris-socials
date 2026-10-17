import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import {
  acquireHeavyJobLease,
  updateHeavyJobProgress,
  finishHeavyJob,
  getHeavyJob,
  getActiveHeavyJob,
  patchHeavyJobSummary,
  heavyJobRunKind,
} from "../job-run";

const base = { jobKind: "render", args: { x: 1 }, actorId: "test-actor" };

describe("heavy job lease (one heavy job per content item, global sandbox cap)", () => {
  it("records a RUNNING row with the job's kind/args/progress; a second claim for the same item is BUSY", async () => {
    const contentItemId = `heavy-${Date.now()}-a`;
    const first = await acquireHeavyJobLease(prisma, { ...base, contentItemId, mode: "inline" });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;
    const view = await getHeavyJob(prisma, first.jobRunId);
    expect(view?.status).toBe("RUNNING");
    expect(view?.summary).toMatchObject({ jobKind: "render", contentItemId, mode: "inline", args: { x: 1 }, progress: { pct: 0 } });

    const second = await acquireHeavyJobLease(prisma, { ...base, jobKind: "transcribe", contentItemId, mode: "inline" });
    expect(second).toMatchObject({ acquired: false, reason: "BUSY", activeJobRunId: first.jobRunId, activeJobKind: "render" });
    expect((await getActiveHeavyJob(prisma, contentItemId))?.id).toBe(first.jobRunId);

    // Another item is independent.
    const other = await acquireHeavyJobLease(prisma, { ...base, contentItemId: `${contentItemId}-other`, mode: "inline" });
    expect(other.acquired).toBe(true);

    expect(await finishHeavyJob(prisma, first.jobRunId, { status: "SUCCEEDED", result: { ok: 1 } })).toBe(true);
    expect(await getActiveHeavyJob(prisma, contentItemId)).toBeNull();
    expect((await acquireHeavyJobLease(prisma, { ...base, contentItemId, mode: "inline" })).acquired).toBe(true);
  });

  it("progress merges into the summary without clobbering other keys; terminal writes are first-writer-wins", async () => {
    const contentItemId = `heavy-${Date.now()}-b`;
    const lease = await acquireHeavyJobLease(prisma, { ...base, contentItemId, mode: "sandbox" });
    if (!lease.acquired) throw new Error("expected lease");
    await patchHeavyJobSummary(prisma, lease.jobRunId, { sandboxName: "heavy-abc" });
    await updateHeavyJobProgress(prisma, lease.jobRunId, { pct: 140, message: "Rendering your video…", stage: "render" });
    let view = await getHeavyJob(prisma, lease.jobRunId);
    expect(view?.summary?.sandboxName).toBe("heavy-abc");
    expect(view?.summary?.progress).toMatchObject({ pct: 99, message: "Rendering your video…", stage: "render" });
    expect(view?.summary?.args).toEqual({ x: 1 });

    expect(await finishHeavyJob(prisma, lease.jobRunId, { status: "FAILED", error: "sandbox vanished" })).toBe(true);
    // The worker's late success can't overwrite the failure, nor can a late progress write.
    expect(await finishHeavyJob(prisma, lease.jobRunId, { status: "SUCCEEDED", result: { late: true } })).toBe(false);
    await updateHeavyJobProgress(prisma, lease.jobRunId, { pct: 50, message: "late" });
    view = await getHeavyJob(prisma, lease.jobRunId);
    expect(view?.status).toBe("FAILED");
    expect(view?.error).toBe("sandbox vanished");
    expect(view?.summary?.result).toBeUndefined();
    expect(view?.summary?.progress.stage).toBe("failed");
  });

  it("caps concurrent sandbox jobs across items (inline jobs don't count) and takes over stale rows", async () => {
    // Clear any RUNNING heavy rows from earlier tests so the count is deterministic.
    await prisma.jobRun.updateMany({ where: { kind: { startsWith: "heavy:" }, status: "RUNNING" }, data: { status: "FAILED", finishedAt: new Date() } });
    const t = Date.now();
    const a = await acquireHeavyJobLease(prisma, { ...base, contentItemId: `cap-${t}-1`, mode: "sandbox", maxConcurrentSandboxes: 2 });
    const b = await acquireHeavyJobLease(prisma, { ...base, contentItemId: `cap-${t}-2`, mode: "sandbox", maxConcurrentSandboxes: 2 });
    const inline = await acquireHeavyJobLease(prisma, { ...base, contentItemId: `cap-${t}-3`, mode: "inline", maxConcurrentSandboxes: 2 });
    expect(a.acquired && b.acquired && inline.acquired).toBe(true);
    const c = await acquireHeavyJobLease(prisma, { ...base, contentItemId: `cap-${t}-4`, mode: "sandbox", maxConcurrentSandboxes: 2 });
    expect(c).toMatchObject({ acquired: false, reason: "CAPACITY", running: 2, limit: 2 });

    // An hour later the two sandbox rows are stale: taken over (FAILED) and the claim succeeds.
    const later = await acquireHeavyJobLease(prisma, {
      ...base,
      contentItemId: `cap-${t}-4`,
      mode: "sandbox",
      maxConcurrentSandboxes: 2,
      now: new Date(Date.now() + 61 * 60 * 1000),
    });
    expect(later.acquired).toBe(true);
    if (a.acquired) expect((await getHeavyJob(prisma, a.jobRunId))?.status).toBe("FAILED");
  });

  it("uses a per-item JobRun kind", () => {
    expect(heavyJobRunKind("abc")).toBe("heavy:abc");
  });
});
