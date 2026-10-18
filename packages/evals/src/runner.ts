import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeCostUsd,
  designVisualsForTimeline,
  groundedNumbers,
  numberIsGrounded,
  numbersShownBy,
  runBrandGuardianAgent,
  runClaimsGateAgent,
  runViewerPanelAgent,
  planViewerFrames,
  type ViewerReviewFacts,
  BilledModelCallError,
  type ModelProvider,
  type ModelUsage,
  type ResearchPacket,
  type StructuredCompletionRequest,
} from "@chris/agents";
import { z } from "zod";
import * as studio from "@chris/agents/studio";
import { getAgentPrompt } from "@chris/agents";
import { EditTimelineSchema } from "@chris/media/timeline";
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

type MotionCase = Extract<EvalCase, { promptId: "MOTION_DESIGNER" }>;

/** Runs the real Motion Designer on a synthetic one-take timeline and returns a gradeable
 * summary: the theme it chose, how taste was honored, and whether any shown number is
 * ungrounded (must always be 0 — the factual hard rule is code). */
async function runMotionCase(provider: ModelProvider, c: MotionCase, brandContext: string) {
  const tokens = c.input.script.split(/\s+/).filter(Boolean);
  const words = tokens.map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.34 }));
  const duration = Math.max(6, tokens.length * 0.4 + 0.5);
  const timeline = EditTimelineSchema.parse({
    version: 2,
    clips: [{ id: "c1", mediaAssetId: "take", sourceStart: 0, sourceEnd: duration }],
    captions: { enabled: true, fontId: "inter-display-bold", fontSize: 62, color: "#FFFFFF", highlightColor: "#FFD84D", y: 0.78 },
  });
  const research = c.input.numericInputs.length ? { primaryClaim: c.input.title, numericInputs: c.input.numericInputs, facts: [], calculationNotes: null } : null;
  const script = { spokenScript: c.input.script };
  const r = await designVisualsForTimeline(provider, {
    timeline,
    wordsByAsset: { take: words },
    research,
    script,
    tier: c.input.tier,
    brandContext,
    topic: { title: c.input.title, pillar: c.input.pillar },
    motionTaste: c.input.tasteContext || c.input.avoidTemplates.length || c.input.capDelta ? { context: c.input.tasteContext, avoidTemplates: c.input.avoidTemplates, capDelta: c.input.capDelta } : null,
  });
  const allowed = groundedNumbers(research, script);
  const avoid = new Set(c.input.avoidTemplates);
  return {
    theme: r.motionTheme,
    themeSource: r.themeSource,
    addedCount: r.added.length,
    addedTemplates: r.added.map((v) => v.template),
    avoidedTemplateUsed: r.added.some((v) => avoid.has(v.template)),
    ungroundedShown: r.added.reduce((n, v) => n + numbersShownBy(v.template, v.props).filter((x) => !numberIsGrounded(x.value, allowed)).length, 0),
    factualRejections: r.rejectedVisuals.filter((x) => x.reason.startsWith("FACTUAL")).length,
  };
}

type ViewerCase = Extract<EvalCase, { promptId: "VIEWER_PANEL" }>;

/** A 16×16 mid-grey JPEG: a neutral placeholder frame (the viewer case grades facts, not pixels). */
const PLACEHOLDER_JPEG =
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYwLjMuMTAwAP/bAEMACBAQExATFhYWFhYWGhgaGxsbGhoaGhsbGx0dHSIiIh0dHRsbHR0gICIiJSYlIyMiIyYmKCgoMDAuLjg4OkVFU//EAEoAAQAAAAAAAAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAAAAQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAQABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwAAD//Z";

/** Runs the real Viewer Panel on synthetic facts and returns a gradeable summary. */
async function runViewerCase(provider: ModelProvider, c: ViewerCase, brandContext: string) {
  const tokens = c.input.script.split(/\s+/).filter(Boolean);
  const words = tokens.map((word, i) => ({ word, start: c.input.startS + i * c.input.secondsPerWord, end: c.input.startS + i * c.input.secondsPerWord + c.input.secondsPerWord * 0.85 }));
  const durationS = (words.at(-1)?.end ?? 1) + c.input.tailS;
  const facts: ViewerReviewFacts = {
    subject: "CHRIS_RENDER",
    title: null,
    platform: c.input.platform,
    persona: "COLD",
    durationS,
    width: 1080,
    height: 1920,
    words,
    wordsSource: "synthetic eval timings",
    talking: true,
    cuts: c.input.cuts.map((x) => ({ t: x.t, kind: x.kind, removedS: x.removedS })),
    cutsSource: "EDIT",
    zooms: [],
    captions: { enabled: true, preset: "BOLD_HIGHLIGHT", uppercase: false },
    texts: [],
    graphics: c.input.graphics,
    music: c.input.backgroundUnderVoiceDb != null ? { present: true, levelDb: -6, duckDb: 0 } : { present: false, levelDb: null, duckDb: null },
    sfxCount: 0,
    audio: {
      integratedLufs: -14,
      truePeakDbtp: -1,
      clipping: false,
      voiceLevelDb: -18,
      backgroundLevelDb: c.input.backgroundUnderVoiceDb != null ? -18 - c.input.backgroundUnderVoiceDb : null,
      backgroundUnderVoiceDb: c.input.backgroundUnderVoiceDb,
      background: c.input.backgroundUnderVoiceDb != null ? "present" : "none",
      levelPerSecond: [],
      levelJumps: c.input.levelJumps,
      cutJumps: [],
    },
    referenceStyle: null,
    notes: ["Eval: the frames are neutral placeholders — judge from the transcript and the measured facts, and say so in limitations."],
  };
  const plan = planViewerFrames({ durationS, cutTimes: facts.cuts.map((x) => x.t) }, { maxFrames: 12 });
  const frames = plan.map((p) => ({ ...p, base64: PLACEHOLDER_JPEG, mediaType: "image/jpeg" as const }));
  const r = await runViewerPanelAgent(provider, { facts, frames, brandContext });
  const problems = new Set(r.review.craft.filter((x) => x.verdict !== "GOOD").map((x) => x.category));
  return {
    tier: r.review.verdict.tier,
    flagsChoppyCuts: problems.has("CUT_TOO_CHOPPY") || problems.has("CUT_MID_THOUGHT") || problems.has("CUT_WITHOUT_PURPOSE"),
    flagsMusicOverVoice: problems.has("MUSIC_OVER_VOICE"),
    flagsLevelJump: problems.has("AUDIO_LEVEL_JUMP"),
    flagsSlowPacing: problems.has("CUT_TOO_SLOW") || problems.has("PACING"),
    beats: r.review.beats.length,
    certaintyWarnings: r.warnings.filter((w) => /estimate/.test(w)).length,
    droppedForBadEvidence: r.warnings.filter((w) => /^Dropped/.test(w)).length,
  };
}

type FilmMeaningCase = Extract<EvalCase, { promptId: "FILM_MEANING_MATCH" }>;

/** Free first pass (code) + the FILM_MEANING_MATCH second pass on the same fixture film. */
async function runFilmMeaningCase(provider: ModelProvider, c: FilmMeaningCase) {
  const film = studio.demoFilm(c.input.variant !== "flawed");
  if (c.input.variant === "floor_alone") film.scenes[0]!.shots[5]!.actions = [{ do: "EXIT", actor: "building", at: 0 }, { do: "EXIT", actor: "car", at: 0 }, { do: "EXIT", actor: "subs", at: 0 }];
  const first = await studio.runMeaningMatchFirstPass({ film, script: studio.DEMO_SCRIPT, catalog: studio.FALLBACK_CATALOG, embedder: new studio.LexicalEmbedder() });
  const prompt = getAgentPrompt("FILM_MEANING_MATCH");
  const r = await provider.completeStructured({
    modelClass: "HIGH",
    systemPrompt: `${getAgentPrompt("SYSTEM_BASE").body}\n\n---\n\n${prompt.body}`,
    userPrompt: `THE FILM (DSL):\n${JSON.stringify(film)}\n\nFIRST PASS:\n${JSON.stringify(first.report)}\n\n(No storyboard image in this eval — judge from the DSL and say so in evidence.)`,
    schema: studio.MeaningMatchReportSchema,
    promptId: "FILM_MEANING_MATCH",
  });
  const verdicts = (checks: Array<{ shotId: string; verdict: string }>) => Object.fromEntries(checks.map((x) => [x.shotId, x.verdict]));
  return {
    firstPass: verdicts(first.report.checks),
    firstPassForcing: first.details.filter((d) => d.forcing).map((d) => d.shotId).join(","),
    review: verdicts(r.output.checks),
    reviewNonMatchHaveReplacement: r.output.checks.every((x) => x.verdict === "MATCH" || !!x.replacement),
  };
}

async function invoke(provider: ModelProvider, c: EvalCase, brandContext: string): Promise<unknown> {
  if (c.promptId === "FILM_MEANING_MATCH") return runFilmMeaningCase(provider, c);
  if (c.promptId === "VIEWER_PANEL") return runViewerCase(provider, c, brandContext);
  if (c.promptId === "CLAIMS_GATE") {
    const research = toResearchPacket(c.input.research);
    return runClaimsGateAgent(provider, {
      research,
      brandContext,
      script: c.input.mode === "SCRIPT" ? { spokenScript: c.input.script ?? "" } : undefined,
    });
  }
  if (c.promptId === "MOTION_DESIGNER") return runMotionCase(provider, c, brandContext);
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
