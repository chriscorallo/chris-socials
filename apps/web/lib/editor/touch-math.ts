/**
 * Pure math behind the editor's touch interactions (mobile layout): the fixed-centre-playhead
 * timeline's scroll <-> time mapping, pinch gestures, bottom-sheet snapping, long-press clip
 * reordering, and snap-to-target. No DOM here — everything is unit-tested in touch-math.test.ts.
 */

export interface Pt {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------------------
// Centre-playhead timeline
// ---------------------------------------------------------------------------------------

/**
 * The mobile timeline pads its content by half the viewport on both sides, so time 0 sits
 * under the fixed centre playhead at scrollLeft 0, and time t at scrollLeft t * pps.
 */
export function scrollForTime(t: number, pxPerSec: number): number {
  return Math.max(0, t * pxPerSec);
}

export function timeForScroll(scrollLeft: number, pxPerSec: number, duration: number): number {
  if (pxPerSec <= 0) return 0;
  return Math.min(duration, Math.max(0, scrollLeft / pxPerSec));
}

/** Output time under a viewport x position (clientX relative to the timeline's left edge). */
export function timeAtViewportX(x: number, viewWidth: number, scrollLeft: number, pxPerSec: number): number {
  return (scrollLeft + x - viewWidth / 2) / pxPerSec;
}

export function clampPps(pps: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, pps));
}

/** Timeline zoom from a pinch: scale pixels-per-second by the change in finger distance. */
export function pinchPps(pps0: number, dist0: number, dist1: number, min: number, max: number): number {
  if (dist0 <= 0) return clampPps(pps0, min, max);
  return clampPps(pps0 * (dist1 / dist0), min, max);
}

/** Pixels-per-second that fits `duration` into `viewWidth` (minus a margin). */
export function fitPps(duration: number, viewWidth: number, min: number, max: number, margin = 48): number {
  if (duration <= 0) return clampPps(60, min, max);
  return clampPps((viewWidth - margin) / duration, min, max);
}

// ---------------------------------------------------------------------------------------
// Pinch / pan on the preview
// ---------------------------------------------------------------------------------------

export function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Two-finger gesture relative to its starting pose: scale (finger distance ratio) and the
 * translation of the midpoint. Rotation is deliberately not tracked.
 */
export function pinchGeometry(a0: Pt, b0: Pt, a1: Pt, b1: Pt): { scale: number; dx: number; dy: number } {
  const d0 = distance(a0, b0);
  const d1 = distance(a1, b1);
  const m0 = midpoint(a0, b0);
  const m1 = midpoint(a1, b1);
  return { scale: d0 > 0 ? d1 / d0 : 1, dx: m1.x - m0.x, dy: m1.y - m0.y };
}

// ---------------------------------------------------------------------------------------
// Bottom sheet
// ---------------------------------------------------------------------------------------

export type SheetSnap = "half" | "full" | "closed";

/**
 * Where a released bottom sheet settles. `height` is its visible height at release, `velocity`
 * its downward speed in px/ms (positive = moving down). A decisive flick wins; otherwise the
 * nearest snap point does. Sheets that only have one open height pass half === full.
 */
export function resolveSheetSnap(opts: { height: number; velocity: number; half: number; full: number; flick?: number }): SheetSnap {
  const { height, velocity, half, full } = opts;
  const flick = opts.flick ?? 0.5;
  const single = Math.abs(full - half) < 1;
  if (velocity > flick) {
    if (single || height < half + 1) return "closed";
    return "half";
  }
  if (velocity < -flick) return single ? "half" : "full";
  if (height < half * 0.55) return "closed";
  if (single) return "half";
  return Math.abs(height - full) < Math.abs(height - half) ? "full" : "half";
}

export type SheetKind = "clip" | "volume" | "text" | "zoom" | "captions" | "look" | "media" | "cover" | "platforms" | "visuals" | "sound" | "style" | "director";

/**
 * The open sheet after the selection changes: sheets about ONE item (clip / volume / text /
 * zoom) follow the selection to the matching sheet — or close when nothing is selected — while
 * whole-video sheets (captions, look, add clip, cover, platforms) stay put.
 */
export function sheetForSelection(sheet: SheetKind | null, sel: "clip" | "text" | "zoom" | "captions" | "visual" | "sfx" | null): SheetKind | null {
  // The Visuals sheet is the gallery when nothing is selected and the selected graphic's
  // editor otherwise; the Sound sheet is whole-video. Both stay open across selections, but a
  // per-item sheet follows the selection INTO them.
  if (sheet !== "clip" && sheet !== "volume" && sheet !== "text" && sheet !== "zoom") return sheet;
  if (sel === null) return null;
  if (sel === "clip") return sheet === "volume" ? "volume" : "clip";
  if (sel === "visual") return "visuals";
  if (sel === "sfx") return "sound";
  return sel;
}

/** Rubber-band: past the limit the sheet still follows the finger, but only by a fraction. */
export function rubberBand(over: number, k = 0.25): number {
  return over <= 0 ? over : over * k;
}

// ---------------------------------------------------------------------------------------
// Long-press reorder + snapping
// ---------------------------------------------------------------------------------------

/**
 * While dragging clip `dragIndex` (by long-press), the index it would land at — among the
 * OTHER clips — when the finger is at output time `t`, and where the drop marker sits.
 */
export function reorderTarget(durations: number[], dragIndex: number, t: number): { index: number; at: number } {
  const others = durations.filter((_, i) => i !== dragIndex);
  let acc = 0;
  for (let i = 0; i < others.length; i++) {
    const d = others[i]!;
    if (t < acc + d / 2) return { index: i, at: acc };
    acc += d;
  }
  return { index: others.length, at: acc };
}

/**
 * Where a new text/zoom added "at the playhead" should start so it is visible at the
 * playhead: floored to the millisecond (rounding UP would start it just after the playhead and
 * hide it), and pulled back from the very end so it still has room to show.
 */
export function spanStartForPlayhead(t: number, duration: number, length = 2.5): number {
  const floored = Math.floor(Math.max(0, t) * 1000) / 1000;
  if (floored > duration - 0.2) return Math.max(0, Math.floor((duration - Math.min(length, duration)) * 1000) / 1000);
  return floored;
}

/** Nearest target within `threshold` of `value`, or null. */
export function snapTo(value: number, targets: number[], threshold: number): number | null {
  let best: number | null = null;
  let bestD = threshold;
  for (const s of targets) {
    const d = Math.abs(s - value);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** True once a pointer has travelled far enough to count as a drag rather than a tap/hold. */
export function movedBeyond(start: Pt, now: Pt, slop: number): boolean {
  return distance(start, now) > slop;
}

// ---------------------------------------------------------------------------------------
// On-screen keyboard
// ---------------------------------------------------------------------------------------

/**
 * How far the on-screen keyboard covers the layout viewport from the bottom, from the
 * visualViewport metrics (iOS Safari overlays the keyboard rather than resizing the page).
 */
export function keyboardInset(layoutHeight: number, visualHeight: number, visualOffsetTop: number): number {
  return Math.max(0, Math.round(layoutHeight - visualHeight - visualOffsetTop));
}
