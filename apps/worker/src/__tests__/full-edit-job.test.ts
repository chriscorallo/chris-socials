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
  createStarterEdit,
  getLatestEditPlan,
  saveFinishingEdit,
  readStoredFullEdit,
  readStoredStyleCut,
  setAutoEditMode,
  getAutoEditMode,
  FULL_EDIT_AUTO_REASON,
  STYLE_CUT_AUTO_REASON,
} from "@chris/domain";
import { FFMPEG_PATH, LocalFsStorageAdapter, EditTimelineSchema, FullEditReportSchema } from "@chris/media";
import { maybeAutoStyleCut, applyStyleCutChoice } from "../style-cut-job";

const run = promisify(execFile);
const actor = { actorId: "chris" };

/** Spreads a sentence's words evenly over [start, end]. */
function said(text: string, start: number, end: number) {
  const ws = text.split(" ");
  const step = (end - start) / ws.length;
  return ws.map((word, i) => ({ word, start: +(start + i * step).toFixed(3), end: +(start + (i + 1) * step - 0.03).toFixed(3) }));
}

/**
 * Full edit wiring against the throwaway DB: it's the DEFAULT automatic edit (new version over
 * the untouched starter, idempotent); Chris's choices ("Try another hook", restore a removed
 * line, Cuts only) are new versions; the setting switches new uploads to Cuts only.
 */
describe("full edit job", () => {
  let dir: string;
  let storage: LocalFsStorageAdapter;
  const bursts: Array<[string, number, number]> = [
    ["Hey guys.", 0.5, 1.4],
    ["Most people overpay.", 2.0, 3.4],
    ["Most people overpay on rent every single month.", 4.0, 6.4],
    ["You can save $400 a month if you negotiate.", 7.0, 9.4],
    ["Nobody tells you this.", 10.0, 11.4],
    ["Follow for more.", 12.0, 13.2],
  ];
  const words = bursts.flatMap(([t, s, e]) => said(t, s, e));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-fulledit-job-"));
    storage = new LocalFsStorageAdapter({ baseDir: join(dir, "storage") });
    const clip = join(dir, "take.mp4");
    const loud = bursts.map(([, s, e]) => `between(t,${s},${e})`).join("+");
    await run(FFMPEG_PATH, [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=s=180x320:r=30:d=14",
      "-f", "lavfi", "-i", "sine=f=220:d=14:sample_rate=48000",
      "-f", "lavfi", "-i", "anoisesrc=c=pink:d=14:a=0.002:r=48000",
      "-filter_complex", `[1:a]volume='0.5*(${loud})':eval=frame[s];[s][2:a]amix=inputs=2:normalize=0[a]`,
      "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", clip,
    ]);
    await storage.put("raw/fulledit/take.mp4", await readFile(clip));
  }, 60_000);
  afterAll(async () => {
    await setAutoEditMode(prisma, "FULL", "chris");
    await rm(dir, { recursive: true, force: true });
  });

  async function item(title: string, withWords = true) {
    const it = await createContentItemFromFootage(prisma, { title }, actor);
    const asset = await createMediaAsset(
      prisma,
      { contentItemId: it.id, kind: "RAW_TAKE", storageKey: "raw/fulledit/take.mp4", originalFilename: "take.mp4", mimeType: "video/mp4", sizeBytes: 1 },
      actor,
    );
    await analyzeMediaAsset(prisma, asset.id, { durationSeconds: 14, width: 180, height: 320, frameRate: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }, actor);
    if (withWords) await recordTranscript(prisma, { mediaAssetId: asset.id, text: words.map((w) => w.word).join(" "), words, source: "LOCAL_WHISPER" }, actor);
    await createStarterEdit(prisma, it.id, actor);
    return { id: it.id, assetId: asset.id };
  }

  it("is the default automatic edit: hook first, retake + greeting out, a verified number graphic, idempotent", async () => {
    await setAutoEditMode(prisma, "EDITOR", "test"); // the shared dev DB may hold an earlier run's setting
    expect(await getAutoEditMode(prisma)).toBe("EDITOR"); // the AI Editor by default; this test has no model → the free Full edit runs
    const { id, assetId } = await item("Full edit auto");
    const r = await maybeAutoStyleCut(prisma, storage, id, actor);
    expect(r.status).toBe("APPLIED");
    const plan = (await getLatestEditPlan(prisma, id))!;
    expect(plan.revisionReason).toBe(FULL_EDIT_AUTO_REASON);
    const fe = readStoredFullEdit(plan.plan)!;
    expect(fe.origin).toBe("AUTO");
    expect(fe.mediaAssetId).toBe(assetId);
    expect(Array.isArray(fe.silences)).toBe(true);
    const report = FullEditReportSchema.parse(fe.report);
    expect(report.removed.map((x) => x.kind)).toEqual(expect.arrayContaining(["GREETING", "RETAKE"]));
    expect(report.hook.text).not.toMatch(/^Hey/);
    const tl = EditTimelineSchema.parse((plan.plan as { timeline: unknown }).timeline);
    // Every clip is the take's own audio; the hook title is the only text.
    expect(tl.clips.every((c) => c.mediaAssetId === assetId)).toBe(true);
    expect(tl.texts.length).toBeLessThanOrEqual(1);
    // Numbers on screen were said ($400).
    for (const v of report.visuals) for (const n of v.numbers) expect([400]).toContain(n);
    // Idempotent: same inputs → no new row.
    expect((await maybeAutoStyleCut(prisma, storage, id, actor)).status).toBe("SKIPPED");
    expect((await getLatestEditPlan(prisma, id))!.id).toBe(plan.id);
  }, 120_000);

  it("Chris's choices are versions: try another hook, restore a removed line, cuts only — never overwriting", async () => {
    const { id } = await item("Full edit choices");
    await maybeAutoStyleCut(prisma, storage, id, actor);
    const auto = (await getLatestEditPlan(prisma, id))!;
    const autoReport = FullEditReportSchema.parse(readStoredFullEdit(auto.plan)!.report);

    const other = await applyStyleCutChoice(prisma, storage, id, "FULL", "chris", { hookIndex: 1 });
    expect(other.ok).toBe(true);
    const v2 = (await getLatestEditPlan(prisma, id))!;
    expect(v2.id).not.toBe(auto.id);
    expect(v2.revisionReason).toMatch(/^Finishing edit by Chris: Full edit/);
    const r2 = FullEditReportSchema.parse(readStoredFullEdit(v2.plan)!.report);
    expect(r2.hook.chosenIndex).toBe(1);
    expect(r2.hook.text).toBe(autoReport.hook.candidates[1]!.text);

    const greeting = autoReport.removed.find((x) => x.kind === "GREETING")!;
    const restored = await applyStyleCutChoice(prisma, storage, id, "FULL", "chris", { forceKeep: [greeting.sentenceId] });
    expect(restored.ok).toBe(true);
    const r3 = FullEditReportSchema.parse(readStoredFullEdit((await getLatestEditPlan(prisma, id))!.plan)!.report);
    expect(r3.removed.some((x) => x.sentenceId === greeting.sentenceId)).toBe(false);

    const cuts = await applyStyleCutChoice(prisma, storage, id, "STYLE", "chris");
    expect(cuts.ok).toBe(true);
    const v4 = (await getLatestEditPlan(prisma, id))!;
    expect(readStoredFullEdit(v4.plan)).toBeNull();
    expect(readStoredStyleCut(v4.plan)).not.toBeNull();
    // Earlier versions are untouched (append-only).
    const rows = await prisma.editPlan.count({ where: { contentItemId: id } });
    expect(rows).toBeGreaterThanOrEqual(5);
  }, 180_000);

  it("never replaces Chris's own edit, and the setting switches new uploads to Cuts only", async () => {
    const { id } = await item("Full edit hands off");
    const starter = (await getLatestEditPlan(prisma, id))!;
    const doc = EditTimelineSchema.parse({
      version: 2,
      clips: [{ id: "c1", mediaAssetId: (await prisma.mediaAsset.findFirstOrThrow({ where: { contentItemId: id } })).id, sourceStart: 0, sourceEnd: 14 }],
      captions: { fontId: "inter-semibold", fontSize: 60, color: "#FFFFFF", highlightColor: "#FFD84D" },
    });
    await saveFinishingEdit(prisma, { contentItemId: id, timeline: doc, durationSeconds: 14, actorId: "chris" });
    expect((await maybeAutoStyleCut(prisma, storage, id, actor)).status).toBe("SKIPPED");
    expect((await getLatestEditPlan(prisma, id))!.id).not.toBe(starter.id);

    await setAutoEditMode(prisma, "CUTS", "chris");
    const { id: id2 } = await item("Cuts only setting");
    expect((await maybeAutoStyleCut(prisma, storage, id2, actor)).status).toBe("APPLIED");
    expect((await getLatestEditPlan(prisma, id2))!.revisionReason).toBe(STYLE_CUT_AUTO_REASON);
    await setAutoEditMode(prisma, "FULL", "chris");
  }, 120_000);
});
