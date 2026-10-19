import type { Rect } from "../safe-zones";
import { PLATFORM_UI, UI_PLATFORM_IDS, referenceVisibleX } from "../platform-ui";

/**
 * Where a Director-placed graphic may go: the part of the frame every app shows (the side crop
 * of tall phones and the top bar excluded) with each app's real UI — the right action rail and
 * the bottom caption block, best-estimate regions of Instagram, TikTok and YouTube — as hard
 * obstacles. The automatic solver keeps using the frozen margin rectangle
 * (PLACEMENT_SAFE_ZONE), which rules out the whole bottom third of the frame; when Chris names a
 * side, the accurate region model gives him the space that is actually visible (e.g. the lower
 * left beside his chest). PURE. See docs/decisions-pending/director-chat.md.
 */
export function directorPlacementArea(canvas: { width: number; height: number }): { bounds: Rect; ui: Rect[] } {
  const kx = canvas.width / 1080;
  const ky = canvas.height / 1920;
  const vis = referenceVisibleX();
  const top = Math.max(...UI_PLATFORM_IDS.map((p) => PLATFORM_UI[p].regions.topBar.y1));
  const bottom = Math.min(...UI_PLATFORM_IDS.map((p) => PLATFORM_UI[p].regions.progressBar.y0));
  const ui: Rect[] = [];
  for (const p of UI_PLATFORM_IDS) {
    for (const id of ["rightRail", "bottomText"] as const) {
      const r = PLATFORM_UI[p].regions[id];
      ui.push({ x: r.x0 * kx, y: r.y0 * ky, width: (r.x1 - r.x0) * kx, height: (r.y1 - r.y0) * ky });
    }
  }
  return { bounds: { x: vis.x0 * kx, y: top * ky, width: (vis.x1 - vis.x0) * kx, height: (bottom - top) * ky }, ui };
}
