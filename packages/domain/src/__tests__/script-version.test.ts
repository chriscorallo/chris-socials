import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import { applyPipelineResult, getLatestScriptVersion, type PipelineResultInput } from "../pipeline-run";
import {
  createHumanScriptVersion,
  recordScriptRegate,
  isScriptVersionFilmable,
  listScriptVersions,
  ScriptNotEditableError,
  ScriptRegateAlreadyRecordedError,
} from "../script-version";
import { createCreatorCardAndAdvance, ScriptNotClearedForFilmingError } from "../creator-card";

async function makeResearchingItem(title: string) {
  const item = await createContentItem(prisma, { title }, { actorId: "test-user" });
  for (const to of ["SELECTED", "CONTRACTED", "RESEARCHING"] as const) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
  }
  return item;
}

const research = {
  primaryClaim: "2026 401(k) limit",
  facts: [{ statement: "Limit is $24,500", type: "FACT", sourceUrl: "https://www.irs.gov/x" }],
  citations: [{ url: "https://www.irs.gov/x", title: "IRS", publisher: "IRS", publishedOrEffectiveDate: null, accessedDate: "2026-10-16", isPrimarySource: true }],
  numericInputs: [],
  calculationNotes: null,
  caveats: [],
  confidence: 0.9,
  contradictoryEvidence: [],
  prohibitedClaims: [],
  contentSafeWording: "safe",
  status: "READY" as const,
  stopResearching: true,
};

function script(text: string) {
  return {
    spokenScript: text,
    beats: [],
    intendedPauses: [],
    emphasizedWords: [],
    visualBeats: [],
    requiredFactualCaveats: [],
    targetRuntimeSeconds: 45,
    estimatedSpeakingRuntimeSeconds: 40.6,
    followUpIdeas: [],
  };
}
const PASS = { result: "PASS" as const, blockReason: null, requiredEdits: [], claims: [] };
const BLOCK = { result: "BLOCK" as const, blockReason: "Script invents an 87-point drop.", requiredEdits: [], claims: [] };

describe("applyPipelineResult — script-level Claims Gate", () => {
  it("READY with history: persists every gated version as an immutable revisedFromId chain", async () => {
    const item = await makeResearchingItem("history chain");
    const input: PipelineResultInput = {
      status: "READY",
      research,
      claimsGateResult: PASS,
      script: script("v2"),
      scriptClaimsGateResult: PASS,
      brandGuardianReport: { brandScore: 80 },
      scriptHistory: [
        { script: script("v1"), scriptClaimsGateResult: { ...PASS, result: "PASS_WITH_REQUIRED_EDIT", requiredEdits: ["fix"] }, brandGuardianReport: null, revisionNote: null },
        { script: script("v2"), scriptClaimsGateResult: PASS, brandGuardianReport: { brandScore: 80 }, revisionNote: "Claims Gate required edits applied: fix" },
      ],
    };
    const { scriptRow } = await applyPipelineResult(prisma, item.id, input, { actorId: "chris" });
    const versions = await listScriptVersions(prisma, item.id);
    expect(versions.map((v) => v.spokenScript)).toEqual(["v1", "v2"]);
    expect(versions[1]!.revisedFromId).toBe(versions[0]!.id);
    expect((versions[1]!.scriptClaimsGateResult as { result: string }).result).toBe("PASS");
    expect(scriptRow?.id).toBe(versions[1]!.id);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("SCRIPTED");
    const journal = await prisma.decisionJournalEntry.findFirst({ where: { evidenceIds: { array_contains: [scriptRow!.id] } } });
    expect(journal?.selectedDecision).toContain("Revision 1");
  });

  it("SCRIPT_BLOCKED: records the blocked script with its BLOCK result and routes to RESEARCH_BLOCKED", async () => {
    const item = await makeResearchingItem("script blocked");
    const { scriptRow, appliedStatus } = await applyPipelineResult(
      prisma,
      item.id,
      {
        status: "SCRIPT_BLOCKED",
        research,
        claimsGateResult: PASS,
        script: script("drops 87 points"),
        scriptClaimsGateResult: BLOCK,
        blockReason: "Script-level Claims Gate BLOCK: Script invents an 87-point drop.",
      },
      { actorId: "chris" },
    );
    expect(appliedStatus).toBe("SCRIPT_BLOCKED");
    expect((scriptRow!.scriptClaimsGateResult as { result: string }).result).toBe("BLOCK");
    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("RESEARCH_BLOCKED");
    const t = await prisma.contentStateTransition.findFirstOrThrow({ where: { contentItemId: item.id, toState: "RESEARCH_BLOCKED" } });
    expect(t.reason).toContain("87-point");
  });

  it("defense in depth: READY whose final script gate is not PASS is downgraded — never reaches SCRIPTED", async () => {
    const item = await makeResearchingItem("downgrade");
    const { appliedStatus } = await applyPipelineResult(
      prisma,
      item.id,
      { status: "READY", research, claimsGateResult: PASS, script: script("x"), scriptClaimsGateResult: BLOCK },
      { actorId: "chris" },
    );
    expect(appliedStatus).toBe("SCRIPT_BLOCKED");
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("RESEARCH_BLOCKED");
  });
});

describe("human script edits", () => {
  async function blockedItem(title: string) {
    const item = await makeResearchingItem(title);
    const { scriptRow } = await applyPipelineResult(
      prisma,
      item.id,
      { status: "SCRIPT_BLOCKED", research, claimsGateResult: PASS, script: script("bad 87 points"), scriptClaimsGateResult: BLOCK },
      { actorId: "chris" },
    );
    return { item, base: scriptRow! };
  }

  it("creates a NEW HUMAN version (history preserved), audited and journaled as a user override", async () => {
    const { item, base } = await blockedItem("human edit");
    const v = await createHumanScriptVersion(prisma, {
      contentItemId: item.id,
      baseScriptVersionId: base.id,
      spokenScript: "Paying it off can cause a small, temporary dip.",
      note: "Removed the invented number",
      actorId: "chris",
    });
    expect(v.authorType).toBe("HUMAN");
    expect(v.revisedFromId).toBe(base.id);
    expect(v.scriptClaimsGateResult).toBeNull();
    // Original untouched.
    expect((await prisma.scriptVersion.findUniqueOrThrow({ where: { id: base.id } })).spokenScript).toBe("bad 87 points");
    await prisma.auditLog.findFirstOrThrow({ where: { action: "SCRIPT_VERSION_HUMAN_EDIT", entityId: item.id } });
    const journal = await prisma.decisionJournalEntry.findFirstOrThrow({ where: { selectedDecision: `Human edit (ScriptVersion ${v.id})` } });
    expect(journal.userOverride).toBe(true);
    // Not filmable until re-gated.
    expect(isScriptVersionFilmable(v).ok).toBe(false);
  });

  it("a PASS re-gate on a fixed script walks RESEARCH_BLOCKED -> ... -> SCRIPTED; a verdict is never overwritten", async () => {
    const { item, base } = await blockedItem("regate pass");
    const v = await createHumanScriptVersion(prisma, { contentItemId: item.id, baseScriptVersionId: base.id, spokenScript: "fixed", actorId: "chris" });
    const { contentItemState } = await recordScriptRegate(prisma, { scriptVersionId: v.id, scriptClaimsGateResult: PASS, brandGuardianReport: { brandScore: 81 }, actorId: "chris" });
    expect(contentItemState).toBe("SCRIPTED");
    await expect(
      recordScriptRegate(prisma, { scriptVersionId: v.id, scriptClaimsGateResult: BLOCK, actorId: "chris" }),
    ).rejects.toBeInstanceOf(ScriptRegateAlreadyRecordedError);
  });

  it("a BLOCK re-gate leaves the item RESEARCH_BLOCKED", async () => {
    const { item, base } = await blockedItem("regate block");
    const v = await createHumanScriptVersion(prisma, { contentItemId: item.id, baseScriptVersionId: base.id, spokenScript: "still 87 points", actorId: "chris" });
    const { contentItemState } = await recordScriptRegate(prisma, { scriptVersionId: v.id, scriptClaimsGateResult: BLOCK, actorId: "chris" });
    expect(contentItemState).toBe("RESEARCH_BLOCKED");
  });

  it("the Creator Card (filming) gate refuses an un-regated human edit, then allows it once it PASSes", async () => {
    const item = await makeResearchingItem("card gate");
    await applyPipelineResult(prisma, item.id, { status: "READY", research, claimsGateResult: PASS, script: script("agent"), scriptClaimsGateResult: PASS }, { actorId: "chris" });
    const base = (await getLatestScriptVersion(prisma, item.id))!;
    const v = await createHumanScriptVersion(prisma, { contentItemId: item.id, baseScriptVersionId: base.id, spokenScript: "my words", actorId: "chris" });
    const card = { contentItemId: item.id, hook: "h", talkingPoints: ["a"], setup: "DESK" as const };
    await expect(createCreatorCardAndAdvance(prisma, card, { actorId: "chris" })).rejects.toBeInstanceOf(ScriptNotClearedForFilmingError);
    await recordScriptRegate(prisma, { scriptVersionId: v.id, scriptClaimsGateResult: PASS, actorId: "chris" });
    await createCreatorCardAndAdvance(prisma, card, { actorId: "chris" });
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("READY_TO_FILM");
  });

  it("refuses edits once filming has started", async () => {
    const item = await makeResearchingItem("not editable");
    await applyPipelineResult(prisma, item.id, { status: "READY", research, claimsGateResult: PASS, script: script("x"), scriptClaimsGateResult: PASS }, { actorId: "chris" });
    const base = (await getLatestScriptVersion(prisma, item.id))!;
    await applyTransition(prisma, { contentItemId: item.id, to: "READY_TO_FILM", actorType: "SYSTEM" });
    await expect(
      createHumanScriptVersion(prisma, { contentItemId: item.id, baseScriptVersionId: base.id, spokenScript: "y", actorId: "chris" }),
    ).rejects.toBeInstanceOf(ScriptNotEditableError);
  });
});
