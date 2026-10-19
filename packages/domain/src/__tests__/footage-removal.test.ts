import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItemFromFootage } from "../footage-first";
import { createMediaAsset, analyzeMediaAsset, listMediaAssetsForContentItem } from "../media-asset";
import { createStarterEdit } from "../starter-edit";
import { applyTransition, isRollback, isValidTransition } from "../state-machine";
import { scheduleContentItemForPublishing } from "../schedule";
import { getContentItem } from "../content-item";
import { saveFinishingEdit, getLatestEditPlan } from "../edit-plan";
import { autoStyleCutEligibility } from "../style-cut-plan";
import { removeTake, replaceFootage, takesUsedByPlan, FootageChangeNotAllowedError, TakeNotFoundError } from "../footage-removal";

const actor = { actorId: "chris" };

async function addTake(contentItemId: string, name: string, duration: number) {
  const a = await createMediaAsset(prisma, { contentItemId, kind: "RAW_TAKE", storageKey: `raw/${contentItemId}/${name}`, originalFilename: name, mimeType: "video/mp4", sizeBytes: 1 }, actor);
  await analyzeMediaAsset(prisma, a.id, { durationSeconds: duration, width: 1080, height: 1920, frameRate: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }, actor);
  await prisma.mediaAsset.update({ where: { id: a.id }, data: { proxyStorageKey: `proxies/${contentItemId}/${name}.proxy.mp4`, filmstripStorageKey: `proxies/${contentItemId}/${name}.strip.jpg` } });
  return a.id;
}

async function edited(title: string, takes: Array<[string, number]>) {
  const item = await createContentItemFromFootage(prisma, { title }, actor);
  const ids: string[] = [];
  for (const [n, d] of takes) ids.push(await addTake(item.id, n, d));
  const { editPlan } = await createStarterEdit(prisma, item.id, actor);
  return { id: item.id, ids, editPlan };
}

/** Walks an edited video to READY (+ a SUCCESS render with a variant) and optionally SCHEDULED. */
async function finish(id: string, schedule: boolean) {
  const plan = (await getLatestEditPlan(prisma, id))!;
  await applyTransition(prisma, { contentItemId: id, to: "EDITING", actorType: "SYSTEM" });
  const render = await prisma.render.create({ data: { contentItemId: id, editPlanId: plan.id, status: "SUCCESS", storageKey: `renders/${id}/r1.mp4` } });
  await prisma.renderVariant.create({
    data: { renderId: render.id, contentItemId: id, platform: "INSTAGRAM", profileVersion: "v1", storageKey: `variants/${id}/ig.mp4`, coverStorageKey: `variants/${id}/ig.jpg`, width: 1080, height: 1920, fps: 30, durationSeconds: 10, fileSizeBytes: 1 },
  });
  await applyTransition(prisma, { contentItemId: id, to: "RENDERED", actorType: "SYSTEM" });
  await applyTransition(prisma, { contentItemId: id, to: "READY", actorType: "SYSTEM" });
  const date = new Date("2026-11-05T17:00:00Z");
  if (schedule) await scheduleContentItemForPublishing(prisma, { contentItemId: id, scheduledDate: date, targetPlatforms: ["INSTAGRAM"] }, actor);
  return { render, date };
}

const state = async (id: string) => (await prisma.contentItem.findUniqueOrThrow({ where: { id } })).currentState;

describe("state machine: footage rollbacks", () => {
  it("MEDIA_INGESTED / FILMED are reachable (as rollbacks) from every editing state, never from publishing on", () => {
    for (const s of ["TAKE_SELECTED", "EDIT_PLANNED", "EDITING", "RENDERED", "QC_REPAIR", "QC_BLOCKED", "READY", "SCHEDULED"] as const) {
      expect(isValidTransition(s, "MEDIA_INGESTED")).toBe(true);
      expect(isRollback(s, "MEDIA_INGESTED")).toBe(true);
      expect(isValidTransition(s, "FILMED")).toBe(true);
      expect(isRollback(s, "FILMED")).toBe(true);
    }
    expect(isValidTransition("MEDIA_INGESTED", "FILMED")).toBe(true);
    for (const s of ["PUBLISHING", "PUBLISHED", "MEASURING", "ARCHIVED", "CANCELLED"] as const) {
      expect(isValidTransition(s, "MEDIA_INGESTED")).toBe(false);
      expect(isValidTransition(s, "FILMED")).toBe(false);
    }
  });
});

describe("takesUsedByPlan", () => {
  it("collects the selected take, recorded parts, timeline clips and cut sources", () => {
    const used = takesUsedByPlan(
      { sequence: { takes: [{ mediaAssetId: "p1" }] }, timeline: { clips: [{ mediaAssetId: "c1" }, { mediaAssetId: "c2" }] }, fullEdit: { mediaAssetId: "f1" }, styleCut: { mediaAssetIds: ["s1"] } },
      "sel",
    );
    expect([...used].sort()).toEqual(["c1", "c2", "f1", "p1", "s1", "sel"]);
    expect([...takesUsedByPlan(null, null)]).toEqual([]);
  });
});

describe("removeTake (Delete this clip)", () => {
  it("a take NOT in the edit: soft-removed, files returned, edit + state untouched, hidden from lists", async () => {
    const { id, ids, editPlan } = await edited("Two takes, delete the spare", [["long.mp4", 20], ["spare.mp4", 8]]);
    const spare = ids[1]!;
    const r = await removeTake(prisma, { contentItemId: id, mediaAssetId: spare }, actor);
    expect(r).toMatchObject({ removed: true, outcome: "KEPT_EDIT", state: "EDIT_PLANNED", editPlanId: null });
    expect(r.storageKeys).toEqual(expect.arrayContaining([`raw/${id}/spare.mp4`, `proxies/${id}/spare.mp4.proxy.mp4`, `proxies/${id}/spare.mp4.strip.jpg`]));
    expect((await getLatestEditPlan(prisma, id))!.id).toBe(editPlan.id);
    const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: spare } });
    expect(row.removedAt).not.toBeNull();
    expect(row.proxyStorageKey).toBeNull();
    // Lists ignore it.
    expect((await listMediaAssetsForContentItem(prisma, id)).map((a) => a.id)).toEqual([ids[0]]);
    expect((await getContentItem(prisma, id))!.mediaAssets.map((a) => a.id)).toEqual([ids[0]]);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: "TAKE_REMOVED" } })).toBe(1);
    // Idempotent.
    expect((await removeTake(prisma, { contentItemId: id, mediaAssetId: spare }, actor)).removed).toBe(false);
  });

  it("the take IN the edit: rolls back and rebuilds the edit from the remaining take (new selection + plan), history kept", async () => {
    const { id, ids, editPlan } = await edited("Delete the take in the edit", [["main.mp4", 20], ["other.mp4", 11]]);
    const transitionsBefore = await prisma.contentStateTransition.count({ where: { contentItemId: id } });
    const r = await removeTake(prisma, { contentItemId: id, mediaAssetId: ids[0]! }, actor);
    expect(r.outcome).toBe("REBUILT");
    expect(r.state).toBe("EDIT_PLANNED");
    const latest = (await getLatestEditPlan(prisma, id))!;
    expect(latest.id).toBe(r.editPlanId);
    expect(latest.id).not.toBe(editPlan.id);
    const sel = await prisma.takeSelection.findUniqueOrThrow({ where: { id: latest.takeSelectionId } });
    expect(sel.selectedMediaAssetId).toBe(ids[1]);
    // The fresh edit is an untouched starter edit, so the automatic Full edit / Cuts only applies to it.
    expect(autoStyleCutEligibility("EDIT_PLANNED", latest).eligible).toBe(true);
    // History: old plan, old selection (FK to the removed take) and every transition stay.
    expect(await prisma.editPlan.count({ where: { id: editPlan.id } })).toBe(1);
    expect(await prisma.takeSelection.count({ where: { contentItemId: id } })).toBe(2);
    const tail = (await prisma.contentStateTransition.findMany({ where: { contentItemId: id }, orderBy: { createdAt: "asc" } })).slice(transitionsBefore).map((t) => `${t.fromState}->${t.toState}`);
    expect(tail).toEqual(["EDIT_PLANNED->MEDIA_INGESTED", "MEDIA_INGESTED->TAKE_SELECTED", "TAKE_SELECTED->EDIT_PLANNED"]);
  });

  it("a take only in the UNSAVED editor timeline counts as in the edit", async () => {
    const { id, ids } = await edited("Unsaved use", [["main.mp4", 20], ["broll.mp4", 6]]);
    const r = await removeTake(prisma, { contentItemId: id, mediaAssetId: ids[1]!, inUnsavedEdit: true }, actor);
    expect(r.outcome).toBe("REBUILT");
  });

  it("a take used in a saved multi-clip timeline counts as in the edit", async () => {
    const { id, ids } = await edited("Saved multi-clip", [["main.mp4", 20], ["insert.mp4", 6]]);
    await saveFinishingEdit(prisma, { contentItemId: id, actorId: "chris", durationSeconds: 26, timeline: { clips: [{ mediaAssetId: ids[0] }, { mediaAssetId: ids[1] }] } });
    const r = await removeTake(prisma, { contentItemId: id, mediaAssetId: ids[1]! }, actor);
    expect(r.outcome).toBe("REBUILT");
    const sel = await prisma.takeSelection.findUniqueOrThrow({ where: { id: (await getLatestEditPlan(prisma, id))!.takeSelectionId } });
    expect(sel.selectedMediaAssetId).toBe(ids[0]);
  });

  it("the LAST take: back to FILMED (needs footage), the video stays in the plan with its schedule", async () => {
    const { id, ids } = await edited("Only take", [["only.mp4", 15]]);
    const { date } = await finish(id, true);
    const r = await removeTake(prisma, { contentItemId: id, mediaAssetId: ids[0]! }, actor);
    expect(r.outcome).toBe("NEEDS_FOOTAGE");
    expect(r.state).toBe("FILMED");
    expect(r.storageKeys).toEqual(expect.arrayContaining([`raw/${id}/only.mp4`, `renders/${id}/r1.mp4`, `variants/${id}/ig.mp4`, `variants/${id}/ig.jpg`]));
    expect((await prisma.scheduleEntry.findUniqueOrThrow({ where: { contentItemId: id } })).scheduledDate).toEqual(date);
    // Render row kept (history), its file pointer cleared.
    const renders = await prisma.render.findMany({ where: { contentItemId: id } });
    expect(renders).toHaveLength(1);
    expect(renders[0]!.storageKey).toBeNull();
    // A new upload ingests normally again (FILMED -> MEDIA_INGESTED).
    await addTake(id, "again.mp4", 9);
    expect(await state(id)).toBe("MEDIA_INGESTED");
  });

  it("refuses a take of another video, and a posted video", async () => {
    const a = await edited("A", [["a.mp4", 5]]);
    const b = await edited("B", [["b.mp4", 5]]);
    await expect(removeTake(prisma, { contentItemId: a.id, mediaAssetId: b.ids[0]! }, actor)).rejects.toBeInstanceOf(TakeNotFoundError);
    await finish(b.id, true);
    await applyTransition(prisma, { contentItemId: b.id, to: "PUBLISHING", actorType: "SYSTEM" });
    await expect(removeTake(prisma, { contentItemId: b.id, mediaAssetId: b.ids[0]! }, actor)).rejects.toBeInstanceOf(FootageChangeNotAllowedError);
  });
});

describe("replaceFootage", () => {
  it("end to end: new take uploaded → old takes removed → fresh edit from the new take; title/schedule kept", async () => {
    const { id, ids, editPlan } = await edited("Trash take", [["trash.mp4", 30], ["trash2.mp4", 12]]);
    const before = await prisma.contentItem.findUniqueOrThrow({ where: { id } });
    const fresh = await addTake(id, "good.mp4", 18);
    expect(await state(id)).toBe("EDIT_PLANNED"); // uploading alone never changes the edit

    const r = await replaceFootage(prisma, { contentItemId: id, newMediaAssetId: fresh }, actor);
    expect(r.removedTakeIds.sort()).toEqual([...ids].sort());
    expect(r.state).toBe("MEDIA_INGESTED");
    expect(r.storageKeys).toEqual(expect.arrayContaining([`raw/${id}/trash.mp4`, `raw/${id}/trash2.mp4`]));
    expect(r.storageKeys).not.toContain(`raw/${id}/good.mp4`);
    expect((await listMediaAssetsForContentItem(prisma, id)).map((a) => a.id)).toEqual([fresh]);

    // The client's next step (same as any upload): captions → starter edit → auto edit → editor.
    const { editPlan: next } = await createStarterEdit(prisma, id, actor);
    expect(next.id).not.toBe(editPlan.id);
    const sel = await prisma.takeSelection.findUniqueOrThrow({ where: { id: next.takeSelectionId } });
    expect(sel.selectedMediaAssetId).toBe(fresh);
    expect(sel.confidence).toBe(1); // the only take now
    expect(await state(id)).toBe("EDIT_PLANNED");
    const after = await prisma.contentItem.findUniqueOrThrow({ where: { id } });
    expect(after.title).toBe(before.title);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: "FOOTAGE_REPLACED" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: "TAKE_REMOVED" } })).toBe(2);
    // No history deleted: both old take rows, the old plan and its selection are still there.
    expect(await prisma.mediaAsset.count({ where: { contentItemId: id } })).toBe(3);
    expect(await prisma.editPlan.count({ where: { id: editPlan.id } })).toBe(1);
    // Idempotent: replacing again with the same clip does nothing.
    const again = await replaceFootage(prisma, { contentItemId: id, newMediaAssetId: fresh }, actor);
    expect(again.removedTakeIds).toEqual([]);
    expect(await state(id)).toBe("EDIT_PLANNED");
  });

  it("a SCHEDULED video: leaves SCHEDULED (must be finished again), keeps its calendar slot, stale renders' files go", async () => {
    const { id } = await edited("Scheduled then reshot", [["old.mp4", 20]]);
    const { render, date } = await finish(id, true);
    expect(await state(id)).toBe("SCHEDULED");
    const fresh = await addTake(id, "reshoot.mp4", 22);
    const r = await replaceFootage(prisma, { contentItemId: id, newMediaAssetId: fresh }, actor);
    expect(r.wasScheduledOrReady).toBe(true);
    expect(r.keptScheduleDate).toEqual(date);
    expect(r.storageKeys).toEqual(expect.arrayContaining([`renders/${id}/r1.mp4`, `variants/${id}/ig.mp4`, `variants/${id}/ig.jpg`]));
    expect(await state(id)).toBe("MEDIA_INGESTED");
    const entry = await prisma.scheduleEntry.findUniqueOrThrow({ where: { contentItemId: id } });
    expect(entry.scheduledDate).toEqual(date);
    expect((await prisma.render.findUniqueOrThrow({ where: { id: render.id } })).storageKey).toBeNull();
    await createStarterEdit(prisma, id, actor);
    // Not schedulable/publishable until it renders and passes the gates again.
    expect(await state(id)).toBe("EDIT_PLANNED");
    expect(isValidTransition("EDIT_PLANNED", "PUBLISHING")).toBe(false);
    const t = await prisma.contentStateTransition.findFirstOrThrow({ where: { contentItemId: id, fromState: "SCHEDULED", toState: "MEDIA_INGESTED" } });
    expect(t.reason).toMatch(/finished again/);
  });

  it("a READY video goes back too", async () => {
    const { id } = await edited("Ready then reshot", [["old.mp4", 20]]);
    await finish(id, false);
    const fresh = await addTake(id, "new.mp4", 10);
    await replaceFootage(prisma, { contentItemId: id, newMediaAssetId: fresh }, actor);
    expect(await state(id)).toBe("MEDIA_INGESTED");
  });

  it("discards an open recording draft", async () => {
    const { id } = await edited("Draft open", [["old.mp4", 20]]);
    const session = await prisma.recordingSession.create({ data: { contentItemId: id, createdBy: "chris" } });
    const fresh = await addTake(id, "new.mp4", 10);
    await replaceFootage(prisma, { contentItemId: id, newMediaAssetId: fresh }, actor);
    expect((await prisma.recordingSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("DISCARDED");
  });

  it("refuses a clip that isn't this video's, or a video with no footage stage yet", async () => {
    const a = await edited("A2", [["a.mp4", 5]]);
    const b = await edited("B2", [["b.mp4", 5]]);
    await expect(replaceFootage(prisma, { contentItemId: a.id, newMediaAssetId: b.ids[0]! }, actor)).rejects.toBeInstanceOf(TakeNotFoundError);
    const planned = await createContentItemFromFootage(prisma, { title: "No footage" }, actor);
    const stray = await createMediaAsset(prisma, { contentItemId: planned.id, kind: "RAW_TAKE", storageKey: `raw/${planned.id}/x.mp4`, originalFilename: "x.mp4", mimeType: "video/mp4", sizeBytes: 1 }, actor);
    await prisma.mediaAsset.update({ where: { id: stray.id }, data: { durationSeconds: 5 } });
    await expect(replaceFootage(prisma, { contentItemId: planned.id, newMediaAssetId: stray.id }, actor)).rejects.toBeInstanceOf(FootageChangeNotAllowedError);
  });
});
