import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runLearningAgent } from "../learning-agent";
import { runAdversarialEvaluatorAgent } from "../adversarial-evaluator-agent";
import { runTasteLearnerAgent } from "../taste-learner-agent";
import { runExperimentAgent } from "../experiment-agent";
import { runWeeklyReviewAgent } from "../weekly-review-agent";

describe("Learning Agent (mock provider — zero cost)", () => {
  const evidence = [
    { id: "ev-1", statement: "Tuesday posts got 20% more views over 8 weeks.", sourceType: "PERFORMANCE_SNAPSHOT", confidence: 0.7 },
  ];

  it("returns a schema-valid proposal and routes to HIGH", async () => {
    const provider = new MockModelProvider(() => ({
      statement: "Tuesday posting performs better for finance content.",
      causalClaim: "Less short-form competition on Tuesdays in this niche.",
      isExperimentalEvidence: false,
      evidenceStatements: ["Tuesday posts got 20% more views over 8 weeks."],
      sampleSize: 12,
      applicablePlatform: null,
      applicableTopic: "finance",
      applicableFormat: null,
      confidence: 0.6,
      confounders: ["Small sample"],
      contradictoryEvidence: [],
      retestConditions: "Re-test after 20 more videos.",
    }));

    const result = await runLearningAgent(provider, { evidence, brandContext: "" });
    expect(result.statement).toContain("Tuesday");
    expect(provider.calls[0]?.modelClass).toBe("HIGH");
    expect(provider.calls[0]?.promptId).toBe("LEARNING_AGENT");
  });

  it("refuses to run with zero evidence", async () => {
    const provider = new MockModelProvider(() => ({}));
    await expect(runLearningAgent(provider, { evidence: [], brandContext: "" })).rejects.toThrow();
  });
});

describe("Adversarial Evaluator agent (mock provider — zero cost)", () => {
  it("returns a schema-valid critique and routes to HIGH", async () => {
    const provider = new MockModelProvider(() => ({
      concerns: [{ description: "x", whyItMatters: "y", evidence: "z" }],
      noMaterialWeaknessesFound: false,
    }));
    const result = await runAdversarialEvaluatorAgent(provider, {
      artifactType: "SCRIPT",
      artifactSummary: "A script about index funds.",
      brandContext: "",
    });
    expect(result.concerns).toHaveLength(1);
    expect(provider.calls[0]?.modelClass).toBe("HIGH");
    expect(provider.calls[0]?.promptId).toBe("ADVERSARIAL_EVALUATOR");
  });

  it("allows a clean result with no concerns", async () => {
    const provider = new MockModelProvider(() => ({ concerns: [], noMaterialWeaknessesFound: true }));
    const result = await runAdversarialEvaluatorAgent(provider, {
      artifactType: "SCRIPT",
      artifactSummary: "x",
      brandContext: "",
    });
    expect(result.noMaterialWeaknessesFound).toBe(true);
  });
});

describe("Taste Learner agent (mock provider — zero cost)", () => {
  const feedback = [
    { artifactType: "EDIT_PLAN", rawFeedback: "too corny", normalizedTag: "too_corny", productionTier: "FAST" },
    { artifactType: "EDIT_PLAN", rawFeedback: "still too corny", normalizedTag: "too_corny", productionTier: "FAST" },
  ];

  it("returns a schema-valid result and routes to MEDIUM", async () => {
    const provider = new MockModelProvider(() => ({
      probabilities: [
        { tag: "too_corny", context: { productionTier: "FAST", topic: null, format: null, platform: null }, probability: 0.2, sampleSize: 2, generalizes: false, confidence: 0.4 },
      ],
    }));
    const result = await runTasteLearnerAgent(provider, { artifactType: "EDIT_PLAN", feedback, brandContext: "" });
    expect(result.probabilities).toHaveLength(1);
    expect(provider.calls[0]?.modelClass).toBe("MEDIUM");
  });

  it("refuses to run with zero feedback", async () => {
    const provider = new MockModelProvider(() => ({ probabilities: [] }));
    await expect(
      runTasteLearnerAgent(provider, { artifactType: "EDIT_PLAN", feedback: [], brandContext: "" }),
    ).rejects.toThrow();
  });
});

describe("Experiment Agent (mock provider — zero cost)", () => {
  it("returns a schema-valid result with at least two variants per experiment", async () => {
    const provider = new MockModelProvider(() => ({
      experiments: [
        {
          hypothesis: "A number-forward hook increases 3s retention.",
          variants: [
            { label: "A", description: "Number-forward hook." },
            { label: "B", description: "Question hook." },
          ],
          confounders: ["Different topics"],
          minSampleSize: 10,
          minDurationDays: 7,
          portfolioMapping: "adjacent",
        },
      ],
    }));

    const result = await runExperimentAgent(provider, {
      weeklySlateSummary: "10 items this week.",
      priorExperiments: [],
      brandContext: "",
    });
    expect(result.experiments[0]?.variants).toHaveLength(2);
    expect(provider.calls[0]?.modelClass).toBe("MEDIUM");
  });
});

describe("Weekly Review / Learning Council agent (mock provider — zero cost)", () => {
  it("returns a schema-valid brief with candidate beliefs and routes to HIGH", async () => {
    const provider = new MockModelProvider(() => ({
      whatHappened: "A quiet week — no strong signal.",
      whatItMeans: "Not enough data to conclude anything meaningful yet.",
      stillUncertain: ["Whether Tuesday posting really performs better."],
      recommendationsForNextWeek: ["Keep current cadence."],
      candidateBeliefs: [],
    }));

    const result = await runWeeklyReviewAgent(provider, {
      weekSummary: "x",
      audienceSignalsSummary: "x",
      experimentsSummary: "x",
      productionCostSummary: "x",
      overridesSummary: "x",
      brandContext: "",
    });
    expect(result.whatHappened).toContain("quiet week");
    expect(provider.calls[0]?.modelClass).toBe("HIGH");
    expect(provider.calls[0]?.promptId).toBe("WEEKLY_REVIEW_LEARNING_COUNCIL");
  });

  it("a quiet week with no strong signal is a valid output, not forced into a fake takeaway", async () => {
    const provider = new MockModelProvider(() => ({
      whatHappened: "Nothing unusual happened.",
      whatItMeans: "No actionable pattern this week.",
      stillUncertain: [],
      recommendationsForNextWeek: [],
      candidateBeliefs: [],
    }));
    const result = await runWeeklyReviewAgent(provider, {
      weekSummary: "x",
      audienceSignalsSummary: "x",
      experimentsSummary: "x",
      productionCostSummary: "x",
      overridesSummary: "x",
      brandContext: "",
    });
    expect(result.candidateBeliefs).toEqual([]);
  });
});
