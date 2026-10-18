import {
  timelineDuration,
  timelineCaptionChunks,
  layoutTimelineText,
  layoutCaptionChunk,
  findTimelineCollisions,
  cropGeometry,
  combinedSafeZone,
  subjectBoxAt,
  uiRegionsHit,
  outsideVisibleWidth,
  rectToUi,
  scaleUiRect,
  uiOverlapArea,
  visualRect,
  TEMPLATE_FOOTPRINTS,
  PLATFORM_UI,
  type MeasureText,
  type TranscriptWord,
  type SubjectTrack,
  type TimelineVisual,
  type UiRegionId,
  type UiRect,
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

/**
 * The conservative margin rectangle (canvas px) for a set of platforms — several = the union of
 * every unsafe margin. Kept for callers that want one rectangle; the warnings below use the
 * per-platform UI regions (platform-ui.ts), which are much more precise.
 */
export function safeRect(platforms: PlatformId[], W = 1080, H = 1920): Box {
  const kx = W / 1080;
  const ky = H / 1920;
  const m = combinedSafeZone(platforms);
  return { x0: m.left * kx, y0: m.top * ky, x1: W - m.right * kx, y1: H - m.bottom * ky };
}

const REGION_HINT: Record<UiRegionId, string> = {
  topBar: "the top bar",
  rightRail: "the like/comment buttons",
  bottomText: "the caption & username",
  progressBar: "the progress bar",
};
const EDGE_HINT = "the edge (cut off on tall phones)";

/** Ignore slivers: a few px of a plate grazing a region isn't worth a warning. */
const MIN_HIT = 0.04;

/** What a rect (canvas px) sits under on one platform, as hint phrases (empty = clear). */
export function uiHitsFor(rect: UiRect, platform: PlatformId, canvas: { width: number; height: number }): string[] {
  const out = uiRegionsHit(rect, platform, canvas, { minFraction: MIN_HIT }).map((h) => REGION_HINT[h.region]);
  if (outsideVisibleWidth(rect, canvas)) out.push(EDGE_HINT);
  return out;
}

/** Joins hint phrases: "a", "a and b", "a, b and c". */
function joinHints(h: string[]): string {
  return h.length <= 1 ? (h[0] ?? "") : `${h.slice(0, -1).join(", ")} and ${h[h.length - 1]}`;
}

/** Share of the face (protected head box) a platform's buttons/caption block would cover. */
const FACE_COVER_WARN = 0.15;

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
export interface WarningExtras {
  /** Graphics with their placements resolved (AUTO ones solved) — checked against the UI. */
  visuals?: TimelineVisual[];
  /** Face tracks per take (EditorAsset.subjectTrack) — a face under the buttons is flagged. */
  tracks?: Record<string, SubjectTrack | null | undefined>;
}

export function warningsForPlatform(
  doc: EditorDoc,
  profile: PlatformProfile,
  wordsByAsset: Record<string, TranscriptWord[] | null | undefined>,
  measure: MeasureText,
  sourceSizes: Record<string, { width: number | null; height: number | null }> = {},
  extras: WarningExtras = {},
): PlatformWarning[] {
  const canvas = doc.canvas;
  const W = canvas.width;
  const H = canvas.height;
  const out: PlatformWarning[] = [];
  const p = [profile.id];
  const label = PLATFORM_SHORT_LABEL[profile.id];

  for (const t of doc.texts) {
    const hits = uiHitsFor(rectToUi(layoutTimelineText(t, canvas, measure).rect), profile.id, canvas);
    if (hits.length) {
      out.push({
        id: `text:${t.id}`,
        platforms: p,
        message: `“${snippet(t.text)}” sits under ${joinHints(hits)}`,
        target: { kind: "text", id: t.id },
      });
    }
  }

  if (doc.captions.enabled) {
    const chunks = timelineCaptionChunks(doc, wordsByAsset);
    const hits = new Set<string>();
    for (const ch of chunks) for (const h of uiHitsFor(rectToUi(layoutCaptionChunk(ch, doc.captions, canvas, measure).rect), profile.id, canvas)) hits.add(h);
    if (hits.size) {
      out.push({
        id: "captions",
        platforms: p,
        message: `Captions sit under ${joinHints([...hits])}`,
        target: { kind: "captions" },
      });
    }
  }

  for (const v of extras.visuals ?? []) {
    if (TEMPLATE_FOOTPRINTS[v.template].kind === "FULL_FRAME") continue;
    const hits = uiHitsFor(rectToUi(visualRect(v, canvas)), profile.id, canvas);
    if (hits.length) out.push({ id: `visual-ui:${v.id}`, platforms: p, message: `A graphic at ${v.start.toFixed(1)}s sits under ${joinHints(hits)}`, target: { kind: "visual", id: v.id } });
  }

  // Chris's face under the buttons / caption block (punch-ins move it): sampled per clip.
  if (extras.tracks) {
    const flagged = faceUnderUi(doc, profile.id, extras.tracks, sourceSizes);
    if (flagged) out.push({ id: `face:${profile.id}`, platforms: p, message: `Your face is partly under ${REGION_HINT[flagged.region]} in a clip`, target: { kind: "clip", id: flagged.clipId } });
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

/**
 * First clip whose framing puts the face (the tracked protected-head box, at 10/50/90 % of the
 * clip) at least FACE_COVER_WARN under the platform's rail, caption block or top bar.
 */
export function faceUnderUi(
  doc: EditorDoc,
  platform: PlatformId,
  tracks: Record<string, SubjectTrack | null | undefined>,
  sourceSizes: Record<string, { width: number | null; height: number | null }>,
): { clipId: string; region: UiRegionId } | null {
  const canvas = doc.canvas;
  const ui = PLATFORM_UI[platform];
  const zones: UiRegionId[] = ["rightRail", "bottomText", "topBar"];
  for (const c of doc.clips) {
    const track = tracks[c.mediaAssetId];
    const size = sourceSizes[c.mediaAssetId];
    if (!track || !size?.width || !size?.height) continue;
    const g = cropGeometry({ width: size.width, height: size.height }, canvas, c.crop);
    for (const f of [0.1, 0.5, 0.9]) {
      const box = subjectBoxAt(track, c.sourceStart + (c.sourceEnd - c.sourceStart) * f);
      if (!box) continue;
      const face: UiRect = {
        x0: box.x * size.width * g.scale - g.offsetX,
        y0: box.y * size.height * g.scale - g.offsetY,
        x1: (box.x + box.w) * size.width * g.scale - g.offsetX,
        y1: (box.y + box.h) * size.height * g.scale - g.offsetY,
      };
      const area = Math.max(1, (face.x1 - face.x0) * (face.y1 - face.y0));
      const region = zones.find((z) => uiOverlapArea(face, scaleUiRect(ui.regions[z], canvas)) / area >= FACE_COVER_WARN);
      if (region) return { clipId: c.id, region };
    }
  }
  return null;
}

/** Warnings for several platforms, merged by id, plus platform-independent overlap checks. */
export function platformWarnings(
  doc: EditorDoc,
  platforms: PlatformId[],
  wordsByAsset: Record<string, TranscriptWord[] | null | undefined>,
  measure: MeasureText,
  sourceSizes: Record<string, { width: number | null; height: number | null }> = {},
  extras: WarningExtras = {},
): PlatformWarning[] {
  const merged = new Map<string, PlatformWarning>();
  for (const id of platforms) {
    for (const w of warningsForPlatform(doc, PLATFORM_PROFILES[id], wordsByAsset, measure, sourceSizes, extras)) {
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
