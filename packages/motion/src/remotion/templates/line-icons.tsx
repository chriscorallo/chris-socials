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
  const billW = 170;
  const billH = 26;
  const gap = 34;
  const v = countUp(frame, 0, props.amount, 4, growLen);
  const labelT = prog(frame, 6, 16, EO);
  const amountText = `$${formatNumber(Math.round(v))}`;
  const finalText = `$${formatNumber(props.amount)}`;
  const size = finalText.length <= 7 ? 112 : finalText.length <= 10 ? 96 : 80;
  const green = p.positive === "#FFFFFF" ? p.primary : p.positive;
  const totalW = cols * billW + (cols - 1) * gap;
  const stacks: Array<{ x: number; y: number; bills: number; delay: number }> = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const inRow = Math.min(cols, n - r * cols);
    const rowW = inRow * billW + (inRow - 1) * gap;
    const center = Math.abs(c - (inRow - 1) / 2) < 0.6;
    stacks.push({ x: (720 - rowW) / 2 + c * (billW + gap) + (r % 2 ? 18 : 0), y: 420 - (rows - 1 - r) * 34, bills: center ? 9 : 7, delay: i * 3 });
  }
  return (
    <div style={{ ...fill }}>
      <div style={{ position: "absolute", left: 60, right: 60, top: 80, height: 340, background: `radial-gradient(ellipse at center, ${rgba(green, 0.14)} 0%, transparent 70%)`, filter: "blur(16px)" }} />
      <svg width={720} height={470} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
        <line x1={(720 - totalW) / 2 - 30} x2={(720 + totalW) / 2 + 30} y1={448} y2={448} stroke={rgba("#FFFFFF", 0.18)} strokeWidth={3} strokeLinecap="round" />
        {stacks.map((st, i) => {
          const g = springAt(frame, fps, 4 + st.delay, f.springs.grow, growLen);
          const shown = Math.max(0, Math.min(st.bills, Math.round(st.bills * Math.min(g, 1.1))));
          return (
            <g key={i}>
              {Array.from({ length: shown }, (_, k) => {
                const y = st.y - k * (billH + 4);
                const top = k === shown - 1;
                return (
                  <g key={k}>
                    <rect x={st.x} y={y} width={billW} height={billH} rx={6} fill={rgba(green, top ? 0.16 : 0.07)} stroke={green} strokeWidth={top ? 3.5 : 2.5} opacity={top ? 1 : 0.75} />
                    {top ? <ellipse cx={st.x + billW / 2} cy={y + billH / 2} rx={14} ry={8} fill="none" stroke={green} strokeWidth={2.5} /> : null}
                  </g>
                );
              })}
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
