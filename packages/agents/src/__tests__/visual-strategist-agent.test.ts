import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runVisualStrategistAgent, formatVisualBrief, type VisualBrief } from "../visual-strategist-agent";

const m = (start: number, end: number, concept = "c"): VisualBrief["moments"][number] => ({ start, end, need: "SCALE", whyViewerNeedsIt: "w", concept, visualIdea: "v", mustNotBe: "the caption" });
const brief = (moments: VisualBrief["moments"]): VisualBrief => ({ topic: "car payments", theme: "status spending", coreMessage: "Your car payment decides your savings.", viewerTakeaway: "Keep needs at 50%.", viewer: "cold", moments, leaveClean: [] });

describe("runVisualStrategistAgent", () => {
  it("understands the video first, then plans viewer moments — kept inside the video, in order, never during the hook, at most one per ~5 s", async () => {
    const provider = new MockModelProvider(() => brief([m(20, 23, "b"), m(0.5, 3, "hook"), m(5, 8, "a"), m(6, 9, "overlap"), m(58, 70, "late"), m(90, 92, "after end")]));
    const out = await runVisualStrategistAgent(provider, { transcript: "[0.00-2.00] hi", durationS: 60, title: "Car", brandContext: "B" });
    expect(out.moments.map((x) => x.concept)).toEqual(["a", "b", "late"]);
    expect(out.moments[2]!.end).toBe(60);
    expect(provider.calls[0]!.promptId).toBe("VISUAL_STRATEGIST");
    expect(formatVisualBrief(out)).toContain("Core message: Your car payment decides your savings.");
  });

  it("is told what the free edit already placed, and allows up to one moment per 4.5 s", async () => {
    const provider = new MockModelProvider(() => brief(Array.from({ length: 12 }, (_, i) => m(2 + i * 4.6, 4 + i * 4.6, `m${i}`))));
    const out = await runVisualStrategistAgent(provider, { transcript: "[0.00-2.00] hi", durationS: 60, title: "Car", brandContext: "B", existing: [{ start: 17.3, end: 21, name: "Big number — $8,333" }] });
    expect(provider.calls[0]!.userPrompt).toContain("Already on the timeline");
    expect(provider.calls[0]!.userPrompt).toContain("17.3–21.0 s: Big number — $8,333");
    expect(out.moments.length).toBe(12); // floor(60 / 4.5) = 13 ≥ 12
  });
});
