import { resolveBundledFontPath, type BundledFontWeight } from "./fonts";
import { getSafeArea, type Rect, type SafeArea } from "./safe-zones";
import { fitText, loadFontMetrics, normalizeOverlayText } from "./text-layout";

export type OverlayPosition = "TOP" | "CENTER" | "BOTTOM";
export type OverlayStyle = "HEADLINE" | "CAPTION" | "NUMBER_CALLOUT" | "LOWER_THIRD";

/** Brand accent — a warm, slightly desaturated yellow: reads as "edited", not "template". */
export const ACCENT_COLOR_HEX = "FFD84D";

interface StylePreset {
  weight: BundledFontWeight;
  /** All pixel values at the 1080-wide reference scale. */
  maxFontSize: number;
  minFontSize: number;
  maxLines: number;
  lineHeight: number; // multiple of font size
  textColor: string; // ffmpeg color
  plate: { color: string; padX: number; padY: number } | null;
  /** Outline + drop shadow for plate-less styles, so they hold up over bright footage. */
  borderWidth: number;
  borderColor: string;
  shadow: { x: number; y: number; color: string } | null;
  align: "CENTER" | "LEFT";
  /** Width of the left accent bar (LOWER_THIRD), 0 for none. */
  accentBarWidth: number;
  /** Text block max width as a fraction of the safe centered width. */
  maxWidthFraction: number;
}

/**
 * Deterministic per-style typography. Restrained on purpose (brand: the viewer should think
 * "that editing is sick", not "this is AI"): one typeface family, a single accent color used
 * only for numbers and the lower-third bar, flat translucent plates instead of glows/gradients.
 */
export const OVERLAY_STYLE_PRESETS: Record<OverlayStyle, StylePreset> = {
  HEADLINE: {
    weight: "DISPLAY_BOLD",
    maxFontSize: 78,
    minFontSize: 50,
    maxLines: 3,
    lineHeight: 1.14,
    textColor: "white",
    plate: { color: "black@0.58", padX: 34, padY: 24 },
    borderWidth: 0,
    borderColor: "black@0",
    shadow: null,
    align: "CENTER",
    accentBarWidth: 0,
    maxWidthFraction: 1,
  },
  CAPTION: {
    weight: "SEMIBOLD",
    maxFontSize: 54,
    minFontSize: 40,
    maxLines: 3,
    lineHeight: 1.2,
    textColor: "white",
    plate: { color: "black@0.48", padX: 26, padY: 18 },
    borderWidth: 0,
    borderColor: "black@0",
    shadow: null,
    align: "CENTER",
    accentBarWidth: 0,
    maxWidthFraction: 1,
  },
  NUMBER_CALLOUT: {
    weight: "DISPLAY_EXTRABOLD",
    maxFontSize: 170,
    minFontSize: 92,
    maxLines: 2,
    lineHeight: 1.02,
    textColor: `#${ACCENT_COLOR_HEX}`,
    plate: null,
    borderWidth: 3,
    borderColor: "black@0.35",
    shadow: { x: 0, y: 6, color: "black@0.45" },
    align: "CENTER",
    accentBarWidth: 0,
    maxWidthFraction: 1,
  },
  LOWER_THIRD: {
    weight: "SEMIBOLD",
    maxFontSize: 46,
    minFontSize: 36,
    maxLines: 2,
    lineHeight: 1.22,
    textColor: "white",
    plate: { color: "black@0.62", padX: 26, padY: 18 },
    borderWidth: 0,
    borderColor: "black@0",
    shadow: null,
    align: "LEFT",
    accentBarWidth: 8,
    maxWidthFraction: 0.82,
  },
};

export interface LayoutOverlayInput {
  text: string;
  startSeconds: number;
  endSeconds: number;
  position: OverlayPosition;
  style?: OverlayStyle;
}

export interface OverlayLine {
  text: string;
  /** Baseline y in canvas pixels. */
  baselineY: number;
  /** Left x in canvas pixels, or "CENTER" to center the line horizontally on the canvas. */
  x: number | "CENTER";
  width: number;
}

export interface OverlayLayout {
  index: number;
  text: string;
  startSeconds: number;
  endSeconds: number;
  position: OverlayPosition;
  style: OverlayStyle;
  fontPath: string;
  fontSize: number;
  lines: OverlayLine[];
  /** The full visual footprint (plate, or text box for plate-less styles). */
  rect: Rect;
  plate: { rect: Rect; color: string } | null;
  accentBar: { rect: Rect; color: string } | null;
  textColor: string;
  borderWidth: number;
  borderColor: string;
  shadow: { x: number; y: number; color: string } | null;
}

/** Reference scale for a canvas: 1.0 at 1080 px on the short edge. */
export function canvasScale(width: number, height: number): number {
  return Math.min(width, height) / 1080;
}

/** FreeType rounds each glyph advance to whole pixels; keep a margin so measured==rendered. */
const MEASUREMENT_SAFETY = 0.96;

export function layoutOverlay(
  overlay: LayoutOverlayInput,
  index: number,
  canvas: { width: number; height: number },
  options: { fontPathOverride?: (weight: BundledFontWeight) => string } = {},
): OverlayLayout {
  const style: OverlayStyle = overlay.style ?? "HEADLINE";
  const preset = OVERLAY_STYLE_PRESETS[style];
  const s = canvasScale(canvas.width, canvas.height);
  const safe: SafeArea = getSafeArea(canvas.width, canvas.height);
  const fontPath = options.fontPathOverride
    ? options.fontPathOverride(preset.weight)
    : resolveBundledFontPath(preset.weight);
  const { font, unitsPerEm } = loadFontMetrics(fontPath);
  const os2 = font.tables.os2 as { sCapHeight?: number } | undefined;
  const capHeightEm = (os2?.sCapHeight ?? unitsPerEm * 0.727) / unitsPerEm;

  const padX = preset.plate ? Math.round(preset.plate.padX * s) : Math.round(preset.borderWidth * s);
  const padY = preset.plate ? Math.round(preset.plate.padY * s) : Math.round(preset.borderWidth * s);
  const accentBar = Math.round(preset.accentBarWidth * s);
  const availableBlockWidth =
    preset.align === "CENTER" ? safe.centeredMaxWidth : safe.right - safe.left;
  const maxTextWidth = Math.floor(
    (availableBlockWidth * preset.maxWidthFraction - 2 * padX - accentBar) * MEASUREMENT_SAFETY,
  );

  const fitted = fitText({
    text: normalizeOverlayText(overlay.text),
    fontPath,
    maxWidth: maxTextWidth,
    maxFontSize: preset.maxFontSize * s,
    minFontSize: preset.minFontSize * s,
    maxLines: preset.maxLines,
  });

  const fs = fitted.fontSize;
  const lineHeightPx = Math.round(fs * preset.lineHeight);
  const capPx = fs * capHeightEm;
  const descenderAllowance = fs * 0.2;
  const textBlockHeight = capPx + (fitted.lines.length - 1) * lineHeightPx + descenderAllowance;
  const blockHeight = Math.round(textBlockHeight + 2 * padY);
  const blockWidth = Math.round(fitted.blockWidth / MEASUREMENT_SAFETY + 2 * padX + accentBar);

  const gap = Math.round(40 * s);
  let blockTop: number;
  switch (overlay.position) {
    case "TOP":
      blockTop = safe.top + gap;
      break;
    case "CENTER":
      blockTop = Math.round((safe.top + safe.bottom) / 2 - blockHeight / 2);
      break;
    case "BOTTOM":
      blockTop = safe.bottom - Math.round(20 * s) - blockHeight;
      break;
  }
  // Never let a tall (many-line, min-size) block escape the safe area vertically.
  blockTop = Math.max(safe.top, Math.min(blockTop, safe.bottom - blockHeight));

  const blockLeft =
    preset.align === "CENTER" ? Math.round((canvas.width - blockWidth) / 2) : safe.left;
  const rect: Rect = { x: blockLeft, y: blockTop, width: blockWidth, height: blockHeight };

  const firstBaseline = blockTop + padY + capPx;
  const lines: OverlayLine[] = fitted.lines.map((text, i) => ({
    text,
    baselineY: Math.round(firstBaseline + i * lineHeightPx),
    x: preset.align === "CENTER" ? "CENTER" : blockLeft + accentBar + padX,
    width: fitted.lineWidths[i] ?? 0,
  }));

  return {
    index,
    text: overlay.text,
    startSeconds: overlay.startSeconds,
    endSeconds: overlay.endSeconds,
    position: overlay.position,
    style,
    fontPath,
    fontSize: fs,
    lines,
    rect,
    plate: preset.plate ? { rect, color: preset.plate.color } : null,
    accentBar:
      accentBar > 0
        ? {
            rect: { x: blockLeft, y: blockTop, width: accentBar, height: blockHeight },
            color: `#${ACCENT_COLOR_HEX}`,
          }
        : null,
    textColor: preset.textColor,
    borderWidth: Math.round(preset.borderWidth * s),
    borderColor: preset.borderColor,
    shadow: preset.shadow
      ? {
          x: Math.round(preset.shadow.x * s),
          y: Math.round(preset.shadow.y * s),
          color: preset.shadow.color,
        }
      : null,
  };
}

export function layoutOverlays(
  overlays: LayoutOverlayInput[],
  canvas: { width: number; height: number },
  options: { fontPathOverride?: (weight: BundledFontWeight) => string } = {},
): OverlayLayout[] {
  return overlays.map((o, i) => layoutOverlay(o, i, canvas, options));
}
