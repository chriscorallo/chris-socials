"use client";

import { memo, type ReactNode } from "react";
import { PLATFORM_UI, UI_PLATFORM_IDS, referenceVisibleX, type PlatformUi, type RailIconKind, type UiRect } from "@chris/media/timeline";
import type { PlatformId } from "../../../../lib/editor/platform-profiles";

/**
 * A realistic but unbranded mock of each app's on-screen UI (TikTok / Reels / Shorts), drawn in
 * VIDEO coordinates (viewBox 1080x1920) from the measured layout in platform-ui.ts — the same
 * regions the platform warnings check. Icon silhouettes + text-line placeholders, semi-
 * transparent, never interactive. Used by the editor preview and the full-screen view.
 *
 * `platform: "ALL"` draws only the keep-clear zones every app shares (no icons): the union of the
 * three apps' rails, caption blocks and top bars, faintly.
 */

const ICON_PATHS: Partial<Record<RailIconKind, { d: string; stroke?: boolean }>> = {
  like: { d: "M12 21l-1.5-1.3C5.4 15.1 2 12 2 8.3 2 5.3 4.4 3 7.4 3c1.7 0 3.4.8 4.6 2.1C13.2 3.8 14.9 3 16.6 3 19.6 3 22 5.3 22 8.3c0 3.7-3.4 6.8-8.5 11.4z" },
  comment: { d: "M12 3C6.5 3 2 6.8 2 11.5c0 2.6 1.4 4.9 3.6 6.5L5 22l4.4-2.4c.8.2 1.7.3 2.6.3 5.5 0 10-3.8 10-8.5S17.5 3 12 3z" },
  save: { d: "M6 2h12a1 1 0 0 1 1 1v19l-7-4.5L5 22V3a1 1 0 0 1 1-1z" },
  share: { d: "M14 4l8 7.5-8 7.5v-4.6C8.5 14.4 5 16.2 2 20c1-5.5 4.5-10.4 12-11.2z" },
  dislike: { d: "M2 4h4v10H2zM8 4h9.3c1 0 1.9.7 2.1 1.6l2 7.4c.3 1.1-.5 2-1.6 2H15l.9 4.2c.2 1-.5 1.8-1.5 1.8L8 14z" },
  repost: { d: "M7 8h10l-2.5-2.5M17 16H7l2.5 2.5M4.5 13.5V12a4 4 0 0 1 2.5-3.7M19.5 10.5V12a4 4 0 0 1-2.5 3.7", stroke: true },
  remix: { d: "M4 4h7v7H4zM13 13h7v7h-7zM14 6h3a3 3 0 0 1 3 3v1M10 18H7a3 3 0 0 1-3-3v-1", stroke: true },
};

const WHITE = "rgba(255,255,255,0.92)";
const SOFT = "rgba(255,255,255,0.62)";

function RailIcon({ kind, cx, cy, size, platform }: { kind: RailIconKind; cx: number; cy: number; size: number; platform: PlatformId }) {
  const r = size / 2;
  if (kind === "avatar") {
    return (
      <g>
        <circle cx={cx} cy={cy} r={r} fill="rgba(255,255,255,0.35)" stroke={WHITE} strokeWidth={5} />
        <circle cx={cx} cy={cy + r} r={18} fill={platform === "TIKTOK" ? "#fe2c55" : WHITE} />
        <path d={`M${cx - 9} ${cy + r}h18M${cx} ${cy + r - 9}v18`} stroke="#fff" strokeWidth={5} strokeLinecap="round" />
      </g>
    );
  }
  if (kind === "disc") {
    return (
      <g>
        <circle cx={cx} cy={cy} r={r} fill="rgba(30,30,30,0.8)" stroke="rgba(255,255,255,0.35)" strokeWidth={10} />
        <circle cx={cx} cy={cy} r={r * 0.42} fill="rgba(255,255,255,0.55)" />
      </g>
    );
  }
  if (kind === "audio") {
    return <rect x={cx - r} y={cy - r} width={size} height={size} rx={size * 0.22} fill="rgba(255,255,255,0.4)" stroke={WHITE} strokeWidth={4} />;
  }
  if (kind === "more") {
    return (
      <g fill={WHITE}>
        {[-1, 0, 1].map((i) => (
          <circle key={i} cx={cx + i * r * 0.55} cy={cy} r={size * 0.075} />
        ))}
      </g>
    );
  }
  const icon = ICON_PATHS[kind];
  if (!icon) return null;
  const s = size / 24;
  // YouTube's like is the thumbs-down shape flipped.
  const flip = platform === "YOUTUBE" && kind === "like";
  const shape = flip ? ICON_PATHS.dislike! : icon;
  return (
    <g transform={`translate(${cx - r} ${cy - r}) scale(${s})${flip ? " translate(0 24) scale(1 -1)" : ""}`}>
      <path d={shape.d} fill={shape.stroke ? "none" : WHITE} stroke={shape.stroke ? WHITE : "none"} strokeWidth={shape.stroke ? 2.2 : 0} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

function Bar({ x, cy, w, h, fill = SOFT }: { x: number; cy: number; w: number; h: number; fill?: string }) {
  return <rect x={x} y={cy - h / 2} width={w} height={h} rx={h / 2} fill={fill} />;
}

function TopBar({ ui }: { ui: PlatformUi }) {
  const t = ui.top;
  const out: ReactNode[] = [];
  const tabW = 190;
  if (t.tabs.length) {
    const gap = 44;
    const total = t.tabs.length * tabW + (t.tabs.length - 1) * gap;
    const x0 = t.align === "center" ? (1080 - total) / 2 : 88;
    t.tabs.forEach((_, i) => {
      const x = x0 + i * (tabW + gap);
      const active = i === t.activeTab;
      const w = t.align === "left" && i === 0 ? 170 : tabW;
      out.push(<Bar key={`tab${i}`} x={x} cy={t.cy} w={w} h={active ? 36 : 30} fill={active ? WHITE : "rgba(255,255,255,0.5)"} />);
      if (active && t.align === "center") out.push(<rect key="ul" x={x + w / 2 - 30} y={t.cy + 34} width={60} height={7} rx={3.5} fill={WHITE} />);
    });
  }
  let rightX = 1080 - 112;
  for (const ic of [...t.icons].reverse()) {
    if (ic === "live") {
      out.push(<rect key="live" x={88} y={t.cy - 24} width={78} height={48} rx={10} fill="none" stroke={WHITE} strokeWidth={5} />);
      continue;
    }
    const cx = rightX;
    rightX -= 110;
    if (ic === "search") {
      out.push(
        <g key="search" fill="none" stroke={WHITE} strokeWidth={7} strokeLinecap="round">
          <circle cx={cx - 6} cy={t.cy - 6} r={24} />
          <path d={`M${cx + 12} ${t.cy + 12}l18 18`} />
        </g>,
      );
    } else if (ic === "camera") {
      out.push(
        <g key="camera" fill="none" stroke={WHITE} strokeWidth={6} strokeLinejoin="round">
          <rect x={cx - 34} y={t.cy - 26} width={68} height={54} rx={14} />
          <circle cx={cx} cy={t.cy + 1} r={14} />
        </g>,
      );
    } else if (ic === "more") {
      out.push(
        <g key="more" fill={WHITE}>
          {[-1, 0, 1].map((i) => (
            <circle key={i} cx={cx} cy={t.cy + i * 18} r={6.5} />
          ))}
        </g>,
      );
    }
  }
  return <g>{out}</g>;
}

function BottomText({ ui }: { ui: PlatformUi }) {
  const { x, rows } = ui.text;
  return (
    <g>
      {rows.map((r, i) => {
        if (r.kind === "handle") {
          let cx = x;
          const parts: ReactNode[] = [];
          if (r.avatar) {
            parts.push(<circle key="av" cx={cx + 30} cy={r.cy} r={30} fill="rgba(255,255,255,0.35)" stroke={WHITE} strokeWidth={4} />);
            cx += 78;
          }
          parts.push(<Bar key="name" x={cx} cy={r.cy} w={r.w} h={r.h * 0.62} fill={WHITE} />);
          cx += r.w + 22;
          if (r.pill) {
            const pw = r.pill.length * 17 + 44;
            const filled = ui.id === "YOUTUBE";
            parts.push(<rect key="pill" x={cx} y={r.cy - 28} width={pw} height={56} rx={filled ? 28 : 14} fill={filled ? WHITE : "none"} stroke={WHITE} strokeWidth={filled ? 0 : 4} />);
          }
          return <g key={i}>{parts}</g>;
        }
        if (r.kind === "audio") {
          return (
            <g key={i}>
              <g transform={`translate(${x} ${r.cy - 17}) scale(1.4)`} fill="none" stroke={WHITE} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
              </g>
              <Bar x={x + 52} cy={r.cy} w={r.w} h={r.h * 0.6} />
            </g>
          );
        }
        return <Bar key={i} x={x} cy={r.cy} w={r.w} h={r.h * 0.62} />;
      })}
    </g>
  );
}

function Mock({ ui, progress }: { ui: PlatformUi; progress: number }) {
  return (
    <g style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.45))" }}>
      {/* the apps darken the top and bottom a little for legibility */}
      <defs>
        <linearGradient id={`pm-top-${ui.id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(0,0,0,0.32)" />
          <stop offset="1" stopColor="rgba(0,0,0,0)" />
        </linearGradient>
        <linearGradient id={`pm-bot-${ui.id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(0,0,0,0)" />
          <stop offset="1" stopColor="rgba(0,0,0,0.42)" />
        </linearGradient>
      </defs>
      <rect x={0} y={0} width={1080} height={ui.regions.topBar.y1 + 40} fill={`url(#pm-top-${ui.id})`} />
      <rect x={0} y={ui.regions.bottomText.y0 - 80} width={1080} height={1920 - ui.regions.bottomText.y0 + 80} fill={`url(#pm-bot-${ui.id})`} />
      <TopBar ui={ui} />
      {ui.rail.items.map((it, i) => (
        <g key={i}>
          <RailIcon kind={it.kind} cx={ui.rail.cx} cy={it.cy} size={it.size} platform={ui.id} />
          {it.label && <Bar x={ui.rail.cx - 34} cy={it.cy + it.size / 2 + 30} w={68} h={20} />}
        </g>
      ))}
      <BottomText ui={ui} />
      <rect x={0} y={1906} width={1080} height={6} fill="rgba(255,255,255,0.28)" />
      <rect x={0} y={1906} width={1080 * progress} height={6} fill={ui.progress.color} />
    </g>
  );
}

function Zone({ r, emphasize }: { r: UiRect; emphasize: boolean }) {
  return (
    <rect
      x={r.x0}
      y={r.y0}
      width={r.x1 - r.x0}
      height={r.y1 - r.y0}
      rx={18}
      fill={emphasize ? "rgba(255,95,110,0.16)" : "rgba(255,255,255,0.06)"}
      stroke={emphasize ? "rgba(255,120,130,0.7)" : "rgba(255,255,255,0.3)"}
      strokeWidth={3}
      strokeDasharray="14 12"
    />
  );
}

/**
 * The overlay. `w`/`h` = the canvas size on screen (the SVG scales the 1080x1920 drawing).
 * `zones` additionally tints the keep-clear regions (while dragging a text/caption/graphic).
 */
export const PlatformMock = memo(function PlatformMock({
  platform,
  w,
  h,
  zones = false,
  progress = 0.32,
  className = "",
}: {
  platform: PlatformId | "ALL";
  w: number;
  h: number;
  zones?: boolean;
  progress?: number;
  className?: string;
}) {
  const crop = referenceVisibleX();
  return (
    <svg className={`pointer-events-none absolute left-0 top-0 ${className}`} width={w} height={h} viewBox="0 0 1080 1920" preserveAspectRatio="none" aria-hidden>
      {platform === "ALL" ? (
        <g>
          <Zone r={unionOf("topBar")} emphasize={zones} />
          <Zone r={unionOf("rightRail")} emphasize={zones} />
          <Zone r={unionOf("bottomText")} emphasize={zones} />
        </g>
      ) : (
        <g>
          {zones && (
            <>
              <Zone r={PLATFORM_UI[platform].regions.topBar} emphasize />
              <Zone r={PLATFORM_UI[platform].regions.rightRail} emphasize />
              <Zone r={PLATFORM_UI[platform].regions.bottomText} emphasize />
            </>
          )}
          <Mock ui={PLATFORM_UI[platform]} progress={progress} />
        </g>
      )}
      {zones && (
        <g fill="rgba(255,95,110,0.12)">
          <rect x={0} y={0} width={crop.x0} height={1920} />
          <rect x={crop.x1} y={0} width={1080 - crop.x1} height={1920} />
        </g>
      )}
    </svg>
  );
});

function unionOf(region: "topBar" | "rightRail" | "bottomText"): UiRect {
  const rs = UI_PLATFORM_IDS.map((id) => PLATFORM_UI[id].regions[region]);
  return { x0: Math.min(...rs.map((r) => r.x0)), y0: Math.min(...rs.map((r) => r.y0)), x1: Math.max(...rs.map((r) => r.x1)), y1: Math.max(...rs.map((r) => r.y1)) };
}
