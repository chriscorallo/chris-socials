import type { ProductionContract } from "@chris/domain";
import type { ModelProvider } from "./model-provider";
import { runResearchAgent } from "./research-agent";
import { runClaimsGateAgent } from "./claims-gate-agent";
import { runScriptAgent } from "./script-agent";
import { runBrandGuardianAgent } from "./brand-guardian-agent";
import type { ResearchPacket, ClaimsGateResult, ScriptVersion, BrandGuardianReport } from "./schemas";

/**
 * The Phase 2 acceptance-critical pipeline (/docs/PHASE_PLAN.md — Phase 2):
 * ResearchPacket -> Claims Gate PASS/BLOCK -> ScriptVersion -> Brand Guardian report.
 *
 * This function is pure orchestration — it takes a provider and inputs, returns typed
 * results. It does not touch the database or the content state machine; a caller (e.g. a
 * Server Action) is responsible for persisting the results and driving
 * RESEARCHING -> RESEARCHED -> SCRIPTING -> SCRIPTED (or -> RESEARCH_BLOCKED) accordingly.
 *
 * Mirrors the Claims Gate hard-gate rule from /docs/ARCHITECTURE.md: a BLOCK stops the
 * pipeline before scripting even starts — no creative step ever runs on rejected research.
 */
export type PipelineResult =
  | { status: "NEEDS_MORE_RESEARCH" | "UNSUPPORTED" | "OUT_OF_SCOPE"; research: ResearchPacket }
  | { status: "RESEARCH_BLOCKED"; research: ResearchPacket; claimsGateResult: ClaimsGateResult }
  | {
      status: "READY";
      research: ResearchPacket;
      claimsGateResult: ClaimsGateResult;
      script: ScriptVersion;
      brandGuardianReport: BrandGuardianReport;
    };

export async function runResearchToScriptPipeline(
  provider: ModelProvider,
  input: { contract: ProductionContract; brandContext: string },
): Promise<PipelineResult> {
  const research = await runResearchAgent(provider, input);

  if (research.status !== "READY") {
    return { status: research.status, research };
  }

  const claimsGateResult = await runClaimsGateAgent(provider, {
    research,
    brandContext: input.brandContext,
  });

  if (claimsGateResult.result === "BLOCK") {
    return { status: "RESEARCH_BLOCKED", research, claimsGateResult };
  }

  const script = await runScriptAgent(provider, {
    contract: input.contract,
    research,
    brandContext: input.brandContext,
  });

  const brandGuardianReport = await runBrandGuardianAgent(provider, {
    script,
    brandContext: input.brandContext,
  });

  return { status: "READY", research, claimsGateResult, script, brandGuardianReport };
}
