import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runReferenceIntelligenceAgent } from "../reference-intelligence-agent";
import { runCreativeDirectorAgent } from "../creative-director-agent";
import {
  runWeeklyStrategistAgent,
  PortfolioAllocationInvalidIdsError,
} from "../weekly-strategist-agent";
import {
  fixtureBacklog,
  fixtureReferenceIntelligenceResult,
  fixtureWeeklyThesis,
  fixturePortfolioAllocation,
} from "./fixtures";

describe("Reference Intelligence agent (mock provider — zero cost)", () => {
  it("returns schema-valid observations and routes to MEDIUM", async () => {
    const provider = new MockModelProvider(() => fixtureReferenceIntelligenceResult());
    const result = await runReferenceIntelligenceAgent(provider, {
      content: {
        creatorName: "Jun Yuh",
        description: "Opens with a dollar figure, cuts every 2s.",
      },
      brandContext: "",
    });
    expect(result.observations.length).toBeGreaterThan(0);
    expect(provider.calls[0]?.modelClass).toBe("MEDIUM");
    expect(provider.calls[0]?.promptId).toBe("REFERENCE_INTELLIGENCE");
  });
});

describe("Creative Director agent (mock provider — zero cost)", () => {
  it("returns a schema-valid WeeklyProgrammingThesis and routes to HIGH", async () => {
    const provider = new MockModelProvider(() => fixtureWeeklyThesis());
    const result = await runCreativeDirectorAgent(provider, {
      backlog: fixtureBacklog(),
      referenceContext: "",
      brandContext: "brand context",
    });
    expect(result.thesis.length).toBeGreaterThan(0);
    expect(provider.calls[0]?.modelClass).toBe("HIGH");
  });

  it("includes the real backlog ids in the user prompt", async () => {
    const provider = new MockModelProvider((req) => {
      expect(req.userPrompt).toContain("[idea-1]");
      expect(req.userPrompt).toContain("[idea-2]");
      return fixtureWeeklyThesis();
    });
    await runCreativeDirectorAgent(provider, {
      backlog: fixtureBacklog(),
      referenceContext: "",
      brandContext: "",
    });
  });
});

describe("Weekly Strategist agent (mock provider — zero cost)", () => {
  it("returns a schema-valid portfolio allocation using real backlog ids", async () => {
    const provider = new MockModelProvider(() => fixturePortfolioAllocation());
    const result = await runWeeklyStrategistAgent(provider, {
      thesis: fixtureWeeklyThesis(),
      backlog: fixtureBacklog(),
      editingBudgetMinutesPerWeek: 300,
      brandContext: "",
    });
    expect(result.items[0]?.contentItemId).toBe("idea-1");
    expect(provider.calls[0]?.modelClass).toBe("HIGH");
  });

  it("rejects an allocation that references a contentItemId not in the backlog", async () => {
    const provider = new MockModelProvider(() =>
      fixturePortfolioAllocation({
        items: [
          {
            contentItemId: "not-a-real-id",
            purpose: "Acquisition",
            pillar: null,
            topic: "Credit",
            subtopic: null,
            format: "Talking head",
            productionTier: "FAST",
            targetLengthSeconds: 45,
            primaryHypothesis: "x",
            historicalAnalogue: null,
            referenceInfluence: null,
            whyThisWeek: "x",
            duplicateRisk: null,
            researchBurden: null,
            productionBurden: null,
            selected: true,
          },
        ],
      }),
    );

    await expect(
      runWeeklyStrategistAgent(provider, {
        thesis: fixtureWeeklyThesis(),
        backlog: fixtureBacklog(),
        editingBudgetMinutesPerWeek: 300,
        brandContext: "",
      }),
    ).rejects.toBeInstanceOf(PortfolioAllocationInvalidIdsError);
  });

  it("mentions the human editing budget in the prompt", async () => {
    const provider = new MockModelProvider((req) => {
      expect(req.userPrompt).toContain("300 minutes/week");
      return fixturePortfolioAllocation();
    });
    await runWeeklyStrategistAgent(provider, {
      thesis: fixtureWeeklyThesis(),
      backlog: fixtureBacklog(),
      editingBudgetMinutesPerWeek: 300,
      brandContext: "",
    });
  });
});
