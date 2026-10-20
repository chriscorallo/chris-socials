import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runFootageBriefAgent } from "../footage-brief-agent";
import { buildSystemPrompt } from "../prompt-context";

const brief = {
  series: "I_DID_THE_MATH",
  targetAudience: "25–35, first real salary",
  primaryObjective: "COMMENT",
  coreReaction: "wait, that's me",
  whyInteresting: "the car payment nobody counts",
  hooks: [
    { text: "The $900 car payment nobody wants to talk about.", mechanism: "PERSONAL_CONTRADICTION", onScreenText: "The $900 car payment", openingVisual: "3D car" },
    { text: "Is a car payment ever worth it?", mechanism: "IMPOSSIBLE_QUESTION", onScreenText: "Is it ever worth it?", openingVisual: "dilemma" },
  ],
  chosenHookIndex: 7,
  hookRationale: "the number stops the scroll",
  story: { hook: "The $900 car payment…", setup: "…", firstDiscovery: "…", midpointReversal: null, payoff: "…", ending: "What would you do?" },
  storyboard: { openingFrame: "car", onScreenText: ["The $900 car payment"], scenes: ["tape"], keyCalculations: ["900 × 72"], midpointVisual: null, payoffVisual: "total", closingFrame: "question" },
  engagement: { whyShare: "…", whyComment: "…", whyFollow: "…" },
  scorecard: [{ dimension: "hookStrength", score: 7 }],
  editorial: { strongest: "number", weakest: "ending", mostImportantRevision: "lead with the number", whatToTest: "title" },
  research: { verified: ["900 × 72 = 64,800"], assumptions: [], unverified: ["average car payment"], complianceFlags: [] },
};

describe("runFootageBriefAgent", () => {
  it("asks with the FOOTAGE_BRIEF prompt (full playbook), returns the typed brief, clamps the chosen hook", async () => {
    const provider = new MockModelProvider(() => brief);
    const out = await runFootageBriefAgent(provider, { transcript: "The $900 car payment nobody wants to talk about…", title: "Car payment", durationS: 62, brandContext: "brand" });
    expect(provider.calls[0]!.promptId).toBe("FOOTAGE_BRIEF");
    expect(provider.calls[0]!.userPrompt).toContain("The $900 car payment nobody wants to talk about");
    expect(out.series).toBe("I_DID_THE_MATH");
    expect(out.chosenHookIndex).toBe(1); // 7 is out of range → last hook
    const { systemPrompt } = buildSystemPrompt("FOOTAGE_BRIEF");
    expect(systemPrompt).toMatch(/Pick Your Poison|hook/i);
  });
});
