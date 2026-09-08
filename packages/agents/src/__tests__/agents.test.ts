import { describe, it, expect } from "vitest";
import { MockModelProvider } from "../providers/mock-provider";
import { runResearchAgent } from "../research-agent";
import { runClaimsGateAgent } from "../claims-gate-agent";
import { runScriptAgent } from "../script-agent";
import { runBrandGuardianAgent } from "../brand-guardian-agent";
import {
  fixtureContract,
  fixtureResearchPacket,
  fixtureClaimsGateResult,
  fixtureScriptVersion,
  fixtureBrandGuardianReport,
} from "./fixtures";

describe("individual agents (mock provider — zero cost)", () => {
  it("Research Agent returns a schema-valid ResearchPacket and routes to MEDIUM", async () => {
    const provider = new MockModelProvider(() => fixtureResearchPacket());
    const result = await runResearchAgent(provider, {
      contract: fixtureContract(),
      brandContext: "brand context text",
    });
    expect(result.status).toBe("READY");
    expect(provider.calls[0]?.modelClass).toBe("MEDIUM");
    expect(provider.calls[0]?.promptId).toBe("RESEARCH");
  });

  it("Research Agent's user prompt respects the contract's scope boundary", async () => {
    const provider = new MockModelProvider((req) => {
      expect(req.userPrompt).toContain("DO NOT expand into");
      expect(req.userPrompt).toContain(fixtureContract().doNotExpandInto);
      return fixtureResearchPacket();
    });
    await runResearchAgent(provider, { contract: fixtureContract(), brandContext: "" });
  });

  it("Claims Gate routes to HIGH and returns a schema-valid result", async () => {
    const provider = new MockModelProvider(() => fixtureClaimsGateResult());
    const result = await runClaimsGateAgent(provider, {
      research: fixtureResearchPacket(),
      brandContext: "",
    });
    expect(result.result).toBe("PASS");
    expect(provider.calls[0]?.modelClass).toBe("HIGH");
  });

  it("Script Agent returns a schema-valid ScriptVersion", async () => {
    const provider = new MockModelProvider(() => fixtureScriptVersion());
    const result = await runScriptAgent(provider, {
      contract: fixtureContract(),
      research: fixtureResearchPacket(),
      brandContext: "",
    });
    expect(result.spokenScript.length).toBeGreaterThan(0);
    expect(provider.calls[0]?.promptId).toBe("SCRIPT");
  });

  it("Brand Guardian returns a schema-valid report", async () => {
    const provider = new MockModelProvider(() => fixtureBrandGuardianReport());
    const result = await runBrandGuardianAgent(provider, {
      script: fixtureScriptVersion(),
      brandContext: "",
    });
    expect(result.brandScore).toBeGreaterThanOrEqual(0);
    expect(result.brandScore).toBeLessThanOrEqual(100);
  });

  it("rejects a mock response that doesn't match the schema (schema is enforced, not bypassed)", async () => {
    const provider = new MockModelProvider(() => ({ nonsense: true }));
    await expect(
      runResearchAgent(provider, { contract: fixtureContract(), brandContext: "" }),
    ).rejects.toThrow();
  });
});
