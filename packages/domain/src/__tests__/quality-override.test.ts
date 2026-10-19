import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import { createMediaAsset } from "../media-asset";
import { recordTakeSelection } from "../take-selection";
import { recordEditPlan } from "../edit-plan";
import { startRendering, recordRenderAttempt } from "../render-record";
import { listManualTransitions, MANUAL_TRANSITIONS, OWNER_GUARDED_TRANSITIONS, applyManualTransition, ManualTransitionNotAllowedError } from "../manual-transition";
import { scheduleContentItemForPublishing } from "../schedule";
import { recordLateQualityCheck, aggregateHardGates } from "../quality-gate";
import { runPreflight } from "../preflight";
import {
  applyOwnerQualityOverride,
  getQualityCheckMode,
  setQualityCheckMode,
  QualityOverrideNotAllowedError,
  FactualConfirmationRequiredError,
  renderPublishApproval,
  getAiCheckStatus,
  listAiCheckSkippedItemIds,
  aiUnavailableReason,
  AI_QUALITY_CHECKS,
  type OwnerQualityOverrideInput,
} from "../quality-override";

/**
 * Owner override "skip the AI quality check" (docs/decisions-pending/quality-override.md):
 * only with the owner's setting on, only after the technical gate passed on the exact render,
 * only with the per-video numbers confirmation when needed; always journaled + audited + a
 * HUMAN transition; preflight treats it as approval until a later AI check supersedes it.
 */

async function makeRenderedItem(technical: "PASS" | "FAIL" = "PASS") {
  const item = await createContentItem(prisma, { title: "Override test" }, { actorId: "test-user" });
  for (const to of ["SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED", "READY_TO_FILM", "FILMED", "MEDIA_INGESTED"] as const) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
  }
  const take = await createMediaAsset(
    prisma,
    { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/${item.id}/take-1.mp4`, originalFilename: "take-1.mp4", mimeType: "video/mp4", sizeBytes: 1 },
    { actorId: "chris" },
  );
  const selection = await recordTakeSelection(prisma, { contentItemId: item.id, selectedMediaAssetId: take.id, confidence: 0.9, reason: "best" }, { actorId: "chris" });
  const plan = await recordEditPlan(
    prisma,
    { contentItemId: item.id, takeSelectionId: selection.id, productionTier: "FAST", targetDurationSeconds: 30, plan: { segments: [{ startSeconds: 0, endSeconds: 30 }] } },
    { actorId: "chris" },
  );
  await startRendering(prisma, item.id, { actorId: "chris" });
  const render = await recordRenderAttempt(
    prisma,
    {
      contentItemId: item.id,
      editPlanId: plan.id,
      status: "SUCCESS",
      storageKey: `renders/${item.id}/r1.mp4`,
      technicalQCReport: { overall: technical, checks: [] },
      durationSeconds: 30,
      width: 1080,
      height: 1920,
      fileSizeBytes: 1_000_000,
    },
    { actorId: "system" },
  );
  return { item, render };
}

function input(contentItemId: string, renderId: string, over: Partial<OwnerQualityOverrideInput> = {}): OwnerQualityOverrideInput {
  return {
    contentItemId,
    actorId: "chris",
    trigger: "AI_UNAVAILABLE",
    aiUnavailableReason: "The AI account is out of credit",
    technical: { status: "PASS", renderId, issues: [] },
    skippedChecks: [AI_QUALITY_CHECKS.VISUAL_QA, AI_QUALITY_CHECKS.BRAND],
    unverifiedClaims: [],
    factualConfirmed: false,
    ...over,
  };
}

const stateOf = async (id: string) => (await prisma.contentItem.findUniqueOrThrow({ where: { id } })).currentState;

afterEach(async () => {
  await setQualityCheckMode(prisma, "FIRM", "test-reset");
});

describe("owner quality override", () => {
  it("defaults to Firm and refuses the override there — nothing is written", async () => {
    await setQualityCheckMode(prisma, "FIRM", "chris");
    expect(await getQualityCheckMode(prisma)).toBe("FIRM");
    const { item, render } = await makeRenderedItem();
    expect(await stateOf(item.id)).toBe("RENDERED");
    await expect(applyOwnerQualityOverride(prisma, input(item.id, render.id))).rejects.toBeInstanceOf(QualityOverrideNotAllowedError);
    expect(await stateOf(item.id)).toBe("RENDERED");
    expect(await prisma.qualityOverride.count({ where: { contentItemId: item.id } })).toBe(0);
  });

  it("with 'Let me skip it': RENDERED -> READY as a HUMAN decision, with journal + audit + transition rows", async () => {
    await setQualityCheckMode(prisma, "SKIP_ALLOWED", "chris");
    const { item, render } = await makeRenderedItem();
    const row = await applyOwnerQualityOverride(prisma, input(item.id, render.id));
    expect(await stateOf(item.id)).toBe("READY");
    expect(row).toMatchObject({ renderId: render.id, trigger: "AI_UNAVAILABLE", technicalStatus: "PASS", factualConfirmed: false, actorId: "chris" });

    const journal = await prisma.decisionJournalEntry.findUniqueOrThrow({ where: { id: row.decisionJournalEntryId! } });
    expect(journal.selectedDecision).toBe("Owner skipped AI quality check");
    expect(journal.userOverride).toBe(true);
    expect(journal.decisionOwner).toBe("Chris (owner)");
    expect(journal.rationale).toMatch(/out of credit/);
    expect((journal.alternatives as string[]).length).toBeGreaterThan(0);

    const audit = await prisma.auditLog.findMany({ where: { entityId: item.id, action: "QUALITY_AI_CHECK_SKIPPED_BY_OWNER" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorType).toBe("HUMAN");

    const t = await prisma.contentStateTransition.findFirstOrThrow({ where: { contentItemId: item.id, toState: "READY" } });
    expect(t).toMatchObject({ fromState: "RENDERED", actorType: "HUMAN", actorId: "chris" });
    expect(t.reason).toMatch(/Owner override: skip AI quality check/);
    // No QCReport claiming the AI gates passed is ever written.
    expect(await prisma.qCReport.count({ where: { renderId: render.id } })).toBe(0);
  });

  it("is idempotent per render (a retry returns the same row, one transition)", async () => {
    await setQualityCheckMode(prisma, "SKIP_ALLOWED", "chris");
    const { item, render } = await makeRenderedItem();
    const a = await applyOwnerQualityOverride(prisma, input(item.id, render.id));
    const b = await applyOwnerQualityOverride(prisma, input(item.id, render.id));
    expect(b.id).toBe(a.id);
    expect(await prisma.contentStateTransition.count({ where: { contentItemId: item.id, toState: "READY" } })).toBe(1);
  });

  it("needs the per-video numbers confirmation when unverified numbers are on screen", async () => {
    await setQualityCheckMode(prisma, "SKIP_ALLOWED", "chris");
    const { item, render } = await makeRenderedItem();
    const claims = ['On-screen text at 2.0s: "Save $30,000"'];
    await expect(applyOwnerQualityOverride(prisma, input(item.id, render.id, { unverifiedClaims: claims }))).rejects.toBeInstanceOf(FactualConfirmationRequiredError);
    expect(await stateOf(item.id)).toBe("RENDERED");
    const row = await applyOwnerQualityOverride(prisma, input(item.id, render.id, { unverifiedClaims: claims, factualConfirmed: true }));
    expect(row.factualConfirmed).toBe(true);
    expect(row.unverifiedClaims).toEqual(claims);
    const journal = await prisma.decisionJournalEntry.findUniqueOrThrow({ where: { id: row.decisionJournalEntryId! } });
    expect(journal.rationale).toMatch(/confirmed he checked/);
    expect(journal.rationale).toContain("$30,000");
  });

  it("a technical failure can't be overridden: stored render FAIL or a stale render id refuses", async () => {
    await setQualityCheckMode(prisma, "SKIP_ALLOWED", "chris");
    const { item, render } = await makeRenderedItem();
    await prisma.render.update({ where: { id: render.id }, data: { technicalQCReport: { overall: "FAIL", checks: [] } } });
    await expect(applyOwnerQualityOverride(prisma, input(item.id, render.id))).rejects.toThrow(/technical/);
    await prisma.render.update({ where: { id: render.id }, data: { technicalQCReport: { overall: "PASS", checks: [] } } });
    await expect(applyOwnerQualityOverride(prisma, input(item.id, "some-other-render"))).rejects.toThrow(/different render/);
    // Even a caller that lies about the type is re-checked.
    const lying = { ...input(item.id, render.id), technical: { status: "BLOCK", renderId: render.id, issues: [] } } as unknown as OwnerQualityOverrideInput;
    await expect(applyOwnerQualityOverride(prisma, lying)).rejects.toThrow(/technical/);
    expect(await stateOf(item.id)).toBe("RENDERED");
  });

  it("a render that failed its technical QC never even reaches RENDERED, so it can't be overridden", async () => {
    await setQualityCheckMode(prisma, "SKIP_ALLOWED", "chris");
    const { item, render } = await makeRenderedItem("FAIL");
    expect(await stateOf(item.id)).toBe("QC_REPAIR");
    await expect(applyOwnerQualityOverride(prisma, input(item.id, render.id))).rejects.toBeInstanceOf(QualityOverrideNotAllowedError);
  });

  it("an 'AI unavailable' override must say why", async () => {
    await setQualityCheckMode(prisma, "SKIP_ALLOWED", "chris");
    const { item, render } = await makeRenderedItem();
    await expect(applyOwnerQualityOverride(prisma, input(item.id, render.id, { aiUnavailableReason: "" }))).rejects.toThrow(/reason/);
    const row = await applyOwnerQualityOverride(prisma, input(item.id, render.id, { trigger: "OWNER_CHOICE", aiUnavailableReason: null }));
    expect(row.trigger).toBe("OWNER_CHOICE");
  });

  it("keeps the bare-button guarantee: no manual path into READY; the override is a separate guarded entry", async () => {
    expect(listManualTransitions("RENDERED")).toEqual([]);
    expect(MANUAL_TRANSITIONS.some((t) => t.to === "READY")).toBe(false);
    expect(OWNER_GUARDED_TRANSITIONS).toContainEqual(expect.objectContaining({ from: "RENDERED", to: "READY", label: "Owner override: skip AI quality check" }));
    await setQualityCheckMode(prisma, "SKIP_ALLOWED", "chris");
    const { item } = await makeRenderedItem();
    await expect(applyManualTransition(prisma, { contentItemId: item.id, to: "READY", actorId: "chris" })).rejects.toBeInstanceOf(ManualTransitionNotAllowedError);
  });

  it("aggregation is untouched: a BLOCK still can't be averaged away", () => {
    expect(aggregateHardGates({ factual: "BLOCK", technical: "PASS", brand: "PASS", creative: "PASS" }).overall).toBe("BLOCK");
  });

  it("schedules after the override, preflight accepts it, and the honest mark shows", async () => {
    await setQualityCheckMode(prisma, "SKIP_ALLOWED", "chris");
    const { item, render } = await makeRenderedItem();
    expect(await renderPublishApproval(prisma, render.id)).toMatchObject({ ok: false });
    await applyOwnerQualityOverride(prisma, input(item.id, render.id));
    await scheduleContentItemForPublishing(prisma, { contentItemId: item.id, scheduledDate: new Date(Date.now() + 86_400_000), targetPlatforms: ["YOUTUBE"] }, { actorId: "chris" });
    expect(await stateOf(item.id)).toBe("SCHEDULED");
    expect(await renderPublishApproval(prisma, render.id)).toEqual({ ok: true, via: "OWNER_OVERRIDE" });

    const pf = await runPreflight(prisma, { contentItemId: item.id, platform: "YOUTUBE", credentialsOk: true, mediaHash: "abc" });
    const reasons = pf.status === "BLOCK" ? pf.reasons : [];
    expect(reasons.some((r) => /QC check/.test(r))).toBe(false);
    // Other preflight checks still run (no package recorded here).
    expect(reasons.some((r) => /packaging check/.test(r))).toBe(true);

    expect((await getAiCheckStatus(prisma, item.id)).kind).toBe("SKIPPED");
    expect((await listAiCheckSkippedItemIds(prisma, [item.id])).has(item.id)).toBe(true);
  });

  it("'Run the AI check now' records a QCReport with no state change; a BLOCK then supersedes the override, a PASS clears the mark", async () => {
    await setQualityCheckMode(prisma, "SKIP_ALLOWED", "chris");
    const { item, render } = await makeRenderedItem();
    await applyOwnerQualityOverride(prisma, input(item.id, render.id));
    await scheduleContentItemForPublishing(prisma, { contentItemId: item.id, scheduledDate: new Date(Date.now() + 86_400_000), targetPlatforms: ["YOUTUBE"] }, { actorId: "chris" });

    await recordLateQualityCheck(
      prisma,
      { contentItemId: item.id, renderId: render.id, gates: { factual: "BLOCK", technical: "PASS", brand: "PASS", creative: "PASS" }, reasons: ["Unsourced number"] },
      { actorId: "chris" },
    );
    expect(await stateOf(item.id)).toBe("SCHEDULED");
    expect(await renderPublishApproval(prisma, render.id)).toMatchObject({ ok: false });
    const blocked = await getAiCheckStatus(prisma, item.id);
    expect(blocked).toMatchObject({ kind: "CHECKED_LATER", passed: false, reasons: ["Unsourced number"] });

    await recordLateQualityCheck(
      prisma,
      { contentItemId: item.id, renderId: render.id, gates: { factual: "PASS", technical: "PASS", brand: "PASS", creative: "PASS" } },
      { actorId: "chris" },
    );
    expect(await renderPublishApproval(prisma, render.id)).toEqual({ ok: true, via: "QC_PASS" });
    expect((await listAiCheckSkippedItemIds(prisma, [item.id])).has(item.id)).toBe(false);
  });

  it("the late check refuses a render the owner didn't override", async () => {
    const { item, render } = await makeRenderedItem();
    await expect(
      recordLateQualityCheck(prisma, { contentItemId: item.id, renderId: render.id, gates: { factual: "PASS", technical: "PASS", brand: "PASS", creative: "PASS" } }, { actorId: "chris" }),
    ).rejects.toThrow();
  });

  it("aiUnavailableReason maps no key / out of credit / spend cap, and nothing else", () => {
    expect(aiUnavailableReason({ name: "SpendCapExceededError", message: "x" })).toMatch(/spending limit/);
    expect(aiUnavailableReason({ message: "400 Your credit balance is too low to access the Anthropic API" })).toMatch(/out of credit/);
    expect(aiUnavailableReason({ message: "Could not resolve authentication method. Expected either apiKey or authToken" })).toMatch(/API key/);
    expect(aiUnavailableReason({ message: "ffmpeg exited with code 1" })).toBeNull();
    expect(aiUnavailableReason(null)).toBeNull();
  });
});
