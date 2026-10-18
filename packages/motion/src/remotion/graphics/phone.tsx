import { useId, type ComponentType, type CSSProperties, type ReactNode } from "react";
import type { GraphicComponent, GraphicIcon, GraphicItem } from "@chris/media/timeline";
import { listSequence } from "../../graphics-timing";
import { Scrim } from "../templates/text";
import { GIcon } from "./icons";
import { FONT, clamp01, colorOf, counted, css, emphasisAt, enterStyle, fmtValue, mix, prog, r1, r4, rgba, seqStyle, sharedPlan, springAt, type GCtx } from "./kit";
import { textW, Word, buildBudget, squeeze, splitWords } from "./text";
import { APP_TINTS, AppTile, Avatar, TypingDots, card, nameHue, namePair, pressAt, rippleAt, toneOf, type Tone } from "./ui";

/**
 * Library 2 — PHONE & APPS family: DM_CHAT · NOTIFICATION · CALL · PHONE_APP · CLOCK_TIMER ·
 * STATUS_ALERT · APP_GRID · KEYNOTE.
 *
 * Generic, original phone/OS-style UI (brand-safe): initials avatars, original line glyphs on
 * tinted tiles, Inter type, palette-driven accents ("me" bubbles take the tone's `solid`), no
 * real OS chrome, system font, logo or signature colour. Layout metrics mirror the design
 * sizes in packages/media/src/graphics/families/phone.ts (keep both in sync), so each
 * component fills exactly its box. Everything is a pure function of ctx.frame.
 */

const fill: CSSProperties = { position: "absolute", inset: 0 };
/** Inter SemiBold vs the Display Bold width estimate (mirror of families/phone.ts TEXT_K). */
const K = 0.95;
const TAB: CSSProperties = { fontVariantNumeric: "tabular-nums", fontFeatureSettings: '"tnum" 1' };

// ===================================================================== helpers

/** Frames for `s` seconds at the graphic's tempo. */
function sec(ctx: GCtx, s: number): number {
  return Math.round((s * ctx.fps) / Math.max(0.25, ctx.anim.speed || 1));
}

function seqOpts(ctx: GCtx, startFrame?: number) {
  return { fps: ctx.fps, durationInFrames: ctx.D, exitFrames: ctx.exitFrames, tempo: ctx.f.tempo, startFrame };
}

/** `s` cut to `width` px at `size` with an ellipsis. */
function ell(s: string, size: number, width: number, k = K): string {
  if (textW(s, size, k) <= width) return s;
  let out = s;
  while (out.length > 1 && textW(`${out}…`, size, k) > width) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

/** Greedy wrap into ≤ `max` lines (the last ellipsized) — mirror of families/phone.ts `wrapN`. */
function wrap(text: string | null | undefined, size: number, width: number, max: number, k = K): string[] {
  const words = (text ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && textW(t, size, k) > width) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  const out = lines.slice(0, max).map((l) => ell(l, size, width, k));
  if (lines.length > max) out[max - 1] = ell(`${lines.slice(max - 1).join(" ")}`, size, width, k).replace(/…?$/, "…");
  return out;
}

/** A tile colour for an app: an explicit colour token, else a calm tint from its name. */
function appTint(ctx: GCtx, it: GraphicItem | undefined, name: string): string {
  if (it && it.color !== "AUTO") return colorOf(ctx, it.color, 0);
  return APP_TINTS[nameHue(name || "app") % APP_TINTS.length]!;
}

/** Spring 0..~1 from `at` (the motion language's soft arrival). */
function popAt(ctx: GCtx, at: number, kind: "soft" | "settle" | "punch" | "grow" = "soft", len = sec(ctx, 0.9)): number {
  return Math.max(0, springAt(ctx.frame, ctx.fps, at, ctx.f.springs[kind], len));
}

/** Pop-in style (scale from an origin + fade), or the shared vocabulary for non-default entrances. */
function popStyle(ctx: GCtx, at: number, origin = "50% 50%", from = 0.6): CSSProperties {
  if (ctx.anim.enter !== "RISE" && ctx.anim.enter !== "POP") return { ...css(enterStyle(ctx, at, sec(ctx, 0.45), { blurOK: false })), transformOrigin: origin };
  const s = popAt(ctx, at);
  const o = prog(ctx.frame, at, Math.max(2, sec(ctx, 0.16)));
  return { opacity: o, transform: `scale(${r4(from + (1 - from) * s)})`, transformOrigin: origin };
}

/** Drop-in from above with the settle spring. */
function dropStyle(ctx: GCtx, at: number, dist = 70): CSSProperties {
  const s = popAt(ctx, at, "settle", sec(ctx, 1));
  const o = prog(ctx.frame, at, Math.max(2, sec(ctx, 0.2)));
  return { opacity: o, transform: `translateY(${r1((1 - Math.min(1.04, s)) * -dist * ctx.f.distance)}px) scale(${r4(0.96 + 0.04 * Math.min(1, s))})` };
}

/** Fade + rise. */
function riseStyle(ctx: GCtx, at: number, dist = 18, len = sec(ctx, 0.5)): CSSProperties {
  const t = prog(ctx.frame, at, len, ctx.ease);
  return { opacity: t, transform: t >= 1 ? undefined : `translateY(${r1((1 - t) * dist * ctx.f.distance)}px)` };
}

/** Original handset glyph (filled) — the icon set's PHONE is a smartphone. */
function Handset({ size, color, rotate = 0 }: { size: number; color: string; rotate?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", transform: rotate ? `rotate(${rotate}deg)` : undefined }}>
      <path d="M6.4 3h2.5c.5 0 .9.3 1 .8l.9 3.3c.1.4 0 .8-.3 1.1L9 9.6a12 12 0 0 0 5.4 5.4l1.4-1.5c.3-.3.7-.4 1.1-.3l3.3.9c.5.1.8.5.8 1v2.5c0 1.3-1.1 2.4-2.4 2.3C10.3 19.4 4.6 13.7 4.1 5.4 4 4.1 5.1 3 6.4 3z" fill={color} />
    </svg>
  );
}

/** A filled star with `f` (0..1) of it filled. */
function Star({ size, f, on, off, id }: { size: number; f: number; on: string; off: string; id: string }) {
  const d = "M12 2.6l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block" }}>
      <defs>
        <clipPath id={id}>
          <rect x={0} y={0} width={r1(24 * clamp01(f))} height={24} />
        </clipPath>
      </defs>
      <path d={d} fill={off} />
      <path d={d} fill={on} clipPath={`url(#${id})`} />
    </svg>
  );
}

function sid(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "");
}

/** Phone wallpaper (lock screen / home screen): calm palette-tinted gradient, by tone. */
function wallpaper(ctx: GCtx, t: Tone): string {
  const p = ctx.p;
  if (t.dark) {
    return `radial-gradient(ellipse 80% 50% at 20% 0%, ${rgba(p.secondary, 0.38)} 0%, transparent 70%), radial-gradient(ellipse 80% 50% at 90% 100%, ${rgba(p.primary, 0.3)} 0%, transparent 70%), linear-gradient(170deg, #1A1824 0%, #0D0C14 60%, #0A0A10 100%)`;
  }
  return `radial-gradient(ellipse 80% 55% at 15% 0%, ${rgba(mix(p.secondary, "#FFFFFF", 0.35), 0.55)} 0%, transparent 70%), radial-gradient(ellipse 80% 55% at 90% 100%, ${rgba(mix(p.primary, "#FFFFFF", 0.3), 0.5)} 0%, transparent 70%), linear-gradient(170deg, #EEF0F8 0%, #E4E2F0 100%)`;
}

/** A frosted surface on a wallpaper. */
function frost(t: Tone, radius: number): CSSProperties {
  return t.dark
    ? { borderRadius: radius, background: rgba("#FFFFFF", 0.11), boxShadow: `inset 0 0 0 1.5px ${rgba("#FFFFFF", 0.08)}, inset 0 1.5px 0 ${rgba("#FFFFFF", 0.12)}` }
    : { borderRadius: radius, background: rgba("#FFFFFF", 0.78), boxShadow: `0 10px 30px ${rgba("#2A2440", 0.12)}, inset 0 0 0 1.5px ${rgba("#FFFFFF", 0.8)}` };
}

/** The whole-box card (UI tones). */
function Card({ t, radius = 48, children, style }: { t: Tone; radius?: number; children: ReactNode; style?: CSSProperties }) {
  return <div style={{ ...fill, ...card(t, radius), overflow: "hidden", ...style }}>{children}</div>;
}

function txt(size: number, color: string, extra: CSSProperties = {}): CSSProperties {
  return { fontFamily: FONT.text, fontSize: size, color, lineHeight: 1.2, whiteSpace: "nowrap", ...extra };
}
function bold(size: number, color: string, extra: CSSProperties = {}): CSSProperties {
  return { fontFamily: FONT.displayBold, fontSize: size, color, lineHeight: 1.12, letterSpacing: "-0.012em", whiteSpace: "nowrap", ...extra };
}

/** mm:ss (or h:mm:ss) from seconds. */
function clockText(totalSec: number, cs = false): string {
  const s = Math.max(0, totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
  return cs ? `${base}.${pad(Math.floor((s * 100) % 100))}` : base;
}

/** "02:14" / "1:02:14" → seconds (null if not a timer). */
function parseTimer(s: string | null | undefined): number | null {
  const m = (s ?? "").trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
}

// ===================================================================== DM_CHAT

const CHAT = { W: 900, PAD: 32, FS: 36, LH: 48, PY: 17, PX: 26, BW: 548, GAP_SAME: 8, GAP_SIDE: 22, REACT: 32, SENDER: 40, RECEIPT: 46, TOP: 26, BOTTOM: 30, AV: 52 } as const;
function chatHead(v: string): number {
  return v === "BUBBLES" ? 0 : v === "DM" ? 132 : 172;
}

interface Bubble {
  it: GraphicItem;
  me: boolean;
  y: number;
  h: number;
  w: number;
  lines: string[];
  sender: { y: number; text: string } | null;
  last: boolean;
  typeAt: number | null;
  at: number;
}

function chatLayout(ctx: GCtx): { bubbles: Bubble[]; receiptY: number } {
  const v = ctx.variant;
  const items = ctx.props.items;
  let y = v === "BUBBLES" ? 12 : CHAT.TOP + chatHead(v) + 22;
  // Timing (raw seconds): a typing indicator before every incoming message, a read pause after each.
  const raw: Array<{ typeAt: number | null; at: number }> = [];
  let tt = 0.35;
  items.forEach((it) => {
    const me = it.side === "ME";
    let typeAt: number | null = null;
    if (!me) {
      typeAt = tt;
      tt += 0.85;
    }
    raw.push({ typeAt, at: tt });
    tt += (me ? 0.45 : 0.55) + Math.min(0.75, it.text.length * 0.014);
  });
  const t0 = sec(ctx, 0.35);
  const total = sec(ctx, tt) - t0;
  const k = squeeze(ctx, t0, total, 0.9);
  const f = (s: number) => Math.round(t0 + (sec(ctx, s) - t0) * k);
  const bubbles: Bubble[] = items.map((it, i) => {
    const prev = i > 0 ? items[i - 1]! : null;
    const next = items[i + 1];
    const me = it.side === "ME";
    if (prev) y += (prev.side === "ME") === me ? CHAT.GAP_SAME : CHAT.GAP_SIDE;
    let sender: Bubble["sender"] = null;
    if (v === "GROUP" && !me && it.sub && (!prev || prev.side === "ME" || prev.sub !== it.sub)) {
      sender = { y, text: it.sub };
      y += CHAT.SENDER;
    }
    if (it.icon) y += CHAT.REACT;
    const lines = wrap(it.text || " ", CHAT.FS, CHAT.BW, 6);
    const lw = Math.max(...lines.map((l) => textW(l, CHAT.FS, K)), 30);
    const h = Math.max(1, lines.length) * CHAT.LH + 2 * CHAT.PY;
    const b: Bubble = { it, me, y, h, w: Math.ceil(Math.min(CHAT.BW, lw) * 1.04 + 2 * CHAT.PX + 8), lines, sender, last: !next || (next.side === "ME") !== me, typeAt: raw[i]!.typeAt === null ? null : f(raw[i]!.typeAt!), at: f(raw[i]!.at) };
    y += h;
    return b;
  });
  return { bubbles, receiptY: y + 10 };
}

function DmChat({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const v = ctx.variant;
  const { props } = ctx;
  const { bubbles, receiptY } = chatLayout(ctx);
  const float = v === "BUBBLES";
  const them = float ? (t.dark ? "#25252E" : "#FFFFFF") : t.dark ? "#2C2C36" : "#E9E9EE";
  const themInk = t.ink;
  const avW = v === "DM" ? CHAT.AV + 12 : 0;
  const lastMe = [...bubbles].reverse().find((b) => b.me);
  const reactCol = (icon: GraphicIcon) => (icon === "HEART" || icon === "FACE_LOVE" ? readableNeg(t) : t.accent);
  const content = (
    <>
      {!float ? <ChatHeader ctx={ctx} t={t} /> : null}
      {bubbles.map((b, i) => {
        const left = b.me ? CHAT.W - CHAT.PAD - b.w : CHAT.PAD + avW;
        const shadow = float ? `0 14px 34px ${rgba("#000000", 0.32)}, 0 3px 8px ${rgba("#000000", 0.2)}` : undefined;
        const typingOn = b.typeAt !== null && ctx.frame >= b.typeAt && ctx.frame < b.at + 3;
        const typingOut = b.typeAt !== null ? 1 - prog(ctx.frame, b.at - 1, 4) : 0;
        const radius = 30;
        const br: CSSProperties = b.last ? (b.me ? { borderBottomRightRadius: 10 } : { borderBottomLeftRadius: 10 }) : {};
        const reactAt = b.at + sec(ctx, 0.5);
        return (
          <div key={i}>
            {b.sender ? (
              <div style={{ position: "absolute", left: left + 20, top: b.sender.y + 2, ...txt(28, t.muted), ...riseStyle(ctx, b.typeAt ?? b.at, 8), maxWidth: CHAT.BW }}>{ell(b.sender.text, 28, CHAT.BW)}</div>
            ) : null}
            {typingOn ? (
              <div style={{ position: "absolute", left, top: b.y + (b.it.icon ? -0 : 0), width: 124, height: 2 * CHAT.PY + CHAT.LH, borderRadius: radius, borderBottomLeftRadius: 10, background: them, boxShadow: shadow, display: "flex", alignItems: "center", justifyContent: "center", ...popStyle(ctx, b.typeAt!, "0% 100%", 0.5), opacity: (popStyle(ctx, b.typeAt!).opacity as number) * typingOut }}>
                <TypingDots ctx={ctx} color={t.muted} size={14} gap={9} />
              </div>
            ) : null}
            {v === "DM" && !b.me && b.last ? (
              <div style={{ position: "absolute", left: CHAT.PAD, top: b.y + b.h - CHAT.AV, ...popStyle(ctx, b.at, "50% 100%", 0.4) }}>
                <Avatar name={b.it.sub || props.title || "Them"} size={CHAT.AV} />
              </div>
            ) : null}
            <div
              style={{
                position: "absolute",
                left,
                top: b.y,
                width: b.w,
                height: b.h,
                boxSizing: "border-box",
                padding: `${CHAT.PY}px ${CHAT.PX}px`,
                borderRadius: radius,
                ...br,
                background: b.me ? `linear-gradient(170deg, ${mix(t.solid, "#FFFFFF", 0.1)} 0%, ${t.solid} 100%)` : them,
                boxShadow: shadow ?? (b.me ? `0 6px 16px ${rgba(t.solid, 0.22)}` : undefined),
                ...popStyle(ctx, b.at, b.me ? "100% 100%" : "0% 100%", 0.55),
              }}
            >
              {b.lines.map((l, li) => (
                <div key={li} style={{ ...txt(CHAT.FS, b.me ? t.onSolid : themInk, { lineHeight: `${CHAT.LH}px` }) }}>{l}</div>
              ))}
              {b.it.icon ? (
                <div
                  style={{
                    position: "absolute",
                    top: -40,
                    ...(b.me ? { left: -22 } : { right: -22 }),
                    width: 64,
                    height: 64,
                    borderRadius: 32,
                    background: t.dark ? "#3A3A46" : "#FFFFFF",
                    boxShadow: `0 0 0 4px ${float ? "transparent" : t.dark ? "#1B1B23" : "#FBFBFD"}, 0 6px 16px ${rgba("#000000", 0.22)}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    ...popStyle(ctx, reactAt, "50% 50%", 0.2),
                  }}
                >
                  <GIcon icon={b.it.icon} size={38} color={reactCol(b.it.icon)} stroke={2.3} />
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
      {props.meta && lastMe ? (
        <div style={{ position: "absolute", right: CHAT.PAD + 8, top: receiptY, ...txt(28, float ? (t.dark ? "#E6E6EE" : "#FFFFFF") : t.muted, float ? { textShadow: `0 2px 8px ${rgba("#000000", 0.6)}` } : {}), ...riseStyle(ctx, lastMe.at + sec(ctx, 0.55), 6) }}>{ell(props.meta, 28, CHAT.W * 0.7)}</div>
      ) : null}
    </>
  );
  if (float) return <div style={fill}>{content}</div>;
  return <Card t={t}>{content}</Card>;
}

function readableNeg(t: Tone): string {
  return t.negative;
}

function ChatHeader({ ctx, t }: { ctx: GCtx; t: Tone }) {
  const v = ctx.variant;
  const name = ctx.props.title || "Alex";
  const status = ctx.props.subtitle;
  const head = chatHead(v);
  const s = riseStyle(ctx, 0, 10);
  if (v === "DM") {
    return (
      <>
        <div style={{ position: "absolute", left: CHAT.PAD, right: CHAT.PAD, top: CHAT.TOP, height: head - 16, display: "flex", alignItems: "center", gap: 22, ...s }}>
          <svg width={30} height={40} viewBox="0 0 12 20" style={{ flex: "none" }}>
            <path d="M10 2L2 10l8 8" fill="none" stroke={t.accent} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div style={{ position: "relative", flex: "none" }}>
            <Avatar name={name} size={84} />
            <div style={{ position: "absolute", right: 0, bottom: 2, width: 22, height: 22, borderRadius: 11, background: t.positive, boxShadow: `0 0 0 4px ${t.dark ? "#1E1E28" : "#FFFFFF"}` }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
            <div style={bold(38, t.ink)}>{ell(name, 38, 470, 1)}</div>
            {status ? <div style={{ ...txt(28, t.muted), marginTop: 4 }}>{ell(status, 28, 470)}</div> : null}
          </div>
          <div style={{ display: "flex", gap: 30, flex: "none", alignItems: "center" }}>
            <Handset size={44} color={t.accent} />
            <GIcon icon="VIDEO" size={48} color={t.accent} stroke={2.1} />
          </div>
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: CHAT.TOP + head + 4, height: 1.5, background: t.line, opacity: s.opacity }} />
      </>
    );
  }
  const senders = v === "GROUP" ? [...new Set(ctx.props.items.filter((i) => i.side !== "ME" && i.sub).map((i) => i.sub!))].slice(0, 3) : [];
  return (
    <>
      <div style={{ position: "absolute", left: CHAT.PAD, right: CHAT.PAD, top: CHAT.TOP - 4, height: head, display: "flex", flexDirection: "column", alignItems: "center", ...s }}>
        <svg width={30} height={40} viewBox="0 0 12 20" style={{ position: "absolute", left: 4, top: 30 }}>
          <path d="M10 2L2 10l8 8" fill="none" stroke={t.accent} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {senders.length > 1 ? (
          <div style={{ display: "flex", height: 84, alignItems: "center" }}>
            {senders.map((n, i) => (
              <Avatar key={n} name={n} size={72} ring={t.dark ? "#1E1E28" : "#FFFFFF"} style={{ marginLeft: i ? -20 : 0, zIndex: 3 - i }} />
            ))}
          </div>
        ) : (
          <Avatar name={name} size={84} />
        )}
        <div style={{ ...bold(34, t.ink), marginTop: 12, maxWidth: CHAT.W - 200 }}>{ell(name, 34, CHAT.W - 200, 1)}</div>
        {status ? <div style={{ ...txt(28, t.muted), marginTop: 4 }}>{ell(status, 28, CHAT.W - 200)}</div> : null}
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: CHAT.TOP + head + 4, height: 1.5, background: t.line, opacity: s.opacity }} />
    </>
  );
}

// ===================================================================== NOTIFICATION

const NOTE_H = 176;

function NotifCard({ ctx, t, it, i, w, onWall, big }: { ctx: GCtx; t: Tone; it: GraphicItem; i: number; w: number; onWall?: boolean; big?: boolean }) {
  const app = it.meta || "Messages";
  const time = ctx.props.meta || "now";
  const tile = big ? 96 : 76;
  const colW = w - 56 - tile - 24;
  const surface: CSSProperties = onWall ? frost(t, 40) : card(t, big ? 46 : 40);
  const ink = t.ink;
  const muted = onWall && t.dark ? rgba("#FFFFFF", 0.62) : t.muted;
  const timeW = textW(time, 28, K) + 8;
  if (big) {
    const tl = wrap(it.text || " ", 40, 768, 2, 1);
    const ml = wrap(it.sub, 34, 768, 3);
    return (
      <div style={{ position: "absolute", inset: 0, boxSizing: "border-box", padding: "34px 32px", display: "flex", gap: 28, alignItems: "flex-start", ...surface }}>
        <AppTile icon={it.icon ?? "BELL"} size={tile} color={appTint(ctx, it, app)} />
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", height: 38, alignItems: "center" }}>
            <div style={txt(28, muted)}>{ell(app, 28, colW - timeW - 20)}</div>
            <div style={txt(28, muted)}>{time}</div>
          </div>
          <div style={{ height: 6 }} />
          {tl.map((l, li) => (
            <div key={li} style={{ ...bold(40, ink), lineHeight: "50px" }}>
              <MoneyCount ctx={ctx} text={l} />
            </div>
          ))}
          {ml.length ? <div style={{ height: 6 }} /> : null}
          {ml.map((l, li) => (
            <div key={li} style={{ ...txt(34, mix(ink, t.surface, 0.25), { lineHeight: "44px" }) }}>{l}</div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div style={{ width: w, height: NOTE_H, boxSizing: "border-box", padding: "24px 28px", display: "flex", gap: 24, alignItems: "center", ...surface }}>
      <AppTile icon={it.icon ?? "BELL"} size={tile} color={appTint(ctx, it, app)} />
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", height: 36, alignItems: "center" }}>
          <div style={txt(28, muted)}>{ell(app, 28, colW - timeW - 20)}</div>
          <div style={txt(28, muted)}>{i >= 0 ? time : ""}</div>
        </div>
        <div style={{ ...bold(36, ink), lineHeight: "46px" }}>{ell(it.text || " ", 36, colW, 1)}</div>
        {it.sub ? <div style={{ ...txt(34, onWall && t.dark ? rgba("#FFFFFF", 0.82) : mix(ink, t.surface, 0.28), { lineHeight: "44px" }) }}>{ell(it.sub, 34, colW)}</div> : null}
      </div>
    </div>
  );
}

/** Text whose first money amount ("$2,500.00") counts up as it lands. */
function MoneyCount({ ctx, text }: { ctx: GCtx; text: string }) {
  const m = text.match(/\$([\d,]+)(\.\d{1,2})?/);
  if (!m || m.index === undefined) return <>{text}</>;
  const final = Number(m[1]!.replace(/,/g, "")) + (m[2] ? Number(m[2]) : 0);
  const dec = m[2] ? m[2].length - 1 : 0;
  const v = counted(ctx, sec(ctx, 0.35), final, 0, 2);
  const shown = `$${v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
  return (
    <>
      {text.slice(0, m.index)}
      <span style={TAB}>{shown}</span>
      {text.slice(m.index + m[0].length)}
    </>
  );
}

/** Notification arrival frames (one every ~0.8 s, compressed to fit). */
function notifTimes(ctx: GCtx, n: number, t0s: number): number[] {
  const t0 = sec(ctx, t0s);
  const gap = sec(ctx, 0.8);
  const k = squeeze(ctx, t0, gap * Math.max(0, n - 1) + sec(ctx, 0.6), 0.8);
  return Array.from({ length: n }, (_, i) => Math.round(t0 + i * gap * k));
}

/** Newest on top, earlier ones pushed down as each new one drops in. */
function NotifStack({ ctx, t, w, top, onWall, t0 }: { ctx: GCtx; t: Tone; w: number; top: number; onWall?: boolean; t0: number }) {
  const items = ctx.props.items;
  const n = items.length;
  const times = notifTimes(ctx, n, t0);
  const gap = onWall ? 16 : 18;
  const pitch = NOTE_H + gap;
  const arrived = times.map((a) => Math.min(1, popAt(ctx, a, "settle", sec(ctx, 0.9))));
  return (
    <>
      {items.map((it, i) => {
        let slot = 0;
        for (let j = i + 1; j < n; j++) slot += arrived[j]!;
        const s = popAt(ctx, times[i]!, "settle", sec(ctx, 1));
        const o = prog(ctx.frame, times[i]!, Math.max(2, sec(ctx, 0.2)));
        const y = top + slot * pitch;
        return (
          <div key={i} style={{ position: "absolute", left: (ctx.width - w) / 2, top: y, zIndex: i, opacity: o, transform: `translateY(${r1((1 - Math.min(1.03, s)) * -60 * ctx.f.distance)}px) scale(${r4(0.94 + 0.06 * Math.min(1, s))})`, transformOrigin: "50% 0%" }}>
            <NotifCard ctx={ctx} t={t} it={it} i={i} w={w} onWall={onWall} />
          </div>
        );
      })}
    </>
  );
}

function Notification({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const v = ctx.variant;
  if (v === "BANNER") {
    const it = ctx.props.items[0] ?? ({ text: "", sub: null, value: null, icon: null, color: "AUTO", op: "NONE", state: "NONE", side: "NONE", meta: null } as GraphicItem);
    return (
      <div style={{ ...fill, ...dropStyle(ctx, 0, 110) }}>
        <NotifCard ctx={ctx} t={t} it={it} i={0} w={ctx.width} big />
      </div>
    );
  }
  if (v === "LOCK") {
    const ink = t.dark ? "#FFFFFF" : "#15141C";
    const clock = ctx.props.title || "9:41";
    const date = ctx.props.subtitle || "Friday, October 24";
    const clockSize = Math.min(210, Math.floor((820 / Math.max(1, textW(clock, 210, 1))) * 210));
    return (
      <div style={{ ...fill, borderRadius: 64, overflow: "hidden", background: wallpaper(ctx, t), boxShadow: `0 40px 90px ${rgba("#000000", 0.45)}, inset 0 0 0 1.5px ${rgba("#FFFFFF", t.dark ? 0.08 : 0.6)}`, opacity: prog(ctx.frame, 0, sec(ctx, 0.3)) }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 46, display: "flex", justifyContent: "center", ...riseStyle(ctx, 0, 8) }}>
          <GIcon icon="LOCK" size={44} color={ink} stroke={2.2} />
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 112, textAlign: "center", ...txt(36, rgba(ink, 0.85)), ...riseStyle(ctx, sec(ctx, 0.05), 10) }}>{ell(date, 36, 820)}</div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 150, textAlign: "center", fontFamily: FONT.display, fontSize: clockSize, lineHeight: 1, letterSpacing: "-0.03em", color: ink, ...TAB, ...riseStyle(ctx, sec(ctx, 0.1), 16, sec(ctx, 0.6)) }}>{clock}</div>
        <NotifStack ctx={ctx} t={t} w={ctx.width - 56} top={400} onWall t0={0.55} />
      </div>
    );
  }
  return (
    <div style={fill}>
      <NotifStack ctx={ctx} t={t} w={ctx.width} top={0} t0={0.15} />
    </div>
  );
}

// ===================================================================== CALL

function CallButton({ size, bg, children, glow }: { size: number; bg: string; children: ReactNode; glow?: string }) {
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: `linear-gradient(160deg, ${mix(bg, "#FFFFFF", 0.14)} 0%, ${bg} 100%)`, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 10px 26px ${rgba(bg, 0.4)}${glow ? `, ${glow}` : ""}`, flex: "none" }}>
      {children}
    </div>
  );
}

/** Expanding rings (0..n) from a pulsing element. */
function Pulse({ ctx, size, color, from, period = 1.3, n = 2, max = 1.7 }: { ctx: GCtx; size: number; color: string; from: number; period?: number; n?: number; max?: number }) {
  const P = Math.round(period * ctx.fps);
  const age = ctx.frame - from;
  if (age < 0) return null;
  return (
    <>
      {Array.from({ length: n }, (_, k) => {
        const ph = ((age + (k * P) / n) % P) / P;
        return <div key={k} style={{ position: "absolute", left: "50%", top: "50%", width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, borderRadius: "50%", border: `3px solid ${rgba(color, 0.55 * (1 - ph))}`, transform: `scale(${r4(1 + (max - 1) * ph)})` }} />;
      })}
    </>
  );
}

function callColors(ctx: GCtx, t: Tone) {
  return { ok: mix(ctx.p.positive, "#000000", t.dark ? 0 : 0.08), no: mix(ctx.p.negative, "#000000", t.dark ? 0 : 0.06) };
}

function Call({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const v = ctx.variant;
  const name = ctx.props.title || "Mom";
  const label = ctx.props.subtitle;
  const { ok, no } = callColors(ctx, t);
  if (v === "BANNER") {
    const btnAt = sec(ctx, 0.35);
    const breathe = 1 + 0.05 * Math.max(0, Math.sin(((ctx.frame - btnAt) / ctx.fps) * Math.PI * 1.6));
    return (
      <div style={{ ...fill, ...dropStyle(ctx, 0, 90) }}>
        <div style={{ ...fill, ...card(t, 100), display: "flex", alignItems: "center", padding: "0 32px 0 30px", gap: 26, boxSizing: "border-box" }}>
          <Avatar name={name} size={128} />
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
            <div style={bold(42, t.ink)}>{ell(name, 42, 440, 1)}</div>
            <div style={{ ...txt(30, t.muted), marginTop: 4 }}>{ell(label || "Incoming call", 30, 440)}</div>
          </div>
          <div style={{ ...popStyle(ctx, btnAt, "50% 50%", 0.3) }}>
            <CallButton size={108} bg={no}>
              <Handset size={52} color="#FFFFFF" rotate={135} />
            </CallButton>
          </div>
          <div style={{ position: "relative", ...popStyle(ctx, btnAt + sec(ctx, 0.08), "50% 50%", 0.3) }}>
            <Pulse ctx={ctx} size={108} color={ok} from={btnAt + sec(ctx, 0.4)} max={1.45} />
            <div style={{ transform: `scale(${r4(breathe)})` }}>
              <CallButton size={108} bg={ok}>
                <Handset size={52} color="#FFFFFF" />
              </CallButton>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (v === "MISSED") {
    const n = Math.max(1, Math.round(ctx.props.items[0]?.value ?? 1));
    const line = ctx.props.items[0]?.text || "Missed call";
    const t0 = sec(ctx, 0.35);
    const step = Math.max(2, Math.min(sec(ctx, 0.32), Math.floor((buildBudget(ctx, 0.8) - t0 - sec(ctx, 0.3)) / Math.max(1, n))));
    const shown = Math.max(1, Math.min(n, 1 + Math.floor(Math.max(0, ctx.frame - t0) / step)));
    const bumpAt = t0 + (shown - 1) * step;
    const bump = shown > 1 ? 1 + 0.18 * pressAt(ctx, bumpAt, sec(ctx, 0.2)) : 1;
    const time = ctx.props.meta;
    const nameMax = 940 - 64 - 104 - 26 - (time ? textW(time, 28, K) + 90 : 90) - textW(` (${n})`, 40, 1);
    return (
      <div style={{ ...fill, ...dropStyle(ctx, 0, 60) }}>
        <div style={{ ...fill, ...card(t, 46), display: "flex", alignItems: "center", padding: "0 32px", gap: 26, boxSizing: "border-box" }}>
          <div style={{ width: 104, height: 104, borderRadius: 52, background: rgba(no, t.dark ? 0.2 : 0.12), display: "flex", alignItems: "center", justifyContent: "center", flex: "none", position: "relative" }}>
            <Handset size={52} color={t.negative} rotate={135} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
            <div style={{ ...bold(40, t.negative), display: "flex", alignItems: "baseline" }}>
              <span>{ell(name, 40, nameMax, 1)}</span>
              {n > 1 || ctx.props.items[0]?.value != null ? (
                <span style={{ display: "inline-block", marginLeft: 10, transform: `scale(${r4(bump)})`, transformOrigin: "0% 70%", ...TAB }}>({shown})</span>
              ) : null}
            </div>
            <div style={{ ...txt(30, t.muted), marginTop: 6 }}>{ell(label ? `${line} · ${label}` : line, 30, 560)}</div>
          </div>
          {time ? <div style={{ ...txt(28, t.muted), flex: "none" }}>{time}</div> : null}
          <div style={{ width: 44, height: 44, borderRadius: 22, border: `2.5px solid ${t.accent}`, display: "flex", alignItems: "center", justifyContent: "center", flex: "none", fontFamily: FONT.displayBold, fontSize: 26, color: t.accent }}>i</div>
        </div>
      </div>
    );
  }
  if (v === "VIDEO") return <VideoCall ctx={ctx} t={t} />;
  // INCOMING
  const W = ctx.width;
  const seq = listSequence(4, { ...ctx.anim, order: "STAGGER", stagger: Math.max(0.1, ctx.anim.stagger) }, seqOpts(ctx, sec(ctx, 0.15)));
  const nameSize = Math.min(68, Math.floor((660 / Math.max(1, textW(name, 68, 1))) * 68));
  const btnAt = seq.at(0, 3);
  const pulseFrom = btnAt + sec(ctx, 0.5);
  const breathe = 1 + 0.05 * Math.max(0, Math.sin(((ctx.frame - pulseFrom) / ctx.fps) * Math.PI * 1.6)) * (ctx.frame >= pulseFrom ? 1 : 0);
  const [a, b] = namePair(name);
  return (
    <Card t={t} radius={64}>
      <div style={{ ...fill, background: `radial-gradient(ellipse 90% 45% at 50% 38%, ${rgba(a, t.dark ? 0.28 : 0.2)} 0%, transparent 70%), radial-gradient(ellipse 80% 40% at 50% 100%, ${rgba(b, t.dark ? 0.18 : 0.1)} 0%, transparent 70%)` }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 76, textAlign: "center", ...txt(32, t.muted), ...css(seqStyle(ctx, seq, 0, 0, { distance: 0.5 })) }}>{ell(label || "mobile", 32, 620)}</div>
      <div style={{ position: "absolute", left: 40, right: 40, top: 124, textAlign: "center", ...bold(nameSize, t.ink), ...css(seqStyle(ctx, seq, 0, 0, { distance: 0.5 })) }}>{name.length > 40 ? ell(name, nameSize, 660, 1) : name}</div>
      <div style={{ position: "absolute", left: W / 2 - 140, top: 290, width: 280, height: 280, ...css(seqStyle(ctx, seq, 0, 1, { style: ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter })) }}>
        <Pulse ctx={ctx} size={280} color={t.dark ? "#FFFFFF" : a} from={seq.at(0, 1) + sec(ctx, 0.3)} period={1.8} n={3} max={1.32} />
        <Avatar name={name} size={280} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 690, display: "flex", justifyContent: "space-around", padding: "0 60px", ...css(seqStyle(ctx, seq, 0, 2, { distance: 0.6 })) }}>
        {([["ALARM", "Remind me"], ["CHAT", "Message"]] as const).map(([ic, l]) => (
          <div key={l} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, width: 200 }}>
            <GIcon icon={ic} size={50} color={t.muted} stroke={2} />
            <div style={txt(28, t.muted)}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 860, display: "flex", justifyContent: "space-around", padding: "0 60px", ...css(seqStyle(ctx, seq, 0, 3, { distance: 0.8 })) }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, width: 200 }}>
          <CallButton size={144} bg={no}>
            <Handset size={66} color="#FFFFFF" rotate={135} />
          </CallButton>
          <div style={txt(30, t.ink)}>Decline</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, width: 200 }}>
          <div style={{ position: "relative" }}>
            <Pulse ctx={ctx} size={144} color={ok} from={pulseFrom} max={1.5} />
            <div style={{ transform: `scale(${r4(breathe)})` }}>
              <CallButton size={144} bg={ok}>
                <Handset size={66} color="#FFFFFF" />
              </CallButton>
            </div>
          </div>
          <div style={txt(30, t.ink)}>Accept</div>
        </div>
      </div>
    </Card>
  );
}

function VideoCall({ ctx, t }: { ctx: GCtx; t: Tone }) {
  const name = ctx.props.title || "Sam";
  const W = ctx.width;
  const H = ctx.height;
  const [a, b] = namePair(name);
  const base = parseTimer(ctx.props.meta);
  const start = sec(ctx, 0.2);
  const timer = base === null ? ctx.props.meta : clockText(base + Math.max(0, Math.floor((ctx.frame - start) / ctx.fps)));
  const seq = listSequence(4, { ...ctx.anim, order: "STAGGER", stagger: Math.max(0.1, ctx.anim.stagger) }, seqOpts(ctx, sec(ctx, 0.2)));
  const talk = 0.5 + 0.5 * Math.sin((ctx.frame / ctx.fps) * Math.PI * 2.2) * Math.sin((ctx.frame / ctx.fps) * Math.PI * 0.7);
  const ctl: CSSProperties = t.dark ? { background: rgba("#16161C", 0.72), boxShadow: `inset 0 0 0 1.5px ${rgba("#FFFFFF", 0.1)}` } : { background: rgba("#FFFFFF", 0.86), boxShadow: `0 10px 30px ${rgba("#000000", 0.2)}` };
  const btnBg = t.dark ? "#3A3A46" : "#EDEDF2";
  const icn = t.dark ? "#FFFFFF" : "#15151C";
  const { no } = callColors(ctx, t);
  return (
    <div style={{ ...fill, borderRadius: 60, overflow: "hidden", background: `linear-gradient(160deg, ${mix(a, "#101018", 0.55)} 0%, ${mix(b, "#08080C", 0.7)} 100%)`, boxShadow: `0 40px 90px ${rgba("#000000", 0.45)}, inset 0 0 0 1.5px ${rgba("#FFFFFF", 0.1)}`, opacity: prog(ctx.frame, 0, sec(ctx, 0.25)) }}>
      <div style={{ ...fill, background: `radial-gradient(ellipse 70% 45% at 50% 40%, ${rgba("#FFFFFF", 0.16)} 0%, transparent 70%), linear-gradient(180deg, ${rgba("#000000", 0.35)} 0%, transparent 22%, transparent 70%, ${rgba("#000000", 0.45)} 100%)` }} />
      <div style={{ position: "absolute", left: W / 2 - 160, top: H * 0.4 - 160, width: 320, height: 320, ...css(seqStyle(ctx, seq, 0, 0, { style: ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter })) }}>
        <div style={{ position: "absolute", inset: -14, borderRadius: "50%", border: `5px solid ${rgba(ctx.p.positive, 0.35 + 0.5 * talk)}`, transform: `scale(${r4(1 + 0.03 * talk)})` }} />
        <Avatar name={name} size={320} />
      </div>
      <div style={{ position: "absolute", left: 44, top: 46, maxWidth: W - 330, ...css(seqStyle(ctx, seq, 0, 1, { distance: 0.5 })) }}>
        <div style={{ ...bold(44, "#FFFFFF"), textShadow: `0 2px 10px ${rgba("#000000", 0.4)}` }}>{ell(name, 44, W - 330, 1)}</div>
        {timer ? <div style={{ ...txt(32, rgba("#FFFFFF", 0.85), TAB), marginTop: 6 }}>{timer}</div> : null}
      </div>
      <div style={{ position: "absolute", right: 34, top: 34, width: 210, height: 300, borderRadius: 30, overflow: "hidden", background: `linear-gradient(160deg, ${mix(ctx.p.secondary, "#2A2A33", 0.4)} 0%, #121218 100%)`, boxShadow: `0 14px 34px ${rgba("#000000", 0.4)}, inset 0 0 0 2px ${rgba("#FFFFFF", 0.18)}`, display: "flex", alignItems: "center", justifyContent: "center", ...css(seqStyle(ctx, seq, 0, 2, { style: ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter })) }}>
        <GIcon icon="USER" size={120} color={rgba("#FFFFFF", 0.55)} stroke={1.6} />
      </div>
      <div style={{ position: "absolute", left: 40, right: 40, bottom: 40, height: 160, borderRadius: 80, ...ctl, display: "flex", alignItems: "center", justifyContent: "space-around", padding: "0 20px", ...css(seqStyle(ctx, seq, 0, 3, { distance: 1 })) }}>
        <CallButton size={108} bg={btnBg}>
          <GIcon icon="MIC" size={48} color={icn} stroke={2.1} />
        </CallButton>
        <CallButton size={108} bg={btnBg}>
          <GIcon icon="VIDEO" size={50} color={icn} stroke={2.1} />
        </CallButton>
        <CallButton size={108} bg={btnBg}>
          <GIcon icon="REPOST" size={48} color={icn} stroke={2.1} />
        </CallButton>
        <CallButton size={108} bg={no}>
          <Handset size={54} color="#FFFFFF" rotate={135} />
        </CallButton>
      </div>
    </div>
  );
}

// ===================================================================== PHONE_APP

function Check({ size, on, color, ring, draw = 1 }: { size: number; on: number; color: string; ring: string; draw?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", flex: "none", position: "relative", boxShadow: `inset 0 0 0 3px ${on > 0.5 ? color : ring}` }}>
      <div style={{ ...fill, borderRadius: "50%", background: color, transform: `scale(${r4(on)})` }} />
      {on > 0.3 ? (
        <svg width={size} height={size} viewBox="0 0 24 24" style={{ position: "absolute", inset: 0 }}>
          <path d="M7 12.5l3.2 3.2L17 8.8" fill="none" stroke="#FFFFFF" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={r4(1 - clamp01(draw))} />
        </svg>
      ) : null}
    </div>
  );
}

function PhoneApp({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "REMINDERS":
      return <Reminders ctx={ctx} />;
    case "INBOX":
      return <Inbox ctx={ctx} />;
    case "EMAIL":
      return <Email ctx={ctx} />;
    case "INVITE":
      return <Invite ctx={ctx} />;
    default:
      return <Notes ctx={ctx} />;
  }
}

function Notes({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props } = ctx;
  const PAD = 48;
  const W = ctx.width;
  let y = 40;
  const metaY = y;
  if (props.meta) y += 44;
  const titleY = y;
  if (props.title) y += 84;
  const items = props.items.length ? props.items : [];
  const cps = 30;
  const t0 = sec(ctx, 0.4);
  const lines = items.map((it) => {
    const box = it.state === "DONE" || it.state === "TODO" || it.state === "NO";
    const w = W - 2 * PAD - (box ? 64 : 0);
    return { it, box, text: ell(it.text || " ", 36, w) };
  });
  const durs = lines.map((l) => Math.ceil((l.text.length / (cps * ctx.anim.speed)) * ctx.fps) + sec(ctx, 0.18));
  const total = durs.reduce((a, b) => a + b, 0);
  const k = squeeze(ctx, t0, total + sec(ctx, 0.3), 0.8);
  let cur = t0;
  const starts = durs.map((d) => {
    const s = cur;
    cur += d * k;
    return Math.round(s);
  });
  const paper = t.dark ? undefined : { background: "linear-gradient(170deg, #FFFEFA 0%, #FBF8EF 100%)" };
  return (
    <Card t={t} radius={44} style={paper}>
      {props.meta ? <div style={{ position: "absolute", left: 0, right: 0, top: metaY, textAlign: "center", ...txt(28, t.muted), ...riseStyle(ctx, 0, 6) }}>{ell(props.meta, 28, W - 2 * PAD)}</div> : null}
      {props.title ? <div style={{ position: "absolute", left: PAD, right: PAD, top: titleY + 8, ...bold(52, t.ink), ...riseStyle(ctx, sec(ctx, 0.05), 10) }}>{ell(props.title, 52, W - 2 * PAD, 1)}</div> : null}
      {lines.map((l, i) => {
        const s = starts[i]!;
        const len = Math.max(1, (durs[i]! - sec(ctx, 0.18)) * k);
        const n = ctx.frame < s ? 0 : Math.min(l.text.length, Math.ceil(((ctx.frame - s) / len) * l.text.length));
        const typing = ctx.frame >= s && n < l.text.length;
        const lastTyped = i === lines.length - 1 && n === l.text.length;
        const showCaret = typing || (lastTyped && ctx.frame < buildBudget(ctx, 0.2));
        const doneAt = s + len + sec(ctx, 0.1);
        const on = l.it.state === "DONE" ? Math.min(1, popAt(ctx, doneAt, "soft", sec(ctx, 0.6))) : 0;
        const blink = Math.floor(ctx.frame / Math.round(ctx.fps * 0.5)) % 2 === 0 || typing;
        return (
          <div key={i} style={{ position: "absolute", left: PAD, right: PAD, top: y + i * 76, height: 76, display: "flex", alignItems: "center", gap: 22, opacity: ctx.frame >= s - 2 ? 1 : 0 }}>
            {l.box ? <Check size={42} on={on} color={t.accent} ring={t.faint} draw={prog(ctx.frame, doneAt + 3, sec(ctx, 0.3))} /> : null}
            <div style={{ ...txt(36, l.it.state === "DONE" && on > 0.5 ? t.muted : t.ink), position: "relative" }}>
              {l.text.slice(0, n)}
              {showCaret ? <span style={{ display: "inline-block", width: 3.5, height: 40, marginLeft: 3, verticalAlign: "-0.15em", borderRadius: 2, background: t.accent, opacity: blink ? 1 : 0 }} /> : null}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

function Reminders({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props } = ctx;
  const PAD = 44;
  const W = ctx.width;
  let y = 40;
  const titleY = y;
  if (props.title) y += 84;
  const seq = listSequence(props.items.length, ctx.anim, seqOpts(ctx, sec(ctx, 0.25)));
  const done = props.items.map((it, i) => (it.state === "DONE" ? i : -1)).filter((i) => i >= 0);
  const t0 = seq.done + sec(ctx, 0.2);
  const gap = sec(ctx, 0.6);
  const k = squeeze(ctx, t0, gap * done.length, 0.8);
  const tickAt = new Map(done.map((i, j) => [i, Math.round(t0 + j * gap * k)]));
  const rows = props.items.map((it) => {
    const h = it.sub ? 104 : 80;
    const r = { it, y, h };
    y += h;
    return r;
  });
  return (
    <Card t={t} radius={44}>
      {props.title ? <div style={{ position: "absolute", left: PAD, right: PAD, top: titleY + 6, ...bold(52, t.accent), ...riseStyle(ctx, 0, 10) }}>{ell(props.title, 52, W - 2 * PAD, 1)}</div> : null}
      {rows.map((r, i) => {
        const at = tickAt.get(i);
        const on = at === undefined ? 0 : Math.min(1, popAt(ctx, at, "soft", sec(ctx, 0.6)));
        const strike = at === undefined ? 0 : prog(ctx.frame, at + 2, sec(ctx, 0.35), ctx.ease);
        const textWd = W - 2 * PAD - 48 - 24;
        const label = ell(r.it.text || " ", 36, textWd);
        const lw = Math.min(textWd, textW(label, 36, K));
        const press = at === undefined ? 0 : pressAt(ctx, at - 2, sec(ctx, 0.2));
        return (
          <div key={i} style={{ position: "absolute", left: PAD, right: PAD, top: r.y, height: r.h, display: "flex", alignItems: "center", gap: 24, ...css(seqStyle(ctx, seq, 0, i)) }}>
            <div style={{ transform: `scale(${r4(1 - 0.12 * press)})` }}>
              <Check size={48} on={on} color={t.accent} ring={t.faint} draw={prog(ctx.frame, (at ?? 0) + 3, sec(ctx, 0.3))} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, borderBottom: i < rows.length - 1 ? `1.5px solid ${t.line}` : undefined, height: r.h, justifyContent: "center", boxSizing: "border-box" }}>
              <div style={{ position: "relative", alignSelf: "flex-start" }}>
                <div style={txt(36, mix(t.ink, t.faint, strike * 0.8))}>{label}</div>
                <div style={{ position: "absolute", left: 0, top: "52%", height: 3, width: lw * strike, background: t.muted, borderRadius: 2 }} />
              </div>
              {r.it.sub ? <div style={{ ...txt(28, t.muted), marginTop: 6 }}>{ell(r.it.sub, 28, textWd)}</div> : null}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

function Inbox({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props } = ctx;
  const PAD = 36;
  const W = ctx.width;
  const seq = listSequence(props.items.length, ctx.anim, seqOpts(ctx, sec(ctx, 0.25)));
  const heading = props.title || "Inbox";
  const sub = props.subtitle;
  const hasHi = props.highlight !== null && props.highlight < props.items.length;
  const em = emphasisAt(ctx, hasHi ? seq.at(0, props.highlight!) + seq.len : 0);
  return (
    <Card t={t} radius={44}>
      <div style={{ position: "absolute", left: PAD, right: PAD, top: 36, height: 80, display: "flex", alignItems: "center", justifyContent: "space-between", ...riseStyle(ctx, 0, 10) }}>
        <div style={bold(52, t.ink)}>{ell(heading, 52, W - 2 * PAD - (sub ? textW(sub, 28, K) + 30 : 0), 1)}</div>
        {sub ? <div style={txt(28, t.accent)}>{sub}</div> : null}
      </div>
      {props.items.map((it, i) => {
        const unread = it.state === "TODO";
        const time = it.meta ?? "";
        const colW = W - 2 * PAD - 30 - 84 - 22;
        const timeW = time ? textW(time, 28, K) + 16 : 0;
        const hi = hasHi && props.highlight === i;
        const dot = unread ? Math.min(1, popAt(ctx, seq.at(0, i) + sec(ctx, 0.25), "punch", sec(ctx, 0.6))) : 0;
        return (
          <div key={i} style={{ position: "absolute", left: 12, right: 12, top: 128 + i * 144, height: 144, borderRadius: 26, background: hi ? rgba(t.accent, 0.1 * em.on) : undefined, ...css(seqStyle(ctx, seq, 0, i)) }}>
            <div style={{ position: "absolute", left: PAD - 12, right: PAD - 12, top: 0, bottom: 0, display: "flex", alignItems: "center", gap: 0, borderBottom: i < props.items.length - 1 ? `1.5px solid ${t.line}` : undefined }}>
              <div style={{ width: 30, flex: "none", display: "flex", justifyContent: "flex-start" }}>
                <div style={{ width: 18, height: 18, borderRadius: 9, background: t.accent, transform: `scale(${r4(dot)})` }} />
              </div>
              <Avatar name={it.text} size={84} />
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, marginLeft: 22 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <div style={bold(36, t.ink, { fontFamily: unread ? FONT.displayBold : FONT.text })}>{ell(it.text || " ", 36, colW - timeW, unread ? 1 : K)}</div>
                  {time ? <div style={txt(28, unread ? t.accent : t.muted)}>{time}</div> : null}
                </div>
                {it.sub ? <div style={{ ...txt(34, unread ? mix(t.ink, t.surface, 0.12) : t.muted), marginTop: 6 }}>{ell(it.sub, 34, colW)}</div> : null}
              </div>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

function Email({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props } = ctx;
  const PAD = 44;
  const W = ctx.width;
  const tl = wrap(props.title || "No subject", 44, W - 2 * PAD, 2, 1);
  const bl = wrap(props.body || " ", 34, W - 2 * PAD, 9);
  const sender = props.subtitle || "Alex";
  const senderY = 44 + Math.max(1, tl.length) * 54 + 26;
  const bodyY = senderY + 88 + 26 + 24;
  const seq = listSequence(bl.length, { ...ctx.anim, stagger: Math.min(0.12, Math.max(0.06, ctx.anim.stagger)) }, seqOpts(ctx, sec(ctx, 0.5)));
  const time = props.meta;
  return (
    <Card t={t} radius={44}>
      {tl.map((l, i) => (
        <div key={i} style={{ position: "absolute", left: PAD, top: 44 + i * 54, ...bold(44, t.ink, { lineHeight: "54px" }), ...riseStyle(ctx, i * 2, 10) }}>
          {l}
        </div>
      ))}
      <div style={{ position: "absolute", left: PAD, right: PAD, top: senderY, height: 88, display: "flex", alignItems: "center", gap: 22, ...riseStyle(ctx, sec(ctx, 0.15), 10) }}>
        <Avatar name={sender} size={80} />
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <div style={bold(34, t.ink)}>{ell(sender, 34, W - 2 * PAD - 120 - (time ? textW(time, 28, K) + 20 : 0), 1)}</div>
          <div style={{ ...txt(28, t.muted), marginTop: 4 }}>to me</div>
        </div>
        {time ? <div style={{ ...txt(28, t.muted), alignSelf: "flex-start", marginTop: 10 }}>{time}</div> : null}
      </div>
      <div style={{ position: "absolute", left: PAD, right: PAD, top: senderY + 88 + 26, height: 1.5, background: t.line, opacity: prog(ctx.frame, sec(ctx, 0.25), sec(ctx, 0.3)) }} />
      {bl.map((l, i) => (
        <div key={i} style={{ position: "absolute", left: PAD, top: bodyY + i * 48, ...txt(34, mix(t.ink, t.surface, 0.1), { lineHeight: "48px" }), ...css(seqStyle(ctx, seq, 0, i, { distance: 0.4 })) }}>
          {l}
        </div>
      ))}
    </Card>
  );
}

function Invite({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props } = ctx;
  const PAD = 40;
  const W = ctx.width;
  const tl = wrap(props.title || "Event", 46, W - 2 * PAD, 2, 1);
  let y = 40 + 56 + 18;
  const titleY = y;
  y += Math.max(1, tl.length) * 56 + 16;
  const rows: Array<{ icon: GraphicIcon; text: string; y: number }> = [];
  if (props.subtitle) {
    rows.push({ icon: "CLOCK", text: props.subtitle, y });
    y += 52;
  }
  if (props.meta) {
    rows.push({ icon: "PIN", text: props.meta, y });
    y += 52;
  }
  const people = props.items.map((i) => i.text).filter(Boolean);
  const peopleY = y;
  if (props.items.length) y += 92;
  const btnY = y + 28;
  const seq = listSequence(2 + rows.length + (people.length ? 1 : 0), { ...ctx.anim, stagger: Math.max(0.08, ctx.anim.stagger) }, seqOpts(ctx, sec(ctx, 0.15)));
  const btnIdx = 1 + rows.length + (people.length ? 1 : 0);
  const pressT = Math.max(seq.done + sec(ctx, 0.35), Math.min(buildBudget(ctx, 0.9) - sec(ctx, 0.5), seq.done + sec(ctx, 0.8)));
  const accepted = prog(ctx.frame, pressT + sec(ctx, 0.12), sec(ctx, 0.3), ctx.ease);
  const press = pressAt(ctx, pressT, sec(ctx, 0.25));
  const rip = rippleAt(ctx, pressT);
  const bw = (W - 2 * PAD - 2 * 18) / 3;
  const shown = people.slice(0, 4);
  const extra = people.length - shown.length;
  const names = people.length <= 2 ? people.join(" & ") : `${people.slice(0, 2).join(", ")} +${people.length - 2}`;
  return (
    <Card t={t} radius={44}>
      <div style={{ position: "absolute", left: PAD, top: 40, height: 56, display: "flex", alignItems: "center", gap: 18, ...css(seqStyle(ctx, seq, 0, 0, { distance: 0.5 })) }}>
        <AppTile icon="CALENDAR" size={56} color={t.solid} />
        <div style={txt(28, t.muted)}>Invitation</div>
      </div>
      {tl.map((l, i) => (
        <div key={i} style={{ position: "absolute", left: PAD, top: titleY + i * 56, ...bold(46, t.ink, { lineHeight: "56px" }), ...css(seqStyle(ctx, seq, 0, 0, { distance: 0.5 })) }}>
          {l}
        </div>
      ))}
      {rows.map((r, i) => (
        <div key={i} style={{ position: "absolute", left: PAD, right: PAD, top: r.y, height: 52, display: "flex", alignItems: "center", gap: 16, ...css(seqStyle(ctx, seq, 0, 1 + i, { distance: 0.5 })) }}>
          <GIcon icon={r.icon} size={36} color={t.accent} stroke={2.1} />
          <div style={txt(34, t.ink)}>{ell(r.text, 34, W - 2 * PAD - 52)}</div>
        </div>
      ))}
      {people.length ? (
        <div style={{ position: "absolute", left: PAD, right: PAD, top: peopleY + 12, height: 68, display: "flex", alignItems: "center", ...css(seqStyle(ctx, seq, 0, 1 + rows.length, { distance: 0.5 })) }}>
          {shown.map((n, i) => (
            <Avatar key={i} name={n} size={64} ring={t.dark ? "#1C1C25" : "#FFFFFF"} style={{ marginLeft: i ? -16 : 0, zIndex: 9 - i }} />
          ))}
          {extra > 0 ? <div style={{ marginLeft: -16, width: 64, height: 64, borderRadius: 32, background: t.fill2, boxShadow: `0 0 0 3px ${t.dark ? "#1C1C25" : "#FFFFFF"}`, display: "flex", alignItems: "center", justifyContent: "center", ...txt(28, t.ink) }}>+{extra}</div> : null}
          <div style={{ ...txt(28, t.muted), marginLeft: 18 }}>{ell(names, 28, W - 2 * PAD - shown.length * 48 - 120)}</div>
        </div>
      ) : null}
      <div style={{ position: "absolute", left: PAD, right: PAD, top: btnY, height: 96, display: "flex", gap: 18, ...css(seqStyle(ctx, seq, 0, btnIdx, { distance: 0.6 })) }}>
        {["Decline", "Maybe"].map((l) => (
          <div key={l} style={{ width: bw, height: 96, borderRadius: 48, background: t.fill, display: "flex", alignItems: "center", justifyContent: "center", ...txt(32, t.ink), opacity: 1 - 0.5 * accepted }}>
            {l}
          </div>
        ))}
        <div style={{ position: "relative", width: bw, height: 96, borderRadius: 48, overflow: "hidden", background: t.solid, boxShadow: `0 8px 20px ${rgba(t.solid, 0.3)}`, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, transform: `scale(${r4(1 - 0.06 * press)})` }}>
          {rip !== null ? <div style={{ position: "absolute", left: "50%", top: "50%", width: bw * 1.4, height: bw * 1.4, marginLeft: -bw * 0.7, marginTop: -bw * 0.7, borderRadius: "50%", background: rgba("#FFFFFF", 0.3 * (1 - rip)), transform: `scale(${r4(rip)})` }} /> : null}
          {accepted > 0.02 ? <GIcon icon="CHECK" size={34} color={t.onSolid} stroke={2.6} draw={accepted} /> : null}
          <div style={txt(32, t.onSolid)}>{accepted > 0.5 ? "Going" : "Accept"}</div>
        </div>
      </div>
    </Card>
  );
}

// ===================================================================== CLOCK_TIMER

function ClockTimer({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "TIMER":
      return <Timer ctx={ctx} />;
    case "STOPWATCH":
      return <Stopwatch ctx={ctx} />;
    case "CLOCK":
      return <AnalogClock ctx={ctx} />;
    default:
      return <Alarm ctx={ctx} />;
  }
}

function Alarm({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props } = ctx;
  const W = ctx.width;
  const ringFrom = sec(ctx, 0.35);
  const age = (ctx.frame - ringFrom) / ctx.fps;
  const ringing = age > 0 ? Math.sin(age * Math.PI * 14) * 14 * (0.55 + 0.45 * Math.abs(Math.sin(age * Math.PI * 0.9))) : 0;
  const time = props.title || "6:00 AM";
  const tSize = Math.min(124, Math.floor((560 / Math.max(1, textW(time, 124, 1))) * 124));
  const seq = listSequence(3, { ...ctx.anim, stagger: Math.max(0.1, ctx.anim.stagger) }, seqOpts(ctx, sec(ctx, 0.1)));
  const bw = (W - 88 - 24) / 2;
  const P = Math.round(ctx.fps * 0.9);
  return (
    <Card t={t} radius={52}>
      <div style={{ position: "absolute", left: 44, top: 44, width: 150, height: 150, ...css(seqStyle(ctx, seq, 0, 0, { style: ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter })) }}>
        {age > 0
          ? [0, 1].map((k) => {
              const ph = (((ctx.frame - ringFrom) + (k * P) / 2) % P) / P;
              return <div key={k} style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `3px solid ${rgba(t.accent, 0.5 * (1 - ph))}`, transform: `scale(${r4(1 + 0.4 * ph)})` }} />;
            })
          : null}
        <div style={{ ...fill, borderRadius: "50%", background: `linear-gradient(160deg, ${mix(t.solid, "#FFFFFF", 0.15)} 0%, ${t.solid} 100%)`, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 12px 28px ${rgba(t.solid, 0.35)}` }}>
          <div style={{ transform: `rotate(${r1(ringing)}deg)` }}>
            <GIcon icon="ALARM" size={78} color={t.onSolid} stroke={2.1} />
          </div>
        </div>
      </div>
      <div style={{ position: "absolute", left: 230, right: 44, top: 44, height: 150, display: "flex", flexDirection: "column", justifyContent: "center", ...css(seqStyle(ctx, seq, 0, 1, { distance: 0.5 })) }}>
        <div style={txt(32, t.muted)}>{ell(props.subtitle || "Alarm", 32, W - 274)}</div>
        <div style={{ fontFamily: FONT.display, fontSize: tSize, lineHeight: 1.02, letterSpacing: "-0.03em", color: t.ink, whiteSpace: "nowrap", ...TAB }}>{time}</div>
      </div>
      <div style={{ position: "absolute", left: 44, right: 44, bottom: 44, height: 100, display: "flex", gap: 24, ...css(seqStyle(ctx, seq, 0, 2, { distance: 0.6 })) }}>
        <div style={{ width: bw, height: 100, borderRadius: 50, background: t.fill2, display: "flex", alignItems: "center", justifyContent: "center", ...txt(34, t.ink) }}>Snooze</div>
        <div style={{ width: bw, height: 100, borderRadius: 50, background: t.solid, display: "flex", alignItems: "center", justifyContent: "center", ...txt(34, t.onSolid) }}>Stop</div>
      </div>
    </Card>
  );
}

function Timer({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props } = ctx;
  const W = ctx.width;
  const from = Math.max(1, props.items[0]?.value ?? 300);
  const to = Math.max(0, Math.min(from, props.items[1]?.value ?? 0));
  const t0 = sec(ctx, 0.45);
  const t1 = buildBudget(ctx, 0.9);
  const k = clamp01((ctx.frame - t0) / Math.max(1, t1 - t0));
  const now = from - (from - to) * k;
  const shownSec = Math.ceil(now - 1e-6);
  const frac = now / from;
  const R = 222;
  const C = 2 * Math.PI * R;
  const ringIn = prog(ctx.frame, 0, sec(ctx, 0.6), ctx.ease);
  const doneOn = to === 0 && k >= 1 ? 1 : 0;
  const flash = doneOn ? (Math.floor((ctx.frame - t1) / Math.round(ctx.fps * 0.25)) % 2 === 0 ? 1 : 0.35) : 1;
  const digits = clockText(shownSec);
  const dSize = Math.min(124, Math.floor((360 / Math.max(1, textW(digits, 124, 1))) * 124));
  const col = doneOn ? t.negative : t.accent;
  const titleY = 40 + 500 + 10;
  return (
    <Card t={t} radius={56}>
      <div style={{ position: "absolute", left: (W - 500) / 2, top: 40, width: 500, height: 500, ...popStyle(ctx, 0, "50% 50%", 0.8) }}>
        <svg width={500} height={500} viewBox="0 0 500 500" style={{ position: "absolute", inset: 0 }}>
          <circle cx={250} cy={250} r={R} fill="none" stroke={t.fill2} strokeWidth={24} />
          <circle cx={250} cy={250} r={R} fill="none" stroke={col} strokeWidth={24} strokeLinecap="round" strokeDasharray={`${r1(C * frac * ringIn)} ${r1(C)}`} transform="rotate(-90 250 250) translate(500 0) scale(-1 1)" />
        </svg>
        <div style={{ ...fill, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontFamily: FONT.display, fontSize: dSize, letterSpacing: "-0.03em", color: doneOn ? t.negative : t.ink, opacity: flash, lineHeight: 1, ...TAB }}>{digits}</div>
          <div style={{ ...txt(28, t.muted), marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <GIcon icon="BELL" size={28} color={t.muted} stroke={2} />
            {clockText(from)}
          </div>
        </div>
      </div>
      {props.title ? <div style={{ position: "absolute", left: 30, right: 30, top: titleY, textAlign: "center", ...bold(46, t.ink), ...riseStyle(ctx, sec(ctx, 0.15), 10) }}>{ell(props.title, 46, W - 60, 1)}</div> : null}
      {props.subtitle ? <div style={{ position: "absolute", left: 30, right: 30, top: titleY + (props.title ? 70 : 0), textAlign: "center", ...txt(30, t.muted), ...riseStyle(ctx, sec(ctx, 0.2), 10) }}>{ell(props.subtitle, 30, W - 60)}</div> : null}
    </Card>
  );
}

function Stopwatch({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props } = ctx;
  const W = ctx.width;
  const end = Math.max(0, props.items[0]?.value ?? 42.8);
  const t0 = sec(ctx, 0.4);
  const t1 = buildBudget(ctx, 0.9);
  const k = clamp01((ctx.frame - t0) / Math.max(1, t1 - t0));
  const now = end * k;
  const digits = clockText(now, true);
  const dSize = Math.min(150, Math.floor(((W - 100) / Math.max(1, textW(clockText(end, true), 150, 1))) * 150));
  const running = k < 1;
  const seq = listSequence(2, ctx.anim, seqOpts(ctx, sec(ctx, 0.1)));
  return (
    <Card t={t} radius={52}>
      {props.title ? <div style={{ position: "absolute", left: 44, top: 36, ...txt(30, t.muted), ...riseStyle(ctx, 0, 6) }}>{ell(props.title, 30, W - 88)}</div> : null}
      <div style={{ position: "absolute", left: 0, right: 0, top: props.title ? 80 : 60, textAlign: "center", fontFamily: FONT.display, fontSize: dSize, letterSpacing: "-0.02em", lineHeight: 1.05, color: running ? t.ink : t.accent, ...TAB, ...css(seqStyle(ctx, seq, 0, 0, { distance: 0.5 })) }}>{digits}</div>
      <div style={{ position: "absolute", left: 44, right: 44, bottom: 40, height: 96, display: "flex", justifyContent: "space-between", ...css(seqStyle(ctx, seq, 0, 1, { distance: 0.6 })) }}>
        <div style={{ width: 220, height: 96, borderRadius: 48, background: t.fill2, display: "flex", alignItems: "center", justifyContent: "center", ...txt(32, t.ink) }}>Lap</div>
        <div style={{ width: 220, height: 96, borderRadius: 48, background: running ? rgba(t.negative, t.dark ? 0.22 : 0.12) : rgba(t.positive, t.dark ? 0.22 : 0.14), display: "flex", alignItems: "center", justifyContent: "center", ...txt(32, running ? t.negative : t.positive) }}>{running ? "Stop" : "Start"}</div>
      </div>
    </Card>
  );
}

function AnalogClock({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props } = ctx;
  const W = ctx.width;
  const h0 = props.items[0]?.value ?? 9;
  const h1 = props.items[1]?.value ?? h0 + 3;
  const t0 = sec(ctx, 0.45);
  const t1 = buildBudget(ctx, 0.9);
  const k = prog(ctx.frame, t0, Math.max(1, t1 - t0), (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2));
  const hNow = h0 + (h1 - h0) * k;
  const hourDeg = ((hNow % 12) / 12) * 360;
  const minDeg = (hNow % 1) * 360;
  const S = 520;
  const c = S / 2;
  const face = t.dark ? "#101017" : "#FFFFFF";
  const tick = t.dark ? "#FFFFFF" : "#15151C";
  const fmtH = (h: number) => {
    const hh = ((Math.floor(h) % 12) + 12) % 12 || 12;
    const mm = Math.floor((((h % 1) + 1) % 1) * 60);
    return `${hh}:${String(mm).padStart(2, "0")}`;
  };
  return (
    <Card t={t} radius={56}>
      <div style={{ position: "absolute", left: (W - S) / 2, top: 40, width: S, height: S, ...popStyle(ctx, 0, "50% 50%", 0.8) }}>
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
          <circle cx={c} cy={c} r={c - 6} fill={face} stroke={t.line} strokeWidth={3} />
          <circle cx={c} cy={c} r={c - 30} fill="none" stroke={rgba(tick, 0.28)} strokeWidth={8} strokeDasharray={`2.5 ${r1((2 * Math.PI * (c - 30)) / 60 - 2.5)}`} />
          {Array.from({ length: 12 }, (_, i) => {
            const a = (i / 12) * Math.PI * 2;
            const r0 = c - 54;
            const r2 = c - 26;
            return <line key={i} x1={r1(c + Math.sin(a) * r0)} y1={r1(c - Math.cos(a) * r0)} x2={r1(c + Math.sin(a) * r2)} y2={r1(c - Math.cos(a) * r2)} stroke={tick} strokeWidth={i % 3 === 0 ? 9 : 5} strokeLinecap="round" />;
          })}
          {[12, 3, 6, 9].map((n, i) => {
            const a = (i / 4) * Math.PI * 2;
            const r = c - 100;
            return (
              <text key={n} x={r1(c + Math.sin(a) * r)} y={r1(c - Math.cos(a) * r + 17)} textAnchor="middle" fontFamily={FONT.displayBold} fontSize={48} fill={tick}>
                {n}
              </text>
            );
          })}
          <g transform={`rotate(${r1(hourDeg)} ${c} ${c})`}>
            <line x1={c} y1={c + 22} x2={c} y2={c - 128} stroke={tick} strokeWidth={16} strokeLinecap="round" />
          </g>
          <g transform={`rotate(${r1(minDeg)} ${c} ${c})`}>
            <line x1={c} y1={c + 30} x2={c} y2={c - 196} stroke={tick} strokeWidth={10} strokeLinecap="round" />
          </g>
          <circle cx={c} cy={c} r={16} fill={t.accent} />
          <circle cx={c} cy={c} r={6} fill={face} />
        </svg>
      </div>
      {props.title ? (
        <div style={{ position: "absolute", left: 36, right: 36, top: 40 + S + 22, height: 60, display: "flex", alignItems: "baseline", justifyContent: "center", gap: 18, ...riseStyle(ctx, sec(ctx, 0.15), 10) }}>
          <div style={bold(46, t.ink)}>{ell(props.title, 46, W - 72 - 150, 1)}</div>
          <div style={{ ...txt(34, t.accent), ...TAB }}>{fmtH(hNow)}</div>
        </div>
      ) : null}
    </Card>
  );
}

// ===================================================================== STATUS_ALERT

function StatusAlert({ ctx }: { ctx: GCtx }) {
  switch (ctx.variant) {
    case "SIGNAL":
      return <BatterySignal ctx={ctx} signal />;
    case "ALERT":
      return <AlertDialog ctx={ctx} />;
    case "TOAST":
      return <Toast ctx={ctx} />;
    default:
      return <BatterySignal ctx={ctx} />;
  }
}

function BatterySignal({ ctx, signal }: { ctx: GCtx; signal?: boolean }) {
  const t = toneOf(ctx);
  const { props } = ctx;
  const W = ctx.width;
  const bl = wrap(props.body, 34, W - 88, 3);
  const titleY = 44 + 132 + 30;
  const bodyY = titleY + (props.title ? 52 : 0) + 8;
  const t0 = sec(ctx, 0.3);
  const end = buildBudget(ctx, 1);
  let glyph: ReactNode;
  if (signal) {
    const steps = 7; // 4 bars + 3 arcs fade out in turn
    const step = Math.max(2, Math.floor((end - t0 - sec(ctx, 0.4)) / steps));
    const gone = (i: number) => prog(ctx.frame, t0 + i * step, Math.max(2, step));
    const slash = prog(ctx.frame, t0 + steps * step, sec(ctx, 0.3), ctx.ease);
    const on = t.ink;
    const off = t.dark ? rgba("#FFFFFF", 0.16) : rgba("#000000", 0.12);
    glyph = (
      <div style={{ display: "flex", alignItems: "flex-end", gap: 70, height: 132 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 12, height: 110 }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ width: 26, height: 32 + i * 26, borderRadius: 7, background: mix(on, off.startsWith("rgba") ? (t.dark ? "#3A3A44" : "#D6D6DC") : off, gone(3 - i)) }} />
          ))}
        </div>
        <div style={{ position: "relative", width: 150, height: 120 }}>
          <svg width={150} height={120} viewBox="0 0 150 120">
            {[0, 1, 2].map((i) => {
              const r = 30 + i * 32;
              const g = gone(4 + (2 - i));
              return <path key={i} d={`M ${r1(75 - r * 0.72)} ${r1(108 - r * 0.7)} A ${r} ${r} 0 0 1 ${r1(75 + r * 0.72)} ${r1(108 - r * 0.7)}`} fill="none" stroke={mix(on, t.dark ? "#3A3A44" : "#D6D6DC", g)} strokeWidth={12} strokeLinecap="round" />;
            })}
            <circle cx={75} cy={104} r={9} fill={mix(on, t.dark ? "#3A3A44" : "#D6D6DC", gone(6))} />
            <line x1={20} y1={14} x2={20 + 112 * slash} y2={14 + 100 * slash} stroke={t.negative} strokeWidth={12} strokeLinecap="round" opacity={slash > 0 ? 1 : 0} />
          </svg>
        </div>
      </div>
    );
  } else {
    const level = Math.max(0, Math.min(100, props.items[0]?.value ?? 1));
    const startL = Math.min(100, level + 24);
    const now = counted(ctx, t0, level, startL, 2.4);
    const low = now <= 20;
    const blink = low && ctx.frame > end - sec(ctx, 0.4) ? (Math.floor(ctx.frame / Math.round(ctx.fps * 0.3)) % 2 === 0 ? 1 : 0.35) : 1;
    const col = low ? t.negative : t.positive;
    glyph = (
      <div style={{ display: "flex", alignItems: "center", gap: 40, height: 132 }}>
        <div style={{ position: "relative", width: 230, height: 108 }}>
          <div style={{ position: "absolute", left: 0, top: 0, width: 214, height: 108, borderRadius: 26, boxShadow: `inset 0 0 0 6px ${t.dark ? rgba("#FFFFFF", 0.55) : rgba("#000000", 0.45)}` }} />
          <div style={{ position: "absolute", right: 0, top: 36, width: 12, height: 36, borderRadius: "0 8px 8px 0", background: t.dark ? rgba("#FFFFFF", 0.55) : rgba("#000000", 0.45) }} />
          <div style={{ position: "absolute", left: 14, top: 14, width: Math.max(10, (186 * now) / 100), height: 80, borderRadius: 14, background: col, opacity: blink }} />
        </div>
        <div style={{ fontFamily: FONT.display, fontSize: 104, letterSpacing: "-0.03em", color: low ? t.negative : t.ink, lineHeight: 1, ...TAB }}>{Math.round(now)}%</div>
      </div>
    );
  }
  return (
    <Card t={t} radius={52}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 44, display: "flex", justifyContent: "center", ...popStyle(ctx, 0, "50% 50%", 0.85) }}>{glyph}</div>
      {props.title ? <div style={{ position: "absolute", left: 44, right: 44, top: titleY, textAlign: "center", ...bold(42, t.ink), ...riseStyle(ctx, sec(ctx, 0.15), 10) }}>{ell(props.title, 42, W - 88, 1)}</div> : null}
      {bl.map((l, i) => (
        <div key={i} style={{ position: "absolute", left: 44, right: 44, top: bodyY + i * 44, textAlign: "center", ...txt(34, t.muted, { lineHeight: "44px" }), ...riseStyle(ctx, sec(ctx, 0.22) + i * 2, 10) }}>
          {l}
        </div>
      ))}
    </Card>
  );
}

function AlertDialog({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props } = ctx;
  const W = ctx.width;
  const tl = wrap(props.title || "Alert", 40, W - 96, 2, 1);
  const bl = wrap(props.body, 34, W - 96, 5);
  const btns = props.items.length ? props.items.slice(0, 3) : ([{ text: "OK", state: "DONE", color: "AUTO" }] as GraphicItem[]);
  const stacked = btns.length > 2;
  const btnTop = 44 + tl.length * 48 + (bl.length ? 12 + bl.length * 44 : 0) + 36;
  const defIdx = Math.max(0, btns.findIndex((b) => b.state === "DONE"));
  const s = popAt(ctx, 0, "settle", sec(ctx, 0.7));
  const o = prog(ctx.frame, 0, sec(ctx, 0.2));
  const pressT = Math.max(sec(ctx, 0.9), buildBudget(ctx, 0.8) - sec(ctx, 0.35));
  const press = pressAt(ctx, pressT, sec(ctx, 0.3));
  const bH = stacked ? 94 : 96;
  return (
    <div style={{ ...fill, opacity: o, transform: `scale(${r4(1.14 - 0.14 * Math.min(1, s))})` }}>
      <Card t={t} radius={40}>
        {tl.map((l, i) => (
          <div key={i} style={{ position: "absolute", left: 48, right: 48, top: 44 + i * 48, textAlign: "center", ...bold(40, t.ink, { lineHeight: "48px" }) }}>
            {l}
          </div>
        ))}
        {bl.map((l, i) => (
          <div key={i} style={{ position: "absolute", left: 48, right: 48, top: 44 + tl.length * 48 + 12 + i * 44, textAlign: "center", ...txt(34, mix(t.ink, t.surface, 0.22), { lineHeight: "44px" }) }}>
            {l}
          </div>
        ))}
        {btns.map((b, i) => {
          const left = stacked ? 0 : (i * W) / btns.length;
          const width = stacked ? W : W / btns.length;
          const top = stacked ? btnTop + i * bH : btnTop;
          const isDef = i === defIdx;
          const color = b.color === "NEGATIVE" ? t.negative : t.accent;
          return (
            <div key={i} style={{ position: "absolute", left, top, width, height: bH, borderTop: `1.5px solid ${t.line}`, borderLeft: !stacked && i > 0 ? `1.5px solid ${t.line}` : undefined, display: "flex", alignItems: "center", justifyContent: "center", background: isDef && press > 0 ? rgba(t.ink, 0.08 * press) : undefined, boxSizing: "border-box" }}>
              <div style={{ ...(isDef ? bold(36, color) : txt(36, color)) }}>{ell(b.text || " ", 36, width - 40, isDef ? 1 : K)}</div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function Toast({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const { props } = ctx;
  const W = ctx.width;
  const icon = props.items[0]?.icon ?? "CHECK";
  const label = ell(props.title || "Saved", 36, W - 64 - 76 - 36 - 40);
  const w = Math.min(W, Math.max(360, 64 + 76 + 24 + textW(label, 36, K) + 50));
  const H = ctx.height;
  const iconCol = props.items[0] && props.items[0].color !== "AUTO" ? colorOf(ctx, props.items[0].color, 0) : t.positive;
  const draw = prog(ctx.frame, sec(ctx, 0.3), sec(ctx, 0.4), ctx.ease);
  return (
    <div style={{ ...fill, ...dropStyle(ctx, 0, 60) }}>
      <div style={{ position: "absolute", left: (W - w) / 2, top: (H - 116) / 2, width: w, height: 116, borderRadius: 58, background: t.dark ? "#1F1F28" : "#FFFFFF", boxShadow: `0 24px 50px ${rgba("#000000", 0.35)}, 0 6px 14px ${rgba("#000000", 0.2)}, inset 0 0 0 1.5px ${t.dark ? rgba("#FFFFFF", 0.08) : rgba("#000000", 0.04)}`, display: "flex", alignItems: "center", gap: 24, padding: "0 40px 0 22px", boxSizing: "border-box" }}>
        <div style={{ width: 76, height: 76, borderRadius: 38, background: rgba(iconCol, t.dark ? 0.22 : 0.14), display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
          <GIcon icon={icon} size={42} color={readable(iconCol, t)} stroke={2.4} draw={draw} />
        </div>
        <div style={txt(36, t.ink)}>{label}</div>
      </div>
    </div>
  );
}

function readable(c: string, t: Tone): string {
  return t.dark ? mix(c, "#FFFFFF", 0.1) : mix(c, "#000000", 0.12);
}

// ===================================================================== APP_GRID

function Badge({ ctx, value, at }: { ctx: GCtx; value: number; at: number }) {
  const s = popAt(ctx, at, "punch", sec(ctx, 0.7));
  const n = counted(ctx, at, value, 0, 1.6);
  const label = value >= 1000 ? `${Math.round(n / 100) / 10}K` : value > 999 ? "999+" : String(Math.round(n));
  const w = Math.max(56, 26 + textW(label, 30, 1));
  return (
    <div style={{ position: "absolute", right: -16, top: -16, minWidth: w, height: 56, padding: "0 13px", boxSizing: "border-box", borderRadius: 28, background: mix(ctx.p.negative, "#000000", 0.04), boxShadow: `0 6px 14px ${rgba("#000000", 0.3)}, 0 0 0 3px ${rgba("#FFFFFF", 0.0)}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.displayBold, fontSize: 30, color: "#FFFFFF", transform: `scale(${r4(Math.min(1.15, s))})`, opacity: s > 0.02 ? 1 : 0, ...TAB }}>
      {label}
    </div>
  );
}

function AppGrid({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const v = ctx.variant;
  if (v === "STORE") return <AppStore ctx={ctx} t={t} />;
  const { props } = ctx;
  const W = ctx.width;
  const items = props.items;
  const seq = listSequence(items.length, { ...ctx.anim, stagger: Math.min(0.09, Math.max(0.05, ctx.anim.stagger)) }, seqOpts(ctx, sec(ctx, 0.2)));
  const hasHi = props.highlight !== null && props.highlight < items.length;
  const em = emphasisAt(ctx, hasHi ? seq.at(0, props.highlight!) + seq.len : 0);
  const badgeAt = (i: number) => seq.done + sec(ctx, 0.1) + i * sec(ctx, 0.12);
  const icon = (it: GraphicItem, i: number, size: number) => {
    const hi = hasHi && props.highlight === i;
    const sc = hi ? em.scale * (1 + 0.06 * em.on) : 1;
    return (
      <div style={{ position: "relative", width: size, height: size, transform: sc !== 1 ? `scale(${r4(sc)})` : undefined }}>
        <AppTile icon={it.icon ?? "STAR"} size={size} color={appTint(ctx, it, it.text || String(i))} style={hi && em.on > 0 ? { boxShadow: `0 0 0 ${r1(5 * em.on)}px ${rgba("#FFFFFF", 0.9)}, 0 ${r1(size * 0.1)}px ${r1(size * 0.25)}px ${rgba("#000000", 0.3)}` } : undefined} />
        {it.value !== null && it.value > 0 ? <Badge ctx={ctx} value={it.value} at={badgeAt(i)} /> : null}
      </div>
    );
  };
  const pop = (i: number) => css(seqStyle(ctx, seq, 0, i, { style: ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter }));
  if (v === "DOCK") {
    const n = Math.max(1, items.length);
    const size = Math.min(150, Math.floor((W - 72 - (n - 1) * 26) / n));
    const gapX = n > 1 ? (W - 72 - n * size) / (n - 1) : 0;
    return (
      <div style={{ ...fill, borderRadius: 72, ...(t.dark ? { background: rgba("#1E1E28", 0.82), boxShadow: `0 30px 70px ${rgba("#000000", 0.45)}, inset 0 0 0 1.5px ${rgba("#FFFFFF", 0.1)}, inset 0 1.5px 0 ${rgba("#FFFFFF", 0.14)}` } : { background: rgba("#FFFFFF", 0.82), boxShadow: `0 30px 70px ${rgba("#000000", 0.3)}, inset 0 0 0 1.5px ${rgba("#FFFFFF", 0.9)}` }), opacity: prog(ctx.frame, 0, sec(ctx, 0.25)) }}>
        {items.map((it, i) => (
          <div key={i} style={{ position: "absolute", left: 36 + i * (size + gapX), top: (ctx.height - size) / 2, ...pop(i) }}>
            {icon(it, i, size)}
          </div>
        ))}
      </div>
    );
  }
  const cols = 4;
  const cellW = (W - 72) / cols;
  const ink = t.dark ? "#FFFFFF" : "#17161E";
  return (
    <div style={{ ...fill, borderRadius: 56, overflow: "visible", background: wallpaper(ctx, t), boxShadow: `0 36px 80px ${rgba("#000000", 0.4)}, inset 0 0 0 1.5px ${rgba("#FFFFFF", t.dark ? 0.08 : 0.6)}`, opacity: prog(ctx.frame, 0, sec(ctx, 0.25)) }}>
      {items.map((it, i) => {
        const c = i % cols;
        const r = Math.floor(i / cols);
        return (
          <div key={i} style={{ position: "absolute", left: 36 + c * cellW, top: 40 + r * 240, width: cellW, display: "flex", flexDirection: "column", alignItems: "center", ...pop(i) }}>
            {icon(it, i, 150)}
            <div style={{ ...txt(28, ink), marginTop: 12, textShadow: t.dark ? `0 1px 6px ${rgba("#000000", 0.5)}` : undefined }}>{ell(it.text || " ", 28, cellW - 12)}</div>
          </div>
        );
      })}
    </div>
  );
}

function AppStore({ ctx, t }: { ctx: GCtx; t: Tone }) {
  const { props } = ctx;
  const id = sid(useId());
  const W = ctx.width;
  const it0 = props.items[0];
  const it1 = props.items[1];
  const it2 = props.items[2];
  const name = props.title || "Your App";
  const rating = Math.max(0, Math.min(5, it0?.value ?? 4.8));
  const count = it1?.value ?? null;
  const seq = listSequence(4, { ...ctx.anim, stagger: Math.max(0.1, ctx.anim.stagger) }, seqOpts(ctx, sec(ctx, 0.15)));
  const statsAt = seq.at(0, 3);
  const r = counted(ctx, statsAt, rating, 0, 1.6);
  const pressT = Math.max(seq.done + sec(ctx, 0.3), Math.min(buildBudget(ctx, 1.4) - sec(ctx, 0.9), seq.done + sec(ctx, 0.7)));
  const press = pressAt(ctx, pressT, sec(ctx, 0.25));
  const morph = prog(ctx.frame, pressT + sec(ctx, 0.15), sec(ctx, 0.3), ctx.ease);
  const loadT0 = pressT + sec(ctx, 0.4);
  const load = prog(ctx.frame, loadT0, sec(ctx, 0.9), (x) => x);
  const open = prog(ctx.frame, loadT0 + sec(ctx, 0.9), sec(ctx, 0.3), ctx.ease);
  const btnW = open > 0 ? 80 + (190 - 80) * open : 190 - (190 - 80) * morph;
  const tl = wrap(props.subtitle, 32, W - 88 - 220 - 36, 2);
  const nameSize = Math.min(48, Math.floor(((W - 88 - 220 - 36) / Math.max(1, textW(name, 48, 1))) * 48));
  const starOn = t.dark ? "#FFFFFF" : "#2A2A33";
  const starOff = t.dark ? rgba("#FFFFFF", 0.18) : rgba("#000000", 0.12);
  const colW = (W - 88) / (it2 ? 3 : 2);
  return (
    <Card t={t} radius={48}>
      <div style={{ position: "absolute", left: 44, top: 44, ...css(seqStyle(ctx, seq, 0, 0, { style: ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter })) }}>
        <AppTile icon={it0?.icon ?? "CHART_UP"} size={220} color={appTint(ctx, it0, name)} />
      </div>
      <div style={{ position: "absolute", left: 44 + 220 + 36, right: 44, top: 50, ...css(seqStyle(ctx, seq, 0, 1, { distance: 0.5 })) }}>
        <div style={bold(nameSize, t.ink)}>{name}</div>
        {tl.map((l, i) => (
          <div key={i} style={{ ...txt(32, t.muted, { lineHeight: "42px" }), marginTop: i ? 0 : 6 }}>
            {l}
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", left: 44 + 220 + 36, top: 44 + 220 - 76, height: 76, width: 190, ...css(seqStyle(ctx, seq, 0, 2, { distance: 0.5 })) }}>
        <div style={{ position: "relative", width: btnW, height: 76, borderRadius: 38, background: open > 0 ? t.fill2 : morph > 0.6 ? "transparent" : t.solid, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${r4(1 - 0.08 * press)})`, overflow: "hidden" }}>
          {morph < 0.5 && open === 0 ? <div style={{ ...bold(34, t.onSolid), opacity: 1 - morph * 2 }}>Get</div> : null}
          {morph >= 0.5 && open < 0.5 ? (
            <svg width={76} height={76} viewBox="0 0 76 76" style={{ position: "absolute", left: (btnW - 76) / 2 }}>
              <circle cx={38} cy={38} r={30} fill="none" stroke={t.fill2} strokeWidth={6} />
              <circle cx={38} cy={38} r={30} fill="none" stroke={t.accent} strokeWidth={6} strokeLinecap="round" strokeDasharray={`${r1(188.5 * load)} 188.5`} transform="rotate(-90 38 38)" />
              <rect x={30} y={30} width={16} height={16} rx={3} fill={t.accent} />
            </svg>
          ) : null}
          {open >= 0.5 ? <div style={{ ...bold(34, t.accent), opacity: open }}>Open</div> : null}
        </div>
      </div>
      <div style={{ position: "absolute", left: 44, right: 44, top: 44 + 220 + 30, height: 1.5, background: t.line, opacity: prog(ctx.frame, statsAt, sec(ctx, 0.3)) }} />
      <div style={{ position: "absolute", left: 44, right: 44, top: 44 + 220 + 30 + 22, height: 70, display: "flex", ...css(seqStyle(ctx, seq, 0, 3, { distance: 0.4 })) }}>
        <div style={{ width: colW, display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ ...bold(40, t.ink), ...TAB }}>{r.toFixed(1)}</div>
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            {[0, 1, 2, 3, 4].map((s) => (
              <Star key={s} id={`${id}s${s}`} size={36} f={r - s} on={starOn} off={starOff} />
            ))}
          </div>
        </div>
        {count !== null ? (
          <div style={{ width: colW, display: "flex", flexDirection: "column", alignItems: "center", borderLeft: `1.5px solid ${t.line}` }}>
            <div style={{ ...bold(40, t.ink), ...TAB }}>{socialish(counted(ctx, statsAt, count, 0, 1.8), count)}</div>
            <div style={{ ...txt(28, t.muted), marginTop: 4 }}>{ell(it1?.text || "Ratings", 28, colW - 20)}</div>
          </div>
        ) : null}
        {it2 ? (
          <div style={{ width: colW, display: "flex", flexDirection: "column", alignItems: "center", borderLeft: `1.5px solid ${t.line}` }}>
            <div style={{ ...bold(40, t.ink), ...TAB }}>{it2.value !== null ? `#${Math.round(counted(ctx, statsAt, it2.value, Math.max(1, it2.value + 20), 1.8))}` : "—"}</div>
            <div style={{ ...txt(28, t.muted), marginTop: 4 }}>{ell(it2.text || "Chart", 28, colW - 20)}</div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function socialish(n: number, final: number): string {
  const a = Math.abs(final);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, "")}K`;
  return Math.round(n).toLocaleString("en-US");
}

// ===================================================================== KEYNOTE

function keyInk(t: Tone) {
  return t.dark ? { ink: "#FFFFFF", muted: "#8E8E99", hi: "#FFFFFF" } : { ink: "#0B0B0E", muted: "#6E6E78", hi: "#0B0B0E" };
}

/** Over footage (not full screen): a soft scrim (dark) or a frosted plate (light). */
function KeyStage({ ctx, t, children }: { ctx: GCtx; t: Tone; children: ReactNode }) {
  if (ctx.props.screen === "FULL") return <div style={fill}>{children}</div>;
  if (t.dark) {
    return (
      <div style={fill}>
        <Scrim strength={0.42} />
        {children}
      </div>
    );
  }
  return (
    <div style={fill}>
      <div style={{ ...fill, ...card(t, 56), opacity: prog(ctx.frame, 0, sec(ctx, 0.3)) }} />
      {children}
    </div>
  );
}

function Keynote({ ctx }: { ctx: GCtx }) {
  const t = toneOf(ctx);
  const k = keyInk(t);
  const { props } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const shadow = ctx.props.screen !== "FULL" && t.dark ? `0 4px 30px ${rgba("#000000", 0.45)}` : undefined;
  const gradFace = (size: number): CSSProperties => ({
    backgroundImage: t.dark ? `linear-gradient(180deg, #FFFFFF 20%, ${mix("#FFFFFF", ctx.p.primary, 0.55)} 100%)` : `linear-gradient(180deg, #0B0B0E 30%, ${mix("#0B0B0E", t.accent, 0.7)} 100%)`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
    WebkitTextFillColor: "transparent",
    padding: `0 ${Math.round(size * 0.04)}px`,
  });
  switch (ctx.variant) {
    case "TITLE": {
      const words = splitWords(props.title || "Less, but better.");
      const fitS = (() => {
        for (let s = 150; s >= 84; s -= 6) {
          const n = wrap(words.join(" "), s, 940, 99, 1).length;
          if (n <= 3) return s;
        }
        return 84;
      })();
      const lines = wrap(words.join(" "), fitS, 940, 3, 1);
      const seq = listSequence(words.length, { ...ctx.anim, stagger: Math.min(0.09, Math.max(0.05, ctx.anim.stagger)) }, seqOpts(ctx, sec(ctx, 0.2)));
      let wi = 0;
      const top = 50;
      return (
        <KeyStage ctx={ctx} t={t}>
          <div style={{ position: "absolute", left: 30, right: 30, top, display: "flex", flexDirection: "column", alignItems: "center", textShadow: shadow }}>
            {lines.map((ln, li) => (
              <div key={li} style={{ display: "flex", columnGap: fitS * 0.26, height: fitS * 1.06, alignItems: "center", fontFamily: FONT.display, fontSize: fitS, letterSpacing: "-0.035em", color: k.ink, whiteSpace: "nowrap", lineHeight: 1.06 }}>
                {ln.split(" ").map((w) => {
                  const i = wi++;
                  return (
                    <Word key={i} ctx={ctx} start={seq.at(0, Math.min(i, words.length - 1))} len={seq.len} size={fitS} face={{}}>
                      {w}
                    </Word>
                  );
                })}
              </div>
            ))}
          </div>
          {props.subtitle ? <div style={{ position: "absolute", left: 40, right: 40, top: top + lines.length * fitS * 1.06 + 30, textAlign: "center", ...txt(40, k.muted), textShadow: shadow, ...riseStyle(ctx, seq.done, 10, sec(ctx, 0.6)) }}>{ell(props.subtitle, 40, W - 80)}</div> : null}
        </KeyStage>
      );
    }
    case "SPECS": {
      const items = props.items.length ? props.items : ([{ text: "", value: 0 }] as GraphicItem[]);
      const n = items.length;
      const colW = (W - 40) / n;
      const head = props.title ? (props.subtitle ? 150 : 104) : 0;
      const seq = listSequence(n, { ...ctx.anim, stagger: Math.max(0.14, ctx.anim.stagger) }, seqOpts(ctx, sec(ctx, head ? 0.35 : 0.15)));
      const plan = sharedPlan(ctx, items.map((i) => i.value ?? 0));
      const finals = items.map((it) => fmtValue(ctx, it.value ?? 0, it.value ?? 0, plan).text);
      const vSize = Math.min(130, ...finals.map((f) => Math.floor(((colW - 40) / Math.max(1, textW(f, 130, 1))) * 130)));
      return (
        <KeyStage ctx={ctx} t={t}>
          {props.title ? <div style={{ position: "absolute", left: 30, right: 30, top: 10, textAlign: "center", ...bold(56, k.ink), letterSpacing: "-0.025em", textShadow: shadow, ...riseStyle(ctx, 0, 12) }}>{ell(props.title, 56, W - 60, 1)}</div> : null}
          {props.title && props.subtitle ? <div style={{ position: "absolute", left: 30, right: 30, top: 82, textAlign: "center", ...txt(34, k.muted), textShadow: shadow, ...riseStyle(ctx, sec(ctx, 0.08), 10) }}>{ell(props.subtitle, 34, W - 60)}</div> : null}
          {items.map((it, i) => {
            const at = seq.at(0, i);
            const v = counted(ctx, at, it.value ?? 0, 0, 2);
            const label = wrap(it.text, 34, colW - 30, 2);
            return (
              <div key={i} style={{ position: "absolute", left: 20 + i * colW, top: head + 40, width: colW, height: 260, display: "flex", flexDirection: "column", alignItems: "center", ...css(seqStyle(ctx, seq, 0, i, { distance: 0.7 })) }}>
                {i > 0 ? <div style={{ position: "absolute", left: 0, top: 20, width: 1.5, height: 220 * prog(ctx.frame, at, sec(ctx, 0.5), ctx.ease), background: t.dark ? rgba("#FFFFFF", 0.18) : rgba("#000000", 0.14) }} /> : null}
                <div style={{ fontFamily: FONT.display, fontSize: vSize, lineHeight: 1.1, letterSpacing: "-0.035em", whiteSpace: "nowrap", ...TAB, ...gradFace(vSize), filter: shadow ? `drop-shadow(${shadow})` : undefined }}>{fmtValue(ctx, v, it.value ?? 0, plan).text}</div>
                {label.map((l, li) => (
                  <div key={li} style={{ ...txt(34, k.muted, { lineHeight: "44px" }), textShadow: shadow, marginTop: li ? 0 : 8 }}>
                    {l}
                  </div>
                ))}
              </div>
            );
          })}
        </KeyStage>
      );
    }
    case "REVEAL": {
      const word = props.title || "Freedom.";
      const size = Math.min(260, Math.floor((940 / Math.max(1, textW(word, 260, 1))) * 260));
      const inT = prog(ctx.frame, 0, sec(ctx, 0.8), ctx.ease);
      const sw0 = sec(ctx, 0.35);
      const swLen = Math.max(6, Math.min(sec(ctx, 1.3), buildBudget(ctx, 1) - sw0));
      const sw = prog(ctx.frame, sw0, swLen, (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2));
      const base = t.dark ? "#3A3A44" : "#C9C9D1";
      const band = t.dark ? mix("#FFFFFF", ctx.p.primary, 0.25) : t.accent;
      const pos = 100 - sw * 100;
      const glow = Math.sin(sw * Math.PI);
      const wordTop = (H - size * 1.1 - (props.subtitle ? 80 : 0)) / 2;
      return (
        <KeyStage ctx={ctx} t={t}>
          <div style={{ position: "absolute", left: 0, right: 0, top: wordTop, height: size * 1.1, display: "flex", justifyContent: "center", alignItems: "center", opacity: inT, transform: `scale(${r4(1.05 - 0.05 * inT)})` }}>
            <div style={{ fontFamily: FONT.display, fontSize: size, lineHeight: 1.1, letterSpacing: "-0.04em", whiteSpace: "nowrap", backgroundImage: `linear-gradient(100deg, ${k.ink} 0%, ${k.ink} 40%, ${band} 47%, ${band} 50%, ${base} 57%, ${base} 100%)`, backgroundSize: "300% 100%", backgroundPosition: `${r1(pos)}% 0%`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", WebkitTextFillColor: "transparent", padding: "0 0.05em", filter: `drop-shadow(0 0 ${r1(30 * glow)}px ${rgba(band, 0.45 * glow)})${shadow ? ` drop-shadow(${shadow})` : ""}` }}>{word}</div>
          </div>
          {props.subtitle ? <div style={{ position: "absolute", left: 40, right: 40, top: wordTop + size * 1.1 + 24, textAlign: "center", ...txt(40, k.muted), textShadow: shadow, ...riseStyle(ctx, sw0 + Math.round(swLen * 0.7), 10, sec(ctx, 0.6)) }}>{ell(props.subtitle, 40, W - 80)}</div> : null}
        </KeyStage>
      );
    }
    default: {
      // NUMBER
      const final = props.items[0]?.value ?? 0;
      const t0 = sec(ctx, 0.3);
      const v = counted(ctx, t0, final, 0, 2.6);
      const finalText = fmtValue(ctx, final, final).text;
      const size = Math.min(300, Math.floor((900 / Math.max(1, textW(finalText, 300, 1))) * 300));
      const hasSub = !!props.subtitle;
      const numTop = hasSub ? 110 : 50;
      const inT = prog(ctx.frame, t0 - sec(ctx, 0.1), sec(ctx, 0.7), ctx.ease);
      return (
        <KeyStage ctx={ctx} t={t}>
          {hasSub ? <div style={{ position: "absolute", left: 40, right: 40, top: 40, textAlign: "center", ...txt(40, t.dark ? mix("#FFFFFF", ctx.p.primary, 0.6) : t.accent), textShadow: shadow, ...riseStyle(ctx, 0, 10) }}>{ell(props.subtitle!, 40, W - 80)}</div> : null}
          <div style={{ position: "absolute", left: 0, right: 0, top: numTop, height: 330, display: "flex", justifyContent: "center", alignItems: "center", opacity: inT, transform: `scale(${r4(0.94 + 0.06 * inT)})`, filter: inT < 1 ? `blur(${r1((1 - inT) * 12)}px)` : undefined }}>
            <div style={{ fontFamily: FONT.display, fontSize: size, lineHeight: 1.1, letterSpacing: "-0.045em", whiteSpace: "nowrap", ...TAB, ...gradFace(size), filter: shadow ? `drop-shadow(${shadow})` : undefined }}>{fmtValue(ctx, v, final).text}</div>
          </div>
          {props.title ? <div style={{ position: "absolute", left: 40, right: 40, top: numTop + 340, textAlign: "center", ...txt(46, k.muted), textShadow: shadow, ...riseStyle(ctx, t0 + sec(ctx, 0.4), 12, sec(ctx, 0.6)) }}>{ell(props.title, 46, W - 80)}</div> : null}
        </KeyStage>
      );
    }
  }
}

// ===================================================================== registry

export const PHONE_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {
  DM_CHAT: DmChat,
  NOTIFICATION: Notification,
  CALL: Call,
  PHONE_APP: PhoneApp,
  CLOCK_TIMER: ClockTimer,
  STATUS_ALERT: StatusAlert,
  APP_GRID: AppGrid,
  KEYNOTE: Keynote,
};
