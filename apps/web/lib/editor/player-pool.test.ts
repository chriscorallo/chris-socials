import { describe, expect, it } from "vitest";
import {
  assignPlayers,
  isContinuation,
  shouldStartStandby,
  standbyRate,
  standbyReady,
  standbySeekTarget,
  RATE_MAX,
  RATE_MIN,
  STANDBY_AHEAD_S,
  WARM_LEAD_S,
  WARM_START_LATENCY_S,
} from "./player-pool";

const clip = (sourceStart: number, sourceEnd: number, mediaAssetId = "A") => ({ mediaAssetId, sourceStart, sourceEnd });

describe("contiguous-clip detection", () => {
  it("same take + adjacent source times = a continuation (framing-only cut)", () => {
    expect(isContinuation(clip(0, 2), clip(2, 4))).toBe(true);
    expect(isContinuation(clip(0, 2), clip(2.01, 4))).toBe(true); // within a frame-ish
    expect(isContinuation(clip(0, 2), clip(2.1, 4))).toBe(false); // a removed pause
    expect(isContinuation(clip(0, 2), clip(1.5, 4))).toBe(false); // going back
    expect(isContinuation(clip(0, 2), clip(2, 4, "B"))).toBe(false); // another take
    expect(isContinuation(undefined, clip(0, 1))).toBe(false);
  });

  it("a run of continuations shares one element; every jump switches", () => {
    const clips = [clip(0, 1), clip(1, 2), clip(2.5, 3), clip(3, 4), clip(4, 5), clip(6, 7), clip(0, 1, "B")];
    expect(assignPlayers(clips).clipPlayer).toEqual(["p0", "p0", "p1", "p1", "p1", "p0", "p1"]);
    expect(assignPlayers(clips).slots).toEqual(["p0", "p1"]);
    expect(assignPlayers([clip(0, 1)])).toEqual({ clipPlayer: ["p0"], slots: ["p0"] });
    // back-compat: a bare count alternates
    expect(assignPlayers(3).clipPlayer).toEqual(["p0", "p1", "p0"]);
  });
});

describe("warm standby scheduling", () => {
  it("waits WARM_LEAD_S before the next clip's first frame (never before 0)", () => {
    expect(standbySeekTarget(clip(5, 6))).toBeCloseTo(5 - WARM_LEAD_S, 9);
    expect(standbySeekTarget(clip(0.2, 1))).toBe(0);
  });

  it("starts when the time left equals its lead (plus start latency)", () => {
    const next = 5;
    const at = next - WARM_LEAD_S;
    expect(shouldStartStandby(WARM_LEAD_S + WARM_START_LATENCY_S + 0.05, at, next)).toBe(false);
    expect(shouldStartStandby(WARM_LEAD_S + WARM_START_LATENCY_S - 0.001, at, next)).toBe(true);
    // a standby that couldn't go back far enough (clip near the start of the take) starts later
    expect(shouldStartStandby(0.5, 0, 0.2)).toBe(false);
    expect(shouldStartStandby(0.25, 0, 0.2)).toBe(true);
  });

  it("steers the standby onto the first frame (+ a frame) by the time the clip ends", () => {
    // simulate 60 Hz ticks: the standby started 0.1 s late
    const next = 10;
    let remaining = 0.5;
    let standby = next - 0.6; // should be next - 0.5 + ahead → 0.1 s + ahead behind
    const dt = 1 / 60;
    while (remaining > 0) {
      const r = standbyRate(standby, next, remaining);
      expect(r).toBeGreaterThanOrEqual(RATE_MIN);
      expect(r).toBeLessThanOrEqual(RATE_MAX);
      standby += r * dt;
      remaining -= dt;
    }
    expect(Math.abs(standby - (next + STANDBY_AHEAD_S))).toBeLessThan(1 / 30);
    expect(standbyReady(standby, next)).toBe(true);
  });

  it("plays at normal speed when already on time, and clamps big errors", () => {
    expect(standbyRate(10 + STANDBY_AHEAD_S - 0.3, 10, 0.3)).toBe(1);
    expect(standbyRate(8, 10, 0.3)).toBe(RATE_MAX);
    expect(standbyRate(12, 10, 0.3)).toBe(RATE_MIN);
  });

  it("only takes over without a seek within a frame or so of the first frame", () => {
    expect(standbyReady(10, 10)).toBe(true);
    expect(standbyReady(10 + 2 / 30, 10)).toBe(true);
    expect(standbyReady(10 - 1 / 30, 10)).toBe(false); // would show removed footage
    expect(standbyReady(10 + 3 / 30, 10)).toBe(false); // would skip frames
  });
});
