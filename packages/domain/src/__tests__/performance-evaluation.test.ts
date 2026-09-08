import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { recordPerformanceEvaluation, getLatestPerformanceEvaluation } from "../performance-evaluation";

describe("recordPerformanceEvaluation", () => {
  it("persists a full evaluation and is append-only across re-runs", async () => {
    const item = await createContentItem(prisma, { title: "Performance evaluation test" }, { actorId: "test" });

    await recordPerformanceEvaluation(
      prisma,
      {
        contentItemId: item.id,
        overallSummary: "Early performance is modest but on-brand.",
        strategicallyValuableDespiteLowerViews: false,
        categories: [
          { category: "ATTENTION", assessment: "Below average reach.", confidence: 0.7, dataCompleteness: "PARTIAL" },
        ],
      },
      { actorId: "chris" },
    );
    const second = await recordPerformanceEvaluation(
      prisma,
      {
        contentItemId: item.id,
        overallSummary: "A week later, relationship signals are strong.",
        strategicallyValuableDespiteLowerViews: true,
        categories: [
          { category: "RELATIONSHIP", assessment: "High repeat-viewer rate.", confidence: 0.6, dataCompleteness: "COMPLETE" },
        ],
      },
      { actorId: "chris" },
    );

    const latest = await getLatestPerformanceEvaluation(prisma, item.id);
    expect(latest?.id).toBe(second.id);
    expect(latest?.strategicallyValuableDespiteLowerViews).toBe(true);

    const all = await prisma.performanceEvaluation.findMany({ where: { contentItemId: item.id } });
    expect(all).toHaveLength(2); // both kept — episodic memory, not overwritten
  });
});
