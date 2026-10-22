import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runHookTestAgent, runWatchBackAgent, settleVerdict, watchBackUserPrompt, type WatchVerdict } from "../watch-back";
import { buildSystemPrompt } from "../prompt-context";

const frame = { t: 0, reason: "FIRST", base64: "AA==", mediaType: "image/jpeg" as const };

const input = {
  title: "Same salary",
  durationS: 42,
  frames: [frame, { ...frame, t: 5.2, reason: "AFTER_CUT" }],
  referenceFrames: [{ ...frame, t: 0.8, ofS: 0.7, referenceLabel: "Ref · reel.mp4" }],
  transcript: "[0.0s] Two people both make a hundred grand.",
  beats: [{ role: "HOOK", headline: "SAME SALARY", viewerNeeds: null, start: 0, end: 4 }],
  screen: "headline zone: TOP",
  audits: [{ stage: "SPLICE", kind: "GAP", atS: 5.2, detail: "cut 1: 310 ms of air" }],
  styleDigest: ["Length: 30–45 s."],
  cuts: [{ index: 0, atS: 5.2 }],
  brandContext: "brand",
};

const verdict = (over: Partial<WatchVerdict> = {}): WatchVerdict => ({
  verdict: "FIX",
  checklist: [
    { check: "HOOK_BY_1_5S", ok: true, finding: "headline up at 0 s", evidence: [{ t: 0, kind: "SEEN", detail: "SAME SALARY on screen" }] },
    { check: "CUTS_INVISIBLE", ok: false, finding: "a gap at the first cut", evidence: [{ t: 5.2, kind: "MEASURED", detail: "310 ms of air" }] },
  ],
  fixes: [{ stage: "SPLICE", op: "RETIME", cutIndex: 0, deltaMs: -200, side: "BOTH", why: "the gap" }],
  coldViewer: "I stop on the salary line. I'd leave at the first cut — it breathes too long.",
  hook: { firstFrameRead: "a man, a headline", stopChancePct: 60, rationale: "an estimate" },
  contrast: [],
  ...over,
});

describe("watch-back agent", () => {
  it("sends our frames and the reference pairs with labels, the audits and the digest; returns the typed verdict", async () => {
    const provider = new MockModelProvider(() => verdict());
    const r = await runWatchBackAgent(provider, input);
    const call = provider.calls[0]!;
    expect(call.promptId).toBe("WATCH_BACK");
    expect(call.images).toHaveLength(3);
    expect(call.images![2]!.label).toMatch(/reference Ref · reel.mp4 at 0.7s \(pairs with ours 0.8s\)/);
    expect(call.userPrompt).toContain("SPLICE GAP at 5.2s");
    expect(call.userPrompt).toContain("Length: 30–45 s.");
    expect(r.verdict.fixes[0]).toMatchObject({ stage: "SPLICE", cutIndex: 0 });
    expect(buildSystemPrompt("WATCH_BACK").modelClass).toBe("HIGH");
    expect(watchBackUserPrompt({ ...input, referenceFrames: [] })).toContain("mark LIKE_THE_REFERENCES as n/a");
  });
  it("the hook test is one MEDIUM call on the first frame and the first words", async () => {
    const provider = new MockModelProvider(() => ({ wouldKeepWatching: "maybe", firstFrameRead: "a face and a title", why: "the title is a claim", missing: "a number" }));
    const r = await runHookTestAgent(provider, { firstFrame: frame, firstWords: "Two people both make" });
    expect(provider.calls[0]!.promptId).toBe("HOOK_TEST");
    expect(provider.calls[0]!.images).toHaveLength(1);
    expect(r.test.wouldKeepWatching).toBe("MAYBE");
    expect(buildSystemPrompt("HOOK_TEST").modelClass).toBe("MEDIUM");
  });
  it("settles the verdict by rule: clean = PASS; fixes on the first watch = FIX; the loop spent = HOLD; a dead hook on both reads = HOLD", () => {
    const clean = verdict({ verdict: "PASS", checklist: verdict().checklist.map((c) => ({ ...c, ok: true })), fixes: [] });
    expect(settleVerdict(clean, null, 0)).toBe("PASS");
    expect(settleVerdict(verdict(), null, 0)).toBe("FIX");
    expect(settleVerdict(verdict(), null, 1)).toBe("HOLD");
    const deadHook = verdict({ checklist: verdict().checklist.map((c) => (c.check === "HOOK_BY_1_5S" ? { ...c, ok: false } : c)) });
    expect(settleVerdict(deadHook, { wouldKeepWatching: "NO", firstFrameRead: "", why: "", missing: null }, 0)).toBe("HOLD");
    expect(settleVerdict(deadHook, { wouldKeepWatching: "MAYBE", firstFrameRead: "", why: "", missing: null }, 0)).toBe("FIX");
  });
});
