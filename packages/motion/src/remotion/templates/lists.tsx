import type { CSSProperties } from "react";
import { EASE_IN_OUT, clamp01, feelEase, prog, springAt } from "../motion";
import { FONT, glassCard, mix, rgba } from "../theme";
import { feelOf, type TemplateComponentProps } from "./types";

const fill: CSSProperties = { position: "absolute", inset: 0 };

// ---------------------------------------------------------------- LIST_STEPS
export function ListSteps(tp: TemplateComponentProps<"LIST_STEPS">) {
  const { props, palette: p, frame, fps, durationInFrames } = tp;
  const f = feelOf(tp);
  const SP = f.springs;
  const EO = feelEase(f);
  const n = props.items.length;
  const titleT = prog(frame, 0, 16, EO);
  const base = props.title ? 10 : 4;
  // Spread item entrances over at most ~45% of the visual.
  const stagger = Math.max(5, Math.min(Math.round(fps * 0.4), Math.floor((durationInFrames * 0.45) / n)));
  const rowH = n <= 3 ? 128 : n === 4 ? 112 : 94;
  const badge = 68;
  const lineT = prog(frame, base + 4, stagger * (n - 1) + 10, EASE_IN_OUT);
  return (
    <div style={{ ...fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", width: 860, boxSizing: "border-box", padding: "44px 52px 40px", ...glassCard(p) }}>
        {props.title ? (
          <div style={{ fontFamily: FONT.displayBold, fontSize: 48, lineHeight: 1.1, letterSpacing: "-0.015em", color: p.ink, marginBottom: 16, opacity: titleT, transform: `translateY(${(1 - titleT) * 14}px)` }}>{props.title}</div>
        ) : null}
        <div style={{ position: "relative" }}>
          <div style={{ position: "absolute", left: badge / 2 - 1.5, top: rowH / 2, height: (n - 1) * rowH * lineT, width: 3, borderRadius: 3, background: `linear-gradient(180deg, ${rgba(p.primary, 0.7)}, ${rgba(p.secondary, 0.5)})` }} />
          {props.items.map((item, i) => {
            const d = base + i * stagger;
            const s = springAt(frame, fps, d, SP.settle);
            const bS = springAt(frame, fps, d, SP.soft);
            const check = prog(frame, d + 4, 12, EO);
            const lit = mix(p.primary, p.secondary, n > 1 ? i / (n - 1) : 0);
            return (
              <div key={i} style={{ position: "relative", height: rowH, display: "flex", alignItems: "center", gap: 30, opacity: clamp01(s * 1.4), transform: `translateX(${(1 - s) * 50 * f.distance}px)` }}>
                <div style={{ flex: "none", width: badge, height: badge, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(160deg, ${mix(lit, "#FFFFFF", 0.25)}, ${mix(lit, "#000000", 0.18)})`, boxShadow: `0 10px 26px ${rgba("#000000", 0.4)}, 0 0 26px ${rgba(lit, 0.35)}, inset 0 2px 0 ${rgba("#FFFFFF", 0.45)}`, transform: `scale(${bS})` }}>
                  {props.style === "CHECK" ? (
                    <svg width={40} height={40} viewBox="0 0 24 24">
                      <path d="M5 12.5 L10 17.5 L19 7" fill="none" stroke="#14110A" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - check} />
                    </svg>
                  ) : (
                    <span style={{ fontFamily: FONT.display, fontSize: 36, color: "#14110A", letterSpacing: "-0.02em" }}>{i + 1}</span>
                  )}
                </div>
                <div style={{ fontFamily: FONT.text, fontSize: item.length > 30 ? 38 : 42, lineHeight: 1.18, color: p.ink }}>{item}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- TIMELINE (vertical)
export function TimelineTemplate(tp: TemplateComponentProps<"TIMELINE">) {
  const { props, palette: p, frame, fps, durationInFrames } = tp;
  const f = feelOf(tp);
  const SP = f.springs;
  const EO = feelEase(f);
  const ev = props.events;
  const n = ev.length;
  const H = 800;
  const top = 64;
  const bottom = 90;
  const step = (H - top - bottom) / (n - 1);
  const x = 70;
  const travel = Math.max(Math.round(fps * 0.9), Math.min(Math.round(fps * 2.2), Math.round(durationInFrames * 0.5)));
  const lineT = prog(frame, 6, travel, EASE_IN_OUT);
  const reach = top + lineT * (H - top - bottom);
  return (
    <div style={{ ...fill }}>
      <div style={{ position: "absolute", inset: 0, ...glassCard(p), opacity: prog(frame, 0, 12, EO) }} />
      <div style={{ position: "absolute", left: x - 2, top, width: 4, height: H - top - bottom, borderRadius: 4, background: rgba("#FFFFFF", 0.12), boxShadow: `0 0 0 1px ${rgba("#000000", 0.15)}` }} />
      <div style={{ position: "absolute", left: x - 2, top, width: 4, height: reach - top, borderRadius: 4, background: `linear-gradient(180deg, ${p.secondary}, ${p.primary})`, boxShadow: `0 0 18px ${rgba(p.primary, 0.5)}` }} />
      {ev.map((e, i) => {
        const y = top + i * step;
        const hitFrame = 6 + (travel * i) / (n - 1);
        const s = springAt(frame, fps, hitFrame - 2, SP.soft);
        const tT = prog(frame, hitFrame, 14, EO);
        const last = i === n - 1;
        const col = mix(p.secondary, p.primary, i / (n - 1));
        const ring = last ? ((frame - hitFrame) % Math.round(fps * 1.3)) / Math.round(fps * 1.3) : 0;
        return (
          <div key={i}>
            {last && frame > hitFrame ? <div style={{ position: "absolute", left: x - 30 - 30 * ring, top: y - 30 - 30 * ring, width: 60 + 60 * ring, height: 60 + 60 * ring, borderRadius: 999, border: `3px solid ${rgba(p.primary, (1 - ring) * 0.7)}` }} /> : null}
            <div style={{ position: "absolute", left: x - 22, top: y - 22, width: 44, height: 44, borderRadius: 999, background: `radial-gradient(circle at 35% 30%, ${mix(col, "#FFFFFF", 0.45)}, ${col} 60%)`, boxShadow: `0 0 0 8px ${rgba("#0B0B10", 0.8)}, 0 0 30px ${rgba(col, 0.6)}`, transform: `scale(${s})` }} />
            <div style={{ position: "absolute", left: x + 58, top: y - 40, width: 760 - x - 58, opacity: tT, transform: `translateX(${(1 - tT) * 30 * f.distance}px)` }}>
              <div style={{ fontFamily: FONT.display, fontSize: 52, lineHeight: 1.05, letterSpacing: "-0.02em", color: last ? p.primary : p.ink, textShadow: `0 2px 4px ${rgba("#000000", 0.4)}, 0 8px 30px ${rgba("#000000", 0.55)}${last ? `, 0 0 30px ${rgba(p.primary, 0.35)}` : ""}` }}>{e.label}</div>
              {e.sub ? <div style={{ marginTop: 6, fontFamily: FONT.text, fontSize: 34, lineHeight: 1.2, color: p.ink, opacity: 0.86, textShadow: `0 2px 4px ${rgba("#000000", 0.45)}, 0 6px 24px ${rgba("#000000", 0.6)}` }}>{e.sub}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
