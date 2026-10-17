/**
 * Per-platform delivery profiles — the renderer workstream's PLATFORM_PROFILES (same numbers
 * preflight and the variant encoder use). The editor only adds a display order and short
 * labels for its compact controls.
 */
export { PLATFORM_PROFILES, combinedSafeZone, type PlatformId, type PlatformProfile } from "@chris/media/timeline";
import type { PlatformId } from "@chris/media/timeline";

export const PLATFORM_IDS: PlatformId[] = ["TIKTOK", "INSTAGRAM", "YOUTUBE"];

/** Short labels for tight UI (segmented control, checkboxes). */
export const PLATFORM_SHORT_LABEL: Record<PlatformId, string> = {
  TIKTOK: "TikTok",
  INSTAGRAM: "Reels",
  YOUTUBE: "Shorts",
};
