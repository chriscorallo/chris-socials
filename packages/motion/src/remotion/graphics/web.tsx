import type { ComponentType, CSSProperties, ReactNode } from "react";
import type { GraphicAnimation, GraphicComponent, GraphicIcon, GraphicItem } from "@chris/media/timeline";
import { listSequence } from "../../graphics-timing";
import { GIcon } from "./icons";
import { FONT, clamp01, colorOf, css, enterStyle, fmtValue, counted, mix, prog, r1, r4, rgba, seqStyle, springAt, withExit, type GCtx } from "./kit";
import { APP_TINTS, Avatar, Caret, card, namePair, pressAt, rippleAt, toneOf, oneLine, type Tone } from "./ui";
import { fitLine, fitWords, hash01, matchPhrase, onFill, solidFill, splitWords, squeeze, textW } from "./text";

/**
 * Library 2 — SEARCH & WEB + NEWS & MEDIA family: SEARCH_BAR · BROWSER · WEB_CARD · NEWS ·
 * MEDIA_PLAYER (field mapping: @chris/media graphics/families/web.ts).
 *
 * Brand-safe by construction: a generic magnifier (no search-engine mark or colours), neutral
 * window chrome (grey dots, no browser marks), placeholder imagery drawn from gradients, outlet
 * names set as neutral type treatments (never a real masthead/logo), media players without any
 * streaming-service mark or signature colour. Every string is fitted (shrink → wrap → ellipsis).
 *
 * Performance: pure functions of ctx.frame; modest node counts; no blur filters.
 */

const fill: CSSProperties = { position: "absolute", inset: 0 };
const PAPER = "#F4F1EA";
const PAPER_INK = "#17140F";
/** Inter SemiBold runs a touch wider than the Display face textW() measures. */
const KT = 1.05;
/** DM Serif Display. */
const KS = 0.98;

// ===================================================================== helpers

function abs(left: number, top: number, width: number, height: number, extra: CSSProperties = {}): CSSProperties {
  return { position: "absolute", left, top, width, height, ...extra };
}

/** Choreography clock: beats in seconds → frames, compressed (with the motion speed) so the
 * build always lands before the exit with a hold. */
function clock(ctx: GCtx, totalSec: number) {
  const sp = Math.max(0.25, ctx.anim.speed || 1);
  const total = Math.round((totalSec * ctx.fps) / sp);
  const k = squeeze(ctx, 0, total);
  return (sec: number) => Math.round(((sec * ctx.fps) / sp) * k);
}

function seqOpts(ctx: GCtx, startFrame?: number) {
  return { fps: ctx.fps, durationInFrames: ctx.D, exitFrames: ctx.exitFrames, tempo: ctx.f.tempo, startFrame };
}

/** The whole card's entrance (honours animation.enter) + container-level element exit. */
function cardIn(ctx: GCtx, start = 0): CSSProperties {
  return css(withExit(ctx, enterStyle(ctx, start, Math.round(0.5 * ctx.fps), { blurOK: true }), 0, 1));
}

/** Characters of `text` shown by a typewriter running from `start` for `len` frames. */
function typedN(ctx: GCtx, text: string, start: number, len: number): number {
  if (ctx.frame < start) return 0;
  return Math.min(text.length, Math.floor(clamp01((ctx.frame - start) / Math.max(1, len)) * text.length + 0.0001));
}

interface Block {
  size: number;
  lines: string[];
  h: number;
  lh: number;
}

/** Wrap `text` into width × maxH (largest size max → min, ellipsis when even min overflows). */
function fitBlock(text: string | null | undefined, width: number, maxH: number, o: { max: number; min: number; lh: number; k?: number; maxLines?: number }): Block {
  const w = splitWords(text);
  if (!w.length || maxH <= 0) return { size: o.max, lines: [], h: 0, lh: o.lh };
  const f = fitWords(w, width, Math.max(maxH, o.min * o.lh), o);
  const lines = f.lines.map((l) => l.map((i) => f.words[i]).join(" "));
  return { size: f.size, lines, h: lines.length * f.size * o.lh, lh: o.lh };
}

function Lines({ b, style, lineStyle }: { b: Block; style?: CSSProperties; lineStyle?: (i: number) => CSSProperties }) {
  return (
    <div style={style}>
      {b.lines.map((ln, i) => (
        <div key={i} style={{ fontSize: b.size, lineHeight: `${r1(b.size * b.lh)}px`, height: r1(b.size * b.lh), ...oneLine, ...(lineStyle ? lineStyle(i) : {}) }}>
          {ln}
        </div>
      ))}
    </div>
  );
}

/** A small local line glyph on the 24 grid. */
function Glyph({ d, size, color, stroke = 2, fillColor, style }: { d: string[]; size: number; color: string; stroke?: number; fillColor?: string; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", overflow: "visible", flex: "none", ...style }}>
      {d.map((p, i) => (
        <path key={i} d={p} fill={fillColor ?? "none"} stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

const G = {
  chevron: ["M6.5 9.5L12 15l5.5-5.5"],
  lock: ["M7 11V8a5 5 0 0 1 10 0v3", "M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"],
  reload: ["M19 12a7 7 0 1 1-2.05-4.95", "M19 4.5v4h-4"],
  enter: ["M19 6v5a2 2 0 0 1-2 2H6", "M9.5 9.5L6 13l3.5 3.5"],
  star: ["M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"],
  play: ["M8 5.5v13l10.5-6.5z"],
  pause: ["M8 5.5v13", "M16 5.5v13"],
  prev: ["M18 6v12l-8.5-6z", "M6 6v12"],
  next: ["M6 6v12l8.5-6z", "M18 6v12"],
  shuffle: ["M3.5 7h3.2c2.1 0 3.4 1 4.6 2.8l1.4 2.4c1.2 1.8 2.5 2.8 4.6 2.8h3.2", "M3.5 17h3.2c2.1 0 3.4-1 4.6-2.8", "M14.7 9.8C15.9 8 17.2 7 19.3 7h1.2", "M18 4.5L20.5 7 18 9.5", "M18 14.5l2.5 2.5-2.5 2.5"],
  repeat: ["M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19", "M16.5 3.5L19 6l-2.5 2.5", "M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5", "M7.5 20.5L5 18l2.5-2.5"],
  cookie: ["M12 3a9 9 0 1 0 9 9 3 3 0 0 1-3.6-3.4A3 3 0 0 1 14.2 5.4 3 3 0 0 1 12 3z"],
  cursor: ["M6 3.5l12.5 8.2-5.6 1.2-2.9 5.3z"],
  menu: ["M4.5 7h15", "M4.5 12h15", "M4.5 17h15"],
  check: ["M5 12.5l4.2 4.2L19 7"],
  plus: ["M12 5v14", "M5 12h14"],
  broken: ["M10 14a4 4 0 0 0 5.7 0l3.3-3.3a4 4 0 0 0-5.7-5.7L12 6.3", "M14 10a4 4 0 0 0-5.7 0L5 13.3a4 4 0 0 0 5.7 5.7l1.3-1.3", "M4 4l3 3", "M20 20l-3-3"],
};

/** Five stars, filled to `value` (0..5) progressively by `p` (0..1). */
function Stars({ value, size, color, empty, p = 1, gap = 6, pop }: { value: number; size: number; color: string; empty: string; p?: number; gap?: number; pop?: (i: number) => number }) {
  const v = Math.max(0, Math.min(5, value)) * clamp01(p);
  return (
    <div style={{ display: "flex", gap, flex: "none" }}>
      {[0, 1, 2, 3, 4].map((i) => {
        const f = clamp01(v - i);
        const s = pop ? pop(i) : 1;
        return (
          <div key={i} style={{ position: "relative", width: size, height: size, transform: s !== 1 ? `scale(${r4(s)})` : undefined }}>
            <Glyph d={G.star} size={size} color={empty} fillColor={empty} stroke={1.2} style={{ position: "absolute", inset: 0 }} />
            {f > 0 ? (
              <div style={{ position: "absolute", left: 0, top: 0, height: size, width: r1(size * f), overflow: "hidden" }}>
                <Glyph d={G.star} size={size} color={color} fillColor={color} stroke={1.2} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** A placeholder "photo": a calm two-tone gradient with soft light shapes (never an image). */
function PlaceholderArt({ seed, w, h, radius, icon, iconColor, children, zoom = 1 }: { seed: string; w: number; h: number; radius: number | string; icon?: GraphicIcon | null; iconColor?: string; children?: ReactNode; zoom?: number }) {
  const [a, b] = namePair(seed || "web");
  let hs = 0;
  for (const c of seed) hs = (hs + c.charCodeAt(0)) % 997;
  return (
    <div style={{ position: "relative", width: w, height: h, borderRadius: radius, overflow: "hidden", flex: "none", background: `linear-gradient(150deg, ${a} 0%, ${b} 100%)` }}>
      <div style={{ ...fill, transform: zoom !== 1 ? `scale(${r4(zoom)})` : undefined }}>
        {[0, 1, 2].map((k) => {
          const d = Math.max(w, h) * (0.55 + 0.35 * hash01(hs + k * 7));
          return <div key={k} style={{ position: "absolute", left: r1(w * hash01(hs + k * 3) - d / 2), top: r1(h * hash01(hs + k * 5 + 1) - d / 2), width: r1(d), height: r1(d), borderRadius: "50%", background: `radial-gradient(circle, ${rgba("#FFFFFF", 0.28 - k * 0.06)} 0%, ${rgba("#FFFFFF", 0)} 68%)` }} />;
        })}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "45%", background: `linear-gradient(180deg, ${rgba("#000000", 0)} 0%, ${rgba("#000000", 0.18)} 100%)` }} />
      </div>
      {icon ? (
        <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <GIcon icon={icon} size={Math.round(Math.min(w, h) * 0.34)} color={iconColor ?? rgba("#FFFFFF", 0.92)} stroke={1.6} />
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** A tap: press scale (≤ 1) + ripple disc. */
function tapAt(ctx: GCtx, at: number | null) {
  if (at == null) return { press: 1, ripple: null as number | null, done: 0 };
  return { press: 1 - 0.05 * pressAt(ctx, at, 7), ripple: rippleAt(ctx, at), done: prog(ctx.frame, at + 3, 6) };
}

function Ripple({ r, x, y, size, color }: { r: number | null; x: number; y: number; size: number; color: string }) {
  if (r == null) return null;
  return <div style={{ position: "absolute", left: r1(x - size / 2), top: r1(y - size / 2), width: size, height: size, borderRadius: "50%", background: rgba(color, 0.32 * (1 - r)), transform: `scale(${r4(0.12 + r)})`, pointerEvents: "none" }} />;
}

function hlIndex(ctx: GCtx, n: number): number | null {
  const h = ctx.props.highlight;
  return h != null && h >= 0 && h < n ? h : null;
}

function itemsOf(ctx: GCtx, max: number): GraphicItem[] {
  return ctx.props.items.slice(0, max);
}

/** Pointer arrow that glides to (x, y) and taps at `at`. */
function Pointer({ ctx, x, y, at, from }: { ctx: GCtx; x: number; y: number; at: number; from: [number, number] }) {
  const lead = Math.round(0.55 * ctx.fps);
  const t = prog(ctx.frame, at - lead, lead, ctx.ease);
  if (ctx.frame < at - lead - 4) return null;
  const px = from[0] + (x - from[0]) * t;
  const py = from[1] + (y - from[1]) * t;
  const s = 1 - 0.14 * pressAt(ctx, at, 7);
  return (
    <div style={{ position: "absolute", left: r1(px - 10), top: r1(py - 8), opacity: prog(ctx.frame, at - lead - 4, 5), transform: `scale(${r4(s)})`, transformOrigin: "10px 8px", filter: `drop-shadow(0 6px 10px ${rgba("#000000", 0.35)})` }}>
      <Glyph d={G.cursor} size={58} color="#111116" fillColor="#FFFFFF" stroke={1.6} />
    </div>
  );
}

// ===================================================================== SEARCH_BAR

function SearchBar({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "RESULTS":
      return <SearchResults ctx={ctx} />;
    case "ASK":
      return <SearchAsk ctx={ctx} />;
    case "SPOTLIGHT":
      return <SearchSpotlight ctx={ctx} />;
    default:
      return <SearchTyping ctx={ctx} />;
  }
}

/** Suggestion text: the typed prefix light, the completion bold (classic autocomplete). */
function Completion({ text, q, size, t, onSel }: { text: string; q: string; size: number; t: Tone; onSel?: boolean }) {
  const ql = q.trim().toLowerCase();
  const pre = ql && text.toLowerCase().startsWith(ql) ? text.slice(0, ql.length) : "";
  const rest = text.slice(pre.length);
  return (
    <div style={{ ...oneLine, fontSize: size, lineHeight: 1.2, flex: 1 }}>
      {pre ? <span style={{ fontFamily: FONT.text, color: onSel ? t.ink : t.muted }}>{pre}</span> : null}
      <span style={{ fontFamily: FONT.displayBold, color: t.ink }}>{rest}</span>
    </div>
  );
}

function SearchTyping({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const q = props.title?.trim() ?? "";
  const items = itemsOf(ctx, 6);
  const n = items.length;
  const hl = hlIndex(ctx, n);
  const engine = props.subtitle?.trim() ?? "";
  const engH = engine ? 110 : 0;
  const pillH = 130;
  const rowH = 96;
  const typeS = Math.min(2.4, Math.max(0.5, q.length / 16));
  const total = 0.35 + typeS + 0.15 + 0.35 + n * 0.07 + (hl != null ? 0.95 : 0.1);
  const at = clock(ctx, total);
  const tType = at(0.35);
  const tTypeEnd = at(0.35 + typeS);
  const tDrop = at(0.35 + typeS + 0.15);
  const tRows = tDrop + Math.round(0.12 * fps);
  const tTap = hl != null ? at(0.35 + typeS + 0.15 + 0.35 + n * 0.07 + 0.45) : null;
  const shown = typedN(ctx, q, tType, tTypeEnd - tType);
  const tap = tapAt(ctx, tTap);
  const picked = tTap != null && hl != null && frame >= tTap + 3 ? items[hl]!.text : null;
  const field = picked ?? q.slice(0, shown);
  const fieldSize = fitLine(picked ?? q, W - 110 - 120, 42, 30, KT);
  const e = n ? inT(ctx, tDrop, Math.round(0.4 * fps)) : 0;
  const fullH = H - engH;
  const cardH = pillH + e * (fullH - pillH);
  const seq = listSequence(n, { ...ctx.anim, stagger: 0.07 }, seqOpts(ctx, tRows));
  const typing = frame < tTypeEnd + 2 && !picked;
  return (
    <div style={{ ...fill, ...cardIn(ctx) }}>
      <div style={{ ...abs(0, 0, W, engH + cardH), ...card(t, engine ? 44 : Math.min(65, 44 + (1 - e) * 21)), overflow: "hidden" }}>
        {engine ? (
          <div style={{ ...abs(0, 0, W, engH), display: "flex", alignItems: "center", justifyContent: "center", gap: 14 }}>
            <div style={{ fontFamily: FONT.display, fontSize: fitLine(engine, W - 200, 60, 36), letterSpacing: "-0.035em", color: t.ink, ...oneLine }}>{engine}</div>
            <div style={{ width: 14, height: 14, borderRadius: 7, background: t.accent, marginTop: 18 }} />
          </div>
        ) : null}
        <div style={{ ...abs(engine ? 24 : 0, engH, engine ? W - 48 : W, pillH), display: "flex", alignItems: "center", gap: 24, padding: "0 36px", boxSizing: "border-box", ...(engine ? { borderRadius: 65, background: t.fill, height: pillH - 20, marginTop: 0 } : {}) }}>
          <GIcon icon="SEARCH" size={44} color={t.muted} stroke={2.2} />
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", fontFamily: FONT.text, fontSize: fieldSize, color: field ? t.ink : t.faint, whiteSpace: "nowrap", overflow: "hidden" }}>
            <span style={{ ...oneLine }}>{field || "Search"}</span>
            <Caret ctx={ctx} color={t.accent} height={fieldSize * 1.05} on={typing || (!picked && frame < tDrop)} />
          </div>
          <GIcon icon="MIC" size={40} color={t.faint} stroke={2} />
        </div>
        {n ? <div style={{ ...abs(36, engH + pillH - (engine ? 10 : 0), W - 72, 1.5), background: t.line, opacity: e }} /> : null}
        {items.map((it, i) => {
          const y = engH + pillH + 10 - (engine ? 10 : 0) + i * rowH;
          const isHl = hl === i;
          const sel = isHl && tTap != null ? prog(frame, tTap, 5) : 0;
          return (
            <div key={i} style={{ ...abs(16, y, W - 32, rowH - 6), borderRadius: 24, overflow: "hidden", ...css(seqStyle(ctx, seq, 0, i, { distance: 0.5 })) }}>
              <div style={{ ...fill, background: t.fill2, opacity: sel, transform: isHl ? `scale(${r4(tap.press)})` : undefined, borderRadius: 24 }} />
              {isHl ? <Ripple r={tap.ripple} x={120} y={(rowH - 6) / 2} size={520} color={t.ink} /> : null}
              <div style={{ ...fill, display: "flex", alignItems: "center", gap: 26, padding: "0 22px", transform: isHl ? `scale(${r4(tap.press)})` : undefined }}>
                <GIcon icon="SEARCH" size={34} color={t.faint} stroke={2.2} />
                <Completion text={it.text} q={q} size={fitLine(it.text, W - 220, 36, 30, KT)} t={t} onSel={sel > 0.5} />
                <svg width={30} height={30} viewBox="0 0 24 24" style={{ flex: "none" }}>
                  <path d="M7 17L17 7M9 7h8v8" fill="none" stroke={t.faint} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function inT(ctx: GCtx, start: number, len: number): number {
  return prog(ctx.frame, start, Math.max(1, len), ctx.ease);
}

/** Compact search field (results pages). */
function SearchField({ ctx, t, w, q, shown, typing }: { ctx: GCtx; t: Tone; w: number; q: string; shown: number; typing: boolean }) {
  const size = fitLine(q, w - 170, 36, 28, KT);
  return (
    <div style={{ width: w, height: 96, borderRadius: 48, background: t.fill, display: "flex", alignItems: "center", gap: 20, padding: "0 32px", boxSizing: "border-box" }}>
      <GIcon icon="SEARCH" size={38} color={t.muted} stroke={2.2} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", fontFamily: FONT.text, fontSize: size, color: t.ink, whiteSpace: "nowrap", overflow: "hidden" }}>
        <span style={oneLine}>{q.slice(0, shown)}</span>
        <Caret ctx={ctx} color={t.accent} height={size} on={typing} />
      </div>
      <GIcon icon="MIC" size={34} color={t.faint} stroke={2} />
    </div>
  );
}

function SearchResults({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const q = props.title?.trim() ?? "";
  const items = itemsOf(ctx, 6);
  const n = items.length;
  const hl = hlIndex(ctx, n);
  const pad = 36;
  const typeS = Math.min(1.1, Math.max(0.35, q.length / 30));
  const total = 0.3 + typeS + 0.2 + n * 0.12 + 0.5 + (hl != null ? 0.8 : 0);
  const at = clock(ctx, total);
  const tType = at(0.3);
  const tTypeEnd = at(0.3 + typeS);
  const tRows = at(0.3 + typeS + 0.2);
  const tTap = hl != null ? at(0.3 + typeS + 0.2 + n * 0.12 + 0.6) : null;
  const tap = tapAt(ctx, tTap);
  const seq = listSequence(n, { ...ctx.anim, stagger: 0.12 }, seqOpts(ctx, tRows));
  const tabs = ["All", "News", "Images", "Videos", "Shopping"];
  const tabsIn = inT(ctx, at(0.2), Math.round(0.4 * fps));
  let y = 216;
  const cw = W - pad * 2;
  return (
    <div style={{ ...fill, ...card(t, 44), overflow: "hidden", ...cardIn(ctx) }}>
      <div style={{ position: "absolute", left: pad, top: 28 }}>
        <SearchField ctx={ctx} t={t} w={cw} q={q} shown={typedN(ctx, q, tType, tTypeEnd - tType)} typing={frame < tTypeEnd + 4} />
      </div>
      <div style={{ ...abs(pad + 8, 138, cw, 52), display: "flex", gap: 40, opacity: tabsIn }}>
        {tabs.map((tb, i) => (
          <div key={tb} style={{ position: "relative", fontFamily: FONT.text, fontSize: 29, color: i === 0 ? t.ink : t.muted, height: 52 }}>
            {tb}
            {i === 0 ? <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 5, borderRadius: 3, background: t.accent, transform: `scaleX(${r4(tabsIn)})` }} /> : null}
          </div>
        ))}
      </div>
      <div style={{ ...abs(0, 196, W, 1.5), background: t.line }} />
      {items.map((it, i) => {
        const snip = fitBlock(it.sub, cw - 32, Math.min(2, linesEst(it.sub, 40, 2)) * 42, { max: 32, min: 32, lh: 42 / 32, k: KT, maxLines: 2 });
        const h = 130 + Math.min(2, linesEst(it.sub, 40, 2)) * 42;
        const top = y;
        y += h;
        const isHl = hl === i;
        const sel = isHl && tTap != null ? prog(frame, tTap, 6) : 0;
        const url = it.meta?.trim() || "example.com";
        const domain = url.replace(/^https?:\/\//, "").split(/[/›]/)[0]!.trim();
        return (
          <div key={i} style={{ ...abs(pad - 16, top, cw + 32, h - 14), borderRadius: 26, overflow: "hidden", ...css(seqStyle(ctx, seq, 0, i, { distance: 0.5 })) }}>
            <div style={{ ...fill, background: t.fill, opacity: sel }} />
            {isHl ? <Ripple r={tap.ripple} x={200} y={70} size={700} color={t.ink} /> : null}
            <div style={{ ...fill, padding: "6px 16px 0", transform: isHl ? `scale(${r4(tap.press)})` : undefined }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, height: 44 }}>
                <Avatar name={domain} size={38} />
                <div style={{ fontFamily: FONT.text, fontSize: 28, color: t.muted, ...oneLine }}>{url}</div>
              </div>
              <div style={{ marginTop: 6, height: 52, fontFamily: FONT.displayBold, fontSize: fitLine(it.text, cw - 32, 40, 32), lineHeight: "52px", color: sel > 0.5 ? (t.dark ? t.accent2 : t.ink) : t.dark ? t.accent : t.solid, textDecoration: sel > 0.5 ? "underline" : undefined, textDecorationThickness: 3, textUnderlineOffset: 6, ...oneLine }}>{it.text}</div>
              <Lines b={snip} style={{ marginTop: 4, fontFamily: FONT.text, color: t.muted }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Estimated wrapped lines (mirrors families/types.ts `lines`). */
function linesEst(text: string | null | undefined, perLine: number, max = 99): number {
  const s = (text ?? "").trim();
  if (!s) return 0;
  let n = 1;
  let cur = 0;
  for (const w of s.split(/\s+/)) {
    if (cur && cur + 1 + w.length > perLine) {
      n++;
      cur = w.length;
    } else cur += (cur ? 1 : 0) + w.length;
  }
  return Math.min(max, n);
}

function SearchAsk({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, fps } = ctx;
  const W = ctx.width;
  const q = props.title?.trim() ?? "";
  const items = itemsOf(ctx, 6);
  const n = Math.max(1, items.length);
  const hl = hlIndex(ctx, items.length);
  const pad = 40;
  const head = 160;
  const rowH = 110;
  const ans = hl != null ? fitBlock(items[hl]!.sub, W - pad * 2 - 20, Math.min(4, linesEst(items[hl]!.sub, 40, 4)) * 44, { max: 32, min: 32, lh: 44 / 32, k: KT, maxLines: 4 }) : null;
  const ansH = ans && ans.lines.length ? ans.h + 30 : 0;
  const total = 0.3 + n * 0.1 + 0.5 + (hl != null ? 0.4 + 0.5 : 0);
  const at = clock(ctx, total);
  const tRows = at(0.3);
  const tTap = hl != null ? at(0.3 + n * 0.1 + 0.6) : null;
  const tap = tapAt(ctx, tTap);
  const e = tTap != null ? inT(ctx, tTap + 3, Math.round(0.45 * fps)) : 0;
  const seq = listSequence(items.length, { ...ctx.anim, stagger: 0.1 }, seqOpts(ctx, tRows));
  const baseH = head + n * rowH + 40;
  const cardH = Math.min(ctx.height, baseH + e * ansH);
  const hIn = inT(ctx, 0, Math.round(0.45 * fps));
  return (
    <div style={{ ...fill, ...cardIn(ctx) }}>
      <div style={{ ...abs(0, 0, W, cardH), ...card(t, 44), overflow: "hidden" }}>
        <div style={{ ...abs(pad, 30, W - pad * 2, 44), display: "flex", alignItems: "center", gap: 14, opacity: hIn }}>
          <GIcon icon="SEARCH" size={30} color={t.faint} stroke={2.2} />
          <div style={{ fontFamily: FONT.text, fontSize: 28, color: t.muted, ...oneLine }}>{q}</div>
        </div>
        <div style={{ ...abs(pad, 84, W - pad * 2, 60), fontFamily: FONT.displayBold, fontSize: 44, lineHeight: "60px", letterSpacing: "-0.02em", color: t.ink, opacity: hIn, transform: `translateY(${r1((1 - hIn) * 12)}px)` }}>People also ask</div>
        {items.map((it, i) => {
          const isHl = hl === i;
          const y = head + i * rowH + (hl != null && i > hl ? e * ansH : 0);
          const rot = isHl ? e * 180 : 0;
          return (
            <div key={i} style={{ ...abs(0, y, W, rowH + (isHl ? e * ansH : 0)), ...css(seqStyle(ctx, seq, 0, i, { distance: 0.4 })) }}>
              <div style={{ ...abs(pad, 0, W - pad * 2, 1.5), background: t.line }} />
              <div style={{ ...abs(pad - 16, 8, W - pad * 2 + 32, rowH - 16), borderRadius: 22, overflow: "hidden", transform: isHl ? `scale(${r4(tap.press)})` : undefined }}>
                {isHl ? <div style={{ ...fill, background: t.fill, opacity: pressAt(ctx, tTap ?? 0, 14) }} /> : null}
                {isHl ? <Ripple r={tap.ripple} x={W * 0.4} y={(rowH - 16) / 2} size={760} color={t.ink} /> : null}
                <div style={{ ...fill, display: "flex", alignItems: "center", gap: 20, padding: "0 16px" }}>
                  <div style={{ flex: 1, fontFamily: FONT.text, fontSize: fitLine(it.text, W - pad * 2 - 90, 36, 30, KT), color: t.ink, ...oneLine }}>{it.text}</div>
                  <Glyph d={G.chevron} size={40} color={isHl && e > 0.5 ? t.accent : t.muted} stroke={2.4} style={{ transform: `rotate(${r1(rot)}deg)` }} />
                </div>
              </div>
              {isHl && ans ? (
                <div style={{ ...abs(pad + 4, rowH - 6, W - pad * 2 - 8, ans.h), opacity: clamp01(e * 1.6 - 0.4), transform: `translateY(${r1((1 - e) * -14)}px)`, borderLeft: `4px solid ${rgba(t.accent, 0.8)}`, paddingLeft: 22, boxSizing: "border-box" }}>
                  <Lines b={ans} style={{ fontFamily: FONT.text, color: t.muted }} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SearchSpotlight({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const q = props.title?.trim() ?? "";
  const items = itemsOf(ctx, 6);
  const n = items.length;
  const hl = hlIndex(ctx, n);
  const fieldH = 130;
  const rowH = 104;
  const typeS = Math.min(2, Math.max(0.4, q.length / 16));
  const total = 0.3 + typeS + 0.15 + n * 0.08 + 0.3 + (hl != null ? 0.25 * hl + 0.7 : 0);
  const at = clock(ctx, total);
  const tType = at(0.3);
  const tTypeEnd = at(0.3 + typeS);
  const tRows = at(0.3 + typeS + 0.15);
  const tSel = at(0.3 + typeS + 0.15 + n * 0.08 + 0.3);
  const tTap = hl != null ? at(0.3 + typeS + 0.15 + n * 0.08 + 0.3 + 0.25 * hl + 0.35) : null;
  const tap = tapAt(ctx, tTap);
  const seq = listSequence(n, { ...ctx.anim, stagger: 0.08 }, seqOpts(ctx, tRows));
  const size = fitLine(q, W - 220, 46, 32);
  // Selection bar: appears on row 0, then steps down to the highlight.
  const selTarget = hl ?? 0;
  let selPos = 0;
  for (let k = 1; k <= selTarget; k++) selPos += inT(ctx, tSel + Math.round((k - 1) * 0.25 * fps) + Math.round(0.2 * fps), Math.round(0.18 * fps));
  const selOn = n ? inT(ctx, tSel, Math.round(0.25 * fps)) : 0;
  const rowsTop = fieldH + 14;
  return (
    <div style={{ ...fill, ...card(t, 40), overflow: "hidden", ...cardIn(ctx) }}>
      <div style={{ ...abs(0, 0, W, fieldH), display: "flex", alignItems: "center", gap: 26, padding: "0 40px", boxSizing: "border-box" }}>
        <GIcon icon="SEARCH" size={50} color={t.muted} stroke={2.2} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", fontFamily: FONT.displayBold, fontSize: size, letterSpacing: "-0.015em", color: t.ink, whiteSpace: "nowrap", overflow: "hidden" }}>
          <span style={oneLine}>{q.slice(0, typedN(ctx, q, tType, tTypeEnd - tType)) || <span style={{ color: t.faint }}>Search</span>}</span>
          <Caret ctx={ctx} color={t.accent} height={size * 1.05} on={frame < tTypeEnd + 4} />
        </div>
      </div>
      {n ? <div style={{ ...abs(0, fieldH, W, 1.5), background: t.line, opacity: inT(ctx, tRows, 8) }} /> : null}
      {n ? <div style={{ ...abs(14, rowsTop + selPos * rowH, W - 28, rowH - 8), borderRadius: 24, background: solidFill(t.solid), opacity: selOn * clamp01(seq.done ? 1 : 1), transform: `scale(${r4(hl != null ? tap.press : 1)})`, boxShadow: `0 10px 24px ${rgba("#000000", 0.18)}` }} /> : null}
      {items.map((it, i) => {
        const on = selOn > 0.5 && Math.round(selPos) === i;
        const ink = on ? t.onSolid : t.ink;
        const tint = it.color && it.color !== "AUTO" ? colorOf(ctx, it.color, i) : APP_TINTS[i % APP_TINTS.length]!;
        return (
          <div key={i} style={{ ...abs(14, rowsTop + i * rowH, W - 28, rowH - 8), display: "flex", alignItems: "center", gap: 24, padding: "0 22px", boxSizing: "border-box", ...css(seqStyle(ctx, seq, 0, i, { distance: 0.4 })) }}>
            <div style={{ width: 62, height: 62, borderRadius: 16, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(160deg, ${mix(tint, "#FFFFFF", 0.2)} 0%, ${tint} 60%, ${mix(tint, "#000000", 0.2)} 100%)` }}>
              <GIcon icon={it.icon ?? "SEARCH"} size={36} color="#FFFFFF" stroke={2.1} />
            </div>
            <div style={{ flex: 1, fontFamily: FONT.text, fontSize: fitLine(it.text, W - 380, 36, 30, KT), color: ink, ...oneLine }}>{it.text}</div>
            {on && hl === i && tap.done > 0 ? <Glyph d={G.enter} size={36} color={ink} stroke={2.2} style={{ opacity: tap.done }} /> : it.meta ? <div style={{ fontFamily: FONT.text, fontSize: 28, color: on ? rgba(t.onSolid, 0.75) : t.faint, flex: "none", maxWidth: 220, ...oneLine }}>{it.meta}</div> : null}
            {on && hl === i ? <Ripple r={tap.ripple} x={W * 0.3} y={(rowH - 8) / 2} size={700} color={t.onSolid} /> : null}
          </div>
        );
      })}
    </div>
  );
}

// ===================================================================== BROWSER

function Browser({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "LOADING":
      return <BrowserLoading ctx={ctx} />;
    case "ERROR":
      return <BrowserError ctx={ctx} />;
    case "COOKIE":
      return <BrowserCookie ctx={ctx} />;
    default:
      return <BrowserWindow ctx={ctx} />;
  }
}

const CHROME_H = 116;

/** Neutral window chrome: grey dots, URL field typing in, progress line. */
function Chrome({ ctx, t, w, url, shown, typing, progress }: { ctx: GCtx; t: Tone; w: number; url: string; shown: number; typing: boolean; progress: number }) {
  const size = fitLine(url, w - 360, 30, 28, KT);
  return (
    <div style={{ ...abs(0, 0, w, CHROME_H), background: t.dark ? rgba("#FFFFFF", 0.05) : "#ECECF0", borderBottom: `1.5px solid ${t.line}` }}>
      <div style={{ ...abs(34, 0, 90, CHROME_H), display: "flex", alignItems: "center", gap: 12 }}>
        {[0, 1, 2].map((k) => (
          <div key={k} style={{ width: 18, height: 18, borderRadius: 9, background: t.dark ? rgba("#FFFFFF", 0.22 - k * 0.04) : mix("#B9B9C2", "#ECECF0", k * 0.18) }} />
        ))}
      </div>
      <div style={{ ...abs(150, 24, w - 240, CHROME_H - 48), borderRadius: 34, background: t.dark ? rgba("#FFFFFF", 0.09) : "#FFFFFF", display: "flex", alignItems: "center", gap: 14, padding: "0 26px", boxSizing: "border-box", boxShadow: t.dark ? undefined : `0 1px 2px ${rgba("#000000", 0.08)}` }}>
        <Glyph d={G.lock} size={26} color={t.muted} stroke={2.2} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", fontFamily: FONT.text, fontSize: size, color: t.ink, whiteSpace: "nowrap", overflow: "hidden" }}>
          <span style={oneLine}>{url.slice(0, shown)}</span>
          <Caret ctx={ctx} color={t.accent} height={size} on={typing} />
        </div>
      </div>
      <div style={{ ...abs(w - 74, 0, 40, CHROME_H), display: "flex", alignItems: "center" }}>
        <Glyph d={G.reload} size={34} color={t.muted} stroke={2.2} style={{ transform: progress > 0 && progress < 1 ? `rotate(${r1(progress * 360)}deg)` : undefined }} />
      </div>
      {progress > 0 && progress < 1.2 ? <div style={{ ...abs(0, CHROME_H - 5, w * Math.min(1, progress), 5), background: t.accent, opacity: progress >= 1 ? clamp01((1.2 - progress) * 5) : 1, boxShadow: `0 0 10px ${rgba(t.accent, 0.5)}` }} /> : null}
    </div>
  );
}

/** Shimmering skeleton bar. */
function Skel({ ctx, t, style }: { ctx: GCtx; t: Tone; style: CSSProperties }) {
  const ph = ((ctx.frame / ctx.fps) * 0.9) % 1;
  const base = t.dark ? rgba("#FFFFFF", 0.08) : "#E9E9EE";
  const hi = t.dark ? rgba("#FFFFFF", 0.16) : "#F6F6F9";
  return <div style={{ borderRadius: 14, background: `linear-gradient(100deg, ${base} ${r1(ph * 140 - 40)}%, ${hi} ${r1(ph * 140 - 20)}%, ${base} ${r1(ph * 140)}%)`, ...style }} />;
}

function urlOf(ctx: GCtx, fallback: string): string {
  return ctx.props.meta?.trim() || fallback;
}

function BrowserWindow({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const url = urlOf(ctx, "yoursite.com");
  const site = props.subtitle?.trim() || url.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/.]/)[0] || "Site";
  const typeS = Math.min(1.6, Math.max(0.4, url.length / 18));
  const total = 0.3 + typeS + 0.9 + 0.7;
  const at = clock(ctx, total);
  const tType = at(0.3);
  const tTypeEnd = at(0.3 + typeS);
  const tLoadEnd = at(0.3 + typeS + 0.9);
  const pr = prog(ctx.frame, tTypeEnd + 2, Math.max(4, tLoadEnd - tTypeEnd - 2), (x) => 1 - (1 - x) * (1 - x));
  const progress = ctx.frame < tTypeEnd + 2 ? 0 : ctx.frame >= tLoadEnd + 8 ? 2 : pr + (ctx.frame >= tLoadEnd ? (ctx.frame - tLoadEnd) * 0.03 : 0);
  const skelOn = inT(ctx, tTypeEnd + 2, Math.round(0.25 * fps));
  const pad = 48;
  const cw = W - pad * 2;
  const reveal = (k: number) => inT(ctx, tLoadEnd + Math.round(k * 0.12 * fps), Math.round(0.4 * fps));
  const head = fitBlock(props.title, cw, 128, { max: 54, min: 40, lh: 1.12, maxLines: 2 });
  const body = fitBlock(props.body, cw, 3 * 46, { max: 34, min: 34, lh: 46 / 34, k: KT, maxLines: 3 });
  const y0 = CHROME_H;
  const navY = y0 + 30;
  const imgY = navY + 92;
  const imgH = Math.max(160, H - imgY - 30 - 40 - 128 - 20 - 3 * 46 - 36);
  const hY = imgY + imgH + 34;
  const bY = hY + Math.max(head.h, 100) + 18;
  const swap = (k: number, skel: ReactNode, real: ReactNode) => {
    const r = reveal(k);
    return (
      <>
        {r < 1 ? <div style={{ opacity: skelOn * (1 - r) }}>{skel}</div> : null}
        {r > 0 ? <div style={{ opacity: r, transform: `translateY(${r1((1 - r) * 10)}px)` }}>{real}</div> : null}
      </>
    );
  };
  return (
    <div style={{ ...fill, ...card(t, 40), overflow: "hidden", ...cardIn(ctx) }}>
      <Chrome ctx={ctx} t={t} w={W} url={url} shown={typedN(ctx, url, tType, tTypeEnd - tType)} typing={ctx.frame < tTypeEnd + 4} progress={progress} />
      {swap(
        0,
        <>
          <Skel ctx={ctx} t={t} style={abs(pad, navY, 60, 60, { borderRadius: 18 })} />
          <Skel ctx={ctx} t={t} style={abs(pad + 80, navY + 16, 220, 28)} />
        </>,
        <div style={{ ...abs(pad, navY, cw, 60), display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ width: 60, height: 60, borderRadius: 18, background: solidFill(t.solid), display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, fontSize: 32, color: t.onSolid }}>{site.slice(0, 1).toUpperCase()}</div>
          <div style={{ flex: 1, fontFamily: FONT.displayBold, fontSize: 36, color: t.ink, letterSpacing: "-0.02em", ...oneLine }}>{site}</div>
          <Glyph d={G.menu} size={40} color={t.muted} stroke={2.4} />
        </div>,
      )}
      {swap(1, <Skel ctx={ctx} t={t} style={abs(pad, imgY, cw, imgH, { borderRadius: 30 })} />, <div style={abs(pad, imgY, cw, imgH)}><PlaceholderArt seed={site + url} w={cw} h={imgH} radius={30} zoom={1.08 - 0.08 * reveal(1)} /></div>)}
      {swap(
        2,
        <>
          <Skel ctx={ctx} t={t} style={abs(pad, hY + 6, cw * 0.92, 44)} />
          <Skel ctx={ctx} t={t} style={abs(pad, hY + 62, cw * 0.6, 44)} />
        </>,
        <Lines b={head} style={{ ...abs(pad, hY, cw, head.h), fontFamily: FONT.displayBold, letterSpacing: "-0.02em", color: t.ink }} />,
      )}
      {swap(
        3,
        <>
          {[0, 1, 2].map((k) => (
            <Skel key={k} ctx={ctx} t={t} style={abs(pad, bY + 10 + k * 46, cw * (k === 2 ? 0.55 : 0.97), 26)} />
          ))}
        </>,
        <Lines b={body} style={{ ...abs(pad, bY, cw, body.h), fontFamily: FONT.text, color: t.muted }} />,
      )}
    </div>
  );
}

function BrowserLoading({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const url = urlOf(ctx, "yoursite.com");
  const stall = Math.max(0, Math.min(100, props.items[0]?.value ?? 100));
  const typeS = Math.min(1.4, Math.max(0.4, url.length / 18));
  const total = 0.3 + typeS + 2.0;
  const at = clock(ctx, total);
  const tType = at(0.3);
  const tTypeEnd = at(0.3 + typeS);
  const tEnd = at(total);
  const x = clamp01((frame - tTypeEnd) / Math.max(1, tEnd - tTypeEnd));
  // Believable loader: rushes, crawls, then lands (or stalls at the given %).
  const curve = x < 0.45 ? (1 - (1 - x / 0.45) ** 2) * 0.72 : 0.72 + (1 - (1 - (x - 0.45) / 0.55) ** 3) * 0.28;
  const pct = (stall / 100) * curve;
  const done = stall >= 100 && x >= 1;
  const spin = (frame / fps) * 360 * 1.1;
  const status = props.title?.trim() || "Loading…";
  const pad = 56;
  const midY = CHROME_H + (H - CHROME_H) / 2;
  const sub = props.body?.trim() ?? "";
  const barW = W - pad * 2;
  const label = `${Math.floor(pct * 100)}%`;
  return (
    <div style={{ ...fill, ...card(t, 40), overflow: "hidden", ...cardIn(ctx) }}>
      <Chrome ctx={ctx} t={t} w={W} url={url} shown={typedN(ctx, url, tType, tTypeEnd - tType)} typing={frame < tTypeEnd + 4} progress={frame < tTypeEnd ? 0 : done ? 2 : Math.max(0.02, pct)} />
      <div style={{ ...abs(pad, midY - 110, barW, 86), display: "flex", alignItems: "center", gap: 26 }}>
        <div style={{ width: 76, height: 76, flex: "none", position: "relative" }}>
          {done ? (
            <div style={{ ...fill, borderRadius: "50%", background: solidFill(t.positive), display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${r4(springAt(frame, fps, tEnd, ctx.f.springs.soft, Math.round(0.6 * fps)))})` }}>
              <Glyph d={G.check} size={44} color={onFill(t.positive)} stroke={3} />
            </div>
          ) : (
            <svg width={76} height={76} viewBox="0 0 76 76" style={{ transform: `rotate(${r1(spin)}deg)` }}>
              <circle cx={38} cy={38} r={31} fill="none" stroke={t.line} strokeWidth={8} />
              <circle cx={38} cy={38} r={31} fill="none" stroke={t.accent} strokeWidth={8} strokeLinecap="round" strokeDasharray={`${r1(2 * Math.PI * 31 * 0.28)} ${r1(2 * Math.PI * 31)}`} />
            </svg>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: FONT.displayBold, fontSize: fitLine(status, barW - 120, 44, 32), letterSpacing: "-0.02em", color: t.ink, ...oneLine }}>{status}</div>
          {sub ? <div style={{ marginTop: 4, fontFamily: FONT.text, fontSize: 28, color: t.muted, ...oneLine }}>{sub}</div> : null}
        </div>
      </div>
      <div style={{ ...abs(pad, midY + 20, barW - 120, 18), borderRadius: 9, background: t.fill2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${r1(pct * 100)}%`, borderRadius: 9, background: `linear-gradient(90deg, ${mix(t.accent, t.surface, 0.25)}, ${t.accent})` }} />
      </div>
      <div style={{ ...abs(W - pad - 104, midY + 4, 104, 50), textAlign: "right", fontFamily: FONT.display, fontSize: 40, color: t.ink, fontVariantNumeric: "tabular-nums" }}>{label}</div>
    </div>
  );
}

function BrowserError({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const url = urlOf(ctx, "yoursite.com/your-plan");
  const code = props.title?.trim() || "404";
  const digits = code.length <= 4 ? code.split("") : null;
  const typeS = Math.min(1.4, Math.max(0.4, url.length / 18));
  const total = 0.3 + typeS + 0.3 + 0.9 + 0.5;
  const at = clock(ctx, total);
  const tType = at(0.3);
  const tTypeEnd = at(0.3 + typeS);
  const tCode = at(0.3 + typeS + 0.3);
  const tBody = at(0.3 + typeS + 0.3 + 0.6);
  const tBtn = at(0.3 + typeS + 0.3 + 0.9);
  const pad = 56;
  const cw = W - pad * 2;
  const body = fitBlock(props.body, cw - 40, 3 * 46, { max: 36, min: 34, lh: 46 / 36, k: KT, maxLines: 3 });
  const btn = props.items[0]?.text?.trim() ?? "";
  const codeSize = digits ? Math.min(220, Math.floor((cw - 40) / (digits.length * 0.66))) : fitLine(code, cw, 110, 54);
  const codeTop = CHROME_H + 46;
  const codeH = digits ? codeSize * 1.02 : codeSize * 1.2;
  const bodyTop = codeTop + codeH + 26;
  const loadP = frame < tTypeEnd ? 0 : Math.min(2, (frame - tTypeEnd) / Math.max(1, tCode - tTypeEnd));
  return (
    <div style={{ ...fill, ...card(t, 40), overflow: "hidden", ...cardIn(ctx) }}>
      <Chrome ctx={ctx} t={t} w={W} url={url} shown={typedN(ctx, url, tType, tTypeEnd - tType)} typing={frame < tTypeEnd + 4} progress={loadP > 1 ? 2 : loadP} />
      <div style={{ ...abs(pad, codeTop, cw, codeH), display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
        {digits ? (
          digits.map((d, i) => {
            const st = tCode + Math.round(i * 0.1 * fps);
            const s = springAt(frame, fps, st, ctx.f.springs.settle, Math.round(0.8 * fps));
            // the last digit loses a screw and swings
            const age = frame - (tCode + Math.round(0.75 * fps));
            const swing = i === digits.length - 1 && age > 0 ? 14 + Math.sin(age * 0.32) * 10 * Math.exp(-age / (0.9 * fps)) : 0;
            return (
              <div key={i} style={{ fontFamily: FONT.display, fontSize: codeSize, lineHeight: 1, letterSpacing: "-0.04em", color: i === 1 ? t.accent : t.ink, opacity: prog(frame, st, 4), transform: `translateY(${r1((1 - Math.min(1.05, s)) * -160)}px) rotate(${r1(swing)}deg)`, transformOrigin: "15% 10%", display: "inline-block" }}>
                {d}
              </div>
            );
          })
        ) : (
          <div style={{ fontFamily: FONT.display, fontSize: codeSize, lineHeight: 1.1, letterSpacing: "-0.03em", color: t.ink, ...oneLine, ...css(enterStyle(ctx, tCode, Math.round(0.5 * fps))) }}>{code}</div>
        )}
      </div>
      <div style={{ ...abs(pad + 20, bodyTop, cw - 40, body.h), textAlign: "center", ...css(enterStyle(ctx, tBody, Math.round(0.45 * fps))) }}>
        <Lines b={body} style={{ fontFamily: FONT.text, color: t.muted }} lineStyle={() => ({ textAlign: "center" })} />
      </div>
      {btn ? (
        <div style={{ ...abs(0, Math.min(H - 120, bodyTop + body.h + 34), W, 88), display: "flex", justifyContent: "center", ...css(enterStyle(ctx, tBtn, Math.round(0.45 * fps), { style: "POP" })) }}>
          <div style={{ height: 88, borderRadius: 44, padding: "0 46px", display: "flex", alignItems: "center", gap: 14, boxShadow: `inset 0 0 0 2.5px ${t.line}`, background: t.fill, fontFamily: FONT.displayBold, fontSize: fitLine(btn, cw - 160, 34, 28), color: t.ink, maxWidth: cw, boxSizing: "border-box" }}>
            <Glyph d={G.broken} size={34} color={t.muted} stroke={2.2} />
            <span style={oneLine}>{btn}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BrowserCookie({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const pad = 44;
  const title = props.title?.trim() || "We value your privacy";
  const btns = itemsOf(ctx, 3).map((it) => it.text.trim()).filter(Boolean);
  const n = btns.length;
  const hl = hlIndex(ctx, n);
  const body = fitBlock(props.body, W - pad * 2, 4 * 46, { max: 34, min: 34, lh: 46 / 34, k: KT, maxLines: 4 });
  const total = 0.6 + 0.4 + n * 0.1 + (hl != null ? 1.3 : 0.2);
  const at = clock(ctx, total);
  const up = springAt(frame, fps, 0, ctx.f.springs.settle, Math.round(0.8 * fps));
  const tBtn = at(0.6);
  const tTap = hl != null ? at(0.6 + 0.4 + n * 0.1 + 0.85) : null;
  const tap = tapAt(ctx, tTap);
  const btnY = H - pad - 92;
  const gap = 18;
  // Widths: the highlighted (or first) button is the big solid one.
  const main = hl ?? 0;
  const ws = btns.map((b) => Math.max(160, textW(b, 32, KT) + 70));
  const sumW = ws.reduce((a, b) => a + b, 0) + gap * Math.max(0, n - 1);
  const room = W - pad * 2;
  const scale = sumW > room ? room / sumW : 1;
  let x = pad;
  const bx: number[] = ws.map((w) => {
    const v = x;
    x += w * scale + gap;
    return v;
  });
  const extra = sumW < room && n ? (room - sumW) : 0;
  const exit = withExit(ctx, { opacity: 1, transform: "none" }, 0, 1);
  return (
    <div style={{ ...fill, opacity: prog(frame, 0, 4) * exit.opacity, transform: `translateY(${r1((1 - Math.min(1, up)) * 220)}px) ${exit.transform === "none" ? "" : exit.transform}`.trim() }}>
      <div style={{ ...fill, ...card(t, 40), overflow: "hidden" }}>
        <div style={{ ...abs(pad, pad, W - pad * 2, 72), display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ width: 66, height: 66, borderRadius: 20, background: t.fill, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
            <svg width={44} height={44} viewBox="0 0 24 24">
              <path d={G.cookie[0]} fill={mix("#C98A4B", t.surface, 0.12)} stroke={mix("#8A5A2B", t.surface, 0.1)} strokeWidth={1.4} strokeLinejoin="round" />
              {[
                [8, 10],
                [12, 15.5],
                [7.5, 15],
                [15.5, 12.5],
                [11, 8.5],
              ].map(([cx, cy], i) => (
                <circle key={i} cx={cx} cy={cy} r={1.15} fill="#5A3A1E" />
              ))}
            </svg>
          </div>
          <div style={{ flex: 1, fontFamily: FONT.displayBold, fontSize: fitLine(title, W - pad * 2 - 90, 42, 32), letterSpacing: "-0.02em", color: t.ink, ...oneLine }}>{title}</div>
        </div>
        <Lines b={body} style={{ ...abs(pad, pad + 72 + 22, W - pad * 2, body.h), fontFamily: FONT.text, color: t.muted }} />
        {btns.map((b, i) => {
          const isMain = i === main;
          const w = ws[i]! * scale + (isMain ? extra : 0);
          const left = bx[i]! + (i > main ? extra : 0);
          const isHl = hl === i;
          const s = enterStyle(ctx, tBtn + Math.round(i * 0.1 * fps), Math.round(0.4 * fps), { style: "POP" });
          const bg = isMain ? solidFill(t.solid) : t.fill;
          const ink = isMain ? t.onSolid : t.ink;
          return (
            <div key={i} style={{ ...abs(left, btnY, w, 92), ...css(s) }}>
              <div style={{ ...fill, borderRadius: 46, background: bg, overflow: "hidden", transform: isHl ? `scale(${r4(tap.press)})` : undefined, boxShadow: isMain ? `0 10px 24px ${rgba("#000000", 0.2)}` : `inset 0 0 0 2px ${t.line}` }}>
                {isHl ? <Ripple r={tap.ripple} x={w / 2} y={46} size={w * 1.4} color={ink} /> : null}
                <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center", gap: 12, fontFamily: FONT.displayBold, fontSize: Math.max(28, Math.round(32 * Math.min(1, scale + 0.05))), color: ink, padding: "0 18px" }}>
                  {isHl && tap.done > 0 ? <Glyph d={G.check} size={34} color={ink} stroke={3} style={{ opacity: tap.done }} /> : null}
                  <span style={oneLine}>{b}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {hl != null && tTap != null ? <Pointer ctx={ctx} x={bx[hl]! + (hl > main ? extra : 0) + (ws[hl]! * scale + (hl === main ? extra : 0)) / 2} y={btnY + 52} at={tTap} from={[W * 0.8, H + 60]} /> : null}
    </div>
  );
}

// ===================================================================== WEB_CARD

function WebCard({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "WIKI":
      return <WebWiki ctx={ctx} />;
    case "REVIEW":
      return <WebReview ctx={ctx} />;
    case "PRODUCT":
      return <WebProduct ctx={ctx} />;
    default:
      return <WebLink ctx={ctx} />;
  }
}

/** A card of computed height, centred in the box. */
function Centered({ ctx, t, h, radius = 40, children, style }: { ctx: GCtx; t: Tone; h: number; radius?: number; children: ReactNode; style?: CSSProperties }) {
  const ch = Math.min(ctx.height, h);
  return (
    <div style={{ ...fill, ...cardIn(ctx) }}>
      <div style={{ ...abs(0, Math.max(0, (ctx.height - ch) / 2), ctx.width, ch), ...card(t, radius), overflow: "hidden", ...style }}>{children}</div>
    </div>
  );
}

function elIn(ctx: GCtx, start: number, opts: { style?: GraphicAnimation["enter"]; distance?: number } = {}): CSSProperties {
  return css(enterStyle(ctx, start, Math.round(0.45 * ctx.fps), { blurOK: false, ...opts }));
}

function WebLink({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, fps } = ctx;
  const W = ctx.width;
  const pad = 40;
  const cw = W - pad * 2;
  const imgH = 400;
  const domain = props.meta?.trim() || "yoursite.com";
  const title = fitBlock(props.title, cw, 2 * 53, { max: 44, min: 36, lh: 1.2, maxLines: 2 });
  const body = fitBlock(props.body, cw, 2 * 42, { max: 32, min: 30, lh: 42 / 32, k: KT, maxLines: 2 });
  const h = imgH + 36 + 44 + 12 + title.h + (body.h ? 10 + body.h : 0) + 36;
  const at = clock(ctx, 1.2);
  const z = inT(ctx, 0, Math.round(1.1 * fps));
  return (
    <Centered ctx={ctx} t={t} h={h}>
      <PlaceholderArt seed={domain + (props.title ?? "")} w={W} h={imgH} radius={0} icon={props.items[0]?.icon ?? "LINK"} zoom={1.12 - 0.12 * z} />
      <div style={{ position: "absolute", left: pad, top: imgH + 36, width: cw }}>
        <div style={{ height: 44, display: "flex", alignItems: "center", gap: 12, ...elIn(ctx, at(0.25)) }}>
          <GIcon icon="GLOBE" size={30} color={t.muted} stroke={2} />
          <div style={{ fontFamily: FONT.text, fontSize: 28, color: t.muted, textTransform: "lowercase", ...oneLine }}>{domain}</div>
        </div>
        <Lines b={title} style={{ marginTop: 12, fontFamily: FONT.displayBold, letterSpacing: "-0.02em", color: t.ink, ...elIn(ctx, at(0.38)) }} />
        {body.h ? <Lines b={body} style={{ marginTop: 10, fontFamily: FONT.text, color: t.muted, ...elIn(ctx, at(0.5)) }} /> : null}
      </div>
    </Centered>
  );
}

function WebWiki({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, fps } = ctx;
  const W = ctx.width;
  const pad = 48;
  const cw = W - pad * 2;
  const term = props.title?.trim() ?? "";
  const facts = itemsOf(ctx, 4);
  const sub = props.subtitle?.trim() ?? "";
  const body = fitBlock(props.body, cw, Math.max(1, linesEst(props.body, 40, 6)) * 46, { max: 34, min: 34, lh: 46 / 34, k: KT, maxLines: 6 });
  const titleSize = fitLine(term, cw - 100, 68, 44, KS);
  const yRule = pad + 80 + (sub ? 44 : 0) + 18;
  const yBody = yRule + 30;
  const yFacts = yBody + body.h + (facts.length ? 22 : 0);
  const h = yFacts + facts.length * 70 + 40;
  const total = 0.5 + body.lines.length * 0.09 + 0.2 + facts.length * 0.1 + 0.2;
  const at = clock(ctx, total);
  const wipe = inT(ctx, at(0.1), Math.round(0.6 * fps));
  const rule = inT(ctx, at(0.35), Math.round(0.5 * fps));
  const seq = listSequence(facts.length, { ...ctx.anim, stagger: 0.1 }, seqOpts(ctx, at(0.5 + body.lines.length * 0.09 + 0.2)));
  return (
    <Centered ctx={ctx} t={t} h={h} radius={36}>
      <div style={{ ...abs(pad, pad, cw - 100, 80), fontFamily: FONT.serif, fontSize: titleSize, lineHeight: "80px", color: t.ink, clipPath: `inset(-10px ${r1((1 - wipe) * 100)}% -10px 0)`, ...oneLine }}>{term}</div>
      <div style={{ ...abs(W - pad - 72, pad + 6, 72, 72), borderRadius: 20, background: t.fill, display: "flex", alignItems: "center", justifyContent: "center", ...elIn(ctx, at(0.2), { style: "POP" }) }}>
        <GIcon icon="BOOK" size={40} color={t.accent} stroke={2} />
      </div>
      {sub ? <div style={{ ...abs(pad, pad + 82, cw, 40), fontFamily: FONT.text, fontStyle: "italic", fontSize: 30, color: t.muted, ...oneLine, ...elIn(ctx, at(0.3)) }}>{sub}</div> : null}
      <div style={{ ...abs(pad, yRule, cw, 2.5), background: t.ink, opacity: 0.85, transform: `scaleX(${r4(rule)})`, transformOrigin: "left" }} />
      <div style={{ ...abs(pad, yRule + 7, cw, 1.5), background: t.line, transform: `scaleX(${r4(rule)})`, transformOrigin: "left" }} />
      {body.lines.map((ln, i) => (
        <div key={i} style={{ ...abs(pad, yBody + i * 46, cw, 46), fontFamily: FONT.text, fontSize: body.size, lineHeight: "46px", color: t.ink, ...oneLine, ...elIn(ctx, at(0.45 + i * 0.09), { distance: 0.4 }) }}>
          {ln}
        </div>
      ))}
      {facts.map((f, i) => (
        <div key={i} style={{ ...abs(pad, yFacts + i * 70, cw, 70), display: "flex", alignItems: "center", gap: 20, borderTop: `1.5px solid ${t.line}`, boxSizing: "border-box", ...css(seqStyle(ctx, seq, 0, i, { distance: 0.4 })) }}>
          <div style={{ width: "40%", fontFamily: FONT.text, fontSize: 28, color: t.muted, ...oneLine }}>{f.text}</div>
          <div style={{ flex: 1, textAlign: "right", fontFamily: FONT.displayBold, fontSize: fitLine(f.sub ?? "", cw * 0.58, 32, 28), color: t.ink, ...oneLine }}>{f.sub ?? ""}</div>
        </div>
      ))}
    </Centered>
  );
}

function WebReview({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const pad = 44;
  const cw = W - pad * 2;
  const name = props.title?.trim() || "Your Name";
  const stars = Math.max(0, Math.min(5, props.items[0]?.value ?? 5));
  const head = props.subtitle?.trim() ?? "";
  const text = props.body?.trim() ? `“${props.body.trim()}”` : "";
  const body = fitBlock(text, cw, 5 * 48, { max: 36, min: 34, lh: 48 / 36, k: KT, maxLines: 5 });
  const yStars = pad + 88 + 22;
  const yBody = yStars + 56 + 20;
  const h = yBody + body.h + pad;
  const at = clock(ctx, 1.6);
  const tStars = at(0.35);
  const per = Math.round(0.11 * fps);
  const starP = clamp01((frame - tStars) / Math.max(1, per * 5));
  const pop = (i: number) => {
    if (i + 1 > Math.ceil(stars)) return 1;
    const a = frame - (tStars + i * per);
    return a < 0 ? 1 : 1 + 0.22 * Math.sin(clamp01(a / Math.round(0.25 * fps)) * Math.PI);
  };
  return (
    <Centered ctx={ctx} t={t} h={h}>
      <div style={{ ...abs(pad, pad, cw, 88), display: "flex", alignItems: "center", gap: 22, ...elIn(ctx, at(0.1)) }}>
        <Avatar name={name} size={88} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: FONT.displayBold, fontSize: fitLine(name, cw - 120, 38, 30), color: t.ink, letterSpacing: "-0.015em", ...oneLine }}>{name}</div>
          {props.meta ? <div style={{ marginTop: 2, fontFamily: FONT.text, fontSize: 28, color: t.muted, ...oneLine }}>{props.meta}</div> : null}
        </div>
      </div>
      <div style={{ ...abs(pad, yStars, cw, 56), display: "flex", alignItems: "center", gap: 20 }}>
        <Stars value={stars} size={50} color={t.accent} empty={t.fill2} p={starP} pop={pop} />
        {head ? <div style={{ flex: 1, fontFamily: FONT.displayBold, fontSize: fitLine(head, cw - 330, 34, 28), color: t.ink, ...oneLine, ...elIn(ctx, tStars + per * 5) }}>{head}</div> : null}
      </div>
      <Lines b={body} style={{ ...abs(pad, yBody, cw, body.h), fontFamily: FONT.text, color: t.ink, ...elIn(ctx, at(0.75)) }} />
    </Centered>
  );
}

function WebProduct({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const pad = 36;
  const cw = W - pad * 2;
  const imgH = 380;
  const price = props.items[0]?.value ?? null;
  const was = props.items[0]?.sub?.trim() ?? "";
  const rating = props.items[1]?.value ?? null;
  const count = props.items[1]?.sub?.trim() ?? "";
  const cta = props.items[2]?.text?.trim() || "Add to cart";
  const title = fitBlock(props.title, cw, 2 * 48, { max: 40, min: 34, lh: 1.2, maxLines: 2 });
  const sub = props.subtitle?.trim() ?? "";
  const ship = props.body?.trim() ?? "";
  let y = pad + imgH + 24;
  const yTitle = y;
  y += title.h;
  const ySub = y + 4;
  if (sub) y += 44;
  const yRate = y + 14;
  if (rating != null) y += 14 + 46;
  const yPrice = y + 12;
  if (price != null) y += 12 + 84;
  const yShip = y + 4;
  if (ship) y += 48;
  const yBtn = y + 20;
  const h = yBtn + 96 + pad;
  const total = 1.6 + 1.0;
  const at = clock(ctx, total);
  const tPrice = at(0.6);
  const tTap = at(1.85);
  const tap = tapAt(ctx, tTap);
  const shown = price != null ? counted(ctx, tPrice, price, 0, 1.6) : 0;
  const pt = price != null ? fmtValue(ctx, shown, price).text : "";
  const z = inT(ctx, 0, Math.round(1.1 * fps));
  return (
    <Centered ctx={ctx} t={t} h={h}>
      <div style={{ position: "absolute", left: pad, top: pad }}>
        <PlaceholderArt seed={(props.title ?? "") + "p"} w={cw} h={imgH} radius={28} icon={props.items[0]?.icon ?? "BAG"} zoom={1.1 - 0.1 * z} />
      </div>
      {props.meta ? (
        <div style={{ position: "absolute", left: pad + 20, top: pad + 20, height: 52, padding: "0 20px", borderRadius: 26, background: solidFill(t.solid), color: t.onSolid, fontFamily: FONT.displayBold, fontSize: 28, display: "flex", alignItems: "center", maxWidth: cw - 140, ...elIn(ctx, at(0.3), { style: "POP" }) }}>
          <span style={oneLine}>{props.meta}</span>
        </div>
      ) : null}
      <div style={{ position: "absolute", left: pad + cw - 84, top: pad + 20, width: 64, height: 64, borderRadius: 32, background: rgba("#FFFFFF", 0.92), display: "flex", alignItems: "center", justifyContent: "center", ...elIn(ctx, at(0.35), { style: "POP" }) }}>
        <GIcon icon="HEART" size={34} color="#111116" stroke={2.2} />
      </div>
      <Lines b={title} style={{ ...abs(pad, yTitle, cw, title.h), fontFamily: FONT.displayBold, letterSpacing: "-0.015em", color: t.ink, ...elIn(ctx, at(0.25)) }} />
      {sub ? <div style={{ ...abs(pad, ySub, cw, 40), fontFamily: FONT.text, fontSize: 30, color: t.muted, ...oneLine, ...elIn(ctx, at(0.32)) }}>{sub}</div> : null}
      {rating != null ? (
        <div style={{ ...abs(pad, yRate, cw, 46), display: "flex", alignItems: "center", gap: 14, ...elIn(ctx, at(0.42)) }}>
          <div style={{ fontFamily: FONT.displayBold, fontSize: 32, color: t.ink }}>{(Math.round(Math.max(0, Math.min(5, rating)) * 10) / 10).toFixed(1)}</div>
          <Stars value={rating} size={36} gap={4} color={t.accent} empty={t.fill2} p={clamp01((frame - at(0.42)) / Math.round(0.6 * fps))} />
          {count ? <div style={{ fontFamily: FONT.text, fontSize: 28, color: t.muted, ...oneLine }}>{count}</div> : null}
        </div>
      ) : null}
      {price != null ? (
        <div style={{ ...abs(pad, yPrice, cw, 84), display: "flex", alignItems: "baseline", gap: 18, ...elIn(ctx, tPrice) }}>
          <div style={{ fontFamily: FONT.display, fontSize: fitLine(pt, cw * 0.6, 70, 44), letterSpacing: "-0.03em", color: t.ink, fontVariantNumeric: "tabular-nums" }}>{pt}</div>
          {was ? <div style={{ fontFamily: FONT.text, fontSize: 32, color: t.faint, textDecoration: "line-through", textDecorationThickness: 3, ...oneLine }}>{was}</div> : null}
        </div>
      ) : null}
      {ship ? (
        <div style={{ ...abs(pad, yShip, cw, 44), display: "flex", alignItems: "center", gap: 14, ...elIn(ctx, at(0.75)) }}>
          <GIcon icon="TRUCK" size={34} color={t.positive} stroke={2} />
          <div style={{ fontFamily: FONT.text, fontSize: 30, color: t.positive, ...oneLine }}>{ship}</div>
        </div>
      ) : null}
      <div style={{ ...abs(pad, yBtn, cw, 96), ...elIn(ctx, at(0.9), { style: "POP" }) }}>
        <div style={{ ...fill, borderRadius: 48, overflow: "hidden", background: tap.done > 0 ? solidFill(t.positive) : solidFill(t.solid), transform: `scale(${r4(tap.press)})`, boxShadow: `0 12px 28px ${rgba("#000000", 0.22)}` }}>
          <Ripple r={tap.ripple} x={cw / 2} y={48} size={cw * 1.2} color="#FFFFFF" />
          <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center", gap: 14, fontFamily: FONT.displayBold, fontSize: 36, color: tap.done > 0 ? onFill(t.positive) : t.onSolid }}>
            {tap.done > 0 ? <Glyph d={G.check} size={38} color={onFill(t.positive)} stroke={3} style={{ opacity: tap.done }} /> : <GIcon icon="CART" size={38} color={t.onSolid} stroke={2.2} />}
            <span style={oneLine}>{tap.done > 0 ? "Added" : cta}</span>
          </div>
        </div>
      </div>
      <Pointer ctx={ctx} x={pad + cw * 0.62} y={yBtn + 60} at={tTap} from={[W + 40, yBtn + 240]} />
    </Centered>
  );
}

// ===================================================================== NEWS

function News({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "HEADLINE":
      return <NewsHeadline ctx={ctx} />;
    case "FRONT_PAGE":
      return <NewsFront ctx={ctx} />;
    case "ARTICLE":
      return <NewsArticle ctx={ctx} />;
    case "CLIPPINGS":
      return <NewsClippings ctx={ctx} />;
    case "AS_SEEN":
      return <NewsAsSeen ctx={ctx} />;
    default:
      return <NewsBreaking ctx={ctx} />;
  }
}

function NewsBreaking({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const red = ctx.p.negative;
  const tag = (props.subtitle?.trim() || "BREAKING").toUpperCase();
  const live = props.meta?.trim() ?? "";
  const tagSize = 40;
  const tagW = Math.min(W * 0.55, textW(tag, tagSize) * 1.08 + 64);
  const liveW = live ? Math.min(W - tagW - 20, textW(live, 30, KT) + 80) : 0;
  const head = fitBlock(props.title, W - 90, 136, { max: 54, min: 38, lh: 1.12, maxLines: 2 });
  const tickers = itemsOf(ctx, 6).map((i) => i.text.trim()).filter(Boolean);
  const exit = withExit(ctx, { opacity: 1, transform: "none" }, 0, 1);
  const tagIn = inT(ctx, 0, Math.round(0.35 * fps));
  const tagS = springAt(frame, fps, 0, ctx.f.springs.punch, Math.round(0.6 * fps));
  const panel = inT(ctx, Math.round(0.18 * fps), Math.round(0.5 * fps));
  const txt = inT(ctx, Math.round(0.36 * fps), Math.round(0.5 * fps));
  const tk = inT(ctx, Math.round(0.6 * fps), Math.round(0.4 * fps));
  const pulse = 0.55 + 0.45 * Math.abs(Math.sin((frame / fps) * Math.PI * 1.3));
  const sepW = 54;
  const itemW = tickers.map((s) => textW(s, 32, KT) + sepW);
  const loopW = Math.max(1, itemW.reduce((a, b) => a + b, 0));
  const reps = loopW > 0 ? Math.max(2, Math.ceil((W * 2) / loopW)) : 0;
  const off = ((Math.max(0, frame - Math.round(0.6 * fps)) / fps) * 130) % loopW;
  const panelBg = t.dark ? `linear-gradient(160deg, ${rgba("#262632", 0.96)}, ${rgba("#121218", 0.97)})` : "linear-gradient(170deg, #FFFFFF, #F3F3F6)";
  return (
    <div style={{ ...fill, opacity: exit.opacity, transform: exit.transform === "none" ? undefined : exit.transform }}>
      <div style={{ ...abs(0, 0, tagW, 78), borderRadius: "18px 18px 0 0", background: solidFill(red), display: "flex", alignItems: "center", justifyContent: "center", clipPath: `inset(0 ${r1((1 - tagIn) * 100)}% 0 0 round 18px 18px 0 0)`, transform: `scale(${r4(0.9 + 0.1 * Math.min(1.05, tagS))})`, transformOrigin: "0% 100%", boxShadow: `0 10px 24px ${rgba("#000000", 0.3)}` }}>
        <div style={{ fontFamily: FONT.display, fontSize: tagSize, letterSpacing: "0.06em", color: onFill(red), ...oneLine }}>{tag}</div>
      </div>
      {live ? (
        <div style={{ ...abs(tagW + 14, 10, liveW, 60), borderRadius: 16, background: rgba("#0B0B10", 0.82), display: "flex", alignItems: "center", gap: 14, padding: "0 22px", boxSizing: "border-box", opacity: tagIn, transform: `translateX(${r1((1 - tagIn) * -30)}px)` }}>
          <div style={{ width: 16, height: 16, borderRadius: 8, flex: "none", background: red, opacity: pulse, boxShadow: `0 0 ${r1(12 * pulse)}px ${rgba(red, 0.8)}` }} />
          <div style={{ fontFamily: FONT.displayBold, fontSize: 30, color: "#FFFFFF", letterSpacing: "0.03em", ...oneLine }}>{live}</div>
        </div>
      ) : null}
      <div style={{ ...abs(0, 78, W, 156), borderRadius: "0 22px 0 0", background: panelBg, overflow: "hidden", clipPath: `inset(0 ${r1((1 - panel) * 100)}% 0 0)`, boxShadow: `0 24px 50px ${rgba("#000000", 0.35)}` }}>
        <div style={{ ...abs(0, 0, 12, 156), background: red }} />
        <div style={{ ...abs(44, 0, W - 80, 156), display: "flex", alignItems: "center", overflow: "hidden" }}>
          <Lines b={head} style={{ fontFamily: FONT.display, letterSpacing: "-0.02em", color: t.ink, opacity: txt, transform: `translateY(${r1((1 - txt) * 40)}px)` }} />
        </div>
      </div>
      <div style={{ ...abs(0, 234, W, 82), borderRadius: "0 0 22px 22px", background: "#0E0E13", overflow: "hidden", opacity: tk, boxShadow: `0 20px 40px ${rgba("#000000", 0.35)}` }}>
        <div style={{ position: "absolute", left: 0, top: 0, height: 82, display: "flex", alignItems: "center", whiteSpace: "nowrap", transform: `translateX(${r1(-off + 150)}px)` }}>
          {Array.from({ length: tickers.length ? reps : 0 }).flatMap((_, r) =>
            tickers.map((s, i) => (
              <div key={`${r}-${i}`} style={{ display: "flex", alignItems: "center", flex: "none" }}>
                <span style={{ fontFamily: FONT.text, fontSize: 32, color: "#FFFFFF" }}>{s}</span>
                <span style={{ width: sepW, display: "flex", justifyContent: "center" }}>
                  <span style={{ width: 10, height: 10, transform: "rotate(45deg)", background: red, display: "inline-block" }} />
                </span>
              </div>
            )),
          )}
        </div>
        <div style={{ ...abs(0, 0, 130, 82), background: solidFill(red), display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `8px 0 18px ${rgba("#000000", 0.4)}` }}>
          <GIcon icon="NEWS" size={42} color={onFill(red)} stroke={2} />
        </div>
      </div>
    </div>
  );
}

/** A masked line-by-line rise for headlines. */
function RiseLines({ ctx, b, start, step, style, lineStyle }: { ctx: GCtx; b: Block; start: number; step: number; style?: CSSProperties; lineStyle?: CSSProperties }) {
  const lh = r1(b.size * b.lh);
  return (
    <div style={style}>
      {b.lines.map((ln, i) => {
        const p = inT(ctx, start + i * step, Math.round(0.55 * ctx.fps));
        return (
          <div key={i} style={{ height: lh, overflow: "hidden", paddingBottom: 0 }}>
            <div style={{ fontSize: b.size, lineHeight: `${lh}px`, whiteSpace: "nowrap", transform: `translateY(${r1((1 - p) * 105)}%)`, opacity: p > 0 ? 1 : 0, ...lineStyle }}>{ln}</div>
          </div>
        );
      })}
    </div>
  );
}

function OutletTile({ name, size, t }: { name: string; size: number; t: Tone }) {
  return (
    <div style={{ width: size, height: size, borderRadius: size * 0.24, flex: "none", background: t.dark ? "#FFFFFF" : "#111116", color: t.dark ? "#111116" : "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.serif, fontSize: Math.round(size * 0.62), lineHeight: 1 }}>
      {(name.replace(/^the\s+/i, "").trim()[0] ?? "N").toUpperCase()}
    </div>
  );
}

function NewsHeadline({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, fps } = ctx;
  const W = ctx.width;
  const pad = 48;
  const cw = W - pad * 2;
  const kicker = props.meta?.trim() ?? "";
  const title = fitBlock(props.title, cw, 3 * 67, { max: 62, min: 44, lh: 1.08, k: KS, maxLines: 3 });
  const dek = fitBlock(props.subtitle, cw, 2 * 44, { max: 34, min: 32, lh: 44 / 34, k: KT, maxLines: 2 });
  const yTitle = pad + 56 + 26;
  const yDek = yTitle + title.h + 20;
  const h = (dek.h ? yDek + dek.h : yTitle + title.h) + pad;
  const at = clock(ctx, 1.4);
  const bar = inT(ctx, at(0.15), Math.round(0.6 * fps));
  return (
    <Centered ctx={ctx} t={t} h={h} radius={36}>
      <div style={{ ...abs(0, 0, 8, h), background: t.accent, transform: `scaleY(${r4(bar)})`, transformOrigin: "top" }} />
      <div style={{ ...abs(pad, pad, cw, 56), display: "flex", alignItems: "center", gap: 18, ...elIn(ctx, at(0.1), { style: "SLIDE" }) }}>
        <OutletTile name={kicker || "News"} size={56} t={t} />
        {kicker ? <div style={{ fontFamily: FONT.displayBold, fontSize: 28, letterSpacing: "0.08em", textTransform: "uppercase", color: t.accent, ...oneLine }}>{kicker}</div> : null}
      </div>
      <RiseLines ctx={ctx} b={title} start={at(0.25)} step={Math.round(0.1 * fps)} style={{ ...abs(pad, yTitle, cw, title.h), fontFamily: FONT.serif, color: t.ink, letterSpacing: "-0.005em" }} />
      {dek.h ? <Lines b={dek} style={{ ...abs(pad, yDek, cw, dek.h), fontFamily: FONT.text, color: t.muted, ...elIn(ctx, at(0.25 + title.lines.length * 0.1 + 0.25)) }} /> : null}
    </Centered>
  );
}

function NewsFront({ ctx }: { ctx: GCtx }) {
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const dark = toneOf(ctx).dark;
  const paper = dark ? "#EDE6D6" : PAPER;
  const ink = PAPER_INK;
  const grey = mix(ink, paper, 0.78);
  const pad = 44;
  const cw = W - pad * 2;
  const mast = props.meta?.trim() || "The Daily Edition";
  const date = props.subtitle?.trim() ?? "";
  const head = fitBlock((props.title ?? "").toUpperCase(), cw, 3 * 100, { max: 104, min: 54, lh: 0.98, k: KS * 1.02, maxLines: 3 });
  const lead = fitBlock(props.body, cw, 3 * 44, { max: 34, min: 34, lh: 44 / 34, k: KS, maxLines: 3 });
  const spinLen = Math.round(1.0 * fps);
  const sp = prog(frame, 0, spinLen, (x) => 1 - (1 - x) ** 3);
  const land = springAt(frame, fps, Math.round(spinLen * 0.75), ctx.f.springs.punch, Math.round(0.5 * fps));
  const settle = frame > spinLen * 0.75 ? 1 + 0.03 * Math.sin(clamp01(land) * Math.PI) : 1;
  const exit = withExit(ctx, { opacity: 1, transform: "none" }, 0, 1);
  const yHead = 252;
  const yLead = yHead + head.h + 22;
  const yLow = yLead + lead.h + 30;
  const lowH = Math.max(120, H - pad - yLow);
  const photoW = Math.round(cw * 0.56);
  const colX = pad + photoW + 28;
  const colW = W - pad - colX;
  const nLines = Math.max(0, Math.floor((lowH - 4) / 26));
  return (
    <div style={{ ...fill, opacity: clamp01(sp * 3) * exit.opacity, transform: `rotate(${r1((1 - sp) * -720)}deg) scale(${r4((0.06 + 0.94 * sp) * settle)}) ${exit.transform === "none" ? "" : exit.transform}`.trim() }}>
      <div style={{ ...fill, borderRadius: 6, background: `linear-gradient(170deg, ${mix(paper, "#FFFFFF", 0.25)} 0%, ${paper} 60%, ${mix(paper, "#C9BFA8", 0.35)} 100%)`, boxShadow: `0 40px 90px ${rgba("#000000", 0.5)}, 0 10px 24px ${rgba("#000000", 0.3)}`, overflow: "hidden" }}>
        <div style={{ ...abs(pad, 40, cw, 110), display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.serif, fontSize: fitLine(mast, cw, 96, 50, KS), color: ink, letterSpacing: "-0.01em", whiteSpace: "nowrap", overflow: "hidden" }}>{mast}</div>
        <div style={{ ...abs(pad, 158, cw, 4), background: ink }} />
        <div style={{ ...abs(pad, 166, cw, 1.5), background: ink }} />
        <div style={{ ...abs(pad, 172, cw, 46), display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.text, fontSize: 28, letterSpacing: "0.06em", textTransform: "uppercase", color: mix(ink, paper, 0.25), ...oneLine }}>{date}</div>
        <div style={{ ...abs(pad, 222, cw, 1.5), background: ink }} />
        <div style={{ ...abs(pad, 226, cw, 4), background: ink }} />
        <Lines b={head} style={{ ...abs(pad, yHead, cw, head.h), fontFamily: FONT.serif, color: ink, letterSpacing: "-0.01em" }} lineStyle={() => ({ textAlign: "center", overflow: "visible" })} />
        <Lines b={lead} style={{ ...abs(pad, yLead, cw, lead.h), fontFamily: FONT.serif, color: mix(ink, paper, 0.12) }} lineStyle={() => ({ textAlign: "center" })} />
        <div style={{ ...abs(pad, yLow - 14, cw, 1.5), background: mix(ink, paper, 0.5) }} />
        <div style={{ ...abs(pad, yLow, photoW, lowH - 40), background: `radial-gradient(circle at 30% 35%, ${mix(ink, paper, 0.55)} 0%, ${mix(ink, paper, 0.72)} 45%, ${mix(ink, paper, 0.82)} 100%)`, overflow: "hidden" }}>
          <div style={{ ...fill, backgroundImage: `radial-gradient(${rgba(ink, 0.22)} 1.2px, transparent 1.6px)`, backgroundSize: "7px 7px" }} />
          <div style={{ position: "absolute", left: "18%", bottom: 0, width: "34%", height: "62%", borderRadius: "48% 48% 0 0", background: rgba(ink, 0.32) }} />
          <div style={{ position: "absolute", left: "26%", bottom: "54%", width: "18%", height: "22%", borderRadius: "50%", background: rgba(ink, 0.32) }} />
        </div>
        <div style={{ ...abs(pad, yLow + lowH - 30, photoW * 0.8, 9), borderRadius: 4, background: grey }} />
        {Array.from({ length: nLines }).map((_, i) => (
          <div key={i} style={{ ...abs(colX, yLow + 4 + i * 26, colW * (i % 5 === 4 ? 0.6 : 0.92 + 0.08 * hash01(i)), 9), borderRadius: 4, background: grey }} />
        ))}
      </div>
    </div>
  );
}

function NewsArticle({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame } = ctx;
  const W = ctx.width;
  const pad = 48;
  const cw = W - pad * 2;
  const src = props.meta?.trim() ?? "";
  const title = fitBlock(props.title, cw, 2 * 60, { max: 50, min: 40, lh: 1.15, k: KS, maxLines: 2 });
  const words = splitWords(props.body);
  const f = fitWords(words.length ? words : [" "], cw, 7 * 54, { max: 38, min: 34, lh: 1.42, k: KT, maxLines: 7 });
  const marks = matchPhrase(f.words, props.items[0]?.text);
  const lh = r1(f.size * 1.42);
  const yTitle = src ? pad + 52 + 24 : pad;
  const yBody = yTitle + title.h + (title.h ? 22 : 0);
  const bodyH = words.length ? f.lines.length * lh : 0;
  const h = yBody + bodyH + pad;
  const nMarked = marks.filter(Boolean).length;
  const total = 0.6 + 0.4 + Math.max(0.5, nMarked * 0.12) + 0.2;
  const at = clock(ctx, total);
  const tHl = at(0.9);
  const per = Math.max(2, Math.round((at(0.9 + Math.max(0.5, nMarked * 0.12)) - tHl) / Math.max(1, nMarked)));
  const hlColor = t.dark ? rgba(ctx.p.primary, 0.42) : rgba(mix(t.accent, "#FFE45C", 0.35), 0.5);
  const gap = f.size * 0.27;
  let k = 0;
  return (
    <Centered ctx={ctx} t={t} h={h} radius={36}>
      {src ? (
        <div style={{ ...abs(pad, pad, cw, 52), display: "flex", alignItems: "center", gap: 16, ...elIn(ctx, at(0.1)) }}>
          <OutletTile name={src} size={48} t={t} />
          <div style={{ fontFamily: FONT.displayBold, fontSize: 30, color: t.ink, ...oneLine }}>{src}</div>
        </div>
      ) : null}
      {title.h ? <Lines b={title} style={{ ...abs(pad, yTitle, cw, title.h), fontFamily: FONT.serif, color: t.ink, ...elIn(ctx, at(0.2)) }} /> : null}
      <div style={{ ...abs(pad, yBody, cw, bodyH), ...elIn(ctx, at(0.35)) }}>
        {words.length
          ? f.lines.map((ln, li) => (
              <div key={li} style={{ display: "flex", columnGap: gap, height: lh, alignItems: "center", whiteSpace: "nowrap" }}>
                {ln.map((wi, j) => {
                  const m = marks[wi];
                  let hp = 0;
                  if (m) {
                    hp = clamp01((frame - (tHl + k * per)) / per);
                    k++;
                  }
                  const nextMarked = m && j < ln.length - 1 && marks[ln[j + 1]!];
                  return (
                    <span key={wi} style={{ position: "relative", fontFamily: FONT.text, fontSize: f.size, lineHeight: `${lh}px`, color: m && hp > 0 ? t.ink : m ? t.ink : t.muted }}>
                      {m ? <span style={{ position: "absolute", left: -6, right: nextMarked ? -gap - 1 : -6, top: "16%", bottom: "12%", borderRadius: 6, background: hlColor, transform: `scaleX(${r4(hp)})`, transformOrigin: "left", zIndex: 0 }} /> : null}
                      <span style={{ position: "relative" }}>{f.words[wi]}</span>
                    </span>
                  );
                })}
              </div>
            ))
          : null}
      </div>
    </Centered>
  );
}

/** Torn-paper polygon (deterministic) for clippings. */
function torn(seed: number, w: number, h: number): string {
  const pts: string[] = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) pts.push(`${r1((i / steps) * w)}px ${r1(hash01(seed + i) * 7)}px`);
  pts.push(`${w}px ${r1(h * 0.5)}px`);
  for (let i = steps; i >= 0; i--) pts.push(`${r1((i / steps) * w)}px ${r1(h - hash01(seed + 40 + i) * 9)}px`);
  return `polygon(${pts.join(", ")})`;
}

function NewsClippings({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const items = itemsOf(ctx, 5);
  const n = Math.max(1, items.length);
  const title = props.title?.trim() ?? "";
  const top = title ? 110 : 30;
  const cw = Math.min(780, W - 60);
  const ch = 196;
  const step = 182;
  const total = 0.2 + n * 0.32 + 0.4;
  const at = clock(ctx, total);
  return (
    <div style={{ ...fill }}>
      {title ? (
        <div style={{ ...abs(0, 0, W, 84), display: "flex", justifyContent: "center" }}>
          <div style={{ height: 84, borderRadius: 42, padding: "0 40px", display: "flex", alignItems: "center", gap: 16, maxWidth: W - 40, boxSizing: "border-box", ...card(t, 42), ...cardIn(ctx) }}>
            <GIcon icon="NEWS" size={38} color={t.accent} stroke={2} />
            <span style={{ fontFamily: FONT.displayBold, fontSize: fitLine(title, W - 200, 40, 30), color: t.ink, ...oneLine }}>{title}</span>
          </div>
        </div>
      ) : null}
      {items.map((it, i) => {
        const left = i % 2 === 0 ? 20 : W - 20 - cw;
        const y = top + i * step;
        const rot = (i % 2 === 0 ? -1 : 1) * (2 + hash01(i + 3) * 1.6);
        const st = at(0.2 + i * 0.32);
        const s = springAt(frame, fps, st, ctx.f.springs.settle, Math.round(0.7 * fps));
        const o = prog(frame, st, 4);
        const ex = withExit(ctx, { opacity: 1, transform: "none" }, i, n);
        const outlet = (it.meta?.trim() || props.meta?.trim() || "").toUpperCase();
        const head = fitBlock(it.text, cw - 80, ch - 110, { max: 46, min: 34, lh: 1.08, k: KS, maxLines: 2 });
        return (
          <div key={i} style={{ ...abs(left, y, cw, ch), opacity: o * ex.opacity, transform: `translateY(${r1((1 - Math.min(1, s)) * -70)}px) rotate(${r1(rot + (1 - Math.min(1, s)) * rot * 2)}deg) scale(${r4(1.12 - 0.12 * Math.min(1, s))}) ${ex.transform === "none" ? "" : ex.transform}`.trim(), filter: `drop-shadow(0 18px 26px ${rgba("#000000", 0.38)})`, zIndex: i }}>
            <div style={{ ...fill, clipPath: torn(i * 97 + 11, cw, ch), background: `linear-gradient(175deg, ${mix(PAPER, "#FFFFFF", 0.35)} 0%, ${PAPER} 70%, ${mix(PAPER, "#D9CFB8", 0.5)} 100%)` }}>
              <div style={{ position: "absolute", left: 40, right: 40, top: 26, height: 40, display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ fontFamily: FONT.serif, fontSize: 28, letterSpacing: "0.14em", color: mix(PAPER_INK, PAPER, 0.35), ...oneLine }}>{outlet}</div>
                <div style={{ flex: 1, height: 1.5, background: mix(PAPER_INK, PAPER, 0.7) }} />
              </div>
              <Lines b={head} style={{ position: "absolute", left: 40, right: 40, top: 80, fontFamily: FONT.serif, color: PAPER_INK }} />
            </div>
            <div style={{ position: "absolute", left: cw / 2 - 70, top: -16, width: 140, height: 38, background: rgba("#FFFFFF", 0.5), transform: `rotate(${r1(-rot * 1.4)}deg)`, boxShadow: `inset 0 0 0 1px ${rgba("#FFFFFF", 0.4)}` }} />
          </div>
        );
      })}
    </div>
  );
}

/** Neutral type treatments for placeholder outlet names (never a real wordmark). */
function outletFace(i: number): { font: string; upper: boolean; spacing: string; skew?: number; boxed?: boolean; max: number } {
  switch (i % 6) {
    case 0:
      return { font: FONT.serif, upper: false, spacing: "-0.01em", max: 50 };
    case 1:
      return { font: FONT.display, upper: true, spacing: "0.16em", max: 34 };
    case 2:
      return { font: FONT.displayBold, upper: false, spacing: "-0.045em", max: 50 };
    case 3:
      return { font: FONT.serif, upper: true, spacing: "0.12em", max: 36 };
    case 4:
      return { font: FONT.display, upper: true, spacing: "0.04em", boxed: true, max: 32 };
    default:
      return { font: FONT.displayBold, upper: false, spacing: "-0.02em", skew: -10, max: 46 };
  }
}

function NewsAsSeen({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, fps } = ctx;
  const W = ctx.width;
  const items = itemsOf(ctx, 6);
  const n = Math.max(1, items.length);
  const cols = n <= 3 ? n : n === 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const title = props.title?.trim() ?? "";
  const top = title ? 110 : 30;
  const cellW = (W - 60) / cols;
  const seq = listSequence(items.length, { ...ctx.anim, stagger: 0.1 }, seqOpts(ctx, Math.round(0.35 * fps)));
  const hIn = inT(ctx, Math.round(0.1 * fps), Math.round(0.5 * fps));
  const ink = t.dark ? rgba("#FFFFFF", 0.9) : rgba("#111116", 0.86);
  const tw = title ? Math.min(W - 200, textW(title.toUpperCase(), 30, KT) * 1.25 + 20) : 0;
  return (
    <div style={{ ...fill, ...card(t, 40), overflow: "hidden", ...cardIn(ctx) }}>
      {title ? (
        <div style={{ ...abs(40, 36, W - 80, 50), display: "flex", alignItems: "center", gap: 24, opacity: hIn }}>
          <div style={{ flex: 1, height: 1.5, background: t.line, transform: `scaleX(${r4(hIn)})`, transformOrigin: "right" }} />
          <div style={{ fontFamily: FONT.text, fontSize: 30, letterSpacing: "0.22em", textTransform: "uppercase", color: t.muted, maxWidth: tw, ...oneLine }}>{title}</div>
          <div style={{ flex: 1, height: 1.5, background: t.line, transform: `scaleX(${r4(hIn)})`, transformOrigin: "left" }} />
        </div>
      ) : null}
      {items.map((it, i) => {
        const r = Math.floor(i / cols);
        const inRow = r === rows - 1 ? n - r * cols : cols;
        const c = i % cols;
        const rowOff = ((cols - inRow) * cellW) / 2;
        const x = 30 + rowOff + c * cellW;
        const y = top + r * 120;
        const face = outletFace(i);
        const name = face.upper ? it.text.toUpperCase() : it.text;
        const room = cellW - 36 - (face.boxed ? 40 : 0);
        const size = fitLine(name, room / (face.spacing.startsWith("0.1") || face.spacing.startsWith("0.2") ? 1.18 : 1), face.max, 26, face.font === FONT.serif ? KS : 1);
        return (
          <div key={i} style={{ ...abs(x, y, cellW, 120), display: "flex", alignItems: "center", justifyContent: "center", ...css(seqStyle(ctx, seq, 0, i, { distance: 0.4 })) }}>
            <div style={{ fontFamily: face.font, fontSize: size, letterSpacing: face.spacing, color: ink, transform: face.skew ? `skewX(${face.skew}deg)` : undefined, padding: face.boxed ? "6px 16px" : undefined, boxShadow: face.boxed ? `inset 0 0 0 3px ${ink}` : undefined, borderRadius: face.boxed ? 6 : undefined, maxWidth: cellW - 24, ...oneLine }}>{name}</div>
          </div>
        );
      })}
    </div>
  );
}

// ===================================================================== MEDIA_PLAYER

function MediaPlayer({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "MUSIC":
      return <MediaMusic ctx={ctx} />;
    case "TITLE_CARD":
      return <MediaTitleCard ctx={ctx} />;
    case "VOICE":
      return <MediaVoice ctx={ctx} />;
    default:
      return <MediaPodcast ctx={ctx} />;
  }
}

function PlayButton({ size, t, playing, press, ripple }: { size: number; t: Tone; playing: boolean; press: number; ripple: number | null }) {
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", flex: "none", position: "relative", overflow: "hidden", background: solidFill(t.solid), transform: `scale(${r4(press)})`, boxShadow: `0 12px 26px ${rgba("#000000", 0.3)}, inset 0 1.5px 0 ${rgba("#FFFFFF", 0.3)}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Ripple r={ripple} x={size / 2} y={size / 2} size={size * 1.6} color={t.onSolid} />
      {playing ? <Glyph d={G.pause} size={Math.round(size * 0.42)} color={t.onSolid} stroke={4.2} /> : <Glyph d={G.play} size={Math.round(size * 0.44)} color={t.onSolid} fillColor={t.onSolid} stroke={1.5} style={{ marginLeft: size * 0.06 }} />}
    </div>
  );
}

function MediaPodcast({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const pad = 40;
  const cover = 220;
  const colX = pad + cover + 30;
  const colW = W - colX - pad;
  const show = props.subtitle?.trim() ?? "";
  const title = fitBlock(props.title, colW, 2 * 50, { max: 44, min: 34, lh: 1.13, maxLines: 2 });
  const at = clock(ctx, 1.6);
  const tTap = at(1.0);
  const tap = tapAt(ctx, tTap);
  const playing = frame >= tTap + 3;
  const bars = 40;
  const wx = pad + 96 + 30;
  const ww = W - wx - pad;
  const bw = ww / bars;
  const progress = playing ? 0.12 + Math.min(0.5, ((frame - tTap) / fps) * 0.06) : 0.12;
  const wIn = inT(ctx, at(0.55), Math.round(0.6 * fps));
  return (
    <div style={{ ...fill, ...card(t, 40), overflow: "hidden", ...cardIn(ctx) }}>
      <div style={{ position: "absolute", left: pad, top: pad, ...elIn(ctx, at(0.1), { style: "POP" }) }}>
        <PlaceholderArt seed={show || props.title || "pod"} w={cover} h={cover} radius={30} icon="PODCAST">
          {show ? <div style={{ position: "absolute", left: 16, right: 16, bottom: 14, fontFamily: FONT.display, fontSize: fitLine(show, cover - 32, 30, 22), color: "#FFFFFF", textAlign: "center", ...oneLine }}>{show}</div> : null}
        </PlaceholderArt>
      </div>
      <div style={{ ...abs(colX, pad + 4, colW, cover - 8), display: "flex", flexDirection: "column", justifyContent: "center", gap: 8 }}>
        {show ? <div style={{ fontFamily: FONT.text, fontSize: 28, color: t.accent, ...oneLine, ...elIn(ctx, at(0.2)) }}>{show}</div> : null}
        <Lines b={title} style={{ fontFamily: FONT.displayBold, letterSpacing: "-0.015em", color: t.ink, ...elIn(ctx, at(0.28)) }} />
        {props.meta ? <div style={{ fontFamily: FONT.text, fontSize: 28, color: t.muted, ...oneLine, ...elIn(ctx, at(0.36)) }}>{props.meta}</div> : null}
      </div>
      <div style={{ position: "absolute", left: pad, top: H - pad - 96, ...elIn(ctx, at(0.45), { style: "POP" }) }}>
        <PlayButton size={96} t={t} playing={playing} press={tap.press} ripple={tap.ripple} />
      </div>
      <div style={{ ...abs(wx, H - pad - 96, ww, 96) }}>
        {Array.from({ length: bars }).map((_, i) => {
          const base = 0.25 + 0.75 * hash01(i * 3.1 + 2) * (0.6 + 0.4 * Math.sin(i * 0.45));
          const live = playing ? 0.75 + 0.25 * Math.sin(frame * 0.35 + i * 1.3) : 1;
          const hgt = Math.max(8, 86 * Math.abs(base) * live * clamp01(wIn * 1.4 - (i / bars) * 0.4));
          const played = i / bars < progress;
          return <div key={i} style={{ position: "absolute", left: r1(i * bw + bw * 0.18), top: r1(48 - hgt / 2), width: r1(bw * 0.64), height: r1(hgt), borderRadius: 6, background: played ? t.accent : t.fill2 }} />;
        })}
        <div style={{ position: "absolute", left: r1(progress * ww - 2), top: 2, width: 4, height: 92, borderRadius: 2, background: t.ink, opacity: wIn }} />
      </div>
    </div>
  );
}

function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function MediaMusic({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const pad = 40;
  const cw = W - pad * 2;
  const art = 600;
  const pct = Math.max(0, Math.min(100, props.items[0]?.value ?? 35)) / 100;
  const dur = 204;
  const at = clock(ctx, 1.7);
  const tTap = at(1.1);
  const tap = tapAt(ctx, tTap);
  const playing = frame >= tTap + 3;
  const grow = playing ? springAt(frame, fps, tTap + 3, ctx.f.springs.soft, Math.round(0.7 * fps)) : 0;
  const artScale = 0.88 + 0.12 * Math.min(1.04, grow);
  const p = Math.min(1, pct + (playing ? (frame - tTap) / fps / dur : 0));
  const title = props.title?.trim() ?? "";
  const artist = props.subtitle?.trim() ?? "";
  const liked = inT(ctx, at(1.45), Math.round(0.3 * fps));
  const ctl = (k: number) => elIn(ctx, at(0.55 + k * 0.06), { style: "POP" });
  return (
    <div style={{ ...fill, ...card(t, 48), overflow: "hidden", ...cardIn(ctx) }}>
      <div style={{ ...fill, background: `radial-gradient(ellipse 80% 50% at 50% 25%, ${rgba(namePair(title + artist)[0], t.dark ? 0.28 : 0.2)} 0%, transparent 70%)` }} />
      {props.meta ? <div style={{ ...abs(pad, 34, cw, 40), textAlign: "center", fontFamily: FONT.text, fontSize: 28, letterSpacing: "0.08em", textTransform: "uppercase", color: t.muted, ...oneLine }}>{props.meta}</div> : null}
      <div style={{ ...abs((W - art) / 2, 96, art, art), transform: `scale(${r4(artScale)})`, boxShadow: `0 ${r1(20 + 20 * grow)}px ${r1(40 + 30 * grow)}px ${rgba("#000000", 0.35 + 0.1 * grow)}`, borderRadius: 34, ...elIn(ctx, at(0.1), { style: "POP" }) }}>
        <PlaceholderArt seed={title + artist} w={art} h={art} radius={34}>
          {[0.78, 0.56, 0.34].map((s, k) => (
            <div key={k} style={{ position: "absolute", left: (art * (1 - s)) / 2, top: (art * (1 - s)) / 2, width: art * s, height: art * s, borderRadius: "50%", boxShadow: `inset 0 0 0 2px ${rgba("#FFFFFF", 0.18 + k * 0.05)}`, transform: `rotate(${r1(playing ? (frame - tTap) * 0.6 : 0)}deg)` }} />
          ))}
          <div style={{ position: "absolute", left: art / 2 - 34, top: art / 2 - 34, width: 68, height: 68, borderRadius: "50%", background: rgba("#FFFFFF", 0.85) }} />
        </PlaceholderArt>
      </div>
      <div style={{ ...abs(pad, 726, cw, 60), display: "flex", alignItems: "center", gap: 20, ...elIn(ctx, at(0.3)) }}>
        <div style={{ flex: 1, minWidth: 0, fontFamily: FONT.displayBold, fontSize: fitLine(title, cw - 80, 48, 34), letterSpacing: "-0.02em", color: t.ink, ...oneLine }}>{title}</div>
        <div style={{ position: "relative", width: 48, height: 48, transform: `scale(${r4(1 + 0.25 * Math.sin(liked * Math.PI))})` }}>
          <GIcon icon="HEART" size={48} color={liked > 0.5 ? t.accent : t.muted} stroke={2.2} />
          {liked > 0 ? (
            <svg width={48} height={48} viewBox="0 0 24 24" style={{ position: "absolute", inset: 0, opacity: liked }}>
              <path d="M12 20s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.2a4.4 4.4 0 0 1 7.5 2.7C19.5 15.4 12 20 12 20z" fill={t.accent} />
            </svg>
          ) : null}
        </div>
      </div>
      {artist ? <div style={{ ...abs(pad, 788, cw - 80, 46), fontFamily: FONT.text, fontSize: 34, color: t.muted, ...oneLine, ...elIn(ctx, at(0.38)) }}>{artist}</div> : null}
      <div style={{ ...abs(pad, 862, cw, 40), ...elIn(ctx, at(0.45)) }}>
        <div style={{ ...abs(0, 0, cw, 10), borderRadius: 5, background: t.fill2 }} />
        <div style={{ ...abs(0, 0, cw * p, 10), borderRadius: 5, background: t.ink }} />
        <div style={{ ...abs(cw * p - 12, -7, 24, 24), borderRadius: 12, background: t.ink, boxShadow: `0 2px 6px ${rgba("#000000", 0.3)}` }} />
        <div style={{ ...abs(0, 22, 200, 40), fontFamily: FONT.text, fontSize: 28, color: t.muted, fontVariantNumeric: "tabular-nums" }}>{mmss(p * dur)}</div>
        <div style={{ ...abs(cw - 200, 22, 200, 40), textAlign: "right", fontFamily: FONT.text, fontSize: 28, color: t.muted, fontVariantNumeric: "tabular-nums" }}>−{mmss(dur - p * dur)}</div>
      </div>
      <div style={{ ...abs(pad, 930, cw, 100), display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 10px", boxSizing: "border-box" }}>
        <div style={ctl(0)}><Glyph d={G.shuffle} size={40} color={t.muted} stroke={2} /></div>
        <div style={ctl(1)}><Glyph d={G.prev} size={52} color={t.ink} fillColor={t.ink} stroke={1.6} /></div>
        <div style={ctl(2)}><PlayButton size={100} t={t} playing={playing} press={tap.press} ripple={tap.ripple} /></div>
        <div style={ctl(3)}><Glyph d={G.next} size={52} color={t.ink} fillColor={t.ink} stroke={1.6} /></div>
        <div style={ctl(4)}><Glyph d={G.repeat} size={40} color={t.muted} stroke={2} /></div>
      </div>
    </div>
  );
}

function MediaTitleCard({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const p = ctx.p;
  const title = (props.title?.trim() || "Untitled").toUpperCase();
  const tag = props.subtitle?.trim() ?? "";
  const badges = itemsOf(ctx, 4).map((i) => i.text.trim()).filter(Boolean);
  const meta = props.meta?.trim() ?? "";
  const at = clock(ctx, 2.0);
  const tr = inT(ctx, at(0.1), Math.round(1.2 * fps));
  const spacing = 0.06 + 0.34 * (1 - tr);
  const finalSize = fitLine(title, (W - 120) / (1 + 0.1 * 1.2), 128, 56);
  const lines2 = textW(title, 56) * 1.1 > W - 120;
  const tb = lines2 ? fitBlock(title, W - 120, 2 * 110, { max: 100, min: 52, lh: 1.02, k: 1.1, maxLines: 2 }) : null;
  const tSize = tb ? tb.size : finalSize;
  const titleH = tb ? tb.h : tSize * 1.05;
  const tagH = tag ? 50 : 0;
  const metaH = meta || badges.length ? 60 : 0;
  const stackH = titleH + 40 + tagH + (metaH ? 30 + metaH : 0);
  const y0 = (H - stackH) / 2;
  const sweep = ((frame - at(0.4)) / Math.round(1.4 * fps)) * 160 - 30;
  const bg = t.dark
    ? `radial-gradient(ellipse 90% 60% at 50% 110%, ${rgba(p.primary, 0.32)} 0%, transparent 65%), radial-gradient(ellipse 60% 40% at 50% 0%, ${rgba(p.secondary, 0.16)} 0%, transparent 70%), linear-gradient(180deg, #0B0B10, #050507)`
    : `radial-gradient(ellipse 90% 60% at 50% 110%, ${rgba(p.primary, 0.22)} 0%, transparent 65%), linear-gradient(180deg, #FBFAF7, #EFEDE8)`;
  const ink = t.dark ? "#FFFFFF" : "#0E0E12";
  const textFace: CSSProperties = {
    fontFamily: FONT.display,
    color: ink,
    backgroundImage: `linear-gradient(100deg, ${ink} ${r1(sweep - 12)}%, ${t.dark ? mix(p.primary, "#FFFFFF", 0.55) : mix(p.primary, "#000000", 0.2)} ${r1(sweep)}%, ${ink} ${r1(sweep + 12)}%)`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    WebkitTextFillColor: "transparent",
  };
  const lineIn = inT(ctx, at(0.7), Math.round(0.6 * fps));
  return (
    <div style={{ ...fill, borderRadius: 36, overflow: "hidden", background: bg, boxShadow: `0 40px 90px ${rgba("#000000", 0.5)}, inset 0 0 0 1.5px ${rgba(t.dark ? "#FFFFFF" : "#000000", 0.08)}`, ...cardIn(ctx) }}>
      <div style={{ ...abs(0, 0, W, 34), background: t.dark ? "#000000" : rgba("#000000", 0.06), opacity: 0.7 }} />
      <div style={{ ...abs(0, H - 34, W, 34), background: t.dark ? "#000000" : rgba("#000000", 0.06), opacity: 0.7 }} />
      <div style={{ ...abs(60, y0, W - 120, titleH), display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", opacity: clamp01(tr * 2.2), filter: `drop-shadow(0 0 ${r1(24 * (1 - tr) + 8)}px ${rgba(p.primary, t.dark ? 0.35 : 0.15)})` }}>
        {(tb ? tb.lines : [title]).map((ln, i) => (
          <div key={i} style={{ fontSize: tSize, lineHeight: `${r1(tb ? tSize * 1.02 : tSize * 1.05)}px`, letterSpacing: `${r4(spacing)}em`, marginRight: `-${r4(spacing)}em`, whiteSpace: "nowrap", ...textFace }}>
            {ln}
          </div>
        ))}
      </div>
      <div style={{ ...abs(W / 2 - 60, y0 + titleH + 18, 120, 4), borderRadius: 2, background: p.primary, transform: `scaleX(${r4(lineIn)})`, boxShadow: `0 0 14px ${rgba(p.primary, 0.6)}` }} />
      {tag ? <div style={{ ...abs(60, y0 + titleH + 40, W - 120, tagH), textAlign: "center", fontFamily: FONT.text, fontSize: fitLine(tag, W - 160, 36, 28, KT), fontStyle: "italic", color: t.dark ? rgba("#FFFFFF", 0.78) : rgba("#000000", 0.66), ...oneLine, ...elIn(ctx, at(0.95)) }}>{tag}</div> : null}
      {metaH ? (
        <div style={{ ...abs(40, y0 + titleH + 40 + tagH + 30, W - 80, metaH), display: "flex", alignItems: "center", justifyContent: "center", gap: 16, ...elIn(ctx, at(1.15)) }}>
          {meta ? <div style={{ fontFamily: FONT.text, fontSize: 28, letterSpacing: "0.06em", color: t.dark ? rgba("#FFFFFF", 0.7) : rgba("#000000", 0.6), ...oneLine, flexShrink: 1 }}>{meta}</div> : null}
          {badges.map((b, i) => (
            <div key={i} style={{ flex: "none", height: 48, padding: "0 16px", borderRadius: 10, display: "flex", alignItems: "center", fontFamily: FONT.displayBold, fontSize: 28, color: ink, boxShadow: `inset 0 0 0 2px ${rgba(ink, 0.45)}`, maxWidth: 260, ...oneLine }}>
              {b}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MediaVoice({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const pad = 40;
  const red = t.negative;
  const title = props.title?.trim() || "New Recording";
  const m = /^(\d{1,2}):(\d{2})$/.exec(props.meta?.trim() ?? "");
  const target = m ? Number(m[1]) * 60 + Number(m[2]) : null;
  const at = clock(ctx, 1.6);
  const tRec = at(0.35);
  const tEnd = at(1.6);
  const recP = clamp01((frame - tRec) / Math.max(1, tEnd - tRec));
  const elapsed = target != null ? target * recP + Math.max(0, (frame - tEnd) / fps) : Math.max(0, (frame - tRec) / fps);
  const timer = target != null || !props.meta ? mmss(elapsed) : props.meta;
  const pulse = 0.5 + 0.5 * Math.abs(Math.sin((frame / fps) * Math.PI));
  const bars = 46;
  const ww = W - pad * 2;
  const bw = ww / bars;
  const shift = Math.floor(Math.max(0, frame - tRec) / 2);
  const recorded = Math.min(bars, Math.floor(Math.max(0, frame - tRec) / 2));
  return (
    <div style={{ ...fill, ...card(t, 40), overflow: "hidden", ...cardIn(ctx) }}>
      <div style={{ ...abs(pad, pad, ww, 64), display: "flex", alignItems: "center", gap: 18 }}>
        <div style={{ width: 22, height: 22, borderRadius: 11, flex: "none", background: red, opacity: frame >= tRec ? 0.4 + 0.6 * pulse : 0.3, boxShadow: `0 0 ${r1(14 * pulse)}px ${rgba(red, 0.7)}` }} />
        <div style={{ flex: 1, minWidth: 0, fontFamily: FONT.displayBold, fontSize: fitLine(title, ww - 260, 40, 30), color: t.ink, letterSpacing: "-0.015em", ...oneLine }}>{title}</div>
        <div style={{ fontFamily: FONT.display, fontSize: 52, color: t.ink, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em" }}>{timer}</div>
      </div>
      <div style={{ ...abs(pad, 128, ww, 140) }}>
        <div style={{ ...abs(0, 69, ww, 2), background: t.line }} />
        {Array.from({ length: bars }).map((_, i) => {
          const fromRight = bars - 1 - i;
          const on = fromRight < recorded;
          const s = shift - fromRight;
          const amp = on ? 0.18 + 0.82 * hash01(s * 1.7 + 5) * (0.55 + 0.45 * Math.abs(Math.sin(s * 0.21))) : 0.05;
          const hh = Math.max(6, 132 * amp);
          return <div key={i} style={{ position: "absolute", left: r1(i * bw + bw * 0.2), top: r1(70 - hh / 2), width: r1(bw * 0.6), height: r1(hh), borderRadius: 5, background: on ? (fromRight < 2 ? red : t.ink) : t.fill2, opacity: on ? 0.55 + 0.45 * (1 - fromRight / bars) : 1 }} />;
        })}
        <div style={{ ...abs(ww - 3, 0, 3, 140), borderRadius: 2, background: red, opacity: frame >= tRec ? 1 : 0.3 }} />
      </div>
      <div style={{ ...abs(W / 2 - 46, H - pad - 92, 92, 92), borderRadius: 46, boxShadow: `inset 0 0 0 5px ${t.fill2}`, display: "flex", alignItems: "center", justifyContent: "center", ...elIn(ctx, at(0.2), { style: "POP" }) }}>
        <div style={{ width: 36, height: 36, borderRadius: 9, background: red }} />
      </div>
    </div>
  );
}

// ===================================================================== registry

/** Library 2 — web family components. */
export const WEB_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {
  SEARCH_BAR: SearchBar,
  BROWSER: Browser,
  WEB_CARD: WebCard,
  NEWS: News,
  MEDIA_PLAYER: MediaPlayer,
};
