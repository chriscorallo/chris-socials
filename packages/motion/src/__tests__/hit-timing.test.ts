import { describe, expect, it } from "vitest";
import { hitBuildLength, hitDelay, kineticWordDelays } from "../remotion/templates/hit-timing";
import { integrationFilterSpec, trackAt } from "../remotion/integration";
import { sceneLook } from "@chris/media/timeline";

describe("emphasis timing hooks", () => {
  it("no hit → natural timing", () => {
    expect(hitBuildLength(45, 3, null, 30, 150, 14)).toBe(45);
    expect(hitDelay(50, undefined, 30, 150, 14)).toBe(0);
    expect(kineticWordDelays(3, 2, 4, null, 30, 150, 14)).toEqual([2, 6, 10]);
  });

  it("counter/stack: the build stretches (or compresses) to land on the hit, within 0.45–3 s and before the exit hold", () => {
    expect(hitBuildLength(45, 3, 63, 30, 150, 14)).toBe(60);
    expect(hitBuildLength(45, 3, 6, 30, 150, 14)).toBe(14); // never faster than 0.45 s
    expect(hitBuildLength(45, 3, 200, 30, 150, 14)).toBe(90); // never slower than 3 s
    expect(hitBuildLength(45, 3, 80, 30, 400, 14)).toBe(77);
    expect(hitBuildLength(45, 3, 140, 30, 100, 14)).toBe(100 - 14 - 12 - 3); // lands ≥0.4 s before the exit
  });

  it("bars: delay only, never negative", () => {
    expect(hitDelay(48, 70, 30, 150, 14)).toBe(22);
    expect(hitDelay(48, 30, 30, 150, 14)).toBe(0);
  });

  it("kinetic: the key word lands on the hit, earlier words spread, later ones follow", () => {
    const d = kineticWordDelays(4, 2, 3, 40, 30, 150, 14);
    expect(d[2]! + 4).toBeCloseTo(40, 0);
    expect(d[0]).toBe(2);
    expect(d[1]! - d[0]!).toBeLessThanOrEqual(3 * 2.5 + 1e-9);
    expect(d[3]! - d[2]!).toBeCloseTo(3, 6);
    // a hit before the natural landing leaves the natural timing alone
    expect(kineticWordDelays(4, 2, 3, 5, 30, 150, 14)).toEqual([2, 5, 8, 11]);
  });
});

describe("composition interaction helpers", () => {
  it("trackAt clamps to the track", () => {
    const ix = { track: { x: [1, 2, 3], y: [4, 5, 6], s: [1, 1.1, 1.2] }, hitAtFrame: null, scene: null, look: sceneLook(null) };
    expect(trackAt(ix, 1)).toEqual({ x: 2, y: 5, s: 1.1 });
    expect(trackAt(ix, 99)).toEqual({ x: 3, y: 6, s: 1.2 });
    expect(trackAt({ ...ix, track: null }, 1)).toBeNull();
  });

  it("filter spec: identity matrix when scene match is off; warm scene warms", () => {
    const look = sceneLook({ r: 220, g: 180, b: 120, luma: 0.7, lumaStd: 0.1 });
    expect(integrationFilterSpec({ shadow: false, lightWrap: false, sceneMatch: false }, look)).toBeNull();
    const off = integrationFilterSpec({ shadow: true, lightWrap: false, sceneMatch: false }, look)!;
    expect(off.matrix.startsWith("1 0 0 0 0")).toBe(true);
    expect(off.wrap).toBeNull();
    const on = integrationFilterSpec({ shadow: true, lightWrap: true, sceneMatch: true }, look)!;
    expect(Number(on.matrix.split(" ")[0])).toBeGreaterThan(Number(on.matrix.split("  ")[2]!.split(" ")[2]));
    expect(on.wrap!.strength).toBeGreaterThan(0.25);
    expect(on.shadow!.color).toMatch(/^#[0-9A-F]{6}$/);
  });
});
