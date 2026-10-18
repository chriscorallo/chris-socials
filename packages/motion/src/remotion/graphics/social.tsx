import { useId, type ComponentType, type CSSProperties, type ReactNode } from "react";
import type { GraphicComponent, GraphicIcon, GraphicItem } from "@chris/media/timeline";
import { listSequence } from "../../graphics-timing";
import { GIcon, GRAPHIC_ICON_PATHS } from "./icons";
import { FONT, clamp01, css, emphasisAt, enterStyle, mix, prog, r1, r4, rgba, seqStyle, springAt, withExit, type GCtx } from "./kit";
import { Avatar, Caret, card, namePair, oneLine, readableOn, socialCountAt, toneOf, typedChars, typeFrames, type Tone } from "./ui";
import { fitLine, fitWords, hash01, splitWords, squeeze, textW } from "./text";

/**
 * Library 2 — SOCIAL family: generic, brand-safe "-style" platform UI.
 * SOCIAL_POST · COMMENT · TRENDING · VIDEO_CARD · STORY · SOCIAL_COUNTER · BURST.
 *
 * Never a real platform's logo, wordmark, verification badge or signature colour: initials
 * avatars, original line glyphs, Inter type, palette accents (the like-heart red and the LIVE
 * red are universal conventions, not marks). Everything is a pure function of ctx.frame and
 * draws inside ctx.width × ctx.height (families/social.ts sizes the box to the content).
 */

const fill: CSSProperties = { position: "absolute", inset: 0 };
const LIKE = "#FF3B5C";
const LIVE_RED = "#FF2D55";
const CORRECT = "#22C55E";
/** Inter SemiBold (body copy) runs a touch wider than the Display estimate in textW. */
const TK = 1.05;
const HEART_D = GRAPHIC_ICON_PATHS.HEART[0]!;
const BIG_HEART_D = "M12 21.2C11.6 21 2 15.4 2 8.6C2 5.5 4.4 3 7.4 3c1.9 0 3.6 1 4.6 2.6C13 4 14.7 3 16.6 3C19.6 3 22 5.5 22 8.6c0 6.8-9.6 12.4-10 12.6z";
const DEFAULT_COUNT_ICONS: GraphicIcon[] = ["CHAT", "REPOST", "HEART", "EYE"];

// ===================================================================== helpers

function seqOpts(ctx: GCtx, startFrame?: number) {
  return { fps: ctx.fps, durationInFrames: ctx.D, exitFrames: ctx.exitFrames, tempo: ctx.f.tempo, startFrame };
}

/** Choreography clock: seconds → frames at the animation speed, compressed so `total` s fits the build budget. */
function clock(ctx: GCtx, total: number): (s: number) => number {
  const k = ctx.fps / Math.max(0.25, ctx.anim.speed);
  const z = squeeze(ctx, 0, total * k);
  return (s) => Math.round(s * k * z);
}

/** The container's entrance (shared vocabulary) + element exit. */
function boxIn(ctx: GCtx, at = 0): CSSProperties {
  return css(withExit(ctx, enterStyle(ctx, at, Math.round(0.5 * ctx.fps), { blurOK: true }), 0, 1));
}

/** 0..1..0 bump over `dur` s from `at`. */
function bump(ctx: GCtx, at: number, dur = 0.35): number {
  const a = (ctx.frame - at) / Math.max(1, dur * ctx.fps);
  return a < 0 || a > 1 ? 0 : Math.sin(a * Math.PI);
}

/** `top` (hex) laid over `base` (any CSS colour, incl. rgba) at opacity t — mix() is hex-only. */
function blendBg(base: string, top: string, t: number): string {
  const a = rgba(top, Math.max(0, Math.min(1, t)));
  return `linear-gradient(${a}, ${a}), ${base}`;
}

function fitText(text: string, w: number, h: number, o: { max: number; min: number; lh: number; k?: number; maxLines?: number }): { size: number; lines: string[] } {
  const f = fitWords(splitWords(text), w, h, o);
  return { size: f.size, lines: f.lines.map((ln) => ln.map((i) => f.words[i]).join(" ")) };
}

/** Wrapped lines that enter one after another. */
function Lines({ ctx, lines, size, lh, color, font = FONT.text, start, align = "left", ls = "-0.006em", weightShift }: { ctx: GCtx; lines: string[]; size: number; lh: number; color: string; font?: string; start: number; align?: "left" | "center"; ls?: string; weightShift?: CSSProperties }) {
  const seq = listSequence(lines.length, { ...ctx.anim, stagger: Math.max(0.06, Math.min(0.12, ctx.anim.stagger)) }, seqOpts(ctx, start));
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} style={{ fontFamily: font, fontSize: size, lineHeight: lh, color, whiteSpace: "nowrap", textAlign: align, letterSpacing: ls, ...weightShift, ...css(seqStyle(ctx, seq, 0, i, { distance: 0.45 })) }}>
          {l || " "}
        </div>
      ))}
    </>
  );
}

function fade(ctx: GCtx, at: number, len = 0.4, dy = 12): CSSProperties {
  const t = prog(ctx.frame, at, Math.max(2, Math.round(len * ctx.fps)), ctx.ease);
  return { opacity: t, transform: t >= 1 ? undefined : `translateY(${r1((1 - t) * dy)}px)` };
}

function popIn(ctx: GCtx, at: number, from = 0.4): CSSProperties {
  const s = springAt(ctx.frame, ctx.fps, at, ctx.f.springs.soft, Math.round(0.8 * ctx.fps));
  return { opacity: prog(ctx.frame, at, 4), transform: `scale(${r4(from + (1 - from) * Math.max(0, s))})` };
}

function FilledIcon({ d, size, color, view = 24 }: { d: string; size: number; color: string; view?: number }) {
  return (
    <svg width={size} height={size} viewBox={`0 0 ${view} ${view}`} style={{ display: "block", overflow: "visible" }}>
      <path d={d} fill={color} />
    </svg>
  );
}

/** Line icon that can be "activated" (filled in `color` with a pop) — likes, saves, upvotes. */
function Toggle({ ctx, icon, size, base, color, at, fillD, stroke = 2 }: { ctx: GCtx; icon: GraphicIcon; size: number; base: string; color: string; at: number | null; fillD?: string; stroke?: number }) {
  const on = at == null ? 0 : prog(ctx.frame, at, Math.max(2, Math.round(0.15 * ctx.fps)));
  const pop = at == null ? 0 : bump(ctx, at, 0.42);
  const sparkT = at == null ? 0 : (ctx.frame - at) / (0.5 * ctx.fps);
  const d = fillD ?? GRAPHIC_ICON_PATHS[icon][0]!;
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none", transform: pop ? `scale(${r4(1 + 0.34 * pop)})` : undefined }}>
      {on > 0 ? (
        <div style={{ position: "absolute", inset: 0, opacity: on }}>
          <FilledIcon d={d} size={size} color={color} />
        </div>
      ) : null}
      <div style={{ position: "absolute", inset: 0 }}>
        <GIcon icon={icon} size={size} color={mix(base, color, on)} stroke={stroke} />
      </div>
      {sparkT > 0 && sparkT < 1
        ? [0, 1, 2, 3, 4, 5].map((k) => {
            const a = (k / 6) * Math.PI * 2 - Math.PI / 2;
            const r = size * (0.55 + 0.45 * sparkT);
            return <div key={k} style={{ position: "absolute", left: size / 2 + Math.cos(a) * r - 3.5, top: size / 2 + Math.sin(a) * r - 3.5, width: 7, height: 7, borderRadius: 4, background: color, opacity: 1 - sparkT }} />;
          })
        : null}
    </div>
  );
}

/** "Your Name · @yourhandle" header line pieces. */
function nameOf(ctx: GCtx, fallback = "Your Name"): string {
  return ctx.props.title?.trim() || fallback;
}

function cleanItems(items: GraphicItem[], max: number): GraphicItem[] {
  return items.slice(0, max);
}

function hhmmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Photo placeholder: soft gradient sky, sun, two hill layers (never a real photo). */
function PhotoArt({ w, h, seed, zoom = 1 }: { w: number; h: number; seed: string; zoom?: number }) {
  const [a, b] = namePair(seed || "photo");
  const sky = `linear-gradient(180deg, ${mix(b, "#2B3A78", 0.6)} 0%, ${mix(a, "#E9806A", 0.55)} 58%, ${mix(a, "#FFD9A0", 0.65)} 100%)`;
  const r = Math.min(w, h) * 0.11;
  return (
    <div style={{ position: "absolute", inset: 0, background: sky, transform: zoom !== 1 ? `scale(${r4(zoom)})` : undefined }}>
      <div style={{ position: "absolute", left: w * 0.62 - r * 3, top: h * 0.5 - r * 3, width: r * 6, height: r * 6, borderRadius: "50%", background: `radial-gradient(circle, ${rgba("#FFE7B8", 0.55)} 0%, transparent 65%)` }} />
      <div style={{ position: "absolute", left: w * 0.62 - r, top: h * 0.5 - r, width: 2 * r, height: 2 * r, borderRadius: "50%", background: "#FFF1D2" }} />
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: "absolute", inset: 0, display: "block" }}>
        <path d={`M0 ${h * 0.68} Q ${w * 0.22} ${h * 0.52} ${w * 0.45} ${h * 0.64} T ${w} ${h * 0.6} V ${h} H 0 Z`} fill={mix(b, "#2A1F3D", 0.6)} />
        <path d={`M0 ${h * 0.84} Q ${w * 0.3} ${h * 0.7} ${w * 0.6} ${h * 0.82} T ${w} ${h * 0.78} V ${h} H 0 Z`} fill={mix(b, "#120E1E", 0.78)} />
      </svg>
    </div>
  );
}

/** Video thumbnail placeholder: deep palette gradient, soft glows, a generic silhouette. */
function ThumbArt({ ctx, w, h, seed }: { ctx: GCtx; w: number; h: number; seed: string }) {
  const [a] = namePair(seed || "video");
  const p = ctx.p;
  return (
    <div style={{ position: "absolute", inset: 0, background: `linear-gradient(135deg, ${mix(a, "#0B0B12", 0.45)} 0%, ${mix(p.secondary, "#0B0B12", 0.55)} 55%, ${mix(p.primary, "#0B0B12", 0.6)} 100%)`, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: -w * 0.1, top: -h * 0.3, width: w * 0.7, height: h * 1.0, borderRadius: "50%", background: `radial-gradient(circle, ${rgba(mix(a, "#FFFFFF", 0.3), 0.4)} 0%, transparent 65%)` }} />
      <div style={{ position: "absolute", right: w * 0.04, bottom: -h * 0.1, opacity: 0.2 }}>
        <GIcon icon="USER" size={Math.round(h * 0.7)} color="#FFFFFF" stroke={1.3} />
      </div>
    </div>
  );
}

/** A generic play glyph (round, translucent) — not any platform's play-button logo. */
function PlayGlyph({ size, o = 1 }: { size: number; o?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: rgba("#0B0B12", 0.42), boxShadow: `inset 0 0 0 ${Math.max(2, size * 0.03)}px ${rgba("#FFFFFF", 0.75)}, 0 10px 30px ${rgba("#000000", 0.35)}`, display: "flex", alignItems: "center", justifyContent: "center", opacity: o }}>
      <svg width={size * 0.42} height={size * 0.42} viewBox="0 0 24 24" style={{ marginLeft: size * 0.05 }}>
        <path d="M6 3.8c0-.9 1-1.5 1.8-1l12.6 8.2c.7.5.7 1.5 0 2L7.8 21.2c-.8.5-1.8-.1-1.8-1z" fill="#FFFFFF" />
      </svg>
    </div>
  );
}

/** Rolling odometer digits (each digit column rolls when the one below it carries). */
function Odometer({ value, final, size, color, font = FONT.display }: { value: number; final: number; size: number; color: string; font?: string }) {
  const fin = Math.max(0, Math.round(final));
  const nDigits = String(fin).length;
  const v = Math.max(0, Math.min(fin, value));
  const cells: ReactNode[] = [];
  for (let k = nDigits - 1; k >= 0; k--) {
    const p10 = 10 ** k;
    const digit = Math.floor(v / p10) % 10;
    const f = k === 0 ? v % 1 : clamp01((v % p10) - (p10 - 1));
    const lead = Math.floor(v / p10) === 0 && k > 0 && Math.floor(fin / p10) > 0 ? true : false;
    cells.push(
      <span key={`d${k}`} style={{ position: "relative", display: "inline-block", width: "0.62em", height: "1.08em", overflow: "hidden", verticalAlign: "top", opacity: lead ? 0.35 : 1 }}>
        <span style={{ position: "absolute", left: 0, right: 0, top: 0, textAlign: "center", transform: f > 0 ? `translateY(${r1(-f * 100)}%)` : undefined }}>{digit}</span>
        {f > 0 ? <span style={{ position: "absolute", left: 0, right: 0, top: "100%", textAlign: "center", transform: `translateY(${r1(-f * 100)}%)` }}>{(digit + 1) % 10}</span> : null}
      </span>,
    );
    if (k > 0 && k % 3 === 0) cells.push(<span key={`c${k}`} style={{ display: "inline-block", width: "0.26em", verticalAlign: "top", height: "1.08em" }}>,</span>);
  }
  return <div style={{ fontFamily: font, fontSize: size, lineHeight: 1.08, color, whiteSpace: "nowrap", letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>{cells}</div>;
}

function odometerWidth(final: number, size: number): number {
  const n = String(Math.max(0, Math.round(final))).length;
  return size * (n * 0.62 + Math.floor((n - 1) / 3) * 0.26);
}

// ------------------------------------------------------------------- flat sticker faces

const FACE_INK = "#3B2208";

/** Flat, original sticker artwork for reaction icons (faces, heart, fire, star, 100, skull). */
function StickerIcon({ icon, size, color }: { icon: GraphicIcon; size: number; color: string }) {
  const svg = (children: ReactNode) => (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: "block", overflow: "visible" }}>
      {children}
    </svg>
  );
  const face = (base: string, shade: string, features: ReactNode) =>
    svg(
      <>
        <circle cx={50} cy={52} r={46} fill={shade} />
        <circle cx={50} cy={48} r={46} fill={base} />
        <ellipse cx={34} cy={24} rx={14} ry={8} fill="#FFFFFF" opacity={0.32} transform="rotate(-24 34 24)" />
        {features}
      </>,
    );
  const Y = "#FFCC3E";
  const YS = "#E9A21B";
  switch (icon) {
    case "FACE_SMILE":
      return face(Y, YS, <>
        <ellipse cx={35} cy={40} rx={5.5} ry={8} fill={FACE_INK} />
        <ellipse cx={65} cy={40} rx={5.5} ry={8} fill={FACE_INK} />
        <path d="M28 57 Q50 82 72 57 Q50 67 28 57Z" fill={FACE_INK} />
      </>);
    case "FACE_LAUGH":
      return face(Y, YS, <>
        <path d="M26 36 L40 42 L26 48" fill="none" stroke={FACE_INK} strokeWidth={5.5} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M74 36 L60 42 L74 48" fill="none" stroke={FACE_INK} strokeWidth={5.5} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M24 55 H76 Q74 86 50 86 Q26 86 24 55Z" fill={FACE_INK} />
        <path d="M36 77 Q50 68 64 77 Q58 85 50 85 Q42 85 36 77Z" fill="#FF6B81" />
      </>);
    case "FACE_WOW":
      return face(Y, YS, <>
        <path d="M24 26 Q34 18 44 24" fill="none" stroke={FACE_INK} strokeWidth={4.5} strokeLinecap="round" />
        <path d="M56 24 Q66 18 76 26" fill="none" stroke={FACE_INK} strokeWidth={4.5} strokeLinecap="round" />
        <circle cx={35} cy={40} r={7.5} fill={FACE_INK} />
        <circle cx={65} cy={40} r={7.5} fill={FACE_INK} />
        <ellipse cx={50} cy={68} rx={10} ry={13} fill={FACE_INK} />
      </>);
    case "FACE_SAD":
      return face(Y, YS, <>
        <ellipse cx={35} cy={42} rx={5.5} ry={7.5} fill={FACE_INK} />
        <ellipse cx={65} cy={42} rx={5.5} ry={7.5} fill={FACE_INK} />
        <path d="M32 74 Q50 58 68 74" fill="none" stroke={FACE_INK} strokeWidth={6} strokeLinecap="round" />
        <path d="M70 50 C70 50 62 60 62 65 a8 8 0 0 0 16 0 C78 60 70 50 70 50Z" fill="#5AB8FF" />
      </>);
    case "FACE_LOVE":
      return face(Y, YS, <>
        <path d="M35 50 C35 50 22 42 22 34 a6.5 6.5 0 0 1 13 -1.5 a6.5 6.5 0 0 1 13 1.5 C48 42 35 50 35 50Z" fill="#FF3B5C" />
        <path d="M65 50 C65 50 52 42 52 34 a6.5 6.5 0 0 1 13 -1.5 a6.5 6.5 0 0 1 13 1.5 C78 42 65 50 65 50Z" fill="#FF3B5C" />
        <path d="M30 60 Q50 82 70 60 Q50 69 30 60Z" fill={FACE_INK} />
      </>);
    case "FACE_COOL":
      return face(Y, YS, <>
        <path d="M14 34 H86 V38 Q84 54 68 54 Q56 54 54 40 H46 Q44 54 32 54 Q16 54 14 38Z" fill="#1A1A22" />
        <path d="M22 38 L30 38" stroke="#FFFFFF" strokeWidth={3} strokeLinecap="round" opacity={0.6} />
        <path d="M60 38 L68 38" stroke="#FFFFFF" strokeWidth={3} strokeLinecap="round" opacity={0.6} />
        <path d="M36 70 Q52 78 66 66" fill="none" stroke={FACE_INK} strokeWidth={6} strokeLinecap="round" />
      </>);
    case "FACE_MAD":
      return face("#FF7B47", "#D9452A", <>
        <path d="M22 30 L42 38" stroke={FACE_INK} strokeWidth={6} strokeLinecap="round" />
        <path d="M78 30 L58 38" stroke={FACE_INK} strokeWidth={6} strokeLinecap="round" />
        <ellipse cx={36} cy={47} rx={5} ry={6} fill={FACE_INK} />
        <ellipse cx={64} cy={47} rx={5} ry={6} fill={FACE_INK} />
        <path d="M34 74 Q50 62 66 74" fill="none" stroke={FACE_INK} strokeWidth={6} strokeLinecap="round" />
      </>);
    case "FACE_THINK":
      return face(Y, YS, <>
        <path d="M24 28 Q34 20 44 26" fill="none" stroke={FACE_INK} strokeWidth={4.5} strokeLinecap="round" />
        <path d="M58 30 L74 30" fill="none" stroke={FACE_INK} strokeWidth={4.5} strokeLinecap="round" />
        <ellipse cx={35} cy={42} rx={5.5} ry={7.5} fill={FACE_INK} />
        <ellipse cx={65} cy={42} rx={5.5} ry={7} fill={FACE_INK} />
        <path d="M38 68 L64 63" fill="none" stroke={FACE_INK} strokeWidth={6} strokeLinecap="round" />
      </>);
    case "SKULL":
      return svg(<>
        <path d="M50 8 C26 8 12 24 12 46 c0 14 7 22 15 27 v12 a5 5 0 0 0 5 5 h36 a5 5 0 0 0 5-5 v-12 c8-5 15-13 15-27 C88 24 74 8 50 8Z" fill="#C9C9D3" transform="translate(0 3)" />
        <path d="M50 8 C26 8 12 24 12 46 c0 14 7 22 15 27 v12 a5 5 0 0 0 5 5 h36 a5 5 0 0 0 5-5 v-12 c8-5 15-13 15-27 C88 24 74 8 50 8Z" fill="#F3F3F7" />
        <ellipse cx={34} cy={48} rx={10} ry={11} fill="#25232E" />
        <ellipse cx={66} cy={48} rx={10} ry={11} fill="#25232E" />
        <path d="M50 58 L44 70 H56Z" fill="#25232E" />
        <path d="M40 80 V90 M50 80 V90 M60 80 V90" stroke="#9A98A6" strokeWidth={3.5} strokeLinecap="round" />
      </>);
    case "HUNDRED":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", overflow: "visible" }}>
          {GRAPHIC_ICON_PATHS.HUNDRED.map((d, i) => (
            <path key={`w${i}`} d={d} fill="none" stroke="#FFFFFF" strokeWidth={4.6} strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {GRAPHIC_ICON_PATHS.HUNDRED.map((d, i) => (
            <path key={`r${i}`} d={d} fill="none" stroke="#F0283C" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </svg>
      );
    case "FIRE":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", overflow: "visible" }}>
          <path d={GRAPHIC_ICON_PATHS.FIRE[0]} fill="#FF7A1A" />
          <path d={GRAPHIC_ICON_PATHS.FIRE[1]} fill="#FFD23F" />
        </svg>
      );
    case "STAR":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", overflow: "visible" }}>
          <path d={GRAPHIC_ICON_PATHS.STAR[0]} fill="#FFC531" stroke="#FFC531" strokeWidth={1.4} strokeLinejoin="round" />
          <path d="M9.2 9.6l1.2-2.4" stroke="#FFFFFF" strokeWidth={1.3} strokeLinecap="round" opacity={0.6} />
        </svg>
      );
    case "HEART":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", overflow: "visible" }}>
          <path d={BIG_HEART_D} fill={color} />
          <ellipse cx={7.6} cy={7.4} rx={2.4} ry={1.4} fill="#FFFFFF" opacity={0.38} transform="rotate(-35 7.6 7.4)" />
        </svg>
      );
    default:
      return (
        <div style={{ width: size, height: size, borderRadius: "50%", background: `linear-gradient(150deg, ${mix(color, "#FFFFFF", 0.25)} 0%, ${color} 60%, ${mix(color, "#000000", 0.18)} 100%)`, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `inset 0 2px 0 ${rgba("#FFFFFF", 0.35)}` }}>
          <GIcon icon={icon} size={Math.round(size * 0.56)} color="#FFFFFF" stroke={2.2} />
        </div>
      );
  }
}

// ===================================================================== SOCIAL_POST

function SocialPost({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "PRO":
      return <PostPro ctx={ctx} />;
    case "FORUM":
      return <PostForum ctx={ctx} />;
    case "PHOTO":
      return <PostPhoto ctx={ctx} />;
    default:
      return <PostMicro ctx={ctx} />;
  }
}

/** Counts that tick up; a heart gets liked. */
function CountRow({ ctx, T, items, width, start, likeAt, iconSize = 42, font = 32 }: { ctx: GCtx; T: Tone; items: GraphicItem[]; width: number; start: number; likeAt: number; iconSize?: number; font?: number }) {
  const n = items.length;
  const colW = width / Math.max(1, n);
  const seq = listSequence(n, { ...ctx.anim, stagger: Math.max(0.05, Math.min(0.1, ctx.anim.stagger)) }, seqOpts(ctx, start));
  return (
    <div style={{ display: "flex", width }}>
      {items.map((it, i) => {
        const icon = it.icon ?? DEFAULT_COUNT_ICONS[i % 4]!;
        const like = icon === "HEART";
        const txt = it.value != null ? socialCountAt(ctx, seq.at(0, i), it.value, 0, 2.4) : it.text;
        const on = like ? prog(ctx.frame, likeAt, 4) : 0;
        return (
          <div key={i} style={{ width: colW, display: "flex", alignItems: "center", gap: 12, ...css(seqStyle(ctx, seq, 0, i, { distance: 0.4 })) }}>
            <Toggle ctx={ctx} icon={icon} size={iconSize} base={T.muted} color={LIKE} at={like ? likeAt : null} fillD={like ? HEART_D : undefined} />
            <span style={{ fontFamily: FONT.text, fontSize: fitLine(txt, colW - iconSize - 16, font, 26, TK), color: mix(T.muted, LIKE, on), fontVariantNumeric: "tabular-nums", ...oneLine }}>{txt}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Short-post card (MICRO): avatar, name, handle · time, the post, counts. */
function PostMicro({ ctx }: { ctx: GCtx }) {
  const { props } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const pad = 48;
  const av = 100;
  const name = nameOf(ctx);
  const handle = props.subtitle?.trim() || "@yourhandle";
  const meta = props.meta?.trim();
  const items = cleanItems(props.items, 4);
  const countsH = items.length ? 92 : 0;
  const bodyTop = pad + av + 26;
  const bodyW = W - 2 * pad;
  const bodyH = Math.max(56, H - bodyTop - countsH - 36);
  const body = fitText(props.body?.trim() || "", bodyW, bodyH, { max: 46, min: 34, lh: 1.32, k: TK });
  const c = clock(ctx, 2.8);
  const nameX = pad + av + 24;
  const nameW = W - nameX - pad - 56;
  const sub = `${handle}${meta ? ` · ${meta}` : ""}`;
  return (
    <div style={{ ...fill, ...card(T, 44), ...boxIn(ctx) }}>
      <div style={{ position: "absolute", left: pad, top: pad, ...popIn(ctx, c(0.08), 0.5) }}>
        <Avatar name={name} size={av} />
      </div>
      <div style={{ position: "absolute", left: nameX, top: pad + 6, width: nameW, ...fade(ctx, c(0.12)) }}>
        <div style={{ fontFamily: FONT.displayBold, fontSize: fitLine(name, nameW, 40, 30), lineHeight: 1.2, color: T.ink, letterSpacing: "-0.015em", ...oneLine }}>{name}</div>
        <div style={{ marginTop: 4, fontFamily: FONT.text, fontSize: fitLine(sub, nameW, 32, 28, TK), lineHeight: 1.2, color: T.muted, ...oneLine }}>{sub}</div>
      </div>
      <div style={{ position: "absolute", right: pad - 6, top: pad + 18, ...fade(ctx, c(0.2)) }}>
        <GIcon icon="DOTS" size={44} color={T.faint} stroke={3} />
      </div>
      <div style={{ position: "absolute", left: pad, top: bodyTop, width: bodyW }}>
        <Lines ctx={ctx} lines={body.lines} size={body.size} lh={1.32} color={T.ink} start={c(0.3)} />
      </div>
      {items.length ? (
        <div style={{ position: "absolute", left: pad, bottom: 34, height: 60, display: "flex", alignItems: "center" }}>
          <CountRow ctx={ctx} T={T} items={items} width={bodyW} start={c(0.75)} likeAt={c(2.1)} />
        </div>
      ) : null}
    </div>
  );
}

/** Professional-network post (PRO): headline, body, reaction summary, action bar. */
function PostPro({ ctx }: { ctx: GCtx }) {
  const { props, frame } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const pad = 48;
  const av = 104;
  const name = nameOf(ctx);
  const headline = props.subtitle?.trim() || "Building in public";
  const meta = props.meta?.trim() || "2h";
  const items = cleanItems(props.items, 3);
  const c = clock(ctx, 3);
  const bodyTop = pad + 150;
  const actionsH = 92;
  const reactH = items.length ? 70 : 0;
  const bodyW = W - 2 * pad;
  const bodyH = Math.max(52, H - bodyTop - actionsH - reactH - 30);
  const body = fitText(props.body?.trim() || "", bodyW, bodyH, { max: 42, min: 33, lh: 1.36, k: TK });
  const nameX = pad + av + 24;
  const nameW = W - nameX - pad;
  const likeAt = c(2.3);
  const liked = prog(frame, likeAt, 4);
  const r0 = items[0];
  const rest = items.slice(1).filter((it) => it.value != null);
  const restTxt = rest.map((it) => `${socialCountAt(ctx, c(1), it.value!, 0, 2.4)} ${it.text || ""}`.trim()).join(" · ");
  const reactColors = [ctx.p.primary, LIKE, ctx.p.positive];
  const reactIcons: GraphicIcon[] = ["THUMBS_UP", "HEART", "BULB"];
  const actions: Array<[GraphicIcon, string]> = [["THUMBS_UP", "Like"], ["CHAT", "Comment"], ["REPOST", "Repost"], ["SEND", "Send"]];
  return (
    <div style={{ ...fill, ...card(T, 40), ...boxIn(ctx) }}>
      <div style={{ position: "absolute", left: pad, top: pad, ...popIn(ctx, c(0.08), 0.5) }}>
        <Avatar name={name} size={av} />
      </div>
      <div style={{ position: "absolute", left: nameX, top: pad - 2, width: nameW, ...fade(ctx, c(0.12)) }}>
        <div style={{ fontFamily: FONT.displayBold, fontSize: fitLine(name, nameW, 40, 30), lineHeight: 1.2, color: T.ink, letterSpacing: "-0.015em", ...oneLine }}>{name}</div>
        <div style={{ marginTop: 2, fontFamily: FONT.text, fontSize: fitLine(headline, nameW, 30, 28, TK), lineHeight: 1.25, color: T.muted, ...oneLine }}>{headline}</div>
        <div style={{ marginTop: 2, display: "flex", alignItems: "center", gap: 8, fontFamily: FONT.text, fontSize: 28, lineHeight: 1.25, color: T.faint }}>
          <span>{meta} ·</span>
          <GIcon icon="GLOBE" size={26} color={T.faint} stroke={2} />
        </div>
      </div>
      <div style={{ position: "absolute", left: pad, top: bodyTop, width: bodyW }}>
        <Lines ctx={ctx} lines={body.lines} size={body.size} lh={1.36} color={T.ink} start={c(0.32)} />
      </div>
      {items.length ? (
        <div style={{ position: "absolute", left: pad, right: pad, bottom: actionsH + 14, height: 52, display: "flex", alignItems: "center", gap: 14, ...fade(ctx, c(0.9)) }}>
          <div style={{ display: "flex", flex: "none" }}>
            {reactIcons.map((ic, k) => (
              <div key={k} style={{ width: 44, height: 44, marginLeft: k ? -12 : 0, borderRadius: 22, background: reactColors[k], boxShadow: `0 0 0 3px ${T.dark ? "#1A1A24" : "#FFFFFF"}`, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3 - k, ...popIn(ctx, c(0.9) + k * 3, 0.3) }}>
                <GIcon icon={ic} size={26} color="#FFFFFF" stroke={2.3} />
              </div>
            ))}
          </div>
          {r0 ? <span style={{ fontFamily: FONT.text, fontSize: 30, color: T.muted, fontVariantNumeric: "tabular-nums", flex: "none" }}>{r0.value != null ? socialCountAt(ctx, c(1), r0.value, 0, 2.4) : r0.text}</span> : null}
          <span style={{ marginLeft: "auto", fontFamily: FONT.text, fontSize: fitLine(restTxt, bodyW * 0.6, 30, 26, TK), color: T.muted, fontVariantNumeric: "tabular-nums", ...oneLine }}>{restTxt}</span>
        </div>
      ) : null}
      <div style={{ position: "absolute", left: pad, right: pad, bottom: actionsH, height: 1.5, background: T.line, ...fade(ctx, c(1), 0.4, 0) }} />
      <div style={{ position: "absolute", left: pad - 10, right: pad - 10, bottom: 0, height: actionsH, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {actions.map(([ic, label], k) => {
          const like = k === 0;
          const col = like ? mix(T.muted, T.accent, liked) : T.muted;
          return (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 10px", ...fade(ctx, c(1.05) + k * 2) }}>
              <Toggle ctx={ctx} icon={ic} size={36} base={T.muted} color={T.accent} at={like ? likeAt : null} />
              <span style={{ fontFamily: FONT.text, fontSize: 29, color: col }}>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const VOTE_D = "M12 3.6c.3 0 .6.1.8.4l7.4 8.2c.5.6.1 1.5-.7 1.5H15.6v6.4c0 .6-.4 1-1 1H9.4c-.6 0-1-.4-1-1v-6.4H4.5c-.8 0-1.2-.9-.7-1.5L11.2 4c.2-.3.5-.4.8-.4z";

function VoteArrow({ size, color, filled, down }: { size: number; color: string; filled: number; down?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", overflow: "visible", transform: down ? "rotate(180deg)" : undefined }}>
      {filled > 0 ? <path d={VOTE_D} fill={color} opacity={filled} /> : null}
      <path d={VOTE_D} fill="none" stroke={color} strokeWidth={1.9} strokeLinejoin="round" />
    </svg>
  );
}

/** Forum post (FORUM): vote column, community · time, title, text, comment/share chips. */
function PostForum({ ctx }: { ctx: GCtx }) {
  const { props, frame } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const pad = 40;
  const colW = 96;
  const x0 = pad + colW + 22;
  const cw = W - x0 - pad;
  const community = props.subtitle?.trim() || "c/money";
  const meta = props.meta?.trim();
  const items = cleanItems(props.items, 4);
  const votes = items[0]?.value ?? null;
  const chips = items.slice(1);
  const c = clock(ctx, 3);
  const title = props.title?.trim() || "";
  const tFit = title ? fitText(title, cw, 2 * 46 * 1.18, { max: 46, min: 36, lh: 1.18, maxLines: 2 }) : null;
  const titleH = tFit ? tFit.lines.length * tFit.size * 1.18 : 0;
  const bodyTop = pad + 64 + titleH + (title ? 14 : 0);
  const footH = 64;
  const bodyH = Math.max(0, H - bodyTop - footH - pad - 22);
  const bodyTxt = props.body?.trim() || "";
  const body = bodyTxt && bodyH > 40 ? fitText(bodyTxt, cw, bodyH, { max: 34, min: 30, lh: 1.4, k: TK }) : null;
  const voteAt = c(2.2);
  const voted = prog(frame, voteAt, 5);
  const vPop = bump(ctx, voteAt, 0.4);
  const accent = T.accent;
  const voteTxt = votes != null ? socialCountAt(ctx, c(0.5), votes, 0, 2.8) : "Vote";
  const chipList: Array<{ icon: GraphicIcon; label: string }> = chips.length
    ? chips.map((it, i) => ({ icon: it.icon ?? (["CHAT", "SHARE", "BOOKMARK"] as GraphicIcon[])[i % 3]!, label: it.value != null ? `${socialCountAt(ctx, c(0.9), it.value, 0, 2.4)} ${it.text}`.trim() : it.text }))
    : [{ icon: "CHAT", label: "Comments" }, { icon: "SHARE", label: "Share" }];
  return (
    <div style={{ ...fill, ...card(T, 36), ...boxIn(ctx) }}>
      <div style={{ position: "absolute", left: pad - 8, top: pad - 4, width: colW + 8, display: "flex", flexDirection: "column", alignItems: "center", gap: 8, ...fade(ctx, c(0.15)) }}>
        <div style={{ transform: vPop ? `scale(${r4(1 + 0.3 * vPop)}) translateY(${r1(-6 * vPop)}px)` : undefined }}>
          <VoteArrow size={52} color={mix(T.muted, accent, voted)} filled={voted} />
        </div>
        <div style={{ fontFamily: FONT.display, fontSize: fitLine(voteTxt, colW + 4, 34, 26), color: mix(T.ink, accent, voted), fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{voteTxt}</div>
        <VoteArrow size={52} color={T.faint} filled={0} down />
      </div>
      <div style={{ position: "absolute", left: pad + colW + 10, top: pad - 10, bottom: pad - 10, width: 1.5, background: T.line }} />
      <div style={{ position: "absolute", left: x0, top: pad, width: cw, height: 48, display: "flex", alignItems: "center", gap: 14, ...fade(ctx, c(0.1)) }}>
        <Avatar name={community} size={46} />
        <span style={{ fontFamily: FONT.displayBold, fontSize: fitLine(community, cw * 0.6, 30, 28), color: T.ink, ...oneLine }}>{community}</span>
        {meta ? <span style={{ fontFamily: FONT.text, fontSize: 28, color: T.faint, flex: "none" }}>· {meta}</span> : null}
      </div>
      {tFit ? (
        <div style={{ position: "absolute", left: x0, top: pad + 64, width: cw }}>
          <Lines ctx={ctx} lines={tFit.lines} size={tFit.size} lh={1.18} color={T.ink} font={FONT.displayBold} start={c(0.25)} ls="-0.018em" />
        </div>
      ) : null}
      {body ? (
        <div style={{ position: "absolute", left: x0, top: bodyTop, width: cw }}>
          <Lines ctx={ctx} lines={body.lines} size={body.size} lh={1.4} color={mix(T.ink, T.muted, 0.35)} start={c(0.55)} />
        </div>
      ) : null}
      <div style={{ position: "absolute", left: x0, bottom: pad - 4, height: footH - 4, display: "flex", alignItems: "center", gap: 14 }}>
        {chipList.slice(0, 3).map((ch, i) => (
          <div key={i} style={{ height: 58, padding: "0 22px", borderRadius: 29, background: T.fill, display: "flex", alignItems: "center", gap: 10, ...fade(ctx, c(0.9) + i * 3) }}>
            <GIcon icon={ch.icon} size={32} color={T.muted} stroke={2} />
            <span style={{ fontFamily: FONT.text, fontSize: 28, color: T.muted, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{ch.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Photo post (PHOTO): header, a placeholder photo (double-tap heart), actions, likes, caption. */
function PostPhoto({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const name = nameOf(ctx);
  const place = props.subtitle?.trim();
  const meta = props.meta?.trim();
  const items = cleanItems(props.items, 4);
  const likes = items[0];
  const c = clock(ctx, 3);
  const headH = 120;
  const imgH = PHOTO_IMG_H;
  const actTop = headH + imgH + 16;
  const pad = 32;
  const tapAt = c(1.25);
  const big = frame >= tapAt ? springAt(frame, fps, tapAt, ctx.f.springs.punch, Math.round(0.6 * fps)) : 0;
  const bigFade = 1 - prog(frame, tapAt + Math.round(0.75 * fps), Math.round(0.3 * fps));
  const likeAt = tapAt + 3;
  const capTop = actTop + 64 + 12 + (likes ? 48 : 0);
  const capW = W - 2 * pad;
  const cap = props.body?.trim() || "";
  const capH = Math.max(46, H - capTop - (meta ? 46 : 0) - 28);
  const capFit = cap ? fitText(`${name} ${cap}`, capW, capH, { max: 32, min: 28, lh: 1.42, k: TK }) : null;
  const likesTxt = likes ? (likes.value != null ? `${socialCountAt(ctx, c(0.9), likes.value, 0, 2.4)} ${likes.text || "likes"}` : likes.text) : "";
  const zoom = 1.06 - 0.06 * prog(frame, 0, Math.max(1, ctx.D - ctx.exitFrames));
  return (
    <div style={{ ...fill, ...card(T, 40), overflow: "hidden", ...boxIn(ctx) }}>
      <div style={{ position: "absolute", left: pad, top: 22, ...popIn(ctx, c(0.06), 0.5) }}>
        <Avatar name={name} size={76} ring={mix(ctx.p.primary, ctx.p.secondary, 0.4)} />
      </div>
      <div style={{ position: "absolute", left: pad + 76 + 22, right: 96, top: place ? 22 : 40, ...fade(ctx, c(0.1)) }}>
        <div style={{ fontFamily: FONT.displayBold, fontSize: fitLine(name, W - 260, 36, 28), lineHeight: 1.2, color: T.ink, ...oneLine }}>{name}</div>
        {place ? <div style={{ fontFamily: FONT.text, fontSize: 28, lineHeight: 1.3, color: T.muted, ...oneLine }}>{place}</div> : null}
      </div>
      <div style={{ position: "absolute", right: pad, top: 40, ...fade(ctx, c(0.15)) }}>
        <GIcon icon="DOTS" size={44} color={T.faint} stroke={3} />
      </div>
      <div style={{ position: "absolute", left: 0, top: headH, width: W, height: imgH, overflow: "hidden", background: T.fill, ...fade(ctx, c(0.18), 0.5, 0) }}>
        <PhotoArt w={W} h={imgH} seed={place || name} zoom={zoom} />
        {big > 0 && bigFade > 0 ? (
          <div style={{ position: "absolute", left: W / 2 - 130, top: imgH / 2 - 120, width: 260, height: 240, opacity: bigFade, transform: `scale(${r4(Math.max(0, big) * (1 + 0.15 * (1 - bigFade)))})`, filter: `drop-shadow(0 12px 30px ${rgba("#000000", 0.35)})` }}>
            <FilledIcon d={BIG_HEART_D} size={260} color="#FFFFFF" />
          </div>
        ) : null}
      </div>
      <div style={{ position: "absolute", left: pad - 4, right: pad - 4, top: actTop, height: 64, display: "flex", alignItems: "center", gap: 30, ...fade(ctx, c(0.5)) }}>
        <Toggle ctx={ctx} icon="HEART" size={52} base={T.ink} color={LIKE} at={likeAt} fillD={HEART_D} />
        <GIcon icon="CHAT" size={50} color={T.ink} stroke={2} />
        <GIcon icon="SEND" size={48} color={T.ink} stroke={2} />
        <div style={{ marginLeft: "auto" }}>
          <GIcon icon="BOOKMARK" size={48} color={T.ink} stroke={2} />
        </div>
      </div>
      {likes ? <div style={{ position: "absolute", left: pad, right: pad, top: actTop + 72, fontFamily: FONT.displayBold, fontSize: fitLine(likesTxt, capW, 32, 28), lineHeight: 1.3, color: T.ink, fontVariantNumeric: "tabular-nums", ...oneLine, ...fade(ctx, c(0.85)) }}>{likesTxt}</div> : null}
      {capFit ? (
        <div style={{ position: "absolute", left: pad, top: capTop, width: capW }}>
          {capFit.lines.map((l, i) => {
            const st = fade(ctx, c(1) + i * 3);
            if (i === 0 && l.startsWith(name)) {
              return (
                <div key={i} style={{ fontFamily: FONT.text, fontSize: capFit.size, lineHeight: 1.42, color: T.ink, whiteSpace: "nowrap", ...st }}>
                  <span style={{ fontFamily: FONT.displayBold }}>{name}</span>
                  {l.slice(name.length)}
                </div>
              );
            }
            return <div key={i} style={{ fontFamily: FONT.text, fontSize: capFit.size, lineHeight: 1.42, color: T.ink, whiteSpace: "nowrap", ...st }}>{l}</div>;
          })}
        </div>
      ) : null}
      {meta ? <div style={{ position: "absolute", left: pad, bottom: 26, fontFamily: FONT.text, fontSize: 28, color: T.faint, ...fade(ctx, c(1.3)) }}>{meta}</div> : null}
    </div>
  );
}
const PHOTO_IMG_H = 700;

// ===================================================================== COMMENT

function Comment({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "PINNED":
      return <CommentPinned ctx={ctx} />;
    case "CHAIN":
      return <CommentChain ctx={ctx} />;
    case "QUESTION":
      return <CommentQuestion ctx={ctx} />;
    default:
      return <CommentReply ctx={ctx} />;
  }
}

/** "Reply to …'s comment" sticker: hugs its text, pops from its tail. */
function CommentReply({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const it = props.items[0];
  const who = it?.sub?.trim() || "Alex";
  const text = it?.text?.trim() || "";
  const pad = 36;
  const tail = 26;
  const head = props.title?.trim() || `Reply to ${who}'s comment`;
  const fit = fitText(text, W - 2 * pad, H - tail - pad - 32 - 64 - 14, { max: 42, min: 32, lh: 1.24, maxLines: 4 });
  const textW_ = Math.max(...fit.lines.map((l) => textW(l, fit.size)), 0);
  const headW = 64 + 16 + textW(head, 30, TK);
  const cw = Math.min(W, Math.max(textW_, headW) + 2 * pad + 8);
  const ch = H - tail;
  const x = (W - cw) / 2;
  const s = springAt(frame, fps, 0, ctx.f.springs.soft, Math.round(0.9 * fps));
  const ex = withExit(ctx, { opacity: prog(frame, 0, 5), transform: `scale(${r4(0.3 + 0.7 * Math.max(0, s))}) rotate(${r1((1 - Math.min(1, s)) * -6)}deg)` }, 0, 1);
  const bg = T.surface;
  const c = clock(ctx, 1.6);
  return (
    <div style={{ position: "absolute", left: x, top: 0, width: cw, height: H, ...css(ex), transformOrigin: "14% 100%" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: cw, height: ch, ...card(T, 34) }} />
      <svg width={60} height={tail + 4} viewBox={`0 0 60 ${tail + 4}`} style={{ position: "absolute", left: 40, top: ch - 2 }}>
        <path d={`M0 0 H48 Q22 6 6 ${tail + 2} Q10 10 0 0Z`} fill={bg} />
      </svg>
      <div style={{ position: "absolute", left: pad, top: 30, right: pad, height: 64, display: "flex", alignItems: "center", gap: 16, ...fade(ctx, c(0.12)) }}>
        <Avatar name={who} size={60} />
        <span style={{ fontFamily: FONT.text, fontSize: fitLine(head, cw - 2 * pad - 80, 30, 26, TK), color: T.muted, ...oneLine }}>{head}</span>
      </div>
      <div style={{ position: "absolute", left: pad, top: 30 + 64 + 12, width: cw - 2 * pad }}>
        <Lines ctx={ctx} lines={fit.lines} size={fit.size} lh={1.24} color={T.ink} font={FONT.displayBold} start={c(0.25)} ls="-0.015em" />
      </div>
    </div>
  );
}

/** Pinned comment card: pin row, author, text, like count. */
function CommentPinned({ ctx }: { ctx: GCtx }) {
  const { props } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const pad = 40;
  const it = props.items[0];
  const who = it?.sub?.trim() || "Your Name";
  const meta = it?.meta?.trim();
  const head = props.title?.trim() || `Pinned by ${who}`;
  const av = 76;
  const x0 = pad + av + 20;
  const likeW = it?.value != null ? 96 : 0;
  const cw = W - x0 - pad - likeW;
  const textTop = pad + 56 + 46;
  const fit = fitText(it?.text?.trim() || "", cw, H - textTop - pad - 6, { max: 38, min: 30, lh: 1.36, k: TK });
  const c = clock(ctx, 2.2);
  const likeAt = c(1.7);
  return (
    <div style={{ ...fill, ...card(T, 36), ...boxIn(ctx) }}>
      <div style={{ position: "absolute", left: pad, top: pad - 4, right: pad, height: 44, display: "flex", alignItems: "center", gap: 10, ...fade(ctx, c(0.1)) }}>
        <GIcon icon="PIN" size={30} color={T.accent} stroke={2.2} />
        <span style={{ fontFamily: FONT.text, fontSize: fitLine(head, W - 2 * pad - 40, 28, 26, TK), color: T.muted, ...oneLine }}>{head}</span>
      </div>
      <div style={{ position: "absolute", left: pad, top: pad + 56, ...popIn(ctx, c(0.15), 0.5) }}>
        <Avatar name={who} size={av} />
      </div>
      <div style={{ position: "absolute", left: x0, top: pad + 56, width: cw, height: 44, display: "flex", alignItems: "center", gap: 10, ...fade(ctx, c(0.2)) }}>
        <span style={{ fontFamily: FONT.displayBold, fontSize: fitLine(who, cw * 0.7, 32, 28), color: T.ink, ...oneLine }}>{who}</span>
        {meta ? <span style={{ fontFamily: FONT.text, fontSize: 28, color: T.faint, flex: "none" }}>{meta}</span> : null}
      </div>
      <div style={{ position: "absolute", left: x0, top: textTop, width: cw }}>
        <Lines ctx={ctx} lines={fit.lines} size={fit.size} lh={1.36} color={T.ink} start={c(0.35)} />
      </div>
      {it?.value != null ? (
        <div style={{ position: "absolute", right: pad - 8, top: pad + 66, width: likeW, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, ...fade(ctx, c(0.5)) }}>
          <Toggle ctx={ctx} icon="HEART" size={44} base={T.muted} color={LIKE} at={likeAt} fillD={HEART_D} />
          <span style={{ fontFamily: FONT.text, fontSize: 28, color: T.muted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{socialCountAt(ctx, c(0.5), it.value, 0, 2.4)}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Comment-chain metrics shared by the component and its box size. */
const CHAIN = { pad: 40, head: 80, av: 72, avMe: 58, indent: 92, nameH: 42, lh: 1.38, size: 34, foot: 46, gap: 26 };

/** A reply thread: comments stack in; ME replies are indented under a thread line. */
function CommentChain({ ctx }: { ctx: GCtx }) {
  const { props } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const items = cleanItems(props.items, 5);
  const n = items.length;
  const title = props.title?.trim();
  const C = CHAIN;
  const seq = listSequence(n, { ...ctx.anim, stagger: Math.max(0.35, ctx.anim.stagger) }, seqOpts(ctx, Math.round(0.25 * ctx.fps)));
  // Fit every comment at one shared size into the box.
  const avail = H - 2 * C.pad - (title ? C.head : 0) - (n - 1) * C.gap - n * (C.nameH + C.foot + 8);
  let size = C.size;
  let fits: Array<{ lines: string[] }> = [];
  for (; size >= 28; size -= 2) {
    fits = items.map((it) => {
      const me = it.side === "ME";
      const w = W - 2 * C.pad - (me ? C.indent + C.avMe : C.av) - 20;
      return fitText(it.text, w, 99999, { max: size, min: size, lh: C.lh, k: TK, maxLines: 4 });
    });
    const total = fits.reduce((a, f) => a + f.lines.length * size * C.lh, 0);
    if (total <= avail) break;
  }
  size = Math.max(28, size);
  let y = C.pad + (title ? C.head : 0);
  const rows = items.map((it, i) => {
    const h = C.nameH + 8 + fits[i]!.lines.length * size * C.lh + C.foot;
    const r = { it, i, y, h };
    y += h + C.gap;
    return r;
  });
  return (
    <div style={{ ...fill, ...card(T, 40), ...boxIn(ctx) }}>
      {title ? (
        <div style={{ position: "absolute", left: C.pad, right: C.pad, top: C.pad - 6, height: 56, display: "flex", alignItems: "center", gap: 12, ...fade(ctx, 2) }}>
          <GIcon icon="CHAT" size={36} color={T.accent} stroke={2.2} />
          <span style={{ fontFamily: FONT.displayBold, fontSize: fitLine(title, W - 2 * C.pad - 60, 38, 30), color: T.ink, letterSpacing: "-0.012em", ...oneLine }}>{title}</span>
        </div>
      ) : null}
      {rows.map(({ it, i, y: ry, h }) => {
        const me = it.side === "ME";
        const av = me ? C.avMe : C.av;
        const x = C.pad + (me ? C.indent : 0);
        const tx = x + av + 20;
        const who = it.sub?.trim() || (me ? "Your Name" : "Alex");
        const st = css(seqStyle(ctx, seq, 0, i, { distance: 0.6 }));
        const likeAt = seq.at(0, i) + seq.len + Math.round(0.2 * ctx.fps);
        const parentRow = me ? rows.slice(0, i).reverse().find((r) => r.it.side !== "ME") : null;
        return (
          <div key={i}>
            {parentRow && i > 0 ? (
              <div style={{ position: "absolute", left: C.pad + C.av / 2 - 1.5, top: parentRow.y + C.av + 10, width: C.indent - C.av / 2 + 6, height: ry + av / 2 - (parentRow.y + C.av + 10), borderLeft: `3px solid ${T.line}`, borderBottom: `3px solid ${T.line}`, borderBottomLeftRadius: 28, ...st }} />
            ) : null}
            <div style={{ position: "absolute", left: x, top: ry, ...st }}>
              <Avatar name={who} size={av} />
            </div>
            <div style={{ position: "absolute", left: tx, top: ry, right: C.pad, height: h, ...st }}>
              <div style={{ height: C.nameH, display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: FONT.displayBold, fontSize: fitLine(who, (W - tx - C.pad) * 0.66, 30, 28), color: T.ink, ...oneLine }}>{who}</span>
                {me ? <span style={{ flex: "none", padding: "2px 12px", borderRadius: 14, background: rgba(T.accent, 0.16), fontFamily: FONT.text, fontSize: 28, lineHeight: 1.2, color: T.accent }}>Creator</span> : null}
                {it.meta ? <span style={{ fontFamily: FONT.text, fontSize: 28, color: T.faint, flex: "none" }}>{it.meta}</span> : null}
              </div>
              <div style={{ marginTop: 8 }}>
                {fits[i]!.lines.map((l, k) => (
                  <div key={k} style={{ fontFamily: FONT.text, fontSize: size, lineHeight: C.lh, color: T.ink, whiteSpace: "nowrap" }}>{l}</div>
                ))}
              </div>
              <div style={{ height: C.foot, display: "flex", alignItems: "flex-end", gap: 28 }}>
                <span style={{ fontFamily: FONT.text, fontSize: 28, color: T.muted }}>Reply</span>
                {it.value != null ? (
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Toggle ctx={ctx} icon="HEART" size={30} base={T.muted} color={LIKE} at={i === 0 ? likeAt : null} fillD={HEART_D} />
                    <span style={{ fontFamily: FONT.text, fontSize: 28, color: T.muted, fontVariantNumeric: "tabular-nums" }}>{socialCountAt(ctx, seq.at(0, i), it.value, 0, 2.2)}</span>
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Q&A sticker: the question in a solid band, the answer types beneath it. */
function CommentQuestion({ ctx }: { ctx: GCtx }) {
  const { props, frame } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const it = props.items[0];
  const who = it?.sub?.trim() || "Sam";
  const q = props.title?.trim() || "Ask me anything";
  const ans = it?.text?.trim() || "";
  const pad = 40;
  const avS = 92;
  const bandTop = avS / 2;
  const bandH = 150;
  const qFit = fitText(q, W - 2 * pad, bandH - 64, { max: 40, min: 30, lh: 1.16, maxLines: 2 });
  const aTop = bandTop + bandH + 26;
  const aFit = fitText(ans, W - 2 * pad, H - aTop - pad, { max: 40, min: 32, lh: 1.26, maxLines: 4 });
  const c = clock(ctx, 1 + typeFrames(ctx, ans, 22) / ctx.fps + 0.2);
  const typeAt = c(0.75);
  const shown = typedChars(ctx, ans, typeAt, 22);
  const typing = frame >= typeAt && shown < ans.length;
  // map typed chars onto the fitted lines
  let left = shown;
  const solid = T.solid;
  return (
    <div style={{ ...fill, ...boxIn(ctx) }}>
      <div style={{ position: "absolute", left: 0, top: bandTop, right: 0, bottom: 0, ...card(T, 40), overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: bandH, background: `linear-gradient(135deg, ${mix(solid, "#FFFFFF", 0.14)} 0%, ${solid} 60%, ${mix(solid, "#000000", 0.18)} 100%)` }} />
      </div>
      <div style={{ position: "absolute", left: W / 2 - avS / 2, top: 0, ...popIn(ctx, c(0.1), 0.4) }}>
        <Avatar name={who} size={avS} ring={T.surface} />
      </div>
      <div style={{ position: "absolute", left: pad, right: pad, top: bandTop + 52, height: bandH - 64, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
        <Lines ctx={ctx} lines={qFit.lines} size={qFit.size} lh={1.16} color={T.onSolid} font={FONT.displayBold} start={c(0.2)} align="center" ls="-0.015em" />
      </div>
      <div style={{ position: "absolute", left: pad, right: pad, top: aTop }}>
        {aFit.lines.map((l, i) => {
          const take = Math.max(0, Math.min(l.length, left));
          left -= l.length + 1;
          const last = typing && take < l.length + 1 && take >= 0 && left < 0 && left + l.length + 1 >= 0;
          return (
            <div key={i} style={{ fontFamily: FONT.displayBold, fontSize: aFit.size, lineHeight: 1.26, color: T.ink, whiteSpace: "nowrap", letterSpacing: "-0.012em", textAlign: "center", minHeight: aFit.size * 1.26 }}>
              {l.slice(0, take)}
              {last ? <Caret ctx={ctx} color={T.accent} height={aFit.size * 0.95} /> : null}
            </div>
          );
        })}
        {frame < typeAt ? <div style={{ position: "absolute", left: 0, right: 0, top: 0, textAlign: "center", fontFamily: FONT.text, fontSize: 34, color: T.faint, ...fade(ctx, c(0.4)) }}>Type something…</div> : null}
      </div>
    </div>
  );
}

// ===================================================================== TRENDING

function Trending({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "CHIPS":
      return <TrendChips ctx={ctx} />;
    case "RISING":
      return <TrendRising ctx={ctx} />;
    default:
      return <TrendList ctx={ctx} />;
  }
}

function TrendHeader({ ctx, T, pad, icon = "CHART_UP" }: { ctx: GCtx; T: Tone; pad: number; icon?: GraphicIcon }) {
  const title = ctx.props.title?.trim() || "Trending";
  return (
    <div style={{ position: "absolute", left: pad, right: pad, top: pad - 4, height: 60, display: "flex", alignItems: "center", gap: 14, ...fade(ctx, 2) }}>
      <div style={{ width: 52, height: 52, borderRadius: 16, background: rgba(T.accent, 0.16), display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
        <GIcon icon={icon} size={32} color={T.accent} stroke={2.2} />
      </div>
      <span style={{ fontFamily: FONT.displayBold, fontSize: fitLine(title, ctx.width - 2 * pad - 70, 42, 32), color: T.ink, letterSpacing: "-0.018em", ...oneLine }}>{title}</span>
    </div>
  );
}

const TREND = { pad: 44, head: 80, row: 146 };

function postsLabel(ctx: GCtx, it: GraphicItem, start: number): string {
  if (it.value == null) return it.sub?.trim() || "";
  const n = socialCountAt(ctx, start, it.value, 0, 2.2);
  return it.sub?.trim() ? `${it.sub.trim()} · ${n} posts` : `${n} posts`;
}

/** Ranked list: context line, topic, post count; the highlighted row glows. */
function TrendList({ ctx }: { ctx: GCtx }) {
  const { props } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const items = cleanItems(props.items, 6);
  const n = items.length;
  const pad = TREND.pad;
  const seq = listSequence(n, ctx.anim, seqOpts(ctx, Math.round(0.25 * ctx.fps)));
  const hi = props.highlight != null && props.highlight < n ? props.highlight : null;
  const em = emphasisAt(ctx, seq.done);
  return (
    <div style={{ ...fill, ...card(T, 40), ...boxIn(ctx) }}>
      <TrendHeader ctx={ctx} T={T} pad={pad} />
      {items.map((it, i) => {
        const y = pad + TREND.head + i * TREND.row;
        const isHi = hi === i;
        const dim = hi != null && !isHi ? 1 - 0.35 * em.on : 1;
        const meta = it.meta?.trim() || `${i + 1} · Trending`;
        const sub = postsLabel(ctx, it, seq.at(0, i));
        const st = css(seqStyle(ctx, seq, 0, i));
        return (
          <div key={i} style={{ position: "absolute", left: pad - 18, right: pad - 18, top: y, height: TREND.row - 8, ...st }}>
            <div style={{ position: "absolute", inset: 0, borderRadius: 22, background: isHi ? rgba(T.accent, 0.13 * em.on) : "transparent", boxShadow: isHi && em.on > 0 ? `inset 0 0 0 2px ${rgba(T.accent, 0.4 * em.on)}` : undefined, transform: isHi ? `scale(${r4(em.scale)})` : undefined }} />
            <div style={{ position: "absolute", left: 18, right: 70, top: 12, opacity: dim }}>
              <div style={{ fontFamily: FONT.text, fontSize: 28, lineHeight: 1.2, color: T.muted, ...oneLine }}>{meta}</div>
              <div style={{ fontFamily: FONT.displayBold, fontSize: fitLine(it.text, W - 2 * pad - 70, 40, 30), lineHeight: 1.22, color: isHi ? mix(T.ink, T.accent, em.on) : T.ink, letterSpacing: "-0.015em", ...oneLine }}>{it.text}</div>
              {sub ? <div style={{ fontFamily: FONT.text, fontSize: 28, lineHeight: 1.2, color: T.muted, fontVariantNumeric: "tabular-nums", ...oneLine }}>{sub}</div> : null}
            </div>
            <div style={{ position: "absolute", right: 18, top: 16, opacity: dim * 0.9 }}>
              <GIcon icon="DOTS" size={38} color={T.faint} stroke={3} />
            </div>
            {i < n - 1 ? <div style={{ position: "absolute", left: 18, right: 18, bottom: -5, height: 1.5, background: T.line }} /> : null}
          </div>
        );
      })}
    </div>
  );
}

/** Hashtag chips (two columns): pop in; the highlighted chip fills with the accent. */
function TrendChips({ ctx }: { ctx: GCtx }) {
  const { props } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const items = cleanItems(props.items, 6);
  const n = items.length;
  const pad = TREND.pad;
  const gap = 20;
  const chipW = (W - 2 * pad - gap) / 2;
  const chipH = 100;
  const seq = listSequence(n, ctx.anim, seqOpts(ctx, Math.round(0.25 * ctx.fps)));
  const popStyle = ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter;
  const hi = props.highlight != null && props.highlight < n ? props.highlight : null;
  const em = emphasisAt(ctx, seq.done);
  return (
    <div style={{ ...fill, ...card(T, 40), ...boxIn(ctx) }}>
      <TrendHeader ctx={ctx} T={T} pad={pad} icon="FIRE" />
      {items.map((it, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const lone = n % 2 === 1 && i === n - 1;
        const x = lone ? (W - chipW) / 2 : pad + col * (chipW + gap);
        const y = pad + TREND.head + row * (chipH + gap);
        const isHi = hi === i;
        const on = isHi ? em.on : 0;
        const tag = it.text.trim().startsWith("#") ? it.text.trim() : `#${it.text.trim()}`;
        const bodyTxt = tag.slice(1);
        const cnt = it.value != null ? `${socialCountAt(ctx, seq.at(0, i), it.value, 0, 2.2)} posts` : it.sub?.trim() || "";
        const ink = on > 0.5 ? T.onSolid : T.ink;
        const textWd = chipW - 100;
        return (
          <div key={i} style={{ position: "absolute", left: x, top: y, width: chipW, height: chipH, ...css(seqStyle(ctx, seq, 0, i, { style: popStyle })) }}>
            <div style={{ position: "absolute", inset: 0, borderRadius: chipH / 2, background: on > 0 ? blendBg(T.fill, T.solid, on) : T.fill, boxShadow: `inset 0 0 0 1.5px ${T.line}`, transform: isHi ? `scale(${r4(em.scale)})` : undefined }} />
            <div style={{ position: "absolute", left: 16, top: 16, width: 68, height: 68, borderRadius: 34, background: on > 0.5 ? rgba(T.onSolid, 0.18) : rgba(T.accent, 0.16), display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, fontSize: 38, color: on > 0.5 ? T.onSolid : T.accent }}>#</div>
            <div style={{ position: "absolute", left: 100, right: 22, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div style={{ fontFamily: FONT.displayBold, fontSize: fitLine(bodyTxt, textWd, 36, 28), lineHeight: 1.15, color: ink, letterSpacing: "-0.012em", ...oneLine }}>{bodyTxt}</div>
              {cnt ? <div style={{ fontFamily: FONT.text, fontSize: 28, lineHeight: 1.2, color: on > 0.5 ? rgba(T.onSolid, 0.8) : T.muted, fontVariantNumeric: "tabular-nums", ...oneLine }}>{cnt}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One rising topic: context, topic, a count that climbs and a rising line that draws. */
function TrendRising({ ctx }: { ctx: GCtx }) {
  const { props, frame } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const pad = TREND.pad;
  const it = props.items[0];
  const topic = it?.text?.trim() || "Topic";
  const meta = it?.meta?.trim() || "Trending now";
  const sub = it?.sub?.trim();
  const c = clock(ctx, 2.6);
  const y0 = pad + TREND.head;
  const chartTop = y0 + 36 + 70 + (sub ? 40 : 0) + 22;
  const chartH = H - chartTop - pad;
  const chartW = W - 2 * pad;
  const draw = prog(frame, c(0.6), Math.max(2, c(2.0) - c(0.6)), ctx.ease);
  const gid = `soc-rise-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const N = 22;
  const pts = Array.from({ length: N }, (_, i) => {
    const x = i / (N - 1);
    const yv = 0.08 + 0.84 * x ** 2.6 + (hash01(i + 3) - 0.5) * 0.07 * (1 - x * 0.7);
    return [x * chartW, chartH - 12 - Math.max(0, Math.min(1, yv)) * (chartH - 30)] as const;
  });
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${r1(x)} ${r1(y)}`).join(" ");
  const area = `${d} L${chartW} ${chartH} L0 ${chartH} Z`;
  const end = pts[N - 1]!;
  const count = it?.value != null ? socialCountAt(ctx, c(0.6), it.value, 0, 2.6) : null;
  const pulse = 0.5 + 0.5 * Math.sin((frame / ctx.fps) * Math.PI * 2 * 1.2);
  const accent = T.accent;
  return (
    <div style={{ ...fill, ...card(T, 40), ...boxIn(ctx) }}>
      <TrendHeader ctx={ctx} T={T} pad={pad} />
      <div style={{ position: "absolute", left: pad, right: pad, top: y0, ...fade(ctx, c(0.15)) }}>
        <div style={{ fontFamily: FONT.text, fontSize: 28, lineHeight: "36px", color: T.muted, ...oneLine }}>{meta}</div>
      </div>
      <div style={{ position: "absolute", left: pad, right: pad + 230, top: y0 + 36, height: 70, display: "flex", alignItems: "center", ...fade(ctx, c(0.25)) }}>
        <span style={{ fontFamily: FONT.display, fontSize: fitLine(topic, W - 2 * pad - 240, 58, 34), color: T.ink, letterSpacing: "-0.025em", ...oneLine }}>{topic}</span>
      </div>
      <div style={{ position: "absolute", right: pad, top: y0 + 44, height: 56, padding: "0 20px", borderRadius: 28, background: rgba(T.positive, 0.15), display: "flex", alignItems: "center", gap: 8, ...popIn(ctx, c(1.2), 0.4) }}>
        <GIcon icon="ARROW_UP" size={30} color={T.positive} stroke={2.6} />
        <span style={{ fontFamily: FONT.display, fontSize: 30, color: T.positive }}>Rising</span>
      </div>
      {sub || count ? (
        <div style={{ position: "absolute", left: pad, right: pad, top: y0 + 36 + 72, fontFamily: FONT.text, fontSize: 30, lineHeight: "38px", color: T.muted, fontVariantNumeric: "tabular-nums", ...oneLine, ...fade(ctx, c(0.4)) }}>
          {count ? <span style={{ color: T.ink, fontFamily: FONT.displayBold }}>{count} posts</span> : null}
          {sub ? `${count ? " · " : ""}${sub}` : null}
        </div>
      ) : null}
      <svg width={chartW} height={chartH} viewBox={`0 0 ${chartW} ${chartH}`} style={{ position: "absolute", left: pad, top: chartTop, overflow: "visible" }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={accent} stopOpacity={0.32} />
            <stop offset="1" stopColor={accent} stopOpacity={0} />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={0} x2={chartW} y1={r1(chartH * g)} y2={r1(chartH * g)} stroke={T.line} strokeWidth={1.5} strokeDasharray="4 10" />
        ))}
        <path d={area} fill={`url(#${gid})`} style={{ clipPath: `inset(0 ${r1((1 - draw) * 100)}% 0 0)` }} />
        <path d={d} fill="none" stroke={accent} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={r4(1 - draw)} />
        {draw >= 0.999 ? (
          <>
            <circle cx={end[0]} cy={end[1]} r={14 + 10 * pulse} fill={accent} opacity={0.18} />
            <circle cx={end[0]} cy={end[1]} r={11} fill={accent} stroke={T.surface} strokeWidth={4} />
          </>
        ) : null}
      </svg>
    </div>
  );
}

// ===================================================================== VIDEO_CARD

function VideoCard({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "PLAYER":
      return <VideoPlayer ctx={ctx} />;
    case "SUBSCRIBE":
      return <VideoSubscribe ctx={ctx} />;
    case "VIEWS":
      return <VideoViews ctx={ctx} />;
    default:
      return <VideoTile ctx={ctx} />;
  }
}

const TILE = { pad: 22, thumbH: 482, gap: 24, lh: 1.22, size: 38 };

/** Video tile: thumbnail (generic play glyph, duration badge), avatar, title, channel · meta. */
function VideoTile({ ctx }: { ctx: GCtx }) {
  const { props, frame } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const { pad, thumbH } = TILE;
  const thumbW = W - 2 * pad;
  const title = props.title?.trim() || "Untitled video";
  const channel = props.subtitle?.trim() || "Your Name";
  const meta = props.meta?.trim();
  const dur = props.items[0]?.text?.trim() || "";
  const c = clock(ctx, 2);
  const infoTop = pad + thumbH + TILE.gap;
  const tx = pad + 72 + 22;
  const tw = W - tx - pad - 40;
  const subLine = [channel, meta].filter(Boolean).join(" · ");
  const tFit = fitText(title, tw, H - infoTop - 44 - pad, { max: TILE.size, min: 30, lh: TILE.lh, maxLines: 2 });
  const zoom = 1.08 - 0.08 * prog(frame, 0, Math.max(1, ctx.D - ctx.exitFrames));
  const hover = prog(frame, c(1.1), Math.round(0.3 * ctx.fps));
  return (
    <div style={{ ...fill, ...card(T, 36), ...boxIn(ctx) }}>
      <div style={{ position: "absolute", left: pad, top: pad, width: thumbW, height: thumbH, borderRadius: 26, overflow: "hidden", ...fade(ctx, c(0.05), 0.5, 0) }}>
        <div style={{ position: "absolute", inset: 0, transform: `scale(${r4(zoom)})` }}>
          <ThumbArt ctx={ctx} w={thumbW} h={thumbH} seed={title} />
        </div>
        <div style={{ position: "absolute", left: thumbW / 2 - 70, top: thumbH / 2 - 70, transform: `scale(${r4(1 + 0.08 * hover)})`, ...popIn(ctx, c(0.4), 0.3) }}>
          <PlayGlyph size={140} />
        </div>
        {dur ? (
          <div style={{ position: "absolute", right: 18, bottom: 18, padding: "4px 14px", borderRadius: 12, background: rgba("#000000", 0.78), fontFamily: FONT.displayBold, fontSize: 30, lineHeight: 1.2, color: "#FFFFFF", fontVariantNumeric: "tabular-nums", ...fade(ctx, c(0.55), 0.3, 6) }}>{dur}</div>
        ) : null}
      </div>
      <div style={{ position: "absolute", left: pad, top: infoTop, ...popIn(ctx, c(0.5), 0.5) }}>
        <Avatar name={channel} size={72} />
      </div>
      <div style={{ position: "absolute", left: tx, top: infoTop - 4, width: tw }}>
        <Lines ctx={ctx} lines={tFit.lines} size={tFit.size} lh={TILE.lh} color={T.ink} font={FONT.displayBold} start={c(0.6)} ls="-0.015em" />
        <div style={{ marginTop: 6, fontFamily: FONT.text, fontSize: fitLine(subLine, tw, 30, 28, TK), lineHeight: 1.3, color: T.muted, ...oneLine, ...fade(ctx, c(0.85)) }}>{subLine}</div>
      </div>
      <div style={{ position: "absolute", right: pad - 6, top: infoTop + 2, ...fade(ctx, c(0.9)) }}>
        <GIcon icon="DOTS" size={40} color={T.faint} stroke={3} />
      </div>
    </div>
  );
}

const PLAYER = { videoH: 551, info: 174 };

/** Player: placeholder video, progress bar split into chapters, playhead + chapter label. */
function VideoPlayer({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const vh = PLAYER.videoH;
  const title = props.title?.trim() || "Untitled video";
  const channel = props.subtitle?.trim() || "Your Name";
  const meta = props.meta?.trim();
  const chapters = cleanItems(props.items, 6).map((it, i) => ({ text: it.text || `Chapter ${i + 1}`, at: Math.max(0, it.value ?? i * 60) })).sort((a, b) => a.at - b.at);
  const nC = chapters.length;
  const lastGap = nC > 1 ? (chapters[nC - 1]!.at - chapters[0]!.at) / (nC - 1) : 300;
  const total = nC ? chapters[nC - 1]!.at + Math.max(30, lastGap) : 600;
  const hi = props.highlight != null && props.highlight < nC ? props.highlight : null;
  const target = hi != null ? (chapters[hi]!.at + (chapters[hi + 1]?.at ?? total)) / 2 / total : 0.62;
  const c = clock(ctx, 3);
  const play = prog(frame, c(0.5), Math.max(1, c(2.6) - c(0.5)), (t) => 1 - (1 - t) ** 2);
  const pos = target * play;
  const cur = chapters.reduce((a, ch, i) => (ch.at / total <= pos + 1e-6 ? i : a), 0);
  const barX = 36;
  const barW = W - 72;
  const barY = vh - 66;
  const accent = readableOn(ctx.p.primary, "#101016", 4);
  const zoom = 1.04 + 0.04 * Math.sin(frame / fps / 2);
  const tSize = fitLine(title, W - 72, 40, 32);
  const sub = [channel, meta].filter(Boolean).join(" · ");
  return (
    <div style={{ ...fill, ...card(T, 36), overflow: "hidden", ...boxIn(ctx) }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: W, height: vh, overflow: "hidden", background: "#0B0B10" }}>
        <div style={{ position: "absolute", inset: 0, transform: `scale(${r4(zoom)})` }}>
          <ThumbArt ctx={ctx} w={W} h={vh} seed={title} />
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 200, background: `linear-gradient(0deg, ${rgba("#000000", 0.72)} 0%, transparent 100%)` }} />
        <div style={{ position: "absolute", left: W / 2 - 60, top: vh / 2 - 90, opacity: 1 - prog(frame, c(0.5), 8) }}>
          <PlayGlyph size={120} />
        </div>
        {nC ? (
          <div style={{ position: "absolute", left: barX, top: barY - 52, right: barX, height: 44, display: "flex", alignItems: "center", gap: 10, ...fade(ctx, c(0.35)) }}>
            <span style={{ fontFamily: FONT.text, fontSize: 30, color: "#FFFFFF", fontVariantNumeric: "tabular-nums", flex: "none" }}>{hhmmss(pos * total)} / {hhmmss(total)}</span>
            <span style={{ fontFamily: FONT.text, fontSize: 30, color: rgba("#FFFFFF", 0.6), flex: "none" }}>·</span>
            <span style={{ fontFamily: FONT.displayBold, fontSize: fitLine(chapters[cur]!.text, barW - 360, 30, 28), color: "#FFFFFF", ...oneLine }}>{chapters[cur]!.text}</span>
            <svg width={20} height={30} viewBox="0 0 20 30" style={{ flex: "none" }}>
              <path d="M6 7l8 8l-8 8" fill="none" stroke="#FFFFFF" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        ) : null}
        <div style={{ position: "absolute", left: barX, top: barY, width: barW, height: 10, ...fade(ctx, c(0.3), 0.4, 0) }}>
          {(nC ? chapters : [{ text: "", at: 0 }]).map((ch, i, arr) => {
            const a = ch.at / total;
            const b = (arr[i + 1]?.at ?? total) / total;
            const filled = clamp01((pos - a) / Math.max(1e-6, b - a));
            const isCur = i === cur;
            return (
              <div key={i} style={{ position: "absolute", left: r1(a * barW + (i ? 4 : 0)), width: r1(Math.max(4, (b - a) * barW - (i ? 4 : 0))), top: isCur ? -2 : 0, height: isCur ? 14 : 10, borderRadius: 7, background: rgba("#FFFFFF", 0.32), overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${r1(filled * 100)}%`, background: accent }} />
              </div>
            );
          })}
          <div style={{ position: "absolute", left: r1(pos * barW - 14), top: -9, width: 28, height: 28, borderRadius: 14, background: accent, boxShadow: `0 0 0 4px ${rgba("#FFFFFF", 0.25)}, 0 4px 12px ${rgba("#000000", 0.5)}` }} />
        </div>
      </div>
      <div style={{ position: "absolute", left: 36, right: 36, top: vh + 26, ...fade(ctx, c(0.45)) }}>
        <div style={{ fontFamily: FONT.displayBold, fontSize: tSize, lineHeight: 1.2, color: T.ink, letterSpacing: "-0.015em", ...oneLine }}>{title}</div>
      </div>
      <div style={{ position: "absolute", left: 36, right: 36, top: vh + 92, height: 60, display: "flex", alignItems: "center", gap: 16, ...fade(ctx, c(0.6)) }}>
        <Avatar name={channel} size={56} />
        <span style={{ fontFamily: FONT.text, fontSize: fitLine(sub, W - 180, 30, 28, TK), color: T.muted, ...oneLine }}>{sub}</span>
      </div>
    </div>
  );
}

/** Subscribe: the button gets pressed → "Subscribed" + a bell that rings. */
function VideoSubscribe({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const pad = 36;
  const av = H - 2 * pad;
  const channel = props.title?.trim() || "Your Name";
  const subs = props.items[0]?.value ?? null;
  const subLabel = props.items[0]?.text?.trim() || "subscribers";
  const handle = props.subtitle?.trim();
  const c = clock(ctx, 2.4);
  const tap = c(1.35);
  const pr = frame >= tap && frame < tap + 5 ? Math.sin(((frame - tap) / 5) * Math.PI) : 0;
  const done = prog(frame, tap + 2, 6);
  const rip = frame >= tap ? clamp01((frame - tap) / Math.round(0.45 * fps)) : 0;
  const btnH = 84;
  const pre = { w: 250, label: "Subscribe" };
  const post = { w: 270, label: "Subscribed" };
  const bw = pre.w + (post.w - pre.w) * done;
  const bell = 84;
  const bellIn = done;
  const right = pad;
  const btnX = W - right - (bell + 16) * bellIn - bw;
  const colX = pad + av + 26;
  const colW = btnX - colX - 20;
  const preBg = T.dark ? "#FFFFFF" : "#111116";
  const preInk = T.dark ? "#0C0B10" : "#FFFFFF";
  const ringAge = frame - (tap + 8);
  const ring = ringAge > 0 ? Math.sin(ringAge * 0.95) * 18 * Math.max(0, 1 - ringAge / Math.round(0.9 * fps)) : 0;
  const line2 = [handle, subs != null ? `${socialCountAt(ctx, c(0.4), subs, 0, 2.4)} ${subLabel}` : subLabel].filter(Boolean).join(" · ");
  return (
    <div style={{ ...fill, ...card(T, 48), ...boxIn(ctx) }}>
      <div style={{ position: "absolute", left: pad, top: pad, ...popIn(ctx, c(0.08), 0.5) }}>
        <Avatar name={channel} size={av} />
      </div>
      <div style={{ position: "absolute", left: colX, width: colW, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center", ...fade(ctx, c(0.15)) }}>
        <div style={{ fontFamily: FONT.displayBold, fontSize: fitLine(channel, colW, 42, 30), lineHeight: 1.2, color: T.ink, letterSpacing: "-0.015em", ...oneLine }}>{channel}</div>
        <div style={{ marginTop: 4, fontFamily: FONT.text, fontSize: fitLine(line2, colW, 30, 26, TK), lineHeight: 1.25, color: T.muted, fontVariantNumeric: "tabular-nums", ...oneLine }}>{line2}</div>
      </div>
      <div style={{ position: "absolute", left: btnX, top: (H - btnH) / 2, width: bw, height: btnH, borderRadius: btnH / 2, overflow: "hidden", background: blendBg(T.fill2, preBg, 1 - done), transform: `scale(${r4(1 - 0.08 * pr)})`, ...popIn(ctx, c(0.35), 0.6) }}>
        {rip > 0 && rip < 1 ? <div style={{ position: "absolute", left: bw / 2 - 150, top: btnH / 2 - 150, width: 300, height: 300, borderRadius: "50%", background: rgba(T.dark ? "#000000" : "#FFFFFF", 0.25 * (1 - rip)), transform: `scale(${r4(0.1 + rip)})` }} /> : null}
        <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, fontSize: 34, color: preInk, opacity: 1 - done, letterSpacing: "-0.01em" }}>{pre.label}</div>
        <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontFamily: FONT.display, fontSize: 34, color: T.ink, opacity: done, letterSpacing: "-0.01em" }}>
          <GIcon icon="CHECK" size={30} color={T.ink} stroke={2.8} draw={prog(frame, tap + 3, 8)} />
          {post.label}
        </div>
      </div>
      {bellIn > 0 ? (
        <div style={{ position: "absolute", right, top: (H - bell) / 2, width: bell, height: bell, borderRadius: bell / 2, background: T.fill2, display: "flex", alignItems: "center", justifyContent: "center", opacity: bellIn, transform: `scale(${r4(0.5 + 0.5 * bellIn)})` }}>
          <div style={{ transform: `rotate(${r1(ring)}deg)`, transformOrigin: "50% 15%" }}>
            <GIcon icon="BELL" size={44} color={T.ink} stroke={2.2} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** View counter: an odometer that keeps ticking up. */
function VideoViews({ ctx }: { ctx: GCtx }) {
  const { props, frame } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const pad = 44;
  const final = Math.max(0, Math.round(props.items[0]?.value ?? 1000000));
  const startV = props.items[1]?.value != null ? Math.max(0, Math.min(final, props.items[1].value)) : Math.round(final * 0.985);
  const label = props.items[0]?.text?.trim() || "views";
  const title = props.title?.trim();
  const sub = [props.subtitle?.trim(), props.meta?.trim()].filter(Boolean).join(" · ");
  const c = clock(ctx, 1);
  const endAt = Math.max(c(0.6) + 10, ctx.D - ctx.exitFrames - Math.round(0.6 * ctx.fps));
  const t = prog(frame, c(0.35), endAt - c(0.35), (x) => 1 - (1 - x) ** 1.6);
  const v = startV + (final - startV) * (ctx.anim.countUp ? t : 1);
  const disc = 104;
  const numX = pad + disc + 28;
  const numW = W - numX - pad;
  const labelW = textW(label, 36, TK) + 16;
  const size = Math.max(56, Math.min(112, Math.floor((numW - labelW) / (odometerWidth(final, 1) || 1))));
  const topY = title ? pad + 50 : pad;
  const rowH = H - topY - pad - (sub ? 46 : 0);
  return (
    <div style={{ ...fill, ...card(T, 44), ...boxIn(ctx) }}>
      {title ? <div style={{ position: "absolute", left: pad, right: pad, top: pad - 6, fontFamily: FONT.text, fontSize: fitLine(title, W - 2 * pad, 32, 28, TK), lineHeight: 1.3, color: T.muted, ...oneLine, ...fade(ctx, c(0.1)) }}>{title}</div> : null}
      <div style={{ position: "absolute", left: pad, top: topY + (rowH - disc) / 2, width: disc, height: disc, borderRadius: disc / 2, background: rgba(T.accent, 0.15), display: "flex", alignItems: "center", justifyContent: "center", ...popIn(ctx, c(0.15), 0.4) }}>
        <GIcon icon="EYE" size={58} color={T.accent} stroke={2} draw={prog(frame, c(0.2), Math.round(0.5 * ctx.fps))} />
      </div>
      <div style={{ position: "absolute", left: numX, top: topY, height: rowH, width: numW, display: "flex", alignItems: "center", gap: 16, ...fade(ctx, c(0.25)) }}>
        <Odometer value={v} final={final} size={size} color={T.ink} />
        <span style={{ fontFamily: FONT.text, fontSize: 36, color: T.muted, alignSelf: "center", marginTop: size * 0.18 }}>{label}</span>
      </div>
      {sub ? (
        <div style={{ position: "absolute", left: pad, right: pad, bottom: pad - 4, height: 40, display: "flex", alignItems: "center", gap: 10, ...fade(ctx, c(0.5)) }}>
          <div style={{ width: 12, height: 12, borderRadius: 6, background: T.positive, opacity: 0.5 + 0.5 * Math.abs(Math.sin((frame / ctx.fps) * Math.PI)) }} />
          <span style={{ fontFamily: FONT.text, fontSize: 30, color: T.positive, ...oneLine }}>{sub}</span>
        </div>
      ) : null}
    </div>
  );
}

// ===================================================================== STORY

function Story({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "QUESTION":
      return <StoryQuestion ctx={ctx} />;
    case "SLIDER":
      return <StorySlider ctx={ctx} />;
    case "QUIZ":
      return <StoryQuiz ctx={ctx} />;
    default:
      return <StoryPoll ctx={ctx} />;
  }
}

/** A story sticker pops in (spring + tilt) — stickers sit on the video. */
function stickerIn(ctx: GCtx): CSSProperties {
  const s = springAt(ctx.frame, ctx.fps, 0, ctx.f.springs.soft, Math.round(0.9 * ctx.fps));
  const st = ctx.anim.enter === "RISE" || ctx.anim.enter === "POP" ? { opacity: prog(ctx.frame, 0, 5), transform: `scale(${r4(0.4 + 0.6 * Math.max(0, s))}) rotate(${r1((1 - Math.min(1, s)) * -5)}deg)` } : enterStyle(ctx, 0, Math.round(0.5 * ctx.fps), { blurOK: true });
  return css(withExit(ctx, st, 0, 1));
}

const STORY = { pad: 40, lh: 1.16, tSize: 44, opt: 96, gap: 16 };

/** Poll: options as pills; one gets tapped, results fill in and percentages count. */
function StoryPoll({ ctx }: { ctx: GCtx }) {
  const { props, frame } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const items = cleanItems(props.items, 4);
  const opts = items.length ? items : [{ text: "Yes", value: 50 } as GraphicItem, { text: "No", value: 50 } as GraphicItem];
  const n = opts.length;
  const { pad } = STORY;
  const title = props.title?.trim() || "";
  const tFit = fitText(title, W - 2 * pad, STORY.tSize * STORY.lh * 3, { max: STORY.tSize, min: 34, lh: STORY.lh, maxLines: 3 });
  const tH = title ? tFit.lines.length * tFit.size * STORY.lh : 0;
  const optTop = pad + tH + (title ? 28 : 0);
  const c = clock(ctx, 2.8);
  const seq = listSequence(n, { ...ctx.anim, stagger: Math.max(0.08, ctx.anim.stagger) }, seqOpts(ctx, c(0.35)));
  const vals = opts.map((o) => Math.max(0, o.value ?? 0));
  const sum = vals.reduce((a, b) => a + b, 0) || 1;
  const pct = vals.map((v) => (v / sum) * 100);
  const chosen = props.highlight != null && props.highlight < n ? props.highlight : pct.indexOf(Math.max(...pct));
  const tap = Math.max(seq.done, c(1.3));
  const res = prog(frame, tap + 4, Math.round(0.8 * ctx.fps), ctx.ease);
  const solid = T.solid;
  return (
    <div style={{ ...fill, ...card(T, 40), ...stickerIn(ctx) }}>
      {title ? (
        <div style={{ position: "absolute", left: pad, right: pad, top: pad }}>
          <Lines ctx={ctx} lines={tFit.lines} size={tFit.size} lh={STORY.lh} color={T.ink} font={FONT.display} start={c(0.12)} align="center" ls="-0.02em" />
        </div>
      ) : null}
      {opts.map((o, i) => {
        const y = optTop + i * (STORY.opt + STORY.gap);
        const isC = i === chosen;
        const pr = isC ? bump(ctx, tap, 0.25) : 0;
        const p = Math.round(pct[i]! * (ctx.anim.countUp ? res : res > 0 ? 1 : 0));
        const barW = (W - 2 * pad) * (pct[i]! / 100) * res;
        const ink = T.ink;
        return (
          <div key={i} style={{ position: "absolute", left: pad, right: pad, top: y, height: STORY.opt, ...css(seqStyle(ctx, seq, 0, i)) }}>
            <div style={{ position: "absolute", inset: 0, borderRadius: STORY.opt / 2, background: T.fill, overflow: "hidden", transform: pr ? `scale(${r4(1 - 0.04 * pr)})` : undefined, boxShadow: isC && res > 0 ? `inset 0 0 0 2.5px ${rgba(solid, 0.7 * res)}` : `inset 0 0 0 1.5px ${T.line}` }}>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: barW, borderRadius: STORY.opt / 2, background: isC ? `linear-gradient(90deg, ${mix(solid, "#FFFFFF", 0.25)}, ${solid})` : T.fill2 }} />
            </div>
            <div style={{ position: "absolute", left: 34, right: 130, top: 0, bottom: 0, display: "flex", alignItems: "center", gap: 12 }}>
              {isC && res > 0 ? <GIcon icon="CHECK" size={32} color={barW > 60 ? T.onSolid : ink} stroke={2.8} draw={res} /> : null}
              <span style={{ fontFamily: FONT.displayBold, fontSize: fitLine(o.text, W - 2 * pad - 200, 36, 28), color: isC && barW > 200 ? mix(ink, T.onSolid, res) : ink, letterSpacing: "-0.01em", ...oneLine }}>{o.text}</span>
            </div>
            <div style={{ position: "absolute", right: 34, top: 0, bottom: 0, display: "flex", alignItems: "center", fontFamily: FONT.display, fontSize: 36, color: isC ? (pct[i]! > 88 ? T.onSolid : T.accent) : T.muted, fontVariantNumeric: "tabular-nums", opacity: res }}>{p}%</div>
          </div>
        );
      })}
    </div>
  );
}

/** Question sticker: avatar, prompt, a field where the answer types. */
function StoryQuestion({ ctx }: { ctx: GCtx }) {
  const { props, frame } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const pad = STORY.pad;
  const av = 88;
  const q = props.title?.trim() || "Ask me a question";
  const ans = props.items[0]?.text?.trim() || "";
  const who = props.items[0]?.sub?.trim() || "Your Name";
  const top = av / 2;
  const qFit = fitText(q, W - 2 * pad, 2 * 40 * 1.16, { max: 40, min: 32, lh: 1.16, maxLines: 2 });
  const qTop = top + av / 2 + 18;
  const qH = qFit.lines.length * qFit.size * 1.16;
  const fTop = qTop + qH + 24;
  const fH = H - fTop - pad + 8;
  const aFit = fitText(ans, W - 2 * pad - 56, fH - 44, { max: 38, min: 30, lh: 1.26, maxLines: 4 });
  const c = clock(ctx, 1 + typeFrames(ctx, ans, 22) / ctx.fps + 0.2);
  const typeAt = c(0.8);
  const shown = typedChars(ctx, ans, typeAt, 22);
  const typing = frame >= typeAt && shown < ans.length;
  let left = shown;
  return (
    <div style={{ ...fill, ...stickerIn(ctx) }}>
      <div style={{ position: "absolute", left: 0, right: 0, top, bottom: 0, ...card(T, 40) }} />
      <div style={{ position: "absolute", left: W / 2 - av / 2, top: 0, ...popIn(ctx, c(0.1), 0.4) }}>
        <Avatar name={who} size={av} ring={T.surface} />
      </div>
      <div style={{ position: "absolute", left: pad, right: pad, top: qTop }}>
        <Lines ctx={ctx} lines={qFit.lines} size={qFit.size} lh={1.16} color={T.ink} font={FONT.display} start={c(0.2)} align="center" ls="-0.02em" />
      </div>
      <div style={{ position: "absolute", left: pad, right: pad, top: fTop, height: fH, borderRadius: 26, background: T.fill, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", ...fade(ctx, c(0.4), 0.4, 6) }}>
        {frame < typeAt ? <div style={{ fontFamily: FONT.text, fontSize: 34, color: T.faint }}>Type something…</div> : null}
        {frame >= typeAt
          ? aFit.lines.map((l, i) => {
              const take = Math.max(0, Math.min(l.length, left));
              const here = typing && left >= 0 && left <= l.length;
              left -= l.length + 1;
              return (
                <div key={i} style={{ fontFamily: FONT.displayBold, fontSize: aFit.size, lineHeight: 1.26, color: T.ink, whiteSpace: "nowrap", minHeight: aFit.size * 1.26, letterSpacing: "-0.01em" }}>
                  {l.slice(0, take)}
                  {here ? <Caret ctx={ctx} color={T.accent} height={aFit.size * 0.95} /> : null}
                </div>
              );
            })
          : null}
      </div>
    </div>
  );
}

/** Emoji-slider style sticker: a sticker face slides along a gradient track. */
function StorySlider({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const pad = STORY.pad;
  const it = props.items[0];
  const val = Math.max(0, Math.min(100, it?.value ?? 80)) / 100;
  const face: GraphicIcon = it?.icon ?? "FACE_LOVE";
  const q = props.title?.trim() || "How much do you agree?";
  const qFit = fitText(q, W - 2 * pad, 2 * 42 * 1.16, { max: 42, min: 32, lh: 1.16, maxLines: 2 });
  const qH = qFit.lines.length * qFit.size * 1.16;
  const c = clock(ctx, 2.6);
  const trackY = Math.max(pad + qH + 90, H - pad - 70);
  const trackX = pad + 20;
  const trackW = W - 2 * trackX;
  const go = c(0.7);
  const s = springAt(frame, fps, go, ctx.f.springs.settle, Math.round(1.3 * fps));
  const x = trackW * val * Math.max(0, s);
  const moving = frame >= go && frame < go + Math.round(1 * fps);
  const knob = 96 * (1 + (moving ? 0.22 * bump(ctx, go, 1) : 0));
  const solid = T.solid;
  const avgT = prog(frame, go + Math.round(1.1 * fps), Math.round(0.4 * fps), ctx.ease);
  const avg = val > 0.5 ? val - 0.3 : val + 0.3;
  return (
    <div style={{ ...fill, ...card(T, 40), ...stickerIn(ctx) }}>
      <div style={{ position: "absolute", left: pad, right: pad, top: pad }}>
        <Lines ctx={ctx} lines={qFit.lines} size={qFit.size} lh={1.16} color={T.ink} font={FONT.display} start={c(0.12)} align="center" ls="-0.02em" />
      </div>
      <div style={{ position: "absolute", left: trackX, top: trackY - 9, width: trackW, height: 18, borderRadius: 9, background: T.fill2, ...fade(ctx, c(0.35), 0.4, 0) }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: x, borderRadius: 9, background: `linear-gradient(90deg, ${mix(solid, "#FFFFFF", 0.45)}, ${solid})` }} />
        {avgT > 0 ? (
          <div style={{ position: "absolute", left: trackW * avg - 30, top: -54, width: 60, display: "flex", flexDirection: "column", alignItems: "center", opacity: avgT }}>
            <span style={{ fontFamily: FONT.text, fontSize: 28, color: T.muted }}>avg</span>
            <div style={{ width: 4, height: 18, borderRadius: 2, background: T.faint }} />
          </div>
        ) : null}
      </div>
      <div style={{ position: "absolute", left: trackX + x - knob / 2, top: trackY - knob / 2, width: knob, height: knob, filter: `drop-shadow(0 8px 14px ${rgba("#000000", 0.28)})`, ...popIn(ctx, c(0.4), 0.3) }}>
        <StickerIcon icon={face} size={knob} color={LIKE} />
      </div>
    </div>
  );
}

/** Quiz: a band with the question, lettered options; the right one is tapped → green check. */
function StoryQuiz({ ctx }: { ctx: GCtx }) {
  const { props, frame } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const items = cleanItems(props.items, 4);
  const opts = items.length ? items : [{ text: "A", state: "DONE" } as GraphicItem, { text: "B" } as GraphicItem];
  const n = opts.length;
  const pad = STORY.pad;
  const q = props.title?.trim() || "Quiz";
  const qFit = fitText(q, W - 2 * pad, 3 * 40 * 1.16, { max: 40, min: 32, lh: 1.16, maxLines: 3 });
  const bandH = qFit.lines.length * qFit.size * 1.16 + 2 * 36;
  const optTop = bandH + 24;
  const optH = Math.min(STORY.opt, (H - optTop - 24 - (n - 1) * 14) / n);
  const c = clock(ctx, 2.8);
  const seq = listSequence(n, { ...ctx.anim, stagger: Math.max(0.08, ctx.anim.stagger) }, seqOpts(ctx, c(0.35)));
  const correct = Math.max(0, opts.findIndex((o) => o.state === "DONE") >= 0 ? opts.findIndex((o) => o.state === "DONE") : (props.highlight ?? 0));
  const tap = Math.max(seq.done, c(1.5));
  const rev = prog(frame, tap + 3, Math.round(0.35 * ctx.fps), ctx.ease);
  const solid = T.solid;
  const showPct = opts.some((o) => o.value != null);
  return (
    <div style={{ ...fill, ...card(T, 40), overflow: "hidden", ...stickerIn(ctx) }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: bandH, background: `linear-gradient(135deg, ${mix(solid, "#FFFFFF", 0.16)} 0%, ${solid} 60%, ${mix(solid, "#000000", 0.18)} 100%)` }} />
      <div style={{ position: "absolute", left: pad, right: pad, top: 0, height: bandH, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <Lines ctx={ctx} lines={qFit.lines} size={qFit.size} lh={1.16} color={T.onSolid} font={FONT.display} start={c(0.12)} align="center" ls="-0.02em" />
      </div>
      {opts.map((o, i) => {
        const y = optTop + i * (optH + 14);
        const ok = i === correct;
        const pr = ok ? bump(ctx, tap, 0.25) : 0;
        const bg = ok ? blendBg(T.fill, CORRECT, rev) : T.fill;
        const ink = ok ? mix(T.ink, "#FFFFFF", rev) : T.ink;
        const dim = ok ? 1 : 1 - 0.4 * rev;
        return (
          <div key={i} style={{ position: "absolute", left: pad - 8, right: pad - 8, top: y, height: optH, ...css(seqStyle(ctx, seq, 0, i)) }}>
            <div style={{ position: "absolute", inset: 0, borderRadius: optH / 2, background: bg, boxShadow: `inset 0 0 0 1.5px ${T.line}`, transform: pr ? `scale(${r4(1 - 0.04 * pr)})` : undefined, opacity: dim }} />
            <div style={{ position: "absolute", left: 14, top: (optH - 64) / 2, width: 64, height: 64, borderRadius: 32, background: ok && rev > 0 ? "#FFFFFF" : T.surface, boxShadow: `inset 0 0 0 2px ${ok && rev > 0 ? "#FFFFFF" : T.line}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, fontSize: 30, color: T.muted, opacity: dim }}>
              {ok && rev > 0.5 ? <GIcon icon="CHECK" size={36} color={CORRECT} stroke={3} draw={clamp01((rev - 0.5) * 2)} /> : String.fromCharCode(65 + i)}
            </div>
            <div style={{ position: "absolute", left: 98, right: showPct ? 110 : 30, top: 0, bottom: 0, display: "flex", alignItems: "center", fontFamily: FONT.displayBold, fontSize: fitLine(o.text, W - 2 * pad - 230, 36, 28), color: ink, letterSpacing: "-0.01em", opacity: dim, ...oneLine }}>{o.text}</div>
            {showPct && o.value != null ? <div style={{ position: "absolute", right: 30, top: 0, bottom: 0, display: "flex", alignItems: "center", fontFamily: FONT.display, fontSize: 32, color: ink, opacity: rev * dim, fontVariantNumeric: "tabular-nums" }}>{Math.round(o.value * rev)}%</div> : null}
          </div>
        );
      })}
    </div>
  );
}

// ===================================================================== SOCIAL_COUNTER

function SocialCounter({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "RAIL":
      return <CounterRail ctx={ctx} />;
    case "PROFILE":
      return <CounterProfile ctx={ctx} />;
    case "LIVE":
      return <CounterLive ctx={ctx} />;
    default:
      return <CounterMilestone ctx={ctx} />;
  }
}

function confettiColors(ctx: GCtx): string[] {
  return [ctx.p.primary, ctx.p.secondary, ctx.p.positive, "#60A5FA", "#F472B6", "#FBBF24"];
}

/** A one-shot confetti burst from (cx, cy), `n` pieces, deterministic. */
function ConfettiBurst({ ctx, at, cx, cy, n, spread, colors, gravity = 900 }: { ctx: GCtx; at: number; cx: number; cy: number; n: number; spread: number; colors: string[]; gravity?: number }) {
  const t = (ctx.frame - at) / ctx.fps;
  if (t < 0 || t > 2.6) return null;
  return (
    <>
      {Array.from({ length: n }, (_, k) => {
        const a = -Math.PI / 2 + (hash01(k + 1) - 0.5) * Math.PI * 1.5;
        const sp = spread * (0.55 + 0.6 * hash01(k + 40));
        const drag = 1 - Math.exp(-t * 3.2);
        const x = cx + Math.cos(a) * sp * drag + Math.sin(t * 6 + k) * 10;
        const y = cy + Math.sin(a) * sp * drag + gravity * 0.18 * t * t;
        const rot = (hash01(k + 9) - 0.5) * 900 * t;
        const w = 12 + 10 * hash01(k + 17);
        const h = hash01(k + 23) > 0.5 ? w * 0.45 : w;
        const o = 1 - clamp01((t - 1.7) / 0.9);
        return <div key={k} style={{ position: "absolute", left: x - w / 2, top: y - h / 2, width: w, height: h, borderRadius: h === w ? w / 2 : 2, background: colors[k % colors.length], opacity: o, transform: `rotate(${r1(rot)}deg) scaleX(${r4(Math.cos(t * 8 + k))})` }} />;
      })}
    </>
  );
}

/** Follower milestone: an odometer rolls to the number, then confetti + pill. */
function CounterMilestone({ ctx }: { ctx: GCtx }) {
  const { props, frame } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const final = Math.max(0, Math.round(props.items[0]?.value ?? 100000));
  const from = props.items[1]?.value != null ? Math.max(0, Math.min(final, props.items[1].value)) : Math.round(final * 0.9);
  const label = props.title?.trim() || "followers";
  const who = props.subtitle?.trim();
  const pill = props.items[0]?.text?.trim() || "New milestone";
  const c = clock(ctx, 2.8);
  const rollAt = c(0.35);
  const land = c(2.0);
  const t = prog(frame, rollAt, Math.max(1, land - rollAt), (x) => 1 - (1 - x) ** 3);
  const v = ctx.anim.countUp ? from + (final - from) * t : frame >= rollAt ? final : from;
  const size = Math.max(80, Math.min(180, Math.floor((W - 120) / Math.max(1, odometerWidth(final, 1)))));
  const em = frame >= land ? bump(ctx, land, 0.45) : 0;
  const numTop = who ? 120 : 84;
  const glow = prog(frame, land, Math.round(0.5 * ctx.fps));
  return (
    <div style={{ ...fill, ...card(T, 48), overflow: "hidden", ...boxIn(ctx) }}>
      <div style={{ ...fill, background: `radial-gradient(ellipse 60% 50% at 50% 46%, ${rgba(T.accent, 0.18 * glow)} 0%, transparent 70%)` }} />
      {who ? (
        <div style={{ position: "absolute", left: 0, right: 0, top: 40, height: 60, display: "flex", alignItems: "center", justifyContent: "center", gap: 14, ...fade(ctx, c(0.1)) }}>
          <Avatar name={who} size={56} />
          <span style={{ fontFamily: FONT.displayBold, fontSize: fitLine(who, W - 200, 34, 28), color: T.ink, ...oneLine }}>{who}</span>
        </div>
      ) : null}
      <div style={{ position: "absolute", left: 0, right: 0, top: numTop, display: "flex", justifyContent: "center", transform: em ? `scale(${r4(1 + 0.08 * em)})` : undefined, ...fade(ctx, c(0.2)) }}>
        <Odometer value={v} final={final} size={size} color={T.ink} />
      </div>
      <div style={{ position: "absolute", left: 40, right: 40, top: numTop + size * 1.08 + 4, textAlign: "center", fontFamily: FONT.text, fontSize: fitLine(label, W - 80, 40, 30, TK), color: T.muted, ...oneLine, ...fade(ctx, c(0.3)) }}>{label}</div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 40, display: "flex", justifyContent: "center" }}>
        <div style={{ height: 64, padding: "0 28px", borderRadius: 32, background: T.solid, display: "flex", alignItems: "center", gap: 12, boxShadow: `0 10px 26px ${rgba(T.solid, 0.35)}`, ...popIn(ctx, land + 2, 0.3) }}>
          <GIcon icon="SPARKLE" size={34} color={T.onSolid} stroke={2.2} />
          <span style={{ fontFamily: FONT.display, fontSize: fitLine(pill, W - 220, 32, 28), color: T.onSolid, whiteSpace: "nowrap" }}>{pill}</span>
        </div>
      </div>
      <ConfettiBurst ctx={ctx} at={land} cx={W / 2} cy={numTop + size * 0.5} n={34} spread={W * 0.46} colors={confettiColors(ctx)} />
    </div>
  );
}

/** Action rail: icons with counts ticking up; the heart gets tapped. */
function CounterRail({ ctx }: { ctx: GCtx }) {
  const { props, frame } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const items = cleanItems(props.items, 5);
  const list = items.length ? items : ([{ icon: "HEART", value: 12400 }, { icon: "CHAT", value: 380 }] as GraphicItem[]);
  const n = list.length;
  const rowH = (H - 40) / n;
  const seq = listSequence(n, ctx.anim, seqOpts(ctx, Math.round(0.2 * ctx.fps)));
  const popStyle = ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter;
  const likeAt = seq.done + Math.round(0.35 * ctx.fps);
  const bare = T.dark;
  const ink = bare ? "#FFFFFF" : T.ink;
  const defaults: GraphicIcon[] = ["HEART", "CHAT", "BOOKMARK", "SHARE", "REPOST"];
  return (
    <div style={{ ...fill, ...boxIn(ctx) }}>
      {!bare ? <div style={{ position: "absolute", left: (W - 200) / 2, top: 0, width: 200, bottom: 0, ...card(T, 100) }} /> : null}
      <div style={{ ...fill, filter: bare ? `drop-shadow(0 3px 6px ${rgba("#000000", 0.55)})` : undefined }}>
        {list.map((it, i) => {
          const icon = it.icon ?? defaults[i % defaults.length]!;
          const like = icon === "HEART";
          const save = icon === "BOOKMARK";
          const at = like ? likeAt : save ? likeAt + Math.round(0.4 * ctx.fps) : null;
          const on = at != null ? prog(frame, at, 4) : 0;
          const col = like ? LIKE : save ? "#FFC531" : T.accent;
          const txt = it.value != null ? socialCountAt(ctx, seq.at(0, i), it.value, 0, 2.4) : it.text;
          return (
            <div key={i} style={{ position: "absolute", left: 0, right: 0, top: 20 + i * rowH, height: rowH, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, ...css(seqStyle(ctx, seq, 0, i, { style: popStyle })) }}>
              <Toggle ctx={ctx} icon={icon} size={84} base={ink} color={col} at={at} stroke={2} fillD={like ? HEART_D : undefined} />
              <span style={{ fontFamily: FONT.display, fontSize: fitLine(txt, W - 20, 34, 28), color: on > 0 && !bare ? mix(ink, col, 0) : ink, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{txt}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Profile header: avatar, stats counting up, name/handle, Follow tapped → Following. */
function CounterProfile({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const pad = 44;
  const av = 156;
  const name = props.title?.trim() || "Your Name";
  const handle = props.subtitle?.trim() || "@yourhandle";
  const stats = cleanItems(props.items, 3);
  const c = clock(ctx, 2.8);
  const seq = listSequence(stats.length, ctx.anim, seqOpts(ctx, c(0.3)));
  const sx = pad + av + 30;
  const sw = W - sx - pad;
  const colW = sw / Math.max(1, stats.length);
  const btnTop = H - pad - 80;
  const tap = c(2.0);
  const pr = frame >= tap && frame < tap + 5 ? Math.sin(((frame - tap) / 5) * Math.PI) : 0;
  const done = prog(frame, tap + 2, 6);
  const rip = frame >= tap ? clamp01((frame - tap) / Math.round(0.45 * fps)) : 0;
  const bw = W - 2 * pad;
  return (
    <div style={{ ...fill, ...card(T, 44), ...boxIn(ctx) }}>
      <div style={{ position: "absolute", left: pad, top: pad, ...popIn(ctx, c(0.06), 0.4) }}>
        <div style={{ padding: 6, borderRadius: "50%", background: `conic-gradient(from 200deg, ${ctx.p.primary}, ${ctx.p.secondary}, ${ctx.p.primary})` }}>
          <div style={{ padding: 5, borderRadius: "50%", background: T.surface }}>
            <Avatar name={name} size={av - 22} />
          </div>
        </div>
      </div>
      {stats.map((it, i) => (
        <div key={i} style={{ position: "absolute", left: sx + i * colW, width: colW, top: pad + 22, display: "flex", flexDirection: "column", alignItems: "center", ...css(seqStyle(ctx, seq, 0, i)) }}>
          <div style={{ fontFamily: FONT.display, fontSize: fitLine(it.value != null ? socialCountAt(ctx, seq.at(0, i), it.value) : "", colW - 10, 48, 32), lineHeight: 1.15, color: T.ink, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", letterSpacing: "-0.02em" }}>{it.value != null ? socialCountAt(ctx, seq.at(0, i), it.value, 0, 2.4) : "—"}</div>
          <div style={{ fontFamily: FONT.text, fontSize: fitLine(it.text, colW - 10, 29, 26, TK), color: T.muted, whiteSpace: "nowrap" }}>{it.text}</div>
        </div>
      ))}
      <div style={{ position: "absolute", left: pad, right: pad, top: pad + av + 18, ...fade(ctx, c(0.25)) }}>
        <div style={{ fontFamily: FONT.displayBold, fontSize: fitLine(name, W - 2 * pad, 42, 30), lineHeight: 1.2, color: T.ink, letterSpacing: "-0.015em", ...oneLine }}>{name}</div>
        <div style={{ fontFamily: FONT.text, fontSize: fitLine(handle, W - 2 * pad, 30, 28, TK), lineHeight: 1.3, color: T.muted, ...oneLine }}>{handle}</div>
      </div>
      <div style={{ position: "absolute", left: pad, top: btnTop, width: bw, height: 80, borderRadius: 22, overflow: "hidden", background: blendBg(T.fill2, T.solid, 1 - done), transform: `scale(${r4(1 - 0.04 * pr)})`, ...fade(ctx, c(0.5)) }}>
        {rip > 0 && rip < 1 ? <div style={{ position: "absolute", left: bw / 2 - 300, top: 40 - 300, width: 600, height: 600, borderRadius: "50%", background: rgba("#FFFFFF", 0.22 * (1 - rip)), transform: `scale(${r4(0.1 + rip)})` }} /> : null}
        <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, fontSize: 34, color: T.onSolid, opacity: 1 - done }}>Follow</div>
        <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontFamily: FONT.display, fontSize: 34, color: T.ink, opacity: done }}>
          <GIcon icon="CHECK" size={30} color={T.ink} stroke={2.8} draw={prog(frame, tap + 3, 8)} />
          Following
        </div>
      </div>
    </div>
  );
}

/** LIVE pill: avatar with a live ring, name, LIVE badge, viewers ticking with small swings. */
function CounterLive({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps } = ctx;
  const T = toneOf(ctx);
  const W = ctx.width;
  const H = ctx.height;
  const name = props.title?.trim();
  const viewers = Math.max(0, props.items[0]?.value ?? 1200);
  const c = clock(ctx, 1.4);
  const pad = 22;
  const av = H - 2 * pad;
  const beat = 0.5 + 0.5 * Math.sin((frame / fps) * Math.PI * 2);
  const reached = prog(frame, c(0.4), Math.round(1.1 * fps), (x) => 1 - (1 - x) ** 3);
  const jitter = frame > c(1.5) ? Math.round((Math.sin(frame * 0.37) + Math.sin(frame * 0.11)) * viewers * 0.004) : 0;
  const shown = formatLive(viewers * (ctx.anim.countUp ? reached : 1) + jitter, viewers);
  const x0 = name ? pad + av + 22 : pad + 10;
  return (
    <div style={{ ...fill, ...card(T, H / 2), ...boxIn(ctx) }}>
      {name ? (
        <div style={{ position: "absolute", left: pad, top: pad, ...popIn(ctx, c(0.05), 0.5) }}>
          <div style={{ padding: 4, borderRadius: "50%", background: LIVE_RED, boxShadow: `0 0 ${r1(10 + 14 * beat)}px ${rgba(LIVE_RED, 0.55)}` }}>
            <div style={{ padding: 3, borderRadius: "50%", background: T.surface }}>
              <Avatar name={name} size={av - 14} />
            </div>
          </div>
        </div>
      ) : null}
      <div style={{ position: "absolute", left: x0, right: pad + 10, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: 6 }}>
        {name ? <div style={{ fontFamily: FONT.displayBold, fontSize: fitLine(name, W - x0 - pad - 10, 34, 28), lineHeight: 1.15, color: T.ink, ...oneLine, ...fade(ctx, c(0.1)) }}>{name}</div> : null}
        <div style={{ display: "flex", alignItems: "center", gap: 16, ...fade(ctx, c(0.15)) }}>
          <div style={{ height: 44, padding: "0 16px", borderRadius: 12, background: LIVE_RED, display: "flex", alignItems: "center", gap: 8, flex: "none", transform: `scale(${r4(1 + 0.04 * beat)})` }}>
            <div style={{ width: 12, height: 12, borderRadius: 6, background: "#FFFFFF", opacity: 0.55 + 0.45 * beat }} />
            <span style={{ fontFamily: FONT.display, fontSize: 28, letterSpacing: "0.06em", color: "#FFFFFF" }}>LIVE</span>
          </div>
          <GIcon icon="EYE" size={36} color={T.muted} stroke={2.1} />
          <span style={{ fontFamily: FONT.display, fontSize: 32, color: T.ink, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{shown}</span>
        </div>
      </div>
    </div>
  );
}

function formatLive(n: number, plan: number): string {
  const v = Math.max(0, n);
  if (plan >= 1e4) return `${(v / 1000).toFixed(v / 1000 >= 100 ? 0 : 1).replace(/\.0$/, "")}K`;
  return Math.round(v).toLocaleString("en-US");
}

// ===================================================================== BURST

function Burst({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "DOUBLE_TAP":
      return <BurstDoubleTap ctx={ctx} />;
    case "RAIN":
      return <BurstRain ctx={ctx} />;
    case "CONFETTI":
      return <BurstConfetti ctx={ctx} />;
    default:
      return <BurstFloat ctx={ctx} />;
  }
}

function burstIcons(ctx: GCtx, fallback: GraphicIcon[]): GraphicIcon[] {
  const ic = ctx.props.items.map((i) => i.icon).filter((x): x is GraphicIcon => !!x);
  return ic.length ? ic : fallback;
}

function heartTint(ctx: GCtx, k: number): string {
  const tints = [LIKE, mix(LIKE, "#FF8FB1", 0.6), ctx.p.primary, ctx.p.secondary, "#FF6B6B", "#C084FC"];
  return tints[k % tints.length]!;
}

/** Big word for the bursts (optional title) — popped, white with a soft shadow. */
function BurstWord({ ctx, at, cx, cy, maxW, size = 120 }: { ctx: GCtx; at: number; cx: number; cy: number; maxW: number; size?: number }) {
  const title = ctx.props.title?.trim();
  if (!title) return null;
  const fs = fitLine(title, maxW, size, 44);
  const s = springAt(ctx.frame, ctx.fps, at, ctx.f.springs.punch, Math.round(0.8 * ctx.fps));
  return (
    <div style={{ position: "absolute", left: cx - maxW / 2, width: maxW, top: cy - fs * 0.6, height: fs * 1.2, display: "flex", alignItems: "center", justifyContent: "center", opacity: prog(ctx.frame, at, 4), transform: `scale(${r4(0.4 + 0.6 * Math.max(0, s))}) rotate(-4deg)` }}>
      <span style={{ fontFamily: FONT.display, fontSize: fs, letterSpacing: "-0.03em", color: "#FFFFFF", whiteSpace: "nowrap", textShadow: `0 4px 0 ${rgba("#000000", 0.18)}, 0 10px 30px ${rgba("#000000", 0.45)}` }}>{title}</span>
    </div>
  );
}

/** Live-stream hearts floating up and swaying. */
function BurstFloat({ ctx }: { ctx: GCtx }) {
  const { frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const icons = burstIcons(ctx, ["HEART"]);
  const N = 16;
  const lifeF = 2.4 * fps;
  return (
    <div style={fill}>
      {Array.from({ length: N }, (_, k) => {
        // A continuous stream: particle k first spawns k/N into the first cycle, then loops.
        const t0 = (k / N) * lifeF * 0.9 + (k ? hash01(k + 2) * 4 : 0);
        if (frame < t0) return null;
        const t = ((frame - t0) / lifeF) % 1;
        const icon = icons[k % icons.length]!;
        const sz = 70 + 50 * hash01(k + 11);
        const x = W * 0.62 + (hash01(k + 5) - 0.5) * W * 0.4 + Math.sin(t * 5 + k) * 36 * t;
        const y = H - sz - t * (H - sz * 1.4) * (0.75 + 0.25 * hash01(k + 7));
        const s = Math.min(1, t * 6) * (1 - 0.25 * t);
        const o = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
        return (
          <div key={k} style={{ position: "absolute", left: x - sz / 2, top: y, width: sz, height: sz, opacity: o, transform: `scale(${r4(s)}) rotate(${r1(Math.sin(t * 4 + k) * 14)}deg)` }}>
            <StickerIcon icon={icon} size={sz} color={heartTint(ctx, k)} />
          </div>
        );
      })}
      <BurstWord ctx={ctx} at={Math.round(0.2 * fps)} cx={W / 2} cy={H * 0.86} maxW={W - 20} size={96} />
    </div>
  );
}

/** Double tap: a big heart pops with a ring + mini hearts, then settles. */
function BurstDoubleTap({ ctx }: { ctx: GCtx }) {
  const { frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const icon = burstIcons(ctx, ["HEART"])[0]!;
  const title = ctx.props.title?.trim();
  const cx = W / 2;
  const cy = title ? H * 0.42 : H / 2;
  const at = Math.round(0.12 * fps);
  const s = springAt(frame, fps, at, ctx.f.springs.punch, Math.round(0.9 * fps));
  const S = Math.min(W, H) * (title ? 0.56 : 0.62);
  const ring = clamp01((frame - at) / Math.round(0.55 * fps));
  const minis = [0, 1, 2, 3, 4, 5, 6, 7];
  const beat = frame > at + fps ? 1 + 0.04 * Math.max(0, Math.sin(((frame - at) / fps) * Math.PI * 2.2)) : 1;
  return (
    <div style={fill}>
      {ring > 0 && ring < 1 ? <div style={{ position: "absolute", left: cx - S * 0.6, top: cy - S * 0.6, width: S * 1.2, height: S * 1.2, borderRadius: "50%", border: `${r1(10 * (1 - ring))}px solid ${rgba("#FFFFFF", 0.7 * (1 - ring))}`, transform: `scale(${r4(0.5 + 0.7 * ring)})` }} /> : null}
      {minis.map((k) => {
        const t = (frame - at - 2) / (0.8 * fps);
        if (t <= 0 || t >= 1) return null;
        const a = (k / minis.length) * Math.PI * 2 + 0.3;
        const r = S * (0.42 + 0.5 * t);
        const sz = 38 + 18 * hash01(k + 3);
        return (
          <div key={k} style={{ position: "absolute", left: cx + Math.cos(a) * r - sz / 2, top: cy + Math.sin(a) * r - sz / 2, opacity: 1 - t, transform: `scale(${r4(1 - 0.4 * t)}) rotate(${r1((hash01(k) - 0.5) * 60)}deg)` }}>
            <StickerIcon icon={icon === "HEART" ? "HEART" : icon} size={sz} color={heartTint(ctx, k)} />
          </div>
        );
      })}
      <div style={{ position: "absolute", left: cx - S / 2, top: cy - S / 2, width: S, height: S, opacity: prog(frame, at, 3), transform: `scale(${r4(Math.max(0, s) * beat)}) rotate(${r1((1 - Math.min(1, s)) * -14)}deg)`, filter: `drop-shadow(0 18px 40px ${rgba("#000000", 0.4)})` }}>
        <StickerIcon icon={icon} size={S} color={LIKE} />
      </div>
      {title ? <BurstWord ctx={ctx} at={at + Math.round(0.35 * fps)} cx={cx} cy={H - 90} maxW={W - 20} size={104} /> : null}
    </div>
  );
}

/** Icons / faces raining down with spin and slight drift. */
function BurstRain({ ctx }: { ctx: GCtx }) {
  const { frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const icons = burstIcons(ctx, ["FACE_LAUGH", "HEART", "FIRE", "FACE_WOW"]);
  const N = 20;
  return (
    <div style={fill}>
      {Array.from({ length: N }, (_, k) => {
        const dur = (1.7 + 0.7 * hash01(k + 8)) * fps;
        const t0 = (k / N) * dur * 0.95 + (k ? hash01(k + 4) * 6 : 0);
        if (frame < t0) return null;
        const t = ((frame - t0) / dur) % 1;
        const sz = 90 + 60 * hash01(k + 13);
        const x = (hash01(k + 21) * 0.9 + 0.05) * W + Math.sin(t * 3 + k) * 20;
        const y = -sz + t * (H + sz * 1.2);
        const rot = (hash01(k + 2) - 0.5) * 50 + t * (hash01(k + 6) - 0.5) * 220;
        return (
          <div key={k} style={{ position: "absolute", left: x - sz / 2, top: y, transform: `rotate(${r1(rot)}deg)`, opacity: t > 0.9 ? (1 - t) / 0.1 : 1 }}>
            <StickerIcon icon={icons[k % icons.length]!} size={sz} color={heartTint(ctx, k)} />
          </div>
        );
      })}
      <BurstWord ctx={ctx} at={Math.round(0.25 * fps)} cx={W / 2} cy={H / 2} maxW={W - 40} />
    </div>
  );
}

/** Confetti cannon: pieces burst up from two corners and flutter down; optional word pops. */
function BurstConfetti({ ctx }: { ctx: GCtx }) {
  const { frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const colors = confettiColors(ctx);
  const icons = ctx.props.items.map((i) => i.icon).filter((x): x is GraphicIcon => !!x);
  const at = 0;
  const N = 40;
  const second = at + Math.round(1.3 * fps);
  return (
    <div style={fill}>
      {frame >= at
        ? Array.from({ length: N }, (_, k) => {
            const t = (frame - (k < 26 ? at : second)) / fps;
            if (t < 0) return null;
            const side = k % 2 === 0 ? -1 : 1;
            const x0 = side < 0 ? W * 0.08 : W * 0.92;
            const y0 = H * 0.92;
            const a = -Math.PI / 2 - side * (0.18 + 0.42 * hash01(k + 3));
            const v = H * (1.05 + 0.6 * hash01(k + 7));
            const drag = 1 - Math.exp(-t * 2.6);
            const fall = Math.max(0, t - 0.5);
            const x = x0 + Math.cos(a) * v * 0.55 * drag + Math.sin(t * 5 + k) * 18 * fall;
            const y = y0 + Math.sin(a) * v * 0.55 * drag + 95 * fall * fall;
            const isIcon = icons.length > 0 && k % 5 === 0;
            if (y > H + 60) return null;
            const o = 1;
            if (isIcon) {
              const sz = 70;
              return (
                <div key={k} style={{ position: "absolute", left: x - sz / 2, top: y - sz / 2, opacity: o, transform: `rotate(${r1((hash01(k) - 0.5) * 80 + t * 40 * side)}deg)` }}>
                  <StickerIcon icon={icons[(k / 5) % icons.length]!} size={sz} color={heartTint(ctx, k)} />
                </div>
              );
            }
            const w = 26 + 16 * hash01(k + 17);
            const h = hash01(k + 23) > 0.5 ? w * 0.42 : w;
            return <div key={k} style={{ position: "absolute", left: x - w / 2, top: y - h / 2, width: w, height: h, borderRadius: h === w ? w / 2 : 3, background: colors[k % colors.length], opacity: o, transform: `rotate(${r1((hash01(k + 9) - 0.5) * 700 * t)}deg) scaleX(${r4(Math.cos(t * 7 + k))})` }} />;
          })
        : null}
      <BurstWord ctx={ctx} at={at + Math.round(0.3 * fps)} cx={W / 2} cy={H * 0.42} maxW={W - 40} size={130} />
    </div>
  );
}

/** Library 2 — social family components. */
export const SOCIAL_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {
  SOCIAL_POST: SocialPost,
  COMMENT: Comment,
  TRENDING: Trending,
  VIDEO_CARD: VideoCard,
  STORY: Story,
  SOCIAL_COUNTER: SocialCounter,
  BURST: Burst,
};
