import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  prisma,
  acquireHeavyJobLease,
  createContentItemFromFootage,
  createMediaAsset,
  analyzeMediaAsset,
  recordTranscript,
  createStarterEdit,
  saveFinishingEdit,
  getLatestEditPlan,
  getSeriesAgreement,
  recordWatchRating,
  setFlag,
  watchBackHoldFor,
} from "@chris/domain";
import { MockModelProvider } from "@chris/agents";
import { FFMPEG_PATH, LocalFsStorageAdapter, EditTimelineSchema } from "@chris/media";
import { runHeavyJobRecorded } from "../heavy-jobs";
import { heavyJobNeedsModel, parseHeavyJobArgs } from "../heavy-job-kinds";


const run = promisify(execFile);
const actor = { actorId: "chris" };
const words = Array.from({ length: 40 }, (_, i) => ({ word: `word${i}${i % 9 === 8 ? "." : ""}`, start: 0.5 + i * 0.5, end: 0.5 + i * 0.5 + 0.4 }));

/**
 * The watch-back job on a real (tiny) render: free audits → one HIGH watch (mock) + one MEDIUM
 * hook test (mock) → a WatchVerdict row with the typed fixes; the fix loop off; Chris's rating;
 * the preflight hold under the gating flag.
 */
describe("watch-back job", () => {
  let dir: string;
  let storage: LocalFsStorageAdapter;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-watch-test-"));
    storage = new LocalFsStorageAdapter({ baseDir: join(dir, "storage") });
    const clip = join(dir, "render.mp4");
    await run(FFMPEG_PATH, ["-y", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=30:duration=22", "-f", "lavfi", "-i", "sine=frequency=440:duration=22", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
    await storage.put("raw/watch/take.mp4", await readFile(clip));
    await storage.put("renders/watch/render.mp4", await readFile(clip));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function renderedItem(title: string) {
    const item = await createContentItemFromFootage(prisma, { title }, actor);
    const asset = await createMediaAsset(prisma, { contentItemId: item.id, kind: "RAW_TAKE", storageKey: "raw/watch/take.mp4", originalFilename: "take.mp4", mimeType: "video/mp4", sizeBytes: 1 }, actor);
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
      captions: { fontId: "inter-display-extrabold", fontSize: 44, color: "#FFFFFF", highlightColor: "#FFD84D" },
      texts: [{ id: "fe-hook-title", text: "Max out your 401(k)?", start: 0, end: 2.5, fontId: "inter-display-extrabold", fontSize: 72, color: "#FFFFFF" }],
    });
    await saveFinishingEdit(prisma, { contentItemId: item.id, timeline, durationSeconds: 20, actorId: "chris" });
    const plan = (await getLatestEditPlan(prisma, item.id))!;
    const render = await prisma.render.create({ data: { contentItemId: item.id, editPlanId: plan.id, status: "SUCCESS", storageKey: "renders/watch/render.mp4", durationSeconds: 20, width: 180, height: 320 } });
    return { itemId: item.id, renderId: render.id };
  }

  async function lease(subject: string, args: unknown) {
    await prisma.jobRun.updateMany({ where: { kind: { startsWith: "heavy:" }, status: { in: ["RUNNING", "QUEUED"] } }, data: { status: "FAILED", finishedAt: new Date() } });
    const l = await acquireHeavyJobLease(prisma, { contentItemId: subject, jobKind: "watch-back", args, mode: "inline", actorId: "chris" });
    if (!l.acquired) throw new Error("lease not acquired");
    return l.jobRunId;
  }

  const verdict = {
    verdict: "FIX",
    checklist: [
      { check: "HOOK_BY_1_5S", ok: true, finding: "title up at 0 s", evidence: [{ t: 0, kind: "SEEN", detail: "Max out your 401(k)?" }] },
      { check: "CUTS_INVISIBLE", ok: false, finding: "the first cut breathes", evidence: [{ t: 3, kind: "MEASURED", detail: "air" }] },
      { check: "LIKE_THE_REFERENCES", ok: true, finding: "n/a", evidence: [{ t: 0, kind: "SEEN", detail: "no reference" }] },
    ],
    fixes: [{ stage: "SPLICE", op: "RETIME", cutIndex: 0, deltaMs: -120, side: "BOTH", why: "a gap" }],
    coldViewer: "I stop on the title. The first cut takes a breath I notice. The ending lands.",
    hook: { firstFrameRead: "a test pattern with a title", stopChancePct: 40, rationale: "an estimate" },
    contrast: [],
  };

  it("is an AI heavy-job kind", () => {
    expect(parseHeavyJobArgs("watch-back", { contentItemId: "c", applyFixes: true, junk: 1 })).toEqual({ contentItemId: "c", applyFixes: true });
    expect(heavyJobNeedsModel("watch-back", { contentItemId: "c" })).toBe(true);
  });

  it("watches the render: audits + one HIGH watch + one MEDIUM hook test → a WatchVerdict with typed fixes; the loop stays off; the rating and the hold follow", async () => {
    const { itemId, renderId } = await renderedItem("Watch-back render");
    const mock = new MockModelProvider((req) => (req.promptId === "HOOK_TEST" ? { wouldKeepWatching: "MAYBE", firstFrameRead: "a title", why: "a claim", missing: null } : verdict));
    const jobRunId = await lease(itemId, { contentItemId: itemId });
    const outcome = await runHeavyJobRecorded(jobRunId, "watch-back", { contentItemId: itemId }, { db: prisma, storage, actor, modelProvider: () => mock, progress: () => undefined });
    expect(outcome.error).toBeUndefined();
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toMatch(/1 fix named/);
    expect(mock.calls.map((c) => c.promptId)).toEqual(["WATCH_BACK", "HOOK_TEST"]);
    const watch = mock.calls[0]!;
    expect(watch.modelClass).toBe("HIGH");
    expect(watch.images!.length).toBeGreaterThan(3);
    expect(watch.userPrompt).toContain("Cuts (index → output time): 0@3.0s, 1@13.0s");
    expect(mock.calls[1]!.modelClass).toBe("MEDIUM");

    const rows = await prisma.watchVerdict.findMany({ where: { contentItemId: itemId } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ renderId, loop: 0, verdict: "FIX", jobRunId });
    expect(row.fixes).toEqual(verdict.fixes);
    expect((row.hookTest as { wouldKeepWatching: string }).wouldKeepWatching).toBe("MAYBE");
    // No fix loop (flag off): one render, no new edit plan version.
    expect(await prisma.render.count({ where: { contentItemId: itemId } })).toBe(1);

    // Shadow: nothing holds the post. Gating on: a HOLD/spent FIX would; a plain FIX (loop 0) does not.
    await setFlag(prisma, { key: "watch_back.gating", enabled: true, actor: "chris", actorType: "HUMAN" });
    expect(await watchBackHoldFor(prisma, renderId)).toBeNull();
    await prisma.watchVerdict.update({ where: { id: row.id }, data: { verdict: "HOLD" } });
    expect(await watchBackHoldFor(prisma, renderId)).toMatch(/put this video on hold/);
    await recordWatchRating(prisma, { watchVerdictId: row.id, rating: "UP", action: "POST_ANYWAY" }, actor);
    expect(await watchBackHoldFor(prisma, renderId)).toBeNull();
    await setFlag(prisma, { key: "watch_back.gating", enabled: false, actor: "chris", actorType: "HUMAN" });

    const agreement = await getSeriesAgreement(prisma, null);
    expect(agreement.rated).toBeGreaterThanOrEqual(1);
    expect(agreement.overrides).toBeGreaterThanOrEqual(1);
    expect(agreement.earned).toBe(false);
  }, 120_000);
});
