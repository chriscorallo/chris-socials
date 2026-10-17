import type { TimelineCrop, TimelineGrade, TimelineZoom, TimelineText, TimelineCaptions } from "@chris/media/timeline";

/**
 * Pure geometry/color math shared by the preview canvas, so the preview follows the contract
 * conventions in packages/media/src/timeline.ts exactly (crop = scale-to-cover then zoom, pan
 * across the overflow; positions are element CENTERS as canvas fractions; px at 1080 width).
 */

/**
 * Layout of a source frame inside the canvas for a clip's crop. The video element is sized
 * `baseW x baseH` (cover at zoom 1) and transformed with
 * `translate(tx px, ty px) scale(crop.zoom)` from origin 0 0.
 */
export function coverLayout(
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  crop: TimelineCrop,
): { baseW: number; baseH: number; tx: number; ty: number; scale: number } {
  const w = srcW > 0 ? srcW : canvasW;
  const h = srcH > 0 ? srcH : canvasH;
  const cover = Math.max(canvasW / w, canvasH / h);
  const baseW = w * cover;
  const baseH = h * cover;
  const zoom = Math.max(1, crop.zoom);
  const overflowX = baseW * zoom - canvasW;
  const overflowY = baseH * zoom - canvasH;
  const tx = -(overflowX / 2) * (1 + clampPan(crop.panX));
  const ty = -(overflowY / 2) * (1 + clampPan(crop.panY));
  return { baseW, baseH, tx, ty, scale: zoom };
}

function clampPan(p: number) {
  return Math.max(-1, Math.min(1, p || 0));
}

/** Inverse of the pan mapping: the pan that results from dragging the picture by (dx, dy) px. */
export function panAfterDrag(
  crop: TimelineCrop,
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  dx: number,
  dy: number,
): { panX: number; panY: number } {
  const { baseW, baseH } = coverLayout(srcW, srcH, canvasW, canvasH, crop);
  const ox = baseW * crop.zoom - canvasW;
  const oy = baseH * crop.zoom - canvasH;
  // tx = -(ox/2)(1+panX) -> dragging right (dx>0) increases tx -> decreases panX.
  const panX = ox > 0.5 ? clampPan(crop.panX - (2 * dx) / ox) : 0;
  const panY = oy > 0.5 ? clampPan(crop.panY - (2 * dy) / oy) : 0;
  return { panX: round(panX), panY: round(panY) };
}

/**
 * Punch-in at output time `t` (on top of the clip crop). The last-defined active zoom wins.
 * CUT = full zoom for the whole span. EASE = smooth (smoothstep) push from 1x to `zoom` over
 * the first `easeSeconds`, then hold; it cuts back at the end of the span.
 */
export function zoomAt(zooms: TimelineZoom[], t: number): { scale: number; x: number; y: number; id: string | null } {
  let active: TimelineZoom | null = null;
  for (const z of zooms) if (t >= z.start && t < z.end) active = z;
  if (!active) return { scale: 1, x: 0.5, y: 0.5, id: null };
  let scale = active.zoom;
  if (active.mode === "EASE" && active.easeSeconds > 0) {
    const p = Math.min(1, Math.max(0, (t - active.start) / active.easeSeconds));
    const s = p * p * (3 - 2 * p);
    scale = 1 + (active.zoom - 1) * s;
  }
  return { scale, x: active.x, y: active.y, id: active.id };
}

/**
 * CSS approximation of the renderer's grade: filter for brightness/contrast/saturation, a
 * soft-light color wash for temperature, and a radial vignette. (The renderer uses ffmpeg
 * eq/colorbalance/vignette — close, not pixel-identical; see INTEGRATION NOTES.)
 */
export function gradeCss(grade: Omit<TimelineGrade, "preset">): {
  filter: string;
  wash: { color: string; opacity: number } | null;
  vignette: number;
} {
  const parts: string[] = [];
  if (grade.brightness !== 0) parts.push(`brightness(${round(1 + grade.brightness)})`);
  if (grade.contrast !== 1) parts.push(`contrast(${round(grade.contrast)})`);
  if (grade.saturation !== 1) parts.push(`saturate(${round(grade.saturation)})`);
  const t = grade.temperature;
  const wash = t === 0 ? null : { color: t > 0 ? "#ff9a3c" : "#3c8cff", opacity: round(Math.min(0.6, Math.abs(t) * 0.45)) };
  return { filter: parts.join(" ") || "none", wash, vignette: grade.vignette };
}

/** Outline thickness (px at canvas width 1080) the preview uses for a stroked text. */
export function strokePx(fontSize: number): number {
  return Math.max(2, Math.round(fontSize * 0.07));
}

// ---------------------------------------------------------------------------------------
// Box estimates (for safe-zone checks) — deterministic, font-metric-free approximations.
// ---------------------------------------------------------------------------------------

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const AVG_CHAR_EM = 0.56;
const AVG_CHAR_EM_UPPER = 0.66;
const LINE_HEIGHT_EM = 1.15;

/** Greedy word-wrap of `text` into lines no wider than `maxPx`, using an average glyph width. */
export function estimateLines(text: string, fontSize: number, maxPx: number, uppercase: boolean): string[] {
  const em = (uppercase ? AVG_CHAR_EM_UPPER : AVG_CHAR_EM) * fontSize;
  const lines: string[] = [];
  for (const para of text.split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const cand = line ? `${line} ${word}` : word;
      if (cand.length * em > maxPx && line) {
        lines.push(line);
        line = word;
      } else line = cand;
    }
    lines.push(line);
  }
  return lines;
}

/** Estimated box of a text element in canvas px (at canvas width W / height H). */
export function estimateTextBox(t: TimelineText, W = 1080, H = 1920): Box {
  const k = W / 1080;
  const fs = t.fontSize * k;
  const maxPx = t.maxWidth * W;
  const lines = estimateLines(t.text, fs, maxPx, t.uppercase);
  const em = (t.uppercase ? AVG_CHAR_EM_UPPER : AVG_CHAR_EM) * fs;
  const pad = t.backgroundColor ? fs * 0.3 : 0;
  const width = Math.min(maxPx, Math.max(...lines.map((l) => l.length * em))) + pad * 2;
  const height = lines.length * fs * LINE_HEIGHT_EM + pad * 2;
  const cx = t.x * W;
  const cy = t.y * H;
  return { x0: cx - width / 2, x1: cx + width / 2, y0: cy - height / 2, y1: cy + height / 2 };
}

/** Estimated box of the caption block for its longest chunk text. */
export function estimateCaptionBox(c: TimelineCaptions, longestChunkText: string, W = 1080, H = 1920): Box {
  const k = W / 1080;
  const fs = c.fontSize * k;
  const maxPx = 0.84 * W;
  const lines = estimateLines(longestChunkText || "Caption text", fs, maxPx, c.uppercase);
  const em = (c.uppercase ? AVG_CHAR_EM_UPPER : AVG_CHAR_EM) * fs;
  const pad = c.backgroundColor || c.preset === "BOXED" ? fs * 0.3 : 0;
  const width = Math.min(maxPx, Math.max(...lines.map((l) => l.length * em))) + pad * 2;
  const height = lines.length * fs * LINE_HEIGHT_EM + pad * 2;
  const cy = c.y * H;
  return { x0: W / 2 - width / 2, x1: W / 2 + width / 2, y0: cy - height / 2, y1: cy + height / 2 };
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
