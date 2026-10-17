import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma, isReferenceVideoKey, recordReferenceAnalysis, countOutdatedReferenceVideos } from "@chris/domain";
import { REFERENCE_VIDEO_KEY_PATTERN } from "@chris/domain/style-metrics";
import { setSandboxLauncherForTests, type SandboxLauncher } from "./heavy-jobs";
import { prepareReferenceCreator, referenceStorageKey, registerReferenceUpload, startReferenceMeasuring } from "./reference-upload";

/**
 * The web side of reference-video upload: creator assignment, storage keys that can't collide
 * with takes, registration, and starting the measuring job through the heavy-job dispatcher
 * (cloud mode with a fake Sandbox launcher: one job for the whole library, no AI key sent).
 */
type Launch = Parameters<SandboxLauncher["launch"]>[0];
const saved: Record<string, string | undefined> = {};
const KEYS = ["RENDER_MODE", "RENDER_SANDBOX_SNAPSHOT_ID", "HEAVY_JOB_MAX_SANDBOXES", "ANTHROPIC_API_KEY"];

describe("reference upload + measuring (web)", () => {
  const launched: Launch[] = [];
  beforeEach(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.RENDER_MODE = "sandbox";
    process.env.RENDER_SANDBOX_SNAPSHOT_ID = "snap_test";
    process.env.HEAVY_JOB_MAX_SANDBOXES = "4";
    process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
    launched.length = 0;
    setSandboxLauncherForTests({
      async launch(input) {
        launched.push(input);
        return { sandboxName: `heavy-${input.jobRunId}` };
      },
      async status() {
        return "running";
      },
      async stop() {},
    });
    await prisma.jobRun.updateMany({ where: { kind: { startsWith: "heavy:" }, status: { in: ["RUNNING", "QUEUED"] } }, data: { status: "FAILED", finishedAt: new Date() } });
    await prisma.referenceContent.updateMany({ where: { analysisStatus: "PENDING" }, data: { analysisStatus: "FAILED" } });
  });
  afterEach(() => {
    setSandboxLauncherForTests(null);
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("keys live under reference/<creator>/ with a safe filename", () => {
    const key = referenceStorageKey("ck123", "My Video (1).MOV", 42);
    expect(key).toBe("reference/ck123/42-My_Video_1_.MOV");
    expect(REFERENCE_VIDEO_KEY_PATTERN.test(key)).toBe(true);
    expect(isReferenceVideoKey(key, "ck123")).toBe(true);
    expect(isReferenceVideoKey(key, "other")).toBe(false);
    expect(REFERENCE_VIDEO_KEY_PATTERN.test("raw/ck123/x.mp4")).toBe(false);
  });

  it("assign → register → one cloud job measures the whole library; a second tap follows it", async () => {
    expect(await startReferenceMeasuring("chris")).toEqual({ jobRunId: null, message: "Nothing waiting to be measured." });
    const c = await prepareReferenceCreator({ name: `Web ${Date.now()}` }, "chris");
    for (const name of ["a.mp4", "b.mp4"]) {
      await registerReferenceUpload({ referenceCreatorId: c.id, storageKey: referenceStorageKey(c.id, name), filename: name, mimeType: "video/mp4", sizeBytes: 10, sourceUrl: "https://www.tiktok.com/@x/video/1", actorId: "chris" });
    }
    const first = await startReferenceMeasuring("chris");
    expect(first.jobRunId).toBeTruthy();
    expect(first.message).toBe("Measuring 2 videos…");
    expect(launched).toHaveLength(1);
    expect(launched[0]!.kind).toBe("reference-analyze");
    expect(launched[0]!.contentItemId).toBe("reference-library");
    expect(launched[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
    const again = await startReferenceMeasuring("chris");
    expect(again.jobRunId).toBe(first.jobRunId);
    expect(launched).toHaveLength(1);
  });

  it("“Update measurements”: videos measured with an older version go back in the queue and one job re-measures them", async () => {
    const c = await prepareReferenceCreator({ name: `Outdated web ${Date.now()}` }, "chris");
    const row = await registerReferenceUpload({ referenceCreatorId: c.id, storageKey: referenceStorageKey(c.id, "old.mp4"), filename: "old.mp4", mimeType: "video/mp4", sizeBytes: 10, actorId: "chris" });
    const v1 = { version: 1, video: { durationS: 11, width: 1080, height: 1920, aspect: "9:16", fps: 30 }, cuts: null, speech: null, audio: null, transcript: null, notes: [] };
    await recordReferenceAnalysis(prisma, row.id, { metrics: v1 as never }, { actorId: "job" });
    expect(await countOutdatedReferenceVideos(prisma, { referenceCreatorId: c.id })).toBe(1);
    // A plain "Measure now" doesn't touch measured videos…
    expect((await startReferenceMeasuring("chris")).jobRunId).toBeNull();
    // …"Update measurements" re-queues them and starts one job.
    const r = await startReferenceMeasuring("chris", { updateOutdated: true });
    expect(r.jobRunId).toBeTruthy();
    expect(r.message).toMatch(/^Measuring \d+ videos?…$/);
    expect(launched.map((l) => l.kind)).toEqual(["reference-analyze"]);
    const after = await prisma.referenceContent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.analysisStatus).toBe("PENDING");
    expect(after.metrics).not.toBeNull(); // old numbers stay readable until the new ones land
  });
});
