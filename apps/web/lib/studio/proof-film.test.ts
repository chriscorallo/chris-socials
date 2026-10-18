import { describe, it, expect } from "vitest";
import { PROOF_FILM } from "@chris/cinema/pure";
import { FALLBACK_CATALOG, LexicalEmbedder, runMeaningMatchFirstPass, type StudioFilm } from "@chris/agents/studio";
import { CinemaFilmEngine } from "./cinema-engine";

describe("Chris's example on the REAL proof film ('The Raise')", () => {
  it("the free first pass flags 'You raised your baseline.': the plane rises THROUGH the apartment and car instead of lifting them", async () => {
    const e = new CinemaFilmEngine(null);
    const film = PROOF_FILM as unknown as StudioFilm;
    const facts = e.describeShots(film);
    // The engine's own evaluator: the baseline, apartment and car ARE in frame — so it's not a framing problem…
    const b = facts.find((f) => f.shotId === "baseline")!;
    for (const id of ["baseline", "building", "car"]) expect(b.actors.find((a) => a.id === id)!.inFrame).toBe(true);
    const r = await runMeaningMatchFirstPass({ film, script: null, catalog: FALLBACK_CATALOG, embedder: new LexicalEmbedder(), facts });
    const c = r.report.checks.find((x) => x.shotId === "baseline")!;
    // …it's a meaning problem: the floor under your life doesn't go up, a glow passes by.
    expect(c.verdict).toBe("MISMATCH");
    expect(c.evidence.find((x) => x.ref === "rule:BASELINE_RISES")!.detail).toContain("THROUGH the building and car");
    expect(c.replacement!.catalogRefs).toContain("action:MOVE");
    // Nothing else in the proof film trips a concept rule.
    expect(r.report.checks.filter((x) => x.verdict === "MISMATCH").map((x) => x.shotId)).toEqual(["baseline"]);
  });
});
