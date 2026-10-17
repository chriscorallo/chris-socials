import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItemFromFootage } from "../footage-first";
import { createMediaAsset, analyzeMediaAsset } from "../media-asset";
import { createStarterEdit, pickStarterTake, buildStarterPlan, StarterEditNotAvailableError, StarterEditNoFootageError } from "../starter-edit";
import { recordTakeSelection } from "../take-selection";

const actor = { actorId: "chris" };

async function footageItem(title: string, takes: Array<{ name: string; duration: number }>) {
  const item = await createContentItemFromFootage(prisma, { title }, actor);
  const ids: string[] = [];
  for (const t of takes) {
    const asset = await createMediaAsset(
      prisma,
      { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/${item.id}/${t.name}`, originalFilename: t.name, mimeType: "video/mp4", sizeBytes: 1 },
      actor,
    );
    await analyzeMediaAsset(prisma, asset.id, { durationSeconds: t.duration, width: 1080, height: 1920, frameRate: 30, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }, actor);
    ids.push(asset.id);
  }
  return { item, ids };
}

describe("createStarterEdit (upload → editor, no AI)", () => {
  it("walks MEDIA_INGESTED → TAKE_SELECTED → EDIT_PLANNED through the real transitions, with a whole-take captioned plan", async () => {
    const { item, ids } = await footageItem("One take", [{ name: "a.mp4", duration: 12.5 }]);
    const { editPlan, created } = await createStarterEdit(prisma, item.id, actor);
    expect(created).toBe(true);

    const after = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.currentState).toBe("EDIT_PLANNED");

    const sel = await prisma.takeSelection.findUniqueOrThrow({ where: { id: editPlan.takeSelectionId } });
    expect(sel.selectedMediaAssetId).toBe(ids[0]);
    expect(sel.reason).toMatch(/^Auto: no AI needed/);
    expect(sel.confidence).toBe(1);

    const plan = editPlan.plan as ReturnType<typeof buildStarterPlan>;
    expect(plan.segments).toEqual([{ startSeconds: 0, endSeconds: 12.5 }]);
    expect(plan.captions).toEqual({ enabled: true, style: "BOLD_HIGHLIGHT", position: "LOWER" });
    expect(plan.targetDimensions).toEqual({ width: 1080, height: 1920 });
    expect((editPlan.plan as Record<string, unknown>).timeline).toBeUndefined(); // derived at load time

    const transitions = await prisma.contentStateTransition.findMany({ where: { contentItemId: item.id }, orderBy: { createdAt: "asc" } });
    const tail = transitions.slice(-2).map((t) => `${t.fromState}->${t.toState}`);
    expect(tail).toEqual(["MEDIA_INGESTED->TAKE_SELECTED", "TAKE_SELECTED->EDIT_PLANNED"]);
    // No model calls were made for any of it.
    expect(await prisma.modelCallLog.count({ where: { contentItemId: item.id } })).toBe(0);
  });

  it("picks the longest of several takes and is idempotent", async () => {
    const { item, ids } = await footageItem("Three takes", [
      { name: "t1.mp4", duration: 8 },
      { name: "t2.mp4", duration: 21 },
      { name: "t3.mp4", duration: 15 },
    ]);
    const first = await createStarterEdit(prisma, item.id, actor);
    const sel = await prisma.takeSelection.findUniqueOrThrow({ where: { id: first.editPlan.takeSelectionId } });
    expect(sel.selectedMediaAssetId).toBe(ids[1]);
    expect(sel.reason).toContain("longest of 3");

    const again = await createStarterEdit(prisma, item.id, actor);
    expect(again.created).toBe(false);
    expect(again.editPlan.id).toBe(first.editPlan.id);
    expect(await prisma.editPlan.count({ where: { contentItemId: item.id } })).toBe(1);
  });

  it("reuses an existing take selection from TAKE_SELECTED", async () => {
    const { item, ids } = await footageItem("Picked already", [
      { name: "long.mp4", duration: 30 },
      { name: "short.mp4", duration: 9 },
    ]);
    await recordTakeSelection(prisma, { contentItemId: item.id, selectedMediaAssetId: ids[1]!, confidence: 0.9, reason: "AI liked it" }, actor);
    const { editPlan } = await createStarterEdit(prisma, item.id, actor);
    const plan = editPlan.plan as ReturnType<typeof buildStarterPlan>;
    expect(plan.segments[0]!.endSeconds).toBe(9);
    expect(await prisma.takeSelection.count({ where: { contentItemId: item.id } })).toBe(1);
  });

  it("refuses before footage is uploaded", async () => {
    const item = await createContentItemFromFootage(prisma, { title: "No footage" }, actor);
    await expect(createStarterEdit(prisma, item.id, actor)).rejects.toBeInstanceOf(StarterEditNotAvailableError);
  });
});

describe("pickStarterTake", () => {
  const t = (id: string, d: number | null, at: number) => ({ id, durationSeconds: d, createdAt: new Date(at) });
  it("longest wins, ties go to the most recent, unanalyzed takes are ignored", () => {
    expect(pickStarterTake([t("a", 5, 1), t("b", 9, 2), t("c", 7, 3)])?.id).toBe("b");
    expect(pickStarterTake([t("a", 9, 1), t("b", 9, 2)])?.id).toBe("b");
    expect(pickStarterTake([t("a", null, 1), t("b", 0, 2)])).toBeNull();
  });
  it("error type for no footage is distinct", () => {
    expect(new StarterEditNoFootageError().name).toBe("StarterEditNoFootageError");
  });
});
