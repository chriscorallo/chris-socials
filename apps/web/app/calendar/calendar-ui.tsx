import type { CSSProperties } from "react";
import type { CalEvent, EventStatus } from "../../lib/calendar-data";

// Shared visual vocabulary for every calendar view — one place for status colors and the
// platform dots, so Month/Week/Day/Agenda and the sheet always agree.

export const PLATFORM_COLOR: Record<string, string> = {
  TIKTOK: "#5ee7f0",
  INSTAGRAM: "#f472b6",
  YOUTUBE: "#ff6b5e",
};
export const PLATFORM_NAME: Record<string, string> = { TIKTOK: "TikTok", INSTAGRAM: "Reels", YOUTUBE: "Shorts" };
export const PLATFORM_SHORT: Record<string, string> = { TIKTOK: "TT", INSTAGRAM: "IG", YOUTUBE: "YT" };
export const ALL_PLATFORMS = ["TIKTOK", "INSTAGRAM", "YOUTUBE"] as const;

export const STATUS_LABEL: Record<EventStatus, string> = {
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  missed: "Missed",
  draft: "Not ready",
  slot: "Open slot",
};

/** Accent color per status (the event's left bar / dot). */
export const STATUS_COLOR: Record<EventStatus, string> = {
  scheduled: "var(--color-violet-400)",
  publishing: "var(--color-gold-400)",
  published: "var(--color-emerald-400)",
  failed: "var(--color-rose-400)",
  missed: "var(--color-rose-400)",
  draft: "var(--color-gold-500)",
  slot: "var(--color-gold-400)",
};

export function eventStyle(status: EventStatus): CSSProperties {
  const c = STATUS_COLOR[status];
  if (status === "slot") {
    return {
      border: `1px dashed color-mix(in srgb, ${c} 55%, transparent)`,
      background: `color-mix(in srgb, ${c} 5%, transparent)`,
      color: "var(--color-text-muted)",
    };
  }
  return {
    borderLeft: `3px solid ${c}`,
    background: `color-mix(in srgb, ${c} ${status === "draft" ? 10 : 17}%, #121216)`,
    color: "var(--color-text)",
  };
}

export function PlatformDots({ platforms, size = 6, className = "" }: { platforms: string[]; size?: number; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-[3px] ${className}`} aria-label={platforms.map((p) => PLATFORM_NAME[p] ?? p).join(", ")}>
      {platforms.map((p) => (
        <span key={p} className="rounded-full" style={{ width: size, height: size, background: PLATFORM_COLOR[p] ?? "#999" }} />
      ))}
    </span>
  );
}

export function StatusPill({ status }: { status: EventStatus }) {
  const c = STATUS_COLOR[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
      style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 30%, transparent)` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Legend() {
  const items: EventStatus[] = ["scheduled", "published", "failed", "draft", "slot"];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-[var(--color-text-faint)]">
      {items.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-[3px]"
            style={s === "slot" ? { border: `1px dashed ${STATUS_COLOR[s]}` } : { background: STATUS_COLOR[s] }}
          />
          {s === "failed" ? "Failed / missed" : STATUS_LABEL[s]}
        </span>
      ))}
      <span className="mx-1 h-3 w-px bg-[var(--color-border)]" />
      {ALL_PLATFORMS.map((p) => (
        <span key={p} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: PLATFORM_COLOR[p] }} />
          {PLATFORM_NAME[p]}
        </span>
      ))}
    </div>
  );
}

export function eventTitle(e: CalEvent): string {
  if (e.kind === "slot") return `Open · ${e.platforms.map((p) => PLATFORM_SHORT[p]).join(" ")}`;
  return e.title;
}
