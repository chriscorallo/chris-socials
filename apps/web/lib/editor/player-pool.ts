/**
 * The preview plays every clip on a fixed pool of two <video> elements (see the edit route's
 * playback.ts): clip i on element i % 2, so the element for the next clip can sit paused on
 * its first frame while the current one plays, and the number of decoders never grows with
 * the number of takes or clips (iOS Safari limits concurrent hardware decoders).
 */
export const PLAYER_POOL = ["p0", "p1"] as const;

export function assignPlayers(clipCount: number): { clipPlayer: string[]; slots: string[] } {
  const clipPlayer = Array.from({ length: clipCount }, (_, i) => PLAYER_POOL[i % 2]!);
  return { clipPlayer, slots: PLAYER_POOL.slice(0, clipCount > 1 ? 2 : 1) };
}
