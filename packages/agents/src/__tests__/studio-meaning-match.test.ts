import { describe, it, expect } from "vitest";
import { demoFilm, DEMO_SCRIPT, FALLBACK_CATALOG, LexicalEmbedder, runMeaningMatchFirstPass, cosine, MeaningMatchReportSchema, type ShotFacts, type TextEmbedder } from "../studio";

const embedder = new LexicalEmbedder();

describe("Meaning-Match first pass — the 'you raised your baseline' case", () => {
  it("MISMATCH when the line says the baseline rose but no floor rises (the proof film's flaw) — with a concrete catalog replacement", async () => {
    const r = await runMeaningMatchFirstPass({ film: demoFilm(false), script: DEMO_SCRIPT, catalog: FALLBACK_CATALOG, embedder });
    const c = r.report.checks.find((x) => x.shotId === "baseline")!;
    expect(c.verdict).toBe("MISMATCH");
    expect(c.lineId).toBe("l7");
    expect(r.details.find((d) => d.shotId === "baseline")!.forcing).toBe(true);
    expect(c.replacement!.catalogRefs).toEqual(expect.arrayContaining(["actor:BASELINE", "action:SET.level"]));
    expect(c.evidence.some((e) => e.ref === "rule:BASELINE_RISES" && e.detail.includes("no baseline/floor rises"))).toBe(true);
    // Every other line in the draft shows what it says.
    expect(r.report.checks.filter((x) => x.verdict === "MISMATCH").map((x) => x.shotId)).toEqual(["baseline"]);
    // The report fits the crew's own schema (evidence everywhere, replacement on non-MATCH).
    expect(MeaningMatchReportSchema.safeParse(r.report).success).toBe(true);
  });

  it("MATCH once the baseline plane rises on 'raised' with the apartment and car on screen", async () => {
    const r = await runMeaningMatchFirstPass({ film: demoFilm(true), script: DEMO_SCRIPT, catalog: FALLBACK_CATALOG, embedder });
    expect(r.report.checks.find((x) => x.shotId === "baseline")!.verdict).toBe("MATCH");
    expect(r.details.some((d) => d.forcing)).toBe(false);
  });

  it("still MISMATCH if the floor rises alone — the things that raised it left the frame", async () => {
    const f = demoFilm(true);
    f.scenes[0]!.shots[5]!.actions = [{ do: "EXIT", actor: "building", at: 0 }, { do: "EXIT", actor: "car", at: 0 }, { do: "EXIT", actor: "subs", at: 0 }];
    const r = await runMeaningMatchFirstPass({ film: f, script: DEMO_SCRIPT, catalog: FALLBACK_CATALOG, embedder });
    const c = r.report.checks.find((x) => x.shotId === "baseline")!;
    expect(c.verdict).toBe("MISMATCH");
    expect(c.evidence.find((e) => e.ref === "rule:BASELINE_RISES")!.detail).toContain("aren't in frame");
  });

  it("uses the engine's in-frame facts: a rising baseline that is out of frame doesn't count", async () => {
    const f = demoFilm(true);
    const facts: ShotFacts[] = [{ shotId: "baseline", actors: [{ id: "baseline", kind: "BASELINE", visible: true, inFrame: false, changes: ["SET"] }], cameraTarget: "baseline", cameraMove: "CRANE_UP", textOnScreen: [] }];
    const r = await runMeaningMatchFirstPass({ film: f, script: DEMO_SCRIPT, catalog: FALLBACK_CATALOG, embedder, facts });
    expect(r.report.checks.find((x) => x.shotId === "baseline")!.verdict).toBe("MISMATCH");
  });

  it("on-screen text that repeats the line is not picture (it can't make a shot 'match')", async () => {
    const r = await runMeaningMatchFirstPass({ film: demoFilm(false), script: DEMO_SCRIPT, catalog: FALLBACK_CATALOG, embedder });
    expect(r.details.find((d) => d.shotId === "baseline")!.picture).not.toContain("You raised your baseline");
  });

  it("names other literal concepts: 'gone' needs something to leave, rent needs the building", async () => {
    const f = demoFilm(true);
    f.scenes[0]!.shots[0]!.text = [];
    f.scenes[0]!.shots[2]!.actions = [];
    const r = await runMeaningMatchFirstPass({ film: f, script: DEMO_SCRIPT, catalog: FALLBACK_CATALOG, embedder });
    expect(r.report.checks.find((x) => x.shotId === "hook")!.verdict).toBe("MISMATCH");
    expect(r.report.checks.find((x) => x.shotId === "rent")!.verdict).toBe("MISMATCH");
  });

  it("without a rule, similarity alone gives MATCH or WEAK (never a forcing MISMATCH) and suggests catalog alternatives", async () => {
    const lowSim: TextEmbedder = { id: "zero", thresholds: { match: 0.9, weak: 0.5 }, embed: async (t) => t.map((_, i) => Array.from({ length: 4 }, (__, k) => (k === i % 4 ? 1 : 0))) };
    const r = await runMeaningMatchFirstPass({ film: demoFilm(true), script: DEMO_SCRIPT, catalog: FALLBACK_CATALOG, embedder: lowSim });
    const end = r.report.checks.find((x) => x.shotId === "end")!;
    expect(end.verdict).toBe("WEAK");
    expect(end.replacement!.catalogRefs.length).toBeGreaterThan(0);
    expect(r.details.find((d) => d.shotId === "end")!.forcing).toBe(false);
  });

  it("lexical embedder: related text scores higher than unrelated", async () => {
    const [a, b, c] = await embedder.embed(["the baseline rises up", "a glowing baseline plane rises", "a car drives away"]);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  });
});
