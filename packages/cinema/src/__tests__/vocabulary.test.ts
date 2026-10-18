import { describe, expect, it } from "vitest";
import type { Film } from "../dsl/schema";
import { validateFilm } from "../dsl/validate";
import { compileFilm, evaluateFrame } from "../evaluate";
import { resolveFilm } from "../timing";
import { PROOF_FILM } from "../films/the-raise";
import { POSES, skeletonFor } from "../figure-poses";
import { actorTopHeight, climbLocalPoint } from "../kinds";

const base = (cast: Film["cast"], actions: NonNullable<Film["scenes"][0]["shots"][0]["actions"]>, duration = 4): Film => ({
  dsl: 1,
  id: "v11",
  title: "v1.1",
  format: { width: 1080, height: 1920, fps: 30 },
  look: "GOLD_STUDIO",
  cast,
  scenes: [{ id: "s", set: { kind: "INFINITY_STUDIO" }, shots: [{ id: "a", duration, camera: { rig: "HOLD", target: [0, 1, 0], from: { distance: 8 }, lens: { focalLength: 32 } }, actions }] }],
});

const at = (film: Film, seconds: number) => {
  const v = validateFilm(film);
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  const cf = compileFilm(resolveFilm(v.film));
  return evaluateFrame(cf, Math.round(seconds * 30));
};

describe("DSL v1.1 vocabulary", () => {
  it("keeps v1 films valid (backward compatible): the proof film and a minimal v1 film", () => {
    expect(validateFilm(PROOF_FILM).ok).toBe(true);
    const v1: Film = base([{ id: "c", kind: "COIN_STACK", visible: true, params: { count: 10 } }], [{ do: "SET", actor: "c", param: "count", to: 20, at: 0.5 }]);
    expect(validateFilm(v1).ok).toBe(true);
    expect(at(v1, 3).actors[0]!.params.count).toBeCloseTo(20, 3);
  });

  it("a RAISEd platform lifts everything that rides on it (the literal 'raised your baseline')", () => {
    const film = base(
      [
        { id: "floor", kind: "PLATFORM", visible: true, params: { level: 0 } },
        { id: "me", kind: "FIGURE", parent: "floor", position: [1, 0, 0.5], visible: true },
        { id: "house", kind: "HOUSE", parent: "floor", position: [-2, 0, 0], visible: true },
      ],
      [{ do: "RAISE", actor: "floor", to: 1.6, at: 0.5, duration: 1.5 }],
    );
    const before = at(film, 0.2);
    const after = at(film, 3.5);
    const y = (s: typeof before, id: string) => s.actors.find((a) => a.id === id)!.position[1];
    expect(y(before, "me")).toBeCloseTo(0, 5);
    expect(y(after, "me")).toBeCloseTo(1.6, 3);
    expect(y(after, "house")).toBeCloseTo(1.6, 3);
    expect(after.actors.find((a) => a.id === "me")!.position[0]).toBeCloseTo(1, 5);
    expect(actorTopHeight("PLATFORM", { level: 1.6 })).toBeCloseTo(1.6);
  });

  it("WALK moves at a pace, faces the way it goes and cycles the legs; POSE blends", () => {
    const film = base([{ id: "me", kind: "FIGURE", position: [0, 0, 0], visible: true }], [
      { do: "WALK", actor: "me", to: [2.5, 0, 0], at: 0 },
      { do: "POSE", actor: "me", pose: "CHEER", at: 3, duration: 0.5 },
    ]);
    const mid = at(film, 1).actors[0]!;
    expect(mid.position[0]).toBeCloseTo(1.25, 1); // 1.25 m/s default pace
    expect((mid.rotation[1] * 180) / Math.PI).toBeCloseTo(90, 0); // facing +x
    expect(mid.gait?.mode).toBe("WALK");
    expect(mid.gait!.phase).toBeGreaterThan(0.5);
    const end = at(film, 3.9).actors[0]!;
    expect(end.position[0]).toBeCloseTo(2.5, 3);
    expect(end.pose.to).toBe("CHEER");
    expect(end.pose.k).toBe(1);
    const sk = skeletonFor(end);
    expect(sk.lShoulder[2]).toBeGreaterThan(120); // arms up
    expect(Object.keys(POSES)).toContain("BALANCE");
  });

  it("CLIMB goes up the stairs step by step (monotonic, lands on the top tread)", () => {
    const film = base(
      [
        { id: "stairs", kind: "STAIRS", visible: true, params: { steps: 6, rise: 0.25, run: 0.4 } },
        { id: "me", kind: "FIGURE", position: [-2, 0, 0], visible: true },
      ],
      [{ do: "CLIMB", actor: "me", on: "stairs", at: 0.2, duration: 3 }],
    );
    let prev = -1;
    for (let t = 0.3; t <= 3.2; t += 0.1) {
      const y = at(film, t).actors.find((a) => a.id === "me")!.position[1];
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = y;
    }
    expect(prev).toBeCloseTo(6 * 0.25, 1);
    expect(climbLocalPoint("STAIRS", { steps: 6, rise: 0.25, run: 0.4 }, 0)[1]).toBe(0);
  });

  it("semantic verbs drive each kind's own parameter; SPIN is integrated (no jumps)", () => {
    const film = base(
      [
        { id: "door", kind: "DOOR", visible: true },
        { id: "chain", kind: "CHAIN", visible: true },
        { id: "g", kind: "GAUGE", visible: true },
        { id: "w", kind: "WHEEL", visible: true, params: { speed: 0 } },
        { id: "cal", kind: "CALENDAR", visible: true },
      ],
      [
        { do: "OPEN", actor: "door", at: 0 },
        { do: "BREAK", actor: "chain", at: 0 },
        { do: "FILL", actor: "g", to: 0.7, at: 0 },
        { do: "SPIN", actor: "w", to: 1, at: 1, duration: 1 },
        { do: "FLIP", actor: "cal", to: 3, at: 0, duration: 2 },
      ],
    );
    const s = at(film, 3.5);
    const p = (id: string) => s.actors.find((a) => a.id === id)!;
    expect(p("door").params.open).toBeCloseTo(1, 3);
    expect(p("chain").params.broken).toBeCloseTo(1, 3);
    expect(p("g").params.value).toBeCloseTo(0.7, 3);
    expect(p("cal").params.page).toBeCloseTo(3, 3);
    // 0 turns until 1 s, ramps over 1 s (≈0.5 turn), then 1 turn/s for 1.5 s
    expect(p("w").phase).toBeGreaterThan(1.7);
    expect(p("w").phase).toBeLessThan(2.3);
    const a = at(film, 2.0).actors.find((x) => x.id === "w")!.phase;
    const b = at(film, 2.0 + 1 / 30).actors.find((x) => x.id === "w")!.phase;
    expect(b - a).toBeLessThan(0.05);
  });

  it("explains vocabulary mistakes for the repair loop", () => {
    const film = base(
      [
        { id: "door", kind: "DOOR", visible: true },
        { id: "me", kind: "FIGURE", visible: true, parent: "ghost", params: { pose: "DAB" } },
        { id: "a", kind: "FIGURE", parent: "b" },
        { id: "b", kind: "FIGURE", parent: "a" },
      ],
      [
        { do: "BREAK", actor: "door", at: 0 },
        { do: "CLIMB", actor: "me", on: "door", at: 0 },
        { do: "RAISE", actor: "door", at: 0 },
      ],
    );
    const v = validateFilm(film);
    expect(v.ok).toBe(false);
    const msgs = v.ok ? [] : v.errors.map((e) => `${e.path}: ${e.message} ${e.hint ?? ""}`).join("\n");
    expect(msgs).toMatch(/BREAK doesn't apply to a DOOR.*CHAIN/s);
    expect(msgs).toMatch(/CLIMB needs a STAIRS or LADDER/);
    expect(msgs).toMatch(/No actor "ghost"/);
    expect(msgs).toMatch(/loops back on itself/);
    expect(msgs).toMatch(/Unknown pose "DAB"/);
    expect(msgs).toMatch(/RAISE doesn't apply to a DOOR/);
  });

  it("the proof film's twist literally raises the floor under you, your home, your car", () => {
    const rf = resolveFilm(PROOF_FILM);
    const cf = compileFilm(rf);
    const shot = rf.shots.find((s) => s.shot.id === "baseline")!;
    const start = evaluateFrame(cf, shot.startFrame + 1);
    const end = evaluateFrame(cf, shot.endFrame - 1);
    for (const id of ["you", "car", "building", "pedestal"]) {
      const y0 = start.actors.find((a) => a.id === id)!.position[1];
      const y1 = end.actors.find((a) => a.id === id)!.position[1];
      expect(y1 - y0, id).toBeGreaterThan(1.5);
    }
    expect(end.actors.find((a) => a.id === "you")!.visible).toBe(true);
    expect(end.actors.find((a) => a.id === "floor")!.params.label).toBe("YOUR BASELINE");
  });
});
