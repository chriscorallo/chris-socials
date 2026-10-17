import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import { createMediaAsset } from "../media-asset";
import { recordTakeSelection } from "../take-selection";
import {
  recordEditPlan,
  recordReplannedEditPlan,
  getRepairChainEditPlanIds,
  getLatestEditPlan,
  ReplanNotAllowedError,
  saveFinishingEdit,
  FinishingEditNotAllowedError,
} from "../edit-plan";
import { startRendering, recordRenderAttempt, MAX_REPAIR_ATTEMPTS } from "../render-record";
import {
  applyManualTransition,
  ManualTransitionNotAllowedError,
  listManualTransitions,
} from "../manual-transition";

async function makeEditPlannedItem() {
  const item = await createContentItem(prisma, { title: "Repair loop test" }, { actorId: "test-user" });
  for (const to of [
    "SELECTED",
    "CONTRACTED",
    "RESEARCHING",
    "RESEARCHED",
    "SCRIPTING",
    "SCRIPTED",
    "READY_TO_FILM",
    "FILMED",
    "MEDIA_INGESTED",
  ] as const) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
  }
  const take = await createMediaAsset(
    prisma,
    {
      contentItemId: item.id,
      kind: "RAW_TAKE",
      storageKey: `raw/${item.id}/take-1.mp4`,
      originalFilename: "take-1.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1,
    },
    { actorId: "chris" },
  );
  const selection = await recordTakeSelection(
    prisma,
    { contentItemId: item.id, selectedMediaAssetId: take.id, confidence: 0.9, reason: "best" },
    { actorId: "chris" },
  );
  const editPlan = await recordEditPlan(
    prisma,
    {
      contentItemId: item.id,
      takeSelectionId: selection.id,
      productionTier: "FAST",
      targetDurationSeconds: 30,
      plan: { segments: [{ startSeconds: 0, endSeconds: 30 }] },
    },
    { actorId: "chris" },
  );
  return { item, editPlan, selection };
}

async function failingRender(contentItemId: string, editPlanId: string) {
  return recordRenderAttempt(
    prisma,
    {
      contentItemId,
      editPlanId,
      status: "SUCCESS",
      storageKey: `renders/${contentItemId}/${Date.now()}.mp4`,
      technicalQCReport: { overall: "FAIL", checks: [] },
    },
    { actorId: "system" },
  );
}

async function stateOf(id: string) {
  return (await prisma.contentItem.findUniqueOrThrow({ where: { id } })).currentState;
}

describe("repair loop with revised edit plans", () => {
  it("a revised plan can be recorded in QC_REPAIR without a state change, and becomes the latest plan", async () => {
    const { item, editPlan, selection } = await makeEditPlannedItem();
    await startRendering(prisma, item.id, { actorId: "chris" });
    await failingRender(item.id, editPlan.id);
    expect(await stateOf(item.id)).toBe("QC_REPAIR");

    const revised = await recordReplannedEditPlan(
      prisma,
      {
        contentItemId: item.id,
        takeSelectionId: selection.id,
        productionTier: "FAST",
        targetDurationSeconds: 28,
        plan: { segments: [{ startSeconds: 1, endSeconds: 29 }] },
        revisionOfEditPlanId: editPlan.id,
        revisionReason: "Headline overlapped the caption band",
      },
      { actorId: "system", actorType: "SYSTEM" },
    );
    expect(await stateOf(item.id)).toBe("QC_REPAIR");
    expect((await getLatestEditPlan(prisma, item.id))?.id).toBe(revised.id);
    expect(await getRepairChainEditPlanIds(prisma, revised.id)).toEqual([editPlan.id, revised.id]);
  });

  it("revisions share the repair budget — the loop still hits QC_BLOCKED at MAX_REPAIR_ATTEMPTS", async () => {
    const { item, editPlan, selection } = await makeEditPlannedItem();
    await startRendering(prisma, item.id, { actorId: "chris" });

    let planId = editPlan.id;
    for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
      const render = await failingRender(item.id, planId);
      expect(render.attempt).toBe(attempt);
      if (attempt < MAX_REPAIR_ATTEMPTS) {
        expect(await stateOf(item.id)).toBe("QC_REPAIR");
        const revised = await recordReplannedEditPlan(
          prisma,
          {
            contentItemId: item.id,
            takeSelectionId: selection.id,
            productionTier: "FAST",
            targetDurationSeconds: 30,
            plan: { segments: [{ startSeconds: 0, endSeconds: 30 }] },
            revisionOfEditPlanId: planId,
            revisionReason: `repair ${attempt}`,
          },
          { actorId: "system", actorType: "SYSTEM" },
        );
        planId = revised.id;
      }
    }
    expect(await stateOf(item.id)).toBe("QC_BLOCKED");
  });

  it("a human re-plan after the QC_BLOCKED rollback starts a fresh repair budget", async () => {
    const { item, editPlan, selection } = await makeEditPlannedItem();
    await startRendering(prisma, item.id, { actorId: "chris" });
    for (let i = 0; i < MAX_REPAIR_ATTEMPTS; i++) await failingRender(item.id, editPlan.id);
    expect(await stateOf(item.id)).toBe("QC_BLOCKED");

    await applyManualTransition(prisma, { contentItemId: item.id, to: "EDIT_PLANNED", actorId: "chris" });
    const fresh = await recordReplannedEditPlan(
      prisma,
      {
        contentItemId: item.id,
        takeSelectionId: selection.id,
        productionTier: "FAST",
        targetDurationSeconds: 30,
        plan: { segments: [{ startSeconds: 0, endSeconds: 30 }] },
        revisionOfEditPlanId: null,
        revisionReason: "Chris re-planned after repair budget ran out",
      },
      { actorId: "chris" },
    );
    await startRendering(prisma, item.id, { actorId: "chris" });
    const render = await failingRender(item.id, fresh.id);
    expect(render.attempt).toBe(1);
    expect(await stateOf(item.id)).toBe("QC_REPAIR");
  });

  it("re-planning is rejected outside EDIT_PLANNED / QC_REPAIR", async () => {
    const { item, editPlan, selection } = await makeEditPlannedItem();
    await startRendering(prisma, item.id, { actorId: "chris" }); // EDITING
    await expect(
      recordReplannedEditPlan(
        prisma,
        {
          contentItemId: item.id,
          takeSelectionId: selection.id,
          productionTier: "FAST",
          targetDurationSeconds: 30,
          plan: {},
          revisionOfEditPlanId: editPlan.id,
          revisionReason: "x",
        },
        { actorId: "chris" },
      ),
    ).rejects.toBeInstanceOf(ReplanNotAllowedError);
  });
});

describe("manual transitions are an explicit allowlist", () => {
  it("rejects skipping a hard gate (RENDERED -> READY) and leaves the item untouched", async () => {
    const { item, editPlan } = await makeEditPlannedItem();
    await startRendering(prisma, item.id, { actorId: "chris" });
    await recordRenderAttempt(
      prisma,
      {
        contentItemId: item.id,
        editPlanId: editPlan.id,
        status: "SUCCESS",
        storageKey: `renders/${item.id}/ok.mp4`,
        technicalQCReport: { overall: "PASS", checks: [] },
      },
      { actorId: "system" },
    );
    expect(await stateOf(item.id)).toBe("RENDERED");
    expect(listManualTransitions("RENDERED")).toEqual([]);
    await expect(
      applyManualTransition(prisma, { contentItemId: item.id, to: "READY", actorId: "chris" }),
    ).rejects.toBeInstanceOf(ManualTransitionNotAllowedError);
    expect(await stateOf(item.id)).toBe("RENDERED");
  });

  it("allows the human-attested READY_TO_FILM -> FILMED step", async () => {
    const item = await createContentItem(prisma, { title: "Film attest" }, { actorId: "test-user" });
    for (const to of ["SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED", "READY_TO_FILM"] as const) {
      await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
    }
    await applyManualTransition(prisma, { contentItemId: item.id, to: "FILMED", actorId: "chris" });
    expect(await stateOf(item.id)).toBe("FILMED");
  });

  it("never offers a manual path into READY, PUBLISHED, RESEARCHED or SCRIPTED", async () => {
    const { MANUAL_TRANSITIONS } = await import("../manual-transition");
    const gatedTargets = new Set(["READY", "PUBLISHED", "PUBLISHING", "RESEARCHED", "SCRIPTED", "RENDERED", "SCHEDULED", "ARCHIVED"]);
    for (const t of MANUAL_TRANSITIONS) expect(gatedTargets.has(t.to)).toBe(false);
  });
});

describe("finishing edits from the in-app editor", () => {
  it("rolls a READY item back to EDIT_PLANNED and stores the timeline as a new plan version", async () => {
    const { item, editPlan } = await makeEditPlannedItem();
    await startRendering(prisma, item.id, { actorId: "chris" });
    await recordRenderAttempt(
      prisma,
      { contentItemId: item.id, editPlanId: editPlan.id, status: "SUCCESS", storageKey: `renders/${item.id}/a.mp4`, technicalQCReport: { overall: "PASS", checks: [] } },
      { actorId: "system" },
    );
    await applyTransition(prisma, { contentItemId: item.id, to: "READY", actorType: "SYSTEM" });

    const timeline = { version: 2, clips: [{ id: "c1", mediaAssetId: "m1", sourceStart: 0, sourceEnd: 12 }] };
    const saved = await saveFinishingEdit(prisma, { contentItemId: item.id, timeline, durationSeconds: 12, actorId: "chris", note: "tighter open" });

    expect(await stateOf(item.id)).toBe("EDIT_PLANNED");
    const latest = await getLatestEditPlan(prisma, item.id);
    expect(latest?.id).toBe(saved.id);
    expect((latest?.plan as { timeline?: unknown }).timeline).toEqual(timeline);
    expect(latest?.revisionOfEditPlanId).toBeNull();
    expect(latest?.revisionReason).toBe("Finishing edit by Chris: tighter open");
    expect(latest?.targetDurationSeconds).toBe(12);
    // The original plan is kept as history.
    expect(await prisma.editPlan.count({ where: { contentItemId: item.id } })).toBe(2);
  });

  it("refuses before there is anything to edit", async () => {
    const item = await createContentItem(prisma, { title: "No plan yet" }, { actorId: "test-user" });
    await expect(
      saveFinishingEdit(prisma, { contentItemId: item.id, timeline: {}, durationSeconds: 1, actorId: "chris" }),
    ).rejects.toBeInstanceOf(FinishingEditNotAllowedError);
  });
});
