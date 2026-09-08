/**
 * Deterministic temporal/positional collision detection between planned text overlays — spec
 * §9 step 14's "headline collision" / "caption collision" checks, for the slice of that check
 * that's actually pure arithmetic on the EditPlan itself (two overlays scheduled in the same
 * screen region at overlapping times) rather than something that requires seeing the actual
 * frame (e.g. a caption sitting over a face, which still needs Visual QA's vision call). Per
 * CLAUDE.md's standing rule — prefer deterministic code over LLM judgment when the check is
 * actually deterministic — this never touches a model.
 */
export interface OverlayForCollisionCheck {
  text: string;
  startSeconds: number;
  endSeconds: number;
  position: "TOP" | "CENTER" | "BOTTOM";
}

export interface OverlayCollision {
  a: string;
  b: string;
  position: "TOP" | "CENTER" | "BOTTOM";
  overlapStartSeconds: number;
  overlapEndSeconds: number;
}

function overlaps(a: OverlayForCollisionCheck, b: OverlayForCollisionCheck): boolean {
  return a.startSeconds < b.endSeconds && b.startSeconds < a.endSeconds;
}

/** O(n^2) over an EditPlan's overlay list — that list is small (a handful of headlines/
 * captions per short-form video), so the naive pairwise comparison is the right level of
 * complexity here, not a sweep-line optimization nothing will ever need. */
export function checkOverlayCollisions(
  overlays: OverlayForCollisionCheck[],
): OverlayCollision[] {
  const collisions: OverlayCollision[] = [];
  for (let i = 0; i < overlays.length; i++) {
    for (let j = i + 1; j < overlays.length; j++) {
      const a = overlays[i]!;
      const b = overlays[j]!;
      if (a.position !== b.position) continue; // different screen regions never collide
      if (!overlaps(a, b)) continue;
      collisions.push({
        a: a.text,
        b: b.text,
        position: a.position,
        overlapStartSeconds: Math.max(a.startSeconds, b.startSeconds),
        overlapEndSeconds: Math.min(a.endSeconds, b.endSeconds),
      });
    }
  }
  return collisions;
}
