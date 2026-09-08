import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import {
  applyPipelineResult,
  getLatestResearchPacket,
  getLatestScriptVersion,
  PipelineRequiresResearchingStateError,
  type PipelineResultInput,
} from "../pipeline-run";

async function makeResearchingItem() {
  const item = await createContentItem(prisma, { title: "Pipeline test idea" }, {
    actorId: "test-user",
  });
  for (const to of ["SELECTED", "CONTRACTED", "RESEARCHING"] as const) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
  }
  return item;
}

const baseResearch = {
  primaryClaim: "test claim",
  facts: [{ statement: "x", type: "FACT" }],
  citations: ["source"],
  numericInputs: [],
  calculationNotes: null,
  caveats: [],
  confidence: 0.8,
  contradictoryEvidence: [],
  prohibitedClaims: [],
  contentSafeWording: "safe wording",
  stopResearching: true,
};

describe("applyPipelineResult", () => {
  it("READY: persists the research packet + script, advances RESEARCHING -> SCRIPTED", async () => {
    const item = await makeResearchingItem();
    const result: PipelineResultInput = {
      status: "READY",
      research: { ...baseResearch, status: "READY" },
      claimsGateResult: { result: "PASS" },
      script: {
        spokenScript: "Here's the script.",
        beats: [{ label: "HOOK", text: "hi" }],
        intendedPauses: [],
        emphasizedWords: [],
        visualBeats: [],
        requiredFactualCaveats: [],
        targetRuntimeSeconds: 45,
        estimatedSpeakingRuntimeSeconds: 40,
        followUpIdeas: [],
      },
      brandGuardianReport: { brandScore: 80 },
    };

    const { researchRow, scriptRow } = await applyPipelineResult(prisma, item.id, result, {
      actorId: "chris",
    });

    expect(researchRow.status).toBe("READY");
    expect(scriptRow?.spokenScript).toBe("Here's the script.");

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("SCRIPTED");

    const latestResearch = await getLatestResearchPacket(prisma, item.id);
    expect(latestResearch?.id).toBe(researchRow.id);
    const latestScript = await getLatestScriptVersion(prisma, item.id);
    expect(latestScript?.id).toBe(scriptRow?.id);
  });

  it("RESEARCH_BLOCKED: persists the packet, transitions to RESEARCH_BLOCKED, never creates a script", async () => {
    const item = await makeResearchingItem();
    const result: PipelineResultInput = {
      status: "RESEARCH_BLOCKED",
      research: { ...baseResearch, status: "READY" },
      claimsGateResult: { result: "BLOCK", blockReason: "Unsupported numeric claim." },
    };

    const { scriptRow } = await applyPipelineResult(prisma, item.id, result, {
      actorId: "chris",
    });

    expect(scriptRow).toBeNull();
    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("RESEARCH_BLOCKED");

    const transitions = await prisma.contentStateTransition.findMany({
      where: { contentItemId: item.id, toState: "RESEARCH_BLOCKED" },
    });
    expect(transitions[0]?.reason).toBe("Unsupported numeric claim.");
  });

  it("NEEDS_MORE_RESEARCH: persists the packet, stays in RESEARCHING (no transition)", async () => {
    const item = await makeResearchingItem();
    const result: PipelineResultInput = {
      status: "NEEDS_MORE_RESEARCH",
      research: { ...baseResearch, status: "NEEDS_MORE_RESEARCH", stopResearching: false },
    };

    await applyPipelineResult(prisma, item.id, result, { actorId: "chris" });

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("RESEARCHING");
  });

  it("rejects application to a ContentItem not currently in RESEARCHING", async () => {
    const item = await createContentItem(prisma, { title: "Wrong state test" }, {
      actorId: "test-user",
    });
    const result: PipelineResultInput = {
      status: "NEEDS_MORE_RESEARCH",
      research: { ...baseResearch, status: "NEEDS_MORE_RESEARCH", stopResearching: false },
    };

    await expect(
      applyPipelineResult(prisma, item.id, result, { actorId: "chris" }),
    ).rejects.toBeInstanceOf(PipelineRequiresResearchingStateError);
  });
});
