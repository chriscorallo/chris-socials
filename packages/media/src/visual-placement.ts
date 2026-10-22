/**
 * Placement engine for motion graphics — PURE and deterministic (browser-safe: the finishing
 * editor calls it live while Chris drags things; the worker calls it before saving/rendering).
 *
 * For every visual with `placement.mode === "AUTO"` it:
 * 1. maps Chris's protected head region (MediaAsset.subjectTrack, SOURCE-frame fractions)
 *    through each clip's crop (cropGeometry) and the output zooms into OUTPUT canvas px, and
 *    unions it over the visual's time window; derives the approximate body region below it;
 * 2. collects obstacles: head (HARD), caption blocks active then (HARD), text overlays active
 *    then (HARD), other visuals on screen then (HARD), body (SOFT — allowed, penalised);
 *    the platform UI safe zone bounds where anything may go at all;
 * 3. scores a deterministic grid of candidate centres x scales (1, 0.9, 0.8, 0.7) and keeps
 *    the best — biggest, clear of every hard obstacle, least over the torso, near the
 *    template's preferred height, balanced, and close to where it already was (so re-solving
 *    while Chris edits doesn't make graphics jump around).
 * If nothing is fully clear it returns the least-bad spot and a LOW_CONFIDENCE warning —
 * never a silent overlap. MANUAL visuals are never moved; they're obstacles for the AUTO
 * ones and get a warning if they cover Chris's face or the captions.
 *
 * In AUTO mode the engine owns x, y AND scale (it always solves from scale 1, so repeated
 * solves never compound a shrink). To size a graphic by hand, set it MANUAL.
 */
import { PLACEMENT_SAFE_ZONE, type SafeZonePx } from "./platform-profiles";
import type { Rect } from "./safe-zones";
import { locateOutputTime, timelineDuration, clipStartTimes, type EditTimeline } from "./timeline";
import {
  cropGeometry,
  layoutCaptionChunk,
  layoutTimelineText,
  normalizeZooms,
  zoomStateAt,
  zoomWindow,
  LAYOUT,
  type MeasureText,
} from "./timeline-layout";
import { timelineCaptionChunks } from "./timeline-captions";
import type { TranscriptWord } from "./caption-chunking";
import type { TimelineVisual } from "./motion-contract";
import { bodyRegionFromHead, subjectBoxAt, type NormBox, type SubjectTrack } from "./subject-track-core";
import { footprintOf, footprintPx, MIN_AUTO_SCALE_FACTOR } from "./visual-footprints";

export interface PlacementOptions {
  /** MediaAsset id -> its subject track (null/absent = not analysed yet). */
  subjectTracks: Record<string, SubjectTrack | null | undefined>;
  /** Platform chrome to stay out of, px at 1080x1920 (default: union of all platforms). */
  platformSafe?: SafeZonePx;
  /** MediaAsset id -> source frame size. Missing = assume the source has the canvas aspect. */
  sourceDimensions?: Record<string, { width: number; height: number } | null | undefined>;
  /** Exact glyph measurement (same one the renderer/preview use). Without it, caption and
   * text footprints are conservative estimates. */
  measure?: MeasureText;
  /** Word timings per take — with `measure`, caption obstacles are the exact caption blocks
   * on screen during each visual. Without them, the whole caption band is an obstacle. */
  wordsByAsset?: Record<string, TranscriptWord[] | null | undefined>;
  /** Clear gap kept around hard obstacles, px at 1080 wide (default 24). */
  marginPx?: number;
  /**
   * MediaAsset id -> whether a person matte exists for that take. With mattes, the AUTO
   * solver may choose the classic depth composition for big type (see AUTO_DEPTH_TEMPLATES):
   * the graphic sits partly BEHIND Chris's head instead of being pushed away from it.
   */
  mattes?: Record<string, boolean | null | undefined>;
  /**
   * Visual id -> the zone the Screen Orchestrator opened for it (canvas px). A candidate spot
   * inside the zone is preferred; outside it costs more, but face / caption / text avoidance
   * still wins (the zone is a preference, the obstacles are rules).
   */
  preferredRects?: Record<string, Rect | null | undefined>;
}

/** Templates the auto-depth rule may put behind Chris (big, bold type only). */
export const AUTO_DEPTH_TEMPLATES = new Set(["KINETIC_TEXT", "NUMBER_COUNTER", "TITLE_CARD"] as const);
/**
 * Max share of the type's glyph band Chris's head may hide — legibility first: numbers are
 * facts (a hidden digit is a wrong number), words survive a little more occlusion.
 */
export const AUTO_DEPTH_MAX_COVER = { NUMBER_COUNTER: 0.2, KINETIC_TEXT: 0.34 } as const;

/**
 * The head SHAPE inside a protected head region (subject-track-core's expansion of a face box:
 * +0.35 face widths each side, +0.6 face heights above, +0.25 below): an ellipse ~1.1 face
 * widths wide from the top of the hair (≈ 0.25 face heights above the face) to the chin.
 */
export function headEllipseFromProtected(r: Rect): { cx: number; cy: number; rx: number; ry: number } {
  const top = r.y + r.height * (0.25 / 1.85);
  const bottom = r.y + r.height * (1.6 / 1.85);
  return { cx: r.x + r.width / 2, cy: (top + bottom) / 2, rx: (r.width * (1.1 / 1.7)) / 2, ry: (bottom - top) / 2 };
}

/** Share of `rect` covered by an ellipse (numerical, 48×24 samples). */
export function ellipseCoverage(rect: Rect, e: { cx: number; cy: number; rx: number; ry: number }): number {
  if (rect.width <= 0 || rect.height <= 0) return 0;
  const nx = 48;
  const ny = 24;
  let inside = 0;
  for (let j = 0; j < ny; j++) {
    const y = rect.y + ((j + 0.5) / ny) * rect.height;
    for (let i = 0; i < nx; i++) {
      const x = rect.x + ((i + 0.5) / nx) * rect.width;
      const dx = (x - e.cx) / e.rx;
      const dy = (y - e.cy) / e.ry;
      if (dx * dx + dy * dy <= 1) inside++;
    }
  }
  return inside / (nx * ny);
}

export type PlacementWarningCode =
  | "LOW_CONFIDENCE"
  | "NO_SUBJECT_TRACK"
  | "SHRUNK"
  | "MANUAL_COVERS_SUBJECT"
  | "MANUAL_COVERS_CAPTIONS"
  | "MANUAL_OUTSIDE_SAFE_ZONE";

export interface PlacementWarning {
  visualId: string;
  code: PlacementWarningCode;
  severity: "INFO" | "WARNING";
  message: string;
}

export interface PlacementDetail {
  /** Final footprint on the canvas, px. */
  rect: Rect;
  /** Chris's protected head region over the visual's window (output px), if known. */
  head: Rect | null;
  body: Rect | null;
  confidence: "HIGH" | "LOW";
}

export interface PlacementResult {
  visuals: TimelineVisual[];
  warnings: PlacementWarning[];
  details: Record<string, PlacementDetail>;
}

/** Where we assume the head is when a take has no subject track yet (canvas fractions) —
 * the typical centred vertical talking-head framing, generous on purpose. */
export const ASSUMED_HEAD_REGION = { x: 0.26, y: 0.12, w: 0.48, h: 0.36 } as const;

const SCALE_FACTORS = [1, 0.9, 0.8, MIN_AUTO_SCALE_FACTOR];
const SAMPLE_STEP_SECONDS = 0.25;

// ---------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------

export function rectArea(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

export function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width);
  const y2 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function inflate(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m };
}

function clipToCanvas(r: Rect, canvas: { width: number; height: number }): Rect | null {
  const x1 = Math.max(0, r.x);
  const y1 = Math.max(0, r.y);
  const x2 = Math.min(canvas.width, r.x + r.width);
  const y2 = Math.min(canvas.height, r.y + r.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null;
}

/** The safe placement area in canvas px for a platform safe zone given at 1080x1920. */
export function placementSafeArea(canvas: { width: number; height: number }, zone: SafeZonePx = PLACEMENT_SAFE_ZONE): Rect {
  const sx = canvas.width / 1080;
  const sy = canvas.height / 1920;
  const left = Math.round(zone.left * sx);
  const top = Math.round(zone.top * sy);
  return {
    x: left,
    y: top,
    width: canvas.width - Math.round(zone.right * sx) - left,
    height: canvas.height - Math.round(zone.bottom * sy) - top,
  };
}

/** A visual's on-canvas footprint (centre x/y + template size x scale), px. */
export function visualRect(v: Pick<TimelineVisual, "template" | "placement"> & { props?: unknown }, canvas: { width: number; height: number }): Rect {
  const fp = footprintOf(v.template, v.props);
  if (fp.kind === "FULL_FRAME") return { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const { width, height } = footprintPx(v.template, v.placement.scale, canvas, v.props);
  return {
    x: Math.round(v.placement.x * canvas.width - width / 2),
    y: Math.round(v.placement.y * canvas.height - height / 2),
    width,
    height,
  };
}

/** Maps a SOURCE-fraction box through a clip crop + output zoom into canvas px. */
export function mapSourceBoxToCanvas(
  box: NormBox,
  source: { width: number; height: number },
  canvas: { width: number; height: number },
  crop: EditTimeline["clips"][number]["crop"],
  zoom: { zoom: number; x: number; y: number },
): Rect | null {
  const g = cropGeometry(source, canvas, crop);
  const x1 = box.x * source.width * g.scale - g.offsetX;
  const y1 = box.y * source.height * g.scale - g.offsetY;
  const x2 = (box.x + box.w) * source.width * g.scale - g.offsetX;
  const y2 = (box.y + box.h) * source.height * g.scale - g.offsetY;
  const win = zoomWindow(zoom, canvas);
  const z = zoom.zoom;
  const r = { x: (x1 - win.x) * z, y: (y1 - win.y) * z, width: (x2 - x1) * z, height: (y2 - y1) * z };
  return clipToCanvas(r, canvas);
}

// ---------------------------------------------------------------------------------------
// Subject over a time window
// ---------------------------------------------------------------------------------------

export interface SubjectWindow {
  head: Rect | null;
  body: Rect | null;
  /** False when at least one clip in the window has no subject track (head is assumed). */
  tracked: boolean;
}

/**
 * Union of Chris's protected head region (and derived body region) on the OUTPUT canvas over
 * [start, end]. Untracked clips contribute ASSUMED_HEAD_REGION (and `tracked` = false); a
 * tracked clip where no face was detected contributes nothing.
 */
export function subjectRegionsForWindow(
  timeline: Pick<EditTimeline, "clips" | "canvas" | "zooms">,
  start: number,
  end: number,
  options: Pick<PlacementOptions, "subjectTracks" | "sourceDimensions">,
): SubjectWindow {
  const canvas = timeline.canvas;
  const duration = timelineDuration(timeline);
  const { zooms } = normalizeZooms(timeline.zooms, duration);
  const s = Math.max(0, Math.min(start, duration));
  const e = Math.max(s, Math.min(end, duration));
  const times = new Set<number>();
  for (let t = s; t < e; t += SAMPLE_STEP_SECONDS) times.add(round3(t));
  times.add(round3(Math.max(s, e - 1e-3)));
  // Every clip boundary inside the window (just after the cut) + zoom boundaries.
  clipStartTimes(timeline).forEach((cs) => {
    if (cs > s && cs < e) times.add(round3(cs + 1e-3));
  });
  for (const z of zooms) {
    if (z.start > s && z.start < e) times.add(round3(z.start + 1e-3));
    if (z.end > s && z.end < e) times.add(round3(z.end + 1e-3));
  }

  let head: Rect | null = null;
  let body: Rect | null = null;
  let tracked = true;
  for (const t of [...times].sort((a, b) => a - b)) {
    const loc = locateOutputTime(timeline, t);
    if (!loc) continue;
    const clip = timeline.clips[loc.clipIndex]!;
    const zoom = zoomStateAt(zooms, t);
    const track = options.subjectTracks[clip.mediaAssetId];
    const src = options.sourceDimensions?.[clip.mediaAssetId] ?? canvas;
    if (!track || track.length === 0) {
      tracked = false;
      const a = ASSUMED_HEAD_REGION;
      const r = {
        x: a.x * canvas.width,
        y: a.y * canvas.height,
        width: a.w * canvas.width,
        height: a.h * canvas.height,
      };
      head = unionRect(head, r);
      body = unionRect(body, {
        x: r.x - r.width * 0.3,
        y: r.y + r.height,
        width: r.width * 1.6,
        height: canvas.height - (r.y + r.height),
      });
      continue;
    }
    const box = subjectBoxAt(track, loc.sourceTime);
    if (!box) continue;
    const h = mapSourceBoxToCanvas(box, src, canvas, clip.crop, zoom);
    if (h) head = unionRect(head, h);
    const b = mapSourceBoxToCanvas(bodyRegionFromHead(box), src, canvas, clip.crop, zoom);
    if (b) body = unionRect(body, b);
  }
  return { head, body, tracked };
}

// ---------------------------------------------------------------------------------------
// Caption / text footprints
// ---------------------------------------------------------------------------------------

function estimatedTextRect(t: EditTimeline["texts"][number], canvas: { width: number; height: number }): Rect {
  const k = canvas.width / 1080;
  const fontPx = t.fontSize * k;
  const maxW = t.maxWidth * canvas.width;
  const textW = t.text.length * fontPx * 0.56;
  const lines = Math.max(1, Math.ceil(textW / maxW)) + (t.text.match(/\n/g)?.length ?? 0);
  const pad = t.backgroundColor ? fontPx * 0.5 : fontPx * 0.1;
  const w = Math.min(maxW, textW) + 2 * pad;
  const h = lines * fontPx * LAYOUT.text.lineHeight + 2 * pad;
  return { x: t.x * canvas.width - w / 2, y: t.y * canvas.height - h / 2, width: w, height: h };
}

function textRect(t: EditTimeline["texts"][number], canvas: { width: number; height: number }, measure?: MeasureText): Rect {
  if (measure) {
    try {
      return layoutTimelineText(t, canvas, measure).rect;
    } catch {
      // unknown font etc. — fall back to the estimate rather than ignoring the text
    }
  }
  return estimatedTextRect(t, canvas);
}

/** Conservative caption band (two lines) at captions.y. */
export function captionBandRect(captions: EditTimeline["captions"], canvas: { width: number; height: number }): Rect {
  const k = canvas.width / 1080;
  const fontPx = captions.fontSize * k;
  const h = 2 * fontPx * LAYOUT.captions.lineHeight + fontPx * 0.6;
  const w = LAYOUT.captions.maxWidth * canvas.width + fontPx * 0.8;
  return { x: (canvas.width - w) / 2, y: captions.y * canvas.height - h / 2, width: w, height: h };
}

interface CaptionIndex {
  chunks: Array<{ start: number; end: number; rect: Rect }> | null;
  band: Rect;
}

function buildCaptionIndex(timeline: EditTimeline, options: PlacementOptions): CaptionIndex | null {
  if (!timeline.captions.enabled) return null;
  const band = captionBandRect(timeline.captions, timeline.canvas);
  if (!options.measure || !options.wordsByAsset) return { chunks: null, band };
  try {
    const chunks = timelineCaptionChunks(timeline, options.wordsByAsset).map((c) => ({
      start: c.start,
      end: c.end,
      rect: layoutCaptionChunk(c, timeline.captions, timeline.canvas, options.measure!).rect,
    }));
    return { chunks, band };
  } catch {
    return { chunks: null, band };
  }
}

function captionObstacles(index: CaptionIndex | null, start: number, end: number): Rect[] {
  if (!index) return [];
  if (!index.chunks) return [index.band];
  return index.chunks.filter((c) => c.start < end && c.end > start).map((c) => c.rect);
}

// ---------------------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------------------

interface Candidate {
  cx: number;
  cy: number;
  factor: number;
  rect: Rect;
  score: number;
  hardOverlap: number;
}

function overlapNames(rect: Rect, named: Array<{ name: string; rect: Rect }>): string[] {
  return [...new Set(named.filter((n) => intersectionArea(rect, n.rect) > 0).map((n) => n.name))];
}

/**
 * Resolves AUTO placements. Returns the visuals (same order as the input), warnings for the
 * editor, and per-visual details (footprint, head region, confidence) for overlays.
 */
/**
 * Close-up framing (selfie: the protected head region fills a big share of the platform-safe
 * area) leaves no room anywhere if the whole expanded head is off limits — every graphic used
 * to be dropped or blown up full screen. Then protect only the FACE CORE (eyes → mouth, the
 * part a viewer must see); a graphic may sit over hair/forehead or beside the cheeks, like top
 * creators place them. Wider shots keep the full head protection. Same rule for preview and
 * render (both call this solver).
 */
export const CLOSE_UP_HEAD_SHARE = 0.45;
export function protectedFaceRect(head: Rect, safe: Rect): Rect {
  const share = rectArea(head) / Math.max(1, rectArea(safe));
  if (share < CLOSE_UP_HEAD_SHARE) return head;
  // Invert subject-track-core's expansion (sides 0.35, top 0.6, bottom 0.25 face sizes).
  const fw = head.width / 1.7;
  const fh = head.height / 1.85;
  const fx = head.x + 0.35 * fw;
  const fy = head.y + 0.6 * fh;
  return { x: Math.round(fx + 0.08 * fw), y: Math.round(fy + 0.28 * fh), width: Math.round(0.84 * fw), height: Math.round(0.72 * fh) };
}

export function solveVisualPlacements(timeline: EditTimeline, options: PlacementOptions): PlacementResult {
  const canvas = timeline.canvas;
  const k = canvas.width / 1080;
  const margin = Math.round((options.marginPx ?? 24) * k);
  const safe = placementSafeArea(canvas, options.platformSafe ?? PLACEMENT_SAFE_ZONE);
  const step = Math.max(4, Math.round(16 * k));
  const captionIndex = buildCaptionIndex(timeline, options);
  const warnings: PlacementWarning[] = [];
  const details: Record<string, PlacementDetail> = {};
  const resolved = new Map<string, TimelineVisual>();

  // Placed visuals (manual first, then each AUTO as it's solved) are obstacles for later ones.
  const placed: Array<{ v: TimelineVisual; rect: Rect }> = [];
  const overlapsInTime = (a: { start: number; end: number }, b: { start: number; end: number }) =>
    a.start < b.end && b.start < a.end;

  const windowObstacles = (v: TimelineVisual) => {
    const subject = subjectRegionsForWindow(timeline, v.start, v.end, options);
    const hard: Array<{ name: string; rect: Rect }> = [];
    // Close-up relief only when we actually know where his face is (an assumed head stays fully protected).
    if (subject.head) hard.push({ name: "Chris's face", rect: subject.tracked ? protectedFaceRect(subject.head, safe) : subject.head });
    for (const r of captionObstacles(captionIndex, v.start, v.end)) hard.push({ name: "the captions", rect: r });
    for (const t of timeline.texts) {
      if (overlapsInTime(t, v)) hard.push({ name: `text "${t.text.slice(0, 24)}"`, rect: textRect(t, canvas, options.measure) });
    }
    for (const p of placed) {
      if (p.v.id !== v.id && overlapsInTime(p.v, v) && footprintOf(p.v.template, p.v.props).kind !== "FULL_FRAME") {
        hard.push({ name: `visual ${p.v.id}`, rect: p.rect });
      }
    }
    return { subject, hard };
  };

  // MANUAL: never moved — checked and registered as obstacles.
  for (const v of timeline.visuals) {
    if (v.placement.mode !== "MANUAL") continue;
    const rect = visualRect(v, canvas);
    const { subject, hard } = windowObstacles(v);
    if (footprintOf(v.template, v.props).kind !== "FULL_FRAME") {
      if (subject.head && v.depth !== "BEHIND_SUBJECT" && intersectionArea(rect, subject.head) > 0) {
        warnings.push({
          visualId: v.id,
          code: "MANUAL_COVERS_SUBJECT",
          severity: "WARNING",
          message: `${label(v)} covers Chris's face — switch it to Auto or move it.`,
        });
      }
      if (hard.some((h) => h.name === "the captions" && intersectionArea(rect, h.rect) > 0)) {
        warnings.push({
          visualId: v.id,
          code: "MANUAL_COVERS_CAPTIONS",
          severity: "WARNING",
          message: `${label(v)} overlaps the captions.`,
        });
      }
      if (rect.x < safe.x || rect.y < safe.y || rect.x + rect.width > safe.x + safe.width || rect.y + rect.height > safe.y + safe.height) {
        warnings.push({
          visualId: v.id,
          code: "MANUAL_OUTSIDE_SAFE_ZONE",
          severity: "INFO",
          message: `${label(v)} reaches into platform UI (likes rail / caption area) — it may be covered in the app.`,
        });
      }
    }
    details[v.id] = { rect, head: subject.head, body: subject.body, confidence: "HIGH" };
    placed.push({ v, rect });
    resolved.set(v.id, v);
  }

  const autos = timeline.visuals
    .filter((v) => v.placement.mode !== "MANUAL")
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));

  for (const v of autos) {
    const fp = footprintOf(v.template, v.props);
    const { subject, hard } = windowObstacles(v);
    if (!subject.tracked) {
      warnings.push({
        visualId: v.id,
        code: "NO_SUBJECT_TRACK",
        severity: "INFO",
        message: `${label(v)}: Chris's position isn't analysed for this take yet — placed assuming a centred framing.`,
      });
    }

    const classic = autoDepthSpot(v, subject, hard, safe, canvas, margin, timeline, options);
    if (classic) {
      const out: TimelineVisual = {
        ...v,
        depth: "BEHIND_SUBJECT",
        placement: { ...v.placement, mode: "AUTO", x: round4(classic.cx / canvas.width), y: round4(classic.cy / canvas.height), scale: round3(classic.factor) },
      };
      const rect = visualRect(out, canvas);
      details[v.id] = { rect, head: subject.head, body: subject.body, confidence: "HIGH" };
      placed.push({ v: out, rect });
      resolved.set(v.id, out);
      continue;
    }

    if (fp.kind === "FULL_FRAME") {
      const out = { ...v, placement: { ...v.placement, mode: "AUTO" as const, x: 0.5, y: 0.5, scale: 1 } };
      resolved.set(v.id, out);
      details[v.id] = { rect: visualRect(out, canvas), head: subject.head, body: subject.body, confidence: "HIGH" };
      continue;
    }

    const hardInflated = hard.map((h) => ({ name: h.name, rect: inflate(h.rect, margin) }));
    const pointTo =
      fp.kind === "CALLOUT" ? readPointTo(v.props, canvas) : null;
    const prev = { x: v.placement.x * canvas.width, y: v.placement.y * canvas.height };
    const preferred = options.preferredRects?.[v.id] ?? null;

    let best: Candidate | null = null;
    let leastBad: Candidate | null = null;
    for (const factor of SCALE_FACTORS) {
      const { width: w, height: h } = footprintPx(v.template, factor, canvas, v.props);
      if (w > safe.width || h > safe.height) continue;
      const xs = gridCentres(safe.x + w / 2, safe.x + safe.width - w / 2, step, safe.x + safe.width / 2);
      const ys = gridCentres(safe.y + h / 2, safe.y + safe.height - h / 2, step, null);
      for (const cy of ys) {
        for (const cx of xs) {
          const rect = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h };
          let hardOverlap = 0;
          for (const o of hardInflated) hardOverlap += intersectionArea(rect, o.rect);
          let score =
            (subject.body ? (1.2 * intersectionArea(rect, subject.body)) / rectArea(rect) : 0) +
            // Over the hair/forehead is allowed in a close-up, but a clear spot beside or below
            // the head is always preferred — a card on his head reads as sloppy.
            (subject.head ? (0.9 * intersectionArea(rect, subject.head)) / rectArea(rect) : 0) +
            1.5 * (1 - factor) +
            0.4 * Math.abs(cx / canvas.width - 0.5) +
            0.5 * Math.abs(cy / canvas.height - fp.preferY) +
            0.15 * (Math.hypot(cx - prev.x, cy - prev.y) / canvas.height) +
            (preferred ? 1.6 * (1 - intersectionArea(rect, preferred) / rectArea(rect)) : 0);
          if (pointTo) {
            const containsTarget =
              pointTo.x >= rect.x && pointTo.x <= rect.x + w && pointTo.y >= rect.y && pointTo.y <= rect.y + h;
            const dist = Math.hypot(cx - pointTo.x, cy - pointTo.y);
            if (containsTarget || dist > 520 * k) hardOverlap += rectArea(rect) * 0.01; // soft-reject
            score += (1.0 * dist) / canvas.width;
          }
          const cand = { cx, cy, factor, rect, score, hardOverlap };
          if (hardOverlap === 0) {
            if (!best || score < best.score) best = cand;
          } else {
            const bad = score + (10 * hardOverlap) / rectArea(rect);
            if (!leastBad || bad < leastBad.score) leastBad = { ...cand, score: bad };
          }
        }
      }
      // A clear spot at a bigger scale always beats any smaller one (scale penalty is
      // monotonic, but the body term could otherwise trade size for torso coverage).
      if (best) break;
    }

    const chosen = best ?? leastBad;
    let out: TimelineVisual;
    if (!chosen) {
      // Footprint bigger than the safe area even at minimum scale: centre it, minimum scale.
      out = { ...v, placement: { ...v.placement, mode: "AUTO", x: 0.5, y: 0.5, scale: MIN_AUTO_SCALE_FACTOR } };
      warnings.push({
        visualId: v.id,
        code: "LOW_CONFIDENCE",
        severity: "WARNING",
        message: `${label(v)} is too big for the platform-safe area — placed centred at minimum size; check it.`,
      });
    } else {
      out = {
        ...v,
        placement: {
          ...v.placement,
          mode: "AUTO",
          x: round4(chosen.cx / canvas.width),
          y: round4(chosen.cy / canvas.height),
          scale: round3(chosen.factor),
        },
      };
      if (!best) {
        const hits = overlapNames(chosen.rect, hardInflated);
        warnings.push({
          visualId: v.id,
          code: "LOW_CONFIDENCE",
          severity: "WARNING",
          message: `${label(v)}: no fully clear spot — best option still overlaps ${hits.length ? hits.join(", ") : "its callout target"}. Consider moving it, shortening it, or a smaller template.`,
        });
      } else if (chosen.factor < 1) {
        warnings.push({
          visualId: v.id,
          code: "SHRUNK",
          severity: "INFO",
          message: `${label(v)} shrunk to ${Math.round(chosen.factor * 100)}% to stay clear of Chris and the captions.`,
        });
      }
    }
    const rect = visualRect(out, canvas);
    details[v.id] = { rect, head: subject.head, body: subject.body, confidence: best ? "HIGH" : "LOW" };
    placed.push({ v: out, rect });
    resolved.set(v.id, out);
  }

  return { visuals: timeline.visuals.map((v) => resolved.get(v.id) ?? v), warnings, details };
}

/** The visuals with AUTO placements resolved (MANUAL untouched). */
export function resolveVisualPlacements(timeline: EditTimeline, options: PlacementOptions): TimelineVisual[] {
  return solveVisualPlacements(timeline, options).visuals;
}

/** Placement warnings for the editor (low confidence, shrunk, manual graphics over Chris...). */
export function placementWarnings(timeline: EditTimeline, options: PlacementOptions): PlacementWarning[] {
  return solveVisualPlacements(timeline, options).warnings;
}

/** Every clip on screen during [start, end) has a person matte. */
function mattesCover(timeline: EditTimeline, start: number, end: number, mattes: PlacementOptions["mattes"]): boolean {
  if (!mattes) return false;
  const starts = clipStartTimes(timeline);
  let any = false;
  for (let k = 0; k < timeline.clips.length; k++) {
    const c = timeline.clips[k]!;
    const s = starts[k]!;
    const e = s + (c.sourceEnd - c.sourceStart);
    if (e <= start || s >= end) continue;
    any = true;
    if (!mattes[c.mediaAssetId]) return false;
  }
  return any;
}

/** The type's glyph band inside a template's footprint (fractions of the footprint). */
function glyphBand(v: TimelineVisual): { top: number; height: number } | null {
  const p = v.props as Record<string, unknown>;
  if (v.template === "KINETIC_TEXT") {
    const text = typeof p.text === "string" ? p.text : "";
    return text.length > 0 && text.length <= 28 ? { top: 0.3, height: 0.4 } : null;
  }
  if (v.template === "NUMBER_COUNTER") return p.label == null ? { top: 0.22, height: 0.56 } : null;
  return null;
}

/**
 * The auto-depth rule ("the classic look"): for big type (short KINETIC_TEXT, label-less
 * NUMBER_COUNTER, TITLE_CARD) in AUTO placement, when every clip in the window has a person
 * matte and the head is tracked, try the composition a seasoned editor would: the type at full
 * size, centred over Chris, its baseline region crossing the top of his head so the head
 * occludes only the lower part of a few glyphs (≤ AUTO_DEPTH_MAX_COVER of the glyph band).
 * Must still be inside the safe area and clear of captions/texts/other graphics. TITLE_CARD
 * keeps its full frame and goes behind only when Chris covers a small part of the title band.
 * Returns the spot, or null (→ the normal solve, depth unchanged).
 */
function autoDepthSpot(
  v: TimelineVisual,
  subject: SubjectWindow,
  hard: Array<{ name: string; rect: Rect }>,
  safe: Rect,
  canvas: { width: number; height: number },
  margin: number,
  timeline: EditTimeline,
  options: PlacementOptions,
): { cx: number; cy: number; factor: number } | null {
  if (!AUTO_DEPTH_TEMPLATES.has(v.template as never)) return null;
  if (!subject.tracked || !subject.head) return null;
  if (!mattesCover(timeline, v.start, v.end, options.mattes)) return null;
  const head = subject.head;
  if (v.template === "TITLE_CARD") {
    const band = { x: canvas.width * 0.08, y: canvas.height * 0.42, width: canvas.width * 0.84, height: canvas.height * 0.16 };
    const person = subject.body ? unionRect(head, subject.body) : head;
    const cover = intersectionArea(band, person) / rectArea(band);
    return cover > 0.02 && cover <= 0.25 ? { cx: canvas.width / 2, cy: canvas.height / 2, factor: 1 } : null;
  }
  const gb = glyphBand(v);
  if (!gb) return null;
  const ell = headEllipseFromProtected(head);
  const hairTop = ell.cy - ell.ry;
  const maxCover = AUTO_DEPTH_MAX_COVER[v.template as "NUMBER_COUNTER" | "KINETIC_TEXT"];
  for (const factor of [1, 0.9, 0.8]) {
    const { width: w, height: h } = footprintPx(v.template, factor, canvas, v.props);
    if (w > safe.width || h > safe.height) continue;
    const bandH = h * gb.height;
    let cy = hairTop - 0.62 * bandH - h * gb.top + h / 2;
    let cx = head.x + head.width / 2;
    cx = Math.min(safe.x + safe.width - w / 2, Math.max(safe.x + w / 2, cx));
    cy = Math.min(safe.y + safe.height - h / 2, Math.max(safe.y + h / 2, cy));
    const rect = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h };
    const band = { x: rect.x, y: rect.y + h * gb.top, width: w, height: bandH };
    const cover = ellipseCoverage(band, ell);
    if (cover <= 0.02 || cover > maxCover) continue;
    if (hard.some((o) => o.name !== "Chris's face" && intersectionArea(rect, inflate(o.rect, margin)) > 0)) continue;
    return { cx, cy, factor };
  }
  return null;
}

function gridCentres(lo: number, hi: number, step: number, extra: number | null): number[] {
  if (hi < lo) return [];
  const out: number[] = [];
  for (let v = lo; v <= hi + 1e-6; v += step) out.push(v);
  if (out[out.length - 1]! < hi - 1e-6) out.push(hi);
  if (extra != null && extra >= lo && extra <= hi) out.push(extra);
  return out;
}

function readPointTo(props: Record<string, unknown>, canvas: { width: number; height: number }): { x: number; y: number } | null {
  const p = props.pointTo as { x?: unknown; y?: unknown } | undefined;
  if (!p || typeof p.x !== "number" || typeof p.y !== "number") return null;
  return { x: p.x * canvas.width, y: p.y * canvas.height };
}

function label(v: TimelineVisual): string {
  return `${v.template.replace(/_/g, " ").toLowerCase()} at ${v.start.toFixed(1)}s`;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
