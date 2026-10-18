import { useId, type ComponentType, type CSSProperties, type ReactNode } from "react";
import type { GraphicComponent, GraphicIcon } from "@chris/media/timeline";
import { EASE_IN_OUT } from "../motion";
import { GIcon } from "./icons";
import { FONT, clamp01, counted, css, emphasisAt, enterStyle, fmtValue, mix, prog, r1, r4, rgba, springAt, withExit, type GCtx } from "./kit";
import { APP_TINTS, AppTile, Avatar, TypingDots, card, inAt, oneLine, pressAt, toneOf, type Tone } from "./ui";
import { fitLine, fitWords, hash01, onFill, splitWords, squeeze, textW } from "./text";

/**
 * Library 2 — LIFE & PLACES family: MAP_NAV (route / pin drop / flight arc / multi-stop trip),
 * WEATHER (now card / week), SCREEN_TIME (report / apps), PAYMENT (received / feed / receipt /
 * declined), TRAVEL (ride / delivery / boarding pass / ticket), DATE (page flip / month /
 * years odometer / days until), TRACKER (habit grid / workout sets / mood meter) and LIST_SPLIT
 * (pros & cons / do's & don'ts / myth → fact).
 *
 * Brand-safe by construction: the maps are ORIGINAL abstract street grids (no tiles, no
 * provider styling), the payment / ride / ticket cards are generic "-style" UIs with initials
 * avatars and palette accents (no app logos or signature colours). Every component reads
 * toneOf(ctx) (dark glass / frosted white), and everything is a pure function of ctx.frame.
 */

type Item = GCtx["props"]["items"][number];
type Pt = { x: number; y: number };
type C = { ctx: GCtx };

const fill: CSSProperties = { position: "absolute", inset: 0 };

// ===================================================================== shared helpers

function sid(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "");
}

/** Choreography clock: seconds → frames (tempo/speed aware), compressed to fit the build budget. */
function clock(ctx: GCtx, totalSec: number, t0Sec = 0.12) {
  const k0 = ctx.f.tempo / Math.max(0.25, ctx.anim.speed);
  const t0 = Math.round(t0Sec * ctx.fps);
  const k = squeeze(ctx, t0, totalSec * ctx.fps * k0);
  const m = ctx.fps * k0 * k;
  return { at: (s: number) => Math.round(t0 + s * m), len: (s: number) => Math.max(3, Math.round(s * m)) };
}

function tx(size: number, color: string, face: string = FONT.text, extra: CSSProperties = {}): CSSProperties {
  return { fontFamily: face, fontSize: size, lineHeight: 1.15, color, ...extra };
}

/** Entrance (shared vocabulary) + element exit for element `idx` of `n`. */
function el(ctx: GCtx, start: number, len: number, idx: number, n: number, opts: { style?: GCtx["anim"]["enter"]; distance?: number; blur?: boolean } = {}): CSSProperties {
  return css(withExit(ctx, enterStyle(ctx, start, len, { style: opts.style, blurOK: !!opts.blur, distance: opts.distance }), idx, n));
}

/** Title + subtitle block (tone-aware; the kit Header is dark-only). */
function Head({ ctx, T, x, y, w, title, subtitle, start = 0, size = 52, align = "left" }: { ctx: GCtx; T: Tone; x: number; y: number; w: number; title?: string | null; subtitle?: string | null; start?: number; size?: number; align?: "left" | "center" }) {
  if (!title && !subtitle) return null;
  const L = Math.round(0.5 * ctx.fps);
  const a = inAt(ctx, start, L);
  const b = inAt(ctx, start + 4, L);
  const ts = title ? fitLine(title, w, size, 36) : 0;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, textAlign: align }}>
      {title ? <div style={{ ...tx(ts, T.ink, FONT.displayBold, { letterSpacing: "-0.018em", lineHeight: 1.12 }), ...oneLine, opacity: a, transform: `translateY(${r1((1 - a) * 14)}px)` }}>{title}</div> : null}
      {subtitle ? <div style={{ ...tx(34, T.muted), marginTop: title ? 6 : 0, ...oneLine, opacity: b, transform: `translateY(${r1((1 - b) * 10)}px)` }}>{subtitle}</div> : null}
    </div>
  );
}
function headH(title?: string | null, subtitle?: string | null): number {
  return title ? (subtitle ? 104 : 62) : subtitle ? 40 : 0;
}

function accentOf(T: Tone, ctx: GCtx): string {
  return T.dark ? ctx.p.primary : T.solid;
}

function Shell({ T, children, radius = 44, style }: { T: Tone; children: ReactNode; radius?: number; style?: CSSProperties }) {
  return <div style={{ ...fill, ...card(T, radius), overflow: "hidden", ...style }}>{children}</div>;
}

function polyLens(pts: Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  return out;
}
function polyAt(pts: Pt[], t: number): Pt & { ang: number } {
  const L = polyLens(pts);
  const total = L[L.length - 1]!;
  const d = clamp01(t) * total;
  for (let i = 1; i < pts.length; i++) {
    if (d <= L[i]! || i === pts.length - 1) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const seg = Math.max(1e-6, L[i]! - L[i - 1]!);
      const u = clamp01((d - L[i - 1]!) / seg);
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, ang: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI };
    }
  }
  return { x: pts[0]?.x ?? 0, y: pts[0]?.y ?? 0, ang: 0 };
}
function polyD(pts: Pt[]): string {
  return pts.map((p, i) => `${i ? "L" : "M"}${r1(p.x)} ${r1(p.y)}`).join(" ");
}

/** The classic map pin (tip at (size/2, size·1.25)). */
function PinGlyph({ color, size, ring = "#FFFFFF" }: { color: string; size: number; ring?: string }) {
  const id = sid(useId());
  return (
    <svg width={size} height={size * 1.3} viewBox="0 0 48 62" style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id={`pg${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={mix(color, "#FFFFFF", 0.28)} />
          <stop offset="1" stopColor={mix(color, "#000000", 0.18)} />
        </linearGradient>
      </defs>
      <path d="M24 60C24 60 5 38.5 5 23.5A19 19 0 0 1 43 23.5C43 38.5 24 60 24 60Z" fill={`url(#pg${id})`} stroke={ring} strokeWidth={2.5} />
      <circle cx={24} cy={23.5} r={7.5} fill="#FFFFFF" />
    </svg>
  );
}

/** A top-view plane silhouette pointing right (+x). */
const PLANE_D = "M22 12C22 11 21 10.6 20 10.6L14.5 10.6L9.5 3.5L7.4 3.5L10.4 10.6L5.6 10.6L3.9 8.3L2.4 8.3L3.4 12L2.4 15.7L3.9 15.7L5.6 13.4L10.4 13.4L7.4 20.5L9.5 20.5L14.5 13.4L20 13.4C21 13.4 22 13 22 12Z";
function Plane({ size, color, angle = 0, style }: { size: number; color: string; angle?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block", overflow: "visible", transform: `rotate(${r1(angle)}deg)`, ...style }}>
      <path d={PLANE_D} fill={color} />
    </svg>
  );
}

/** A filled star (ratings). */
function Star({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block" }}>
      <path d="M12 2.8l2.75 5.6 6.15.9-4.45 4.33 1.05 6.12L12 16.87l-5.5 2.88 1.05-6.12L3.1 9.3l6.15-.9z" fill={color} />
    </svg>
  );
}

/** Deterministic barcode-like stripes as one path (w × h). */
function barcodePath(w: number, h: number, seed: number, vertical = false): string {
  let x = 0;
  let d = "";
  let i = 0;
  while (x < w - 2) {
    const bw = 2 + Math.floor(hash01(seed + i * 3.7) * 4) * 2;
    const gap = 3 + Math.floor(hash01(seed + i * 5.3 + 1) * 3) * 2;
    const ww = Math.min(bw, w - x);
    d += vertical ? `M0 ${r1(x)}h${r1(h)}v${r1(ww)}h${-r1(h)}Z` : `M${r1(x)} 0h${r1(ww)}v${r1(h)}h${-r1(ww)}Z`;
    x += bw + gap;
    i++;
  }
  return d;
}

/** "6h 42m" → 402 (minutes); null when it isn't a duration. */
function parseHM(s: string | null | undefined): number | null {
  const m = /^\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*$/i.exec(s ?? "");
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}
function fmtHM(mins: number): string {
  const t = Math.max(0, Math.round(mins));
  const h = Math.floor(t / 60);
  const m = t % 60;
  return h > 0 ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

// ===================================================================== maps (original art)

interface MapLook {
  bg: string;
  minor: string;
  major: string;
  avenue: string;
  park: string;
  water: string;
}
function mapLook(T: Tone): MapLook {
  return T.dark
    ? { bg: "#1A1B23", minor: "#252733", major: "#2E3140", avenue: "#383C4E", park: "#1B2E25", water: "#15233A" }
    : { bg: "#E8EBEF", minor: "#F6F7F9", major: "#FFFFFF", avenue: "#FFFFFF", park: "#CFE8D6", water: "#C2DBF2" };
}

function projector(w: number, h: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return (u: number, v: number): Pt => {
    const x = (u - 0.5) * w;
    const y = (v - 0.5) * h;
    return { x: w / 2 + x * c - y * s, y: h / 2 + x * s + y * c };
  };
}
const MAP_U = [-0.5, -0.26, -0.02, 0.22, 0.46, 0.7, 0.94, 1.18, 1.42];
const MAP_V = [-0.46, -0.1, 0.26, 0.54, 0.82, 1.16, 1.52];

/** An abstract street grid: blocks, minor + major streets, an avenue, a park and some water. */
function StreetMap({ T, w, h, angle, t, water = [-0.05, -0.12], park = [0.7, 0.54], children }: { T: Tone; w: number; h: number; angle: number; t: number; water?: [number, number]; park?: [number, number]; children?: ReactNode }) {
  const L = mapLook(T);
  const P = projector(w, h, angle);
  const seg = (a: Pt, b: Pt) => `M${r1(a.x)} ${r1(a.y)}L${r1(b.x)} ${r1(b.y)}`;
  const lo = -0.7;
  const hi = 1.7;
  const minorU = MAP_U.slice(1).map((u, i) => (u + MAP_U[i]!) / 2);
  const minorV = MAP_V.slice(1).map((v, i) => (v + MAP_V[i]!) / 2);
  const minor = [...minorU.map((u) => seg(P(u, lo), P(u, hi))), ...minorV.map((v) => seg(P(lo, v), P(hi, v)))].join("");
  const major = [...MAP_U.map((u) => seg(P(u, lo), P(u, hi))), ...MAP_V.map((v) => seg(P(lo, v), P(hi, v)))].join("");
  const [pu, pv] = park;
  const ui = MAP_U.findIndex((u) => u >= pu - 1e-6);
  const vi = MAP_V.findIndex((v) => v >= pv - 1e-6);
  const u2 = MAP_U[Math.min(MAP_U.length - 1, ui + 1)]!;
  const v2 = MAP_V[Math.min(MAP_V.length - 1, vi + 1)]!;
  const e = 0.028;
  const parkPts = [P(pu + e, pv + e * 1.6), P(u2 - e, pv + e * 1.6), P(u2 - e, v2 - e * 1.6), P(pu + e, v2 - e * 1.6)];
  const wc = P(water[0], water[1]);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: "absolute", left: 0, top: 0, overflow: "hidden", opacity: t, transform: `scale(${r4(1.05 - 0.05 * t)})` }}>
      <rect x={0} y={0} width={w} height={h} fill={L.bg} />
      <path d={minor} stroke={L.minor} strokeWidth={7} fill="none" />
      <polygon points={parkPts.map((p) => `${r1(p.x)},${r1(p.y)}`).join(" ")} fill={L.park} stroke={L.park} strokeWidth={14} strokeLinejoin="round" />
      <path d={major} stroke={L.major} strokeWidth={17} fill="none" />
      <path d={seg(P(-0.3, 1.32), P(1.3, -0.18))} stroke={L.avenue} strokeWidth={26} fill="none" />
      <circle cx={r1(wc.x)} cy={r1(wc.y)} r={r1(Math.max(w, h) * 0.3)} fill={L.water} />
      {children}
    </svg>
  );
}

/** A soft dotted "world" (abstract landmasses, not a real map). */
const WORLD_BLOBS = [
  "ellipse 20% 24% at 20% 38%",
  "ellipse 11% 17% at 29% 74%",
  "ellipse 24% 20% at 60% 32%",
  "ellipse 10% 15% at 55% 66%",
  "ellipse 13% 10% at 84% 72%",
  "ellipse 15% 13% at 82% 42%",
  "ellipse 8% 8% at 42% 18%",
];
function WorldDots({ T, w, h, t, shift = 0 }: { T: Tone; w: number; h: number; t: number; shift?: number }) {
  const mask = WORLD_BLOBS.map((b) => {
    const m = /at (\d+)% (\d+)%/.exec(b)!;
    const x = (Number(m[1]) + shift * 37) % 100;
    return `radial-gradient(${b.replace(/at \d+%/, `at ${x}%`)}, #000 50%, transparent 100%)`;
  }).join(", ");
  const dot = T.dark ? rgba("#FFFFFF", 0.3) : rgba("#1A1A22", 0.26);
  const faint = T.dark ? rgba("#FFFFFF", 0.06) : rgba("#1A1A22", 0.06);
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: w, height: h, opacity: t, transform: `scale(${r4(1.03 - 0.03 * t)})` }}>
      <div style={{ ...fill, backgroundImage: `radial-gradient(circle, ${faint} 2px, transparent 2.8px)`, backgroundSize: "24px 24px" }} />
      <div style={{ ...fill, backgroundImage: `radial-gradient(circle, ${dot} 2.8px, transparent 3.6px)`, backgroundSize: "24px 24px", WebkitMaskImage: mask, maskImage: mask }} />
    </div>
  );
}

// ===================================================================== MAP_NAV

function MapNav({ ctx }: C) {
  switch (ctx.variant) {
    case "PIN":
      return <MapPinDrop ctx={ctx} />;
    case "FLIGHT":
      return <MapFlight ctx={ctx} />;
    case "CITIES":
      return <MapCities ctx={ctx} />;
    default:
      return <MapRoute ctx={ctx} />;
  }
}

const ROUTE_UV: Array<[number, number]> = [
  [0.22, 0.82],
  [0.46, 0.82],
  [0.46, 0.54],
  [0.7, 0.54],
  [0.7, 0.26],
];

function RouteLine({ pts, t, color, casing }: { pts: Pt[]; t: number; color: string; casing: string }) {
  const d = polyD(pts);
  const dash = t >= 0.999 ? undefined : "1 1";
  const off = t >= 0.999 ? undefined : r4(1 - t);
  return (
    <g>
      <path d={d} fill="none" stroke={casing} strokeWidth={22} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={dash} strokeDashoffset={off} />
      <path d={d} fill="none" stroke={color} strokeWidth={12} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={dash} strokeDashoffset={off} />
    </g>
  );
}

function MapRoute({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const pad = 22;
  const bottomH = 300;
  const mw = W - 2 * pad;
  const mh = H - 2 * pad - bottomH;
  const { at, len } = clock(ctx, 3.0);
  const acc = accentOf(T, ctx);
  const mapT = inAt(ctx, 0, len(0.6));
  const P = projector(mw, mh, -6);
  const pts = ROUTE_UV.map(([u, v]) => P(u, v));
  const r0 = at(0.45);
  const rl = len(1.5);
  const rt = prog(frame, r0, rl, EASE_IN_OUT);
  const headPt = polyAt(pts, rt);
  const start = pts[0]!;
  const end = pts[pts.length - 1]!;
  const pinAt = r0 + rl - len(0.25);
  const drop = springAt(frame, fps, pinAt, ctx.f.springs.punch, len(0.7));
  const pinO = prog(frame, pinAt, 4);
  const startO = inAt(ctx, r0 - len(0.15), len(0.3));
  const pulse = ((frame / fps) * 0.9) % 1;
  const eta = (props.subtitle ?? "").split("·")[0]!.trim();
  const etaT = inAt(ctx, r0 + rl, len(0.35));
  const pinS = 64;
  const items = props.items.slice(0, 2);
  const by = pad + mh + 30;
  const goAt = at(2.55);
  const goPress = pressAt(ctx, goAt, len(0.25));
  const goRip = clamp01((frame - goAt) / len(0.5));
  const nEl = 3 + items.length;
  const etaW = eta ? Math.min(260, textW(eta, 30) + 40) : 0;
  return (
    <Shell T={T}>
      <div style={{ position: "absolute", left: pad, top: pad, width: mw, height: mh, borderRadius: 30, overflow: "hidden", transform: "translateZ(0)" }}>
        <StreetMap T={T} w={mw} h={mh} angle={-6} t={mapT}>
          <RouteLine pts={pts} t={rt} color={acc} casing={T.dark ? rgba("#FFFFFF", 0.9) : "#FFFFFF"} />
          <g opacity={startO}>
            <circle cx={r1(start.x)} cy={r1(start.y)} r={17} fill="#FFFFFF" />
            <circle cx={r1(start.x)} cy={r1(start.y)} r={10} fill={acc} />
          </g>
          {rt > 0.001 && rt < 0.999 ? (
            <g>
              <circle cx={r1(headPt.x)} cy={r1(headPt.y)} r={r1(18 + 22 * pulse)} fill={rgba(acc, 0.28 * (1 - pulse))} />
              <circle cx={r1(headPt.x)} cy={r1(headPt.y)} r={15} fill="#FFFFFF" />
              <circle cx={r1(headPt.x)} cy={r1(headPt.y)} r={9} fill={acc} />
            </g>
          ) : null}
        </StreetMap>
        <div style={{ position: "absolute", left: end.x - pinS / 2, top: end.y - pinS * 1.25, opacity: pinO, transform: `translateY(${r1((1 - drop) * -90)}px)`, transformOrigin: "50% 100%", filter: `drop-shadow(0 8px 10px ${rgba("#000000", 0.35)})` }}>
          <PinGlyph color={acc} size={pinS} />
        </div>
        {eta ? (
          <div style={{ position: "absolute", left: Math.min(mw - etaW - 16, end.x + 34), top: end.y - pinS * 1.25 - 4, height: 56, width: etaW, boxSizing: "border-box", borderRadius: 28, background: T.dark ? "#FFFFFF" : "#15151C", color: T.dark ? "#111116" : "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", ...tx(fitLine(eta, etaW - 32, 30, 28), T.dark ? "#111116" : "#FFFFFF", FONT.displayBold), opacity: etaT, transform: `translateX(${r1((1 - etaT) * -14)}px)`, boxShadow: `0 10px 24px ${rgba("#000000", 0.3)}` }}>
            <span style={oneLine}>{eta}</span>
          </div>
        ) : null}
      </div>
      <div style={{ position: "absolute", left: 44, top: by, width: W - 88 - 150, ...el(ctx, at(0.15), len(0.5), 0, nEl) }}>
        {props.title ? <div style={{ ...tx(fitLine(props.title, W - 88 - 150, 50, 34), T.ink, FONT.displayBold, { letterSpacing: "-0.015em" }), ...oneLine }}>{props.title}</div> : null}
        {props.subtitle ? <div style={{ ...tx(34, T.accent, FONT.display), marginTop: 4, ...oneLine }}>{props.subtitle}</div> : null}
      </div>
      <div style={{ position: "absolute", right: 44, top: by + 4, width: 120, height: 120, ...el(ctx, at(0.6), len(0.5), 1, nEl, { style: "POP" }) }}>
        <div style={{ ...fill, borderRadius: 60, border: `3px solid ${rgba(acc, 0.6 * (1 - goRip))}`, transform: `scale(${r4(1 + goRip * 0.35)})`, opacity: goRip > 0 && goRip < 1 ? 1 : 0 }} />
        <div style={{ ...fill, borderRadius: 60, background: T.solid, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${r4(1 - 0.1 * goPress)})`, boxShadow: `0 14px 30px ${rgba(T.solid, 0.4)}` }}>
          <span style={tx(38, T.onSolid, FONT.displayBold, { letterSpacing: "0.02em" })}>GO</span>
        </div>
      </div>
      {items.map((it, i) => {
        const y = by + 128 + i * 74;
        const line = `${it.text}`;
        return (
          <div key={i} style={{ position: "absolute", left: 44, top: y, width: W - 88, height: 60, display: "flex", alignItems: "center", gap: 22, ...el(ctx, at(0.35 + 0.15 * i), len(0.45), 2 + i, nEl, { style: "SLIDE" }) }}>
            <div style={{ width: 26, height: 26, flex: "none", borderRadius: i === 0 ? 13 : 7, boxSizing: "border-box", border: i === 0 ? `5px solid ${T.muted}` : "none", background: i === 0 ? "transparent" : acc }} />
            <span style={{ ...tx(fitLine(line, W - 88 - 48 - (it.sub ? Math.min(300, textW(it.sub, 30)) + 20 : 0), 36, 30), T.ink, FONT.display), ...oneLine }}>{line}</span>
            {it.sub ? <span style={{ ...tx(30, T.muted), ...oneLine, marginLeft: "auto", maxWidth: 320 }}>{it.sub}</span> : null}
          </div>
        );
      })}
      {items.length === 2 ? <div style={{ position: "absolute", left: 44 + 11, top: by + 128 + 30 + 18, width: 4, height: 74 - 36, borderRadius: 2, background: `repeating-linear-gradient(180deg, ${T.faint} 0 6px, transparent 6px 12px)`, opacity: inAt(ctx, at(0.5), len(0.4)) }} /> : null}
    </Shell>
  );
}

function MapPinDrop({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const { at, len } = clock(ctx, 2.2);
  const acc = accentOf(T, ctx);
  const mapT = inAt(ctx, 0, len(0.6));
  const cx = W / 2;
  const cy = H * 0.47;
  const pinS = 116;
  const dropAt = at(0.35);
  const drop = springAt(frame, fps, dropAt, ctx.f.springs.punch, len(0.8));
  const pinO = prog(frame, dropAt, 4);
  const land = dropAt + len(0.22);
  const age = (frame - land) / fps;
  const title = props.title ?? "";
  const sub = props.subtitle ?? "";
  const tSize = title ? fitLine(title, W - 160, 52, 34) : 0;
  const cardW = Math.min(W - 80, Math.max(title ? textW(title, tSize) : 0, sub ? Math.min(W - 160, textW(sub, 32)) : 0) + 88);
  const cardH = title && sub ? 148 : 104;
  const cardS = el(ctx, at(1.0), len(0.5), 1, 2);
  return (
    <Shell T={T}>
      <StreetMap T={T} w={W} h={H} angle={9} t={mapT} water={[1.08, 1.12]} park={[0.22, 0.26]} />
      <div style={{ ...fill, background: T.dark ? `radial-gradient(ellipse 70% 60% at 50% 45%, transparent 40%, ${rgba("#0B0B10", 0.55)} 100%)` : `radial-gradient(ellipse 70% 60% at 50% 45%, transparent 45%, ${rgba("#FFFFFF", 0.4)} 100%)` }} />
      {age > 0
        ? [0, 1, 2].map((k) => {
            const s = (age * 0.75 + k / 3) % 1;
            const first = age * 0.75 < k / 3 ? 0 : 1;
            return <div key={k} style={{ position: "absolute", left: cx - 130, top: cy - 48, width: 260, height: 96, borderRadius: "50%", border: `4px solid ${rgba(acc, 0.75 * (1 - s) * first)}`, background: rgba(acc, 0.1 * (1 - s) * first), transform: `scale(${r4(0.2 + 1.1 * s)})` }} />;
          })
        : null}
      <div style={{ position: "absolute", left: cx - 34, top: cy - 12, width: 68, height: 24, borderRadius: "50%", background: rgba("#000000", 0.35), filter: "blur(5px)", opacity: pinO * clamp01(drop), transform: `scale(${r4(0.4 + 0.6 * clamp01(drop))})` }} />
      <div style={{ position: "absolute", left: cx - pinS / 2, top: cy - pinS * 1.25, opacity: pinO, transform: `translateY(${r1((1 - drop) * -300)}px)`, transformOrigin: "50% 100%" }}>
        <PinGlyph color={acc} size={pinS} />
      </div>
      {title || sub ? (
        <div style={{ position: "absolute", left: (W - cardW) / 2, top: H - 44 - cardH, width: cardW, height: cardH, boxSizing: "border-box", padding: "0 44px", borderRadius: 34, ...card(T, 34), display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", ...cardS }}>
          {title ? <div style={{ ...tx(tSize, T.ink, FONT.displayBold, { letterSpacing: "-0.015em" }), ...oneLine, maxWidth: "100%" }}>{title}</div> : null}
          {sub ? <div style={{ ...tx(32, T.muted), ...oneLine, maxWidth: "100%", marginTop: title ? 6 : 0 }}>{sub}</div> : null}
        </div>
      ) : null}
    </Shell>
  );
}

function codeOf(it: Item | undefined, fallback: string): string {
  if (!it) return fallback;
  return (it.sub?.trim() || it.text.trim().slice(0, 3).toUpperCase() || fallback).slice(0, 5);
}

function MapFlight({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame } = ctx;
  const W = ctx.width;
  const { at, len } = clock(ctx, 2.8);
  const acc = accentOf(T, ctx);
  const hH = props.title ? 96 : 0;
  const mx = 24;
  const my = 24 + hH;
  const mw = W - 48;
  const mh = 420;
  const mapT = inAt(ctx, 0, len(0.6));
  const A = { x: 0.15 * mw, y: 0.66 * mh };
  const B = { x: 0.85 * mw, y: 0.52 * mh };
  const Cq = { x: (A.x + B.x) / 2, y: 0.0 * mh - 20 };
  const q = (u: number) => ({ x: (1 - u) ** 2 * A.x + 2 * (1 - u) * u * Cq.x + u * u * B.x, y: (1 - u) ** 2 * A.y + 2 * (1 - u) * u * Cq.y + u * u * B.y });
  const qd = (u: number) => ({ x: 2 * (1 - u) * (Cq.x - A.x) + 2 * u * (B.x - Cq.x), y: 2 * (1 - u) * (Cq.y - A.y) + 2 * u * (B.y - Cq.y) });
  const a0 = at(0.55);
  const al = len(1.7);
  const ft = prog(frame, a0, al, EASE_IN_OUT);
  const pl = q(ft);
  const tg = qd(ft);
  const ang = (Math.atan2(tg.y, tg.x) * 180) / Math.PI;
  const d = `M${r1(A.x)} ${r1(A.y)} Q${r1(Cq.x)} ${r1(Cq.y)} ${r1(B.x)} ${r1(B.y)}`;
  const dotA = inAt(ctx, at(0.3), len(0.35));
  const dotB = inAt(ctx, a0 + al - len(0.1), len(0.35));
  const pulse = ((frame / ctx.fps) * 0.8) % 1;
  const from = props.items[0];
  const to = props.items[1];
  const cA = codeOf(from, "LAX");
  const cB = codeOf(to, "JFK");
  const by = my + mh + 40;
  const codeS = Math.min(fitLine(cA, 280, 104, 60), fitLine(cB, 280, 104, 60));
  const colW = Math.max(textW(cA, codeS), textW(cB, codeS), 200);
  const midL = 44 + colW + 30;
  const midR = W - 44 - colW - 30;
  const midW = Math.max(60, midR - midL);
  const nEl = 3;
  const ink = T.dark ? "#FFFFFF" : "#15151C";
  return (
    <Shell T={T}>
      <Head ctx={ctx} T={T} x={44} y={40} w={W - 88} title={props.title} />
      <div style={{ position: "absolute", left: mx, top: my, width: mw, height: mh, borderRadius: 30, overflow: "hidden", background: T.dark ? rgba("#FFFFFF", 0.035) : "#F1F2F5" }}>
        <WorldDots T={T} w={mw} h={mh} t={mapT} />
        <svg width={mw} height={mh} viewBox={`0 0 ${mw} ${mh}`} style={{ position: "absolute", inset: 0, overflow: "visible", opacity: mapT }}>
          <path d={d} fill="none" stroke={T.dark ? rgba("#FFFFFF", 0.22) : rgba("#15151C", 0.18)} strokeWidth={4} strokeDasharray="3 13" strokeLinecap="round" />
          <path d={d} fill="none" stroke={acc} strokeWidth={6} strokeLinecap="round" pathLength={1} strokeDasharray={ft >= 0.999 ? undefined : "1 1"} strokeDashoffset={ft >= 0.999 ? undefined : r4(1 - ft)} />
          {[
            { p: A, t: dotA },
            { p: B, t: dotB },
          ].map((o, i) => (
            <g key={i} opacity={o.t}>
              <circle cx={r1(o.p.x)} cy={r1(o.p.y)} r={r1(14 + 24 * pulse)} fill={rgba(acc, 0.3 * (1 - pulse) * o.t)} />
              <circle cx={r1(o.p.x)} cy={r1(o.p.y)} r={r1(14 * o.t)} fill="#FFFFFF" />
              <circle cx={r1(o.p.x)} cy={r1(o.p.y)} r={r1(8 * o.t)} fill={acc} />
            </g>
          ))}
        </svg>
        {ft > 0.001 ? (
          <div style={{ position: "absolute", left: pl.x - 34, top: pl.y - 34, width: 68, height: 68, opacity: ft >= 0.999 ? 1 - clamp01((frame - a0 - al) / len(0.3)) : clamp01(ft * 8), filter: `drop-shadow(0 8px 10px ${rgba("#000000", 0.35)})` }}>
            <Plane size={68} color={ink} angle={ang} />
          </div>
        ) : null}
      </div>
      <div style={{ position: "absolute", left: 44, top: by, width: colW, ...el(ctx, at(0.2), len(0.5), 0, nEl) }}>
        <div style={{ ...tx(codeS, T.ink, FONT.displayBold, { letterSpacing: "-0.02em", lineHeight: 1 }), ...oneLine }}>{cA}</div>
        <div style={{ ...tx(32, T.muted), ...oneLine, marginTop: 10 }}>{from?.text ?? ""}</div>
      </div>
      <div style={{ position: "absolute", right: 44, top: by, width: colW, textAlign: "right", ...el(ctx, at(0.35), len(0.5), 2, nEl) }}>
        <div style={{ ...tx(codeS, T.ink, FONT.displayBold, { letterSpacing: "-0.02em", lineHeight: 1 }), ...oneLine }}>{cB}</div>
        <div style={{ ...tx(32, T.muted), ...oneLine, marginTop: 10 }}>{to?.text ?? ""}</div>
      </div>
      <div style={{ position: "absolute", left: midL, top: by + 4, width: midW, height: 100, display: "flex", flexDirection: "column", alignItems: "center", ...el(ctx, at(0.5), len(0.5), 1, nEl, { style: "FADE" }) }}>
        <div style={{ position: "relative", width: "100%", height: 52 }}>
          <div style={{ position: "absolute", left: 0, right: 0, top: 25, height: 3, background: `repeating-linear-gradient(90deg, ${T.faint} 0 8px, transparent 8px 16px)` }} />
          <div style={{ position: "absolute", left: "50%", top: 2, width: 48, height: 48, marginLeft: -24, borderRadius: 24, background: T.surface, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Plane size={40} color={T.accent} />
          </div>
        </div>
        {props.subtitle ? <div style={{ ...tx(fitLine(props.subtitle, midW, 30, 28), T.muted, FONT.display), ...oneLine, maxWidth: "100%", marginTop: 6 }}>{props.subtitle}</div> : null}
      </div>
    </Shell>
  );
}

function MapCities({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const stops = props.items.slice(0, 5);
  const n = Math.max(1, stops.length);
  const { at, len } = clock(ctx, 0.9 + 0.62 * (n - 1) + 0.5);
  const acc = accentOf(T, ctx);
  const hh = headH(props.title, props.subtitle);
  const mx = 24;
  const my = hh ? 40 + hh + 24 : 24;
  const mw = W - 48;
  const mh = H - my - 24;
  const mapT = inAt(ctx, 0, len(0.6));
  const pos: Pt[] = stops.map((_, i) => ({
    x: n === 1 ? mw / 2 : mw * (0.12 + (0.76 * i) / (n - 1)),
    y: mh * (n === 1 ? 0.5 : (i % 2 === 0 ? 0.6 : 0.36) + (hash01(i + 4) - 0.5) * 0.06),
  }));
  const segs = pos.slice(1).map((b, i) => {
    const a = pos[i]!;
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 60 };
    return { d: `M${r1(a.x)} ${r1(a.y)} Q${r1(c.x)} ${r1(c.y)} ${r1(b.x)} ${r1(b.y)}`, a, b, c };
  });
  const base = at(0.6);
  const segL = len(0.62);
  const spacing = n > 1 ? (0.76 * mw) / (n - 1) : mw;
  const labelW = Math.min(360, n > 2 ? spacing * 2 - 24 : mw * 0.42);
  const pulse = ((frame / fps) * 0.8) % 1;
  return (
    <Shell T={T}>
      <Head ctx={ctx} T={T} x={44} y={40} w={W - 88} title={props.title} subtitle={props.subtitle} />
      <div style={{ position: "absolute", left: mx, top: my, width: mw, height: mh, borderRadius: 30, overflow: "hidden", background: T.dark ? rgba("#FFFFFF", 0.035) : "#F1F2F5" }}>
        <WorldDots T={T} w={mw} h={mh} t={mapT} shift={1} />
        <svg width={mw} height={mh} viewBox={`0 0 ${mw} ${mh}`} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          {segs.map((s, i) => {
            const t = prog(frame, base + i * segL, segL, EASE_IN_OUT);
            return (
              <g key={i}>
                <path d={s.d} fill="none" stroke={T.dark ? rgba("#FFFFFF", 0.14) : rgba("#15151C", 0.12)} strokeWidth={4} strokeDasharray="3 12" strokeLinecap="round" opacity={mapT} />
                <path d={s.d} fill="none" stroke={acc} strokeWidth={6} strokeLinecap="round" pathLength={1} strokeDasharray={t >= 0.999 ? undefined : "1 1"} strokeDashoffset={t >= 0.999 ? undefined : r4(1 - t)} />
                {t > 0.001 && t < 0.999 ? (() => {
                  const u = t;
                  const p = { x: (1 - u) ** 2 * s.a.x + 2 * (1 - u) * u * s.c.x + u * u * s.b.x, y: (1 - u) ** 2 * s.a.y + 2 * (1 - u) * u * s.c.y + u * u * s.b.y };
                  return <circle cx={r1(p.x)} cy={r1(p.y)} r={10} fill="#FFFFFF" stroke={acc} strokeWidth={5} />;
                })() : null}
              </g>
            );
          })}
        </svg>
        {stops.map((it, i) => {
          const p = pos[i]!;
          const s0 = i === 0 ? base - len(0.3) : base + i * segL - len(0.06);
          const pop = springAt(frame, fps, s0, ctx.f.springs.soft, len(0.6));
          const o = prog(frame, s0, 4);
          const above = n > 1 && i % 2 === 1;
          const lw = labelW;
          const lx = Math.max(8, Math.min(mw - lw - 8, p.x - lw / 2));
          const ts = fitLine(it.text, lw, 36, 28);
          const lab = inAt(ctx, s0 + 3, len(0.4));
          const last = i === stops.length - 1;
          return (
            <div key={i}>
              {last && frame > s0 + len(0.4) ? <div style={{ position: "absolute", left: p.x - 30, top: p.y - 30, width: 60, height: 60, borderRadius: 30, border: `3px solid ${rgba(acc, 0.7 * (1 - pulse))}`, transform: `scale(${r4(0.8 + pulse * 0.9)})` }} /> : null}
              <div style={{ position: "absolute", left: p.x - 26, top: p.y - 26, width: 52, height: 52, borderRadius: 26, background: acc, boxShadow: `0 0 0 5px ${T.dark ? "#1A1B23" : "#FFFFFF"}, 0 10px 22px ${rgba("#000000", 0.3)}`, display: "flex", alignItems: "center", justifyContent: "center", opacity: o, transform: `scale(${r4(Math.max(0, pop))})` }}>
                <span style={tx(28, onFill(acc), FONT.displayBold)}>{i + 1}</span>
              </div>
              <div style={{ position: "absolute", left: lx, top: above ? p.y - 44 - 86 : p.y + 44, width: lw, textAlign: "center", opacity: lab, transform: `translateY(${r1((1 - lab) * (above ? 10 : -10))}px)` }}>
                <div style={{ ...tx(ts, T.ink, FONT.displayBold, { letterSpacing: "-0.01em" }), ...oneLine }}>{it.text}</div>
                {it.sub ? <div style={{ ...tx(28, T.muted), ...oneLine, marginTop: 4 }}>{it.sub}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

// ===================================================================== WEATHER

type Sky = [string, string];
function skyOf(icon: GraphicIcon | null, dark: boolean): Sky {
  switch (icon) {
    case "CLOUD":
      return dark ? ["#2B3546", "#141A25"] : ["#6F86A2", "#A6B7CB"];
    case "RAIN":
    case "STORM":
      return dark ? ["#212A39", "#0F131B"] : ["#4E5E74", "#7D8EA3"];
    case "SNOW":
      return dark ? ["#2C3A52", "#141C2B"] : ["#7F9AB8", "#BCCCDF"];
    case "MOON":
      return dark ? ["#16204A", "#070A1A"] : ["#25336A", "#4A5D97"];
    default:
      return dark ? ["#24477F", "#101E3B"] : ["#3D8BDB", "#82BFF2"];
  }
}

function CloudShape({ w, x, y, shade = 0, id }: { w: number; x: number; y: number; shade?: number; id: string }) {
  const s = w / 100;
  const top = mix("#FFFFFF", "#9AA6B8", shade);
  const bot = mix("#DCE3EC", "#6E7B90", shade);
  return (
    <g transform={`translate(${r1(x)} ${r1(y)}) scale(${r4(s)})`}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={top} />
          <stop offset="1" stopColor={bot} />
        </linearGradient>
      </defs>
      <path d="M24 62 A18 18 0 0 1 22.5 26.1 A26 26 0 0 1 72.6 22.4 A20 20 0 0 1 78 62 Z" fill={`url(#${id})`} />
    </g>
  );
}

/** Large filled weather art (original), gently animated. */
function WeatherArt({ ctx, icon, size }: { ctx: GCtx; icon: GraphicIcon | null; size: number }) {
  const id = sid(useId());
  const s = ctx.frame / ctx.fps;
  const sunG = (
    <defs>
      <radialGradient id={`sun${id}`} cx="0.4" cy="0.35" r="0.7">
        <stop offset="0" stopColor="#FFE58A" />
        <stop offset="1" stopColor="#FFB23E" />
      </radialGradient>
    </defs>
  );
  const sun = (cx: number, cy: number, r: number) => (
    <g>
      <g transform={`rotate(${r1(s * 14)} ${cx} ${cy})`}>
        {Array.from({ length: 8 }, (_, i) => {
          const a = (i / 8) * Math.PI * 2;
          return <line key={i} x1={r1(cx + Math.cos(a) * r * 1.35)} y1={r1(cy + Math.sin(a) * r * 1.35)} x2={r1(cx + Math.cos(a) * r * 1.7)} y2={r1(cy + Math.sin(a) * r * 1.7)} stroke="#FFC94D" strokeWidth={r * 0.16} strokeLinecap="round" />;
        })}
      </g>
      <circle cx={cx} cy={cy} r={r * 1.18} fill={rgba("#FFD36B", 0.25)} />
      <circle cx={cx} cy={cy} r={r} fill={`url(#sun${id})`} />
    </g>
  );
  const drift = Math.sin(s * 1.2) * 4;
  const v = 100;
  let body: ReactNode;
  switch (icon) {
    case "CLOUD":
      body = (
        <>
          {sun(64, 34, 16)}
          <CloudShape w={62} x={30 + drift * 0.5} y={20} shade={0.25} id={`c1${id}`} />
          <CloudShape w={78} x={6 - drift * 0.4} y={40} id={`c2${id}`} />
        </>
      );
      break;
    case "RAIN":
    case "STORM":
    case "SNOW": {
      const drops = Array.from({ length: 6 }, (_, i) => {
        const ph = (s * (icon === "SNOW" ? 0.6 : 1.4) + hash01(i + 2)) % 1;
        const x = 22 + i * 11 + (icon === "SNOW" ? Math.sin(s * 2 + i) * 2 : 0);
        const y = 74 + ph * 24;
        return icon === "SNOW" ? <circle key={i} cx={r1(x)} cy={r1(y)} r={2.6} fill="#FFFFFF" opacity={r4(1 - ph)} /> : <line key={i} x1={r1(x)} y1={r1(y)} x2={r1(x - 2.5)} y2={r1(y + 7)} stroke="#9CCBFF" strokeWidth={3} strokeLinecap="round" opacity={r4(1 - ph)} />;
      });
      const flash = icon === "STORM" ? (Math.floor(s * 3) % 4 === 0 ? 1 : 0.55) : 0;
      body = (
        <>
          {drops}
          <CloudShape w={86} x={7 + drift * 0.4} y={14} shade={icon === "SNOW" ? 0.1 : 0.4} id={`c1${id}`} />
          {icon === "STORM" ? <path d="M54 62 L44 80 L52 80 L46 96 L62 74 L54 74 L60 62 Z" fill="#FFD34D" opacity={flash} /> : null}
        </>
      );
      break;
    }
    case "MOON":
      body = (
        <>
          <mask id={`m${id}`}>
            <rect x={0} y={0} width={100} height={100} fill="#FFFFFF" />
            <circle cx={64} cy={38} r={30} fill="#000000" />
          </mask>
          <circle cx={50} cy={50} r={32} fill="#F4F1E4" mask={`url(#m${id})`} />
          {[0, 1, 2].map((i) => (
            <circle key={i} cx={[80, 72, 88][i]} cy={[66, 82, 50][i]} r={[2.4, 1.8, 1.6][i]} fill="#FFFFFF" opacity={0.5 + 0.5 * Math.abs(Math.sin(s * 1.5 + i))} />
          ))}
        </>
      );
      break;
    default:
      body = sun(50, 50, 24);
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${v} ${v}`} style={{ display: "block", overflow: "visible" }}>
      {sunG}
      {body}
    </svg>
  );
}

function weatherTint(icon: GraphicIcon | null, T: Tone): string {
  switch (icon) {
    case "SUN":
      return "#F5B83D";
    case "RAIN":
    case "STORM":
      return T.dark ? "#7DB8FF" : "#3D84D6";
    case "SNOW":
      return T.dark ? "#CFE3FF" : "#6E8FB8";
    case "MOON":
      return T.dark ? "#C9C3FF" : "#6B63C9";
    default:
      return T.muted;
  }
}

function deg(v: number): string {
  return `${Math.round(v)}°`;
}

function Weather({ ctx }: C) {
  return ctx.variant === "WEEK" ? <WeatherWeek ctx={ctx} /> : <WeatherCard ctx={ctx} />;
}

function WeatherCard({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const now = props.items[0];
  const hours = props.items.slice(1, 7);
  const icon = now?.icon ?? "SUN";
  const [s1, s2] = skyOf(icon, T.dark);
  const { at, len } = clock(ctx, 1.6 + hours.length * 0.08);
  const temp = now?.value ?? null;
  const shown = temp != null ? counted(ctx, at(0.25), temp, Math.round(temp * 0.6)) : 0;
  const shadow = `0 2px 12px ${rgba("#000000", 0.22)}`;
  const artIn = springAt(frame, ctx.fps, at(0.15), ctx.f.springs.soft, len(0.8));
  const nEl = 4 + hours.length;
  const titleW = W - 96 - 300;
  const stripY = 520;
  return (
    <div style={{ ...fill, borderRadius: 48, overflow: "hidden", background: `linear-gradient(165deg, ${s1} 0%, ${s2} 100%)`, boxShadow: card(T, 48).boxShadow }}>
      <div style={{ ...fill, background: `radial-gradient(ellipse 60% 50% at 80% 10%, ${rgba("#FFFFFF", 0.18)} 0%, transparent 70%)` }} />
      <div style={{ position: "absolute", left: 48, top: 44, width: titleW, display: "flex", alignItems: "center", gap: 12, ...el(ctx, at(0), len(0.5), 0, nEl) }}>
        <svg width={30} height={30} viewBox="0 0 24 24" style={{ flex: "none" }}>
          <path d="M20 4L4 11l7 2 2 7z" fill="#FFFFFF" />
        </svg>
        <span style={{ ...tx(props.title ? fitLine(props.title, titleW - 42, 44, 32) : 44, "#FFFFFF", FONT.displayBold, { textShadow: shadow }), ...oneLine }}>{props.title ?? ""}</span>
      </div>
      {temp != null ? (
        <div style={{ position: "absolute", left: 40, top: 100, ...tx(210, "#FFFFFF", FONT.display, { lineHeight: 1, letterSpacing: "-0.04em", textShadow: shadow, fontVariantNumeric: "tabular-nums" }), ...el(ctx, at(0.15), len(0.55), 1, nEl, { blur: true }) }}>{deg(shown)}</div>
      ) : null}
      <div style={{ position: "absolute", left: 48, top: 330, width: W - 96 - 260, ...el(ctx, at(0.35), len(0.5), 2, nEl) }}>
        {now?.text ? <div style={{ ...tx(fitLine(now.text, W - 96 - 260, 44, 32), "#FFFFFF", FONT.displayBold, { textShadow: shadow }), ...oneLine }}>{now.text}</div> : null}
        {now?.sub ? <div style={{ ...tx(34, rgba("#FFFFFF", 0.86), FONT.display, { textShadow: shadow }), ...oneLine, marginTop: 6 }}>{now.sub}</div> : null}
      </div>
      <div style={{ position: "absolute", right: 34, top: 70, width: 300, height: 300, opacity: clamp01(artIn * 1.5), transform: `scale(${r4(0.6 + 0.4 * artIn)}) translateY(${r1(Math.sin((frame / ctx.fps) * 1.1) * 5)}px)` }}>
        <WeatherArt ctx={ctx} icon={icon} size={300} />
      </div>
      {hours.length ? (
        <div style={{ position: "absolute", left: 32, right: 32, top: stripY - 60, height: H - stripY + 60 - 32, borderRadius: 30, background: rgba("#FFFFFF", T.dark ? 0.1 : 0.18), boxShadow: `inset 0 0 0 1.5px ${rgba("#FFFFFF", 0.16)}`, display: "flex", alignItems: "center", justifyContent: "space-around", padding: "0 12px", opacity: inAt(ctx, at(0.45), len(0.4)) }}>
          {hours.map((h, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, width: (W - 88) / Math.max(4, hours.length), ...el(ctx, at(0.55 + i * 0.08), len(0.45), 3 + i, nEl) }}>
              <span style={{ ...tx(fitLine(h.text, (W - 88) / Math.max(4, hours.length) - 8, 30, 28), rgba("#FFFFFF", 0.88), FONT.display), ...oneLine, maxWidth: "100%" }}>{h.text}</span>
              <GIcon icon={h.icon ?? icon} size={50} color="#FFFFFF" stroke={1.9} />
              <span style={tx(38, "#FFFFFF", FONT.displayBold, { fontVariantNumeric: "tabular-nums" })}>{h.value != null ? deg(h.value) : "–"}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WeatherWeek({ ctx }: C) {
  const T = toneOf(ctx);
  const { props } = ctx;
  const W = ctx.width;
  const rows = props.items.slice(0, 7);
  const n = Math.max(1, rows.length);
  const { at, len } = clock(ctx, 0.9 + n * 0.1);
  const hh = props.title ? 90 : 0;
  const top = 40 + hh;
  const rowH = 100;
  const lows = rows.map((r) => (r.sub != null && Number.isFinite(parseFloat(r.sub)) ? parseFloat(r.sub) : null));
  const highs = rows.map((r) => r.value);
  const allV = [...lows, ...highs].filter((x): x is number => x != null);
  const mn = allV.length ? Math.min(...allV) : 0;
  const mx = allV.length ? Math.max(...allV) : 1;
  const span = Math.max(1, mx - mn);
  const barL = 44 + 150 + 70 + 100;
  const barR = W - 44 - 100;
  const barW = barR - barL;
  return (
    <Shell T={T}>
      <Head ctx={ctx} T={T} x={44} y={40} w={W - 88} title={props.title} />
      {rows.map((r, i) => {
        const y = top + i * rowH;
        const s0 = at(0.2 + i * 0.1);
        const g = inAt(ctx, s0 + 3, len(0.6));
        const lo = lows[i] ?? mn;
        const hi = r.value ?? lo;
        const x0 = ((Math.min(lo, hi) - mn) / span) * barW;
        const x1 = ((Math.max(lo, hi) - mn) / span) * barW;
        return (
          <div key={i} style={{ position: "absolute", left: 44, top: y, width: W - 88, height: rowH, ...el(ctx, s0, len(0.45), i, n, { style: "SLIDE" }) }}>
            {i > 0 ? <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 1.5, background: T.line }} /> : null}
            <div style={{ position: "absolute", left: 0, top: 0, width: 150, height: rowH, display: "flex", alignItems: "center" }}>
              <span style={{ ...tx(fitLine(r.text, 150, 36, 28), T.ink, FONT.displayBold), ...oneLine }}>{r.text}</span>
            </div>
            <div style={{ position: "absolute", left: 150, top: (rowH - 50) / 2 }}>
              <GIcon icon={r.icon ?? "SUN"} size={50} color={weatherTint(r.icon ?? "SUN", T)} stroke={2} />
            </div>
            <div style={{ position: "absolute", left: 220, width: 90, top: 0, height: rowH, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
              <span style={tx(34, T.muted, FONT.display, { fontVariantNumeric: "tabular-nums" })}>{lows[i] != null ? deg(counted(ctx, s0, lows[i]!)) : r.sub ?? ""}</span>
            </div>
            <div style={{ position: "absolute", left: barL - 44, width: barW, top: rowH / 2 - 7, height: 14, borderRadius: 7, background: T.fill2 }}>
              <div style={{ position: "absolute", left: x0, top: 0, height: 14, width: Math.max(14, (x1 - x0) * g), borderRadius: 7, background: `linear-gradient(90deg, #5AC8FA 0%, #F5C04A 60%, #FF8A4C 100%)`, backgroundSize: `${r1(barW)}px 14px`, backgroundPosition: `${r1(-x0)}px 0` }} />
            </div>
            <div style={{ position: "absolute", right: 0, width: 90, top: 0, height: rowH, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
              <span style={tx(36, T.ink, FONT.displayBold, { fontVariantNumeric: "tabular-nums" })}>{r.value != null ? deg(counted(ctx, s0, r.value)) : ""}</span>
            </div>
          </div>
        );
      })}
    </Shell>
  );
}

// ===================================================================== SCREEN_TIME

const APP_GLYPHS: GraphicIcon[] = ["PLAY", "CAMERA", "CHAT", "MUSIC", "NEWS"];

function AppRows({ ctx, T, items, x, y, w, rowH, start, step, idx0, nEl }: { ctx: GCtx; T: Tone; items: Item[]; x: number; y: number; w: number; rowH: number; start: number; step: number; idx0: number; nEl: number }) {
  const maxV = Math.max(1, ...items.map((i) => i.value ?? 0));
  const L = Math.round(0.45 * ctx.fps);
  return (
    <>
      {items.map((it, i) => {
        const s0 = start + i * step;
        const g = inAt(ctx, s0 + 4, Math.round(0.7 * ctx.fps));
        const v = it.value ?? 0;
        const tint = APP_TINTS[i % APP_TINTS.length]!;
        const timeTxt = it.value != null ? fmtHM(counted(ctx, s0, v)) : "";
        const nameW = w - 80 - 22 - 170;
        return (
          <div key={i} style={{ position: "absolute", left: x, top: y + i * rowH, width: w, height: rowH, display: "flex", alignItems: "center", gap: 22, ...el(ctx, s0, L, idx0 + i, nEl, { style: "SLIDE" }) }}>
            <AppTile icon={it.icon ?? APP_GLYPHS[i % APP_GLYPHS.length]!} size={72} color={tint} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
                <span style={{ ...tx(fitLine(it.text, nameW, 36, 30), T.ink, FONT.display), ...oneLine }}>{it.text}</span>
                <span style={{ ...tx(34, T.muted, FONT.display, { fontVariantNumeric: "tabular-nums" }), flex: "none" }}>{timeTxt}</span>
              </div>
              <div style={{ marginTop: 12, height: 10, borderRadius: 5, background: T.fill }}>
                <div style={{ width: `${r1((v / maxV) * 100 * g)}%`, height: 10, borderRadius: 5, background: tint }} />
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

function ScreenTime({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame } = ctx;
  const W = ctx.width;
  const apps = props.items.slice(0, 5);
  const vals = (props.series[0]?.values ?? []).slice(0, 7);
  const isApps = ctx.variant === "APPS";
  const { at, len } = clock(ctx, 1.6 + vals.length * 0.07 + apps.length * 0.1);
  const acc = accentOf(T, ctx);
  if (isApps) {
    const hh = headH(props.title, props.subtitle);
    const y0 = 44 + (hh ? hh + 30 : 0);
    return (
      <Shell T={T}>
        <Head ctx={ctx} T={T} x={48} y={44} w={W - 96} title={props.title} subtitle={props.subtitle} />
        <AppRows ctx={ctx} T={T} items={apps} x={48} y={y0} w={W - 96} rowH={110} start={at(0.3)} step={len(0.12)} idx0={0} nEl={apps.length} />
      </Shell>
    );
  }
  const mins = parseHM(props.title);
  const titleTxt = mins != null ? fmtHM(counted(ctx, at(0.1), mins, 0, 2.2)) : props.title ?? "";
  const nEl = 2 + vals.length + apps.length;
  const chartY = 44 + 150;
  const chartH = vals.length ? 330 : 0;
  const barsTop = chartY + 30;
  const barsH = chartH - 30 - 56;
  const maxV = Math.max(1e-6, ...vals);
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const cw = W - 96;
  const slot = vals.length ? cw / vals.length : cw;
  const bw = Math.min(72, slot * 0.58);
  const peak = vals.indexOf(Math.max(...vals));
  const avgY = barsTop + barsH - (avg / maxV) * barsH;
  const avgT = inAt(ctx, at(0.9), len(0.4));
  const appsY = chartY + chartH + (vals.length ? 24 : 0);
  return (
    <Shell T={T}>
      <div style={{ position: "absolute", left: 48, top: 44, width: W - 96 - 110, ...el(ctx, at(0), len(0.5), 0, nEl) }}>
        {props.subtitle ? <div style={{ ...tx(32, T.muted, FONT.display), ...oneLine }}>{props.subtitle}</div> : null}
        <div style={{ ...tx(fitLine(titleTxt || " ", W - 96 - 110, 96, 50), T.ink, FONT.displayBold, { letterSpacing: "-0.03em", lineHeight: 1.05, fontVariantNumeric: "tabular-nums" }), ...oneLine, marginTop: 4 }}>{titleTxt}</div>
      </div>
      <div style={{ position: "absolute", right: 48, top: 52, ...el(ctx, at(0.1), len(0.5), 1, nEl, { style: "POP" }) }}>
        <AppTile icon="HOURGLASS" size={88} color={T.dark ? mix(ctx.p.secondary, "#3A2A8C", 0.4) : T.solid} />
      </div>
      {vals.length ? (
        <>
          <div style={{ position: "absolute", left: 48, right: 48, top: avgY, height: 0, borderTop: `3px dashed ${rgba(T.dark ? "#FFFFFF" : "#111116", 0.28)}`, opacity: avgT }} />
          <div style={{ position: "absolute", right: 48, top: avgY - 40, ...tx(28, T.muted, FONT.display), opacity: avgT }}>avg</div>
          {vals.map((v, i) => {
            const s0 = at(0.3 + i * 0.07);
            const g = springAt(frame, ctx.fps, s0, ctx.f.springs.grow, len(0.8));
            const h = Math.max(6, (v / maxV) * barsH * Math.max(0, g));
            const x = 48 + slot * i + (slot - bw) / 2;
            const isP = i === peak;
            const lab = props.categories[i] ?? "";
            return (
              <div key={i}>
                <div style={{ position: "absolute", left: x, top: barsTop + barsH - h, width: bw, height: h, borderRadius: 14, background: isP ? `linear-gradient(180deg, ${mix(acc, "#FFFFFF", 0.2)} 0%, ${acc} 100%)`   : T.dark ? rgba("#FFFFFF", 0.16) : rgba(acc, 0.35), opacity: prog(frame, s0, 3) }} />
                {isP ? <div style={{ position: "absolute", left: x - 30, width: bw + 60, top: barsTop + barsH - h - 42, textAlign: "center", ...tx(28, T.ink, FONT.displayBold), opacity: inAt(ctx, s0 + len(0.4), len(0.3)) }}>{`${Math.round(v * 10) / 10}h`}</div> : null}
                <div style={{ position: "absolute", left: 48 + slot * i, width: slot, top: barsTop + barsH + 14, textAlign: "center", ...tx(28, isP ? T.ink : T.muted, FONT.display), ...oneLine, opacity: inAt(ctx, s0, len(0.4)) }}>{lab}</div>
              </div>
            );
          })}
        </>
      ) : null}
      {apps.length ? (
        <>
          <div style={{ position: "absolute", left: 48, top: appsY, right: 48, height: 1.5, background: T.line, opacity: inAt(ctx, at(0.8), len(0.4)) }} />
          <AppRows ctx={ctx} T={T} items={apps} x={48} y={appsY + 20} w={W - 96} rowH={100} start={at(0.95)} step={len(0.1)} idx0={2 + vals.length} nEl={nEl} />
        </>
      ) : null}
    </Shell>
  );
}

// ===================================================================== PAYMENT

function moneyText(ctx: GCtx, shown: number, final: number): string {
  return fmtValue(ctx, shown, final).text;
}

function counterparty(text: string): string {
  const w = text.split(/\s+/).filter((x) => !/^(you|paid|received|from|sent|to|requested|charged|got|for)$/i.test(x));
  return w.join(" ") || text;
}

function Payment({ ctx }: C) {
  switch (ctx.variant) {
    case "FEED":
      return <PayFeed ctx={ctx} />;
    case "RECEIPT":
      return <PayReceipt ctx={ctx} />;
    case "DECLINED":
      return <PayDeclined ctx={ctx} />;
    default:
      return <PayReceived ctx={ctx} />;
  }
}

function PayReceived({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const { at, len } = clock(ctx, 2.0);
  const amount = props.items[0]?.value ?? 0;
  const pos = T.positive;
  const discAt = at(0.1);
  const disc = springAt(frame, fps, discAt, ctx.f.springs.punch, len(0.7));
  const check = prog(frame, discAt + len(0.2), len(0.4), EASE_IN_OUT);
  const burstAt = discAt + len(0.25);
  const bt = clamp01((frame - burstAt) / len(0.7));
  const ring = clamp01((frame - burstAt) / len(0.6));
  const amtAt = at(0.45);
  const shownV = counted(ctx, amtAt, amount);
  const amtTxt = moneyText(ctx, shownV, amount);
  const amtS = fitLine(moneyText(ctx, amount, amount), W - 120, 132, 70);
  const from = props.subtitle ?? "";
  const who = from.replace(/^from\s+/i, "");
  const body = props.body?.trim() ?? "";
  const bodyF = body ? fitWords(splitWords(body), W - 200, 2 * 46, { max: 34, min: 30, lh: 1.3, maxLines: 2 }) : null;
  const cx = W / 2;
  const discY = 48;
  const discS = 150;
  const nEl = 4;
  return (
    <Shell T={T}>
      <div style={{ position: "absolute", left: cx - discS / 2, top: discY, width: discS, height: discS }}>
        {bt > 0 && bt < 1
          ? Array.from({ length: 14 }, (_, i) => {
              const a = (i / 14) * Math.PI * 2 + hash01(i) * 0.3;
              const dist = 70 + (60 + hash01(i + 9) * 60) * (1 - (1 - bt) ** 3);
              const sz = 10 + hash01(i + 3) * 8;
              return <div key={i} style={{ position: "absolute", left: discS / 2 + Math.cos(a) * dist - sz / 2, top: discS / 2 + Math.sin(a) * dist - sz / 2, width: sz, height: i % 3 === 0 ? sz * 2.2 : sz, borderRadius: sz, background: i % 2 ? pos : T.accent, opacity: r4(1 - bt), transform: `rotate(${r1((a * 180) / Math.PI + 90)}deg)` }} />;
            })
          : null}
        {ring > 0 && ring < 1 ? <div style={{ ...fill, borderRadius: "50%", border: `4px solid ${rgba(pos, 0.6 * (1 - ring))}`, transform: `scale(${r4(1 + ring * 0.6)})` }} /> : null}
        <div style={{ ...fill, borderRadius: "50%", background: `linear-gradient(150deg, ${mix(pos, "#FFFFFF", 0.2)} 0%, ${pos} 100%)`, boxShadow: `0 16px 34px ${rgba(pos, 0.35)}`, display: "flex", alignItems: "center", justifyContent: "center", opacity: prog(frame, discAt, 3), transform: `scale(${r4(Math.max(0, disc))})` }}>
          <GIcon icon="CHECK" size={84} color="#FFFFFF" stroke={3} draw={check} />
        </div>
      </div>
      <div style={{ position: "absolute", left: 40, right: 40, top: discY + discS + 30, textAlign: "center", ...el(ctx, at(0.35), len(0.5), 0, nEl) }}>
        <div style={{ ...tx(38, T.muted, FONT.display), ...oneLine }}>{props.title ?? ""}</div>
      </div>
      <div style={{ position: "absolute", left: 30, right: 30, top: discY + discS + 82, textAlign: "center", ...tx(amtS, T.ink, FONT.displayBold, { letterSpacing: "-0.03em", lineHeight: 1.05, fontVariantNumeric: "tabular-nums" }), ...el(ctx, amtAt, len(0.5), 1, nEl, { style: "POP" }) }}>{amtTxt}</div>
      {from ? (
        <div style={{ position: "absolute", left: 40, right: 40, top: discY + discS + 82 + amtS * 1.05 + 22, display: "flex", justifyContent: "center", alignItems: "center", gap: 16, ...el(ctx, at(0.7), len(0.5), 2, nEl) }}>
          <Avatar name={who} size={60} />
          <span style={{ ...tx(fitLine(from, W - 200, 36, 30), T.ink, FONT.display), ...oneLine }}>{from}</span>
        </div>
      ) : null}
      {bodyF ? (
        <div style={{ position: "absolute", left: 60, right: 60, bottom: 44, padding: "20px 32px", borderRadius: 26, background: T.fill, textAlign: "center", ...el(ctx, at(0.9), len(0.5), 3, nEl) }}>
          {bodyF.lines.map((ln, i) => (
            <div key={i} style={{ ...tx(bodyF.size, T.ink, FONT.text, { lineHeight: 1.3 }), whiteSpace: "nowrap" }}>
              {ln.map((k) => bodyF.words[k]).join(" ")}
            </div>
          ))}
        </div>
      ) : null}
    </Shell>
  );
}

function PayFeed({ ctx }: C) {
  const T = toneOf(ctx);
  const { props } = ctx;
  const W = ctx.width;
  const rows = props.items.slice(0, 8);
  const n = Math.max(1, rows.length);
  const { at, len } = clock(ctx, 0.8 + n * 0.14);
  const hh = headH(props.title, props.subtitle);
  const y0 = hh ? 40 + hh + 16 : 30;
  const rowH = 150;
  return (
    <Shell T={T}>
      <Head ctx={ctx} T={T} x={44} y={40} w={W - 88} title={props.title} subtitle={props.subtitle} />
      {rows.map((it, i) => {
        const s0 = at(0.2 + i * 0.14);
        const v = it.value ?? 0;
        const paid = v < 0;
        const shown = counted(ctx, s0 + 3, Math.abs(v));
        const amt = it.value != null ? `${paid ? "−" : "+"}${fmtValue(ctx, shown, Math.abs(v)).text}` : "";
        const amtW = Math.max(150, textW(it.value != null ? `+${fmtValue(ctx, Math.abs(v), Math.abs(v)).text}` : "", 38) + 10);
        const textW_ = W - 88 - 84 - 24 - amtW - 20;
        return (
          <div key={i} style={{ position: "absolute", left: 44, top: y0 + i * rowH, width: W - 88, height: rowH, ...el(ctx, s0, len(0.45), i, n, { style: "RISE" }) }}>
            {i > 0 ? <div style={{ position: "absolute", left: 108, right: 0, top: 0, height: 1.5, background: T.line }} /> : null}
            <div style={{ position: "absolute", left: 0, top: (rowH - 84) / 2 }}>
              <Avatar name={counterparty(it.text)} size={84} />
            </div>
            <div style={{ position: "absolute", left: 108, top: 0, width: textW_, height: rowH, display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div style={{ ...tx(fitLine(it.text, textW_, 36, 30), T.ink, FONT.displayBold), ...oneLine }}>{it.text}</div>
              {it.sub ? <div style={{ ...tx(30, T.muted), ...oneLine, marginTop: 6 }}>{it.sub}</div> : null}
            </div>
            <div style={{ position: "absolute", right: 0, top: 0, width: amtW, height: rowH, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-end" }}>
              <div style={tx(38, paid ? T.ink : T.positive, FONT.displayBold, { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" })}>{amt}</div>
              {it.meta ? <div style={{ ...tx(28, T.faint), ...oneLine, marginTop: 6, maxWidth: amtW }}>{it.meta}</div> : null}
            </div>
          </div>
        );
      })}
    </Shell>
  );
}

function PayReceipt({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const lines = props.items.slice(0, 8);
  const { at, len } = clock(ctx, 2.4);
  const slotH = 64;
  const slotY = 0;
  const px = 42;
  const pw = W - 2 * px;
  const paperTop = slotY + slotH / 2;
  const paperH = H - paperTop - 6;
  // Printer feed: jerky increments, eased.
  const ft = prog(frame, at(0.25), len(1.6), (x) => x);
  const steps = 7;
  const k = ft * steps;
  const fi = Math.floor(k);
  const feed = Math.min(1, (fi + EASE_IN_OUT(Math.min(1, (k - fi) * 1.6))) / steps);
  const total = lines.reduce((a, it) => a + (it.value ?? 0), 0);
  const totAt = at(1.9);
  const totTxt = fmtValue(ctx, counted(ctx, totAt, total), total).text;
  const paperC = T.dark ? "#F3F1EA" : "#FFFFFF";
  const inkC = "#1A1A20";
  const mut = "#6B6B76";
  const teeth = 14;
  const tw = pw / teeth;
  const zig = Array.from({ length: teeth }, (_, k) => {
    const i = teeth - 1 - k;
    return `${r1(i * tw + tw / 2)}px 100%, ${r1(i * tw)}px calc(100% - 16px)`;
  }).join(", ");
  const clip = `polygon(0 0, 100% 0, 100% calc(100% - 16px), ${zig})`;
  const dash = `repeating-linear-gradient(90deg, ${rgba(inkC, 0.35)} 0 10px, transparent 10px 18px)`;
  const contentW = pw - 80;
  const rowH = 62;
  return (
    <div style={fill}>
      <div style={{ position: "absolute", left: px, top: paperTop, width: pw, height: paperH, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: pw, height: paperH, transform: `translateY(${r1(-(1 - feed) * paperH)}px)` }}>
          <div style={{ ...fill, background: paperC, clipPath: clip, boxShadow: `inset 0 22px 18px -14px ${rgba("#000000", 0.18)}` }}>
            <div style={{ position: "absolute", left: 40, top: 52, width: contentW, textAlign: "center" }}>
              <div style={{ ...tx(fitLine(props.title ?? "", contentW, 44, 32), inkC, FONT.displayBold, { letterSpacing: "0.02em" }), ...oneLine }}>{props.title ?? ""}</div>
              {props.subtitle ? <div style={{ ...tx(28, mut, FONT.text, { letterSpacing: "0.04em" }), ...oneLine, marginTop: 8 }}>{props.subtitle}</div> : null}
            </div>
            <div style={{ position: "absolute", left: 40, width: contentW, top: props.subtitle ? 172 : 132, height: 3, background: dash }} />
            {lines.map((it, i) => (
              <div key={i} style={{ position: "absolute", left: 40, width: contentW, top: (props.subtitle ? 196 : 156) + i * rowH, height: rowH, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 }}>
                <span style={{ ...tx(fitLine(it.text, contentW - 170, 34, 28), inkC, FONT.display), ...oneLine }}>{it.text}</span>
                <span style={tx(34, inkC, FONT.display, { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" })}>{it.value != null ? fmtValue(ctx, it.value, it.value).text : ""}</span>
              </div>
            ))}
            {props.showTotal ? (
              <>
                <div style={{ position: "absolute", left: 40, width: contentW, top: (props.subtitle ? 196 : 156) + lines.length * rowH + 14, height: 3, background: dash }} />
                <div style={{ position: "absolute", left: 40, width: contentW, top: (props.subtitle ? 196 : 156) + lines.length * rowH + 34, height: 70, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={tx(36, inkC, FONT.displayBold, { letterSpacing: "0.08em" })}>TOTAL</span>
                  <span style={tx(fitLine(fmtValue(ctx, total, total).text, contentW - 200, 50, 34), inkC, FONT.displayBold, { fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" })}>{totTxt}</span>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <div style={{ position: "absolute", left: 0, top: slotY, width: W, height: slotH, borderRadius: 32, ...card(T, 32), opacity: inAt(ctx, 0, len(0.4)) }}>
        <div style={{ position: "absolute", left: px - 8, right: px - 8, top: slotH / 2 - 5, height: 10, borderRadius: 5, background: T.dark ? "#050507" : "#2A2A33", boxShadow: `inset 0 3px 6px ${rgba("#000000", 0.6)}` }} />
      </div>
    </div>
  );
}

function PayDeclined({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const { at, len } = clock(ctx, 2.0);
  const amount = props.items[0]?.value ?? null;
  const decAt = at(1.25);
  const declined = frame >= decAt;
  const dAge = frame - decAt;
  const shake = dAge >= 0 ? Math.sin(dAge * 1.9) * 16 * Math.max(0, 1 - dAge / len(0.55)) : 0;
  const xPop = springAt(frame, fps, decAt, ctx.f.springs.punch, len(0.6));
  const flash = dAge >= 0 ? Math.max(0, 1 - dAge / len(0.8)) : 0;
  const neg = T.negative;
  const cardIn = el(ctx, at(0), len(0.55), 0, 3, { style: "SLIDE" });
  const pad = 44;
  const cw = 310;
  const ch = 196;
  const rx = pad + cw + 40;
  const rw = W - rx - pad;
  const cg1 = mix(ctx.p.secondary, "#101018", 0.45);
  const cg2 = mix(ctx.p.primary, "#101018", 0.62);
  const proc = !declined;
  const title = props.title ?? "Declined";
  return (
    <Shell T={T} style={{ boxShadow: [card(T).boxShadow, flash > 0 ? `inset 0 0 0 4px ${rgba(neg, 0.8 * flash)}` : null].filter(Boolean).join(", ") }}>
      <div style={{ position: "absolute", left: pad, top: (H - ch) / 2, width: cw, height: ch, ...cardIn }}>
        <div style={{ ...fill, borderRadius: 24, background: `linear-gradient(135deg, ${cg1} 0%, ${cg2} 100%)`, boxShadow: `0 18px 36px ${rgba("#000000", 0.35)}, inset 0 1.5px 0 ${rgba("#FFFFFF", 0.2)}`, transform: `translateX(${r1(shake)}px) rotate(${r1(shake * 0.15)}deg)`, overflow: "hidden" }}>
          <div style={{ ...fill, background: `radial-gradient(ellipse 80% 60% at 20% 0%, ${rgba("#FFFFFF", 0.22)} 0%, transparent 60%)` }} />
          <div style={{ position: "absolute", left: 28, top: 40, width: 58, height: 44, borderRadius: 10, background: "linear-gradient(135deg, #E8D9A8 0%, #B8A26A 100%)", boxShadow: `inset 0 0 0 1.5px ${rgba("#000000", 0.18)}` }} />
          <svg width={34} height={34} viewBox="0 0 24 24" style={{ position: "absolute", right: 26, top: 44 }}>
            {[5, 9, 13].map((r, i) => (
              <path key={i} d={`M${12 - r * 0.2} ${12 - r * 0.6} a${r} ${r} 0 0 1 0 ${r * 1.2}`} fill="none" stroke={rgba("#FFFFFF", 0.8)} strokeWidth={2} strokeLinecap="round" transform={`translate(${i * 2 - 4} 0)`} />
            ))}
          </svg>
          <div style={{ position: "absolute", left: 28, bottom: 30, ...tx(30, rgba("#FFFFFF", 0.92), FONT.display, { letterSpacing: "0.12em" }) }}>•••• 4821</div>
          {declined ? <div style={{ ...fill, background: rgba(neg, 0.35 * flash) }} /> : null}
        </div>
      </div>
      <div style={{ position: "absolute", left: rx, top: 0, width: rw, height: H, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        {amount != null ? <div style={{ ...tx(fitLine(fmtValue(ctx, amount, amount).text, rw, 64, 40), T.ink, FONT.displayBold, { letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }), ...el(ctx, at(0.25), len(0.5), 1, 3) }}>{fmtValue(ctx, amount, amount).text}</div> : null}
        <div style={{ position: "relative", height: 64, marginTop: 10 }}>
          <div style={{ position: "absolute", left: 0, top: 0, height: 64, display: "flex", alignItems: "center", gap: 16, opacity: proc ? inAt(ctx, at(0.45), len(0.3)) : 0 }}>
            <span style={tx(34, T.muted, FONT.display)}>Processing</span>
            <TypingDots ctx={ctx} color={T.muted} size={12} gap={8} />
          </div>
          {declined ? (
            <div style={{ position: "absolute", left: 0, top: 0, height: 64, width: rw, display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 52, height: 52, flex: "none", borderRadius: 26, background: neg, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${r4(Math.max(0, xPop))})` }}>
                <GIcon icon="CROSS" size={30} color="#FFFFFF" stroke={3.2} />
              </div>
              <span style={{ ...tx(fitLine(title, rw - 70, 44, 30), neg, FONT.displayBold, { letterSpacing: "-0.01em" }), ...oneLine, opacity: clamp01(xPop * 2) }}>{title}</span>
            </div>
          ) : null}
        </div>
        {props.subtitle ? <div style={{ ...tx(32, T.muted), ...oneLine, marginTop: 10, opacity: declined ? inAt(ctx, decAt + 4, len(0.4)) : 0 }}>{props.subtitle}</div> : null}
      </div>
    </Shell>
  );
}

// ===================================================================== TRAVEL

function Travel({ ctx }: C) {
  switch (ctx.variant) {
    case "DELIVERY":
      return <TravelDelivery ctx={ctx} />;
    case "BOARDING":
      return <TravelBoarding ctx={ctx} />;
    case "TICKET":
      return <TravelTicket ctx={ctx} />;
    default:
      return <TravelRide ctx={ctx} />;
  }
}

const RIDE_UV: Array<[number, number]> = [
  [0.22, 0.26],
  [0.46, 0.26],
  [0.46, 0.54],
  [0.7, 0.54],
  [0.7, 0.82],
  [0.94, 0.82],
];

function CarTop({ T, size, angle }: { T: Tone; size: number; angle: number }) {
  const body = T.dark ? "#F2F2F5" : "#22222A";
  const glass = T.dark ? "#2A2C38" : "#8FA3BC";
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" style={{ display: "block", overflow: "visible", transform: `rotate(${r1(angle)}deg)` }}>
      <rect x={6} y={13} width={36} height={22} rx={8} fill={body} />
      <rect x={25} y={16} width={8} height={16} rx={3} fill={glass} />
      <rect x={11} y={16.5} width={6} height={15} rx={2.5} fill={glass} />
      <rect x={39} y={15} width={3} height={4} rx={1} fill="#FFE9A8" />
      <rect x={39} y={29} width={3} height={4} rx={1} fill="#FFE9A8" />
    </svg>
  );
}

function TravelRide({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const { at, len } = clock(ctx, 2.6);
  const acc = accentOf(T, ctx);
  const pad = 22;
  const mw = W - 2 * pad;
  const mh = 330;
  const mapT = inAt(ctx, 0, len(0.6));
  const P = projector(mw, mh, -4);
  const pts = RIDE_UV.map(([u, v]) => P(u, v));
  const carT = 0.62 * prog(frame, at(0.4), len(2.0), (x) => 1 - (1 - x) ** 2);
  const car = polyAt(pts, carT);
  const end = pts[pts.length - 1]!;
  const pulse = ((frame / fps) * 0.9) % 1;
  // remaining route ahead of the car
  const L = polyLens(pts);
  const total = L[L.length - 1]!;
  const dCar = carT * total;
  const ahead: Pt[] = [{ x: car.x, y: car.y }, ...pts.filter((_, i) => L[i]! > dCar)];
  const meta = props.meta ?? "";
  const pillW = meta ? Math.min(mw - 40, textW(meta, 32) + 64) : 0;
  const rating = props.items[0]?.value ?? null;
  const sub = props.subtitle ?? "";
  const parts = sub.split("·").map((s) => s.trim()).filter(Boolean);
  const plate = parts.length > 1 ? parts[parts.length - 1]! : "";
  const carName = parts.length > 1 ? parts.slice(0, -1).join(" · ") : sub;
  const by = pad + mh + 34;
  const nameW = W - 88 - 128 - 24 - 220;
  const nEl = 4;
  return (
    <Shell T={T}>
      <div style={{ position: "absolute", left: pad, top: pad, width: mw, height: mh, borderRadius: 30, overflow: "hidden", transform: "translateZ(0)" }}>
        <StreetMap T={T} w={mw} h={mh} angle={-4} t={mapT} water={[-0.1, 1.2]} park={[0.22, 0.54]}>
          <path d={polyD(pts)} fill="none" stroke={T.dark ? rgba("#FFFFFF", 0.16) : rgba("#15151C", 0.14)} strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" opacity={mapT} />
          <path d={polyD(ahead)} fill="none" stroke={acc} strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" opacity={inAt(ctx, at(0.3), len(0.4))} />
          <circle cx={r1(end.x)} cy={r1(end.y)} r={r1(16 + 26 * pulse)} fill={rgba(acc, 0.3 * (1 - pulse))} />
          <circle cx={r1(end.x)} cy={r1(end.y)} r={17} fill="#FFFFFF" />
          <circle cx={r1(end.x)} cy={r1(end.y)} r={10} fill={acc} />
        </StreetMap>
        <div style={{ position: "absolute", left: car.x - 30, top: car.y - 30, width: 60, height: 60, opacity: inAt(ctx, at(0.25), len(0.3)), filter: `drop-shadow(0 6px 8px ${rgba("#000000", 0.35)})` }}>
          <CarTop T={T} size={60} angle={car.ang} />
        </div>
        {meta ? (
          <div style={{ position: "absolute", right: 20, top: 20, height: 64, width: pillW, borderRadius: 32, background: T.solid, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, boxShadow: `0 12px 26px ${rgba("#000000", 0.28)}`, ...el(ctx, at(0.5), len(0.45), 0, nEl, { style: "POP" }) }}>
            <span style={{ ...tx(fitLine(meta, pillW - 40, 32, 28), T.onSolid, FONT.displayBold), ...oneLine }}>{meta}</span>
          </div>
        ) : null}
      </div>
      <div style={{ position: "absolute", left: 44, top: by, ...el(ctx, at(0.2), len(0.5), 1, nEl, { style: "POP" }) }}>
        <Avatar name={props.title ?? "Driver"} size={128} />
        {rating != null ? (
          <div style={{ position: "absolute", left: 14, right: 14, bottom: -14, height: 44, borderRadius: 22, background: T.surface, boxShadow: `0 6px 14px ${rgba("#000000", 0.22)}`, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Star size={26} color={T.dark ? "#F5C04A" : "#E0A21A"} />
            <span style={tx(28, T.ink, FONT.displayBold)}>{rating.toFixed(1)}</span>
          </div>
        ) : null}
      </div>
      <div style={{ position: "absolute", left: 44 + 128 + 28, top: by + 4, width: nameW, ...el(ctx, at(0.35), len(0.5), 2, nEl) }}>
        <div style={{ ...tx(fitLine(props.title ?? "", nameW, 46, 32), T.ink, FONT.displayBold, { letterSpacing: "-0.015em" }), ...oneLine }}>{props.title ?? ""}</div>
        {carName ? <div style={{ ...tx(32, T.muted), ...oneLine, marginTop: 6 }}>{carName}</div> : null}
        {plate ? <div style={{ display: "inline-block", marginTop: 12, padding: "4px 16px", borderRadius: 10, border: `2.5px solid ${T.ink}`, ...tx(30, T.ink, FONT.displayBold, { letterSpacing: "0.1em" }) }}>{plate}</div> : null}
      </div>
      <div style={{ position: "absolute", right: 44, top: by + 20, display: "flex", gap: 20, ...el(ctx, at(0.5), len(0.5), 3, nEl) }}>
        {(["CHAT", "PHONE"] as const).map((ic) => (
          <div key={ic} style={{ width: 96, height: 96, borderRadius: 48, background: T.fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <GIcon icon={ic} size={44} color={T.ink} stroke={2} />
          </div>
        ))}
      </div>
    </Shell>
  );
}

function TravelDelivery({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const stages = props.items.slice(0, 6);
  const n = Math.max(1, stages.length);
  const { at, len } = clock(ctx, 1.6 + n * 0.15);
  const acc = accentOf(T, ctx);
  const lastDone = stages.reduce((a, s, i) => (s.state === "DONE" ? i : a), -1);
  const current = lastDone + 1 < stages.length ? lastDone + 1 : -1;
  const hh = headH(props.title, props.subtitle);
  const titleW = W - 88 - 120;
  const barY = 44 + Math.max(hh, 96) + 34;
  const barW = W - 88;
  const frac = stages.length > 1 ? Math.max(0, lastDone) / (stages.length - 1) : lastDone >= 0 ? 1 : 0;
  const bt = prog(frame, at(0.4), len(1.0), EASE_IN_OUT) * frac;
  const listY = barY + 76;
  const rowH = 96;
  const pulse = ((frame / fps) * 0.9) % 1;
  return (
    <Shell T={T}>
      <Head ctx={ctx} T={T} x={44} y={44} w={titleW} title={props.title} subtitle={props.subtitle} />
      <div style={{ position: "absolute", right: 44, top: 44, ...el(ctx, at(0.05), len(0.5), 0, n + 2, { style: "POP" }) }}>
        <AppTile icon="BOX" size={96} color={T.dark ? mix(ctx.p.secondary, "#3A2A8C", 0.4) : T.solid} />
      </div>
      <div style={{ position: "absolute", left: 44, top: barY, width: barW, height: 14, borderRadius: 7, background: T.fill2, opacity: inAt(ctx, at(0.25), len(0.4)) }}>
        <div style={{ width: `${r1(bt * 100)}%`, height: 14, borderRadius: 7, background: `linear-gradient(90deg, ${mix(acc, "#FFFFFF", 0.15)} 0%, ${acc} 100%)` }} />
        <div style={{ position: "absolute", left: Math.max(0, Math.min(barW - 64, bt * barW - 32)), top: -26, width: 64, height: 64, borderRadius: 32, background: T.surface, boxShadow: `0 8px 18px ${rgba("#000000", 0.25)}, inset 0 0 0 3px ${acc}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <GIcon icon="TRUCK" size={36} color={T.dark ? "#FFFFFF" : T.ink} stroke={2} />
        </div>
      </div>
      {stages.map((s, i) => {
        const y = listY + i * rowH;
        const s0 = at(0.5 + i * 0.15);
        const done = s.state === "DONE";
        const cur = i === current;
        const nodeT = springAt(frame, fps, s0 + 3, ctx.f.springs.soft, len(0.5));
        const conT = prog(frame, s0 + len(0.25), len(0.35));
        return (
          <div key={i} style={{ position: "absolute", left: 44, top: y, width: W - 88, height: rowH, ...el(ctx, s0, len(0.45), i + 1, n + 2, { style: "SLIDE" }) }}>
            {i < stages.length - 1 ? (
              <div style={{ position: "absolute", left: 22, top: rowH / 2 + 22, width: 4, height: rowH - 44, borderRadius: 2, background: T.fill2 }}>
                <div style={{ width: 4, height: `${r1((stages[i + 1]!.state === "DONE" ? 1 : 0) * conT * 100)}%`, borderRadius: 2, background: acc }} />
              </div>
            ) : null}
            {cur ? <div style={{ position: "absolute", left: 0, top: rowH / 2 - 24, width: 48, height: 48, borderRadius: 24, border: `3px solid ${rgba(acc, 0.7 * (1 - pulse))}`, transform: `scale(${r4(1 + pulse * 0.6)})` }} /> : null}
            <div style={{ position: "absolute", left: 4, top: rowH / 2 - 20, width: 40, height: 40, borderRadius: 20, boxSizing: "border-box", background: done ? acc : T.surface, border: done ? "none" : `4px solid ${cur ? acc : T.fill2}`, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${r4(0.6 + 0.4 * Math.max(0, nodeT))})` }}>
              {done ? <GIcon icon="CHECK" size={24} color={onFill(acc)} stroke={3.4} /> : null}
            </div>
            <div style={{ position: "absolute", left: 76, top: 0, height: rowH, right: s.sub ? 240 : 0, display: "flex", alignItems: "center" }}>
              <span style={{ ...tx(fitLine(s.text, W - 88 - 76 - (s.sub ? 240 : 0), 36, 30), done || cur ? T.ink : T.muted, done || cur ? FONT.displayBold : FONT.display), ...oneLine }}>{s.text}</span>
            </div>
            {s.sub ? (
              <div style={{ position: "absolute", right: 0, top: 0, height: rowH, width: 230, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                <span style={{ ...tx(30, cur ? T.accent : T.muted, FONT.display), ...oneLine }}>{s.sub}</span>
              </div>
            ) : null}
          </div>
        );
      })}
    </Shell>
  );
}

/** A card surface with half-circle notches cut at `cuts` (perforation), with a drop shadow. */
function NotchedCard({ T, w, h, cuts, r = 26, style, children }: { T: Tone; w: number; h: number; cuts: Array<{ x: number; y: number }>; r?: number; style?: CSSProperties; children: ReactNode }) {
  const holes = cuts.map((c) => `radial-gradient(circle ${r}px at ${r1(c.x)}px ${r1(c.y)}px, transparent ${r - 0.5}px, #000 ${r + 0.5}px)`);
  const mask = holes.join(", ");
  const base = card(T, 40);
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: w, height: h, filter: `drop-shadow(0 26px 40px ${rgba("#000000", 0.38)}) drop-shadow(0 8px 14px ${rgba("#000000", 0.22)})`, ...style }}>
      <div style={{ ...fill, borderRadius: 40, background: base.background, WebkitMaskImage: mask, maskImage: mask, WebkitMaskComposite: "source-in", maskComposite: "intersect", overflow: "hidden" }}>{children}</div>
    </div>
  );
}

function TravelBoarding({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const { at, len } = clock(ctx, 2.6);
  const acc = accentOf(T, ctx);
  const from = props.items[0];
  const to = props.items[1];
  const details = props.items.slice(2, 6);
  const pad = 52;
  const perfY = H - 190;
  const passIn = enterStyle(ctx, 0, len(0.6), { style: "RISE", distance: 2 });
  const cA = (from?.text ?? "").slice(0, 5);
  const cB = (to?.text ?? "").slice(0, 5);
  const codeS = Math.min(fitLine(cA || "XXX", 300, 120, 64), fitLine(cB || "XXX", 300, 120, 64));
  const lineL = pad + Math.max(textW(cA, codeS), 160) + 30;
  const lineR = W - pad - Math.max(textW(cB, codeS), 160) - 30;
  const lw = Math.max(40, lineR - lineL);
  const pt = prog(frame, at(0.55), len(1.1), EASE_IN_OUT);
  const bc = prog(frame, at(1.4), len(0.8), EASE_IN_OUT);
  const nEl = 5;
  const colW = (W - 2 * pad) / Math.max(1, details.length);
  const lab = (): CSSProperties => ({ ...tx(28, T.muted, FONT.display, { letterSpacing: "0.12em", textTransform: "uppercase" }), ...oneLine });
  return (
    <div style={{ ...fill, ...css(passIn) }}>
      <NotchedCard T={T} w={W} h={H} cuts={[{ x: 0, y: perfY }, { x: W, y: perfY }]}>
        <div style={{ position: "absolute", left: 0, top: 0, right: 0, height: 10, background: `linear-gradient(90deg, ${ctx.p.primary} 0%, ${ctx.p.secondary} 100%)` }} />
        <div style={{ position: "absolute", left: pad, right: pad, top: 44, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 20, ...el(ctx, at(0.1), len(0.5), 0, nEl) }}>
          <span style={lab()}>Boarding pass</span>
          {props.meta ? <span style={{ ...tx(30, T.accent, FONT.displayBold, { letterSpacing: "0.04em" }), ...oneLine }}>{props.meta}</span> : null}
        </div>
        <div style={{ position: "absolute", left: pad, top: 110, ...el(ctx, at(0.2), len(0.5), 1, nEl, { style: "DROP" }) }}>
          <div style={tx(codeS, T.ink, FONT.displayBold, { letterSpacing: "-0.02em", lineHeight: 1 })}>{cA}</div>
          <div style={{ ...tx(30, T.muted), ...oneLine, marginTop: 10, maxWidth: 300 }}>{from?.sub ?? ""}</div>
        </div>
        <div style={{ position: "absolute", right: pad, top: 110, textAlign: "right", ...el(ctx, at(0.3), len(0.5), 1, nEl, { style: "DROP" }) }}>
          <div style={tx(codeS, T.ink, FONT.displayBold, { letterSpacing: "-0.02em", lineHeight: 1 })}>{cB}</div>
          <div style={{ ...tx(30, T.muted), ...oneLine, marginTop: 10, maxWidth: 300 }}>{to?.sub ?? ""}</div>
        </div>
        <div style={{ position: "absolute", left: lineL, top: 110 + codeS * 0.5 - 2, width: lw, height: 4, opacity: inAt(ctx, at(0.4), len(0.4)) }}>
          <div style={{ ...fill, background: `repeating-linear-gradient(90deg, ${T.faint} 0 8px, transparent 8px 16px)` }} />
          <div style={{ position: "absolute", left: 0, top: 0, height: 4, width: `${r1(pt * 100)}%`, background: acc, borderRadius: 2 }} />
          <div style={{ position: "absolute", left: pt * lw - 24, top: -22 }}>
            <Plane size={48} color={acc} />
          </div>
        </div>
        <div style={{ position: "absolute", left: pad, right: pad, top: 300, ...el(ctx, at(0.45), len(0.5), 2, nEl) }}>
          <div style={lab()}>Passenger</div>
          <div style={{ ...tx(fitLine(props.title ?? "", W - 2 * pad, 42, 32), T.ink, FONT.displayBold), ...oneLine, marginTop: 6 }}>{props.title ?? ""}</div>
        </div>
        <div style={{ position: "absolute", left: pad, right: pad, top: 430, display: "flex", ...el(ctx, at(0.6), len(0.5), 3, nEl) }}>
          {details.map((d, i) => (
            <div key={i} style={{ width: colW, minWidth: 0, paddingRight: 12, boxSizing: "border-box" }}>
              <div style={lab()}>{d.text}</div>
              <div style={{ ...tx(fitLine(d.sub ?? (d.value != null ? String(d.value) : ""), colW - 12, 42, 30), T.ink, FONT.displayBold), ...oneLine, marginTop: 6 }}>{d.sub ?? (d.value != null ? String(d.value) : "")}</div>
            </div>
          ))}
        </div>
        <div style={{ position: "absolute", left: 40, right: 40, top: perfY - 2, height: 4, background: `repeating-linear-gradient(90deg, ${T.line} 0 12px, transparent 12px 22px)` }} />
        <div style={{ position: "absolute", left: pad, right: pad, top: perfY + 40, height: 110, clipPath: `inset(0 ${r1((1 - bc) * 100)}% 0 0)` }}>
          <svg width={W - 2 * pad} height={110} viewBox={`0 0 ${W - 2 * pad} 110`} style={{ display: "block" }}>
            <path d={barcodePath(W - 2 * pad, 110, 11)} fill={T.ink} />
          </svg>
        </div>
      </NotchedCard>
    </div>
  );
}

function TravelTicket({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const { at, len } = clock(ctx, 2.4);
  const stubW = 220;
  const perfX = W - stubW;
  const pad = 48;
  const mainW = perfX - 2 * pad;
  const tearAt = at(2.1);
  const tear = prog(frame, tearAt, len(0.5), EASE_IN_OUT);
  const passIn = enterStyle(ctx, 0, len(0.6), { style: "RISE", distance: 2 });
  const titleF = fitWords(splitWords(props.title ?? ""), mainW, 2 * 64 * 1.08, { max: 64, min: 40, lh: 1.08, maxLines: 2 });
  const details = props.items.slice(0, 3);
  const colW = mainW / Math.max(1, details.length);
  const nEl = 5;
  const lab: CSSProperties = { ...tx(28, T.muted, FONT.display, { letterSpacing: "0.12em", textTransform: "uppercase" }), ...oneLine };
  const titleH = titleF.lines.length * titleF.size * 1.08;
  const cuts = [{ x: perfX, y: 0 }, { x: perfX, y: H }];
  const holes = cuts.map((c) => `radial-gradient(circle 26px at ${r1(c.x)}px ${r1(c.y)}px, transparent 25.5px, #000 26.5px)`).join(", ");
  const holesStub = cuts.map((c) => `radial-gradient(circle 26px at ${r1(c.x - perfX)}px ${r1(c.y)}px, transparent 25.5px, #000 26.5px)`).join(", ");
  const base = card(T, 40);
  const shadow = `drop-shadow(0 26px 40px ${rgba("#000000", 0.38)}) drop-shadow(0 8px 14px ${rgba("#000000", 0.22)})`;
  return (
    <div style={{ ...fill, ...css(passIn) }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: perfX, height: H, filter: shadow }}>
        <div style={{ ...fill, borderRadius: "40px 0 0 40px", background: base.background, WebkitMaskImage: holes, maskImage: holes, overflow: "hidden" }}>
          <div style={{ ...fill, background: `radial-gradient(ellipse 70% 80% at 0% 0%, ${rgba(ctx.p.primary, T.dark ? 0.22 : 0.16)} 0%, transparent 70%), radial-gradient(ellipse 60% 70% at 100% 100%, ${rgba(ctx.p.secondary, T.dark ? 0.22 : 0.12)} 0%, transparent 70%)` }} />
          <div style={{ position: "absolute", left: pad, top: 48, display: "flex", alignItems: "center", gap: 14, ...el(ctx, at(0.15), len(0.5), 0, nEl) }}>
            <GIcon icon="TICKET" size={38} color={T.accent} stroke={2} />
            <span style={{ ...tx(28, T.accent, FONT.displayBold, { letterSpacing: "0.14em", textTransform: "uppercase" }) }}>Admit one</span>
          </div>
          <div style={{ position: "absolute", left: pad, top: 116, width: mainW, ...el(ctx, at(0.25), len(0.55), 1, nEl) }}>
            {titleF.lines.map((ln, i) => (
              <div key={i} style={{ ...tx(titleF.size, T.ink, FONT.displayBold, { lineHeight: 1.08, letterSpacing: "-0.02em" }), whiteSpace: "nowrap" }}>
                {ln.map((k) => titleF.words[k]).join(" ")}
              </div>
            ))}
          </div>
          <div style={{ position: "absolute", left: pad, top: 116 + titleH + 18, width: mainW, ...el(ctx, at(0.4), len(0.5), 2, nEl) }}>
            {props.subtitle ? <div style={{ ...tx(34, T.ink, FONT.display), ...oneLine }}>{props.subtitle}</div> : null}
            {props.meta ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                <GIcon icon="PIN" size={30} color={T.muted} stroke={2} />
                <span style={{ ...tx(30, T.muted), ...oneLine }}>{props.meta}</span>
              </div>
            ) : null}
          </div>
          <div style={{ position: "absolute", left: pad, bottom: 44, width: mainW, display: "flex", ...el(ctx, at(0.55), len(0.5), 3, nEl) }}>
            {details.map((d, i) => (
              <div key={i} style={{ width: colW, minWidth: 0, paddingRight: 10, boxSizing: "border-box" }}>
                <div style={lab}>{d.text}</div>
                <div style={{ ...tx(fitLine(d.sub ?? (d.value != null ? String(d.value) : ""), colW - 10, 44, 30), T.ink, FONT.displayBold), ...oneLine, marginTop: 4 }}>{d.sub ?? (d.value != null ? String(d.value) : "")}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div style={{ position: "absolute", left: perfX, top: 0, width: stubW, height: H, filter: shadow, transform: `translate(${r1(tear * 26)}px, ${r1(tear * 10)}px) rotate(${r1(tear * 4)}deg)`, transformOrigin: "0% 100%" }}>
        <div style={{ ...fill, borderRadius: "0 40px 40px 0", background: base.background, WebkitMaskImage: holesStub, maskImage: holesStub, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 0, top: 30, bottom: 30, width: 4, background: `repeating-linear-gradient(180deg, ${T.line} 0 12px, transparent 12px 22px)` }} />
          <div style={{ position: "absolute", left: 50, top: 60, bottom: 60, width: 70, ...el(ctx, at(0.6), len(0.5), 4, nEl, { style: "WIPE" }) }}>
            <svg width={70} height={H - 120} viewBox={`0 0 70 ${H - 120}`} style={{ display: "block" }}>
              <path d={barcodePath(H - 120, 70, 23, true)} fill={T.ink} />
            </svg>
          </div>
          <div style={{ position: "absolute", left: 150, top: H / 2, width: H - 140, transform: "translate(-50%, -50%) rotate(90deg)", textAlign: "center", ...tx(28, T.muted, FONT.displayBold, { letterSpacing: "0.3em" }), ...oneLine }}>NO. {String(1000 + Math.floor(hash01((props.title ?? "").length + 3) * 8999))}</div>
        </div>
      </div>
    </div>
  );
}

// ===================================================================== DATE

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** Weekday (0 = Sunday) of the 1st, for a recent reference year (2026). */
const MONTH_FIRST = [4, 0, 0, 3, 5, 1, 3, 6, 2, 4, 0, 2];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function monthIndex(s: string | null | undefined): number {
  const t = (s ?? "").trim().toLowerCase();
  return MONTHS.findIndex((m) => t.startsWith(m) || t.includes(` ${m}`));
}

function DateC({ ctx }: C) {
  switch (ctx.variant) {
    case "MONTH":
      return <DateMonth ctx={ctx} />;
    case "YEARS":
      return <DateYears ctx={ctx} />;
    case "UNTIL":
      return <DateUntil ctx={ctx} />;
    default:
      return <DateFlip ctx={ctx} />;
  }
}

function DateFlip({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const a = Math.round(props.items[0]?.value ?? 1);
  const b = Math.round(props.items[1]?.value ?? a);
  const diff = b - a;
  const steps = Math.min(14, Math.abs(diff));
  const vals = Array.from({ length: steps + 1 }, (_, j) => (steps ? Math.round(a + (diff * j) / steps) : a));
  const { at, len } = clock(ctx, 0.5 + 0.18 * Math.max(4, steps) + 0.4);
  const t0 = at(0.5);
  const span = len(0.18 * Math.max(4, steps));
  const flipL = len(0.42);
  const starts = vals.slice(1).map((_, j) => t0 + Math.round(span * EASE_IN_OUT(steps > 1 ? j / (steps - 1) : 0) * (steps > 1 ? 1 : 0)));
  const started = starts.filter((s) => frame >= s).length;
  const base = vals[Math.min(vals.length - 1, started)]!;
  const wdIdx = WEEKDAYS.findIndex((d) => (props.subtitle ?? "").toLowerCase().startsWith(d.slice(0, 3).toLowerCase()));
  const weekday = (v: number) => (wdIdx < 0 ? (v === b ? props.subtitle ?? "" : "") : WEEKDAYS[(((wdIdx - (b - v)) % 7) + 7) % 7]!);
  const pageBg = T.dark ? "#1E1E27" : "#FFFFFF";
  const bandH = 150;
  const px = 30;
  const pw = W - 2 * px;
  const pageTop = 46;
  const pageH = H - pageTop - 46;
  const bodyH = pageH - bandH;
  const ink = T.ink;
  const numS = fitLine(String(Math.max(Math.abs(a), Math.abs(b))), pw - 80, 300, 120);
  const band = T.dark ? ctx.p.primary : T.solid;
  const onBand = onFill(band);
  const blockIn = enterStyle(ctx, 0, len(0.55), { style: ctx.anim.enter === "RISE" ? "POP" : ctx.anim.enter });
  const page = (v: number, key: string | number, style: CSSProperties = {}) => (
    <div key={key} style={{ position: "absolute", left: 0, top: bandH, width: pw, height: bodyH, background: pageBg, borderRadius: "0 0 34px 34px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", backfaceVisibility: "hidden", ...style }}>
      <div style={tx(numS, ink, FONT.displayBold, { lineHeight: 0.95, letterSpacing: "-0.04em", fontVariantNumeric: "tabular-nums" })}>{v}</div>
      <div style={{ ...tx(40, T.muted, FONT.display), ...oneLine, maxWidth: pw - 60, marginTop: 10, height: 46 }}>{weekday(v)}</div>
    </div>
  );
  const flipping = starts
    .map((s, j) => ({ s, j }))
    .filter(({ s }) => frame >= s && frame < s + flipL)
    .slice(-3);
  return (
    <div style={{ ...fill, ...css(blockIn) }}>
      <div style={{ position: "absolute", left: px + 10, top: pageTop + 16, width: pw - 20, height: pageH, borderRadius: 34, background: T.dark ? "#14141B" : "#E4E4EA", transform: "translateY(16px)", boxShadow: `0 30px 60px ${rgba("#000000", 0.4)}` }} />
      <div style={{ position: "absolute", left: px + 5, top: pageTop + 8, width: pw - 10, height: pageH, borderRadius: 34, background: T.dark ? "#191920" : "#EFEFF3", transform: "translateY(8px)" }} />
      <div style={{ position: "absolute", left: px, top: pageTop, width: pw, height: pageH, borderRadius: 34, perspective: 1400 }}>
        {page(base, "base")}
        {flipping.map(({ s, j }) => {
          const t = clamp01((frame - s) / flipL);
          const e = t * t;
          return page(vals[j]!, `f${j}`, { transformOrigin: "50% 0%", transform: `translateY(${r1(-e * 140)}px) rotate(${r1(e * (j % 2 ? 7 : -7))}deg) rotateX(${r1(t * 75)}deg)`, opacity: r4(1 - e), boxShadow: `0 ${r1(20 * t)}px 40px ${rgba("#000000", 0.3 * t)}` });
        })}
        <div style={{ position: "absolute", left: 0, top: 0, width: pw, height: bandH, borderRadius: "34px 34px 0 0", background: `linear-gradient(180deg, ${mix(band, "#FFFFFF", 0.12)} 0%, ${band} 100%)`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ ...tx(fitLine((props.title ?? "").toUpperCase(), pw - 80, 68, 40), onBand, FONT.displayBold, { letterSpacing: "0.12em" }), ...oneLine }}>{(props.title ?? "").toUpperCase()}</span>
        </div>
        {[0.28, 0.72].map((fx, i) => (
          <div key={i} style={{ position: "absolute", left: pw * fx - 14, top: -26, width: 28, height: 56, borderRadius: 14, background: T.dark ? "#3A3A46" : "#2A2A33", boxShadow: `inset 0 2px 0 ${rgba("#FFFFFF", 0.25)}` }} />
        ))}
      </div>
    </div>
  );
}

function DateMonth({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const mi = monthIndex(props.title);
  const days = mi >= 0 ? MONTH_DAYS[mi]! : 30;
  const off = mi >= 0 ? MONTH_FIRST[mi]! : 0;
  const crossed = Math.max(0, Math.min(days, Math.round(props.items[0]?.value ?? 0)));
  const { at, len } = clock(ctx, 0.9 + Math.min(2.2, crossed * 0.07) + 0.4);
  const acc = accentOf(T, ctx);
  const pad = 44;
  const hh = headH(props.title, props.subtitle);
  const gridTop = pad + hh + 30;
  const cw = (W - 2 * pad) / 7;
  const chH = 96;
  const cellsTop = gridTop + 56;
  const crossStart = at(0.6);
  const crossSpan = len(Math.min(2.2, crossed * 0.07));
  const crossAt = (d: number) => crossStart + (crossed > 1 ? Math.round((crossSpan * (d - 1)) / (crossed - 1)) : 0);
  const today = crossed < days ? crossed + 1 : -1;
  const todayAt = crossed ? crossAt(crossed) + len(0.3) : crossStart;
  const pulse = ((frame / fps) * 0.8) % 1;
  const gridIn = inAt(ctx, at(0.25), len(0.5));
  const xs: string[] = [];
  for (let d = 1; d <= crossed; d++) {
    const s = crossAt(d);
    const t1 = prog(frame, s, len(0.14));
    const t2 = prog(frame, s + len(0.08), len(0.14));
    if (t1 <= 0) continue;
    const k = off + d - 1;
    const cx = pad + (k % 7) * cw + cw / 2;
    const cy = cellsTop + Math.floor(k / 7) * chH + chH / 2;
    const r = Math.min(cw, chH) * 0.3;
    xs.push(`M${r1(cx - r)} ${r1(cy - r)}L${r1(cx - r + 2 * r * t1)} ${r1(cy - r + 2 * r * t1)}`);
    if (t2 > 0) xs.push(`M${r1(cx + r)} ${r1(cy - r)}L${r1(cx + r - 2 * r * t2)} ${r1(cy - r + 2 * r * t2)}`);
  }
  const DOW = ["S", "M", "T", "W", "T", "F", "S"];
  return (
    <Shell T={T}>
      <Head ctx={ctx} T={T} x={pad} y={pad} w={W - 2 * pad} title={props.title} subtitle={props.subtitle} />
      {DOW.map((d, i) => (
        <div key={i} style={{ position: "absolute", left: pad + i * cw, top: gridTop, width: cw, textAlign: "center", ...tx(28, T.muted, FONT.displayBold), opacity: gridIn }}>{d}</div>
      ))}
      <div style={{ position: "absolute", left: pad, right: pad, top: gridTop + 46, height: 1.5, background: T.line, opacity: gridIn }} />
      {Array.from({ length: days }, (_, i) => {
        const d = i + 1;
        const k = off + i;
        const isX = d <= crossed;
        const isT = d === today;
        const fade = isX ? 1 - 0.5 * prog(frame, crossAt(d), len(0.2)) : 1;
        const rowIn = inAt(ctx, at(0.25) + Math.floor(k / 7) * 2, len(0.45));
        return (
          <div key={d} style={{ position: "absolute", left: pad + (k % 7) * cw, top: cellsTop + Math.floor(k / 7) * chH, width: cw, height: chH, display: "flex", alignItems: "center", justifyContent: "center", ...tx(36, isT && frame >= todayAt ? T.onSolid : T.ink, isT ? FONT.displayBold : FONT.display, { fontVariantNumeric: "tabular-nums" }), opacity: rowIn * fade, transform: `translateY(${r1((1 - rowIn) * 12)}px)` }}>
            {d}
          </div>
        );
      })}
      {today > 0 && frame >= todayAt
        ? (() => {
            const k = off + today - 1;
            const cx = pad + (k % 7) * cw + cw / 2;
            const cy = cellsTop + Math.floor(k / 7) * chH + chH / 2;
            const s = springAt(frame, fps, todayAt, ctx.f.springs.soft, len(0.5));
            return (
              <>
                <div style={{ position: "absolute", left: cx - 38, top: cy - 38, width: 76, height: 76, borderRadius: 38, border: `3px solid ${rgba(acc, 0.6 * (1 - pulse))}`, transform: `scale(${r4(1 + pulse * 0.4)})` }} />
                <div style={{ position: "absolute", left: cx - 36, top: cy - 36, width: 72, height: 72, borderRadius: 36, background: T.solid, transform: `scale(${r4(Math.max(0, s))})`, display: "flex", alignItems: "center", justifyContent: "center", ...tx(36, T.onSolid, FONT.displayBold) }}>{today}</div>
              </>
            );
          })()
        : null}
      <svg width={W} height={ctx.height} style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
        <path d={xs.join("")} fill="none" stroke={T.dark ? ctx.p.negative : T.negative} strokeWidth={6} strokeLinecap="round" />
      </svg>
    </Shell>
  );
}

function DateYears({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame } = ctx;
  const W = ctx.width;
  const a = Math.max(0, Math.round(props.items[0]?.value ?? 0));
  const b = Math.max(0, Math.round(props.items[1]?.value ?? a));
  const digits = Math.max(String(a).length, String(b).length, 1);
  const { at, len } = clock(ctx, 2.6);
  const acc = accentOf(T, ctx);
  const rt = prog(frame, at(0.45), len(2.0), EASE_IN_OUT);
  const v = a + (b - a) * rt;
  const hh = props.title ? 70 : 0;
  const tileW = Math.min(150, (W - 88 - (digits - 1) * 18) / digits);
  const tileH = tileW * 1.3;
  const dS = tileW * 0.98;
  const rowW = digits * tileW + (digits - 1) * 18;
  const top = 44 + hh + 18;
  const done = rt >= 0.999;
  const land = inAt(ctx, at(0.45) + len(2.0), len(0.4));
  return (
    <Shell T={T}>
      {props.title ? <div style={{ position: "absolute", left: 44, right: 44, top: 44, textAlign: "center", ...tx(fitLine(props.title, W - 88, 46, 32), T.ink, FONT.displayBold, { letterSpacing: "-0.015em" }), ...oneLine, ...el(ctx, at(0), len(0.5), 0, 3) }}>{props.title}</div> : null}
      <div style={{ position: "absolute", left: (W - rowW) / 2, top, width: rowW, height: tileH, display: "flex", gap: 18, ...el(ctx, at(0.15), len(0.5), 1, 3, { style: "POP" }) }}>
        {Array.from({ length: digits }, (_, i) => {
          const k = digits - 1 - i;
          const p10 = 10 ** k;
          const base = Math.floor(v / p10);
          const rem = v - base * p10;
          const frac = k === 0 ? v - Math.floor(v) : clamp01(rem - (p10 - 1));
          const pos = (base % 10) + frac;
          const changed = Math.floor(a / p10) !== Math.floor(b / p10);
          const col = done && changed ? mix(T.ink, acc, land) : T.ink;
          return (
            <div key={i} style={{ position: "relative", width: tileW, height: tileH, borderRadius: 24, overflow: "hidden", background: T.dark ? `linear-gradient(180deg, #2A2A36 0%, #1A1A22 50%, #23232E 100%)` : `linear-gradient(180deg, #F4F4F7 0%, #E6E6EC 50%, #F0F0F4 100%)`, boxShadow: `inset 0 0 0 1.5px ${T.line}, inset 0 2px 0 ${rgba("#FFFFFF", T.dark ? 0.1 : 0.8)}` }}>
              <div style={{ position: "absolute", left: 0, top: 0, width: tileW, transform: `translateY(${r1(-pos * tileH)}px)` }}>
                {Array.from({ length: 11 }, (_, d) => (
                  <div key={d} style={{ height: tileH, display: "flex", alignItems: "center", justifyContent: "center", ...tx(dS, col, FONT.displayBold, { lineHeight: 1, fontVariantNumeric: "tabular-nums" }) }}>{d % 10}</div>
                ))}
              </div>
              <div style={{ position: "absolute", left: 0, right: 0, top: tileH / 2 - 1, height: 2, background: T.dark ? rgba("#000000", 0.5) : rgba("#000000", 0.08) }} />
              <div style={{ ...fill, background: `linear-gradient(180deg, ${rgba(T.dark ? "#000000" : "#FFFFFF", 0.35)} 0%, transparent 22%, transparent 78%, ${rgba(T.dark ? "#000000" : "#FFFFFF", 0.35)} 100%)` }} />
            </div>
          );
        })}
      </div>
      {props.subtitle ? <div style={{ position: "absolute", left: 44, right: 44, top: top + tileH + 22, textAlign: "center", ...tx(fitLine(props.subtitle, W - 88, 34, 28), T.muted, FONT.display), ...oneLine, ...el(ctx, at(0.6), len(0.5), 2, 3) }}>{props.subtitle}</div> : null}
    </Shell>
  );
}

function DateUntil({ ctx }: C) {
  const T = toneOf(ctx);
  const { props } = ctx;
  const W = ctx.width;
  const { at, len } = clock(ctx, 1.8);
  const acc = accentOf(T, ctx);
  const v = Math.round(props.items[0]?.value ?? 0);
  const shown = Math.round(counted(ctx, at(0.3), v, 0, 2.2));
  const numS = fitLine(String(v), W - 120, 230, 100);
  const titleF = fitWords(splitWords(props.title ?? ""), W - 96, 2 * 46 * 1.15, { max: 46, min: 34, lh: 1.15, maxLines: 2 });
  const grad = T.dark ? `linear-gradient(180deg, ${mix(acc, "#FFFFFF", 0.35)} 0%, ${acc} 100%)` : `linear-gradient(180deg, ${mix(T.solid, "#FFFFFF", 0.15)} 0%, ${T.solid} 100%)`;
  const em = emphasisAt(ctx, at(0.3) + len(1.0));
  return (
    <Shell T={T}>
      <div style={{ position: "absolute", left: 48, top: 44, right: 48, display: "flex", alignItems: "center", gap: 18, ...el(ctx, at(0), len(0.5), 0, 3) }}>
        <AppTile icon="CALENDAR" size={68} color={T.dark ? mix(ctx.p.secondary, "#3A2A8C", 0.4) : T.solid} />
        {props.subtitle ? <span style={{ ...tx(32, T.muted, FONT.display), ...oneLine }}>{props.subtitle}</span> : null}
      </div>
      <div style={{ position: "absolute", left: 30, right: 30, top: 124, height: numS, display: "flex", justifyContent: "center", alignItems: "center", ...el(ctx, at(0.2), len(0.55), 1, 3, { style: "POP" }) }}>
        <span style={{ ...tx(numS, T.ink, FONT.displayBold, { lineHeight: 1, letterSpacing: "-0.05em", fontVariantNumeric: "tabular-nums" }), background: grad, WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", display: "inline-block", transform: `scale(${r4(em.scale)})` }}>{shown}</span>
      </div>
      <div style={{ position: "absolute", left: 48, right: 48, top: 124 + numS + 14, textAlign: "center", ...el(ctx, at(0.45), len(0.5), 2, 3) }}>
        {titleF.lines.map((ln, i) => (
          <div key={i} style={{ ...tx(titleF.size, T.ink, FONT.displayBold, { letterSpacing: "-0.015em" }), whiteSpace: "nowrap" }}>
            {ln.map((k) => titleF.words[k]).join(" ")}
          </div>
        ))}
      </div>
    </Shell>
  );
}

// ===================================================================== TRACKER

function Tracker({ ctx }: C) {
  switch (ctx.variant) {
    case "SETS":
      return <TrackerSets ctx={ctx} />;
    case "MOOD":
      return <TrackerMood ctx={ctx} />;
    default:
      return <TrackerHabit ctx={ctx} />;
  }
}

function TrackerHabit({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const N = 35;
  const done = Math.max(0, Math.min(N, Math.round(props.items[0]?.value ?? 0)));
  const { at, len } = clock(ctx, 2.6);
  const acc = accentOf(T, ctx);
  // Which days are done: the latest days most likely (the streak), a few misses earlier.
  const score = Array.from({ length: N }, (_, i) => hash01(i * 7.3 + 1) * 0.9 + (i / N) * 1.3);
  const order = score.map((s, i) => ({ s, i })).sort((x, y) => y.s - x.s);
  const isDone = new Array<boolean>(N).fill(false);
  order.slice(0, done).forEach((o) => (isDone[o.i] = true));
  let streak = 0;
  for (let i = N - 1; i >= 0 && isDone[i]; i--) streak++;
  const pad = 44;
  const hh = headH(props.title, props.subtitle);
  const gap = 12;
  const gridTop = pad + hh + 28;
  const cw = (W - 2 * pad - 6 * gap) / 7;
  const ch = Math.min(cw, 92);
  const cellsTop = gridTop + 48;
  const fillStart = at(0.4);
  const fillSpan = len(1.8);
  const DOW = ["M", "T", "W", "T", "F", "S", "S"];
  const statY = cellsTop + 5 * (ch + gap) + 18;
  const statAt = at(0.5);
  const doneShown = Math.round(counted(ctx, statAt, done, 0, 2.6));
  const streakShown = Math.round(counted(ctx, statAt, streak, 0, 2.6));
  const gridIn = inAt(ctx, at(0.15), len(0.5));
  return (
    <Shell T={T}>
      <Head ctx={ctx} T={T} x={pad} y={pad} w={W - 2 * pad} title={props.title} subtitle={props.subtitle} />
      {DOW.map((d, i) => (
        <div key={i} style={{ position: "absolute", left: pad + i * (cw + gap), top: gridTop, width: cw, textAlign: "center", ...tx(28, T.muted, FONT.displayBold), opacity: gridIn }}>{d}</div>
      ))}
      {Array.from({ length: N }, (_, i) => {
        const s0 = fillStart + Math.round((fillSpan * i) / (N - 1));
        const on = isDone[i] ? springAt(frame, fps, s0, ctx.f.springs.soft, len(0.45)) : 0;
        const lvl = hash01(i * 3.1 + 5);
        const col = mix(acc, "#FFFFFF", (T.dark ? 0.32 : 0.5) * (lvl < 0.5 ? 0 : lvl < 0.8 ? 0.55 : 1));
        const isToday = i === N - 1;
        return (
          <div key={i} style={{ position: "absolute", left: pad + (i % 7) * (cw + gap), top: cellsTop + Math.floor(i / 7) * (ch + gap), width: cw, height: ch, borderRadius: 20, background: T.fill, opacity: gridIn, boxShadow: isToday && frame > s0 ? `inset 0 0 0 3px ${rgba(acc, 0.9)}` : undefined }}>
            {isDone[i] ? <div style={{ ...fill, borderRadius: 20, background: col, transform: `scale(${r4(Math.max(0, Math.min(1.08, on)))})`, opacity: clamp01(on * 2), boxShadow: `inset 0 1.5px 0 ${rgba("#FFFFFF", 0.25)}` }} /> : null}
          </div>
        );
      })}
      <div style={{ position: "absolute", left: pad, right: pad, top: statY, height: H - statY - pad + 10, display: "flex", alignItems: "center", justifyContent: "space-between", ...el(ctx, statAt, len(0.5), 1, 2) }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={tx(60, T.ink, FONT.displayBold, { letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" })}>{doneShown}</span>
          <span style={tx(34, T.muted, FONT.display)}>/ {N} days</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 22px", borderRadius: 30, background: rgba(acc, T.dark ? 0.16 : 0.1) }}>
          <GIcon icon="FIRE" size={36} color={T.accent} stroke={2.1} />
          <span style={tx(34, T.accent, FONT.displayBold, { fontVariantNumeric: "tabular-nums" })}>{streakShown}-day streak</span>
        </div>
      </div>
    </Shell>
  );
}

function TrackerSets({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const sets = props.items.slice(0, 8);
  const n = Math.max(1, sets.length);
  const { at, len } = clock(ctx, 0.6 + n * 0.45);
  const acc = accentOf(T, ctx);
  const pad = 44;
  const hh = headH(props.title, props.subtitle);
  const y0 = pad + (hh ? hh + 26 : 0);
  const rowH = 112;
  const current = sets.findIndex((s) => s.state !== "DONE");
  const pulse = ((frame / fps) * 0.9) % 1;
  return (
    <Shell T={T}>
      <Head ctx={ctx} T={T} x={pad} y={pad} w={W - 2 * pad - 110} title={props.title} subtitle={props.subtitle} />
      <div style={{ position: "absolute", right: pad, top: pad, ...el(ctx, at(0), len(0.5), 0, n + 1, { style: "POP" }) }}>
        <AppTile icon="DUMBBELL" size={88} color={T.dark ? mix(ctx.p.secondary, "#3A2A8C", 0.4) : T.solid} />
      </div>
      {sets.map((s, i) => {
        const s0 = at(0.3 + i * 0.45);
        const done = s.state === "DONE";
        const cur = i === current;
        const reps = Math.max(0, Math.min(15, Math.round(s.value ?? 0)));
        const repSpan = len(0.32);
        const checkAt = s0 + len(0.08) + repSpan;
        const ck = done ? springAt(frame, fps, checkAt, ctx.f.springs.punch, len(0.5)) : 0;
        const repsShown = done ? Math.round(counted(ctx, s0 + len(0.08), reps, 0, 1)) : reps;
        const dotsW = W - 2 * pad - 80 - 200;
        const dot = Math.min(24, (dotsW - 10 * Math.max(0, reps - 1)) / Math.max(1, reps));
        return (
          <div key={i} style={{ position: "absolute", left: pad, top: y0 + i * rowH, width: W - 2 * pad, height: rowH - 12, borderRadius: 26, background: cur ? rgba(acc, T.dark ? 0.12 : 0.08) : T.fill, boxShadow: cur ? `inset 0 0 0 2.5px ${rgba(acc, 0.5 + 0.3 * (1 - pulse))}` : undefined, opacity: !done && !cur ? 0.6 : 1, ...el(ctx, s0, len(0.4), i + 1, n + 1, { style: "SLIDE" }) }}>
            <div style={{ position: "absolute", left: 22, top: (rowH - 12 - 56) / 2, width: 56, height: 56, borderRadius: 28, background: done ? acc : T.fill2, display: "flex", alignItems: "center", justifyContent: "center", ...tx(28, done ? onFill(acc) : T.ink, FONT.displayBold) }}>{i + 1}</div>
            <div style={{ position: "absolute", left: 100, top: 14, right: 200 }}>
              <div style={{ ...tx(fitLine(s.text, W - 2 * pad - 300, 34, 28), T.ink, FONT.displayBold), ...oneLine }}>{s.text}</div>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                {Array.from({ length: reps }, (_, k) => {
                  const on = done ? prog(frame, s0 + len(0.08) + Math.round((repSpan * k) / Math.max(1, reps)), 3) : 0;
                  return <div key={k} style={{ width: dot, height: dot, borderRadius: dot / 2, background: on > 0 ? acc : T.fill2, transform: `scale(${r4(1 + 0.25 * Math.sin(on * Math.PI))})` }} />;
                })}
              </div>
            </div>
            <div style={{ position: "absolute", right: 96, top: 0, height: rowH - 12, display: "flex", alignItems: "baseline", justifyContent: "flex-end", gap: 8, paddingTop: 26, boxSizing: "border-box" }}>
              <span style={tx(40, T.ink, FONT.displayBold, { fontVariantNumeric: "tabular-nums" })}>{repsShown}</span>
              <span style={tx(28, T.muted, FONT.display)}>reps</span>
            </div>
            <div style={{ position: "absolute", right: 22, top: (rowH - 12 - 56) / 2, width: 56, height: 56, borderRadius: 28, boxSizing: "border-box", border: done ? "none" : `3.5px solid ${T.faint}`, background: done ? T.positive : "transparent", display: "flex", alignItems: "center", justifyContent: "center", transform: done ? `scale(${r4(Math.max(0, ck))})` : undefined }}>
              {done ? <GIcon icon="CHECK" size={32} color="#FFFFFF" stroke={3.4} /> : null}
            </div>
          </div>
        );
      })}
    </Shell>
  );
}

const MOOD_FACES: GraphicIcon[] = ["FACE_MAD", "FACE_SAD", "FACE_THINK", "FACE_SMILE", "FACE_LAUGH"];

function TrackerMood({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame, fps } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const { at, len } = clock(ctx, 2.2);
  const v = Math.max(0, Math.min(100, props.items[0]?.value ?? 50));
  const label = props.items[0]?.text ?? "";
  const pad = 44;
  const hh = headH(props.title, props.subtitle);
  const R = 270;
  const cx = W / 2;
  const cy = pad + (hh ? hh + 24 : 0) + R + 74 + 38;
  const segC = [ctx.p.negative, mix(ctx.p.negative, "#F5B83D", 0.6), "#F5B83D", mix("#F5B83D", ctx.p.positive, 0.6), ctx.p.positive];
  const arcT = prog(frame, at(0.2), len(0.8), EASE_IN_OUT);
  const ndAt = at(0.7);
  const sp = springAt(frame, fps, ndAt, ctx.f.springs.settle, len(1.2));
  const target = v / 100;
  const pos = Math.max(-0.05, Math.min(1.05, target * sp));
  const ang = Math.PI * (1 - pos);
  const sel = Math.min(4, Math.floor(target * 5 - 1e-6));
  const landed = inAt(ctx, ndAt + len(0.7), len(0.4));
  const seg = (i: number) => {
    const a0 = Math.PI * (1 - i / 5) - 0.025;
    const a1 = Math.PI * (1 - (i + 1) / 5) + 0.025;
    const p0 = { x: cx + Math.cos(a0) * R, y: cy - Math.sin(a0) * R };
    const p1 = { x: cx + Math.cos(a1) * R, y: cy - Math.sin(a1) * R };
    return `M${r1(p0.x)} ${r1(p0.y)} A${R} ${R} 0 0 1 ${r1(p1.x)} ${r1(p1.y)}`;
  };
  const needleL = R - 70;
  return (
    <Shell T={T}>
      <Head ctx={ctx} T={T} x={pad} y={pad} w={W - 2 * pad} title={props.title} subtitle={props.subtitle} align="center" />
      <svg width={W} height={H} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
        {MOOD_FACES.map((_, i) => {
          const t = clamp01(arcT * 5 - i);
          return <path key={i} d={seg(i)} fill="none" stroke={segC[i]} strokeWidth={34} strokeLinecap="butt" pathLength={1} strokeDasharray={t >= 1 ? undefined : "1 1"} strokeDashoffset={t >= 1 ? undefined : r4(1 - t)} opacity={sel === i ? 1 : 0.55 + 0.45 * (1 - landed)} />;
        })}
        <line x1={cx} y1={cy} x2={r1(cx + Math.cos(ang) * needleL)} y2={r1(cy - Math.sin(ang) * needleL)} stroke={T.ink} strokeWidth={10} strokeLinecap="round" opacity={prog(frame, ndAt - 4, 4)} />
        <circle cx={cx} cy={cy} r={22} fill={T.ink} opacity={inAt(ctx, at(0.4), len(0.3))} />
        <circle cx={cx} cy={cy} r={9} fill={T.surface} opacity={inAt(ctx, at(0.4), len(0.3))} />
      </svg>
      {MOOD_FACES.map((f, i) => {
        const a = Math.PI * (1 - (i + 0.5) / 5);
        const fr = R + 74;
        const x = cx + Math.cos(a) * fr;
        const y = cy - Math.sin(a) * fr;
        const isSel = sel === i;
        const s0 = at(0.25 + i * 0.08);
        const pop = springAt(frame, fps, s0, ctx.f.springs.soft, len(0.5));
        const sz = 76;
        const k = isSel ? 1 + 0.3 * landed : 1 - 0.12 * landed;
        return (
          <div key={i} style={{ position: "absolute", left: x - sz / 2, top: y - sz / 2, width: sz, height: sz, borderRadius: sz / 2, background: isSel ? segC[i] : T.fill, display: "flex", alignItems: "center", justifyContent: "center", opacity: prog(frame, s0, 3) * (isSel ? 1 : 1 - 0.35 * landed), transform: `scale(${r4(Math.max(0, pop) * k)})`, boxShadow: isSel ? `0 0 ${r1(30 * landed)}px ${rgba(segC[i]!, 0.6 * landed)}` : undefined }}>
            <GIcon icon={f} size={50} color={isSel ? "#FFFFFF" : T.muted} stroke={2} />
          </div>
        );
      })}
      {label ? <div style={{ position: "absolute", left: pad, right: pad, top: cy + 44, textAlign: "center", ...tx(fitLine(label, W - 2 * pad, 44, 32), T.ink, FONT.displayBold, { letterSpacing: "-0.01em" }), ...oneLine, opacity: landed, transform: `translateY(${r1((1 - landed) * 12)}px)` }}>{label}</div> : null}
    </Shell>
  );
}

// ===================================================================== LIST_SPLIT

function ListSplit({ ctx }: C) {
  return ctx.variant === "MYTH_FACT" ? <ListMythFact ctx={ctx} /> : <ListColumns ctx={ctx} />;
}

function Badge({ ok, size, T }: { ok: boolean; size: number; T: Tone }) {
  const c = ok ? T.positive : T.negative;
  return (
    <div style={{ width: size, height: size, flex: "none", borderRadius: size / 2, background: rgba(c, T.dark ? 0.2 : 0.14), boxShadow: `inset 0 0 0 2px ${rgba(c, 0.5)}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <GIcon icon={ok ? "CHECK" : "CROSS"} size={Math.round(size * 0.56)} color={c} stroke={3} />
    </div>
  );
}

function ListColumns({ ctx }: C) {
  const T = toneOf(ctx);
  const { props } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const dos = ctx.variant === "DOS_DONTS";
  const left = props.items.filter((i) => i.state !== "NO").slice(0, 10);
  const right = props.items.filter((i) => i.state === "NO").slice(0, 10);
  const rows = Math.max(1, left.length, right.length);
  const { at, len } = clock(ctx, 0.8 + (left.length + right.length) * 0.12);
  const pad = 40;
  const gap = 24;
  const colW = (W - 2 * pad - gap) / 2;
  const hh = props.title ? 62 : 0;
  const colTop = pad + (hh ? hh + 24 : 0);
  const colH = H - colTop - pad;
  const headRow = 96;
  const rowH = (colH - headRow - 16) / rows;
  const textW_ = colW - 28 - 44 - 16 - 20;
  const heads: [string, string] = [props.categories[0] || (dos ? "Do" : "Pros"), props.categories[1] || (dos ? "Don't" : "Cons")];
  const cols: Array<{ ok: boolean; items: Item[] }> = [
    { ok: true, items: left },
    { ok: false, items: right },
  ];
  const nEl = 2 + left.length + right.length;
  // Interleave the reveal: L0, R0, L1, R1…
  const orderOf = (c: number, i: number) => {
    let k = 0;
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < 2; cc++) {
        if (r < cols[cc]!.items.length) {
          if (cc === c && r === i) return k;
          k++;
        }
      }
    }
    return k;
  };
  return (
    <Shell T={T}>
      {props.title ? <Head ctx={ctx} T={T} x={pad + 4} y={pad} w={W - 2 * pad - 8} title={props.title} /> : null}
      {cols.map((col, c) => {
        const ac = col.ok ? T.positive : T.negative;
        const x = pad + c * (colW + gap);
        return (
          <div key={c} style={{ position: "absolute", left: x, top: colTop, width: colW, height: colH, borderRadius: 30, background: rgba(ac, T.dark ? 0.08 : 0.06), boxShadow: `inset 0 0 0 1.5px ${rgba(ac, T.dark ? 0.22 : 0.18)}`, ...el(ctx, at(0.1 + c * 0.1), len(0.5), c, nEl) }}>
            <div style={{ position: "absolute", left: 28, right: 28, top: 0, height: headRow, display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 52, height: 52, borderRadius: 26, flex: "none", background: ac, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <GIcon icon={col.ok ? "CHECK" : "CROSS"} size={30} color="#FFFFFF" stroke={3.4} />
              </div>
              <span style={{ ...tx(fitLine(heads[c]!, colW - 56 - 68, 40, 30), T.ink, FONT.displayBold, { letterSpacing: "-0.01em" }), ...oneLine }}>{heads[c]}</span>
            </div>
            <div style={{ position: "absolute", left: 28, right: 28, top: headRow - 1, height: 1.5, background: rgba(ac, 0.22) }} />
            {col.items.map((it, i) => {
              const f = fitWords(splitWords(it.text), textW_, rowH - 20, { max: 38, min: 30, lh: 1.2, maxLines: 3 });
              const k = orderOf(c, i);
              return (
                <div key={i} style={{ position: "absolute", left: 28, right: 20, top: headRow + 8 + i * rowH, height: rowH, display: "flex", alignItems: "center", gap: 16, ...el(ctx, at(0.35 + k * 0.12), len(0.45), 2 + k, nEl, { style: c === 0 ? "SLIDE" : "RISE" }) }}>
                  <Badge ok={col.ok} size={44} T={T} />
                  <div style={{ minWidth: 0 }}>
                    {f.lines.map((ln, j) => (
                      <div key={j} style={{ ...tx(f.size, T.ink, FONT.display, { lineHeight: 1.2 }), whiteSpace: "nowrap" }}>
                        {ln.map((w) => f.words[w]).join(" ")}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </Shell>
  );
}

function ListMythFact({ ctx }: C) {
  const T = toneOf(ctx);
  const { props, frame } = ctx;
  const W = ctx.width;
  const H = ctx.height;
  const myths = props.items.filter((i) => i.state === "NO");
  const facts = props.items.filter((i) => i.state !== "NO");
  const n = Math.max(1, Math.max(myths.length, facts.length));
  const pairs = Array.from({ length: n }, (_, i) => ({ myth: myths[i], fact: facts[i] }));
  const { at, len } = clock(ctx, 0.6 + n * 1.0);
  const pad = 40;
  const hh = props.title ? 62 : 0;
  const top = pad + (hh ? hh + 24 : 0);
  const gap = 18;
  const ph = (H - top - pad - gap * (n - 1)) / n;
  const chipW = 118;
  const tw = W - 2 * pad - 56 - chipW - 20;
  const heads: [string, string] = [props.categories[0] || "Myth", props.categories[1] || "Fact"];
  const chip = (txt: string, c: string, solid: boolean): ReactNode => (
    <div style={{ width: chipW, height: 46, flex: "none", borderRadius: 23, background: solid ? c : rgba(c, T.dark ? 0.18 : 0.12), display: "flex", alignItems: "center", justifyContent: "center", ...tx(fitLine(txt.toUpperCase(), chipW - 20, 28, 28), solid ? "#FFFFFF" : c, FONT.displayBold, { letterSpacing: "0.1em" }) }}>
      <span style={oneLine}>{txt.toUpperCase()}</span>
    </div>
  );
  return (
    <Shell T={T}>
      {props.title ? <Head ctx={ctx} T={T} x={pad + 4} y={pad} w={W - 2 * pad - 8} title={props.title} /> : null}
      {pairs.map((pr, i) => {
        const s0 = at(0.2 + i * 1.0);
        const strikeAt = s0 + len(0.4);
        const st = prog(frame, strikeAt, len(0.35), EASE_IN_OUT);
        const factAt = strikeAt + len(0.3);
        const half = (ph - 40) / 2;
        const mf = pr.myth ? fitWords(splitWords(pr.myth.text), tw, half, { max: 34, min: 28, lh: 1.2, maxLines: 2 }) : null;
        const ff = pr.fact ? fitWords(splitWords(pr.fact.text), tw, half, { max: 36, min: 28, lh: 1.2, maxLines: 2 }) : null;
        return (
          <div key={i} style={{ position: "absolute", left: pad, top: top + i * (ph + gap), width: W - 2 * pad, height: ph, borderRadius: 28, background: T.fill, ...el(ctx, s0, len(0.45), i, n) }}>
            {mf ? (
              <div style={{ position: "absolute", left: 28, right: 28, top: 20, height: half, display: "flex", alignItems: "center", gap: 20 }}>
                {chip(heads[0], T.negative, false)}
                <div style={{ position: "relative", minWidth: 0, opacity: 1 - 0.3 * st }}>
                  {mf.lines.map((ln, j) => {
                    const s = ln.map((w) => mf.words[w]).join(" ");
                    const lw = Math.min(tw, textW(s, mf.size, 0.92));
                    const lt = clamp01(st * mf.lines.length - j);
                    return (
                      <div key={j} style={{ position: "relative", ...tx(mf.size, T.muted, FONT.display, { lineHeight: 1.2 }), whiteSpace: "nowrap" }}>
                        {s}
                        <div style={{ position: "absolute", left: -4, top: "54%", height: 4, width: (lw + 8) * lt, borderRadius: 2, background: T.negative }} />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {ff ? (
              <div style={{ position: "absolute", left: 28, right: 28, top: 20 + half, height: half, display: "flex", alignItems: "center", gap: 20, ...el(ctx, mf ? factAt : s0, len(0.45), i, n, { style: "SLIDE" }) }}>
                {chip(heads[1], T.positive, true)}
                <div style={{ minWidth: 0 }}>
                  {ff.lines.map((ln, j) => (
                    <div key={j} style={{ ...tx(ff.size, T.ink, FONT.displayBold, { lineHeight: 1.2 }), whiteSpace: "nowrap" }}>
                      {ln.map((w) => ff.words[w]).join(" ")}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </Shell>
  );
}

/** Library 2 — life family components. */
export const LIFE_COMPONENTS: Partial<Record<GraphicComponent, ComponentType<{ ctx: GCtx }>>> = {
  MAP_NAV: MapNav,
  WEATHER: Weather,
  SCREEN_TIME: ScreenTime,
  PAYMENT: Payment,
  TRAVEL: Travel,
  DATE: DateC,
  TRACKER: Tracker,
  LIST_SPLIT: ListSplit,
};
