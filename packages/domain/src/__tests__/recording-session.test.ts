import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { createContentItemFromFootage } from "../footage-first";
import { createMediaAsset, analyzeMediaAsset } from "../media-asset";
import { createStarterEdit, readStarterSequence } from "../starter-edit";
import { nextActionFor } from "../friendly-status";
import {
  attachRecordingSegment,
  assertSegmentUploadAllowed,
  deleteRecordingSegment,
  discardRecordingSession,
  draftLabel,
  findRegisteredSegment,
  finishRecordingSession,
  getFinishedRecordingSequence,
  getOpenRecordingSession,
  getRecordingDraftSummary,
  hasOpenRecordingDraft,
  listOpenRecordingDrafts,
  openRecordingSession,
  RecordingDraftOpenError,
  RecordingSessionClosedError,
  saveRecordingDraftPosition,
} from "../recording-session";

const actor = { actorId: "chris" };

/** What an upload of one segment does on the server: create the take, link it, analyze it. */
async function uploadSegment(contentItemId: string, recordingSessionId: string, key: string, seconds: number, extra: { index?: number; scriptEnd?: number } = {}) {
  const existing = await findRegisteredSegment(prisma, recordingSessionId, key);
  if (existing?.mediaAsset) return existing.mediaAsset;
  await assertSegmentUploadAllowed(prisma, { recordingSessionId, contentItemId });
  const asset = await createMediaAsset(
    prisma,
    { contentItemId, kind: "RAW_TAKE", storageKey: `raw/${contentItemId}/${key}.mp4`, originalFilename: `${key}.mp4`, mimeType: "video/mp4", sizeBytes: 10 },
    actor,
  );
  const r = await attachRecordingSegment(
    prisma,
    { recordingSessionId, clientKey: key, segmentIndex: extra.index ?? null, durationSeconds: seconds, scriptPositionStart: 0, scriptPositionEnd: extra.scriptEnd ?? null, mediaAssetId: asset.id },
    actor,
  );
  if (r.duplicateOf && r.duplicateOf !== asset.id) {
    await prisma.mediaAsset.delete({ where: { id: asset.id } });
    return prisma.mediaAsset.findUniqueOrThrow({ where: { id: r.duplicateOf } });
  }
  await analyzeMediaAsset(prisma, asset.id, { durationSeconds: seconds, width: 1080, height: 1920, frameRate: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }, actor);
  return asset;
}

describe("recording sessions (segmented teleprompter recording + drafts)", () => {
  it("opens a draft on a planned video: walks it to FILMED with honest steps, and is idempotent", async () => {
    const item = await createContentItem(prisma, { title: "Planned, not filmed" }, actor);
    const a = await openRecordingSession(prisma, { contentItemId: item.id, scriptFingerprint: "fp1" }, actor);
    expect(a.created).toBe(true);
    expect(a.session.status).toBe("DRAFT");
    const after = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.currentState).toBe("FILMED");
    const b = await openRecordingSession(prisma, { contentItemId: item.id }, actor);
    expect(b.created).toBe(false);
    expect(b.session.id).toBe(a.session.id);
    expect(await prisma.recordingSession.count({ where: { contentItemId: item.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: item.id, action: "RECORDING_SESSION_STARTED" } })).toBe(1);
  });

  it("two concurrent opens make ONE draft", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "Race" }, actor);
    const [x, y] = await Promise.all([openRecordingSession(prisma, { contentItemId: item.id }, actor), openRecordingSession(prisma, { contentItemId: item.id }, actor)]);
    expect(x.session.id).toBe(y.session.id);
    expect(await prisma.recordingSession.count({ where: { contentItemId: item.id, status: "DRAFT" } })).toBe(1);
  });

  it("appends segments in order, auto-saves the script position, and registration is idempotent", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "Three parts" }, actor);
    const { session } = await openRecordingSession(prisma, { contentItemId: item.id }, actor);
    const s1 = await uploadSegment(item.id, session.id, "k1", 4.2, { scriptEnd: 0.2 });
    // A retried upload (lost response) returns the same take — no duplicate.
    const again = await uploadSegment(item.id, session.id, "k1", 4.2, { scriptEnd: 0.2 });
    expect(again.id).toBe(s1.id);
    await uploadSegment(item.id, session.id, "k2", 6, { scriptEnd: 0.5 });
    await uploadSegment(item.id, session.id, "k3", 3.5, { scriptEnd: 0.7 });
    const open = await getOpenRecordingSession(prisma, item.id);
    expect(open!.segments.map((s) => s.clientKey)).toEqual(["k1", "k2", "k3"]);
    expect(open!.segments.map((s) => s.segmentIndex)).toEqual([0, 1, 2]);
    expect(open!.scriptPosition).toBeCloseTo(0.7);
    expect(await prisma.mediaAsset.count({ where: { contentItemId: item.id, kind: "RAW_TAKE" } })).toBe(3);
    // First analysed part = the canonical ingest trigger.
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("MEDIA_INGESTED");
    const summary = await getRecordingDraftSummary(prisma, item.id);
    expect(summary).toMatchObject({ parts: 3 });
    expect(summary!.seconds).toBeCloseTo(13.7);
    expect(draftLabel(summary!)).toBe("3 parts · 0:14 filmed");
  });

  it("a duplicate registration racing in returns the first take (duplicateOf)", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "Dup" }, actor);
    const { session } = await openRecordingSession(prisma, { contentItemId: item.id }, actor);
    const mk = (n: string) =>
      createMediaAsset(prisma, { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/${item.id}/${n}`, originalFilename: n, mimeType: "video/mp4", sizeBytes: 1 }, actor);
    const a1 = await mk("a1.mp4");
    const a2 = await mk("a2.mp4");
    const r1 = await attachRecordingSegment(prisma, { recordingSessionId: session.id, clientKey: "same", mediaAssetId: a1.id }, actor);
    const r2 = await attachRecordingSegment(prisma, { recordingSessionId: session.id, clientKey: "same", mediaAssetId: a2.id }, actor);
    expect(r1.duplicateOf).toBeNull();
    expect(r2.duplicateOf).toBe(a1.id);
    expect(await prisma.recordingSegment.count({ where: { recordingSessionId: session.id } })).toBe(1);
  });

  it("gates the automatic steps while drafting: no starter edit, no take pick", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "Gate" }, actor);
    const { session } = await openRecordingSession(prisma, { contentItemId: item.id }, actor);
    await uploadSegment(item.id, session.id, "g1", 5);
    expect(await hasOpenRecordingDraft(prisma, item.id)).toBe(true);
    await expect(createStarterEdit(prisma, item.id, actor)).rejects.toBeInstanceOf(RecordingDraftOpenError);
    expect(await prisma.editPlan.count({ where: { contentItemId: item.id } })).toBe(0);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("MEDIA_INGESTED");
    // The video's next step is "Continue filming", never "Edit video".
    const d = await getRecordingDraftSummary(prisma, item.id);
    expect(nextActionFor("MEDIA_INGESTED", d).kind).toBe("CONTINUE_FILMING");
    expect(nextActionFor("MEDIA_INGESTED").kind).toBe("START_EDIT");
  });

  it("delete last segment: marks it DELETED, removes its take, keeps history; indexes never reused", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "Delete" }, actor);
    const { session } = await openRecordingSession(prisma, { contentItemId: item.id }, actor);
    await uploadSegment(item.id, session.id, "d1", 3);
    const s2 = await uploadSegment(item.id, session.id, "d2", 4);
    const r = await deleteRecordingSegment(prisma, { recordingSessionId: session.id, contentItemId: item.id, clientKey: "d2" }, actor);
    expect(r.deleted).toBe(true);
    expect(r.storageKeys).toEqual([s2.storageKey]);
    expect(await prisma.mediaAsset.findUnique({ where: { id: s2.id } })).toBeNull();
    const row = await prisma.recordingSegment.findFirstOrThrow({ where: { recordingSessionId: session.id, clientKey: "d2" } });
    expect(row.status).toBe("DELETED");
    expect(row.mediaAssetId).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: item.id, action: "RECORDING_SEGMENT_DELETED" } })).toBe(1);
    // Idempotent.
    expect((await deleteRecordingSegment(prisma, { recordingSessionId: session.id, contentItemId: item.id, clientKey: "d2" }, actor)).deleted).toBe(false);
    // Record again → next index (2), after the deleted one.
    await uploadSegment(item.id, session.id, "d3", 5);
    const open = await getOpenRecordingSession(prisma, item.id);
    expect(open!.segments.map((s) => [s.clientKey, s.segmentIndex])).toEqual([
      ["d1", 0],
      ["d3", 2],
    ]);
    // A phone that asks for the deleted part's index (1) gets the next free one instead.
    await uploadSegment(item.id, session.id, "d4", 2, { index: 1 });
    const after = await getOpenRecordingSession(prisma, item.id);
    expect(after!.segments.map((s) => [s.clientKey, s.segmentIndex])).toEqual([
      ["d1", 0],
      ["d3", 2],
      ["d4", 3],
    ]);
  });

  it("resume: the draft survives (position saved) and new parts append after the existing ones", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "Resume" }, actor);
    const { session } = await openRecordingSession(prisma, { contentItemId: item.id, scriptFingerprint: "fp" }, actor);
    await uploadSegment(item.id, session.id, "r1", 3);
    await saveRecordingDraftPosition(prisma, { recordingSessionId: session.id, contentItemId: item.id, scriptPosition: 0.42, scriptFingerprint: "fp" });
    // "Days later": reopening returns the same draft with its position.
    const back = await openRecordingSession(prisma, { contentItemId: item.id }, actor);
    expect(back.created).toBe(false);
    expect(back.session.scriptPosition).toBeCloseTo(0.42);
    expect(back.session.segments).toHaveLength(1);
    await uploadSegment(item.id, session.id, "r2", 2, { index: 1 });
    expect((await getOpenRecordingSession(prisma, item.id))!.segments.map((s) => s.clientKey)).toEqual(["r1", "r2"]);
  });

  it("finish → starter edit uses ALL parts in order (not the longest); finished drafts are closed", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "Finish" }, actor);
    const { session } = await openRecordingSession(prisma, { contentItemId: item.id }, actor);
    const p1 = await uploadSegment(item.id, session.id, "f1", 3);
    const p2 = await uploadSegment(item.id, session.id, "f2", 9); // longest — must NOT win alone
    const p3 = await uploadSegment(item.id, session.id, "f3", 4);
    await expect(finishRecordingSession(prisma, { recordingSessionId: session.id, contentItemId: "other" }, actor)).rejects.toThrow();
    const done = await finishRecordingSession(prisma, { recordingSessionId: session.id, contentItemId: item.id }, actor);
    expect(done.status).toBe("FINISHED");
    // Idempotent.
    expect((await finishRecordingSession(prisma, { recordingSessionId: session.id, contentItemId: item.id }, actor)).id).toBe(session.id);
    expect(await hasOpenRecordingDraft(prisma, item.id)).toBe(false);
    expect((await getFinishedRecordingSequence(prisma, item.id))!.mediaAssetIds).toEqual([p1.id, p2.id, p3.id]);

    const { editPlan } = await createStarterEdit(prisma, item.id, actor);
    const sel = await prisma.takeSelection.findUniqueOrThrow({ where: { id: editPlan.takeSelectionId } });
    expect(sel.selectedMediaAssetId).toBe(p1.id);
    expect(sel.reason).toContain("3 recorded parts");
    const seq = readStarterSequence(editPlan.plan);
    expect(seq!.takes).toEqual([
      { mediaAssetId: p1.id, durationSeconds: 3 },
      { mediaAssetId: p2.id, durationSeconds: 9 },
      { mediaAssetId: p3.id, durationSeconds: 4 },
    ]);
    expect(editPlan.targetDurationSeconds).toBe(16);
    expect((editPlan.plan as Record<string, unknown>).timeline).toBeUndefined(); // still an untouched starter edit
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("EDIT_PLANNED");

    // A late upload into the finished draft is refused (permanent error for the uploader).
    await expect(assertSegmentUploadAllowed(prisma, { recordingSessionId: session.id, contentItemId: item.id })).rejects.toBeInstanceOf(RecordingSessionClosedError);
    await expect(discardRecordingSession(prisma, { recordingSessionId: session.id, contentItemId: item.id }, actor)).rejects.toBeInstanceOf(RecordingSessionClosedError);
  });

  it("finish needs at least one part", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "Empty" }, actor);
    const { session } = await openRecordingSession(prisma, { contentItemId: item.id }, actor);
    await expect(finishRecordingSession(prisma, { recordingSessionId: session.id, contentItemId: item.id }, actor)).rejects.toThrow(/at least one part/);
  });

  it("discard: DISCARDED, parts' media removed, history kept, idempotent; the video can be filmed again", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "Discard" }, actor);
    const { session } = await openRecordingSession(prisma, { contentItemId: item.id }, actor);
    const a = await uploadSegment(item.id, session.id, "x1", 3);
    const b = await uploadSegment(item.id, session.id, "x2", 3);
    const r = await discardRecordingSession(prisma, { recordingSessionId: session.id, contentItemId: item.id }, actor);
    expect(r.discarded).toBe(true);
    expect(r.storageKeys.sort()).toEqual([a.storageKey, b.storageKey].sort());
    expect(await prisma.mediaAsset.count({ where: { contentItemId: item.id } })).toBe(0);
    expect(await prisma.recordingSegment.count({ where: { recordingSessionId: session.id, status: "DELETED" } })).toBe(2);
    expect((await prisma.recordingSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("DISCARDED");
    expect(await prisma.auditLog.count({ where: { entityId: item.id, action: "RECORDING_SESSION_DISCARDED" } })).toBe(1);
    expect(await prisma.contentStateTransition.count({ where: { contentItemId: item.id } })).toBeGreaterThan(0);
    expect((await discardRecordingSession(prisma, { recordingSessionId: session.id, contentItemId: item.id }, actor)).discarded).toBe(false);
    await expect(assertSegmentUploadAllowed(prisma, { recordingSessionId: session.id, contentItemId: item.id })).rejects.toBeInstanceOf(RecordingSessionClosedError);
    expect(await getFinishedRecordingSequence(prisma, item.id)).toBeNull();
    // A new draft can start on the same video.
    const again = await openRecordingSession(prisma, { contentItemId: item.id }, actor);
    expect(again.created).toBe(true);
  });

  it("lists open drafts for badges", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "Badge" }, actor);
    const { session } = await openRecordingSession(prisma, { contentItemId: item.id }, actor);
    await uploadSegment(item.id, session.id, "b1", 2.5);
    const list = await listOpenRecordingDrafts(prisma, [item.id]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ contentItemId: item.id, parts: 1, recordingSessionId: session.id });
  });

  it("refuses to record into a video past the editing step", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "Edited" }, actor);
    const asset = await createMediaAsset(prisma, { contentItemId: item.id, kind: "RAW_TAKE", storageKey: "raw/x/a.mp4", originalFilename: "a.mp4", mimeType: "video/mp4", sizeBytes: 1 }, actor);
    await analyzeMediaAsset(prisma, asset.id, { durationSeconds: 5, width: 1080, height: 1920, frameRate: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }, actor);
    await createStarterEdit(prisma, item.id, actor);
    await expect(openRecordingSession(prisma, { contentItemId: item.id }, actor)).rejects.toThrow(/refused/);
  });
});
