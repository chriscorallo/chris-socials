import { useId, type ComponentType, type CSSProperties } from "react";
import { donutShares, graphicRange, runningTotals, type GraphicComponent } from "@chris/media/timeline";
import { graphicSequence, listSequence } from "../../graphics-timing";
import { EASE_IN_OUT } from "../motion";
import { heroGradient } from "../templates/text";
import { GIcon } from "./icons";
import {
  FONT,
  Header,
  Panel,
  clamp01,
  colorOf,
  counted,
  css,
  dimFor,
  emphasisAt,
  enterStyle,
  fitSize,
  fmtValue,
  glowShadow,
  headHeight,
  mix,
  prog,
  r1,
  rgba,
  seqStyle,
  springAt,
  valueColor,
  withExit,
  type GCtx,
} from "./kit";

/**
 * Chart base components: BAR_GROUP, LINE_AREA, WATERFALL, DONUT, PROGRESS, GAUGE, SCATTER.
 *
 * Same conventions as money.tsx: each draws inside its graphicDesignSize box (a glass Panel
 * with the Header on top), everything is a pure function of the frame, elements are timed by
 * the shared sequencers (animation.order / stagger / speed), numbers count up in their final
 * format, and the highlight gets the emphasis while the rest dims.
 *
 * Value labels are laid out with a small collision pass (`layoutLabels`): a label that would
 * hit a neighbour or another bar shrinks (never below 36 px) and, if it still can't fit,
 * gives way to a more important one (the highlight / bigger value) — a dense chart shows
 * fewer numbers rather than overlapping ones.
 */

const PAD = 40;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

function sid(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "");
}

function seqOpts(ctx: GCtx) {
  return { fps: ctx.fps, durationInFrames: ctx.D, exitFrames: ctx.exitFrames, tempo: ctx.f.tempo };
}

/** Estimated rendered width of a single-line string (Inter Display ≈ 0.6 em/char). */
function estW(text: string, size: number, perChar = 0.6): number {
  return Math.max(1, text.length) * perChar * size;
}

function finiteOr(n: number, d: number): number {
  return Number.isFinite(n) ? n : d;
}

function maxOf(xs: number[], d = 0): number {
  return xs.length ? xs.reduce((a, b) => (b > a ? b : a), -Infinity) : d;
}
function minOf(xs: number[], d = 0): number {
  return xs.length ? xs.reduce((a, b) => (b < a ? b : a), Infinity) : d;
}

/** Bar growth 0..~1.05 on the motion feel's grow spring, paced by the sequence length. */
function growAt(ctx: GCtx, start: number, len: number): number {
  const s = springAt(ctx.frame, ctx.fps, start, ctx.f.springs.grow, Math.max(6, Math.round(len * 1.9)));
  return Math.max(0, Math.min(1.05, s));
}

/** Exit-only element style (for geometry that animates its own entrance). */
function exitCss(ctx: GCtx, flat: number, count: number): CSSProperties {
  const s = withExit(ctx, { opacity: 1, transform: "none" }, flat, count);
  return { opacity: s.opacity, transform: s.transform === "none" ? undefined : s.transform };
}

/** A percent-format context (shares of a whole), counting like any other value. */
function pctCtx(ctx: GCtx): GCtx {
  return { ...ctx, fmt: { ...ctx.fmt, kind: "PERCENT", prefix: "", suffix: "", signs: "NEGATIVE", compact: "NONE", decimals: null, negativeRed: false } };
}

// ------------------------------------------------------------------- label collision pass

interface LabelIn {
  cx: number;
  /** vertical centre at the base size */
  cy: number;
  text: string;
  /** higher wins a conflict */
  pri: number;
  /** width it may use when squeezed next to an obstacle (its own slot) */
  slotW: number;
  /** index of the obstacle the label belongs to (its own bar) */
  own?: number;
}
interface LabelOut {
  size: number;
  show: boolean;
  cx: number;
}
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;
}

function layoutLabels(ls: LabelIn[], bounds: { left: number; right: number }, obstacles: Rect[], base: number, min: number, uniform = true): LabelOut[] {
  const PC = 0.56;
  const out: LabelOut[] = ls.map((l) => ({ size: base, show: true, cx: l.cx }));
  const rect = (i: number): Rect => {
    const w = estW(ls[i]!.text, out[i]!.size, PC);
    const h = out[i]!.size * 1.1;
    return { x0: out[i]!.cx - w / 2, x1: out[i]!.cx + w / 2, y0: ls[i]!.cy - h / 2, y1: ls[i]!.cy + h / 2 };
  };
  const clampX = (i: number) => {
    const half = estW(ls[i]!.text, out[i]!.size, PC) / 2;
    out[i]!.cx = Math.min(bounds.right - half, Math.max(bounds.left + half, out[i]!.cx));
  };
  const hits = (i: number, gap: number) => obstacles.some((o, k) => k !== ls[i]!.own && overlaps(rect(i), o, gap));
  // 1) a label that would sit over a neighbouring bar first nudges sideways (a little off
  //    centre reads fine), then squeezes into its own slot, else gives way.
  ls.forEach((l, i) => {
    clampX(i);
    if (!hits(i, 2)) return;
    for (const dx of [4, -4, 8, -8, 12, -12, 16, -16, 22, -22, 28, -28]) {
      out[i]!.cx = l.cx + dx;
      clampX(i);
      if (!hits(i, 2)) return;
    }
    out[i]!.cx = l.cx;
    const s = Math.floor((l.slotW - 6) / (Math.max(1, l.text.length) * PC));
    if (s >= min) out[i]!.size = Math.min(out[i]!.size, s);
    else out[i]!.show = false;
    clampX(i);
    if (out[i]!.show && hits(i, 0)) out[i]!.show = false;
  });
  // 2) label vs label: shrink both to clear, else the less important one gives way.
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (let i = 0; i < ls.length; i++) {
      for (let j = i + 1; j < ls.length; j++) {
        if (!out[i]!.show || !out[j]!.show) continue;
        if (!overlaps(rect(i), rect(j), 8)) continue;
        const d = Math.abs(out[i]!.cx - out[j]!.cx) - 12;
        const s = Math.floor((2 * d) / ((Math.max(1, ls[i]!.text.length) + Math.max(1, ls[j]!.text.length)) * PC));
        if (s >= min && s < Math.min(out[i]!.size, out[j]!.size)) {
          out[i]!.size = s;
          out[j]!.size = s;
        } else {
          const lo = ls[i]!.pri >= ls[j]!.pri ? j : i;
          out[lo]!.show = false;
        }
        clampX(i);
        clampX(j);
        changed = true;
      }
    }
    if (!changed) break;
  }
  if (uniform) {
    const s = minOf(out.filter((o) => o.show).map((o) => o.size), base);
    out.forEach((o, i) => {
      o.size = s;
      clampX(i);
    });
  }
  return out;
}

/** Category labels along an axis: one shared size; if even the minimum can't fit every slot, a
 * sparse subset (every k-th, always the last). */
function axisLabels(cats: string[], slotW: number, base = 34, min = 28): { size: number; every: number } {
  const PC = 0.56;
  const longest = cats.reduce((a, c) => Math.max(a, c.length), 1);
  const size = Math.max(min, Math.min(base, Math.floor((slotW * 1.2 - 12) / (longest * PC))));
  const w = cats.map((c) => estW(c, size, PC));
  for (let k = 1; k < Math.max(2, cats.length); k++) {
    let ok = true;
    for (let i = 0; i + k < cats.length && ok; i++) if (cats[i] && cats[i + k] && (w[i]! + w[i + k]!) / 2 + 14 > k * slotW) ok = false;
    if (ok) return { size, every: k };
  }
  return { size, every: Math.max(1, cats.length) };
}

function Legend({ ctx, entries, top, width, start }: { ctx: GCtx; entries: Array<{ label: string; color: string; line?: boolean }>; top: number; width: number; start: number }) {
  const { p } = ctx;
  const total = entries.reduce((a, e) => a + 40 + estW(e.label, 32, 0.56), 0) + (entries.length - 1) * 34;
  const size = total > width ? Math.max(28, Math.floor(32 * (width / total))) : 32;
  return (
    <div style={{ position: "absolute", left: 0, top, width, height: 46, display: "flex", alignItems: "center", gap: 34, whiteSpace: "nowrap", overflow: "hidden" }}>
      {entries.map((e, i) => {
        const o = prog(ctx.frame, start + i * 3, 12, ctx.ease);
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, opacity: o, transform: `translateY(${r1((1 - o) * 8)}px)` }}>
            <div style={{ width: e.line ? 30 : 18, height: e.line ? 6 : 18, borderRadius: e.line ? 3 : 6, background: e.color, boxShadow: `0 0 12px ${rgba(e.color, 0.55)}` }} />
            <div style={{ fontFamily: FONT.text, fontSize: size, color: p.ink, opacity: 0.92 }}>{e.label}</div>
          </div>
        );
      })}
    </div>
  );
}

function barFill(color: string, dir: "up" | "down" | "right" | "left", strength = 1): string {
  const deg = dir === "up" ? 180 : dir === "down" ? 0 : dir === "right" ? 270 : 90;
  return `linear-gradient(${deg}deg, ${mix(color, "#FFFFFF", 0.22 * strength)} 0%, ${color} 42%, ${mix(color, "#000000", 0.32)} 100%)`;
}

// ===================================================================== BAR_GROUP
/**
 * Grouped / stacked / horizontal bars for series × categories. Negative values hang below a
 * zero axis (red with format.negativeRed). Highlight = a category index. Sequenced per series
 * (GROUP_BY_GROUP = last year's bars, then this year's).
 */
export function BarGroup({ ctx }: { ctx: GCtx }) {
  if (ctx.variant === "HORIZONTAL") return <BarsHorizontal ctx={ctx} />;
  const { props, p, frame } = ctx;
  const series = props.series;
  const nS = Math.max(1, series.length);
  const nC = Math.max(1, props.categories.length, ...series.map((s) => s.values.length));
  const stacked = ctx.variant === "STACKED";
  const IW = ctx.width - 2 * PAD;
  const IH = ctx.height - 2 * PAD;
  const head = headHeight(props);
  const legend = series.length > 1;
  const legendH = legend ? 62 : 0;
  const has = (g: number, i: number) => i < (series[g]?.values.length ?? 0);
  const val = (g: number, i: number) => finiteOr(series[g]?.values[i] ?? 0, 0);

  // Value domain (stacked: per-category positive / negative stacks).
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < nC; i++) {
    let pos = 0;
    let neg = 0;
    for (let g = 0; g < series.length; g++) {
      if (!has(g, i)) continue;
      const v = val(g, i);
      if (stacked) {
        if (v > 0) pos += v;
        else neg += v;
      } else {
        hi = Math.max(hi, v);
        lo = Math.min(lo, v);
      }
    }
    if (stacked) {
      hi = Math.max(hi, pos);
      lo = Math.min(lo, neg);
    }
  }
  if (hi - lo < 1e-9) hi = lo + 1;
  const anyNeg = lo < 0;
  const valH = 58;
  const catH = 58;
  const plotTop = head + legendH + (hi > 0 ? valH : 10);
  const plotBottom = IH - catH - (anyNeg && !stacked ? valH : anyNeg ? 12 : 0);
  const plotH = Math.max(40, plotBottom - plotTop);
  const yOf = (v: number) => plotTop + ((hi - v) / (hi - lo)) * plotH;
  const zeroY = yOf(0);

  const slotW = IW / nC;
  let barW: number;
  let groupW: number;
  let barGap = 0;
  if (stacked || nS === 1) {
    barW = Math.min(stacked ? 168 : 150, slotW * 0.62);
    groupW = barW;
  } else {
    groupW = slotW * 0.8;
    barGap = Math.max(6, groupW * 0.05);
    barW = Math.min(120, (groupW - barGap * (nS - 1)) / nS);
    groupW = barW * nS + barGap * (nS - 1);
  }
  const barX = (g: number, i: number) => slotW * i + (slotW - groupW) / 2 + (stacked || nS === 1 ? 0 : g * (barW + barGap));

  const seq = graphicSequence(series.map(() => nC), ctx.anim, seqOpts(ctx));
  const hl = props.highlight !== null && props.highlight < nC ? props.highlight : null;
  const hlDone = hl !== null ? maxOf(series.map((_, g) => seq.at(g, hl) + seq.len), seq.done) : seq.done;
  const em = emphasisAt(ctx, hlDone);
  const fadeAxis = prog(frame, Math.max(0, seq.first - 6), 14, ctx.ease);

  // Final geometry per bar (for labels + obstacles).
  type Bar = { g: number; i: number; v: number; base: number; end: number; x: number; w: number; color: string; topMost: boolean };
  const bars: Bar[] = [];
  for (let i = 0; i < nC; i++) {
    let pos = 0;
    let neg = 0;
    const segs: Bar[] = [];
    for (let g = 0; g < series.length; g++) {
      if (!has(g, i)) continue;
      const v = val(g, i);
      const base = stacked ? (v >= 0 ? pos : neg) : 0;
      if (stacked) {
        if (v >= 0) pos += v;
        else neg += v;
      }
      const accent = colorOf(ctx, series[g]!.color, g);
      const color = v < 0 && ctx.fmt.negativeRed && !stacked ? p.negative : accent;
      segs.push({ g, i, v, base, end: base + v, x: barX(g, i), w: barW, color, topMost: !stacked });
    }
    if (stacked) {
      const lastPos = [...segs].reverse().find((b) => b.v > 0);
      const lastNeg = [...segs].reverse().find((b) => b.v < 0);
      if (lastPos) lastPos.topMost = true;
      if (lastNeg) lastNeg.topMost = true;
    }
    bars.push(...segs);
  }
  const rectOf = (b: Bar): Rect => ({ x0: b.x, x1: b.x + b.w, y0: yOf(Math.max(b.base, b.end)), y1: yOf(Math.min(b.base, b.end)) });

  // Value labels.
  const maxAbs = Math.max(1e-9, ...bars.map((b) => Math.abs(b.v)));
  const labelBars = stacked ? [] : bars;
  const labelIn: LabelIn[] = labelBars.map((b, k) => {
    const r = rectOf(b);
    const text = fmtValue(ctx, b.v, b.v).text;
    return { cx: b.x + b.w / 2, cy: b.v >= 0 ? r.y0 - 30 : r.y1 + 30, text, pri: (hl === b.i ? 10 : 0) + Math.abs(b.v) / maxAbs, slotW: nS > 1 ? barW + barGap : slotW, own: k };
  });
  const labels = layoutLabels(labelIn, { left: 0, right: IW }, labelBars.map(rectOf), nS > 1 ? 40 : 46, 36);
  const cat = axisLabels(props.categories, slotW);

  return (
    <Panel ctx={ctx} pad={PAD}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: PAD, top: PAD, width: IW, height: IH }}>
        {legend ? <Legend ctx={ctx} entries={series.map((s, g) => ({ label: s.label, color: colorOf(ctx, s.color, g) }))} top={head + 4} width={IW} start={seq.first} /> : null}
        {/* grid + zero axis */}
        {[0.25, 0.5, 0.75].map((t) => (
          <div key={t} style={{ position: "absolute", left: 0, right: 0, top: plotTop + plotH * t, height: 1.5, background: rgba("#FFFFFF", 0.045), opacity: fadeAxis }} />
        ))}
        <div style={{ position: "absolute", left: -6, right: -6, top: zeroY - 1, height: 2, background: rgba("#FFFFFF", anyNeg ? 0.3 : 0.16), opacity: fadeAxis }} />
        {bars.map((b, k) => {
          const start = seq.at(b.g, b.i);
          const t = growAt(ctx, start, seq.len);
          const cur = b.base + (b.end - b.base) * t;
          const y0 = yOf(Math.max(b.base, cur));
          const y1 = yOf(Math.min(b.base, cur));
          const h = Math.max(0, y1 - y0);
          const isH = hl === b.i;
          const dim = dimFor(isH, hl !== null, em);
          const up = b.v >= 0;
          const rad = Math.min(16, b.w * 0.18);
          const segGap = stacked ? 2 : 0;
          const radius = b.topMost ? (up ? `${rad}px ${rad}px 4px 4px` : `4px 4px ${rad}px ${rad}px`) : "4px";
          return (
            <div key={k} style={{ position: "absolute", left: b.x, width: b.w, top: y0 + (stacked && up ? segGap : 0), height: Math.max(0, h - segGap), ...exitCss(ctx, seq.flat(b.g, b.i), seq.count) }}>
              <div style={{ position: "absolute", inset: 0, opacity: dim * clamp01(t * 4), borderRadius: radius, background: barFill(b.color, up ? "up" : "down"), boxShadow: [`inset 0 ${up ? 2 : -2}px 0 ${rgba("#FFFFFF", 0.28)}`, isH ? glowShadow(b.color, em.on, 0.8) : undefined].filter(Boolean).join(", "), transform: isH && em.scale !== 1 ? `scale(${em.scale})` : undefined, transformOrigin: up ? "50% 100%" : "50% 0%" }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "36%", borderRadius: radius, background: `linear-gradient(90deg, ${rgba("#FFFFFF", 0.14)}, transparent)` }} />
              </div>
              {stacked && h > 52 && b.w > estW(fmtValue(ctx, b.v, b.v).text, 36) + 8 ? (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, fontSize: 36, color: rgba("#0B0B10", 0.86), letterSpacing: "-0.02em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", opacity: prog(frame, start + seq.len * 0.6, 10, ctx.ease) * dim }}>
                  {fmtValue(ctx, counted(ctx, start, b.v, 0, 1.2, seq.len), b.v).text}
                </div>
              ) : null}
            </div>
          );
        })}
        {labelBars.map((b, k) => {
          const L = labels[k]!;
          if (!L.show) return null;
          const start = seq.at(b.g, b.i);
          const t = growAt(ctx, start, seq.len);
          const cur = b.base + (b.end - b.base) * t;
          const up = b.v >= 0;
          const yEdge = yOf(cur);
          const isH = hl === b.i;
          const dim = dimFor(isH, hl !== null, em);
          const st = enterStyle(ctx, start + Math.round(seq.len * 0.3), seq.len, { style: ctx.anim.enter === "RISE" ? "FADE" : ctx.anim.enter, blurOK: seq.count <= 12 });
          const tv = fmtValue(ctx, counted(ctx, start, b.v, 0, 1.2, seq.len), b.v);
          const color = isH ? valueColor(ctx, b.v, p.primary) : valueColor(ctx, b.v, p.ink);
          return (
            <div key={`l${k}`} style={{ position: "absolute", left: L.cx - 160, width: 320, height: L.size * 1.15, top: up ? yEdge - 10 - L.size * 1.15 : yEdge + 10, display: "flex", alignItems: "center", justifyContent: "center", ...exitCss(ctx, seq.flat(b.g, b.i), seq.count) }}>
              <div style={{ ...css(st), opacity: st.opacity * dim, fontFamily: FONT.display, fontSize: L.size, lineHeight: 1, color, letterSpacing: "-0.02em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", textShadow: isH ? glowShadow(color, em.on, 0.5) : undefined }}>{tv.text}</div>
            </div>
          );
        })}
        {props.categories.map((c, i) => {
          if (i >= nC || !c) return null;
          if (cat.every > 1 && i % cat.every !== 0 && i !== nC - 1) return null;
          const isH = hl === i;
          const o = prog(frame, seq.at(0, i) - 2, 12, ctx.ease);
          return (
            <div key={`c${i}`} style={{ position: "absolute", left: slotW * i + slotW / 2 - 140, width: 280, top: IH - catH + 14, height: 40, display: "flex", justifyContent: "center", alignItems: "center", fontFamily: isH ? FONT.displayBold : FONT.text, fontSize: cat.size, color: isH ? p.ink : p.muted, opacity: o * (isH ? 1 : 0.92), whiteSpace: "nowrap" }}>
              {c}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function BarsHorizontal({ ctx }: { ctx: GCtx }) {
  const { props, p, frame } = ctx;
  const series = props.series;
  const nS = Math.max(1, series.length);
  const nC = Math.max(1, props.categories.length, ...series.map((s) => s.values.length));
  const IW = ctx.width - 2 * PAD;
  const IH = ctx.height - 2 * PAD;
  const head = headHeight(props);
  const legend = series.length > 1;
  const legendH = legend ? 62 : 0;
  const has = (g: number, i: number) => i < (series[g]?.values.length ?? 0);
  const val = (g: number, i: number) => finiteOr(series[g]?.values[i] ?? 0, 0);
  const all = series.flatMap((s) => s.values.map((v) => finiteOr(v, 0)));
  let hi = Math.max(0, maxOf(all, 0));
  const lo = Math.min(0, minOf(all, 0));
  if (hi - lo < 1e-9) hi = lo + 1;
  const anyNeg = lo < 0;
  const valueSize = 38;
  const texts = series.flatMap((s) => s.values.map((v) => fmtValue(ctx, v, v).text));
  const valW = Math.min(250, maxOf(texts.map((t) => estW(t, valueSize)), 80) + 22);
  const x0 = anyNeg && hi > 0 ? valW : anyNeg ? valW : 0;
  const plotW = Math.max(60, IW - x0 - (hi > 0 ? valW : 12));
  const xOf = (v: number) => x0 + ((v - lo) / (hi - lo)) * plotW;
  const zeroX = xOf(0);
  const rowsTop = head + legendH;
  const rowH = (IH - rowsTop) / nC;
  const labelH = 44;
  const barH = nS > 1 ? Math.min(34, (rowH - labelH - 22) / nS - 8) : Math.min(42, rowH - labelH - 26);
  const barGap = 8;
  const seq = graphicSequence(series.map(() => nC), ctx.anim, seqOpts(ctx));
  const hl = props.highlight !== null && props.highlight < nC ? props.highlight : null;
  const hlDone = hl !== null ? maxOf(series.map((_, g) => seq.at(g, hl) + seq.len), seq.done) : seq.done;
  const em = emphasisAt(ctx, hlDone);
  const catSize = Math.max(28, Math.min(34, ...props.categories.map((c) => fitSize(c, IW * 0.7, 34, 28, 0.56))));
  return (
    <Panel ctx={ctx} pad={PAD}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: PAD, top: PAD, width: IW, height: IH }}>
        {legend ? <Legend ctx={ctx} entries={series.map((s, g) => ({ label: s.label, color: colorOf(ctx, s.color, g) }))} top={head + 4} width={IW} start={seq.first} /> : null}
        {anyNeg ? <div style={{ position: "absolute", left: zeroX - 1, width: 2, top: rowsTop + 4, bottom: 0, background: rgba("#FFFFFF", 0.26), opacity: prog(frame, 0, 14, ctx.ease) }} /> : null}
        {Array.from({ length: nC }, (_, i) => {
          const top = rowsTop + i * rowH;
          const isH = hl === i;
          const dim = dimFor(isH, hl !== null, em);
          const lab = seqStyle(ctx, seq, 0, i, { style: ctx.anim.enter === "RISE" ? "SLIDE" : ctx.anim.enter });
          const c = props.categories[i] ?? "";
          const barsTop = top + labelH + 6;
          return (
            <div key={i} style={{ position: "absolute", left: 0, top, width: IW, height: rowH, opacity: dim }}>
              {c ? <div style={{ position: "absolute", left: anyNeg ? 0 : 2, top: 0, height: labelH, display: "flex", alignItems: "center", fontFamily: isH ? FONT.displayBold : FONT.text, fontSize: catSize, color: isH ? p.ink : rgba(p.ink, 0.88), whiteSpace: "nowrap", ...css(lab) }}>{c}</div> : null}
              {series.map((s, g) => {
                if (!has(g, i)) return null;
                const v = val(g, i);
                const start = seq.at(g, i);
                const t = growAt(ctx, start, seq.len);
                const accent = colorOf(ctx, s.color, g);
                const color = v < 0 && ctx.fmt.negativeRed ? p.negative : accent;
                const end = xOf(v * t);
                const left = Math.min(zeroX, end);
                const w = Math.abs(end - zeroX);
                const y = barsTop - top + g * (barH + barGap);
                const tv = fmtValue(ctx, counted(ctx, start, v, 0, 1.2, seq.len), v);
                const vo = prog(frame, start + Math.round(seq.len * 0.25), 12, ctx.ease);
                const r = Math.min(14, barH / 2);
                const up = v >= 0;
                const vColor = isH ? valueColor(ctx, v, p.primary) : valueColor(ctx, v, p.ink);
                return (
                  <div key={g} style={exitCss(ctx, seq.flat(g, i), seq.count)}>
                    <div style={{ position: "absolute", left: x0, width: plotW, top: y, height: barH, borderRadius: r, background: rgba("#FFFFFF", 0.045), opacity: prog(frame, start - 4, 10, ctx.ease) }} />
                    <div style={{ position: "absolute", left, width: w, top: y, height: barH, borderRadius: up ? `4px ${r}px ${r}px 4px` : `${r}px 4px 4px ${r}px`, background: barFill(color, up ? "right" : "left"), boxShadow: [`inset 0 2px 0 ${rgba("#FFFFFF", 0.26)}`, isH ? glowShadow(color, em.on, 0.8) : undefined].filter(Boolean).join(", "), opacity: clamp01(t * 4) }} />
                    <div style={{ position: "absolute", top: y + barH / 2 - 24, height: 48, ...(up ? { left: end + 14 } : { right: IW - end + 14 }), display: "flex", alignItems: "center", fontFamily: FONT.display, fontSize: valueSize, color: vColor, letterSpacing: "-0.02em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", opacity: vo, textShadow: isH ? glowShadow(vColor, em.on, 0.5) : undefined }}>{tv.text}</div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ===================================================================== LINE_AREA
function smoothPolyline(pts: Array<[number, number]>, samplesPerSeg = 16): Array<[number, number]> {
  if (pts.length < 3) return pts;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      // No overshoot beyond the two neighbouring points (a curve never invents a dip).
      out.push([Math.min(Math.max(x, p1[0]), p2[0]), Math.min(Math.max(y, Math.min(p1[1], p2[1])), Math.max(p1[1], p2[1]))]);
    }
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

function yAtX(poly: Array<[number, number]>, x: number): number {
  if (!poly.length) return 0;
  if (x <= poly[0]![0]) return poly[0]![1];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    if (x <= b[0]) {
      const t = b[0] - a[0] > 1e-6 ? (x - a[0]) / (b[0] - a[0]) : 1;
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return poly[poly.length - 1]![1];
}

/** Per-series draw windows: TOGETHER all at once, STAGGER a beat apart, GROUP_BY_GROUP /
 * ONE_BY_ONE one line after another — compressed to finish before the hold + exit. */
function drawWindows(ctx: GCtx, n: number): { starts: number[]; len: number; done: number } {
  const { fps } = ctx;
  const speed = Math.max(0.5, ctx.anim.speed || 1);
  const s0 = Math.round(0.22 * fps);
  let len = Math.round((1.5 * fps) / speed);
  const st = (Math.max(0.06, ctx.anim.stagger) * 3 * fps * ctx.f.tempo) / speed;
  const pause = (ctx.anim.groupPause * fps * ctx.f.tempo) / speed;
  const offs = Array.from({ length: n }, (_, g) => {
    switch (ctx.anim.order) {
      case "TOGETHER":
        return 0;
      case "STAGGER":
        return g * st;
      default:
        return g * (len * 0.85 + pause);
    }
  });
  const budget = Math.max(s0 + 8, ctx.D - ctx.exitFrames - Math.round(0.7 * fps));
  const maxOff = maxOf(offs, 0);
  if (s0 + maxOff + len > budget) {
    const k = (budget - s0) / (maxOff + len);
    len = Math.max(8, Math.floor(len * k));
    for (let g = 0; g < n; g++) offs[g] = offs[g]! * k;
  }
  const starts = offs.map((o) => Math.round(s0 + o));
  return { starts, len, done: maxOf(starts, s0) + len };
}

export function LineArea({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const id = sid(useId());
  const series = props.series;
  const nS = series.length;
  const area = ctx.variant === "AREA";
  const IW = ctx.width - 2 * PAD;
  const IH = ctx.height - 2 * PAD;
  const head = headHeight(props);
  const multi = nS > 1;
  const legendH = multi ? 66 : 0;
  const nPts = Math.max(2, ...series.map((s) => s.values.length));
  const hasCats = props.categories.some((c) => c && c.trim());
  const catH = hasCats ? 56 : 14;
  const all = series.flatMap((s) => s.values.map((v) => finiteOr(v, 0)));
  // Lines needn't start at zero: all-positive data that lives in a narrow band (100 → 74,
  // 10 → 27) zooms to that band so the movement reads; anything touching zero keeps it.
  const mn = minOf(all, 0);
  const mx = maxOf(all, 0);
  const zoom = mn > 0 && mn > 0.35 * mx;
  const lo0 = zoom ? mn - (mx - mn) * 0.18 : Math.min(0, mn);
  let hi = Math.max(zoom ? mx : 0, mx);
  if (hi - lo0 < 1e-9) hi = lo0 + 1;
  const lo = lo0 < 0 ? lo0 - (hi - lo0) * 0.04 : lo0;
  hi += (hi - lo) * 0.04;
  const finals = series.map((s) => finiteOr(s.values[s.values.length - 1] ?? 0, 0));
  const pillSize = 40;
  const gutter = multi ? Math.min(280, maxOf(finals.map((v) => estW(fmtValue(ctx, v, v).text, 36)), 80) + 58) : 0;
  const plotL = 6;
  const plotW = IW - plotL - (multi ? gutter : 14);
  const plotTop = head + legendH + (multi ? 22 : 96);
  // A single falling line ends low: leave room under its end for the value pill.
  const s0v = series[0]?.values ?? [];
  const fallingEnd = !multi && s0v.length >= 2 && finiteOr(s0v[s0v.length - 1]!, 0) < finiteOr(s0v[s0v.length - 2]!, 0);
  const plotBottom = IH - catH - (fallingEnd ? 98 : 0);
  const plotH = Math.max(60, plotBottom - plotTop);
  const xOf = (i: number) => plotL + (i / (nPts - 1)) * plotW;
  const yOf = (v: number) => plotTop + ((hi - v) / (hi - lo)) * plotH;
  const zeroY = zoom ? plotBottom : yOf(0);
  const win = drawWindows(ctx, Math.max(1, nS));
  const em = emphasisAt(ctx, win.done);

  const lines = series.map((s, g) => {
    const color = colorOf(ctx, s.color, g);
    const pts: Array<[number, number]> = s.values.map((v, i) => [xOf(i), yOf(finiteOr(v, 0))]);
    if (pts.length === 1) pts.push([xOf(1), pts[0]![1]]);
    const poly = smoothPolyline(pts);
    const d = poly.map((q, i) => `${i ? "L" : "M"}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" ");
    const last = pts[pts.length - 1] ?? [xOf(nPts - 1), zeroY];
    const areaD = pts.length ? `${d} L${last[0].toFixed(1)},${zeroY.toFixed(1)} L${pts[0]![0].toFixed(1)},${zeroY.toFixed(1)} Z` : "";
    const start = win.starts[g] ?? 0;
    const draw = prog(frame, start, win.len, EASE_IN_OUT);
    const headX = pts[0]![0] + (last[0] - pts[0]![0]) * draw;
    return { s, g, color, pts, poly, d, areaD, last, start, draw, headX, headY: yAtX(poly, headX) };
  });

  // End-value pills: single series sits above (or below, when falling) its end point; several
  // series stack in a right gutter, de-collided.
  const pillH = 60;
  const pillY: number[] = lines.map((l) => l.last[1]);
  if (multi) {
    const order = lines.map((_, g) => g).sort((a, b) => pillY[a]! - pillY[b]!);
    const minY = plotTop + pillH / 2 - 10;
    const maxY = plotBottom - pillH / 2;
    let prev = -Infinity;
    for (const g of order) {
      pillY[g] = Math.max(pillY[g]!, prev + pillH + 8, minY);
      prev = pillY[g]!;
    }
    // If the stack ran off the bottom, push it back up.
    let over = prev - maxY;
    if (over > 0) {
      for (let k = order.length - 1; k >= 0; k--) {
        const g = order[k]!;
        pillY[g] = pillY[g]! - over;
        const above = k > 0 ? pillY[order[k - 1]!]! : -Infinity;
        over = Math.max(0, above + pillH + 8 - pillY[g]!);
        if (over <= 0) break;
      }
    }
  }
  const cats = props.categories;
  const catIdx: number[] = [];
  if (hasCats) {
    const cand = cats.map((c, i) => (c && c.trim() && i < nPts ? i : -1)).filter((i) => i >= 0);
    const wOf = (i: number) => estW(cats[i]!, 30, 0.58);
    for (const i of cand) {
      const prev = catIdx[catIdx.length - 1];
      if (prev === undefined || xOf(i) - xOf(prev) >= (wOf(i) + wOf(prev)) / 2 + 26) catIdx.push(i);
    }
    const lastC = cand[cand.length - 1];
    if (lastC !== undefined && catIdx[catIdx.length - 1] !== lastC) {
      while (catIdx.length && xOf(lastC) - xOf(catIdx[catIdx.length - 1]!) < (wOf(lastC) + wOf(catIdx[catIdx.length - 1]!)) / 2 + 26) catIdx.pop();
      catIdx.push(lastC);
    }
  }
  const gridO = prog(frame, 0, 16, ctx.ease);
  return (
    <Panel ctx={ctx} pad={PAD}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: PAD, top: PAD, width: IW, height: IH }}>
        {multi ? <Legend ctx={ctx} entries={lines.map((l) => ({ label: l.s.label, color: l.color, line: true }))} top={head + 6} width={IW} start={win.starts[0] ?? 0} /> : null}
        <svg width={IW} height={IH} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
          <defs>
            {lines.map((l) => (
              <g key={l.g}>
                <linearGradient id={`${id}-s${l.g}`} x1="0" x2="1" y1="0" y2="0">
                  <stop offset="0" stopColor={mix(l.color, "#FFFFFF", 0.1)} stopOpacity={0.55} />
                  <stop offset="1" stopColor={l.color} />
                </linearGradient>
                <linearGradient id={`${id}-f${l.g}`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={plotTop} y2={zeroY}>
                  <stop offset="0" stopColor={l.color} stopOpacity={multi ? 0.22 : 0.34} />
                  <stop offset="1" stopColor={l.color} stopOpacity={0} />
                </linearGradient>
                <clipPath id={`${id}-c${l.g}`}>
                  <rect x={-20} y={-40} width={Math.max(0, l.headX + 20)} height={IH + 80} />
                </clipPath>
              </g>
            ))}
            <filter id={`${id}-glow`} x="-20%" y="-50%" width="140%" height="200%">
              <feGaussianBlur stdDeviation={9} />
            </filter>
          </defs>
          {[0, 0.25, 0.5, 0.75].map((t) => (
            <line key={t} x1={0} x2={plotL + plotW} y1={plotTop + plotH * t} y2={plotTop + plotH * t} stroke={rgba("#FFFFFF", 0.06)} strokeWidth={1.5} strokeDasharray="6 10" opacity={gridO} />
          ))}
          <line x1={0} x2={plotL + plotW} y1={zeroY} y2={zeroY} stroke={rgba("#FFFFFF", lo < 0 ? 0.28 : 0.16)} strokeWidth={2} opacity={gridO} />
          {lines.map((l) => {
            const ex = exitCss(ctx, l.g, Math.max(1, nS));
            return (
              <g key={l.g} style={ex}>
                {area ? <path d={l.areaD} fill={`url(#${id}-f${l.g})`} clipPath={`url(#${id}-c${l.g})`} /> : null}
                <path d={l.d} fill="none" stroke={l.color} strokeWidth={14} strokeLinecap="round" strokeLinejoin="round" clipPath={`url(#${id}-c${l.g})`} filter={`url(#${id}-glow)`} opacity={0.42} />
                <path d={l.d} fill="none" stroke={`url(#${id}-s${l.g})`} strokeWidth={multi ? 7 : 8} strokeLinecap="round" strokeLinejoin="round" clipPath={`url(#${id}-c${l.g})`} />
                {l.pts.length <= 12
                  ? l.pts.slice(0, -1).map((q, i) => (
                      <circle key={i} cx={q[0]} cy={q[1]} r={6} fill={l.color} stroke={rgba("#0B0B10", 0.8)} strokeWidth={2.5} opacity={q[0] <= l.headX + 0.5 ? 0.95 : 0} />
                    ))
                  : null}
                {l.draw > 0 && l.draw < 1 ? (
                  <>
                    <circle cx={l.headX} cy={l.headY} r={13} fill="#FFFFFF" filter={`url(#${id}-glow)`} opacity={0.8} />
                    <circle cx={l.headX} cy={l.headY} r={8} fill="#FFFFFF" />
                  </>
                ) : null}
                {l.draw >= 1 ? <EndDot ctx={ctx} x={l.last[0]} y={l.last[1]} color={l.color} at={l.start + win.len} ring={em.ring} /> : null}
              </g>
            );
          })}
        </svg>
        {lines.map((l) => {
          const final = finals[l.g]!;
          const first = finiteOr(l.s.values[0] ?? 0, 0);
          const tv = fmtValue(ctx, counted(ctx, l.start, final, first, 1, win.len), final);
          const pillAt = l.start + Math.round(win.len * 0.8);
          const sp = springAt(frame, fps, pillAt, ctx.f.springs.soft, Math.round(0.7 * fps));
          const vColor = valueColor(ctx, final, l.color);
          const w = estW(tv.text, multi ? 36 : pillSize) + 52;
          let left: number;
          let top: number;
          if (multi) {
            left = plotL + plotW + 26;
            top = pillY[l.g]! - pillH / 2;
          } else {
            const prev = l.pts[l.pts.length - 2]?.[1] ?? l.last[1];
            const falling = l.last[1] > prev + 1;
            const below = falling && l.last[1] + 34 + pillH <= IH - catH + 4;
            left = Math.max(0, Math.min(IW - w, l.last[0] - w + 30));
            top = below ? l.last[1] + 30 : Math.max(head + legendH + 4, l.last[1] - 30 - pillH);
          }
          return (
            <div key={`p${l.g}`} style={{ position: "absolute", left, top, height: pillH, display: "flex", alignItems: "center", opacity: clamp01(sp * 1.4), transform: `translateY(${r1((1 - Math.min(1, sp)) * 14 * ctx.f.distance)}px) scale(${r1((0.86 + 0.14 * Math.min(1.05, sp)) * em.scale * 1000) / 1000})`, transformOrigin: multi ? "0% 50%" : "100% 100%", ...exitCss(ctx, l.g, Math.max(1, nS)) }}>
              {multi ? <div style={{ position: "absolute", left: -22, top: pillH / 2 - 1, width: 18, height: 2, background: rgba(l.color, 0.5) }} /> : null}
              <div style={{ padding: "0 24px", height: pillH, display: "flex", alignItems: "center", borderRadius: 999, background: rgba(vColor, 0.15), boxShadow: `inset 0 0 0 2px ${rgba(vColor, 0.55)}, ${glowShadow(vColor, 0.4 + 0.6 * em.on, 0.6) ?? ""}`.replace(/, $/, ""), fontFamily: FONT.display, fontSize: multi ? 36 : pillSize, letterSpacing: "-0.02em", color: vColor, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                {tv.text}
              </div>
            </div>
          );
        })}
        {!multi && lines[0] && finiteOr(lines[0].s.values[0] ?? 0, 0) !== 0 ? (() => {
          const l = lines[0]!;
          const first = finiteOr(l.s.values[0] ?? 0, 0);
          const q = l.pts[0]!;
          const above = q[1] - 62 > head + 2;
          return (
            <div style={{ position: "absolute", left: Math.max(0, q[0] - 6), top: above ? q[1] - 60 : q[1] + 16, height: 44, display: "flex", alignItems: "center", fontFamily: FONT.display, fontSize: 36, letterSpacing: "-0.02em", color: valueColor(ctx, first, p.muted), whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", opacity: prog(frame, l.start, 12, ctx.ease), ...exitCss(ctx, 0, 1) }}>
              {fmtValue(ctx, first, first).text}
            </div>
          );
        })() : null}
        {catIdx.map((i) => {
          const x = xOf(i);
          const first = i === catIdx[0] && x - estW(cats[i]!, 30, 0.58) / 2 < 0;
          const lastOne = x + estW(cats[i]!, 30, 0.58) / 2 > plotL + plotW + (multi ? gutter : 14);
          const o = prog(frame, (win.starts[0] ?? 0) + Math.round((i / Math.max(1, nPts - 1)) * win.len) - 4, 12, ctx.ease);
          return (
            <div key={`c${i}`} style={{ position: "absolute", top: IH - catH + 16, height: 36, ...(first ? { left: 0 } : lastOne ? { right: IW - (plotL + plotW) - 10 } : { left: x - 120, width: 240, justifyContent: "center" }), display: "flex", alignItems: "center", fontFamily: FONT.text, fontSize: 30, color: p.muted, opacity: o, whiteSpace: "nowrap" }}>
              {cats[i]}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function EndDot({ ctx, x, y, color, at, ring }: { ctx: GCtx; x: number; y: number; color: string; at: number; ring: number }) {
  const age = ctx.frame - at;
  const k = clamp01(age / Math.round(0.9 * ctx.fps));
  const rr = ring > 0 ? ring : k;
  return (
    <>
      {rr < 1 ? <circle cx={x} cy={y} r={14 + 30 * rr} fill="none" stroke={color} strokeWidth={3} opacity={(1 - rr) * 0.8} /> : null}
      <circle cx={x} cy={y} r={12} fill={color} stroke="#FFFFFF" strokeWidth={4} />
    </>
  );
}

// ===================================================================== WATERFALL
/**
 * STEPS: the classic waterfall — each bar floats on the running total, joined by connectors
 * (start in the brand colour, ins green, outs red). FLOW: every value from a zero line,
 * coloured by sign — the "cash flow rollercoaster". showTotal adds the final total bar.
 */
export function Waterfall({ ctx }: { ctx: GCtx }) {
  const { props, p, frame } = ctx;
  const flow = ctx.variant === "FLOW";
  const s = props.series[0];
  const vals = (s?.values ?? []).map((v) => finiteOr(v, 0));
  const n = vals.length;
  const rt = runningTotals(vals);
  const total = rt[n - 1] ?? 0;
  const showTot = props.showTotal && n > 0;
  const nb = Math.max(1, n + (showTot ? 1 : 0));
  const IW = ctx.width - 2 * PAD;
  const IH = ctx.height - 2 * PAD;
  const head = headHeight(props);
  const accent = colorOf(ctx, s?.color, 0);
  type B = { k: number; v: number; base: number; end: number; color: string; label: string; total: boolean };
  const bars: B[] = vals.map((v, i) => {
    const base = flow ? 0 : i === 0 ? 0 : rt[i - 1]!;
    const end = flow ? v : rt[i]!;
    let color: string;
    if (v === 0) color = p.muted;
    else if (!flow && i === 0 && v > 0) color = accent;
    else if (v > 0) color = p.positive;
    else color = ctx.fmt.negativeRed ? p.negative : p.secondary;
    return { k: i, v, base, end, color, label: props.categories[i] ?? "", total: false };
  });
  if (showTot) bars.push({ k: n, v: total, base: 0, end: total, color: total < 0 && ctx.fmt.negativeRed ? p.negative : accent, label: props.categories[n] || "Total", total: true });
  const ends = bars.flatMap((b) => [b.base, b.end]);
  let hi = Math.max(0, maxOf(ends, 0));
  const lo = Math.min(0, minOf(ends, 0));
  if (hi - lo < 1e-9) hi = lo + 1;
  const anyNeg = lo < 0;
  const valH = 56;
  const catH = 58;
  const totalGap = showTot ? 26 : 0;
  const plotTop = head + (hi > 0 ? valH + 6 : 12);
  const plotBottom = IH - catH - (anyNeg ? valH : 4);
  const plotH = Math.max(40, plotBottom - plotTop);
  const yOf = (v: number) => plotTop + ((hi - v) / (hi - lo)) * plotH;
  const zeroY = yOf(0);
  const slotW = (IW - totalGap) / nb;
  const barW = Math.min(132, slotW * 0.66);
  const xOf = (k: number) => slotW * k + (k >= n && showTot ? totalGap : 0) + (slotW - barW) / 2;
  const seq = listSequence(nb, ctx.anim, seqOpts(ctx));
  const hl = props.highlight !== null && props.highlight < nb ? props.highlight : showTot ? n : null;
  const em = emphasisAt(ctx, hl !== null ? seq.at(0, hl) + seq.len : seq.done);
  const minBar = 6;
  const rectOf = (b: B): Rect => {
    let y0 = yOf(Math.max(b.base, b.end));
    let y1 = yOf(Math.min(b.base, b.end));
    if (y1 - y0 < minBar) {
      const m = (y0 + y1) / 2;
      y0 = m - minBar / 2;
      y1 = m + minBar / 2;
    }
    return { x0: xOf(b.k), x1: xOf(b.k) + barW, y0, y1 };
  };
  const up = (b: B) => (b.v === 0 ? true : flow || b.total ? b.v > 0 : b.v > 0);
  const maxAbs = Math.max(1e-9, ...bars.map((b) => Math.abs(b.v)));
  const labelIn: LabelIn[] = bars.map((b, k) => {
    const r = rectOf(b);
    return { cx: xOf(b.k) + barW / 2, cy: up(b) ? r.y0 - 30 : r.y1 + 30, text: fmtValue(ctx, b.v, b.v).text, pri: (b.total ? 20 : 0) + (hl === b.k ? 10 : 0) + Math.abs(b.v) / maxAbs, slotW, own: k };
  });
  const labels = layoutLabels(labelIn, { left: 0, right: IW }, bars.map(rectOf), 42, 36);
  const cat = axisLabels(bars.map((b) => b.label), slotW);
  const fadeAxis = prog(frame, Math.max(0, seq.first - 6), 14, ctx.ease);
  return (
    <Panel ctx={ctx} pad={PAD}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: PAD, top: PAD, width: IW, height: IH }}>
        {[0.25, 0.5, 0.75].map((t) => (
          <div key={t} style={{ position: "absolute", left: 0, right: 0, top: plotTop + plotH * t, height: 1.5, background: rgba("#FFFFFF", 0.04), opacity: fadeAxis }} />
        ))}
        <div style={{ position: "absolute", left: -6, right: -6, top: zeroY - 1, height: 2, background: rgba("#FFFFFF", anyNeg ? 0.3 : 0.16), opacity: fadeAxis }} />
        {showTot ? <div style={{ position: "absolute", left: slotW * n + totalGap / 2 - 1, width: 2, top: plotTop - 10, bottom: catH - 6, background: `repeating-linear-gradient(180deg, ${rgba("#FFFFFF", 0.16)} 0 8px, transparent 8px 16px)`, opacity: prog(frame, seq.at(0, n) - 6, 10, ctx.ease) }} /> : null}
        {/* connectors (STEPS): the running total carried to the next bar */}
        {!flow
          ? bars.slice(0, -1).map((b, k) => {
              const next = bars[k + 1]!;
              const y = yOf(b.end);
              const x0 = xOf(b.k) + barW;
              const x1 = xOf(next.k);
              const t = prog(frame, seq.at(0, k + 1) - 2, Math.round(seq.len * 0.6), ctx.ease);
              return <div key={`j${k}`} style={{ position: "absolute", left: x0, width: Math.max(0, (x1 - x0) * t), top: y - 1, height: 2, background: `repeating-linear-gradient(90deg, ${rgba("#FFFFFF", 0.42)} 0 6px, transparent 6px 11px)`, ...exitCss(ctx, k, seq.count) }} />;
            })
          : null}
        {bars.map((b, k) => {
          const start = seq.at(0, k);
          const t = growAt(ctx, start, seq.len);
          const cur = b.base + (b.end - b.base) * t;
          const y0r = yOf(Math.max(b.base, cur));
          const y1r = yOf(Math.min(b.base, cur));
          const zero = b.v === 0;
          const hgt = zero ? minBar : Math.max(0, y1r - y0r);
          const top = zero ? zeroY - minBar / 2 : y0r;
          const isH = hl === b.k;
          const dim = dimFor(isH, hl !== null && !(showTot && hl === n), em);
          const u = up(b);
          const rad = Math.min(14, barW * 0.16);
          const radius = flow || b.total ? (u ? `${rad}px ${rad}px 4px 4px` : `4px 4px ${rad}px ${rad}px`) : `${Math.min(10, rad)}px`;
          return (
            <div key={k} style={{ position: "absolute", left: xOf(b.k), width: barW, top, height: hgt, ...exitCss(ctx, k, seq.count) }}>
              <div style={{ position: "absolute", inset: 0, opacity: dim * clamp01(t * 4), borderRadius: radius, background: zero ? rgba(p.muted, 0.5) : barFill(b.color, u ? "up" : "down", b.total ? 1.3 : 1), boxShadow: [`inset 0 ${u ? 2 : -2}px 0 ${rgba("#FFFFFF", 0.26)}`, isH || b.total ? glowShadow(b.color, b.total ? Math.max(0.35, em.on) : em.on, b.total ? 1 : 0.8) : undefined].filter(Boolean).join(", "), transform: isH && em.scale !== 1 ? `scale(${em.scale})` : undefined, transformOrigin: u ? "50% 100%" : "50% 0%" }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "36%", borderRadius: radius, background: `linear-gradient(90deg, ${rgba("#FFFFFF", 0.14)}, transparent)` }} />
              </div>
            </div>
          );
        })}
        {bars.map((b, k) => {
          const L = labels[k]!;
          if (!L.show) return null;
          const start = seq.at(0, k);
          const t = growAt(ctx, start, seq.len);
          const cur = b.base + (b.end - b.base) * t;
          const u = up(b);
          const r = rectOf(b);
          const yEdge = b.v === 0 ? r.y0 : u ? yOf(Math.max(b.base, cur)) : yOf(Math.min(b.base, cur));
          const isH = hl === b.k;
          const dim = dimFor(isH, hl !== null && !(showTot && hl === n), em);
          const tv = fmtValue(ctx, counted(ctx, start, b.v, 0, 1.2, seq.len), b.v);
          const color = b.total ? valueColor(ctx, b.v, accent) : b.v === 0 ? p.muted : flow || k > 0 ? b.color : p.ink;
          const st = enterStyle(ctx, start + Math.round(seq.len * 0.3), seq.len, { style: ctx.anim.enter === "RISE" ? "FADE" : ctx.anim.enter, blurOK: seq.count <= 12 });
          const size = b.total ? Math.max(L.size, Math.min(48, fitSize(tv.text, slotW + 40, 48, 36))) : L.size;
          return (
            <div key={`l${k}`} style={{ position: "absolute", left: L.cx - 160, width: 320, height: size * 1.15, top: u ? yEdge - 10 - size * 1.15 : yEdge + 10, display: "flex", alignItems: "center", justifyContent: "center", ...exitCss(ctx, k, seq.count) }}>
              <div style={{ ...css(st), opacity: st.opacity * dim, fontFamily: FONT.display, fontSize: size, lineHeight: 1, color, letterSpacing: "-0.02em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", textShadow: isH || b.total ? glowShadow(color, b.total ? Math.max(0.3, em.on) : em.on, 0.5) : undefined }}>{tv.text}</div>
            </div>
          );
        })}
        {bars.map((b, k) => {
          if (!b.label) return null;
          if (cat.every > 1 && k % cat.every !== 0 && k !== nb - 1 && !b.total) return null;
          const o = prog(frame, seq.at(0, k) - 2, 12, ctx.ease);
          const strong = b.total || hl === b.k;
          return (
            <div key={`c${k}`} style={{ position: "absolute", left: xOf(b.k) + barW / 2 - 140, width: 280, top: IH - catH + 14, height: 40, display: "flex", justifyContent: "center", alignItems: "center", fontFamily: strong ? FONT.displayBold : FONT.text, fontSize: cat.size, color: strong ? p.ink : p.muted, opacity: o, whiteSpace: "nowrap" }}>
              {b.label}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ===================================================================== DONUT
function polar(cx: number, cy: number, r: number, a: number): [number, number] {
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function f2(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}
/** Annular sector (r0 = 0 → pie wedge), clockwise from a0 to a1 (radians, SVG y-down). */
function sector(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const d = Math.min(a1 - a0, TAU - 1e-3);
  if (!(d > 1e-4)) return "";
  const e = a0 + d;
  const large = d > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, r1, a0);
  const [x1, y1] = polar(cx, cy, r1, e);
  if (r0 <= 0.5) return `M${f2(cx)} ${f2(cy)} L${f2(x0)} ${f2(y0)} A${f2(r1)} ${f2(r1)} 0 ${large} 1 ${f2(x1)} ${f2(y1)} Z`;
  const [x2, y2] = polar(cx, cy, r0, e);
  const [x3, y3] = polar(cx, cy, r0, a0);
  return `M${f2(x0)} ${f2(y0)} A${f2(r1)} ${f2(r1)} 0 ${large} 1 ${f2(x1)} ${f2(y1)} L${f2(x2)} ${f2(y2)} A${f2(r0)} ${f2(r0)} 0 ${large} 0 ${f2(x3)} ${f2(y3)} Z`;
}
/** Stroke arc, clockwise from a0 to a1. */
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const d = Math.min(a1 - a0, TAU - 1e-3);
  if (!(d > 1e-4)) return "";
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a0 + d);
  return `M${f2(x0)} ${f2(y0)} A${f2(r)} ${f2(r)} 0 ${d > Math.PI ? 1 : 0} 1 ${f2(x1)} ${f2(y1)}`;
}

export function Donut({ ctx }: { ctx: GCtx }) {
  const { props, p, frame } = ctx;
  const id = sid(useId());
  const items = props.items;
  const n = items.length;
  const half = ctx.variant === "HALF";
  const pie = ctx.variant === "PIE";
  const IW = ctx.width - 2 * PAD;
  const IH = ctx.height - 2 * PAD;
  const head = headHeight(props);
  const vals = items.map((it) => Math.max(0, finiteOr(it.value ?? 0, 0)));
  const sum = vals.reduce((a, b) => a + b, 0);
  const shares = donutShares(items);
  // Percent data that already sums to ~100 shows once (the value IS the share).
  const valueIsShare = ctx.fmt.kind === "PERCENT" && Math.abs(sum - 100) < 0.6;
  // Value + share need a full row: beside the donut (DONUT / PIE) or under a half donut.
  const side = !half && !valueIsShare;
  const cols = valueIsShare && n > 1 ? 2 : 1;
  const rows = cols === 2 ? Math.ceil(n / 2) : Math.max(1, n);
  const rowH = valueIsShare ? 64 : 84;
  const legendH = rows * rowH;
  const pop = 16;
  const chartTop = head + 8;
  const chartW = side ? IW * 0.47 : IW;
  const chartH = side ? IH - head - 8 : IH - head - 8 - legendH - 28;
  let cy: number;
  let R: number;
  if (half) {
    R = Math.max(80, Math.min(IW / 2 - pop - 6, chartH - pop - 8));
    cy = chartTop + pop + R + (chartH - pop - R) / 2;
  } else {
    R = Math.max(80, Math.min(chartW / 2 - pop, (chartH - 2 * pop) / 2));
    cy = chartTop + chartH / 2;
  }
  const cx = side ? chartW / 2 : IW / 2;
  const r0 = pie ? 0 : R * (half ? 0.6 : 0.62);
  const a0 = half ? Math.PI : -Math.PI / 2;
  const sweep = half ? Math.PI : TAU;
  const padA = n > 1 ? (pie ? 1.0 : 1.4) * DEG : 0;
  const seq = listSequence(Math.max(1, n), ctx.anim, seqOpts(ctx));
  const hl = props.highlight !== null && props.highlight < n ? props.highlight : null;
  const em = emphasisAt(ctx, hl !== null ? seq.at(0, hl) + seq.len : seq.done);
  const largest = vals.reduce((best, v, i) => (v > (vals[best] ?? -1) ? i : best), 0);
  const focus = hl ?? largest;
  const pct = pctCtx(ctx);
  let cum = 0;
  const slices = items.map((it, i) => {
    const v = vals[i]!;
    const s0 = sum > 0 ? a0 + (cum / sum) * sweep : a0;
    cum += v;
    const s1 = sum > 0 ? a0 + (cum / sum) * sweep : a0;
    return { it, i, v, s0, s1, mid: (s0 + s1) / 2, color: colorOf(ctx, it.color, i) };
  });
  const trackO = prog(frame, 0, 14, ctx.ease);
  const centerShare = shares[focus] ?? 0;
  const centerStart = seq.at(0, focus);
  const centerT = prog(frame, centerStart + Math.round(seq.len * 0.4), seq.len, ctx.ease);
  const centerText = fmtValue(pct, counted(ctx, centerStart, centerShare, 0, 1.4, seq.len), centerShare);
  const innerW = half ? r0 * 1.6 : r0 * 1.42;
  const centerSize = Math.min(half ? 104 : 96, fitSize(fmtValue(pct, centerShare, centerShare).text, innerW, half ? 104 : 96, 40, 0.68));
  const focusLabel = items[focus]?.text ?? "";
  const legendL = side ? chartW + 24 : 0;
  const legendW = IW - legendL;
  const colW = cols === 2 ? (legendW - 28) / 2 : legendW;
  const legendTop = side ? head + (IH - head - legendH) / 2 + 4 : IH - legendH;
  return (
    <Panel ctx={ctx} pad={PAD}>
      <Header ctx={ctx} align={half ? "center" : "left"} />
      <div style={{ position: "absolute", left: PAD, top: PAD, width: IW, height: IH }}>
        <svg width={IW} height={IH} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
          <defs>
            <radialGradient id={`${id}-sheen`} cx={cx} cy={cy - R * 0.5} r={R * 1.3} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#FFFFFF" stopOpacity={0.2} />
              <stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
            </radialGradient>
            <filter id={`${id}-glow`} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation={12} />
            </filter>
          </defs>
          <path d={sector(cx, cy, r0, R, a0, a0 + sweep - (half ? 0 : 1e-3))} fill={rgba("#FFFFFF", 0.05)} opacity={trackO} />
          {slices.map((sl) => {
            if (sl.v <= 0) return null;
            const t = prog(frame, seq.at(0, sl.i), seq.len, EASE_IN_OUT);
            const span = Math.max(0, sl.s1 - sl.s0 - padA);
            const from = sl.s0 + padA / 2;
            const to = from + span * t;
            const isH = hl === sl.i;
            const dim = dimFor(isH, hl !== null, em);
            const off = isH ? pop * em.on : 0;
            const [dx, dy] = polar(0, 0, off, sl.mid);
            const d = sector(cx, cy, r0, R, from, to);
            return (
              <g key={sl.i} style={{ ...exitCss(ctx, sl.i, seq.count) }} transform={`translate(${f2(dx)} ${f2(dy)})`}>
                {isH && em.on > 0.01 ? <path d={d} fill={sl.color} filter={`url(#${id}-glow)`} opacity={0.55 * em.on} /> : null}
                <path d={d} fill={sl.color} opacity={dim} />
                <path d={d} fill={`url(#${id}-sheen)`} opacity={dim} />
              </g>
            );
          })}
          {!pie && !half ? <circle cx={cx} cy={cy} r={Math.max(0, r0 - 1)} fill="none" stroke={rgba("#000000", 0.25)} strokeWidth={2} opacity={trackO} /> : null}
        </svg>
        {!pie && n > 0 ? (
          <div style={{ position: "absolute", left: cx - innerW / 2, width: innerW, top: half ? cy - r0 * 0.78 : cy - r0 * 0.62, height: half ? r0 * 0.78 : r0 * 1.24, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: half ? "flex-end" : "center", opacity: centerT, transform: `scale(${r1((0.9 + 0.1 * centerT) * (hl !== null ? em.scale : 1) * 1000) / 1000})` }}>
            <div style={{ fontFamily: FONT.display, fontSize: centerSize, lineHeight: 1, letterSpacing: "-0.035em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", backgroundImage: heroGradient(slices[focus]?.color ?? p.primary), WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", filter: `drop-shadow(0 6px 22px ${rgba("#000000", 0.5)})` }}>{centerText.text}</div>
            {focusLabel ? <div style={{ marginTop: 8, fontFamily: FONT.text, fontSize: fitSize(focusLabel, innerW, 32, 28, 0.56), color: p.ink, opacity: 0.9, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: innerW }}>{focusLabel}</div> : null}
          </div>
        ) : null}
        {slices.map((sl) => {
          const col = cols === 2 ? sl.i % 2 : 0;
          const row = cols === 2 ? Math.floor(sl.i / 2) : sl.i;
          const left = legendL + col * (colW + 28);
          const isH = hl === sl.i;
          const dim = dimFor(isH, hl !== null, em);
          const st = seqStyle(ctx, seq, 0, sl.i, { style: ctx.anim.enter === "RISE" ? "RISE" : ctx.anim.enter });
          const start = seq.at(0, sl.i);
          const share = shares[sl.i] ?? 0;
          const big = valueIsShare ? fmtValue(ctx, counted(ctx, start, sl.v, 0, 1.2, seq.len), sl.v).text : fmtValue(pct, counted(ctx, start, share, 0, 1.2, seq.len), share).text;
          const small = valueIsShare ? null : fmtValue(ctx, counted(ctx, start, sl.v, 0, 1.2, seq.len), sl.v).text;
          const bigW = estW(valueIsShare ? fmtValue(ctx, sl.v, sl.v).text : fmtValue(pct, share, share).text, small ? 42 : 38, 0.58);
          const labelW = colW - 32 - 18 - 28 - bigW;
          return (
            <div key={`g${sl.i}`} style={{ position: "absolute", left, top: legendTop + row * rowH, width: colW, height: rowH - 8, display: "flex", alignItems: "center", gap: 14, padding: "0 16px", boxSizing: "border-box", borderRadius: 18, background: isH ? rgba(sl.color, 0.1 + 0.08 * em.on) : rgba("#FFFFFF", 0.035), boxShadow: isH ? `inset 0 0 0 1.5px ${rgba(sl.color, 0.3 + 0.3 * em.on)}` : undefined, ...css(st), opacity: st.opacity * dim }}>
              <div style={{ width: 18, height: 18, borderRadius: 6, background: sl.color, flex: "none", alignSelf: small ? "flex-start" : undefined, marginTop: small ? 12 : 0, boxShadow: `0 0 12px ${rgba(sl.color, 0.5)}` }} />
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                <div style={{ fontFamily: FONT.text, fontSize: fitSize(sl.it.text, labelW, small ? 30 : 32, 28, 0.56), lineHeight: 1.1, color: small ? rgba(p.ink, 0.85) : p.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sl.it.text}</div>
                {small ? <div style={{ fontFamily: FONT.display, fontSize: 36, lineHeight: 1.02, color: p.ink, letterSpacing: "-0.02em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{small}</div> : null}
              </div>
              <div style={{ fontFamily: FONT.display, fontSize: small ? 42 : 38, color: isH || small ? sl.color : p.ink, letterSpacing: "-0.02em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{big}</div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ===================================================================== PROGRESS
export function Progress({ ctx }: { ctx: GCtx }) {
  return ctx.variant === "BARS" ? <ProgressBars ctx={ctx} /> : <ProgressRings ctx={ctx} />;
}

/** AUTO colours skip the palette's positive green: on a progress chart green means "done". */
function progressColor(ctx: GCtx, token: GCtx["props"]["items"][number]["color"], i: number): string {
  if (token && token !== "AUTO") return colorOf(ctx, token, i);
  return colorOf(ctx, "AUTO", [0, 1, 4, 3, 6, 7][i % 6]!);
}

function progressFrac(ctx: GCtx, v: number): number {
  const r = graphicRange(ctx.props);
  return clamp01((v - r.min) / Math.max(1e-9, r.max - r.min));
}

function ProgressRings({ ctx }: { ctx: GCtx }) {
  const { props, p, frame } = ctx;
  const id = sid(useId());
  const items = props.items;
  const n = Math.max(1, items.length);
  const IW = ctx.width - 2 * PAD;
  const IH = ctx.height - 2 * PAD;
  const head = headHeight(props);
  const anySub = items.some((it) => it.sub);
  const textH = 50 + (anySub ? 38 : 0);
  const colW = IW / n;
  const avail = IH - head - textH - 22;
  const D = Math.max(120, Math.min(n === 1 ? 330 : 270, colW - (n > 1 ? 26 : 0), avail));
  const sw = Math.round(D * 0.105);
  const R = (D - sw) / 2;
  const top = head + Math.max(0, (avail - D) / 2);
  const seq = listSequence(n, ctx.anim, seqOpts(ctx));
  const hl = props.highlight !== null && props.highlight < n ? props.highlight : null;
  const em = emphasisAt(ctx, hl !== null ? seq.at(0, hl) + seq.len * 2 : seq.done + seq.len);
  const range = graphicRange(props);
  return (
    <Panel ctx={ctx} pad={PAD}>
      <Header ctx={ctx} align={n === 1 ? "center" : "left"} />
      <div style={{ position: "absolute", left: PAD, top: PAD, width: IW, height: IH }}>
        {items.map((it, i) => {
          const v = finiteOr(it.value ?? 0, 0);
          const frac = progressFrac(ctx, v);
          const done = frac >= 0.999;
          const accent = progressColor(ctx, it.color, i);
          const color = done ? p.positive : accent;
          const start = seq.at(0, i);
          const fillLen = Math.round(seq.len * 2);
          const t = prog(frame, start, fillLen, ctx.ease);
          const f = frac * t;
          const cx = colW * i + colW / 2;
          const cy = top + D / 2;
          const isH = hl === i;
          const dim = dimFor(isH, hl !== null, em);
          const st = seqStyle(ctx, seq, 0, i, { style: ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter });
          const tv = fmtValue(ctx, counted(ctx, start, v, range.min, 1, fillLen), v);
          const valSize = fitSize(fmtValue(ctx, v, v).text, D - 2 * sw - 40, Math.round(D * 0.27), 36, 0.66);
          const capA = -Math.PI / 2 + f * TAU;
          const [hx, hy] = polar(cx, cy, R, capA);
          const glowOn = isH ? em.on : done ? clamp01((frame - (start + fillLen)) / 10) : 0;
          return (
            <div key={i} style={{ position: "absolute", inset: 0, ...css(st), opacity: st.opacity * dim }}>
              <svg width={IW} height={IH} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
                <defs>
                  <linearGradient id={`${id}-r${i}`} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor={mix(color, "#FFFFFF", 0.35)} />
                    <stop offset="1" stopColor={color} />
                  </linearGradient>
                  <filter id={`${id}-g${i}`} x="-30%" y="-30%" width="160%" height="160%">
                    <feGaussianBlur stdDeviation={8} />
                  </filter>
                </defs>
                <circle cx={cx} cy={cy} r={R} fill="none" stroke={rgba("#FFFFFF", 0.07)} strokeWidth={sw} />
                <circle cx={cx} cy={cy} r={R + sw / 2 + 1} fill="none" stroke={rgba("#FFFFFF", 0.05)} strokeWidth={1.5} />
                {f > 0.002 ? (
                  <>
                    <path d={arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + f * TAU)} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" filter={`url(#${id}-g${i})`} opacity={0.35 + 0.35 * glowOn} />
                    <path d={arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + f * TAU)} fill="none" stroke={`url(#${id}-r${i})`} strokeWidth={sw} strokeLinecap="round" />
                    <circle cx={hx} cy={hy} r={sw * 0.22} fill="#FFFFFF" opacity={0.9} />
                  </>
                ) : null}
              </svg>
              <div style={{ position: "absolute", left: cx - D / 2, width: D, top: cy - D / 2, height: D, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", transform: isH && em.scale !== 1 ? `scale(${em.scale})` : undefined }}>
                <div style={{ fontFamily: FONT.display, fontSize: valSize, lineHeight: 1, letterSpacing: "-0.03em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", ...(v < 0 && ctx.fmt.negativeRed ? { color: p.negative } : { backgroundImage: heroGradient(done ? p.positive : isH || hl === null ? accent : p.ink), WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }) }}>{tv.text}</div>
                {done ? <div style={{ marginTop: 8, opacity: clamp01((frame - (start + fillLen)) / 8) }}><GIcon icon="CHECK" size={Math.round(D * 0.13)} color={p.positive} /></div> : null}
              </div>
              <div style={{ position: "absolute", left: cx - colW / 2 + 4, width: colW - 8, top: top + D + 18, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                <div style={{ fontFamily: isH ? FONT.displayBold : FONT.text, fontSize: fitSize(it.text, colW - 12, n === 1 ? 38 : 34, 28, 0.56), color: p.ink, whiteSpace: "nowrap", lineHeight: 1.15 }}>{it.text}</div>
                {it.sub ? <div style={{ marginTop: 4, fontFamily: FONT.text, fontSize: 28, color: p.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: colW - 12 }}>{it.sub}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function ProgressBars({ ctx }: { ctx: GCtx }) {
  const { props, p, frame } = ctx;
  const items = props.items;
  const n = Math.max(1, items.length);
  const IW = ctx.width - 2 * PAD;
  const IH = ctx.height - 2 * PAD;
  const head = headHeight(props);
  const rowH = (IH - head + 22) / n;
  const seq = listSequence(n, ctx.anim, seqOpts(ctx));
  const hl = props.highlight !== null && props.highlight < n ? props.highlight : null;
  const em = emphasisAt(ctx, hl !== null ? seq.at(0, hl) + seq.len * 2 : seq.done + seq.len);
  const range = graphicRange(props);
  const showMax = props.range !== null && ctx.fmt.kind !== "PERCENT";
  const maxText = showMax ? fmtValue(ctx, range.max, range.max).text : "";
  const barH = 34;
  return (
    <Panel ctx={ctx} pad={PAD}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: PAD, top: PAD, width: IW, height: IH }}>
        {items.map((it, i) => {
          const v = finiteOr(it.value ?? 0, 0);
          const frac = progressFrac(ctx, v);
          const done = frac >= 0.999;
          const accent = progressColor(ctx, it.color, i);
          const color = done ? p.positive : accent;
          const start = seq.at(0, i);
          const fillLen = Math.round(seq.len * 2);
          const t = growAt(ctx, start, fillLen);
          const f = Math.min(frac * t, 1);
          const top = head + i * rowH;
          const isH = hl === i;
          const dim = dimFor(isH, hl !== null, em);
          const st = seqStyle(ctx, seq, 0, i, { style: ctx.anim.enter === "RISE" ? "SLIDE" : ctx.anim.enter });
          const tv = fmtValue(ctx, counted(ctx, start, v, range.min, 1, fillLen), v);
          const valText = tv.text;
          const valW = estW(fmtValue(ctx, v, v).text, 44) + (showMax ? estW(` / ${maxText}`, 30) : 0) + (done ? 44 : 0);
          return (
            <div key={i} style={{ position: "absolute", left: 0, top, width: IW, height: rowH, ...css(st), opacity: st.opacity * dim }}>
              <div style={{ position: "absolute", left: 0, top: 0, height: 52, right: valW + 16, display: "flex", alignItems: "center", fontFamily: isH ? FONT.displayBold : FONT.text, fontSize: fitSize(it.text, IW - valW - 20, 36, 28, 0.56), color: p.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.text}</div>
              <div style={{ position: "absolute", right: 0, top: 0, height: 52, display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap" }}>
                {done ? <div style={{ opacity: clamp01((frame - (start + fillLen)) / 8) }}><GIcon icon="CHECK" size={34} color={p.positive} stroke={2.4} /></div> : null}
                <span style={{ fontFamily: FONT.display, fontSize: 44, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", color: valueColor(ctx, v, done ? p.positive : isH ? accent : p.ink), transform: isH && em.scale !== 1 ? `scale(${em.scale})` : undefined, display: "inline-block" }}>{valText}</span>
                {showMax ? <span style={{ fontFamily: FONT.text, fontSize: 30, color: p.muted }}>/ {maxText}</span> : null}
              </div>
              <div style={{ position: "absolute", left: 0, right: 0, top: 62, height: barH, borderRadius: barH / 2, background: rgba("#FFFFFF", 0.07), boxShadow: `inset 0 1.5px 3px ${rgba("#000000", 0.35)}` }} />
              {f > 0.001 ? (
                <div style={{ position: "absolute", left: 0, top: 62, height: barH, width: Math.max(barH, IW * f), borderRadius: barH / 2, background: `linear-gradient(90deg, ${mix(color, "#000000", 0.18)} 0%, ${color} 70%, ${mix(color, "#FFFFFF", 0.3)} 100%)`, boxShadow: [`inset 0 2px 0 ${rgba("#FFFFFF", 0.32)}`, glowShadow(color, isH ? Math.max(0.4, em.on) : 0.35, 0.6)].filter(Boolean).join(", ") }}>
                  <div style={{ position: "absolute", right: 6, top: 6, width: barH - 12, height: barH - 12, borderRadius: "50%", background: rgba("#FFFFFF", 0.85), boxShadow: `0 0 12px ${rgba("#FFFFFF", 0.6)}` }} />
                </div>
              ) : null}
              {it.sub ? <div style={{ position: "absolute", left: 0, right: 0, top: 62 + barH + 10, fontFamily: FONT.text, fontSize: 28, color: p.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.sub}</div> : null}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ===================================================================== GAUGE
export function Gauge({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const id = sid(useId());
  const seg = ctx.variant === "SEGMENTS";
  const it = props.items[0];
  const v = finiteOr(it?.value ?? 0, 0);
  const range = graphicRange(props);
  const frac = clamp01((v - range.min) / Math.max(1e-9, range.max - range.min));
  const IW = ctx.width - 2 * PAD;
  const IH = ctx.height - 2 * PAD;
  const head = headHeight(props);
  const avail = IH - head;
  // 240° dial: from 150° (lower left) clockwise over the top to 390° (lower right).
  const A0 = 150 * DEG;
  const SW = 240 * DEG;
  const minT = fmtValue(ctx, range.min, range.min).text;
  const maxT = fmtValue(ctx, range.max, range.max).text;
  const label = it?.text ?? "";
  // DIAL: the label sits between the scale ends when it fits there at >= 28 px, else on its
  // own row under them (the dial shrinks a little to make room).
  const fitR = (r: number) => 2 * r * Math.cos(30 * DEG) - estW(minT, 30, 0.6) / 2 - estW(maxT, 30, 0.6) / 2 - 90;
  const R0 = Math.max(120, Math.min(IW / 2 - 70, (avail - 40) / 1.62));
  const lowLabel = !seg && !!label && estW(label, 31, 0.58) > fitR(R0);
  const R = lowLabel ? Math.max(120, Math.min(IW / 2 - 70, (avail - 92) / 1.62)) : R0;
  const sw = Math.round(R * 0.13);
  const cx = IW / 2;
  const cy = head + 16 + sw / 2 + R;
  const speed = Math.max(0.5, ctx.anim.speed || 1);
  const start = Math.round(0.25 * fps);
  const len = Math.round((1.3 * fps) / speed);
  const sN = springAt(frame, fps, start, ctx.f.springs.soft, Math.round(len * 1.4));
  const shown = Math.max(-0.03, Math.min(1.04, frac * sN));
  const em = emphasisAt(ctx, start + len);
  const tv = fmtValue(ctx, counted(ctx, start, v, range.min, 1, len), v);
  const finalText = fmtValue(ctx, v, v).text;
  const ramp = (t: number) => (seg ? (t < 0.5 ? mix(p.positive, p.primary, t * 2) : mix(p.primary, p.negative, (t - 0.5) * 2)) : mix(p.secondary, p.primary, t));
  const valueAt = ramp(frac);
  const trackO = prog(frame, 0, 14, ctx.ease);
  const valSize = fitSize(finalText, R * 1.25, Math.round(Math.min(124, R * 0.46)), 48);
  const valTop = seg ? cy - valSize * 0.62 : cy + R * 0.14;
  const [ex0, ey0] = polar(cx, cy, R, A0);
  const [ex1] = polar(cx, cy, R, A0 + SW);
  const N = 12;
  const gapA = 3 * DEG;
  const lit = frac * prog(frame, start, len, ctx.ease);
  const angle = A0 + SW * shown;
  const needleL = R - sw / 2 - 18;
  const textO = prog(frame, start + 4, 14, ctx.ease);
  return (
    <Panel ctx={ctx} pad={PAD}>
      <Header ctx={ctx} align="center" />
      <div style={{ position: "absolute", left: PAD, top: PAD, width: IW, height: IH }}>
        <svg width={IW} height={IH} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <defs>
            <linearGradient id={`${id}-ramp`} gradientUnits="userSpaceOnUse" x1={cx - R} x2={cx + R} y1={0} y2={0}>
              <stop offset="0" stopColor={ramp(0)} />
              <stop offset="0.5" stopColor={ramp(0.5)} />
              <stop offset="1" stopColor={ramp(1)} />
            </linearGradient>
            <filter id={`${id}-glow`} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation={10} />
            </filter>
            <radialGradient id={`${id}-hub`} cx="0.35" cy="0.3" r="0.8">
              <stop offset="0" stopColor="#FFFFFF" />
              <stop offset="1" stopColor={mix(p.muted, "#000000", 0.35)} />
            </radialGradient>
          </defs>
          {seg ? (
            Array.from({ length: N }, (_, k) => {
              const s0 = A0 + (k / N) * SW + gapA / 2;
              const s1 = A0 + ((k + 1) / N) * SW - gapA / 2;
              const on = clamp01((lit - k / N) * N * 1.2);
              const c = ramp((k + 0.5) / N);
              const d = sector(cx, cy, R - sw / 2 - 4, R + sw / 2 + 4, s0, s1);
              return (
                <g key={k}>
                  <path d={d} fill={rgba("#FFFFFF", 0.07)} opacity={trackO} />
                  {on > 0 ? (
                    <>
                      <path d={d} fill={c} filter={`url(#${id}-glow)`} opacity={0.4 * on} />
                      <path d={d} fill={c} opacity={on} />
                    </>
                  ) : null}
                </g>
              );
            })
          ) : (
            <>
              <path d={arc(cx, cy, R, A0, A0 + SW)} fill="none" stroke={rgba("#FFFFFF", 0.07)} strokeWidth={sw} strokeLinecap="round" opacity={trackO} />
              <path d={arc(cx, cy, R, A0, A0 + SW)} fill="none" stroke={`url(#${id}-ramp)`} strokeWidth={sw} strokeLinecap="round" opacity={0.22 * trackO} />
              {shown > 0.003 ? (
                <>
                  <path d={arc(cx, cy, R, A0, A0 + SW * Math.min(1, shown))} fill="none" stroke={`url(#${id}-ramp)`} strokeWidth={sw} strokeLinecap="round" filter={`url(#${id}-glow)`} opacity={0.45} />
                  <path d={arc(cx, cy, R, A0, A0 + SW * Math.min(1, shown))} fill="none" stroke={`url(#${id}-ramp)`} strokeWidth={sw} strokeLinecap="round" />
                </>
              ) : null}
              {Array.from({ length: 25 }, (_, k) => {
                const a = A0 + (k / 24) * SW;
                const major = k % 6 === 0;
                const [x0, y0] = polar(cx, cy, R - sw / 2 - 12, a);
                const [x1, y1] = polar(cx, cy, R - sw / 2 - (major ? 30 : 21), a);
                return <line key={k} x1={x0} y1={y0} x2={x1} y2={y1} stroke={rgba("#FFFFFF", major ? 0.34 : 0.16)} strokeWidth={major ? 3 : 2} strokeLinecap="round" opacity={trackO} />;
              })}
              <g transform={`rotate(${f2(angle / DEG)} ${f2(cx)} ${f2(cy)})`} opacity={prog(frame, start - 4, 8, ctx.ease)}>
                <path d={`M${f2(cx - 30)} ${f2(cy)} L${f2(cx)} ${f2(cy - 11)} L${f2(cx + needleL)} ${f2(cy - 2.5)} L${f2(cx + needleL)} ${f2(cy + 2.5)} L${f2(cx)} ${f2(cy + 11)} Z`} fill={rgba("#000000", 0.45)} transform="translate(0 6)" />
                <path d={`M${f2(cx - 30)} ${f2(cy)} L${f2(cx)} ${f2(cy - 11)} L${f2(cx + needleL)} ${f2(cy - 2.5)} L${f2(cx + needleL)} ${f2(cy + 2.5)} L${f2(cx)} ${f2(cy + 11)} Z`} fill="#FFFFFF" />
              </g>
              <circle cx={cx} cy={cy} r={24} fill={`url(#${id}-hub)`} stroke={rgba("#000000", 0.4)} strokeWidth={2} />
              <circle cx={cx} cy={cy} r={8} fill={valueAt} />
            </>
          )}
        </svg>
        <div style={{ position: "absolute", left: ex0 - 110, width: 220, top: ey0 + sw / 2 + 10, textAlign: "center", fontFamily: FONT.text, fontSize: 30, color: p.muted, opacity: trackO, whiteSpace: "nowrap" }}>{minT}</div>
        <div style={{ position: "absolute", left: ex1 - 110, width: 220, top: ey0 + sw / 2 + 10, textAlign: "center", fontFamily: FONT.text, fontSize: 30, color: p.muted, opacity: trackO, whiteSpace: "nowrap" }}>{maxT}</div>
        <div style={{ position: "absolute", left: cx - R, width: 2 * R, top: valTop, display: "flex", flexDirection: "column", alignItems: "center", opacity: textO, transform: `scale(${r1(em.scale * 1000) / 1000})` }}>
          <div style={{ fontFamily: FONT.display, fontSize: valSize, lineHeight: 1, letterSpacing: "-0.035em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", ...(v < 0 && ctx.fmt.negativeRed ? { color: p.negative } : { backgroundImage: heroGradient(valueAt), WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }), filter: `drop-shadow(0 0 ${r1(10 + 22 * em.on)}px ${rgba(valueAt, 0.25 + 0.25 * em.on)}) drop-shadow(0 8px 24px ${rgba("#000000", 0.5)})` }}>{tv.text}</div>
          {label && !lowLabel ? <div style={{ marginTop: 10, fontFamily: FONT.text, fontSize: fitSize(label, seg ? R * 1.4 : fitR(R), 34, 28, 0.56), color: p.ink, opacity: 0.92, whiteSpace: "nowrap" }}>{label}</div> : null}
        </div>
        {lowLabel ? <div style={{ position: "absolute", left: 0, right: 0, top: ey0 + sw / 2 + 56, textAlign: "center", fontFamily: FONT.text, fontSize: fitSize(label, IW - 20, 34, 28, 0.56), color: p.ink, opacity: 0.92 * textO, whiteSpace: "nowrap" }}>{label}</div> : null}
      </div>
    </Panel>
  );
}

// ===================================================================== SCATTER
export function Scatter({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const id = sid(useId());
  const bubbles = ctx.variant === "BUBBLES";
  const series = props.series;
  const n = series.length;
  const IW = ctx.width - 2 * PAD;
  const IH = ctx.height - 2 * PAD;
  const head = headHeight(props);
  const pts = series.map((s) => ({ x: finiteOr(s.values[0] ?? 0, 0), y: finiteOr(s.values[1] ?? 0, 0), z: Math.max(0, finiteOr(s.values[2] ?? 1, 1)) }));
  const zMax = Math.max(1e-9, ...pts.map((q) => q.z));
  const radius = (z: number) => (bubbles ? 26 + Math.sqrt(z / zMax) * 50 : 20);
  const maxR = bubbles ? 76 : 20;
  const xLabel = props.categories[0] ?? "";
  const yLabel = props.categories[1] ?? "";
  const plotL = 14;
  const plotTop = head + (yLabel ? 58 : 18);
  const plotR = IW - 6;
  const plotBottom = IH - (xLabel ? 64 : 22);
  const m = maxR + 18;
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  const xLo = Math.min(0, minOf(xs, 0));
  let xHi = maxOf(xs, 1);
  const yLo = Math.min(0, minOf(ys, 0));
  let yHi = maxOf(ys, 1);
  if (xHi - xLo < 1e-9) xHi = xLo + 1;
  if (yHi - yLo < 1e-9) yHi = yLo + 1;
  const pxOf = (x: number) => plotL + m + ((x - xLo) / (xHi - xLo)) * (plotR - plotL - 2 * m);
  const pyOf = (y: number) => plotBottom - m - ((y - yLo) / (yHi - yLo)) * (plotBottom - plotTop - 2 * m);
  const seq = listSequence(Math.max(1, n), ctx.anim, seqOpts(ctx));
  const hl = props.highlight !== null && props.highlight < n ? props.highlight : null;
  const em = emphasisAt(ctx, hl !== null ? seq.at(0, hl) + seq.len : seq.done);
  // Label placement: right, left, above, below — first spot clear of dots + earlier labels.
  const dots = pts.map((q) => ({ x: pxOf(q.x), y: pyOf(q.y), r: radius(q.z) }));
  const placed: Rect[] = [];
  const labelPos = series.map((s, g) => {
    const d = dots[g]!;
    const size = fitSize(s.label, 300, hl === g ? 34 : 32, 28, 0.56);
    const w = estW(s.label, size, 0.56) + 8;
    const h = size * 1.2;
    const cands: Array<{ x: number; y: number; align: "left" | "right" | "center" }> = [
      { x: d.x + d.r + 14, y: d.y - h / 2, align: "left" },
      { x: d.x - d.r - 14 - w, y: d.y - h / 2, align: "right" },
      { x: d.x - w / 2, y: d.y - d.r - 10 - h, align: "center" },
      { x: d.x - w / 2, y: d.y + d.r + 10, align: "center" },
    ];
    const score = (c: { x: number; y: number }) => {
      const r: Rect = { x0: c.x, y0: c.y, x1: c.x + w, y1: c.y + h };
      let bad = 0;
      if (r.x0 < 0 || r.x1 > IW || r.y0 < head || r.y1 > IH) bad += 100;
      for (const o of placed) if (overlaps(r, o, 6)) bad += 10;
      dots.forEach((o, k) => {
        if (k !== g && overlaps(r, { x0: o.x - o.r, x1: o.x + o.r, y0: o.y - o.r, y1: o.y + o.r }, 4)) bad += 5;
      });
      return bad;
    };
    let best = cands[0]!;
    let bestS = Infinity;
    for (const c of cands) {
      const sc = score(c);
      if (sc < bestS) {
        best = c;
        bestS = sc;
      }
      if (sc === 0) break;
    }
    best = { ...best, x: Math.max(0, Math.min(IW - w, best.x)), y: Math.max(head, Math.min(IH - h, best.y)) };
    placed.push({ x0: best.x, y0: best.y, x1: best.x + w, y1: best.y + h });
    return { ...best, w, h, size };
  });
  const axisO = prog(frame, 0, 16, ctx.ease);
  const axisDraw = prog(frame, 2, Math.round(0.6 * fps), ctx.ease);
  return (
    <Panel ctx={ctx} pad={PAD}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: PAD, top: PAD, width: IW, height: IH }}>
        <svg width={IW} height={IH} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <defs>
            <marker id={`${id}-arr`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M1 1L9 5L1 9" fill="none" stroke={rgba("#FFFFFF", 0.5)} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
            </marker>
          </defs>
          {[0.25, 0.5, 0.75].map((t) => (
            <g key={t} opacity={axisO}>
              <line x1={plotL} x2={plotR} y1={plotTop + (plotBottom - plotTop) * t} y2={plotTop + (plotBottom - plotTop) * t} stroke={rgba("#FFFFFF", 0.05)} strokeWidth={1.5} strokeDasharray="6 10" />
              <line y1={plotTop} y2={plotBottom} x1={plotL + (plotR - plotL) * t} x2={plotL + (plotR - plotL) * t} stroke={rgba("#FFFFFF", 0.05)} strokeWidth={1.5} strokeDasharray="6 10" />
            </g>
          ))}
          <path d={`M${plotL} ${plotBottom} L${plotL} ${f2(plotBottom - (plotBottom - plotTop) * axisDraw)}`} stroke={rgba("#FFFFFF", 0.32)} strokeWidth={2.5} fill="none" markerEnd={axisDraw > 0.95 ? `url(#${id}-arr)` : undefined} />
          <path d={`M${plotL} ${plotBottom} L${f2(plotL + (plotR - plotL) * axisDraw)} ${plotBottom}`} stroke={rgba("#FFFFFF", 0.32)} strokeWidth={2.5} fill="none" markerEnd={axisDraw > 0.95 ? `url(#${id}-arr)` : undefined} />
        </svg>
        {yLabel ? <div style={{ position: "absolute", left: plotL + 18, top: plotTop - 52, height: 40, display: "flex", alignItems: "center", fontFamily: FONT.text, fontSize: 30, color: p.muted, opacity: axisO, whiteSpace: "nowrap" }}>{yLabel}</div> : null}
        {xLabel ? <div style={{ position: "absolute", right: 10, top: plotBottom + 14, height: 40, display: "flex", alignItems: "center", fontFamily: FONT.text, fontSize: 30, color: p.muted, opacity: axisO, whiteSpace: "nowrap" }}>{xLabel}</div> : null}
        {series.map((s, g) => {
          const d = dots[g]!;
          const color = colorOf(ctx, s.color, g);
          const start = seq.at(0, g);
          const sp = springAt(frame, fps, start, ctx.f.springs.soft, Math.round(seq.len * 1.8));
          const k = Math.max(0, Math.min(1.12, sp));
          const isH = hl === g;
          const dim = dimFor(isH, hl !== null, em);
          const lp = labelPos[g]!;
          const lo = prog(frame, start + Math.round(seq.len * 0.35), seq.len, ctx.ease);
          const ex = exitCss(ctx, g, seq.count);
          const scale = k * (isH ? em.scale : 1);
          const ringR = isH && em.on > 0 ? d.r + 8 + 18 * (ctx.anim.emphasis === "RING" ? em.ring : 0) : 0;
          return (
            <div key={g} style={{ ...ex, opacity: (typeof ex.opacity === "number" ? ex.opacity : 1) * dim }}>
              {isH && em.on > 0.01 ? <div style={{ position: "absolute", left: d.x - ringR, top: d.y - ringR, width: 2 * ringR, height: 2 * ringR, borderRadius: "50%", boxShadow: `inset 0 0 0 2.5px ${rgba(color, 0.7 * em.on * (ctx.anim.emphasis === "RING" ? 1 - em.ring * 0.6 : 1))}` }} /> : null}
              <div style={{ position: "absolute", left: d.x - d.r, top: d.y - d.r, width: 2 * d.r, height: 2 * d.r, borderRadius: "50%", transform: `scale(${r1(scale * 1000) / 1000})`, opacity: clamp01(sp * 2), background: bubbles ? `radial-gradient(circle at 35% 30%, ${rgba(mix(color, "#FFFFFF", 0.35), 0.55)} 0%, ${rgba(color, 0.32)} 60%, ${rgba(color, 0.2)} 100%)` : `radial-gradient(circle at 35% 30%, ${mix(color, "#FFFFFF", 0.45)} 0%, ${color} 55%, ${mix(color, "#000000", 0.25)} 100%)`, boxShadow: [bubbles ? `inset 0 0 0 3px ${rgba(color, 0.85)}` : `0 0 0 3px ${rgba("#0B0B10", 0.6)}`, `0 0 ${isH ? r1(18 + 26 * em.on) : 14}px ${rgba(color, isH ? 0.45 + 0.3 * em.on : 0.35)}`].join(", ") }} />
              <div style={{ position: "absolute", left: lp.x, top: lp.y, width: lp.w, height: lp.h, display: "flex", alignItems: "center", justifyContent: lp.align === "left" ? "flex-start" : lp.align === "right" ? "flex-end" : "center", fontFamily: isH ? FONT.displayBold : FONT.text, fontSize: lp.size, color: isH ? p.ink : rgba(p.ink, 0.9), whiteSpace: "nowrap", opacity: lo, textShadow: `0 2px 10px ${rgba("#000000", 0.6)}` }}>{s.label}</div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export const CHARTS_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {
  BAR_GROUP: BarGroup,
  LINE_AREA: LineArea,
  WATERFALL: Waterfall,
  DONUT: Donut,
  PROGRESS: Progress,
  GAUGE: Gauge,
  SCATTER: Scatter,
};

