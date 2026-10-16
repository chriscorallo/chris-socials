import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runEditPlannerAgent } from "../edit-planner-agent";
import { runTakeSelectorAgent, summarizeDelivery } from "../take-selector-agent";
import { EditPlanOutputSchema } from "../schemas";
import { fixtureContract } from "./fixtures";

const words = [
  { word: "Okay", start: 0.5, end: 0.8 },
  { word: "so.", start: 0.8, end: 1.0 },
  { word: "Most", start: 2.0, end: 2.2 },
  { word: "people", start: 2.2, end: 2.5 },
  { word: "think", start: 2.5, end: 2.9 },
  { word: "wrong.", start: 2.9, end: 3.3 },
];

const plan = {
  segments: [{ startSeconds: 2.1, endSeconds: 3.1 }], // mid-word on both ends
  targetDimensions: { width: 1080, height: 1920 },
  textOverlays: [],
  captions: { enabled: true, style: "CLEAN" as const, position: "LOWER" as const },
  punchIns: [{ startSeconds: 0.2, endSeconds: 0.8, zoom: 1.15, focus: "UPPER_THIRD" as const }],
  normalizeAudio: true,
  bRollRequests: [],
  musicTrack: null,
  sfxEvents: [],
  transitions: [],
  targetDurationSeconds: 1.5,
  productionTier: "FAST" as const,
  doNothingElse: false,
  rationale: "Keep the thesis line.",
};

describe("Edit Planner with word timings", () => {
  it("shows the model timestamped phrases and snaps its cut points to word boundaries", async () => {
    const provider = new MockModelProvider(() => plan);
    const result = await runEditPlannerAgent(provider, {
      contract: fixtureContract(),
      scriptText: "script",
      takeTranscript: "Okay so. Most people think wrong.",
      takeWords: words,
      sourceDurationSeconds: 5,
      brandContext: "",
    });
    const prompt = provider.calls[0]!.userPrompt;
    expect(prompt).toContain("[2.00-3.30] (pause 1.00s before) Most people think wrong.");
    expect(prompt).toContain("NOT executed yet");
    expect(result.segments[0]!.startSeconds).toBeCloseTo(1.92, 3);
    expect(result.segments[0]!.endSeconds).toBeCloseTo(3.45, 3);
    expect(result.rationale).toContain("snapped to word boundaries");
    expect(result.captions?.style).toBe("CLEAN");
    expect(result.punchIns).toHaveLength(1);
  });

  it("includes the previous plan and QC issues in a repair pass", async () => {
    const provider = new MockModelProvider(() => plan);
    await runEditPlannerAgent(provider, {
      contract: fixtureContract(),
      scriptText: "script",
      takeTranscript: null,
      sourceDurationSeconds: 5,
      brandContext: "",
      repairContext: {
        previousPlan: EditPlanOutputSchema.parse(plan),
        qcIssues: [
          {
            category: "FACE_OBSTRUCTION",
            severity: "BLOCKING",
            description: "Headline covers the eyes",
            timestampSeconds: 0.4,
            recommendedRepair: "Move headline to BOTTOM",
          },
        ],
      },
    });
    const prompt = provider.calls[0]!.userPrompt;
    expect(prompt).toContain("REPAIR PASS");
    expect(prompt).toContain("minimum change");
    expect(prompt).toContain("[BLOCKING] FACE_OBSTRUCTION @ 0.4s: Headline covers the eyes");
    expect(prompt).toContain('"rationale": "Keep the thesis line."');
  });

  it("still parses EditPlans persisted before captions/punchIns existed", () => {
    const legacy: Record<string, unknown> = { ...plan };
    delete legacy.captions;
    delete legacy.punchIns;
    const parsed = EditPlanOutputSchema.parse(legacy);
    expect(parsed.captions).toBeNull();
    expect(parsed.punchIns).toEqual([]);
  });

  it("rejects an out-of-range punch-in zoom", () => {
    expect(() =>
      EditPlanOutputSchema.parse({ ...plan, punchIns: [{ startSeconds: 0, endSeconds: 1, zoom: 2, focus: "CENTER" }] }),
    ).toThrow();
  });
});

describe("Take Selector with word timings", () => {
  it("gives the model measured delivery stats and a timestamped transcript", async () => {
    const provider = new MockModelProvider(() => ({
      selectedMediaAssetId: "take-1",
      backupMediaAssetId: null,
      confidence: 0.7,
      reason: "Only take.",
      materialDefects: [],
    }));
    await runTakeSelectorAgent(provider, {
      takes: [{ mediaAssetId: "take-1", transcript: "x", durationSeconds: 5, words }],
      brandContext: "",
    });
    const prompt = provider.calls[0]!.userPrompt;
    expect(prompt).toMatch(/Delivery \(measured\): \d+ wpm, leading silence 0.5s, trailing silence 1.7s, longest pause 1s/);
    expect(prompt).toContain("[0.50-1.00] Okay so.");
  });

  it("summarizeDelivery is deterministic arithmetic", () => {
    expect(summarizeDelivery(words, 5)).toEqual({
      wordsPerMinute: 129,
      leadingSilenceSeconds: 0.5,
      trailingSilenceSeconds: 1.7,
      longestPauseSeconds: 1,
      pausesOver1s: 0,
    });
  });
});
