import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runHookPickerAgent } from "../hook-picker-agent";
import { runVisualStrategistAgent } from "../visual-strategist-agent";
import { runPlatformPackagingAgent } from "../platform-packaging-agent";
import { runTakeSelectorAgent } from "../take-selector-agent";
import { buildDirectorPack } from "@chris/media/director";
import { EditTimelineSchema } from "@chris/media";

const BRIEF = "Series: Pick Your Poison · Ending objective: COMMENT · Intended reaction: which one is better?\nChosen hook (IMPOSSIBLE_CHOICE): \"$500K at 25 or $5M at 45.\"";

describe("downstream bots receive the Creative Brief (and work without one)", () => {
  it("hook picker, strategist, packaging and take selector put the brief in the prompt only when given", async () => {
    const hp = new MockModelProvider(() => ({ chosenIndex: 0, reason: "r", ranking: [0] }));
    const cands = [{ index: 0, text: "x", score: 1, reason: "r" }];
    await runHookPickerAgent(hp, { candidates: cands, transcript: "t", brandContext: "B", creativeBrief: BRIEF });
    await runHookPickerAgent(hp, { candidates: cands, transcript: "t", brandContext: "B" });
    expect(hp.calls[0]!.userPrompt).toContain("Creative brief");
    expect(hp.calls[0]!.userPrompt).toContain("$500K at 25 or $5M at 45.");
    expect(hp.calls[1]!.userPrompt).not.toContain("Creative brief");

    const vs = new MockModelProvider(() => ({ topic: "t", theme: "t", coreMessage: "m", viewerTakeaway: "v", viewer: "c", moments: [], leaveClean: [] }));
    await runVisualStrategistAgent(vs, { transcript: "[0.00-1.00] hi", durationS: 30, title: "T", brandContext: "B", creativeBrief: BRIEF });
    expect(vs.calls[0]!.userPrompt).toContain("storyboard's opening frame, midpoint visual and payoff visual are the starting plan");

    const pk = new MockModelProvider(() => ({ caption: "c", title: null, hashtags: [], coverFrameSeconds: null, metadataEntries: [] }));
    await runPlatformPackagingAgent(pk, { platform: "TIKTOK", finalTranscript: "t", brandContext: "B", creativeBrief: BRIEF });
    expect(pk.calls[0]!.userPrompt).toContain("ending's ONE objective");

    const ts = new MockModelProvider(() => ({ selectedMediaAssetId: "a", backupMediaAssetId: null, confidence: 0.9, reason: "r", materialDefects: [] }));
    await runTakeSelectorAgent(ts, { takes: [{ mediaAssetId: "a", transcript: "hello", durationSeconds: 10, words: null }], brandContext: "B", scriptText: "The script.", creativeBrief: BRIEF });
    expect(ts.calls[0]!.userPrompt).toContain("The script this was filmed from");
    expect(ts.calls[0]!.userPrompt).toContain("Prefer the take that delivers the chosen hook");
  });

  it("the Director's pack carries the plan", () => {
    const timeline = EditTimelineSchema.parse({ version: 2, clips: [{ id: "c1", mediaAssetId: "take", sourceStart: 0, sourceEnd: 10 }], captions: { fontId: "inter-display-extrabold", fontSize: 64, color: "#FFFFFF", highlightColor: "#FFD84D", y: 0.72 } });
    const pack = buildDirectorPack({ chrisMessage: "make it pop", history: [], lastApplied: null, timeline, understanding: {}, wordsByAsset: {}, placement: { subjectTracks: {} }, record: null, title: "T", sheet: null, brief: BRIEF });
    expect(pack.prompt).toContain("The plan this video was made to");
    expect(pack.prompt).toContain("Pick Your Poison");
  });
});
