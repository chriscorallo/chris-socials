import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma, createContentItem, createMediaAsset, acquireHeavyJobLease, getHeavyJob } from "@chris/domain";
import { MockTranscriptionProvider } from "@chris/agents";
import { FFMPEG_PATH, LocalFsStorageAdapter, type PersonMatteResult, type SubjectTrackAnalysis } from "@chris/media";
import { executeHeavyJob, runHeavyJobRecorded, createProgressWriter } from "../heavy-jobs";
import { parseHeavyJobArgs, heavyJobNeedsModel } from "../heavy-job-kinds";
import { parseCli, loadEnvFile } from "../job-runner";

const run = promisify(execFile);

/**
 * The heavy-job layer that runs both in-process (local) and inside the Vercel Sandbox
 * (job-runner.ts): args validation, the ingest sequence (transcribe → track → matte), JobRun
 * progress/result recording, and — end to end — the runner CLI as a child process against the
 * throwaway database + local storage (the same code path the sandbox runs, with the real ONNX
 * face tracker).
 */
describe("heavy jobs", () => {
  let storageDir: string;
  let storage: LocalFsStorageAdapter;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "chris-heavy-storage-"));
    storage = new LocalFsStorageAdapter({ baseDir: storageDir });
  });
  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  async function makeItemWithTakes(n: number, bytes: Buffer = Buffer.from("not really a video")) {
    const item = await createContentItem(prisma, { title: "Heavy job test" }, { actorId: "t" });
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const storageKey = `raw/${item.id}/take-${i}.mp4`;
      await storage.put(storageKey, bytes);
      const a = await createMediaAsset(
        prisma,
        { contentItemId: item.id, kind: "RAW_TAKE", storageKey, originalFilename: `take-${i}.mp4`, mimeType: "video/mp4", sizeBytes: bytes.byteLength },
        { actorId: "chris" },
      );
      await prisma.mediaAsset.update({ where: { id: a.id }, data: { width: 1080, height: 1920, hasAudio: true, durationSeconds: 1 } });
      ids.push(a.id);
    }
    return { item, ids };
  }

  const provider = Object.assign(new MockTranscriptionProvider(() => ({ text: "Hi there.", words: [{ word: "Hi", start: 0, end: 0.2 }, { word: "there.", start: 0.2, end: 0.5 }] })), { model: "mock-whisper" });
  const analyze = async (): Promise<SubjectTrackAnalysis> => ({
    track: [{ t: 0, box: { x: 0.4, y: 0.2, w: 0.2, h: 0.15 } }],
    source: { width: 1080, height: 1920 },
    framesAnalyzed: 1,
    framesWithFace: 1,
    fps: 3,
    model: "fake-face",
  });
  const computeMatte = async (_src: string, out: string): Promise<PersonMatteResult> => {
    await writeFile(out, Buffer.from("matte"));
    return { outPath: out, width: 288, height: 512, fps: 30, frames: 30, coverage: 0.4, ms: 5, model: "fake-modnet" } as PersonMatteResult;
  };

  it("validates args across the process boundary", () => {
    expect(parseHeavyJobArgs("render", { contentItemId: "a", thenQualityGate: true, extra: 1 })).toEqual({ contentItemId: "a", thenQualityGate: true });
    expect(parseHeavyJobArgs("ingest", { contentItemId: "a", transcribe: true })).toEqual({ contentItemId: "a", transcribe: true, track: false, matte: false });
    expect(() => parseHeavyJobArgs("render", { contentItemId: "" })).toThrow(/contentItemId/);
    expect(() => parseHeavyJobArgs("subject-track", { contentItemId: "a", mediaAssetIds: [1] })).toThrow(/mediaAssetIds/);
    expect(() => parseHeavyJobArgs("transcribe", null)).toThrow();
    expect(heavyJobNeedsModel("render", { contentItemId: "a" })).toBe(false);
    expect(heavyJobNeedsModel("render", { contentItemId: "a", thenQualityGate: true })).toBe(true);
    expect(heavyJobNeedsModel("motion-design", { contentItemId: "a" })).toBe(true);
    expect(heavyJobNeedsModel("ingest", { contentItemId: "a" })).toBe(false);
  });

  it("ingest: transcribes, tracks and mattes every take still missing them, reporting progress", async () => {
    const { item, ids } = await makeItemWithTakes(2);
    const updates: string[] = [];
    const outcome = await executeHeavyJob("ingest", { contentItemId: item.id, transcribe: true, track: true, matte: true }, {
      db: prisma,
      storage,
      actor: { actorId: "chris" },
      transcriptionProvider: provider,
      analyze,
      computeMatte,
      progress: (p) => updates.push(`${p.stage}:${Math.round(p.pct)}`),
    });
    expect(outcome.ok).toBe(true);
    const rows = await prisma.mediaAsset.findMany({ where: { id: { in: ids } } });
    for (const r of rows) {
      expect(r.transcript).toBe("Hi there.");
      expect(r.subjectTrack).not.toBeNull();
      expect(r.matteStorageKey).toBe(`mattes/${item.id}/${r.id}.mp4`);
    }
    expect(updates.filter((u) => u.startsWith("matte")).length).toBe(2);
    const pcts = updates.map((u) => Number(u.split(":")[1]));
    expect([...pcts].sort((a, b) => a - b)).toEqual(pcts); // monotonic

    // A second run finds nothing to do.
    const again = await executeHeavyJob("ingest", { contentItemId: item.id, transcribe: true, track: true, matte: true }, { db: prisma, storage, actor: { actorId: "chris" }, transcriptionProvider: provider, analyze, computeMatte });
    expect(again.result).toEqual({ transcribe: [], track: [], matte: [] });
  });

  it("records the outcome on the JobRun: SUCCEEDED with a small result, or FAILED with the reason", async () => {
    const { item, ids } = await makeItemWithTakes(1);
    const lease = await acquireHeavyJobLease(prisma, { contentItemId: item.id, jobKind: "transcribe", args: {}, mode: "inline", actorId: "chris" });
    if (!lease.acquired) throw new Error("lease");
    const ok = await runHeavyJobRecorded(lease.jobRunId, "transcribe", { contentItemId: item.id, mediaAssetId: ids[0] }, { db: prisma, storage, actor: { actorId: "chris" }, transcriptionProvider: provider });
    expect(ok.ok).toBe(true);
    const view = await getHeavyJob(prisma, lease.jobRunId);
    expect(view?.status).toBe("SUCCEEDED");
    expect(view?.summary?.progress).toMatchObject({ pct: 100, stage: "done", message: "Transcribed 1 take." });
    expect(view?.summary?.result).toEqual({ transcribe: [{ mediaAssetId: ids[0], status: "SUCCESS", wordCount: 2, errorMessage: null, model: "mock-whisper" }] });

    // A job that throws (no edit plan to render) is FAILED with the error — never left RUNNING.
    const lease2 = await acquireHeavyJobLease(prisma, { contentItemId: item.id, jobKind: "render", args: {}, mode: "inline", actorId: "chris" });
    if (!lease2.acquired) throw new Error("lease2");
    const bad = await runHeavyJobRecorded(lease2.jobRunId, "render", { contentItemId: item.id }, { db: prisma, storage, actor: { actorId: "chris" } });
    expect(bad.ok).toBe(false);
    const failed = await getHeavyJob(prisma, lease2.jobRunId);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.error).toMatch(/No EditPlan/);

    // Model-needing jobs without a provider fail clearly.
    const lease3 = await acquireHeavyJobLease(prisma, { contentItemId: item.id, jobKind: "quality-gate", args: {}, mode: "inline", actorId: "chris" });
    if (!lease3.acquired) throw new Error("lease3");
    const noModel = await runHeavyJobRecorded(lease3.jobRunId, "quality-gate", { contentItemId: item.id }, { db: prisma, storage, actor: { actorId: "chris" } });
    expect(noModel.ok).toBe(false);
  });

  it("throttles progress writes but never drops the last one", async () => {
    const { item } = await makeItemWithTakes(0);
    const lease = await acquireHeavyJobLease(prisma, { contentItemId: item.id, jobKind: "render", args: {}, mode: "inline", actorId: "chris" });
    if (!lease.acquired) throw new Error("lease");
    const w = createProgressWriter(prisma, lease.jobRunId, { minIntervalMs: 200 });
    for (let i = 1; i <= 20; i++) w.update({ pct: i, message: "Rendering your graphics…", stage: "graphics" });
    await new Promise((r) => setTimeout(r, 400));
    await w.flush();
    const view = await getHeavyJob(prisma, lease.jobRunId);
    expect(view?.summary?.progress).toMatchObject({ pct: 20, stage: "graphics" });
  });

  it("job-runner CLI helpers: argv parsing and the self-deleting env file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chris-runner-cli-"));
    try {
      await writeFile(join(dir, "args.json"), JSON.stringify({ contentItemId: "x" }));
      const cli = parseCli(["render", `@${join(dir, "args.json")}`, "--job-run-id", "j1", "--env-file", "/e.json", "--stop-self"]);
      expect(cli).toMatchObject({ kind: "render", args: { contentItemId: "x" }, jobRunId: "j1", envFile: "/e.json", stopSelf: true, offline: null });
      const envPath = join(dir, "env.json");
      await writeFile(envPath, JSON.stringify({ CHRIS_TEST_ENV_A: "1", "bad key": "x", CHRIS_TEST_ENV_B: 5 }));
      expect(loadEnvFile(envPath)).toEqual(["CHRIS_TEST_ENV_A"]);
      expect(process.env.CHRIS_TEST_ENV_A).toBe("1");
      expect(existsSync(envPath)).toBe(false);
    } finally {
      delete process.env.CHRIS_TEST_ENV_A;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(
    "the runner CLI end to end (child process, real DB + local storage, real face tracker): progress + result on the JobRun",
    async () => {
      const work = await mkdtemp(join(tmpdir(), "chris-runner-e2e-"));
      try {
        const video = join(work, "clip.mp4");
        await run(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=15:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
        const { item, ids } = await makeItemWithTakes(1, await readFile(video));
        const lease = await acquireHeavyJobLease(prisma, { contentItemId: item.id, jobKind: "subject-track", args: {}, mode: "sandbox", actorId: "chris" });
        if (!lease.acquired) throw new Error("lease");
        const envFile = join(work, "env.json");
        await writeFile(envFile, JSON.stringify({ DATABASE_URL: process.env.DATABASE_URL, STORAGE_LOCAL_DIR: storageDir }));
        const runner = join(__dirname, "..", "job-runner.ts");
        const { stdout } = await run(process.execPath, ["--import", "tsx", runner, "subject-track", JSON.stringify({ contentItemId: item.id }), "--job-run-id", lease.jobRunId, "--env-file", envFile], {
          cwd: join(__dirname, "..", ".."),
          env: { ...process.env, DATABASE_URL: "", BLOB_READ_WRITE_TOKEN: "" },
          timeout: 120_000,
        });
        expect(stdout).toMatch(/"event":"job_done","ok":true/);
        expect(existsSync(envFile)).toBe(false);
        const view = await getHeavyJob(prisma, lease.jobRunId);
        expect(view?.status).toBe("SUCCEEDED");
        expect(view?.summary?.progress.pct).toBe(100);
        expect((view?.summary?.result as { track: Array<{ status: string }> }).track[0]!.status).toBe("SUCCESS");
        const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: ids[0] } });
        expect(asset.subjectTrack).not.toBeNull();
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
    150_000,
  );
});
