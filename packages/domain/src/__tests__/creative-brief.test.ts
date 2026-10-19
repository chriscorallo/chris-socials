import { describe, it, expect } from "vitest";
import { prisma, createContentItemFromFootage } from "../index";
import { recordCreativeBrief, getLatestCreativeBrief, formatCreativeBrief, CreativeBriefSchema } from "../creative-brief";

export const sampleBrief = () => ({
  series: "Pick Your Poison",
  targetAudience: "20s–30s earners who think a raise means rich",
  primaryObjective: "comment",
  coreReaction: "Wait, which one is actually better?",
  whyInteresting: "Everyone has an instant answer, and the math changes it.",
  hooks: [
    { text: "$500K at 25 or $5 million at 45. You only get one.", mechanism: "impossible choice", onScreenText: "$500K @25 vs $5M @45", openingVisual: "two huge numbers split-screen" },
    { text: "Five hundred grand at 25 might beat five million at 45.", mechanism: "PERSONAL_CONTRADICTION", onScreenText: "$500K > $5M?", openingVisual: "Chris pointing at the smaller number" },
    { text: "Would you trade twenty years of freedom for ten times more money?", mechanism: "made-up-family", onScreenText: "20 years vs 10x", openingVisual: "a calendar flipping" },
  ],
  chosenHookIndex: 0,
  hookRationale: "Instantly clear and forces a decision before the math.",
  story: { hook: "the choice", setup: "assume 7% average returns, not guaranteed", firstDiscovery: "$500K compounds to about $1.9M by 45", midpointReversal: "but the real gap is twenty years of options", payoff: "depends on what you'd do with the time", ending: "Did the math change your answer?" },
  storyboard: { openingFrame: "$500K vs $5M", onScreenText: ["$500K @ 25", "$5M @ 45"], scenes: ["growth line"], keyCalculations: ["500000 × 1.07^20 ≈ 1.93M"], midpointVisual: "20-year calendar", payoffVisual: "both bars side by side", closingFrame: "Which one?" },
  engagement: { whyShare: "settles a friend debate", whyComment: "people defend their pick", whyFollow: "more dilemmas like this" },
  scorecard: { hookStrength: 8, followerConversion: 6 },
  editorial: { strongest: "the choice", weakest: "returns assumption", mostImportantRevision: "say 'not guaranteed' once", whatToTest: "comment rate vs a math-first hook" },
  research: { verified: [], assumptions: ["7% average return"], unverified: ["1.93M figure needs a check"], complianceFlags: [] },
});

describe("Creative Brief", () => {
  it("normalises drifting labels (series, objective, mechanisms) instead of failing", () => {
    const b = CreativeBriefSchema.parse(sampleBrief());
    expect(b.series).toBe("PICK_YOUR_POISON");
    expect(b.primaryObjective).toBe("COMMENT");
    expect(b.hooks.map((h) => h.mechanism)).toEqual(["IMPOSSIBLE_CHOICE", "PERSONAL_CONTRADICTION", "IMPOSSIBLE_QUESTION"]);
  });

  it("is append-only, sets the item's series, and the latest one is what bots read", async () => {
    const it0 = await createContentItemFromFootage(prisma, { title: `Brief ${Date.now()}` }, { actorId: "chris" });
    await recordCreativeBrief(prisma, { contentItemId: it0.id, source: "CHATGPT", brief: sampleBrief() }, { actorId: "chris" });
    await recordCreativeBrief(prisma, { contentItemId: it0.id, source: "AGENT", brief: { ...sampleBrief(), series: "I_DID_THE_MATH", chosenHookIndex: 9 } }, { actorId: "pipeline" });
    expect(await prisma.creativeBrief.count({ where: { contentItemId: it0.id } })).toBe(2);
    const latest = (await getLatestCreativeBrief(prisma, it0.id))!;
    expect(latest.series).toBe("I_DID_THE_MATH");
    expect(latest.chosenHookIndex).toBe(2); // out of range → clamped to the last hook
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: it0.id } })).series).toBe("I_DID_THE_MATH");
    const text = formatCreativeBrief(latest);
    expect(text).toContain("Series: I Did The Math · Ending objective: COMMENT");
    expect(text).toContain("midpoint → but the real gap is twenty years of options");
    expect(text).toContain("Unverified (don't present as fact): 1.93M figure needs a check");
  });
});

describe("Creative Brief from the in-app script pipeline", () => {
  it("applyPipelineResult records the Script Agent's brief next to the final script (scorecard list → record)", async () => {
    const { applyPipelineResult } = await import("../pipeline-run");
    const { applyTransition } = await import("../state-machine");
    const { createContentItem } = await import("../content-item");
    const item = await createContentItem(prisma, { title: `Pipeline brief ${Date.now()}` }, { actorId: "t" });
    for (const to of ["SELECTED", "CONTRACTED", "RESEARCHING"] as const) await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
    const brief = { ...sampleBrief(), scorecard: [{ dimension: "hookStrength", score: 8 }, { dimension: "payoffQuality", score: 12 }] };
    const { scriptRow } = await applyPipelineResult(
      prisma,
      item.id,
      {
        status: "READY",
        research: { primaryClaim: "c", facts: [], citations: [], numericInputs: [], calculationNotes: null, caveats: [], confidence: 0.9, contradictoryEvidence: [], prohibitedClaims: [], contentSafeWording: "c", status: "READY", stopResearching: true },
        claimsGateResult: { result: "PASS" },
        script: { spokenScript: "$500K at 25 or $5 million at 45.", beats: [], intendedPauses: [], emphasizedWords: [], visualBeats: [], requiredFactualCaveats: [], targetRuntimeSeconds: 45, estimatedSpeakingRuntimeSeconds: 44, followUpIdeas: [], creativeBrief: brief },
      },
      { actorId: "pipeline" },
    );
    const latest = (await getLatestCreativeBrief(prisma, item.id))!;
    expect(latest.source).toBe("AGENT");
    expect(latest.scorecard).toEqual({ hookStrength: 8, payoffQuality: 10 });
    expect((await prisma.creativeBrief.findFirstOrThrow({ where: { contentItemId: item.id } })).scriptVersionId).toBe(scriptRow!.id);
  });
});
