import { describe, it, expect } from "vitest";
import {
  advanceFilm,
  approveStoryboard,
  claimKey,
  confirmClaims,
  demoAnswerFor,
  demoFilm,
  FakeFilmEngine,
  InMemoryFilmStore,
  LexicalEmbedder,
  runMeaningMatchFirstPass,
  DEMO_SCRIPT,
  startFilm,
  submitPackAnswer,
  type StudioDeps,
  type StudioFilm,
} from "@chris/agents/studio";
import { CinemaFilmEngine, pointInFrame, STUDIO_VOICES } from "./cinema-engine";
import { buildStudioFilmView } from "./view";
import { toEngineJob } from "./heavy-dispatch";

describe("CinemaFilmEngine adapter (real engine, pure parts)", () => {
  const engine = new CinemaFilmEngine(null);
  it("validates with the engine's own validator and explains errors for the repair loop", () => {
    expect(engine.validateFilm(demoFilm(true)).ok).toBe(true);
    const bad = structuredClone(demoFilm(true)) as unknown as { scenes: Array<{ shots: Array<{ actions?: unknown[] }> }> };
    bad.scenes[0]!.shots[1]!.actions = [{ do: "SET", actor: "raise", param: "count", to: 1, at: { word: "takes" } }];
    const r = engine.validateFilm(bad);
    expect(r.ok).toBe(false);
    expect(!r.ok && engine.formatIssues(r.errors)).toContain("Did you mean");
  });

  it("says plainly that storyboards/renders aren't connected until the heavy-job kinds exist", () => {
    expect(engine.capabilities()).toMatchObject({ storyboard: false, render: false });
    expect(engine.capabilities().note).toContain("aren't connected yet");
  });

  it("describeShots uses the real evaluator + projection: the fixed baseline shot keeps the baseline in frame", () => {
    const facts = engine.describeShots(demoFilm(true) as StudioFilm);
    const b = facts.find((f) => f.shotId === "baseline")!;
    expect(b.actors.find((a) => a.id === "baseline")).toMatchObject({ visible: true, inFrame: true });
    const hook = facts.find((f) => f.shotId === "hook")!;
    expect(hook.actors.find((a) => a.id === "raise")).toMatchObject({ visible: true, inFrame: true });
    expect(hook.actors.find((a) => a.id === "chart")!.visible).toBe(false);
  });

  it("the Meaning-Match first pass with the real engine's facts still catches the flawed baseline and clears the fixed one", async () => {
    for (const [fixed, verdict] of [[false, "MISMATCH"], [true, "MATCH"]] as const) {
      const film = demoFilm(fixed) as StudioFilm;
      const r = await runMeaningMatchFirstPass({ film, script: DEMO_SCRIPT, catalog: engine.getCatalog(), embedder: new LexicalEmbedder(), facts: engine.describeShots(film) });
      expect(r.report.checks.find((c) => c.shotId === "baseline")!.verdict).toBe(verdict);
    }
  });

  it("pointInFrame: in front vs behind vs far off-axis", () => {
    const cam = { position: [0, 1, 10], lookAt: [0, 1, 0], fov: 50 };
    expect(pointInFrame(cam, [0, 1, 0])).toBe(true);
    expect(pointInFrame(cam, [0, 1, 20])).toBe(false);
    expect(pointInFrame(cam, [9, 1, 0])).toBe(false);
  });

  it("voices: 7 Kokoro voices with ▶ samples + Chris's own voice", () => {
    expect(STUDIO_VOICES.filter((v) => v.engine === "KOKORO" && v.sampleUrl)).toHaveLength(7);
    expect(STUDIO_VOICES.some((v) => v.engine === "CHRIS")).toBe(true);
  });

  it("maps a heavy JobRun onto an EngineJob", () => {
    expect(toEngineJob("j", "SUCCEEDED", { jobKind: "film-storyboard", result: { stills: [], contactSheetUrl: null } }, null)).toMatchObject({ status: "DONE", kind: "STORYBOARD", storyboard: { stills: [] } });
    expect(toEngineJob("j", "FAILED", { jobKind: "film-render" }, "boom")).toMatchObject({ status: "FAILED", kind: "RENDER", error: "boom" });
    expect(toEngineJob("j", "QUEUED", null, null).status).toBe("QUEUED");
  });
});

describe("studio view model — the states the phone shows", () => {
  async function film() {
    const store = new InMemoryFilmStore();
    const engine = new FakeFilmEngine({ validate: (d) => new CinemaFilmEngine(null).validateFilm(d), pollsToFinish: 1 });
    const deps: StudioDeps = { store, engine, embedder: new LexicalEmbedder() };
    const f = await startFilm(deps, { title: "t", idea: "raise", targetSeconds: 40, look: "GOLD_STUDIO", voiceId: "am_michael", voiceEngine: "KOKORO", aiMode: "CHATGPT", createdBy: "c" });
    const view = async () => {
      const fr = (await store.getFilm(f.id))!;
      const versions = await store.listVersions(f.id);
      const cur = versions.find((v) => v.id === fr.currentVersionId);
      const v = cur ? engine.validateFilm(cur.film) : null;
      return buildStudioFilmView(fr, versions, await store.listArtifacts(f.id), v?.ok ? v.film : null);
    };
    const until = async () => {
      let r = await advanceFilm(deps, f.id);
      for (let i = 0; i < 5 && r.waitingFor === "ENGINE"; i++) r = await advanceFilm(deps, f.id);
    };
    return { deps, store, id: f.id, view, until };
  }

  it("walks: crew → ask ChatGPT (step 1) → ask ChatGPT (step 2, with image, baseline flagged) → storyboard (facts to confirm) → ready; always $0", async () => {
    const { deps, id, view, until } = await film();
    expect((await view()).phase).toBe("crew");
    await until();
    let v = await view();
    expect(v.phase).toBe("chatgpt");
    expect(v.pending).toMatchObject({ kind: "WRITE", stepNumber: 1, optional: false });
    expect(v.crew.entries.filter((e) => e.state === "waiting").map((e) => e.member.id)).toEqual(["director", "hook", "writer", "camera"]);

    await submitPackAnswer(deps, id, demoAnswerFor("WRITE", null), "c");
    await until();
    v = await view();
    expect(v.pending).toMatchObject({ kind: "REVIEW", stepNumber: 2 });
    expect(v.pending!.imageUrl).toBeTruthy();
    expect(v.storyboardIsSketch).toBe(true);
    const shot = v.storyboard.find((s) => s.shotId === "baseline")!;
    expect(shot).toMatchObject({ verdict: "MISMATCH" });
    expect(shot.verdictNote).toContain("no baseline/floor rises");
    expect(shot.fix).toContain("BASELINE");
    expect(v.crew.entries.find((e) => e.member.id === "meaning")!.state).toBe("waiting");

    const cur = async () => (await deps.store.getVersion((await deps.store.getFilm(id))!.currentVersionId!))!.film;
    await submitPackAnswer(deps, id, demoAnswerFor("REVIEW", await cur()), "c");
    await until();
    await submitPackAnswer(deps, id, demoAnswerFor("REVIEW", await cur()), "c");
    v = await view();
    expect(v.phase).toBe("storyboard");
    expect(v.can).toMatchObject({ approve: true, redo: true, edit: true, sendToVideos: false });
    expect(v.facts).toEqual([expect.objectContaining({ text: "Taxes take 35%.", confirmed: false })]);
    expect(v.storyboard.find((s) => s.shotId === "baseline")!.verdict).toBe("MATCH");
    expect(v.versions.map((x) => x.version)).toEqual([2, 1]);

    await confirmClaims(deps, id, [claimKey("l2", "Taxes take 35%.")], "c");
    await approveStoryboard(deps, id, "c");
    await until();
    v = await view();
    expect(v.phase).toBe("ready");
    expect(v.render).toBeTruthy();
    expect(v.can).toMatchObject({ sendToVideos: true, finalCheck: true });
    expect(v.costUsd).toBe(0);
    expect(v.finalReports[0]!.who).toContain("automatic");
  });
});
