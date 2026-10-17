import type { CSSProperties } from "react";
import { MOTION_PALETTES, type TimelineVisual } from "@chris/media/timeline";

export type PaletteName = TimelineVisual["palette"];
export type Palette = (typeof MOTION_PALETTES)[PaletteName];

export function paletteFor(name: PaletteName | undefined): Palette {
  return MOTION_PALETTES[name ?? "BRAND"] ?? MOTION_PALETTES.BRAND;
}

/** #RRGGBB(AA) -> rgba() with an alpha multiplier. */
export function rgba(hex: string, alpha = 1): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return `rgba(${r},${g},${b},${Math.round(a * alpha * 1000) / 1000})`;
}

/** Mix two #RRGGBB colors (t = 0 -> a, 1 -> b). */
export function mix(a: string, b: string, t: number): string {
  const pa = a.replace("#", "");
  const pb = b.replace("#", "");
  const c = (i: number) =>
    Math.round(parseInt(pa.slice(i, i + 2), 16) * (1 - t) + parseInt(pb.slice(i, i + 2), 16) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${c(0)}${c(2)}${c(4)}`;
}

/**
 * Typography. Every face is a registered, OFL font from packages/media/assets/fonts (the same
 * files the ffmpeg renderer and the editor preview use). Families get motion-private names so
 * they never collide with the editor's own @font-face rules.
 */
export const MOTION_FONTS = {
  display: { family: "ChrisMotion Display", file: "InterDisplay-ExtraBold.ttf", weight: 800 },
  displayBold: { family: "ChrisMotion DisplayBold", file: "InterDisplay-Bold.ttf", weight: 700 },
  text: { family: "ChrisMotion Text", file: "Inter-SemiBold.ttf", weight: 600 },
  serif: { family: "ChrisMotion Serif", file: "DMSerifDisplay-Regular.ttf", weight: 400 },
} as const;

export const FONT = {
  display: `"${MOTION_FONTS.display.family}", "Inter", system-ui, sans-serif`,
  displayBold: `"${MOTION_FONTS.displayBold.family}", "Inter", system-ui, sans-serif`,
  text: `"${MOTION_FONTS.text.family}", "Inter", system-ui, sans-serif`,
  serif: `"${MOTION_FONTS.serif.family}", Georgia, serif`,
};

/** Shared surface styles: deep glass card with top light, hairline border and soft depth. */
export function glassCard(p: Palette, radius = 44): CSSProperties {
  return {
    borderRadius: radius,
    background: `linear-gradient(160deg, ${rgba("#2A2A3A", 0.86)} 0%, ${rgba("#12121A", 0.9)} 55%, ${rgba("#0B0B10", 0.92)} 100%)`,
    boxShadow: [
      `0 40px 90px ${rgba("#000000", 0.45)}`,
      `0 12px 28px ${rgba("#000000", 0.35)}`,
      `inset 0 1.5px 0 ${rgba("#FFFFFF", 0.16)}`,
      `inset 0 0 0 1.5px ${rgba("#FFFFFF", 0.07)}`,
      `inset 0 -40px 80px ${rgba(p.secondary, 0.06)}`,
    ].join(", "),
  };
}

/** Soft dark lift behind bare text so it reads over bright footage too. */
export const TEXT_LIFT = `0 2px 4px ${rgba("#000000", 0.35)}, 0 8px 30px ${rgba("#000000", 0.55)}`;

export function glow(color: string, strength = 1): string {
  return `0 0 ${18 * strength}px ${rgba(color, 0.55)}, 0 0 ${60 * strength}px ${rgba(color, 0.3)}`;
}

export function formatNumber(v: number, decimals = 0): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Compact money/number for chart labels: 1250 -> 1.3k, 2_400_000 -> 2.4M. */
export function compactNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${trim(v / 1e9)}B`;
  if (a >= 1e6) return `${trim(v / 1e6)}M`;
  if (a >= 1e4) return `${trim(v / 1e3)}k`;
  return formatNumber(v, Number.isInteger(v) ? 0 : 1);
}
function trim(x: number): string {
  return (Math.round(x * 10) / 10).toString();
}

/** Prefix-unit values ("$") go before the number, others after ("%", "x"). */
export function withUnit(text: string, unit: string): string {
  if (!unit) return text;
  return /^[$€£¥₹]$/.test(unit) ? `${unit}${text}` : `${text}${unit}`;
}
