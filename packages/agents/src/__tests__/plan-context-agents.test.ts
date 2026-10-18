import { describe, expect, it } from "vitest";
import { PLAN_CONTEXT_BUDGET_CHARS } from "@chris/domain";
import { buildPlanContextText } from "@chris/domain/plan-context";
import { MockModelProvider } from "../providers/mock-provider";
import { runScriptAgent, planContextBlock } from "../script-agent";
import { runWeeklyStrategistAgent } from "../weekly-strategist-agent";
import { runResearchToScriptPipeline } from "../pipeline";
import { getAgentPrompt } from "../prompt-context";
import {
  fixtureBacklog,
  fixtureBrandGuardianReport,
  fixtureClaimsGateResult,
  fixtureContract,
  fixturePortfolioAllocation,
  fixtureResearchPacket,
  fixtureScriptVersion,
  fixtureWeeklyThesis,
} from "./fixtures";

const plan = buildPlanContextText(
  [
    {
      title: "120-video plan",
      importedAt: "2026-10-17T00:00:00.000Z",
      messages: [
        { role: "user", text: "Help me plan my channel.", at: null },
        { role: "assistant", text: "## Business Model\nA $29/month Money Reset community.\n\n## Posting Cadence\n4 videos a day.", at: null },
      ],
    },
  ],
  { maxChars: 50_000 },
).text;

const huge = `# Chris's planning conversation with ChatGPT\n${"x".repeat(100_000)}`;

describe("Plan context in the Script agent and Weekly Strategist (mock provider — zero cost)", () => {
  it("Script agent: the plan conversation goes into the cached stable context, after the brand", async () => {
    const provider = new MockModelProvider(() => fixtureScriptVersion());
    await runScriptAgent(provider, { contract: fixtureContract(), research: fixtureResearchPacket(), brandContext: "BRAND DOC", planContext: plan });
    const req = provider.calls[0]!;
    expect(req.stableContext).toContain("BRAND DOC");
    expect(req.stableContext).toContain("Money Reset community");
    expect(req.stableContext!.indexOf("BRAND DOC")).toBeLessThan(req.stableContext!.indexOf("Money Reset"));
    expect(req.stableContext).toContain("NOT a verified source");
    // The prompt itself tells the agent how to use it.
    expect(req.systemPrompt).toContain("Chris's planning conversation (when provided)");
  });

  it("Script agent: budgeted — an oversized context is clipped to the SCRIPT budget", async () => {
    const provider = new MockModelProvider(() => fixtureScriptVersion());
    await runScriptAgent(provider, { contract: fixtureContract(), research: fixtureResearchPacket(), brandContext: "", planContext: huge });
    const ctx = provider.calls[0]!.stableContext!;
    expect(ctx.length).toBeLessThanOrEqual(PLAN_CONTEXT_BUDGET_CHARS.SCRIPT);
    expect(ctx.endsWith("…[cut]")).toBe(true);
  });

  it("no plan context → unchanged behaviour (brand only, or nothing)", async () => {
    const provider = new MockModelProvider(() => fixtureScriptVersion());
    await runScriptAgent(provider, { contract: fixtureContract(), research: fixtureResearchPacket(), brandContext: "" });
    expect(provider.calls[0]!.stableContext).toBeUndefined();
    await runScriptAgent(provider, { contract: fixtureContract(), research: fixtureResearchPacket(), brandContext: "BRAND", planContext: "  " });
    expect(provider.calls[1]!.stableContext).toBe("BRAND");
    expect(planContextBlock(undefined, 100)).toBe("");
  });

  it("pipeline passes it to every Script call (draft and revisions), never to the Claims Gate", async () => {
    let scriptGates = 0;
    const provider = new MockModelProvider((req) => {
      if (req.promptId === "RESEARCH") return fixtureResearchPacket();
      if (req.promptId === "CLAIMS_GATE") {
        if (!req.userPrompt.includes("MODE: SCRIPT")) return fixtureClaimsGateResult();
        scriptGates++;
        return scriptGates === 1 ? fixtureClaimsGateResult({ result: "PASS_WITH_REQUIRED_EDIT", requiredEdits: ["Say 'can', not 'will'."] }) : fixtureClaimsGateResult();
      }
      if (req.promptId === "SCRIPT") return fixtureScriptVersion();
      return fixtureBrandGuardianReport();
    });
    await runResearchToScriptPipeline(provider, { contract: fixtureContract(), brandContext: "brand", planContext: plan });
    const scripts = provider.calls.filter((c) => c.promptId === "SCRIPT");
    expect(scripts.length).toBeGreaterThanOrEqual(2);
    for (const s of scripts) expect(s.stableContext).toContain("Money Reset community");
    for (const c of provider.calls.filter((x) => x.promptId !== "SCRIPT")) {
      expect(c.stableContext ?? "").not.toContain("Money Reset");
      expect(c.userPrompt).not.toContain("Money Reset");
    }
  });

  it("Weekly Strategist: included and budgeted to its own (larger) budget", async () => {
    const provider = new MockModelProvider(() => fixturePortfolioAllocation());
    await runWeeklyStrategistAgent(provider, { thesis: fixtureWeeklyThesis(), backlog: fixtureBacklog(), editingBudgetMinutesPerWeek: 300, brandContext: "BRAND", planContext: plan });
    expect(provider.calls[0]!.stableContext).toContain("4 videos a day");
    expect(provider.calls[0]!.systemPrompt).toContain("Chris's planning conversation (when provided)");

    const p2 = new MockModelProvider(() => fixturePortfolioAllocation());
    await runWeeklyStrategistAgent(p2, { thesis: fixtureWeeklyThesis(), backlog: fixtureBacklog(), editingBudgetMinutesPerWeek: 300, brandContext: "", planContext: huge });
    expect(p2.calls[0]!.stableContext!.length).toBeLessThanOrEqual(PLAN_CONTEXT_BUDGET_CHARS.WEEKLY_STRATEGIST);
    expect(p2.calls[0]!.stableContext!.length).toBeGreaterThan(PLAN_CONTEXT_BUDGET_CHARS.SCRIPT);
  });

  it("prompt registry: SCRIPT and WEEKLY_STRATEGIST v1.2.0 declare the optional PlanContext, rollback 1.1.0", () => {
    for (const id of ["SCRIPT", "WEEKLY_STRATEGIST"]) {
      const p = getAgentPrompt(id);
      expect(p.frontmatter.version).toBe("1.2.0");
      expect(p.frontmatter.rollback_version).toBe("1.1.0");
      expect(p.frontmatter.required_context).toContain("PlanContext (optional)");
    }
  });
});
