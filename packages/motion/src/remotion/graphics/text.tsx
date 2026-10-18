import { useId, type ComponentType, type CSSProperties, type ReactNode } from "react";
import type { GraphicComponent, GraphicIcon } from "@chris/media/timeline";
import { listSequence } from "../../graphics-timing";
import { EASE_IN, EASE_IN_OUT } from "../motion";
import { Scrim, gradientText, heroGradient } from "../templates/text";
import { TEXT_LIFT, glassCard } from "../theme";
import { GIcon } from "./icons";
import {
  FONT,
  Header,
  Panel,
  clamp01,
  colorOf,
  counted,
  css,
  emphasisAt,
  enterStyle,
  fitSize,
  fmtValue,
  glowShadow,
  headHeight,
  mix,
  prog,
  r1,
  r4,
  rgba,
  seqStyle,
  springAt,
  withExit,
  type GCtx,
} from "./kit";

/**
 * Text, callout, social and transition components of the composable graphics system:
 * KINETIC · QUOTE · LOWER_THIRD · ANNOTATION · STICKER · MAP_PIN · ICON_BURST · CTA · TRANSITION.
 *
 * Conventions (shared with money.tsx): every component draws absolutely inside
 * ctx.width × ctx.height (graphicDesignSize), animation is a pure function of ctx.frame, the
 * motion language (ctx.f) shapes springs/eases, and variable strings are measured + fitted so
 * nothing overflows. Bare type (no card) sits on a soft, invisible Scrim; transparent overlays
 * (annotations) carry a dark drop-shadow so their strokes read over any footage.
 */

const fill: CSSProperties = { position: "absolute", inset: 0 };
const DARK = "#0C0B10";
const STROKE_SHADOW = `drop-shadow(0 2px 3px ${rgba("#000000", 0.55)}) drop-shadow(0 8px 18px ${rgba("#000000", 0.35)})`;

// ===================================================================== helpers

function sid(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "");
}

function seqOpts(ctx: GCtx, startFrame?: number) {
  return { fps: ctx.fps, durationInFrames: ctx.D, exitFrames: ctx.exitFrames, tempo: ctx.f.tempo, startFrame };
}

function cleanWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}%$]/gu, "");
}

export function splitWords(s: string | null | undefined): string[] {
  return (s ?? "").split(/\s+/).filter(Boolean);
}

/** Latest frame a build may finish so it can still be read before the exit. */
export function buildBudget(ctx: GCtx, hold = 0.6): number {
  return Math.max(8, ctx.D - ctx.exitFrames - Math.round(hold * ctx.fps));
}

/** Compression factor (≤ 1) so `total` frames of choreography starting at `t0` fit the budget. */
export function squeeze(ctx: GCtx, t0: number, total: number, hold = 0.6): number {
  const room = buildBudget(ctx, hold) - t0;
  return total <= 0 || room >= total ? 1 : Math.max(0.2, room / total);
}

/** Relative glyph advance (em) for Inter Display Bold/ExtraBold — a conservative estimate. */
export function charW(c: string): number {
  if (c === " " || c.charCodeAt(0) === 160) return 0.27;
  if ("iljI.,:;'!|’‘·".includes(c)) return 0.31;
  if ("ftr()-\"“”/".includes(c)) return 0.42;
  if (c === "m" || c === "w") return 0.86;
  if (c === "M" || c === "W") return 0.98;
  if (c === "—" || c === "–") return 0.9;
  if (/[A-Z]/.test(c)) return 0.72;
  if (/[0-9$%€£−+]/.test(c)) return 0.64;
  return 0.58;
}

/** Estimated rendered width of `s` at `size` px (k scales for narrower/wider faces). */
export function textW(s: string, size: number, k = 1): number {
  let w = 0;
  for (const c of s) w += charW(c);
  return w * size * k;
}

/** Largest size ≤ max at which `s` fits `width` on one line. */
export function fitLine(s: string, width: number, max: number, min = 28, k = 1): number {
  const w = textW(s || " ", max, k);
  return Math.max(min, Math.min(max, Math.floor((max * width) / Math.max(1, w))));
}

/** Greedy line break of words (token indices per line). */
export function breakLines(words: string[], size: number, width: number, k: number): number[][] {
  const lines: number[][] = [];
  let cur: number[] = [];
  let curText = "";
  words.forEach((w, i) => {
    const t = curText ? `${curText} ${w}` : w;
    if (cur.length && textW(t, size, k) > width) {
      lines.push(cur);
      cur = [i];
      curText = w;
    } else {
      cur.push(i);
      curText = t;
    }
  });
  if (cur.length) lines.push(cur);
  return lines;
}

/** Same line count, but balanced (no orphan last word): narrow the measure while it holds. */
export function balancedLines(words: string[], size: number, width: number, k: number): number[][] {
  const base = breakLines(words, size, width, k);
  if (base.length <= 1) return base;
  const longest = Math.max(...words.map((w) => textW(w, size, k)));
  let best = base;
  for (let w2 = width - 16; w2 >= Math.max(longest, width * 0.45); w2 -= 16) {
    const l = breakLines(words, size, w2, k);
    if (l.length > base.length) break;
    best = l;
  }
  return best;
}

export interface Fitted {
  size: number;
  lines: number[][];
  /** Words actually shown (the last may carry an ellipsis when even the minimum overflows). */
  words: string[];
}

/** Largest font size (max → min) at which the words wrap into `width` × `height`. */
export function fitWords(wordsIn: string[], width: number, height: number, o: { max: number; min: number; lh: number; k?: number; maxLines?: number }): Fitted {
  const k = o.k ?? 1;
  const words = wordsIn.length ? wordsIn : [" "];
  for (let s = o.max; s >= o.min; s -= 2) {
    const longest = Math.max(...words.map((w) => textW(w, s, k)));
    if (longest > width) continue;
    const lines = balancedLines(words, s, width, k);
    if (lines.length * s * o.lh <= height && (!o.maxLines || lines.length <= o.maxLines)) return { size: s, lines, words };
  }
  // Even the minimum overflows: clamp lines and ellipsize.
  const s = o.min;
  const maxL = Math.max(1, Math.min(o.maxLines ?? 99, Math.floor(height / (s * o.lh))));
  let lines = breakLines(words, s, width, k);
  const out = [...words];
  if (lines.length > maxL) {
    lines = lines.slice(0, maxL);
    const last = lines[maxL - 1]!;
    const li = last[last.length - 1]!;
    out[li] = `${out[li]}…`;
  }
  return { size: s, lines, words: out };
}

/** Indices of body words that belong to the `phrase` (every occurrence). */
export function matchPhrase(words: string[], phrase: string | null | undefined): boolean[] {
  const marks = words.map(() => false);
  const pw = splitWords(phrase).map(cleanWord).filter(Boolean);
  if (!pw.length) return marks;
  const cw = words.map(cleanWord);
  for (let i = 0; i + pw.length <= cw.length; i++) {
    if (pw.every((w, j) => cw[i + j] === w)) for (let j = 0; j < pw.length; j++) marks[i + j] = true;
  }
  return marks;
}

export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const ch = (i: number) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}

/** Readable content colour on a solid fill. */
export function onFill(c: string): string {
  return luminance(c) > 0.32 ? DARK : "#FFFFFF";
}

/** Deterministic 0..1 hash. */
export function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function solidFill(c: string): string {
  return `linear-gradient(150deg, ${mix(c, "#FFFFFF", 0.32)} 0%, ${c} 52%, ${mix(c, "#000000", 0.2)} 100%)`;
}

/** A word that enters per the animation's entrance — RISE/SLIDE/DROP/WIPE = a masked slide
 * (the premium kinetic-type reveal), others use the shared element vocabulary. */
export function Word({ ctx, start, len, size, face, children }: { ctx: GCtx; start: number; len: number; size: number; face: CSSProperties; children: ReactNode }) {
  const style = ctx.anim.enter;
  if (style === "RISE" || style === "SLIDE" || style === "DROP" || style === "WIPE") {
    const t = prog(ctx.frame, start, Math.round(len * 1.25), ctx.ease);
    const dir = style === "DROP" ? -1 : 1;
    const masked = t < 0.999;
    const pad = Math.round(size * 0.18);
    return (
      <span style={{ display: "inline-block", overflow: masked ? "hidden" : "visible", padding: `${pad}px 0.06em`, margin: `${-pad}px -0.06em`, opacity: t <= 0 ? 0 : 1 }}>
        <span style={{ display: "inline-block", transform: masked ? `translateY(${r1((1 - t) * dir * 115)}%)` : undefined, ...face }}>{children}</span>
      </span>
    );
  }
  const s = enterStyle(ctx, start, len, { blurOK: true });
  return (
    <span style={{ display: "inline-block", ...css(s) }}>
      <span style={face}>{children}</span>
    </span>
  );
}

export function goldFace(ctx: GCtx, glow: number): CSSProperties {
  return { ...gradientText(ctx.p.primary), filter: `drop-shadow(0 0 ${r1(10 + 18 * glow)}px ${rgba(ctx.p.primary, 0.22 + 0.3 * glow)}) drop-shadow(0 6px 16px ${rgba("#000000", 0.5)})` };
}

/** A tinted glass disc holding a line icon. */
export function Disc({ size, color, icon, draw = 1, style }: { size: number; color: string; icon: GraphicIcon | null; draw?: number; style?: CSSProperties }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: `radial-gradient(circle at 34% 28%, ${rgba(mix(color, "#FFFFFF", 0.25), 0.34)} 0%, ${rgba(color, 0.14)} 46%, ${rgba("#0E0E16", 0.78)} 100%)`,
        boxShadow: `inset 0 0 0 1.5px ${rgba(color, 0.55)}, inset 0 2px 0 ${rgba("#FFFFFF", 0.2)}, 0 14px 32px ${rgba("#000000", 0.42)}`,
        ...style,
      }}
    >
      {icon ? <GIcon icon={icon} size={Math.round(size * 0.5)} color={mix(color, "#FFFFFF", 0.18)} draw={draw} stroke={1.9} /> : <div style={{ width: size * 0.22, height: size * 0.22, borderRadius: "50%", background: color, boxShadow: `0 0 ${size * 0.2}px ${rgba(color, 0.7)}` }} />}
    </div>
  );
}

// ===================================================================== KINETIC

function Kinetic({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "HIGHLIGHT":
      return <KineticHighlight ctx={ctx} />;
    case "STRIKE":
      return <KineticStrike ctx={ctx} />;
    case "OUTLINE":
      return <KineticOutline ctx={ctx} />;
    default:
      return <KineticStack ctx={ctx} />;
  }
}

/** Lines stack in one after another, each word sliding up out of its own mask; the key
 * word(s) (`title`), else the last line, land in gold. */
function KineticStack({ ctx }: { ctx: GCtx }) {
  const { props, p, fps } = ctx;
  const words = splitWords(props.body ?? props.title);
  const fit = fitWords(words, ctx.width - 60, ctx.height - 40, { max: 140, min: 48, lh: 1.04 });
  const { size, lines } = fit;
  const keys = matchPhrase(fit.words, props.body ? props.title : null);
  const hasKey = keys.some(Boolean);
  const lineSeq = listSequence(lines.length, { ...ctx.anim, stagger: Math.max(0.14, ctx.anim.stagger * 1.8) }, seqOpts(ctx));
  const wordGap = Math.max(1, Math.round((0.055 * fps * ctx.f.tempo) / Math.max(0.5, ctx.anim.speed)));
  const em = emphasisAt(ctx, lineSeq.done);
  const lastWordOnly = lines.length === 1 && (lines[0]?.length ?? 0) > 1;
  return (
    <div style={{ ...fill, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <Scrim strength={0.34} />
      {lines.map((ln, li) => {
        const isLast = li === lines.length - 1;
        const ex = withExit(ctx, { opacity: 1, transform: "none" }, li, lines.length);
        return (
          <div key={li} style={{ position: "relative", display: "flex", columnGap: size * 0.24, justifyContent: "center", fontFamily: FONT.display, fontSize: size, lineHeight: 1.04, letterSpacing: "-0.03em", whiteSpace: "nowrap", ...css(ex) }}>
            {ln.map((wi, k) => {
              const gold = hasKey ? keys[wi]! : isLast && (lines.length > 1 || (lastWordOnly && k === ln.length - 1));
              return (
                <Word key={wi} ctx={ctx} start={lineSeq.at(0, li) + k * wordGap} len={lineSeq.len} size={size} face={gold ? goldFace(ctx, em.on) : { color: p.ink, textShadow: TEXT_LIFT }}>
                  {fit.words[wi]}
                </Word>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** The text builds, then a marker sweeps behind the words matching `title` (the last word
 * when nothing matches) and the type flips dark on the ink. */
function KineticHighlight({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const raw = splitWords(props.body ?? props.title);
  let marks = matchPhrase(raw, props.body ? props.title : null);
  if (!marks.some(Boolean) && raw.length) marks = raw.map((_, i) => i === raw.length - 1);
  // Tokens: a highlighted run is one unbreakable token (joined by NBSP).
  const tokens: Array<{ text: string; hl: boolean }> = [];
  raw.forEach((w, i) => {
    const prev = tokens[tokens.length - 1];
    if (marks[i] && prev?.hl && marks[i - 1]) prev.text += `${String.fromCharCode(160)}${w}`;
    else tokens.push({ text: w, hl: !!marks[i] });
  });
  const fit = fitWords(tokens.map((t) => t.text), ctx.width - 60, ctx.height - 40, { max: 120, min: 46, lh: 1.12 });
  const { size, lines } = fit;
  const seq = listSequence(tokens.length, ctx.anim, seqOpts(ctx));
  const hlIdx = tokens.map((t, i) => (t.hl ? i : -1)).filter((i) => i >= 0);
  const sweepLen = Math.round(0.42 * fps);
  const mark0 = Math.max(seq.done + 2, ctx.hit != null && ctx.hit > seq.done ? Math.round(ctx.hit) - 4 : 0);
  const k = squeeze(ctx, mark0, sweepLen * hlIdx.length, 0.5);
  return (
    <div style={{ ...fill, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <Scrim strength={0.34} />
      {lines.map((ln, li) => (
        <div key={li} style={{ position: "relative", display: "flex", columnGap: size * 0.26, justifyContent: "center", fontFamily: FONT.display, fontSize: size, lineHeight: 1.12, letterSpacing: "-0.025em", whiteSpace: "nowrap", ...css(withExit(ctx, { opacity: 1, transform: "none" }, li, lines.length)) }}>
          {ln.map((ti) => {
            const t = tokens[ti]!;
            const text = fit.words[ti];
            const st = seq.at(0, ti);
            if (!t.hl)
              return (
                <Word key={ti} ctx={ctx} start={st} len={seq.len} size={size} face={{ color: p.ink, textShadow: TEXT_LIFT }}>
                  {text}
                </Word>
              );
            const order = hlIdx.indexOf(ti);
            const m = prog(frame, mark0 + Math.round(order * sweepLen * k), Math.max(4, Math.round(sweepLen * k)), EASE_IN_OUT);
            return (
              <Word key={ti} ctx={ctx} start={st} len={seq.len} size={size} face={{ position: "relative", color: mix(p.ink, DARK, clamp01(m * 1.6 - 0.3)), textShadow: m > 0.3 ? "none" : TEXT_LIFT }}>
                <span style={{ position: "absolute", left: "-0.12em", right: "-0.12em", top: "0.1em", bottom: "0.02em", borderRadius: size * 0.14, background: `linear-gradient(100deg, ${mix(p.primary, "#FFFFFF", 0.2)} 0%, ${p.primary} 60%, ${mix(p.primary, "#000000", 0.08)} 100%)`, transform: `rotate(-1.6deg) scaleX(${r4(m)})`, transformOrigin: "0% 50%", boxShadow: m > 0.05 ? `0 6px 22px ${rgba("#000000", 0.35)}, 0 0 30px ${rgba(p.primary, 0.3 * m)}` : undefined, zIndex: 0 }} />
                <span style={{ position: "relative", zIndex: 1 }}>{text}</span>
              </Word>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Which body word is struck: `~word~` marks it explicitly; otherwise the last word of the
 * first clause ("It's not a cost, it's an" → cost), else the body's last word. */
function strikeTarget(words: string[]): number {
  for (let i = 0; i < words.length; i++) if (/^~.*~[,.;:!?]*$/.test(words[i]!)) return i;
  for (let i = 0; i < words.length - 1; i++) if (/[,.;:—–]$/.test(words[i]!)) return i;
  return words.length - 1;
}

/** Body builds; a red strike sweeps through the wrong word; the `title` writes in below in
 * gold with a hand-drawn underline ("It's not a ~~cost~~, it's an → investment"). */
function KineticStrike({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const id = sid(useId());
  const words = splitWords(props.body).map((w) => w);
  const xi = words.length ? strikeTarget(words) : -1;
  if (xi >= 0) words[xi] = words[xi]!.replace(/~/g, "");
  const title = (props.title ?? "").trim();
  const W = ctx.width - 60;
  let fit: Fitted = { size: 60, lines: [], words };
  let tSize = 0;
  for (let s = 108; s >= 44; s -= 4) {
    const f = fitWords(words, W, ctx.height, { max: s, min: s, lh: 1.08 });
    const ts = title ? Math.min(Math.round(s * 1.45), fitLine(title, W, Math.round(s * 1.45), 44)) : 0;
    const total = f.lines.length * s * 1.08 + (title ? ts * 1.12 + ts * 0.32 + 10 : 0);
    fit = f;
    tSize = ts;
    if (total <= ctx.height - 30 && f.words.every((w, i) => w === words[i])) break;
  }
  const size = fit.size;
  const seq = listSequence(Math.max(1, words.length), ctx.anim, seqOpts(ctx));
  const t1 = seq.done + 3;
  const Ls = Math.round(0.32 * fps);
  const gap = Math.round(0.08 * fps);
  const Lt = Math.round(0.5 * fps);
  const Lu = Math.round(0.45 * fps);
  const k = squeeze(ctx, t1, Ls + gap + Math.round(0.25 * fps) + Lu, 0.5);
  const strikeP = xi >= 0 ? prog(frame, t1, Math.max(3, Math.round(Ls * k)), EASE_IN_OUT) : 1;
  const t2 = t1 + Math.round((Ls + gap) * k);
  const sp = springAt(frame, fps, t2, ctx.f.springs.soft, Math.round(Lt * 1.6));
  const tO = prog(frame, t2, Math.max(3, Math.round(6 * k)));
  const uP = prog(frame, t2 + Math.round(0.25 * fps * k), Math.max(4, Math.round(Lu * k)), EASE_IN_OUT);
  const em = emphasisAt(ctx, t2 + Lt);
  const tw = textW(title, tSize) * 0.98;
  const uh = Math.round(tSize * 0.34);
  return (
    <div style={{ ...fill, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <Scrim strength={0.34} />
      {fit.lines.map((ln, li) => (
        <div key={li} style={{ position: "relative", display: "flex", columnGap: size * 0.26, justifyContent: "center", fontFamily: FONT.display, fontSize: size, lineHeight: 1.08, letterSpacing: "-0.025em", whiteSpace: "nowrap", ...css(withExit(ctx, { opacity: 1, transform: "none" }, li, fit.lines.length + 1)) }}>
          {ln.map((wi) => {
            const w = fit.words[wi]!;
            if (wi !== xi)
              return (
                <Word key={wi} ctx={ctx} start={seq.at(0, wi)} len={seq.len} size={size} face={{ color: p.ink, textShadow: TEXT_LIFT }}>
                  {w}
                </Word>
              );
            const m = /^(.*?)([,.;:!?—–]*)$/.exec(w);
            const core = m?.[1] || w;
            const tail = m?.[2] ?? "";
            return (
              <Word key={wi} ctx={ctx} start={seq.at(0, wi)} len={seq.len} size={size} face={{ color: p.ink, textShadow: TEXT_LIFT }}>
                <span style={{ position: "relative", display: "inline-block", color: mix(p.ink, p.muted, strikeP), opacity: 1 - 0.38 * strikeP }}>
                  {core}
                  <span style={{ position: "absolute", left: "-6%", right: "-6%", top: "50%", height: Math.max(6, Math.round(size * 0.09)), marginTop: -Math.max(3, Math.round(size * 0.045)), borderRadius: 99, background: `linear-gradient(90deg, ${mix(p.negative, "#FFFFFF", 0.15)}, ${p.negative})`, transform: `rotate(-5deg) scaleX(${r4(strikeP)})`, transformOrigin: "0% 50%", boxShadow: `0 0 16px ${rgba(p.negative, 0.5)}, 0 3px 8px ${rgba("#000000", 0.4)}`, opacity: strikeP > 0 ? 1 : 0 }} />
                </span>
                {tail}
              </Word>
            );
          })}
        </div>
      ))}
      {title ? (
        <div style={{ position: "relative", marginTop: 10, display: "flex", flexDirection: "column", alignItems: "center", opacity: tO, transform: `translateY(${r1((1 - sp) * 34 * ctx.f.distance)}px) scale(${r4(0.86 + 0.14 * sp)})`, transformOrigin: "50% 80%", ...css(withExit(ctx, { opacity: tO, transform: "none" }, fit.lines.length, fit.lines.length + 1)) }}>
          <div style={{ fontFamily: FONT.display, fontSize: tSize, lineHeight: 1.12, letterSpacing: "-0.03em", whiteSpace: "nowrap", ...goldFace(ctx, em.on) }}>{title}</div>
          <svg width={tw} height={uh} viewBox={`0 0 ${r1(tw)} ${uh}`} style={{ display: "block", overflow: "visible", marginTop: -uh * 0.18, filter: STROKE_SHADOW }}>
            <defs>
              <linearGradient id={`u${id}`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor={mix(p.primary, "#FFFFFF", 0.3)} />
                <stop offset="1" stopColor={p.primary} />
              </linearGradient>
            </defs>
            <path d={`M ${r1(tw * 0.02)} ${r1(uh * 0.62)} C ${r1(tw * 0.3)} ${r1(uh * 0.2)}, ${r1(tw * 0.66)} ${r1(uh * 0.18)}, ${r1(tw * 0.98)} ${r1(uh * 0.42)}`} fill="none" stroke={`url(#u${id})`} strokeWidth={Math.max(5, tSize * 0.075)} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={r4(1 - uP)} />
          </svg>
        </div>
      ) : null}
    </div>
  );
}

/** Huge outlined type; each line fills with colour left → right (soft leading edge). */
function KineticOutline({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const words = splitWords(props.body ?? props.title);
  const fit = fitWords(words, ctx.width - 50, ctx.height - 30, { max: 220, min: 56, lh: 1.0 });
  const { size, lines } = fit;
  const seq = listSequence(lines.length, { ...ctx.anim, stagger: Math.max(0.12, ctx.anim.stagger * 1.6) }, seqOpts(ctx));
  const fillLen = Math.round(0.75 * fps);
  const k = squeeze(ctx, seq.at(0, 0) + Math.round(0.28 * fps), fillLen + (seq.at(0, lines.length - 1) - seq.at(0, 0)), 0.4);
  const strokeW = Math.max(2.5, r1(size * 0.02));
  return (
    <div style={{ ...fill, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <Scrim strength={0.3} />
      {lines.map((ln, li) => {
        const text = ln.map((i) => fit.words[i]).join(" ");
        const inS = withExit(ctx, enterStyle(ctx, seq.at(0, li), seq.len, { blurOK: true }), li, lines.length);
        const fs = seq.at(0, li) + Math.round(0.28 * fps * k);
        const f = prog(frame, fs, Math.max(4, Math.round(fillLen * k)), EASE_IN_OUT);
        const isLast = li === lines.length - 1 && lines.length > 1;
        const pct = f * 112 - 6;
        const mask = `linear-gradient(90deg, #000 ${r1(pct - 6)}%, transparent ${r1(pct + 6)}%)`;
        const base: CSSProperties = { fontFamily: FONT.display, fontSize: size, lineHeight: 1.0, letterSpacing: "-0.02em", whiteSpace: "nowrap", padding: "0 0.04em" };
        return (
          <div key={li} style={{ position: "relative", ...css(inS) }}>
            <div style={{ ...base, color: "transparent", WebkitTextStroke: `${strokeW}px ${rgba(isLast ? mix(p.primary, "#FFFFFF", 0.2) : p.ink, 0.92)}`, filter: `drop-shadow(0 3px 10px ${rgba("#000000", 0.55)})` }}>{text}</div>
            {f > 0 ? (
              <div style={{ ...base, position: "absolute", left: 0, top: 0, ...(isLast ? gradientText(p.primary) : { color: p.ink }), WebkitMaskImage: f < 1 ? mask : undefined, maskImage: f < 1 ? mask : undefined, filter: isLast ? `drop-shadow(0 0 22px ${rgba(p.primary, 0.35)})` : `drop-shadow(0 4px 18px ${rgba("#000000", 0.4)})` }}>{text}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ===================================================================== QUOTE

function Quote({ ctx }: { ctx: GCtx }) {
  if (ctx.variant === "NOTE") return <QuoteNote ctx={ctx} />;
  if (ctx.variant === "BUBBLE") return <QuoteBubble ctx={ctx} />;
  return <QuoteCard ctx={ctx} />;
}

/** Glass card, big gold serif quote mark, the quote in serif, a ruled attribution. */
function QuoteCard({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const pad = 64;
  const bodyText = props.body?.trim() || props.title || "";
  const attr = props.body?.trim() ? props.title : null;
  const markH = 96;
  const attrH = attr ? 78 : 0;
  const bodyTop = pad + markH;
  const bodyH = ctx.height - bodyTop - pad - attrH;
  const bodyW = ctx.width - pad * 2;
  const words = splitWords(bodyText);
  const fit = fitWords(words, bodyW, bodyH, { max: 66, min: 44, lh: 1.2, k: 0.9 });
  const { size, lines } = fit;
  const blockH = lines.length * size * 1.2;
  const seq = listSequence(words.length, { ...ctx.anim, stagger: Math.min(ctx.anim.stagger, 0.05) }, seqOpts(ctx, Math.round(0.3 * fps)));
  const ms = springAt(frame, fps, 2, ctx.f.springs.soft, Math.round(0.9 * fps));
  const mo = prog(frame, 2, 8);
  const attrT = prog(frame, seq.done - Math.round(0.1 * fps), Math.round(0.5 * fps), ctx.ease);
  return (
    <Panel ctx={ctx} pad={pad}>
      <div style={{ ...fill, borderRadius: 44, background: `radial-gradient(ellipse 60% 50% at 8% 0%, ${rgba(p.primary, 0.12)} 0%, transparent 70%)` }} />
      <div style={{ position: "absolute", left: pad - 10, top: pad - 34, fontFamily: FONT.serif, fontSize: 230, lineHeight: 1, height: 150, ...gradientText(p.primary), opacity: mo, transform: `translateY(${r1((1 - ms) * 24)}px) scale(${r4(0.7 + 0.3 * ms)})`, transformOrigin: "20% 40%", filter: `drop-shadow(0 6px 18px ${rgba(p.primary, 0.25)})` }}>“</div>
      <div style={{ position: "absolute", left: pad, top: bodyTop + Math.max(0, (bodyH - blockH) / 2), width: bodyW }}>
        {lines.map((ln, li) => (
          <div key={li} style={{ display: "flex", columnGap: size * 0.24, fontFamily: FONT.serif, fontSize: size, lineHeight: 1.2, color: p.ink, whiteSpace: "nowrap", letterSpacing: "-0.005em" }}>
            {ln.map((wi) => (
              <span key={wi} style={{ display: "inline-block", ...css(seqStyle(ctx, seq, 0, wi, { distance: 0.4 })) }}>
                {fit.words[wi]}
              </span>
            ))}
          </div>
        ))}
      </div>
      {attr ? (
        <div style={{ position: "absolute", left: pad, right: pad, bottom: pad - 6, height: 48, display: "flex", alignItems: "center", gap: 20, opacity: attrT, transform: `translateX(${r1((1 - attrT) * -18)}px)` }}>
          <div style={{ width: 56, height: 3, borderRadius: 3, flex: "none", background: `linear-gradient(90deg, ${p.primary}, ${rgba(p.primary, 0.3)})`, transform: `scaleX(${r4(attrT)})`, transformOrigin: "left" }} />
          <div style={{ fontFamily: FONT.text, fontSize: fitLine(attr, bodyW - 80, 34, 28), color: mix(p.muted, p.primary, 0.25), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: "0.01em" }}>{attr}</div>
        </div>
      ) : null}
    </Panel>
  );
}

/** Note card: gold left rule, small-caps heading (`title`), the note in display type. */
function QuoteNote({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const pad = 56;
  const left = pad + 34;
  const heading = props.body?.trim() ? props.title : null;
  const bodyText = props.body?.trim() || props.title || "";
  const headH = heading ? 62 : 0;
  const bodyW = ctx.width - left - pad;
  const bodyH = ctx.height - 2 * pad - headH;
  const fit = fitWords(splitWords(bodyText), bodyW, bodyH, { max: 64, min: 44, lh: 1.16 });
  const { size, lines } = fit;
  const blockH = lines.length * size * 1.16 + headH;
  const top = pad + Math.max(0, (ctx.height - 2 * pad - blockH) / 2);
  const seq = listSequence(lines.length, { ...ctx.anim, stagger: Math.max(0.1, ctx.anim.stagger) }, seqOpts(ctx, Math.round(0.32 * fps)));
  const rule = prog(frame, 2, Math.round(0.55 * fps), ctx.ease);
  const hT = prog(frame, Math.round(0.12 * fps), Math.round(0.45 * fps), ctx.ease);
  return (
    <Panel ctx={ctx} pad={pad}>
      <div style={{ position: "absolute", left: pad - 6, top: pad, bottom: pad, width: 7, borderRadius: 7, background: `linear-gradient(180deg, ${mix(p.primary, "#FFFFFF", 0.25)}, ${p.primary} 55%, ${rgba(p.primary, 0.25)})`, transform: `scaleY(${r4(rule)})`, transformOrigin: "top", boxShadow: `0 0 18px ${rgba(p.primary, 0.45)}` }} />
      <div style={{ ...fill, borderRadius: 44, background: `linear-gradient(90deg, ${rgba(p.primary, 0.08)} 0%, transparent 35%)`, opacity: rule }} />
      <div style={{ position: "absolute", left, top, width: bodyW }}>
        {heading ? (
          <div style={{ height: headH, fontFamily: FONT.text, fontSize: fitLine(heading.toUpperCase(), bodyW, 30, 28, 1.25), letterSpacing: "0.14em", color: p.primary, textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", opacity: hT, transform: `translateY(${r1((1 - hT) * 10)}px)` }}>{heading}</div>
        ) : null}
        {lines.map((ln, li) => (
          <div key={li} style={{ fontFamily: FONT.displayBold, fontSize: size, lineHeight: 1.16, letterSpacing: "-0.018em", color: p.ink, whiteSpace: "nowrap", ...css(seqStyle(ctx, seq, 0, li, { distance: 0.6 })) }}>
            {ln.map((i) => fit.words[i]).join(" ")}
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** A clean speech bubble with a tail; pops in from the tail on a spring. */
function QuoteBubble({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps } = ctx;
  const id = sid(useId());
  const W = ctx.width;
  const H = ctx.height;
  const x0 = 14;
  const y0 = 14;
  const x1 = W - 14;
  const y1 = H - 86;
  const r = Math.min(70, (y1 - y0) / 2);
  const tb1 = x0 + W * 0.15;
  const tb2 = tb1 + 96;
  const tipX = x0 + W * 0.07;
  const tipY = H - 14;
  const d = `M ${x0 + r} ${y0} H ${x1 - r} A ${r} ${r} 0 0 1 ${x1} ${y0 + r} V ${y1 - r} A ${r} ${r} 0 0 1 ${x1 - r} ${y1} H ${tb2} Q ${tb2 - 30} ${y1 + 34} ${tipX} ${tipY} Q ${tb1 + 14} ${y1 + 30} ${tb1} ${y1} H ${x0 + r} A ${r} ${r} 0 0 1 ${x0} ${y1 - r} V ${y0 + r} A ${r} ${r} 0 0 1 ${x0 + r} ${y0} Z`;
  const label = props.body?.trim() ? props.title : null;
  const text = props.body?.trim() || props.title || "";
  const padX = 64;
  const labelH = label ? 46 : 0;
  const fit = fitWords(splitWords(text), x1 - x0 - padX * 2, y1 - y0 - 70 - labelH, { max: 78, min: 44, lh: 1.12 });
  const { size, lines } = fit;
  const s = springAt(frame, fps, 0, ctx.f.springs.soft, Math.round(0.9 * fps));
  const o = prog(frame, 0, 5);
  const seq = listSequence(fit.words.length, { ...ctx.anim, stagger: Math.min(0.05, ctx.anim.stagger) }, seqOpts(ctx, Math.round(0.22 * fps)));
  const ox = r1((tipX / W) * 100);
  return (
    <div style={{ ...fill, opacity: o, transform: `scale(${r4(0.25 + 0.75 * s)}) rotate(${r1((1 - s) * -6)}deg)`, transformOrigin: `${ox}% 100%` }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0, overflow: "visible", filter: `drop-shadow(0 22px 40px ${rgba("#000000", 0.45)}) drop-shadow(0 4px 10px ${rgba("#000000", 0.3)})` }}>
        <defs>
          <linearGradient id={`b${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#FBFAF7" />
            <stop offset="1" stopColor="#E9E5DD" />
          </linearGradient>
        </defs>
        <path d={d} fill={`url(#b${id})`} />
        <path d={d} fill="none" stroke={rgba("#FFFFFF", 0.9)} strokeWidth={1.5} />
      </svg>
      <div style={{ position: "absolute", left: x0 + padX, right: W - x1 + padX, top: y0, height: y1 - y0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-start" }}>
        {label ? <div style={{ height: labelH, fontFamily: FONT.text, fontSize: 30, color: mix(DARK, "#FFFFFF", 0.45), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{label}</div> : null}
        {lines.map((ln, li) => (
          <div key={li} style={{ display: "flex", columnGap: size * 0.25, fontFamily: FONT.display, fontSize: size, lineHeight: 1.12, letterSpacing: "-0.025em", color: DARK, whiteSpace: "nowrap" }}>
            {ln.map((wi) => (
              <span key={wi} style={{ display: "inline-block", ...css(seqStyle(ctx, seq, 0, wi, { style: ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter, distance: 0.4 })) }}>
                {fit.words[wi]}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ===================================================================== LOWER_THIRD

function LowerThird({ ctx }: { ctx: GCtx }) {
  if (ctx.variant === "TAG") return <LowerTag ctx={ctx} />;
  if (ctx.variant === "MINIMAL") return <LowerMinimal ctx={ctx} />;
  return <LowerBar ctx={ctx} />;
}

/** Gold bar grows, a glass plate wipes out of it, name + role slide out from behind it. */
function LowerBar({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const name = props.title ?? "";
  const role = props.subtitle ?? "";
  const barW = 12;
  const plateH = role ? 176 : 132;
  const top = (ctx.height - plateH) / 2;
  const padX = 40;
  const maxW = ctx.width - barW;
  const nameSize = fitLine(name, maxW - padX * 2, 70, 44);
  const roleSize = role ? fitLine(role, maxW - padX * 2, 36, 28, 1.02) : 0;
  const plateW = Math.min(maxW, Math.max(320, Math.max(textW(name, nameSize), role ? textW(role, roleSize, 1.02) : 0) + padX * 2 + 24));
  const b = springAt(frame, fps, 0, ctx.f.springs.settle, Math.round(0.6 * fps));
  const w = prog(frame, Math.round(0.16 * fps), Math.round(0.5 * fps), ctx.ease);
  const n = prog(frame, Math.round(0.28 * fps), Math.round(0.5 * fps), ctx.ease);
  const rl = prog(frame, Math.round(0.38 * fps), Math.round(0.5 * fps), ctx.ease);
  const line = prog(frame, Math.round(0.45 * fps), Math.round(0.6 * fps), ctx.ease);
  return (
    <div style={fill}>
      <div style={{ position: "absolute", left: barW, top, width: plateW, height: plateH, clipPath: `inset(-40px ${r1((1 - w) * 100)}% -40px 0)` }}>
        <div style={{ ...fill, ...glassCard(p, 0), borderRadius: "0 30px 30px 0" }} />
        <div style={{ position: "absolute", left: 0, bottom: 0, height: 3, width: "100%", background: `linear-gradient(90deg, ${p.primary}, ${rgba(p.primary, 0)} 80%)`, transform: `scaleX(${r4(line)})`, transformOrigin: "left", opacity: 0.85 }} />
        <div style={{ position: "absolute", left: padX, right: padX, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center", overflow: "hidden" }}>
          <div style={{ fontFamily: FONT.displayBold, fontSize: nameSize, lineHeight: 1.08, letterSpacing: "-0.02em", color: p.ink, whiteSpace: "nowrap", opacity: n, transform: `translateX(${r1((1 - n) * -70)}px)` }}>{name}</div>
          {role ? <div style={{ marginTop: 6, fontFamily: FONT.text, fontSize: roleSize, lineHeight: 1.2, color: mix(p.muted, p.ink, 0.25), whiteSpace: "nowrap", opacity: rl, transform: `translateX(${r1((1 - rl) * -50)}px)` }}>{role}</div> : null}
        </div>
      </div>
      <div style={{ position: "absolute", left: 0, top, width: barW, height: plateH, borderRadius: 4, background: heroGradient(p.primary), transform: `scaleY(${r4(Math.max(0, b))})`, transformOrigin: "50% 50%", boxShadow: `0 0 22px ${rgba(p.primary, 0.55)}` }} />
    </div>
  );
}

/** Two-part pill: a gold tag (`title`) and a glass label (`subtitle`) sliding out of it. */
function LowerTag({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const tag = props.title ?? "";
  const label = props.subtitle ?? "";
  const h = 100;
  const top = (ctx.height - h) / 2;
  const tagSize = fitLine(tag, ctx.width * 0.5 - 60, 46, 32);
  const tagW = Math.round(textW(tag, tagSize) + 64);
  const restW = ctx.width - tagW - 14;
  const labSize = label ? fitLine(label, restW - 76, 44, 30) : 0;
  const labW = label ? Math.min(restW, Math.round(textW(label, labSize) + 80)) : 0;
  const s = springAt(frame, fps, 0, ctx.f.springs.soft, Math.round(0.8 * fps));
  const o = prog(frame, 0, 5);
  const l = prog(frame, Math.round(0.2 * fps), Math.round(0.5 * fps), ctx.ease);
  return (
    <div style={fill}>
      {label ? (
        <div style={{ position: "absolute", left: tagW - 40, top, width: labW + 54, height: h, clipPath: `inset(-30px ${r1((1 - l) * 100)}% -30px 0)` }}>
          <div style={{ ...fill, ...glassCard(p, h / 2) }} />
          <div style={{ position: "absolute", left: 40 + 14, right: 26, top: 0, bottom: 0, display: "flex", alignItems: "center", fontFamily: FONT.displayBold, fontSize: labSize, letterSpacing: "-0.015em", color: p.ink, whiteSpace: "nowrap", opacity: l, transform: `translateX(${r1((1 - l) * -30)}px)` }}>
            <span style={{ paddingLeft: 26 }}>{label}</span>
          </div>
        </div>
      ) : null}
      <div style={{ position: "absolute", left: 0, top, width: tagW, height: h, borderRadius: h / 2, background: solidFill(p.primary), boxShadow: `0 14px 34px ${rgba("#000000", 0.4)}, inset 0 2px 0 ${rgba("#FFFFFF", 0.4)}, 0 0 30px ${rgba(p.primary, 0.3)}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, fontSize: tagSize, letterSpacing: "-0.015em", color: onFill(p.primary), whiteSpace: "nowrap", opacity: o, transform: `scale(${r4(0.5 + 0.5 * s)})`, transformOrigin: "30% 50%" }}>{tag}</div>
    </div>
  );
}

/** A thin gold rule that draws, a small-caps label above it and a line of text below. */
function LowerMinimal({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const label = props.title ?? "";
  const text = props.subtitle ?? "";
  const W = ctx.width - 24;
  const labSize = fitLine(label.toUpperCase(), W, 30, 28, 1.3);
  const txtSize = text ? fitLine(text, W, 50, 34) : 0;
  const ruleW = Math.min(W, Math.max(160, Math.max(textW(label.toUpperCase(), labSize, 1.3), text ? textW(text, txtSize) : 0) * 0.55));
  const rule = prog(frame, 0, Math.round(0.6 * fps), ctx.ease);
  const a = prog(frame, Math.round(0.12 * fps), Math.round(0.5 * fps), ctx.ease);
  const b = prog(frame, Math.round(0.24 * fps), Math.round(0.5 * fps), ctx.ease);
  return (
    <div style={{ ...fill, display: "flex", flexDirection: "column", justifyContent: "center", paddingLeft: 12 }}>
      <Scrim strength={0.28} />
      <div style={{ position: "relative", fontFamily: FONT.text, fontSize: labSize, letterSpacing: "0.16em", textTransform: "uppercase", color: p.primary, whiteSpace: "nowrap", textShadow: TEXT_LIFT, opacity: a, transform: `translateY(${r1((1 - a) * 12)}px)` }}>{label}</div>
      <div style={{ position: "relative", marginTop: 14, marginBottom: 16, width: ruleW, height: 3, borderRadius: 3, background: `linear-gradient(90deg, ${p.primary}, ${rgba(p.primary, 0)})`, transform: `scaleX(${r4(rule)})`, transformOrigin: "left", boxShadow: `0 0 12px ${rgba(p.primary, 0.4)}` }} />
      {text ? <div style={{ position: "relative", fontFamily: FONT.displayBold, fontSize: txtSize, lineHeight: 1.1, letterSpacing: "-0.015em", color: p.ink, whiteSpace: "nowrap", textShadow: TEXT_LIFT, opacity: b, transform: `translateY(${r1((1 - b) * -12)}px)` }}>{text}</div> : null}
    </div>
  );
}

// ===================================================================== ANNOTATION

function Annotation({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "ARROW":
      return <AnnotArrow ctx={ctx} />;
    case "UNDERLINE":
      return <AnnotUnderline ctx={ctx} />;
    case "BOX":
      return <AnnotBox ctx={ctx} />;
    default:
      return <AnnotCircle ctx={ctx} />;
  }
}

function annotLabelStyle(ctx: GCtx, size: number): CSSProperties {
  return { fontFamily: FONT.display, fontSize: size, lineHeight: 1.05, letterSpacing: "-0.02em", color: ctx.p.primary, whiteSpace: "nowrap", textShadow: `0 2px 4px ${rgba("#000000", 0.6)}, 0 6px 22px ${rgba("#000000", 0.55)}` };
}

/** A hand-drawn ellipse drawing itself around the box centre, overshooting into a second loop. */
function AnnotCircle({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const W = ctx.width;
  const cH = Math.min(W, ctx.height);
  const cx = W / 2;
  const cy = cH / 2;
  const rx = W / 2 - 34;
  const ry = cH / 2 - 56;
  const tilt = (-9 * Math.PI) / 180;
  const N = 96;
  const a0 = (-128 * Math.PI) / 180;
  const sweep = Math.PI * 2 + 0.62;
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const a = a0 + sweep * u;
    const k = 0.94 + 0.1 * u + 0.025 * Math.sin(a * 2 + 0.7);
    const x = Math.cos(a) * rx * k;
    const y = Math.sin(a) * ry * k;
    pts.push(`${i ? "L" : "M"} ${r1(cx + x * Math.cos(tilt) - y * Math.sin(tilt))} ${r1(cy + x * Math.sin(tilt) + y * Math.cos(tilt))}`);
  }
  const dP = prog(frame, Math.round(0.08 * fps), Math.round(0.62 * fps / Math.max(0.5, ctx.anim.speed)), Easing2);
  const title = props.title?.trim();
  const lT = springAt(frame, fps, Math.round(0.55 * fps), ctx.f.springs.soft, Math.round(0.8 * fps));
  const lO = prog(frame, Math.round(0.55 * fps), 6);
  const em = emphasisAt(ctx, Math.round(0.8 * fps));
  return (
    <div style={fill}>
      <svg width={W} height={cH} viewBox={`0 0 ${W} ${cH}`} style={{ position: "absolute", left: 0, top: 0, overflow: "visible", filter: STROKE_SHADOW }}>
        <path d={pts.join(" ")} fill="none" stroke={p.primary} strokeWidth={11} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={r4(1 - dP)} style={{ filter: em.on > 0.01 ? `drop-shadow(0 0 ${r1(12 * em.on)}px ${rgba(p.primary, 0.6 * em.on)})` : undefined }} />
      </svg>
      {title ? (
        <div style={{ position: "absolute", left: 0, right: 0, top: cH - 30, height: ctx.height - cH + 30, display: "flex", alignItems: "center", justifyContent: "center", opacity: lO, transform: `translateY(${r1((1 - lT) * 24)}px) rotate(-4deg) scale(${r4(0.8 + 0.2 * lT)})` }}>
          <span style={annotLabelStyle(ctx, fitLine(title, W - 20, 56, 32))}>{title}</span>
        </div>
      ) : null}
    </div>
  );
}

const Easing2 = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2) * 0.35 + (1 - (1 - t) ** 3) * 0.65;

/** A curved arrow drawing from the label up to the target, with an arrowhead. */
function AnnotArrow({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const title = props.title?.trim() ?? "";
  const lSize = title ? fitLine(title, W * 0.62, 54, 32) : 0;
  const lW = title ? Math.min(W * 0.62, textW(title, lSize)) : 0;
  const sx = title ? Math.max(70, lW * 0.62) : 60;
  const sy = title ? H - 20 - lSize * 1.1 - 22 : H - 40;
  const tx = W - 34;
  const ty = 40;
  const c1x = sx + 30;
  const c1y = sy - (sy - ty) * 0.75;
  const c2x = tx - (tx - sx) * 0.55;
  const c2y = ty + 6;
  const ang = Math.atan2(ty - c2y, tx - c2x);
  const hl = 46;
  const spread = (30 * Math.PI) / 180;
  const h1 = `M ${r1(tx - hl * Math.cos(ang - spread))} ${r1(ty - hl * Math.sin(ang - spread))} L ${tx} ${ty} L ${r1(tx - hl * Math.cos(ang + spread))} ${r1(ty - hl * Math.sin(ang + spread))}`;
  const lT = prog(frame, 0, Math.round(0.4 * fps), ctx.ease);
  const t0 = Math.round(0.2 * fps);
  const shaft = prog(frame, t0, Math.round(0.5 * fps), Easing2);
  const head = prog(frame, t0 + Math.round(0.42 * fps), Math.round(0.2 * fps), ctx.ease);
  return (
    <div style={fill}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0, overflow: "visible", filter: STROKE_SHADOW }}>
        <path d={`M ${r1(sx)} ${r1(sy)} C ${r1(c1x)} ${r1(c1y)}, ${r1(c2x)} ${r1(c2y)}, ${tx} ${ty}`} fill="none" stroke={p.primary} strokeWidth={9} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={r4(1 - shaft)} />
        <path d={h1} fill="none" stroke={p.primary} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={r4(1 - head)} />
      </svg>
      {title ? (
        <div style={{ position: "absolute", left: 6, bottom: 16, opacity: lT, transform: `translateY(${r1((1 - lT) * 18)}px) rotate(-3deg)`, transformOrigin: "0 100%" }}>
          <span style={annotLabelStyle(ctx, lSize)}>{title}</span>
        </div>
      ) : null}
    </div>
  );
}

/** A two-stroke swoosh underline (optional word above it). */
function AnnotUnderline({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const title = props.title?.trim();
  const y = H - 74;
  const main = `M 24 ${y + 10} C ${r1(W * 0.3)} ${y - 6}, ${r1(W * 0.66)} ${y - 16}, ${W - 24} ${y - 4}`;
  const back = `M ${r1(W * 0.86)} ${y + 18} C ${r1(W * 0.64)} ${y + 10}, ${r1(W * 0.4)} ${y + 18}, ${r1(W * 0.2)} ${y + 34}`;
  const t0 = title ? Math.round(0.25 * fps) : Math.round(0.06 * fps);
  const a = prog(frame, t0, Math.round(0.4 * fps), Easing2);
  const b = prog(frame, t0 + Math.round(0.34 * fps), Math.round(0.3 * fps), Easing2);
  const tT = prog(frame, 0, Math.round(0.45 * fps), ctx.ease);
  return (
    <div style={fill}>
      {title ? (
        <>
          <Scrim strength={0.26} />
          <div style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 86, display: "flex", alignItems: "center", justifyContent: "center", opacity: tT, transform: `translateY(${r1((1 - tT) * 18)}px)` }}>
            <span style={{ fontFamily: FONT.display, fontSize: fitLine(title, W - 40, 96, 44), letterSpacing: "-0.03em", color: p.ink, whiteSpace: "nowrap", textShadow: TEXT_LIFT }}>{title}</span>
          </div>
        </>
      ) : null}
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0, overflow: "visible", filter: STROKE_SHADOW }}>
        <path d={main} fill="none" stroke={p.primary} strokeWidth={13} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={r4(1 - a)} />
        <path d={back} fill="none" stroke={mix(p.primary, "#FFFFFF", 0.1)} strokeWidth={7} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={r4(1 - b)} opacity={0.9} />
      </svg>
    </div>
  );
}

/** Four corner brackets snapping in around a region, with a gold label tab. */
function AnnotBox({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const title = props.title?.trim();
  const tabH = 66;
  const top = title ? tabH + 16 : 14;
  const x0 = 14;
  const x1 = W - 14;
  const y0 = top;
  const y1 = H - 14;
  const L = Math.min(84, (x1 - x0) * 0.22, (y1 - y0) * 0.28);
  const corners: Array<{ d: string; dx: number; dy: number }> = [
    { d: `M ${x0} ${y0 + L} V ${y0 + 14} Q ${x0} ${y0} ${x0 + 14} ${y0} H ${x0 + L}`, dx: -1, dy: -1 },
    { d: `M ${x1 - L} ${y0} H ${x1 - 14} Q ${x1} ${y0} ${x1} ${y0 + 14} V ${y0 + L}`, dx: 1, dy: -1 },
    { d: `M ${x1} ${y1 - L} V ${y1 - 14} Q ${x1} ${y1} ${x1 - 14} ${y1} H ${x1 - L}`, dx: 1, dy: 1 },
    { d: `M ${x0 + L} ${y1} H ${x0 + 14} Q ${x0} ${y1} ${x0} ${y1 - 14} V ${y1 - L}`, dx: -1, dy: 1 },
  ];
  const tabSize = title ? fitLine(title, W - 80, 40, 28) : 0;
  const tabW = title ? Math.min(W - 28, textW(title, tabSize) + 48) : 0;
  const tabS = springAt(frame, fps, Math.round(0.32 * fps), ctx.f.springs.soft, Math.round(0.8 * fps));
  const tabO = prog(frame, Math.round(0.32 * fps), 5);
  const em = emphasisAt(ctx, Math.round(0.6 * fps));
  return (
    <div style={fill}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0, overflow: "visible", filter: STROKE_SHADOW }}>
        {corners.map((c, i) => {
          const s = springAt(frame, fps, i * 2, ctx.f.springs.punch, Math.round(0.6 * fps));
          const off = (1 - s) * 44;
          return <path key={i} d={c.d} fill="none" stroke={p.primary} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" opacity={prog(frame, i * 2, 4)} transform={`translate(${r1(c.dx * off)} ${r1(c.dy * off)})`} style={{ filter: em.on > 0.01 ? `drop-shadow(0 0 ${r1(10 * em.on)}px ${rgba(p.primary, 0.55 * em.on)})` : undefined }} />;
        })}
      </svg>
      {title ? (
        <div style={{ position: "absolute", left: x0 - 4, top: 0, height: tabH, width: tabW, borderRadius: 16, background: solidFill(p.primary), color: onFill(p.primary), display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, fontSize: tabSize, letterSpacing: "-0.01em", whiteSpace: "nowrap", boxShadow: `0 10px 26px ${rgba("#000000", 0.45)}, inset 0 2px 0 ${rgba("#FFFFFF", 0.35)}`, opacity: tabO, transform: `translateY(${r1((1 - tabS) * 16)}px) scale(${r4(0.7 + 0.3 * tabS)})`, transformOrigin: "0% 100%" }}>{title}</div>
      ) : null}
    </div>
  );
}

// ===================================================================== STICKER

function Sticker({ ctx }: { ctx: GCtx }) {
  if (ctx.variant === "STAMP") return <StickerStamp ctx={ctx} />;
  if (ctx.variant === "BUBBLE") return <StickerBubble ctx={ctx} />;
  return <StickerBadge ctx={ctx} />;
}

/** A die-cut badge: icon + word, pops on a spring with a tilt, a light sheen sweeps over. */
function StickerBadge({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps } = ctx;
  const it = props.items[0];
  const c = colorOf(ctx, it?.color ?? "AUTO", 0);
  const ink = onFill(c);
  const icon = it?.icon ?? null;
  const title = props.title?.trim() ?? "";
  const S = Math.min(ctx.width, ctx.height) * 0.68;
  const inner = S - 24;
  const s = springAt(frame, fps, 0, ctx.f.springs.soft, Math.round(1 * fps));
  const o = prog(frame, 0, 5);
  const land = Math.round(0.45 * fps);
  const sheen = prog(frame, land, Math.round(0.55 * fps), EASE_IN_OUT);
  const bob = Math.sin((frame / fps) * 2.2) * 1.2 * prog(frame, land, 10);
  const em = emphasisAt(ctx, land);
  const tSize = title ? fitLine(title, inner - 56, icon ? 84 : 112, 36) : 0;
  const iconSize = icon ? Math.round(inner * (title ? 0.36 : 0.5)) : 0;
  return (
    <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: S, height: S, padding: 12, boxSizing: "border-box", borderRadius: S * 0.27, background: "linear-gradient(160deg, #FFFDF8, #EEE8DC)", boxShadow: `0 26px 50px ${rgba("#000000", 0.45)}, 0 6px 14px ${rgba("#000000", 0.3)}${em.on > 0.01 ? `, ${glowShadow(c, em.on, 0.8)}` : ""}`, opacity: o, transform: `rotate(${r1(-6 + (1 - s) * -20 + bob)}deg) scale(${r4(0.3 + 0.7 * s)})` }}>
        <div style={{ position: "relative", width: "100%", height: "100%", borderRadius: S * 0.23, background: solidFill(c), overflow: "hidden", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: inner * 0.05, boxShadow: `inset 0 3px 0 ${rgba("#FFFFFF", 0.35)}, inset 0 -6px 18px ${rgba("#000000", 0.18)}` }}>
          {icon ? <GIcon icon={icon} size={iconSize} color={ink} stroke={2.1} draw={prog(frame, Math.round(0.15 * fps), Math.round(0.6 * fps), ctx.ease)} /> : null}
          {title ? <div style={{ fontFamily: FONT.display, fontSize: tSize, lineHeight: 1, letterSpacing: "-0.01em", color: ink, whiteSpace: "nowrap" }}>{title}</div> : null}
          {sheen > 0 && sheen < 1 ? <div style={{ position: "absolute", inset: "-20%", background: `linear-gradient(105deg, transparent 40%, ${rgba("#FFFFFF", 0.5)} 50%, transparent 60%)`, transform: `translateX(${r1(-90 + sheen * 180)}%)` }} /> : null}
        </div>
      </div>
    </div>
  );
}

function starPath(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push(`${r1(cx + Math.cos(a) * rr)} ${r1(cy + Math.sin(a) * rr)}`);
  }
  return `M ${pts.join(" L ")} Z`;
}

/** A rubber stamp: double ring, ruled band, the word — slams in (1.6 → 1) with an impact. */
function StickerStamp({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const it = props.items[0];
  const c = it && it.color !== "AUTO" ? colorOf(ctx, it.color, 0) : mix(p.negative, "#FFFFFF", 0.06);
  const title = (props.title?.trim() ?? "").toUpperCase();
  const S = Math.min(ctx.width, ctx.height) - 70;
  const R = S / 2;
  const land = Math.max(4, Math.round(0.2 * fps));
  const a = prog(frame, 0, land, EASE_IN);
  const age = frame - land;
  const settle = age >= 0 ? springAt(frame, fps, land, ctx.f.springs.punch, Math.round(0.5 * fps)) : 0;
  const scale = age < 0 ? 1.6 - 0.6 * a : 0.95 + 0.05 * settle;
  const shake = age >= 0 ? Math.sin(age * 2.4) * 5 * Math.max(0, 1 - age / 9) : 0;
  const ripple = age >= 0 ? clamp01(age / Math.round(0.45 * fps)) : 0;
  const band = R * 0.56;
  const tSize = title ? fitLine(title, S * 0.86, 104, 36, 1.06) : 0;
  const ink = rgba(c, 0.94);
  return (
    <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {ripple > 0 && ripple < 1 ? <div style={{ position: "absolute", width: S, height: S, borderRadius: "50%", border: `4px solid ${rgba(c, 0.5 * (1 - ripple))}`, transform: `scale(${r4(1 + ripple * 0.14)}) rotate(-12deg)` }} /> : null}
      <div style={{ position: "relative", width: S, height: S, opacity: clamp01(a * 1.6), transform: `translateX(${r1(shake)}px) rotate(${r1(-12 - (1 - a) * 8)}deg) scale(${r4(scale)})`, filter: `drop-shadow(0 ${r1(4 + 14 * (1 - a))}px ${r1(10 + 20 * (1 - a))}px ${rgba("#000000", 0.45)})` }}>
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <circle cx={R} cy={R} r={R - 8} fill={rgba("#0B0B10", 0.35)} stroke={ink} strokeWidth={12} />
          <circle cx={R} cy={R} r={R - 30} fill="none" stroke={ink} strokeWidth={3.5} />
          <circle cx={R + 1.6} cy={R + 1.2} r={R - 8} fill="none" stroke={rgba(c, 0.25)} strokeWidth={3} />
          <line x1={R - Math.sqrt((R - 30) ** 2 - (band / 2) ** 2)} x2={R + Math.sqrt((R - 30) ** 2 - (band / 2) ** 2)} y1={R - band / 2} y2={R - band / 2} stroke={ink} strokeWidth={4} />
          <line x1={R - Math.sqrt((R - 30) ** 2 - (band / 2) ** 2)} x2={R + Math.sqrt((R - 30) ** 2 - (band / 2) ** 2)} y1={R + band / 2} y2={R + band / 2} stroke={ink} strokeWidth={4} />
          {[-1, 0, 1].map((k) => (
            <path key={`t${k}`} d={starPath(R + k * R * 0.2, R - band / 2 - (R - 30 - band / 2) * 0.5 + Math.abs(k) * 6, k ? 10 : 15)} fill={ink} />
          ))}
          {[-1, 0, 1].map((k) => (
            <path key={`b${k}`} d={starPath(R + k * R * 0.2, R + band / 2 + (R - 30 - band / 2) * 0.5 - Math.abs(k) * 6, k ? 10 : 15)} fill={ink} />
          ))}
        </svg>
        <div style={{ position: "absolute", left: 0, right: 0, top: R - band / 2, height: band, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "relative", fontFamily: FONT.display, fontSize: tSize, letterSpacing: "0.04em", color: ink, whiteSpace: "nowrap", lineHeight: 1 }}>
            <span style={{ position: "absolute", left: 2, top: 1.5, color: rgba(c, 0.3) }}>{title}</span>
            {title}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A round price bubble: the value counts up big, `title` small beneath; gentle float. */
function StickerBubble({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps } = ctx;
  const it = props.items[0];
  const c = colorOf(ctx, it?.color ?? "AUTO", 0);
  const ink = onFill(c);
  const S = Math.min(ctx.width, ctx.height) * 0.76;
  const s = springAt(frame, fps, 0, ctx.f.springs.soft, Math.round(1 * fps));
  const o = prog(frame, 0, 5);
  const land = Math.round(0.4 * fps);
  const v = it?.value ?? null;
  const shown = v != null ? fmtValue(ctx, counted(ctx, Math.round(0.15 * fps), v), v).text : "";
  const finalText = v != null ? fmtValue(ctx, v, v).text : "";
  const title = props.title?.trim() ?? "";
  const vSize = v != null ? fitLine(finalText, S * 0.74, title ? 150 : 170, 44) : 0;
  const tSize = title ? fitLine(title.toUpperCase(), S * 0.6, v != null ? 40 : 96, 28, 1.2) : 0;
  const bob = Math.sin((frame / fps) * 2) * 6 * prog(frame, land, 12);
  const spin = (frame / fps) * 12;
  const em = emphasisAt(ctx, land + Math.round(0.4 * fps));
  return (
    <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", width: S, height: S, borderRadius: "50%", background: `radial-gradient(circle at 34% 28%, ${mix(c, "#FFFFFF", 0.38)} 0%, ${c} 52%, ${mix(c, "#000000", 0.22)} 100%)`, boxShadow: `0 28px 56px ${rgba("#000000", 0.45)}, 0 6px 14px ${rgba("#000000", 0.3)}, inset 0 3px 0 ${rgba("#FFFFFF", 0.35)}${em.on > 0.01 ? `, ${glowShadow(c, em.on)}` : ""}`, opacity: o, transform: `translateY(${r1(bob)}px) rotate(${r1(8 + (1 - s) * 24)}deg) scale(${r4(0.3 + 0.7 * s)})`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ position: "absolute", inset: 0, transform: `rotate(${r1(spin)}deg)` }}>
          <circle cx={S / 2} cy={S / 2} r={S / 2 - 20} fill="none" stroke={rgba(ink === DARK ? "#000000" : "#FFFFFF", 0.28)} strokeWidth={3} strokeDasharray="3 11" strokeLinecap="round" />
        </svg>
        {v != null ? <div style={{ position: "relative", fontFamily: FONT.display, fontSize: vSize, lineHeight: 1, letterSpacing: "-0.04em", color: ink, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", transform: `scale(${r4(em.scale)})` }}>{shown}</div> : null}
        {title ? <div style={{ position: "relative", marginTop: v != null ? 8 : 0, fontFamily: FONT.display, fontSize: tSize, letterSpacing: "0.12em", textTransform: "uppercase", color: ink, opacity: 0.86, whiteSpace: "nowrap" }}>{title}</div> : null}
      </div>
    </div>
  );
}

// ===================================================================== MAP_PIN

const MAP_BLOBS = [
  "ellipse 22% 26% at 20% 30%",
  "ellipse 16% 22% at 31% 68%",
  "ellipse 26% 22% at 62% 28%",
  "ellipse 15% 20% at 78% 64%",
  "ellipse 12% 12% at 50% 54%",
  "ellipse 9% 12% at 91% 22%",
  "ellipse 8% 9% at 60% 86%",
];

function MapPinIcon({ color, size, glow }: { color: string; size: number; glow: number }) {
  const id = sid(useId());
  return (
    <svg width={size} height={size * 1.32} viewBox="0 0 48 64" style={{ display: "block", overflow: "visible", filter: `drop-shadow(0 6px 10px ${rgba("#000000", 0.5)})${glow > 0.01 ? ` drop-shadow(0 0 ${r1(14 * glow)}px ${rgba(color, 0.8 * glow)})` : ""}` }}>
      <defs>
        <linearGradient id={`p${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={mix(color, "#FFFFFF", 0.35)} />
          <stop offset="1" stopColor={mix(color, "#000000", 0.15)} />
        </linearGradient>
      </defs>
      <path d="M24 62 C24 62 4 39 4 24 A20 20 0 0 1 44 24 C44 39 24 62 24 62 Z" fill={`url(#p${id})`} stroke={rgba("#FFFFFF", 0.5)} strokeWidth={1.2} />
      <circle cx={24} cy={24} r={8} fill={DARK} opacity={0.82} />
    </svg>
  );
}

function MapBackdrop({ ctx, w, h, t }: { ctx: GCtx; w: number; h: number; t: number }) {
  const mask = MAP_BLOBS.map((b) => `radial-gradient(${b}, #000 45%, transparent 100%)`).join(", ");
  const dots = (a: number, r: number) => `radial-gradient(circle, ${rgba("#FFFFFF", a)} ${r}px, transparent ${r + 0.8}px)`;
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: w, height: h, opacity: t, transform: `scale(${r4(1.03 - 0.03 * t)})` }}>
      <div style={{ ...fill, borderRadius: 26, background: `radial-gradient(ellipse 70% 60% at 50% 45%, ${rgba(ctx.p.secondary, 0.1)} 0%, transparent 75%)` }} />
      <div style={{ ...fill, backgroundImage: dots(0.07, 1.8), backgroundSize: "26px 26px", WebkitMaskImage: "radial-gradient(ellipse 60% 60% at 50% 50%, #000 40%, transparent 100%)", maskImage: "radial-gradient(ellipse 60% 60% at 50% 50%, #000 40%, transparent 100%)" }} />
      <div style={{ ...fill, backgroundImage: dots(0.34, 2.6), backgroundSize: "26px 26px", WebkitMaskImage: mask, maskImage: mask }} />
    </div>
  );
}

function MapPin({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const pad = 40;
  const head = headHeight(props);
  const mw = ctx.width - pad * 2;
  const mh = ctx.height - pad * 2 - head;
  const items = props.items.slice(0, 5);
  const route = ctx.variant === "ROUTE";
  const n = items.length;
  const seq = listSequence(Math.max(1, n), { ...ctx.anim, stagger: Math.max(ctx.anim.stagger, route ? 0.5 : 0.22) }, seqOpts(ctx, Math.round(0.4 * fps)));
  const hl = props.highlight != null && props.highlight < n ? props.highlight : null;
  const mapT = prog(frame, 0, Math.round(0.6 * fps), ctx.ease);
  const pinSize = 54;
  const cardW = n > 3 && route ? 250 : 320;
  const cardH = 118;
  // Positions (map-local px of the pin TIP): deterministic and well spread.
  const pos = items.map((_, i) => {
    if (route) {
      const x = n === 1 ? 0.5 : 0.17 + (0.66 * i) / (n - 1);
      const y = n === 1 ? 0.55 : i % 2 === 0 ? 0.74 : 0.36;
      return { x: x * mw, y: y * mh, side: i % 2 === 0 ? ("below" as const) : ("above" as const) };
    }
    const left = n === 1 ? true : i % 2 === 0;
    const x = n === 1 ? 0.3 : left ? 0.1 + 0.12 * hash01(i + 1) : 0.78 + 0.1 * hash01(i + 7);
    const y = (i + 0.5) / Math.max(1, n) + (n > 1 ? (hash01(i + 3) - 0.5) * (0.3 / n) : 0);
    return { x: x * mw, y: Math.min(mh - 10, Math.max(pinSize * 1.32 + 70, y * mh + pinSize * 0.66)), side: left ? ("right" as const) : ("left" as const) };
  });
  // Route: the arc(s) between consecutive pins.
  const id = sid(useId());
  const arcs = route
    ? pos.slice(1).map((b, i) => {
        const a = pos[i]!;
        const ay = a.y - pinSize * 0.66;
        const by = b.y - pinSize * 0.66;
        const cx = (a.x + b.x) / 2;
        const cy = Math.min(ay, by) - Math.max(80, Math.abs(b.x - a.x) * 0.3);
        const start = seq.at(0, i) + Math.round(0.35 * fps);
        const end = seq.at(0, i + 1);
        const t = prog(frame, start, Math.max(6, end - start + Math.round(0.1 * fps)), EASE_IN_OUT);
        const q = (u: number) => ({ x: (1 - u) ** 2 * a.x + 2 * (1 - u) * u * cx + u * u * b.x, y: (1 - u) ** 2 * ay + 2 * (1 - u) * u * cy + u * u * by });
        return { d: `M ${r1(a.x)} ${r1(ay)} Q ${r1(cx)} ${r1(cy)} ${r1(b.x)} ${r1(by)}`, t, head: q(t) };
      })
    : [];
  return (
    <Panel ctx={ctx} pad={pad}>
      <Header ctx={ctx} />
      <div style={{ position: "absolute", left: pad, top: pad + head, width: mw, height: mh }}>
        <MapBackdrop ctx={ctx} w={mw} h={mh} t={mapT} />
        {arcs.length ? (
          <svg width={mw} height={mh} viewBox={`0 0 ${mw} ${mh}`} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            <defs>
              {arcs.map((a, i) => (
                <mask key={i} id={`m${id}${i}`} maskUnits="userSpaceOnUse" x={-200} y={-400} width={mw + 400} height={mh + 800}>
                  <path d={a.d} fill="none" stroke="#FFFFFF" strokeWidth={20} pathLength={1} strokeDasharray="1 1" strokeDashoffset={r4(1 - a.t)} />
                </mask>
              ))}
            </defs>
            {arcs.map((a, i) => (
              <g key={i}>
                <path d={a.d} fill="none" stroke={rgba(p.primary, 0.9)} strokeWidth={5} strokeLinecap="round" strokeDasharray="1 15" mask={`url(#m${id}${i})`} style={{ filter: `drop-shadow(0 0 6px ${rgba(p.primary, 0.5)})` }} />
                {a.t > 0.01 && a.t < 0.99 ? <circle cx={a.head.x} cy={a.head.y} r={9} fill={mix(p.primary, "#FFFFFF", 0.4)} style={{ filter: `drop-shadow(0 0 10px ${rgba(p.primary, 0.9)})` }} /> : null}
              </g>
            ))}
          </svg>
        ) : null}
        {items.map((it, i) => {
          const at = seq.at(0, i);
          const isH = hl === i;
          const em = emphasisAt(ctx, at + seq.len);
          const color = it.color !== "AUTO" ? colorOf(ctx, it.color, i) : hl === null || isH ? p.primary : mix(p.ink, p.secondary, 0.3);
          const drop = springAt(frame, fps, at, ctx.f.springs.punch, Math.round(0.7 * fps));
          const pO = prog(frame, at, 4);
          const ps = pos[i]!;
          const v = it.value;
          const vt = v != null ? fmtValue(ctx, counted(ctx, at + 4, v), v).text : "";
          const cardIn = withExit(ctx, enterStyle(ctx, at + Math.round(0.2 * fps), seq.len, { style: ps.side === "left" ? "FADE" : "FADE" }), i, n);
          const slide = prog(frame, at + Math.round(0.2 * fps), seq.len, ctx.ease);
          const cw = Math.min(cardW, Math.max(200, Math.max(textW(it.text, 36), v != null ? textW(fmtValue(ctx, v, v).text, 44) + (it.sub ? textW(it.sub, 28, 1.02) + 14 : 0) : 0) + 52));
          const hy = ps.y - pinSize * 0.66;
          let cl: number;
          let ct: number;
          let dx = 0;
          let dy = 0;
          if (ps.side === "right") {
            cl = ps.x + 32;
            ct = hy - cardH / 2;
            dx = -24;
          } else if (ps.side === "left") {
            cl = ps.x - 32 - cw;
            ct = hy - cardH / 2;
            dx = 24;
          } else if (ps.side === "below") {
            cl = ps.x - cw / 2;
            ct = ps.y + 18;
            dy = -16;
          } else {
            cl = ps.x - cw / 2;
            ct = ps.y - pinSize * 1.32 - 16 - cardH;
            dy = 16;
          }
          cl = Math.max(0, Math.min(mw - cw, cl));
          ct = Math.max(0, Math.min(mh - cardH, ct));
          const ring = isH ? (((frame - at - seq.len) / (1.2 * fps)) % 1 + 1) % 1 : 0;
          return (
            <div key={i}>
              <div style={{ position: "absolute", left: ps.x - 22, top: ps.y - 8, width: 44, height: 16, borderRadius: "50%", background: rgba("#000000", 0.5), filter: "blur(4px)", opacity: pO * clamp01(drop), transform: `scale(${r4(0.4 + 0.6 * clamp01(drop))})` }} />
              {isH && frame > at + seq.len ? <div style={{ position: "absolute", left: ps.x - 40, top: ps.y - 16, width: 80, height: 32, borderRadius: "50%", border: `3px solid ${rgba(color, 0.7 * (1 - ring) * em.on)}`, transform: `scale(${r4(0.5 + ring * 1.4)})` }} /> : null}
              <div style={{ position: "absolute", left: ps.x - pinSize / 2, top: ps.y - pinSize * 1.32, opacity: pO, transform: `translateY(${r1((1 - drop) * -140)}px) scale(${r4(isH ? em.scale : 1)})`, transformOrigin: "50% 100%" }}>
                <MapPinIcon color={color} size={pinSize} glow={isH ? em.on : 0} />
              </div>
              <div style={{ position: "absolute", left: cl, top: ct, width: cw, height: cardH, boxSizing: "border-box", padding: "14px 24px", borderRadius: 22, ...glassCard(p, 22), boxShadow: [glassCard(p, 22).boxShadow, isH ? `inset 0 0 0 2px ${rgba(color, 0.6 * em.on)}` : null, isH ? glowShadow(color, em.on, 0.7) : null].filter(Boolean).join(", "), display: "flex", flexDirection: "column", justifyContent: "center", ...css(cardIn), transform: `translate(${r1(dx * (1 - slide))}px, ${r1(dy * (1 - slide))}px)` }}>
                <div style={{ fontFamily: FONT.displayBold, fontSize: fitLine(it.text, cw - 48, 36, 28), lineHeight: 1.1, color: p.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.text}</div>
                {v != null ? (
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4, whiteSpace: "nowrap" }}>
                    <span style={{ fontFamily: FONT.display, fontSize: fitLine(fmtValue(ctx, v, v).text, cw - 48 - (it.sub ? textW(it.sub, 28) + 10 : 0), 44, 30), letterSpacing: "-0.02em", color: v < 0 && ctx.fmt.negativeRed ? p.negative : isH || hl === null ? p.primary : mix(p.primary, p.ink, 0.35), fontVariantNumeric: "tabular-nums" }}>{vt}</span>
                    {it.sub ? <span style={{ fontFamily: FONT.text, fontSize: 28, color: p.muted, overflow: "hidden", textOverflow: "ellipsis" }}>{it.sub}</span> : null}
                  </div>
                ) : it.sub ? (
                  <div style={{ fontFamily: FONT.text, fontSize: 28, color: p.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.sub}</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ===================================================================== ICON_BURST

function IconBurst({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const items = props.items.slice(0, 8);
  const n = items.length;
  const title = props.title?.trim() ?? "";
  const W = ctx.width;
  const H = ctx.height;
  if (ctx.variant === "ROW") {
    const tSize = title ? fitLine(title, W - 60, 64, 44) : 0;
    const gap = 26;
    const d = n ? Math.min(150, (W - 40 - gap * (n - 1)) / n) : 0;
    const hasText = items.some((i) => i.text.trim());
    const rowTop = title ? 150 : (H - d) / 2 - (hasText ? 30 : 0);
    const seq = listSequence(Math.max(1, n), ctx.anim, seqOpts(ctx, Math.round(0.3 * fps)));
    const tT = prog(frame, 0, Math.round(0.5 * fps), ctx.ease);
    const lineT = prog(frame, Math.round(0.2 * fps), Math.max(6, seq.done - Math.round(0.2 * fps)), ctx.ease);
    const rowW = n * d + (n - 1) * gap;
    return (
      <div style={fill}>
        <Scrim strength={0.28} />
        {title ? <div style={{ position: "absolute", left: 0, right: 0, top: 30, textAlign: "center", fontFamily: FONT.displayBold, fontSize: tSize, letterSpacing: "-0.02em", color: p.ink, whiteSpace: "nowrap", textShadow: TEXT_LIFT, opacity: tT, transform: `translateY(${r1((1 - tT) * 16)}px)` }}>{title}</div> : null}
        {n > 1 ? <div style={{ position: "absolute", left: (W - rowW) / 2 + d / 2, width: rowW - d, top: rowTop + d / 2 - 1.5, height: 3, borderRadius: 3, background: `linear-gradient(90deg, ${rgba(p.primary, 0.1)}, ${rgba(p.primary, 0.55)}, ${rgba(p.primary, 0.1)})`, transform: `scaleX(${r4(lineT)})`, transformOrigin: "left" }} /> : null}
        {items.map((it, i) => {
          const c = colorOf(ctx, it.color, i);
          const st = seqStyle(ctx, seq, 0, i, { style: ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter });
          return (
            <div key={i} style={{ position: "absolute", left: (W - rowW) / 2 + i * (d + gap), top: rowTop, width: d, display: "flex", flexDirection: "column", alignItems: "center", ...css(st) }}>
              <Disc size={d} color={c} icon={it.icon} draw={prog(frame, seq.at(0, i), Math.round(0.6 * fps), ctx.ease)} />
              {it.text.trim() ? <div style={{ marginTop: 12, fontFamily: FONT.text, fontSize: fitLine(it.text, d + gap - 4, 30, 28), color: p.ink, whiteSpace: "nowrap", textShadow: TEXT_LIFT, maxWidth: d + gap, overflow: "hidden", textOverflow: "ellipsis" }}>{it.text}</div> : null}
            </div>
          );
        })}
      </div>
    );
  }
  const orbit = ctx.variant === "ORBIT";
  const cx = W / 2;
  const cy = H / 2;
  const tSize = title ? fitLine(title, orbit ? W * 0.5 : W * 0.56, 128, 48) : 0;
  const tS = springAt(frame, fps, 0, ctx.f.springs.punch, Math.round(0.8 * fps));
  const tO = prog(frame, 0, 5);
  const burstAt = Math.round(0.18 * fps);
  const seq = listSequence(Math.max(1, n), { ...ctx.anim, stagger: Math.min(ctx.anim.stagger, orbit ? 0.12 : 0.04) }, seqOpts(ctx, burstAt));
  const d = n > 6 ? 116 : 128;
  const rx = W / 2 - d / 2 - 18;
  const ry = orbit ? rx * 0.62 : H / 2 - d / 2 - 18;
  const shock = prog(frame, burstAt, Math.round(0.6 * fps), ctx.ease);
  const spin = orbit ? ((frame / fps) * Math.PI * 2 * ctx.anim.speed) / 16 : 0;
  const em = emphasisAt(ctx, seq.done);
  const discs = items.map((it, i) => {
    const a = -Math.PI / 2 + (orbit ? 0 : Math.PI / Math.max(1, n)) + (i * Math.PI * 2) / Math.max(1, n) + spin;
    const s = springAt(frame, fps, seq.at(0, i), ctx.f.springs.soft, Math.round(1 * fps));
    const age = (frame - seq.at(0, i)) / fps;
    const fl = orbit ? 0 : prog(frame, seq.at(0, i) + seq.len, 12);
    const fx = Math.cos(age * 1.3 + i * 1.7) * 6 * fl;
    const fy = Math.sin(age * 1.6 + i * 2.3) * 9 * fl;
    const depth = orbit ? (Math.sin(a) + 1) / 2 : 1;
    const x = cx + Math.cos(a) * rx * s + fx;
    const y = cy + Math.sin(a) * ry * s + fy;
    const sc = (0.35 + 0.65 * Math.min(1.1, Math.max(0, s))) * (orbit ? 0.78 + 0.3 * depth : 1);
    return { it, i, x, y, sc, o: prog(frame, seq.at(0, i), 4) * (orbit ? 0.55 + 0.45 * depth : 1), front: !orbit || Math.sin(a) > -0.15, rot: (1 - Math.min(1, s)) * -40 };
  });
  const sparks = orbit ? [] : Array.from({ length: 14 }, (_, k) => k);
  const renderDisc = (q: (typeof discs)[number]) => (
    <div key={q.i} style={{ position: "absolute", left: q.x - d / 2, top: q.y - d / 2, opacity: q.o, transform: `scale(${r4(q.sc)}) rotate(${r1(q.rot)}deg)`, zIndex: q.front ? 3 : 1 }}>
      <Disc size={d} color={colorOf(ctx, q.it.color, q.i)} icon={q.it.icon} draw={prog(frame, seq.at(0, q.i), Math.round(0.6 * fps), ctx.ease)} />
    </div>
  );
  return (
    <div style={fill}>
      <div style={{ position: "absolute", left: cx - W * 0.42, top: cy - H * 0.3, width: W * 0.84, height: H * 0.6, borderRadius: "50%", background: `radial-gradient(ellipse 50% 50% at 50% 50%, ${rgba(p.primary, 0.2 + 0.1 * em.on)} 0%, ${rgba("#08080C", 0.3)} 45%, transparent 72%)`, filter: "blur(10px)", opacity: tO }} />
      {orbit ? (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={rgba(p.primary, 0.35)} strokeWidth={2} strokeDasharray="2 12" strokeLinecap="round" opacity={prog(frame, Math.round(0.1 * fps), Math.round(0.6 * fps))} />
          <ellipse cx={cx} cy={cy} rx={rx * 0.62} ry={ry * 0.62} fill="none" stroke={rgba("#FFFFFF", 0.08)} strokeWidth={1.5} opacity={prog(frame, Math.round(0.2 * fps), Math.round(0.6 * fps))} />
        </svg>
      ) : null}
      {!orbit && shock > 0 && shock < 1 ? <div style={{ position: "absolute", left: cx - 200, top: cy - 200, width: 400, height: 400, borderRadius: "50%", border: `3px solid ${rgba(p.primary, 0.55 * (1 - shock))}`, transform: `scale(${r4(0.3 + shock * 1.6)})` }} /> : null}
      {sparks.map((k) => {
        const a = (k / sparks.length) * Math.PI * 2 + hash01(k) * 0.4;
        const t = prog(frame, burstAt, Math.round(0.7 * fps), ctx.ease);
        const r = 80 + t * (W * 0.42 + hash01(k + 5) * 40);
        if (t <= 0 || t >= 1) return null;
        return <div key={`s${k}`} style={{ position: "absolute", left: cx + Math.cos(a) * r - 4, top: cy + Math.sin(a) * r - 4, width: 8, height: 8, borderRadius: 4, background: mix(p.primary, "#FFFFFF", 0.3), opacity: 1 - t, boxShadow: `0 0 10px ${rgba(p.primary, 0.8)}` }} />;
      })}
      {discs.filter((q) => !q.front).map(renderDisc)}
      {title ? (
        <div style={{ position: "absolute", left: 0, right: 0, top: cy - tSize * 0.62, height: tSize * 1.24, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2, opacity: tO, transform: `scale(${r4((0.6 + 0.4 * tS) * em.scale)})` }}>
          <span style={{ fontFamily: FONT.display, fontSize: tSize, letterSpacing: "-0.03em", whiteSpace: "nowrap", ...goldFace(ctx, em.on) }}>{title}</span>
        </div>
      ) : null}
      {discs.filter((q) => q.front).map(renderDisc)}
    </div>
  );
}

// ===================================================================== CTA

/** Title with a quoted keyword (“BUDGET”) picked out in gold. */
function CtaTitle({ ctx, text, size }: { ctx: GCtx; text: string; size: number }) {
  const m = /^(.*?)([“"«])(.+?)([”"»])(.*)$/.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      {m[1]}
      <span style={{ color: ctx.p.primary, textShadow: `0 0 ${r1(size * 0.4)}px ${rgba(ctx.p.primary, 0.35)}` }}>
        {m[2]}
        {m[3]}
        {m[4]}
      </span>
      {m[5]}
    </>
  );
}

function Cta({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps } = ctx;
  const v = ctx.variant;
  const W = ctx.width;
  const H = ctx.height;
  const cardH = Math.min(H - 20, 220);
  const top = (H - cardH) / 2;
  const pad = 34;
  const disc = cardH - 2 * pad;
  const rightW = v === "FOLLOW" ? 214 : v === "COMMENT" ? 150 : v === "SHARE" ? 168 : 0;
  const colL = pad + disc + 30;
  const colW = W - colL - pad - (rightW ? rightW + 24 : 0);
  const title = props.title?.trim() ?? "";
  const sub = props.subtitle?.trim() ?? "";
  const tSize = fitLine(title, colW, 52, 36);
  const sSize = sub ? fitLine(sub, colW, 34, 28, 1.02) : 0;
  const card = withExit(ctx, enterStyle(ctx, 0, Math.round(0.5 * fps), { blurOK: true }), 0, 1);
  const iS = springAt(frame, fps, Math.round(0.14 * fps), ctx.f.springs.soft, Math.round(0.9 * fps));
  const iO = prog(frame, Math.round(0.14 * fps), 5);
  const tT = prog(frame, Math.round(0.22 * fps), Math.round(0.5 * fps), ctx.ease);
  const sT = prog(frame, Math.round(0.32 * fps), Math.round(0.5 * fps), ctx.ease);
  const act = Math.round(0.85 * fps);
  const age = frame - act;
  const c = p.primary;

  let icon: ReactNode;
  let right: ReactNode = null;
  if (v === "SAVE") {
    const f = prog(frame, act, Math.round(0.4 * fps), EASE_IN_OUT);
    const pop = age >= 0 ? 1 + 0.14 * Math.sin(clamp01(age / Math.round(0.35 * fps)) * Math.PI) : 1;
    const isz = Math.round(disc * 0.52);
    icon = (
      <div style={{ position: "relative", width: isz, height: isz, transform: `scale(${r4(pop)})` }}>
        <svg width={isz} height={isz} viewBox="0 0 24 24" style={{ position: "absolute", inset: 0, overflow: "visible", clipPath: `inset(${r1((1 - f) * 100)}% 0 0 0)` }}>
          <path d="M6.5 3h11v18l-5.5-4l-5.5 4z" fill={c} stroke={c} strokeWidth={1.8} strokeLinejoin="round" />
        </svg>
        <div style={{ position: "absolute", inset: 0 }}>
          <GIcon icon="BOOKMARK" size={isz} color={mix(c, "#FFFFFF", 0.15)} draw={prog(frame, Math.round(0.2 * fps), Math.round(0.5 * fps), ctx.ease)} />
        </div>
        {age > 0 && age < Math.round(0.5 * fps)
          ? [0, 1, 2, 3, 4].map((k) => {
              const a = -Math.PI / 2 + (k - 2) * 0.55;
              const t = clamp01(age / Math.round(0.5 * fps));
              const r0 = isz * 0.62 + t * isz * 0.25;
              return <div key={k} style={{ position: "absolute", left: isz / 2 + Math.cos(a) * r0 - 3, top: isz / 2 + Math.sin(a) * r0 - 3, width: 6, height: 6, borderRadius: 3, background: c, opacity: 1 - t }} />;
            })
          : null}
      </div>
    );
  } else if (v === "COMMENT") {
    icon = <GIcon icon="CHAT" size={Math.round(disc * 0.5)} color={mix(c, "#FFFFFF", 0.15)} draw={prog(frame, Math.round(0.2 * fps), Math.round(0.6 * fps), ctx.ease)} />;
    const bT = springAt(frame, fps, Math.round(0.5 * fps), ctx.f.springs.soft, Math.round(0.8 * fps));
    right = (
      <div style={{ width: rightW, height: 92, borderRadius: "46px 46px 46px 14px", background: rgba("#FFFFFF", 0.1), boxShadow: `inset 0 0 0 1.5px ${rgba("#FFFFFF", 0.14)}, inset 0 1.5px 0 ${rgba("#FFFFFF", 0.18)}`, display: "flex", alignItems: "center", justifyContent: "center", gap: 14, opacity: prog(frame, Math.round(0.5 * fps), 5), transform: `scale(${r4(0.5 + 0.5 * bT)})`, transformOrigin: "0% 100%" }}>
        {[0, 1, 2].map((k) => {
          const ph = (frame / fps) * Math.PI * 2 * 1.4 - k * 0.9;
          const up = Math.max(0, Math.sin(ph));
          return <div key={k} style={{ width: 18, height: 18, borderRadius: 9, background: mix(p.ink, c, up * 0.6), transform: `translateY(${r1(-up * 9)}px)`, opacity: 0.55 + 0.45 * up }} />;
        })}
      </div>
    );
  } else if (v === "SHARE") {
    const isz = Math.round(disc * 0.52);
    const cycle = Math.round(1.3 * fps);
    const ph = age >= 0 ? (age % cycle) / cycle : 0;
    const lift = age >= 0 ? Math.sin(Math.min(1, ph * 2) * Math.PI) * 4 : 0;
    const draw = prog(frame, Math.round(0.2 * fps), Math.round(0.6 * fps), ctx.ease);
    icon = (
      <svg width={isz} height={isz} viewBox="0 0 24 24" style={{ overflow: "visible" }}>
        <path d="M4 13v6a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-6" fill="none" stroke={mix(c, "#FFFFFF", 0.15)} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={r4(1 - draw)} />
        <g transform={`translate(0 ${r1(-lift)})`}>
          <path d="M12 15V3.5M7.5 8L12 3.5L16.5 8" fill="none" stroke={mix(c, "#FFFFFF", 0.15)} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={r4(1 - draw)} />
        </g>
      </svg>
    );
    const av = 76;
    right = (
      <div style={{ position: "relative", width: rightW, height: av }}>
        {[0, 1, 2].map((k) => {
          const s = springAt(frame, fps, act + k * Math.round(0.12 * fps), ctx.f.springs.soft, Math.round(0.8 * fps));
          const tint = [p.primary, p.secondary, p.positive][k]!;
          return (
            <div key={k} style={{ position: "absolute", left: k * (av - 30), top: 0, width: av, height: av, borderRadius: "50%", background: `radial-gradient(circle at 35% 30%, ${rgba(mix(tint, "#FFFFFF", 0.3), 0.55)}, ${rgba(tint, 0.25)} 60%, ${rgba("#101018", 0.9)})`, boxShadow: `0 0 0 4px ${rgba("#15151E", 1)}, inset 0 0 0 1.5px ${rgba(tint, 0.6)}`, display: "flex", alignItems: "center", justifyContent: "center", opacity: prog(frame, act + k * Math.round(0.12 * fps), 4), transform: `scale(${r4(0.3 + 0.7 * s)})`, zIndex: 3 - k }}>
              <GIcon icon="USER" size={40} color={mix(tint, "#FFFFFF", 0.4)} stroke={2} />
            </div>
          );
        })}
      </div>
    );
  } else {
    // FOLLOW: a bell that rings + a Follow button that gets tapped (→ check).
    const ringAge = frame - Math.round(0.5 * fps);
    const ring = ringAge > 0 ? Math.sin(ringAge * 0.95) * 16 * Math.max(0, 1 - ringAge / Math.round(0.8 * fps)) : 0;
    icon = (
      <div style={{ transform: `rotate(${r1(ring)}deg)`, transformOrigin: "50% 12%" }}>
        <GIcon icon="BELL" size={Math.round(disc * 0.5)} color={mix(c, "#FFFFFF", 0.15)} draw={prog(frame, Math.round(0.2 * fps), Math.round(0.5 * fps), ctx.ease)} />
      </div>
    );
    const tap = Math.max(Math.round(1.05 * fps), Math.round(buildBudget(ctx) * 0.5));
    const tA = frame - tap;
    const press = tA >= 0 && tA < 4 ? 1 - 0.1 * Math.sin((tA / 4) * Math.PI) : 1;
    const rel = tA >= 4 ? springAt(frame, fps, tap + 4, ctx.f.springs.punch, Math.round(0.5 * fps)) : 0;
    const bScale = tA < 4 ? press : 0.94 + 0.06 * rel;
    const done = prog(frame, tap + 2, 6);
    const rip = tA >= 0 ? clamp01(tA / Math.round(0.45 * fps)) : 0;
    const bIn = springAt(frame, fps, Math.round(0.4 * fps), ctx.f.springs.soft, Math.round(0.8 * fps));
    right = (
      <div style={{ position: "relative", width: rightW, height: 92, borderRadius: 46, overflow: "hidden", background: done > 0 ? `linear-gradient(0deg, ${rgba("#FFFFFF", 0.1 * done)}, ${rgba("#FFFFFF", 0.1 * done)}), ${solidFill(c)}` : solidFill(c), boxShadow: `0 10px 26px ${rgba("#000000", 0.4)}, inset 0 2px 0 ${rgba("#FFFFFF", 0.4)}, 0 0 ${r1(26 * (1 - done) + 8)}px ${rgba(c, 0.35)}`, opacity: prog(frame, Math.round(0.4 * fps), 5), transform: `scale(${r4((0.6 + 0.4 * bIn) * bScale)})` }}>
        {rip > 0 && rip < 1 ? <div style={{ position: "absolute", left: rightW * 0.6 - 120, top: 46 - 120, width: 240, height: 240, borderRadius: "50%", background: rgba("#FFFFFF", 0.4 * (1 - rip)), transform: `scale(${r4(0.1 + rip)})` }} /> : null}
        <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, fontSize: 38, letterSpacing: "-0.01em", color: onFill(c), opacity: 1 - done, transform: `translateY(${r1(-done * 20)}px)` }}>Follow</div>
        <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center", opacity: done, transform: `translateY(${r1((1 - done) * 20)}px)` }}>
          <GIcon icon="CHECK" size={48} color={onFill(c)} stroke={2.6} draw={prog(frame, tap + 3, 8)} />
        </div>
      </div>
    );
  }

  return (
    <div style={fill}>
      <div style={{ position: "absolute", left: 0, top, width: W, height: cardH, ...glassCard(p, 56), ...css(card) }}>
        <div style={{ ...fill, borderRadius: 56, background: `radial-gradient(ellipse 40% 90% at 0% 50%, ${rgba(c, 0.14)} 0%, transparent 70%)` }} />
        <div style={{ position: "absolute", left: pad, top: pad, opacity: iO, transform: `scale(${r4(0.4 + 0.6 * iS)})` }}>
          <div style={{ width: disc, height: disc, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: `radial-gradient(circle at 34% 28%, ${rgba(mix(c, "#FFFFFF", 0.25), 0.34)} 0%, ${rgba(c, 0.14)} 50%, ${rgba("#0E0E16", 0.7)} 100%)`, boxShadow: `inset 0 0 0 2px ${rgba(c, 0.6)}, inset 0 2px 0 ${rgba("#FFFFFF", 0.2)}, 0 0 30px ${rgba(c, 0.2)}` }}>{icon}</div>
        </div>
        <div style={{ position: "absolute", left: colL, width: colW, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontFamily: FONT.displayBold, fontSize: tSize, lineHeight: 1.1, letterSpacing: "-0.018em", color: p.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", opacity: tT, transform: `translateX(${r1((1 - tT) * -22)}px)` }}>
            <CtaTitle ctx={ctx} text={title} size={tSize} />
          </div>
          {sub ? <div style={{ marginTop: 6, fontFamily: FONT.text, fontSize: sSize, lineHeight: 1.2, color: p.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", opacity: sT, transform: `translateX(${r1((1 - sT) * -16)}px)` }}>{sub}</div> : null}
        </div>
        {right ? <div style={{ position: "absolute", right: pad, top: 0, bottom: 0, width: rightW, display: "flex", alignItems: "center", justifyContent: "center" }}>{right}</div> : null}
      </div>
    </div>
  );
}

// ===================================================================== TRANSITION

/** Full-frame transitions; mid-duration is the covered moment. */
function Transition({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "IRIS":
      return <TransIris ctx={ctx} />;
    case "SLAM":
      return <TransSlam ctx={ctx} />;
    case "FLASH":
      return <TransFlash ctx={ctx} />;
    default:
      return <TransWipe ctx={ctx} />;
  }
}

function TransWipe({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, D } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const s = H * Math.tan((16 * Math.PI) / 180);
  const inP = prog(frame, 0, Math.max(2, Math.round(D * 0.42)), EASE_IN_OUT);
  const outP = prog(frame, Math.round(D * 0.54), Math.max(2, Math.round(D * 0.34)), EASE_IN_OUT);
  const span = W + s;
  const L = inP * span;
  const T = outP * span;
  const poly = (a: number, b: number) => `polygon(${r1(a)}px 0px, ${r1(b)}px 0px, ${r1(b - s)}px ${H}px, ${r1(a - s)}px ${H}px)`;
  const band = 110 * (1 - inP);
  const band2 = 110 * outP * (1 - outP) * 4;
  const title = props.title?.trim();
  const tSize = title ? fitLine(title, W - 140, 170, 60) : 0;
  const u = frame / Math.max(1, D);
  return (
    <div style={fill}>
      {band > 1 && inP > 0 ? <div style={{ ...fill, background: mix(p.primary, "#FFFFFF", 0.45), clipPath: poly(L, L + band) }} /> : null}
      <div style={{ ...fill, clipPath: poly(T, L), background: `linear-gradient(115deg, ${p.primary} 0%, ${mix(p.primary, "#24123A", 0.62)} 20%, ${mix(p.secondary, "#0B0716", 0.5)} 55%, ${mix(p.secondary, "#000000", 0.72)} 100%)` }}>
        <div style={{ ...fill, background: `radial-gradient(ellipse 70% 36% at 50% 50%, ${rgba(p.secondary, 0.3)} 0%, transparent 70%)` }} />
        <div style={{ ...fill, backgroundImage: `repeating-linear-gradient(106deg, ${rgba("#FFFFFF", 0.05)} 0px, ${rgba("#FFFFFF", 0.05)} 2px, transparent 2px, transparent 46px)` }} />
        {title ? (
          <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center", transform: `translateX(${r1((0.5 - u) * 260)}px)` }}>
            <span style={{ fontFamily: FONT.display, fontSize: tSize, letterSpacing: "-0.035em", whiteSpace: "nowrap", ...goldFace(ctx, 0.5) }}>{title}</span>
          </div>
        ) : null}
      </div>
      {band2 > 1 ? <div style={{ ...fill, background: mix(p.secondary, "#FFFFFF", 0.35), clipPath: poly(T - band2, T) }} /> : null}
    </div>
  );
}

function TransIris({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, D } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const R = Math.hypot(W, H) / 2 + 30;
  const close = prog(frame, 0, Math.max(2, Math.round(D * 0.42)), EASE_IN_OUT);
  const open = prog(frame, Math.round(D * 0.54), Math.max(2, Math.round(D * 0.34)), EASE_IN);
  const rr = frame < D / 2 ? R * (1 - close) : R * open;
  const mask = `radial-gradient(circle at 50% 50%, transparent ${r1(rr)}px, #000 ${r1(rr + 1.5)}px)`;
  const title = props.title?.trim();
  const tSize = title ? fitLine(title, W - 160, 150, 56) : 0;
  const rimO = rr > 2 && rr < R * 0.97 ? Math.min(1, rr / 60) : 0;
  return (
    <div style={fill}>
      <div style={{ ...fill, background: `radial-gradient(ellipse 70% 50% at 50% 50%, ${mix("#0B0B12", p.secondary, 0.1)} 0%, #07070B 75%)`, WebkitMaskImage: mask, maskImage: mask }} />
      {rimO > 0 ? <div style={{ position: "absolute", left: W / 2 - rr, top: H / 2 - rr, width: rr * 2, height: rr * 2, borderRadius: "50%", boxShadow: `0 0 0 4px ${rgba(p.primary, 0.9 * rimO)}, 0 0 30px 6px ${rgba(p.primary, 0.35 * rimO)}` }} /> : null}
      {title ? (
        <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center", opacity: clamp01(1 - rr / 200) }}>
          <span style={{ fontFamily: FONT.display, fontSize: tSize, letterSpacing: "-0.03em", whiteSpace: "nowrap", ...goldFace(ctx, 0.6) }}>{title}</span>
        </div>
      ) : null}
    </div>
  );
}

function TransSlam({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps, D } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const land = Math.max(3, Math.round(0.18 * fps));
  const a = prog(frame, 0, land, EASE_IN);
  const age = frame - land;
  const set = age >= 0 ? springAt(frame, fps, land, ctx.f.springs.punch, Math.round(0.5 * fps)) : 0;
  const push = 1 + 0.05 * prog(frame, land, Math.max(1, D - land), (t) => t);
  const scale = age < 0 ? 2.6 - 1.6 * a : (0.93 + 0.07 * set) * push;
  const shake = age >= 0 ? Math.sin(age * 2.3) * 12 * Math.max(0, 1 - age / 8) : 0;
  const flash = age >= 0 ? 0.45 * Math.max(0, 1 - age / 5) : 0;
  const outLen = Math.max(ctx.exitFrames, Math.round(D * 0.2));
  const out = prog(frame, D - outLen, outLen, EASE_IN);
  const back = prog(frame, 0, 3) * (1 - out);
  const title = props.title?.trim() || "";
  const tSize = fitLine(title.toUpperCase() === title ? title : title, W - 120, 300, 80);
  const bloom = age >= 0 ? 0.55 + 0.45 * Math.max(0, 1 - age / 10) : 0.3 * a;
  return (
    <div style={fill}>
      <div style={{ ...fill, background: rgba("#07070B", 0.9 * back) }} />
      <div style={{ ...fill, opacity: back * bloom, background: `radial-gradient(ellipse 60% 26% at 50% 50%, ${rgba(p.primary, 0.32)} 0%, ${rgba(p.primary, 0.08)} 50%, transparent 75%)` }} />
      {title ? (
        <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center", opacity: clamp01(a * 1.5) * (1 - out), transform: `translateX(${r1(shake)}px) scale(${r4(scale)})`, filter: age < 0 && a < 0.95 ? `blur(${r1((1 - a) * 8)}px)` : undefined }}>
          <span style={{ fontFamily: FONT.display, fontSize: tSize, lineHeight: 1, letterSpacing: "-0.04em", color: "#FFFFFF", whiteSpace: "nowrap", textShadow: `0 0 40px ${rgba(p.primary, 0.45)}, 0 10px 40px ${rgba("#000000", 0.6)}` }}>{title}</span>
        </div>
      ) : null}
      {flash > 0.01 ? <div style={{ ...fill, background: rgba(mix("#FFFFFF", p.primary, 0.15), flash) }} /> : null}
      <div style={{ position: "absolute", left: 0, right: 0, top: H / 2 + tSize * 0.62, height: 6, opacity: 0 }} />
    </div>
  );
}

function TransFlash({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, D } = ctx;
  const W = ctx.width;
  const peak = Math.max(2, Math.round(D * 0.36));
  const up = prog(frame, 0, peak, EASE_IN);
  const down = prog(frame, peak, Math.max(2, D - peak), EASE_OUT_SOFT);
  const k = frame < peak ? up : 1 - down;
  const grow = prog(frame, 0, D, (t) => t);
  const title = props.title?.trim();
  return (
    <div style={fill}>
      <div style={{ ...fill, opacity: k, background: `radial-gradient(ellipse ${r1(50 + 40 * grow)}% ${r1(34 + 30 * grow)}% at 50% 48%, #FFFFFF 0%, ${mix(p.primary, "#FFFFFF", 0.55)} 30%, ${rgba(p.primary, 0.55)} 55%, ${rgba(p.primary, 0)} 85%)` }} />
      <div style={{ ...fill, background: rgba("#FFFDF6", 0.85 * k ** 2) }} />
      <div style={{ position: "absolute", left: -W * 0.2, right: -W * 0.2, top: "48%", height: 10, marginTop: -5, borderRadius: 10, opacity: k * 0.9, background: `linear-gradient(90deg, transparent, ${mix(p.primary, "#FFFFFF", 0.5)} 30%, #FFFFFF 50%, ${mix(p.primary, "#FFFFFF", 0.5)} 70%, transparent)`, filter: "blur(3px)", transform: `scaleX(${r4(0.5 + 0.5 * k)})` }} />
      {title ? (
        <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center", opacity: k }}>
          <span style={{ fontFamily: FONT.display, fontSize: fitLine(title, W - 160, 150, 56), letterSpacing: "-0.03em", color: DARK, whiteSpace: "nowrap" }}>{title}</span>
        </div>
      ) : null}
    </div>
  );
}

const EASE_OUT_SOFT = (t: number) => 1 - (1 - t) ** 2.2;

// ===================================================================== registry

export const TEXT_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {
  KINETIC: Kinetic,
  QUOTE: Quote,
  LOWER_THIRD: LowerThird,
  ANNOTATION: Annotation,
  STICKER: Sticker,
  MAP_PIN: MapPin,
  ICON_BURST: IconBurst,
  CTA: Cta,
  TRANSITION: Transition,
};

// Exported for tests (pure helpers).
export const __textInternals = { fitWords, textW, matchPhrase, strikeTarget, fitSize };
