import { describe, it, expect } from "vitest";
import { planQualityStep, onAiCheckFailure, skippedDetail } from "./finish-quality";

// Finish modal's quality-step decisions (docs/decisions-pending/quality-override.md).
describe("Finish: quality step", () => {
  const ready = { ready: true, reason: null };
  const noCredit = { ready: false, reason: "The AI account is out of credit" };

  it("Firm always runs the AI check — even with no credit, and even with the tick", () => {
    expect(planQualityStep({ mode: "FIRM", ai: noCredit, skipThis: true })).toEqual({ kind: "AI_CHECK" });
    expect(planQualityStep({ mode: "FIRM", ai: ready, skipThis: true })).toEqual({ kind: "AI_CHECK" });
  });

  it("Let me skip it: AI can't run → skip with the reason; AI ready → only when Chris ticks Skip", () => {
    expect(planQualityStep({ mode: "SKIP_ALLOWED", ai: noCredit, skipThis: false })).toEqual({ kind: "SKIP", trigger: "AI_UNAVAILABLE", reason: "The AI account is out of credit" });
    expect(planQualityStep({ mode: "SKIP_ALLOWED", ai: ready, skipThis: true })).toEqual({ kind: "SKIP", trigger: "OWNER_CHOICE", reason: null });
    expect(planQualityStep({ mode: "SKIP_ALLOWED", ai: ready, skipThis: false })).toEqual({ kind: "AI_CHECK" });
  });

  it("an AI check that fails for lack of AI: skip (allowed) or stop firmly (Firm); other failures are errors", () => {
    expect(onAiCheckFailure("SKIP_ALLOWED", "The AI account is out of credit", "RENDERED")).toEqual({ kind: "SKIP", reason: "The AI account is out of credit" });
    expect(onAiCheckFailure("FIRM", "The AI account is out of credit", "RENDERED")).toEqual({ kind: "FIRM_STOP", reason: "The AI account is out of credit" });
    expect(onAiCheckFailure("SKIP_ALLOWED", null, "RENDERED")).toEqual({ kind: "ERROR" });
    // Not waiting at RENDERED (e.g. it moved on) → never an override.
    expect(onAiCheckFailure("SKIP_ALLOWED", "No Anthropic API key is set up", "QC_REPAIR")).toEqual({ kind: "ERROR" });
  });

  it("says what was skipped and why", () => {
    expect(skippedDetail("The AI account is out of credit")).toBe("Technical check passed. AI check skipped — the AI account is out of credit (your call, logged).");
    expect(skippedDetail(null)).toBe("Technical check passed. AI check skipped (your call, logged).");
  });
});
