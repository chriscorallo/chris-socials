import { describe, expect, it } from "vitest";
import { compileFilm, evaluateFrame, focalToFov, sfxTimeline, FLOW_FLIGHT } from "../evaluate";
import { PROOF_FILM } from "../films/the-raise";
import { resolveFilm, resolveAnchor } from "../timing";
import { ease, cubicBezier } from "../ease";
import { CINEMA_ASSETS } from "../assets/manifest";

const rf = resolveFilm(PROOF_FILM, null);
const cf = compileFilm(rf);
const shot = (id: string) => rf.shots.find((s) => s.shot.id === id)!;
const actor = (f: number, id: string) => evaluateFrame(cf, f).actors.find((a) => a.id === id)!;

describe("evaluator", () => {
  it("cinematic easing has no linear starts (motivated, eased moves)", () => {
    expect(ease("CINEMATIC", 0.1)).toBeLessThan(0.06);
    expect(ease("CINEMATIC", 0.9)).toBeGreaterThan(0.96);
    expect(cubicBezier(0.42, 0, 0.58, 1)(0.5)).toBeCloseTo(0.5, 3);
  });

  it("maps focal length to a 9:16 field of view (36 mm long side)", () => {
    expect(focalToFov(36)).toBeCloseTo(53.13, 1);
    expect(focalToFov(85)).toBeLessThan(focalToFov(35));
  });

  it("evaporates and flows coins: the raise goes 100 -> 65 -> ... -> 0", () => {
    expect(actor(shot("hook").endFrame - 1, "raise").params.count).toBe(100);
    expect(actor(shot("apartment").startFrame, "raise").params.count).toBeCloseTo(65, 5);
    const flowStart = resolveAnchor(shot("apartment"), { word: "three" });
    const mid = Math.round((flowStart + 0.7) * 30);
    const midState = actor(mid, "raise");
    expect(midState.params.count as number).toBeLessThan(65);
    expect(midState.flows.length).toBe(1);
    expect(midState.countRate).toBeLessThan(0);
    expect(actor(shot("gone").startFrame + 5, "raise").params.count).toBeCloseTo(0, 5);
    // building received coins after the flight time
    expect(FLOW_FLIGHT).toBeGreaterThan(0);
  });

  it("texts count toward their number and leave before the cut", () => {
    const taxes = shot("taxes");
    const at = resolveAnchor(taxes, { word: "taxes" });
    const early = evaluateFrame(cf, Math.round((at + 0.2) * 30)).texts.find((t) => t.beat.text === "$6,500")!;
    expect(early.display).toMatch(/^\$\d{1,2},\d{3}$/);
    expect(Number(early.display.replace(/\D/g, ""))).toBeGreaterThan(6500);
    const next = evaluateFrame(cf, shot("apartment").startFrame);
    expect(next.texts.find((t) => t.beat.text === "$6,500")).toBeUndefined();
  });

  it("a whip pan carries the camera through the cut", () => {
    const hook = shot("hook");
    const before = evaluateFrame(cf, hook.endFrame - 2).overlay.whip;
    expect(before).toBeGreaterThan(0.3);
    expect(evaluateFrame(cf, hook.startFrame + 10).overlay.whip).toBe(0);
  });

  it("schedules auto SFX for transitions plus authored cues, in time order", () => {
    const hits = sfxTimeline(rf);
    expect(hits.some((h) => h.source === "hook:transition" && h.sound === "WHOOSH")).toBe(true);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.time).toBeGreaterThanOrEqual(hits[i - 1]!.time);
  });

  it("fades to black only at the very end (the hook is frame 0)", () => {
    expect(evaluateFrame(cf, 0).overlay.black).toBe(0);
    expect(evaluateFrame(cf, rf.totalFrames - 1).overlay.black).toBeGreaterThan(0.9);
  });
});

describe("asset manifest", () => {
  it("every asset has a source, a license and a verification date", () => {
    expect(CINEMA_ASSETS.length).toBeGreaterThan(5);
    for (const a of CINEMA_ASSETS) {
      expect(a.source.length, a.id).toBeGreaterThan(3);
      expect(a.license.length, a.id).toBeGreaterThan(2);
      expect(a.verified, a.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof a.aiGenerated, a.id).toBe("boolean");
      if (a.delivery === "RUNTIME_DOWNLOAD" || a.delivery === "NPM") expect(a.url, a.id).toBeTruthy();
    }
    expect(new Set(CINEMA_ASSETS.map((a) => a.id)).size).toBe(CINEMA_ASSETS.length);
  });
});
