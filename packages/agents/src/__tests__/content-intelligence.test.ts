import { describe, it, expect } from "vitest";
import { buildSystemPrompt, contentIntelligenceFor, getAgentPrompt } from "../prompt-context";

describe("Content Intelligence playbook (Chris's master strategy) reaches every creative bot", () => {
  it("FULL agents get the whole playbook after SYSTEM_BASE, before their own prompt", () => {
    const { systemPrompt } = buildSystemPrompt("SCRIPT");
    expect(systemPrompt).toContain("THE CONTENT INTELLIGENCE PLAYBOOK (how this brand makes short-form video)");
    expect(systemPrompt.indexOf("CONTENT INTELLIGENCE PLAYBOOK")).toBeLessThan(systemPrompt.indexOf(getAgentPrompt("SCRIPT").body.trim().slice(0, 40)));
    for (const id of ["RESEARCH", "BRAND_GUARDIAN", "HOOK_PICKER", "VISUAL_STRATEGIST", "VIEWER_PANEL", "CREATIVE_DIRECTOR"]) {
      expect(contentIntelligenceFor(id), id).toContain("Hook families");
    }
  });

  it("supporting agents get the CORE excerpt; gates and pixel checks get none", () => {
    expect(contentIntelligenceFor("MOTION_DESIGNER")).toContain("PLAYBOOK — CORE");
    expect(contentIntelligenceFor("PLATFORM_PACKAGING_TIKTOK")).toContain("Endings have one objective");
    expect(contentIntelligenceFor("CLAIMS_GATE")).toBe("");
    expect(contentIntelligenceFor("VISUAL_QA")).toBe("");
  });
});
