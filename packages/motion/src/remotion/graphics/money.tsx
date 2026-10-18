import { seriesTotal, valueColumnsCell } from "@chris/media/timeline";
import { graphicSequence, listSequence } from "../../graphics-timing";
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
  type GCtx,
} from "./kit";

const OP: Record<string, string> = { PLUS: "+", MINUS: "−", TIMES: "×", DIVIDE: "÷", EQUALS: "=", NONE: "" };

// ===================================================================== VALUE_COLUMNS
/**
 * People/options side by side, each with its own stack of values above its label — e.g.
 * Employee (4k × 12) · Freelance (lumpy) · Business owner (0, 5k, −15k … 100k). Sequenced
 * per entity by default (GROUP_BY_GROUP): one column fills cell by cell, then the next.
 */
export function ValueColumns({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const series = props.series;
  const n = Math.max(1, series.length);
  const rows = Math.max(1, ...series.map((s) => s.values.length));
  const cell = valueColumnsCell(rows, props.screen === "FULL");
  const font = Math.round(Math.min(54, cell * 0.6));
  const pad = 40;
  const innerW = ctx.width - pad * 2;
  const hasCats = props.categories.length > 0;
  const gutter = hasCats ? 78 : 0;
  const gap = n >= 4 ? 16 : 24;
  const colW = (innerW - gutter - gap * (n - 1)) / n;
  const head = headHeight(props);
  // Groups: per entity, its label first then its cells (+ total).
  const seq = graphicSequence(series.map((s) => s.values.length + 1 + (props.showTotal ? 1 : 0)), ctx.anim, { fps, durationInFrames: ctx.D, exitFrames: ctx.exitFrames, tempo: ctx.f.tempo });
  const maxAbs = Math.max(1e-9, ...series.flatMap((s) => s.values.map(Math.abs)));
  const anyNeg = series.some((s) => s.values.some((v) => v < 0));
  const hl = props.highlight !== null && props.highlight < n ? props.highlight : null;
  const em = emphasisAt(ctx, hl !== null ? seq.groupDone(hl) : seq.done);
  const cardTop = head;
  const cardH = rows * cell + 16;
  const labelTop = cardTop + cardH + 20;
  const bars = ctx.variant === "BARS";
  return (
    <Panel ctx={ctx} pad={pad}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: pad, top: pad, right: pad, bottom: pad }}>
        {hasCats
          ? Array.from({ length: rows }, (_, r) => {
              const o = prog(frame, seq.at(0, 1 + r) - 4, 10, ctx.ease);
              return (
                <div key={r} style={{ position: "absolute", left: 0, width: gutter - 10, top: cardTop + 8 + r * cell, height: cell, display: "flex", alignItems: "center", justifyContent: "flex-end", fontFamily: FONT.text, fontSize: Math.min(30, font - 6), color: p.muted, opacity: o * 0.9, whiteSpace: "nowrap" }}>
                  {props.categories[r] ?? ""}
                </div>
              );
            })
          : null}
        {series.map((s, g) => {
          const x = gutter + g * (colW + gap);
          const accent = colorOf(ctx, s.color, g);
          const isH = hl === g;
          const dim = dimFor(isH, hl !== null, em);
          const lab = seqStyle(ctx, seq, g, 0, { style: "RISE" });
          const cardIn = enterStyle(ctx, seq.at(g, 0), seq.len, { style: "FADE" });
          const total = seriesTotal(s);
          const totalIdx = s.values.length + 1;
          const totalStart = seq.at(g, totalIdx);
          const tv = fmtValue(ctx, counted(ctx, totalStart, total), total);
          const hlGlow = isH ? em.on : 0;
          return (
            <div key={g} style={{ position: "absolute", left: x, top: 0, width: colW, height: "100%", opacity: dim, transform: isH && em.scale !== 1 ? `scale(${em.scale})` : undefined, transformOrigin: "50% 60%" }}>
              {/* the value card */}
              <div style={{ position: "absolute", left: 0, right: 0, top: cardTop, height: cardH, ...tile(ctx, isH ? accent : null, 24, 0.8 + 0.6 * hlGlow), opacity: cardIn.opacity, boxShadow: [tile(ctx, isH ? accent : null).boxShadow, glowShadow(accent, hlGlow, 0.9)].filter(Boolean).join(", ") }} />
              <div style={{ position: "absolute", left: 14, right: 14, top: cardTop, height: 4, borderRadius: 4, background: `linear-gradient(90deg, ${rgba(accent, 0)}, ${rgba(accent, 0.9)}, ${rgba(accent, 0)})`, opacity: cardIn.opacity * 0.8 }} />
              {s.values.map((v, i) => {
                const st = seqStyle(ctx, seq, g, 1 + i);
                const shown = counted(ctx, seq.at(g, 1 + i), v, 0, 1.2, seq.len);
                const t = fmtValue(ctx, shown, v);
                const cellText = s.texts[i];
                const color = v === 0 && !cellText ? p.muted : valueColor(ctx, v, p.ink);
                const w = Math.abs(v) / maxAbs;
                return (
                  <div key={i} style={{ position: "absolute", left: 8, right: 8, top: cardTop + 8 + i * cell, height: cell, ...css(st) }}>
                    {i > 0 ? <div style={{ position: "absolute", left: 10, right: 10, top: 0, height: 1.5, background: rgba("#FFFFFF", 0.06) }} /> : null}
                    {bars ? (
                      <div style={{ position: "absolute", top: cell * 0.2, bottom: cell * 0.2, left: anyNeg ? (v < 0 ? `${50 - 50 * w}%` : "50%") : 8, width: anyNeg ? `${50 * w}%` : `calc(${w * 100}% - 16px)`, borderRadius: 8, background: v < 0 ? rgba(p.negative, 0.4) : rgba(accent, 0.34), transformOrigin: v < 0 ? "right" : "left", transform: `scaleX(${prog(frame, seq.at(g, 1 + i), seq.len, ctx.ease)})` }} />
                    ) : null}
                    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: bars ? "flex-end" : "center", paddingRight: bars ? 14 : 0, fontFamily: FONT.display, fontSize: fitSize(cellText || t.text, colW - 28, font, 26, 0.58), letterSpacing: "-0.02em", color, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", textShadow: color === p.negative ? `0 0 18px ${rgba(p.negative, 0.35)}` : undefined }}>
                      {cellText || t.text}
                    </div>
                  </div>
                );
              })}
              {/* the entity: icon + label (+ note) under its card */}
              <div style={{ position: "absolute", left: -6, right: -6, top: labelTop, display: "flex", flexDirection: "column", alignItems: "center", ...css(lab) }}>
                {s.icon ? (
                  <div style={{ width: 62, height: 62, borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", background: rgba(accent, 0.16), boxShadow: `inset 0 0 0 1.5px ${rgba(accent, 0.45)}` }}>
                    <GIcon icon={s.icon} size={38} color={accent} draw={prog(frame, seq.at(g, 0), Math.round(0.6 * fps), ctx.ease)} />
                  </div>
                ) : (
                  <div style={{ width: 46, height: 6, borderRadius: 6, background: accent, marginTop: 10, marginBottom: 6, boxShadow: `0 0 16px ${rgba(accent, 0.5)}` }} />
                )}
                <div style={{ marginTop: 12, fontFamily: FONT.displayBold, fontSize: fitSize(s.label, colW + 8, 40, 28, 0.56), lineHeight: 1.05, color: p.ink, textAlign: "center", letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>{s.label}</div>
                {s.note ? <div style={{ marginTop: 6, fontFamily: FONT.text, fontSize: 28, color: p.muted, textAlign: "center", whiteSpace: "nowrap", maxWidth: colW + 12, overflow: "hidden", textOverflow: "ellipsis" }}>{s.note}</div> : null}
              </div>
              {props.showTotal ? (
                <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 80, display: "flex", alignItems: "center", justifyContent: "center", ...css(seqStyle(ctx, seq, g, totalIdx, { style: "POP" })) }}>
                  <div style={{ padding: "8px 22px", borderRadius: 999, background: rgba(total < 0 && ctx.fmt.negativeRed ? p.negative : p.primary, 0.14), boxShadow: `inset 0 0 0 2px ${rgba(total < 0 && ctx.fmt.negativeRed ? p.negative : p.primary, 0.5)}`, fontFamily: FONT.display, fontSize: fitSize(tv.text, colW - 40, 44, 28, 0.6), color: valueColor(ctx, total, p.primary), letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>
                    {tv.text}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ===================================================================== MONTH_GRID
export function MonthGrid({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const cal = ctx.variant === "CALENDAR";
  const cols = cal ? 4 : 6;
  const cellH = cal ? 150 : 118;
  const gap = 12;
  const pad = 40;
  const innerW = ctx.width - pad * 2;
  const cellW = (innerW - gap * (cols - 1)) / cols;
  const labels = props.series.length > 1 || props.showTotal;
  const seq = graphicSequence(props.series.map((s) => s.values.length + 1), ctx.anim, { fps, durationInFrames: ctx.D, exitFrames: ctx.exitFrames, tempo: ctx.f.tempo });
  let y = headHeight(props);
  const hlCell = props.highlight;
  return (
    <Panel ctx={ctx} pad={pad}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: pad, top: pad, right: pad, bottom: pad }}>
        {props.series.map((s, g) => {
          const accent = colorOf(ctx, s.color, g);
          const top = y;
          const rowsN = Math.ceil(Math.max(1, s.values.length) / cols);
          y += (labels ? 62 : 0) + rowsN * (cellH + gap) - gap + 22;
          const lab = seqStyle(ctx, seq, g, 0, { style: "SLIDE" });
          const total = seriesTotal(s);
          const tv = fmtValue(ctx, counted(ctx, seq.groupDone(g) - seq.len, total), total);
          return (
            <div key={g}>
              {labels ? (
                <div style={{ position: "absolute", left: 0, right: 0, top, height: 50, display: "flex", alignItems: "center", gap: 14, ...css(lab) }}>
                  {s.icon ? <GIcon icon={s.icon} size={40} color={accent} /> : <div style={{ width: 14, height: 14, borderRadius: 7, background: accent, boxShadow: `0 0 14px ${rgba(accent, 0.6)}` }} />}
                  <div style={{ fontFamily: FONT.displayBold, fontSize: 40, color: p.ink, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>{s.label}</div>
                  <div style={{ flex: 1 }} />
                  {props.showTotal ? <div style={{ fontFamily: FONT.display, fontSize: 42, color: valueColor(ctx, total, p.primary), letterSpacing: "-0.02em", opacity: prog(frame, seq.groupDone(g) - seq.len, 10, ctx.ease) }}>{tv.text}</div> : null}
                </div>
              ) : null}
              {s.values.map((v, i) => {
                const c = i % cols;
                const r = Math.floor(i / cols);
                const st = seqStyle(ctx, seq, g, 1 + i, { style: ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter });
                const t = fmtValue(ctx, counted(ctx, seq.at(g, 1 + i), v, 0, 1.2, seq.len), v);
                const isH = props.series.length === 1 && hlCell === i;
                const em = isH ? emphasisAt(ctx, seq.at(g, 1 + i) + seq.len) : null;
                const color = v === 0 ? p.muted : valueColor(ctx, v, p.ink);
                return (
                  <div key={i} style={{ position: "absolute", left: c * (cellW + gap), top: top + (labels ? 62 : 0) + r * (cellH + gap), width: cellW, height: cellH, ...css(st) }}>
                    <div style={{ position: "absolute", inset: 0, ...tile(ctx, isH ? p.primary : v < 0 && ctx.fmt.negativeRed ? p.negative : null, 20, isH ? 1 + (em?.on ?? 0) : 0.55), boxShadow: isH ? glowShadow(p.primary, em?.on ?? 0) : tile(ctx, v < 0 && ctx.fmt.negativeRed ? p.negative : null, 20, 0.55).boxShadow, transform: em && em.scale !== 1 ? `scale(${em.scale})` : undefined }} />
                    <div style={{ position: "absolute", left: 14, top: 10, fontFamily: FONT.text, fontSize: cal ? 30 : 26, color: p.muted, whiteSpace: "nowrap" }}>{props.categories[i] ?? ""}</div>
                    <div style={{ position: "absolute", left: 6, right: 6, bottom: cal ? 22 : 14, textAlign: "center", fontFamily: FONT.display, fontSize: fitSize(t.text, cellW - 16, cal ? 52 : 40, 26, 0.6), color: isH ? p.primary : color, letterSpacing: "-0.02em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{t.text}</div>
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

// ===================================================================== STAT_TILES
export function StatTiles({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const items = props.items;
  const n = Math.max(1, items.length);
  const pad = 40;
  const innerW = ctx.width - pad * 2;
  const head = headHeight(props);
  const seq = listSequence(n, ctx.anim, { fps, durationInFrames: ctx.D, exitFrames: ctx.exitFrames, tempo: ctx.f.tempo });
  const hl = props.highlight !== null && props.highlight < n ? props.highlight : null;
  const em = emphasisAt(ctx, hl !== null ? seq.at(0, hl) + seq.len : seq.done);
  const v = ctx.variant;
  const gap = 20;
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  if (v === "STACK") {
    for (let i = 0; i < n; i++) boxes.push({ x: 0, y: head + i * 176, w: innerW, h: 156 });
  } else {
    const cols = v === "GRID" ? 2 : n <= 4 ? n : 3;
    const rowsN = Math.ceil(n / cols);
    const h = v === "GRID" ? 230 : rowsN === 1 ? 280 : 230;
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols);
      const inRow = Math.min(cols, n - r * cols);
      const w = (innerW - gap * (cols - 1)) / cols;
      const rowW = inRow * w + (inRow - 1) * gap;
      boxes.push({ x: (innerW - rowW) / 2 + (i - r * cols) * (w + gap), y: head + r * (h + gap), w, h });
    }
  }
  return (
    <Panel ctx={ctx} pad={pad}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: pad, top: pad, right: pad, bottom: pad }}>
        {items.map((it, i) => {
          const b = boxes[i]!;
          const st = seqStyle(ctx, seq, 0, i, { style: ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter });
          const accent = colorOf(ctx, it.color, i);
          const isH = hl === i;
          const val = it.value;
          const t = val === null ? null : fmtValue(ctx, counted(ctx, seq.at(0, i), val), val);
          const dim = dimFor(isH, hl !== null, em);
          const stack = v === "STACK";
          const valueSize = stack ? 64 : n === 1 ? 128 : n === 2 && v === "ROW" ? 96 : 66;
          return (
            <div key={i} style={{ position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h, ...css(st), opacity: st.opacity * dim }}>
              <div style={{ position: "absolute", inset: 0, ...tile(ctx, isH ? accent : null, 28, 1 + em.on * (isH ? 0.6 : 0)), boxShadow: isH ? glowShadow(accent, em.on) : tile(ctx, null, 28).boxShadow, transform: isH && em.scale !== 1 ? `scale(${em.scale})` : undefined }} />
              {stack ? (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", gap: 22, padding: "0 30px" }}>
                  {it.icon ? <GIcon icon={it.icon} size={56} color={accent} draw={prog(frame, seq.at(0, i), Math.round(0.6 * fps), ctx.ease)} /> : <div style={{ width: 10, height: 64, borderRadius: 6, background: accent }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: FONT.displayBold, fontSize: 40, color: p.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.text}</div>
                    {it.sub ? <div style={{ fontFamily: FONT.text, fontSize: 30, color: p.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>{it.sub}</div> : null}
                  </div>
                  {t ? <div style={{ fontFamily: FONT.display, fontSize: fitSize(t.text, b.w * 0.42, valueSize, 34), color: valueColor(ctx, val!, isH ? p.primary : p.ink), letterSpacing: "-0.025em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{t.text}</div> : null}
                </div>
              ) : (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 18px", textAlign: "center" }}>
                  {it.icon ? <div style={{ marginBottom: 10 }}><GIcon icon={it.icon} size={46} color={accent} draw={prog(frame, seq.at(0, i), Math.round(0.6 * fps), ctx.ease)} /></div> : null}
                  {t ? (
                    <div style={{ fontFamily: FONT.display, fontSize: fitSize(t.text, b.w - 36, valueSize, 34), lineHeight: 1, letterSpacing: "-0.03em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", ...(val! < 0 && ctx.fmt.negativeRed ? { color: p.negative } : { backgroundImage: heroGradient(isH || hl === null ? accent : p.ink), WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }) }}>{t.text}</div>
                  ) : null}
                  <div style={{ marginTop: 10, fontFamily: FONT.text, fontSize: 32, lineHeight: 1.15, color: p.ink, maxWidth: b.w - 30, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{it.text}</div>
                  {it.sub ? <div style={{ marginTop: 4, fontFamily: FONT.text, fontSize: 28, color: p.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: b.w - 30 }}>{it.sub}</div> : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ===================================================================== BIG_NUMBER
export function BigNumber({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps, f } = ctx;
  const a = props.items[0];
  const b = props.items[1];
  const head = headHeight(props);
  const startA = Math.round(0.15 * fps);
  const lenA = Math.round(1.1 * fps / Math.max(0.5, props.animation.speed));
  if (ctx.variant === "FROM_TO" && a && b) {
    const startB = startA + Math.round(lenA * 0.75);
    const ta = fmtValue(ctx, counted(ctx, startA, a.value ?? 0, 0, 1, lenA), a.value ?? 0);
    const tb = fmtValue(ctx, counted(ctx, startB, b.value ?? 0, a.value ?? 0, 1, lenA), b.value ?? 0);
    const arrow = prog(frame, startB - 6, 14, ctx.ease);
    const sb = springAt(frame, fps, startB, f.springs.soft, Math.round(lenA * 1.4));
    const em = emphasisAt(ctx, startB + lenA);
    return (
      <div style={{ position: "absolute", inset: 0 }}>
        <Header ctx={ctx} align="center" />
        <div style={{ position: "absolute", left: 0, right: 0, top: head, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 26 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", ...css(enterStyle(ctx, startA, Math.round(0.5 * fps))) }}>
            <div style={{ fontFamily: FONT.display, fontSize: fitSize(ta.text, 360, 104, 50), color: valueColor(ctx, a.value ?? 0, p.muted), letterSpacing: "-0.03em", textShadow: `0 6px 30px ${rgba("#000000", 0.5)}` }}>{ta.text}</div>
            <div style={{ fontFamily: FONT.text, fontSize: 32, color: p.muted, marginTop: 6 }}>{a.text}</div>
          </div>
          <svg width={96} height={60} viewBox="0 0 96 60" style={{ opacity: arrow, overflow: "visible" }}>
            <path d="M6 30h76M64 12l18 18l-18 18" fill="none" stroke={p.primary} strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - arrow} />
          </svg>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", opacity: clamp01(sb * 1.4), transform: `scale(${r1((0.7 + 0.3 * Math.min(sb, 1.1)) * em.scale * 100) / 100})` }}>
            <div style={{ fontFamily: FONT.display, fontSize: fitSize(tb.text, 420, 132, 56), letterSpacing: "-0.035em", ...((b.value ?? 0) < 0 && ctx.fmt.negativeRed ? { color: p.negative } : { backgroundImage: heroGradient(p.primary), WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }), filter: `drop-shadow(0 0 ${r1(10 + 24 * em.on)}px ${rgba(p.primary, 0.35 + 0.2 * em.on)}) drop-shadow(0 8px 26px ${rgba("#000000", 0.55)})` }}>{tb.text}</div>
            <div style={{ fontFamily: FONT.text, fontSize: 34, color: p.ink, marginTop: 6 }}>{b.text}</div>
          </div>
        </div>
      </div>
    );
  }
  const val = a?.value ?? 0;
  const t = fmtValue(ctx, counted(ctx, startA, val, 0, 1, lenA), val);
  const final = fmtValue(ctx, val, val);
  const em = emphasisAt(ctx, startA + lenA);
  const size = fitSize(final.text, ctx.width - 40, 190, 80, 0.6);
  const sIn = springAt(frame, fps, startA, f.springs.soft, Math.round(0.9 * fps));
  const neg = val < 0 && ctx.fmt.negativeRed;
  const bodyStyle = neg ? { color: p.negative } : { backgroundImage: heroGradient(p.primary), WebkitBackgroundClip: "text" as const, backgroundClip: "text" as const, color: "transparent" };
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", inset: "-8% -6%", background: `radial-gradient(ellipse 50% 50% at 50% 55%, ${rgba("#08080C", 0.32)} 0%, transparent 72%)`, filter: "blur(18px)" }} />
      <Header ctx={ctx} align="center" />
      <div style={{ position: "absolute", left: 0, right: 0, top: head, bottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ position: "relative", fontFamily: FONT.display, fontSize: size, lineHeight: 0.95, letterSpacing: "-0.04em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", opacity: clamp01(sIn * 1.5), transform: `scale(${r1((0.82 + 0.18 * Math.min(1.08, sIn)) * em.scale * 1000) / 1000})`, filter: `drop-shadow(0 0 ${r1(14 + 26 * em.on)}px ${rgba(neg ? p.negative : p.primary, 0.32 + 0.2 * em.on)}) drop-shadow(0 10px 30px ${rgba("#000000", 0.55)})` }}>
          {ctx.variant === "ODOMETER" ? <Odometer ctx={ctx} text={final.text} start={startA} len={lenA} size={size} style={bodyStyle} /> : <span style={bodyStyle}>{t.text}</span>}
        </div>
        {a?.text ? <div style={{ marginTop: 14, fontFamily: FONT.text, fontSize: 40, color: p.ink, textShadow: `0 4px 20px ${rgba("#000000", 0.6)}`, opacity: prog(frame, startA + 8, 14, ctx.ease), whiteSpace: "nowrap" }}>{a.text}</div> : null}
      </div>
    </div>
  );
}

/** Rolling digit wheels landing on the final text. */
function Odometer({ ctx, text, start, len, size, style }: { ctx: GCtx; text: string; start: number; len: number; size: number; style: React.CSSProperties }) {
  const chars = [...text];
  let di = 0;
  const digits = chars.filter((c) => /\d/.test(c)).length;
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-start" }}>
      {chars.map((c, i) => {
        if (!/\d/.test(c)) return <span key={i} style={style}>{c}</span>;
        const d = Number(c);
        const k = di++;
        const spins = 1 + ((digits - k) % 3);
        const t = prog(ctx.frame, start + k * 2, len, ctx.ease);
        const pos = t * (spins * 10 + d);
        const frac = pos % 10;
        return (
          <span key={i} style={{ position: "relative", display: "inline-block", height: size * 0.95, overflow: "hidden", width: "0.62em" }}>
            <span style={{ position: "absolute", left: 0, right: 0, top: 0, transform: `translateY(${-frac * size * 0.95}px)`, display: "flex", flexDirection: "column" }}>
              {Array.from({ length: 11 }, (_, n) => (
                <span key={n} style={{ ...style, height: size * 0.95, textAlign: "center", display: "block" }}>{n % 10}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

// ===================================================================== FORMULA
export function Formula({ ctx }: { ctx: GCtx }) {
  const { props, p, fps } = ctx;
  const items = props.items;
  const n = items.length;
  const seq = listSequence(n, { ...ctx.anim, order: ctx.anim.order === "TOGETHER" ? "TOGETHER" : "ONE_BY_ONE" }, { fps, durationInFrames: ctx.D, exitFrames: ctx.exitFrames, tempo: ctx.f.tempo });
  const resultIdx = items.findIndex((it) => it.op === "EQUALS");
  const res = resultIdx >= 0 ? resultIdx : n - 1;
  const em = emphasisAt(ctx, seq.at(0, res) + seq.len);
  const pad = 40;
  const head = headHeight(props);
  if (ctx.variant === "RECEIPT") {
    return (
      <Panel ctx={ctx} pad={pad}>
        <Header ctx={ctx} />
        <div style={{ position: "absolute", left: pad + 8, right: pad + 8, top: pad + head, bottom: pad }}>
          {items.map((it, i) => {
            const isRes = i === res;
            const st = seqStyle(ctx, seq, 0, i, { style: "SLIDE" });
            const val = it.value ?? 0;
            const t = it.value === null ? null : fmtValue(ctx, counted(ctx, seq.at(0, i), val, 0, 1.2, seq.len), val);
            const y = i * 108 + (isRes ? 22 : 0);
            return (
              <div key={i} style={{ position: "absolute", left: 0, right: 0, top: y, height: 96, display: "flex", alignItems: "center", gap: 18, ...css(st) }}>
                {isRes ? <div style={{ position: "absolute", left: 0, right: 0, top: -14, height: 3, borderRadius: 3, background: `linear-gradient(90deg, ${rgba(p.primary, 0.1)}, ${rgba(p.primary, 0.8)})` }} /> : null}
                <div style={{ width: 52, fontFamily: FONT.display, fontSize: 52, color: it.op === "MINUS" ? p.negative : isRes ? p.primary : p.muted, textAlign: "center" }}>{OP[it.op]}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: isRes ? FONT.displayBold : FONT.text, fontSize: isRes ? 44 : 38, color: p.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.text}</div>
                  {it.sub ? <div style={{ fontFamily: FONT.text, fontSize: 28, color: p.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.sub}</div> : null}
                </div>
                {t ? <div style={{ fontFamily: FONT.display, fontSize: isRes ? 64 : 48, color: isRes ? valueColor(ctx, val, p.primary) : it.op === "MINUS" ? p.negative : valueColor(ctx, val, p.ink), letterSpacing: "-0.025em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", transform: isRes ? `scale(${em.scale})` : undefined, textShadow: isRes ? glowShadow(p.primary, em.on, 0.6) : undefined }}>{t.text}</div> : null}
              </div>
            );
          })}
        </div>
      </Panel>
    );
  }
  // ROW: terms left→right; with > 3 terms the result drops to its own line.
  const terms = items.filter((_, i) => i !== res);
  const twoLines = n > 3;
  const lineTerms = twoLines ? terms : items;
  const W = ctx.width;
  const termW = Math.min(300, (W - 40 - (lineTerms.length - 1) * 60) / Math.max(1, lineTerms.length));
  const renderTerm = (it: (typeof items)[number], i: number, size: number, big: boolean) => {
    const val = it.value ?? 0;
    // Multipliers/divisors are counts (× 12 months), never money: shown as plain numbers.
    const plain = it.op === "TIMES" || it.op === "DIVIDE";
    const tctx = plain ? { ...ctx, fmt: { ...ctx.fmt, kind: "NUMBER" as const, prefix: "", suffix: "", signs: "NEGATIVE" as const } } : ctx;
    const t = it.value === null ? null : fmtValue(tctx, counted(ctx, seq.at(0, i), val, 0, 1.2, seq.len), val);
    const isRes = i === res;
    const neg = val < 0 && ctx.fmt.negativeRed;
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: big ? undefined : termW, ...css(seqStyle(ctx, seq, 0, i, { style: "POP" })), transform: isRes && em.scale !== 1 ? `scale(${em.scale})` : css(seqStyle(ctx, seq, 0, i, { style: "POP" })).transform }}>
        {t ? (
          <div style={{ fontFamily: FONT.display, fontSize: fitSize(t.text, big ? W - 120 : termW, size, 34), letterSpacing: "-0.03em", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", ...(isRes && !neg ? { backgroundImage: heroGradient(p.primary), WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", filter: `drop-shadow(0 0 ${r1(12 + 20 * em.on)}px ${rgba(p.primary, 0.4)})` } : { color: neg ? p.negative : p.ink }) }}>{t.text}</div>
        ) : null}
        <div style={{ marginTop: 6, fontFamily: FONT.text, fontSize: big ? 38 : 30, color: isRes ? p.ink : p.muted, textAlign: "center", lineHeight: 1.15, maxWidth: big ? W - 120 : termW + 20 }}>{it.text}</div>
      </div>
    );
  };
  const opEl = (op: string, i: number) => (
    <div key={`op${i}`} style={{ fontFamily: FONT.display, fontSize: 72, color: op === "MINUS" ? p.negative : p.primary, width: 60, textAlign: "center", opacity: prog(ctx.frame, seq.at(0, i) - 4, 8, ctx.ease), alignSelf: "flex-start", marginTop: 10, textShadow: `0 0 20px ${rgba(op === "MINUS" ? p.negative : p.primary, 0.35)}` }}>{OP[op] || "+"}</div>
  );
  return (
    <div style={{ position: "absolute", inset: 0, ...(twoLines ? {} : {}) }}>
      <Panel ctx={ctx} pad={pad}>
        <Header ctx={ctx} align="center" />
        <div style={{ position: "absolute", left: 20, right: 20, top: pad + head, bottom: pad, display: "flex", flexDirection: "column", justifyContent: "center", gap: 30 }}>
          <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start" }}>
            {lineTerms.map((it) => {
              const i = items.indexOf(it);
              return (
                <div key={i} style={{ display: "flex", alignItems: "flex-start" }}>
                  {i > 0 && !(twoLines && i === res) ? opEl(it.op === "NONE" ? "PLUS" : it.op, i) : null}
                  {renderTerm(it, i, 76, false)}
                </div>
              );
            })}
          </div>
          {twoLines ? (
            <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start", gap: 10 }}>
              {opEl("EQUALS", res)}
              {renderTerm(items[res]!, res, 104, true)}
            </div>
          ) : null}
        </div>
      </Panel>
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", borderRadius: 44, boxShadow: glowShadow(mix(p.primary, "#FFFFFF", 0.2), em.on * 0.4) }} />
    </div>
  );
}

export { withExit };
