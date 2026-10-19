import { describe, it, expect, afterEach } from "vitest";
import {
  prisma,
  createContentItem,
  applyTransition,
  createMediaAsset,
  recordTakeSelection,
  recordEditPlan,
  startRendering,
  recordRenderAttempt,
  setQualityCheckMode,
  QualityOverrideNotAllowedError,
  scheduleContentItemForPublishing,
  runPreflight,
} from "@chris/domain";
import { listUnverifiedClaims, precheckSkipAiQualityCheck, skipAiQualityCheckForContentItem } from "../quality-gate-job";

/**
 * The worker half of the owner override (docs/decisions-pending/quality-override.md): the
 * free deterministic checks (technical gate + collisions + unverified numbers) and the full
 * skip flow, with no model call and no video download.
 */

type Overlay = { text: string; startSeconds: number; endSeconds: number; position: "TOP" | "CENTER" | "BOTTOM"; style: "HEADLINE" | "CAPTION" | "NUMBER_CALLOUT" | "LOWER_THIRD" };

async function makeRenderedItem(textOverlays: Overlay[]) {
  const item = await createContentItem(prisma, { title: "Override job test" }, { actorId: "test-user" });
  for (const to of ["SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED", "READY_TO_FILM", "FILMED", "MEDIA_INGESTED"] as const) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
  }
  const take = await createMediaAsset(
    prisma,
    { contentItemId: item.id, kind: "RAW_TAKE", storageKey: `raw/${item.id}/t.mp4`, originalFilename: "t.mp4", mimeType: "video/mp4", sizeBytes: 1 },
    { actorId: "chris" },
  );
  const selection = await recordTakeSelection(prisma, { contentItemId: item.id, selectedMediaAssetId: take.id, confidence: 0.9, reason: "only" }, { actorId: "chris" });
  const plan = await recordEditPlan(
    prisma,
    {
      contentItemId: item.id,
      takeSelectionId: selection.id,
      productionTier: "FAST",
      targetDurationSeconds: 10,
      plan: {
        segments: [{ startSeconds: 0, endSeconds: 10 }],
        targetDimensions: { width: 1080, height: 1920 },
        textOverlays,
        captions: { enabled: false, style: "CLEAN", position: "LOWER" },
        normalizeAudio: true,
        bRollRequests: [],
        musicTrack: null,
        sfxEvents: [],
        transitions: [],
        targetDurationSeconds: 10,
        productionTier: "FAST",
        doNothingElse: false,
        rationale: "test",
      },
    },
    { actorId: "chris" },
  );
  await startRendering(prisma, item.id, { actorId: "chris" });
  await recordRenderAttempt(
    prisma,
    { contentItemId: item.id, editPlanId: plan.id, status: "SUCCESS", storageKey: `renders/${item.id}/r.mp4`, technicalQCReport: { overall: "PASS", checks: [] }, durationSeconds: 10, width: 1080, height: 1920, fileSizeBytes: 100_000 },
    { actorId: "system" },
  );
  return item;
}

const stateOf = async (id: string) => (await prisma.contentItem.findUniqueOrThrow({ where: { id } })).currentState;
const actor = { actorId: "chris" };

afterEach(async () => {
  await setQualityCheckMode(prisma, "FIRM", "test-reset");
});

describe("skip the AI quality check (owner override) — worker", () => {
  it("Firm (default): refused, the video stays RENDERED", async () => {
    const item = await makeRenderedItem([]);
    await expect(
      skipAiQualityCheckForContentItem(prisma, item.id, actor, { trigger: "AI_UNAVAILABLE", aiUnavailableReason: "The AI account is out of credit", factualConfirmed: false }),
    ).rejects.toBeInstanceOf(QualityOverrideNotAllowedError);
    expect(await stateOf(item.id)).toBe("RENDERED");
  });

  it("no numbers on screen: straight to READY, then schedulable; preflight treats it as approved", async () => {
    await setQualityCheckMode(prisma, "SKIP_ALLOWED", "chris");
    const item = await makeRenderedItem([{ text: "Here's the trick", startSeconds: 1, endSeconds: 3, position: "TOP", style: "HEADLINE" }]);
    const r = await skipAiQualityCheckForContentItem(prisma, item.id, actor, { trigger: "AI_UNAVAILABLE", aiUnavailableReason: "The AI account is out of credit", factualConfirmed: false });
    expect(r.status).toBe("READY");
    if (r.status !== "READY") return;
    // No fact-check or brand review on record (no AI ever ran) — recorded as skipped, honestly.
    expect(r.skippedChecks.join(" | ")).toMatch(/picture check/);
    expect(r.skippedChecks.join(" | ")).toMatch(/Brand & voice review \(none on record\)/);
    expect(r.skippedChecks.join(" | ")).toMatch(/fact-check/);
    expect(await stateOf(item.id)).toBe("READY");
    await scheduleContentItemForPublishing(prisma, { contentItemId: item.id, scheduledDate: new Date(Date.now() + 3600_000), targetPlatforms: ["TIKTOK"] }, actor);
    const pf = await runPreflight(prisma, { contentItemId: item.id, platform: "TIKTOK", credentialsOk: false, mediaHash: null });
    expect(pf.status).toBe("BLOCK");
    const reasons = pf.status === "BLOCK" ? pf.reasons : [];
    expect(reasons.some((x) => /QC check/.test(x))).toBe(false);
    // Credentials / hash checks still run.
    expect(reasons.some((x) => /credentials/.test(x))).toBe(true);
    expect(reasons.some((x) => /hash/.test(x))).toBe(true);
  });

  it("unverified numbers on screen need 'I've checked the numbers' — listed, then accepted and journaled", async () => {
    await setQualityCheckMode(prisma, "SKIP_ALLOWED", "chris");
    const item = await makeRenderedItem([{ text: "Save $30,000 a year", startSeconds: 2, endSeconds: 4, position: "TOP", style: "NUMBER_CALLOUT" }]);
    const first = await skipAiQualityCheckForContentItem(prisma, item.id, actor, { trigger: "OWNER_CHOICE", factualConfirmed: false });
    expect(first.status).toBe("NEEDS_FACTUAL_CONFIRMATION");
    if (first.status !== "NEEDS_FACTUAL_CONFIRMATION") return;
    expect(first.unverifiedClaims).toEqual(['On-screen text at 2.0s: "Save $30,000 a year"']);
    expect(await stateOf(item.id)).toBe("RENDERED");

    const second = await skipAiQualityCheckForContentItem(prisma, item.id, actor, { trigger: "OWNER_CHOICE", factualConfirmed: true });
    expect(second.status).toBe("READY");
    const row = await prisma.qualityOverride.findFirstOrThrow({ where: { contentItemId: item.id } });
    expect(row.factualConfirmed).toBe(true);
    const journal = await prisma.decisionJournalEntry.findUniqueOrThrow({ where: { id: row.decisionJournalEntryId! } });
    expect(journal.rationale).toContain("$30,000");
    expect(journal.rationale).toMatch(/Chris chose to skip it/);
  });

  it("a technical BLOCK (overlapping on-screen text) still blocks — never READY", async () => {
    await setQualityCheckMode(prisma, "SKIP_ALLOWED", "chris");
    const item = await makeRenderedItem([
      { text: "First headline", startSeconds: 1, endSeconds: 4, position: "TOP", style: "HEADLINE" },
      { text: "Second headline", startSeconds: 2, endSeconds: 5, position: "TOP", style: "HEADLINE" },
    ]);
    const pre = await precheckSkipAiQualityCheck(prisma, item.id);
    expect(pre.technical.status).toBe("BLOCK");
    const r = await skipAiQualityCheckForContentItem(prisma, item.id, actor, { trigger: "AI_UNAVAILABLE", aiUnavailableReason: "No Anthropic API key is set up", factualConfirmed: true });
    expect(r.status).toBe("TECHNICAL_BLOCK");
    if (r.status === "TECHNICAL_BLOCK") expect(r.reasons.join(" ")).toMatch(/First headline/);
    expect(await stateOf(item.id)).toBe("RENDERED");
    expect(await prisma.qualityOverride.count({ where: { contentItemId: item.id } })).toBe(0);
  });

  it("listUnverifiedClaims (pure): nothing when FACTUAL passes; grounded numbers don't count; digits only in speech", () => {
    const base = { claimsGateBlocked: false, factualBlockReason: null, ungroundedVisuals: [], allowedNumbers: [7] };
    expect(listUnverifiedClaims({ ...base, factualStatus: "PASS", texts: [{ text: "99%", start: 0 }], spoken: [] })).toEqual([]);
    expect(listUnverifiedClaims({ ...base, factualStatus: "BLOCK", texts: [{ text: "7 rules", start: 0 }], spoken: [{ text: "one more thing", start: 1 }] })).toEqual([]);
    expect(
      listUnverifiedClaims({ ...base, factualStatus: "BLOCK", texts: [], spoken: [{ text: "I paid 4,000 dollars", start: 3.25 }] }),
    ).toEqual(['You say at 3.3s: "I paid 4,000 dollars"']);
    expect(
      listUnverifiedClaims({ ...base, factualStatus: "BLOCK", claimsGateBlocked: true, factualBlockReason: "The 50% claim has no source.", texts: [], spoken: [] }),
    ).toEqual(["The fact-check flagged: The 50% claim has no source"]);
  });
});
