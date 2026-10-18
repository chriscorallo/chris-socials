/**
 * The compositor's master clock — PURE (sources injected; tested in engine.test.ts).
 *
 * While playing, output time is driven by the AudioContext's clock (the sound card's sample
 * counter — it never drifts from what's heard), delayed by the output latency so the picture
 * matches the sound that is actually coming out of the speaker. Without audio (context not
 * allowed / suspended / no audio track) a wall clock (performance.now) drives it instead.
 * Video frames are slaved to this time; nothing ever restarts audio at a cut.
 */

export interface ClockSource {
  /** seconds, monotonic */
  now(): number;
  /** seconds between `now()` and the moment that sample is heard (0 for the wall clock) */
  latency(): number;
  readonly kind: "audio" | "wall";
}

export class MasterClock {
  private running = false;
  private anchorOut = 0;
  private anchorSrc = 0;
  private src: ClockSource | null = null;

  get isRunning() {
    return this.running;
  }

  get kind(): ClockSource["kind"] | null {
    return this.src?.kind ?? null;
  }

  /**
   * Starts at output time `out` when `src` reaches `at` (≥ now — a small lead lets audio be
   * scheduled in the future, sample-accurately). Until then, time() holds at `out`.
   */
  start(out: number, src: ClockSource, at = src.now()) {
    this.src = src;
    this.anchorOut = out;
    this.anchorSrc = at;
    this.running = true;
  }

  /** Output time now. */
  time(): number {
    if (!this.running || !this.src) return this.anchorOut;
    const el = this.src.now() - this.src.latency() - this.anchorSrc;
    return this.anchorOut + Math.max(0, el);
  }

  /** Where on the source clock output time `out` is (for scheduling audio). */
  sourceTimeFor(out: number): number {
    return this.anchorSrc + (out - this.anchorOut);
  }

  /** Freezes at the current time and returns it. */
  stop(): number {
    const t = this.time();
    this.running = false;
    this.anchorOut = t;
    return t;
  }

  /** Jump (while stopped or running) to output time `out`. */
  set(out: number) {
    if (this.running && this.src) {
      this.anchorOut = out;
      this.anchorSrc = this.src.now() - this.src.latency();
    } else this.anchorOut = out;
  }

  /** Swap the driving source mid-play without a jump in output time. */
  rebase(src: ClockSource) {
    const t = this.time();
    this.src = src;
    if (this.running) {
      this.anchorOut = t;
      this.anchorSrc = src.now() - src.latency();
    }
  }
}

export function wallClock(): ClockSource {
  return { kind: "wall", now: () => performance.now() / 1000, latency: () => 0 };
}

export function audioClock(ctx: { currentTime: number; outputLatency?: number; baseLatency?: number }): ClockSource {
  return {
    kind: "audio",
    now: () => ctx.currentTime,
    // outputLatency (Chrome/Firefox) is the full path to the speaker; Safari only reports
    // baseLatency. Capped so a bogus value can't push the picture seconds behind.
    latency: () => Math.min(0.25, Math.max(0, (ctx.outputLatency ?? 0) || (ctx.baseLatency ?? 0))),
  };
}
