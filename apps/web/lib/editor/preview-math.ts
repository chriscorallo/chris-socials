import {
  cropGeometry,
  temperatureGains,
  vignetteFactor,
  type ResolvedGrade,
  type TimelineCrop,
} from "@chris/media/timeline";

/**
 * Small preview helpers on top of the renderer's own layout math (`@chris/media/timeline`'s
 * cropGeometry / zoomStateAt / resolveGrade / layoutTimelineText / layoutCaptionChunk). Only
 * things the shared module doesn't provide live here: the inverse of the pan mapping (for
 * drag-to-reframe), the grade as SVG filter parameters, vignette gradient stops, and
 * formatting helpers.
 */

/** The pan that results from dragging the picture by (dx, dy) canvas px. */
export function panAfterDrag(
  crop: TimelineCrop,
  source: { width: number; height: number },
  canvas: { width: number; height: number },
  dx: number,
  dy: number,
): { panX: number; panY: number } {
  const g = cropGeometry(source, canvas, crop);
  const ox = g.scaledWidth - canvas.width;
  const oy = g.scaledHeight - canvas.height;
  // offsetX = ox·(panX+1)/2 and the picture moves by -offset → dragging right lowers panX.
  const panX = ox > 0.5 ? clampPan(crop.panX - (2 * dx) / ox) : 0;
  const panY = oy > 0.5 ? clampPan(crop.panY - (2 * dy) / oy) : 0;
  return { panX: round(panX), panY: round(panY) };
}

function clampPan(p: number) {
  return Math.max(-1, Math.min(1, p || 0));
}

/**
 * The grade as SVG filter parameters (PREVIEW PARITY NOTES, timeline-engine.md):
 * contrast/brightness = feComponentTransfer linear (slope c, intercept 0.5·(1−c)+b), then
 * feColorMatrix saturate, then a diagonal temperature matrix from temperatureGains.
 */
export function gradeSvgParams(g: ResolvedGrade): { slope: number; intercept: number; saturation: number; matrix: string } {
  const tg = temperatureGains(g.temperature);
  return {
    slope: round(g.contrast),
    intercept: round(0.5 * (1 - g.contrast) + g.brightness),
    saturation: round(g.saturation),
    matrix: `${tg.r} 0 0 0 0  0 ${tg.g} 0 0 0  0 0 ${tg.b} 0 0  0 0 0 1 0`,
  };
}

/** CSS radial-gradient reproducing the renderer's vignette (cos⁴ falloff to the farthest corner). */
export function vignetteGradient(v: number): string | null {
  if (v <= 0) return null;
  const stops: string[] = [];
  for (let i = 0; i <= 10; i++) {
    const d = i / 10;
    const a = 1 - vignetteFactor(v, d);
    stops.push(`rgba(0,0,0,${round(a)}) ${i * 10}%`);
  }
  return `radial-gradient(circle farthest-corner at 50% 50%, ${stops.join(", ")})`;
}

/** Hex #RRGGBB(AA) -> CSS rgba(). */
export function hexToRgba(hex: string, alphaOverride?: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = alphaOverride ?? (h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
  return `rgba(${r}, ${g}, ${b}, ${round(a)})`;
}

export function splitHexAlpha(hex: string): { rgb: string; alpha: number } {
  const h = hex.replace("#", "");
  return { rgb: `#${h.slice(0, 6).toUpperCase()}`, alpha: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
}

export function joinHexAlpha(rgb: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  return a >= 255 ? rgb.toUpperCase() : `${rgb.toUpperCase()}${a.toString(16).padStart(2, "0").toUpperCase()}`;
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

export function formatTime(s: number, withFrames = false): string {
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  const base = `${m}:${sec.toString().padStart(2, "0")}`;
  if (!withFrames) return base;
  const cs = Math.floor((t * 100) % 100);
  return `${base}.${cs.toString().padStart(2, "0")}`;
}
