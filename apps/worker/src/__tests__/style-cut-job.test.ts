import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  prisma,
  createContentItemFromFootage,
  createMediaAsset,
  analyzeMediaAsset,
  recordTranscript,
  recordSubjectTrack,
  createStarterEdit,
  getLatestEditPlan,
  saveFinishingEdit,
  autoStyleCutEligibility,
  readStoredStyleCut,
  STYLE_CUT_AUTO_REASON,
  STARTER_EDIT_ORIGIN,
} from "@chris/domain";
import { FFMPEG_PATH, LocalFsStorageAdapter, EditTimelineSchema } from "@chris/media";
import { maybeAutoStyleCut, applyStyleCutChoice } from "../style-cut-job";

const run = promisify(execFile);
const actor = { actorId: "chris" };

/**
 * Style cut wiring end to end against the throwaway DB: starter edit → captions land → AUTO
 * style cut (new version, real silence measurement on a real file) → idempotent → refreshed
 * when the face track lands → never replaces Chris's own edit → editor buttons (plain / re-apply).
 */
describe("style cut job", () => {
  let dir: string;
  let storage: LocalFsStorageAdapter;
  // "Speech" bursts (s): 0.8–2.6, 3.8–5.6 (1.2 s pause), 6.0–8.0 (0.4 s pause); dead air to 10 s.
  const words = [
    { word: "Most", start: 0.8, end: 1.2 },
    { word: "people", start: 1.25, end: 1.8 },
    { word: "overpay.", start: 1.85, end: 2.45 },
    { word: "Here's", start: 3.8, end: 4.3 },
    { word: "the", start: 4.35, end: 4.6 },
    { word: "fix,", start: 4.65, end: 5.5 },
    { word: "pay", start: 6.0, end: 6.4 },
    { word: "yourself", start: 6.45, end: 7.2 },
    { word: "first.", start: 7.25, end: 7.9 },
  ];

  // These tests cover the Cuts-only style cut; the Full edit (the default) has its own tests.
  const prevAuto = process.env.FULL_EDIT_AUTO;
  beforeAll(async () => {
    process.env.FULL_EDIT_AUTO = "off";
    dir = await mkdtemp(join(tmpdir(), "chris-stylecut-job-"));
    storage = new LocalFsStorageAdapter({ baseDir: join(dir, "storage") });
    const clip = join(dir, "take.mp4");
    const loud = "between(t,0.8,2.6)+between(t,3.8,5.6)+between(t,6.0,8.0)";
    await run(FFMPEG_PATH, [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=s=180x320:r=30:d=10",
      "-f", "lavfi", "-i", "sine=f=220:d=10:sample_rate=48000",
      "-f", "lavfi", "-i", "anoisesrc=c=pink:d=10:a=0.002:r=48000",
      "-filter_complex", `[1:a]volume='0.5*(${loud})':eval=frame[s];[s][2:a]amix=inputs=2:normalize=0[a]`,
      "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", clip,
    ]);
    await storage.put("raw/stylecut/take.mp4", await readFile(clip));
  }, 60_000);
  afterAll(async () => {
    if (prevAuto === undefined) delete process.env.FULL_EDIT_AUTO;
    else process.env.FULL_EDIT_AUTO = prevAuto;
    await rm(dir, { recursive: true, force: true });
  });

  async function item(title: string) {
    const it = await createContentItemFromFootage(prisma, { title }, actor);
    const asset = await createMediaAsset(
      prisma,
      { contentItemId: it.id, kind: "RAW_TAKE", storageKey: "raw/stylecut/take.mp4", originalFilename: "take.mp4", mimeType: "video/mp4", sizeBytes: 1 },
      actor,
    );
    await analyzeMediaAsset(prisma, asset.id, { durationSeconds: 10, width: 180, height: 320, frameRate: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }, actor);
    await createStarterEdit(prisma, it.id, actor);
    return { id: it.id, assetId: asset.id };
  }

  it("does nothing without captions, then replaces the untouched starter edit once they land (idempotent)", async () => {
    const { id, assetId } = await item("Style cut auto");
    const none = await maybeAutoStyleCut(prisma, storage, id, actor);
    expect(none).toMatchObject({ status: "SKIPPED" });
    if (none.status === "SKIPPED") expect(none.reason).toMatch(/needs captions first/);
    const starter = await getLatestEditPlan(prisma, id);

    await recordTranscript(prisma, { mediaAssetId: assetId, text: words.map((w) => w.word).join(" "), words, source: "LOCAL_WHISPER" }, actor);
    const applied = await maybeAutoStyleCut(prisma, storage, id, actor);
    expect(applied.status).toBe("APPLIED");
    const plan = (await getLatestEditPlan(prisma, id))!;
    expect(plan.id).not.toBe(starter!.id);
    expect(plan.revisionReason).toBe(STYLE_CUT_AUTO_REASON);
    expect(plan.revisionOfEditPlanId).toBeNull();
    const sc = readStoredStyleCut(plan.plan)!;
    expect(sc.origin).toBe("AUTO");
    expect(sc.stats.speechTiming).toBe("AUDIO"); // silences measured from the real file
    expect(sc.silences!.length).toBeGreaterThanOrEqual(3);
    const tl = EditTimelineSchema.parse((plan.plan as { timeline: unknown }).timeline);
    expect(tl.captions.enabled).toBe(true);
    // Dead air gone at both ends, the 1.2 s pause shortened.
    expect(tl.clips[0]!.sourceStart).toBeGreaterThan(0.6);
    expect(tl.clips.at(-1)!.sourceEnd).toBeLessThan(8.5);
    expect(sc.stats.pausesRemoved).toBeGreaterThanOrEqual(1);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id } })).currentState).toBe("EDIT_PLANNED");
    const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: "EDIT_PLAN_REPLANNED" }, orderBy: { createdAt: "desc" } });
    expect(audit?.actorType).toBe("SYSTEM");
    // The starter row is kept (append-only).
    expect(await prisma.editPlan.count({ where: { contentItemId: id } })).toBe(2);

    const again = await maybeAutoStyleCut(prisma, storage, id, actor);
    expect(again.status).toBe("SKIPPED");
    expect(await prisma.editPlan.count({ where: { contentItemId: id } })).toBe(2);

    // The face track lands → inputs changed → the AUTO cut is refreshed (new version).
    const track = Array.from({ length: 41 }, (_, i) => ({ t: i / 4, box: { x: 0.3, y: 0.15, w: 0.4, h: 0.3 } }));
    await recordSubjectTrack(prisma, assetId, track, actor);
    expect((await maybeAutoStyleCut(prisma, storage, id, actor)).status).toBe("APPLIED");
    expect(await prisma.editPlan.count({ where: { contentItemId: id } })).toBe(3);
    expect(readStoredStyleCut((await getLatestEditPlan(prisma, id))!.plan)!.stats.faceTracked).toBe(true);
  }, 60_000);

  it("never replaces an edit Chris saved", async () => {
    const { id, assetId } = await item("Style cut hands off");
    await recordTranscript(prisma, { mediaAssetId: assetId, text: "x", words, source: "LOCAL_WHISPER" }, actor);
    const latest = (await getLatestEditPlan(prisma, id))!;
    const tl = EditTimelineSchema.parse({
      version: 2,
      clips: [{ id: "c", mediaAssetId: assetId, sourceStart: 1, sourceEnd: 5 }],
      captions: { fontId: "inter-display-extrabold", fontSize: 72, color: "#FFFFFF", highlightColor: "#FFD84D" },
    });
    await saveFinishingEdit(prisma, { contentItemId: id, timeline: tl, durationSeconds: 4, actorId: "chris" });
    const mine = (await getLatestEditPlan(prisma, id))!;
    expect(mine.id).not.toBe(latest.id);
    const r = await maybeAutoStyleCut(prisma, storage, id, actor);
    expect(r.status).toBe("SKIPPED");
    expect((await getLatestEditPlan(prisma, id))!.id).toBe(mine.id);
  }, 60_000);

  it("editor buttons: back to the full take, then re-apply — each a new version", async () => {
    const { id, assetId } = await item("Style cut buttons");
    await recordTranscript(prisma, { mediaAssetId: assetId, text: "x", words, source: "LOCAL_WHISPER" }, actor);
    await maybeAutoStyleCut(prisma, storage, id, actor);
    const before = await prisma.editPlan.count({ where: { contentItemId: id } });

    const plain = await applyStyleCutChoice(prisma, storage, id, "PLAIN", "chris");
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.timeline.clips).toHaveLength(1);
      expect(plain.timeline.clips[0]).toMatchObject({ sourceStart: 0, sourceEnd: 10 });
    }
    const p1 = (await getLatestEditPlan(prisma, id))!;
    expect(readStoredStyleCut(p1.plan)).toBeNull();
    // Chris chose the plain take: automation leaves it alone.
    expect((await maybeAutoStyleCut(prisma, storage, id, actor)).status).toBe("SKIPPED");

    const style = await applyStyleCutChoice(prisma, storage, id, "STYLE", "chris");
    expect(style.ok).toBe(true);
    const p2 = (await getLatestEditPlan(prisma, id))!;
    expect(readStoredStyleCut(p2.plan)!.origin).toBe("CHRIS");
    expect(p2.revisionReason).toMatch(/^Finishing edit by Chris: Style cut/);
    expect(await prisma.editPlan.count({ where: { contentItemId: id } })).toBe(before + 2);
  }, 60_000);

  it("eligibility is pure and strict", () => {
    const starter = { id: "p1", plan: { origin: STARTER_EDIT_ORIGIN }, revisionReason: null };
    expect(autoStyleCutEligibility("EDIT_PLANNED", starter)).toMatchObject({ eligible: true, replaces: "STARTER" });
    expect(autoStyleCutEligibility("RENDERED", starter).eligible).toBe(false);
    expect(autoStyleCutEligibility("EDIT_PLANNED", { ...starter, plan: { origin: STARTER_EDIT_ORIGIN, timeline: {} } }).eligible).toBe(false);
    expect(autoStyleCutEligibility("EDIT_PLANNED", { ...starter, revisionReason: "Finishing edit by Chris" }).eligible).toBe(false);
    expect(autoStyleCutEligibility("EDIT_PLANNED", null).eligible).toBe(false);
  });
});
