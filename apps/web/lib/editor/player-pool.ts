/**
 * The preview plays every clip on a fixed pool of two <video> elements (see the edit route's
 * playback.ts), so the number of decoders never grows with the number of takes or clips (iOS
 * Safari limits concurrent hardware decoders). Pure scheduling math lives here (unit-tested).
 *
 * Two kinds of cut (docs/decisions-pending/editor-smoothness-fullscreen-platform-ui.md):
 *  - a CONTINUATION — the next clip picks up the same take exactly where this one ends (a
 *    framing-only cut: the style cut's punch-in on a split, or a plain split). The same element
 *    keeps playing; only the crop changes at the boundary. No seek, no element switch, no audio
 *    restart.
 *  - a JUMP — anything else (a removed pause, another take, going backwards). The next clip
 *    plays on the OTHER element, which is pre-seeked a little BEFORE the clip's first frame and
 *    started (muted, hidden) shortly before the boundary, its rate nudged so it arrives at the
 *    first frame exactly when the current clip ends ("warm standby"). The cut is then a
 *    visibility + audio swap between two elements that are both already playing.
 */
export const PLAYER_POOL = ["p0", "p1"] as const;

/** Two clips closer than this in source time count as one continuous piece of footage. */
export const CONTINUATION_EPS_S = 1 / 60;
/** How far before the next clip's first frame the standby element waits (and starts playing). */
export const WARM_LEAD_S = 0.6;
/** play() → first frame takes a few vsyncs; start the standby this much early to absorb it. */
export const WARM_START_LATENCY_S = 0.08;
/** Below this error the standby plays at normal speed. */
export const RATE_DEADBAND_S = 0.01;
export const RATE_MIN = 0.8;
/** The standby aims this far past the first frame (see standbyRate). */
export const STANDBY_AHEAD_S = 1 / 30;
export const RATE_MAX = 1.25;

export interface PoolClip {
  mediaAssetId: string;
  sourceStart: number;
  sourceEnd: number;
}

/** True when `next` continues `prev`'s footage seamlessly (same take, adjacent source times). */
export function isContinuation(prev: PoolClip | undefined, next: PoolClip | undefined): boolean {
  if (!prev || !next) return false;
  return prev.mediaAssetId === next.mediaAssetId && Math.abs(next.sourceStart - prev.sourceEnd) <= CONTINUATION_EPS_S;
}

/**
 * Which pool element plays each clip: a run of continuations shares one element; each jump
 * switches to the other element. Two slots whenever there is more than one clip (stable DOM).
 * Back-compat: a bare count assigns alternating elements (every cut a jump).
 */
export function assignPlayers(clips: number | readonly PoolClip[]): { clipPlayer: string[]; slots: string[] } {
  const n = typeof clips === "number" ? clips : clips.length;
  const clipPlayer: string[] = [];
  let slot = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && (typeof clips === "number" || !isContinuation(clips[i - 1], clips[i]))) slot = 1 - slot;
    clipPlayer.push(PLAYER_POOL[slot]!);
  }
  return { clipPlayer, slots: PLAYER_POOL.slice(0, n > 1 ? 2 : 1) };
}

/** Where the standby element should wait (paused) for the clip it plays next. */
export function standbySeekTarget(nextClip: PoolClip): number {
  return Math.max(0, nextClip.sourceStart - WARM_LEAD_S);
}

/**
 * Whether to start the waiting standby now: it starts when the time left in the current clip
 * equals how far it sits before its first frame (minus the expected start latency).
 */
export function shouldStartStandby(remainingS: number, standbyTime: number, nextSourceStart: number): boolean {
  const lead = nextSourceStart - standbyTime;
  return remainingS <= Math.max(0, lead) + WARM_START_LATENCY_S;
}

/**
 * Playback rate for a running standby so that it reaches `nextSourceStart` exactly when the
 * current clip ends `remainingS` from now. `error` > 0 = the standby is ahead.
 */
export function standbyRate(standbyTime: number, nextSourceStart: number, remainingS: number, aheadS = STANDBY_AHEAD_S): number {
  // Aim a frame AHEAD of the first frame: an element's currentTime runs ahead of the frame it
  // has on screen, so aiming exactly at the first frame often shows the frame BEFORE it
  // (removed footage) at the swap. Measured: 0.5 frame → 5/14 cuts showed it, 1 frame → 1–2/14.
  const desired = nextSourceStart + aheadS - Math.max(0, remainingS);
  const error = standbyTime - desired;
  if (Math.abs(error) < RATE_DEADBAND_S) return 1;
  const r = 1 - error / Math.max(0.15, remainingS);
  return Math.round(Math.min(RATE_MAX, Math.max(RATE_MIN, r)) * 1000) / 1000;
}

/**
 * At the boundary: can the standby take over without a seek? It must be playing the right take
 * no more than half a frame before the next clip's first frame and at most 2.5 frames past it
 * (its currentTime runs ahead of the picture by up to a frame, plus the half-frame aim).
 */
export function standbyReady(standbyTime: number, nextSourceStart: number, fps = 30): boolean {
  return standbyTime >= nextSourceStart - 0.5 / fps && standbyTime <= nextSourceStart + 2.5 / fps;
}
