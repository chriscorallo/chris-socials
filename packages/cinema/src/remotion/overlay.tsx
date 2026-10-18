import type { CSSProperties, ReactNode } from "react";
import { clamp01, ease } from "../ease";
import type { CaptionState, FrameState, TextState } from "../evaluate";
import type { LookDef } from "../looks";

/**
 * The 2D layer: kinetic typography synced to the narration, phrase captions, letterbox. Laid out
 * inside the platform safe area (packages/media safe-zones: top 250, bottom 420, right 140,
 * left 60 on 1080×1920), so nothing sits under the TikTok/Reels/Shorts UI.
 */

export const FONTS = {
  display: "CinemaDisplay", // Inter Display ExtraBold
  displayBold: "CinemaDisplayBold", // Inter Display Bold
  sans: "CinemaSans", // Inter SemiBold
  serif: "CinemaSerif", // DM Serif Display
} as const;

export const FONT_FILES: Array<{ family: string; file: string; weight: number }> = [
  { family: FONTS.display, file: "InterDisplay-ExtraBold.ttf", weight: 800 },
  { family: FONTS.displayBold, file: "InterDisplay-Bold.ttf", weight: 700 },
  { family: FONTS.sans, file: "Inter-SemiBold.ttf", weight: 600 },
  { family: FONTS.serif, file: "DMSerifDisplay-Regular.ttf", weight: 400 },
];

/** Safe-area-aware vertical bands (fractions of height) and the horizontal center. */
export const BANDS = { UPPER: 0.235, CENTER: 0.47, LOWER: 0.64 } as const;
export const CAPTION_Y = 0.725;
export const SAFE_CENTER_X = 500 / 1080;
export const SAFE_WIDTH = 820 / 1080;

function goldText(look: LookDef): CSSProperties {
  return {
    backgroundImage: `linear-gradient(180deg, #FFF1CC 0%, ${look.goldLight} 38%, ${look.gold} 62%, ${look.goldDeep} 100%)`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
  };
}

function Chars({ text, t, stagger, render }: { text: string; t: number; stagger: number; render: (ch: string, k: number, i: number) => ReactNode }) {
  const chars = [...text];
  return (
    <>
      {chars.map((ch, i) => {
        const k = clamp01((t - i * stagger) / 0.45);
        return render(ch, k, i);
      })}
    </>
  );
}

function TextBeatView({ s, look, w, h }: { s: TextState; look: LookDef; w: number; h: number }) {
  const u = w / 1080;
  const b = s.beat;
  const band = BANDS[b.position ?? (b.style === "LABEL" ? "LOWER" : b.style === "TITLE" ? "CENTER" : "UPPER")];
  const out = ease("EASE_IN", s.exit);
  const base: CSSProperties = {
    position: "absolute",
    left: SAFE_CENTER_X * w - (SAFE_WIDTH * w) / 2,
    width: SAFE_WIDTH * w,
    top: band * h,
    transform: `translateY(-50%) translateY(${-out * 30 * u}px)`,
    opacity: 1 - out,
    filter: out > 0 ? `blur(${out * 14 * u}px)` : undefined,
    textAlign: "center",
    whiteSpace: "pre-wrap",
  };
  const strike = s.strike > 0 ? (
    <div style={{ position: "absolute", left: "8%", top: "52%", height: 10 * u, width: `${84 * ease("EASE_OUT", s.strike)}%`, background: look.danger, borderRadius: 6 * u, boxShadow: `0 0 ${18 * u}px ${look.danger}` }} />
  ) : null;

  switch (b.style) {
    case "HERO_NUMBER": {
      const len = [...s.display].length;
      const size = Math.min(200, 760 / Math.max(1, len * 0.64)) * u;
      return (
        <div style={base}>
          <div style={{ position: "relative", display: "inline-block", whiteSpace: "nowrap", fontFamily: FONTS.display, fontSize: size, lineHeight: 1, letterSpacing: "-0.035em", fontVariantNumeric: "tabular-nums", filter: `drop-shadow(0 ${10 * u}px ${30 * u}px rgba(0,0,0,0.65)) drop-shadow(0 0 ${28 * u}px rgba(243,196,106,0.28))` }}>
            <Chars
              text={s.display}
              t={s.age}
              stagger={0.022}
              render={(ch, k, i) => (
                <span key={i} style={{ display: "inline-block", transform: `translateY(${(1 - ease("EASE_OUT", k)) * 0.35}em) scale(${0.92 + 0.08 * ease("EASE_OUT", k)})`, opacity: ease("EASE_OUT", k), filter: k < 1 ? `blur(${(1 - k) * 16 * u}px)` : undefined, ...(b.accent === false ? { color: look.cream } : goldText(look)) }}>
                  {ch}
                </span>
              )}
            />
            {strike}
          </div>
        </div>
      );
    }
    case "KICKER": {
      const k = ease("EASE_OUT", clamp01(s.age / 0.6));
      // a kicker sits above whatever headline shares its band
      return (
        <div style={{ ...base, top: (band - 0.082) * h }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 18 * u, fontFamily: FONTS.sans, fontSize: 34 * u, letterSpacing: `${0.22 + 0.12 * k}em`, textTransform: "uppercase", color: b.accent ? look.goldLight : look.cream, opacity: 0.92 * k, textShadow: `0 ${2 * u}px ${6 * u}px rgba(0,0,0,0.95), 0 0 ${22 * u}px rgba(0,0,0,0.9)` }}>
            <span style={{ width: 46 * u * k, height: 2 * u, background: look.gold, display: "inline-block" }} />
            {b.text}
            <span style={{ width: 46 * u * k, height: 2 * u, background: look.gold, display: "inline-block" }} />
          </div>
        </div>
      );
    }
    case "STATEMENT":
    case "TITLE": {
      const words = b.text.split(" ");
      const size = (b.style === "TITLE" ? 118 : 88) * u;
      return (
        <div style={base}>
          <div style={{ position: "relative", display: "inline-block", fontFamily: FONTS.serif, fontSize: size, lineHeight: 1.06, letterSpacing: b.style === "TITLE" ? "0.005em" : "-0.01em", color: b.accent ? undefined : look.cream, textShadow: `0 ${6 * u}px ${30 * u}px rgba(0,0,0,0.85)` }}>
            {words.map((wd, i) => {
              const k = clamp01((s.age - i * 0.09) / 0.55);
              return (
                <span key={i} style={{ display: "inline-block", overflow: "hidden", verticalAlign: "bottom", paddingBottom: "0.08em", marginRight: "0.24em" }}>
                  <span style={{ display: "inline-block", transform: `translateY(${(1 - ease("EASE_OUT", k)) * 105}%)`, ...(b.accent ? goldText(look) : {}) }}>{wd}</span>
                </span>
              );
            })}
            {strike}
          </div>
        </div>
      );
    }
    case "LABEL": {
      const [label, value] = b.text.split("|");
      const k = ease("SPRING", clamp01(s.age / 0.7));
      return (
        <div style={base}>
          <div style={{ position: "relative", display: "inline-flex", alignItems: "baseline", gap: 22 * u, padding: `${20 * u}px ${36 * u}px`, borderRadius: 999, background: "linear-gradient(180deg, rgba(28,24,30,0.78), rgba(12,10,14,0.78))", border: `${1.5 * u}px solid rgba(243,196,106,0.38)`, boxShadow: `0 ${18 * u}px ${50 * u}px rgba(0,0,0,0.55), inset 0 ${1 * u}px 0 rgba(255,255,255,0.08)`, transform: `scale(${0.85 + 0.15 * k})`, opacity: clamp01(s.age / 0.25) }}>
            <span style={{ fontFamily: FONTS.sans, fontSize: 40 * u, color: look.cream, letterSpacing: "0.01em" }}>{label}</span>
            {value && <span style={{ fontFamily: FONTS.display, fontSize: 56 * u, ...goldText(look), fontVariantNumeric: "tabular-nums" }}>{value}</span>}
            {strike}
          </div>
        </div>
      );
    }
    case "STAMP": {
      const k = clamp01(s.age / 0.28);
      const sc = 1.7 - 0.7 * ease("EASE_OUT", k);
      return (
        <div style={base}>
          <div style={{ display: "inline-block", fontFamily: FONTS.display, fontSize: 190 * u, lineHeight: 1, letterSpacing: "-0.03em", color: b.accent ? look.danger : look.cream, transform: `rotate(-4deg) scale(${sc})`, opacity: k, filter: `blur(${(1 - k) * 10 * u}px) drop-shadow(0 ${10 * u}px ${36 * u}px rgba(0,0,0,0.8))` }}>{s.display}</div>
        </div>
      );
    }
    case "FOOTNOTE": {
      const k = clamp01(s.age / 0.5);
      return (
        <div style={{ ...base, top: (b.position ? band : 0.312) * h }}>
          <div style={{ display: "inline-block", maxWidth: 700 * u, padding: `${8 * u}px ${18 * u}px`, borderRadius: 14 * u, background: "rgba(8,7,9,0.62)", fontFamily: FONTS.sans, fontSize: 25 * u, lineHeight: 1.35, color: "#C9C3BA", opacity: 0.92 * k, letterSpacing: "0.01em" }}>{s.display}</div>
        </div>
      );
    }
  }
}

function Caption({ c, look, w, h }: { c: CaptionState; look: LookDef; w: number; h: number }) {
  const u = w / 1080;
  const k = ease("EASE_OUT", c.enter) * (1 - c.exit);
  return (
    <div style={{ position: "absolute", left: SAFE_CENTER_X * w - (SAFE_WIDTH * w) / 2, width: SAFE_WIDTH * w, top: CAPTION_Y * h, transform: `translateY(-50%) translateY(${(1 - ease("EASE_OUT", c.enter)) * 14 * u}px)`, textAlign: "center", opacity: k }}>
      <span style={{ fontFamily: FONTS.displayBold, fontSize: 54 * u, lineHeight: 1.15, letterSpacing: "-0.01em", textShadow: `0 ${3 * u}px ${16 * u}px rgba(0,0,0,0.95), 0 0 ${3 * u}px rgba(0,0,0,0.9)` }}>
        {c.words.map((wd, i) => (
          <span key={i} style={{ color: wd.active ? look.goldLight : look.cream, opacity: wd.spoken ? 1 : 0.55, marginRight: wd.raw.endsWith("-") ? 0 : "0.26em", display: "inline-block", transform: wd.active ? "translateY(-2%) scale(1.04)" : undefined }}>
            {wd.raw}
          </span>
        ))}
      </span>
    </div>
  );
}

export function Overlay({ state, look, width, height }: { state: FrameState; look: LookDef; width: number; height: number }) {
  const lb = state.post.letterbox;
  const bar = lb * height * 0.11;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {/* legibility scrims: darken the type zones a touch */}
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: height * 0.4, background: "linear-gradient(180deg, rgba(0,0,0,0.5), rgba(0,0,0,0.18) 60%, rgba(0,0,0,0))" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: height * 0.42, background: "linear-gradient(0deg, rgba(0,0,0,0.45), rgba(0,0,0,0.2) 55%, rgba(0,0,0,0))" }} />
      {state.texts.map((t) => (
        <TextBeatView key={t.key} s={t} look={look} w={width} h={height} />
      ))}
      {state.caption && <Caption c={state.caption} look={look} w={width} h={height} />}
      {bar > 0.5 && (
        <>
          <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: bar, background: "#000" }} />
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: bar, background: "#000" }} />
        </>
      )}
    </div>
  );
}
