/**
 * Motion v2 TIMING HOOKS (emphasis hits) — the only template-level change of the interaction
 * work, kept here so styling edits in the template files never collide with it. Each helper
 * takes the template's natural timing and `hitAtFrame` (local frame of the speaker's emphasis,
 * from @chris/media's pickEmphasisHit) and returns adjusted timing. Pure; null hit = natural.
 * Rules: a hit never makes a build faster than ~0.45 s or slower than 3 s, and the landed
 * state always holds ≥ 0.4 s before the exit starts.
 */

function latestHit(fps: number, durationInFrames: number, exitFrames: number): number {
  return Math.max(0, durationInFrames - exitFrames - Math.round(fps * 0.4));
}

/** Stretched/compressed build length so a build starting at `start` lands on the hit. */
export function hitBuildLength(
  naturalLen: number,
  start: number,
  hitAtFrame: number | null | undefined,
  fps: number,
  durationInFrames: number,
  exitFrames: number,
): number {
  if (hitAtFrame == null) return naturalLen;
  const hit = Math.min(hitAtFrame, latestHit(fps, durationInFrames, exitFrames));
  const len = hit - start;
  return Math.round(Math.min(fps * 3, Math.max(fps * 0.45, len)));
}

/** Frames to DELAY a build whose key moment naturally lands at `naturalHit` (never negative). */
export function hitDelay(naturalHit: number, hitAtFrame: number | null | undefined, fps: number, durationInFrames: number, exitFrames: number): number {
  if (hitAtFrame == null) return 0;
  const hit = Math.min(hitAtFrame, latestHit(fps, durationInFrames, exitFrames));
  return Math.max(0, Math.min(Math.round(fps * 3), Math.round(hit - naturalHit)));
}

/**
 * KINETIC_TEXT punch timing: word i's start frame. Words up to the key word (first emphasised
 * word, else the last) spread out so the key word LANDS (≈ 4 frames after it starts) on the
 * hit; stagger can stretch up to 2.5×, any remaining wait delays the key word and the rest.
 */
export function kineticWordDelays(
  wordCount: number,
  keyIndex: number,
  stagger: number,
  hitAtFrame: number | null | undefined,
  fps: number,
  durationInFrames: number,
  exitFrames: number,
): number[] {
  const natural = Array.from({ length: wordCount }, (_, i) => 2 + i * stagger);
  if (hitAtFrame == null || wordCount === 0) return natural;
  const k = Math.max(0, Math.min(wordCount - 1, keyIndex));
  const target = Math.min(hitAtFrame, latestHit(fps, durationInFrames, exitFrames)) - 4;
  const naturalK = 2 + k * stagger;
  if (target <= naturalK) return natural;
  const s2 = k > 0 ? Math.min(stagger * 2.5, (target - 2) / k) : stagger;
  const extra = Math.max(0, target - (2 + k * s2));
  return natural.map((_, i) => Math.round((2 + i * (i <= k ? s2 : 0) + (i > k ? k * s2 + (i - k) * stagger : 0) + (i >= k ? extra : 0)) * 100) / 100);
}
