import {
  buildCaptionChunks,
  layoutCaptionChunks,
  remapWordsToOutputTimeline,
  CAPTION_STYLE_PRESETS,
  type CaptionsConfig,
  type TranscriptWord,
} from "./captions";
import { layoutOverlays, type OverlayStyle } from "./overlay-layout";

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

// ---------------------------------------------------------------------------------------
// Caption band vs. overlays
// ---------------------------------------------------------------------------------------

export interface CaptionCollision {
  overlayText: string;
  captionText: string;
  overlapStartSeconds: number;
  overlapEndSeconds: number;
}

/**
 * Pixel-accurate caption-vs-overlay collision check, using exactly the layout the renderer
 * uses (same font metrics, same safe zones, same automatic caption relocation). The renderer
 * moves a caption phrase out of an overlay's way when a free safe position exists, so this
 * only reports the residual cases where it could not — those are real collisions that need
 * an EditPlan change (stagger the overlay, change its position, or switch caption position).
 */
export function checkCaptionOverlayCollisions(input: {
  overlays: Array<OverlayForCollisionCheck & { style?: OverlayStyle }>;
  captions: CaptionsConfig;
  /** Source-timeline word timings (MediaAsset.transcriptWords). */
  sourceWords: TranscriptWord[];
  segments: Array<{ startSeconds: number; endSeconds: number }>;
  canvas: { width: number; height: number };
}): CaptionCollision[] {
  if (!input.captions.enabled || input.sourceWords.length === 0) return [];
  const overlays = layoutOverlays(input.overlays, input.canvas);
  const words = remapWordsToOutputTimeline(input.sourceWords, input.segments);
  const chunks = buildCaptionChunks(words, {
    maxChars: CAPTION_STYLE_PRESETS[input.captions.style].maxChars,
  });
  const layout = layoutCaptionChunks(chunks, input.captions, input.canvas, overlays);
  const collisions: CaptionCollision[] = [];
  for (const l of layout.layouts) {
    for (const idx of l.residualCollisionWith) {
      const o = overlays[idx]!;
      collisions.push({
        overlayText: o.text,
        captionText: l.chunk.text,
        overlapStartSeconds: Math.max(o.startSeconds, l.chunk.start),
        overlapEndSeconds: Math.min(o.endSeconds, l.chunk.end),
      });
    }
  }
  return collisions;
}
