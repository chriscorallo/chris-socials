import type { CSSProperties, ReactNode } from "react";
import { graphicTone, type GraphicIcon } from "@chris/media/timeline";
import { GIcon } from "./icons";
import { FONT, counted, mix, prog, r1, rgba, type GCtx } from "./kit";
import { luminance } from "./text";

/**
 * Shared UI kit for library 2 (platform-style posts, phone/OS, web, news, life, hooks, FX).
 *
 * Brand-safe by construction: these are GENERIC interface pieces — initials avatars, original
 * line glyphs on tinted app tiles, Inter type, palette-driven accents. Never a real platform's
 * logo, wordmark, verification badge, system font or signature colour.
 *
 * Performance (editor preview): pure functions of the frame, no state/effects, no blur filters
 * on many elements, no per-frame allocation beyond styles.
 */

// ------------------------------------------------------------------- tone (light / dark)

export interface Tone {
  dark: boolean;
  /** Card surface (solid-ish; use `card()` for the full surface style). */
  surface: string;
  /** Inner fills: inputs, rows, chips. */
  fill: string;
  fill2: string;
  ink: string;
  muted: string;
  faint: string;
  line: string;
  /** Palette primary, contrast-safe on the surface (text/icons). */
  accent: string;
  /** A solid accent for buttons/bubbles, and the text colour on it. */
  solid: string;
  onSolid: string;
  /** Second accent (palette secondary), contrast-safe. */
  accent2: string;
  positive: string;
  negative: string;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Darken (light bg) or lighten (dark bg) `c` until it reads on `bg` at ≥ `min`:1. */
export function readableOn(c: string, bg: string, min = 3): string {
  const towards = luminance(bg) > 0.4 ? "#000000" : "#FFFFFF";
  let out = c;
  for (let t = 0.08; t <= 0.9 && contrast(out, bg) < min; t += 0.08) out = mix(c, towards, t);
  return out;
}

export function toneOf(ctx: GCtx): Tone {
  const dark = graphicTone(ctx.props) === "DARK";
  const p = ctx.p;
  if (dark) {
    const surface = "#15151C";
    const solid = p.primary;
    return {
      dark,
      surface,
      fill: rgba("#FFFFFF", 0.07),
      fill2: rgba("#FFFFFF", 0.12),
      ink: "#FFFFFF",
      muted: mix("#FFFFFF", "#15151C", 0.38),
      faint: mix("#FFFFFF", "#15151C", 0.62),
      line: rgba("#FFFFFF", 0.1),
      accent: readableOn(p.primary, surface, 4.5),
      solid,
      onSolid: luminance(solid) > 0.4 ? "#0C0B10" : "#FFFFFF",
      accent2: readableOn(p.secondary, surface, 4.5),
      positive: readableOn(p.positive, surface, 4.5),
      negative: readableOn(p.negative, surface, 4.5),
    };
  }
  const surface = "#FFFFFF";
  const solid = readableOn(p.secondary === "#D4D4D8" ? "#2A2A33" : mix(p.secondary, "#3A2A8C", 0.35), surface, 4.6);
  return {
    dark,
    surface,
    fill: "#F2F2F5",
    fill2: "#E7E7EC",
    ink: "#111116",
    muted: "#6B6B76",
    faint: "#A2A2AD",
    line: "rgba(17,17,22,0.09)",
    accent: readableOn(p.primary, surface, 3.2),
    solid,
    onSolid: "#FFFFFF",
    accent2: readableOn(p.secondary, surface, 4),
    positive: readableOn(p.positive, surface, 3.2),
    negative: readableOn(p.negative, surface, 3.6),
  };
}

/** The main card surface for a tone (dark = the house glass card; light = frosted white). */
export function card(t: Tone, radius = 44): CSSProperties {
  if (t.dark) {
    return {
      borderRadius: radius,
      background: `linear-gradient(160deg, ${rgba("#2A2A3A", 0.9)} 0%, ${rgba("#14141C", 0.94)} 55%, ${rgba("#0D0D12", 0.95)} 100%)`,
      boxShadow: `0 40px 90px ${rgba("#000000", 0.45)}, 0 12px 28px ${rgba("#000000", 0.35)}, inset 0 1.5px 0 ${rgba("#FFFFFF", 0.14)}, inset 0 0 0 1.5px ${rgba("#FFFFFF", 0.07)}`,
    };
  }
  return {
    borderRadius: radius,
    background: `linear-gradient(170deg, ${rgba("#FFFFFF", 0.98)} 0%, ${rgba("#F7F7FA", 0.97)} 100%)`,
    boxShadow: `0 36px 80px ${rgba("#000000", 0.32)}, 0 10px 24px ${rgba("#000000", 0.18)}, inset 0 0 0 1.5px ${rgba("#FFFFFF", 0.7)}`,
  };
}

/** A hairline divider. */
export function hairline(t: Tone): CSSProperties {
  return { height: 1.5, background: t.line };
}

// ------------------------------------------------------------------- people + apps

/** Deterministic hue for a name (avatars, app tiles without a colour). */
export function nameHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function hsl(h: number, s: number, l: number): string {
  // → hex (so mix()/rgba() keep working)
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Two pleasant colours for a name (gradient avatars / placeholder images). */
export function namePair(name: string): [string, string] {
  const h = nameHue(name || "?");
  return [hsl(h, 62, 62), hsl((h + 38) % 360, 58, 46)];
}

export function initials(name: string | null | undefined): string {
  const w = (name ?? "").replace(/^[@#]/, "").split(/\s+/).filter(Boolean);
  if (!w.length) return "?";
  return ((w[0]![0] ?? "") + (w.length > 1 ? (w[w.length - 1]![0] ?? "") : "")).toUpperCase();
}

/** An initials avatar on a soft gradient (placeholder people — never a real photo). */
export function Avatar({ name, size, ring, style }: { name: string | null | undefined; size: number; ring?: string; style?: CSSProperties }) {
  const [a, b] = namePair(name ?? "");
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        flex: "none",
        background: `linear-gradient(145deg, ${a} 0%, ${b} 100%)`,
        boxShadow: ring ? `0 0 0 ${Math.max(2, size * 0.05)}px ${ring}` : `inset 0 1.5px 0 ${rgba("#FFFFFF", 0.35)}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: FONT.displayBold,
        fontSize: Math.round(size * 0.4),
        letterSpacing: "-0.02em",
        color: "#FFFFFF",
        ...style,
      }}
    >
      {initials(name)}
    </div>
  );
}

/** A generic app tile: rounded square, tinted gradient, original line glyph. */
export function AppTile({ icon, size, color, style }: { icon: GraphicIcon | null; size: number; color: string; style?: CSSProperties }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.24,
        flex: "none",
        background: `linear-gradient(160deg, ${mix(color, "#FFFFFF", 0.22)} 0%, ${color} 55%, ${mix(color, "#000000", 0.22)} 100%)`,
        boxShadow: `inset 0 1.5px 0 ${rgba("#FFFFFF", 0.35)}, 0 ${r1(size * 0.08)}px ${r1(size * 0.2)}px ${rgba("#000000", 0.22)}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
    >
      {icon ? <GIcon icon={icon} size={Math.round(size * 0.56)} color="#FFFFFF" stroke={2.1} /> : null}
    </div>
  );
}

/** Tile colours for apps without an explicit colour token (calm, not any brand's). */
export const APP_TINTS = ["#5B8CFF", "#34C38F", "#FF8A4C", "#A779FF", "#FF5C7A", "#22B8CF", "#F5B83D", "#7C8798"];

// ------------------------------------------------------------------- numbers + text motion

/** Social-style compact count: 987 · 1,234 · 12.4K · 1.2M · 3B. */
export function socialCount(n: number, plan?: number): string {
  const a = Math.abs(n);
  const ref = Math.abs(plan ?? n);
  const sign = n < 0 ? "−" : "";
  const fmt = (x: number, d: number) => {
    const s = x.toFixed(d);
    return d > 0 ? s.replace(/\.0+$/, "") : s;
  };
  if (ref >= 1e9) return `${sign}${fmt(a / 1e9, a / 1e9 >= 100 ? 0 : 1)}B`;
  if (ref >= 1e6) return `${sign}${fmt(a / 1e6, a / 1e6 >= 100 ? 0 : 1)}M`;
  if (ref >= 1e4) return `${sign}${fmt(a / 1e3, a / 1e3 >= 100 ? 0 : 1)}K`;
  return `${sign}${Math.round(a).toLocaleString("en-US")}`;
}

/** A count that ticks up to `final` from `start` (the format is planned from the final value). */
export function socialCountAt(ctx: GCtx, start: number, final: number, from = 0, lenMul = 2.2): string {
  return socialCount(counted(ctx, start, final, from, lenMul), final);
}

/** Typewriter: how many characters of `text` are shown at this frame (cps = chars/second). */
export function typedChars(ctx: GCtx, text: string, start: number, cps = 18): number {
  if (ctx.frame < start) return 0;
  return Math.min(text.length, Math.floor(((ctx.frame - start) / ctx.fps) * cps * ctx.anim.speed));
}

/** Frames a typewriter of `text` takes. */
export function typeFrames(ctx: GCtx, text: string, cps = 18): number {
  return Math.ceil((text.length / (cps * ctx.anim.speed)) * ctx.fps);
}

/** A blinking caret (visible while typing, then blinks). */
export function Caret({ ctx, color, height, on = true }: { ctx: GCtx; color: string; height: number; on?: boolean }) {
  if (!on) return null;
  const blink = Math.floor(ctx.frame / Math.round(ctx.fps * 0.5)) % 2 === 0;
  return <span style={{ display: "inline-block", width: Math.max(3, height * 0.08), height, marginLeft: 3, verticalAlign: "-0.12em", borderRadius: 2, background: color, opacity: blink ? 1 : 0 }} />;
}

/** Three bouncing dots (typing indicator). */
export function TypingDots({ ctx, color, size = 16, gap = 10 }: { ctx: GCtx; color: string; size?: number; gap?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap }}>
      {[0, 1, 2].map((k) => {
        const ph = (ctx.frame / ctx.fps) * Math.PI * 2 * 1.5 - k * 0.9;
        const up = Math.max(0, Math.sin(ph));
        return <div key={k} style={{ width: size, height: size, borderRadius: size / 2, background: color, opacity: 0.4 + 0.6 * up, transform: `translateY(${r1(-up * size * 0.4)}px)` }} />;
      })}
    </div>
  );
}

/** A soft press (0..1..0 dip) at `at` frames — for buttons getting "tapped". */
export function pressAt(ctx: GCtx, at: number, len = 6): number {
  const a = ctx.frame - at;
  if (a < 0 || a > len) return 0;
  return Math.sin((a / len) * Math.PI);
}

/** A tap ripple (0 → 1 over ~0.45 s from `at`), or null when not running. */
export function rippleAt(ctx: GCtx, at: number): number | null {
  const a = ctx.frame - at;
  const len = Math.round(0.45 * ctx.fps);
  if (a < 0 || a > len) return null;
  return a / len;
}

/** Element-entrance helper for library-2 components: 0..1 eased progress from `start`. */
export function inAt(ctx: GCtx, start: number, len = Math.round(0.45 * ctx.fps)): number {
  return prog(ctx.frame, start, len, ctx.ease);
}

/** Row of content laid out with flex (tiny helper to keep JSX short). */
export function Row({ children, gap = 16, align = "center", style }: { children: ReactNode; gap?: number; align?: CSSProperties["alignItems"]; style?: CSSProperties }) {
  return <div style={{ display: "flex", flexDirection: "row", alignItems: align, gap, ...style }}>{children}</div>;
}

/** Single-line text that never overflows its box (ellipsis). */
export const oneLine: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 };
