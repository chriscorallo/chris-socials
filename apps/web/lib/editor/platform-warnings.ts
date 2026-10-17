import { timelineDuration, timelineCaptionChunks, type TranscriptWord } from "@chris/media/timeline";
import { PLATFORM_PROFILES, PLATFORM_IDS, type PlatformId, type PlatformProfile } from "./platform-profiles";
import { estimateTextBox, estimateCaptionBox, coverLayout, type Box } from "./preview-math";
import type { EditorDoc, Selection } from "./types";

export interface PlatformWarning {
  id: string;
  platforms: PlatformId[];
  message: string;
  /** What clicking the warning selects. */
  target: Selection;
}

/** The safe area (canvas px) for a set of platforms — "All" = the union of every unsafe margin. */
export function safeRect(platforms: PlatformId[], W = 1080, H = 1920): Box {
  const kx = W / 1080;
  const ky = H / 1920;
  const zones = platforms.map((p) => PLATFORM_PROFILES[p].safeZone);
  const m = {
    top: Math.max(...zones.map((z) => z.top)),
    bottom: Math.max(...zones.map((z) => z.bottom)),
    left: Math.max(...zones.map((z) => z.left)),
    right: Math.max(...zones.map((z) => z.right)),
  };
  return { x0: m.left * kx, y0: m.top * ky, x1: W - m.right * kx, y1: H - m.bottom * ky };
}

function outside(box: Box, safe: Box): string[] {
  const sides: string[] = [];
  if (box.y0 < safe.y0 - 0.5) sides.push("top");
  if (box.y1 > safe.y1 + 0.5) sides.push("bottom");
  if (box.x0 < safe.x0 - 0.5) sides.push("left");
  if (box.x1 > safe.x1 + 0.5) sides.push("right");
  return sides;
}

const SIDE_HINT: Record<string, string> = {
  top: "the top bar",
  bottom: "the caption & username area",
  left: "the left edge",
  right: "the like/comment buttons",
};

function snippet(s: string) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 24 ? `${t.slice(0, 22)}…` : t;
}

/**
 * Deterministic delivery checks for one platform: overlay/caption boxes inside the app's safe
 * zone, duration inside the platform's limits, canvas aspect, and source sharpness (a clip
 * reframed so far in that fewer than 720 source pixels span the 1080 canvas looks soft).
 */
export function warningsForPlatform(
  doc: EditorDoc,
  profile: PlatformProfile,
  wordsByAsset: Record<string, TranscriptWord[] | null | undefined>,
  sourceSizes: Record<string, { width: number | null; height: number | null }> = {},
): PlatformWarning[] {
  const W = doc.canvas.width;
  const H = doc.canvas.height;
  const safe = safeRect([profile.id], W, H);
  const out: PlatformWarning[] = [];
  const p = [profile.id];

  for (const t of doc.texts) {
    const sides = outside(estimateTextBox(t, W, H), safe);
    if (sides.length) {
      out.push({
        id: `text:${t.id}`,
        platforms: p,
        message: `“${snippet(t.text)}” sits under ${sides.map((s) => SIDE_HINT[s]).join(" and ")}`,
        target: { kind: "text", id: t.id },
      });
    }
  }

  if (doc.captions.enabled) {
    const chunks = timelineCaptionChunks(doc, wordsByAsset);
    if (chunks.length) {
      const longest = chunks.reduce((a, c) => (c.text.length > a.length ? c.text : a), "");
      const sides = outside(estimateCaptionBox(doc.captions, longest, W, H), safe);
      if (sides.length) {
        out.push({
          id: "captions",
          platforms: p,
          message: `Captions sit under ${sides.map((s) => SIDE_HINT[s]).join(" and ")}`,
          target: { kind: "captions" },
        });
      }
    }
  }

  const D = timelineDuration(doc);
  if (D < profile.minDurationSeconds) {
    out.push({ id: `duration-min:${profile.id}`, platforms: p, message: `Too short for ${profile.label} (min ${profile.minDurationSeconds}s)`, target: null });
  } else if (D > profile.maxDurationSeconds) {
    out.push({
      id: `duration-max:${profile.id}`,
      platforms: p,
      message: `Too long for ${profile.label} — ${Math.round(D)}s, max ${profile.maxDurationSeconds}s`,
      target: null,
    });
  }

  if (Math.abs(W / H - profile.canvas.width / profile.canvas.height) > 0.01) {
    out.push({ id: "aspect", platforms: p, message: `${profile.label} wants ${profile.canvas.width}×${profile.canvas.height} (9:16)`, target: null });
  }

  for (const c of doc.clips) {
    const s = sourceSizes[c.mediaAssetId];
    if (!s?.width || !s?.height) continue;
    const { baseW } = coverLayout(s.width, s.height, W, H, c.crop);
    const sourcePxAcross = (s.width * W) / (baseW * c.crop.zoom);
    if (sourcePxAcross < 720 * (W / 1080)) {
      out.push({
        id: `soft:${c.id}`,
        platforms: p,
        message: "A clip is zoomed in so far it will look soft",
        target: { kind: "clip", id: c.id },
      });
    }
  }
  return out;
}

/** Warnings for several platforms, merged by id (so "All" lists each problem once, tagged). */
export function platformWarnings(
  doc: EditorDoc,
  platforms: PlatformId[],
  wordsByAsset: Record<string, TranscriptWord[] | null | undefined>,
  sourceSizes: Record<string, { width: number | null; height: number | null }> = {},
): PlatformWarning[] {
  const merged = new Map<string, PlatformWarning>();
  for (const id of platforms) {
    for (const w of warningsForPlatform(doc, PLATFORM_PROFILES[id], wordsByAsset, sourceSizes)) {
      const existing = merged.get(w.id);
      if (existing) existing.platforms.push(...w.platforms);
      else merged.set(w.id, { ...w, platforms: [...w.platforms] });
    }
  }
  return [...merged.values()];
}

export { PLATFORM_IDS };
