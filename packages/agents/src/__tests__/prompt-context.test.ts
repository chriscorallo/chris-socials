import { describe, it, expect } from "vitest";
import { buildSystemPrompt, getAgentPrompt, PromptNotFoundError } from "../prompt-context";

describe("prompt-context", () => {
  it("combines SYSTEM_BASE with the specific agent prompt", () => {
    const { systemPrompt, modelClass } = buildSystemPrompt("RESEARCH");
    expect(systemPrompt).toContain("You are a specialist inside the Chris Content Intelligence System");
    expect(systemPrompt).toContain("You are the factual research specialist");
    expect(modelClass).toBe("MEDIUM");
  });

  it("reports the correct model class per agent", () => {
    expect(buildSystemPrompt("CLAIMS_GATE").modelClass).toBe("HIGH");
    expect(buildSystemPrompt("SCRIPT").modelClass).toBe("MEDIUM");
    expect(buildSystemPrompt("BRAND_GUARDIAN").modelClass).toBe("MEDIUM");
  });

  it("refuses to build a system prompt for a DETERMINISTIC prompt_id", () => {
    expect(() => buildSystemPrompt("SYSTEM_BASE")).toThrow();
  });

  it("throws PromptNotFoundError for an unknown prompt_id", () => {
    expect(() => getAgentPrompt("NOT_A_REAL_PROMPT")).toThrow(PromptNotFoundError);
  });
});
