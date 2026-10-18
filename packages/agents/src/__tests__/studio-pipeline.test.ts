import { describe, it, expect } from "vitest";
import { validateFilm, formatIssues } from "@chris/cinema/pure";
import {
  advanceFilm,
  approveStoryboard,
  claimKey,
  confirmClaims,
  crewRoomView,
  demoAnswerFor,
  demoFilm,
  demoReviewAnswer,
  demoWriteAnswer,
  DEMO_SCRIPT,
  editLine,
  extractJsonObject,
  FakeFilmEngine,
  FreeMockProvider,
  guardDirectorDecision,
  InMemoryFilmStore,
  LexicalEmbedder,
  OllamaModelProvider,
  LocalAiUnavailableError,
  parsePackAnswer,
  PASS,
  block,
  redoShots,
  requestFinalCheck,
  resumeFilm,
  startFilm,
  StudioPaidProviderError,
  submitPackAnswer,
  WritePackResponseSchema,
  type EngineValidation,
  type FilmLimits,
  type StudioDeps,
  type StudioFilm,
} from "../studio";
import { AnthropicModelProvider } from "../providers/anthropic-provider";

const realValidate = (dsl: unknown): EngineValidation => {
  const r = validateFilm(dsl);
  return r.ok ? { ok: true, film: r.film as unknown as StudioFilm, warnings: r.warnings } : { ok: false, errors: r.errors, warnings: r.warnings };
};

function setup(over: Partial<StudioDeps> = {}, engineOpts: ConstructorParameters<typeof FakeFilmEngine>[0] = {}) {
  const store = new InMemoryFilmStore();
  const engine = new FakeFilmEngine({ validate: realValidate, formatIssues, pollsToFinish: 2, ...engineOpts });
  const deps: StudioDeps = { store, engine, embedder: new LexicalEmbedder(), brandContext: "BRAND", ...over };
  return { store, engine, deps };
}

const newFilm = (limits?: Partial<FilmLimits>) => ({ title: "Raise", idea: "Why a raise disappears — and the fix", targetSeconds: 40, look: "GOLD_STUDIO", voiceId: "am_michael", voiceEngine: "KOKORO" as const, aiMode: "CHATGPT" as const, createdBy: "chris", ...(limits ? { limits: { maxIterations: 3, maxRoundTrips: 10, maxRepairs: 3, maxStoryboards: 8, maxRenders: 3, maxLocalAiCalls: 12, ...limits } } : {}) });

async function runUntilWaiting(deps: StudioDeps, id: string, rounds = 8) {
  let r = await advanceFilm(deps, id);
  for (let i = 0; i < rounds && r.waitingFor === "ENGINE"; i++) r = await advanceFilm(deps, id);
  return r;
}

async function currentFilm(deps: StudioDeps, id: string) {
  const f = await deps.store.getFilm(id);
  return (await deps.store.getVersion(f!.currentVersionId!))!.film;
}

describe("Studio orchestrator — happy path with the revise loop", () => {
  it("WRITE → validate → verify → storyboard → auto crew → REVIEW (revise: baseline) → round 2 → APPROVE → confirm facts → render → READY", async () => {
    const { deps, store, engine } = setup();
    const film = await startFilm(deps, newFilm());
    let r = await runUntilWaiting(deps, film.id);
    expect(r.waitingFor).toBe("CHATGPT");
    expect(r.film.pending!.kind).toBe("WRITE");
    expect(r.film.pending!.prompt).toContain("FILM DSL (v1)");
    expect(r.film.pending!.promptVersions.map((p) => p.id)).toEqual(["SYSTEM_BASE", "FILM_DIRECTOR", "FILM_HOOK", "FILM_SCREENWRITER", "FILM_CINEMATOGRAPHER"]);

    expect(await submitPackAnswer(deps, film.id, demoAnswerFor("WRITE", null), "chris")).toMatchObject({ ok: true });
    r = await runUntilWaiting(deps, film.id);
    expect(r.film.pending!.kind).toBe("REVIEW");
    expect(r.film.pending!.imageUrl).toMatch(/^data:image\/svg\+xml/);
    expect(r.film.pending!.prompt).toContain("rule — must be fixed or overruled");
    const autoMM = (await store.listArtifacts(film.id)).find((a) => a.kind === "MEANING_MATCH_AUTO")!;
    expect(autoMM.gate).toBe("BLOCK");
    expect(autoMM.summary).toContain("baseline “You raised your baseline.” → MISMATCH");

    await submitPackAnswer(deps, film.id, demoAnswerFor("REVIEW", await currentFilm(deps, film.id)), "chris");
    let f = (await store.getFilm(film.id))!;
    expect(f.iteration).toBe(2);
    expect((await store.listVersions(film.id)).map((v) => v.origin)).toEqual(["CREW_WRITE", "CREW_REVISION"]);

    r = await runUntilWaiting(deps, film.id);
    expect(r.film.pending!.kind).toBe("REVIEW");
    await submitPackAnswer(deps, film.id, demoAnswerFor("REVIEW", await currentFilm(deps, film.id)), "chris");
    f = (await store.getFilm(film.id))!;
    expect(f.status).toBe("NEEDS_CHRIS");
    expect(f.step).toBe("STORYBOARD_REVIEW");

    // Facts must be confirmed by Chris before render (authority 1 + factual hard gate).
    const refused = await approveStoryboard(deps, film.id, "chris");
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toContain("Taxes take 35%");
    await confirmClaims(deps, film.id, [claimKey("l2", "Taxes take 35%.")], "chris");
    expect((await approveStoryboard(deps, film.id, "chris")).ok).toBe(true);
    r = await runUntilWaiting(deps, film.id);
    expect(r.film.status).toBe("READY");
    expect(r.film.counters).toMatchObject({ roundTrips: 3, storyboards: 2, renders: 1, localAiCalls: 0 });
    expect(engine.requests.filter((x) => x.kind === "RENDER")).toHaveLength(1);

    const view = crewRoomView(r.film, await store.listArtifacts(film.id));
    expect(view.costUsd).toBe(0);
    expect(view.entries.find((e) => e.member.id === "verify")!.state).toBe("done");
    expect(view.timeline.some((t) => t.who === "Meaning-Match" && t.summary.includes("MISMATCH"))).toBe(true);

    // Optional final check round trip.
    const fc = await requestFinalCheck(deps, film.id);
    expect(fc.ok && fc.film.pending?.kind).toBe("FINAL");
    await submitPackAnswer(deps, film.id, demoAnswerFor("FINAL", null), "chris");
    expect((await store.getFilm(film.id))!.status).toBe("READY");
    expect((await store.listArtifacts(film.id)).some((a) => a.kind === "ANALYSIS")).toBe(true);
  });
});

describe("authority & hard gates", () => {
  const base = { unresolvedMismatches: [], blockingQuality: [], iteration: 1, maxIterations: 3 };
  const approve = { decision: "APPROVE" as const, rationale: "great", revisions: [], overruled: [], notesForChris: "" };
  it("a hard-gate BLOCK is never approved — REVISE while rounds remain, BLOCKED at the cap", () => {
    const gates = { verification: block("Math: wrong"), technical: PASS };
    expect(guardDirectorDecision(approve, { ...base, gates }).kind).toBe("REVISE");
    expect(guardDirectorDecision(approve, { ...base, gates, iteration: 3 }).kind).toBe("BLOCKED");
  });
  it("APPROVE over an unresolved Meaning-Match MISMATCH is coerced to REVISE (stricter only)", () => {
    const d = guardDirectorDecision(approve, { ...base, gates: { verification: PASS, technical: PASS }, unresolvedMismatches: [{ shotId: "baseline", line: "You raised your baseline.", fix: "raise it" }] });
    expect(d.kind).toBe("REVISE");
    expect(d.kind === "REVISE" && d.coerced).toBe(true);
  });
  it("the Director can't loosen: REVISE stays REVISE even with all gates passing", () => {
    const d = guardDirectorDecision({ ...approve, decision: "REVISE", revisions: [{ target: "SCRIPT", refs: ["l1"], instruction: "tighten", because: [{ kind: "REPORT", ref: "retention:l1", detail: "slow" }] }] }, { ...base, gates: { verification: PASS, technical: PASS } });
    expect(d.kind).toBe("REVISE");
  });

  it("in the pipeline: an APPROVE of the flawed draft gets a FIX round for the baseline shot instead", async () => {
    const { deps, store } = setup();
    const film = await startFilm(deps, newFilm());
    await runUntilWaiting(deps, film.id);
    await submitPackAnswer(deps, film.id, demoAnswerFor("WRITE", null), "chris");
    await runUntilWaiting(deps, film.id);
    const lazy = demoReviewAnswer(demoFilm(true)); // approves, and returns no revised film
    lazy.meaningMatch.checks = lazy.meaningMatch.checks.map((c) => ({ ...c }));
    await submitPackAnswer(deps, film.id, JSON.stringify(lazy), "chris");
    const f = (await store.getFilm(film.id))!;
    expect(f.status).toBe("NEEDS_CHATGPT");
    expect(f.pending!.kind).toBe("FIX");
    expect(f.pending!.prompt).toContain("Make the picture show \"You raised your baseline.\"");
    const decision = (await store.listArtifacts(film.id)).find((a) => a.kind === "DECISION")!;
    expect(decision.summary).toContain("code overrode the Director");
  });

  it("wrong math BLOCKs before any storyboard; out of repairs → BLOCKED with the reason", async () => {
    const { deps, store, engine } = setup();
    const film = await startFilm(deps, newFilm({ maxRepairs: 0 }));
    await runUntilWaiting(deps, film.id);
    const w = demoWriteAnswer();
    w.script.calculations = w.script.calculations.map((c) => (c.id === "c2" ? { ...c, claimed: 7000 } : c));
    await submitPackAnswer(deps, film.id, JSON.stringify(w), "chris");
    const r = await runUntilWaiting(deps, film.id);
    expect(r.film.status).toBe("BLOCKED");
    expect(r.film.blockedReasons.join(" ")).toContain("the math gives 6,500");
    expect(engine.requests).toHaveLength(0);
    expect((await store.listArtifacts(film.id)).find((a) => a.kind === "VERIFICATION")!.gate).toBe("BLOCK");
  });

  it("iteration cap: after maxIterations rounds the best version goes to Chris (gates passing), never loops forever", async () => {
    const { deps, store } = setup();
    const film = await startFilm(deps, newFilm({ maxIterations: 1 }));
    await runUntilWaiting(deps, film.id);
    await submitPackAnswer(deps, film.id, demoAnswerFor("WRITE", null), "chris");
    await runUntilWaiting(deps, film.id);
    await submitPackAnswer(deps, film.id, demoAnswerFor("REVIEW", await currentFilm(deps, film.id)), "chris");
    const f = (await store.getFilm(film.id))!;
    expect(f.step).toBe("STORYBOARD_REVIEW");
    expect(f.iteration).toBe(1);
  });
});

describe("robustness", () => {
  it("engine validation errors → one FIX round trip with the validator's own messages", async () => {
    const { deps, store } = setup();
    const film = await startFilm(deps, newFilm());
    await runUntilWaiting(deps, film.id);
    const w = demoWriteAnswer();
    (w.shots.film as { scenes: Array<{ shots: Array<{ actions?: unknown[] }> }> }).scenes[0]!.shots[1]!.actions = [{ do: "SET", actor: "raise", param: "count", to: 65, at: { word: "takes" } }];
    await submitPackAnswer(deps, film.id, JSON.stringify(w), "chris");
    const r = await runUntilWaiting(deps, film.id);
    expect(r.film.pending!.kind).toBe("FIX");
    expect(r.film.pending!.prompt).toContain('"takes" is not a word of this shot');
    await submitPackAnswer(deps, film.id, demoAnswerFor("FIX", null), "chris");
    const r2 = await runUntilWaiting(deps, film.id);
    expect(r2.film.pending!.kind).toBe("REVIEW");
    expect((await store.getFilm(film.id))!.counters.repairs).toBe(1);
  });

  it("a paste that doesn't fit is rejected with a one-tap repair message; a duplicate paste is a no-op", async () => {
    const { deps, store } = setup();
    const film = await startFilm(deps, newFilm());
    await runUntilWaiting(deps, film.id);
    const bad = await submitPackAnswer(deps, film.id, '```json\n{"brief": {}, }\n```', "chris");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.repairMessage).toContain("resend the COMPLETE JSON");
    expect((await store.getFilm(film.id))!.pending!.lastErrors!.length).toBeGreaterThan(0);
    const text = demoAnswerFor("WRITE", null);
    expect(await submitPackAnswer(deps, film.id, text, "chris")).toMatchObject({ ok: true, alreadyApplied: false });
    expect(await submitPackAnswer(deps, film.id, text, "chris")).toMatchObject({ ok: true, alreadyApplied: true });
    expect((await store.listVersions(film.id))).toHaveLength(1);
  });

  it("resumes after a crash mid-step without duplicating the engine job or artifacts", async () => {
    const { deps, store, engine } = setup();
    const film = await startFilm(deps, newFilm());
    await runUntilWaiting(deps, film.id);
    await submitPackAnswer(deps, film.id, demoAnswerFor("WRITE", null), "chris");
    store.failNextUpdate = 3; // VALIDATE ok, VERIFY ok, then crash on the STORYBOARD step's write (after the engine request)
    const crashed = await advanceFilm(deps, film.id);
    expect(crashed.film.status).toBe("FAILED");
    expect(crashed.film.lastError).toContain("simulated crash");
    await resumeFilm(deps, film.id);
    const r = await runUntilWaiting(deps, film.id);
    expect(r.film.pending!.kind).toBe("REVIEW");
    const keys = engine.requests.filter((x) => x.kind === "STORYBOARD").map((x) => x.key);
    expect(new Set(keys).size).toBe(1); // the retry reused the same idempotency key → same job
    const arts = await store.listArtifacts(film.id);
    expect(new Set(arts.map((a) => a.idempotencyKey)).size).toBe(arts.length);
  });

  it("a failed storyboard is retried; a failed render can be retried by Chris; limits stop the film", async () => {
    const { deps, store } = setup({}, { failStoryboards: 1, failRenders: 1 });
    const film = await startFilm(deps, newFilm({ maxIterations: 1 }));
    await runUntilWaiting(deps, film.id);
    await submitPackAnswer(deps, film.id, demoAnswerFor("WRITE", null), "chris");
    await runUntilWaiting(deps, film.id);
    expect((await store.listArtifacts(film.id)).some((a) => a.kind === "STORYBOARD_FAILED")).toBe(true);
    await submitPackAnswer(deps, film.id, demoAnswerFor("REVIEW", demoFilm(true)), "chris");
    await confirmClaims(deps, film.id, [claimKey("l2", "Taxes take 35%.")], "chris");
    await approveStoryboard(deps, film.id, "chris");
    let r = await runUntilWaiting(deps, film.id);
    expect(r.film.statusMessage).toContain("render failed");
    await approveStoryboard(deps, film.id, "chris");
    r = await runUntilWaiting(deps, film.id);
    expect(r.film.status).toBe("READY");

    const { deps: d2 } = setup();
    const f2 = await startFilm(d2, newFilm({ maxRoundTrips: 1 }));
    await runUntilWaiting(d2, f2.id);
    await submitPackAnswer(d2, f2.id, demoAnswerFor("WRITE", null), "chris");
    const stopped = await runUntilWaiting(d2, f2.id);
    expect(stopped.film.status).toBe("STOPPED");
    expect(stopped.film.statusMessage).toContain("round trips");
  });

  it("Chris's edits and redos (authority 1) skip the creative round and come straight back to him", async () => {
    const { deps, store } = setup();
    const film = await startFilm(deps, newFilm({ maxIterations: 1 }));
    await runUntilWaiting(deps, film.id);
    await submitPackAnswer(deps, film.id, demoAnswerFor("WRITE", null), "chris");
    await runUntilWaiting(deps, film.id);
    await submitPackAnswer(deps, film.id, demoAnswerFor("REVIEW", demoFilm(false)), "chris");
    const e = await editLine(deps, film.id, "end", "Same raise. Very different life.", "chris");
    expect(e.ok).toBe(true);
    let r = await runUntilWaiting(deps, film.id);
    expect(r.film.status).toBe("NEEDS_CHRIS");
    const versions = await store.listVersions(film.id);
    expect(versions.at(-1)!.origin).toBe("CHRIS_EDIT");

    const redo = await redoShots(deps, film.id, ["car"], "make the car red and bigger", "chris");
    expect(redo.ok && redo.film.pending!.kind).toBe("FIX");
    expect(redo.ok && redo.film.pending!.prompt).toContain("make the car red and bigger");
    await submitPackAnswer(deps, film.id, JSON.stringify({ film: { ...demoFilm(true), scenes: [{ ...demoFilm(true).scenes[0]!, shots: demoFilm(true).scenes[0]!.shots.map((s) => (s.id === "end" ? { ...s, line: "Same raise. Very different life." } : s)) }] }, script: { ...DEMO_SCRIPT, lines: DEMO_SCRIPT.lines.map((l) => (l.id === "l10" ? { ...l, text: "Same raise. Very different life." } : l)) }, changeSummary: "red car" }), "chris");
    r = await runUntilWaiting(deps, film.id);
    expect(r.film.status).toBe("NEEDS_CHRIS");
    expect((await store.listArtifacts(film.id)).filter((a) => a.agent === "CHRIS").map((a) => a.kind)).toEqual(expect.arrayContaining(["CHRIS_EDIT_LINE", "CHRIS_REDO"]));
  });
});

describe("$0 by construction", () => {
  it("refuses a billed provider at runtime (and the type forbids it)", async () => {
    const { deps } = setup();
    // @ts-expect-error — the Anthropic provider isn't a FreeModelProvider
    const paid: StudioDeps["localAi"] = new AnthropicModelProvider("sk-test-not-used");
    await expect(startFilm({ ...deps, localAi: paid }, newFilm())).rejects.toBeInstanceOf(StudioPaidProviderError);
  });

  it("LOCAL mode: the optional free local model answers the packs automatically", async () => {
    const store0 = new InMemoryFilmStore();
    const local = new FreeMockProvider((req) => {
      const kind = req.promptId.replace("FILM_PACK_", "") as "WRITE" | "REVIEW" | "FIX" | "FINAL";
      const f = [...store0.films.values()][0]!;
      const current = store0.versions.find((v) => v.id === f.currentVersionId)?.film ?? null;
      return extractJsonObject(demoAnswerFor(kind, current))!.value;
    });
    const { deps } = setup({ localAi: local, store: store0 });
    const store = store0;
    const film = await startFilm(deps, { ...newFilm(), aiMode: "LOCAL" });
    for (let i = 0; i < 6; i++) await runUntilWaiting(deps, film.id);
    const f = (await store.getFilm(film.id))!;
    expect(f.step).toBe("STORYBOARD_REVIEW");
    expect(f.counters.localAiCalls).toBeGreaterThanOrEqual(2);
    expect(local.calls.every((c) => c.schema)).toBe(true);
    expect((await store.listArtifacts(film.id)).some((a) => a.via === "LOCAL_AI")).toBe(true);
  });
});

describe("packs + parsing", () => {
  it("every demo answer parses (fences, chatter) and the WRITE schema rejects < 5 hooks", () => {
    for (const k of ["WRITE", "REVIEW", "FIX", "FINAL"] as const) expect(parsePackAnswer(k, demoAnswerFor(k, demoFilm(false))).ok).toBe(true);
    const w = demoWriteAnswer();
    w.hooks.options = w.hooks.options.slice(0, 3);
    expect(WritePackResponseSchema.safeParse(w).success).toBe(false);
  });
  it("tolerates smart quotes and trailing commas", () => {
    expect(extractJsonObject("Sure! {“a”: [1, 2,], }")?.value).toEqual({ a: [1, 2] });
    expect(extractJsonObject("no json here")).toBeNull();
  });
});

describe("local AI provider (Ollama, OpenAI-compatible)", () => {
  it("sends a json_schema request with the image and parses the answer", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"x": 1}\n```' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OllamaModelProvider({ baseUrl: "http://localhost:11434/", fetchImpl });
    const { z } = await import("zod");
    const r = await p.completeStructured({ modelClass: "MEDIUM", systemPrompt: "s", userPrompt: "u", images: [{ base64: "AAA", mediaType: "image/jpeg" }], schema: z.object({ x: z.number() }), promptId: "FILM_PACK_REVIEW" });
    expect(r.output).toEqual({ x: 1 });
    expect(r.model).toBe("local:qwen2.5vl:7b");
    expect((body.response_format as { type: string }).type).toBe("json_schema");
    expect(JSON.stringify(body.messages)).toContain("data:image/jpeg;base64,AAA");
    expect(p.free).toBe(true);
  });
  it("an unreachable Mac is a clear LocalAiUnavailableError", async () => {
    const p = new OllamaModelProvider({ baseUrl: "http://localhost:1", fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    const { z } = await import("zod");
    await expect(p.completeStructured({ modelClass: "LOW", systemPrompt: "s", userPrompt: "u", schema: z.object({}), promptId: "x" })).rejects.toBeInstanceOf(LocalAiUnavailableError);
  });
});
