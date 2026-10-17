import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma, createContentItem, getHeavyJob, finishHeavyJob, patchHeavyJobSummary } from "@chris/domain";
import { runHeavyJob, reconcileHeavyJob, setSandboxLauncherForTests, sandboxConfig, workerEnv, type SandboxLauncher } from "./heavy-jobs";
import { plainJobError, progressLine } from "./heavy-job-text";

/**
 * The web app's heavy-job dispatcher in cloud (sandbox) mode, with a fake Sandbox launcher:
 * lease per item, global cap, only the needed secrets go to the worker, launch failures leave
 * nothing half-written, and the poll endpoint's bookkeeping (dead sandbox → FAILED, finished →
 * sandbox stopped).
 */
type Launch = Parameters<SandboxLauncher["launch"]>[0];

function fakeLauncher(opts: { fail?: boolean; status?: string | null } = {}) {
  const launched: Launch[] = [];
  const stopped: string[] = [];
  const l: SandboxLauncher = {
    async launch(input) {
      if (opts.fail) throw new Error("vCPU quota exceeded");
      launched.push(input);
      return { sandboxName: `heavy-${input.jobRunId}` };
    },
    async status() {
      return opts.status === undefined ? "running" : opts.status;
    },
    async stop(name) {
      stopped.push(name);
    },
  };
  return { l, launched, stopped };
}

const saved: Record<string, string | undefined> = {};
const KEYS = ["RENDER_MODE", "RENDER_SANDBOX_SNAPSHOT_ID", "HEAVY_JOB_MAX_SANDBOXES", "ANTHROPIC_API_KEY", "BLOB_READ_WRITE_TOKEN", "AUTH_SECRET", "RENDER_SANDBOX_VCPUS"];

describe("runHeavyJob (sandbox mode, fake launcher)", () => {
  beforeEach(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.RENDER_MODE = "sandbox";
    process.env.RENDER_SANDBOX_SNAPSHOT_ID = "snap_test";
    process.env.HEAVY_JOB_MAX_SANDBOXES = "2";
    process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
    process.env.BLOB_READ_WRITE_TOKEN = "blob-test";
    process.env.AUTH_SECRET = "never-sent";
    await prisma.jobRun.updateMany({ where: { kind: { startsWith: "heavy:" }, status: { in: ["RUNNING", "QUEUED"] } }, data: { status: "FAILED", finishedAt: new Date() } });
  });
  afterEach(() => {
    setSandboxLauncherForTests(null);
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const item = () => createContentItem(prisma, { title: "Cloud job test" }, { actorId: "t" });

  it("starts a sandbox job and returns at once; a second tap on the same video is BUSY (attach)", async () => {
    const f = fakeLauncher();
    setSandboxLauncherForTests(f.l);
    const it1 = await item();
    const r = await runHeavyJob("render", { contentItemId: it1.id }, { actorId: "chris" });
    expect(r.status).toBe("started");
    if (r.status !== "started") return;
    expect(f.launched[0]).toMatchObject({ kind: "render", snapshotId: "snap_test", args: { contentItemId: it1.id, thenQualityGate: false } });
    expect(f.launched[0]!.env.BLOB_READ_WRITE_TOKEN).toBe("blob-test");
    // A plain render needs no model: the API key does not leave the app. Nothing else either.
    expect(f.launched[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(f.launched[0]!.env.AUTH_SECRET).toBeUndefined();
    const view = await getHeavyJob(prisma, r.jobRunId);
    expect(view?.summary).toMatchObject({ mode: "sandbox", jobKind: "render", sandboxName: `heavy-${r.jobRunId}` });

    const again = await runHeavyJob("transcribe", { contentItemId: it1.id }, { actorId: "chris" });
    expect(again).toMatchObject({ status: "busy", jobRunId: r.jobRunId, jobKind: "render" });
    expect(f.launched).toHaveLength(1);
  });

  it("passes the API key only to jobs that call the model", () => {
    expect(workerEnv("render", { contentItemId: "x", thenQualityGate: true }).ANTHROPIC_API_KEY).toBe("sk-test-not-real");
    expect(workerEnv("ingest", { contentItemId: "x" }).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("caps concurrent sandboxes: beyond the cap jobs QUEUE (batch upload) and start when a slot frees", async () => {
    const f = fakeLauncher();
    setSandboxLauncherForTests(f.l);
    const a = await runHeavyJob("ingest", { contentItemId: (await item()).id, transcribe: true, track: true, matte: true }, { actorId: "c" });
    const b = await runHeavyJob("ingest", { contentItemId: (await item()).id, transcribe: true, track: true, matte: true }, { actorId: "c" });
    const third = await runHeavyJob("ingest", { contentItemId: (await item()).id, transcribe: true, track: true, matte: true }, { actorId: "c" });
    expect([a.status, b.status, third.status]).toEqual(["started", "started", "started"]);
    expect(f.launched).toHaveLength(2);
    if (third.status !== "started") return;
    const queued = await getHeavyJob(prisma, third.jobRunId);
    expect(queued?.status).toBe("QUEUED");
    expect(queued?.summary?.progress.message).toMatch(/Waiting for a free cloud worker/);

    // A slot frees: polling the queued job starts it in a new sandbox.
    if (a.status === "started") await finishHeavyJob(prisma, a.jobRunId, { status: "SUCCEEDED" });
    const polled = await reconcileHeavyJob(queued!);
    expect(polled.status).toBe("RUNNING");
    expect(f.launched).toHaveLength(3);
    expect(f.launched[2]!.jobRunId).toBe(third.jobRunId);
  });

  it("a launch failure marks the job FAILED with the reason (nothing left RUNNING) and frees the item", async () => {
    const it1 = await item();
    setSandboxLauncherForTests(fakeLauncher({ fail: true }).l);
    const r = await runHeavyJob("transcribe", { contentItemId: it1.id }, { actorId: "c" });
    expect(r.status).toBe("refused");
    if (r.status !== "refused" || !r.jobRunId) throw new Error("expected a recorded refusal");
    const view = await getHeavyJob(prisma, r.jobRunId);
    expect(view?.status).toBe("FAILED");
    expect(view?.error).toMatch(/vCPU quota exceeded/);
    setSandboxLauncherForTests(fakeLauncher().l);
    expect((await runHeavyJob("transcribe", { contentItemId: it1.id }, { actorId: "c" })).status).toBe("started");
  });

  it("refuses clearly when the cloud worker isn't configured", async () => {
    delete process.env.RENDER_SANDBOX_SNAPSHOT_ID;
    const r = await runHeavyJob("render", { contentItemId: (await item()).id }, { actorId: "c" });
    expect(r).toMatchObject({ status: "refused", jobRunId: null });
  });

  it("poll bookkeeping: a silent job whose sandbox is gone → FAILED; a finished job's sandbox is stopped once", async () => {
    const f = fakeLauncher({ status: null });
    setSandboxLauncherForTests(f.l);
    const r = await runHeavyJob("render", { contentItemId: (await item()).id }, { actorId: "c" });
    if (r.status !== "started") throw new Error("expected start");
    const view = (await getHeavyJob(prisma, r.jobRunId))!;
    // Fresh progress → not checked yet.
    expect((await reconcileHeavyJob(view)).status).toBe("RUNNING");
    // Two minutes of silence and no sandbox → FAILED.
    const later = await reconcileHeavyJob(view, new Date(Date.now() + 2 * 60_000));
    expect(later.status).toBe("FAILED");
    expect(later.error).toMatch(/stopped before finishing/);

    const g = fakeLauncher({ status: "running" });
    setSandboxLauncherForTests(g.l);
    const r2 = await runHeavyJob("render", { contentItemId: (await item()).id }, { actorId: "c" });
    if (r2.status !== "started") throw new Error("expected start");
    await finishHeavyJob(prisma, r2.jobRunId, { status: "SUCCEEDED", result: { ok: 1 } });
    await reconcileHeavyJob((await getHeavyJob(prisma, r2.jobRunId))!);
    await reconcileHeavyJob((await getHeavyJob(prisma, r2.jobRunId))!);
    expect(g.stopped).toEqual([`heavy-${r2.jobRunId}`]);
    await patchHeavyJobSummary(prisma, r2.jobRunId, {});
  });

  it("vCPUs are 1 or even, as Vercel Sandbox requires", () => {
    process.env.RENDER_SANDBOX_VCPUS = "5";
    expect(sandboxConfig().vcpus).toBe(4);
    process.env.RENDER_SANDBOX_VCPUS = "1";
    expect(sandboxConfig().vcpus).toBe(1);
  });
});

describe("heavy job wording", () => {
  it("speaks plain English", () => {
    expect(progressLine("render", "Rendering your graphics…", 40.4)).toBe("Rendering your graphics… 40%");
    expect(progressLine("transcribe", null, 0)).toBe("Transcribing your takes…");
    expect(plainJobError("x", "SpendCapExceededError")).toMatch(/spending limit/);
    expect(plainJobError("The cloud worker was stopped (SIGTERM) — most likely it ran out of time.")).toMatch(/ran out of time/);
    expect(plainJobError("")).toMatch(/try again/);
  });
});
