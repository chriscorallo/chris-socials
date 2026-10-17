import { useId, type CSSProperties } from "react";
import { EASE_IN_OUT, EASE_OUT, SPRINGS, clamp01, countUp, prog, springAt } from "../motion";
import { FONT, compactNumber, glassCard, mix, rgba, withUnit } from "../theme";
import { gradientText } from "./text";
import type { TemplateComponentProps } from "./types";
import { BarChart3D } from "./three";

const fill: CSSProperties = { position: "absolute", inset: 0 };

function sid(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "");
}

// ---------------------------------------------------------------- BAR_CHART
export function BarChart(tp: TemplateComponentProps<"BAR_CHART">) {
  const { props, palette: p, frame } = tp;
  const titleT = prog(frame, 0, 16, EASE_OUT);
  const hasTitle = !!props.title;
  return (
    <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", width: 900, height: 760, boxSizing: "border-box", padding: "48px 52px 40px", display: "flex", flexDirection: "column", ...glassCard(p) }}>
        {hasTitle ? (
          <div style={{ fontFamily: FONT.displayBold, fontSize: 48, lineHeight: 1.1, color: p.ink, letterSpacing: "-0.015em", opacity: titleT, transform: `translateY(${(1 - titleT) * 14}px)` }}>{props.title}</div>
        ) : null}
        <div style={{ position: "relative", flex: 1, marginTop: hasTitle ? 24 : 0 }}>
          {props.depth3d ? <BarChart3D {...tp} /> : <Bars2D {...tp} />}
        </div>
      </div>
    </div>
  );
}

function Bars2D({ props, palette: p, frame, fps }: TemplateComponentProps<"BAR_CHART">) {
  const W = 796;
  const H = props.title ? 596 : 672;
  const labelH = 62;
  const valueH = 64;
  const plotH = H - labelH - valueH;
  const n = props.bars.length;
  const gap = n <= 3 ? 64 : n <= 4 ? 44 : 30;
  const bw = (W - gap * (n - 1)) / n;
  const max = Math.max(...props.bars.map((b) => Math.abs(b.value)), 1e-9);
  const hl = props.highlightIndex != null && props.highlightIndex < n ? props.highlightIndex : null;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: valueH + plotH, height: 2, background: rgba("#FFFFFF", 0.14) }} />
      {[0.25, 0.5, 0.75].map((g) => (
        <div key={g} style={{ position: "absolute", left: 0, right: 0, top: valueH + plotH * (1 - g), height: 1.5, background: rgba("#FFFFFF", 0.05) }} />
      ))}
      {props.bars.map((b, i) => {
        const s = springAt(frame, fps, 8 + i * 5, SPRINGS.grow);
        const h = Math.max(6, (Math.abs(b.value) / max) * plotH) * s;
        const x = i * (bw + gap);
        const isH = hl === null || hl === i;
        const focus = hl !== null && hl === i;
        const color = isH ? p.primary : p.secondary;
        const v = countUp(frame, 0, b.value, 8 + i * 5, Math.round(fps * 1.0));
        const vT = prog(frame, 12 + i * 5, 12, EASE_OUT);
        const dim = hl !== null && !focus ? 0.55 + 0.45 * (1 - prog(frame, 8 + n * 5 + 10, 16, EASE_IN_OUT)) : 1;
        return (
          <div key={i}>
            <div style={{ position: "absolute", left: x, width: bw, top: valueH + plotH - h, height: h, borderRadius: "18px 18px 6px 6px", opacity: dim, background: `linear-gradient(180deg, ${mix(color, "#FFFFFF", 0.25)} 0%, ${color} 40%, ${mix(color, "#000000", 0.35)} 100%)`, boxShadow: focus ? `0 0 40px ${rgba(color, 0.45)}, inset 0 2px 0 ${rgba("#FFFFFF", 0.4)}` : `inset 0 2px 0 ${rgba("#FFFFFF", 0.3)}` }}>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "38%", borderRadius: "18px 0 0 6px", background: `linear-gradient(90deg, ${rgba("#FFFFFF", 0.16)}, transparent)` }} />
            </div>
            <div style={{ position: "absolute", left: x - 20, width: bw + 40, top: valueH + plotH - h - valueH + 6, height: valueH, display: "flex", alignItems: "flex-end", justifyContent: "center", fontFamily: FONT.display, fontSize: n >= 6 ? 36 : 42, color: focus ? p.primary : p.ink, opacity: vT * (focus || hl === null ? 1 : 0.8), letterSpacing: "-0.02em", textShadow: focus ? `0 0 24px ${rgba(p.primary, 0.5)}` : undefined, whiteSpace: "nowrap" }}>
              {withUnit(compactNumber(Number.isInteger(b.value) ? Math.round(v) : Math.round(v * 10) / 10), props.unit)}
            </div>
            <div style={{ position: "absolute", left: x - 16, width: bw + 32, top: valueH + plotH + 16, textAlign: "center", fontFamily: FONT.text, fontSize: n >= 6 ? 34 : 38, color: focus ? p.ink : p.muted, opacity: prog(frame, 6 + i * 4, 14, EASE_OUT), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {b.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- LINE_CHART
function smoothPolyline(pts: Array<[number, number]>, samplesPerSeg = 24): Array<[number, number]> {
  if (pts.length < 3) return pts;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      // Centripetal-ish Catmull-Rom with tension 0.5; clamp y to avoid overshoot below baseline.
      const x = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, Math.min(Math.max(y, Math.min(p1[1], p2[1]) - 40), Math.max(p1[1], p2[1]) + 40)]);
    }
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

export function LineChart({ props, palette: p, frame, fps }: TemplateComponentProps<"LINE_CHART">) {
  const id = sid(useId());
  const hasTitle = !!props.title;
  const W = 796;
  const H = hasTitle ? 418 : 500;
  const padTop = 88;
  const plotH = H - padTop;
  const vals = props.points.map((q) => q.value);
  const min = Math.min(0, ...vals);
  const max = Math.max(...vals, min + 1e-9);
  const pts: Array<[number, number]> = props.points.map((q, i) => [
    (i / (props.points.length - 1)) * W,
    padTop + plotH - ((q.value - min) / (max - min)) * plotH,
  ]);
  const poly = smoothPolyline(pts);
  const cum: number[] = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1]! + Math.hypot(poly[i]![0] - poly[i - 1]![0], poly[i]![1] - poly[i - 1]![1]));
  const total = cum[cum.length - 1]!;
  const drawLen = Math.round(fps * 1.6);
  const draw = prog(frame, 10, drawLen, EASE_IN_OUT);
  const headLen = draw * total;
  let hi = cum.findIndex((c) => c >= headLen);
  if (hi < 0) hi = poly.length - 1;
  const head = poly[Math.max(0, hi)]!;
  const d = poly.map((q, i) => `${i ? "L" : "M"}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" ");
  const area = `${d} L${W},${H} L0,${H} Z`;
  const titleT = prog(frame, 0, 16, EASE_OUT);
  const last = props.points[props.points.length - 1]!;
  const lastV = countUp(frame, props.points[0]!.value, last.value, 10, drawLen);
  const end = pts[pts.length - 1]!;
  const pillT = springAt(frame, fps, 10 + drawLen - 4, SPRINGS.soft);
  const ring = ((frame - (10 + drawLen)) % Math.round(fps * 1.3)) / Math.round(fps * 1.3);
  const n = props.points.length;
  const showAll = n <= 7 && props.points.every((q) => q.label.length <= 4);
  const labelIdx = showAll ? props.points.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1];
  const pillW = 300;
  const pillLeft = Math.min(W - pillW + 20, Math.max(-20, end[0] - pillW / 2));
  return (
    <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", width: 900, height: 680, boxSizing: "border-box", padding: "46px 52px 40px", ...glassCard(p) }}>
        {hasTitle ? (
          <div style={{ fontFamily: FONT.displayBold, fontSize: 48, lineHeight: 1.1, color: p.ink, letterSpacing: "-0.015em", opacity: titleT, transform: `translateY(${(1 - titleT) * 14}px)` }}>{props.title}</div>
        ) : null}
        <div style={{ position: "relative", width: W, height: H, marginTop: hasTitle ? 18 : 0 }}>
          <svg width={W} height={H} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            <defs>
              <linearGradient id={`${id}-stroke`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor={p.secondary} />
                <stop offset="1" stopColor={p.primary} />
              </linearGradient>
              <linearGradient id={`${id}-area`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor={p.primary} stopOpacity={0.32} />
                <stop offset="1" stopColor={p.secondary} stopOpacity={0} />
              </linearGradient>
              <clipPath id={`${id}-clip`}>
                <rect x={-10} y={-200} width={head[0] + 10} height={H + 400} />
              </clipPath>
              <filter id={`${id}-glow`} x="-20%" y="-50%" width="140%" height="200%">
                <feGaussianBlur stdDeviation={10} />
              </filter>
            </defs>
            {[0.25, 0.5, 0.75, 1].map((g) => (
              <line key={g} x1={0} x2={W} y1={padTop + plotH * (1 - g)} y2={padTop + plotH * (1 - g)} stroke={rgba("#FFFFFF", 0.06)} strokeWidth={1.5} strokeDasharray="6 10" />
            ))}
            <line x1={0} x2={W} y1={H} y2={H} stroke={rgba("#FFFFFF", 0.16)} strokeWidth={2} />
            <path d={area} fill={`url(#${id}-area)`} clipPath={`url(#${id}-clip)`} />
            <path d={d} fill="none" stroke={`url(#${id}-stroke)`} strokeWidth={14} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - draw} filter={`url(#${id}-glow)`} opacity={0.6} />
            <path d={d} fill="none" stroke={`url(#${id}-stroke)`} strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - draw} />
            {pts.slice(0, -1).map((q, i) => (
              <circle key={i} cx={q[0]} cy={q[1]} r={6} fill={mix(p.secondary, p.primary, i / (n - 1))} opacity={q[0] <= head[0] + 1 ? 0.9 : 0} />
            ))}
            {draw > 0 && draw < 1 ? <circle cx={head[0]} cy={head[1]} r={11} fill="#FFFFFF" filter={`url(#${id}-glow)`} /> : null}
            {draw > 0 && draw < 1 ? <circle cx={head[0]} cy={head[1]} r={8} fill="#FFFFFF" /> : null}
            {draw >= 1 && props.highlightLast ? (
              <>
                <circle cx={end[0]} cy={end[1]} r={14 + 34 * ring} fill="none" stroke={p.primary} strokeWidth={3} opacity={(1 - ring) * 0.8} />
                <circle cx={end[0]} cy={end[1]} r={13} fill={p.primary} filter={`url(#${id}-glow)`} />
                <circle cx={end[0]} cy={end[1]} r={12} fill={p.primary} stroke="#FFFFFF" strokeWidth={4} />
              </>
            ) : null}
          </svg>
          {props.highlightLast ? (
            <div style={{ position: "absolute", left: pillLeft, width: pillW, top: Math.max(-6, end[1] - 112), display: "flex", justifyContent: "center", transform: `translateY(${(1 - pillT) * 16}px) scale(${0.85 + 0.15 * pillT})`, opacity: clamp01(pillT * 1.3) }}>
              <div style={{ padding: "10px 26px", borderRadius: 999, background: rgba(p.primary, 0.14), boxShadow: `inset 0 0 0 2px ${rgba(p.primary, 0.55)}, 0 0 30px ${rgba(p.primary, 0.25)}`, fontFamily: FONT.display, fontSize: 46, letterSpacing: "-0.02em", color: p.primary, whiteSpace: "nowrap" }}>
                {withUnit(compactNumber(Math.round(lastV)), props.unit)}
              </div>
            </div>
          ) : null}
          {labelIdx.map((i) => {
            const q = pts[i]!;
            const align = i === 0 ? "flex-start" : i === n - 1 ? "flex-end" : "center";
            const left = i === 0 ? 0 : i === n - 1 ? q[0] - 200 : q[0] - 100;
            return (
              <div key={i} style={{ position: "absolute", top: H + 16, left, width: i === 0 || i === n - 1 ? 200 : 200, display: "flex", justifyContent: align, fontFamily: FONT.text, fontSize: 34, color: p.muted, opacity: prog(frame, 8 + i * 2, 14, EASE_OUT), whiteSpace: "nowrap" }}>
                {props.points[i]!.label}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- COMPARISON
export function Comparison({ props, palette: p, frame, fps }: TemplateComponentProps<"COMPARISON">) {
  const lT = springAt(frame, fps, 2, SPRINGS.settle);
  const rT = springAt(frame, fps, 8, SPRINGS.settle);
  const vsT = springAt(frame, fps, 12, SPRINGS.soft);
  const decide = prog(frame, Math.round(fps * 1.0), 18, EASE_IN_OUT);
  const verdictT = prog(frame, Math.round(fps * 1.1), 16, EASE_OUT);
  const side = (which: "LEFT" | "RIGHT") => {
    const data = which === "LEFT" ? props.left : props.right;
    const t = which === "LEFT" ? lT : rT;
    const win = props.winner === which;
    const lose = props.winner !== "NONE" && !win;
    const L = data.value.length;
    const size = L <= 5 ? 104 : L <= 7 ? 86 : L <= 10 ? 70 : 56;
    const accent = which === "LEFT" ? p.primary : p.secondary;
    const valueColor = props.winner === "NONE" ? accent : win ? p.primary : p.ink;
    return (
      <div style={{ position: "relative", width: 404, height: 420, boxSizing: "border-box", padding: "40px 30px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", ...glassCard(p, 40), opacity: clamp01(t * 1.3) * (lose ? 1 - 0.4 * decide : 1), transform: `translateX(${(1 - t) * (which === "LEFT" ? -70 : 70)}px) scale(${win ? 1 + 0.04 * decide : lose ? 1 - 0.03 * decide : 1})`, boxShadow: win ? `${glassCard(p, 40).boxShadow}, 0 0 0 ${3 * decide}px ${rgba(p.primary, 0.85)}, 0 0 ${60 * decide}px ${rgba(p.primary, 0.3)}` : glassCard(p, 40).boxShadow }}>
        <div style={{ fontFamily: FONT.text, fontSize: 36, lineHeight: 1.2, letterSpacing: "0.08em", textTransform: "uppercase", color: p.muted }}>{data.label}</div>
        <div style={{ marginTop: 22, fontFamily: FONT.display, fontSize: size, lineHeight: 1, letterSpacing: "-0.035em", whiteSpace: "nowrap", ...(win || props.winner === "NONE" ? gradientText(valueColor) : { color: valueColor }) }}>{data.value}</div>
        {win ? (
          <div style={{ position: "absolute", top: -26, right: 34, width: 60, height: 60, borderRadius: 99, background: p.primary, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${springAt(frame, fps, Math.round(fps * 1.05), SPRINGS.soft)})`, boxShadow: `0 8px 24px ${rgba("#000000", 0.4)}, 0 0 30px ${rgba(p.primary, 0.5)}` }}>
            <svg width={34} height={34} viewBox="0 0 24 24">
              <path d="M5 12.5 L10 17.5 L19 7" fill="none" stroke="#14110A" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <div style={{ ...fill, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", display: "flex", gap: 48, alignItems: "center" }}>
        {side("LEFT")}
        {side("RIGHT")}
        <div style={{ position: "absolute", left: "50%", top: "50%", width: 104, height: 104, marginLeft: -52, marginTop: -52, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(160deg, ${mix(p.primary, "#FFFFFF", 0.2)}, ${mix(p.primary, "#000000", 0.2)})`, boxShadow: `0 14px 40px ${rgba("#000000", 0.5)}, 0 0 0 8px ${rgba("#0B0B10", 0.85)}`, transform: `scale(${vsT}) rotate(${(1 - vsT) * -40}deg)`, fontFamily: FONT.display, fontSize: 40, color: "#14110A", letterSpacing: "-0.02em" }}>VS</div>
      </div>
      {props.verdict ? (
        <div style={{ marginTop: 30, padding: "14px 32px", borderRadius: 999, ...glassCard(p, 999), fontFamily: FONT.text, fontSize: 36, color: p.ink, opacity: verdictT, transform: `translateY(${(1 - verdictT) * 16}px)`, whiteSpace: "nowrap" }}>{props.verdict}</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- PERCENT_RING
export function PercentRing({ props, palette: p, frame, fps }: TemplateComponentProps<"PERCENT_RING">) {
  const id = sid(useId());
  const D = 400;
  const sw = 36;
  const r = (D - sw) / 2 - 16;
  const c = D / 2;
  const fillLen = Math.round(fps * 1.5);
  const t = prog(frame, 6, fillLen, EASE_IN_OUT);
  const pct = props.percent * t;
  const a = (pct / 100) * Math.PI * 2 - Math.PI / 2;
  const ex = c + r * Math.cos(a);
  const ey = c + r * Math.sin(a);
  const labelT = prog(frame, 14, 18, EASE_OUT);
  const ticks = Array.from({ length: 60 }, (_, i) => i);
  const shown = Math.round(countUp(frame, 0, props.percent, 6, fillLen));
  return (
    <div style={{ ...fill, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", width: D, height: D }}>
        <div style={{ position: "absolute", inset: 30, borderRadius: 999, ...glassCard(p, 999) }} />
        <svg width={D} height={D} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <defs>
            <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor={mix(p.primary, "#FFFFFF", 0.3)} />
              <stop offset="0.6" stopColor={p.primary} />
              <stop offset="1" stopColor={mix(p.primary, p.secondary, 0.6)} />
            </linearGradient>
            <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation={12} />
            </filter>
          </defs>
          {ticks.map((i) => {
            const ang = (i / 60) * Math.PI * 2 - Math.PI / 2;
            const r1 = r + sw / 2 + 12;
            const r2 = r1 + (i % 5 === 0 ? 14 : 7);
            return <line key={i} x1={c + r1 * Math.cos(ang)} y1={c + r1 * Math.sin(ang)} x2={c + r2 * Math.cos(ang)} y2={c + r2 * Math.sin(ang)} stroke={rgba("#FFFFFF", i / 60 <= pct / 100 ? 0.4 : 0.12)} strokeWidth={2.5} strokeLinecap="round" />;
          })}
          <circle cx={c} cy={c} r={r} fill="none" stroke={rgba("#FFFFFF", 0.08)} strokeWidth={sw} />
          {pct > 0.2 ? (
            <>
              <circle cx={c} cy={c} r={r} fill="none" stroke={`url(#${id}-g)`} strokeWidth={sw} strokeLinecap="round" pathLength={100} strokeDasharray={`${pct} ${100 - pct + 0.0001}`} transform={`rotate(-90 ${c} ${c})`} filter={`url(#${id}-glow)`} opacity={0.55} />
              <circle cx={c} cy={c} r={r} fill="none" stroke={`url(#${id}-g)`} strokeWidth={sw} strokeLinecap="round" pathLength={100} strokeDasharray={`${pct} ${100 - pct + 0.0001}`} transform={`rotate(-90 ${c} ${c})`} />
              <circle cx={ex} cy={ey} r={sw * 0.32} fill="#FFFFFF" opacity={0.9} filter={`url(#${id}-glow)`} />
              <circle cx={ex} cy={ey} r={sw * 0.2} fill="#FFFFFF" />
            </>
          ) : null}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.display, letterSpacing: "-0.04em" }}>
          <span style={{ fontSize: 124, lineHeight: 1, fontVariantNumeric: "tabular-nums", color: p.ink, textShadow: `0 6px 30px ${rgba("#000000", 0.5)}` }}>{shown}</span>
          <span style={{ fontSize: 62, lineHeight: 1, marginLeft: 4, marginTop: 30, ...gradientText(p.primary) }}>%</span>
        </div>
      </div>
      <div style={{ marginTop: 20, maxWidth: 520, textAlign: "center", fontFamily: FONT.text, fontSize: 36, lineHeight: 1.25, color: p.ink, opacity: labelT, transform: `translateY(${(1 - labelT) * 16}px)`, textShadow: `0 2px 4px ${rgba("#000000", 0.35)}, 0 8px 30px ${rgba("#000000", 0.6)}` }}>{props.label}</div>
    </div>
  );
}
