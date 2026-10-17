/**
 * Per-platform delivery profiles used by the editor's platform preview, safe-zone warnings,
 * and the Finish & schedule readiness check.
 *
 * TEMPORARY local fallback. The renderer workstream is adding `PLATFORM_PROFILES` (same shape)
 * to `@chris/media/timeline`; once merged, the integrator replaces the body of this file with
 *   `export { PLATFORM_PROFILES } from "@chris/media/timeline";`
 * (and the type re-export) — nothing else in the editor imports platform data directly.
 * See docs/decisions-pending/editor-ui.md, INTEGRATION NOTES.
 */
export type PlatformId = "INSTAGRAM" | "TIKTOK" | "YOUTUBE";

export interface PlatformProfile {
  id: PlatformId;
  label: string;
  canvas: { width: number; height: number };
  minDurationSeconds: number;
  maxDurationSeconds: number;
  /** Unsafe margins, px at 1080x1920 — covered by the app's own UI. */
  safeZone: { top: number; bottom: number; left: number; right: number };
  coverFrame: { supported: boolean; note?: string };
}

// TEMPORARY values — approximations of each app's overlay chrome in late 2026.
export const PLATFORM_PROFILES: Record<PlatformId, PlatformProfile> = {
  TIKTOK: {
    id: "TIKTOK",
    label: "TikTok",
    canvas: { width: 1080, height: 1920 },
    minDurationSeconds: 3,
    maxDurationSeconds: 600,
    safeZone: { top: 150, bottom: 420, left: 60, right: 140 },
    coverFrame: { supported: true, note: "TikTok uses the cover frame offset you pick here." },
  },
  INSTAGRAM: {
    id: "INSTAGRAM",
    label: "Reels",
    canvas: { width: 1080, height: 1920 },
    minDurationSeconds: 3,
    maxDurationSeconds: 180,
    safeZone: { top: 220, bottom: 420, left: 60, right: 140 },
    coverFrame: { supported: true, note: "Reels uses this frame as the cover (thumb_offset)." },
  },
  YOUTUBE: {
    id: "YOUTUBE",
    label: "Shorts",
    canvas: { width: 1080, height: 1920 },
    minDurationSeconds: 1,
    maxDurationSeconds: 180,
    safeZone: { top: 180, bottom: 360, left: 60, right: 140 },
    coverFrame: { supported: false, note: "Shorts picks its own thumbnail from the video." },
  },
};

export const PLATFORM_IDS: PlatformId[] = ["TIKTOK", "INSTAGRAM", "YOUTUBE"];
