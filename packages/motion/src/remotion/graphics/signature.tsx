import type { ComponentType, CSSProperties } from "react";
import type { GraphicComponent, GraphicItem } from "@chris/media/timeline";
import { listSequence } from "../../graphics-timing";
import { EASE_OUT, FONT, counted, css, emphasisAt, fitSize, fmtValue, glowShadow, mix, prog, r1, r4, rgba, seqStyle, springAt, tile, type GCtx } from "./kit";
import { fitLine, hash01 } from "./text";
import { card, oneLine, toneOf, type Tone } from "./ui";

/**
 * Library 2 — SIGNATURE: Chris's brand recognition (Content Intelligence, 2026-10-19).
 * SERIES_CARD (the six series' openers) · DILEMMA (two giant contrasting amounts, the sound-off
 * opening frame) · SIGNATURE_STING (intro / outro / bumper / lower third).
 *
 * One signature everywhere: a serif series name in a pill, a thin gold rule that sweeps in,
 * a small tabular episode tag, and the gold → violet accent. Pure functions of ctx.frame; no
 * filters beyond text shadows (WebKit-safe).
 */

const fill: CSSProperties = { position: "absolute", inset: 0 };

const SERIES_NAME: Record<string, string> = {
  POISON: "Pick Your Poison",
  MATH: "I Did The Math",
  BUTTERFLY: "The Financial Butterfly Effect",
  BROKE: "How Broke Is This Character?",
  NO_SENSE: "Money Makes No Sense",
  ALIVE: "The Cost of Being Alive",
  EPISODE: "Episode",
};

/** Wrapped line estimate (~`perLine` chars), mirrors families/signature.ts for the head height. */
function lineCount(text: string | null | undefined, perLine: number, max: number): number {
  const t = (text ?? "").trim();
  if (!t) return 0;
  let n = 1;
  let cur = 0;
  for (const w of t.split(/\s+/)) {
    if (cur && cur + 1 + w.length > perLine) {
      n++;
      cur = w.length;
    } else cur += (cur ? 1 : 0) + w.length;
  }
  return Math.min(max, n);
}

function accentOf(ctx: GCtx): string {
  return ctx.p.primary;
}

/** The series pill + episode tag row. */
function SigChip({ ctx, t, name, meta, at }: { ctx: GCtx; t: Tone; name: string; meta: string | null; at: number }) {
  const { frame, fps } = ctx;
  const s = springAt(frame, fps, at, ctx.f.springs.punch, Math.round(0.5 * fps));
  const a = prog(frame, at, 4);
  const m = prog(frame, at + Math.round(0.18 * fps), 6);
  const gold = accentOf(ctx);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, opacity: a, transform: `translateX(${r1((1 - Math.max(0, s)) * -24)}px)` }}>
      <div style={{ padding: "8px 20px 10px", borderRadius: 999, background: t.dark ? rgba(gold, 0.16) : rgba(gold, 0.22), boxShadow: `inset 0 0 0 1.5px ${rgba(gold, 0.55)}`, fontFamily: FONT.serif, fontSize: 30, color: t.dark ? mix(gold, "#FFFFFF", 0.3) : mix(gold, "#000000", 0.45), letterSpacing: "0.01em", whiteSpace: "nowrap" }}>{name}</div>
      {meta ? <div style={{ fontFamily: FONT.text, fontSize: 26, letterSpacing: "0.16em", textTransform: "uppercase", color: t.muted, fontVariantNumeric: "tabular-nums", opacity: m }}>{meta}</div> : null}
    </div>
  );
}

/** The gold rule: sweeps in from the left. */
function GoldRule({ ctx, at, width, height = 4 }: { ctx: GCtx; at: number; width: number | string; height?: number }) {
  const t = prog(ctx.frame, at, Math.round(0.45 * ctx.fps), EASE_OUT);
  const gold = accentOf(ctx);
  return <div style={{ width, height, borderRadius: height, background: `linear-gradient(90deg, ${gold} 0%, ${mix(gold, ctx.p.secondary, 0.7)} 100%)`, transform: `scaleX(${r4(t)})`, transformOrigin: "0 50%", boxShadow: `0 0 18px ${rgba(gold, 0.45 * t)}` }} />;
}

/** Chip row + rule + the episode's line; returns its height for the body below. */
function SigHead({ ctx, t, name }: { ctx: GCtx; t: Tone; name: string }) {
  const { props, frame, fps, width: W } = ctx;
  const title = props.title?.trim() ?? "";
  const n = lineCount(title, 26, 3);
  const size = n > 2 ? 52 : fitSize(title, W - 96, 62, 44, 0.52);
  const tIn = prog(frame, Math.round(0.3 * fps), Math.round(0.5 * fps), EASE_OUT);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SigChip ctx={ctx} t={t} name={name} meta={props.meta} at={0} />
      <GoldRule ctx={ctx} at={Math.round(0.12 * fps)} width={Math.min(W - 96, 420)} />
      {title ? (
        <div style={{ fontFamily: FONT.displayBold, fontSize: size, lineHeight: 1.1, letterSpacing: "-0.02em", color: t.ink, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", opacity: tIn, transform: `translateY(${r1((1 - tIn) * 16)}px)` }}>{title}</div>
      ) : null}
    </div>
  );
}

function headHeightOf(ctx: GCtx): number {
  return 150 + lineCount(ctx.props.title, 26, 3) * 62;
}

function money(ctx: GCtx, v: number | null, shownAt: number, countLen: number, pop = false): string | null {
  if (v == null) return null;
  const shown = pop ? v : counted(ctx, shownAt, v, 0, 1, countLen);
  return fmtValue(ctx, shown, v).text;
}

// ===================================================================== SERIES_CARD

function SeriesCard({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const v = ctx.variant;
  const name = ctx.props.subtitle?.trim() || SERIES_NAME[v] || SERIES_NAME.EPISODE!;
  const pad = 48;
  const bodyTop = pad + headHeightOf(ctx);
  let body: React.ReactNode = null;
  switch (v) {
    case "POISON": body = <PoisonBody ctx={ctx} t={t} top={bodyTop} />; break;
    case "MATH": body = <MathBody ctx={ctx} t={t} top={bodyTop} />; break;
    case "BUTTERFLY": body = <ButterflyBody ctx={ctx} t={t} top={bodyTop} />; break;
    case "BROKE": body = <BrokeBody ctx={ctx} t={t} top={bodyTop} />; break;
    case "NO_SENSE": body = <NoSenseBody ctx={ctx} t={t} top={bodyTop} />; break;
    case "ALIVE": return <AliveCard ctx={ctx} t={t} name={name} />;
    default: body = null;
  }
  const cardIn = prog(ctx.frame, 0, Math.round(0.35 * ctx.fps), EASE_OUT);
  return (
    <div style={{ ...fill, ...card(t), opacity: cardIn, transform: `scale(${r4(0.96 + 0.04 * cardIn)})` }}>
      <div style={{ position: "absolute", left: pad, right: pad, top: pad }}>
        <SigHead ctx={ctx} t={t} name={name} />
      </div>
      {body}
    </div>
  );
}

function PoisonBody({ ctx, t, top }: { ctx: GCtx; t: Tone; top: number }) {
  const { props, frame, fps, width: W, height: H } = ctx;
  const items = props.items.slice(0, 2);
  const gold = accentOf(ctx);
  const violet = ctx.p.secondary;
  const at = Math.round(0.5 * fps);
  const em = emphasisAt(ctx, at + Math.round(0.4 * fps));
  const tileW = (W - 96 - 40) / 2;
  const tileH = Math.max(160, H - top - 48);
  return (
    <div style={{ position: "absolute", left: 48, right: 48, top, height: tileH }}>
      {items.map((it, i) => {
        const s = springAt(frame, fps, at + i * Math.round(0.14 * fps), ctx.f.springs.punch, Math.round(0.6 * fps));
        const o = prog(frame, at + i * Math.round(0.14 * fps), 4);
        const acc = i === 0 ? gold : violet;
        const val = money(ctx, it.value, at + Math.round(0.3 * fps), Math.round(0.6 * fps));
        return (
          <div key={i} style={{ position: "absolute", left: i === 0 ? 0 : tileW + 40, top: 0, width: tileW, height: tileH, ...tile(ctx, acc, 26, 1 + 0.5 * em.on), boxShadow: glowShadow(acc, em.on * 0.8), opacity: o, transform: `translateX(${r1((1 - Math.max(0, s)) * (i === 0 ? -40 : 40))}px) scale(${r4(em.scale)})`, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 26px", boxSizing: "border-box" }}>
            {val ? <div style={{ fontFamily: FONT.display, fontSize: fitSize(val, tileW - 52, 80, 44, 0.6), lineHeight: 1, letterSpacing: "-0.03em", color: acc, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", textShadow: `0 0 24px ${rgba(acc, 0.35)}` }}>{val}</div> : null}
            <div style={{ marginTop: val ? 10 : 0, fontFamily: FONT.displayBold, fontSize: fitSize(it.text, tileW - 52, 40, 30, 0.55), lineHeight: 1.15, color: t.ink, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{it.text}</div>
            {it.sub ? <div style={{ marginTop: 6, fontFamily: FONT.text, fontSize: 28, color: t.muted, ...oneLine }}>{it.sub}</div> : null}
          </div>
        );
      })}
      <OrBadge ctx={ctx} x={W / 2 - 48} y={tileH / 2} at={at + Math.round(0.3 * fps)} label="or" />
    </div>
  );
}

function OrBadge({ ctx, x, y, at, label }: { ctx: GCtx; x: number; y: number; at: number; label: string }) {
  const s = springAt(ctx.frame, ctx.fps, at, ctx.f.springs.punch, Math.round(0.5 * ctx.fps));
  const gold = accentOf(ctx);
  return (
    <div style={{ position: "absolute", left: x - 34, top: y - 34, width: 68, height: 68, borderRadius: 34, background: `linear-gradient(160deg, ${mix(gold, "#FFFFFF", 0.3)}, ${gold} 60%, ${mix(gold, "#000000", 0.2)})`, boxShadow: `0 10px 26px ${rgba("#000000", 0.4)}, 0 0 0 4px ${rgba("#0C0B10", 0.9)}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.displayBold, fontSize: 26, color: "#1A1408", letterSpacing: "0.02em", transform: `scale(${r4(Math.max(0, s))}) rotate(${r1((1 - Math.max(0, s)) * -40)}deg)` }}>{label}</div>
  );
}

function MathBody({ ctx, t, top }: { ctx: GCtx; t: Tone; top: number }) {
  const { props, frame, fps, width: W } = ctx;
  const items = props.items.slice(0, 6);
  const seq = listSequence(items.length + 1, { ...ctx.anim, order: "ONE_BY_ONE" }, { fps, durationInFrames: ctx.D, exitFrames: ctx.exitFrames, tempo: ctx.f.tempo, startFrame: Math.round(0.45 * fps) });
  const gold = accentOf(ctx);
  const rowH = 92;
  const em = emphasisAt(ctx, seq.at(0, items.length));
  return (
    <div style={{ position: "absolute", left: 48, right: 48, top }}>
      {items.map((it, i) => {
        const st = seqStyle(ctx, seq, 0, i, { style: "SLIDE" });
        const val = money(ctx, it.value, seq.at(0, i), seq.len);
        return (
          <div key={i} style={{ height: rowH, display: "flex", alignItems: "center", gap: 20, borderBottom: `1.5px dashed ${t.line}`, ...css(st) }}>
            <div style={{ width: 36, fontFamily: FONT.display, fontSize: 34, color: t.muted, textAlign: "center" }}>{i === 0 ? "" : "+"}</div>
            <div style={{ flex: 1, minWidth: 0, fontFamily: FONT.text, fontSize: fitSize(it.text, W - 96 - 36 - 240, 36, 28, 0.55), color: t.ink, ...oneLine }}>{it.text}</div>
            {val ? <div style={{ fontFamily: FONT.display, fontSize: 40, color: t.ink, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{val}</div> : null}
          </div>
        );
      })}
      {props.body ? (
        <div style={{ marginTop: 26, display: "flex", alignItems: "baseline", justifyContent: "space-between", ...css(seqStyle(ctx, seq, 0, items.length, { style: "POP" })), transform: `scale(${r4(em.scale)})`, transformOrigin: "100% 50%" }}>
          <div style={{ fontFamily: FONT.serif, fontSize: 34, color: t.muted }}>=</div>
          <div style={{ fontFamily: FONT.display, fontSize: fitSize(props.body, W - 96 - 60, 84, 48, 0.58), lineHeight: 1, letterSpacing: "-0.03em", color: gold, textShadow: glowShadow(gold, em.on, 0.8), whiteSpace: "nowrap" }}>{props.body}</div>
        </div>
      ) : null}
    </div>
  );
}

function ButterflyBody({ ctx, t, top }: { ctx: GCtx; t: Tone; top: number }) {
  const { props, frame, fps, width: W } = ctx;
  const items = props.items.slice(0, 3);
  const gold = accentOf(ctx);
  const violet = ctx.p.secondary;
  const x0 = 48 + 40;
  const x1 = W - 48 - 40;
  const yMid = top + 150;
  const at = Math.round(0.45 * fps);
  const draw = prog(frame, at, Math.round(1.1 * fps), EASE_OUT);
  const forkAt = x0 + (x1 - x0) * 0.32;
  const path = (dy: number) => `M${x0} ${yMid} L${forkAt} ${yMid} C ${forkAt + 120} ${yMid}, ${forkAt + 160} ${yMid + dy}, ${x1} ${yMid + dy}`;
  const nodeX = items.map((_, i) => x0 + ((x1 - x0) * i) / Math.max(1, items.length - 1));
  return (
    <div style={{ ...fill }}>
      <svg width={W} height={ctx.height} viewBox={`0 0 ${W} ${ctx.height}`} style={{ position: "absolute", inset: 0 }}>
        <path d={path(-70)} fill="none" stroke={gold} strokeWidth={6} strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
        <path d={path(70)} fill="none" stroke={violet} strokeWidth={6} strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
        {items.map((_, i) => {
          const on = prog(frame, at + Math.round(((i / Math.max(1, items.length - 1)) * 1.0 + 0.1) * fps), 6);
          return <circle key={i} cx={nodeX[i]} cy={i === items.length - 1 ? yMid - 70 : yMid} r={14 * on} fill={i === 0 ? t.ink : gold} stroke={rgba("#0C0B10", 0.9)} strokeWidth={4} />;
        })}
        {items.length > 1 ? <circle cx={x1} cy={yMid + 70} r={14 * prog(frame, at + Math.round(1.1 * fps), 6)} fill={violet} stroke={rgba("#0C0B10", 0.9)} strokeWidth={4} /> : null}
      </svg>
      {items.map((it, i) => {
        const on = prog(frame, at + Math.round(((i / Math.max(1, items.length - 1)) * 1.0 + 0.2) * fps), 8);
        const last = i === items.length - 1;
        const x = nodeX[i]!;
        const align = i === 0 ? "flex-start" : last ? "flex-end" : "center";
        return (
          <div key={i} style={{ position: "absolute", left: i === 0 ? 48 : last ? undefined : x - 120, right: last ? 48 : undefined, width: 240, top: last ? yMid + 100 : yMid + 36, display: "flex", flexDirection: "column", alignItems: align, textAlign: i === 0 ? "left" : last ? "right" : "center", opacity: on, transform: `translateY(${r1((1 - on) * 10)}px)` }}>
            <div style={{ fontFamily: FONT.displayBold, fontSize: 32, color: t.ink, ...oneLine, maxWidth: 240 }}>{it.text}</div>
            {it.sub ? <div style={{ marginTop: 4, fontFamily: FONT.text, fontSize: 26, color: last ? violet : t.muted, lineHeight: 1.2, maxWidth: 240 }}>{it.sub}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

function BrokeBody({ ctx, t, top }: { ctx: GCtx; t: Tone; top: number }) {
  const { props, frame, fps, width: W } = ctx;
  const items = props.items.slice(0, 6);
  const seq = listSequence(items.length, { ...ctx.anim, order: "ONE_BY_ONE" }, { fps, durationInFrames: ctx.D, exitFrames: ctx.exitFrames, tempo: ctx.f.tempo, startFrame: Math.round(0.45 * fps) });
  const verdictAt = seq.at(0, items.length - 1) + seq.len + Math.round(0.1 * fps);
  const vs = springAt(frame, fps, verdictAt, ctx.f.springs.punch, Math.round(0.5 * fps));
  const em = emphasisAt(ctx, verdictAt);
  const neg = ctx.p.negative;
  return (
    <div style={{ position: "absolute", left: 48, right: 48, top }}>
      {items.map((it, i) => {
        const st = seqStyle(ctx, seq, 0, i, { style: "SLIDE" });
        const val = money(ctx, it.value, seq.at(0, i), seq.len);
        const isNeg = (it.value ?? 0) < 0;
        return (
          <div key={i} style={{ height: 80, display: "flex", alignItems: "center", gap: 18, ...css(st) }}>
            <div style={{ width: 10, height: 40, borderRadius: 5, background: isNeg ? neg : ctx.p.positive }} />
            <div style={{ flex: 1, minWidth: 0, fontFamily: FONT.text, fontSize: 34, color: t.ink, ...oneLine }}>{it.text}</div>
            {val ? <div style={{ fontFamily: FONT.display, fontSize: 38, color: isNeg ? neg : t.ink, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{val}</div> : null}
          </div>
        );
      })}
      {props.body ? (
        <div style={{ marginTop: 22, display: "flex", justifyContent: "center" }}>
          <div style={{ padding: "14px 34px", borderRadius: 16, border: `5px solid ${neg}`, color: neg, fontFamily: FONT.display, fontSize: fitSize(props.body, W - 96 - 80, 60, 36, 0.6), letterSpacing: "0.04em", textTransform: "uppercase", whiteSpace: "nowrap", transform: `rotate(-5deg) scale(${r4(Math.max(0, 0.2 + 0.8 * vs) * em.scale)})`, opacity: prog(frame, verdictAt, 3), boxShadow: glowShadow(neg, em.on, 0.8), background: rgba(neg, 0.08) }}>{props.body}</div>
        </div>
      ) : null}
    </div>
  );
}

function NoSenseBody({ ctx, t, top }: { ctx: GCtx; t: Tone; top: number }) {
  const { props, frame, fps, width: W, height: H } = ctx;
  const gold = accentOf(ctx);
  const revealAt = Math.round(Math.max(0.9 * fps, (ctx.D - ctx.exitFrames) * 0.55));
  const q = prog(frame, Math.round(0.4 * fps), Math.round(0.5 * fps), EASE_OUT);
  const rv = springAt(frame, fps, revealAt, ctx.f.springs.punch, Math.round(0.6 * fps));
  const gone = prog(frame, revealAt, Math.round(0.3 * fps), EASE_OUT);
  const pulse = 1 + 0.03 * Math.sin((frame / fps) * 4);
  const em = emphasisAt(ctx, revealAt);
  const zone = H - top - 48;
  return (
    <div style={{ position: "absolute", left: 48, right: 48, top, height: zone }}>
      <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center", opacity: q * (1 - gone), transform: `scale(${r4((0.6 + 0.4 * q) * pulse)})` }}>
        <div style={{ fontFamily: FONT.serif, fontSize: Math.min(200, zone * 0.9), lineHeight: 1, color: gold, textShadow: `0 0 40px ${rgba(gold, 0.4)}` }}>?</div>
      </div>
      {props.body ? (
        <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center", opacity: prog(frame, revealAt, 4), transform: `translateY(${r1((1 - Math.max(0, rv)) * 30)}px) scale(${r4(em.scale)})` }}>
          <div style={{ padding: "18px 28px", borderRadius: 20, background: rgba(gold, 0.12), boxShadow: `inset 0 0 0 1.5px ${rgba(gold, 0.5)}, ${glowShadow(gold, em.on, 0.6) ?? ""}`, fontFamily: FONT.displayBold, fontSize: fitSize(props.body, W - 96 - 56, 40, 28, 0.52), lineHeight: 1.2, color: t.ink, textAlign: "center", maxWidth: W - 96, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{props.body}</div>
        </div>
      ) : null}
    </div>
  );
}

/** The Cost of Being Alive: a receipt with a torn bottom edge; a total that appears complete. */
function AliveCard({ ctx, t, name }: { ctx: GCtx; t: Tone; name: string }) {
  const { props, frame, fps, width: W, height: H } = ctx;
  const items = props.items.slice(0, 6);
  const seq = listSequence(items.length + 1, { ...ctx.anim, order: "ONE_BY_ONE" }, { fps, durationInFrames: ctx.D, exitFrames: ctx.exitFrames, tempo: ctx.f.tempo, startFrame: Math.round(0.4 * fps) });
  const total = items.reduce((a, it) => a + (it.value ?? 0), 0);
  const paper = "#F6F1E6";
  const ink = "#2A2520";
  const gold = accentOf(ctx);
  const drop = prog(frame, 0, Math.round(0.45 * fps), EASE_OUT);
  const tear = Array.from({ length: 23 }, (_, i) => `${r1(100 - (i / 22) * 100)}% ${i % 2 ? 100 : 98.6}%`).join(", ");
  const em = emphasisAt(ctx, seq.at(0, items.length));
  return (
    <div style={{ ...fill, opacity: drop, transform: `translateY(${r1((1 - drop) * -30)}px)` }}>
      <div style={{ ...fill, background: paper, clipPath: `polygon(0 0, 100% 0, ${tear})`, boxShadow: `0 30px 70px ${rgba("#000000", 0.45)}` }} />
      <div style={{ position: "absolute", left: 40, right: 40, top: 36 }}>
        <div style={{ textAlign: "center", fontFamily: FONT.serif, fontSize: 36, color: ink, letterSpacing: "0.01em" }}>{name}</div>
        {props.title ? <div style={{ marginTop: 6, textAlign: "center", fontFamily: FONT.text, fontSize: 26, letterSpacing: "0.14em", textTransform: "uppercase", color: mix(ink, paper, 0.4), ...oneLine }}>{props.title}</div> : null}
        {props.meta ? <div style={{ marginTop: 2, textAlign: "center", fontFamily: FONT.text, fontSize: 22, letterSpacing: "0.12em", color: mix(ink, paper, 0.55), fontVariantNumeric: "tabular-nums" }}>{props.meta}</div> : null}
        <div style={{ margin: "18px 0 10px", borderTop: `2px dashed ${mix(ink, paper, 0.7)}` }} />
        {items.map((it, i) => {
          const st = seqStyle(ctx, seq, 0, i, { style: "FADE" });
          const val = money(ctx, it.value, seq.at(0, i), seq.len);
          return (
            <div key={i} style={{ height: 76, display: "flex", alignItems: "center", justifyContent: "space-between", ...css(st) }}>
              <div style={{ fontFamily: FONT.text, fontSize: 32, color: ink, ...oneLine, maxWidth: "62%" }}>{it.text}</div>
              {val ? <div style={{ fontFamily: FONT.display, fontSize: 34, color: ink, fontVariantNumeric: "tabular-nums" }}>{val}</div> : null}
            </div>
          );
        })}
        <div style={{ margin: "10px 0 14px", borderTop: `2px dashed ${mix(ink, paper, 0.7)}` }} />
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", ...css(seqStyle(ctx, seq, 0, items.length, { style: "POP" })), transform: `scale(${r4(em.scale)})`, transformOrigin: "100% 50%" }}>
          <div style={{ fontFamily: FONT.displayBold, fontSize: 30, letterSpacing: "0.12em", color: ink }}>TOTAL</div>
          <div style={{ fontFamily: FONT.display, fontSize: 56, letterSpacing: "-0.02em", color: mix(gold, "#000000", 0.3), fontVariantNumeric: "tabular-nums", textShadow: glowShadow(gold, em.on, 0.5) }}>{fmtValue(ctx, total, total).text}</div>
        </div>
      </div>
      <div style={{ position: "absolute", left: 40, right: 40, bottom: 44, textAlign: "center", fontFamily: FONT.text, fontSize: 22, letterSpacing: "0.1em", color: mix(ink, paper, 0.5), opacity: prog(frame, seq.at(0, items.length), 8) }}>{"PER MONTH · NO REFUNDS"}</div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: Math.min(8, H * 0.01), background: "transparent" }} />
      {W > 0 ? null : null}
    </div>
  );
}

// ===================================================================== DILEMMA

function Dilemma({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const v = ctx.variant;
  const { props, frame, fps, width: W, height: H } = ctx;
  const items = props.items.slice(0, 2);
  const gold = accentOf(ctx);
  const violet = ctx.p.secondary;
  const side = v === "SIDE";
  const pad = 40;
  const title = props.title?.trim() ?? "";
  const titleH = title ? 100 : 0;
  const extra = v === "TIMER" || v === "FLIP" ? 200 : 0;
  const zoneH = H - pad * 2 - titleH - extra;
  const gap = v === "TIMER" || v === "FLIP" ? 36 : 84;
  const tileW = side ? (W - pad * 2 - gap) / 2 : W - pad * 2;
  const tileH = side ? zoneH : (zoneH - gap) / 2;
  const at = Math.round(0.12 * fps);
  const cardIn = prog(frame, 0, Math.round(0.3 * fps), EASE_OUT);
  const promptAt = at + Math.round(0.75 * fps);
  const em = emphasisAt(ctx, promptAt);
  // TIMER: a 3-second clock; FLIP: the coin lands on one side late.
  const timerStart = promptAt + Math.round(0.2 * fps);
  const secondsLeft = Math.max(0, 3 - Math.floor(Math.max(0, frame - timerStart) / fps));
  const flipAt = promptAt + Math.round(0.2 * fps);
  const flipT = prog(frame, flipAt, Math.round(1.1 * fps), EASE_OUT);
  const landed = frame >= flipAt + Math.round(1.1 * fps);
  const winner = hash01((props.items[0]?.value ?? 1) + (props.items[1]?.value ?? 2)) > 0.5 ? 1 : 0;
  return (
    <div style={{ ...fill, ...card(t), opacity: cardIn }}>
      {items.map((it, i) => {
        const s = springAt(frame, fps, at + i * Math.round(0.22 * fps), ctx.f.springs.punch, Math.round(0.7 * fps));
        const o = prog(frame, at + i * Math.round(0.22 * fps), 4);
        const acc = i === 0 ? gold : violet;
        const val = money(ctx, it.value, at + i * Math.round(0.22 * fps), Math.round(0.8 * fps));
        const dim = v === "FLIP" && landed && i !== winner ? 0.35 : 1;
        const left = side ? pad + i * (tileW + gap) : pad;
        const top = side ? pad : pad + i * (tileH + gap);
        // The number may take at most half the tile so the label and sub always fit under it.
        const valSize = val ? Math.min(fitSize(val, tileW - 48, side ? 118 : 150, 56, 0.6), Math.floor(tileH * (it.sub ? 0.42 : 0.5))) : 0;
        return (
          <div key={i} style={{ position: "absolute", left, top, width: tileW, height: tileH, ...tile(ctx, acc, 30, 1 + 0.4 * em.on), opacity: o * dim, transform: `translateY(${r1((1 - Math.max(0, s)) * (i === 0 ? -30 : 30))}px) scale(${r4(1 + 0.02 * em.on)})`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "0 24px", boxSizing: "border-box", boxShadow: glowShadow(acc, em.on * 0.6) }}>
            {val ? <div style={{ fontFamily: FONT.display, fontSize: valSize, lineHeight: 1, letterSpacing: "-0.04em", color: acc, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", textShadow: `0 0 30px ${rgba(acc, 0.35)}` }}>{val}</div> : null}
            <div style={{ marginTop: val ? 12 : 0, fontFamily: FONT.displayBold, fontSize: fitSize(it.text, tileW - 48, val ? 38 : 56, 28, 0.55), lineHeight: 1.12, color: t.ink, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{it.text}</div>
            {it.sub ? <div style={{ marginTop: 6, fontFamily: FONT.text, fontSize: 28, color: t.muted, ...oneLine, maxWidth: "100%" }}>{it.sub}</div> : null}
          </div>
        );
      })}
      {v !== "FLIP" && v !== "TIMER" ? <OrBadge ctx={ctx} x={W / 2} y={side ? pad + tileH / 2 : pad + tileH + gap / 2} at={at + Math.round(0.5 * fps)} label="or" /> : null}
      {v === "FLIP" ? <Coin ctx={ctx} x={W / 2} y={pad + zoneH + 100} t={flipT} landed={landed} winner={winner} side={side} /> : null}
      {v === "TIMER" ? (
        <div style={{ position: "absolute", left: pad, right: pad, top: pad + zoneH + 40, height: 120, display: "flex", alignItems: "center", justifyContent: "center", gap: 18 }}>
          <div style={{ fontFamily: FONT.text, fontSize: 30, letterSpacing: "0.14em", textTransform: "uppercase", color: t.muted, opacity: prog(frame, promptAt, 6) }}>Choose in</div>
          <div style={{ width: 110, height: 110, borderRadius: 55, boxShadow: `inset 0 0 0 6px ${rgba(gold, 0.25)}`, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", opacity: prog(frame, promptAt, 6) }}>
            <svg width={110} height={110} viewBox="0 0 110 110" style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
              <circle cx={55} cy={55} r={52} fill="none" stroke={gold} strokeWidth={6} pathLength={1} strokeDasharray={1} strokeDashoffset={Math.min(1, Math.max(0, (frame - timerStart) / (3 * fps)))} strokeLinecap="round" />
            </svg>
            <div style={{ fontFamily: FONT.display, fontSize: 56, color: t.ink, fontVariantNumeric: "tabular-nums" }}>{secondsLeft || "!"}</div>
          </div>
        </div>
      ) : null}
      {title ? (
        <div style={{ position: "absolute", left: pad, right: pad, bottom: pad, height: 70, display: "flex", alignItems: "center", justifyContent: "center", opacity: prog(frame, promptAt, 5), transform: `scale(${r4(0.9 + 0.1 * Math.max(0, springAt(frame, fps, promptAt, ctx.f.springs.punch, Math.round(0.5 * fps))) * em.scale)})` }}>
          <div style={{ fontFamily: FONT.serif, fontSize: fitLine(title, W - pad * 2 - 20, 56, 34, 0.95), color: t.ink, whiteSpace: "nowrap", textShadow: `0 0 26px ${rgba(gold, 0.25 * em.on)}` }}>{title}</div>
        </div>
      ) : null}
    </div>
  );
}

/** A gold coin that spins (scaleX) and settles, pointing at the winner. */
function Coin({ ctx, x, y, t, landed, winner, side }: { ctx: GCtx; x: number; y: number; t: number; landed: boolean; winner: number; side: boolean }) {
  const gold = accentOf(ctx);
  const spins = 5;
  const sx = Math.cos(t * Math.PI * spins) * (1 - t) + t;
  const lift = Math.sin(Math.min(1, t) * Math.PI) * 60;
  const arrowOn = prog(ctx.frame, 0, 1) * (landed ? 1 : 0);
  const towards = winner === 0 ? (side ? "←" : "↑") : side ? "→" : "↓";
  return (
    <div style={{ position: "absolute", left: x - 70, top: y - 70 - lift, width: 140, height: 140 }}>
      <div style={{ ...fill, borderRadius: 70, transform: `scaleX(${r4(Math.max(0.06, Math.abs(sx)))})`, background: `radial-gradient(circle at 35% 30%, ${mix(gold, "#FFFFFF", 0.5)}, ${gold} 45%, ${mix(gold, "#000000", 0.3)} 100%)`, boxShadow: `0 16px 34px ${rgba("#000000", 0.45)}, inset 0 0 0 8px ${rgba("#000000", 0.12)}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.serif, fontSize: 64, color: "#2A1E05" }}>{sx >= 0 ? "$" : "¢"}</div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 150, textAlign: "center", fontFamily: FONT.display, fontSize: 44, color: gold, opacity: arrowOn }}>{towards}</div>
    </div>
  );
}

// ===================================================================== SIGNATURE_STING

function SignatureSting({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "OUTRO":
      return <StingOutro ctx={ctx} />;
    case "BUMPER":
      return <StingBumper ctx={ctx} />;
    case "LOWER":
      return <StingLower ctx={ctx} />;
    default:
      return <StingIntro ctx={ctx} />;
  }
}

function StingIntro({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps, width: W, height: H } = ctx;
  const gold = accentOf(ctx);
  const title = props.title?.trim() ?? "";
  const handle = props.subtitle?.trim() ?? "";
  const band = prog(frame, 0, Math.round(0.3 * fps), EASE_OUT);
  const tIn = prog(frame, Math.round(0.22 * fps), Math.round(0.45 * fps), EASE_OUT);
  const hIn = prog(frame, Math.round(0.5 * fps), Math.round(0.3 * fps), EASE_OUT);
  return (
    <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: H * 0.5 - 2 + 60, height: 4, background: `linear-gradient(90deg, transparent, ${gold} 30%, ${mix(gold, ctx.p.secondary, 0.6)} 70%, transparent)`, transform: `scaleX(${r4(band)})`, boxShadow: `0 0 24px ${rgba(gold, 0.5 * band)}` }} />
      <div style={{ position: "absolute", left: 60, right: 60, top: 0, bottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, transform: "translateY(-30px)" }}>
        <div style={{ fontFamily: FONT.serif, fontSize: fitSize(title, (W - 160) * 1.85, 64, 40, 0.5), lineHeight: 1.15, color: "#FFFFFF", textAlign: "center", textShadow: `0 2px 4px ${rgba("#000000", 0.5)}, 0 10px 30px ${rgba("#000000", 0.45)}`, opacity: tIn, transform: `translateY(${r1((1 - tIn) * 14)}px)`, letterSpacing: `${r4(0.06 * (1 - tIn))}em`, maxWidth: W - 160, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{title}</div>
        {handle ? <div style={{ fontFamily: FONT.text, fontSize: 30, letterSpacing: "0.12em", color: mix(gold, "#FFFFFF", 0.3), opacity: hIn, textShadow: `0 2px 4px ${rgba("#000000", 0.5)}` }}>{handle}</div> : null}
      </div>
    </div>
  );
}

function StingOutro({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps, width: W } = ctx;
  const gold = accentOf(ctx);
  const title = props.title?.trim() ?? "";
  const handle = props.subtitle?.trim() ?? "";
  const next = props.meta?.trim() ?? "";
  const cardIn = prog(frame, 0, Math.round(0.35 * fps), EASE_OUT);
  const tIn = prog(frame, Math.round(0.2 * fps), Math.round(0.5 * fps), EASE_OUT);
  const nIn = prog(frame, Math.round(0.9 * fps), Math.round(0.4 * fps), EASE_OUT);
  const em = emphasisAt(ctx, Math.round(0.4 * fps));
  return (
    <div style={{ ...fill, ...card(t), opacity: cardIn, transform: `scale(${r4(0.97 + 0.03 * cardIn)})`, padding: 48, boxSizing: "border-box", display: "flex", flexDirection: "column", justifyContent: "center", gap: 18 }}>
      <GoldRule ctx={ctx} at={Math.round(0.1 * fps)} width={120} />
      <div style={{ fontFamily: FONT.serif, fontSize: next ? 46 : fitSize(title, W - 96, 60, 40, 0.5), lineHeight: 1.15, color: t.ink, opacity: tIn, transform: `translateY(${r1((1 - tIn) * 14)}px) scale(${r4(em.scale)})`, transformOrigin: "0 50%", display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{title}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, opacity: tIn }}>
        {handle ? <div style={{ padding: "8px 18px", borderRadius: 999, background: rgba(gold, 0.16), boxShadow: `inset 0 0 0 1.5px ${rgba(gold, 0.5)}`, fontFamily: FONT.displayBold, fontSize: 28, color: t.dark ? mix(gold, "#FFFFFF", 0.3) : mix(gold, "#000000", 0.4) }}>{handle}</div> : null}
      </div>
      {next ? (
        <div style={{ marginTop: 6, display: "flex", gap: 12, alignItems: "baseline", opacity: nIn, transform: `translateY(${r1((1 - nIn) * 10)}px)` }}>
          <div style={{ fontFamily: FONT.text, fontSize: 26, letterSpacing: "0.14em", textTransform: "uppercase", color: gold }}>Next</div>
          <div style={{ fontFamily: FONT.text, fontSize: 30, color: t.muted, lineHeight: 1.25, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{next}</div>
        </div>
      ) : null}
    </div>
  );
}

function StingBumper({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps, width: W, height: H } = ctx;
  const gold = accentOf(ctx);
  const title = props.title?.trim() ?? "";
  const wipe = prog(frame, 0, Math.round(0.4 * fps), EASE_OUT);
  const tIn = prog(frame, Math.round(0.15 * fps), Math.round(0.35 * fps), EASE_OUT);
  const size = fitLine(title.toUpperCase(), W - 200, 92, 48, 1.02);
  return (
    <div style={{ ...fill }}>
      <div style={{ position: "absolute", left: 0, top: H / 2 - 3, width: W, height: 6, background: `linear-gradient(90deg, ${gold}, ${mix(gold, ctx.p.secondary, 0.7)})`, transform: `scaleX(${r4(wipe)})`, transformOrigin: "0 50%", boxShadow: `0 0 30px ${rgba(gold, 0.6 * wipe)}` }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ padding: "0 36px", background: "#0C0B10", fontFamily: FONT.display, fontSize: size, letterSpacing: "0.08em", textTransform: "uppercase", color: "#FFFFFF", opacity: tIn, transform: `scale(${r4(0.9 + 0.1 * tIn)})`, textShadow: `0 0 24px ${rgba(gold, 0.35)}`, whiteSpace: "nowrap" }}>{title}</div>
      </div>
    </div>
  );
}

function StingLower({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps, width: W, height: H } = ctx;
  const gold = accentOf(ctx);
  const name = props.title?.trim() ?? "";
  const line = props.subtitle?.trim() ?? "";
  const sIn = springAt(frame, fps, 0, ctx.f.springs.punch, Math.round(0.6 * fps));
  const o = prog(frame, 0, 4);
  return (
    <div style={{ ...fill, ...card(t, 26), opacity: o, transform: `translateX(${r1((1 - Math.max(0, sIn)) * -40)}px)`, display: "flex", alignItems: "center", gap: 22, padding: "0 30px 0 0", boxSizing: "border-box" }}>
      <div style={{ width: 12, height: H - 40, marginLeft: 16, borderRadius: 6, background: `linear-gradient(180deg, ${gold}, ${mix(gold, ctx.p.secondary, 0.7)})`, boxShadow: `0 0 16px ${rgba(gold, 0.45)}` }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: FONT.displayBold, fontSize: fitLine(name, W - 120, 46, 30), color: t.ink, letterSpacing: "-0.01em", ...oneLine }}>{name}</div>
        {line ? <div style={{ marginTop: 4, fontFamily: FONT.serif, fontSize: fitLine(line, W - 120, 30, 24, 0.95), color: t.muted, ...oneLine, opacity: prog(frame, Math.round(0.2 * fps), 8) }}>{line}</div> : null}
      </div>
    </div>
  );
}

export const SIGNATURE_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {
  SERIES_CARD: SeriesCard,
  DILEMMA: Dilemma,
  SIGNATURE_STING: SignatureSting,
};

export const __signatureInternals = { lineCount, SERIES_NAME };
export type { GraphicItem as __SignatureItem };
