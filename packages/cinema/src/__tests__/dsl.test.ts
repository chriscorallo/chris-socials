import { describe, expect, it } from "vitest";
import { formatIssues, validateFilm } from "../dsl/validate";
import { tokenizeLine } from "../dsl/words";
import { PROOF_FILM } from "../films/the-raise";
import type { Film } from "../dsl/schema";

const clone = (): Film => JSON.parse(JSON.stringify(PROOF_FILM)) as Film;

describe("film DSL validation", () => {
  it("accepts the proof film", () => {
    const r = validateFilm(PROOF_FILM);
    if (!r.ok) throw new Error(formatIssues(r.errors));
    expect(r.ok).toBe(true);
  });

  it("explains a misspelled word anchor with suggestions", () => {
    const f = clone();
    f.scenes[0]!.shots[2]!.actions![0]!.at = { word: "thirdy" };
    const r = validateFilm(f);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.errors.find((x) => x.path === "scenes[0].shots[2].actions[0].at");
    expect(e?.message).toContain('"thirdy" is not a word');
    expect(e?.hint).toContain("thirty");
  });

  it("anchors hyphenated words by their parts", () => {
    expect(tokenizeLine("Taxes take thirty-five percent.").map((t) => t.norm)).toEqual(["taxes", "take", "thirty", "five", "percent"]);
  });

  it("rejects unknown actors and names the cast", () => {
    const f = clone();
    f.scenes[0]!.shots[0]!.camera.target = "raize";
    const r = validateFilm(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.hint).toContain("raise");
  });

  it("requires a duration for a shot without a line", () => {
    const f = clone();
    delete f.scenes[0]!.shots[1]!.line;
    const r = validateFilm(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "scenes[0].shots[1].duration")).toBe(true);
  });

  it("reports shape errors at the exact field (unknown keys, ranges)", () => {
    const f = clone() as unknown as { scenes: Array<{ shots: Array<{ camera: { lens: { focalLength: number } }; colour?: string }> }> };
    f.scenes[0]!.shots[0]!.camera.lens.focalLength = 5;
    f.scenes[0]!.shots[0]!.colour = "red";
    const r = validateFilm(f);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.find((e) => e.path === "scenes[0].shots[0].camera.lens.focalLength")?.hint).toMatch(/Focal length/);
    expect(r.errors.find((e) => e.message.includes("colour"))).toBeTruthy();
  });

  it("refuses CONTINUE on the first shot and moving rigs without an end pose", () => {
    const f = clone();
    f.scenes[0]!.shots[0]!.camera.from = "CONTINUE";
    delete f.scenes[0]!.shots[1]!.camera.to;
    const r = validateFilm(f);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.path)).toEqual(expect.arrayContaining(["scenes[0].shots[0].camera.from", "scenes[0].shots[1].camera.to"]));
  });

  it("caps on-screen text length (footnotes excepted)", () => {
    const f = clone();
    f.scenes[0]!.shots[0]!.text![0]!.text = "x".repeat(70);
    const r = validateFilm(f);
    expect(r.ok).toBe(false);
  });
});
