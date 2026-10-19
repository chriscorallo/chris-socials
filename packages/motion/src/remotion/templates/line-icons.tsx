import { useId, type CSSProperties } from "react";
import { EASE_IN_OUT, clamp01, countUp, feelEase, prog, springAt } from "../motion";
import { FONT, TEXT_LIFT, formatNumber, glassCard, mix, rgba } from "../theme";
import { gradientText } from "./text";
import { feelOf, type TemplateComponentProps } from "./types";
import { stackCountFor } from "../../timing";

/**
 * LINE icon style: the ICON_3D objects and MONEY_STACK_3D drawn as 2D line art (64-unit grid,
 * round caps) on a frosted glass disc, drawing themselves stroke by stroke. Same footprints
 * and caption/amount typography as the 3D versions, so placement is unchanged.
 */

const fill: CSSProperties = { position: "absolute", inset: 0 };

type Stroke = { d: string; accent?: boolean };

/** Hand-drawn 64x64 line icons (original geometry). Accent strokes use the secondary color. */
export const LINE_ICON_PATHS: Record<string, Stroke[]> = {
  COIN: [
    { d: "M32 8a24 24 0 1 1 0 48a24 24 0 1 1 0-48z" },
    { d: "M32 14a18 18 0 1 1 0 36a18 18 0 1 1 0-36z", accent: true },
    { d: "M38.5 25.5c-1.4-2.1-3.7-3.3-6.5-3.3c-3.6 0-6.2 1.9-6.2 4.6c0 2.9 2.6 3.9 6.2 4.7c3.7 0.8 6.4 2 6.4 5c0 2.8-2.7 4.8-6.4 4.8c-2.9 0-5.3-1.2-6.7-3.4" },
    { d: "M32 18.5v3.7M32 41.3v4.2" },
  ],
  CREDIT_CARD: [
    { d: "M13 16h38a5 5 0 0 1 5 5v22a5 5 0 0 1-5 5H13a5 5 0 0 1-5-5V21a5 5 0 0 1 5-5z" },
    { d: "M8 25h48" },
    { d: "M15.5 32h9a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-9a1.5 1.5 0 0 1-1.5-1.5v-5a1.5 1.5 0 0 1 1.5-1.5z", accent: true },
    { d: "M33 41h7M44 41h5" },
  ],
  HOUSE: [
    { d: "M9 31L32 12l23 19" },
    { d: "M16 26v26h32V26" },
    { d: "M27 52V40h10v12", accent: true },
    { d: "M42 15v6" },
  ],
  PIGGY_BANK: [
    { d: "M15 35c0-9.4 8.1-15.5 18.6-15.5c8.2 0 14.4 3.5 17.4 8.6l5-1v9.3l-4.3 1.8c-1 3.6-3.6 6.6-7.2 8.3V52h-6.2v-4h-9.6v4h-6.2v-6.8C17.6 42.9 15 39.3 15 35z" },
    { d: "M28 23.5h8" },
    { d: "M44.5 31.5h0.1" },
    { d: "M32 4.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 1 1 0-9z", accent: true },
  ],
  CHART_UP: [
    { d: "M10 10v44h46" },
    { d: "M18 46v-6M28 46v-12M38 46v-9M48 46v-18" },
    { d: "M16 36l11-11l8 6l15-15", accent: true },
    { d: "M42 16h8v8", accent: true },
  ],
  CALENDAR: [
    { d: "M15 14h34a5 5 0 0 1 5 5v30a5 5 0 0 1-5 5H15a5 5 0 0 1-5-5V19a5 5 0 0 1 5-5z" },
    { d: "M10 25h44" },
    { d: "M22 9v9M42 9v9" },
    { d: "M18 33h4M30 33h4M42 33h4M18 43h4M42 43h4" },
    { d: "M29 40h6v6h-6z", accent: true },
  ],
  LOCK: [
    { d: "M19 28h26a5 5 0 0 1 5 5v16a5 5 0 0 1-5 5H19a5 5 0 0 1-5-5V33a5 5 0 0 1 5-5z" },
    { d: "M22 28v-7a10 10 0 0 1 20 0v7" },
    { d: "M32 36.5a3 3 0 1 1 0 6a3 3 0 1 1 0-6zM32 42.5v4", accent: true },
  ],
  PHONE: [
    { d: "M25 8h14a5 5 0 0 1 5 5v38a5 5 0 0 1-5 5H25a5 5 0 0 1-5-5V13a5 5 0 0 1 5-5z" },
    { d: "M29 13h6" },
    { d: "M25 40l5-6l4 3l6-8", accent: true },
    { d: "M30 50h4" },
  ],
  BRIEFCASE: [
    { d: "M14 22h36a4 4 0 0 1 4 4v22a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V26a4 4 0 0 1 4-4z" },
    { d: "M25 22v-5a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v5" },
    { d: "M10 34h18M36 34h18" },
    { d: "M29 31h6v6h-6z", accent: true },
  ],
  GRADUATION_CAP: [
    { d: "M6 26L32 14l26 12L32 38z" },
    { d: "M16 31v11c0 4 7 7.5 16 7.5s16-3.5 16-7.5V31" },
    { d: "M58 26v14", accent: true },
    { d: "M58 41.5a1.8 1.8 0 1 1 0 3.6a1.8 1.8 0 1 1 0-3.6z", accent: true },
  ],
  TROPHY: [
    { d: "M20 10h24v14c0 7.2-5.4 13-12 13s-12-5.8-12-13z" },
    { d: "M20 15h-6c0 6 3 10 7.5 11M44 15h6c0 6-3 10-7.5 11" },
    { d: "M32 37v8M24 54h16M27 54l1.5-9h7l1.5 9" },
    { d: "M32 16.5l1.9 3.9l4.3 0.6l-3.1 3l0.7 4.2l-3.8-2l-3.8 2l0.7-4.2l-3.1-3l4.3-0.6z", accent: true },
  ],
  ROCKET: [
    { d: "M32 6c7 5.5 10 13 10 22v14H22V28c0-9 3-16.5 10-22z" },
    { d: "M22 32l-7 7v6l7-3M42 32l7 7v6l-7-3" },
    { d: "M32 20.5a4 4 0 1 1 0 8a4 4 0 1 1 0-8z" },
    { d: "M27 46c0 5 2 8 5 12c3-4 5-7 5-12", accent: true },
  ],
  LIGHTBULB: [
    { d: "M24.5 41c0-4-6.5-7.5-6.5-15.5a14 14 0 0 1 28 0c0 8-6.5 11.5-6.5 15.5z" },
    { d: "M25 46h14M26.5 51h11M29 56h6" },
    { d: "M28 34l2-8l2 4l2-4l2 8", accent: true },
    { d: "M32 3v3M12 11l2.2 2.2M52 11l-2.2 2.2M6 25.5h3M55 25.5h3", accent: true },
  ],
  BRAIN: [
    { d: "M31 12c-2.5-3-8-3-10.5 0.5c-4.5-0.5-8 3.5-7 8c-4 2-5 7.5-2 11c-2.5 4 0 9.5 4.5 10c1 4.5 6 7 10 5c2 2 5 2.5 5 2.5z" },
    { d: "M33 12c2.5-3 8-3 10.5 0.5c4.5-0.5 8 3.5 7 8c4 2 5 7.5 2 11c2.5 4 0 9.5-4.5 10c-1 4.5-6 7-10 5c-2 2-5 2.5-5 2.5z" },
    { d: "M32 12v37" },
    { d: "M20 22c3 0 5 2 5 5M17 34c3-1 6 0 7 3M44 22c-3 0-5 2-5 5M47 34c-3-1-6 0-7 3", accent: true },
  ],
  GIFT: [
    { d: "M12 26h40v8H12z" },
    { d: "M15 34v20h34V34" },
    { d: "M32 26v28" },
    { d: "M32 26c-3-7-13-11-13-4c0 3 4 4 13 4zM32 26c3-7 13-11 13-4c0 3-4 4-13 4z", accent: true },
  ],
  KEY: [
    { d: "M18 20a11 11 0 1 1 0 22a11 11 0 1 1 0-22z" },
    { d: "M18 27.2a3.8 3.8 0 1 1 0 7.6a3.8 3.8 0 1 1 0-7.6z", accent: true },
    { d: "M29 31h28" },
    { d: "M45 31v7M51 31v5M57 31v8" },
  ],
  MAGNIFIER: [
    { d: "M27 8a19 19 0 1 1 0 38a19 19 0 1 1 0-38z" },
    { d: "M40.5 40.5L56 56" },
    { d: "M17 22a11 11 0 0 1 9-7", accent: true },
  ],
  MEGAPHONE: [
    { d: "M12 26h8l20-12v36L20 38h-8a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z" },
    { d: "M18 38l3 12h6l-3-12" },
    { d: "M46 25c2 2 2 12 0 14M51 20c4.5 4.5 4.5 19.5 0 24", accent: true },
  ],
  CROWN: [
    { d: "M10 22l9 9l13-17l13 17l9-9l-5 24H15z" },
    { d: "M15 52h34" },
    { d: "M28 38a4 4 0 1 1 8 0a4 4 0 1 1-8 0z", accent: true },
    { d: "M10 19.5v0.1M32 11.5v0.1M54 19.5v0.1", accent: true },
  ],
  FIRE: [
    { d: "M32 6c2 8 14 14 14 29a14 14 0 0 1-28 0c0-7 3-11 6-14c0 5 2 8 5 9c-1-9 1-17 3-24z" },
    { d: "M32 32c3 3 6 5 6 9.5a6 6 0 0 1-12 0c0-4 3-6.5 6-9.5z", accent: true },
  ],
  LIGHTNING: [
    { d: "M36 6L16 36h14l-4 22l22-32H34l2-20z" },
    { d: "M50 10l-3 4M54 18l-4 1M12 46l4-1M14 54l3-4", accent: true },
  ],
  TARGET: [
    { d: "M30 10a22 22 0 1 1 0 44a22 22 0 1 1 0-44z" },
    { d: "M30 19a13 13 0 1 1 0 26a13 13 0 1 1 0-26z" },
    { d: "M30 28.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 1 1 0-7z", accent: true },
    { d: "M30 32L50 12M50 12v-5M50 12h5", accent: true },
  ],
  LAPTOP: [
    { d: "M15 14h34a3 3 0 0 1 3 3v24H12V17a3 3 0 0 1 3-3z" },
    { d: "M6 41h52l-3 7H9z" },
    { d: "M28 44.5h8" },
    { d: "M18 34l7-7l5 4l9-9l6 5", accent: true },
  ],
  CAR: [
    { d: "M8 40v-8l6-12h30l8 12h6v8H8z" },
    { d: "M16 24h26l5 8H12z" },
    { d: "M18 40a4 4 0 1 0 0 8a4 4 0 1 0 0-8z" },
    { d: "M46 40a4 4 0 1 0 0 8a4 4 0 1 0 0-8z" },
    { d: "M53 36h3", accent: true },
  ],
  DIAMOND: [
    { d: "M20 12h24l12 14L32 54L8 26z" },
    { d: "M8 26h48M20 12l12 14l12-14M32 26v28" },
    { d: "M26 18l6-6", accent: true },
  ],
  WALLET: [
    { d: "M10 18h40a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V22a4 4 0 0 1 4-4z" },
    { d: "M6 24h44a4 4 0 0 1 4 4v4H6" },
    { d: "M40 34h14v10H40a5 5 0 0 1 0-10z" },
    { d: "M45 39h3", accent: true },
  ],
  BANK: [
    { d: "M8 24L32 10l24 14H8z" },
    { d: "M12 24v22M24 24v22M40 24v22M52 24v22" },
    { d: "M6 46h52v6H6z" },
    { d: "M32 14a3 3 0 1 0 0 6a3 3 0 1 0 0-6z", accent: true },
  ],
};

function DrawnIcon({ strokes, size, primary, secondary, frame, fps, start, tempo, glow }: { strokes: Stroke[]; size: number; primary: string; secondary: string; frame: number; fps: number; start: number; tempo: number; glow: number }) {
  const gid = `li-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const per = Math.round(fps * 0.38 * tempo);
  const step = Math.round(fps * 0.12 * tempo);
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" style={{ overflow: "visible" }}>
      <defs>
        <filter id={gid} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation={1.6} />
        </filter>
      </defs>
      {strokes.map((s, i) => {
        const t = prog(frame, start + i * step, per, EASE_IN_OUT);
        const color = s.accent ? secondary : primary;
        return (
          <g key={i}>
            <path d={s.d} fill="none" stroke={color} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - t} filter={`url(#${gid})`} opacity={0.55 * glow} />
            <path d={s.d} fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - t} />
          </g>
        );
      })}
    </svg>
  );
}

/** ICON_3D in the LINE icon style. */
export function LineIcon(tp: TemplateComponentProps<"ICON_3D">) {
  const { props, palette: p, frame, fps } = tp;
  const f = feelOf(tp);
  const EO = feelEase(f);
  const s = springAt(frame, fps, 0, f.springs.soft);
  const hasCap = !!props.caption;
  const area = hasCap ? 480 : 600;
  const disc = hasCap ? 380 : 440;
  const float = Math.sin((frame / fps) * 1.6) * 6 * (f.language === "PLAYFUL" ? 1.6 : 1);
  const capT = prog(frame, 12, 18, EO);
  const strokes = LINE_ICON_PATHS[props.icon] ?? LINE_ICON_PATHS.COIN!;
  const tilt = f.rotate ? (1 - Math.min(1, s)) * -f.rotate * 2 : 0;
  const secondary = mix(p.secondary, "#FFFFFF", 0.15);
  return (
    <div style={{ ...fill }}>
      <div style={{ position: "absolute", left: (560 - disc) / 2, top: (area - disc) / 2 + float, width: disc, height: disc, transform: `scale(${0.8 + 0.2 * s}) rotate(${tilt}deg)`, opacity: clamp01(s * 1.5) }}>
        <div style={{ position: "absolute", inset: 0, ...glassCard(p, 999) }} />
        <div style={{ position: "absolute", inset: 14, borderRadius: 999, boxShadow: `inset 0 0 0 2px ${rgba(p.primary, 0.22)}, 0 0 ${50 * f.glow}px ${rgba(p.primary, 0.14)}` }} />
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <DrawnIcon strokes={strokes} size={disc * 0.62} primary={p.primary} secondary={secondary} frame={frame} fps={fps} start={4} tempo={f.tempo} glow={f.glow} />
        </div>
      </div>
      {hasCap ? (
        <div style={{ position: "absolute", left: 0, right: 0, top: area + 4, textAlign: "center", fontFamily: FONT.displayBold, fontSize: 46, letterSpacing: "-0.015em", color: p.ink, textShadow: TEXT_LIFT, opacity: capT, transform: `translateY(${(1 - capT) * 18 * f.distance}px)` }}>{props.caption}</div>
      ) : null}
    </div>
  );
}

/** MONEY_STACK_3D in the LINE icon style: outlined bill stacks rising, amount counting up. */
export function LineMoneyStack(tp: TemplateComponentProps<"MONEY_STACK_3D">) {
  const { props, palette: p, frame, fps } = tp;
  const f = feelOf(tp);
  const EO = feelEase(f);
  const n = stackCountFor(props.amount);
  const growLen = Math.round(fps * 1.4);
  const cols = Math.min(n, 3);
  const rows = Math.ceil(n / cols);
  const billW = 150;
  const gap = 52;
  const depth = 30;
  const v = countUp(frame, 0, props.amount, 4, growLen);
  const labelT = prog(frame, 6, 16, EO);
  const amountText = `$${formatNumber(Math.round(v))}`;
  const finalText = `$${formatNumber(props.amount)}`;
  const size = finalText.length <= 7 ? 112 : finalText.length <= 10 ? 96 : 80;
  const green = p.positive === "#FFFFFF" ? p.primary : p.positive;
  const totalW = cols * billW + (cols - 1) * gap;
  // Back rows first (drawn behind), each row raised and shifted like an isometric line drawing.
  const stacks: Array<{ x: number; y: number; h: number; delay: number }> = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const inRow = Math.min(cols, n - r * cols);
    const rowW = inRow * billW + (inRow - 1) * gap;
    const center = 1 - Math.abs(c - (inRow - 1) / 2) / 2;
    const back = rows - 1 - r;
    stacks.push({ x: (720 - rowW) / 2 + c * (billW + gap) + back * 26, y: 430 - back * 46, h: 120 + 70 * center - back * 10, delay: i * 3 });
  }
  stacks.sort((a, b) => a.y - b.y);
  return (
    <div style={{ ...fill }}>
      <div style={{ position: "absolute", left: 60, right: 60, top: 80, height: 340, background: `radial-gradient(ellipse at center, ${rgba(green, 0.14)} 0%, transparent 70%)`, filter: "blur(16px)" }} />
      <svg width={720} height={470} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
        <line x1={(720 - totalW) / 2 - 30} x2={(720 + totalW) / 2 + 30} y1={448} y2={448} stroke={rgba("#FFFFFF", 0.18)} strokeWidth={3} strokeLinecap="round" />
        {stacks.map((st, i) => {
          const g = springAt(frame, fps, 4 + st.delay, f.springs.grow, growLen);
          const h = Math.max(0, st.h * Math.min(g, 1.08));
          if (h < 2) return null;
          const x0 = st.x;
          const x1 = st.x + billW;
          const yb = st.y;
          const yt = st.y - h;
          const dx = depth;
          const dy = depth * 0.6;
          const edges = Math.max(0, Math.floor((h - 18) / 16));
          const sw = 3;
          return (
            <g key={i} strokeLinejoin="round" strokeLinecap="round">
              {/* side + top faces (line drawing, faint fill), then the front face */}
              <path d={`M${x1} ${yb} L${x1 + dx} ${yb - dy} L${x1 + dx} ${yt - dy} L${x1} ${yt} Z`} fill={rgba(green, 0.06)} stroke={green} strokeWidth={sw} opacity={0.85} />
              <path d={`M${x0} ${yt} L${x0 + dx} ${yt - dy} L${x1 + dx} ${yt - dy} L${x1} ${yt} Z`} fill={rgba(green, 0.18)} stroke={green} strokeWidth={sw} />
              <ellipse cx={(x0 + x1 + dx) / 2} cy={yt - dy / 2} rx={18} ry={6} fill="none" stroke={green} strokeWidth={2} opacity={0.8} />
              <rect x={x0} y={yt} width={billW} height={h} fill={rgba(green, 0.1)} stroke={green} strokeWidth={sw} />
              {Array.from({ length: edges }, (_, k) => (
                <line key={k} x1={x0 + 6} x2={x1 - 6} y1={yt + 16 + k * 16} y2={yt + 16 + k * 16} stroke={green} strokeWidth={1.4} opacity={0.32} />
              ))}
              <rect x={(x0 + x1) / 2 - 16} y={yt} width={32} height={h} fill={rgba(p.primary, 0.22)} stroke={p.primary} strokeWidth={2.5} />
            </g>
          );
        })}
      </svg>
      <div style={{ position: "absolute", left: 0, right: 0, top: 470, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ position: "relative", fontFamily: FONT.display, fontSize: size, lineHeight: 1, letterSpacing: "-0.035em", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          <span style={{ visibility: "hidden" }}>{finalText}</span>
          <span style={{ position: "absolute", inset: 0, textAlign: "center", ...gradientText(mix(green, p.primary, 0.15)), filter: `drop-shadow(0 0 24px ${rgba(green, 0.4)}) drop-shadow(0 8px 22px ${rgba("#000000", 0.5)})` }}>{amountText}</span>
        </div>
        {props.label ? <div style={{ marginTop: 14, fontFamily: FONT.text, fontSize: 38, letterSpacing: "0.1em", textTransform: "uppercase", color: p.ink, opacity: labelT * 0.92, textShadow: TEXT_LIFT }}>{props.label}</div> : null}
      </div>
    </div>
  );
}
