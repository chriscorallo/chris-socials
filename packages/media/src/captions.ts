import { BUNDLED_FONT_FAMILIES, resolveBundledFontPath, type BundledFontWeight } from "./fonts";
import { ACCENT_COLOR_HEX, canvasScale, type OverlayLayout } from "./overlay-layout";
import { getSafeArea, rectInsideSafeArea, rectsIntersect, type Rect } from "./safe-zones";
import { assFontSizeToEmPixels, measureTextWidth, replaceControlChars, wrapText } from "./text-layout";

/**
 * Word-level burned-in captions. Pipeline (all deterministic, no model calls):
 *   source-timeline word timings (transcription)
 *     -> remapWordsToOutputTimeline (through the EditPlan's kept segments)
 *     -> buildCaptionChunks (2-4 word phrases, broken on punctuation / pauses)
 *     -> layoutCaptionChunks (font-metric wrap, safe-zone placement, overlay avoidance)
 *     -> buildAssDocument (rendered by ffmpeg's libass `ass` filter with the bundled fonts)
 */

import {
  remapWordsToOutputTimeline,
  buildCaptionChunks,
  DEFAULT_CHUNKING,
  type TranscriptWord,
  type CaptionChunk,
  type ChunkingOptions,
} from "./caption-chunking";
export {
  remapWordsToOutputTimeline,
  buildCaptionChunks,
  DEFAULT_CHUNKING,
  type TranscriptWord,
  type CaptionChunk,
  type ChunkingOptions,
};

export type CaptionStylePreset = "CLEAN" | "BOLD_HIGHLIGHT";
export type CaptionPosition = "LOWER" | "CENTER";

export interface CaptionsConfig {
  enabled: boolean;
  style: CaptionStylePreset;
  position: CaptionPosition;
}

export const DEFAULT_CAPTIONS_CONFIG: CaptionsConfig = {
  enabled: true,
  style: "CLEAN",
  position: "LOWER",
};

// ---------------------------------------------------------------------------------------
// Layout + placement
// ---------------------------------------------------------------------------------------

interface CaptionPreset {
  weight: BundledFontWeight;
  /** Pixels-per-em at the 1080 reference scale. */
  emSize: number;
  outline: number;
  shadow: number;
  /** ASS colours, &HAABBGGRR (AA=00 opaque). */
  primary: string;
  outlineColour: string;
  backColour: string;
  highlightActiveWord: boolean;
  maxChars: number;
}

export const CAPTION_STYLE_PRESETS: Record<CaptionStylePreset, CaptionPreset> = {
  CLEAN: {
    weight: "DISPLAY_BOLD",
    emSize: 62,
    outline: 3,
    shadow: 2,
    primary: "&H00FFFFFF",
    outlineColour: "&H40000000",
    backColour: "&H80000000",
    highlightActiveWord: false,
    maxChars: 24,
  },
  BOLD_HIGHLIGHT: {
    weight: "DISPLAY_EXTRABOLD",
    emSize: 72,
    outline: 4,
    shadow: 0,
    primary: "&H00FFFFFF",
    outlineColour: "&H10000000",
    backColour: "&H00000000",
    highlightActiveWord: true,
    maxChars: 18,
  },
};

/** ASS colour for the brand accent (RRGGBB -> &HBBGGRR&). */
const ACCENT_ASS = `&H${ACCENT_COLOR_HEX.slice(4, 6)}${ACCENT_COLOR_HEX.slice(2, 4)}${ACCENT_COLOR_HEX.slice(0, 2)}&`;

export interface CaptionChunkLayout {
  chunk: CaptionChunk;
  lines: string[];
  /** Anchor: horizontal centre / bottom edge of the text block (ASS \an2 \pos). */
  anchorX: number;
  anchorBottomY: number;
  rect: Rect;
  /** True when the default band collided with an overlay and the caption was moved. */
  relocated: boolean;
  /** Overlay indices this chunk still overlaps after relocation (should be empty). */
  residualCollisionWith: number[];
}

export interface CaptionLayoutResult {
  preset: CaptionStylePreset;
  assFontSize: number;
  fontFamily: string;
  bold: boolean;
  outline: number;
  shadow: number;
  layouts: CaptionChunkLayout[];
}

function timeOverlaps(a: { start: number; end: number }, b: { startSeconds: number; endSeconds: number }) {
  return a.start < b.endSeconds && b.startSeconds < a.end;
}

export function captionBandBottom(position: CaptionPosition, canvas: { width: number; height: number }): number {
  const safe = getSafeArea(canvas.width, canvas.height);
  const s = canvasScale(canvas.width, canvas.height);
  if (position === "LOWER") return safe.bottom - Math.round(40 * s);
  // CENTER: lower-middle of the frame — under the face of a typical talking-head framing.
  return Math.round(safe.top + (safe.bottom - safe.top) * 0.72);
}

export function layoutCaptionChunks(
  chunks: CaptionChunk[],
  config: CaptionsConfig,
  canvas: { width: number; height: number },
  overlays: OverlayLayout[] = [],
): CaptionLayoutResult {
  const preset = CAPTION_STYLE_PRESETS[config.style];
  const s = canvasScale(canvas.width, canvas.height);
  const safe = getSafeArea(canvas.width, canvas.height);
  const fontPath = resolveBundledFontPath(preset.weight);
  const emPx = preset.emSize * s;
  // Inverse of assFontSizeToEmPixels: the ASS Fontsize that yields `emPx` pixels per em.
  const assFontSize = Math.round((emPx * emPx) / assFontSizeToEmPixels(emPx, fontPath));
  const lineHeight = assFontSize; // libass line advance ~= Fontsize for this font
  const outline = Math.max(1, Math.round(preset.outline * s));
  const maxWidth = Math.floor(safe.centeredMaxWidth * 0.94 - 2 * outline);
  const gap = Math.round(32 * s);
  const defaultBottom = captionBandBottom(config.position, canvas);
  const family = BUNDLED_FONT_FAMILIES[preset.weight];

  const layouts = chunks.map((chunk) => {
    const lines = wrapText(chunk.text, fontPath, emPx, maxWidth);
    const width = Math.max(...lines.map((l) => measureTextWidth(l, fontPath, emPx))) + 2 * outline;
    const height = lines.length * lineHeight;
    const rectFor = (bottom: number): Rect => ({
      x: Math.round(canvas.width / 2 - width / 2),
      y: Math.round(bottom - height),
      width: Math.round(width),
      height: Math.round(height),
    });
    const active = overlays.filter((o) => timeOverlaps(chunk, o));
    const conflicts = (r: Rect) => active.filter((o) => rectsIntersect(r, padRect(o.rect, gap / 2)));

    let bottom = defaultBottom;
    let relocated = false;
    let residual = conflicts(rectFor(bottom));
    if (residual.length > 0) {
      const candidates: number[] = [];
      const topOfConflicts = Math.min(...residual.map((o) => o.rect.y));
      const bottomOfConflicts = Math.max(...residual.map((o) => o.rect.y + o.rect.height));
      candidates.push(topOfConflicts - gap); // just above the overlay
      candidates.push(bottomOfConflicts + gap + height); // just below it
      candidates.push(captionBandBottom(config.position === "LOWER" ? "CENTER" : "LOWER", canvas));
      for (const candidate of candidates) {
        const r = rectFor(candidate);
        if (rectInsideSafeArea(r, safe) && conflicts(r).length === 0) {
          bottom = candidate;
          relocated = true;
          residual = [];
          break;
        }
      }
    }
    const rect = rectFor(bottom);
    return {
      chunk,
      lines,
      anchorX: Math.round(canvas.width / 2),
      anchorBottomY: Math.round(bottom),
      rect,
      relocated,
      residualCollisionWith: residual.map((o) => o.index),
    };
  });

  return {
    preset: config.style,
    assFontSize,
    fontFamily: family.family,
    bold: family.bold,
    outline,
    shadow: Math.round(preset.shadow * s),
    layouts,
  };
}

function padRect(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad };
}

// ---------------------------------------------------------------------------------------
// ASS document
// ---------------------------------------------------------------------------------------

/**
 * Makes transcript text inert inside an ASS Dialogue line: `{...}` would open an override
 * block and `\N`/`\n`/`\h` are line-break/space escapes. Braces become parentheses and a
 * backslash becomes a fullwidth reverse solidus lookalike-free slash — a deliberate,
 * documented tiny fidelity loss for characters that essentially never occur in speech.
 */
export function sanitizeAssText(text: string): string {
  return replaceControlChars(text)
    .replace(/\\/g, "/")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")");
}

function assTime(seconds: number): string {
  const t = Math.max(0, seconds);
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** Joins chunk lines, optionally colouring one word (by index across the whole chunk). */
function chunkText(lines: string[], highlightIndex: number | null): string {
  let wordIdx = 0;
  return lines
    .map((line) =>
      line
        .split(" ")
        .map((w) => {
          const safe = sanitizeAssText(w);
          const out = wordIdx === highlightIndex ? `{\\c${ACCENT_ASS}}${safe}{\\c&HFFFFFF&}` : safe;
          wordIdx++;
          return out;
        })
        .join(" "),
    )
    .join("\\N");
}

export function buildAssDocument(
  layout: CaptionLayoutResult,
  canvas: { width: number; height: number },
): string {
  const preset = CAPTION_STYLE_PRESETS[layout.preset];
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    // 2 = no automatic wrapping: lines are pre-wrapped from real font metrics above, so what
    // the layout/collision code computed is exactly what libass draws.
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,${layout.fontFamily},${layout.assFontSize},${preset.primary},&H000000FF,${preset.outlineColour},${preset.backColour},${layout.bold ? -1 : 0},0,0,0,100,100,0,0,1,${layout.outline},${layout.shadow},2,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events: string[] = [];
  for (const l of layout.layouts) {
    const pos = `{\\an2\\pos(${l.anchorX},${l.anchorBottomY})}`;
    if (!preset.highlightActiveWord) {
      events.push(
        `Dialogue: 0,${assTime(l.chunk.start)},${assTime(l.chunk.end)},Caption,,0,0,0,,${pos}${chunkText(l.lines, null)}`,
      );
      continue;
    }
    // One event per word: the whole phrase stays put, the spoken word lights up.
    const ws = l.chunk.words;
    ws.forEach((w, i) => {
      const start = i === 0 ? l.chunk.start : w.start;
      const end = i === ws.length - 1 ? l.chunk.end : ws[i + 1]!.start;
      if (end <= start) return;
      events.push(
        `Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${pos}${chunkText(l.lines, i)}`,
      );
    });
  }
  return [...header, ...events, ""].join("\n");
}
