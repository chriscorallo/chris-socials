import {
  timelineDuration,
  timelineCaptionChunks,
  layoutTimelineText,
  layoutCaptionChunk,
  findTimelineCollisions,
  cropGeometry,
  combinedSafeZone,
  type MeasureText,
  type TranscriptWord,
} from "@chris/media/timeline";
import { PLATFORM_PROFILES, PLATFORM_SHORT_LABEL, type PlatformId, type PlatformProfile } from "./platform-profiles";
import type { EditorDoc, Selection } from "./types";

export interface PlatformWarning {
  id: string;
  platforms: PlatformId[];
  message: string;
  /** What clicking the warning selects. */
  target: Selection;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The safe area (canvas px) for a set of platforms — several = the union of every unsafe margin. */
export function safeRect(platforms: PlatformId[], W = 1080, H = 1920): Box {
  const kx = W / 1080;
  const ky = H / 1920;
  const m = combinedSafeZone(platforms);
  return { x0: m.left * kx, y0: m.top * ky, x1: W - m.right * kx, y1: H - m.bottom * ky };
}

function outside(r: { x: number; y: number; width: number; height: number }, safe: Box): string[] {
  const sides: string[] = [];
  if (r.y < safe.y0 - 0.5) sides.push("top");
  if (r.y + r.height > safe.y1 + 0.5) sides.push("bottom");
  if (r.x < safe.x0 - 0.5) sides.push("left");
  if (r.x + r.width > safe.x1 + 0.5) sides.push("right");
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
 * Deterministic delivery checks for one platform, using the renderer's exact layouts
 * (layoutTimelineText / layoutCaptionChunk with the injected `measure`): overlay and caption
 * footprints inside the app's safe zone, duration inside the platform's limits, canvas aspect,
 * and source sharpness (a reframe so tight that < 720 source px span the 1080 canvas).
 */
export function warningsForPlatform(
  doc: EditorDoc,
  profile: PlatformProfile,
  wordsByAsset: Record<string, TranscriptWord[] | null | undefined>,
  measure: MeasureText,
  sourceSizes: Record<string, { width: number | null; height: number | null }> = {},
): PlatformWarning[] {
  const canvas = doc.canvas;
  const W = canvas.width;
  const H = canvas.height;
  const safe = safeRect([profile.id], W, H);
  const out: PlatformWarning[] = [];
  const p = [profile.id];
  const label = PLATFORM_SHORT_LABEL[profile.id];

  for (const t of doc.texts) {
    const sides = outside(layoutTimelineText(t, canvas, measure).rect, safe);
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
    const sides = new Set<string>();
    for (const ch of chunks) for (const s of outside(layoutCaptionChunk(ch, doc.captions, canvas, measure).rect, safe)) sides.add(s);
    if (sides.size) {
      out.push({
        id: "captions",
        platforms: p,
        message: `Captions sit under ${[...sides].map((s) => SIDE_HINT[s]).join(" and ")}`,
        target: { kind: "captions" },
      });
    }
  }

  const D = timelineDuration(doc);
  if (D < profile.minDurationSeconds) {
    out.push({ id: `duration-min:${profile.id}`, platforms: p, message: `Too short for ${label} (min ${profile.minDurationSeconds}s)`, target: null });
  } else if (D > profile.maxDurationSeconds) {
    out.push({
      id: `duration-max:${profile.id}`,
      platforms: p,
      message: `Too long for ${label} — ${Math.round(D)}s, max ${profile.maxDurationSeconds}s`,
      target: null,
    });
  }

  if (Math.abs(W / H - profile.canvas.width / profile.canvas.height) > 0.01) {
    out.push({ id: "aspect", platforms: p, message: `${label} wants a vertical ${profile.canvas.width}×${profile.canvas.height} (9:16) video`, target: null });
  }

  for (const c of doc.clips) {
    const s = sourceSizes[c.mediaAssetId];
    if (!s?.width || !s?.height) continue;
    const g = cropGeometry({ width: s.width, height: s.height }, canvas, c.crop);
    const sourcePxAcross = W / g.scale;
    if (sourcePxAcross < 720 * (W / 1080)) {
      out.push({ id: `soft:${c.id}`, platforms: p, message: "A clip is zoomed in so far it will look soft", target: { kind: "clip", id: c.id } });
    }
  }
  return out;
}

/** Warnings for several platforms, merged by id, plus platform-independent overlap checks. */
export function platformWarnings(
  doc: EditorDoc,
  platforms: PlatformId[],
  wordsByAsset: Record<string, TranscriptWord[] | null | undefined>,
  measure: MeasureText,
  sourceSizes: Record<string, { width: number | null; height: number | null }> = {},
): PlatformWarning[] {
  const merged = new Map<string, PlatformWarning>();
  for (const id of platforms) {
    for (const w of warningsForPlatform(doc, PLATFORM_PROFILES[id], wordsByAsset, measure, sourceSizes)) {
      const existing = merged.get(w.id);
      if (existing) existing.platforms.push(...w.platforms);
      else merged.set(w.id, { ...w, platforms: [...w.platforms] });
    }
  }
  // Overlaps the Quality Gate would flag (same function the gate uses).
  const chunks = timelineCaptionChunks(doc, wordsByAsset);
  const seen = new Set<string>();
  for (const c of findTimelineCollisions(doc, chunks, measure)) {
    const key = `${c.kind}:${c.a}:${c.b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = doc.texts.find((t) => t.text === c.b);
    merged.set(`overlap:${key}`, {
      id: `overlap:${key}`,
      platforms: [...platforms],
      message:
        c.kind === "CAPTION_TEXT"
          ? `Captions overlap “${snippet(c.b)}” around ${c.overlapStartSeconds.toFixed(1)}s`
          : `“${snippet(c.a)}” and “${snippet(c.b)}” overlap`,
      target: text ? { kind: "text", id: text.id } : null,
    });
  }
  return [...merged.values()];
}
