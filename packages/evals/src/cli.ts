import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { AnthropicModelProvider, MockModelProvider, resolveModel } from "@chris/agents";
import {
  EVAL_RESULTS_DIR,
  REPO_ROOT,
  loadEvalCases,
  runEvalSuite,
  summarizeByPrompt,
  type EvalCaseResult,
} from "./index";

/**
 * Usage:
 *   pnpm --filter @chris/evals eval                         # all cases, real model (needs key)
 *   pnpm --filter @chris/evals eval -- --only=cg-roth-25k,bg-generic-ai
 *   pnpm --filter @chris/evals eval -- --prompt=BRAND_GUARDIAN
 *   pnpm --filter @chris/evals eval -- --mock               # zero-cost harness check
 *   pnpm --filter @chris/evals eval -- --max-cost=1.50      # stop starting cases past $1.50
 * Env: ENV_FILE=/path/to/.env (default: repo-root .env). Never prints the key.
 */
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k!, v ?? "true"] as const;
  }),
);

config({ path: process.env.ENV_FILE ?? join(REPO_ROOT, ".env"), quiet: true });

const mock = args.get("mock") === "true";
let cases = loadEvalCases();
if (args.get("only")) {
  const only = new Set(args.get("only")!.split(","));
  cases = cases.filter((c) => only.has(c.id));
}
if (args.get("prompt")) cases = cases.filter((c) => c.promptId === args.get("prompt"));

if (!mock && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set (set ENV_FILE or export it), or pass --mock.");
  process.exit(2);
}

const byId = new Map(cases.map((c) => [c.id, c]));
let currentId = "";
const provider = mock
  ? new MockModelProvider(() => byId.get(currentId)?.mockResponse)
  : new AnthropicModelProvider();

const maxCost = args.get("max-cost") ? Number(args.get("max-cost")) : undefined;
console.log(`Running ${cases.length} eval case(s) ${mock ? "(MOCK)" : `against real models (HIGH=${resolveModel("HIGH")}, MEDIUM=${resolveModel("MEDIUM")})`}\n`);

const ordered = cases.map((c) => ({ ...c }));
const results: EvalCaseResult[] = [];
let total = 0;
const skipped: string[] = [];
for (const c of ordered) {
  currentId = c.id;
  const run = await runEvalSuite(provider, [c], { maxCostUsd: maxCost === undefined ? undefined : Math.max(0, maxCost - total) });
  skipped.push(...run.skipped);
  for (const r of run.results) {
    results.push(r);
    total += r.costUsd;
    const verdict = r.passed ? "PASS" : "FAIL";
    const out = r.output as Record<string, unknown> | null;
    const summary = out
      ? r.promptId === "CLAIMS_GATE"
        ? `result=${String(out.result)}`
        : `brand=${String(out.brandScore)} voice=${String(out.voiceScore)} orig=${String(out.originalityScore)} req=${(out.requiredChanges as unknown[] | undefined)?.length ?? 0}`
      : (r.error ?? "");
    console.log(`${verdict.padEnd(5)} ${r.id.padEnd(30)} ${r.promptId.padEnd(15)} $${r.costUsd.toFixed(4)}  ${summary}${r.passed ? "" : `\n      ${r.failures.join("; ")}`}`);
  }
}

const byPrompt = summarizeByPrompt(results);
const passed = results.filter((r) => r.passed).length;
console.log(`\n${passed}/${results.length} passed, total cost $${total.toFixed(4)}${skipped.length ? `, skipped (budget): ${skipped.join(", ")}` : ""}`);
for (const [p, s] of Object.entries(byPrompt)) console.log(`  ${p}: ${s.passed}/${s.total}${s.allPassed ? " (all passed)" : ""}`);

if (!mock) {
  if (!existsSync(EVAL_RESULTS_DIR)) mkdirSync(EVAL_RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(EVAL_RESULTS_DIR, `${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        models: { HIGH: resolveModel("HIGH"), MEDIUM: resolveModel("MEDIUM"), LOW: resolveModel("LOW") },
        retrieval: process.env.RESEARCH_WEB_SEARCH ?? "on",
        totalCostUsd: total,
        passed,
        total: results.length,
        skipped,
        byPrompt,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nResults written to ${file}`);
}
process.exit(passed === results.length ? 0 : 1);
