import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runEditorAgent, EditorPlanInvalidError } from "../editor-agent";
import { buildSystemPrompt } from "../prompt-context";

const lines = [
  { id: 0, text: "So I have a picture here of two people, who would you rather be?", start: 0.5, end: 4.2, words: 13 },
  { id: 1, text: "Both are making a hundred grand a year.", start: 4.5, end: 7.0, words: 8 },
  { id: 2, text: "Let me know, kind of curious.", start: 50, end: 52, words: 6 },
];

describe("runEditorAgent — the Editor writes the cut", () => {
  it("asks with the numbered lines, the brief and the full playbook + orchestration; returns the typed plan with only real ids", async () => {
    const provider = new MockModelProvider(() => ({
      storyline: [
        { sentenceId: 1, role: "hook", headline: "SAME SALARY", viewerNeeds: null },
        { sentenceId: 0, role: "SETUP", keepWords: { from: 6, to: 12 }, headline: "WHICH ONE ARE YOU?", viewerNeeds: "two people side by side" },
        { sentenceId: 9, role: "PAYOFF" },
        { sentenceId: 1, role: "ENDING" },
      ],
      cut: [{ sentenceId: 2, why: "trailing — ends on the question instead" }, { sentenceId: 1, why: "x" }],
      title: "Both making $100K",
      pacing: "long shots zooms",
      rationale: "r",
      coldViewer: "holds",
    }));
    const plan = await runEditorAgent(provider, { title: "Both making $100K", durationS: 63, lines, brandContext: "brand", creativeBrief: "Series: Pick Your Poison" });
    expect(provider.calls[0]!.promptId).toBe("EDITOR");
    expect(provider.calls[0]!.userPrompt).toContain("[0] 0.5–4.2s (13 words): So I have a picture");
    expect(provider.calls[0]!.userPrompt).toContain("Pick Your Poison");
    expect(plan.storyline.map((e) => e.sentenceId)).toEqual([1, 0]); // unknown id 9 and the repeat of 1 dropped
    expect(plan.storyline[0]!.role).toBe("HOOK");
    expect(plan.pacing).toBe("LONG_SHOTS_ZOOMS");
    expect(plan.cut).toEqual([{ sentenceId: 2, why: "trailing — ends on the question instead" }]);
    const { systemPrompt } = buildSystemPrompt("EDITOR");
    expect(systemPrompt).toMatch(/THE EDITOR \(how the screen is run/);
    expect(systemPrompt).toMatch(/WHO YOU ARE WHEN YOU DO THIS WORK/);
  });

  it("refuses a plan with no usable line", async () => {
    const provider = new MockModelProvider(() => ({ storyline: [{ sentenceId: 42, role: "HOOK" }], cut: [], rationale: "" }));
    await expect(runEditorAgent(provider, { title: null, durationS: 10, lines, brandContext: "" })).rejects.toBeInstanceOf(EditorPlanInvalidError);
  });
});
