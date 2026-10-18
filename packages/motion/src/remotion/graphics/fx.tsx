import { useId, type ComponentType, type CSSProperties, type ReactNode } from "react";
import type { GraphicComponent, GraphicIcon, GraphicItem } from "@chris/media/timeline";
import { listSequence } from "../../graphics-timing";
import { EASE_IN, EASE_IN_OUT } from "../motion";
import { GIcon } from "./icons";
import { EASE_OUT, FONT, clamp01, colorOf, counted, css, emphasisAt, glowShadow, mix, prog, r1, r4, rgba, seqStyle, springAt, type GCtx } from "./kit";
import { breakLines, buildBudget, fitLine, fitWords, goldFace, hash01, onFill, textW } from "./text";
import { card, oneLine, toneOf, type Tone } from "./ui";

/**
 * Library 2 — HOOKS, REACTIONS & FX: VERDICT · HOOK_TEXT · COUNTDOWN · QUIZ · SCREEN_FX.
 *
 * Retention beats and editing effects that sit OVER Chris: bare type carries its own outline /
 * shadow so it reads on any footage, cards follow the Dark / Light tone, and the full-frame
 * SCREEN_FX overlays keep the centre see-through (gradients, a handful of elements, no
 * per-element blur, no blend modes — the visuals layer is composited separately).
 * Everything is a pure function of ctx.frame; randomness is `hash01`.
 */

const fill: CSSProperties = { position: "absolute", inset: 0 };
const center: CSSProperties = { ...fill, display: "flex", alignItems: "center", justifyContent: "center" };
const NOIR = "#0C0B10";
const SHADOW_TEXT = `0 2px 4px ${rgba("#000000", 0.55)}, 0 10px 30px ${rgba("#000000", 0.45)}`;

// ===================================================================== helpers

function sid(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "");
}

function seqOpts(ctx: GCtx, startFrame?: number) {
  return { fps: ctx.fps, durationInFrames: ctx.D, exitFrames: ctx.exitFrames, tempo: ctx.f.tempo, startFrame };
}

function splitW(s: string | null | undefined): string[] {
  return (s ?? "").split(/\s+/).filter(Boolean);
}

/** Fit text into width × height (shrink → wrap → ellipsis); lines as strings. */
function fitBlock(text: string, width: number, height: number, o: { max: number; min: number; lh: number; k?: number; maxLines?: number }): { size: number; lines: string[] } {
  const ws = splitW(text);
  if (!ws.length) return { size: o.min, lines: [] };
  const f = fitWords(ws, width, Math.max(height, o.min * o.lh), o);
  return { size: f.size, lines: f.lines.map((l) => l.map((i) => f.words[i]).join(" ")) };
}

type Mood = "POS" | "NEG" | "PRI";
const POS_WORDS = new Set(["TRUE", "FACT", "FACTS", "YES", "RIGHT", "CORRECT", "APPROVED", "VERIFIED", "LEGIT", "REAL", "PASS", "PASSED", "WIN", "DONE", "CONFIRMED", "SAFE", "GOOD", "PAID", "HIRED", "SMART", "W", "PROFIT"]);
const NEG_WORDS = new Set(["FALSE", "MYTH", "WRONG", "NO", "NOT", "SCAM", "FAKE", "BUSTED", "DENIED", "REJECTED", "FAIL", "FAILED", "NOPE", "CAP", "LIE", "LIES", "BAD", "AVOID", "BROKE", "L", "OVERPRICED", "DEBT", "EXPIRED", "CANCELLED", "CANCELED", "DON'T", "DONT", "STOP", "LOSS"]);

/** The mood of a verdict word: TRUE/FACT → positive, FALSE/MYTH/WRONG/SCAM → negative. */
function moodOf(text: string | null | undefined): Mood | null {
  const t = (text ?? "").toUpperCase().replace(/[^A-Z' ]/g, " ");
  if (/\bSOLD OUT\b|\bRED FLAG\b|\bDO NOT\b/.test(t)) return "NEG";
  const toks = t.split(/\s+/).filter(Boolean);
  if (toks.some((w) => NEG_WORDS.has(w))) return "NEG";
  if (toks.some((w) => POS_WORDS.has(w))) return "POS";
  return null;
}

function moodColor(ctx: GCtx, m: Mood): string {
  return m === "POS" ? ctx.p.positive : m === "NEG" ? ctx.p.negative : ctx.p.primary;
}

/** Verdict colour: items[0].color override → the word's mood → the variant default. */
function verdictColor(ctx: GCtx, def: Mood): string {
  const it = ctx.props.items[0];
  if (it && it.color !== "AUTO") return colorOf(ctx, it.color, 0);
  return moodColor(ctx, moodOf(ctx.props.title) ?? def);
}

/** Outlined display type in SVG (fill + stroke behind it + optional hard offset shadow). */
function StrokeText({
  lines,
  size,
  lh,
  width,
  color,
  stroke,
  strokeW,
  shadow = 0,
  k = 1,
  lineStyle,
}: {
  lines: string[];
  size: number;
  lh: number;
  width: number;
  color: string;
  stroke: string;
  strokeW: number;
  shadow?: number;
  k?: number;
  lineStyle?: (i: number) => CSSProperties;
}) {
  const pad = Math.ceil(strokeW + shadow + 6);
  const H = lines.length * size * lh;
  return (
    <svg width={width + 2 * pad} height={H + 2 * pad} viewBox={`0 0 ${width + 2 * pad} ${H + 2 * pad}`} style={{ display: "block", overflow: "visible", margin: -pad }}>
      {lines.map((l, i) => {
        const y = pad + (i + 0.5) * size * lh + size * 0.36;
        const x = pad + width / 2;
        const w = textW(l, size, k);
        const tl = w > width ? width : undefined;
        const common = { textAnchor: "middle" as const, fontFamily: FONT.display, fontSize: size, textLength: tl, lengthAdjust: tl ? ("spacingAndGlyphs" as const) : undefined, strokeLinejoin: "round" as const };
        return (
          <g key={i} style={{ transformBox: "fill-box", transformOrigin: "50% 50%", ...(lineStyle ? lineStyle(i) : {}) }}>
            {shadow > 0 ? (
              <text {...common} x={x + shadow} y={y + shadow} fill={stroke} stroke={stroke} strokeWidth={strokeW}>
                {l}
              </text>
            ) : null}
            <text {...common} x={x} y={y} fill={color} stroke={stroke} strokeWidth={strokeW} paintOrder="stroke">
              {l}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** A thick mark path (tick / cross) in a 100-unit box, drawn on by `draw` 0..1. */
function MarkPath({ kind, size, color, draw, width = 11 }: { kind: "CHECK" | "CROSS"; size: number; color: string; draw: number; width?: number }) {
  const paths = kind === "CHECK" ? ["M27 52 L44 68 L74 35"] : ["M33 33 L67 67", "M67 33 L33 67"];
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: "block", overflow: "visible" }}>
      {paths.map((d, i) => {
        const n = paths.length;
        const t = clamp01(draw * n - i);
        return <path key={i} d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={r4(1 - t)} opacity={t > 0 ? 1 : 0} />;
      })}
    </svg>
  );
}

function starD(cx: number, cy: number, R: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r : R;
    pts.push(`${r1(cx + Math.cos(a) * rr)} ${r1(cy + Math.sin(a) * rr)}`);
  }
  return `M ${pts.join(" L ")} Z`;
}

/** Seconds as a clock: 3 → "0:03", 754 → "12:34", 5400 → "1:30:00". */
function clockText(sec: number, ref: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  if (ref >= 3600) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** An entrance transform (0..1 eased) — rise + fade. */
function riseStyle(t: number, d = 22): CSSProperties {
  return { opacity: clamp01(t * 1.4), transform: t >= 1 ? undefined : `translateY(${r1((1 - t) * d)}px)` };
}

// ===================================================================== VERDICT

function Verdict({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "CHECK":
      return <VerdictMark ctx={ctx} kind="CHECK" />;
    case "CROSS":
      return <VerdictMark ctx={ctx} kind="CROSS" />;
    case "TAPE":
      return <VerdictTape ctx={ctx} />;
    default:
      return <VerdictStamp ctx={ctx} />;
  }
}

/** A rectangular rubber stamp: worn ink (masked specks), double rule, slams in with a shake. */
function VerdictStamp({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps } = ctx;
  const uid = sid(useId());
  const c = mix(verdictColor(ctx, "PRI"), "#FFFFFF", 0.06);
  const word = (props.title?.trim() || "VERDICT").toUpperCase();
  const sub = (props.subtitle?.trim() ?? "").toUpperCase();
  const W = ctx.width - 110;
  const wSize = fitLine(word, W - 120, 156, 48, 1.07);
  const sSize = sub ? fitLine(sub, W - 230, 40, 28, 1.2) : 0;
  const cap = wSize * 0.73;
  const sCap = sSize * 0.73;
  const contentH = cap + (sub ? 40 + sCap : 0);
  const H = Math.round(132 + contentH);
  const top = (H - contentH) / 2;
  const base = top + cap;
  const subBase = base + 40 + sCap;
  const subW = sub ? Math.min(W - 160, textW(sub, sSize, 1.2)) : 0;
  const land = Math.max(4, Math.round(0.2 * fps));
  const a = prog(frame, 0, land, EASE_IN);
  const age = frame - land;
  const settle = age >= 0 ? springAt(frame, fps, land, ctx.f.springs.punch, Math.round(0.5 * fps)) : 0;
  const em = emphasisAt(ctx, land + 4);
  const scale = (age < 0 ? 1.9 - 0.9 * a : 0.96 + 0.04 * settle) * em.scale;
  const shake = (age >= 0 ? Math.sin(age * 2.4) * 7 * Math.max(0, 1 - age / 9) : 0) + em.shakeX;
  const ring = age >= 0 ? clamp01(age / Math.round(0.5 * fps)) : 0;
  const ink = rgba(c, 0.95);
  const rot = -7 - (1 - a) * 6;
  const specks = Array.from({ length: 30 }, (_, i) => ({ x: hash01(i * 3 + 1) * W, y: hash01(i * 7 + 2) * H, r: 1.2 + hash01(i * 5 + 3) * 4 }));
  const scratches = Array.from({ length: 5 }, (_, i) => {
    const x = hash01(i * 11 + 4) * W;
    const y = hash01(i * 13 + 5) * H;
    const l = 30 + hash01(i * 17 + 6) * 70;
    return { x1: x, y1: y, x2: x + l, y2: y + (hash01(i * 19 + 7) - 0.5) * 16 };
  });
  return (
    <div style={center}>
      {ring > 0 && ring < 1 ? <div style={{ position: "absolute", width: W, height: H, borderRadius: 28, border: `4px solid ${rgba(c, 0.55 * (1 - ring))}`, transform: `rotate(${r1(rot)}deg) scale(${r4(1 + ring * 0.13)})` }} /> : null}
      <div style={{ position: "relative", width: W, height: H, opacity: clamp01(a * 1.6), transform: `translateX(${r1(shake)}px) rotate(${r1(rot)}deg) scale(${r4(scale)})`, filter: `drop-shadow(0 ${r1(4 + 14 * (1 - a))}px ${r1(10 + 20 * (1 - a))}px ${rgba("#000000", 0.5)})${em.on > 0.01 ? ` drop-shadow(0 0 ${r1(18 * em.on)}px ${rgba(c, 0.45 * em.on)})` : ""}` }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <defs>
            <mask id={`m${uid}`} maskUnits="userSpaceOnUse" x={-20} y={-20} width={W + 40} height={H + 40}>
              <rect x={-20} y={-20} width={W + 40} height={H + 40} fill="#FFFFFF" />
              {specks.map((s, i) => (
                <circle key={i} cx={r1(s.x)} cy={r1(s.y)} r={r1(s.r)} fill="#000000" opacity={0.85} />
              ))}
              {scratches.map((s, i) => (
                <line key={`s${i}`} x1={r1(s.x1)} y1={r1(s.y1)} x2={r1(s.x2)} y2={r1(s.y2)} stroke="#000000" strokeWidth={2.2} strokeLinecap="round" opacity={0.7} />
              ))}
            </mask>
          </defs>
          <g mask={`url(#m${uid})`}>
            <rect x={7} y={7} width={W - 14} height={H - 14} rx={26} fill={rgba("#0B0B10", 0.34)} stroke={ink} strokeWidth={12} />
            <rect x={27} y={27} width={W - 54} height={H - 54} rx={14} fill={rgba(c, 0.08)} stroke={ink} strokeWidth={3.5} />
            <text x={W / 2 + 2} y={base + 1.5} textAnchor="middle" fontFamily={FONT.display} fontSize={wSize} letterSpacing="0.04em" fill={rgba(c, 0.28)}>
              {word}
            </text>
            <text x={W / 2} y={base} textAnchor="middle" fontFamily={FONT.display} fontSize={wSize} letterSpacing="0.04em" fill={ink} textLength={textW(word, wSize, 1.07) > W - 110 ? W - 110 : undefined} lengthAdjust="spacingAndGlyphs">
              {word}
            </text>
            {sub ? (
              <>
                <line x1={56} x2={W / 2 - subW / 2 - 22} y1={subBase - sCap / 2} y2={subBase - sCap / 2} stroke={ink} strokeWidth={4} strokeLinecap="round" />
                <line x1={W / 2 + subW / 2 + 22} x2={W - 56} y1={subBase - sCap / 2} y2={subBase - sCap / 2} stroke={ink} strokeWidth={4} strokeLinecap="round" />
                <text x={W / 2} y={subBase} textAnchor="middle" fontFamily={FONT.display} fontSize={sSize} letterSpacing="0.12em" fill={ink} textLength={textW(sub, sSize, 1.2) > W - 160 ? W - 160 : undefined} lengthAdjust="spacingAndGlyphs">
                  {sub}
                </text>
              </>
            ) : null}
          </g>
        </svg>
      </div>
    </div>
  );
}

/** A big tick / X: a solid disc pops, the ring draws round it, the mark draws on, the word lands. */
function VerdictMark({ ctx, kind }: { ctx: GCtx; kind: "CHECK" | "CROSS" }) {
  const { props, frame, fps } = ctx;
  const c = verdictColor(ctx, kind === "CHECK" ? "POS" : "NEG");
  const title = props.title?.trim() ?? "";
  const sub = props.subtitle?.trim() ?? "";
  const Dm = 320;
  const pop = springAt(frame, fps, 0, ctx.f.springs.soft, Math.round(0.9 * fps));
  const o = prog(frame, 0, 5);
  const ringT = prog(frame, 3, Math.round(0.45 * fps), ctx.ease);
  const markAt = Math.round(0.22 * fps);
  const draw = prog(frame, markAt, Math.round(0.36 * fps), EASE_IN_OUT);
  const landAt = markAt + Math.round(0.36 * fps);
  const shock = clamp01((frame - landAt) / Math.round(0.5 * fps));
  const em = emphasisAt(ctx, landAt);
  const punch = frame >= landAt ? 1 + 0.06 * Math.max(0, Math.sin(clamp01((frame - landAt) / 8) * Math.PI)) : 1;
  const shake = kind === "CROSS" && frame >= landAt ? Math.sin((frame - landAt) * 2.2) * 8 * Math.max(0, 1 - (frame - landAt) / 10) : 0;
  const tIn = prog(frame, Math.round(0.34 * fps), Math.round(0.45 * fps), ctx.ease);
  const sIn = prog(frame, Math.round(0.46 * fps), Math.round(0.45 * fps), ctx.ease);
  const tSize = title ? fitLine(title.toUpperCase(), ctx.width - 60, 112, 44, 1.04) : 0;
  const ink = onFill(c);
  const R = Dm / 2 + 26;
  const circ = 2 * Math.PI * R;
  return (
    <div style={{ ...fill, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", width: Dm + 80, height: Dm + 80, flex: "none", transform: `translateX(${r1(shake + em.shakeX)}px)` }}>
        <svg width={Dm + 80} height={Dm + 80} viewBox={`0 0 ${Dm + 80} ${Dm + 80}`} style={{ position: "absolute", inset: 0, overflow: "visible", transform: "rotate(-90deg)" }}>
          <circle cx={Dm / 2 + 40} cy={Dm / 2 + 40} r={R} fill="none" stroke={rgba(c, 0.95)} strokeWidth={8} strokeLinecap="round" strokeDasharray={`${r1(circ * ringT)} ${r1(circ)}`} style={{ filter: `drop-shadow(0 2px 6px ${rgba("#000000", 0.4)})` }} />
        </svg>
        {shock > 0 && shock < 1 ? <div style={{ position: "absolute", left: 40, top: 40, width: Dm, height: Dm, borderRadius: "50%", border: `6px solid ${rgba(c, 0.6 * (1 - shock))}`, transform: `scale(${r4(1 + shock * 0.42)})` }} /> : null}
        <div
          style={{
            position: "absolute",
            left: 40,
            top: 40,
            width: Dm,
            height: Dm,
            borderRadius: "50%",
            background: `radial-gradient(circle at 34% 28%, ${mix(c, "#FFFFFF", 0.4)} 0%, ${c} 52%, ${mix(c, "#000000", 0.24)} 100%)`,
            boxShadow: `0 26px 56px ${rgba("#000000", 0.45)}, 0 6px 14px ${rgba("#000000", 0.3)}, inset 0 4px 0 ${rgba("#FFFFFF", 0.35)}, inset 0 -10px 24px ${rgba("#000000", 0.18)}${em.on > 0.01 ? `, ${glowShadow(c, em.on, 1.2)}` : ""}`,
            opacity: o,
            transform: `scale(${r4((0.35 + 0.65 * pop) * punch * em.scale)})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <MarkPath kind={kind} size={Dm * 0.86} color={ink} draw={draw} width={kind === "CHECK" ? 11 : 10.5} />
        </div>
      </div>
      {title ? (
        <div style={{ marginTop: 18, fontFamily: FONT.display, fontSize: tSize, lineHeight: 1.05, letterSpacing: "0.02em", color: "#FFFFFF", whiteSpace: "nowrap", textShadow: `0 0 28px ${rgba(c, 0.45)}, ${SHADOW_TEXT}`, ...riseStyle(tIn, 26) }}>{title.toUpperCase()}</div>
      ) : null}
      {sub ? (
        <div style={{ marginTop: 10, maxWidth: ctx.width - 60, fontFamily: FONT.text, fontSize: 38, lineHeight: 1.2, color: rgba("#FFFFFF", 0.92), textShadow: SHADOW_TEXT, ...oneLine, ...riseStyle(sIn, 18) }}>{sub}</div>
      ) : null}
    </div>
  );
}

/** One strip of banner tape: hazard edges, the word repeated and scrolling. */
function TapeBand({ ctx, text, bg, fg, stripe, h, angle, cx, cy, len, reveal, dir, speed, slap }: { ctx: GCtx; text: string; bg: string; fg: string; stripe: string; h: number; angle: number; cx: number; cy: number; len: number; reveal: number; dir: 1 | -1; speed: number; slap: number }) {
  const size = Math.round(h * 0.5);
  const unitW = textW(text, size, 1.1) + size * 1.3;
  const reps = Math.max(3, Math.min(14, Math.ceil((len + 420) / Math.max(40, unitW)) + 1));
  const scroll = (ctx.frame * speed) % Math.max(1, unitW);
  const edge = Math.max(8, Math.round(h * 0.09));
  const clip = dir === 1 ? `inset(-20px ${r1((1 - reveal) * 100)}% -20px 0)` : `inset(-20px 0 -20px ${r1((1 - reveal) * 100)}%)`;
  const hazard = `repeating-linear-gradient(-45deg, ${stripe} 0px, ${stripe} 14px, transparent 14px, transparent 28px)`;
  return (
    <div style={{ position: "absolute", left: cx - len / 2, top: cy - h / 2, width: len, height: h, transform: `rotate(${angle}deg) scaleY(${r4(slap)})`, clipPath: clip, filter: `drop-shadow(0 16px 26px ${rgba("#000000", 0.45)})` }}>
      <div style={{ ...fill, background: `linear-gradient(180deg, ${mix(bg, "#FFFFFF", 0.14)} 0%, ${bg} 45%, ${mix(bg, "#000000", 0.12)} 100%)`, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: edge, backgroundImage: hazard }} />
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: edge, backgroundImage: hazard }} />
        <div style={{ position: "absolute", top: 0, bottom: 0, left: dir === 1 ? -scroll : -unitW + scroll, display: "flex", alignItems: "center", whiteSpace: "nowrap" }}>
          {Array.from({ length: reps }, (_, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", flex: "none", width: unitW }}>
              <span style={{ fontFamily: FONT.display, fontSize: size, lineHeight: 1, letterSpacing: "0.08em", color: fg }}>{text}</span>
              <span style={{ width: size * 0.26, height: size * 0.26, marginLeft: size * 0.5, background: fg, transform: "rotate(45deg)", opacity: 0.8, flex: "none" }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Two crossing banner tapes (SOLD OUT / DO NOT BUY): the back strip wipes in, the front slaps over it. */
function VerdictTape({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps, width: W, height: H } = ctx;
  const c = verdictColor(ctx, "PRI");
  const word = (props.title?.trim() || "SOLD OUT").toUpperCase();
  const back = (props.subtitle?.trim() || word).toUpperCase();
  const len = W + 460;
  const r1T = prog(frame, 0, Math.round(0.32 * fps), ctx.ease);
  const at2 = Math.round(0.16 * fps);
  const r2T = prog(frame, at2, Math.round(0.3 * fps), EASE_IN);
  const slapAt = at2 + Math.round(0.3 * fps);
  const slap = frame >= slapAt ? 1 + 0.12 * Math.max(0, 1 - springAt(frame, fps, slapAt, ctx.f.springs.punch, Math.round(0.4 * fps))) : 1;
  const ink = onFill(c);
  return (
    <div style={fill}>
      <TapeBand ctx={ctx} text={back} bg={mix(NOIR, c, 0.06)} fg={c} stripe={rgba(c, 0.85)} h={106} angle={9} cx={W / 2} cy={H / 2 - 22} len={len} reveal={r1T} dir={-1} speed={1.6} slap={1} />
      <TapeBand ctx={ctx} text={word} bg={c} fg={ink} stripe={rgba(NOIR, 0.85)} h={138} angle={-7} cx={W / 2} cy={H / 2 + 22} len={len} reveal={r2T} dir={1} speed={2.2} slap={slap} />
    </div>
  );
}

// ===================================================================== HOOK_TEXT

function HookText({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "MEME":
      return <HookMeme ctx={ctx} />;
    case "POV":
      return <HookPov ctx={ctx} />;
    case "WAIT":
      return <HookWait ctx={ctx} />;
    case "PLOT_TWIST":
      return <HookPlotTwist ctx={ctx} />;
    case "CHAPTER":
      return <HookChapter ctx={ctx} />;
    default:
      return <HookPow ctx={ctx} />;
  }
}

function burstPoints(cx: number, cy: number, rx: number, ry: number, n: number, inner: number, seed: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 2 * n; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n + (hash01(seed + i * 1.3) - 0.5) * 0.1;
    const r = i % 2 ? inner * (0.9 + 0.16 * hash01(seed + i * 2.1)) : 0.86 + 0.14 * hash01(seed + i * 3.7);
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }
  return pts;
}

/** Comic POW: a halftone starburst slams in behind outlined comic type. */
function HookPow({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps, width: W, height: H } = ctx;
  const title = (props.title?.trim() || "POW!").toUpperCase();
  const sub = props.subtitle?.trim() ?? "";
  const cx = W / 2;
  const cy = H / 2;
  const front = burstPoints(cx, cy, W * 0.47, H * 0.47, 15, 0.7, 3);
  const backPts = burstPoints(cx, cy, W * 0.5, H * 0.5, 13, 0.74, 41);
  const poly = (pts: Array<[number, number]>) => pts.map(([x, y]) => `${r1(x)},${r1(y)}`).join(" ");
  const cssPoly = `polygon(${front.map(([x, y]) => `${r1(x)}px ${r1(y)}px`).join(", ")})`;
  const b1 = springAt(frame, fps, 0, ctx.f.springs.punch, Math.round(0.6 * fps));
  const b2 = springAt(frame, fps, 2, ctx.f.springs.punch, Math.round(0.6 * fps));
  const tS = springAt(frame, fps, Math.round(0.08 * fps), ctx.f.springs.punch, Math.round(0.7 * fps));
  const o = prog(frame, 0, 4);
  const landAt = Math.round(0.3 * fps);
  const em = emphasisAt(ctx, landAt);
  const throb = 1 + 0.012 * Math.sin((frame / fps) * 7) * prog(frame, landAt, 8);
  const c = p.primary;
  const c2 = p.secondary;
  const fitted = fitBlock(title, W * 0.6, H * (sub ? 0.36 : 0.44), { max: 150, min: 56, lh: 0.98, k: 1.04, maxLines: 3 });
  const sw = Math.max(8, Math.round(fitted.size * 0.13));
  const subSize = sub ? fitLine(sub.toUpperCase(), W * 0.56, 40, 28, 1.08) : 0;
  return (
    <div style={{ ...fill, opacity: o }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0, overflow: "visible", transform: `rotate(${r1(8 + (1 - b1) * -20)}deg) scale(${r4(0.2 + 0.8 * Math.max(0, b1))})`, transformOrigin: "50% 50%" }}>
        <polygon points={poly(backPts)} fill={mix(c2, "#000000", 0.08)} stroke={NOIR} strokeWidth={9} strokeLinejoin="round" />
      </svg>
      <div style={{ ...fill, transform: `rotate(${r1(-4 + (1 - b2) * 16)}deg) scale(${r4((0.15 + 0.85 * Math.max(0, b2)) * throb * em.scale)})`, transformOrigin: "50% 50%" }}>
        <div style={{ ...fill, clipPath: cssPoly, background: `radial-gradient(ellipse 60% 60% at 40% 34%, ${mix(c, "#FFFFFF", 0.45)} 0%, ${c} 55%, ${mix(c, "#000000", 0.22)} 100%)` }} />
        <div style={{ ...fill, clipPath: cssPoly, backgroundImage: `radial-gradient(circle, ${rgba(NOIR, 0.26)} 0, ${rgba(NOIR, 0.26)} 32%, transparent 36%)`, backgroundSize: "20px 20px", WebkitMaskImage: "linear-gradient(140deg, transparent 25%, #000 85%)", maskImage: "linear-gradient(140deg, transparent 25%, #000 85%)" }} />
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <polygon points={poly(front)} fill="none" stroke={NOIR} strokeWidth={10} strokeLinejoin="round" />
        </svg>
      </div>
      <div style={{ ...center, flexDirection: "column", transform: `rotate(-6deg) scale(${r4(Math.max(0, 0.3 + 0.7 * tS))})` }}>
        <StrokeText lines={fitted.lines} size={fitted.size} lh={0.98} width={W * 0.66} color="#FFFFFF" stroke={NOIR} strokeW={sw} shadow={Math.round(fitted.size * 0.07)} k={1.04} />
        {sub ? (
          <div style={{ marginTop: 22, padding: "10px 26px", borderRadius: 14, background: NOIR, color: "#FFFFFF", fontFamily: FONT.display, fontSize: subSize, letterSpacing: "0.04em", textTransform: "uppercase", maxWidth: W * 0.62, ...oneLine, opacity: prog(frame, landAt, 6) }}>{sub}</div>
        ) : null}
      </div>
    </div>
  );
}

/** Meme captions: bold outlined top text, bottom text a beat later; the middle stays clear. */
function HookMeme({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps, width: W, height: H } = ctx;
  const top = (props.title?.trim() ?? "").toUpperCase();
  const bot = (props.subtitle?.trim() ?? "").toUpperCase();
  const zone = Math.min(420, H * 0.26);
  const o = { max: 118, min: 56, lh: 1.02, k: 1.04, maxLines: 3 };
  const ft = fitBlock(top, W - 70, zone, o);
  const fb = fitBlock(bot, W - 70, zone, o);
  const t0 = Math.round(0.04 * fps);
  const k = Math.min(1, (buildBudget(ctx) - t0) / Math.max(1, Math.round(0.9 * fps)));
  const botAt = t0 + Math.round(0.55 * fps * k);
  const lineStyle = (start: number) => (i: number): CSSProperties => {
    const s = springAt(frame, fps, start + i * Math.round(3 * ctx.f.tempo), ctx.f.springs.punch, Math.round(0.5 * fps));
    const a = prog(frame, start + i * Math.round(3 * ctx.f.tempo), 3);
    return { opacity: a, transform: `scale(${r4(0.6 + 0.4 * Math.max(0, s))})` };
  };
  const sw = (s: number) => Math.max(7, Math.round(s * 0.13));
  return (
    <div style={fill}>
      {ft.lines.length ? (
        <div style={{ position: "absolute", left: 35, right: 35, top: 26, display: "flex", justifyContent: "center", filter: `drop-shadow(0 6px 14px ${rgba("#000000", 0.4)})` }}>
          <StrokeText lines={ft.lines} size={ft.size} lh={1.02} width={W - 70} color="#FFFFFF" stroke={NOIR} strokeW={sw(ft.size)} k={1.04} lineStyle={lineStyle(t0)} />
        </div>
      ) : null}
      {fb.lines.length ? (
        <div style={{ position: "absolute", left: 35, right: 35, bottom: 26, display: "flex", justifyContent: "center", filter: `drop-shadow(0 6px 14px ${rgba("#000000", 0.4)})` }}>
          <StrokeText lines={fb.lines} size={fb.size} lh={1.02} width={W - 70} color="#FFFFFF" stroke={NOIR} strokeW={sw(fb.size)} k={1.04} lineStyle={lineStyle(botAt)} />
        </div>
      ) : null}
    </div>
  );
}

/** A word that rises out of a mask (the house kinetic reveal) or uses the entrance vocabulary. */
function RevealWord({ ctx, start, len, size, face, children, gap }: { ctx: GCtx; start: number; len: number; size: number; face: CSSProperties; children: ReactNode; gap: number }) {
  const style = ctx.anim.enter;
  if (style === "RISE" || style === "SLIDE" || style === "DROP" || style === "WIPE") {
    const t = prog(ctx.frame, start, Math.round(len * 1.2), ctx.ease);
    const masked = t < 0.999;
    const pad = Math.round(size * 0.2);
    return (
      <span style={{ display: "inline-block", overflow: masked ? "hidden" : "visible", padding: `${pad}px 0.05em`, margin: `${-pad}px ${gap - size * 0.05}px ${-pad}px -0.05em`, opacity: t <= 0 ? 0 : 1, verticalAlign: "bottom" }}>
        <span style={{ display: "inline-block", transform: masked ? `translateY(${r1((1 - t) * (style === "DROP" ? -110 : 110))}%)` : undefined, ...face }}>{children}</span>
      </span>
    );
  }
  const s = seqLike(ctx, start, len);
  return <span style={{ display: "inline-block", marginRight: gap, ...s, ...face }}>{children}</span>;
}

function seqLike(ctx: GCtx, start: number, len: number): CSSProperties {
  const seq = { at: () => start, len, count: 1, flat: () => 0, groupDone: () => start + len, done: start + len, first: start };
  return css(seqStyle(ctx, seq, 0, 0));
}

/** "POV:" editorial title — the label in serif accent, the situation types in word by word. */
function HookPov({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps, width: W, height: H } = ctx;
  const t = toneOf(ctx);
  const label = props.title?.trim() || "POV:";
  const body = props.body?.trim() || props.subtitle?.trim() || "";
  const padX = 60;
  const padY = 44;
  const tokens = [label, ...splitW(body)];
  const f = fitWords(tokens, W - padX - 52, H - 2 * padY, { max: 66, min: 40, lh: 1.18, maxLines: 6 });
  const seq = listSequence(tokens.length, ctx.anim, seqOpts(ctx, Math.round(0.16 * fps)));
  const bar = prog(frame, 0, Math.round(0.5 * fps), ctx.ease);
  const cardIn = prog(frame, 0, Math.round(0.4 * fps), ctx.ease);
  const gap = f.size * 0.27;
  return (
    <div style={{ ...fill, ...card(t, 40), opacity: clamp01(cardIn * 1.5) }}>
      <div style={{ position: "absolute", left: 30, top: padY + 8, bottom: padY + 8, width: 7, borderRadius: 4, background: `linear-gradient(180deg, ${t.accent}, ${t.accent2})`, transform: `scaleY(${r4(bar)})`, transformOrigin: "50% 0%" }} />
      <div style={{ position: "absolute", left: padX, right: 52, top: padY, bottom: padY, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        {f.lines.map((line, li) => (
          <div key={li} style={{ height: f.size * 1.18, display: "flex", alignItems: "flex-end", whiteSpace: "nowrap" }}>
            {line.map((wi) => {
              const isLabel = wi === 0;
              const face: CSSProperties = isLabel
                ? { fontFamily: FONT.serif, fontSize: f.size * 1.12, lineHeight: 1.05, color: t.accent, letterSpacing: "0.005em" }
                : { fontFamily: FONT.display, fontSize: f.size, lineHeight: 1.08, color: t.ink, letterSpacing: "-0.015em" };
              return (
                <RevealWord key={wi} ctx={ctx} start={seq.at(0, wi)} len={seq.len} size={f.size} face={face} gap={gap}>
                  {f.words[wi]}
                </RevealWord>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** "wait for it…" — hourglass flips, the dots tick, a bar fills to the payoff. */
function HookWait({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps, width: W } = ctx;
  const t = toneOf(ctx);
  const title = props.title?.trim() || "wait for it";
  const sub = props.subtitle?.trim() ?? "";
  const pad = 46;
  const disc = 104;
  const dotsW = 84;
  const tSize = fitLine(title, W - 2 * pad - disc - 30 - dotsW, 76, 40);
  const B = buildBudget(ctx, 0.4);
  const t0 = Math.round(0.25 * fps);
  const fillT = prog(frame, t0, Math.max(4, B - t0), (x) => x * (0.6 + 0.4 * x));
  const done = frame >= B ? clamp01((frame - B) / 8) : 0;
  const sec = frame / fps;
  const flipK = Math.floor(sec / 1.1);
  const fr = sec / 1.1 - flipK;
  const rot = 180 * flipK + 180 * EASE_IN_OUT(clamp01((fr - 0.72) / 0.28));
  const e1 = prog(frame, 0, Math.round(0.45 * fps), ctx.ease);
  const e2 = prog(frame, 4, Math.round(0.45 * fps), ctx.ease);
  const e3 = prog(frame, 8, Math.round(0.45 * fps), ctx.ease);
  const phase = Math.floor((frame / fps) * 3.2) % 4;
  return (
    <div style={{ ...fill, ...card(t, 40), ...riseStyle(e1, 26) }}>
      <div style={{ position: "absolute", left: pad, right: pad, top: pad, display: "flex", alignItems: "center", gap: 30 }}>
        <div style={{ width: disc, height: disc, borderRadius: "50%", flex: "none", background: `linear-gradient(160deg, ${rgba(t.accent, 0.24)}, ${rgba(t.accent, 0.1)})`, boxShadow: `inset 0 0 0 2px ${rgba(t.accent, 0.35)}`, display: "flex", alignItems: "center", justifyContent: "center", ...riseStyle(e2, 14) }}>
          <div style={{ transform: `rotate(${r1(rot)}deg)` }}>
            <GIcon icon="HOURGLASS" size={56} color={t.accent} stroke={2.2} />
          </div>
        </div>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", ...riseStyle(e3, 14) }}>
          <div style={{ display: "flex", alignItems: "baseline" }}>
            <span style={{ fontFamily: FONT.display, fontSize: tSize, lineHeight: 1.1, letterSpacing: "-0.02em", color: t.ink, whiteSpace: "nowrap" }}>{title}</span>
            <span style={{ display: "inline-flex", gap: 10, marginLeft: 12, alignItems: "flex-end", height: tSize * 0.8 }}>
              {[0, 1, 2].map((k) => (
                <span key={k} style={{ width: 14, height: 14, borderRadius: 7, background: t.accent, opacity: done > 0 ? 1 : phase > k ? 1 : 0.18, transform: `translateY(${phase === k + 1 && done === 0 ? -6 : 0}px)` }} />
              ))}
            </span>
          </div>
          {sub ? <div style={{ marginTop: 6, fontFamily: FONT.text, fontSize: 34, lineHeight: 1.2, color: t.muted, ...oneLine }}>{sub}</div> : null}
        </div>
      </div>
      <div style={{ position: "absolute", left: pad, right: pad, bottom: pad, height: 18, borderRadius: 9, background: t.fill2, overflow: "hidden", opacity: e3 }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${r1(fillT * 100)}%`, borderRadius: 9, background: `linear-gradient(90deg, ${t.accent2}, ${t.accent})`, boxShadow: done > 0 ? `0 0 ${r1(18 * done)}px ${rgba(t.accent, 0.7 * done)}` : undefined }} />
        <div style={{ position: "absolute", top: 0, bottom: 0, width: 120, left: `${r1(((frame * 3) % 160) - 20)}%`, background: `linear-gradient(90deg, transparent, ${rgba("#FFFFFF", 0.35)}, transparent)`, opacity: 1 - done }} />
      </div>
    </div>
  );
}

/** PLOT TWIST — the words slam in over a spinning spiral of zoom rays. */
function HookPlotTwist({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps, width: W, height: H } = ctx;
  const title = (props.title?.trim() || "PLOT TWIST").toUpperCase();
  const sub = props.subtitle?.trim() ?? "";
  const land = Math.max(3, Math.round(0.2 * fps));
  const a = prog(frame, 0, land, EASE_IN);
  const age = frame - land;
  const set = age >= 0 ? springAt(frame, fps, land, ctx.f.springs.punch, Math.round(0.5 * fps)) : 0;
  const em = emphasisAt(ctx, land);
  const scale = (age < 0 ? 2.5 - 1.5 * a : 0.94 + 0.06 * set) * em.scale;
  const shake = (age >= 0 ? Math.sin(age * 2.3) * 12 * Math.max(0, 1 - age / 9) : 0) + em.shakeX;
  const flash = age >= 0 ? Math.max(0, 1 - age / 6) : 0;
  const bg = prog(frame, 0, Math.round(0.35 * fps), EASE_OUT);
  const spin = (frame / fps) * 70;
  const pulse = ((frame / fps) * 90) % 64;
  const S = Math.max(W, H) * 1.1;
  const fitted = fitBlock(title, W - 140, H * (sub ? 0.42 : 0.5), { max: 150, min: 60, lh: 0.98, k: 1.03, maxLines: 3 });
  const subIn = prog(frame, land + 4, Math.round(0.4 * fps), ctx.ease);
  const mask = "radial-gradient(circle, transparent 0%, transparent 16%, #000 30%, #000 44%, transparent 68%)";
  return (
    <div style={fill}>
      <div style={{ position: "absolute", left: (W - S) / 2, top: (H - S) / 2, width: S, height: S, opacity: bg, transform: `rotate(${r1(spin)}deg) scale(${r4(0.6 + 0.4 * bg)})`, backgroundImage: `repeating-conic-gradient(from 0deg, ${rgba(p.primary, 0.55)} 0deg 5deg, transparent 5deg 15deg)`, WebkitMaskImage: mask, maskImage: mask }} />
      <div style={{ position: "absolute", left: (W - S) / 2, top: (H - S) / 2, width: S, height: S, opacity: bg * 0.8, backgroundImage: `repeating-radial-gradient(circle, transparent 0px, transparent ${r1(pulse)}px, ${rgba(p.secondary, 0.45)} ${r1(pulse + 3)}px, transparent ${r1(pulse + 9)}px, transparent 64px)`, WebkitMaskImage: mask, maskImage: mask }} />
      <div style={{ ...fill, background: `radial-gradient(ellipse 46% 34% at 50% 50%, ${rgba("#08080C", 0.55)} 0%, ${rgba("#08080C", 0.25)} 55%, transparent 80%)`, opacity: bg }} />
      <div style={{ ...center, flexDirection: "column", opacity: clamp01(a * 1.5), transform: `translateX(${r1(shake)}px) scale(${r4(scale)})` }}>
        <StrokeText lines={fitted.lines} size={fitted.size} lh={0.98} width={W - 120} color="#FFFFFF" stroke={mix(p.primary, NOIR, 0.82)} strokeW={Math.round(fitted.size * 0.09)} shadow={Math.round(fitted.size * 0.06)} k={1.03} />
      </div>
      {sub ? (
        <div style={{ position: "absolute", left: 60, right: 60, top: H / 2 + (fitted.lines.length * fitted.size * 0.98) / 2 + 30, display: "flex", justifyContent: "center", ...riseStyle(subIn, 16) }}>
          <div style={{ padding: "12px 28px", borderRadius: 999, background: rgba(NOIR, 0.78), boxShadow: `inset 0 0 0 2px ${rgba(p.primary, 0.5)}`, fontFamily: FONT.displayBold, fontSize: fitLine(sub, W - 220, 40, 30), color: "#FFFFFF", maxWidth: W - 160, ...oneLine }}>{sub}</div>
        </div>
      ) : null}
      {flash > 0.01 ? <div style={{ ...fill, background: `radial-gradient(ellipse 60% 50% at 50% 50%, ${rgba("#FFFFFF", 0.5 * flash)} 0%, transparent 70%)` }} /> : null}
    </div>
  );
}

/** Chapter card: "PART 1" between growing rules, the title in serif, a hairline draws under it. */
function HookChapter({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps, width: W } = ctx;
  const t = toneOf(ctx);
  const title = props.title?.trim() || "Storytime";
  const kicker = (props.subtitle?.trim() || "Chapter 1").toUpperCase();
  const kSize = fitLine(kicker, W - 360, 34, 28, 1.3);
  const kW = Math.min(W - 360, textW(kicker, kSize, 1.3));
  const tSize = fitLine(title, W - 130, 150, 60, 0.86);
  const cIn = prog(frame, 0, Math.round(0.4 * fps), ctx.ease);
  const rules = prog(frame, Math.round(0.12 * fps), Math.round(0.6 * fps), ctx.ease);
  const kIn = prog(frame, Math.round(0.1 * fps), Math.round(0.45 * fps), ctx.ease);
  const tAt = Math.round(0.22 * fps);
  const lineT = prog(frame, Math.round(0.5 * fps), Math.round(0.6 * fps), ctx.ease);
  const ruleW = Math.max(40, (W - 120 - kW) / 2 - 30);
  const words = splitW(title);
  const seq = listSequence(words.length, ctx.anim, seqOpts(ctx, tAt));
  return (
    <div style={{ ...fill, ...card(t, 44), opacity: clamp01(cIn * 1.5), transform: `scale(${r4(0.97 + 0.03 * cIn)})` }}>
      <div style={{ position: "absolute", left: 60, right: 60, top: 64, height: 44, display: "flex", alignItems: "center", justifyContent: "center", gap: 26 }}>
        <div style={{ width: ruleW, height: 2.5, borderRadius: 2, background: `linear-gradient(90deg, transparent, ${rgba(t.accent, 0.8)})`, transform: `scaleX(${r4(rules)})`, transformOrigin: "100% 50%" }} />
        <div style={{ fontFamily: FONT.text, fontSize: kSize, letterSpacing: "0.24em", color: t.accent, whiteSpace: "nowrap", ...riseStyle(kIn, 12) }}>{kicker}</div>
        <div style={{ width: ruleW, height: 2.5, borderRadius: 2, background: `linear-gradient(90deg, ${rgba(t.accent, 0.8)}, transparent)`, transform: `scaleX(${r4(rules)})`, transformOrigin: "0% 50%" }} />
      </div>
      <div style={{ position: "absolute", left: 40, right: 40, top: 120, bottom: 70, display: "flex", alignItems: "center", justifyContent: "center", whiteSpace: "nowrap" }}>
        {words.map((w, i) => (
          <RevealWord key={i} ctx={ctx} start={seq.at(0, i)} len={seq.len} size={tSize} gap={i < words.length - 1 ? tSize * 0.24 : 0} face={{ fontFamily: FONT.serif, fontSize: tSize, lineHeight: 1.08, color: t.ink, letterSpacing: "-0.01em" }}>
            {w}
          </RevealWord>
        ))}
      </div>
      <div style={{ position: "absolute", left: "50%", bottom: 62, width: 180, marginLeft: -90, height: 5, borderRadius: 3, background: `linear-gradient(90deg, ${t.accent2}, ${t.accent})`, transform: `scaleX(${r4(lineT)})` }} />
    </div>
  );
}

// ===================================================================== COUNTDOWN

interface CountPlan {
  nums: number[];
  t0: number;
  per: number;
  finalAt: number;
  hasFinal: boolean;
  /** Index of the number on screen at `frame` (clamped). */
  idx: (frame: number) => number;
  startOf: (i: number) => number;
}

/** When each number of a countdown shows: ≤ 1 s each, compressed (and strided) to fit the build. */
function countPlan(ctx: GCtx, endZero = false): CountPlan {
  const { fps } = ctx;
  const n = Math.max(1, Math.min(5999, Math.round(ctx.props.items[0]?.value ?? 3)));
  const hasFinal = endZero || !!ctx.props.title?.trim();
  const t0 = Math.round(0.06 * fps);
  const room = Math.max(fps * 0.6, buildBudget(ctx, 0.6) - t0);
  const minPer = Math.max(3, (0.3 * fps) / ctx.anim.speed);
  const tail = hasFinal ? 0.9 : 0.3;
  let stride = 1;
  let nums: number[] = [];
  for (let guard = 0; guard < 200; guard++) {
    nums = [];
    for (let v = n; v >= 1; v -= stride) nums.push(v);
    if (nums[nums.length - 1] !== 1) nums.push(1);
    if ((nums.length + tail) * minPer <= room || stride >= n) break;
    stride = Math.ceil(stride * 1.25 + 1);
  }
  const per = Math.max(3, Math.min(fps / ctx.anim.speed, room / (nums.length + tail)));
  const finalAt = Math.round(t0 + nums.length * per);
  return {
    nums,
    t0,
    per,
    finalAt,
    hasFinal,
    idx: (frame) => Math.max(0, Math.min(nums.length - 1, Math.floor((frame - t0) / per))),
    startOf: (i) => Math.round(t0 + i * per),
  };
}

function Countdown({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "RING":
      return <CountRing ctx={ctx} />;
    case "FLIP":
      return <CountFlip ctx={ctx} />;
    case "BAR":
      return <CountBar ctx={ctx} />;
    default:
      return <CountNumbers ctx={ctx} />;
  }
}

/** The final word of a countdown: slams in with a flash (gold face). */
function FinalWord({ ctx, at, word, width, max, color }: { ctx: GCtx; at: number; word: string; width: number; max: number; color?: string }) {
  const { frame, fps } = ctx;
  if (frame < at) return null;
  const s = springAt(frame, fps, at, ctx.f.springs.punch, Math.round(0.5 * fps));
  const o = prog(frame, at, 3);
  const em = emphasisAt(ctx, at + 2);
  const size = fitLine(word, width, max, 56, 1.02);
  const face: CSSProperties = color ? { color, textShadow: SHADOW_TEXT } : goldFace(ctx, 0.5 + 0.5 * em.on);
  return (
    <div style={{ ...center, opacity: o, transform: `translateX(${r1(em.shakeX)}px) scale(${r4((1.5 - 0.5 * Math.min(1.1, Math.max(0, s))) * em.scale)})` }}>
      <span style={{ fontFamily: FONT.display, fontSize: size, lineHeight: 1, letterSpacing: "-0.03em", whiteSpace: "nowrap", ...face }}>{word}</span>
    </div>
  );
}

/** 3-2-1: each number punches in with a shockwave ring and dissolves; then the final word. */
function CountNumbers({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps, width: W, height: H } = ctx;
  const plan = countPlan(ctx);
  const word = props.title?.trim() ?? "";
  const final = plan.hasFinal && frame >= plan.finalAt;
  const i = plan.idx(frame);
  const st = plan.startOf(i);
  const v = plan.nums[i]!;
  const lf = frame - st;
  const s = springAt(frame, fps, st, ctx.f.springs.punch, Math.round(0.5 * fps));
  const isLast = i === plan.nums.length - 1 && !plan.hasFinal;
  const outT = isLast ? 0 : clamp01((lf - plan.per * 0.7) / Math.max(1, plan.per * 0.3));
  const shock = clamp01(lf / Math.max(4, plan.per * 0.8));
  const txt = String(v);
  const size = fitLine(txt, W - 120, 420, 120, 1);
  const flash = final ? Math.max(0, 1 - (frame - plan.finalAt) / 6) : 0;
  const bgIn = prog(frame, 0, 6);
  const dots = Math.min(plan.nums.length, 10);
  return (
    <div style={fill}>
      <div style={{ ...fill, opacity: bgIn, background: `radial-gradient(circle at 50% 50%, ${rgba("#08080C", 0.5)} 0%, ${rgba("#08080C", 0.25)} 40%, transparent 68%)` }} />
      {!final ? (
        <>
          {shock < 1 ? <div style={{ position: "absolute", left: W / 2 - 230, top: H / 2 - 230, width: 460, height: 460, borderRadius: "50%", border: `${r1(10 * (1 - shock) + 2)}px solid ${rgba(p.primary, 0.75 * (1 - shock))}`, transform: `scale(${r4(0.55 + 0.6 * EASE_OUT(shock))})` }} /> : null}
          <div style={{ ...center, opacity: prog(frame, st, 3) * (1 - outT), transform: `scale(${r4((1.45 - 0.45 * Math.min(1.1, Math.max(0, s))) * (1 + 0.25 * outT))})` }}>
            <span style={{ fontFamily: FONT.display, fontSize: size, lineHeight: 1, letterSpacing: "-0.05em", color: "#FFFFFF", fontVariantNumeric: "tabular-nums", textShadow: `0 0 50px ${rgba(p.primary, 0.5)}, ${SHADOW_TEXT}` }}>{txt}</span>
          </div>
        </>
      ) : (
        <FinalWord ctx={ctx} at={plan.finalAt} word={word} width={W - 80} max={230} />
      )}
      {dots > 1 ? (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 36, display: "flex", justifyContent: "center", gap: 14, opacity: bgIn }}>
          {Array.from({ length: dots }, (_, k) => {
            const on = final || k <= Math.round((i / Math.max(1, plan.nums.length - 1)) * (dots - 1));
            return <div key={k} style={{ width: on ? 34 : 14, height: 14, borderRadius: 7, background: on ? p.primary : rgba("#FFFFFF", 0.35), boxShadow: `0 2px 8px ${rgba("#000000", 0.4)}` }} />;
          })}
        </div>
      ) : null}
      {flash > 0.01 ? <div style={{ ...fill, borderRadius: "50%", background: `radial-gradient(circle, ${rgba("#FFFFFF", 0.55 * flash)} 0%, transparent 65%)` }} /> : null}
    </div>
  );
}

/** A timer dial: the ring drains each second around the number; the word lands at zero. */
function CountRing({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps, width: W, height: H } = ctx;
  const t = toneOf(ctx);
  const plan = countPlan(ctx);
  const word = props.title?.trim() ?? "";
  const final = plan.hasFinal && frame >= plan.finalAt;
  const i = plan.idx(frame);
  const st = plan.startOf(i);
  const lf = frame - st;
  const v = plan.nums[i]!;
  const D = Math.min(W, H) - 60;
  const R = D / 2 - 46;
  const circ = 2 * Math.PI * R;
  const inT = springAt(frame, fps, 0, ctx.f.springs.soft, Math.round(0.8 * fps));
  const drain = final ? 1 : clamp01(lf / Math.max(1, plan.per));
  const isLastHold = i === plan.nums.length - 1 && !plan.hasFinal;
  const remain = final ? 1 : isLastHold ? 0 : 1 - drain;
  const pop = springAt(frame, fps, st, ctx.f.springs.punch, Math.round(0.4 * fps));
  const txt = String(v);
  const size = fitLine(txt, R * 1.4, 300, 100, 1);
  const col = final ? t.positive : t.accent;
  const em = emphasisAt(ctx, plan.finalAt);
  return (
    <div style={center}>
      <div style={{ position: "relative", width: D, height: D, borderRadius: "50%", ...card(t, D / 2), boxShadow: `${(card(t, D / 2).boxShadow as string) ?? ""}${final && em.on > 0.01 ? `, ${glowShadow(col, em.on)}` : ""}`, opacity: clamp01(inT * 1.4), transform: `scale(${r4((0.5 + 0.5 * Math.min(1.05, Math.max(0, inT))) * (final ? em.scale : 1))})` }}>
        <svg width={D} height={D} viewBox={`0 0 ${D} ${D}`} style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
          {Array.from({ length: 60 }, (_, k) => {
            const a = (k / 60) * Math.PI * 2;
            const r0 = R + 30;
            const r2 = R + (k % 5 === 0 ? 40 : 35);
            return <line key={k} x1={r1(D / 2 + Math.cos(a) * r0)} y1={r1(D / 2 + Math.sin(a) * r0)} x2={r1(D / 2 + Math.cos(a) * r2)} y2={r1(D / 2 + Math.sin(a) * r2)} stroke={k % 5 === 0 ? t.muted : t.faint} strokeWidth={k % 5 === 0 ? 3 : 2} strokeLinecap="round" opacity={0.7} />;
          })}
          <circle cx={D / 2} cy={D / 2} r={R} fill="none" stroke={t.fill2} strokeWidth={24} />
          <circle cx={D / 2} cy={D / 2} r={R} fill="none" stroke={col} strokeWidth={24} strokeLinecap="round" strokeDasharray={`${r1(circ * remain)} ${r1(circ)}`} style={{ filter: `drop-shadow(0 0 10px ${rgba(col, 0.45)})` }} />
        </svg>
        {!final ? (
          <div style={{ ...center, transform: `scale(${r4(1.2 - 0.2 * Math.min(1.1, Math.max(0, pop)))})`, opacity: prog(frame, st, 3) }}>
            <span style={{ fontFamily: FONT.display, fontSize: size, lineHeight: 1, letterSpacing: "-0.05em", color: t.ink, fontVariantNumeric: "tabular-nums" }}>{txt}</span>
          </div>
        ) : (
          <FinalWord ctx={ctx} at={plan.finalAt} word={word} width={R * 1.55} max={150} color={t.ink} />
        )}
      </div>
    </div>
  );
}

/** One flip-clock digit card (top flap folds down to reveal the next digit). */
function FlipDigit({ t, w, h, cur, prev, fp, color }: { t: Tone; w: number; h: number; cur: string; prev: string; fp: number; color: string }) {
  const faceBg = t.dark ? "linear-gradient(180deg, #2B2B36 0%, #1D1D25 100%)" : "linear-gradient(180deg, #FFFFFF 0%, #EFEFF3 100%)";
  const lowerBg = t.dark ? "linear-gradient(180deg, #1A1A21 0%, #15151B 100%)" : "linear-gradient(180deg, #E9E9EE 0%, #E1E1E7 100%)";
  const size = Math.round(h * 0.78);
  const glyph = (d: string, half: "top" | "bottom") => (
    <div style={{ position: "absolute", left: 0, right: 0, height: h, top: half === "top" ? 0 : -h / 2, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, fontSize: size, lineHeight: 1, color, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.03em" }}>{d}</div>
  );
  const half = (d: string, which: "top" | "bottom", style: CSSProperties = {}) => (
    <div style={{ position: "absolute", left: 0, right: 0, height: h / 2, top: which === "top" ? 0 : h / 2, overflow: "hidden", background: which === "top" ? faceBg : lowerBg, borderRadius: which === "top" ? "22px 22px 0 0" : "0 0 22px 22px", ...style }}>{glyph(d, which)}</div>
  );
  const flipping = fp > 0 && fp < 1;
  return (
    <div style={{ position: "relative", width: w, height: h, flex: "none", borderRadius: 22, boxShadow: `0 18px 36px ${rgba("#000000", t.dark ? 0.45 : 0.22)}, inset 0 0 0 1.5px ${t.dark ? rgba("#FFFFFF", 0.06) : rgba("#000000", 0.05)}` }}>
      {half(cur, "top")}
      {half(flipping ? prev : cur, "bottom")}
      {flipping && fp < 0.5 ? half(prev, "top", { transform: `perspective(700px) rotateX(${r1(-180 * fp)}deg)`, transformOrigin: "50% 100%", filter: `brightness(${r4(1 - 0.5 * fp)})` }) : null}
      {flipping && fp >= 0.5 ? half(cur, "bottom", { transform: `perspective(700px) rotateX(${r1(180 * (1 - fp))}deg)`, transformOrigin: "50% 0%" }) : null}
      <div style={{ position: "absolute", left: 0, right: 0, top: h / 2 - 1.5, height: 3, background: t.dark ? rgba("#000000", 0.55) : rgba("#000000", 0.12) }} />
    </div>
  );
}

/** Flip-clock m:ss digits counting down to 0:00, then the final word. */
function CountFlip({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps, width: W } = ctx;
  const t = toneOf(ctx);
  const plan = countPlan(ctx, true);
  const word = props.title?.trim() ?? "";
  const label = props.subtitle?.trim() ?? "";
  const seq = [...plan.nums, 0];
  const i = frame >= plan.finalAt ? seq.length - 1 : plan.idx(frame);
  const st = i === seq.length - 1 ? plan.finalAt : plan.startOf(i);
  const cur = seq[i]!;
  const prev = i > 0 ? seq[i - 1]! : cur;
  const ref = seq[0]!;
  const digits = (v: number) => {
    const m = Math.floor(v / 60);
    const s = v % 60;
    return [...String(Math.min(99, m)).padStart(2, "0"), ...String(s).padStart(2, "0")];
  };
  const dc = digits(cur);
  const dp = digits(prev);
  const flipLen = Math.max(4, Math.min(Math.round(0.4 * fps), Math.round(plan.per * 0.7)));
  const fp = i > 0 ? prog(frame, st, flipLen, (x) => x) : 1;
  const cw = 150;
  const ch = 210;
  const inT = prog(frame, 0, Math.round(0.45 * fps), ctx.ease);
  const done = frame >= plan.finalAt;
  const zeroCol = done ? t.negative : t.ink;
  const labelH = label ? 70 : 0;
  const wordIn = done && word ? springAt(frame, fps, plan.finalAt + 2, ctx.f.springs.soft, Math.round(0.6 * fps)) : 0;
  const wSize = word ? fitLine(word.toUpperCase(), W - 200, 64, 34, 1.1) : 0;
  void ref;
  return (
    <div style={{ ...fill, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 0 }}>
      {label ? <div style={{ height: labelH, fontFamily: FONT.text, fontSize: 36, letterSpacing: "0.16em", textTransform: "uppercase", color: "#FFFFFF", textShadow: SHADOW_TEXT, maxWidth: W - 60, ...oneLine, ...riseStyle(inT, 14) }}>{label}</div> : null}
      <div style={{ display: "flex", alignItems: "center", gap: 14, ...riseStyle(inT, 24) }}>
        {[0, 1].map((k) => (
          <FlipDigit key={k} t={t} w={cw} h={ch} cur={dc[k]!} prev={dp[k]!} fp={dc[k] === dp[k] ? 1 : fp} color={zeroCol} />
        ))}
        <div style={{ display: "flex", flexDirection: "column", gap: 34, padding: "0 10px" }}>
          {[0, 1].map((k) => (
            <div key={k} style={{ width: 20, height: 20, borderRadius: 10, background: "#FFFFFF", boxShadow: `0 2px 8px ${rgba("#000000", 0.5)}`, opacity: done ? 1 : 0.55 + 0.45 * (Math.floor(frame / Math.max(2, Math.round(fps / 2))) % 2) }} />
          ))}
        </div>
        {[2, 3].map((k) => (
          <FlipDigit key={k} t={t} w={cw} h={ch} cur={dc[k]!} prev={dp[k]!} fp={dc[k] === dp[k] ? 1 : fp} color={zeroCol} />
        ))}
      </div>
      {word ? (
        <div style={{ height: 120, display: "flex", alignItems: "flex-end" }}>
          <div style={{ padding: "14px 34px", borderRadius: 999, background: solidPill(ctx, word), color: onFill(solidPillColor(ctx, word)), fontFamily: FONT.display, fontSize: wSize, letterSpacing: "0.06em", whiteSpace: "nowrap", boxShadow: `0 16px 34px ${rgba("#000000", 0.4)}`, opacity: clamp01(wordIn * 2), transform: `scale(${r4(0.5 + 0.5 * Math.min(1.08, Math.max(0, wordIn)))})` }}>{word.toUpperCase()}</div>
        </div>
      ) : null}
    </div>
  );
}

function solidPillColor(ctx: GCtx, word: string): string {
  return moodColor(ctx, moodOf(word) ?? "PRI");
}
function solidPill(ctx: GCtx, word: string): string {
  const c = solidPillColor(ctx, word);
  return `linear-gradient(160deg, ${mix(c, "#FFFFFF", 0.25)} 0%, ${c} 60%, ${mix(c, "#000000", 0.15)} 100%)`;
}

/** "Ends in" — the time ticks down as the bar drains (accent → red), then the final word. */
function CountBar({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps, width: W } = ctx;
  const t = toneOf(ctx);
  const start = Math.max(1, Math.min(359999, Math.round(ctx.props.items[0]?.value ?? 10)));
  const word = props.title?.trim() ?? "";
  const label = props.subtitle?.trim() || "Ends in";
  const pad = 44;
  const t0 = Math.round(0.3 * fps);
  const end = Math.max(t0 + 6, buildBudget(ctx, word ? 0.9 : 0.5));
  const k = prog(frame, t0, end - t0, (x) => x);
  const left = start * (1 - k);
  const done = frame >= end;
  const shown = clockText(Math.ceil(left - 1e-6), start);
  const inT = prog(frame, 0, Math.round(0.45 * fps), ctx.ease);
  const warn = clamp01((k - 0.7) / 0.3);
  const barCol = mix(t.accent, t.negative, warn);
  const tSize = fitLine(clockText(start, start), 330, 84, 50);
  const wIn = done && word ? springAt(frame, fps, end, ctx.f.springs.punch, Math.round(0.5 * fps)) : 0;
  const wCol = word ? (moodOf(word) === "POS" ? t.positive : moodOf(word) === "NEG" ? t.negative : t.accent) : t.ink;
  const wSize = word ? fitLine(word, 360, 64, 40) : 0;
  const boxW = Math.max(textW(clockText(start, start), tSize), word ? textW(word, wSize) : 0) + 8;
  const lSize = fitLine(label, W - 2 * pad - 76 - 40 - boxW, 40, 30);
  const pulse = warn > 0 && !done ? 1 + 0.04 * Math.max(0, Math.sin((frame / fps) * Math.PI * 4)) : 1;
  return (
    <div style={{ ...fill, ...card(t, 40), ...riseStyle(inT, 24) }}>
      <div style={{ position: "absolute", left: pad, right: pad, top: pad - 4, height: 100, display: "flex", alignItems: "center", gap: 20 }}>
        <div style={{ width: 76, height: 76, borderRadius: 24, flex: "none", background: rgba(barCol, 0.16), boxShadow: `inset 0 0 0 2px ${rgba(barCol, 0.35)}`, display: "flex", alignItems: "center", justifyContent: "center", transform: `rotate(${r1(done ? 0 : Math.sin((frame / fps) * 18) * 6 * warn)}deg)` }}>
          <GIcon icon="ALARM" size={44} color={barCol} stroke={2.2} />
        </div>
        <div style={{ flex: 1, minWidth: 0, fontFamily: FONT.displayBold, fontSize: lSize, color: t.muted, letterSpacing: "0.02em", ...oneLine }}>{label}</div>
        <div style={{ position: "relative", flex: "none", width: boxW, height: 100, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
          <span style={{ fontFamily: FONT.display, fontSize: tSize, lineHeight: 1, letterSpacing: "-0.03em", color: warn > 0.5 ? t.negative : t.ink, fontVariantNumeric: "tabular-nums", opacity: word && done ? 1 - clamp01(wIn * 2) : 1, transform: `scale(${r4(pulse)})`, display: "inline-block" }}>{done ? clockText(0, start) : shown}</span>
          {word && done ? (
            <span style={{ position: "absolute", right: 0, top: 0, bottom: 0, display: "flex", alignItems: "center", fontFamily: FONT.display, fontSize: wSize, letterSpacing: "-0.01em", color: wCol, whiteSpace: "nowrap", opacity: clamp01(wIn * 2), transform: `scale(${r4(1.4 - 0.4 * Math.min(1.1, Math.max(0, wIn)))})`, transformOrigin: "100% 50%" }}>{word}</span>
          ) : null}
        </div>
      </div>
      <div style={{ position: "absolute", left: pad, right: pad, bottom: pad, height: 26, borderRadius: 13, background: t.fill2, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${r1((1 - k) * 100)}%`, borderRadius: 13, background: `linear-gradient(90deg, ${mix(barCol, "#FFFFFF", 0.2)}, ${barCol})`, boxShadow: `0 0 16px ${rgba(barCol, 0.5)}` }} />
      </div>
    </div>
  );
}

// ===================================================================== QUIZ

const QPAD = 48;

function quizContentH(ctx: GCtx): number {
  const n = Math.max(2, ctx.props.items.length);
  switch (ctx.variant) {
    case "RATING":
      return 130;
    case "SLIDER":
      return 250;
    case "THIS_THAT":
      return 330 + (ctx.props.items.some((it) => it.value != null) ? 100 : 0);
    default:
      return n * 104 + (n - 1) * 18;
  }
}

/** The quiz header: the question fitted into whatever the box leaves (≤ 3 lines), a small line. */
function QuizHead({ ctx, t, h, w }: { ctx: GCtx; t: Tone; h: number; w: number }) {
  const { props, frame, fps } = ctx;
  const title = props.title?.trim() ?? "";
  const sub = props.subtitle?.trim() ?? "";
  if (h <= 0 || (!title && !sub)) return null;
  const subH = sub ? 48 : 0;
  const f = title ? fitBlock(title, w, h - 32 - subH, { max: 54, min: 38, lh: 1.12, maxLines: 3, k: 0.98 }) : null;
  const a = prog(frame, 0, Math.round(0.5 * fps), ctx.ease);
  const b = prog(frame, 4, Math.round(0.5 * fps), ctx.ease);
  return (
    <div style={{ height: h, flex: "none", display: "flex", flexDirection: "column", justifyContent: "flex-start" }}>
      {f
        ? f.lines.map((l, i) => (
            <div key={i} style={{ fontFamily: FONT.displayBold, fontSize: f.size, lineHeight: 1.12, letterSpacing: "-0.018em", color: t.ink, whiteSpace: "nowrap", ...riseStyle(a, 14) }}>
              {l}
            </div>
          ))
        : null}
      {sub ? <div style={{ marginTop: 8, fontFamily: FONT.text, fontSize: 34, lineHeight: 1.2, color: t.muted, ...oneLine, ...riseStyle(b, 10) }}>{sub}</div> : null}
    </div>
  );
}

function Quiz({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const contentH = quizContentH(ctx);
  const headH = ctx.height - 2 * QPAD - contentH;
  const innerW = ctx.width - 2 * QPAD;
  const inT = prog(ctx.frame, 0, Math.round(0.4 * ctx.fps), ctx.ease);
  let body: ReactNode;
  switch (ctx.variant) {
    case "POLL":
      body = <QuizPoll ctx={ctx} t={t} w={innerW} />;
      break;
    case "RATING":
      body = <QuizRating ctx={ctx} t={t} w={innerW} />;
      break;
    case "SLIDER":
      body = <QuizSlider ctx={ctx} t={t} w={innerW} />;
      break;
    case "THIS_THAT":
      body = <QuizThisThat ctx={ctx} t={t} w={innerW} h={contentH} />;
      break;
    default:
      body = <QuizQuestion ctx={ctx} t={t} w={innerW} headH={headH} />;
  }
  return (
    <div style={{ ...fill, ...card(t, 44), opacity: clamp01(inT * 1.5), transform: `scale(${r4(0.97 + 0.03 * inT)})` }}>
      <div style={{ position: "absolute", inset: QPAD, display: "flex", flexDirection: "column" }}>
        <QuizHead ctx={ctx} t={t} h={headH} w={innerW} />
        <div style={{ position: "relative", height: contentH, flex: "none" }}>{body}</div>
      </div>
    </div>
  );
}

function quizShares(items: GraphicItem[]): number[] {
  const vals = items.map((it) => Math.max(0, it.value ?? 0));
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 100.5) return vals;
  return vals.map((v) => (sum > 0 ? (v / sum) * 100 : 0));
}

function pctText(v: number, final: number): string {
  const d = Math.abs(final - Math.round(final)) > 1e-6 ? 1 : 0;
  return `${v.toFixed(d)}%`;
}

/** A question with options; after a beat the correct one turns green ✓ (a wrong pick red ✕). */
function QuizQuestion({ ctx, t, w, headH }: { ctx: GCtx; t: Tone; w: number; headH: number }) {
  const { props, frame, fps } = ctx;
  const items = props.items;
  const n = items.length;
  const rowH = 104;
  const gap = 18;
  const seq = listSequence(n, ctx.anim, seqOpts(ctx, Math.round(0.3 * fps)));
  let correct = items.findIndex((it) => it.state === "DONE");
  if (correct < 0 && props.highlight != null && props.highlight < n) correct = props.highlight;
  const picked = props.highlight != null && props.highlight < n && props.highlight !== correct ? props.highlight : -1;
  const hasReveal = correct >= 0 || items.some((it) => it.state === "NO");
  const B = buildBudget(ctx);
  const revealAt = Math.max(seq.done + 2, Math.min(seq.done + Math.round(1.1 * fps), B - Math.round(0.45 * fps)));
  const rv = hasReveal ? prog(frame, revealAt, Math.round(0.35 * fps), ctx.ease) : 0;
  const em = emphasisAt(ctx, revealAt);
  const shares = quizShares(items);
  const hasValues = items.some((it) => it.value != null);
  const think = hasReveal ? prog(frame, seq.done, Math.max(1, revealAt - seq.done), (x) => x) : 0;
  return (
    <div style={fill}>
      {hasReveal && headH > 0 ? (
        <div style={{ position: "absolute", left: 0, right: 0, top: -22, height: 5, borderRadius: 3, background: t.fill2, overflow: "hidden", opacity: rv > 0.99 ? 0 : prog(frame, seq.done - 6, 6) }}>
          <div style={{ width: `${r1(think * 100)}%`, height: "100%", borderRadius: 3, background: t.accent }} />
        </div>
      ) : null}
      {items.map((it, i) => {
        const s = seqStyle(ctx, seq, 0, i);
        const isC = hasReveal && i === correct;
        const isW = hasReveal && (it.state === "NO" || i === picked);
        const col = isC ? t.positive : isW ? t.negative : null;
        const dim = hasReveal && !isC && !isW ? 1 - 0.5 * rv : 1;
        const shake = isW && frame >= revealAt ? Math.sin((frame - revealAt) * 2.2) * 9 * Math.max(0, 1 - (frame - revealAt) / 12) : 0;
        const sc = isC ? em.scale : 1;
        const share = shares[i] ?? 0;
        const barT = hasValues ? prog(frame, revealAt + 3, Math.round(0.7 * fps), ctx.ease) * (hasReveal ? 1 : 0) + (hasReveal ? 0 : prog(frame, seq.at(0, i) + 4, Math.round(0.7 * fps), ctx.ease)) : 0;
        const letter = String.fromCharCode(65 + i);
        const textSize = fitLine(it.text, w - 110 - 40 - (hasValues ? 130 : 70), 40, 32);
        const valFinal = share;
        const shownV = hasValues && it.value != null ? pctText(valFinal * barT, valFinal) : "";
        const style = css(s);
        return (
          <div key={i} style={{ position: "absolute", left: 0, right: 0, top: i * (rowH + gap), height: rowH, ...style, opacity: (style.opacity as number) * dim, transform: `${style.transform ?? ""} translateX(${r1(shake)}px) scale(${r4(sc)})`.trim() }}>
            <div style={{ ...fill, borderRadius: 26, background: t.fill, overflow: "hidden", boxShadow: col ? `inset 0 0 0 ${r1(3 * rv)}px ${rgba(col, 0.85)}${isC && em.on > 0.01 ? `, ${glowShadow(col, em.on * rv, 0.7)}` : ""}` : `inset 0 0 0 1.5px ${t.line}` }}>
              {hasValues && it.value != null ? <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${r1(share * barT)}%`, background: col ? rgba(col, 0.22) : rgba(t.ink, t.dark ? 0.1 : 0.07) }} /> : null}
              {col ? <div style={{ ...fill, background: rgba(col, 0.12 * rv) }} /> : null}
            </div>
            <div style={{ position: "absolute", left: 22, top: (rowH - 62) / 2, width: 62, height: 62, borderRadius: 31, background: t.fill2, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {col && rv > 0 ? <div style={{ ...fill, borderRadius: 31, background: col, opacity: rv }} /> : null}
              {col && rv > 0.5 ? (
                <div style={{ position: "relative" }}>
                  <MarkPath kind={isC ? "CHECK" : "CROSS"} size={52} color={onFill(col)} draw={clamp01((rv - 0.5) * 2)} width={12} />
                </div>
              ) : (
                <span style={{ position: "relative", fontFamily: FONT.display, fontSize: 34, color: t.ink, opacity: 1 - (col ? clamp01(rv * 2) : 0) }}>{letter}</span>
              )}
            </div>
            <div style={{ position: "absolute", left: 108, right: hasValues ? 140 : 30, top: 0, bottom: 0, display: "flex", alignItems: "center", fontFamily: FONT.displayBold, fontSize: textSize, color: t.ink, letterSpacing: "-0.01em" }}>
              <span style={oneLine}>{it.text}</span>
            </div>
            {shownV ? <div style={{ position: "absolute", right: 28, top: 0, bottom: 0, display: "flex", alignItems: "center", fontFamily: FONT.display, fontSize: 38, color: col ?? t.ink, fontVariantNumeric: "tabular-nums", opacity: clamp01(barT * 3) }}>{shownV}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

/** Poll results: each option's bar grows with its % counting; the leader takes the accent. */
function QuizPoll({ ctx, t, w }: { ctx: GCtx; t: Tone; w: number }) {
  const { props, frame, fps } = ctx;
  const items = props.items;
  const rowH = 104;
  const gap = 18;
  const seq = listSequence(items.length, ctx.anim, seqOpts(ctx, Math.round(0.3 * fps)));
  const shares = quizShares(items);
  let lead = props.highlight != null && props.highlight < items.length ? props.highlight : -1;
  if (lead < 0 && shares.length) lead = shares.indexOf(Math.max(...shares));
  const em = emphasisAt(ctx, seq.done);
  return (
    <div style={fill}>
      {items.map((it, i) => {
        const s = css(seqStyle(ctx, seq, 0, i));
        const start = seq.at(0, i) + 3;
        const share = shares[i] ?? 0;
        const grow = prog(frame, start, Math.round(0.8 * fps / ctx.anim.speed), ctx.ease);
        const v = counted(ctx, start, share, 0, 1.4);
        const isL = i === lead;
        const col = isL ? t.accent : t.ink;
        const voted = it.state === "DONE";
        const textSize = fitLine(it.text, w - 200 - (voted ? 56 : 0), 40, 32);
        return (
          <div key={i} style={{ position: "absolute", left: 0, right: 0, top: i * (rowH + gap), height: rowH, ...s, transform: `${s.transform ?? ""} scale(${r4(isL ? em.scale : 1)})`.trim() }}>
            <div style={{ ...fill, borderRadius: 26, background: t.fill, overflow: "hidden", boxShadow: isL ? `inset 0 0 0 2.5px ${rgba(t.accent, 0.7)}${em.on > 0.01 ? `, ${glowShadow(t.accent, em.on, 0.6)}` : ""}` : `inset 0 0 0 1.5px ${t.line}` }}>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${r1(share * grow)}%`, borderRadius: 26, background: isL ? `linear-gradient(90deg, ${rgba(t.accent, 0.42)}, ${rgba(t.accent, 0.26)})` : rgba(t.ink, t.dark ? 0.12 : 0.08) }} />
            </div>
            <div style={{ position: "absolute", left: 30, right: 170, top: 0, bottom: 0, display: "flex", alignItems: "center", gap: 14 }}>
              <span style={{ fontFamily: FONT.displayBold, fontSize: textSize, color: t.ink, letterSpacing: "-0.01em", ...oneLine }}>{it.text}</span>
              {voted ? (
                <div style={{ width: 42, height: 42, borderRadius: 21, flex: "none", background: t.accent, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <MarkPath kind="CHECK" size={38} color={onFill(t.accent)} draw={1} width={13} />
                </div>
              ) : null}
            </div>
            <div style={{ position: "absolute", right: 30, top: 0, bottom: 0, display: "flex", alignItems: "center", fontFamily: FONT.display, fontSize: 42, color: col, fontVariantNumeric: "tabular-nums" }}>{pctText(v, share)}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Star rating: the score counts up and the stars fill one after another (fractions too). */
function QuizRating({ ctx, t, w }: { ctx: GCtx; t: Tone; w: number }) {
  const { props, p, frame, fps } = ctx;
  const nStars = props.range ? Math.max(3, Math.min(10, Math.round(props.range.max - props.range.min))) : 5;
  const value = Math.max(0, Math.min(nStars, props.items[0]?.value ?? 4.5));
  const t0 = Math.round(0.3 * fps);
  const B = buildBudget(ctx);
  const len = Math.max(6, Math.min(Math.round(1.3 * fps / ctx.anim.speed), B - t0));
  const v = prog(frame, t0, len, ctx.ease) * value;
  const valueW = 210;
  const starGap = 12;
  const starS = Math.min(110, (w - valueW - 20 - starGap * (nStars - 1)) / nStars);
  const starCol = t.dark ? p.primary : t.accent;
  const dec = Math.abs(value - Math.round(value)) > 1e-6 ? 1 : 0;
  const inT = prog(frame, 4, Math.round(0.45 * fps), ctx.ease);
  const em = emphasisAt(ctx, t0 + len);
  const d = starD(50, 52, 47, 20);
  return (
    <div style={{ ...fill, display: "flex", alignItems: "center", gap: 20 }}>
      <div style={{ width: valueW, flex: "none", display: "flex", alignItems: "baseline", ...riseStyle(inT, 14) }}>
        <span style={{ fontFamily: FONT.display, fontSize: 104, lineHeight: 1, letterSpacing: "-0.04em", color: t.ink, fontVariantNumeric: "tabular-nums", display: "inline-block", transform: `scale(${r4(em.scale)})`, transformOrigin: "0% 80%" }}>{v.toFixed(dec)}</span>
        <span style={{ marginLeft: 6, fontFamily: FONT.displayBold, fontSize: 34, color: t.muted }}>/{nStars}</span>
      </div>
      <div style={{ display: "flex", gap: starGap }}>
        {Array.from({ length: nStars }, (_, k) => {
          const f = clamp01(v - k);
          const full = f >= 0.999 && value - k >= 1;
          const popAt = t0 + Math.round(len * ((k + 1) / Math.max(1, value)));
          const pop = full && frame >= popAt ? 1 + 0.18 * Math.max(0, Math.sin(clamp01((frame - popAt) / 7) * Math.PI)) : 1;
          const si = prog(frame, 2 + k * 2, Math.round(0.4 * fps), ctx.ease);
          return (
            <div key={k} style={{ position: "relative", width: starS, height: starS, flex: "none", opacity: si, transform: `scale(${r4((0.6 + 0.4 * si) * pop)})` }}>
              <svg width={starS} height={starS} viewBox="0 0 100 100" style={{ position: "absolute", inset: 0 }}>
                <path d={d} fill={t.fill2} stroke={t.dark ? rgba("#FFFFFF", 0.12) : rgba("#000000", 0.06)} strokeWidth={2} strokeLinejoin="round" />
              </svg>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${r1(f * 100)}%`, overflow: "hidden" }}>
                <svg width={starS} height={starS} viewBox="0 0 100 100" style={{ position: "absolute", left: 0, top: 0 }}>
                  <path d={d} fill={starCol} stroke={mix(starCol, "#000000", 0.15)} strokeWidth={2} strokeLinejoin="round" />
                  <path d={starD(50, 52, 30, 13)} fill={rgba("#FFFFFF", 0.18)} />
                </svg>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** "Rate this 1–10": the handle (a face that changes with the score) slides to the value. */
function QuizSlider({ ctx, t, w }: { ctx: GCtx; t: Tone; w: number }) {
  const { props, frame, fps } = ctx;
  const range = props.range ?? { min: 1, max: 10 };
  const lo = range.min;
  const hi = range.max > range.min ? range.max : range.min + 10;
  const value = Math.max(lo, Math.min(hi, props.items[0]?.value ?? 8));
  const t0 = Math.round(0.35 * fps);
  const B = buildBudget(ctx);
  const len = Math.max(6, Math.min(Math.round(1.2 * fps / ctx.anim.speed), B - t0 - Math.round(0.2 * fps)));
  const sp = springAt(frame, fps, t0, ctx.f.springs.settle, len);
  const k = frame < t0 ? 0 : Math.max(0, Math.min(1.04, sp));
  const cur = lo + (value - lo) * Math.min(1, k);
  const frac = ((lo + (value - lo) * k) - lo) / (hi - lo);
  const handleS = 104;
  const trackY = 156;
  const trackH = 26;
  const x = handleS / 2 + frac * (w - handleS);
  const ratio = (cur - lo) / (hi - lo);
  const face: GraphicIcon = props.items[0]?.icon ?? (ratio < 0.3 ? "FACE_SAD" : ratio < 0.55 ? "FACE_THINK" : ratio < 0.8 ? "FACE_SMILE" : "FACE_LOVE");
  const dec = Math.abs(value - Math.round(value)) > 1e-6 ? 1 : 0;
  const inT = prog(frame, 4, Math.round(0.45 * fps), ctx.ease);
  const landAt = t0 + len;
  const em = emphasisAt(ctx, landAt);
  const steps = hi - lo <= 10 && Number.isInteger(hi - lo) ? hi - lo : 0;
  const bubbleIn = prog(frame, t0 - 4, Math.round(0.3 * fps), ctx.ease);
  return (
    <div style={{ ...fill, ...riseStyle(inT, 16) }}>
      <div style={{ position: "absolute", left: handleS / 2 - 13, right: handleS / 2 - 13, top: trackY - trackH / 2, height: trackH, borderRadius: trackH / 2, background: t.fill2 }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: r1(x - handleS / 2 + 13), borderRadius: trackH / 2, background: `linear-gradient(90deg, ${t.accent2}, ${t.accent})`, boxShadow: `0 0 18px ${rgba(t.accent, 0.35)}` }} />
      </div>
      {steps
        ? Array.from({ length: steps + 1 }, (_, i) => {
            const sx = handleS / 2 + (i / steps) * (w - handleS);
            return <div key={i} style={{ position: "absolute", left: sx - 3, top: trackY + trackH / 2 + 14, width: 6, height: 6, borderRadius: 3, background: t.faint }} />;
          })
        : null}
      <div style={{ position: "absolute", left: x - 62, top: trackY - handleS / 2 - 104, width: 124, height: 84, opacity: bubbleIn, transform: `scale(${r4((0.6 + 0.4 * bubbleIn) * em.scale)})`, transformOrigin: "50% 100%" }}>
        <div style={{ ...fill, borderRadius: 26, background: t.solid, boxShadow: `0 12px 26px ${rgba("#000000", 0.3)}${em.on > 0.01 ? `, ${glowShadow(t.solid, em.on, 0.6)}` : ""}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, fontSize: 52, color: t.onSolid, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>{cur.toFixed(dec)}</div>
        <div style={{ position: "absolute", left: 62 - 12, bottom: -10, width: 24, height: 24, background: t.solid, transform: "rotate(45deg)", borderRadius: 4 }} />
      </div>
      <div style={{ position: "absolute", left: x - handleS / 2, top: trackY - handleS / 2, width: handleS, height: handleS, borderRadius: "50%", background: "linear-gradient(160deg, #FFFFFF 0%, #ECECF1 100%)", boxShadow: `0 12px 26px ${rgba("#000000", 0.35)}, inset 0 0 0 1.5px ${rgba("#000000", 0.06)}`, display: "flex", alignItems: "center", justifyContent: "center", transform: `rotate(${r1((k < 1 ? (1 - k) * -40 : 0) + (frame >= landAt ? Math.sin((frame - landAt) * 0.9) * 8 * Math.max(0, 1 - (frame - landAt) / 14) : 0))}deg)` }}>
        <GIcon icon={face} size={64} color={mix(t.dark ? ctx.p.primary : t.accent, "#000000", 0.25)} stroke={2.3} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: trackY + 50, display: "flex", justifyContent: "space-between", fontFamily: FONT.displayBold, fontSize: 32, color: t.muted }}>
        <span>{fmtNum(lo)}</span>
        <span>{fmtNum(hi)}</span>
      </div>
    </div>
  );
}

function fmtNum(v: number): string {
  return Math.abs(v - Math.round(v)) > 1e-6 ? v.toFixed(1) : String(Math.round(v));
}

/** This or that: two option cards with an OR chip; the vote split bar grows and the winner lights up. */
function QuizThisThat({ ctx, t, w, h }: { ctx: GCtx; t: Tone; w: number; h: number }) {
  const { props, frame, fps } = ctx;
  const items = [props.items[0] ?? { text: "This", value: null, icon: null, color: "AUTO" as const }, props.items[1] ?? { text: "That", value: null, icon: null, color: "AUTO" as const }];
  const hasValues = items.some((it) => it.value != null);
  const va = Math.max(0, items[0]!.value ?? 0);
  const vb = Math.max(0, items[1]!.value ?? 0);
  const sum = va + vb;
  const shareA = sum > 0 ? (va / sum) * 100 : 50;
  const gap = 28;
  const cw = (w - gap) / 2;
  const ch = 330;
  const seq = listSequence(2, ctx.anim, seqOpts(ctx, Math.round(0.25 * fps)));
  const B = buildBudget(ctx);
  const voteAt = Math.min(seq.done + Math.round(0.35 * fps), B - Math.round(0.9 * fps));
  const grow = hasValues ? prog(frame, voteAt, Math.round(0.9 * fps / ctx.anim.speed), ctx.ease) : 0;
  const winner = props.highlight != null && props.highlight < 2 ? props.highlight : hasValues ? (va >= vb ? 0 : 1) : -1;
  const decided = hasValues ? clamp01((frame - (voteAt + Math.round(0.9 * fps / ctx.anim.speed))) / 8) : props.highlight != null ? prog(frame, voteAt, 8) : 0;
  const em = emphasisAt(ctx, voteAt + Math.round(0.9 * fps / ctx.anim.speed));
  const colA = colorOf(ctx, items[0]!.color, 0);
  const colB = colorOf(ctx, items[1]!.color, 1);
  const cols = [t.dark ? colA : mix(colA, "#000000", 0.2), t.dark ? colB : mix(colB, "#000000", 0.2)];
  const chip = springAt(frame, fps, seq.at(0, 1) + 4, ctx.f.springs.soft, Math.round(0.6 * fps));
  return (
    <div style={fill}>
      {items.map((it, i) => {
        const s = css(seqStyle(ctx, seq, 0, i));
        const c = cols[i]!;
        const isW = i === winner;
        const dim = winner >= 0 && !isW ? 1 - 0.4 * decided : 1;
        const tf = fitBlock(it.text, cw - 56, 112, { max: 46, min: 34, lh: 1.12, maxLines: 2 });
        const icon = it.icon;
        return (
          <div key={i} style={{ position: "absolute", left: i * (cw + gap), top: 0, width: cw, height: ch, ...s, opacity: (s.opacity as number) * dim, transform: `${s.transform ?? ""} scale(${r4(isW ? em.scale : 1)})`.trim() }}>
            <div style={{ ...fill, borderRadius: 32, background: `linear-gradient(170deg, ${rgba(c, t.dark ? 0.2 : 0.14)} 0%, ${rgba(c, 0.05)} 100%)`, boxShadow: isW && decided > 0 ? `inset 0 0 0 ${r1(3 * decided)}px ${rgba(c, 0.9)}${em.on > 0.01 ? `, ${glowShadow(c, em.on * decided, 0.8)}` : ""}` : `inset 0 0 0 1.5px ${rgba(c, 0.3)}` }} />
            <div style={{ position: "absolute", left: 0, right: 0, top: 36, display: "flex", justifyContent: "center" }}>
              <div style={{ width: 112, height: 112, borderRadius: 56, background: `linear-gradient(160deg, ${mix(c, "#FFFFFF", 0.25)}, ${c} 60%, ${mix(c, "#000000", 0.18)})`, boxShadow: `0 12px 24px ${rgba("#000000", 0.25)}, inset 0 2px 0 ${rgba("#FFFFFF", 0.3)}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {icon ? <GIcon icon={icon} size={60} color={onFill(c)} stroke={2.2} /> : <span style={{ fontFamily: FONT.display, fontSize: 56, color: onFill(c) }}>{i === 0 ? "A" : "B"}</span>}
              </div>
            </div>
            <div style={{ position: "absolute", left: 28, right: 28, top: 170, height: 112, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center" }}>
              {tf.lines.map((l, li) => (
                <div key={li} style={{ fontFamily: FONT.displayBold, fontSize: tf.size, lineHeight: 1.12, color: t.ink, whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>{l}</div>
              ))}
            </div>
            {isW && decided > 0 ? (
              <div style={{ position: "absolute", right: -10, top: -10, width: 64, height: 64, borderRadius: 32, background: c, boxShadow: `0 8px 18px ${rgba("#000000", 0.35)}`, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${r4(Math.min(1, decided * 1.2))})` }}>
                <MarkPath kind="CHECK" size={54} color={onFill(c)} draw={decided} width={13} />
              </div>
            ) : null}
          </div>
        );
      })}
      <div style={{ position: "absolute", left: w / 2 - 50, top: ch / 2 - 50, width: 100, height: 100, borderRadius: 50, background: t.dark ? "#0E0E14" : "#FFFFFF", boxShadow: `0 10px 24px ${rgba("#000000", 0.35)}, inset 0 0 0 2px ${t.line}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, fontSize: 38, color: t.ink, letterSpacing: "0.02em", opacity: clamp01(chip * 1.5), transform: `scale(${r4(Math.max(0, 0.4 + 0.6 * chip))})` }}>OR</div>
      {hasValues ? (
        <div style={{ position: "absolute", left: 0, right: 0, top: ch + 36, height: h - ch - 36, opacity: prog(frame, voteAt - 4, 6) }}>
          <div style={{ position: "relative", height: 60, borderRadius: 30, background: t.fill2, overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, bottom: 0, right: "50%", width: `${r1(shareA * grow)}%`, transformOrigin: "100% 50%", background: `linear-gradient(90deg, ${cols[0]}, ${mix(cols[0]!, "#FFFFFF", 0.15)})`, borderRadius: "30px 0 0 30px", marginRight: `${r1(-(shareA - 50) * grow)}%` }} />
            <div style={{ position: "absolute", top: 0, bottom: 0, left: `${r1(50 + (shareA - 50) * grow)}%`, width: `${r1((100 - shareA) * grow)}%`, background: `linear-gradient(90deg, ${mix(cols[1]!, "#FFFFFF", 0.15)}, ${cols[1]})`, borderRadius: "0 30px 30px 0" }} />
            <div style={{ position: "absolute", left: 24, top: 0, bottom: 0, display: "flex", alignItems: "center", fontFamily: FONT.display, fontSize: 36, color: onFill(cols[0]!), fontVariantNumeric: "tabular-nums", opacity: clamp01(grow * 3) }}>{pctText(counted(ctx, voteAt, shareA, 0, 1.4), shareA)}</div>
            <div style={{ position: "absolute", right: 24, top: 0, bottom: 0, display: "flex", alignItems: "center", fontFamily: FONT.display, fontSize: 36, color: onFill(cols[1]!), fontVariantNumeric: "tabular-nums", opacity: clamp01(grow * 3) }}>{pctText(counted(ctx, voteAt, 100 - shareA, 0, 1.4), 100 - shareA)}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ===================================================================== SCREEN_FX

function ScreenFx({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "FILM_BURN":
      return <FxFilmBurn ctx={ctx} />;
    case "LIGHT_LEAK":
      return <FxLightLeak ctx={ctx} />;
    case "SPEED_LINES":
      return <FxSpeedLines ctx={ctx} />;
    case "VHS":
      return <FxVhs ctx={ctx} />;
    case "SPOTLIGHT":
      return <FxSpotlight ctx={ctx} />;
    case "ZOOM_PUNCH":
      return <FxZoomPunch ctx={ctx} />;
    case "SPLIT":
      return <FxSplit ctx={ctx} />;
    default:
      return <FxGlitch ctx={ctx} />;
  }
}

/** The optional word of a screen effect (upper area, clear of the face and the captions). */
function FxWord({ ctx, y, kind = "PUNCH" }: { ctx: GCtx; y: number; kind?: "PUNCH" | "CINE" | "GLITCH" }) {
  const { props, p, frame, fps, width: W } = ctx;
  const word = props.title?.trim();
  if (!word) return null;
  const at = Math.round(0.1 * fps);
  if (kind === "CINE") {
    const tIn = prog(frame, at, Math.round(0.8 * fps), ctx.ease);
    const size = fitLine(word, W - 160, 96, 48, 0.9);
    return (
      <div style={{ position: "absolute", left: 60, right: 60, top: y - size * 0.6, display: "flex", justifyContent: "center", opacity: tIn, transform: `translateY(${r1((1 - tIn) * 18)}px)`, letterSpacing: `${r4(0.08 * (1 - tIn))}em` }}>
        <span style={{ fontFamily: FONT.serif, fontSize: size, lineHeight: 1.1, color: "#FFFFFF", whiteSpace: "nowrap", textShadow: `0 0 30px ${rgba(p.primary, 0.35)}, ${SHADOW_TEXT}` }}>{word}</span>
      </div>
    );
  }
  const up = word.toUpperCase();
  const size = fitLine(up, W - 140, 132, 52, 1.04);
  const s = springAt(frame, fps, at, ctx.f.springs.punch, Math.round(0.5 * fps));
  const o = prog(frame, at, 3);
  if (kind === "GLITCH") {
    const b = Math.floor(frame / 2);
    const g = frame < at + 0.4 * fps ? 1 : hash01(Math.floor(frame / 3) * 1.7) > 0.75 ? 0.8 : 0.08;
    const dx = (hash01(b * 3.1) - 0.5) * 26 * g + 3;
    const cut = hash01(b * 5.3);
    const face: CSSProperties = { fontFamily: FONT.display, fontSize: size, lineHeight: 1, letterSpacing: "0.01em", whiteSpace: "nowrap" };
    return (
      <div style={{ position: "absolute", left: 0, right: 0, top: y - size / 2, height: size, opacity: o }}>
        <div style={{ ...center, transform: `translateX(${r1(-dx)}px)`, opacity: 0.85 }}>
          <span style={{ ...face, color: "#FF2A6D" }}>{up}</span>
        </div>
        <div style={{ ...center, transform: `translateX(${r1(dx)}px)`, opacity: 0.85 }}>
          <span style={{ ...face, color: "#22E4FF" }}>{up}</span>
        </div>
        <div style={{ ...center, clipPath: g > 0.5 ? `inset(${r1(cut * 60)}% 0 ${r1((1 - cut) * 25)}% 0)` : undefined }}>
          <span style={{ ...face, color: "#FFFFFF", textShadow: `0 6px 24px ${rgba("#000000", 0.5)}` }}>{up}</span>
        </div>
        {g > 0.5 ? (
          <div style={{ ...center, clipPath: `inset(${r1(cut * 60)}% 0 ${r1(100 - cut * 60 - 18)}% 0)`, transform: `translateX(${r1(dx * 2.2)}px)` }}>
            <span style={{ ...face, color: "#FFFFFF" }}>{up}</span>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: y - size / 2, height: size, display: "flex", justifyContent: "center", opacity: o, transform: `scale(${r4(1.5 - 0.5 * Math.min(1.1, Math.max(0, s)))}) rotate(-3deg)` }}>
      <StrokeText lines={[up]} size={size} lh={1} width={W - 140} color="#FFFFFF" stroke={NOIR} strokeW={Math.round(size * 0.1)} shadow={Math.round(size * 0.06)} k={1.04} />
    </div>
  );
}

const SCANLINES = `repeating-linear-gradient(0deg, ${rgba("#000000", 0.18)} 0px, ${rgba("#000000", 0.18)} 2px, transparent 2px, transparent 5px)`;

/** Glitch: RGB-split bars and pixel blocks burst in (and spike again), over scanlines. */
function FxGlitch({ ctx }: { ctx: GCtx }) {
  const { frame, fps, width: W, height: H } = ctx;
  const bucket = Math.floor(frame / 2);
  const intro = frame < Math.round(0.45 * fps);
  const spike = hash01(Math.floor(frame / 3) * 1.7 + 0.3);
  const g = intro ? 1 - 0.4 * (frame / Math.max(1, 0.45 * fps)) : spike > 0.74 ? 0.55 + 0.45 * hash01(bucket * 2.9) : 0.1;
  const nBars = Math.round(3 + 7 * g);
  const bars = Array.from({ length: nBars }, (_, i) => {
    const h1 = hash01(bucket * 13.1 + i * 7.7);
    const h2 = hash01(bucket * 3.3 + i * 11.9);
    const h3 = hash01(bucket * 5.9 + i * 2.3);
    // Low intensity keeps bars in the top/bottom thirds (the centre stays clear).
    const band = g > 0.5 ? h1 : h1 < 0.5 ? h1 * 0.6 : 0.7 + (h1 - 0.5) * 0.6;
    const y = band * H;
    const bh = 4 + h2 * (g > 0.5 ? 60 : 22);
    const x = h3 < 0.5 ? 0 : h3 * W * 0.5;
    const bw = W * (0.35 + 0.65 * hash01(bucket * 7.1 + i));
    const col = i % 3 === 0 ? "#22E4FF" : i % 3 === 1 ? "#FF2A6D" : "#FFFFFF";
    return { y, bh, x, bw, col, a: (0.18 + 0.32 * h2) * (0.4 + 0.6 * g) };
  });
  const blocks = g > 0.4 ? Array.from({ length: 8 }, (_, i) => ({ x: hash01(bucket * 9.7 + i * 3.1) * W, y: hash01(bucket * 4.1 + i * 8.3) * H, s: 18 + hash01(bucket + i * 5.5) * 54, c: i % 2 ? "#22E4FF" : "#FF2A6D" })) : [];
  const shift = (hash01(bucket * 1.9) - 0.5) * 18 * g;
  return (
    <div style={fill}>
      <div style={{ ...fill, backgroundImage: SCANLINES, opacity: 0.35 + 0.4 * g }} />
      <div style={{ ...fill, background: `linear-gradient(90deg, ${rgba("#FF2A6D", 0.32 * g)} 0%, transparent 7%, transparent 93%, ${rgba("#22E4FF", 0.32 * g)} 100%)`, transform: `translateX(${r1(shift)}px)` }} />
      {bars.map((b, i) => (
        <div key={i} style={{ position: "absolute", left: b.x, top: b.y, width: b.bw, height: b.bh, background: rgba(b.col, b.a), boxShadow: `${r1(12 * g)}px 0 0 ${rgba(b.col === "#22E4FF" ? "#FF2A6D" : "#22E4FF", b.a * 0.7)}` }} />
      ))}
      {blocks.map((b, i) => (
        <div key={`b${i}`} style={{ position: "absolute", left: b.x, top: b.y, width: b.s * 1.6, height: b.s * 0.5, background: rgba(b.c, 0.4 * g) }} />
      ))}
      {g > 0.5 ? <div style={{ ...fill, background: rgba("#FFFFFF", 0.06 * g) }} /> : null}
      <FxWord ctx={ctx} y={H * 0.17} kind="GLITCH" />
    </div>
  );
}

/** Film burn: a warm, flickering burn breathes in from the left edge and a corner. */
function FxFilmBurn({ ctx }: { ctx: GCtx }) {
  const { p, frame, fps, D, height: H } = ctx;
  const u = clamp01(frame / Math.max(1, D));
  const env = Math.sin(Math.PI * Math.min(1, 0.15 + u * 1.1)) * prog(frame, 0, Math.round(0.35 * fps), EASE_OUT);
  const fl = 0.82 + 0.18 * hash01(Math.floor(frame / 2) * 3.7);
  const warm = mix("#FF7A1A", p.primary, 0.2);
  const hot = "#FFE9C2";
  const red = "#E0301E";
  const x = -18 + 26 * Math.sin(u * Math.PI * 0.9);
  const y = 42 + 10 * Math.sin(u * 5);
  const k = env * fl;
  return (
    <div style={fill}>
      <div style={{ ...fill, background: `radial-gradient(ellipse 70% 55% at ${r1(x)}% ${r1(y)}%, ${rgba(warm, 0.9 * k)} 0%, ${rgba(warm, 0.55 * k)} 30%, ${rgba(red, 0.25 * k)} 52%, transparent 72%)` }} />
      <div style={{ ...fill, background: `radial-gradient(ellipse 30% 26% at ${r1(x - 4)}% ${r1(y + 2)}%, ${rgba(hot, 0.95 * k)} 0%, ${rgba(hot, 0.4 * k)} 45%, transparent 80%)` }} />
      <div style={{ ...fill, background: `radial-gradient(ellipse 55% 30% at 108% ${r1(6 + 8 * u)}%, ${rgba(warm, 0.75 * k * clamp01(u * 2))} 0%, ${rgba(red, 0.3 * k * clamp01(u * 2))} 40%, transparent 70%)` }} />
      <div style={{ ...fill, background: `radial-gradient(ellipse 60% 22% at 20% 104%, ${rgba(red, 0.45 * k)} 0%, transparent 70%)` }} />
      <div style={{ ...fill, background: rgba(warm, 0.08 * k) }} />
      <FxWord ctx={ctx} y={H * 0.18} kind="CINE" />
    </div>
  );
}

/** Light leaks: soft warm blooms drift across the edges, a streak sweeps through. */
function FxLightLeak({ ctx }: { ctx: GCtx }) {
  const { p, frame, fps, D, height: H } = ctx;
  const u = clamp01(frame / Math.max(1, D));
  const inT = prog(frame, 0, Math.round(0.5 * fps), EASE_OUT);
  const amber = mix("#FFB15C", p.primary, 0.25);
  const rose = mix("#FF6B8B", p.secondary, 0.25);
  const ax = -10 + 50 * u;
  const bx = 110 - 40 * u;
  const sweep = -40 + 180 * u;
  return (
    <div style={{ ...fill, opacity: inT }}>
      <div style={{ ...fill, background: `radial-gradient(ellipse 60% 34% at ${r1(ax)}% 8%, ${rgba(amber, 0.6)} 0%, ${rgba(amber, 0.22)} 40%, transparent 72%)` }} />
      <div style={{ ...fill, background: `radial-gradient(ellipse 50% 32% at ${r1(bx)}% 92%, ${rgba(rose, 0.5)} 0%, ${rgba(rose, 0.18)} 42%, transparent 72%)` }} />
      <div style={{ ...fill, background: `radial-gradient(ellipse 34% 50% at 104% ${r1(30 + 20 * u)}%, ${rgba(amber, 0.45)} 0%, transparent 70%)` }} />
      <div style={{ ...fill, background: `linear-gradient(115deg, transparent ${r1(sweep - 18)}%, ${rgba("#FFF1DC", 0.2)} ${r1(sweep)}%, transparent ${r1(sweep + 18)}%)` }} />
      <FxWord ctx={ctx} y={H * 0.18} kind="CINE" />
    </div>
  );
}

/** Anime speed lines: white wedges rush in from the edges toward a clear centre, re-rolling. */
function FxSpeedLines({ ctx }: { ctx: GCtx }) {
  const { frame, fps, width: W, height: H } = ctx;
  const cx = W / 2;
  const cy = H * 0.45;
  const Rout = Math.hypot(W, H) * 0.62;
  const inT = prog(frame, 0, Math.round(0.25 * fps), EASE_OUT);
  const b = Math.floor(frame / 2);
  const N = 40;
  const rx = W * 0.4;
  const ry = H * 0.3;
  const polys = Array.from({ length: N }, (_, i) => {
    const h1 = hash01(b * 7.3 + i * 3.9);
    const h2 = hash01(b * 2.1 + i * 5.7);
    const a = (i / N) * Math.PI * 2 + (h1 - 0.5) * 0.12;
    const k = (1 + 0.5 * h2) * (1 + (1 - inT) * 1.2);
    const ix = cx + Math.cos(a) * rx * k;
    const iy = cy + Math.sin(a) * ry * k;
    const half = (Math.PI / N) * (0.12 + 0.3 * h1);
    const ox1 = cx + Math.cos(a - half) * Rout;
    const oy1 = cy + Math.sin(a - half) * Rout;
    const ox2 = cx + Math.cos(a + half) * Rout;
    const oy2 = cy + Math.sin(a + half) * Rout;
    return { pts: `${r1(ix)},${r1(iy)} ${r1(ox1)},${r1(oy1)} ${r1(ox2)},${r1(oy2)}`, a: 0.45 + 0.45 * h2 };
  });
  return (
    <div style={fill}>
      <div style={{ ...fill, background: `radial-gradient(ellipse 50% 40% at 50% 45%, transparent 55%, ${rgba("#000000", 0.28 * inT)} 100%)` }} />
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0 }}>
        {polys.map((q, i) => (
          <polygon key={i} points={q.pts} fill={i % 7 === 3 ? rgba(ctx.p.primary, q.a * inT) : rgba("#FFFFFF", q.a * inT)} />
        ))}
      </svg>
      <FxWord ctx={ctx} y={H * 0.15} />
    </div>
  );
}

/** A drawn play triangle (no glyph — fonts differ between hosts). */
function PlayTri({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" style={{ display: "block" }}>
      <path d="M1.5 1 L9 5 L1.5 9 Z" fill={color} />
    </svg>
  );
}

/** VHS: scanlines, a rolling tracking band, REC + PLAY on-screen display and a running counter. */
function FxVhs({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps, width: W, height: H } = ctx;
  const sec = frame / fps;
  const inT = prog(frame, 0, Math.round(0.3 * fps), EASE_OUT);
  const blink = Math.floor(sec * 2) % 2 === 0;
  const meta = props.meta?.trim() || "";
  const mode = (props.title?.trim() || "PLAY").toUpperCase();
  const jitter = hash01(Math.floor(frame / 3) * 4.3) > 0.85 ? (hash01(frame * 1.3) - 0.5) * 6 : 0;
  const bandY = ((sec * 0.35) % 1.3) * H * 1.1 - H * 0.15;
  const count = Math.floor(sec);
  const counter = `SP ${Math.floor(count / 3600)}:${String(Math.floor((count % 3600) / 60)).padStart(2, "0")}:${String(count % 60).padStart(2, "0")}`;
  const osd: CSSProperties = { fontFamily: FONT.text, fontSize: 44, letterSpacing: "0.1em", color: "#FFFFFF", textShadow: `-2px 0 ${rgba("#FF2A6D", 0.6)}, 2px 0 ${rgba("#22E4FF", 0.6)}, 0 3px 6px ${rgba("#000000", 0.55)}`, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
  const metaLines = meta ? meta.split(/\s{2,}|\n|·/).map((s) => s.trim()).filter(Boolean).slice(0, 2) : [];
  const metaSize = Math.min(44, ...metaLines.map((l) => fitLine(l, W * 0.6, 44, 30, 1.2)));
  return (
    <div style={{ ...fill, opacity: inT }}>
      <div style={{ ...fill, backgroundImage: SCANLINES, opacity: 0.55 }} />
      <div style={{ ...fill, background: `radial-gradient(ellipse 75% 60% at 50% 50%, transparent 55%, ${rgba("#000000", 0.5)} 100%)` }} />
      <div style={{ ...fill, background: `linear-gradient(180deg, ${rgba("#22E4FF", 0.06)} 0%, transparent 30%, transparent 70%, ${rgba("#FF2A6D", 0.06)} 100%)` }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: bandY, height: 70, background: `repeating-linear-gradient(0deg, ${rgba("#FFFFFF", 0.16)} 0px, ${rgba("#FFFFFF", 0.16)} 1px, transparent 1px, transparent 4px), linear-gradient(180deg, transparent, ${rgba("#FFFFFF", 0.08)}, transparent)`, transform: `translateX(${r1(jitter * 3)}px)` }} />
      <div style={{ ...fill, transform: `translate(${r1(jitter)}px, 0px)` }}>
        <div style={{ position: "absolute", left: 76, top: 150, display: "flex", alignItems: "center", gap: 16, ...osd }}>
          <div style={{ width: 30, height: 30, borderRadius: 15, background: mix(p.negative, "#FF2A2A", 0.5), opacity: blink ? 1 : 0.15, boxShadow: `0 0 12px ${rgba("#FF2A2A", 0.6)}` }} />
          REC
        </div>
        <div style={{ position: "absolute", right: 76, top: 150, display: "flex", alignItems: "center", gap: 16, ...osd }}>
          {mode}
          <PlayTri size={34} color="#FFFFFF" />
        </div>
        <div style={{ position: "absolute", left: 76, bottom: H * 0.22, display: "flex", flexDirection: "column", gap: 6, ...osd, fontSize: metaSize }}>
          {metaLines.map((l, i) => (
            <span key={i}>{l.toUpperCase()}</span>
          ))}
        </div>
        <div style={{ position: "absolute", right: 76, bottom: H * 0.22, ...osd }}>{counter}</div>
      </div>
    </div>
  );
}

/** Spotlight: the frame darkens down to a soft circle on the speaker. */
function FxSpotlight({ ctx }: { ctx: GCtx }) {
  const { frame, fps, width: W, height: H } = ctx;
  const t = prog(frame, 0, Math.round(0.7 * fps), EASE_IN_OUT);
  const R0 = Math.hypot(W, H);
  const R1 = W * 0.42;
  const breathe = 1 + 0.015 * Math.sin((frame / fps) * 2.4) * t;
  const R = (R0 + (R1 - R0) * t) * breathe;
  const cy = H * 0.5;
  return (
    <div style={fill}>
      <div style={{ ...fill, background: `radial-gradient(circle ${r1(R + 110)}px at 50% ${r1(cy)}px, transparent 0px, transparent ${r1(R - 20)}px, ${rgba("#050507", 0.55)} ${r1(R + 50)}px, ${rgba("#050507", 0.86)} ${r1(R + 110)}px)` }} />
      <div style={{ position: "absolute", left: W / 2 - R, top: cy - R, width: R * 2, height: R * 2, borderRadius: "50%", boxShadow: `inset 0 0 0 2px ${rgba("#FFFFFF", 0.08 * t)}` }} />
      <div style={{ ...fill, background: `linear-gradient(180deg, ${rgba("#FFF8E8", 0.07 * t)} 0%, transparent 30%)` }} />
      <FxWord ctx={ctx} y={Math.min(H * 0.8, cy + R1 + 150)} />
    </div>
  );
}

/** Zoom punch: a white flash, viewfinder corners snap in, rays fade — sells a punch-in cut. */
function FxZoomPunch({ ctx }: { ctx: GCtx }) {
  const { frame, fps, height: H } = ctx;
  const flash = Math.max(0, 1 - frame / Math.max(2, Math.round(0.22 * fps)));
  const s = springAt(frame, fps, 0, ctx.f.springs.punch, Math.round(0.5 * fps));
  const k = Math.max(0, s);
  const inset = 120 - 190 * (1 - Math.min(1.1, k));
  const L = 130;
  const rays = Math.max(0, 1 - frame / Math.max(2, Math.round(0.45 * fps)));
  const mask = "radial-gradient(ellipse 50% 42% at 50% 46%, transparent 55%, #000 100%)";
  const corner = (rot: number, style: CSSProperties) => (
    <svg width={L} height={L} viewBox={`0 0 ${L} ${L}`} style={{ position: "absolute", ...style, transform: `rotate(${rot}deg)`, overflow: "visible", filter: `drop-shadow(0 3px 6px ${rgba("#000000", 0.5)})` }}>
      <path d={`M6 ${L} L6 18 Q6 6 18 6 L${L} 6`} fill="none" stroke="#FFFFFF" strokeWidth={11} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  return (
    <div style={fill}>
      {rays > 0.01 ? <div style={{ ...fill, opacity: rays, backgroundImage: `repeating-conic-gradient(from 0deg at 50% 46%, ${rgba("#FFFFFF", 0.35)} 0deg 1.4deg, transparent 1.4deg 7deg)`, WebkitMaskImage: mask, maskImage: mask }} /> : null}
      <div style={{ ...fill, background: `radial-gradient(ellipse 70% 55% at 50% 46%, transparent 60%, ${rgba("#000000", 0.32)} 100%)`, opacity: prog(frame, 0, 4) }} />
      {corner(0, { left: inset, top: inset + 120 })}
      {corner(90, { right: inset, top: inset + 120 })}
      {corner(180, { right: inset, bottom: inset + 260 })}
      {corner(270, { left: inset, bottom: inset + 260 })}
      {flash > 0.01 ? <div style={{ ...fill, background: rgba("#FFFFFF", 0.75 * flash) }} /> : null}
      <FxWord ctx={ctx} y={H * 0.17} />
    </div>
  );
}

/** Before / after: the divider sweeps in, gets "dragged", settles in the middle; labels on each side. */
function FxSplit({ ctx }: { ctx: GCtx }) {
  const { props, p, frame, fps, width: W, height: H } = ctx;
  const a = (props.items[0]?.text?.trim() || "BEFORE").toUpperCase();
  const b = (props.items[1]?.text?.trim() || "AFTER").toUpperCase();
  const sweep = prog(frame, 0, Math.round(0.55 * fps), ctx.ease);
  const dragT = Math.max(0, frame / fps - 0.7);
  const drag = Math.sin(dragT * 4.2) * 70 * Math.exp(-dragT * 1.6) * (frame / fps > 0.7 ? 1 : 0);
  const x = W - (W / 2) * sweep + drag;
  const lab = prog(frame, Math.round(0.35 * fps), Math.round(0.45 * fps), ctx.ease);
  const hy = H * 0.5;
  const size = Math.min(fitLine(a, W / 2 - 150, 38, 28, 1.25), fitLine(b, W / 2 - 150, 38, 28, 1.25));
  const pill = (txt: string, solid: boolean): CSSProperties => ({ padding: "14px 26px", borderRadius: 999, fontFamily: FONT.display, fontSize: size, letterSpacing: "0.14em", whiteSpace: "nowrap", color: solid ? onFill(p.primary) : "#FFFFFF", background: solid ? p.primary : rgba("#0C0B10", 0.72), boxShadow: `0 10px 24px ${rgba("#000000", 0.4)}${solid ? "" : `, inset 0 0 0 1.5px ${rgba("#FFFFFF", 0.18)}`}`, maxWidth: W / 2 - 120, overflow: "hidden", textOverflow: "ellipsis", ...(txt ? {} : {}) });
  return (
    <div style={fill}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: Math.max(0, x), background: `linear-gradient(90deg, ${rgba("#0A0A10", 0.34)}, ${rgba("#0A0A10", 0.22)})` }} />
      <div style={{ position: "absolute", left: x - 3, top: 0, bottom: 0, width: 6, background: "#FFFFFF", boxShadow: `0 0 18px ${rgba("#FFFFFF", 0.6)}, 0 0 4px ${rgba("#000000", 0.4)}` }} />
      <div style={{ position: "absolute", left: x - 48, top: hy - 48, width: 96, height: 96, borderRadius: 48, background: "#FFFFFF", boxShadow: `0 10px 26px ${rgba("#000000", 0.45)}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width={56} height={56} viewBox="0 0 24 24">
          <path d="M9 7 L4 12 L9 17 M15 7 L20 12 L15 17" fill="none" stroke={NOIR} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div style={{ position: "absolute", left: 64, top: H * 0.15, ...pill(a, false), ...riseStyle(lab, 14) }}>{a}</div>
      <div style={{ position: "absolute", right: 64, top: H * 0.15, ...pill(b, true), ...riseStyle(lab, 14) }}>{b}</div>
      <FxWord ctx={ctx} y={H * 0.27} />
    </div>
  );
}

// ===================================================================== registry

/** Library 2 — fx family components. */
export const FX_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {
  VERDICT: Verdict,
  HOOK_TEXT: HookText,
  COUNTDOWN: Countdown,
  QUIZ: Quiz,
  SCREEN_FX: ScreenFx,
};

// Pure helpers exported for tests.
export const __fxInternals = { moodOf, clockText, breakLines };
