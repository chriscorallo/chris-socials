import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { MockTranscriptionProvider } from "../providers/mock-transcription-provider";
import { runTakeSelectorAgent, TakeSelectionInvalidIdError } from "../take-selector-agent";
import { runEditPlannerAgent, EditPlanSegmentOutOfBoundsError } from "../edit-planner-agent";
import { runVisualQAAgent } from "../visual-qa-agent";
import { fixtureContract } from "./fixtures";

describe("Take Selector agent (mock provider — zero cost)", () => {
  const takes = [
    { mediaAssetId: "take-1", transcript: "First attempt, a bit rambly.", durationSeconds: 50 },
    { mediaAssetId: "take-2", transcript: "Cleaner, more confident delivery.", durationSeconds: 47 },
  ];

  it("returns a schema-valid selection and routes to MEDIUM", async () => {
    const provider = new MockModelProvider(() => ({
      selectedMediaAssetId: "take-2",
      backupMediaAssetId: "take-1",
      confidence: 0.8,
      reason: "Clearer delivery, no verbal stumbles.",
      materialDefects: [],
    }));

    const result = await runTakeSelectorAgent(provider, { takes, brandContext: "" });
    expect(result.selectedMediaAssetId).toBe("take-2");
    expect(provider.calls[0]?.modelClass).toBe("MEDIUM");
    expect(provider.calls[0]?.promptId).toBe("TAKE_SELECTOR");
  });

  it("rejects a selectedMediaAssetId not present in the candidate takes", async () => {
    const provider = new MockModelProvider(() => ({
      selectedMediaAssetId: "not-a-real-take",
      backupMediaAssetId: null,
      confidence: 0.5,
      reason: "x",
      materialDefects: [],
    }));

    await expect(
      runTakeSelectorAgent(provider, { takes, brandContext: "" }),
    ).rejects.toBeInstanceOf(TakeSelectionInvalidIdError);
  });

  it("rejects a backupMediaAssetId not present in the candidate takes", async () => {
    const provider = new MockModelProvider(() => ({
      selectedMediaAssetId: "take-1",
      backupMediaAssetId: "not-a-real-take",
      confidence: 0.5,
      reason: "x",
      materialDefects: [],
    }));

    await expect(
      runTakeSelectorAgent(provider, { takes, brandContext: "" }),
    ).rejects.toBeInstanceOf(TakeSelectionInvalidIdError);
  });

  it("refuses to run with zero candidate takes", async () => {
    const provider = new MockModelProvider(() => ({}));
    await expect(
      runTakeSelectorAgent(provider, { takes: [], brandContext: "" }),
    ).rejects.toThrow();
  });
});

describe("Edit Planner agent (mock provider — zero cost)", () => {
  const validPlan = {
    segments: [{ startSeconds: 2, endSeconds: 40 }],
    targetDimensions: { width: 1080, height: 1920 },
    textOverlays: [],
    normalizeAudio: true,
    bRollRequests: [],
    musicTrack: null,
    sfxEvents: [],
    transitions: [],
    targetDurationSeconds: 38,
    productionTier: "FAST" as const,
    doNothingElse: false,
    rationale: "Trim the rambling intro, keep the payoff.",
  };

  it("returns a schema-valid EditPlan and routes to MEDIUM (spec §16)", async () => {
    const provider = new MockModelProvider(() => validPlan);
    const result = await runEditPlannerAgent(provider, {
      contract: fixtureContract(),
      scriptText: "Here's the script.",
      takeTranscript: "the actual take transcript",
      sourceDurationSeconds: 50,
      brandContext: "",
    });
    expect(result.segments).toHaveLength(1);
    expect(provider.calls[0]?.modelClass).toBe("MEDIUM");
    expect(provider.calls[0]?.promptId).toBe("EDIT_PLANNER");
  });

  it("rejects a segment that ends past the source take's actual duration", async () => {
    const provider = new MockModelProvider(() => ({
      ...validPlan,
      segments: [{ startSeconds: 0, endSeconds: 999 }],
    }));

    await expect(
      runEditPlannerAgent(provider, {
        contract: fixtureContract(),
        scriptText: "script",
        takeTranscript: null,
        sourceDurationSeconds: 50,
        brandContext: "",
      }),
    ).rejects.toBeInstanceOf(EditPlanSegmentOutOfBoundsError);
  });

  it("skips the bounds check when the source duration is unknown", async () => {
    const provider = new MockModelProvider(() => ({
      ...validPlan,
      segments: [{ startSeconds: 0, endSeconds: 999 }],
    }));

    const result = await runEditPlannerAgent(provider, {
      contract: fixtureContract(),
      scriptText: "script",
      takeTranscript: null,
      sourceDurationSeconds: null,
      brandContext: "",
    });
    expect(result.segments[0]?.endSeconds).toBe(999);
  });

  it("allows doNothingElse=true as a valid, restrained plan", async () => {
    const provider = new MockModelProvider(() => ({
      ...validPlan,
      textOverlays: [],
      doNothingElse: true,
      rationale: "The raw take already delivers the point clearly — no additions earn their place.",
    }));
    const result = await runEditPlannerAgent(provider, {
      contract: fixtureContract(),
      scriptText: "script",
      takeTranscript: null,
      sourceDurationSeconds: 50,
      brandContext: "",
    });
    expect(result.doNothingElse).toBe(true);
  });
});

describe("Visual QA agent (mock provider — zero cost)", () => {
  const oneFrame = [{ atSeconds: 0, base64: "ZmFrZS1wbmctYnl0ZXM=", mediaType: "image/png" as const }];

  it("returns a schema-valid report and routes to MEDIUM, forwarding frames as images", async () => {
    const provider = new MockModelProvider(() => ({
      issues: [],
      overallImpression: "Clean render, no defects observed.",
    }));

    const result = await runVisualQAAgent(provider, {
      frames: oneFrame,
      durationSeconds: 4,
      productionTier: "FAST",
      textOverlaySummary: "(none)",
      brandContext: "",
    });

    expect(result.issues).toEqual([]);
    expect(provider.calls[0]?.modelClass).toBe("MEDIUM");
    expect(provider.calls[0]?.promptId).toBe("VISUAL_QA");
    expect(provider.calls[0]?.images).toHaveLength(1);
    expect(provider.calls[0]?.images?.[0]?.label).toBe("t=0.00s");
  });

  it("passes through issues the model reports, including BLOCKING severity", async () => {
    const provider = new MockModelProvider(() => ({
      issues: [
        {
          category: "FACE_OBSTRUCTION",
          description: "Caption covers the speaker's mouth.",
          severity: "BLOCKING",
          timestampSeconds: 1.5,
          recommendedRepair: "Move caption to TOP.",
        },
      ],
      overallImpression: "One blocking defect found.",
    }));

    const result = await runVisualQAAgent(provider, {
      frames: oneFrame,
      durationSeconds: 4,
      productionTier: "FAST",
      textOverlaySummary: "(none)",
      brandContext: "",
    });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.severity).toBe("BLOCKING");
  });

  it("refuses to run with zero frames — there is nothing to inspect", async () => {
    const provider = new MockModelProvider(() => ({ issues: [], overallImpression: "x" }));
    await expect(
      runVisualQAAgent(provider, {
        frames: [],
        durationSeconds: 4,
        productionTier: "FAST",
        textOverlaySummary: "(none)",
        brandContext: "",
      }),
    ).rejects.toThrow();
  });
});

describe("MockTranscriptionProvider", () => {
  it("returns the configured response and records the call", async () => {
    const provider = new MockTranscriptionProvider((filePath) => ({
      text: `transcript for ${filePath}`,
      language: "en",
      durationSeconds: 42,
    }));
    const result = await provider.transcribe("/tmp/take-1.mp4");
    expect(result.text).toBe("transcript for /tmp/take-1.mp4");
    expect(provider.calls).toEqual(["/tmp/take-1.mp4"]);
  });
});
