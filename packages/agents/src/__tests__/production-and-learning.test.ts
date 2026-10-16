import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { prisma, createContentItem, applyTransition, recordTasteFeedback, CreateProductionContractSchema, CreateCreatorCardSchema } from "@chris/domain";
import { MockModelProvider } from "../providers/mock-provider";
import {
  runProductionDirectorContractAgent,
  runProductionDirectorCreatorCardAgent,
  toCreateProductionContractInput,
  toCreateCreatorCardInput,
  draftAndIssueProductionContract,
  AutopilotDisabledError,
  type ProductionContractDraft,
} from "../production-director-agent";
import { refreshTasteModel } from "../taste-refresh";
import { getVoiceSamplesText } from "../brand-context";
import { runWeeklyStrategistAgent } from "../weekly-strategist-agent";
import { runCreativeDirectorAgent } from "../creative-director-agent";
import { fixtureBacklog, fixturePortfolioAllocation, fixtureWeeklyThesis } from "./fixtures";

const contractDraft = (o: Partial<ProductionContractDraft> = {}): ProductionContractDraft => ({
  purpose: "Acquisition",
  primaryIdea: "The 2026 401(k) limit, explained in 40 seconds",
  audiencePromise: "You'll know exactly how much you can put in this year",
  topic: "Retirement",
  format: "Talking head",
  productionTier: "FAST",
  targetLengthMinSeconds: 30,
  targetLengthMaxSeconds: 45,
  researchDepth: "STANDARD",
  factualRisk: "HIGH",
  experiment: null,
  platformOpportunities: ["instagram", "tiktok"],
  humanEditingBudgetMinutes: 10,
  requiredAssets: [],
  scope: "Employee deferral limit and age-50 catch-up only.",
  doNotExpandInto: "IRA limits, Roth vs traditional, employer match strategy.",
  rationale: "Number-driven claim that changes yearly -> HIGH risk, STANDARD research, FAST tier.",
  ...o,
});

describe("Production Director agent (mock provider — zero cost)", () => {
  it("drafts a contract that satisfies the domain's CreateProductionContractSchema", async () => {
    const provider = new MockModelProvider(() => contractDraft());
    const draft = await runProductionDirectorContractAgent(provider, { idea: { title: "401k limit" }, brandContext: "b" });
    expect(() => CreateProductionContractSchema.parse(toCreateProductionContractInput("item-1", draft))).not.toThrow();
    expect(provider.calls[0]?.promptId).toBe("PRODUCTION_DIRECTOR");
    expect(provider.calls[0]?.userPrompt).toContain("MODE: CONTRACT");
  });

  it("deterministically repairs an inverted min/max length", async () => {
    const provider = new MockModelProvider(() => contractDraft({ targetLengthMinSeconds: 60, targetLengthMaxSeconds: 30 }));
    const draft = await runProductionDirectorContractAgent(provider, { idea: { title: "x" }, brandContext: "" });
    expect([draft.targetLengthMinSeconds, draft.targetLengthMaxSeconds]).toEqual([30, 60]);
  });

  it("drafts a Creator Card that satisfies CreateCreatorCardSchema", async () => {
    const provider = new MockModelProvider(() => ({ hook: "You can put $24,500 in your 401(k) this year.", talkingPoints: ["limit", "catch-up"], setup: "DESK", estimatedMinutes: 10, notes: null }));
    const card = await runProductionDirectorCreatorCardAgent(provider, { spokenScript: "s", brandContext: "" });
    expect(() => CreateCreatorCardSchema.parse(toCreateCreatorCardInput("item-1", card))).not.toThrow();
    expect(provider.calls[0]?.userPrompt).toContain("MODE: CREATOR_CARD");
  });

  it("autopilot path is refused unless the feature flag is on (or a human triggered it), then issues + advances", async () => {
    const item = await createContentItem(prisma, { title: "PD autopilot" }, { actorId: "t" });
    await applyTransition(prisma, { contentItemId: item.id, to: "SELECTED", actorType: "SYSTEM" });
    const provider = new MockModelProvider(() => contractDraft());
    await expect(draftAndIssueProductionContract(prisma, provider, { contentItemId: item.id, actorId: "system" })).rejects.toBeInstanceOf(AutopilotDisabledError);

    const { contract } = await draftAndIssueProductionContract(prisma, provider, { contentItemId: item.id, actorId: "chris", triggeredByHuman: true });
    expect(contract.doNotExpandInto).toContain("IRA limits");
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).currentState).toBe("CONTRACTED");
    await prisma.decisionJournalEntry.findFirstOrThrow({ where: { evidenceIds: { array_contains: [contract.id] } } });
  });
});

describe("refreshTasteModel", () => {
  it("runs the Taste Learner per artifact type with enough feedback and appends probabilities", async () => {
    const artifactType = `SCRIPT_${randomUUID().slice(0, 6)}`;
    for (const raw of ["too corny", "way too corny"]) {
      await recordTasteFeedback(prisma, { artifactType, rawFeedback: raw, normalizedTag: "too_corny", productionTier: "FAST" }, { actorId: "chris" });
    }
    const provider = new MockModelProvider(() => ({
      probabilities: [{ tag: "too_corny", context: { productionTier: "FAST", topic: null, format: null, platform: null }, probability: 0.15, sampleSize: 2, generalizes: false, confidence: 0.4 }],
    }));
    const results = await refreshTasteModel(prisma, provider);
    expect(results.find((r) => r.artifactType === artifactType)).toMatchObject({ status: "UPDATED", recorded: 1 });
    const row = await prisma.chrisAcceptanceProbability.findFirstOrThrow({ where: { artifactType } });
    expect(row.context).toEqual({ productionTier: "FAST" });
  });
});

describe("strategy agents take the learning loop as input", () => {
  it("Creative Director and Weekly Strategist include strategic context; Strategist can propose new ideas", async () => {
    const cd = new MockModelProvider(() => fixtureWeeklyThesis());
    await runCreativeDirectorAgent(cd, { backlog: fixtureBacklog(), referenceContext: "", brandContext: "b", strategicContext: "## Strategic context\nBELIEF-XYZ" });
    expect(cd.calls[0]?.userPrompt).toContain("BELIEF-XYZ");

    const ws = new MockModelProvider(() =>
      fixturePortfolioAllocation({
        proposedNewIdeas: [{ title: "New", description: "d", pillar: null, topic: "t", format: "f", purpose: "p", productionTier: "RAW", primaryHypothesis: "h", whyThisWeek: "w", gapFilled: "g" }],
      }),
    );
    const out = await runWeeklyStrategistAgent(ws, { thesis: fixtureWeeklyThesis(), backlog: fixtureBacklog(), editingBudgetMinutesPerWeek: 300, brandContext: "", strategicContext: "BELIEF-XYZ", targetPortfolioSize: 12 });
    expect(out.proposedNewIdeas).toHaveLength(1);
    expect(ws.calls[0]?.userPrompt).toContain("about 12 videos");
  });
});

describe("voice samples", () => {
  it("returns nothing for the shipped empty scaffold, and only the text between markers once filled", () => {
    expect(getVoiceSamplesText()).toBe("");
    const dir = mkdtempSync(join(tmpdir(), "voice-"));
    const path = join(dir, "V.md");
    writeFileSync(path, "intro ignored\n<!-- SAMPLES START -->\n### Sample 1\nOkay look, here's the thing.\n<!-- SAMPLES END -->\n");
    expect(getVoiceSamplesText(path)).toBe("### Sample 1\nOkay look, here's the thing.");
  });
});
