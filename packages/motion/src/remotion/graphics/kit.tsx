import type { CSSProperties, ReactNode } from "react";
import {
  formatGraphicNumber,
  graphicDesignSize,
  graphicVariant,
  numberPlan,
  type GraphicAnimation,
  type GraphicColor,
  type GraphicFormat,
  type GraphicProps,
  type NumberPlan,
} from "@chris/media/timeline";
import { Easing } from "remotion";
import { EASE_OUT, clamp01, feelEase, prog, springAt } from "../motion";
import { FONT, glassCard, mix, rgba } from "../theme";
import { DEFAULT_FEEL, type MotionFeel, type Palette } from "../../style";
import { elementExitProgress, emphasisFrame, type GraphicSequence } from "../../graphics-timing";
import type { TemplateComponentProps } from "../templates/types";

/**
 * Shared kit for the composable graphics: one context object per graphic (palette, feel,
 * format, animation, timing), colour tokens, number formatting with count-up, the element
 * entrance/exit/emphasis vocabulary, and the header + glass surfaces every component uses.
 *
 * Performance: everything is a pure function of the frame — no state, no effects, no
 * per-frame allocations beyond the element styles; CSS blur is only used where few elements
 * animate (it is the expensive filter in a browser preview).
 */

export interface GCtx {
  props: GraphicProps;
  variant: string;
  p: Palette;
  f: MotionFeel;
  frame: number;
  fps: number;
  D: number;
  enterFrames: number;
  exitFrames: number;
  hit: number | null;
  width: number;
  height: number;
  anim: GraphicAnimation;
  fmt: GraphicFormat;
  ease: (t: number) => number;
}

export function makeCtx(tp: TemplateComponentProps<"GRAPHIC">): GCtx {
  const props = tp.props;
  const size = graphicDesignSize(props);
  const f = tp.feel ?? DEFAULT_FEEL;
  return {
    props,
    variant: graphicVariant(props),
    p: tp.palette,
    f,
    frame: tp.frame,
    fps: tp.fps,
    D: tp.durationInFrames,
    enterFrames: tp.enterFrames,
    exitFrames: tp.exitFrames,
    hit: tp.hitAtFrame ?? null,
    width: size.width,
    height: size.height,
    anim: props.animation,
    fmt: props.format,
    ease: feelEase(f),
  };
}

export const fill: CSSProperties = { position: "absolute", inset: 0 };

// ------------------------------------------------------------------- colours

/** Categorical colours for AUTO series/items — brand accents first, then harmonised mixes. */
export function seriesPalette(p: Palette): string[] {
  // Clear, distinct hues after the brand accents (mixing gold and violet reads as khaki).
  return [p.primary, p.secondary, p.positive, "#60A5FA", "#F472B6", "#2DD4BF", mix(p.primary, "#FFFFFF", 0.45), p.muted];
}

export function colorOf(ctx: GCtx, token: GraphicColor | undefined, index: number): string {
  const p = ctx.p;
  switch (token) {
    case "PRIMARY":
      return p.primary;
    case "SECONDARY":
      return p.secondary;
    case "POSITIVE":
      return p.positive;
    case "NEGATIVE":
      return p.negative;
    case "INK":
      return p.ink;
    case "MUTED":
      return p.muted;
    default: {
      const pal = seriesPalette(p);
      return pal[index % pal.length]!;
    }
  }
}

// ------------------------------------------------------------------- numbers

/** Count-up value at this frame (premium ease: fast start, long soft landing). */
export function counted(ctx: GCtx, start: number, final: number, from = 0, lenMul = 1.8, len = Math.round(0.55 * ctx.fps)): number {
  if (!ctx.anim.countUp) return ctx.frame >= start ? final : from;
  const t = prog(ctx.frame, start, Math.max(1, Math.round(len * lenMul)), Easing.bezier(0.12, 0.8, 0.2, 1));
  return from + (final - from) * t;
}

/** Formatted value; the unit/decimals are planned from the FINAL value so a count-up never
 * switches format mid-count. */
export function fmtValue(ctx: GCtx, shown: number, final: number = shown, shared?: NumberPlan | null): { text: string; negative: boolean } {
  let plan = shared ?? numberPlan(final, ctx.fmt);
  if (shared && shared.decimals > 0) {
    // Shared unit, own digits: "$4k" next to "$4.5k" (never "$4.0k").
    const x = Math.abs(final) / shared.divisor;
    let d = 0;
    while (d < shared.decimals && Math.abs(Math.round(x * 10 ** d) - x * 10 ** d) > 1e-6) d++;
    plan = { ...shared, decimals: d };
  }
  const r = formatGraphicNumber(shown, ctx.fmt, plan);
  // Integer finals count in integers of their unit ("1k 2k 3k 4k"), never "2.7k".
  return { text: r.text, negative: final < 0 ? true : r.negative };
}

/**
 * One format for a set of values shown together (a column, a month grid): never "$2,750" next
 * to "$2.8k". Small values in the set keep everything in full digits; otherwise the largest
 * value's unit with at most one decimal (an honest rounding).
 */
export function sharedPlan(ctx: GCtx, values: number[]): NumberPlan | null {
  const nz = values.filter((v) => v !== 0 && Number.isFinite(v));
  if (!nz.length || ctx.fmt.decimals !== null || ctx.fmt.compact !== "AUTO" || ctx.fmt.kind === "PERCENT") return null;
  const max = Math.max(...nz.map(Math.abs));
  const base = numberPlan(max, ctx.fmt);
  const need = (x: number, d: number) => {
    for (let k = 0; k <= d; k++) if (Math.abs(Math.round(x * 10 ** k) - x * 10 ** k) < 1e-6) return k;
    return d;
  };
  if (base.divisor > 1 && nz.some((v) => Math.abs(v) < base.divisor) && max < 1e5) {
    return { divisor: 1, unit: "", decimals: Math.max(...nz.map((v) => need(Math.abs(v), 2))) };
  }
  if (base.divisor === 1) return { ...base, decimals: Math.max(...nz.map((v) => need(Math.abs(v), 2))) };
  return { ...base, decimals: Math.max(...nz.map((v) => Math.min(1, need(Math.abs(v) / base.divisor, 2)))) };
}

export function valueColor(ctx: GCtx, value: number, base: string): string {
  return value < 0 && ctx.fmt.negativeRed ? ctx.p.negative : base;
}

/** Font size that fits `text` into `width` px given a base size (Inter Display ~0.6 em/char). */
export function fitSize(text: string, width: number, base: number, min = 30, perChar = 0.6): number {
  const need = Math.max(1, text.length) * perChar * base;
  return Math.max(min, Math.min(base, Math.floor((base * width) / need)));
}

// ------------------------------------------------------------------- element animation

export interface ElStyle {
  opacity: number;
  transform: string;
  filter?: string;
  clipPath?: string;
}

/**
 * The element entrance vocabulary (`animation.enter`), shaped by the motion language: travel
 * × feel.distance, overshoot from the feel's springs, blur × feel.blur. `blurOK` = few
 * elements animate (blur is costly in the browser preview).
 */
export function enterStyle(ctx: GCtx, start: number, len: number, opts: { style?: GraphicAnimation["enter"]; blurOK?: boolean; distance?: number } = {}): ElStyle {
  const { frame, fps, f } = ctx;
  const style = opts.style ?? ctx.anim.enter;
  const D = (opts.distance ?? 1) * f.distance;
  const t = prog(frame, start, len, ctx.ease);
  const o = prog(frame, start, Math.max(2, Math.round(len * 0.6)), EASE_OUT);
  switch (style) {
    case "POP": {
      const s = springAt(frame, fps, start, f.springs.soft, Math.round(len * 1.8));
      const k = Math.max(0, s);
      return { opacity: clamp01(o * 1.2), transform: `scale(${r4(0.55 + 0.45 * Math.min(k, 1.12))})` };
    }
    case "FADE":
      return { opacity: o, transform: "none" };
    case "SLIDE":
      return { opacity: o, transform: `translateX(${r1((1 - t) * -46 * D)}px)` };
    case "WIPE":
      return { opacity: clamp01(o * 2), transform: "none", clipPath: `inset(0 ${r1((1 - t) * 100)}% 0 0)` };
    case "DROP": {
      const s = springAt(frame, fps, start, f.springs.settle, Math.round(len * 1.6));
      return { opacity: o, transform: `translateY(${r1((1 - Math.min(1, s)) * -42 * D)}px)` };
    }
    case "FLIP":
      return { opacity: o, transform: `perspective(900px) rotateX(${r1((1 - t) * -78)}deg)` };
    case "BLUR": {
      const b = (1 - t) * 14 * Math.max(0.6, f.blur);
      return { opacity: o, transform: `scale(${r4(1.06 - 0.06 * t)})`, filter: opts.blurOK !== false && b > 0.1 ? `blur(${r1(b)}px)` : undefined };
    }
    case "RISE":
    default:
      return { opacity: o, transform: `translateY(${r1((1 - t) * 28 * D)}px)` };
  }
}

/** Element exit (REVERSE / DROP / FADE_UP) folded into an element's style. */
export function withExit(ctx: GCtx, s: ElStyle, flatIndex: number, count: number): ElStyle {
  const x = elementExitProgress(ctx.anim.exit, ctx.frame, flatIndex, count, { fps: ctx.fps, durationInFrames: ctx.D });
  if (x <= 0) return s;
  const dy = ctx.anim.exit === "DROP" ? x * 60 : ctx.anim.exit === "FADE_UP" ? -x * 40 : x * 18;
  return { ...s, opacity: s.opacity * (1 - x), transform: `${s.transform === "none" ? "" : s.transform} translateY(${r1(dy)}px)`.trim() };
}

/** Entrance + exit for element (g, i) of a sequence. */
export function seqStyle(ctx: GCtx, seq: GraphicSequence, g: number, i: number, opts: { style?: GraphicAnimation["enter"]; distance?: number } = {}): ElStyle {
  const blurOK = seq.count <= 12;
  return withExit(ctx, enterStyle(ctx, seq.at(g, i), seq.len, { ...opts, blurOK }), seq.flat(g, i), seq.count);
}

export function css(s: ElStyle): CSSProperties {
  return { opacity: s.opacity, transform: s.transform === "none" ? undefined : s.transform, filter: s.filter, clipPath: s.clipPath, willChange: "transform, opacity" };
}

export interface Emphasis {
  /** 0..1 how "on" the emphasis is (holds once on). */
  on: number;
  scale: number;
  ring: number;
  shakeX: number;
}

/** What the highlighted element does once revealed (on the speaker's emphasis when given). */
export function emphasisAt(ctx: GCtx, revealedAt: number): Emphasis {
  const e = emphasisFrame(revealedAt, ctx.hit);
  const kind = ctx.anim.emphasis;
  const on = kind === "NONE" ? 0 : prog(ctx.frame, e, Math.round(0.35 * ctx.fps), ctx.ease);
  const age = ctx.frame - e;
  let scale = 1;
  let ring = 0;
  let shakeX = 0;
  if (age >= 0) {
    if (kind === "PULSE" || kind === "GLOW") {
      const s = springAt(ctx.frame, ctx.fps, e, ctx.f.springs.punch, Math.round(0.6 * ctx.fps));
      scale = 1 + (kind === "PULSE" ? 0.1 : 0.04) * Math.max(0, Math.sin(Math.min(1, s) * Math.PI)) * ctx.f.hitScale;
    }
    if (kind === "RING") ring = clamp01(age / Math.round(0.8 * ctx.fps));
    if (kind === "SHAKE") shakeX = Math.sin(age * 1.9) * 9 * Math.max(0, 1 - age / Math.round(0.5 * ctx.fps));
  }
  return { on, scale, ring, shakeX };
}

/** Dim factor for non-highlighted elements once the emphasis is on (focus). */
export function dimFor(isHighlight: boolean, hasHighlight: boolean, em: Emphasis): number {
  if (!hasHighlight || isHighlight) return 1;
  return 1 - 0.42 * em.on;
}

// ------------------------------------------------------------------- surfaces + header

export function headHeight(props: Pick<GraphicProps, "title" | "subtitle">): number {
  return props.title ? (props.subtitle ? 150 : 104) : 0;
}

export function Header({ ctx, align = "left", padX = 0 }: { ctx: GCtx; align?: "left" | "center"; padX?: number }) {
  const { props, p, frame } = ctx;
  if (!props.title) return null;
  const t = prog(frame, 0, Math.round(0.5 * ctx.fps), ctx.ease);
  const s = prog(frame, 4, Math.round(0.5 * ctx.fps), ctx.ease);
  const size = fitSize(props.title, ctx.width - 2 * padX - 40, 52, 38, 0.56);
  return (
    <div style={{ height: headHeight(props), padding: `0 ${padX}px`, display: "flex", flexDirection: "column", justifyContent: "flex-start", textAlign: align, alignItems: align === "center" ? "center" : "flex-start" }}>
      <div style={{ fontFamily: FONT.displayBold, fontSize: size, lineHeight: 1.08, color: p.ink, letterSpacing: "-0.018em", opacity: t, transform: `translateY(${r1((1 - t) * 14)}px)`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{props.title}</div>
      {props.subtitle ? (
        <div style={{ marginTop: 8, fontFamily: FONT.text, fontSize: 34, lineHeight: 1.2, color: p.muted, opacity: s, transform: `translateY(${r1((1 - s) * 10)}px)`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{props.subtitle}</div>
      ) : null}
    </div>
  );
}

/** The glass card filling the component's design box. */
export function Panel({ ctx, children, pad = 44, radius = 44, style }: { ctx: GCtx; children: ReactNode; pad?: number; radius?: number; style?: CSSProperties }) {
  return (
    <div style={{ position: "absolute", inset: 0, boxSizing: "border-box", padding: pad, display: "flex", flexDirection: "column", ...glassCard(ctx.p, radius), ...style }}>
      {children}
    </div>
  );
}

/** A soft inner tile (cells, cards inside a panel). */
export function tile(ctx: GCtx, accent: string | null, radius = 22, strength = 1): CSSProperties {
  return {
    borderRadius: radius,
    background: accent
      ? `linear-gradient(160deg, ${rgba(accent, 0.2 * strength)} 0%, ${rgba(accent, 0.07 * strength)} 100%)`
      : `linear-gradient(160deg, ${rgba("#FFFFFF", 0.085)} 0%, ${rgba("#FFFFFF", 0.035)} 100%)`,
    boxShadow: accent
      ? `inset 0 0 0 1.5px ${rgba(accent, 0.38 * strength)}, inset 0 1.5px 0 ${rgba("#FFFFFF", 0.12)}`
      : `inset 0 0 0 1.5px ${rgba("#FFFFFF", 0.07)}, inset 0 1.5px 0 ${rgba("#FFFFFF", 0.09)}`,
  };
}

export function glowShadow(color: string, on: number, strength = 1): string | undefined {
  if (on <= 0.01) return undefined;
  return `0 0 ${r1(22 * strength * on)}px ${rgba(color, 0.5 * on)}, 0 0 ${r1(64 * strength * on)}px ${rgba(color, 0.26 * on)}`;
}

export function r1(n: number): number {
  return Math.round(n * 10) / 10;
}
export function r4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export { FONT, rgba, mix, prog, springAt, clamp01, EASE_OUT };
