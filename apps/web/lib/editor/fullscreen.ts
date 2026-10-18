/**
 * Full-screen view of the edited video (MobileShell / Preview "full screen" button) — pure layout
 * and state helpers, unit-tested.
 *
 * Plain mode: the whole 9:16 frame, CONTAINED (fit) in the screen and centred — exactly what was
 * edited, nothing cropped. Platform mode ("show TikTok / Reels / Shorts UI"): laid out like the
 * app's feed (platform-ui.ts) — the video FILLS the area above the app's opaque bottom nav bar
 * (cropping a little off the sides on tall phones), the nav bar sits below it, and the app's UI
 * mock is drawn over the video.
 */
import { referenceVisibleX, screenFit } from "@chris/media/timeline";
import type { PlatformId } from "./platform-profiles";

/** The apps' bottom nav bar above the home indicator (pt), iOS tab-bar height. */
export const APP_NAV_BAR_PT = 49;
/** Controls hide after this long without a touch while playing. */
export const CONTROLS_AUTO_HIDE_MS = 2600;
/** A downward swipe this long (px), or a quick flick, closes full screen. */
export const SWIPE_CLOSE_PX = 90;
export const SWIPE_CLOSE_VELOCITY = 0.6; // px per ms

export interface FullscreenLayout {
  /** Size of the 9:16 canvas (may be larger than the viewport when filled). */
  canvas: { w: number; h: number };
  /** Top-left of the canvas inside the viewport. */
  x: number;
  y: number;
  /** The area the video may occupy (clips the canvas). */
  clip: { x: number; y: number; w: number; h: number };
  /** The app's nav bar below the video (platform mode only). */
  nav: { y: number; h: number } | null;
}

/**
 * Where the canvas goes in a full-screen viewport. `safeBottom` = env(safe-area-inset-bottom)
 * (home indicator), added to the nav bar like the apps do.
 */
export function fullscreenLayout(
  viewport: { w: number; h: number },
  platform: PlatformId | null,
  safeBottom = 0,
  aspect = 9 / 16,
): FullscreenLayout {
  const video = { width: 1080, height: Math.round(1080 / aspect) };
  if (!platform) {
    const f = screenFit({ width: viewport.w, height: viewport.h }, "CONTAIN", video);
    const w = Math.floor(f.width);
    const h = Math.floor(f.height);
    const x = Math.round((viewport.w - w) / 2);
    const y = Math.round((viewport.h - h) / 2);
    return { canvas: { w, h }, x, y, clip: { x, y, w, h }, nav: null };
  }
  // The UI mock is laid out for the reference phone (platform-ui.ts), where the app crops ~49 px
  // off each side. Reproduce that crop whenever the screen is tall enough (the nav bar takes the
  // rest — exactly 83 pt on a 393x852 screen); on a shorter viewport (Safari's toolbars, older
  // phones) fill the area above a normal nav bar instead.
  const minNav = APP_NAV_BAR_PT + Math.max(0, safeBottom);
  const ref = referenceVisibleX();
  const refScale = viewport.w / (ref.x1 - ref.x0);
  const refH = video.height * refScale;
  const navH = viewport.h - refH >= minNav ? viewport.h - refH : minNav;
  const areaH = Math.max(0, viewport.h - navH);
  const f = screenFit({ width: viewport.w, height: areaH }, "FILL", video);
  const w = Math.ceil(f.width);
  const h = Math.ceil(f.height);
  return {
    canvas: { w, h },
    x: Math.round((viewport.w - w) / 2),
    y: Math.round((areaH - h) / 2),
    clip: { x: 0, y: 0, w: viewport.w, h: areaH },
    nav: { y: areaH, h: navH },
  };
}

/** Whether a vertical drag should close full screen. */
export function swipeCloses(dy: number, dtMs: number, dx = 0): boolean {
  if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) return false;
  return dy >= SWIPE_CLOSE_PX || (dy >= 30 && dy / Math.max(1, dtMs) >= SWIPE_CLOSE_VELOCITY);
}

export type FullscreenPlatform = PlatformId | "NONE";

export interface FullscreenPrefs {
  /** Which app's UI to draw over the video in full screen ("NONE" = plain). */
  platform: FullscreenPlatform;
  muted: boolean;
}

export const FULLSCREEN_PREFS_KEY = "ed.fullscreen.v1";
export const DEFAULT_FULLSCREEN_PREFS: FullscreenPrefs = { platform: "NONE", muted: false };
const PLATFORMS: FullscreenPlatform[] = ["NONE", "TIKTOK", "INSTAGRAM", "YOUTUBE"];

/** Parses stored prefs; anything unexpected falls back to the defaults (never throws). */
export function parseFullscreenPrefs(raw: string | null | undefined): FullscreenPrefs {
  if (!raw) return DEFAULT_FULLSCREEN_PREFS;
  try {
    const v = JSON.parse(raw) as Partial<FullscreenPrefs>;
    return {
      platform: PLATFORMS.includes(v.platform as FullscreenPlatform) ? (v.platform as FullscreenPlatform) : DEFAULT_FULLSCREEN_PREFS.platform,
      muted: typeof v.muted === "boolean" ? v.muted : DEFAULT_FULLSCREEN_PREFS.muted,
    };
  } catch {
    return DEFAULT_FULLSCREEN_PREFS;
  }
}

/** localStorage read, guarded (private mode / blocked storage / SSR → defaults). */
export function loadFullscreenPrefs(storage: Pick<Storage, "getItem"> | null | undefined = typeof window !== "undefined" ? safeStorage() : null): FullscreenPrefs {
  try {
    return parseFullscreenPrefs(storage?.getItem(FULLSCREEN_PREFS_KEY));
  } catch {
    return DEFAULT_FULLSCREEN_PREFS;
  }
}

export function saveFullscreenPrefs(p: FullscreenPrefs, storage: Pick<Storage, "setItem"> | null | undefined = typeof window !== "undefined" ? safeStorage() : null): void {
  try {
    storage?.setItem(FULLSCREEN_PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage full / blocked — the choice just isn't remembered */
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Next platform in the full-screen "UI" switch: none → TikTok → Reels → Shorts → none. */
export function nextFullscreenPlatform(p: FullscreenPlatform): FullscreenPlatform {
  return PLATFORMS[(PLATFORMS.indexOf(p) + 1) % PLATFORMS.length]!;
}
