import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runAnalyticsAgent } from "../analytics-agent";
import {
  runAudienceIntelligenceAgent,
  AudienceInsightNotRecurringError,
} from "../audience-intelligence-agent";

describe("Analytics agent (mock provider — zero cost)", () => {
  const snapshots = [
    {
      platform: "YOUTUBE" as const,
      offset: "T_PLUS_24H",
      viewCount: 500,
      likeCount: 40,
      commentCount: 5,
      shareCount: null,
      saveCount: null,
      reach: null,
      avgWatchTimeSeconds: null,
    },
  ];

  function evaluation(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      categories: [
        { category: "ATTENTION", assessment: "Solid reach for this pillar.", confidence: 0.8, dataCompleteness: "PARTIAL" },
      ],
      overallSummary: "Reasonable early performance.",
      strategicallyValuableDespiteLowerViews: false,
      ...overrides,
    };
  }

  it("returns a schema-valid evaluation and routes to MEDIUM", async () => {
    const provider = new MockModelProvider(() => evaluation());
    const result = await runAnalyticsAgent(provider, {
      title: "Test video",
      snapshots,
      productionCost: { estimatedFilmingMinutes: 20, humanEditingBudgetMinutes: 45 },
      brandContext: "",
    });
    expect(result.categories[0]?.category).toBe("ATTENTION");
    expect(provider.calls[0]?.modelClass).toBe("MEDIUM");
    expect(provider.calls[0]?.promptId).toBe("ANALYTICS_AGENT");
  });

  it("formats an absent metric as unavailable, not zero, in the prompt sent to the model", async () => {
    const provider = new MockModelProvider(() => evaluation());
    await runAnalyticsAgent(provider, {
      title: "Test video",
      snapshots,
      productionCost: { estimatedFilmingMinutes: null, humanEditingBudgetMinutes: null },
      brandContext: "",
    });
    const prompt = provider.calls[0]?.userPrompt ?? "";
    expect(prompt).toContain("shares=not available from this platform");
    expect(prompt).not.toContain("shares=0");
  });

  it("refuses to run with zero snapshots", async () => {
    const provider = new MockModelProvider(() => evaluation());
    await expect(
      runAnalyticsAgent(provider, {
        title: "x",
        snapshots: [],
        productionCost: { estimatedFilmingMinutes: null, humanEditingBudgetMinutes: null },
        brandContext: "",
      }),
    ).rejects.toThrow();
  });
});

describe("Audience Intelligence agent (mock provider — zero cost)", () => {
  const comments = [
    { platform: "YOUTUBE" as const, authorHandle: "@a", text: "Does this work for a Roth IRA?" },
    { platform: "INSTAGRAM" as const, authorHandle: "@b", text: "What about Roth accounts specifically?" },
  ];

  it("returns a schema-valid result and routes to LOW", async () => {
    const provider = new MockModelProvider(() => ({
      insights: [
        {
          category: "questions",
          description: "Viewers repeatedly ask about Roth IRA applicability.",
          supportingCommentCount: 2,
          exampleQuotes: ["Does this work for a Roth IRA?"],
          actionableSuggestion: "Make a Roth-specific follow-up.",
        },
      ],
    }));

    const result = await runAudienceIntelligenceAgent(provider, { comments, brandContext: "" });
    expect(result.insights).toHaveLength(1);
    expect(provider.calls[0]?.modelClass).toBe("LOW");
    expect(provider.calls[0]?.promptId).toBe("AUDIENCE_INTELLIGENCE");
  });

  it("rejects an insight backed by only one comment — an anecdote, not a pattern", async () => {
    const provider = new MockModelProvider(() => ({
      insights: [
        {
          category: "objections",
          description: "One viewer disagreed.",
          supportingCommentCount: 1,
          exampleQuotes: ["I disagree"],
          actionableSuggestion: null,
        },
      ],
    }));

    await expect(runAudienceIntelligenceAgent(provider, { comments, brandContext: "" })).rejects.toBeInstanceOf(
      AudienceInsightNotRecurringError,
    );
  });

  it("refuses to run with zero comments", async () => {
    const provider = new MockModelProvider(() => ({ insights: [] }));
    await expect(runAudienceIntelligenceAgent(provider, { comments: [], brandContext: "" })).rejects.toThrow();
  });
});
