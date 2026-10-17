import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { createMediaAsset } from "../media-asset";
import { recordTranscript } from "../media-asset";
import {
  findOrCreateReferenceCreator,
  registerReferenceVideo,
  recordReferenceAnalysis,
  deleteReferenceVideoMedia,
  getReferenceStyleProfile,
  getOwnSpeechProfile,
  listPendingReferenceVideos,
  requeueReferenceVideos,
  listReferenceVideos,
  referenceVideoCounts,
  normalizeSourceUrl,
  platformFromUrl,
  setReferenceVideoSourceUrl,
  countOutdatedReferenceVideos,
} from "../reference-videos";
import { REFERENCE_METRICS_VERSION } from "../style-metrics";
import { createReferenceContent } from "../reference-creator";
import { fakeMetrics, fakeMusicLedMetrics } from "./style-fixtures";

const actor = { actorId: "chris" };
let n = 0;
const uniq = (s: string) => `${s} ${Date.now()}-${n++}`;

async function video(creatorId: string, extra: { sourceUrl?: string } = {}) {
  return registerReferenceVideo(prisma, { referenceCreatorId: creatorId, storageKey: `reference/${creatorId}/${Date.now()}-${n++}-clip.mp4`, filename: "clip.mp4", mimeType: "video/mp4", sizeBytes: 1234, ...extra }, actor);
}

describe("reference videos (domain)", () => {
  it("finds or creates a creator by name, case-insensitively, with empty descriptive fields", async () => {
    const name = uniq("Alex Hormozi");
    const a = await findOrCreateReferenceCreator(prisma, { name: `  ${name}  ` }, actor);
    expect(a.created).toBe(true);
    const b = await findOrCreateReferenceCreator(prisma, { name: name.toUpperCase() }, actor);
    expect(b).toMatchObject({ id: a.id, created: false });
    const byId = await findOrCreateReferenceCreator(prisma, { referenceCreatorId: a.id }, actor);
    expect(byId.id).toBe(a.id);
    const row = await prisma.referenceCreator.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.brandPositioning).toBe("");
    await expect(findOrCreateReferenceCreator(prisma, { name: "  " }, actor)).rejects.toThrow(/creator/);
    await expect(findOrCreateReferenceCreator(prisma, { referenceCreatorId: "nope" }, actor)).rejects.toThrow(/exist/);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: a.id, action: "REFERENCE_CREATOR_CREATED" } });
    expect(audit).not.toBeNull();
  });

  it("registers an upload as PENDING (idempotent per key), infers the platform from the link, guards the key", async () => {
    const c = await findOrCreateReferenceCreator(prisma, { name: uniq("Shelby Sapp") }, actor);
    const key = `reference/${c.id}/1-a.mov`;
    const first = await registerReferenceVideo(prisma, { referenceCreatorId: c.id, storageKey: key, filename: "a.mov", mimeType: "video/quicktime", sourceUrl: "tiktok.com/@shelby/video/1" }, actor);
    expect(first.analysisStatus).toBe("PENDING");
    expect(first.platform).toBe("TIKTOK");
    expect(first.sourceUrl).toBe("https://tiktok.com/@shelby/video/1");
    expect(first.description).toBe("");
    const again = await registerReferenceVideo(prisma, { referenceCreatorId: c.id, storageKey: key, filename: "a.mov" }, actor);
    expect(again.id).toBe(first.id);
    await expect(registerReferenceVideo(prisma, { referenceCreatorId: c.id, storageKey: `raw/${c.id}/x.mp4`, filename: "x.mp4" }, actor)).rejects.toThrow(/belong/);
    await expect(registerReferenceVideo(prisma, { referenceCreatorId: c.id, storageKey: `reference/other/x.mp4`, filename: "x.mp4" }, actor)).rejects.toThrow(/belong/);
    await expect(registerReferenceVideo(prisma, { referenceCreatorId: c.id, storageKey: `reference/${c.id}/x.mp3`, filename: "x.mp3", mimeType: "audio/mpeg" }, actor)).rejects.toThrow(/video files/);
    const pending = await listPendingReferenceVideos(prisma, { ids: [first.id] });
    expect(pending.map((p) => p.id)).toEqual([first.id]);
  });

  it("links: normalized, platform recognized, junk refused", async () => {
    expect(normalizeSourceUrl("instagram.com/reel/abc")).toBe("https://instagram.com/reel/abc");
    expect(normalizeSourceUrl("not a link")).toBeNull();
    expect(normalizeSourceUrl("")).toBeNull();
    expect(platformFromUrl("https://www.youtube.com/shorts/x")).toBe("YOUTUBE");
    expect(platformFromUrl("https://youtu.be/x")).toBe("YOUTUBE");
    expect(platformFromUrl("https://vm.tiktok.com/x")).toBe("TIKTOK");
    expect(platformFromUrl("https://example.com")).toBeNull();
    const c = await findOrCreateReferenceCreator(prisma, { name: uniq("Link") }, actor);
    const v = await video(c.id);
    const updated = await setReferenceVideoSourceUrl(prisma, v.id, "https://www.instagram.com/reel/1", actor);
    expect(updated.platform).toBe("INSTAGRAM");
    await expect(setReferenceVideoSourceUrl(prisma, v.id, "hello", actor)).rejects.toThrow(/link/);
  });

  it("stores a validated measurement; a malformed one is recorded as a failure, never half-written", async () => {
    const c = await findOrCreateReferenceCreator(prisma, { name: uniq("Measure") }, actor);
    const v = await video(c.id);
    const ok = await recordReferenceAnalysis(prisma, v.id, { metrics: fakeMetrics() }, actor);
    expect(ok.analysisStatus).toBe("DONE");
    expect(ok.durationSeconds).toBe(30);
    expect(ok.hook).toBe("You're doing your 401k wrong.");
    expect(ok.metricsVersion).toBe(1);
    const v2 = await video(c.id);
    const bad = await recordReferenceAnalysis(prisma, v2.id, { metrics: { ...fakeMetrics(), video: { durationS: -5 } } as never }, actor);
    expect(bad.analysisStatus).toBe("FAILED");
    expect(bad.metrics).toBeNull();
    expect(bad.analysisError).toMatch(/malformed/);
    // Retry puts the failure back in the queue.
    expect(await requeueReferenceVideos(prisma, { ids: [v2.id] }, actor)).toBe(1);
    expect((await prisma.referenceContent.findUniqueOrThrow({ where: { id: v2.id } })).analysisStatus).toBe("PENDING");
    const counts = (await referenceVideoCounts(prisma)).get(c.id)!;
    expect(counts).toEqual({ total: 2, measured: 1, pending: 1, failed: 0 });
  });

  it("deleting a video's file keeps its numbers (and its audit trail)", async () => {
    const c = await findOrCreateReferenceCreator(prisma, { name: uniq("Delete") }, actor);
    const v = await video(c.id);
    await recordReferenceAnalysis(prisma, v.id, { metrics: fakeMetrics({ shot: 1.5 }) }, actor);
    const deleted: string[] = [];
    const row = await deleteReferenceVideoMedia(prisma, v.id, async (k) => void deleted.push(k), actor);
    expect(deleted).toEqual([v.mediaStorageKey]);
    expect(row.mediaStorageKey).toBeNull();
    expect(row.mediaDeletedAt).not.toBeNull();
    expect(row.analysisStatus).toBe("DONE");
    expect(row.metrics).not.toBeNull();
    // Idempotent; and the numbers still count toward the style.
    await deleteReferenceVideoMedia(prisma, v.id, async (k) => void deleted.push(k), actor);
    expect(deleted).toHaveLength(1);
    expect((await getReferenceStyleProfile(prisma, { referenceCreatorId: c.id })).shotMedianS!.value).toBe(1.5);
    // A never-measured video whose file is deleted can't be measured any more.
    const p = await video(c.id);
    expect((await deleteReferenceVideoMedia(prisma, p.id, async () => undefined, actor)).analysisStatus).toBe("FAILED");
    expect(await prisma.auditLog.count({ where: { entityId: v.id, action: "REFERENCE_VIDEO_MEDIA_DELETED" } })).toBe(1);
  });

  it("getReferenceStyleProfile: per creator and overall; ignores notes-only and unmeasured rows", async () => {
    const a = await findOrCreateReferenceCreator(prisma, { name: uniq("A") }, actor);
    const b = await findOrCreateReferenceCreator(prisma, { name: uniq("B") }, actor);
    for (const shot of [1, 2, 3]) await recordReferenceAnalysis(prisma, (await video(a.id)).id, { metrics: fakeMetrics({ shot }) }, actor);
    await recordReferenceAnalysis(prisma, (await video(b.id)).id, { metrics: fakeMetrics({ shot: 10 }) }, actor);
    await video(a.id); // pending
    await createReferenceContent(prisma, { referenceCreatorId: a.id, description: "notes only" }, actor);
    const pa = await getReferenceStyleProfile(prisma, { referenceCreatorId: a.id });
    expect(pa.sampleSize).toBe(3);
    expect(pa.shotMedianS!.value).toBe(2);
    const all = await getReferenceStyleProfile(prisma);
    expect(all.sampleSize).toBeGreaterThanOrEqual(4);
    expect(all.creatorCount).toBeGreaterThanOrEqual(2);
    const list = await listReferenceVideos(prisma, a.id);
    expect(list).toHaveLength(4); // the notes-only row isn't a video
    expect(list.filter((v) => v.parsedMetrics).length).toBe(3);
  });

  it("older measurements: counted, re-queued in one go (file still present), old numbers kept until replaced", async () => {
    const c = await findOrCreateReferenceCreator(prisma, { name: uniq("Outdated") }, actor);
    const old1 = await video(c.id);
    const old2 = await video(c.id);
    const gone = await video(c.id);
    const fresh = await video(c.id);
    for (const v of [old1, old2, gone]) await recordReferenceAnalysis(prisma, v.id, { metrics: fakeMetrics({ shot: 2 }) }, actor); // v1
    await recordReferenceAnalysis(prisma, fresh.id, { metrics: fakeMusicLedMetrics() }, actor); // v2
    await deleteReferenceVideoMedia(prisma, gone.id, async () => undefined, actor); // can't be re-measured
    expect((await prisma.referenceContent.findUniqueOrThrow({ where: { id: fresh.id } })).metricsVersion).toBe(REFERENCE_METRICS_VERSION);
    expect(await countOutdatedReferenceVideos(prisma, { referenceCreatorId: c.id })).toBe(2);
    expect(await requeueReferenceVideos(prisma, { outdated: true, ids: [old1.id, old2.id, gone.id, fresh.id] }, actor)).toBe(2);
    expect(await countOutdatedReferenceVideos(prisma, { referenceCreatorId: c.id })).toBe(0);
    const rows = await prisma.referenceContent.findMany({ where: { id: { in: [old1.id, old2.id, gone.id, fresh.id] } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(old1.id)!.analysisStatus).toBe("PENDING");
    expect(byId.get(old1.id)!.metrics).not.toBeNull(); // still readable while waiting
    expect(byId.get(fresh.id)!.analysisStatus).toBe("DONE");
    expect(byId.get(gone.id)!.analysisStatus).toBe("DONE");
    // The style keeps counting videos that are waiting to be re-measured.
    expect((await getReferenceStyleProfile(prisma, { referenceCreatorId: c.id })).sampleSize).toBe(4);
    const audit = await prisma.auditLog.findFirst({ where: { action: "REFERENCE_VIDEOS_REQUEUED" }, orderBy: { createdAt: "desc" } });
    expect(audit!.after).toMatchObject({ outdated: true, count: 2, toVersion: REFERENCE_METRICS_VERSION });
  });

  it("getOwnSpeechProfile reads Chris's raw takes' word timings (no new transcription)", async () => {
    const item = await createContentItem(prisma, { title: "own speech" }, actor);
    const asset = await createMediaAsset(prisma, { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/${item.id}/t.mp4`, originalFilename: "t.mp4", mimeType: "video/mp4", sizeBytes: 1 }, actor);
    const words = Array.from({ length: 20 }, (_, i) => ({ word: `w${i}`, start: i * 0.6, end: i * 0.6 + 0.3 }));
    await recordTranscript(prisma, { mediaAssetId: asset.id, text: "x", words, source: "LOCAL_WHISPER" }, { actorId: "chris", actorType: "JOB" });
    const own = await getOwnSpeechProfile(prisma);
    expect(own.takes).toBeGreaterThanOrEqual(1);
    expect(own.gapP90S).not.toBeNull();
  });
});
