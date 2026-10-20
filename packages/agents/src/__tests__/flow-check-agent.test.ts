import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runFlowCheckAgent, flowFixes, type FlowCheckInput } from "../flow-check-agent";

const input: FlowCheckInput = {
  kept: [
    { sentenceId: 3, text: "The easiest way to look rich is spending money you should have invested.", beat: "HOOK" },
    { sentenceId: 0, text: "So that's where it all goes.", beat: "POINT" },
    { sentenceId: 5, text: "Assets first, then the nice things.", beat: "PAYOFF" },
  ],
  removed: [{ sentenceId: 4, text: "Most people put the car before the index fund.", kind: "LOW_VALUE", why: "low value" }],
  hookSentenceIds: [3],
  brandContext: "brand",
};

describe("flow check (AI edit read-through)", () => {
  it("asks with the kept order, the removed lines and the hook marked; returns typed issues", async () => {
    const provider = new MockModelProvider(() => ({ reads: "ISSUES", issues: [{ atSentenceId: 0, problem: "'that' points at a cut line", fix: "RESTORE", sentenceId: 4 }], hookProblem: null, quotable: "Assets first, then the nice things." }));
    const out = await runFlowCheckAgent(provider, input);
    expect(provider.calls[0]!.promptId).toBe("FLOW_CHECK");
    expect(provider.calls[0]!.userPrompt).toContain("[3] (HOOK) The easiest way");
    expect(provider.calls[0]!.userPrompt).toContain("[4] (low_value: low value) Most people");
    expect(out.issues[0]!.fix).toBe("RESTORE");
  });

  it("turns issues into Full-edit choices: valid ids only, never the hook, capped", () => {
    const check = {
      reads: "ISSUES" as const,
      hookProblem: null,
      quotable: null,
      issues: [
        { atSentenceId: 0, problem: "p", fix: "RESTORE" as const, sentenceId: 4 },
        { atSentenceId: 0, problem: "p", fix: "RESTORE" as const, sentenceId: 99 }, // not a removed line
        { atSentenceId: 3, problem: "p", fix: "DROP" as const, sentenceId: 3 }, // the hook — never
        { atSentenceId: 5, problem: "p", fix: "DROP" as const, sentenceId: 5 },
        { atSentenceId: 5, problem: "p", fix: "NONE" as const, sentenceId: null },
      ],
    };
    expect(flowFixes(check, input)).toEqual({ forceKeep: [4], forceDrop: [5] });
    expect(flowFixes(check, input, 1)).toEqual({ forceKeep: [4], forceDrop: [] });
  });
});
