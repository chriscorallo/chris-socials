import { describe, it, expect } from "vitest";
import { checkOverlayCollisions, type OverlayForCollisionCheck } from "../overlay-collision";

function overlay(
  text: string,
  startSeconds: number,
  endSeconds: number,
  position: OverlayForCollisionCheck["position"] = "BOTTOM",
): OverlayForCollisionCheck {
  return { text, startSeconds, endSeconds, position };
}

describe("checkOverlayCollisions (pure, deterministic)", () => {
  it("no collisions when there is only one overlay", () => {
    expect(checkOverlayCollisions([overlay("Hook", 0, 2)])).toEqual([]);
  });

  it("no collision when time windows don't overlap, same position", () => {
    const overlays = [overlay("Hook", 0, 2), overlay("Beat 1", 2, 4)];
    expect(checkOverlayCollisions(overlays)).toEqual([]);
  });

  it("no collision when time windows overlap but positions differ", () => {
    const overlays = [overlay("Headline", 0, 3, "TOP"), overlay("Caption", 1, 4, "BOTTOM")];
    expect(checkOverlayCollisions(overlays)).toEqual([]);
  });

  it("flags a collision when two overlays share both time and position", () => {
    const overlays = [overlay("Headline", 0, 3, "BOTTOM"), overlay("Caption", 1, 4, "BOTTOM")];
    const collisions = checkOverlayCollisions(overlays);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      a: "Headline",
      b: "Caption",
      position: "BOTTOM",
      overlapStartSeconds: 1,
      overlapEndSeconds: 3,
    });
  });

  it("finds every colliding pair among more than two overlays, not just the first", () => {
    const overlays = [
      overlay("A", 0, 5, "BOTTOM"),
      overlay("B", 1, 2, "BOTTOM"), // collides with A
      overlay("C", 4, 6, "BOTTOM"), // collides with A
      overlay("D", 0, 5, "TOP"), // different position, no collision with anything
    ];
    const collisions = checkOverlayCollisions(overlays);
    expect(collisions).toHaveLength(2);
    expect(collisions.map((c) => [c.a, c.b])).toEqual([
      ["A", "B"],
      ["A", "C"],
    ]);
  });

  it("touching (not overlapping) windows do not collide — end===start is adjacency, not overlap", () => {
    const overlays = [overlay("A", 0, 2, "BOTTOM"), overlay("B", 2, 4, "BOTTOM")];
    expect(checkOverlayCollisions(overlays)).toEqual([]);
  });
});
