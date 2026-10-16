import type { ProductionContract } from "@chris/domain";
import { scopeProvider, type ModelProvider, type StructuredCompletionRequest } from "./model-provider";
import { runResearchAgent } from "./research-agent";
import { runClaimsGateAgent } from "./claims-gate-agent";
import { runScriptAgent, type ScriptRevisionRequest } from "./script-agent";
import { runBrandGuardianAgent, brandReportNeedsRevision } from "./brand-guardian-agent";
import type { ResearchPacket, ClaimsGateResult, ScriptVersion, BrandGuardianReport } from "./schemas";

/**
 * Research -> Claims Gate (research) -> Script -> Claims Gate (SCRIPT) -> Brand Guardian,
 * with bounded revision loops. Pure orchestration: no database, no state machine — the caller
 * persists via packages/domain applyPipelineResult (use `toPipelineResultInput`).
 *
 * Hard-gate rules enforced here (finance content: the gate must see the words that get filmed):
 * 1. A research-level BLOCK stops before any script is drafted (RESEARCH_BLOCKED).
 * 2. Research-level required edits + prohibited claims are handed to the Script Agent.
 * 3. The final script is ALWAYS re-gated. PASS_WITH_REQUIRED_EDIT -> up to
 *    `maxScriptRevisions` Script revisions applying the edits, each re-gated. Anything other
 *    than PASS after that -> SCRIPT_BLOCKED; no unchecked script can come back READY.
 * 4. Brand Guardian required changes / sub-threshold scores -> up to `maxScriptRevisions`
 *    brand revisions. A brand revision is a new script, so it is re-gated too; if it does not
 *    PASS the gate it is DISCARDED and the last gated script stands (brand quality never buys
 *    back a factual failure).
 * 5. Every model call is counted against `maxModelCalls`; exceeding it throws
 *    PipelineBudgetExceededError before the call is made.
 */

export interface PipelineOptions {
  /** Per loop (claims-edit loop and brand loop each). Default 1. */
  maxScriptRevisions?: number;
  /** Hard ceiling on model calls for one run. Default = the worst case for maxScriptRevisions. */
  maxModelCalls?: number;
  /** Attributes every call's ModelCallLog row to this item (via provider.withContext). */
  contentItemId?: string;
  brandScoreThreshold?: number;
}

/** One script version the pipeline produced and gated, in order. The last entry is `script`. */
export interface ScriptAttempt {
  script: ScriptVersion;
  scriptClaimsGateResult: ClaimsGateResult;
  brandGuardianReport: BrandGuardianReport | null;
  /** Why this version exists (null for the first draft). */
  revisionNote: string | null;
}

export type PipelineResult =
  | { status: "NEEDS_MORE_RESEARCH" | "UNSUPPORTED" | "OUT_OF_SCOPE"; research: ResearchPacket; modelCalls: number }
  | { status: "RESEARCH_BLOCKED"; research: ResearchPacket; claimsGateResult: ClaimsGateResult; modelCalls: number }
  | {
      status: "SCRIPT_BLOCKED";
      research: ResearchPacket;
      claimsGateResult: ClaimsGateResult;
      script: ScriptVersion;
      scriptClaimsGateResult: ClaimsGateResult;
      scriptHistory: ScriptAttempt[];
      blockReason: string;
      modelCalls: number;
    }
  | {
      status: "READY";
      research: ResearchPacket;
      claimsGateResult: ClaimsGateResult;
      script: ScriptVersion;
      scriptClaimsGateResult: ClaimsGateResult;
      brandGuardianReport: BrandGuardianReport;
      scriptHistory: ScriptAttempt[];
      /** True when the final script still misses the brand threshold / has required changes
       * after the bounded revisions — filmable factually, but Chris should look first. */
      brandNeedsHumanReview: boolean;
      /** Brand revisions thrown away because they failed the Claims Gate. */
      discardedRevisions: { script: ScriptVersion; scriptClaimsGateResult: ClaimsGateResult }[];
      modelCalls: number;
    };

export class PipelineBudgetExceededError extends Error {
  constructor(
    public readonly maxModelCalls: number,
    public readonly nextPromptId: string,
  ) {
    super(
      `Pipeline call budget exhausted: ${maxModelCalls} model calls used; refusing to call ` +
        `"${nextPromptId}". Raise maxModelCalls or reduce maxScriptRevisions.`,
    );
    this.name = "PipelineBudgetExceededError";
  }
}

/** Counts calls through a provider and refuses once the ceiling is hit. */
class BudgetedProvider implements ModelProvider {
  calls = 0;
  constructor(
    private readonly inner: ModelProvider,
    private readonly max: number,
  ) {}
  async completeStructured<T>(request: StructuredCompletionRequest<T>) {
    if (this.calls >= this.max) throw new PipelineBudgetExceededError(this.max, request.promptId);
    this.calls += 1;
    return this.inner.completeStructured(request);
  }
}

export function defaultMaxModelCalls(maxScriptRevisions: number): number {
  // research + gate + draft + script-gate + brand, then per claims revision (script + gate)
  // and per brand revision (script + gate + brand).
  return 5 + 2 * maxScriptRevisions + 3 * maxScriptRevisions;
}

export async function runResearchToScriptPipeline(
  provider: ModelProvider,
  input: { contract: ProductionContract; brandContext: string; strategyContext?: string },
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const maxRevisions = options.maxScriptRevisions ?? 1;
  const budget = new BudgetedProvider(
    options.contentItemId ? scopeProvider(provider, { contentItemId: options.contentItemId }) : provider,
    options.maxModelCalls ?? defaultMaxModelCalls(maxRevisions),
  );
  const { contract, brandContext } = input;

  const research = await runResearchAgent(budget, { contract, brandContext });
  if (research.status !== "READY") {
    return { status: research.status, research, modelCalls: budget.calls };
  }

  const claimsGateResult = await runClaimsGateAgent(budget, { research, brandContext });
  if (claimsGateResult.result === "BLOCK") {
    return { status: "RESEARCH_BLOCKED", research, claimsGateResult, modelCalls: budget.calls };
  }

  const writeScript = (revision?: ScriptRevisionRequest) =>
    runScriptAgent(budget, {
      contract,
      research,
      brandContext,
      claimsGateRequiredEdits: claimsGateResult.requiredEdits,
      revision,
    });
  const gateScript = (script: ScriptVersion) => runClaimsGateAgent(budget, { research, brandContext, script });

  // --- Factual loop: the gate must PASS the actual script wording. ---
  let script = await writeScript();
  let scriptGate = await gateScript(script);
  const history: ScriptAttempt[] = [
    { script, scriptClaimsGateResult: scriptGate, brandGuardianReport: null, revisionNote: null },
  ];

  for (let i = 0; i < maxRevisions && scriptGate.result === "PASS_WITH_REQUIRED_EDIT"; i += 1) {
    const edits = scriptGate.requiredEdits;
    script = await writeScript({ previousScript: script, source: "CLAIMS_GATE", requiredEdits: edits });
    scriptGate = await gateScript(script);
    history.push({
      script,
      scriptClaimsGateResult: scriptGate,
      brandGuardianReport: null,
      revisionNote: `Claims Gate required edits applied: ${edits.join(" | ")}`,
    });
  }

  if (scriptGate.result !== "PASS") {
    const blockReason =
      scriptGate.result === "BLOCK"
        ? `Script-level Claims Gate BLOCK: ${scriptGate.blockReason ?? "no reason given"}`
        : `Script-level Claims Gate required edits still unresolved after ${maxRevisions} revision(s): ${scriptGate.requiredEdits.join(" | ")}`;
    return {
      status: "SCRIPT_BLOCKED",
      research,
      claimsGateResult,
      script,
      scriptClaimsGateResult: scriptGate,
      scriptHistory: history,
      blockReason,
      modelCalls: budget.calls,
    };
  }

  // --- Brand loop: improve voice/identity without ever un-gating the facts. ---
  const threshold = options.brandScoreThreshold;
  const review = (s: ScriptVersion) =>
    runBrandGuardianAgent(budget, { script: s, brandContext, strategyContext: input.strategyContext });
  let brandReport = await review(script);
  history[history.length - 1]!.brandGuardianReport = brandReport;
  const discardedRevisions: { script: ScriptVersion; scriptClaimsGateResult: ClaimsGateResult }[] = [];

  for (let i = 0; i < maxRevisions && brandReportNeedsRevision(brandReport, threshold); i += 1) {
    const edits = brandReport.requiredChanges.length
      ? brandReport.requiredChanges
      : [`Raise brand/voice fit (brand ${brandReport.brandScore}, voice ${brandReport.voiceScore}): ${brandReport.risks.join("; ") || brandReport.strategicFit}`];
    const candidate = await writeScript({ previousScript: script, source: "BRAND_GUARDIAN", requiredEdits: edits });
    const candidateGate = await gateScript(candidate);
    if (candidateGate.result !== "PASS") {
      discardedRevisions.push({ script: candidate, scriptClaimsGateResult: candidateGate });
      break;
    }
    const candidateReport = await review(candidate);
    script = candidate;
    scriptGate = candidateGate;
    brandReport = candidateReport;
    history.push({
      script,
      scriptClaimsGateResult: scriptGate,
      brandGuardianReport: brandReport,
      revisionNote: `Brand Guardian changes applied: ${edits.join(" | ")}`,
    });
  }

  return {
    status: "READY",
    research,
    claimsGateResult,
    script,
    scriptClaimsGateResult: scriptGate,
    brandGuardianReport: brandReport,
    scriptHistory: history,
    brandNeedsHumanReview: brandReportNeedsRevision(brandReport, threshold),
    discardedRevisions,
    modelCalls: budget.calls,
  };
}

/** Maps a PipelineResult to packages/domain's applyPipelineResult input — the one call the
 * web layer needs: `applyPipelineResult(prisma, id, toPipelineResultInput(result), actor)`. */
export function toPipelineResultInput(result: PipelineResult) {
  return {
    status: result.status,
    research: result.research,
    claimsGateResult: "claimsGateResult" in result ? result.claimsGateResult : undefined,
    script: "script" in result ? result.script : undefined,
    scriptClaimsGateResult: "scriptClaimsGateResult" in result ? result.scriptClaimsGateResult : undefined,
    brandGuardianReport: "brandGuardianReport" in result ? result.brandGuardianReport : undefined,
    scriptHistory: "scriptHistory" in result ? result.scriptHistory : undefined,
    blockReason: "blockReason" in result ? result.blockReason : undefined,
  };
}
