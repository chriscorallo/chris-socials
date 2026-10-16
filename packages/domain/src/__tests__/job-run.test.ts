import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import {
  acquirePublishLease,
  releasePublishLease,
  runRecordedJob,
  listRecentJobRuns,
} from "../job-run";

describe("publish lease (advisory-locked claim + JobRun lease row)", () => {
  it("pg_advisory_xact_lock works on this database and serializes claims: a second claim is refused until release", async () => {
    const itemId = `lease-test-${Date.now()}`;
    const first = await acquirePublishLease(prisma, itemId, "YOUTUBE");
    expect(first.acquired).toBe(true);
    const second = await acquirePublishLease(prisma, itemId, "YOUTUBE");
    expect(second.acquired).toBe(false);
    // Different platform for the same item is independent.
    expect((await acquirePublishLease(prisma, itemId, "TIKTOK")).acquired).toBe(true);

    if (first.acquired) await releasePublishLease(prisma, first.leaseId, { status: "SUCCEEDED" });
    expect((await acquirePublishLease(prisma, itemId, "YOUTUBE")).acquired).toBe(true);
  });

  it("a stale lease can be taken over", async () => {
    const itemId = `lease-stale-${Date.now()}`;
    const first = await acquirePublishLease(prisma, itemId, "INSTAGRAM");
    expect(first.acquired).toBe(true);
    const later = await acquirePublishLease(prisma, itemId, "INSTAGRAM", { now: new Date(Date.now() + 21 * 60 * 1000) });
    expect(later.acquired).toBe(true);
  });
});

describe("runRecordedJob", () => {
  it("records SUCCEEDED with the summary, or FAILED with the error, never throwing", async () => {
    const ok = await runRecordedJob(prisma, "test-job", async () => ({ n: 1 }));
    expect(ok.status).toBe("SUCCEEDED");
    const failed = await runRecordedJob(prisma, "test-job", async () => {
      throw new Error("boom");
    });
    expect(failed.status).toBe("FAILED");
    const rows = await listRecentJobRuns(prisma, { kind: "test-job", limit: 2 });
    expect(rows.map((r) => r.status).sort()).toEqual(["FAILED", "SUCCEEDED"]);
    expect(rows.find((r) => r.status === "FAILED")?.error).toBe("boom");
    expect(rows.find((r) => r.status === "SUCCEEDED")?.summary).toEqual({ n: 1 });
  });
});
