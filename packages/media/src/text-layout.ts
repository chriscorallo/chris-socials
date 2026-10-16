import { readFileSync } from "node:fs";
import opentype from "opentype.js";

/**
 * Deterministic text measurement + line wrapping from real font metrics (opentype.js reads
 * the same TTF ffmpeg's drawtext renders with). ffmpeg 6's drawtext applies no shaping or
 * GPOS kerning, so plain advance-width sums match what actually lands on screen to within
 * FreeType's per-glyph pixel rounding — callers keep a small safety margin for that.
 */

interface LoadedFont {
  font: opentype.Font;
  unitsPerEm: number;
  /** OS/2 winAscent + winDescent in font units — what libass treats as the "font size" box. */
  winHeightUnits: number;
}

const fontCache = new Map<string, LoadedFont>();

export function loadFontMetrics(fontPath: string): LoadedFont {
  const cached = fontCache.get(fontPath);
  if (cached) return cached;
  const bytes = readFileSync(fontPath);
  const font = opentype.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const os2 = font.tables.os2 as { usWinAscent?: number; usWinDescent?: number } | undefined;
  const winHeightUnits =
    os2?.usWinAscent != null && os2?.usWinDescent != null
      ? os2.usWinAscent + os2.usWinDescent
      : font.ascender - font.descender;
  const loaded = { font, unitsPerEm: font.unitsPerEm, winHeightUnits };
  fontCache.set(fontPath, loaded);
  return loaded;
}

/** Rendered width in pixels of `text` at drawtext `fontsize` (= pixels per em). */
export function measureTextWidth(text: string, fontPath: string, fontSize: number): number {
  const { font } = loadFontMetrics(fontPath);
  return font.getAdvanceWidth(text, fontSize, { kerning: false });
}

/**
 * Converts an ASS/libass `Fontsize` to the equivalent pixels-per-em: libass scales a font so
 * its winAscent+winDescent box equals Fontsize, which for Inter is ~1.21 em.
 */
export function assFontSizeToEmPixels(assFontSize: number, fontPath: string): number {
  const { unitsPerEm, winHeightUnits } = loadFontMetrics(fontPath);
  return (assFontSize * unitsPerEm) / winHeightUnits;
}

/** Breaks a single word too wide for `maxWidth` into character runs that fit. */
function hardBreakWord(word: string, fontPath: string, fontSize: number, maxWidth: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const ch of Array.from(word)) {
    const candidate = current + ch;
    if (current && measureTextWidth(candidate, fontPath, fontSize) > maxWidth) {
      parts.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Greedy word wrap to `maxWidth` pixels. Never drops text: a single word wider than the line
 * is hard-broken by character rather than allowed to overflow the frame.
 */
export function wrapText(
  text: string,
  fontPath: string,
  fontSize: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureTextWidth(candidate, fontPath, fontSize) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (measureTextWidth(word, fontPath, fontSize) <= maxWidth) {
      current = word;
    } else {
      const pieces = hardBreakWord(word, fontPath, fontSize, maxWidth);
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? "";
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Re-balances a greedy wrap so the last line isn't a lonely orphan word when avoidable. */
function balanceLines(
  lines: string[],
  fontPath: string,
  fontSize: number,
  maxWidth: number,
): string[] {
  if (lines.length < 2) return lines;
  const words = lines.join(" ").split(" ");
  // Binary search the narrowest width that still yields the same line count.
  let lo = 0;
  let hi = maxWidth;
  let best = lines;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const attempt = wrapText(words.join(" "), fontPath, fontSize, mid);
    if (attempt.length <= lines.length && attempt.every((l) => measureTextWidth(l, fontPath, fontSize) <= maxWidth)) {
      best = attempt;
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return best;
}

export interface FittedText {
  lines: string[];
  fontSize: number;
  /** Widest line, measured, in pixels. */
  blockWidth: number;
  lineWidths: number[];
}

/**
 * Picks the largest font size in [minFontSize, maxFontSize] at which `text` wraps into at
 * most `maxLines` lines of at most `maxWidth` px, then balances line lengths. If even
 * `minFontSize` needs more lines, it keeps `minFontSize` and returns however many lines that
 * takes — text is never truncated (losing words silently is worse than an extra line, and
 * the overlay collision/safe-zone checks will surface a block that got too tall).
 */
export function fitText(input: {
  text: string;
  fontPath: string;
  maxWidth: number;
  maxFontSize: number;
  minFontSize: number;
  maxLines: number;
}): FittedText {
  const { text, fontPath, maxWidth, maxLines } = input;
  let fontSize = Math.round(input.maxFontSize);
  const minFontSize = Math.round(Math.min(input.minFontSize, input.maxFontSize));
  let lines = wrapText(text, fontPath, fontSize, maxWidth);
  while (lines.length > maxLines && fontSize > minFontSize) {
    fontSize = Math.max(minFontSize, Math.floor(fontSize * 0.94));
    lines = wrapText(text, fontPath, fontSize, maxWidth);
  }
  lines = balanceLines(lines, fontPath, fontSize, maxWidth);
  const lineWidths = lines.map((l) => measureTextWidth(l, fontPath, fontSize));
  return { lines, fontSize, blockWidth: Math.max(0, ...lineWidths), lineWidths };
}

/** Replaces C0 control characters and DEL with a space. */
export function replaceControlChars(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

/**
 * Normalizes untrusted overlay text for rendering: strips control characters (a raw newline
 * or tab would otherwise become a stray glyph/line in drawtext), collapses whitespace. Every
 * printable character — %, :, quotes, commas, brackets, backslashes — is kept verbatim; the
 * renderer passes text via `textfile=` + `expansion=none`, so nothing needs escaping.
 */
export function normalizeOverlayText(text: string): string {
  return replaceControlChars(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
