import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeCostUsd,
  runBrandGuardianAgent,
  runClaimsGateAgent,
  BilledModelCallError,
  type ModelProvider,
  type ModelUsage,
  type ResearchPacket,
  type StructuredCompletionRequest,
} from "@chris/agents";
import { z } from "zod";
import { EvalCaseSchema, type Assertion, type EvalCase, type EvalCaseResult, type ResearchFixture } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..", "..", "..");
export const EVAL_FIXTURES_DIR = join(REPO_ROOT, "fixtures", "evals");
export const EVAL_RESULTS_DIR = join(EVAL_FIXTURES_DIR, "results");

export function loadEvalCases(dir: string = EVAL_FIXTURES_DIR): EvalCase[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const cases = files.flatMap((f) => {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
    return z.array(EvalCaseSchema).parse(raw);
  });
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`Duplicate eval case id "${c.id}"`);
    ids.add(c.id);
  }
  return cases;
}

/** Brand context for evals comes straight from /brand/*.md (the same text the DB seeds from),
 * so an eval run needs no database. */
export function loadBrandContextFromFiles(): string {
  const read = (name: string) => readFileSync(join(REPO_ROOT, "brand", name), "utf8");
  return `## Brand Constitution\n\n${read("BRAND_CONSTITUTION.md")}\n\n---\n\n## Chris Brain\n\n${read("CHRIS_BRAIN.md")}`;
}

function toResearchPacket(r: ResearchFixture): ResearchPacket {
  return {
    primaryClaim: r.primaryClaim,
    facts: r.facts.map((f) => ({ ...f, type: f.type as ResearchPacket["facts"][number]["type"] })),
    citations: r.citations,
    numericInputs: r.numericInputs,
    calculationNotes: null,
    caveats: r.caveats,
    confidence: r.confidence,
    contradictoryEvidence: [],
    prohibitedClaims: r.prohibitedClaims,
    contentSafeWording: r.contentSafeWording || r.primaryClaim,
    status: "READY",
    stopResearching: true,
  };
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc == null ? undefined : (acc as Record<string, unknown>)[key]), obj);
}

/** Deterministic grading — returns the list of failed assertions (empty = pass). */
export function checkAssertions(output: unknown, assertions: Assertion[], mode: "all" | "any" = "all"): string[] {
  const failures: string[] = [];
  for (const a of assertions) {
    const v = getPath(output, a.path);
    const fail = (why: string) => failures.push(`${a.path}: ${why} (got ${JSON.stringify(v)})`);
    if (a.in && !a.in.includes(v as never)) fail(`expected one of ${JSON.stringify(a.in)}`);
    if (a.notIn && a.notIn.includes(v as never)) fail(`expected none of ${JSON.stringify(a.notIn)}`);
    if (a.gte !== undefined && !(typeof v === "number" && v >= a.gte)) fail(`expected >= ${a.gte}`);
    if (a.lt !== undefined && !(typeof v === "number" && v < a.lt)) fail(`expected < ${a.lt}`);
    if (a.nonEmpty && !((Array.isArray(v) || typeof v === "string") && v.length > 0)) fail("expected non-empty");
  }
  if (mode === "any") return failures.length < assertions.length ? [] : failures;
  return failures;
}

/** Records model + cost of every call made through it (no database needed). */
class MeteringProvider implements ModelProvider {
  costUsd = 0;
  usage: ModelUsage | null = null;
  private add(u: ModelUsage | undefined) {
    if (!u) return;
    const t = (this.usage ??= { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, webSearchRequests: 0, webFetchRequests: 0 });
    for (const k of Object.keys(t) as (keyof ModelUsage)[]) t[k] += u[k];
  }
  model: string | null = null;
  constructor(private readonly inner: ModelProvider) {}
  async completeStructured<T>(request: StructuredCompletionRequest<T>) {
    try {
      const result = await this.inner.completeStructured(request);
      this.model = result.model;
      this.costUsd += (result.usage && computeCostUsd(result.model, result.usage)) || 0;
      this.add(result.usage);
      return result;
    } catch (err) {
      if (err instanceof BilledModelCallError) {
        this.model = err.model;
        this.costUsd += (err.usage && computeCostUsd(err.model, err.usage)) || 0;
        this.add(err.usage);
      }
      throw err;
    }
  }
}

async function invoke(provider: ModelProvider, c: EvalCase, brandContext: string): Promise<unknown> {
  if (c.promptId === "CLAIMS_GATE") {
    const research = toResearchPacket(c.input.research);
    return runClaimsGateAgent(provider, {
      research,
      brandContext,
      script: c.input.mode === "SCRIPT" ? { spokenScript: c.input.script ?? "" } : undefined,
    });
  }
  return runBrandGuardianAgent(provider, {
    script: { spokenScript: c.input.script },
    brandContext,
    strategyContext: c.input.strategyContext,
  });
}

export async function runEvalCase(provider: ModelProvider, c: EvalCase, brandContext: string): Promise<EvalCaseResult> {
  const meter = new MeteringProvider(provider);
  const started = Date.now();
  try {
    const output = await invoke(meter, c, brandContext);
    const failures = checkAssertions(output, c.expect, c.promptId === "BRAND_GUARDIAN" ? c.expectMode : "all");
    return {
      id: c.id,
      category: c.category,
      promptId: c.promptId,
      passed: failures.length === 0,
      failures,
      output,
      costUsd: meter.costUsd,
      usage: meter.usage,
      latencyMs: Date.now() - started,
      model: meter.model,
    };
  } catch (err) {
    return {
      id: c.id,
      category: c.category,
      promptId: c.promptId,
      passed: false,
      failures: ["call failed"],
      output: null,
      error: err instanceof Error ? err.message : String(err),
      costUsd: meter.costUsd,
      usage: meter.usage,
      latencyMs: Date.now() - started,
      model: meter.model,
    };
  }
}

/** Sequential on purpose: predictable spend, and a budget check between cases. */
export async function runEvalSuite(
  provider: ModelProvider,
  cases: EvalCase[],
  opts: { brandContext?: string; maxCostUsd?: number; onResult?: (r: EvalCaseResult) => void } = {},
): Promise<{ results: EvalCaseResult[]; totalCostUsd: number; skipped: string[] }> {
  const brandContext = opts.brandContext ?? loadBrandContextFromFiles();
  const results: EvalCaseResult[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const c of cases) {
    if (opts.maxCostUsd !== undefined && total >= opts.maxCostUsd) {
      skipped.push(c.id);
      continue;
    }
    const r = await runEvalCase(provider, c, brandContext);
    total += r.costUsd;
    results.push(r);
    opts.onResult?.(r);
  }
  return { results, totalCostUsd: total, skipped };
}

/** Per-prompt verdict: a prompt "passes" only if every case targeting it ran and passed. */
export function summarizeByPrompt(results: EvalCaseResult[]): Record<string, { passed: number; total: number; allPassed: boolean }> {
  const out: Record<string, { passed: number; total: number; allPassed: boolean }> = {};
  for (const r of results) {
    const s = (out[r.promptId] ??= { passed: 0, total: 0, allPassed: true });
    s.total += 1;
    if (r.passed) s.passed += 1;
    else s.allPassed = false;
  }
  return out;
}
