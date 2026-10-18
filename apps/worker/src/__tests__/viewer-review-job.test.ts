import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  prisma,
  acquireHeavyJobLease,
  getHeavyJob,
  createContentItemFromFootage,
  createMediaAsset,
  analyzeMediaAsset,
  recordTranscript,
  createStarterEdit,
  saveFinishingEdit,
  getLatestEditPlan,
  findOrCreateReferenceCreator,
  registerReferenceVideo,
} from "@chris/domain";
import {
  CostTrackingModelProvider,
  MockModelProvider,
  MockTranscriptionProvider,
  SpendCapExceededError,
  ViewerReviewSchema,
  type ModelProvider,
} from "@chris/agents";
import { FFMPEG_PATH, LocalFsStorageAdapter, EditTimelineSchema } from "@chris/media";
import { runHeavyJobRecorded, executeHeavyJob } from "../heavy-jobs";
import { heavyJobNeedsModel, heavyJobSubject, parseHeavyJobArgs, referenceVideoSubject } from "../heavy-job-kinds";
import { timelineCuts } from "../viewer-review-job";
import { sampleViewerReview } from "@chris/agents";

const run = promisify(execFile);
const actor = { actorId: "chris" };

/**
 * Viewer Panel job end to end against the throwaway DB and real ffmpeg (a synthetic 20 s
 * "render" with a tone that comes and goes): input building (frames incl. both sides of every
 * cut, edit facts, measured audio), the cost estimate + ceiling, the one model call
 * (MockModelProvider — no real call is ever made), the versioned ViewerReview row, the spend
 * cap failing closed, and the reference-video path.
 */
describe("viewer review job", () => {
  let dir: string;
  let storage: LocalFsStorageAdapter;
  let clip: string;
  const words = Array.from({ length: 30 }, (_, i) => ({ word: i % 7 === 6 ? `word${i}.` : `word${i}`, start: 0.6 + i * 0.68, end: 0.6 + i * 0.68 + 0.5 }));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-viewer-job-"));
    storage = new LocalFsStorageAdapter({ baseDir: join(dir, "storage") });
    clip = join(dir, "render.mp4");
    await run(FFMPEG_PATH, [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=s=180x320:r=30:d=22",
      "-f", "lavfi", "-i", "sine=f=220:d=22:sample_rate=48000",
      "-filter_complex", "[1:a]volume='0.4*(1-between(t,9,10))':eval=frame[a]",
      "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
    ]);
    await storage.put("raw/viewer/take.mp4", await readFile(clip));
    await storage.put("renders/viewer/render.mp4", await readFile(clip));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    delete process.env.VIEWER_REVIEW_MAX_USD;
  });

  /** A video with a 3-clip finishing edit (a removed pause at 3.0 s, a framing-only cut at 13.0 s) and a SUCCESS render. */
  async function renderedItem(title: string) {
    const item = await createContentItemFromFootage(prisma, { title }, actor);
    const asset = await createMediaAsset(prisma, { contentItemId: item.id, kind: "RAW_TAKE", storageKey: "raw/viewer/take.mp4", originalFilename: "take.mp4", mimeType: "video/mp4", sizeBytes: 1 }, actor);
    await analyzeMediaAsset(prisma, asset.id, { durationSeconds: 22, width: 180, height: 320, frameRate: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }, actor);
    await recordTranscript(prisma, { mediaAssetId: asset.id, text: words.map((w) => w.word).join(" "), words, source: "LOCAL_WHISPER" }, actor);
    await createStarterEdit(prisma, item.id, actor);
    const timeline = EditTimelineSchema.parse({
      version: 2,
      clips: [
        { id: "a", mediaAssetId: asset.id, sourceStart: 0.5, sourceEnd: 3.5 },
        { id: "b", mediaAssetId: asset.id, sourceStart: 4.0, sourceEnd: 14.0 },
        { id: "c", mediaAssetId: asset.id, sourceStart: 14.0, sourceEnd: 21.0, crop: { zoom: 1.2, panX: 0, panY: 0 } },
      ],
      captions: { fontId: "inter-display-extrabold", fontSize: 72, color: "#FFFFFF", highlightColor: "#FFD84D" },
      texts: [{ id: "t1", text: "Max out your 401(k)?", start: 0, end: 2.5, fontId: "inter-display-extrabold", fontSize: 80, color: "#FFFFFF" }],
    });
    await saveFinishingEdit(prisma, { contentItemId: item.id, timeline, durationSeconds: 20, actorId: "chris" });
    const plan = (await getLatestEditPlan(prisma, item.id))!;
    const render = await prisma.render.create({
      data: { contentItemId: item.id, editPlanId: plan.id, status: "SUCCESS", storageKey: "renders/viewer/render.mp4", durationSeconds: 22, width: 180, height: 320 },
    });
    return { itemId: item.id, renderId: render.id, editPlanId: plan.id };
  }

  async function lease(subject: string, args: unknown) {
    await prisma.jobRun.updateMany({ where: { kind: { startsWith: "heavy:" }, status: { in: ["RUNNING", "QUEUED"] } }, data: { status: "FAILED", finishedAt: new Date() } });
    const l = await acquireHeavyJobLease(prisma, { contentItemId: subject, jobKind: "viewer-review", args, mode: "inline", actorId: "chris" });
    if (!l.acquired) throw new Error("lease not acquired");
    return l.jobRunId;
  }

  it("is an AI heavy-job kind with exactly one subject", () => {
    expect(parseHeavyJobArgs("viewer-review", { contentItemId: "c", platform: "TIKTOK", junk: 1 })).toEqual({ contentItemId: "c", platform: "TIKTOK" });
    expect(parseHeavyJobArgs("viewer-review", { referenceContentId: "r", persona: "FOLLOWER" })).toEqual({ referenceContentId: "r", persona: "FOLLOWER" });
    expect(() => parseHeavyJobArgs("viewer-review", {})).toThrow(/exactly one/);
    expect(() => parseHeavyJobArgs("viewer-review", { contentItemId: "c", referenceContentId: "r" })).toThrow(/exactly one/);
    expect(() => parseHeavyJobArgs("viewer-review", { contentItemId: "c", platform: "MYSPACE" })).toThrow(/platform/);
    expect(heavyJobSubject("viewer-review", { contentItemId: "c" })).toBe("c");
    expect(heavyJobSubject("viewer-review", { referenceContentId: "r" })).toBe(referenceVideoSubject("r"));
    expect(heavyJobNeedsModel("viewer-review", { referenceContentId: "r" })).toBe(true);
  });

  it("names every cut of an edit by what it does", () => {
    const cuts = timelineCuts({
      clips: [
        { id: "a", mediaAssetId: "x", sourceStart: 0, sourceEnd: 2, crop: { zoom: 1, panX: 0, panY: 0 }, volume: 1 },
        { id: "b", mediaAssetId: "x", sourceStart: 2.6, sourceEnd: 4, crop: { zoom: 1.12, panX: 0, panY: 0 }, volume: 1 },
        { id: "c", mediaAssetId: "x", sourceStart: 4, sourceEnd: 5, crop: { zoom: 1, panX: 0, panY: 0 }, volume: 1 },
        { id: "d", mediaAssetId: "y", sourceStart: 0, sourceEnd: 1, crop: { zoom: 1, panX: 0, panY: 0 }, volume: 1 },
      ],
    });
    expect(cuts).toEqual([
      { t: 2, kind: "PAUSE_REMOVED", removedS: 0.6, zoomFrom: 1, zoomTo: 1.12 },
      { t: 3.4, kind: "FRAMING", zoomFrom: 1.12, zoomTo: 1 },
      { t: 4.4, kind: "TAKE", zoomFrom: 1, zoomTo: 1 },
    ]);
  });

  it("watches the latest render: frames on both sides of every cut, the edit's facts, measured sound → a new ViewerReview row", async () => {
    const { itemId, renderId, editPlanId } = await renderedItem("Viewer check render");
    const mock = new MockModelProvider(() => sampleViewerReview());
    const jobRunId = await lease(itemId, { contentItemId: itemId });
    const progress: string[] = [];
    const outcome = await runHeavyJobRecorded(jobRunId, "viewer-review", { contentItemId: itemId, platform: "TIKTOK" }, {
      db: prisma,
      storage,
      actor,
      modelProvider: () => mock,
      progress: (p) => progress.push(p.message),
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toMatch(/^A new viewer would call it good:/);
    expect(progress.some((m) => /Watching it like a new viewer/.test(m))).toBe(true);

    // One model call, HIGH, with JPEG frames labelled — incl. both sides of the 3.0 s and 13.0 s cuts.
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0]!;
    expect(call.modelClass).toBe("HIGH");
    const labels = call.images!.map((i) => i.label);
    expect(labels).toContain("t=2.90s — just before a cut");
    expect(labels).toContain("t=3.10s — just after a cut");
    expect(labels).toContain("t=12.90s — just before a cut");
    expect(labels).toContain("t=13.10s — just after a cut");
    expect(labels).toContain("t=0.00s — first frame");
    expect(call.images!.every((i) => i.mediaType === "image/jpeg" && i.base64.length > 100)).toBe(true);
    expect(call.images!.length).toBeLessThanOrEqual(80);
    // The edit's facts and the measured sound are in the prompt; the brand only shapes fixes.
    expect(call.userPrompt).toContain("Watched on: TikTok For You feed");
    expect(call.userPrompt).toContain("3.00 s: jump cut (pause removed) (0.50 s removed)");
    expect(call.userPrompt).toContain("13.00 s: framing change only");
    expect(call.userPrompt).toContain("Text \"Max out your 401(k)?\" 0.0–2.5 s");
    expect(call.userPrompt).toContain("Overall loudness");
    expect(call.userPrompt).toMatch(/\[\d+\.\d–\d+\.\d\] word0/);

    const rows = await prisma.viewerReview.findMany({ where: { contentItemId: itemId } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ subjectKind: "RENDER", renderId, editPlanId, platform: "TIKTOK", persona: "COLD", promptId: "VIEWER_PANEL", verdictTier: "GOOD", jobRunId, mediaStorageKey: "renders/viewer/render.mp4" });
    expect(row.estimatedCostUsd).toBeGreaterThan(0.05);
    expect(row.costUsd).toBeNull(); // the mock spends nothing
    expect(ViewerReviewSchema.safeParse(row.review).success).toBe(true);
    const summary = row.inputSummary as { frames: Array<{ t: number; reason: string }>; cutsSource: string; wordCount: number; audioMeasured: boolean };
    expect(summary.cutsSource).toBe("EDIT");
    expect(summary.wordCount).toBeGreaterThan(20);
    expect(summary.audioMeasured).toBe(true);
    expect(summary.frames.length).toBe(call.images!.length);
    expect(await prisma.auditLog.count({ where: { entityId: row.id, action: "VIEWER_REVIEW_RECORDED" } })).toBe(1);
    expect((await getHeavyJob(prisma, jobRunId))!.status).toBe("SUCCEEDED");

    // Watching again adds a version; the first is kept.
    const again = await lease(itemId, { contentItemId: itemId });
    expect((await runHeavyJobRecorded(again, "viewer-review", { contentItemId: itemId }, { db: prisma, storage, actor, modelProvider: () => mock })).ok).toBe(true);
    expect(await prisma.viewerReview.count({ where: { contentItemId: itemId } })).toBe(2);
    // Advisory only: the video's state never moves.
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: itemId } })).currentState).toBe("EDIT_PLANNED");
  }, 120_000);

  it("no render yet → a plain refusal, and the AI is never asked", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "Viewer check no render" }, actor);
    let built = 0;
    const out = await executeHeavyJob("viewer-review", { contentItemId: item.id }, {
      db: prisma,
      storage,
      actor,
      modelProvider: () => {
        built += 1;
        return new MockModelProvider(() => sampleViewerReview());
      },
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/render it first/);
    expect(built).toBe(0);
  });

  it("the daily spend cap fails closed: nothing is sent, nothing is stored, the page can say why", async () => {
    const { itemId } = await renderedItem("Viewer check capped");
    let sent = 0;
    const delegate: ModelProvider = {
      completeStructured: async () => {
        sent += 1;
        throw new Error("must not be called");
      },
    };
    const out = await executeHeavyJob("viewer-review", { contentItemId: itemId }, {
      db: prisma,
      storage,
      actor,
      modelProvider: () => new CostTrackingModelProvider(delegate, prisma, { dailyCapUsd: 0 }),
    });
    expect(out.ok).toBe(false);
    expect((out.result as { errorName: string }).errorName).toBe(new SpendCapExceededError("x", 0, 0).name);
    expect(sent).toBe(0);
    expect(await prisma.viewerReview.count({ where: { contentItemId: itemId } })).toBe(0);
  }, 120_000);

  it("refuses before calling when the estimate is over the per-review ceiling", async () => {
    const { itemId } = await renderedItem("Viewer check ceiling");
    process.env.VIEWER_REVIEW_MAX_USD = "0.01";
    const mock = new MockModelProvider(() => sampleViewerReview());
    const out = await executeHeavyJob("viewer-review", { contentItemId: itemId }, { db: prisma, storage, actor, modelProvider: () => mock });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/over the \$0\.01 limit per review/);
    expect(mock.calls).toHaveLength(0);
  }, 120_000);

  it("watches a reference video: cuts detected, words transcribed, never presented as Chris, no brand context", async () => {
    const c = await findOrCreateReferenceCreator(prisma, { name: `Viewer ref ${Date.now()}` }, actor);
    const key = `reference/${c.id}/1-ref.mp4`;
    await storage.put(key, await readFile(clip));
    const v = await registerReferenceVideo(prisma, { referenceCreatorId: c.id, storageKey: key, filename: "ref.mp4" }, actor);
    const transcriber = Object.assign(new MockTranscriptionProvider(() => ({ text: words.map((w) => w.word).join(" "), words })), { model: "mock" });
    const mock = new MockModelProvider(() => sampleViewerReview());
    const jobRunId = await lease(referenceVideoSubject(v.id), { referenceContentId: v.id });
    const out = await runHeavyJobRecorded(jobRunId, "viewer-review", { referenceContentId: v.id }, { db: prisma, storage, actor, modelProvider: () => mock, transcriptionProvider: transcriber });
    expect(out.error).toBeUndefined();
    expect(out.ok).toBe(true);
    const prompt = mock.calls[0]!.userPrompt;
    expect(prompt).toContain(`A video by ${c.name} (a reference creator — NOT Chris)`);
    expect(prompt).not.toContain("The creator's brand");
    expect(prompt).toContain("detected from the picture");
    const row = await prisma.viewerReview.findFirstOrThrow({ where: { referenceContentId: v.id } });
    expect(row).toMatchObject({ subjectKind: "REFERENCE_VIDEO", contentItemId: null, renderId: null, mediaStorageKey: key });
  }, 120_000);
});
