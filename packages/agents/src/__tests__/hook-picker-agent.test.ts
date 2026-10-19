import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runHookPickerAgent, HookPickInvalidError } from "../hook-picker-agent";

const candidates = [
  { index: 0, text: "So anyway, that's the thing about it.", score: 0.9, reason: "contrast word" },
  { index: 1, text: "Most people budget backwards.", score: 0.6, reason: "contrast ('most people')" },
];

describe("runHookPickerAgent", () => {
  it("picks among Chris's own sentences, with the HOOK_PICKER prompt and typed output", async () => {
    const provider = new MockModelProvider(() => ({ chosenIndex: 1, reason: "Stands alone and makes a cold viewer ask why.", ranking: [1, 0, 7] }));
    const pick = await runHookPickerAgent(provider, { candidates, transcript: "Most people budget backwards…", brandContext: "" });
    expect(pick.chosenIndex).toBe(1);
    expect(pick.ranking).toEqual([1, 0]);
    expect(provider.calls[0]!.promptId).toBe("HOOK_PICKER");
    expect(provider.calls[0]!.userPrompt).toContain('[1] "Most people budget backwards."');
  });

  it("refuses a pick that isn't one of the options (never invents a line)", async () => {
    const provider = new MockModelProvider(() => ({ chosenIndex: 5, reason: "x", ranking: [] }));
    await expect(runHookPickerAgent(provider, { candidates, transcript: "", brandContext: "" })).rejects.toBeInstanceOf(HookPickInvalidError);
  });

  it("no candidates → no model call", async () => {
    const provider = new MockModelProvider(() => ({}));
    await expect(runHookPickerAgent(provider, { candidates: [], transcript: "", brandContext: "" })).rejects.toBeInstanceOf(HookPickInvalidError);
    expect(provider.calls).toHaveLength(0);
  });
});
