import { describe, it, expect } from "vitest";
import { PROOF_FILM } from "@chris/cinema/pure";
import { FALLBACK_CATALOG, LexicalEmbedder, runMeaningMatchFirstPass, type StudioFilm } from "@chris/agents/studio";
import { CinemaFilmEngine } from "./cinema-engine";

/**
 * Chris's example on the REAL proof film ('The Raise'). The first version played "You raised your
 * baseline." over a glow plane rising THROUGH the apartment and car; the engine's v1.1 re-cut
 * (packages/cinema films/the-raise.ts) puts you, your apartment and your car ON a PLATFORM that
 * rises (RAISE) and lifts them. The free first pass must accept the fix and still catch the flaw.
 */
describe("Chris's example on the REAL proof film ('The Raise')", () => {
  const e = new CinemaFilmEngine(null);

  it("the re-cut shows the floor under your life going up: nothing in the film trips a concept rule", async () => {
    const film = PROOF_FILM as unknown as StudioFilm;
    const facts = e.describeShots(film);
    const b = facts.find((f) => f.shotId === "baseline")!;
    for (const id of ["floor", "you", "building", "car"]) expect(b.actors.find((a) => a.id === id)!.inFrame, id).toBe(true);
    const r = await runMeaningMatchFirstPass({ film, script: null, catalog: FALLBACK_CATALOG, embedder: new LexicalEmbedder(), facts });
    expect(r.report.checks.find((x) => x.shotId === "baseline")!.verdict).not.toBe("MISMATCH");
    expect(r.report.checks.filter((x) => x.verdict === "MISMATCH").map((x) => x.shotId)).toEqual([]);
  });

  it("still catches the original flaw: the floor rises while the apartment and car stay on the ground", async () => {
    const flawed = JSON.parse(JSON.stringify(PROOF_FILM)) as typeof PROOF_FILM;
    for (const a of flawed.cast) if (a.id === "building" || a.id === "car") delete a.parent;
    const film = flawed as unknown as StudioFilm;
    const facts = e.describeShots(film);
    const r = await runMeaningMatchFirstPass({ film, script: null, catalog: FALLBACK_CATALOG, embedder: new LexicalEmbedder(), facts });
    const c = r.report.checks.find((x) => x.shotId === "baseline")!;
    expect(c.verdict).toBe("MISMATCH");
    expect(c.evidence.find((x) => x.ref === "rule:BASELINE_RISES")!.detail).toContain("THROUGH the building and car");
    expect(c.replacement!.catalogRefs).toContain("action:RAISE");
  });
});
