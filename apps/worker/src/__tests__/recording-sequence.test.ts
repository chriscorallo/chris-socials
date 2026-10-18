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
  openRecordingSession,
  attachRecordingSegment,
  finishRecordingSession,
  readStoredStyleCut,
} from "@chris/domain";
import { EditPlanOutputSchema } from "@chris/agents";
import { FFMPEG_PATH, LocalFsStorageAdapter, EditTimelineSchema, timelineCaptionWords } from "@chris/media";
import { maybeAutoStyleCut, applyStyleCutChoice } from "../style-cut-job";
import { timelineForPlan } from "../render-job";

const run = promisify(execFile);
const actor = { actorId: "chris" };

/**
 * A video recorded in parts with the teleprompter (docs/decisions-pending/
 * segmented-recording-drafts.md): nothing automatic while it's a draft; after Finish the
 * starter edit opens with every part in order and the automatic style cut joins them.
 */
describe("multi-part recording → starter edit + style cut", () => {
  let dir: string;
  let storage: LocalFsStorageAdapter;
  // Each part: dead air, speech 1.0–2.6 and 3.6–5.0 (a 1 s pause), dead air to 6.5 s.
  const words = (tag: string) => [
    { word: `${tag}-one`, start: 1.0, end: 1.6 },
    { word: `${tag}-two`, start: 1.65, end: 2.5 },
    { word: `${tag}-three.`, start: 3.6, end: 4.2 },
    { word: `${tag}-four`, start: 4.25, end: 4.9 },
  ];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chris-recseq-"));
    storage = new LocalFsStorageAdapter({ baseDir: join(dir, "storage") });
    const clip = join(dir, "part.mp4");
    const loud = "between(t,1.0,2.6)+between(t,3.6,5.0)";
    await run(FFMPEG_PATH, [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=s=180x320:r=30:d=6.5",
      "-f", "lavfi", "-i", "sine=f=220:d=6.5:sample_rate=48000",
      "-f", "lavfi", "-i", "anoisesrc=c=pink:d=6.5:a=0.002:r=48000",
      "-filter_complex", `[1:a]volume='0.5*(${loud})':eval=frame[s];[s][2:a]amix=inputs=2:normalize=0[a]`,
      "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", clip,
    ]);
    const buf = await readFile(clip);
    for (const k of ["p1", "p2", "p3"]) await storage.put(`raw/recseq/${k}.mp4`, buf);
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function recordParts(title: string, keys: string[]) {
    const item = await createContentItemFromFootage(prisma, { title }, actor);
    const { session } = await openRecordingSession(prisma, { contentItemId: item.id }, actor);
    const ids: string[] = [];
    for (const [i, k] of keys.entries()) {
      const a = await createMediaAsset(prisma, { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/recseq/${k}.mp4`, originalFilename: `${k}.mp4`, mimeType: "video/mp4", sizeBytes: 1 }, actor);
      await attachRecordingSegment(prisma, { recordingSessionId: session.id, clientKey: k, segmentIndex: i, mediaAssetId: a.id, durationSeconds: 6.5 }, actor);
      await analyzeMediaAsset(prisma, a.id, { durationSeconds: 6.5, width: 180, height: 320, frameRate: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }, actor);
      // Transcription runs early (as it does on upload) — that's allowed while drafting.
      const w = words(k);
      await recordTranscript(prisma, { mediaAssetId: a.id, text: w.map((x) => x.word).join(" "), words: w, source: "LOCAL_WHISPER" }, actor);
      ids.push(a.id);
    }
    return { id: item.id, sessionId: session.id, ids };
  }

  it("skips the style cut while drafting; after Finish the editor timeline is every part in order, then the style cut joins them", async () => {
    const { id, sessionId, ids } = await recordParts("Three parts", ["p1", "p2", "p3"]);
    const skipped = await maybeAutoStyleCut(prisma, storage, id, actor);
    expect(skipped.status).toBe("SKIPPED");
    if (skipped.status === "SKIPPED") expect(skipped.reason).toMatch(/draft/i);
    expect(await prisma.editPlan.count({ where: { contentItemId: id } })).toBe(0);

    await finishRecordingSession(prisma, { recordingSessionId: sessionId, contentItemId: id }, actor);
    const { editPlan } = await createStarterEdit(prisma, id, actor);

    // The editor / renderer starting point: one whole clip per part, in order.
    const parsed = EditPlanOutputSchema.parse(editPlan.plan);
    const starter = timelineForPlan(editPlan.plan, parsed, { selectedMediaAssetId: ids[0]!, sourceWordsAvailable: true }).timeline;
    expect(starter.clips.map((c) => [c.mediaAssetId, c.sourceStart, c.sourceEnd])).toEqual(ids.map((x) => [x, 0, 6.5]));
    expect(starter.captions.enabled).toBe(true);

    const applied = await maybeAutoStyleCut(prisma, storage, id, actor);
    expect(applied.status).toBe("APPLIED");
    const latest = (await getLatestEditPlan(prisma, id))!;
    const tl = EditTimelineSchema.parse((latest.plan as { timeline: unknown }).timeline);
    const runs = tl.clips.map((c) => c.mediaAssetId).filter((x, i, a) => i === 0 || a[i - 1] !== x);
    expect(runs).toEqual(ids);
    // Dead air at every join is gone: each part starts just before its first word, ends just after its last.
    for (const a of ids) {
      const cs = tl.clips.filter((c) => c.mediaAssetId === a);
      expect(cs[0]!.sourceStart).toBeGreaterThan(0.7);
      expect(cs[cs.length - 1]!.sourceEnd).toBeLessThan(5.6);
    }
    const sc = readStoredStyleCut(latest.plan)!;
    expect(sc.mediaAssetIds).toEqual(ids);
    expect(Object.keys(sc.silencesByAsset ?? {})).toEqual(ids);
    expect(sc.summary).toMatch(/Joined your 3 parts/);
    // Captions: every word of every part once, in order.
    const assets = await prisma.mediaAsset.findMany({ where: { id: { in: ids } } });
    const byAsset = Object.fromEntries(assets.map((x) => [x.id, x.transcriptWords as never]));
    expect(timelineCaptionWords(tl, byAsset).map((w) => w.word)).toEqual(["p1", "p2", "p3"].flatMap((k) => words(k).map((w) => w.word)));
    // Idempotent.
    expect((await maybeAutoStyleCut(prisma, storage, id, actor)).status).toBe("SKIPPED");

    // Editor: "Use my full take instead" = every part whole, in order.
    const plain = await applyStyleCutChoice(prisma, storage, id, "PLAIN", "chris");
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(plain.timeline.clips.map((c) => [c.mediaAssetId, c.sourceStart, c.sourceEnd])).toEqual(ids.map((x) => [x, 0, 6.5]));
    const again = await applyStyleCutChoice(prisma, storage, id, "STYLE", "chris");
    expect(again.ok).toBe(true);
    if (again.ok) expect(new Set(again.timeline.clips.map((c) => c.mediaAssetId))).toEqual(new Set(ids));
  }, 60_000);

  it("a one-part recording behaves like an ordinary one-take video", async () => {
    const { id, sessionId, ids } = await recordParts("One part", ["p1"]);
    await finishRecordingSession(prisma, { recordingSessionId: sessionId, contentItemId: id }, actor);
    const { editPlan } = await createStarterEdit(prisma, id, actor);
    expect((editPlan.plan as Record<string, unknown>).sequence).toBeUndefined();
    const applied = await maybeAutoStyleCut(prisma, storage, id, actor);
    expect(applied.status).toBe("APPLIED");
    const tl = EditTimelineSchema.parse(((await getLatestEditPlan(prisma, id))!.plan as { timeline: unknown }).timeline);
    expect(new Set(tl.clips.map((c) => c.mediaAssetId))).toEqual(new Set(ids));
  }, 60_000);
});
