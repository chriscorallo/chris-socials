import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fitText, measureTextWidth, wrapText, normalizeOverlayText } from "../text-layout";
import {
  resolveBundledFontPath,
  resolveBundledFontsDir,
  DEFAULT_FONT_PATH,
  BUNDLED_FONT_FILES,
} from "../fonts";
import { getSafeArea, SAFE_ZONE_9X16_REFERENCE } from "../safe-zones";
import { layoutOverlay, OVERLAY_STYLE_PRESETS } from "../overlay-layout";

const FONT = resolveBundledFontPath("DISPLAY_BOLD");

describe("bundled fonts", () => {
  it("ships every weight as a real TTF and exposes a portable default", () => {
    const dir = resolveBundledFontsDir();
    for (const f of Object.values(BUNDLED_FONT_FILES)) expect(existsSync(`${dir}/${f}`)).toBe(true);
    expect(DEFAULT_FONT_PATH).toMatch(/InterDisplay-Bold\.ttf$/);
    expect(existsSync(DEFAULT_FONT_PATH)).toBe(true);
    expect(DEFAULT_FONT_PATH).not.toMatch(/^\/System\//);
  });
});

describe("text measurement + wrapping (real font metrics)", () => {
  it("measures wider text as wider and scales linearly with size", () => {
    const a = measureTextWidth("50%", FONT, 100);
    const b = measureTextWidth("50% more", FONT, 100);
    expect(b).toBeGreaterThan(a);
    expect(measureTextWidth("50%", FONT, 200)).toBeCloseTo(a * 2, 5);
  });

  it("wraps so no line exceeds the width, and never drops a word", () => {
    const text = "Save fifty percent more by paying your card twice a month, every month";
    const lines = wrapText(text, FONT, 70, 600);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measureTextWidth(l, FONT, 70)).toBeLessThanOrEqual(600);
    expect(lines.join(" ")).toBe(text);
  });

  it("hard-breaks a single word wider than the line instead of overflowing", () => {
    const lines = wrapText("Supercalifragilisticexpialidocious", FONT, 120, 400);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measureTextWidth(l, FONT, 120)).toBeLessThanOrEqual(400);
    expect(lines.join("")).toBe("Supercalifragilisticexpialidocious");
  });

  it("auto-shrinks long text toward minFontSize to respect maxLines", () => {
    const short = fitText({ text: "Short hook", fontPath: FONT, maxWidth: 800, maxFontSize: 80, minFontSize: 50, maxLines: 3 });
    expect(short.fontSize).toBe(80);
    const long = fitText({
      text: "A much longer headline that keeps going and going until it simply cannot fit in three lines at the largest size",
      fontPath: FONT,
      maxWidth: 800,
      maxFontSize: 80,
      minFontSize: 50,
      maxLines: 3,
    });
    expect(long.fontSize).toBeLessThan(80);
    expect(long.fontSize).toBeGreaterThanOrEqual(50);
  });

  it("strips control characters but keeps every printable character verbatim", () => {
    expect(normalizeOverlayText("Save 50%:\n\"don't\"\t[x], \\ ok;")).toBe(
      "Save 50%: \"don't\" [x], \\ ok;",
    );
  });
});

describe("safe zones + overlay styles", () => {
  it("exports the 9:16 platform safe-zone constants and scales them", () => {
    expect(SAFE_ZONE_9X16_REFERENCE).toMatchObject({ top: 250, bottom: 420, right: 140 });
    const safe = getSafeArea(1080, 1920);
    expect(safe).toMatchObject({ top: 250, bottom: 1500, right: 940, left: 60 });
    expect(safe.centeredMaxWidth).toBe(800);
    const half = getSafeArea(540, 960);
    expect(half.bottom).toBe(750);
  });

  it("gives each style a distinct treatment", () => {
    const canvas = { width: 1080, height: 1920 };
    const base = { text: "Credit utilisation", startSeconds: 0, endSeconds: 1, position: "CENTER" as const };
    const head = layoutOverlay({ ...base, style: "HEADLINE" }, 0, canvas);
    const num = layoutOverlay({ ...base, text: "50%", style: "NUMBER_CALLOUT" }, 1, canvas);
    const low = layoutOverlay({ ...base, style: "LOWER_THIRD" }, 2, canvas);
    expect(head.plate).not.toBeNull();
    expect(num.plate).toBeNull();
    expect(num.fontSize).toBeGreaterThan(head.fontSize);
    expect(low.accentBar).not.toBeNull();
    expect(low.lines[0]!.x).not.toBe("CENTER");
    expect(OVERLAY_STYLE_PRESETS.CAPTION.weight).toBe("SEMIBOLD");
  });
});
