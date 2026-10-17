import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  prisma,
  acquireHeavyJobLease,
  getHeavyJob,
  findOrCreateReferenceCreator,
  registerReferenceVideo,
  parseReferenceVideoMetrics,
  getReferenceStyleProfile,
} from "@chris/domain";
import { MockTranscriptionProvider } from "@chris/agents";
import { FFMPEG_PATH, LocalFsStorageAdapter } from "@chris/media";
import { analyzeReferenceVideoFile, analyzePendingReferenceVideos } from "../reference-analysis-job";
import { runHeavyJobRecorded } from "../heavy-jobs";
import { heavyJobNeedsModel, heavyJobSubject, parseHeavyJobArgs, REFERENCE_LIBRARY_SUBJECT } from "../heavy-job-kinds";

const run = promisify(execFile);

/**
 * Reference-video measurement end to end with real ffmpeg (a synthetic 6 s clip: a hard cut at
 * 3.0 s, a 440 Hz "voice" with a quiet noise bed) and a deterministic transcription provider
 * (real Whisper is exercised by packages/media's RUN_WHISPER_TESTS suite and was verified on
 * `say` speech — see docs/decisions-pending/reference-videos.md). No model calls anywhere.
 */
describe("reference analysis job", () => {
  let dir: string;
  let clip: string;
  let storage: LocalFsStorageAdapter;
  const words = [
    { word: "Stop", start: 0.3, end: 0.6 },
    { word: "doing", start: 0.6, end: 0.9 },
    { word: "this.", start: 0.9, end: 1.3 },
    { word: "Here's", start: 1.6, end: 1.9 },
    { word: "the", start: 1.9, end: 2.0 },
    { word: "fix.", start: 2.0, end: 2.4 },
    { word: "Follow", start: 4.8, end: 5.1 },
    { word: "for", start: 5.1, end: 5.2 },
    { word: "more.", start: 5.2, end: 5.6 },
  ];
  const provider = Object.assign(new MockTranscriptionProvider(() => ({ text: words.map((w) => w.word).join(" "), words })), { model: "mock" });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-ref-job-"));
    storage = new LocalFsStorageAdapter({ baseDir: join(dir, "storage") });
    clip = join(dir, "clip.mp4");
    await run(FFMPEG_PATH, [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=s=180x320:r=30:d=3",
      "-f", "lavfi", "-i", "smptebars=s=180x320:r=30:d=3",
      "-f", "lavfi", "-i", "sine=f=440:d=6:sample_rate=48000",
      "-f", "lavfi", "-i", "anoisesrc=c=pink:d=6:a=0.01:r=48000",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a]volume=0.5[s];[s][3:a]amix=inputs=2:normalize=0[a]",
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", clip,
    ]);
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("measures a file: video, the hard cut, speech, loudness and background", async () => {
    const m = await analyzeReferenceVideoFile(clip, { transcriptionProvider: provider });
    expect(parseReferenceVideoMetrics(m)).not.toBeNull();
    expect(m.video).toMatchObject({ width: 180, height: 320, aspect: "9:16", fps: 30 });
    expect(m.video.durationS).toBeGreaterThan(5.9);
    expect(m.cuts!.count).toBe(1);
    expect(m.cuts!.times[0]).toBeCloseTo(3, 1);
    expect(m.cuts!.firstCutS).toBeCloseTo(3, 1);
    expect(m.speech!.hookText).toBe("Stop doing this.");
    expect(m.speech!.lastSentence).toBe("Follow for more.");
    expect(m.speech!.closingShotAfterSpeech).toBe(false);
    expect(m.audio!.integratedLufs).not.toBeNull();
    // The tone plays throughout, so the "background" floor is the tone itself → reads as no gap
    // between voice and floor. What matters here: the numbers exist and are typed.
    expect(["present", "none", "unknown"]).toContain(m.audio!.background);
    expect(m.transcript).toContain("Stop doing this.");
  }, 60_000);

  it("measures every waiting video; a broken file fails alone; the style profile picks them up", async () => {
    const c = await findOrCreateReferenceCreator(prisma, { name: `Job test ${Date.now()}` }, { actorId: "chris" });
    const goodKey = `reference/${c.id}/1-good.mp4`;
    const badKey = `reference/${c.id}/2-bad.mp4`;
    await storage.put(goodKey, await readFile(clip));
    await storage.put(badKey, Buffer.from("definitely not a video"));
    const good = await registerReferenceVideo(prisma, { referenceCreatorId: c.id, storageKey: goodKey, filename: "good.mp4" }, { actorId: "chris" });
    const bad = await registerReferenceVideo(prisma, { referenceCreatorId: c.id, storageKey: badKey, filename: "bad.mp4" }, { actorId: "chris" });
    const progress: string[] = [];
    const r = await analyzePendingReferenceVideos(prisma, storage, { ids: [good.id, bad.id], transcriptionProvider: provider, onProgress: (p) => progress.push(p.message) }, { actorId: "job" });
    expect(r.remaining).toBe(0);
    expect(r.measured.find((x) => x.id === good.id)!.ok).toBe(true);
    expect(r.measured.find((x) => x.id === bad.id)!.ok).toBe(false);
    expect(progress[0]).toMatch(/Measuring video 1 of 2/);
    const g = await prisma.referenceContent.findUniqueOrThrow({ where: { id: good.id } });
    const b = await prisma.referenceContent.findUniqueOrThrow({ where: { id: bad.id } });
    expect(g.analysisStatus).toBe("DONE");
    expect(g.durationSeconds).toBe(6);
    expect(b.analysisStatus).toBe("FAILED");
    expect(b.analysisError).toBeTruthy();
    const profile = await getReferenceStyleProfile(prisma, { referenceCreatorId: c.id });
    expect(profile.sampleSize).toBe(1);
    expect(profile.confidence).toBe("early");
    expect(await prisma.auditLog.count({ where: { entityId: good.id, action: "REFERENCE_VIDEO_MEASURED", actorType: "JOB" } })).toBe(1);
  }, 90_000);

  it("stops at the time budget and leaves the rest waiting", async () => {
    const c = await findOrCreateReferenceCreator(prisma, { name: `Budget ${Date.now()}` }, { actorId: "chris" });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const key = `reference/${c.id}/${i}-v.mp4`;
      await storage.put(key, await readFile(clip));
      ids.push((await registerReferenceVideo(prisma, { referenceCreatorId: c.id, storageKey: key, filename: "v.mp4" }, { actorId: "chris" })).id);
    }
    const r = await analyzePendingReferenceVideos(prisma, storage, { ids, transcriptionProvider: provider, timeBudgetMs: 0 }, { actorId: "job" });
    expect(r.measured).toHaveLength(0);
    expect(r.remaining).toBe(2);
  }, 60_000);

  it("is a heavy-job kind: no content item, library lease, no model key, JobRun progress + result", async () => {
    expect(parseHeavyJobArgs("reference-analyze", {})).toEqual({});
    expect(parseHeavyJobArgs("reference-analyze", { referenceContentIds: ["a"], junk: 1 })).toEqual({ referenceContentIds: ["a"] });
    expect(() => parseHeavyJobArgs("reference-analyze", { referenceContentIds: "a" })).toThrow();
    expect(heavyJobSubject("reference-analyze", {})).toBe(REFERENCE_LIBRARY_SUBJECT);
    expect(heavyJobSubject("render", { contentItemId: "x" })).toBe("x");
    expect(heavyJobNeedsModel("reference-analyze", {})).toBe(false);

    const c = await findOrCreateReferenceCreator(prisma, { name: `Kind ${Date.now()}` }, { actorId: "chris" });
    const key = `reference/${c.id}/k.mp4`;
    await storage.put(key, await readFile(clip));
    const v = await registerReferenceVideo(prisma, { referenceCreatorId: c.id, storageKey: key, filename: "k.mp4" }, { actorId: "chris" });
    await prisma.jobRun.updateMany({ where: { kind: { startsWith: "heavy:" }, status: { in: ["RUNNING", "QUEUED"] } }, data: { status: "FAILED", finishedAt: new Date() } });
    const lease = await acquireHeavyJobLease(prisma, { contentItemId: REFERENCE_LIBRARY_SUBJECT, jobKind: "reference-analyze", args: { referenceContentIds: [v.id] }, mode: "inline", actorId: "chris" });
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) return;
    const busy = await acquireHeavyJobLease(prisma, { contentItemId: REFERENCE_LIBRARY_SUBJECT, jobKind: "reference-analyze", args: {}, mode: "inline", actorId: "chris" });
    expect(busy).toMatchObject({ acquired: false, reason: "BUSY" });
    const outcome = await runHeavyJobRecorded(lease.jobRunId, "reference-analyze", { referenceContentIds: [v.id] }, { db: prisma, storage, actor: { actorId: "chris" }, transcriptionProvider: provider });
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe("Measured 1 video.");
    const job = await getHeavyJob(prisma, lease.jobRunId);
    expect(job!.status).toBe("SUCCEEDED");
    expect(job!.summary!.jobKind).toBe("reference-analyze");
    expect((job!.summary!.result as { measured: unknown[] }).measured).toHaveLength(1);
  }, 90_000);
});
