/**
 * Teleprompter scroll timing (pure). Scrolling is modeled as PROGRESS through the text
 * (0 = first line on the reading line, 1 = last line has passed it), advanced at a speaking
 * rate in words per minute. Tying speed to words — not pixels — keeps the pace identical when
 * Chris changes the text size, rotates, or switches between the in-app prompter and the
 * floating (Picture-in-Picture) one.
 */

/** Speed levels shown as "Speed 1…10"; 5 ≈ a natural on-camera pace. */
export const SPEED_MIN = 1;
export const SPEED_MAX = 10;
export const SPEED_DEFAULT = 5;

/** Words per minute for a speed level: 1 → 90 wpm … 10 → 225 wpm, 15 wpm per step. */
export function speedToWpm(level: number): number {
  const l = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(level)));
  return 90 + (l - 1) * 15;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Progress per second at a speaking rate (fraction of the whole text). */
export function progressPerSecond(words: number, wpm: number): number {
  if (words <= 0 || wpm <= 0) return 0;
  return wpm / 60 / words;
}

/** Advance progress by `dtMs`, clamped to [0, 1]. Large gaps (tab hidden, debugger) are capped
 * at 250 ms so the text never jumps a paragraph when the page wakes up. */
export function advanceProgress(progress: number, dtMs: number, perSecond: number): number {
  const dt = Math.min(Math.max(dtMs, 0), 250) / 1000;
  return Math.min(1, Math.max(0, progress + dt * perSecond));
}

/** Seconds to read the whole text at a speed. */
export function estimateSeconds(words: number, wpm: number): number {
  if (words <= 0 || wpm <= 0) return 0;
  return Math.round((words / wpm) * 60);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Vertical offset (px) for the text block: at progress 0 its top sits on the reading line; at 1
 * its bottom does. `contentHeight` is the rendered text height.
 */
export function scrollOffset(progress: number, contentHeight: number, readingLine: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return readingLine - p * Math.max(0, contentHeight);
}

/** Inverse of scrollOffset for drag-to-scrub: a finger moving `dyPx` (down = back) changes
 * progress by -dy / contentHeight. */
export function progressAfterDrag(progress: number, dyPx: number, contentHeight: number): number {
  if (contentHeight <= 0) return progress;
  return Math.min(1, Math.max(0, progress - dyPx / contentHeight));
}

/** Text size steps (CSS px for the in-app prompter). */
export const FONT_SIZES = [24, 28, 32, 36, 42, 48, 56] as const;
export const FONT_DEFAULT_INDEX = 3;

/**
 * Greedy word wrap for the canvas renderer (Picture-in-Picture). `measure` returns a string's
 * width; paragraphs (blank-line separated or single newlines) always start a new line; a blank
 * line is kept between paragraphs. A single word wider than the line is kept on its own line.
 */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  paragraphs.forEach((para, pi) => {
    if (pi > 0) out.push("");
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  });
  return out;
}
