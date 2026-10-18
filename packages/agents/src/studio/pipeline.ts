import { createHash } from "node:crypto";
import { getAgentPrompt } from "../prompt-context";
import type { ModelImageInput } from "../model-provider";
import type { FilmEnginePort, RenderResult, StoryboardResult } from "./engine-port";
import type { StudioFilm } from "./film-types";
import { flattenShots } from "./film-types";
import { checkContinuity, checkCoverage, checkQualityBasics, claimKey, lineIdForShot, verifyFilm, type VerificationReport } from "./deterministic";
import { guardDirectorDecision, PASS, block, type FinalDecision, type FilmHardGates } from "./gates";
import { LocalAiUnavailableError, type FreeModelProvider } from "./local-ai-provider";
import { runMeaningMatchFirstPass, type MeaningFirstPass, type TextEmbedder } from "./meaning-match";
import { buildFixPack, buildReviewPack, buildWritePack, buildFinalPack, PACK_SCHEMAS, parsePackAnswer, type FixPackInput, type Pack, type PackKind } from "./packs";
import {
  FilmBriefSchema,
  FilmScriptSchema,
  type FilmBrief,
  type FilmScript,
  type FinalPackResponse,
  type FixPackResponse,
  type QualityIssue,
  type ReviewPackResponse,
  type WritePackResponse,
  type ContinuityIssue,
} from "./schemas";
import type { ArtifactAgent, FilmRecord, FilmStore, FilmVersionRecord, NewArtifact, NewFilm, PendingPack, VersionOrigin } from "./store";

/**
 * Mini-movie Studio orchestrator — deterministic code that drives the crew (spec §4: ONE
 * orchestrator + specialists exchanging typed, persisted artifacts; no free chat).
 *
 *   WRITE (round trip a: Director brief + Hook + Screenwriter + Cinematographer)
 *     → VALIDATE (engine validator + script↔shot coverage; FIX round trip on errors, ≤ maxRepairs)
 *     → VERIFY   (math + number tracing — HARD GATE; FIX round trip on a failure)
 *     → STORYBOARD (engine job) → AUTO_REVIEW (Meaning-Match first pass, Continuity, Quality basics)
 *     → REVIEW (round trip b: Meaning-Match vision, Cohesion, Retention, Quality vision, fact check,
 *               Director decision) → guard (stricter-only) → REVISE (≤ maxIterations) | APPROVE
 *     → STORYBOARD_REVIEW (Chris: approve / redo shot / edit line / confirm facts)
 *     → RENDER (engine job) → FINAL_QC (render measurements; TECHNICAL gate) → READY
 *     (optional FINAL round trip: rendered-frame quality + first-time-viewer analysis)
 *
 * $0 by construction: round trips are answered by Chris's ChatGPT (paste) or the optional local
 * model, which must be a `FreeModelProvider` (`free: true`) — a billed provider is a type error
 * and is also refused at runtime. Every step is idempotent (artifact idempotency keys, engine
 * idempotency keys) and resumable: the film row records the step; a crash mid-step re-runs it.
 */

export class StudioPaidProviderError extends Error {
  constructor() {
    super("The studio only runs on free providers (your ChatGPT, or local AI on your Mac). A billed provider was refused.");
    this.name = "StudioPaidProviderError";
  }
}

export interface StudioDeps {
  store: FilmStore;
  engine: FilmEnginePort;
  embedder: TextEmbedder;
  /** Optional local AI (Ollama). Only used when the film's aiMode is LOCAL. */
  localAi?: FreeModelProvider | null;
  brandContext?: string | null;
  referenceMedianShotSeconds?: number | null;
  referencePacing?: string | null;
  /** Lease holder id (one worker per film). */
  worker?: string;
}

function assertFree(p: FreeModelProvider | null | undefined): void {
  if (p && (p as { free?: unknown }).free !== true) throw new StudioPaidProviderError();
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

// ---------------------------------------------------------------------------------------------
// Start

export async function startFilm(deps: StudioDeps, input: NewFilm): Promise<FilmRecord> {
  assertFree(deps.localAi);
  const film = await deps.store.createFilm(input);
  await deps.store.addArtifact(art(film, null, "BRIEF_REQUEST", "CHRIS", "CHRIS", `Chris asked for: "${input.idea.slice(0, 160)}" (~${input.targetSeconds}s, ${input.look}, voice ${input.voiceId}).`, { idea: input.idea, targetSeconds: input.targetSeconds, look: input.look, voiceId: input.voiceId, voiceEngine: input.voiceEngine, aiMode: input.aiMode }, null, `${film.id}:start`));
  return film;
}

/** Optional: start from a ChatGPT draft Chris already has (the WRITE answer pasted at creation). */
export async function startFilmFromDraft(deps: StudioDeps, input: NewFilm, draftText: string) {
  const film = await startFilm(deps, input);
  const r = await submitPackAnswer(deps, film.id, draftText, input.createdBy, "WRITE");
  return { film: (await deps.store.getFilm(film.id))!, result: r };
}

function art(film: Pick<FilmRecord, "id" | "iteration">, versionId: string | null, kind: string, agent: ArtifactAgent, via: string, summary: string, payload: unknown, gate: "PASS" | "BLOCK" | null, key: string, promptVersion: string | null = null): NewArtifact {
  return { filmId: film.id, versionId, kind, agent, via, promptVersion, iteration: film.iteration, idempotencyKey: key, summary, payload, gate };
}

// ---------------------------------------------------------------------------------------------
// Current state helpers

interface Current {
  version: FilmVersionRecord;
  script: FilmScript | null;
  brief: FilmBrief | null;
}

async function current(deps: StudioDeps, film: FilmRecord): Promise<Current | null> {
  if (!film.currentVersionId) return null;
  const version = await deps.store.getVersion(film.currentVersionId);
  if (!version) return null;
  const script = FilmScriptSchema.safeParse(version.script);
  const brief = FilmBriefSchema.safeParse(version.brief);
  return { version, script: script.success ? script.data : null, brief: brief.success ? brief.data : null };
}

/** Chris's choices are authority 1: narrator + format are enforced on whatever the crew wrote. */
function withChrisChoices(film: FilmRecord, dsl: unknown): unknown {
  if (!dsl || typeof dsl !== "object") return dsl;
  const d = { ...(dsl as Record<string, unknown>) };
  const narr = (d.narration && typeof d.narration === "object" ? d.narration : {}) as Record<string, unknown>;
  d.narration = { ...narr, engine: film.voiceEngine, voice: film.voiceId };
  d.format = { width: 1080, height: 1920, fps: 30 };
  if (typeof d.look !== "string") d.look = film.look;
  if (d.dsl === undefined) d.dsl = 1;
  return d;
}

function validated(deps: StudioDeps, film: FilmRecord, cur: Current): { ok: true; film: StudioFilm } | { ok: false; problems: string } {
  const v = deps.engine.validateFilm(withChrisChoices(film, cur.version.film));
  const problems: string[] = [];
  if (!v.ok) problems.push(deps.engine.formatIssues(v.errors));
  if (v.ok && cur.script) for (const c of checkCoverage(cur.script, v.film)) problems.push(`- ${c.path}: ${c.message}`);
  if (!cur.script) problems.push("- script: missing or doesn't match the FilmScript shape.");
  if (problems.length) return { ok: false, problems: problems.join("\n") };
  return { ok: true, film: (v as { film: StudioFilm }).film };
}

async function newVersion(deps: StudioDeps, film: FilmRecord, origin: VersionOrigin, dsl: unknown, script: unknown, brief: unknown, note: string, actor: string): Promise<FilmVersionRecord> {
  return deps.store.addVersion({ filmId: film.id, origin, parentVersionId: film.currentVersionId, film: dsl, script, brief, note, createdBy: actor });
}

// ---------------------------------------------------------------------------------------------
// Packs

async function issuePack(deps: StudioDeps, film: FilmRecord, pack: Pack, reason?: string): Promise<FilmRecord> {
  if (film.pending?.kind === pack.kind && film.pending.prompt === pack.prompt) return film;
  if (film.counters.roundTrips >= film.limits.maxRoundTrips) {
    return deps.store.updateFilm(film.id, { status: "STOPPED", pending: null, statusMessage: `Stopped: this film used all ${film.limits.maxRoundTrips} ChatGPT round trips. Start a new version or raise the limit.` });
  }
  const pending: PendingPack = { kind: pack.kind, title: pack.title, prompt: pack.prompt, imageUrl: pack.imageUrl, promptVersions: pack.promptVersions, reason, issuedAt: new Date().toISOString() };
  await deps.store.addArtifact(art(film, film.currentVersionId, "PACK_ISSUED", "ORCHESTRATOR", "DETERMINISTIC", `Ready for ChatGPT: ${pack.title} (${Math.round(pack.chars / 1000)}k characters${pack.imageUrl ? " + storyboard image" : ""}).`, { kind: pack.kind, chars: pack.chars, imageUrl: pack.imageUrl, promptVersions: pack.promptVersions, reason: reason ?? null, promptSha: sha(pack.prompt) }, null, `${film.id}:pack:${film.counters.roundTrips + 1}:${pack.kind}`));
  const next = await deps.store.updateFilm(film.id, {
    status: "NEEDS_CHATGPT",
    pending,
    counters: { ...film.counters, roundTrips: film.counters.roundTrips + 1 },
    statusMessage: pack.kind === "WRITE" ? "Your crew is ready — ask ChatGPT to write the film." : pack.kind === "REVIEW" ? "Storyboard is ready — ask ChatGPT for the crew's review." : pack.kind === "FIX" ? "One quick fix round with ChatGPT." : "Optional: ask ChatGPT to check the finished film.",
  });
  if (next.aiMode === "LOCAL" && deps.localAi) return runLocal(deps, next, pack);
  return next;
}

async function runLocal(deps: StudioDeps, film: FilmRecord, pack: Pack): Promise<FilmRecord> {
  if (film.counters.localAiCalls >= film.limits.maxLocalAiCalls) {
    return deps.store.updateFilm(film.id, { statusMessage: `Local AI limit reached (${film.limits.maxLocalAiCalls} calls) — use ChatGPT for this step.` });
  }
  const images: ModelImageInput[] = [];
  if (pack.imageUrl && deps.engine.loadImage) {
    const img = await deps.engine.loadImage(pack.imageUrl).catch(() => null);
    if (img) images.push({ ...img, label: "Storyboard contact sheet" });
  }
  const counted = await deps.store.updateFilm(film.id, { counters: { ...film.counters, localAiCalls: film.counters.localAiCalls + 1 }, statusMessage: "Your Mac's local AI is working on it…" });
  try {
    const r = await deps.localAi!.completeStructured({
      modelClass: pack.kind === "REVIEW" ? "HIGH" : "MEDIUM",
      systemPrompt: getAgentPrompt("SYSTEM_BASE").body,
      userPrompt: pack.prompt,
      images: images.length ? images : undefined,
      schema: PACK_SCHEMAS[pack.kind] as never,
      promptId: `FILM_PACK_${pack.kind}`,
    });
    await applyAnswer(deps, counted, pack.kind, r.output as never, "LOCAL_AI", `local:${sha(JSON.stringify(r.output))}`, "local-ai");
    return (await deps.store.getFilm(film.id))!;
  } catch (err) {
    const msg = err instanceof LocalAiUnavailableError ? err.message : `Local AI's answer didn't fit (${err instanceof Error ? err.message : String(err)})`;
    return deps.store.updateFilm(film.id, { statusMessage: `${msg} — you can use ChatGPT for this step instead.` });
  }
}

export type SubmitResult = { ok: true; alreadyApplied: boolean; repaired: string[] } | { ok: false; errors: string[]; repairMessage: string };

/** Chris pasted ChatGPT's answer. Tolerant parse → schema → artifacts → continue. */
export async function submitPackAnswer(deps: StudioDeps, filmId: string, text: string, actor: string, expectKind?: PackKind): Promise<SubmitResult> {
  assertFree(deps.localAi);
  const film = await deps.store.getFilm(filmId);
  if (!film) return { ok: false, errors: ["Film not found."], repairMessage: "" };
  // A double tap / re-paste of an answer that was already applied is a no-op, whatever the film is doing now.
  for (const k of ["WRITE", "REVIEW", "FIX", "FINAL"] as const) {
    if (await deps.store.findArtifact(`${film.id}:answer:${k}:${sha(text.trim())}`)) return { ok: true, alreadyApplied: true, repaired: [] };
  }
  const kind = film.pending?.kind ?? expectKind;
  if (!kind) return { ok: false, errors: ["The crew isn't waiting for a ChatGPT answer right now."], repairMessage: "" };
  const key = `${film.id}:answer:${kind}:${sha(text.trim())}`;
  const parsed = parsePackAnswer(kind, text);
  if (!parsed.ok) {
    await deps.store.addArtifact(art(film, film.currentVersionId, "PACK_REJECTED", "ORCHESTRATOR", "DETERMINISTIC", `ChatGPT's answer didn't fit (${parsed.errors.length} problem${parsed.errors.length === 1 ? "" : "s"}): ${parsed.errors[0]}`, { errors: parsed.errors, sha: sha(text), excerpt: text.slice(0, 2000) }, null, `${key}:rejected`));
    if (film.pending) await deps.store.updateFilm(film.id, { pending: { ...film.pending, lastErrors: parsed.errors, repairMessage: parsed.repairMessage } });
    return { ok: false, errors: parsed.errors, repairMessage: parsed.repairMessage };
  }
  await applyAnswer(deps, film, kind, parsed.value as never, "CHATGPT", key, actor, text);
  return { ok: true, alreadyApplied: false, repaired: parsed.repaired };
}

async function applyAnswer(deps: StudioDeps, film: FilmRecord, kind: PackKind, value: WritePackResponse | ReviewPackResponse | FixPackResponse | FinalPackResponse, via: "CHATGPT" | "LOCAL_AI", key: string, actor: string, raw?: string): Promise<void> {
  const pv = (id: string) => film.pending?.promptVersions.find((p) => p.id === id)?.version ?? null;
  await deps.store.addArtifact(art(film, film.currentVersionId, "PACK_ANSWER", "ORCHESTRATOR", via, `${via === "CHATGPT" ? "ChatGPT" : "Local AI"} answered the ${kind.toLowerCase()} round.`, { kind, sha: raw ? sha(raw) : null, excerpt: raw?.slice(0, 2000) ?? null }, null, key));
  const k = (s: string) => `${key}:${s}`;
  if (kind === "WRITE") {
    const w = value as WritePackResponse;
    await deps.store.addArtifact(art(film, null, "BRIEF", "FILM_DIRECTOR", via, `Brief: ${w.brief.premise}`, w.brief, null, k("brief"), pv("FILM_DIRECTOR")));
    const rec = w.hooks.options.find((h) => h.id === w.hooks.recommendedId) ?? w.hooks.options[0]!;
    await deps.store.addArtifact(art(film, null, "HOOKS", "FILM_HOOK", via, `${w.hooks.options.length} hooks; picked ${rec.id}: "${rec.line}" (${rec.mechanism}, stop ≈ ${rec.stopEstimate.score}/100, estimate).`, w.hooks, null, k("hooks"), pv("FILM_HOOK")));
    await deps.store.addArtifact(art(film, null, "SCRIPT", "FILM_SCREENWRITER", via, `Script: ${w.script.lines.length} lines, ~${Math.round(w.script.estimatedSeconds)}s, ${w.script.calculations.length} calculations, ${w.script.claims.filter((c) => c.kind === "FACT").length} facts to confirm.`, w.script, null, k("script"), pv("FILM_SCREENWRITER")));
    const v = await newVersion(deps, film, "CREW_WRITE", w.shots.film, w.script, w.brief, "First draft by the crew", actor);
    await deps.store.addArtifact(art(film, v.id, "SHOT_PLAN", "FILM_CINEMATOGRAPHER", via, `Shot list: ${w.shots.shotNotes.length} shots. ${w.shots.changeSummary}`, { shotNotes: w.shots.shotNotes, changeSummary: w.shots.changeSummary }, null, k("shots"), pv("FILM_CINEMATOGRAPHER")));
    await deps.store.updateFilm(film.id, { title: w.brief.workingTitle || film.title, currentVersionId: v.id, pending: null, status: "WORKING", step: "VALIDATE", statusMessage: "Checking the film…" });
    return;
  }
  if (kind === "FIX") {
    const f = value as FixPackResponse;
    const cur = await current(deps, film);
    const v = await newVersion(deps, film, "FIX", f.film, f.script ?? cur?.script ?? null, cur?.brief ?? null, f.changeSummary, actor);
    await deps.store.addArtifact(art(film, v.id, "SHOT_PLAN", "FILM_CINEMATOGRAPHER", via, `Fix: ${f.changeSummary}`, { changeSummary: f.changeSummary, scriptChanged: !!f.script }, null, k("fix"), pv("FILM_CINEMATOGRAPHER")));
    await deps.store.updateFilm(film.id, { currentVersionId: v.id, pending: null, status: "WORKING", step: "VALIDATE", statusMessage: "Checking the fix…" });
    return;
  }
  if (kind === "FINAL") {
    const f = value as FinalPackResponse;
    await deps.store.addArtifact(art(film, film.currentVersionId, "QUALITY_RENDER", "FILM_QUALITY", via, `Finished-film quality: ${f.quality.verdict} — ${f.quality.premiumBar.verdict} the premium bar. ${f.quality.topFixes[0] ?? ""}`.trim(), f.quality, null, k("quality"), pv("FILM_QUALITY")));
    await deps.store.addArtifact(art(film, film.currentVersionId, "ANALYSIS", "FILM_ANALYSIS", via, `First-time viewer: ${f.analysis.verdict} — ${f.analysis.headline}`, f.analysis, null, k("analysis"), pv("FILM_ANALYSIS")));
    await deps.store.updateFilm(film.id, { pending: null, status: "READY", statusMessage: "Your film is ready." });
    return;
  }
  // REVIEW
  const r = value as ReviewPackResponse;
  const vid = film.currentVersionId;
    await deps.store.addArtifact(art(film, vid, "MEANING_MATCH", "FILM_MEANING_MATCH", via, meaningSummary(r.meaningMatch.checks, shotNumberer(await validFilmOf(deps, film))), r.meaningMatch, null, k("mm"), pv("FILM_MEANING_MATCH")));
  await deps.store.addArtifact(art(film, vid, "COHESION", "FILM_COHESION", via, `${r.cohesion.metaphor.holds ? "One metaphor holds" : "Metaphor breaks"}; ending ${r.cohesion.ending.lands ? "lands" : "doesn't land"}; ${r.cohesion.issues.length} issue(s).`, r.cohesion, null, k("cohesion"), pv("FILM_COHESION")));
  await deps.store.addArtifact(art(film, vid, "RETENTION", "FILM_RETENTION", via, `Hook stop ≈ ${r.retention.hook.stop.score}/100 (estimate). ${r.retention.fixes.length} fix(es). ${r.retention.summary}`, r.retention, null, k("retention"), pv("FILM_RETENTION")));
  await deps.store.addArtifact(art(film, vid, "QUALITY", "FILM_QUALITY", via, `Storyboard quality: ${r.quality.verdict}, ${r.quality.premiumBar.verdict} the premium bar. ${r.quality.topFixes[0] ?? ""}`.trim(), r.quality, null, k("quality"), pv("FILM_QUALITY")));
  await deps.store.addArtifact(art(film, vid, "FACT_CHECK", "CLAIMS_GATE", via, `Fact check: ${r.factCheck.result}${r.factCheck.blockReason ? ` — ${r.factCheck.blockReason}` : ""}`, r.factCheck, r.factCheck.result === "BLOCK" ? "BLOCK" : "PASS", k("facts"), pv("CLAIMS_GATE")));
  await deps.store.addArtifact(art(film, vid, "DIRECTOR_DECISION", "FILM_DIRECTOR", via, `Director: ${r.director.decision} — ${r.director.notesForChris || r.director.rationale}`, r.director, null, k("director"), pv("FILM_DIRECTOR")));
  await decide(deps, (await deps.store.getFilm(film.id))!, r, via, actor);
}

// ---------------------------------------------------------------------------------------------
// Decision (code half of the Director — stricter only)

async function latestPayload<T>(deps: StudioDeps, film: FilmRecord, kind: string, versionId: string | null): Promise<T | null> {
  const all = await deps.store.listArtifacts(film.id);
  const hit = all.filter((a) => a.kind === kind && (versionId === null || a.versionId === versionId)).at(-1);
  return (hit?.payload as T) ?? null;
}

async function decide(deps: StudioDeps, film: FilmRecord, r: ReviewPackResponse, via: string, actor: string): Promise<void> {
  const cur = await current(deps, film);
  const val = cur ? validated(deps, film, cur) : null;
  if (!cur || !val?.ok || !cur.script) {
    await deps.store.updateFilm(film.id, { pending: null, status: "WORKING", step: "VALIDATE" });
    return;
  }
  const verification = verifyFilm({ script: cur.script, film: val.film, confirmedClaims: film.confirmedClaims, factCheck: r.factCheck, requireConfirmations: false });
  const first = await latestPayload<MeaningFirstPass>(deps, film, "MEANING_MATCH_AUTO", cur.version.id);
  const autoQuality = (await latestPayload<{ issues: QualityIssue[] }>(deps, film, "QUALITY_AUTO", cur.version.id))?.issues ?? [];
  const overruled = new Set(r.director.overruled.map((o) => o.ref));
  const isOverruled = (shotId: string) => [...overruled].some((ref) => ref === shotId || ref.endsWith(`:${shotId}`) || ref.includes(shotId));
  const unresolved = (first?.details ?? [])
    .filter((d) => d.forcing && !isOverruled(d.shotId))
    .map((d) => {
      const c = first!.report.checks.find((x) => x.shotId === d.shotId)!;
      return { shotId: d.shotId, line: c.line, fix: `Make the picture show "${c.line}": ${c.replacement?.description ?? ""} (${c.replacement?.dslHint ?? ""})` };
    });
  const blockingQuality = [...autoQuality, ...r.quality.issues].filter((q) => q.severity === "BLOCKING").map((q) => ({ shotId: q.shotId, detail: q.detail, fix: q.fix }));
  const gates: FilmHardGates = { verification: verification.gate, technical: PASS };
  const decision = guardDirectorDecision(r.director, { gates, unresolvedMismatches: unresolved, blockingQuality, iteration: film.iteration, maxIterations: film.limits.maxIterations });
  await deps.store.addArtifact(art(film, cur.version.id, "DECISION", "DIRECTOR_GUARD", "DETERMINISTIC", decisionSummary(decision), decision, decision.kind === "BLOCKED" ? "BLOCK" : decision.kind === "APPROVE" ? "PASS" : null, `${film.id}:v${cur.version.version}:i${film.iteration}:decision`));

  if (decision.kind === "APPROVE") {
    await deps.store.updateFilm(film.id, { pending: null, status: "NEEDS_CHRIS", step: "STORYBOARD_REVIEW", statusMessage: "The crew approved the storyboard — your turn." });
  } else if (decision.kind === "STOP") {
    await deps.store.updateFilm(film.id, { pending: null, status: "STOPPED", statusMessage: `The Director stopped: ${decision.rationale}` });
  } else if (decision.kind === "BLOCKED") {
    await deps.store.updateFilm(film.id, { pending: null, status: "BLOCKED", blockedReasons: decision.reasons, statusMessage: "Blocked by a hard gate — see why below." });
  } else {
    const next = await deps.store.updateFilm(film.id, { pending: null, iteration: film.iteration + 1, status: "WORKING" });
    if (r.revisedFilm && !decision.coerced) {
      const v = await newVersion(deps, next, "CREW_REVISION", r.revisedFilm, r.revisedScript ?? cur.script, cur.brief, `Round ${film.iteration} revision: ${decision.revisions.map((x) => x.instruction).join(" | ").slice(0, 400)}`, actor);
      await deps.store.addArtifact(art(next, v.id, "SHOT_PLAN", "FILM_CINEMATOGRAPHER", via, `Revision for round ${next.iteration}: ${decision.revisions.length} change(s).`, { revisions: decision.revisions }, null, `${film.id}:i${next.iteration}:revision-version`));
      await deps.store.updateFilm(film.id, { currentVersionId: v.id, step: "VALIDATE", statusMessage: `Round ${next.iteration}: checking the revision…` });
    } else {
      // The Director's answer had no revised film, or code forced revisions it didn't write.
      const base = r.revisedFilm ?? cur.version.film;
      const problems = decision.revisions.map((x) => `- [${x.target}${x.refs.length ? ` ${x.refs.join(", ")}` : ""}] ${x.instruction}`).join("\n");
      const atFix = await deps.store.updateFilm(film.id, { step: "FIX" });
      await issuePack(deps, atFix, buildFixPack({ reason: "REVISION", script: r.revisedScript ?? cur.script, film: base, problems, catalog: deps.engine.getCatalog() }), "REVISION");
    }
  }
}

const brief = (s: string, n = 90) => {
  const first = s.split(/ — | \(|; /)[0]!.trim();
  return first.length > n ? `${first.slice(0, n - 1).trimEnd()}…` : first;
};

/** Crew-room line for Meaning-Match, in Chris's words: shot 7 "you raised your baseline" → doesn't
 * show it: <why>. Fix: <what>. Mismatches first; loose matches only counted. */
export function meaningSummary(checks: Array<{ shotId: string; line: string; verdict: string; shown: string; evidence: Array<{ ref: string; detail: string }>; replacement: { description: string } | null }>, shotNumber: (id: string) => number): string {
  const mis = checks.filter((c) => c.verdict === "MISMATCH");
  const weak = checks.filter((c) => c.verdict === "WEAK").length;
  if (!mis.length) return weak ? `Every line's picture shows it (${weak} only loosely — fine for abstract lines).` : `All ${checks.length} lines' pictures show what's said.`;
  const parts = mis.slice(0, 2).map((c) => {
    const why = c.evidence.find((e) => e.ref.startsWith("rule:") && e.detail !== "the shot shows it")?.detail ?? c.shown;
    return `Shot ${shotNumber(c.shotId)} “${c.line}” → doesn't show it: ${brief(why)}. Fix: ${brief(c.replacement?.description ?? "—")}.`;
  });
  return `${parts.join(" ")}${mis.length > 2 ? ` (+${mis.length - 2} more)` : ""}${weak ? ` ${weak} other line${weak === 1 ? "" : "s"} only loosely match.` : ""}`;
}

function shotNumberer(film: StudioFilm | null): (id: string) => number {
  const ids = film ? flattenShots(film).map((f) => f.shot.id) : [];
  return (id) => ids.indexOf(id) + 1 || 0;
}

async function validFilmOf(deps: StudioDeps, film: FilmRecord): Promise<StudioFilm | null> {
  const cur = await current(deps, film);
  const v = cur ? validated(deps, film, cur) : null;
  return v?.ok ? v.film : null;
}

function decisionSummary(d: FinalDecision): string {
  switch (d.kind) {
    case "APPROVE":
      return `Approved for Chris: ${d.rationale}`;
    case "REVISE":
      return `Revise (${d.revisions.length} change${d.revisions.length === 1 ? "" : "s"})${d.coerced ? ` — code overrode the Director's call because: ${d.coercedBecause.join("; ")}` : ""}.`;
    case "BLOCKED":
      return `Blocked: ${d.reasons.join("; ")}`;
    case "STOP":
      return `Stopped: ${d.rationale}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Automatic findings → text for the review pack

function findingsText(v: VerificationReport, mm: MeaningFirstPass, cont: ContinuityIssue[], q: QualityIssue[], sb: StoryboardResult | null): string {
  const lines: string[] = [];
  lines.push(`VERIFICATION (hard gate, code): ${v.summary}`);
  for (const m of v.math) lines.push(`  - ${m.ok ? "✓" : "✗"} ${m.detail}`);
  for (const c of v.claimsToConfirm) lines.push(`  - FACT for Chris to confirm: "${c.text}" (${c.sourceNote ?? "no source given"})`);
  lines.push(`MEANING-MATCH FIRST PASS (concept rules + ${mm.embedderId}): ${mm.report.summary}`);
  for (const c of mm.report.checks) if (c.verdict !== "MATCH") lines.push(`  - ${c.shotId} "${c.line}" → ${c.verdict}${mm.details.find((d) => d.shotId === c.shotId)?.forcing ? " (rule — must be fixed or overruled with a reason)" : ""}: ${c.evidence.find((e) => e.ref.startsWith("rule:"))?.detail ?? c.shown}. Suggested: ${c.replacement?.description}`);
  lines.push(`CONTINUITY (code, DSL state diff): ${cont.length ? `${cont.length} issue(s)` : "no issues"}`);
  for (const c of cont) lines.push(`  - [${c.severity}] ${c.toShot}: ${c.detail} Fix: ${c.fix}`);
  lines.push(`QUALITY BASICS (code: text length/collisions, reading time, shot length, film length${sb?.stills.some((s) => s.metrics) ? ", measured contrast/safe zones/empty frames" : "; stills not measured"}): ${q.length ? `${q.length} issue(s)` : "no issues"}`);
  for (const i of q) lines.push(`  - [${i.severity}] ${i.shotId} ${i.kind}: ${i.detail} Fix: ${i.fix}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// The step machine

export interface AdvanceResult {
  film: FilmRecord;
  steps: string[];
  waitingFor: "CHATGPT" | "CHRIS" | "ENGINE" | null;
}

export async function advanceFilm(deps: StudioDeps, filmId: string, opts: { maxSteps?: number } = {}): Promise<AdvanceResult> {
  assertFree(deps.localAi);
  const holder = deps.worker ?? `w-${Math.random().toString(36).slice(2, 8)}`;
  const steps: string[] = [];
  let film = await deps.store.getFilm(filmId);
  if (!film) throw new Error(`No film ${filmId}`);
  if (!(await deps.store.acquireLease(filmId, 120_000, holder))) return { film, steps, waitingFor: "ENGINE" };
  try {
    for (let i = 0; i < (opts.maxSteps ?? 25); i++) {
      film = (await deps.store.getFilm(filmId))!;
      if (film.status !== "WORKING" && film.status !== "RENDERING") break;
      const before = `${film.step}:${film.currentVersionId}:${film.iteration}:${film.engineJob?.id ?? ""}`;
      try {
        await runStep(deps, film);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await deps.store.updateFilm(filmId, { status: "FAILED", lastError: msg, statusMessage: "Something broke on our side — tap Resume to pick up where it stopped." }).catch(() => undefined);
        steps.push(`${film.step}:FAILED`);
        break;
      }
      steps.push(film.step);
      const after = (await deps.store.getFilm(filmId))!;
      const now = `${after.step}:${after.currentVersionId}:${after.iteration}:${after.engineJob?.id ?? ""}`;
      if (now === before && after.status === film.status) break; // waiting on the engine
    }
  } finally {
    await deps.store.releaseLease(filmId, holder);
  }
  film = (await deps.store.getFilm(filmId))!;
  const waitingFor = film.status === "NEEDS_CHATGPT" ? "CHATGPT" : film.status === "NEEDS_CHRIS" ? "CHRIS" : film.status === "WORKING" || film.status === "RENDERING" ? "ENGINE" : null;
  return { film, steps, waitingFor };
}

async function runStep(deps: StudioDeps, film: FilmRecord): Promise<void> {
  const { store, engine } = deps;
  switch (film.step) {
    case "WRITE": {
      const voice = engine.listVoices().find((v) => v.id === film.voiceId) ?? null;
      await issuePack(deps, film, buildWritePack({ idea: film.idea, targetSeconds: film.targetSeconds, look: film.look, voice, catalog: engine.getCatalog(), brandContext: deps.brandContext ?? null, referencePacing: deps.referencePacing ?? null }));
      return;
    }
    case "VALIDATE": {
      const cur = await current(deps, film);
      if (!cur) {
        await store.updateFilm(film.id, { step: "WRITE" });
        return;
      }
      const v = validated(deps, film, cur);
      const key = `${film.id}:v${cur.version.version}:validation`;
      if (!v.ok) {
        await store.addArtifact(art(film, cur.version.id, "VALIDATION", "ENGINE", "DETERMINISTIC", `The engine can't read version ${cur.version.version} yet: ${v.problems.split("\n")[0]}`, { problems: v.problems }, "BLOCK", key));
        if (film.counters.repairs >= film.limits.maxRepairs) {
          await store.updateFilm(film.id, { status: "BLOCKED", blockedReasons: [`The film still doesn't validate after ${film.limits.maxRepairs} fix rounds.`, v.problems.slice(0, 600)], statusMessage: "The crew couldn't produce a film the engine can read." });
          return;
        }
        const f = await store.updateFilm(film.id, { counters: { ...film.counters, repairs: film.counters.repairs + 1 }, step: "FIX" });
        await issuePack(deps, f, buildFixPack({ reason: film.skipCreativeReview ? "CHRIS_EDIT" : "VALIDATION", script: cur.script, film: cur.version.film, problems: v.problems, catalog: engine.getCatalog() }), "VALIDATION");
        return;
      }
      await store.addArtifact(art(film, cur.version.id, "VALIDATION", "ENGINE", "DETERMINISTIC", `Version ${cur.version.version} is valid: ${flattenShots(v.film).length} shots, every script line has its shot.`, { shots: flattenShots(v.film).length }, "PASS", key));
      await store.updateFilm(film.id, { step: "VERIFY" });
      return;
    }
    case "VERIFY": {
      const cur = (await current(deps, film))!;
      const v = validated(deps, film, cur);
      if (!v.ok || !cur.script) return void (await store.updateFilm(film.id, { step: "VALIDATE" }));
      const rep = verifyFilm({ script: cur.script, film: v.film, confirmedClaims: film.confirmedClaims, requireConfirmations: false });
      await store.addArtifact(art(film, cur.version.id, "VERIFICATION", "VERIFICATION", "DETERMINISTIC", `Verification: ${rep.summary}`, rep, rep.gate.status, `${film.id}:v${cur.version.version}:verification`));
      if (rep.gate.status === "BLOCK") {
        if (film.counters.repairs >= film.limits.maxRepairs) {
          await store.updateFilm(film.id, { status: "BLOCKED", blockedReasons: rep.gate.reasons, statusMessage: "Blocked: the numbers still don't check out." });
          return;
        }
        const f = await store.updateFilm(film.id, { counters: { ...film.counters, repairs: film.counters.repairs + 1 }, step: "FIX" });
        await issuePack(deps, f, buildFixPack({ reason: "REVISION", script: cur.script, film: cur.version.film, problems: `The numbers must be right (hard gate). Fix the words or the numbers — code recomputes every calculation:\n${rep.gate.reasons.map((r) => `- ${r}`).join("\n")}`, catalog: engine.getCatalog() }), "VERIFICATION");
        return;
      }
      await store.updateFilm(film.id, { step: "STORYBOARD" });
      return;
    }
    case "STORYBOARD": {
      const cur = (await current(deps, film))!;
      const v = validated(deps, film, cur);
      if (!v.ok) return void (await store.updateFilm(film.id, { step: "VALIDATE" }));
      if (!engine.capabilities().storyboard) {
        await store.addArtifact(art(film, cur.version.id, "STORYBOARD", "ENGINE", "ENGINE", `No storyboard renderer here (${engine.capabilities().note ?? "not set up"}) — the crew reviews from the shot list only.`, { stills: [], contactSheetUrl: null }, null, `${film.id}:v${cur.version.version}:storyboard:none`));
        await store.updateFilm(film.id, { step: "AUTO_REVIEW", engineJob: null });
        return;
      }
      if (film.counters.storyboards >= film.limits.maxStoryboards) {
        await store.updateFilm(film.id, { status: "STOPPED", statusMessage: `Stopped: ${film.limits.maxStoryboards} storyboards used for this film.` });
        return;
      }
      const attempt = (await store.listArtifacts(film.id)).filter((a) => a.kind === "STORYBOARD_FAILED" && a.versionId === cur.version.id).length;
      const { jobId } = await engine.requestStoryboard({ filmId: film.id, versionId: cur.version.id, film: v.film, idempotencyKey: `${film.id}:${cur.version.id}:storyboard:${attempt}` });
      await store.updateFilm(film.id, { step: "STORYBOARD_WAIT", engineJob: { id: jobId, kind: "STORYBOARD", versionId: cur.version.id }, counters: { ...film.counters, storyboards: film.counters.storyboards + 1 }, statusMessage: "Drawing the storyboard…" });
      return;
    }
    case "STORYBOARD_WAIT": {
      const job = film.engineJob ? await engine.getJob(film.engineJob.id) : null;
      if (!job) return void (await store.updateFilm(film.id, { step: "STORYBOARD", engineJob: null }));
      if (job.status === "QUEUED" || job.status === "RUNNING") {
        const msg = `Drawing the storyboard… ${job.progressPct != null ? `${Math.round(job.progressPct)}%` : ""}`.trim();
        if (film.statusMessage !== msg) await store.updateFilm(film.id, { statusMessage: msg });
        return;
      }
      if (job.status === "FAILED" || !job.storyboard) {
        await store.addArtifact(art(film, film.engineJob!.versionId, "STORYBOARD_FAILED", "ENGINE", "ENGINE", `Storyboard failed: ${job.error ?? "no stills"}`, { error: job.error ?? null }, "BLOCK", `${film.id}:job:${job.id}:failed`));
        if (film.counters.storyboards >= film.limits.maxStoryboards) {
          await store.updateFilm(film.id, { status: "BLOCKED", blockedReasons: [`Technical: the storyboard renderer failed (${job.error ?? "unknown"}).`], engineJob: null });
          return;
        }
        await store.updateFilm(film.id, { step: "STORYBOARD", engineJob: null });
        return;
      }
      await store.addArtifact(art(film, film.engineJob!.versionId, "STORYBOARD", "ENGINE", "ENGINE", `Storyboard: ${job.storyboard.stills.length} stills.`, job.storyboard, "PASS", `${film.id}:job:${job.id}:done`));
      await store.updateFilm(film.id, { step: "AUTO_REVIEW", engineJob: null, statusMessage: "The automatic crew is checking the storyboard…" });
      return;
    }
    case "AUTO_REVIEW": {
      const cur = (await current(deps, film))!;
      const v = validated(deps, film, cur);
      if (!v.ok || !cur.script) return void (await store.updateFilm(film.id, { step: "VALIDATE" }));
      const sb = await latestPayload<StoryboardResult>(deps, film, "STORYBOARD", cur.version.id);
      const vk = `${film.id}:v${cur.version.version}`;
      const facts = engine.describeShots(v.film);
      const mm = await runMeaningMatchFirstPass({ film: v.film, script: cur.script, catalog: engine.getCatalog(), embedder: deps.embedder, facts });
            await store.addArtifact(art(film, cur.version.id, "MEANING_MATCH_AUTO", "MEANING_MATCH_FIRST_PASS", mm.embedderId.startsWith("lexical") ? "DETERMINISTIC" : "LOCAL_EMBEDDING", meaningSummary(mm.report.checks, shotNumberer(v.film)), mm, mm.details.some((d) => d.forcing) ? "BLOCK" : "PASS", `${vk}:mm-auto`));
      const cont = checkContinuity(v.film);
      await store.addArtifact(art(film, cur.version.id, "CONTINUITY", "CONTINUITY", "DETERMINISTIC", cont.length ? `${cont.length} continuity issue(s): ${cont[0]!.toShot} — ${cont[0]!.detail}` : "Continuity: objects, counts, screen direction and lighting all consistent.", { issues: cont }, null, `${vk}:continuity`));
      const q = checkQualityBasics({ film: v.film, stills: sb?.stills ?? [], targetSeconds: film.targetSeconds, referenceMedianShotSeconds: deps.referenceMedianShotSeconds ?? null });
      await store.addArtifact(art(film, cur.version.id, "QUALITY_AUTO", "QUALITY_BASICS", "DETERMINISTIC", q.length ? `${q.length} quality note(s): ${q[0]!.shotId} — ${q[0]!.detail}` : "Quality basics: text, timing and framing checks all pass.", { issues: q, measured: !!sb?.stills.some((s) => s.metrics) }, q.some((x) => x.severity === "BLOCKING") ? "BLOCK" : "PASS", `${vk}:quality-auto`));
      if (film.skipCreativeReview) {
        await store.updateFilm(film.id, { skipCreativeReview: false, status: "NEEDS_CHRIS", step: "STORYBOARD_REVIEW", statusMessage: "Updated — have a look." });
        return;
      }
      const rep = verifyFilm({ script: cur.script, film: v.film, confirmedClaims: film.confirmedClaims, requireConfirmations: false });
      const f = await store.updateFilm(film.id, { step: "REVIEW" });
      await issuePack(deps, f, buildReviewPack({ brief: cur.brief ?? fallbackBrief(film), script: cur.script, film: v.film, catalog: engine.getCatalog(), contactSheetUrl: sb?.contactSheetUrl ?? null, automaticFindings: findingsText(rep, mm, cont, q, sb), iteration: film.iteration, maxIterations: film.limits.maxIterations, brandContext: deps.brandContext ?? null, chrisNotes: film.chrisNotes }));
      return;
    }
    case "REVIEW":
    case "FIX":
      // Waiting for a round trip; nothing automatic to do (status is NEEDS_CHATGPT).
      if (!film.pending) await store.updateFilm(film.id, { step: film.step === "REVIEW" ? "AUTO_REVIEW" : "VALIDATE" });
      return;
    case "STORYBOARD_REVIEW":
      await store.updateFilm(film.id, { status: "NEEDS_CHRIS" });
      return;
    case "RENDER": {
      const cur = (await current(deps, film))!;
      const v = validated(deps, film, cur);
      if (!v.ok) return void (await store.updateFilm(film.id, { step: "VALIDATE", status: "WORKING" }));
      if (!engine.capabilities().render) {
        await store.updateFilm(film.id, { status: "NEEDS_CHRIS", step: "STORYBOARD_REVIEW", statusMessage: `Rendering isn't available here yet: ${engine.capabilities().note ?? "not set up"}.` });
        return;
      }
      if (film.counters.renders >= film.limits.maxRenders) {
        await store.updateFilm(film.id, { status: "STOPPED", statusMessage: `Stopped: ${film.limits.maxRenders} renders used for this film.` });
        return;
      }
      const { jobId } = await engine.requestRender({ filmId: film.id, versionId: cur.version.id, film: v.film, tier: "FINAL", idempotencyKey: `${film.id}:${cur.version.id}:render:${film.counters.renders}` });
      await store.updateFilm(film.id, { status: "RENDERING", step: "RENDER_WAIT", engineJob: { id: jobId, kind: "RENDER", versionId: cur.version.id }, counters: { ...film.counters, renders: film.counters.renders + 1 }, statusMessage: "Rendering your film…" });
      return;
    }
    case "RENDER_WAIT": {
      const job = film.engineJob ? await engine.getJob(film.engineJob.id) : null;
      if (!job) return void (await store.updateFilm(film.id, { step: "RENDER", status: "WORKING", engineJob: null }));
      if (job.status === "QUEUED" || job.status === "RUNNING") {
        const msg = `Rendering your film… ${job.progressPct != null ? `${Math.round(job.progressPct)}%` : ""}`.trim();
        if (film.statusMessage !== msg) await store.updateFilm(film.id, { statusMessage: msg });
        return;
      }
      if (job.status === "FAILED" || !job.render) {
        await store.addArtifact(art(film, film.engineJob!.versionId, "RENDER_FAILED", "ENGINE", "ENGINE", `Render failed: ${job.error ?? "no file"}`, { error: job.error ?? null }, "BLOCK", `${film.id}:job:${job.id}:failed`));
        const canRetry = film.counters.renders < film.limits.maxRenders;
        await store.updateFilm(film.id, canRetry ? { status: "NEEDS_CHRIS", step: "STORYBOARD_REVIEW", engineJob: null, statusMessage: `The render failed (${job.error ?? "unknown"}). Tap Render to try again.` } : { status: "BLOCKED", engineJob: null, blockedReasons: [`Technical: render failed (${job.error ?? "unknown"}).`] });
        return;
      }
      await store.addArtifact(art(film, film.engineJob!.versionId, "RENDER", "ENGINE", "ENGINE", `Rendered: ${job.render.durationSeconds.toFixed(1)}s${job.render.loudnessLufs != null ? `, ${job.render.loudnessLufs.toFixed(1)} LUFS` : ""}.`, job.render, "PASS", `${film.id}:job:${job.id}:done`));
      await store.updateFilm(film.id, { step: "FINAL_QC", engineJob: null, contentItemId: job.render.contentItemId ?? film.contentItemId });
      return;
    }
    case "FINAL_QC": {
      const cur = (await current(deps, film))!;
      const v = validated(deps, film, cur);
      const render = await latestPayload<RenderResult>(deps, film, "RENDER", cur.version.id);
      if (!v.ok || !render) return void (await store.updateFilm(film.id, { step: "RENDER" }));
      // The DSL-level notes were already reported at storyboard time; here only what was MEASURED on the render.
      const q = checkQualityBasics({ film: v.film, render, targetSeconds: film.targetSeconds }).filter((i) => i.evidence.some((e) => e.kind === "MEASURED"));
      const blocking = q.filter((i) => i.severity === "BLOCKING");
      const technical = blocking.length ? block(...blocking.map((b) => `${b.shotId}: ${b.detail}`)) : PASS;
      await store.addArtifact(art(film, cur.version.id, "QUALITY_RENDER_AUTO", "QUALITY_BASICS", "DETERMINISTIC", blocking.length ? `Blocking: ${blocking[0]!.detail}` : q.length ? `${q.length} note(s) on the render: ${q[0]!.detail}` : "Render checks pass (loudness, peaks, safe zones, contrast).", { issues: q, technical }, technical.status, `${film.id}:v${cur.version.version}:r${film.counters.renders}:final-qc`));
      if (technical.status === "BLOCK") {
        await store.updateFilm(film.id, { status: "NEEDS_CHRIS", step: "STORYBOARD_REVIEW", blockedReasons: technical.reasons, statusMessage: "The render has a problem that must be fixed before it can post — redo the shot(s) below." });
        return;
      }
      await store.updateFilm(film.id, { status: "READY", step: "DONE", blockedReasons: [], statusMessage: "Your film is ready." });
      return;
    }
    case "DONE":
      await store.updateFilm(film.id, { status: "READY" });
      return;
  }
}

function fallbackBrief(film: FilmRecord): FilmBrief {
  return { workingTitle: film.title, premise: film.idea, audience: "ambitious people in their 20s and 30s", promise: "one clear money insight", tone: "direct, skeptical", centralMetaphor: { idea: "(not set)", whyItFits: "(not set)", catalogRefs: [] }, keyNumbers: [], mustInclude: [], doNotExpandInto: [], targetSeconds: film.targetSeconds, successCriteria: ["lands in under a minute"], risks: [], uncertainty: "brief missing" };
}

// ---------------------------------------------------------------------------------------------
// Chris's actions (authority 1). Every one is an artifact (CHRIS) — the audit trail of overrides.

export type ChrisActionResult = { ok: true; film: FilmRecord } | { ok: false; message: string; film: FilmRecord | null };

async function chrisArtifact(deps: StudioDeps, film: FilmRecord, kind: string, summary: string, payload: unknown) {
  await deps.store.addArtifact(art(film, film.currentVersionId, kind, "CHRIS", "CHRIS", summary, payload, null, `${film.id}:chris:${kind}:${sha(JSON.stringify(payload) + Date.now() + Math.random())}`));
}

export async function confirmClaims(deps: StudioDeps, filmId: string, keys: string[], actor: string): Promise<ChrisActionResult> {
  const film = await deps.store.getFilm(filmId);
  if (!film) return { ok: false, message: "Film not found.", film: null };
  const set = [...new Set([...film.confirmedClaims, ...keys])];
  await chrisArtifact(deps, film, "CHRIS_CONFIRMED_FACTS", `Chris confirmed ${keys.length} fact(s) he stands behind.`, { keys, actor });
  return { ok: true, film: await deps.store.updateFilm(filmId, { confirmedClaims: set }) };
}

/** Approve the storyboard → render. Refused while the verification gate (incl. unconfirmed facts) blocks. */
export async function approveStoryboard(deps: StudioDeps, filmId: string, actor: string): Promise<ChrisActionResult> {
  const film = await deps.store.getFilm(filmId);
  if (!film) return { ok: false, message: "Film not found.", film: null };
  if (film.step !== "STORYBOARD_REVIEW") return { ok: false, message: "The storyboard isn't ready for approval yet.", film };
  const cur = await current(deps, film);
  const v = cur ? validated(deps, film, cur) : null;
  if (!cur?.script || !v?.ok) return { ok: false, message: "This version doesn't validate — redo a shot first.", film };
  const factCheck = await latestPayload<{ result: "PASS" | "PASS_WITH_REQUIRED_EDIT" | "BLOCK"; blockReason: string | null; requiredEdits: string[] }>(deps, film, "FACT_CHECK", null);
  const rep = verifyFilm({ script: cur.script, film: v.film, confirmedClaims: film.confirmedClaims, factCheck, requireConfirmations: true });
  if (rep.gate.status === "BLOCK") return { ok: false, message: rep.gate.reasons.join(" "), film };
  await chrisArtifact(deps, film, "CHRIS_APPROVED", "Chris approved the storyboard.", { versionId: film.currentVersionId, actor });
  return { ok: true, film: await deps.store.updateFilm(filmId, { status: "WORKING", step: "RENDER", blockedReasons: [], statusMessage: "Starting the render…" }) };
}

/** "Redo this shot" (+ optional note) → one FIX round trip for just those shots. */
export async function redoShots(deps: StudioDeps, filmId: string, shotIds: string[], note: string, actor: string): Promise<ChrisActionResult> {
  const film = await deps.store.getFilm(filmId);
  if (!film) return { ok: false, message: "Film not found.", film: null };
  if (film.step !== "STORYBOARD_REVIEW" && film.status !== "READY") return { ok: false, message: "You can redo shots once the storyboard is in front of you.", film };
  const cur = await current(deps, film);
  if (!cur) return { ok: false, message: "No film yet.", film };
  const mm = await latestPayload<MeaningFirstPass>(deps, film, "MEANING_MATCH_AUTO", cur.version.id);
  const hints = shotIds.map((id) => mm?.report.checks.find((c) => c.shotId === id)).filter(Boolean).map((c) => `- ${c!.shotId} "${c!.line}": first pass says ${c!.verdict}${c!.replacement ? ` — ${c!.replacement.description}` : ""}`);
  const problems = `Redo shot(s): ${shotIds.join(", ")}.${note.trim() ? `\nChris's note (he outranks the crew): ${note.trim()}` : ""}${hints.length ? `\nWhat the automatic crew saw:\n${hints.join("\n")}` : ""}`;
  await chrisArtifact(deps, film, "CHRIS_REDO", `Chris asked to redo ${shotIds.join(", ")}${note ? `: "${note.slice(0, 120)}"` : ""}.`, { shotIds, note, actor });
  const f = await deps.store.updateFilm(filmId, { chrisNotes: note.trim() ? [...film.chrisNotes, `${shotIds.join(", ")}: ${note.trim()}`] : film.chrisNotes, skipCreativeReview: true, step: "FIX", status: "WORKING" });
  const next = await issuePack(deps, f, buildFixPack({ reason: "REDO_SHOT", script: cur.script, film: cur.version.film, problems, catalog: deps.engine.getCatalog() } satisfies FixPackInput), "REDO_SHOT");
  return { ok: true, film: next };
}

/** Chris edits a narration line → a new version (CHRIS_EDIT) → validate/verify/storyboard again. */
export async function editLine(deps: StudioDeps, filmId: string, shotId: string, text: string, actor: string): Promise<ChrisActionResult> {
  const film = await deps.store.getFilm(filmId);
  if (!film) return { ok: false, message: "Film not found.", film: null };
  const cur = await current(deps, film);
  if (!cur?.script) return { ok: false, message: "No script yet.", film };
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || clean.length > 300) return { ok: false, message: "A line needs 1–300 characters.", film };
  const dsl = structuredClone(cur.version.film) as { scenes?: Array<{ shots?: Array<{ id: string; line?: string; say?: string }> }> };
  const shot = dsl.scenes?.flatMap((s) => s.shots ?? []).find((s) => s.id === shotId);
  if (!shot?.line) return { ok: false, message: "That shot has no narration line.", film };
  const lineId = lineIdForShot(cur.script, { line: shot.line } as never);
  const old = shot.line;
  shot.line = clean;
  delete shot.say;
  const script: FilmScript = { ...cur.script, lines: cur.script.lines.map((l) => (l.id === lineId ? { ...l, text: clean, say: null } : l)) };
  const v = await newVersion(deps, film, "CHRIS_EDIT", dsl, script, cur.brief, `Chris edited ${shotId}: "${old}" → "${clean}"`, actor);
  await chrisArtifact(deps, film, "CHRIS_EDIT_LINE", `Chris changed ${shotId}: “${old}” → “${clean}”.`, { shotId, from: old, to: clean, actor });
  return { ok: true, film: await deps.store.updateFilm(filmId, { currentVersionId: v.id, skipCreativeReview: true, step: "VALIDATE", status: "WORKING", statusMessage: "Checking your edit…" }) };
}

/** Optional FINAL round trip on the rendered film. */
export async function requestFinalCheck(deps: StudioDeps, filmId: string): Promise<ChrisActionResult> {
  const film = await deps.store.getFilm(filmId);
  if (!film || film.status !== "READY") return { ok: false, message: "The film isn't rendered yet.", film };
  const cur = (await current(deps, film))!;
  const render = await latestPayload<RenderResult>(deps, film, "RENDER", cur.version.id);
  const auto = await latestPayload<{ issues: QualityIssue[] }>(deps, film, "QUALITY_RENDER_AUTO", cur.version.id);
  const v = validated(deps, film, cur);
  if (!v.ok || !cur.script) return { ok: false, message: "This version doesn't validate.", film };
  const pack = buildFinalPack({ script: cur.script, film: v.film, contactSheetUrl: render?.contactSheetUrl ?? null, automaticFindings: (auto?.issues ?? []).map((i) => `- [${i.severity}] ${i.shotId}: ${i.detail}`).join("\n") || "No automatic findings." });
  const next = await issuePack(deps, film, pack);
  return { ok: true, film: next.status === "NEEDS_CHATGPT" ? next : next };
}

/** Clear the optional pending FINAL pack without answering. */
export async function skipFinalCheck(deps: StudioDeps, filmId: string): Promise<ChrisActionResult> {
  const film = await deps.store.getFilm(filmId);
  if (!film) return { ok: false, message: "Film not found.", film: null };
  if (film.pending?.kind !== "FINAL") return { ok: true, film };
  return { ok: true, film: await deps.store.updateFilm(filmId, { pending: null, status: "READY", statusMessage: "Your film is ready." }) };
}

/** After a FAILED step: continue from the recorded step (idempotent). */
export async function resumeFilm(deps: StudioDeps, filmId: string): Promise<ChrisActionResult> {
  const film = await deps.store.getFilm(filmId);
  if (!film) return { ok: false, message: "Film not found.", film: null };
  if (film.status !== "FAILED" && film.status !== "STOPPED") return { ok: true, film };
  return { ok: true, film: await deps.store.updateFilm(filmId, { status: film.engineJob?.kind === "RENDER" ? "RENDERING" : film.pending ? "NEEDS_CHATGPT" : "WORKING", lastError: null, statusMessage: "Picking up where it stopped…" }) };
}

export const studioClaimKey = claimKey;
