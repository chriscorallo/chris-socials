import { useId, type CSSProperties } from "react";
import { EASE_IN_OUT, EASE_OUT, SPRINGS, clamp01, countUp, prog, springAt } from "../motion";
import { FONT, TEXT_LIFT, formatNumber, glassCard, mix, rgba } from "../theme";
import type { TemplateComponentProps } from "./types";
import { hitBuildLength, kineticWordDelays } from "./hit-timing";

const fill: CSSProperties = { position: "absolute", inset: 0 };

/** Gold-leaf style gradient fill for hero numbers / emphasis. */
export function heroGradient(primary: string): string {
  return `linear-gradient(180deg, ${mix(primary, "#FFFFFF", 0.62)} 0%, ${primary} 52%, ${mix(primary, "#7A4E00", 0.28)} 100%)`;
}

export function gradientText(primary: string): CSSProperties {
  return {
    backgroundImage: heroGradient(primary),
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
    WebkitTextFillColor: "transparent",
  };
}

/**
 * Soft dark falloff behind bare (card-less) type so it holds up over bright footage, invisible
 * as a shape: a blurred radial ellipse, ~30% at the centre, gone at the edges.
 */
export function Scrim({ strength = 0.3 }: { strength?: number }) {
  return <div style={{ position: "absolute", inset: "-6% -4%", background: `radial-gradient(ellipse 50% 50% at 50% 50%, ${rgba("#08080C", strength)} 0%, ${rgba("#08080C", strength * 0.55)} 45%, transparent 75%)`, filter: "blur(18px)" }} />;
}

function cleanWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}%$]/gu, "");
}

// ---------------------------------------------------------------- KINETIC_TEXT
export function KineticText({ props, palette: p, frame, fps, durationInFrames, exitFrames, hitAtFrame }: TemplateComponentProps<"KINETIC_TEXT">) {
  const words = props.text.split(/\s+/).filter(Boolean);
  const emph = new Set(props.emphasis.map(cleanWord));
  const chars = props.text.length;
  const size = chars <= 18 ? 120 : chars <= 34 ? 96 : chars <= 60 ? 80 : chars <= 90 ? 66 : 56;
  // Build over at most ~45% of the visual (and never slower than a natural read).
  const stagger = Math.max(2, Math.min(5, Math.floor((durationInFrames * 0.45) / Math.max(1, words.length))));
  // Motion v2 timing hook: the key word (first emphasised, else the last) lands on the speaker's emphasis.
  const firstEmph = words.findIndex((w) => emph.has(cleanWord(w)));
  const keyIndex = firstEmph >= 0 ? firstEmph : words.length - 1;
  const delays = kineticWordDelays(words.length, keyIndex, stagger, hitAtFrame, fps, durationInFrames, exitFrames);

  if (props.style === "TYPEWRITER") {
    const perChar = Math.max(0.6, Math.min(2.2, (durationInFrames * 0.5) / Math.max(1, chars)));
    const shown = Math.min(chars, Math.floor(frame / perChar));
    let idx = 0;
    const caretOn = Math.floor(frame / (fps * 0.5)) % 2 === 0 || shown < chars;
    return (
      <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Scrim />
        <div style={{ fontFamily: FONT.display, fontSize: size, lineHeight: 1.08, letterSpacing: "-0.02em", color: p.ink, textAlign: "center", textShadow: TEXT_LIFT, maxWidth: 880 }}>
          {words.map((w, i) => {
            const start = idx;
            idx += w.length + 1;
            const visible = w.slice(0, Math.max(0, Math.min(w.length, shown - start)));
            const isE = emph.has(cleanWord(w));
            return (
              <span key={i} style={{ whiteSpace: "nowrap" }}>
                <span style={{ color: isE ? p.primary : p.ink }}>{visible}</span>
                <span style={{ opacity: 0 }}>{w.slice(visible.length)}</span>
                {i < words.length - 1 ? " " : ""}
              </span>
            );
          })}
          <span style={{ display: "inline-block", width: size * 0.07, height: size * 0.9, marginLeft: size * 0.06, verticalAlign: "-0.1em", background: p.primary, opacity: caretOn ? 1 : 0, borderRadius: 4, boxShadow: `0 0 18px ${rgba(p.primary, 0.6)}` }} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Scrim />
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "baseline", columnGap: size * 0.26, rowGap: size * 0.06, maxWidth: 880, fontFamily: FONT.display, fontSize: size, lineHeight: 1.06, letterSpacing: "-0.025em" }}>
        {words.map((w, i) => {
          const isE = emph.has(cleanWord(w));
          const d = delays[i]!;
          if (props.style === "SLIDE_UP") {
            const t = prog(frame, d, Math.round(fps * 0.5), EASE_OUT);
            return (
              <span key={i} style={{ display: "inline-block", overflow: "hidden", paddingBottom: size * 0.12, marginBottom: -size * 0.12 }}>
                <span style={{ display: "inline-block", transform: `translateY(${(1 - t) * 105}%)`, color: isE ? p.primary : p.ink, textShadow: isE ? `0 0 30px ${rgba(p.primary, 0.45)}, ${TEXT_LIFT}` : TEXT_LIFT }}>{w}</span>
              </span>
            );
          }
          // PUNCH
          const s = springAt(frame, fps, d, SPRINGS.punch);
          const o = prog(frame, d, 5, EASE_OUT);
          const scale = (isE ? 1.5 : 1.28) - (isE ? 0.5 : 0.28) * s;
          const blur = Math.max(0, 1 - s) * 12;
          const underline = isE ? prog(frame, d + 6, 12, EASE_OUT) : 0;
          return (
            <span key={i} style={{ position: "relative", display: "inline-block", opacity: o, transform: `translateY(${(1 - s) * 26}px) scale(${scale})`, filter: blur > 0.1 ? `blur(${blur}px)` : undefined, transformOrigin: "50% 70%" }}>
              {isE ? (
                <>
                  <span style={{ ...gradientText(p.primary), filter: `drop-shadow(0 0 22px ${rgba(p.primary, 0.42)}) drop-shadow(0 6px 18px ${rgba("#000000", 0.55)})` }}>{w}</span>
                  <span style={{ position: "absolute", left: "4%", right: "4%", bottom: -size * 0.08, height: Math.max(6, size * 0.075), borderRadius: 99, background: `linear-gradient(90deg, ${p.primary}, ${rgba(p.primary, 0.2)})`, transform: `scaleX(${underline})`, transformOrigin: "left", boxShadow: `0 0 18px ${rgba(p.primary, 0.5)}` }} />
                </>
              ) : (
                <span style={{ color: p.ink, textShadow: TEXT_LIFT }}>{w}</span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- NUMBER_COUNTER
export function NumberCounter({ props, palette: p, frame, fps, durationInFrames, exitFrames, hitAtFrame }: TemplateComponentProps<"NUMBER_COUNTER">) {
  // Motion v2 timing hook: the count lands on the speaker's emphasis when there is one.
  const countLen = hitBuildLength(Math.min(Math.round(fps * 1.5), Math.round(durationInFrames * 0.5)), 3, hitAtFrame, fps, durationInFrames, exitFrames);
  const v = countUp(frame, props.from, props.value, 3, countLen);
  const finalText = `${props.prefix}${formatNumber(props.value, props.decimals)}${props.suffix}`;
  const text = `${props.prefix}${formatNumber(v, props.decimals)}${props.suffix}`;
  const L = finalText.length;
  const size = L <= 4 ? 176 : L <= 6 ? 160 : L <= 8 ? 136 : L <= 10 ? 114 : 96;
  const land = 3 + countLen;
  const pulse = 1 + 0.035 * Math.sin(Math.PI * prog(frame, land - 2, 10, EASE_IN_OUT));
  const labelT = prog(frame, Math.round(land * 0.55), 18, EASE_OUT);
  const lineT = prog(frame, Math.round(land * 0.45), 22, EASE_OUT);
  const breathe = 0.85 + 0.15 * Math.sin((frame / fps) * 2.2);
  return (
    <div style={{ ...fill, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <Scrim strength={0.32} />
      <div style={{ position: "absolute", left: "50%", top: "44%", width: 680, height: 300, transform: "translate(-50%,-50%)", background: `radial-gradient(ellipse at center, ${rgba(p.primary, 0.22 * breathe)} 0%, ${rgba(p.primary, 0.07)} 42%, transparent 70%)`, filter: "blur(10px)" }} />
      <div style={{ position: "relative", fontFamily: FONT.display, fontSize: size, lineHeight: 1, letterSpacing: "-0.035em", fontVariantNumeric: "tabular-nums", transform: `scale(${pulse})`, whiteSpace: "nowrap" }}>
        {/* invisible final value reserves the width so the layout never jitters while counting */}
        <span style={{ visibility: "hidden" }}>{finalText}</span>
        <span style={{ position: "absolute", inset: 0, textAlign: "center", ...gradientText(p.primary), filter: `drop-shadow(0 0 26px ${rgba(p.primary, 0.45)}) drop-shadow(0 10px 26px ${rgba("#000000", 0.5)})` }}>{text}</span>
      </div>
      <div style={{ width: 140, height: 5, borderRadius: 9, marginTop: 16, background: `linear-gradient(90deg, transparent, ${p.primary}, transparent)`, transform: `scaleX(${lineT})`, opacity: lineT }} />
      {props.label ? (
        <div style={{ marginTop: 16, fontFamily: FONT.text, fontSize: 38, letterSpacing: "0.12em", textTransform: "uppercase", color: p.ink, opacity: labelT * 0.92, transform: `translateY(${(1 - labelT) * 18}px)`, textShadow: TEXT_LIFT, textAlign: "center", maxWidth: 740 }}>
          {props.label}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- STAT_CARD
function TrendArrow({ up, color, size }: { up: boolean; color: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: up ? undefined : "rotate(180deg)" }}>
      <path d="M12 4 L20 13 H14.5 V20 H9.5 V13 H4 Z" fill={color} />
    </svg>
  );
}

export function StatCard({ props, palette: p, frame, fps }: TemplateComponentProps<"STAT_CARD">) {
  const valT = springAt(frame, fps, 6, SPRINGS.settle);
  const labelT = prog(frame, 2, 16, EASE_OUT);
  const subT = prog(frame, 14, 16, EASE_OUT);
  const barT = prog(frame, 0, 22, EASE_OUT);
  const chipT = springAt(frame, fps, 16, SPRINGS.soft);
  const sheen = prog(frame, 12, 34, EASE_IN_OUT);
  const tColor = props.trend === "UP" ? p.positive : props.trend === "DOWN" ? p.negative : p.muted;
  const L = props.value.length;
  const size = L <= 4 ? 150 : L <= 7 ? 124 : L <= 10 ? 100 : 80;
  return (
    <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", width: 720, minHeight: 360, padding: "46px 52px 46px 66px", boxSizing: "border-box", overflow: "hidden", ...glassCard(p) }}>
        <div style={{ position: "absolute", left: 0, top: 46, bottom: 46, width: 8, borderRadius: "0 8px 8px 0", background: `linear-gradient(180deg, ${p.primary}, ${p.secondary})`, transform: `scaleY(${barT})`, transformOrigin: "top", boxShadow: `0 0 24px ${rgba(p.primary, 0.5)}` }} />
        <div style={{ position: "absolute", top: -200, bottom: -200, width: 180, left: -260 + sheen * 1400, transform: "rotate(18deg)", background: `linear-gradient(90deg, transparent, ${rgba("#FFFFFF", 0.09)}, transparent)` }} />
        <div style={{ fontFamily: FONT.text, fontSize: 36, letterSpacing: "0.1em", textTransform: "uppercase", color: p.muted, opacity: labelT, transform: `translateY(${(1 - labelT) * 14}px)` }}>{props.label}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 30, marginTop: 14 }}>
          <div style={{ fontFamily: FONT.display, fontSize: size, lineHeight: 1.02, letterSpacing: "-0.035em", ...gradientText(p.primary), filter: `drop-shadow(0 0 24px ${rgba(p.primary, 0.35)})`, opacity: clamp01(valT * 1.4), transform: `translateY(${(1 - valT) * 40}px)`, whiteSpace: "nowrap" }}>{props.value}</div>
          {props.trend !== "NONE" ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 84, height: 84, borderRadius: 999, background: rgba(tColor, 0.16), boxShadow: `inset 0 0 0 2px ${rgba(tColor, 0.4)}, 0 0 30px ${rgba(tColor, 0.25)}`, transform: `scale(${chipT})`, opacity: clamp01(chipT) }}>
              <TrendArrow up={props.trend === "UP"} color={tColor} size={46} />
            </div>
          ) : null}
        </div>
        {props.sublabel ? (
          <div style={{ marginTop: 14, fontFamily: FONT.text, fontSize: 34, color: rgba(p.muted, 0.9), opacity: subT, transform: `translateY(${(1 - subT) * 12}px)` }}>{props.sublabel}</div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- DEFINITION
export function Definition({ props, palette: p, frame }: TemplateComponentProps<"DEFINITION">) {
  const over = prog(frame, 2, 14, EASE_OUT);
  const termT = prog(frame, 5, 20, EASE_OUT);
  const rule = prog(frame, 12, 26, EASE_OUT);
  const words = props.definition.split(/\s+/);
  const tSize = props.term.length <= 14 ? 88 : props.term.length <= 24 ? 74 : 60;
  return (
    <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", width: 880, padding: "44px 56px 48px", boxSizing: "border-box", ...glassCard(p) }}>
        <div style={{ fontFamily: FONT.text, fontSize: 34, letterSpacing: "0.28em", color: p.primary, opacity: over, textTransform: "uppercase" }}>Definition</div>
        <div style={{ marginTop: 10, fontFamily: FONT.serif, fontSize: tSize, lineHeight: 1.04, color: p.ink, opacity: termT, transform: `translateY(${(1 - termT) * 20}px)`, letterSpacing: "-0.01em" }}>{props.term}</div>
        <div style={{ height: 3, marginTop: 22, marginBottom: 22, borderRadius: 3, background: `linear-gradient(90deg, ${p.primary}, ${rgba(p.primary, 0.25)} 55%, transparent)`, transform: `scaleX(${rule})`, transformOrigin: "left" }} />
        <div style={{ fontFamily: FONT.text, fontSize: 38, lineHeight: 1.32, color: rgba("#ECECF2", 1) }}>
          {words.map((w, i) => {
            const t = prog(frame, 18 + i * 1.2, 10, EASE_OUT);
            return (
              <span key={i} style={{ opacity: 0.15 + 0.85 * t }}>
                {w}
                {i < words.length - 1 ? " " : ""}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- TITLE_CARD
export function TitleCard({ props, palette: p, frame, durationInFrames, canvas }: TemplateComponentProps<"TITLE_CARD">) {
  const u = Math.min(canvas.width, canvas.height) / 1080;
  const dim = prog(frame, 0, 16, EASE_IN_OUT);
  const bars = prog(frame, 0, 22, EASE_OUT);
  const titleT = prog(frame, 6, 30, EASE_OUT);
  const subT = prog(frame, 16, 22, EASE_OUT);
  const lines = prog(frame, 20, 26, EASE_OUT);
  const sweep = prog(frame, 18, 40, EASE_IN_OUT);
  const drift = 1 + 0.025 * (frame / Math.max(1, durationInFrames));
  const L = props.title.length;
  const size = (L <= 14 ? 132 : L <= 24 ? 108 : L <= 40 ? 88 : 72) * u;
  const barH = canvas.height * 0.085 * bars;
  return (
    <div style={{ ...fill, width: canvas.width, height: canvas.height }}>
      <div style={{ ...fill, opacity: dim, background: `radial-gradient(ellipse 80% 55% at 50% 50%, ${rgba("#05050A", 0.5)} 0%, ${rgba("#05050A", 0.8)} 70%, ${rgba("#05050A", 0.9)} 100%)` }} />
      <div style={{ ...fill, opacity: dim * 0.5, background: `radial-gradient(ellipse 60% 30% at 50% 48%, ${rgba(p.secondary, 0.16)} 0%, transparent 70%)` }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: barH, background: "#000" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: barH, background: "#000" }} />
      <div style={{ ...fill, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", transform: `scale(${drift})` }}>
        {props.subtitle ? (
          <div style={{ display: "flex", alignItems: "center", gap: 26 * u, marginBottom: 34 * u, opacity: subT }}>
            <div style={{ width: 90 * u * lines, height: 2 * u, background: `linear-gradient(90deg, transparent, ${p.primary})` }} />
            <div style={{ fontFamily: FONT.text, fontSize: 36 * u, letterSpacing: "0.34em", textTransform: "uppercase", color: p.primary, paddingLeft: "0.34em" }}>{props.subtitle}</div>
            <div style={{ width: 90 * u * lines, height: 2 * u, background: `linear-gradient(90deg, ${p.primary}, transparent)` }} />
          </div>
        ) : null}
        <div style={{ position: "relative", maxWidth: canvas.width * 0.86, textAlign: "center", fontFamily: FONT.serif, fontSize: size, lineHeight: 1.06, color: p.ink, letterSpacing: `${0.1 * (1 - titleT)}em`, opacity: titleT, filter: titleT < 0.99 ? `blur(${(1 - titleT) * 14}px)` : undefined, textShadow: `0 10px 40px ${rgba("#000000", 0.6)}` }}>
          {props.title}
          <span aria-hidden style={{ position: "absolute", inset: 0, backgroundImage: `linear-gradient(105deg, transparent ${sweep * 140 - 30}%, ${rgba("#FFFFFF", 0.95)} ${sweep * 140 - 15}%, transparent ${sweep * 140}%)`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", WebkitTextFillColor: "transparent", opacity: 0.55 * (1 - Math.abs(sweep - 0.5) * 2) }}>{props.title}</span>
        </div>
        <div style={{ marginTop: 40 * u, width: 220 * u, height: 3 * u, borderRadius: 3, background: `linear-gradient(90deg, transparent, ${p.primary}, transparent)`, transform: `scaleX(${lines})`, boxShadow: `0 0 18px ${rgba(p.primary, 0.6)}` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- CALLOUT
/** Label pill in the box; the leader line + target are drawn in CANVAS space by CalloutLeader. */
export function Callout({ props, palette: p, frame, fps }: TemplateComponentProps<"CALLOUT">) {
  const s = springAt(frame, fps, 0, SPRINGS.soft);
  const dot = 0.6 + 0.4 * Math.sin(frame / 5);
  return (
    <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18, maxWidth: 520, boxSizing: "border-box", padding: "22px 34px 22px 26px", borderRadius: 48, ...glassCard(p, 48), transform: `scale(${0.9 + 0.1 * s})` }}>
        <div style={{ flex: "none", width: 20, height: 20, borderRadius: 99, background: p.primary, boxShadow: `0 0 ${16 + 10 * dot}px ${rgba(p.primary, 0.8)}` }} />
        <div style={{ fontFamily: FONT.displayBold, fontSize: props.text.length > 22 ? 36 : 42, lineHeight: 1.15, color: p.ink, letterSpacing: "-0.01em" }}>{props.text}</div>
      </div>
    </div>
  );
}

export function CalloutLeader({ props, palette: p, frame, fps, box, canvas, durationInFrames, exitFrames }: TemplateComponentProps<"CALLOUT">) {
  const tx = props.pointTo.x * canvas.width;
  const ty = props.pointTo.y * canvas.height;
  // Start from the pill edge facing the target (pill ~ box center; approximate radius).
  const dx = tx - box.cx;
  const dy = ty - box.cy;
  const len = Math.hypot(dx, dy) || 1;
  const halfW = (box.width / 2) * 0.82;
  const halfH = (box.height / 2) * 0.6;
  const k = Math.min(halfW / Math.max(1e-6, Math.abs(dx)), halfH / Math.max(1e-6, Math.abs(dy)));
  const sx = box.cx + dx * Math.min(1, k);
  const sy = box.cy + dy * Math.min(1, k);
  // Gentle curve: control point offset perpendicular.
  const mx = (sx + tx) / 2 - (dy / len) * 60 * box.scale;
  const my = (sy + ty) / 2 + (dx / len) * 60 * box.scale;
  const draw = prog(frame, 6, 18, EASE_OUT);
  const tgt = springAt(frame, fps, 18, SPRINGS.soft);
  const ringT = ((frame - 22) % Math.round(fps * 1.2)) / Math.round(fps * 1.2);
  const exitStart = durationInFrames - exitFrames;
  const out = 1 - prog(frame, exitStart, exitFrames, EASE_OUT);
  const sw = 5 * box.scale;
  const gid = `cl-glow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg width={canvas.width} height={canvas.height} style={{ position: "absolute", inset: 0, opacity: out, overflow: "visible" }}>
      <defs>
        <filter id={gid} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={6 * box.scale} />
        </filter>
      </defs>
      <path d={`M ${sx} ${sy} Q ${mx} ${my} ${tx} ${ty}`} pathLength={1} fill="none" stroke={rgba("#000000", 0.45)} strokeWidth={sw + 6} strokeLinecap="round" strokeDasharray="1 1" strokeDashoffset={1 - draw} filter={`url(#${gid})`} />
      <path d={`M ${sx} ${sy} Q ${mx} ${my} ${tx} ${ty}`} pathLength={1} fill="none" stroke={p.primary} strokeWidth={sw} strokeLinecap="round" strokeDasharray="1 1" strokeDashoffset={1 - draw} />
      {frame > 22 ? <circle cx={tx} cy={ty} r={(18 + 40 * ringT) * box.scale} fill="none" stroke={p.primary} strokeWidth={3 * box.scale} opacity={(1 - ringT) * 0.8} /> : null}
      <circle cx={tx} cy={ty} r={14 * box.scale * tgt} fill={p.primary} />
      <circle cx={tx} cy={ty} r={14 * box.scale * tgt} fill={p.primary} filter={`url(#${gid})`} opacity={0.8} />
    </svg>
  );
}
