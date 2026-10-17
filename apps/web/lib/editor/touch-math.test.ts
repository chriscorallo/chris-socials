import { describe, it, expect } from "vitest";
import {
  scrollForTime,
  timeForScroll,
  timeAtViewportX,
  pinchPps,
  fitPps,
  pinchGeometry,
  resolveSheetSnap,
  rubberBand,
  reorderTarget,
  snapTo,
  movedBeyond,
  keyboardInset,
} from "./touch-math";

describe("centre-playhead timeline mapping", () => {
  it("round-trips time and scroll position", () => {
    for (const pps of [8, 60, 333]) {
      for (const t of [0, 0.5, 3.25, 9.99]) {
        expect(timeForScroll(scrollForTime(t, pps), pps, 10)).toBeCloseTo(t, 9);
      }
    }
  });

  it("clamps to the video's length", () => {
    expect(timeForScroll(-40, 60, 10)).toBe(0);
    expect(timeForScroll(60 * 25, 60, 10)).toBe(10);
    expect(scrollForTime(-1, 60)).toBe(0);
  });

  it("puts the playhead time under the viewport centre", () => {
    // 400px wide, scrolled to 3s at 50 px/s: the centre is 3s, 100px right of centre is 5s.
    expect(timeAtViewportX(200, 400, 150, 50)).toBeCloseTo(3);
    expect(timeAtViewportX(300, 400, 150, 50)).toBeCloseTo(5);
    expect(timeAtViewportX(0, 400, 0, 50)).toBeCloseTo(-4);
  });

  it("zooms with a pinch, clamped", () => {
    expect(pinchPps(60, 100, 200, 8, 480)).toBe(120);
    expect(pinchPps(60, 100, 50, 8, 480)).toBe(30);
    expect(pinchPps(60, 100, 10_000, 8, 480)).toBe(480);
    expect(pinchPps(60, 100, 1, 8, 480)).toBe(8);
    expect(pinchPps(60, 0, 50, 8, 480)).toBe(60);
  });

  it("fits a whole video into the viewport", () => {
    expect(fitPps(10, 393, 8, 480, 48)).toBeCloseTo(34.5);
    expect(fitPps(0, 393, 8, 480)).toBe(60);
    expect(fitPps(1000, 393, 8, 480)).toBe(8);
  });
});

describe("pinch geometry", () => {
  it("measures scale and midpoint travel", () => {
    const g = pinchGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: -50, y: 10 }, { x: 150, y: 10 });
    expect(g.scale).toBeCloseTo(2);
    expect(g.dx).toBeCloseTo(0);
    expect(g.dy).toBeCloseTo(10);
  });

  it("is a no-op scale for coincident starting fingers", () => {
    expect(pinchGeometry({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }).scale).toBe(1);
  });
});

describe("bottom sheet snapping", () => {
  const S = { half: 360, full: 760 };
  it("settles at the nearest snap point when released slowly", () => {
    expect(resolveSheetSnap({ ...S, height: 700, velocity: 0 })).toBe("full");
    expect(resolveSheetSnap({ ...S, height: 420, velocity: 0 })).toBe("half");
    expect(resolveSheetSnap({ ...S, height: 150, velocity: 0 })).toBe("closed");
  });
  it("follows a decisive flick", () => {
    expect(resolveSheetSnap({ ...S, height: 700, velocity: 1.2 })).toBe("half");
    expect(resolveSheetSnap({ ...S, height: 360, velocity: 1.2 })).toBe("closed");
    expect(resolveSheetSnap({ ...S, height: 380, velocity: -1.2 })).toBe("full");
  });
  it("handles single-height sheets", () => {
    expect(resolveSheetSnap({ half: 500, full: 500, height: 480, velocity: -2 })).toBe("half");
    expect(resolveSheetSnap({ half: 500, full: 500, height: 480, velocity: 2 })).toBe("closed");
    expect(resolveSheetSnap({ half: 500, full: 500, height: 200, velocity: 0 })).toBe("closed");
  });
  it("rubber-bands past the top", () => {
    expect(rubberBand(-20)).toBe(-20);
    expect(rubberBand(40)).toBe(10);
  });
});

describe("long-press reorder", () => {
  const durs = [4, 3, 2];
  it("drops a clip before the clip whose middle the finger has not passed", () => {
    // dragging clip 0; others are [3, 2] at 0..3 and 3..5
    expect(reorderTarget(durs, 0, 0.5)).toEqual({ index: 0, at: 0 });
    expect(reorderTarget(durs, 0, 2)).toEqual({ index: 1, at: 3 });
    expect(reorderTarget(durs, 0, 4.5)).toEqual({ index: 2, at: 5 });
  });
  it("can move the last clip to the front", () => {
    expect(reorderTarget(durs, 2, 0.1)).toEqual({ index: 0, at: 0 });
  });
});

describe("snapping and slop", () => {
  it("snaps to the nearest target within the threshold", () => {
    expect(snapTo(2.03, [0, 2, 4], 0.1)).toBe(2);
    expect(snapTo(2.3, [0, 2, 4], 0.1)).toBeNull();
    expect(snapTo(3.96, [2, 4, 3.9], 0.1)).toBe(4);
  });
  it("distinguishes a tap from a drag", () => {
    expect(movedBeyond({ x: 0, y: 0 }, { x: 3, y: 4 }, 8)).toBe(false);
    expect(movedBeyond({ x: 0, y: 0 }, { x: 6, y: 8 }, 8)).toBe(true);
  });
});

describe("keyboard inset", () => {
  it("is how much of the layout viewport the keyboard covers", () => {
    expect(keyboardInset(852, 852, 0)).toBe(0);
    expect(keyboardInset(852, 516, 0)).toBe(336);
    // page scrolled by iOS while focusing: the offset is not keyboard
    expect(keyboardInset(852, 516, 40)).toBe(296);
    expect(keyboardInset(852, 900, 0)).toBe(0);
  });
});
