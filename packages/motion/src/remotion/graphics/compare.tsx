import { useId, type CSSProperties, type ComponentType, type ReactElement } from "react";
import { numberPlan, type GraphicColor, type GraphicComponent, type GraphicIcon } from "@chris/media/timeline";
import { graphicSequence, listSequence, type GraphicSequence } from "../../graphics-timing";
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
  tile,
  valueColor,
  withExit,
  type Emphasis,
  type GCtx,
} from "./kit";

/**
 * Comparisons, timelines, lists and tables: VERSUS, ENTITY_CARDS, BEFORE_AFTER, STEPS,
 * CHECKLIST, RANKING, TABLE. Same conventions as money.tsx — every element enters through the
 * sequencer (animation.order/stagger/speed), numbers count up with a stable format, the
 * highlighted element takes the emphasis while the rest dim, and everything is a pure function
 * of the frame.
 */

type Item = GCtx["props"]["items"][number];
type Series = GCtx["props"]["series"][number];

const DARK = "#14110A";
const MEDALS = ["#F4C84A", "#CDD3DD", "#D9925A"] as const;

function seqOpts(ctx: GCtx) {
  return { fps: ctx.fps, durationInFrames: ctx.D, exitFrames: ctx.exitFrames, tempo: ctx.f.tempo };
}

function hlOf(ctx: GCtx, n: number): number | null {
  const h = ctx.props.highlight;
  return h !== null && h >= 0 && h < n ? h : null;
}

/** AUTO → one brand accent for single-accent lists (steps, checks); explicit tokens win. */
function accentOf(ctx: GCtx, token: GraphicColor | undefined, fallback: string): string {
  return !token || token === "AUTO" ? fallback : colorOf(ctx, token, 0);
}

function clampLines(lines: number): CSSProperties {
  return { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" };
}

const oneLine: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

function sid(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "");
}

/** A tinted rounded tile holding a line icon that draws on. */
function IconTile({ icon, accent, size, draw, strength = 1 }: { icon: GraphicIcon; accent: string; size: number; draw: number; strength?: number }) {
  return (
    <div style={{ width: size, height: size, flex: "none", borderRadius: Math.round(size * 0.3), display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(160deg, ${rgba(accent, 0.24 * strength)}, ${rgba(accent, 0.08 * strength)})`, boxShadow: `inset 0 0 0 1.5px ${rgba(accent, 0.45 * strength)}, inset 0 1.5px 0 ${rgba("#FFFFFF", 0.14)}` }}>
      <GIcon icon={icon} size={Math.round(size * 0.58)} color={accent} draw={draw} />
    </div>
  );
}

/** A metallic medal disc (gold / silver / bronze) with its rank. */
function Medal({ rank, size, scale = 1 }: { rank: number; size: number; scale?: number }) {
  const c = MEDALS[rank] ?? MEDALS[2];
  return (
    <div style={{ width: size, height: size, flex: "none", borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", background: `radial-gradient(circle at 34% 28%, ${mix(c, "#FFFFFF", 0.55)} 0%, ${c} 46%, ${mix(c, "#000000", 0.32)} 100%)`, boxShadow: `0 6px 18px ${rgba("#000000", 0.4)}, 0 0 22px ${rgba(c, 0.35)}, inset 0 0 0 ${Math.max(2, Math.round(size * 0.06))}px ${rgba(mix(c, "#FFFFFF", 0.4), 0.55)}`, transform: scale !== 1 ? `scale(${r1(scale * 100) / 100})` : undefined, fontFamily: FONT.display, fontSize: Math.round(size * 0.48), color: mix(c, "#000000", 0.72), letterSpacing: "-0.02em" }}>
      {rank + 1}
    </div>
  );
}

/** The gradient "VS" coin. */
function VsBadge({ ctx, start, size = 96 }: { ctx: GCtx; start: number; size?: number }) {
  const { p, frame, fps, f } = ctx;
  const s = springAt(frame, fps, start, f.springs.soft, Math.round(0.8 * fps));
  return (
    <div style={{ width: size, height: size, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(160deg, ${mix(p.primary, "#FFFFFF", 0.22)}, ${mix(p.primary, "#000000", 0.18)})`, boxShadow: `0 14px 36px ${rgba("#000000", 0.5)}, 0 0 0 7px ${rgba("#0E0E14", 0.9)}, 0 0 34px ${rgba(p.primary, 0.32)}`, opacity: clamp01(s * 1.4), transform: `scale(${r1(Math.max(0, s) * 100) / 100}) rotate(${r1((1 - Math.min(1, s)) * -(40 + f.rotate * 4))}deg)`, fontFamily: FONT.display, fontSize: Math.round(size * 0.38), color: DARK, letterSpacing: "-0.02em" }}>
      VS
    </div>
  );
}

/** Value text with gradient for the hero/highlighted value, red for negatives. */
function valueFace(ctx: GCtx, value: number, accent: string, hero: boolean, plain: string): CSSProperties {
  if (value < 0 && ctx.fmt.negativeRed) return { color: ctx.p.negative };
  return hero ? { backgroundImage: heroGradient(accent), WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" } : { color: plain };
}

/**
 * Rank order for leaderboards/podiums: if the author already ordered the values (monotonic up
 * or down) that order IS the ranking (e.g. "lowest fees" ascending); otherwise rank by value,
 * highest first. Items without a value keep their place after the valued ones.
 */
function rankOrder(items: Item[]): number[] {
  const idx = items.map((_, i) => i);
  const vals = items.map((it) => it.value);
  if (vals.some((v) => v === null)) {
    const withV = idx.filter((i) => vals[i] !== null);
    const without = idx.filter((i) => vals[i] === null);
    return [...rankOrder(withV.map((i) => items[i]!)).map((k) => withV[k]!), ...without];
  }
  const v = vals as number[];
  const asc = v.every((x, i) => i === 0 || x >= v[i - 1]!);
  const desc = v.every((x, i) => i === 0 || x <= v[i - 1]!);
  if (asc || desc) return idx;
  return idx.sort((a, b) => v[b]! - v[a]! || a - b);
}

function emScale(isH: boolean, em: Emphasis): string | undefined {
  return isH && em.scale !== 1 ? `scale(${r1(em.scale * 1000) / 1000})` : undefined;
}

// ===================================================================== VERSUS
/** A vs B: two entities, metric by metric. SPLIT = halves with a VS coin; CARDS = two cards. */
export function Versus({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const empty: Series = { label: "", values: [], icon: null, color: "AUTO", note: null, texts: [] };
  const sides = [props.series[0] ?? empty, props.series[1] ?? empty];
  const rows = Math.max(1, sides[0]!.values.length, sides[1]!.values.length);
  const pad = 40;
  const innerW = ctx.width - pad * 2;
  const head = headHeight(props);
  const seq = graphicSequence([2, ...Array.from({ length: rows }, () => 2)], ctx.anim, seqOpts(ctx));
  const hl = hlOf(ctx, 2);
  const em = emphasisAt(ctx, seq.done);
  const cards = ctx.variant === "CARDS";
  const accents = sides.map((s, i) => colorOf(ctx, s.color, i));
  const anyIcon = sides.some((s) => s.icon);
  const anyNote = sides.some((s) => s.note);
  // Mirrors graphicDesignSize: header (icon row only when an entity has one) + rows + 16 px foot.
  const headH = (anyIcon ? 124 : 24) + (anyNote ? 38 : 0) + 84;
  const bodyH = Math.max(headH + rows * 60, ctx.height - pad * 2 - head);
  const rowH = (bodyH - headH - 16) / rows;
  const gapMid = cards ? 36 : 0;
  const colW = cards ? (innerW - gapMid) / 2 : innerW / 2;
  const midW = cards ? 0 : Math.min(300, Math.max(200, innerW * 0.3));
  const valW = cards ? colW - 48 : (innerW - midW) / 2 - 16;
  const vsTop = anyIcon ? 70 : headH / 2 - 48 + 4;
  const hctx = harmonized(ctx, sides.flatMap((x) => x.values));

  const cell = (g: number, r: number) => {
    const s = sides[g]!;
    const has = r < s.values.length;
    const v = has ? s.values[r]! : 0;
    const text = s.texts[r]?.trim() ? s.texts[r]! : null;
        const t = fmtValue(hctx, counted(ctx, seq.at(1 + r, g), v, 0, 1.2, seq.len), v);
    const isH = hl === g;
    const shown = !has ? "—" : (text ?? t.text);
    const final = !has ? "—" : (text ?? fmtValue(hctx, v, v).text);
    const size = fitSize(final, valW, 58, 36, 0.6);
    return { shown, size, style: has ? valueFace(ctx, v, accents[g]!, isH && !text, valueColor(ctx, v, p.ink)) : { color: p.muted } };
  };

  return (
    <Panel ctx={ctx} pad={pad}>
      <Header ctx={ctx} align={cards ? "left" : "center"} />
      <div style={{ position: "absolute", left: pad, right: pad, top: pad + head, height: bodyH }}>
        {sides.map((s, g) => {
          const isH = hl === g;
          const dim = dimFor(isH, hl !== null, em);
          const accent = accents[g]!;
          const hs = seqStyle(ctx, seq, 0, g, { style: ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter });
          const cardIn = enterStyle(ctx, seq.at(0, g), seq.len, { style: "FADE" });
          const x = g * (colW + gapMid);
          const glow = isH ? em.on : 0;
          const baseTile = tile(ctx, accent, 30, (cards ? 0.7 : 0.45) + 0.7 * glow);
          return (
            <div key={g} style={{ position: "absolute", left: x, top: 0, width: colW, height: bodyH, opacity: dim, transform: emScale(isH, em), transformOrigin: "50% 50%" }}>
              <div style={{ position: "absolute", inset: cards ? 0 : `0 ${g === 0 ? 8 : 0}px 0 ${g === 1 ? 8 : 0}px`, ...baseTile, opacity: cardIn.opacity, boxShadow: [baseTile.boxShadow, glowShadow(accent, glow, 0.9)].filter(Boolean).join(", ") }} />
              <div style={{ position: "absolute", left: 30, right: 30, top: 0, height: 4, borderRadius: 4, background: `linear-gradient(90deg, ${rgba(accent, 0)}, ${rgba(accent, 0.95)}, ${rgba(accent, 0)})`, opacity: cardIn.opacity * (0.55 + 0.45 * glow) }} />
              {/* entity header */}
              <div style={{ position: "absolute", left: 16, right: 16, top: 26, height: headH - 40, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", ...css(hs) }}>
                {s.icon ? (
                  <IconTile icon={s.icon} accent={accent} size={88} draw={prog(frame, seq.at(0, g), Math.round(0.6 * fps), ctx.ease)} strength={1 + 0.4 * glow} />
                ) : anyIcon ? (
                  <div style={{ width: 88, height: 88, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <div style={{ width: 22, height: 22, borderRadius: 99, background: accent, boxShadow: `0 0 22px ${rgba(accent, 0.7)}` }} />
                  </div>
                ) : null}
                <div style={{ marginTop: anyIcon ? 16 : 6, fontFamily: FONT.displayBold, fontSize: fitSize(s.label, colW - 60, 46, 30, 0.56), lineHeight: 1.25, color: p.ink, letterSpacing: "-0.015em", maxWidth: "100%", ...oneLine }}>{s.label}</div>
                {!anyIcon ? <div style={{ marginTop: 12, width: 46, height: 5, borderRadius: 5, background: accent, boxShadow: `0 0 14px ${rgba(accent, 0.6)}` }} /> : null}
                {s.note ? <div style={{ marginTop: 6, fontFamily: FONT.text, fontSize: 28, color: p.muted, maxWidth: "100%", ...oneLine }}>{s.note}</div> : null}
              </div>
              {cards
                ? Array.from({ length: rows }, (_, r) => {
                    const st = seqStyle(ctx, seq, 1 + r, g);
                    const c = cell(g, r);
                    return (
                      <div key={r} style={{ position: "absolute", left: 24, right: 24, top: headH + r * rowH, height: rowH, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", ...css(st) }}>
                        <div style={{ position: "absolute", left: 20, right: 20, top: 0, height: 1.5, background: rgba("#FFFFFF", 0.08) }} />
                        <div style={{ fontFamily: FONT.text, fontSize: 28, color: p.muted, maxWidth: "100%", ...oneLine }}>{props.categories[r] ?? ""}</div>
                        <div style={{ marginTop: 2, fontFamily: FONT.display, fontSize: c.size, lineHeight: 1.05, letterSpacing: "-0.025em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", ...c.style }}>{c.shown}</div>
                      </div>
                    );
                  })
                : null}
            </div>
          );
        })}
        {!cards
          ? Array.from({ length: rows }, (_, r) => {
              const y = headH + r * rowH;
              const lab = enterStyle(ctx, seq.at(1 + r, 0), seq.len, { style: "FADE" });
              return (
                <div key={r} style={{ position: "absolute", left: 0, right: 0, top: y, height: rowH }}>
                  <div style={{ position: "absolute", left: 30, right: 30, top: 0, height: 1.5, background: `linear-gradient(90deg, transparent, ${rgba("#FFFFFF", 0.1)} 20%, ${rgba("#FFFFFF", 0.1)} 80%, transparent)`, opacity: lab.opacity }} />
                  <div style={{ position: "absolute", left: (innerW - midW) / 2, width: midW, top: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", fontFamily: FONT.text, fontSize: 30, lineHeight: 1.2, color: p.muted, opacity: withExit(ctx, lab, seq.flat(1 + r, 0), seq.count).opacity }}>
                    <span style={{ ...clampLines(2), maxWidth: midW - 20 }}>{props.categories[r] ?? ""}</span>
                  </div>
                  {[0, 1].map((g) => {
                    const c = cell(g, r);
                    const st = seqStyle(ctx, seq, 1 + r, g);
                    const dim = dimFor(hl === g, hl !== null, em);
                    return (
                      <div key={g} style={{ position: "absolute", left: g === 0 ? 8 : (innerW + midW) / 2, width: (innerW - midW) / 2 - 8, top: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", opacity: dim }}>
                        <div style={{ fontFamily: FONT.display, fontSize: c.size, lineHeight: 1, letterSpacing: "-0.025em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", ...css(st), ...c.style }}>{c.shown}</div>
                      </div>
                    );
                  })}
                </div>
              );
            })
          : null}
        <div style={{ position: "absolute", left: innerW / 2 - 48, top: vsTop, width: 96, height: 96 }}>
          <VsBadge ctx={ctx} start={seq.at(0, 1)} />
        </div>
      </div>
    </Panel>
  );
}

/** Values compared side by side share one number format: "$2,100 vs $2,940", never
 * "$2.1k vs $2,940" (AUTO compaction decides per value; zeros don't vote). */
function harmonized(ctx: GCtx, all: number[]): GCtx {
  const values = all.filter((v) => v !== 0);
  if (ctx.fmt.compact !== "AUTO" || ctx.fmt.kind === "PERCENT" || values.length < 2) return ctx;
  const plans = values.map((v) => numberPlan(v, ctx.fmt));
  if (plans.every((pl) => pl.divisor === plans[0]!.divisor)) return ctx;
  const maxAbs = Math.max(...values.map(Math.abs));
  if (maxAbs >= 1e5) return ctx;
  return { ...ctx, fmt: { ...ctx.fmt, compact: "NONE" } };
}

// ===================================================================== ENTITY_CARDS
/** 2–6 options as cards: ROW (wraps 3+3), GRID (2 columns), PODIUM (top 3 on steps). */
export function EntityCards({ ctx }: { ctx: GCtx }) {
  if (ctx.variant === "PODIUM") return <Podium ctx={ctx} />;
  const { props, p, frame, fps } = ctx;
  const items = props.items;
  const n = Math.max(1, items.length);
  const pad = 40;
  const innerW = ctx.width - pad * 2;
  const head = headHeight(props);
  const seq = listSequence(items.length, ctx.anim, seqOpts(ctx));
  const hl = hlOf(ctx, items.length);
  const em = emphasisAt(ctx, hl !== null ? seq.at(0, hl) + seq.len : seq.done);
  const grid = ctx.variant === "GRID";
  const gap = 20;
  const cols = grid ? 2 : n <= 3 ? n : Math.ceil(n / 2);
  const rowsN = Math.ceil(n / cols);
  const h = grid ? 280 : rowsN === 1 ? 380 : 300;
  const w = (innerW - gap * (cols - 1)) / cols;
  return (
    <Panel ctx={ctx} pad={pad}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: pad, right: pad, top: pad + head, bottom: pad }}>
        {items.map((it, i) => {
          const r = Math.floor(i / cols);
          const inRow = Math.min(cols, n - r * cols);
          const rowW = inRow * w + (inRow - 1) * gap;
          const x = (innerW - rowW) / 2 + (i - r * cols) * (w + gap);
          const y = r * (h + gap);
          const st = seqStyle(ctx, seq, 0, i, { style: ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter });
          const accent = colorOf(ctx, it.color, i);
          const isH = hl === i;
          const dim = dimFor(isH, hl !== null, em);
          const val = it.value;
          const t = val === null ? null : fmtValue(ctx, counted(ctx, seq.at(0, i), val), val);
          const final = val === null ? "" : fmtValue(ctx, val, val).text;
          const draw = prog(frame, seq.at(0, i), Math.round(0.6 * fps), ctx.ease);
          const glow = isH ? em.on : 0;
          const bg = tile(ctx, isH ? accent : null, 28, 1 + 0.6 * glow);
          const big = !grid && rowsN === 1;
          const valueSize = fitSize(final, w - 48, big ? (n === 2 ? 92 : 72) : grid ? 64 : 58, 36, 0.6);
          return (
            <div key={i} style={{ position: "absolute", left: x, top: y, width: w, height: h, ...css(st), opacity: st.opacity * dim }}>
              <div style={{ position: "absolute", inset: 0, ...bg, boxShadow: [bg.boxShadow, glowShadow(accent, glow)].filter(Boolean).join(", "), transform: emScale(isH, em) }} />
              <div style={{ position: "absolute", left: 28, right: 28, top: 0, height: 3, borderRadius: 3, background: `linear-gradient(90deg, ${rgba(accent, 0)}, ${rgba(accent, 0.85)}, ${rgba(accent, 0)})`, opacity: 0.5 + 0.5 * glow }} />
              {grid ? (
                <div style={{ position: "absolute", inset: 0, padding: "26px 28px 24px", display: "flex", flexDirection: "column", transform: emScale(isH, em) }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    {it.icon ? <IconTile icon={it.icon} accent={accent} size={64} draw={draw} /> : <div style={{ width: 14, height: 14, borderRadius: 99, background: accent, boxShadow: `0 0 16px ${rgba(accent, 0.6)}` }} />}
                    <div style={{ flex: 1, minWidth: 0, fontFamily: FONT.displayBold, fontSize: fitSize(it.text, w - 140, 36, 28, 0.56), color: p.ink, lineHeight: 1.2, ...clampLines(2) }}>{it.text}</div>
                  </div>
                  <div style={{ flex: 1 }} />
                  {t ? <div style={{ fontFamily: FONT.display, fontSize: valueSize, lineHeight: 1, letterSpacing: "-0.03em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", ...valueFace(ctx, val!, accent, isH || hl === null, p.ink) }}>{t.text}</div> : null}
                  {it.sub ? <div style={{ marginTop: 8, fontFamily: FONT.text, fontSize: 28, color: p.muted, ...oneLine }}>{it.sub}</div> : null}
                </div>
              ) : (
                <div style={{ position: "absolute", inset: 0, padding: "0 20px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", transform: emScale(isH, em) }}>
                  {it.icon ? <IconTile icon={it.icon} accent={accent} size={big ? 84 : 70} draw={draw} /> : <div style={{ width: 16, height: 16, borderRadius: 99, background: accent, boxShadow: `0 0 18px ${rgba(accent, 0.6)}` }} />}
                  <div style={{ marginTop: big ? 20 : 14, fontFamily: FONT.displayBold, fontSize: fitSize(it.text, w - 40, big ? 38 : 34, 28, 0.56), lineHeight: 1.2, color: p.ink, maxWidth: w - 36, ...clampLines(2) }}>{it.text}</div>
                  {t ? <div style={{ marginTop: big ? 14 : 8, fontFamily: FONT.display, fontSize: valueSize, lineHeight: 1, letterSpacing: "-0.03em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", ...valueFace(ctx, val!, accent, isH || hl === null, p.ink) }}>{t.text}</div> : null}
                  {it.sub ? <div style={{ marginTop: 10, fontFamily: FONT.text, fontSize: 28, color: p.muted, maxWidth: w - 36, ...oneLine }}>{it.sub}</div> : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/** Top 3 on a podium — 2nd left, 1st centre (tallest), 3rd right — in medal colours. */
function Podium({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps, f } = ctx;
  const order = rankOrder(props.items).slice(0, 3);
  const pad = 40;
  const innerW = ctx.width - pad * 2;
  const head = headHeight(props);
  const bodyH = ctx.height - pad * 2 - head;
  const n = order.length;
  // Reveal bronze → silver → gold (the winner lands last).
  const seq = listSequence(n, ctx.anim, seqOpts(ctx));
  const revealIdx = (rank: number) => n - 1 - rank;
  const em = emphasisAt(ctx, seq.done);
  const gap = 24;
  const colW = (innerW - gap * 2) / 3;
  const slots = [1, 0, 2]; // left = 2nd, centre = 1st, right = 3rd
  const heights = [250, 180, 130];
  return (
    <Panel ctx={ctx} pad={pad}>
      <Header ctx={ctx} align="center" />
      <div style={{ position: "absolute", left: pad, right: pad, top: pad + head, height: bodyH }}>
        <div style={{ position: "absolute", left: -10, right: -10, bottom: 0, height: 2, background: `linear-gradient(90deg, transparent, ${rgba("#FFFFFF", 0.16)}, transparent)` }} />
        {slots.map((rank, col) => {
          const idx = order[rank];
          if (idx === undefined) return null;
          const it = props.items[idx]!;
          const k = revealIdx(rank);
          const start = seq.at(0, k);
          const medal = MEDALS[rank]!;
          const accent = it.color === "AUTO" ? medal : colorOf(ctx, it.color, rank);
          const x = col * (colW + gap);
          const ph = heights[rank]!;
          const grow = springAt(frame, fps, start, f.springs.settle, Math.round(seq.len * 1.6));
          const above = seqStyle(ctx, seq, 0, k, { style: "RISE" });
          const exitOnly = withExit(ctx, { opacity: 1, transform: "none" }, seq.flat(0, k), seq.count);
          const val = it.value;
          const t = val === null ? null : fmtValue(ctx, counted(ctx, start + Math.round(seq.len * 0.4), val), val);
          const final = val === null ? "" : fmtValue(ctx, val, val).text;
          const win = rank === 0;
          const g = win ? em.on : 0;
          return (
            <div key={rank} style={{ position: "absolute", left: x, width: colW, top: 0, bottom: 0, opacity: exitOnly.opacity }}>
              {/* pedestal */}
              <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: ph, transformOrigin: "50% 100%", transform: `scaleY(${r1(clamp01(Math.max(0, grow)) * 1000) / 1000})`, borderRadius: "26px 26px 8px 8px", background: `linear-gradient(180deg, ${rgba(medal, 0.34 + 0.12 * g)} 0%, ${rgba(medal, 0.1)} 55%, ${rgba(medal, 0.03)} 100%)`, boxShadow: [`inset 0 0 0 1.5px ${rgba(medal, 0.45)}`, `inset 0 2px 0 ${rgba("#FFFFFF", 0.22)}`, glowShadow(medal, g, 0.8)].filter(Boolean).join(", ") }}>
                <div style={{ position: "absolute", left: 0, right: 0, top: 14, textAlign: "center", fontFamily: FONT.display, fontSize: win ? 120 : 92, lineHeight: 1, letterSpacing: "-0.04em", backgroundImage: `linear-gradient(180deg, ${mix(medal, "#FFFFFF", 0.5)}, ${rgba(medal, 0.25)})`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", opacity: prog(frame, start + 4, 12, ctx.ease) }}>{rank + 1}</div>
              </div>
              {/* the entity above its step */}
              <div style={{ position: "absolute", left: -6, right: -6, bottom: ph + 22, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", ...css(above), transform: [css(above).transform, win && em.scale !== 1 ? `scale(${em.scale})` : ""].filter(Boolean).join(" ") || undefined }}>
                {it.icon ? <IconTile icon={it.icon} accent={accent} size={win ? 88 : 74} draw={prog(frame, start, Math.round(0.6 * fps), ctx.ease)} strength={1 + 0.4 * g} /> : <Medal rank={rank} size={win ? 80 : 66} />}
                <div style={{ marginTop: 14, fontFamily: FONT.displayBold, fontSize: fitSize(it.text, colW, win ? 38 : 34, 28, 0.56), lineHeight: 1.2, color: p.ink, maxWidth: colW + 6, ...clampLines(2) }}>{it.text}</div>
                {t ? <div style={{ marginTop: 8, fontFamily: FONT.display, fontSize: fitSize(final, colW, win ? 68 : 54, 36, 0.6), lineHeight: 1, letterSpacing: "-0.03em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", ...valueFace(ctx, val!, win ? p.primary : medal, win, mix(medal, "#FFFFFF", 0.35)), filter: win ? `drop-shadow(0 0 ${r1(8 + 16 * g)}px ${rgba(p.primary, 0.35)})` : undefined }}>{t.text}</div> : null}
                {it.sub ? <div style={{ marginTop: 6, fontFamily: FONT.text, fontSize: 28, color: p.muted, maxWidth: colW, ...oneLine }}>{it.sub}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ===================================================================== BEFORE_AFTER
/** Then → now. SIDE: muted "before" panel → arrow → glowing "after"; STACKED: top → bottom. */
export function BeforeAfter({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const before = props.items[0];
  const after = props.items[1];
  const pad = 40;
  const innerW = ctx.width - pad * 2;
  const head = headHeight(props);
  const bodyH = ctx.height - pad * 2 - head;
  const stacked = ctx.variant === "STACKED";
  const seq = listSequence(3, { ...ctx.anim, order: ctx.anim.order === "TOGETHER" ? "TOGETHER" : "ONE_BY_ONE" }, seqOpts(ctx));
  const em = emphasisAt(ctx, seq.at(0, 2) + seq.len);
  const arrowT = prog(frame, seq.at(0, 1), seq.len, ctx.ease);
  const arrowX = withExit(ctx, { opacity: 1, transform: "none" }, 1, 3);
  const av = after?.value ?? null;
  const bv = before?.value ?? null;
  const up = av !== null && bv !== null ? av >= bv : true;
  const arrowColor = up ? p.primary : p.negative;

  const panel = (it: Item | undefined, which: 0 | 1, w: number, h: number) => {
    if (!it) return null;
    const isAfter = which === 1;
    const k = isAfter ? 2 : 0;
    const st = seqStyle(ctx, seq, 0, k, { style: isAfter && ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter });
    const accent = isAfter ? colorOf(ctx, it.color === "AUTO" ? "PRIMARY" : it.color, 0) : it.color === "AUTO" ? p.muted : colorOf(ctx, it.color, 0);
    const val = it.value;
    const from = isAfter && bv !== null ? bv : 0;
    const t = val === null ? null : fmtValue(ctx, counted(ctx, seq.at(0, k), val, from, 1.6, seq.len), val);
    const final = val === null ? "" : fmtValue(ctx, val, val).text;
    const g = isAfter ? em.on : 0;
    const bg = isAfter ? tile(ctx, accent, 34, 1 + 0.5 * g) : tile(ctx, null, 34);
    const draw = prog(frame, seq.at(0, k), Math.round(0.6 * fps), ctx.ease);
    const label = (
      <div style={{ display: "inline-flex", alignItems: "center", gap: 12, padding: "8px 20px", borderRadius: 999, background: isAfter ? rgba(accent, 0.16) : rgba("#FFFFFF", 0.07), boxShadow: `inset 0 0 0 1.5px ${isAfter ? rgba(accent, 0.45) : rgba("#FFFFFF", 0.1)}`, maxWidth: stacked ? w - 260 : w - 60, boxSizing: "border-box" }}>
        <div style={{ width: 10, height: 10, flex: "none", borderRadius: 99, background: isAfter ? accent : p.muted, boxShadow: isAfter ? `0 0 12px ${rgba(accent, 0.8)}` : undefined }} />
        <span style={{ fontFamily: FONT.text, fontSize: 30, color: isAfter ? p.ink : p.muted, ...oneLine }}>{it.text}</span>
      </div>
    );
    const valueEl = t ? (
      <div style={{ fontFamily: FONT.display, fontSize: fitSize(final, stacked ? w * 0.5 : w - 60, stacked ? 84 : isAfter ? 100 : 88, 40, 0.6), lineHeight: 1, letterSpacing: "-0.035em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", ...(isAfter ? valueFace(ctx, val!, accent, true, p.ink) : { color: val! < 0 && ctx.fmt.negativeRed ? mix(p.negative, p.muted, 0.25) : mix(p.ink, p.muted, 0.55) }), filter: isAfter ? `drop-shadow(0 0 ${r1(10 + 20 * g)}px ${rgba(accent, 0.3 + 0.2 * g)})` : undefined }}>{t.text}</div>
    ) : null;
    return (
      <div style={{ position: "relative", width: w, height: h, flex: "none", ...css(st), transform: [css(st).transform, isAfter && em.scale !== 1 ? `scale(${em.scale})` : ""].filter(Boolean).join(" ") || undefined }}>
        <div style={{ position: "absolute", inset: 0, ...bg, boxShadow: [bg.boxShadow, isAfter ? glowShadow(accent, g) : null].filter(Boolean).join(", "), opacity: isAfter ? 1 : 0.92 }} />
        {stacked ? (
          <div style={{ position: "absolute", inset: 0, padding: "0 34px", display: "flex", alignItems: "center", gap: 24 }}>
            {it.icon ? <IconTile icon={it.icon} accent={accent} size={76} draw={draw} strength={isAfter ? 1 : 0.7} /> : null}
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
              {label}
              {it.sub ? <div style={{ fontFamily: FONT.text, fontSize: 28, lineHeight: 1.2, color: p.muted, ...clampLines(2) }}>{it.sub}</div> : null}
            </div>
            {valueEl}
          </div>
        ) : (
          <div style={{ position: "absolute", inset: 0, padding: "32px 28px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: 22 }}>
            {label}
            {it.icon ? <IconTile icon={it.icon} accent={accent} size={84} draw={draw} strength={isAfter ? 1 : 0.7} /> : null}
            {valueEl}
            {it.sub ? <div style={{ fontFamily: FONT.text, fontSize: 28, lineHeight: 1.2, color: p.muted, maxWidth: w - 50, ...clampLines(2) }}>{it.sub}</div> : null}
          </div>
        )}
      </div>
    );
  };

  const arrowSize = stacked ? 92 : 84;
  const arrow = (
    <div style={{ width: arrowSize, height: arrowSize, flex: "none", borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(160deg, ${rgba(arrowColor, 0.28)}, ${rgba(arrowColor, 0.1)})`, boxShadow: `inset 0 0 0 1.5px ${rgba(arrowColor, 0.5)}, 0 0 ${r1(26 * arrowT)}px ${rgba(arrowColor, 0.3)}`, opacity: clamp01(arrowT * 1.5) * arrowX.opacity, transform: `scale(${r1((0.6 + 0.4 * arrowT) * 100) / 100})` }}>
      <svg width={arrowSize * 0.5} height={arrowSize * 0.5} viewBox="0 0 24 24" style={{ overflow: "visible", transform: stacked ? "rotate(90deg)" : undefined }}>
        <path d="M3.5 12h16M13 5.5l6.5 6.5l-6.5 6.5" fill="none" stroke={arrowColor} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={arrowT >= 1 ? undefined : "1 1"} strokeDashoffset={arrowT >= 1 ? undefined : 1 - arrowT} />
      </svg>
    </div>
  );

  if (stacked) {
    const gapA = 22;
    const h = (bodyH - arrowSize - gapA * 2) / 2;
    return (
      <Panel ctx={ctx} pad={pad}>
        <Header ctx={ctx} />
        <div style={{ position: "absolute", left: pad, right: pad, top: pad + head, height: bodyH, display: "flex", flexDirection: "column", alignItems: "center", gap: gapA }}>
          {panel(before, 0, innerW, h)}
          {arrow}
          {panel(after, 1, innerW, h)}
        </div>
      </Panel>
    );
  }
  const gapA = 18;
  const w = (innerW - arrowSize - gapA * 2) / 2;
  return (
    <Panel ctx={ctx} pad={pad}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: pad, right: pad, top: pad + head, height: bodyH, display: "flex", alignItems: "center", gap: gapA }}>
        {panel(before, 0, w, bodyH)}
        {arrow}
        {panel(after, 1, w, bodyH)}
      </div>
    </Panel>
  );
}

// ===================================================================== STEPS
/** Ordered steps: VERTICAL line that fills, HORIZONTAL track, ROADMAP winding path. */
export function Steps({ ctx }: { ctx: GCtx }) {
  const uid = sid(useId());
  const { props } = ctx;
  const items = props.items;
  const seq = listSequence(items.length, ctx.anim, seqOpts(ctx));
  const hl = hlOf(ctx, items.length);
  const em = emphasisAt(ctx, hl !== null ? seq.at(0, hl) + seq.len : seq.done);
  const pad = 40;
  const head = headHeight(props);
  const innerW = ctx.width - pad * 2;
  const bodyH = ctx.height - pad * 2 - head;
  const v = ctx.variant;
  return (
    <Panel ctx={ctx} pad={pad}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: pad, right: pad, top: pad + head, height: bodyH }}>
        {v === "HORIZONTAL" ? (
          <StepsHorizontal ctx={ctx} seq={seq} hl={hl} em={em} w={innerW} h={bodyH} />
        ) : v === "ROADMAP" ? (
          <StepsRoadmap ctx={ctx} seq={seq} hl={hl} em={em} w={innerW} h={bodyH} uid={uid} />
        ) : (
          <StepsVertical ctx={ctx} seq={seq} hl={hl} em={em} w={innerW} h={bodyH} />
        )}
      </div>
    </Panel>
  );
}

interface StepProps {
  ctx: GCtx;
  seq: GraphicSequence;
  hl: number | null;
  em: Emphasis;
  w: number;
  h: number;
}

/** A step's node: a ring that lights into a filled accent disc; number or icon inside. */
function StepNode({ ctx, it, i, start, size, accent, isH, em }: { ctx: GCtx; it: Item; i: number; start: number; size: number; accent: string; isH: boolean; em: Emphasis }) {
  const { frame, fps, f, p } = ctx;
  const lit = prog(frame, start, Math.round(0.35 * fps), ctx.ease);
  const s = springAt(frame, fps, start, f.springs.soft, Math.round(0.7 * fps));
  const g = isH ? em.on : 0;
  const ring = em.ring > 0 && isH ? em.ring : 0;
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none", transform: `scale(${r1((0.82 + 0.18 * Math.min(1.08, Math.max(0, s))) * (isH ? em.scale : 1) * 1000) / 1000}) translateX(${isH ? r1(em.shakeX) : 0}px)` }}>
      <div style={{ position: "absolute", inset: 0, borderRadius: 999, background: "#121219", boxShadow: `inset 0 0 0 2.5px ${rgba(p.ink, 0.18)}` }} />
      <div style={{ position: "absolute", inset: 0, borderRadius: 999, opacity: lit, background: `linear-gradient(160deg, ${mix(accent, "#FFFFFF", 0.25)}, ${mix(accent, "#000000", 0.12)})`, boxShadow: [`0 0 ${r1(18 + 20 * g)}px ${rgba(accent, 0.45 + 0.25 * g)}`, `inset 0 1.5px 0 ${rgba("#FFFFFF", 0.4)}`].join(", ") }} />
      {ring > 0 ? <div style={{ position: "absolute", inset: -ring * 22, borderRadius: 999, boxShadow: `0 0 0 3px ${rgba(accent, 0.7 * (1 - ring))}` }} /> : null}
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, fontSize: Math.round(size * 0.44), color: lit > 0.5 ? DARK : p.muted, letterSpacing: "-0.02em" }}>
        {it.icon ? <GIcon icon={it.icon} size={Math.round(size * 0.52)} color={lit > 0.5 ? DARK : p.muted} stroke={2.1} draw={prog(frame, start, Math.round(0.6 * fps), ctx.ease)} /> : i + 1}
      </div>
    </div>
  );
}

function stepValue(ctx: GCtx, it: Item, start: number, len: number): string | null {
  if (it.value === null) return null;
  return fmtValue(ctx, counted(ctx, start, it.value, 0, 1.2, len), it.value).text;
}

function ValueChip({ text, accent }: { text: string; accent: string }) {
  return <div style={{ display: "inline-block", padding: "4px 14px", borderRadius: 999, background: rgba(accent, 0.14), boxShadow: `inset 0 0 0 1.5px ${rgba(accent, 0.4)}`, fontFamily: FONT.display, fontSize: 30, color: accent, letterSpacing: "-0.01em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{text}</div>;
}

/** Line fill 0..1 between first and last node, reaching node i as it lights. */
function trackFill(ctx: GCtx, seq: GraphicSequence, n: number): number {
  if (n <= 1) return 0;
  let fill = 0;
  for (let i = 1; i < n; i++) {
    const lead = Math.max(4, Math.round(seq.len * 0.7));
    fill += prog(ctx.frame, seq.at(0, i) - lead, lead, ctx.ease) / (n - 1);
  }
  return fill;
}

function StepsVertical({ ctx, seq, hl, em, w, h }: StepProps) {
  const { props, p } = ctx;
  const items = props.items;
  const n = Math.max(1, items.length);
  const node = 76;
  const rowH = n > 1 ? Math.min(150, (h - node) / (n - 1)) : h;
  const textX = node + 34;
  const fill = trackFill(ctx, seq, items.length);
  const lineTop = node / 2;
  const lineLen = (items.length - 1) * rowH;
  const lineIn = withExit(ctx, enterStyle(ctx, seq.first, seq.len, { style: "FADE" }), 0, seq.count).opacity;
  return (
    <>
      {items.length > 1 ? (
        <>
          <div style={{ position: "absolute", left: node / 2 - 2, top: lineTop, width: 4, height: lineLen, borderRadius: 4, background: rgba(p.ink, 0.12), opacity: lineIn }} />
          <div style={{ position: "absolute", left: node / 2 - 2, top: lineTop, width: 4, height: lineLen, borderRadius: 4, background: `linear-gradient(180deg, ${p.primary}, ${mix(p.primary, p.secondary, 0.6)})`, boxShadow: `0 0 14px ${rgba(p.primary, 0.5)}`, transformOrigin: "50% 0", transform: `scaleY(${r1(fill * 1000) / 1000})`, opacity: lineIn }} />
        </>
      ) : null}
      {items.map((it, i) => {
        const y = i * rowH;
        const st = seqStyle(ctx, seq, 0, i, { style: ctx.anim.enter === "RISE" ? "SLIDE" : ctx.anim.enter });
        const isH = hl === i;
        const dim = dimFor(isH, hl !== null, em);
        const accent = accentOf(ctx, it.color, p.primary);
        const val = stepValue(ctx, it, seq.at(0, i), seq.len);
        const exitO = withExit(ctx, { opacity: 1, transform: "none" }, seq.flat(0, i), seq.count).opacity;
        const textW = w - textX - (val ? 170 : 0);
        return (
          <div key={i} style={{ position: "absolute", left: 0, right: 0, top: y, height: Math.min(rowH, h - y), opacity: dim }}>
            <div style={{ position: "absolute", left: 0, top: 0, opacity: exitO }}>
              <StepNode ctx={ctx} it={it} i={i} start={seq.at(0, i)} size={node} accent={accent} isH={isH} em={em} />
            </div>
            <div style={{ position: "absolute", left: textX, width: textW, top: it.sub ? 0 : 0, minHeight: node, display: "flex", flexDirection: "column", justifyContent: "center", ...css(st) }}>
              <div style={{ fontFamily: FONT.displayBold, fontSize: fitSize(it.text, textW * 1.7, 42, 32, 0.55), lineHeight: 1.2, color: isH ? mix(p.ink, accent, 0.25 * em.on) : p.ink, letterSpacing: "-0.01em", ...clampLines(it.sub ? 1 : 2) }}>{it.text}</div>
              {it.sub ? <div style={{ marginTop: 6, fontFamily: FONT.text, fontSize: 30, lineHeight: 1.15, color: p.muted, ...clampLines(rowH >= 140 ? 2 : 1) }}>{it.sub}</div> : null}
            </div>
            {val ? (
              <div style={{ position: "absolute", right: 0, top: node / 2 - 22, ...css(st) }}>
                <ValueChip text={val} accent={accent} />
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function StepsHorizontal({ ctx, seq, hl, em, w, h }: StepProps) {
  const { props, p } = ctx;
  const items = props.items;
  const n = Math.max(1, items.length);
  const colW = w / n;
  const node = n >= 6 ? 76 : n >= 5 ? 84 : 92;
  const cy = Math.min(90, h * 0.24);
  const fill = trackFill(ctx, seq, items.length);
  const x0 = colW / 2;
  const len = (items.length - 1) * colW;
  const lineIn = withExit(ctx, enterStyle(ctx, seq.first, seq.len, { style: "FADE" }), 0, seq.count).opacity;
  return (
    <>
      {items.length > 1 ? (
        <>
          <div style={{ position: "absolute", left: x0, top: cy - 2, width: len, height: 4, borderRadius: 4, background: rgba(p.ink, 0.12), opacity: lineIn }} />
          <div style={{ position: "absolute", left: x0, top: cy - 2, width: len, height: 4, borderRadius: 4, background: `linear-gradient(90deg, ${p.primary}, ${mix(p.primary, p.secondary, 0.6)})`, boxShadow: `0 0 14px ${rgba(p.primary, 0.5)}`, transformOrigin: "0 50%", transform: `scaleX(${r1(fill * 1000) / 1000})`, opacity: lineIn }} />
        </>
      ) : null}
      {items.map((it, i) => {
        const st = seqStyle(ctx, seq, 0, i);
        const isH = hl === i;
        const dim = dimFor(isH, hl !== null, em);
        const accent = accentOf(ctx, it.color, p.primary);
        const val = stepValue(ctx, it, seq.at(0, i), seq.len);
        const exitO = withExit(ctx, { opacity: 1, transform: "none" }, seq.flat(0, i), seq.count).opacity;
        const tw = colW - 14;
        return (
          <div key={i} style={{ position: "absolute", left: i * colW, width: colW, top: 0, bottom: 0, opacity: dim }}>
            <div style={{ position: "absolute", left: (colW - node) / 2, top: cy - node / 2, opacity: exitO }}>
              <StepNode ctx={ctx} it={it} i={i} start={seq.at(0, i)} size={node} accent={accent} isH={isH} em={em} />
            </div>
            <div style={{ position: "absolute", left: 7, right: 7, top: cy + node / 2 + 24, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", ...css(st) }}>
              <div style={{ fontFamily: FONT.displayBold, fontSize: fitSize(it.text, tw * 1.6, n >= 5 ? 32 : 36, 28, 0.55), lineHeight: 1.2, color: p.ink, maxWidth: tw, ...clampLines(2) }}>{it.text}</div>
              {it.sub ? <div style={{ marginTop: 8, fontFamily: FONT.text, fontSize: 28, lineHeight: 1.15, color: isH ? accent : p.muted, maxWidth: tw, ...clampLines(2) }}>{it.sub}</div> : null}
              {val ? <div style={{ marginTop: 10 }}><ValueChip text={val} accent={accent} /></div> : null}
            </div>
          </div>
        );
      })}
    </>
  );
}

function StepsRoadmap({ ctx, seq, hl, em, w, h, uid }: StepProps & { uid: string }) {
  const { props, p, frame } = ctx;
  const items = props.items;
  const n = items.length;
  const node = 72;
  const cx = w / 2;
  const amp = Math.min(110, w * 0.12);
  const rowH = n > 0 ? h / n : h;
  const pts = items.map((_, i) => ({ x: i % 2 === 0 ? cx - amp : cx + amp, y: rowH * (i + 0.5) }));
  const all = [{ x: cx, y: 0 }, ...pts, { x: cx, y: h }];
  // S-curves with vertical tangents; arc length sampled so the draw reaches each node on time.
  let d = `M${r1(all[0]!.x)} ${r1(all[0]!.y)}`;
  const segLen: number[] = [];
  for (let k = 1; k < all.length; k++) {
    const a = all[k - 1]!;
    const b = all[k]!;
    const dy = b.y - a.y;
    const c1 = { x: a.x, y: a.y + dy * 0.55 };
    const c2 = { x: b.x, y: b.y - dy * 0.55 };
    d += ` C${r1(c1.x)} ${r1(c1.y)} ${r1(c2.x)} ${r1(c2.y)} ${r1(b.x)} ${r1(b.y)}`;
    let L = 0;
    let prev = a;
    for (let s = 1; s <= 24; s++) {
      const t = s / 24;
      const u = 1 - t;
      const q = { x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y };
      L += Math.hypot(q.x - prev.x, q.y - prev.y);
      prev = q;
    }
    segLen.push(L);
  }
  const total = Math.max(1, segLen.reduce((a, b) => a + b, 0));
  const lead = Math.max(4, Math.round(seq.len * 0.8));
  let drawn = 0;
  segLen.forEach((L, k) => {
    // segment k ends at node k (k < n) or at the tail (k === n)
    const at = k < n ? seq.at(0, k) : seq.done;
    drawn += (L / total) * prog(frame, at - lead, lead, ctx.ease);
  });
  const exitAll = withExit(ctx, { opacity: 1, transform: "none" }, 0, seq.count).opacity;
  const gid = `rm-${uid}`;
  const labelW = cx - amp - node / 2 - 26;
  return (
    <>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: "absolute", left: 0, top: 0, overflow: "visible", opacity: exitAll }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2={h} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={p.primary} stopOpacity={0} />
            <stop offset="0.07" stopColor={p.primary} />
            <stop offset="0.93" stopColor={mix(p.primary, p.secondary, 0.7)} />
            <stop offset="1" stopColor={mix(p.primary, p.secondary, 0.7)} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={d} fill="none" stroke={rgba(p.ink, 0.12)} strokeWidth={10} strokeLinecap="round" strokeDasharray="2 18" />
        <path d={d} fill="none" stroke={`url(#${gid})`} strokeWidth={9} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={r1((1 - drawn) * 10000) / 10000} style={{ filter: `drop-shadow(0 0 10px ${rgba(p.primary, 0.45)})` }} />
      </svg>
      {items.map((it, i) => {
        const pt = pts[i]!;
        const left = i % 2 === 0;
        const st = seqStyle(ctx, seq, 0, i, { style: ctx.anim.enter === "RISE" ? "FADE" : ctx.anim.enter });
        const isH = hl === i;
        const dim = dimFor(isH, hl !== null, em);
        const accent = accentOf(ctx, it.color, p.primary);
        const val = stepValue(ctx, it, seq.at(0, i), seq.len);
        const exitO = withExit(ctx, { opacity: 1, transform: "none" }, seq.flat(0, i), seq.count).opacity;
        const slide = (1 - prog(frame, seq.at(0, i), seq.len, ctx.ease)) * 26 * ctx.f.distance * (left ? -1 : 1);
        return (
          <div key={i} style={{ opacity: dim }}>
            <div style={{ position: "absolute", left: pt.x - node / 2, top: pt.y - node / 2, opacity: exitO }}>
              <StepNode ctx={ctx} it={it} i={i} start={seq.at(0, i)} size={node} accent={accent} isH={isH} em={em} />
            </div>
            <div style={{ position: "absolute", top: pt.y - rowH / 2 + 8, height: rowH - 16, width: labelW, ...(left ? { left: 0, alignItems: "flex-end", textAlign: "right" } : { left: pt.x + node / 2 + 26, alignItems: "flex-start", textAlign: "left" }), display: "flex", flexDirection: "column", justifyContent: "center", ...css(st), transform: `translateX(${r1(slide)}px)` }}>
              <div style={{ fontFamily: FONT.displayBold, fontSize: fitSize(it.text, labelW * 1.6, 42, 30, 0.55), lineHeight: 1.2, color: isH || i === n - 1 ? mix(p.ink, p.primary, 0.35) : p.ink, letterSpacing: "-0.01em", maxWidth: labelW, ...clampLines(2) }}>{it.text}</div>
              {it.sub ? <div style={{ marginTop: 6, fontFamily: FONT.text, fontSize: 28, lineHeight: 1.18, color: p.muted, maxWidth: labelW, ...clampLines(rowH >= 150 ? 2 : 1) }}>{it.sub}</div> : null}
              {val ? <div style={{ marginTop: 8 }}><ValueChip text={val} accent={accent} /></div> : null}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ===================================================================== CHECKLIST
/** Do's and don'ts: CHECK (✓ / ○ / ✕ by state), NUMBERED, BULLETS; rows reveal in turn. */
export function Checklist({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps, f } = ctx;
  const items = props.items;
  const pad = 40;
  const innerW = ctx.width - pad * 2;
  const head = headHeight(props);
  const anySub = items.some((it) => it.sub);
  const rowStep = anySub ? 140 : 112;
  const rowH = rowStep - 14;
  const seq = listSequence(items.length, ctx.anim, seqOpts(ctx));
  const hl = hlOf(ctx, items.length);
  const em = emphasisAt(ctx, hl !== null ? seq.at(0, hl) + seq.len : seq.done);
  const v = ctx.variant;
  const mark = 62;
  return (
    <Panel ctx={ctx} pad={pad}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: pad, right: pad, top: pad + head, bottom: pad }}>
        {items.map((it, i) => {
          const st = seqStyle(ctx, seq, 0, i, { style: ctx.anim.enter === "RISE" ? "SLIDE" : ctx.anim.enter });
          const start = seq.at(0, i);
          const isH = hl === i;
          const dim = dimFor(isH, hl !== null, em);
          const state = v === "CHECK" ? (it.state === "NONE" ? "DONE" : it.state) : "NONE";
          const tone = state === "NO" ? p.negative : state === "TODO" ? p.muted : accentOf(ctx, it.color, v === "CHECK" ? p.positive : p.primary);
          const g = isH ? em.on : 0;
          const bg = tile(ctx, isH ? tone : null, 24, 1 + 0.5 * g);
          const pop = springAt(frame, fps, start + 3, f.springs.soft, Math.round(0.6 * fps));
          const drawT = prog(frame, start + Math.round(seq.len * 0.35), Math.round(0.45 * fps), ctx.ease);
          const scale = r1((0.6 + 0.4 * Math.min(1.1, Math.max(0, pop))) * 1000) / 1000;
          let marker: ReactElement;
          if (v === "NUMBERED") {
            marker = <div style={{ width: mark, height: mark, borderRadius: 18, display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(160deg, ${rgba(tone, 0.26)}, ${rgba(tone, 0.08)})`, boxShadow: `inset 0 0 0 1.5px ${rgba(tone, 0.5)}`, fontFamily: FONT.display, fontSize: 36, color: tone, transform: `scale(${scale})` }}>{i + 1}</div>;
          } else if (v === "BULLETS") {
            marker = (
              <div style={{ width: mark, height: mark, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ width: 20, height: 20, borderRadius: 99, background: tone, boxShadow: `0 0 ${r1(14 + 10 * g)}px ${rgba(tone, 0.7)}`, transform: `scale(${scale})` }} />
              </div>
            );
          } else if (state === "TODO") {
            marker = <div style={{ width: mark, height: mark, borderRadius: 999, boxShadow: `inset 0 0 0 3px ${rgba(p.muted, 0.55)}`, transform: `scale(${scale})` }} />;
          } else {
            const no = state === "NO";
            marker = (
              <div style={{ width: mark, height: mark, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", background: no ? rgba(tone, 0.18) : `linear-gradient(160deg, ${mix(tone, "#FFFFFF", 0.25)}, ${mix(tone, "#000000", 0.15)})`, boxShadow: no ? `inset 0 0 0 2.5px ${rgba(tone, 0.75)}` : `0 0 ${r1(16 + 14 * g)}px ${rgba(tone, 0.45)}, inset 0 1.5px 0 ${rgba("#FFFFFF", 0.4)}`, transform: `scale(${scale})` }}>
                <GIcon icon={no ? "CROSS" : "CHECK"} size={no ? 32 : 36} color={no ? tone : DARK} stroke={no ? 2.8 : 3} draw={drawT} />
              </div>
            );
          }
          const textW = innerW - mark - 30 - 52;
          return (
            <div key={i} style={{ position: "absolute", left: 0, right: 0, top: i * rowStep, height: rowH, ...css(st), opacity: st.opacity * dim }}>
              <div style={{ position: "absolute", inset: 0, ...bg, boxShadow: [bg.boxShadow, glowShadow(tone, g, 0.7)].filter(Boolean).join(", "), transform: emScale(isH, em) }} />
              <div style={{ position: "absolute", inset: 0, padding: "0 26px", display: "flex", alignItems: "center", gap: 26, transform: [emScale(isH, em), isH && em.shakeX ? `translateX(${r1(em.shakeX)}px)` : ""].filter(Boolean).join(" ") || undefined }}>
                {marker}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: FONT.displayBold, fontSize: fitSize(it.text, textW, 40, 30, 0.55), lineHeight: 1.15, color: state === "TODO" ? mix(p.ink, p.muted, 0.5) : p.ink, letterSpacing: "-0.01em", ...(it.sub ? oneLine : clampLines(2)) }}>{it.text}</div>
                  {it.sub ? <div style={{ marginTop: 4, fontFamily: FONT.text, fontSize: 28, color: p.muted, ...oneLine }}>{it.sub}</div> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ===================================================================== RANKING
/** A leaderboard: BARS (rank, label, proportional bar, value) or MEDALS (top 3 discs). */
export function Ranking({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const items = props.items;
  const order = rankOrder(items);
  const pad = 40;
  const innerW = ctx.width - pad * 2;
  const head = headHeight(props);
  const rowStep = 116;
  const rowH = 100;
  const seq = listSequence(items.length, ctx.anim, seqOpts(ctx));
  const hl = hlOf(ctx, items.length);
  const hlPos = hl === null ? null : order.indexOf(hl);
  const em = emphasisAt(ctx, hlPos !== null ? seq.at(0, hlPos) + seq.len : seq.done);
  const medals = ctx.variant === "MEDALS";
  const maxAbs = Math.max(1e-9, ...items.map((it) => Math.abs(it.value ?? 0)));
  const finals = items.map((it) => (it.value === null ? "" : fmtValue(ctx, it.value, it.value).text));
  const valW = Math.min(240, Math.max(110, Math.max(0, ...finals.map((s) => s.length)) * 0.6 * 44 + 10));
  return (
    <Panel ctx={ctx} pad={pad}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: pad, right: pad, top: pad + head, bottom: pad }}>
        {order.map((idx, pos) => {
          const it = items[idx]!;
          const st = seqStyle(ctx, seq, 0, pos, { style: ctx.anim.enter === "RISE" ? "SLIDE" : ctx.anim.enter });
          const start = seq.at(0, pos);
          const isH = hl === idx;
          const dim = dimFor(isH, hl !== null, em);
          const medal = medals && pos < 3 ? MEDALS[pos]! : null;
          const accent = it.color !== "AUTO" ? colorOf(ctx, it.color, pos) : medal ?? (pos === 0 || isH ? p.primary : mix(p.secondary, "#FFFFFF", 0.25));
          const g = isH ? em.on : 0;
          const lead = pos === 0 && !medals;
          const bg = tile(ctx, isH || (medals && pos === 0) ? accent : null, 24, (isH ? 1 : 0.6) + 0.5 * g);
          const val = it.value;
          const t = val === null ? null : fmtValue(ctx, counted(ctx, start, val, 0, 1.2, seq.len), val);
          const barT = prog(frame, start + 2, Math.round(seq.len * 1.4), ctx.ease);
          const w = val === null ? 0 : Math.abs(val) / maxAbs;
          const labelSize = fitSize(it.text, innerW - 120 - (it.icon ? 66 : 0) - valW - 40, 38, 30, 0.55);
          return (
            <div key={idx} style={{ position: "absolute", left: 0, right: 0, top: pos * rowStep, height: rowH, ...css(st), opacity: st.opacity * dim }}>
              <div style={{ position: "absolute", inset: 0, ...bg, boxShadow: [bg.boxShadow, glowShadow(accent, g, 0.7)].filter(Boolean).join(", "), transform: emScale(isH, em) }} />
              <div style={{ position: "absolute", inset: 0, padding: "0 26px 0 20px", display: "flex", alignItems: "center", gap: 18, transform: emScale(isH, em) }}>
                <div style={{ width: 64, flex: "none", display: "flex", justifyContent: "center" }}>
                  {medal ? <Medal rank={pos} size={58} /> : <div style={{ fontFamily: FONT.display, fontSize: 40, color: lead ? p.primary : p.muted, letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums" }}>{pos + 1}</div>}
                </div>
                {it.icon ? <GIcon icon={it.icon} size={46} color={medal ?? (lead ? p.primary : p.ink)} draw={prog(frame, start, Math.round(0.6 * fps), ctx.ease)} /> : null}
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 10 }}>
                  <div style={{ fontFamily: FONT.displayBold, fontSize: labelSize, lineHeight: 1.2, color: p.ink, letterSpacing: "-0.01em", ...oneLine }}>{it.text}</div>
                  {!medals && val !== null ? (
                    <div style={{ position: "relative", height: 12, borderRadius: 12, background: rgba("#FFFFFF", 0.07) }}>
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${r1(Math.max(0.015, w) * 100)}%`, borderRadius: 12, transformOrigin: "0 50%", transform: `scaleX(${r1(barT * 1000) / 1000})`, background: val < 0 && ctx.fmt.negativeRed ? p.negative : `linear-gradient(90deg, ${rgba(accent, 0.55)}, ${accent})`, boxShadow: lead || isH ? `0 0 14px ${rgba(accent, 0.5)}` : undefined }} />
                    </div>
                  ) : null}
                </div>
                {t ? <div style={{ width: valW, flex: "none", textAlign: "right", fontFamily: FONT.display, fontSize: fitSize(finals[idx]!, valW, 44, 34, 0.6), letterSpacing: "-0.025em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", ...valueFace(ctx, val!, accent, lead || isH || (medals && pos === 0), p.ink) }}>{t.text}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ===================================================================== TABLE
/** Rows × columns: header from categories, row headers from series labels, cells from values
 * (formatted) or texts; CLEAN hairlines or ZEBRA bands; the highlighted row glows. */
export function Table({ ctx }: { ctx: GCtx }) {
  const { props, p } = ctx;
  const series = props.series;
  const cols = Math.max(1, props.categories.length, ...series.map((s) => s.values.length));
  const pad = 40;
  const innerW = ctx.width - pad * 2;
  const head = headHeight(props);
  const headRow = 76;
  const rowH = 96;
  const seq = graphicSequence([cols, ...series.map(() => 1 + cols)], ctx.anim, seqOpts(ctx));
  const hl = hlOf(ctx, series.length);
  const em = emphasisAt(ctx, hl !== null ? seq.groupDone(1 + hl) : seq.done);
  const zebra = ctx.variant === "ZEBRA";
  const longest = Math.max(4, ...series.map((s) => s.label.length));
  const labW = Math.round(Math.min(innerW * 0.38, Math.max(innerW * 0.22, longest * 0.56 * 38 + 40)));
  const cellW = (innerW - labW) / cols;
  // One number format per column ("$1,800 / $500", never "$1.8k / $500").
  const colCtx = Array.from({ length: cols }, (_, j) => harmonized(ctx, series.filter((s) => !s.texts[j]?.trim() && j < s.values.length).map((s) => s.values[j]!)));
  const cellText = (s: Series, j: number): { text: string; value: number | null } => {
    const tx = s.texts[j];
    if (tx && tx.trim()) return { text: tx, value: null };
    if (j >= s.values.length) return { text: "—", value: null };
    return { text: fmtValue(colCtx[j]!, s.values[j]!, s.values[j]!).text, value: s.values[j]! };
  };
  return (
    <Panel ctx={ctx} pad={pad}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: pad, right: pad, top: pad + head, bottom: pad }}>
        {/* header row */}
        {Array.from({ length: cols }, (_, j) => {
          const st = seqStyle(ctx, seq, 0, j, { style: "FADE" });
          const label = props.categories[j] ?? "";
          return (
            <div key={j} style={{ position: "absolute", left: labW + j * cellW, width: cellW, top: 0, height: headRow - 12, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 8px", boxSizing: "border-box", fontFamily: FONT.text, fontSize: fitSize(label.toUpperCase(), cellW - 16, 30, 28, 0.66), letterSpacing: "0.06em", textTransform: "uppercase", color: p.muted, ...oneLine, ...css(st) }}>
              {label}
            </div>
          );
        })}
        <div style={{ position: "absolute", left: 0, right: 0, top: headRow - 8, height: 2, borderRadius: 2, background: `linear-gradient(90deg, ${rgba(p.primary, 0.05)}, ${rgba(p.primary, 0.55)}, ${rgba(p.primary, 0.05)})`, opacity: prog(ctx.frame, seq.first, seq.len, ctx.ease) * withExit(ctx, { opacity: 1, transform: "none" }, 0, seq.count).opacity }} />
        {series.map((s, r) => {
          const g = 1 + r;
          const y = headRow + r * rowH;
          const isH = hl === r;
          const dim = dimFor(isH, hl !== null, em);
          const glow = isH ? em.on : 0;
          const accent = colorOf(ctx, s.color === "AUTO" ? "PRIMARY" : s.color, r);
          const band = enterStyle(ctx, seq.at(g, 0), seq.len, { style: "FADE" });
          const bandO = withExit(ctx, band, seq.flat(g, 0), seq.count).opacity;
          const lab = seqStyle(ctx, seq, g, 0, { style: ctx.anim.enter === "RISE" ? "SLIDE" : ctx.anim.enter });
          const showBand = isH || (zebra && r % 2 === 0);
          const bg = isH ? tile(ctx, accent, 20, 0.6 + 0.8 * glow) : tile(ctx, null, 20, 1);
          return (
            <div key={r} style={{ position: "absolute", left: 0, right: 0, top: y, height: rowH, opacity: dim }}>
              {showBand ? <div style={{ position: "absolute", left: -14, right: -14, top: 6, bottom: 6, ...bg, boxShadow: [bg.boxShadow, glowShadow(accent, glow, 0.7)].filter(Boolean).join(", "), opacity: bandO * (isH ? 1 : 0.85) }} /> : null}
              {!zebra && r > 0 ? <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 1.5, background: rgba("#FFFFFF", 0.08), opacity: bandO }} /> : null}
              <div style={{ position: "absolute", left: 6, width: labW - 12, top: 0, bottom: 0, display: "flex", alignItems: "center", gap: 14, ...css(lab) }}>
                {s.icon ? <GIcon icon={s.icon} size={40} color={isH ? accent : p.muted} /> : null}
                <div style={{ fontFamily: FONT.displayBold, fontSize: fitSize(s.label, labW - 20 - (s.icon ? 54 : 0), 38, 28, 0.56), color: isH ? mix(p.ink, accent, 0.3 * glow) : p.ink, letterSpacing: "-0.01em", ...oneLine }}>{s.label}</div>
              </div>
              {Array.from({ length: cols }, (_, j) => {
                const st = seqStyle(ctx, seq, g, 1 + j);
                const c = cellText(s, j);
                const shown = c.value === null ? c.text : fmtValue(colCtx[j]!, counted(ctx, seq.at(g, 1 + j), c.value, 0, 1.2, seq.len), c.value).text;
                const isNum = c.value !== null;
                const color = c.text === "—" ? p.muted : isNum ? valueColor(ctx, c.value!, isH ? accent : p.ink) : isH ? p.ink : mix(p.ink, p.muted, 0.3);
                return (
                  <div key={j} style={{ position: "absolute", left: labW + j * cellW, width: cellW, top: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 8px", boxSizing: "border-box", ...css(st) }}>
                    <div style={{ fontFamily: isNum ? FONT.display : FONT.text, fontSize: fitSize(c.text, cellW - 18, isNum ? 42 : 34, 28, isNum ? 0.6 : 0.55), letterSpacing: isNum ? "-0.02em" : undefined, color, fontVariantNumeric: isNum ? "tabular-nums" : undefined, maxWidth: "100%", ...oneLine }}>{shown}</div>
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

export const COMPARE_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {
  VERSUS: Versus,
  ENTITY_CARDS: EntityCards,
  BEFORE_AFTER: BeforeAfter,
  STEPS: Steps,
  CHECKLIST: Checklist,
  RANKING: Ranking,
  TABLE: Table,
};
