import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import {
  AnthropicModelProvider,
  computeCostUsd,
  runResearchToScriptPipeline,
  BilledModelCallError,
  type ModelProvider,
  type StructuredCompletionRequest,
} from "@chris/agents";
import { EVAL_RESULTS_DIR, REPO_ROOT, loadBrandContextFromFiles } from "./runner";

/**
 * Real end-to-end pipeline run (no database): Research (web) -> Claims Gate (research, web) ->
 * Script -> Claims Gate (script) -> Brand Guardian (+ bounded revisions). Prints every call's
 * usage (incl. cache reads and web searches) and the total cost, writes the full result JSON
 * under fixtures/evals/results/. Usage: `npx tsx src/e2e-pipeline.ts` from packages/evals
 * (ENV_FILE=/path/to/.env). Spends real money (~$0.3-0.8).
 */
config({ path: process.env.ENV_FILE ?? join(REPO_ROOT, ".env"), quiet: true });

const calls: { promptId: string; model: string; costUsd: number; usage: unknown; ok: boolean }[] = [];
const real = new AnthropicModelProvider();
const metered: ModelProvider = {
  async completeStructured<T>(req: StructuredCompletionRequest<T>) {
    try {
      const r = await real.completeStructured(req);
      const cost = (r.usage && computeCostUsd(r.model, r.usage)) || 0;
      calls.push({ promptId: req.promptId, model: r.model, costUsd: cost, usage: r.usage, ok: true });
      console.log(`  ${req.promptId.padEnd(15)} ${r.model.padEnd(18)} $${cost.toFixed(4)} ${JSON.stringify(r.usage)}`);
      return r;
    } catch (err) {
      if (err instanceof BilledModelCallError) {
        const cost = (err.usage && computeCostUsd(err.model, err.usage)) || 0;
        calls.push({ promptId: req.promptId, model: err.model, costUsd: cost, usage: err.usage, ok: false });
      }
      throw err;
    }
  },
};

const contract: Parameters<typeof runResearchToScriptPipeline>[1]["contract"] = {
  id: "e2e",
  contentItemId: "e2e",
  purpose: "Acquisition",
  primaryIdea: "The 2026 401(k) contribution limit, explained in plain English",
  audiencePromise: "You'll know exactly how much you're allowed to put in your 401(k) in 2026 and what 'maxing it out' really means",
  topic: "Retirement",
  format: "Talking head",
  productionTier: "FAST",
  targetLengthMinSeconds: 30,
  targetLengthMaxSeconds: 50,
  researchDepth: "STANDARD",
  factualRisk: "HIGH",
  experiment: null,
  platformOpportunities: ["instagram", "tiktok", "youtube"],
  humanEditingBudgetMinutes: 10,
  requiredAssets: [],
  scope: "2026 employee elective deferral limit and the age-50+ catch-up only.",
  doNotExpandInto: "IRA limits, Roth vs traditional, employer match formulas, investment selection.",
  createdAt: new Date(),
};

console.log("Running real pipeline: 2026 401(k) contribution limit explained\n");
const started = Date.now();
const result = await runResearchToScriptPipeline(metered, { contract, brandContext: loadBrandContextFromFiles() });
const total = calls.reduce((s, c) => s + c.costUsd, 0);

console.log(`\nstatus=${result.status}  modelCalls=${result.modelCalls}  total=$${total.toFixed(4)}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log("\nCitations:");
for (const c of result.research.citations) console.log(`  - ${c.url} (${c.publisher}, ${c.publishedOrEffectiveDate ?? "n.d."}, primary=${c.isPrimarySource})`);
console.log("\nNumeric inputs:", JSON.stringify(result.research.numericInputs, null, 1));
if ("scriptHistory" in result) {
  for (const [i, a] of result.scriptHistory.entries()) {
    console.log(`\n--- Script v${i + 1} (script gate: ${a.scriptClaimsGateResult.result}) ${a.revisionNote ?? ""}\n${a.script.spokenScript}`);
    if (a.scriptClaimsGateResult.requiredEdits.length) console.log("  required edits:", a.scriptClaimsGateResult.requiredEdits);
  }
}
if (result.status === "READY") {
  const b = result.brandGuardianReport;
  console.log(`\nBrand Guardian: brand=${b.brandScore} voice=${b.voiceScore} orig=${b.originalityScore} needsHumanReview=${result.brandNeedsHumanReview}`);
}

mkdirSync(EVAL_RESULTS_DIR, { recursive: true });
const file = join(EVAL_RESULTS_DIR, `e2e-pipeline-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), totalCostUsd: total, calls, result }, null, 2));
console.log(`\nWritten to ${file}`);
