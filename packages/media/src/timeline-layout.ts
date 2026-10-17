/**
 * Timeline geometry, typography layout, zoom curve and grade resolution — PURE (no Node, no
 * ffmpeg, no font files). The server renderer (timeline-render.ts) and the browser finishing
 * editor's preview both call these functions, so what the editor previews is, by
 * construction, what renders. The only thing injected is `measureText` (glyph advances):
 * the renderer measures with opentype.js on the TTF; the preview measures with a canvas 2D
 * context using the same font file (font-kerning: none — see the PREVIEW PARITY NOTES in
 * docs/decisions-pending/timeline-engine.md).
 */
import { FONT_METRICS, type FontMetrics } from "./font-metrics";
import { findFont } from "./font-registry";
import {
  GRADE_PRESET_VALUES,
  type EditTimeline,
  type TimelineCaptions,
  type TimelineCrop,
  type TimelineGrade,
  type TimelineText,
  type TimelineZoom,
} from "./timeline";
import type { TimelineCaptionChunk } from "./timeline-captions";
import { rectsIntersect, type Rect } from "./safe-zones";

/** Advance width in canvas px of `text` set in font `fontId` at `fontPx` pixels per em, no kerning. */
export type MeasureText = (text: string, fontId: string, fontPx: number) => number;


/**
 * Every typographic constant the layout uses. Multiples of the element's font size (px per
 * em) unless noted. Changing one changes renderer AND preview together.
 */
export const LAYOUT = {
  text: {
    lineHeight: 1.18,
    plate: { padX: 0.4, padY: 0.24, radius: 0.18 },
    strokeWidth: 0.045,
  },
  captions: {
    lineHeight: 1.15,
    /** Max line width as a fraction of canvas width (before plate padding / stroke). */
    maxWidth: 0.78,
    plate: { padX: 0.36, padY: 0.2, radius: 0.24 },
    strokeWidth: 0.055,
    /** CLEAN only: soft drop shadow offset (x = y) and its colour. */
    cleanShadow: { offset: 0.035, color: "#00000080" },
    /** BOXED with backgroundColor null uses this plate. */
    boxedDefaultBackground: "#000000B3",
  },
} as const;

export function timelineCanvasScale(canvas: { width: number }): number {
  return canvas.width / 1080;
}

export function fontMetricsFor(fontId: string): FontMetrics {
  const m = FONT_METRICS[fontId];
  if (!m || !findFont(fontId)) throw new UnknownFontError(fontId);
  return m;
}

export class UnknownFontError extends Error {
  constructor(fontId: string) {
    super(`Unknown fontId "${fontId}" — not in FONT_REGISTRY.`);
    this.name = "UnknownFontError";
  }
}

// ---------------------------------------------------------------------------------------
// Crop / reframe
// ---------------------------------------------------------------------------------------

export interface CropGeometry {
  /** Source scale factor (cover scale x zoom). */
  scale: number;
  /** The source frame scaled, in canvas px (>= canvas). */
  scaledWidth: number;
  scaledHeight: number;
  /** Top-left of the visible canvas window inside the scaled frame, canvas px. */
  offsetX: number;
  offsetY: number;
}

/**
 * The contract's crop semantics: scale the source to COVER the canvas, times `zoom`, then
 * slide the canvas-sized window over the overflow: pan -1 = left/top edge, 0 = centred,
 * 1 = right/bottom edge. Preview: size the <video> to scaledWidth x scaledHeight and
 * translate it by (-offsetX, -offsetY).
 */
export function cropGeometry(
  source: { width: number; height: number },
  canvas: { width: number; height: number },
  crop: TimelineCrop,
): CropGeometry {
  const cover = Math.max(canvas.width / source.width, canvas.height / source.height);
  const scale = cover * crop.zoom;
  const scaledWidth = source.width * scale;
  const scaledHeight = source.height * scale;
  return {
    scale,
    scaledWidth,
    scaledHeight,
    offsetX: ((scaledWidth - canvas.width) * (crop.panX + 1)) / 2,
    offsetY: ((scaledHeight - canvas.height) * (crop.panY + 1)) / 2,
  };
}

// ---------------------------------------------------------------------------------------
// Zooms (output timeline)
// ---------------------------------------------------------------------------------------

/** Smooth push-in curve (ease-in-out cubic), p in [0,1]. */
export function easeInOutCubic(p: number): number {
  const x = Math.min(1, Math.max(0, p));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Sorts zooms, clamps them to [0, duration], drops ones that end up empty or overlap an
 * earlier zoom (each with a warning — never silently). Renderer and preview both use the
 * result, so they agree on which zooms exist.
 */
export function normalizeZooms(
  zooms: TimelineZoom[],
  duration: number,
): { zooms: TimelineZoom[]; warnings: string[] } {
  const warnings: string[] = [];
  const out: TimelineZoom[] = [];
  for (const z of [...zooms].sort((a, b) => a.start - b.start)) {
    const start = Math.max(0, z.start);
    const end = Math.min(duration, z.end);
    if (end - start < 1 / 30) {
      warnings.push(`zoom ${z.id}: ${z.start}-${z.end}s lies outside the ${round3(duration)}s video — skipped.`);
      continue;
    }
    if (end < z.end) warnings.push(`zoom ${z.id}: end ${z.end}s clamped to the video end (${round3(duration)}s).`);
    const prev = out[out.length - 1];
    if (prev && start < prev.end) {
      warnings.push(`zoom ${z.id}: overlaps zoom ${prev.id} — skipped.`);
      continue;
    }
    out.push({ ...z, start, end });
  }
  return { zooms: out, warnings };
}

export interface ZoomState {
  zoom: number;
  /** Focal point, canvas fractions — stays fixed on screen (CSS transform-origin). */
  x: number;
  y: number;
}

/**
 * Zoom at output time t. Inside [start, end): CUT = `zoom` instantly; EASE = ramps 1 -> zoom
 * over `easeSeconds` from `start` with easeInOutCubic, then holds. At `end` it cuts back to 1.
 * Expects normalizeZooms() output.
 */
export function zoomStateAt(zooms: TimelineZoom[], t: number): ZoomState {
  for (const z of zooms) {
    if (t >= z.start && t < z.end) {
      if (z.mode === "EASE" && z.easeSeconds > 0) {
        const e = easeInOutCubic((t - z.start) / z.easeSeconds);
        return { zoom: 1 + (z.zoom - 1) * e, x: z.x, y: z.y };
      }
      return { zoom: z.zoom, x: z.x, y: z.y };
    }
  }
  return { zoom: 1, x: 0.5, y: 0.5 };
}

/** The canvas-px source window shown for a zoom state (what the renderer samples). */
export function zoomWindow(state: ZoomState, canvas: { width: number; height: number }): Rect {
  const w = canvas.width / state.zoom;
  const h = canvas.height / state.zoom;
  return {
    x: state.x * canvas.width * (1 - 1 / state.zoom),
    y: state.y * canvas.height * (1 - 1 / state.zoom),
    width: w,
    height: h,
  };
}

// ---------------------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------------------

export type ResolvedGrade = Omit<TimelineGrade, "preset">;

export const NEUTRAL_GRADE: ResolvedGrade = GRADE_PRESET_VALUES.NONE;

/**
 * Precedence: start from the preset's values (GRADE_PRESET_VALUES; NONE = neutral); every
 * field that is explicitly NON-neutral overrides the preset's value for that field. (A field
 * left at neutral means "use the preset".)
 */
export function resolveGrade(grade: TimelineGrade): ResolvedGrade {
  const base = GRADE_PRESET_VALUES[grade.preset] ?? NEUTRAL_GRADE;
  const pick = (k: keyof ResolvedGrade) => (grade[k] !== NEUTRAL_GRADE[k] ? grade[k] : base[k]);
  return {
    brightness: pick("brightness"),
    contrast: pick("contrast"),
    saturation: pick("saturation"),
    temperature: pick("temperature"),
    vignette: pick("vignette"),
  };
}

export function isNeutralGrade(g: ResolvedGrade): boolean {
  return (Object.keys(NEUTRAL_GRADE) as Array<keyof ResolvedGrade>).every((k) => g[k] === NEUTRAL_GRADE[k]);
}

/** Temperature as linear per-channel RGB gains (warm = more red, less blue). */
export function temperatureGains(t: number): { r: number; g: number; b: number } {
  return { r: round4(1 + 0.1 * t), g: 1, b: round4(1 - 0.12 * t) };
}

/** Vignette lens angle (radians) for strength v: darkening = cos(angle * d)^4, d = distance
 * from centre / half-diagonal. */
export function vignetteAngle(v: number): number {
  return round4((v * Math.PI) / 3);
}

export function vignetteFactor(v: number, normalizedDistance: number): number {
  if (v <= 0) return 1;
  const c = Math.cos(vignetteAngle(v) * Math.min(1, normalizedDistance));
  return c * c * c * c;
}

// ---------------------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------------------

/** "#RRGGBB" / "#RRGGBBAA" -> components, alpha 0..1. */
export function parseHexColor(hex: string): { r: number; g: number; b: number; a: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}

// ---------------------------------------------------------------------------------------
// Text normalisation + wrapping
// ---------------------------------------------------------------------------------------

/** Control characters -> space, whitespace collapsed; explicit newlines kept as hard breaks. */
export function normalizeLayoutText(text: string, uppercase: boolean): string[] {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((p) => {
      let out = "";
      for (const ch of p) {
        const code = ch.codePointAt(0)!;
        out += code < 0x20 || code === 0x7f ? " " : ch;
      }
      return out.replace(/\s+/g, " ").trim();
    })
    .filter((p) => p.length > 0);
  return uppercase ? paragraphs.map((p) => p.toUpperCase()) : paragraphs;
}

function hardBreak(word: string, fits: (s: string) => boolean): string[] {
  const parts: string[] = [];
  let current = "";
  for (const ch of Array.from(word)) {
    if (current && !fits(current + ch)) {
      parts.push(current);
      current = ch;
    } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

/** Greedy word wrap. Never drops text: an over-long word is broken by character. */
export function greedyWrap(words: string[], maxWidth: number, width: (s: string) => number): string[] {
  const lines: string[] = [];
  let current = "";
  const fits = (s: string) => width(s) <= maxWidth;
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (fits(word)) current = word;
    else {
      const pieces = hardBreak(word, fits);
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? "";
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Greedy wrap, then re-balanced: the narrowest width (binary search, 12 steps) that keeps the
 * same line count — avoids a lonely last word.
 */
export function balancedWrap(text: string, maxWidth: number, width: (s: string) => number): string[] {
  const words = text.split(" ").filter((w) => w.length > 0);
  const greedy = greedyWrap(words, maxWidth, width);
  if (greedy.length < 2) return greedy;
  let lo = 0;
  let hi = maxWidth;
  let best = greedy;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const attempt = greedyWrap(words, mid, width);
    if (attempt.length <= greedy.length && attempt.every((l) => width(l) <= maxWidth)) {
      best = attempt;
      hi = mid;
    } else lo = mid;
  }
  return best;
}

// ---------------------------------------------------------------------------------------
// Text element layout
// ---------------------------------------------------------------------------------------

export interface LaidOutLine {
  text: string;
  /** Left edge of the line's advance box, canvas px. */
  x: number;
  /** Alphabetic baseline, canvas px. */
  baseline: number;
  width: number;
}

export interface TextElementLayout {
  fontId: string;
  /** Pixels per em at this canvas size. */
  fontPx: number;
  lineHeight: number;
  strokeWidth: number;
  lines: LaidOutLine[];
  /** Visual footprint: the plate, or the text box incl. stroke when plate-less. */
  rect: Rect;
  plate: { rect: Rect; radius: number; color: string } | null;
}

function lineBaseline(lineTop: number, lineHeight: number, m: FontMetrics, fontPx: number): number {
  // Cap height vertically centred in the line box.
  return lineTop + (lineHeight + (m.capHeight / m.unitsPerEm) * fontPx) / 2;
}

/**
 * Lays out a TimelineText: wrap inside maxWidth (minus plate padding / stroke), block centred
 * at (x, y) and clamped inside the canvas, lines aligned within the block, cap height
 * centred in each line box. All outputs are rounded to whole px.
 */
export function layoutTimelineText(
  t: Pick<TimelineText, "text" | "fontId" | "fontSize" | "backgroundColor" | "strokeColor" | "align" | "x" | "y" | "maxWidth" | "uppercase">,
  canvas: { width: number; height: number },
  measure: MeasureText,
): TextElementLayout {
  const m = fontMetricsFor(t.fontId);
  const k = timelineCanvasScale(canvas);
  const fontPx = Math.round(t.fontSize * k);
  const lineHeight = Math.round(fontPx * LAYOUT.text.lineHeight);
  const strokeWidth = t.strokeColor ? Math.max(1, Math.round(fontPx * LAYOUT.text.strokeWidth)) : 0;
  const padX = t.backgroundColor ? Math.round(fontPx * LAYOUT.text.plate.padX) : strokeWidth;
  const padY = t.backgroundColor ? Math.round(fontPx * LAYOUT.text.plate.padY) : strokeWidth;
  const wrapWidth = Math.max(fontPx, t.maxWidth * canvas.width - 2 * padX);
  const width = (s: string) => measure(s, t.fontId, fontPx);

  const lines = normalizeLayoutText(t.text, t.uppercase).flatMap((p) => balancedWrap(p, wrapWidth, width));
  const widths = lines.map(width);
  const contentWidth = Math.max(0, ...widths);
  const blockW = Math.round(contentWidth + 2 * padX);
  const blockH = Math.round(lines.length * lineHeight + 2 * padY);
  const left = clamp(Math.round(t.x * canvas.width - blockW / 2), 0, Math.max(0, canvas.width - blockW));
  const top = clamp(Math.round(t.y * canvas.height - blockH / 2), 0, Math.max(0, canvas.height - blockH));

  const laid: LaidOutLine[] = lines.map((text, i) => {
    const w = widths[i]!;
    const x =
      t.align === "left" ? left + padX : t.align === "right" ? left + blockW - padX - w : left + (blockW - w) / 2;
    return {
      text,
      x: Math.round(x),
      baseline: Math.round(lineBaseline(top + padY + i * lineHeight, lineHeight, m, fontPx)),
      width: Math.round(w),
    };
  });
  const rect = { x: left, y: top, width: blockW, height: blockH };
  return {
    fontId: t.fontId,
    fontPx,
    lineHeight,
    strokeWidth,
    lines: laid,
    rect,
    plate: t.backgroundColor
      ? { rect, radius: Math.round(fontPx * LAYOUT.text.plate.radius), color: t.backgroundColor }
      : null,
  };
}

// ---------------------------------------------------------------------------------------
// Caption layout
// ---------------------------------------------------------------------------------------

export interface LaidOutCaptionWord {
  text: string;
  /** Index into chunk.words. */
  index: number;
  x: number;
  width: number;
}

export interface LaidOutCaptionLine extends LaidOutLine {
  words: LaidOutCaptionWord[];
}

export interface TimelineCaptionLayout {
  fontPx: number;
  lineHeight: number;
  strokeWidth: number;
  /** CLEAN only (0 otherwise). */
  shadowOffset: number;
  lines: LaidOutCaptionLine[];
  rect: Rect;
  plate: { rect: Rect; radius: number; color: string } | null;
}

/** The plate colour for a caption style, or null for no plate. */
export function captionPlateColor(c: Pick<TimelineCaptions, "preset" | "backgroundColor">): string | null {
  if (c.preset === "BOXED") return c.backgroundColor ?? LAYOUT.captions.boxedDefaultBackground;
  return c.backgroundColor;
}

/**
 * Lays out one caption chunk: words wrapped (balanced) inside LAYOUT.captions.maxWidth, block
 * centred horizontally and vertically at captions.y, lines centred, cap height centred in
 * each line box. Word x positions are given for highlight/karaoke rendering in the preview.
 */
export function layoutCaptionChunk(
  chunk: Pick<TimelineCaptionChunk, "words">,
  captions: Pick<TimelineCaptions, "preset" | "fontId" | "fontSize" | "strokeColor" | "backgroundColor" | "y">,
  canvas: { width: number; height: number },
  measure: MeasureText,
): TimelineCaptionLayout {
  const m = fontMetricsFor(captions.fontId);
  const k = timelineCanvasScale(canvas);
  const fontPx = Math.round(captions.fontSize * k);
  const lineHeight = Math.round(fontPx * LAYOUT.captions.lineHeight);
  const strokeWidth = captions.strokeColor ? Math.max(1, Math.round(fontPx * LAYOUT.captions.strokeWidth)) : 0;
  const plateColor = captionPlateColor(captions);
  const padX = plateColor ? Math.round(fontPx * LAYOUT.captions.plate.padX) : strokeWidth;
  const padY = plateColor ? Math.round(fontPx * LAYOUT.captions.plate.padY) : strokeWidth;
  const width = (s: string) => measure(s, captions.fontId, fontPx);
  const wrapWidth = Math.max(fontPx, LAYOUT.captions.maxWidth * canvas.width - 2 * padX);

  const words = chunk.words.map((w) => normalizeLayoutText(w.word, false).join(" ")).map((w) => (w.length ? w : "·"));
  const lineTexts = balancedWrap(words.join(" "), wrapWidth, width);
  // Re-associate wrapped lines with word indices (a hard-broken word spans lines; it keeps
  // its index on each piece).
  let wi = 0;
  let consumed = "";
  const lineWords: LaidOutCaptionWord[][] = lineTexts.map((line) => {
    const parts = line.split(" ");
    return parts.map((p) => {
      const item = { text: p, index: Math.min(wi, words.length - 1), x: 0, width: 0 };
      consumed += p;
      if (consumed.length >= (words[wi]?.length ?? Infinity)) {
        wi++;
        consumed = "";
      }
      return item;
    });
  });

  const widths = lineTexts.map(width);
  const contentWidth = Math.max(0, ...widths);
  const blockW = Math.round(contentWidth + 2 * padX);
  const blockH = Math.round(lineTexts.length * lineHeight + 2 * padY);
  const left = clamp(Math.round(canvas.width / 2 - blockW / 2), 0, Math.max(0, canvas.width - blockW));
  const top = clamp(Math.round(captions.y * canvas.height - blockH / 2), 0, Math.max(0, canvas.height - blockH));

  const lines: LaidOutCaptionLine[] = lineTexts.map((text, i) => {
    const w = widths[i]!;
    const x = Math.round(left + (blockW - w) / 2);
    const ws = lineWords[i]!;
    let prefix = "";
    for (const word of ws) {
      word.x = Math.round(x + (prefix ? width(prefix + " ") : 0));
      word.width = Math.round(width(word.text));
      prefix = prefix ? `${prefix} ${word.text}` : word.text;
    }
    return {
      text,
      x,
      baseline: Math.round(lineBaseline(top + padY + i * lineHeight, lineHeight, m, fontPx)),
      width: Math.round(w),
      words: ws,
    };
  });
  const rect = { x: left, y: top, width: blockW, height: blockH };
  return {
    fontPx,
    lineHeight,
    strokeWidth,
    shadowOffset: captions.preset === "CLEAN" ? Math.max(1, Math.round(fontPx * LAYOUT.captions.cleanShadow.offset)) : 0,
    lines,
    rect,
    plate: plateColor ? { rect, radius: Math.round(fontPx * LAYOUT.captions.plate.radius), color: plateColor } : null,
  };
}

// ---------------------------------------------------------------------------------------
// Timing clamps + collisions
// ---------------------------------------------------------------------------------------

/** Clamps texts to [0, duration]; drops (with a warning) any that end up empty. */
export function normalizeTexts(
  texts: TimelineText[],
  duration: number,
): { texts: TimelineText[]; warnings: string[] } {
  const warnings: string[] = [];
  const out: TimelineText[] = [];
  for (const t of texts) {
    const start = Math.max(0, t.start);
    const end = Math.min(duration, t.end);
    if (end - start < 1 / 30) {
      warnings.push(`text ${t.id} ("${t.text.slice(0, 40)}"): ${t.start}-${t.end}s lies outside the ${round3(duration)}s video — skipped.`);
      continue;
    }
    if (end < t.end) warnings.push(`text ${t.id}: end ${t.end}s clamped to the video end (${round3(duration)}s).`);
    out.push({ ...t, start, end });
  }
  return { texts: out, warnings };
}

export interface TimelineCollision {
  kind: "TEXT_TEXT" | "CAPTION_TEXT";
  a: string;
  b: string;
  overlapStartSeconds: number;
  overlapEndSeconds: number;
}

/**
 * Deterministic on-screen collisions in a timeline: two texts whose footprints intersect while
 * both are visible, and caption phrases whose footprint intersects a visible text. Uses the
 * exact layouts the renderer draws.
 */
export function findTimelineCollisions(
  timeline: Pick<EditTimeline, "canvas" | "texts" | "captions">,
  chunks: TimelineCaptionChunk[],
  measure: MeasureText,
): TimelineCollision[] {
  const texts = timeline.texts.map((t) => ({ t, rect: layoutTimelineText(t, timeline.canvas, measure).rect }));
  const out: TimelineCollision[] = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!;
      const b = texts[j]!;
      const s = Math.max(a.t.start, b.t.start);
      const e = Math.min(a.t.end, b.t.end);
      if (e > s && rectsIntersect(a.rect, b.rect)) {
        out.push({ kind: "TEXT_TEXT", a: a.t.text, b: b.t.text, overlapStartSeconds: round3(s), overlapEndSeconds: round3(e) });
      }
    }
  }
  if (timeline.captions.enabled) {
    for (const c of chunks) {
      const rect = layoutCaptionChunk(c, timeline.captions, timeline.canvas, measure).rect;
      for (const { t, rect: tr } of texts) {
        const s = Math.max(t.start, c.start);
        const e = Math.min(t.end, c.end);
        if (e > s && rectsIntersect(rect, tr)) {
          out.push({ kind: "CAPTION_TEXT", a: c.text, b: t.text, overlapStartSeconds: round3(s), overlapEndSeconds: round3(e) });
        }
      }
    }
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
