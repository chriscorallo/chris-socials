/**
 * How motion graphics INTERACT with the footage (Motion v2) — PURE and deterministic
 * (browser-safe). The worker computes these numbers before rendering and passes them to the
 * Remotion composition as props; the finishing editor's preview computes the SAME numbers with
 * the SAME functions, so what Chris previews is what renders.
 *
 * - Subject anchor ("Follow me"): a per-frame centre track that follows Chris's head (subject
 *   track → clip crop → output zoom → canvas px, + offset), zero-phase smoothed per clip (it
 *   cuts with the picture on a cut, glides between tracker samples), kept on the canvas.
 * - Camera coupling ("Move with camera"): the edit's punch-ins applied to the graphic around the
 *   zoom's focal point, scaled by `cameraCoupling` (1 = glued to the footage, 0.3–0.6 = parallax).
 * - Scene integration: region statistics of the footage behind a graphic (mean colour, luma,
 *   contrast) → a "look" (scrim strength, white balance, black level, tinted shadow, light-wrap
 *   colour) the composition applies.
 * - Emphasis timing: per-word vocal emphasis (loudness z-scores within the clip + numbers +
 *   words the graphic shows) → the frame where a template lands its key moment.
 *
 * Decisions: docs/decisions-pending/motion-v2-interaction.md.
 */
import type { MotionTemplate, TimelineVisual } from "./motion-contract";
import type { NormBox, SubjectTrack } from "./subject-track-core";
import { subjectBoxAt } from "./subject-track-core";
import { clipStartTimes, locateOutputTime, timelineDuration, type EditTimeline } from "./timeline";
import { cropGeometry, normalizeZooms, zoomStateAt, type ZoomState } from "./timeline-layout";
import { footprintPx, TEMPLATE_FOOTPRINTS } from "./visual-footprints";

type Canvas = { width: number; height: number };
type Pt = { x: number; y: number };

// ---------------------------------------------------------------------------------------
// Matte ↔ crop mapping
// ---------------------------------------------------------------------------------------

/**
 * Size a person matte is computed at: same aspect as the source, `targetHeight` tall (even
 * dims, never upscaled). Because the renderer's crop is defined RELATIVE to the input
 * (cover scale = max(W/iw, H/ih) × zoom, pan in fractions of the overflow), a matte with the
 * source's aspect goes through the clip's exact crop/zoom and lands pixel-aligned with the
 * footage — see `cropGeometry` (identical geometry for both up to < 1 px of rounding).
 */
export function matteDimensionsFor(source: { width: number; height: number }, targetHeight = 512): { width: number; height: number } {
  const h = Math.min(source.height, targetHeight);
  const w = (source.width * h) / source.height;
  const even = (v: number) => Math.max(2, 2 * Math.round(v / 2));
  return { width: even(w), height: even(h) };
}

/** Where a SOURCE-fraction point lands on the OUTPUT canvas (crop then zoom). Unclipped. */
export function mapSourcePointToCanvas(
  pt: Pt,
  source: { width: number; height: number },
  canvas: Canvas,
  crop: EditTimeline["clips"][number]["crop"],
  zoom: ZoomState,
): Pt {
  const g = cropGeometry(source, canvas, crop);
  const x = pt.x * source.width * g.scale - g.offsetX;
  const y = pt.y * source.height * g.scale - g.offsetY;
  return applyZoomToPoint({ x, y }, zoom, canvas);
}

/** The footage zoom as the renderer applies it: p → F + (p − F)·z, F = focal point (px). */
export function applyZoomToPoint(p: Pt, zoom: ZoomState, canvas: Canvas): Pt {
  const fx = zoom.x * canvas.width;
  const fy = zoom.y * canvas.height;
  return { x: fx + (p.x - fx) * zoom.zoom, y: fy + (p.y - fy) * zoom.zoom };
}

// ---------------------------------------------------------------------------------------
// Camera coupling
// ---------------------------------------------------------------------------------------

export interface CoupledTransform {
  /** Multiplier on the graphic's scale. */
  scale: number;
  /** Focal point (canvas px) the scale happens around. */
  originX: number;
  originY: number;
}

/**
 * A fraction `coupling` of the footage zoom: scale = 1 + (z − 1)·coupling around the same
 * focal point. coupling 1 → the graphic is glued to the picture; 0 → screen-fixed.
 */
export function cameraCouplingTransform(zoom: ZoomState, coupling: number, canvas: Canvas): CoupledTransform {
  const c = Math.min(1, Math.max(0, coupling));
  return { scale: 1 + (zoom.zoom - 1) * c, originX: zoom.x * canvas.width, originY: zoom.y * canvas.height };
}

export function applyCoupledTransform(p: Pt, t: CoupledTransform): Pt {
  return { x: t.originX + (p.x - t.originX) * t.scale, y: t.originY + (p.y - t.originY) * t.scale };
}

// ---------------------------------------------------------------------------------------
// Subject (head) on the output canvas
// ---------------------------------------------------------------------------------------

export interface InteractionContext {
  /** mediaAssetId → subject track (protected head region, source fractions). */
  subjectTracks: Record<string, SubjectTrack | null | undefined>;
  /** mediaAssetId → source frame size (display orientation). Missing = canvas aspect. */
  sourceDimensions?: Record<string, { width: number; height: number } | null | undefined>;
}

/** Chris's protected head box on the OUTPUT canvas (px, unclipped) at output time t, or null. */
export function headBoxOnCanvasAt(
  timeline: Pick<EditTimeline, "clips" | "canvas">,
  zooms: EditTimeline["zooms"],
  t: number,
  ctx: InteractionContext,
): { x: number; y: number; width: number; height: number; clipIndex: number } | null {
  const loc = locateOutputTime(timeline, t);
  if (!loc) return null;
  const clip = timeline.clips[loc.clipIndex]!;
  const track = ctx.subjectTracks[clip.mediaAssetId];
  if (!track || track.length === 0) return null;
  const box: NormBox | null = subjectBoxAt(track, loc.sourceTime);
  if (!box) return null;
  const src = ctx.sourceDimensions?.[clip.mediaAssetId] ?? timeline.canvas;
  const zoom = zoomStateAt(zooms, t);
  const a = mapSourcePointToCanvas({ x: box.x, y: box.y }, src, timeline.canvas, clip.crop, zoom);
  const b = mapSourcePointToCanvas({ x: box.x + box.w, y: box.y + box.h }, src, timeline.canvas, clip.crop, zoom);
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y, clipIndex: loc.clipIndex };
}

// ---------------------------------------------------------------------------------------
// Per-frame motion track (anchor + coupling)
// ---------------------------------------------------------------------------------------

/** Per local frame of a visual: its centre (canvas px) and a scale multiplier. */
export interface VisualMotionTrack {
  x: number[];
  y: number[];
  s: number[];
}

/** Time constant of the zero-phase follow smoothing (seconds). ~0.12 s reads as "attached"
 * without inheriting the tracker's 3 fps steps. */
export const ANCHOR_SMOOTH_SECONDS = 0.12;

/** Forward + backward one-pole low-pass (zero phase lag), per run. */
export function zeroPhaseSmooth(values: number[], alpha: number): number[] {
  if (values.length < 2 || alpha >= 1) return [...values];
  const f = [...values];
  for (let i = 1; i < f.length; i++) f[i] = f[i - 1]! + alpha * (f[i]! - f[i - 1]!);
  for (let i = f.length - 2; i >= 0; i--) f[i] = f[i + 1]! + alpha * (f[i]! - f[i + 1]!);
  return f;
}

function frameAlpha(fps: number, tau: number): number {
  return 1 - Math.exp(-1 / Math.max(1e-6, fps * tau));
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * The per-frame centre/scale track of a visual over its window [round(start·fps), round(end·fps)),
 * or null when it simply sits at its placement (no SUBJECT anchor, no coupled zoom). The
 * centre starts from `placement.x/y` (the same centre the composition draws at).
 *
 * - SUBJECT anchor: centre = head centre + (offsetX·W, offsetY·H). Frames where the head is
 *   unknown hold the last known spot (or the first one found); no head at all → placement.
 *   Smoothed per clip (zero phase) so the graphic CUTS with the picture on a cut.
 * - cameraCoupling > 0 during a zoom: scale (and, when screen-anchored, position) follow
 *   that fraction of the zoom around its focal point. A subject-anchored graphic already moves
 *   with the zoom (the head is mapped through it); only its scale is coupled.
 * - Finally clamped so the box stays on the canvas (36 px margin when anchored).
 */
export function visualMotionTrack(
  visual: Pick<TimelineVisual, "template" | "start" | "end" | "placement" | "anchor" | "cameraCoupling">,
  timeline: Pick<EditTimeline, "clips" | "canvas" | "zooms">,
  ctx: InteractionContext,
  fps: number,
): VisualMotionTrack | null {
  const canvas = timeline.canvas;
  const fullFrame = TEMPLATE_FOOTPRINTS[visual.template].kind === "FULL_FRAME";
  const duration = timelineDuration(timeline);
  const { zooms } = normalizeZooms(timeline.zooms, duration);
  const from = Math.max(0, Math.round(visual.start * fps));
  const n = Math.max(1, Math.round(visual.end * fps) - from);
  const anchored = !fullFrame && visual.anchor?.type === "SUBJECT";
  const coupling = Math.min(1, Math.max(0, visual.cameraCoupling ?? 0));
  const zoomInWindow = zooms.some((z) => z.start < visual.end && z.end > visual.start && z.zoom !== 1);
  if (!anchored && !(coupling > 0 && zoomInWindow)) return null;

  const base: Pt = { x: visual.placement.x * canvas.width, y: visual.placement.y * canvas.height };
  const times = Array.from({ length: n }, (_, i) => (from + i) / fps);
  let xs: number[] = times.map(() => base.x);
  let ys: number[] = times.map(() => base.y);
  const ss: number[] = times.map(() => 1);

  if (anchored) {
    const off = { x: (visual.anchor.offsetX ?? 0) * canvas.width, y: (visual.anchor.offsetY ?? 0) * canvas.height };
    const raw: Array<{ p: Pt | null; clip: number }> = times.map((t) => {
      const h = headBoxOnCanvasAt(timeline, zooms, t, ctx);
      const loc = locateOutputTime(timeline, t);
      return { p: h ? { x: h.x + h.width / 2 + off.x, y: h.y + h.height / 2 + off.y } : null, clip: h?.clipIndex ?? loc?.clipIndex ?? 0 };
    });
    const firstKnown = raw.find((r) => r.p)?.p ?? null;
    if (firstKnown) {
      let last = firstKnown;
      const filled = raw.map((r) => {
        if (r.p) last = r.p;
        return { p: r.p ?? last, clip: r.clip };
      });
      // Smooth each clip's run separately: a cut moves the head instantly and the graphic with it.
      const a = frameAlpha(fps, ANCHOR_SMOOTH_SECONDS);
      xs = [];
      ys = [];
      let i = 0;
      while (i < filled.length) {
        let j = i;
        while (j < filled.length && filled[j]!.clip === filled[i]!.clip) j++;
        xs.push(...zeroPhaseSmooth(filled.slice(i, j).map((f) => f.p.x), a));
        ys.push(...zeroPhaseSmooth(filled.slice(i, j).map((f) => f.p.y), a));
        i = j;
      }
    }
  }

  if (coupling > 0) {
    times.forEach((t, i) => {
      const z = zoomStateAt(zooms, t);
      if (z.zoom === 1) return;
      const tr = cameraCouplingTransform(z, coupling, canvas);
      ss[i] = tr.scale;
      if (!anchored) {
        const p = applyCoupledTransform({ x: xs[i]!, y: ys[i]! }, tr);
        xs[i] = p.x;
        ys[i] = p.y;
      }
    });
  }

  if (!fullFrame) {
    // Anchored graphics were PLACED by Chris (offset from where he dropped it): like any manual
    // placement they may sit anywhere on the canvas (36 px margin) — clamping them to the
    // platform-safe area would make them jump away from where he put them.
    const m = 36 * (canvas.width / 1080);
    const area = anchored ? { x: m, y: m, width: canvas.width - 2 * m, height: canvas.height - 2 * m } : { x: 0, y: 0, width: canvas.width, height: canvas.height };
    times.forEach((_, i) => {
      const fp = footprintPx(visual.template, visual.placement.scale * ss[i]!, canvas);
      const hw = Math.min(fp.width, area.width) / 2;
      const hh = Math.min(fp.height, area.height) / 2;
      xs[i] = Math.min(area.x + area.width - hw, Math.max(area.x + hw, xs[i]!));
      ys[i] = Math.min(area.y + area.height - hh, Math.max(area.y + hh, ys[i]!));
    });
  }
  return { x: xs.map(r1), y: ys.map(r1), s: ss.map(r4) };
}

/**
 * The anchor offset (canvas fractions) that keeps a visual exactly where it is now when
 * "Follow me" is switched on at output time t — so the toggle never makes it jump.
 */
export function anchorOffsetFor(
  visual: Pick<TimelineVisual, "placement">,
  timeline: Pick<EditTimeline, "clips" | "canvas" | "zooms">,
  t: number,
  ctx: InteractionContext,
): { offsetX: number; offsetY: number } | null {
  const { zooms } = normalizeZooms(timeline.zooms, timelineDuration(timeline));
  const h = headBoxOnCanvasAt(timeline, zooms, t, ctx);
  if (!h) return null;
  const c = timeline.canvas;
  const clampOff = (v: number) => Math.round(Math.min(1, Math.max(-1, v)) * 1000) / 1000;
  return {
    offsetX: clampOff(visual.placement.x - (h.x + h.width / 2) / c.width),
    offsetY: clampOff(visual.placement.y - (h.y + h.height / 2) / c.height),
  };
}

// ---------------------------------------------------------------------------------------
// Scene statistics → look
// ---------------------------------------------------------------------------------------

/** Footage statistics behind a graphic (sRGB 0..255 means; luma/contrast 0..1). */
export interface SceneStats {
  r: number;
  g: number;
  b: number;
  /** Rec.709 luma of the region, 0..1. */
  luma: number;
  /** Standard deviation of luma across the region's cells, 0..1 (busy/contrasty footage). */
  lumaStd: number;
}

const luma709 = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Stats from raw RGB24 pixels (e.g. the region scaled down to 8×8 by ffmpeg). */
export function sceneStatsFromRgb(rgb: Uint8Array | Buffer): SceneStats {
  const px = Math.floor(rgb.length / 3);
  if (px === 0) throw new Error("sceneStatsFromRgb: no pixels");
  let r = 0;
  let g = 0;
  let b = 0;
  const lumas: number[] = [];
  for (let i = 0; i < px; i++) {
    const R = rgb[i * 3]!;
    const G = rgb[i * 3 + 1]!;
    const B = rgb[i * 3 + 2]!;
    r += R;
    g += G;
    b += B;
    lumas.push(luma709(R, G, B));
  }
  r /= px;
  g /= px;
  b /= px;
  const mean = lumas.reduce((a, v) => a + v, 0) / px;
  const std = Math.sqrt(lumas.reduce((a, v) => a + (v - mean) * (v - mean), 0) / px);
  return { r: Math.round(r * 10) / 10, g: Math.round(g * 10) / 10, b: Math.round(b * 10) / 10, luma: r4(luma709(r, g, b)), lumaStd: r4(std) };
}

/** Average of several samples (e.g. start/middle/end of a visual's window). */
export function mergeSceneStats(list: Array<SceneStats | null | undefined>): SceneStats | null {
  const xs = list.filter((s): s is SceneStats => !!s);
  if (xs.length === 0) return null;
  const avg = (k: keyof SceneStats) => xs.reduce((a, s) => a + s[k], 0) / xs.length;
  return { r: Math.round(avg("r") * 10) / 10, g: Math.round(avg("g") * 10) / 10, b: Math.round(avg("b") * 10) / 10, luma: r4(avg("luma")), lumaStd: r4(avg("lumaStd")) };
}

/** What the composition applies for a visual's scene integration. All values are subtle by design. */
export interface SceneLook {
  /** Extra soft dark falloff behind the graphic (0 = none). Bright/busy footage → stronger. */
  scrim: number;
  /** White-balance gains toward the footage's colour temperature (each within ±4%). */
  gain: { r: number; g: number; b: number };
  /** Black level lift so pure blacks don't look pasted on hazy/bright footage (0..0.03). */
  lift: number;
  /** Contact/drop shadow: colour = the scene's own dark tone (never pure black). */
  shadow: { color: string; opacity: number };
  /** Light-wrap: the background's colour bleeding onto the graphic's edges. */
  wrap: { color: string; strength: number };
}

const NEUTRAL_LOOK: SceneLook = {
  scrim: 0,
  gain: { r: 1, g: 1, b: 1 },
  lift: 0,
  shadow: { color: "#05060A", opacity: 0.34 },
  wrap: { color: "#BFC4CC", strength: 0.3 },
};

const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0").toUpperCase();
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/**
 * The look for a visual given the footage behind it (null stats → neutral). Rules (a finishing
 * artist's, kept restrained):
 * - scrim: bright footage needs more separation: 0.08 at luma ≤ 0.35 → 0.42 at luma ~0.85, +
 *   up to 0.08 for busy (high-contrast) backgrounds;
 * - white balance: warm footage warms the graphic's whites slightly (and vice versa) — ±4% max;
 * - black lift: up to 0.03 on bright footage (matching the footage's black level);
 * - shadow: the scene's own colour at 22% brightness, stronger on bright footage (shadows
 *   barely read on dark footage, exactly like reality);
 * - light wrap: the scene colour normalised to a light tone, strength 0.25–0.6 with luma.
 */
export function sceneLook(stats: SceneStats | null | undefined): SceneLook {
  if (!stats) return NEUTRAL_LOOK;
  const L = Math.min(1, Math.max(0, stats.luma));
  const scrim = r4(Math.min(0.5, Math.max(0.08, 0.08 + (L - 0.35) * 0.68) + Math.min(0.08, stats.lumaStd * 0.4)));
  const warmth = Math.max(-1, Math.min(1, (stats.r - stats.b) / 128));
  const gain = { r: r4(1 + 0.04 * warmth), g: 1, b: r4(1 - 0.04 * warmth) };
  const lift = r4(Math.min(0.03, Math.max(0, (L - 0.5) * 0.08)));
  const shadow = { color: toHex(stats.r * 0.22, stats.g * 0.22, stats.b * 0.22), opacity: r4(0.24 + 0.26 * L) };
  const m = Math.max(1, stats.r, stats.g, stats.b);
  const k = 225 / m;
  const wrap = { color: toHex(stats.r * k, stats.g * k, stats.b * k), strength: r4(0.25 + 0.35 * L) };
  return { scrim, gain, lift, shadow, wrap };
}

/**
 * The footage region (OUTPUT canvas px) a visual is judged against: its footprint at its
 * placement (full frame for TITLE_CARD), clipped to the canvas.
 */
export function sceneRegionFor(v: Pick<TimelineVisual, "template" | "placement">, canvas: Canvas): { x: number; y: number; width: number; height: number } {
  const fp = TEMPLATE_FOOTPRINTS[v.template];
  if (fp.kind === "FULL_FRAME") return { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const { width, height } = footprintPx(v.template, v.placement.scale, canvas);
  const x = Math.max(0, Math.round(v.placement.x * canvas.width - width / 2));
  const y = Math.max(0, Math.round(v.placement.y * canvas.height - height / 2));
  return { x, y, width: Math.max(2, Math.min(canvas.width - x, width)), height: Math.max(2, Math.min(canvas.height - y, height)) };
}

/**
 * Inverse of the output zoom: the pre-zoom canvas rect that ends up at `rect` (px). The
 * renderer zooms the cropped/graded picture, so this is where to sample the footage.
 */
export function unzoomRect(rect: { x: number; y: number; width: number; height: number }, zoom: ZoomState, canvas: Canvas) {
  const fx = zoom.x * canvas.width;
  const fy = zoom.y * canvas.height;
  const z = zoom.zoom;
  return { x: fx + (rect.x - fx) / z, y: fy + (rect.y - fy) / z, width: rect.width / z, height: rect.height / z };
}

/**
 * The SOURCE-pixel rect behind an output-canvas rect for a clip (inverse of the clip crop),
 * clamped to the source frame. Used by the worker's ffmpeg sampler.
 */
export function canvasRectToSourceRect(
  rect: { x: number; y: number; width: number; height: number },
  source: { width: number; height: number },
  canvas: Canvas,
  crop: EditTimeline["clips"][number]["crop"],
): { x: number; y: number; width: number; height: number } {
  const g = cropGeometry(source, canvas, crop);
  const x1 = Math.max(0, Math.min(source.width - 2, (rect.x + g.offsetX) / g.scale));
  const y1 = Math.max(0, Math.min(source.height - 2, (rect.y + g.offsetY) / g.scale));
  const x2 = Math.max(x1 + 2, Math.min(source.width, (rect.x + rect.width + g.offsetX) / g.scale));
  const y2 = Math.max(y1 + 2, Math.min(source.height, (rect.y + rect.height + g.offsetY) / g.scale));
  return { x: Math.floor(x1), y: Math.floor(y1), width: Math.floor(x2 - x1), height: Math.floor(y2 - y1) };
}

/**
 * Where (output seconds) to sample the footage for a visual's scene stats: just after its
 * entrance, the middle, and just before its exit.
 */
export function sceneSampleTimes(v: Pick<TimelineVisual, "start" | "end">): number[] {
  const d = v.end - v.start;
  return [v.start + Math.min(0.7, d * 0.25), v.start + d / 2, v.end - Math.min(0.45, d * 0.2)].map((t) => Math.round(t * 1000) / 1000);
}

// ---------------------------------------------------------------------------------------
// Vocal emphasis → hit timing
// ---------------------------------------------------------------------------------------

/** Per-word loudness measured from the take's audio (SOURCE timeline seconds). */
export interface WordLoudness {
  word: string;
  start: number;
  end: number;
  /** RMS level over the word, dBFS. */
  rmsDb: number;
  /** Peak level over the word, dBFS. */
  peakDb: number;
}

/** A word on the OUTPUT timeline with its emphasis score (higher = more stressed). */
export interface EmphasisWord {
  word: string;
  start: number;
  end: number;
  score: number;
}

/** Templates whose key moment (landing) can be timed to an emphasis. */
export const EMPHASIS_TEMPLATES: ReadonlySet<MotionTemplate> = new Set(["NUMBER_COUNTER", "BAR_CHART", "KINETIC_TEXT", "MONEY_STACK_3D"]);

const SPELLED: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

export function wordHasNumber(w: string): boolean {
  const a = w.replace(/[^a-z]/gi, "").toLowerCase();
  return /\d/.test(w) || a in SPELLED || /^(hundred|thousand|million|billion|percent|half|double|triple)$/.test(a);
}

function zscores(xs: number[]): number[] {
  if (xs.length === 0) return [];
  const m = xs.reduce((a, v) => a + v, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, v) => a + (v - m) * (v - m), 0) / xs.length);
  return xs.map((v) => (sd > 1e-6 ? (v - m) / sd : 0));
}

/**
 * Words of the edit on the OUTPUT timeline with an emphasis score: z(RMS) + 0.5·z(peak)
 * computed WITHIN each clip (a loud take doesn't swamp a quiet one), + 0.8 for words that carry
 * a number. Words without loudness (no audio analysis) score only on numbers.
 */
export function outputEmphasisWords(
  timeline: Pick<EditTimeline, "clips">,
  loudnessByAsset: Record<string, WordLoudness[] | null | undefined>,
  wordsByAsset?: Record<string, Array<{ word: string; start: number; end: number }> | null | undefined>,
): EmphasisWord[] {
  const out: EmphasisWord[] = [];
  const starts = clipStartTimes(timeline);
  timeline.clips.forEach((c, k) => {
    const loud = loudnessByAsset[c.mediaAssetId];
    const words = loud ?? wordsByAsset?.[c.mediaAssetId]?.map((w) => ({ ...w, rmsDb: NaN, peakDb: NaN })) ?? [];
    const inClip = words.filter((w) => w.end > c.sourceStart && w.start < c.sourceEnd);
    const hasAudio = inClip.some((w) => Number.isFinite(w.rmsDb));
    const zr = hasAudio ? zscores(inClip.map((w) => (Number.isFinite(w.rmsDb) ? w.rmsDb : -60))) : inClip.map(() => 0);
    const zp = hasAudio ? zscores(inClip.map((w) => (Number.isFinite(w.peakDb) ? w.peakDb : -60))) : inClip.map(() => 0);
    inClip.forEach((w, i) => {
      const s = starts[k]! + Math.max(0, w.start - c.sourceStart);
      const e = starts[k]! + Math.min(c.sourceEnd, w.end) - c.sourceStart;
      const score = zr[i]! + 0.5 * zp[i]! + (wordHasNumber(w.word) ? 0.8 : 0);
      out.push({ word: w.word, start: Math.round(s * 1000) / 1000, end: Math.round(e * 1000) / 1000, score: Math.round(score * 1000) / 1000 });
    });
  });
  return out.sort((a, b) => a.start - b.start);
}

const normWord = (w: string) => {
  const n = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return n in SPELLED ? String(SPELLED[n]) : n;
};

/** Tokens a visual itself shows that, when spoken, make the moment (the number, the punch word). */
export function visualKeyTokens(v: Pick<TimelineVisual, "template" | "props">): string[] {
  const p = v.props as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? [String(Math.round(Math.abs(x) * 100) / 100).replace(/\.0+$/, ""), String(Math.round(Math.abs(x)))] : []);
  switch (v.template) {
    case "NUMBER_COUNTER":
      return num(p.value);
    case "MONEY_STACK_3D":
      return num(p.amount);
    case "BAR_CHART": {
      const bars = Array.isArray(p.bars) ? (p.bars as Array<{ value?: unknown }>) : [];
      const hi = typeof p.highlightIndex === "number" ? p.highlightIndex : null;
      const pick = hi != null && bars[hi] ? [bars[hi]] : bars;
      return pick.flatMap((b) => num(b.value));
    }
    case "KINETIC_TEXT":
      return (Array.isArray(p.emphasis) ? (p.emphasis as string[]) : []).map(normWord).filter(Boolean);
    default:
      return [];
  }
}

export interface EmphasisPickOptions {
  /** Earliest allowed hit after the visual's start (s). Default 0.45 (the entrance has to read). */
  minLead?: number;
  /** Keep the landed state on screen at least this long before the exit (s). Default 0.9. */
  minHold?: number;
  /** With `emphasisAt`, only emphases within this distance of the target count (s). Default 0.6. */
  snapWindow?: number;
  /** Minimum score for an automatic pick (default 0.6) — no strong emphasis → template timing. */
  minScore?: number;
}

/**
 * When (OUTPUT seconds) a visual's key moment should land, or null for the template's own
 * timing.
 * - `emphasisAt === 0` → null (explicitly "template timing").
 * - `emphasisAt > 0` → the strongest emphasis within ±snapWindow of start+emphasisAt
 *   (score − 0.8·distance); none → exactly start+emphasisAt (clamped into the window).
 * - `emphasisAt === null` → for the emphasis templates, the strongest word in the window
 *   (+1.5 when it's the very number/word the graphic shows, small preference for the first
 *   half — the hit should land while there's time to read it); null when nothing is strong.
 * The hit is the word's onset + a hair (0.04 s): motion lands on the consonant attack.
 */
export function pickEmphasisHit(
  v: Pick<TimelineVisual, "template" | "props" | "start" | "end" | "emphasisAt">,
  words: EmphasisWord[],
  options: EmphasisPickOptions = {},
): number | null {
  const minLead = options.minLead ?? 0.45;
  const minHold = options.minHold ?? 0.9;
  const snap = options.snapWindow ?? 0.6;
  const minScore = options.minScore ?? 0.6;
  const lo = v.start + minLead;
  const hi = v.end - minHold;
  if (hi <= lo) return null;
  if (v.emphasisAt === 0) return null;
  const keys = new Set(visualKeyTokens(v));
  const inWin = words
    .map((w) => ({ ...w, at: w.start + 0.04 }))
    .filter((w) => w.at >= lo && w.at <= hi)
    .map((w) => ({ ...w, s: w.score + (keys.size && keys.has(normWord(w.word)) ? 1.5 : 0) }));
  const round = (t: number) => Math.round(t * 1000) / 1000;
  if (v.emphasisAt != null) {
    const target = Math.min(hi, Math.max(lo, v.start + v.emphasisAt));
    let best: { at: number; val: number } | null = null;
    for (const w of inWin) {
      const d = Math.abs(w.at - target);
      if (d > snap) continue;
      const val = w.s - 0.8 * d;
      if (w.s >= minScore * 0.5 && (!best || val > best.val)) best = { at: w.at, val };
    }
    return round(best ? best.at : target);
  }
  if (!EMPHASIS_TEMPLATES.has(v.template)) return null;
  let best: { at: number; val: number } | null = null;
  for (const w of inWin) {
    if (w.s < minScore) continue;
    const pos = (w.at - v.start) / Math.max(1e-6, v.end - v.start);
    const val = w.s - 0.6 * Math.max(0, pos - 0.5);
    if (!best || val > best.val) best = { at: w.at, val };
  }
  return best ? round(best.at) : null;
}

// ---------------------------------------------------------------------------------------
// Everything the composition needs, per visual
// ---------------------------------------------------------------------------------------

/** Per-visual interaction data passed to the Remotion composition (render AND preview). */
export interface VisualInteraction {
  /** Per local frame centre/scale, or null (static at its placement). */
  track: VisualMotionTrack | null;
  /** Local frame (0 = the visual's first frame) where the key moment lands, or null. */
  hitAtFrame: number | null;
  /** Footage statistics behind the graphic (null = unknown → neutral look). */
  scene: SceneStats | null;
  /** The composition's integration look (derived from `scene`). */
  look: SceneLook;
}

export interface BuildInteractionsInput extends InteractionContext {
  /** visualId → scene stats (worker: ffmpeg region sampling; editor: the same via a server action). */
  sceneStats?: Record<string, SceneStats | null | undefined>;
  /** Emphasis words on the OUTPUT timeline (outputEmphasisWords). */
  emphasisWords?: EmphasisWord[] | null;
}

/** Builds every visual's interaction data at `fps`. Pure; same numbers in render and preview. */
export function buildVisualInteractions(
  timeline: Pick<EditTimeline, "clips" | "canvas" | "zooms" | "visuals">,
  input: BuildInteractionsInput,
  fps: number,
): Record<string, VisualInteraction> {
  const out: Record<string, VisualInteraction> = {};
  for (const v of timeline.visuals) {
    const from = Math.max(0, Math.round(v.start * fps));
    const hit = input.emphasisWords ? pickEmphasisHit(v, input.emphasisWords) : null;
    const scene = input.sceneStats?.[v.id] ?? null;
    out[v.id] = {
      track: visualMotionTrack(v, timeline, input, fps),
      hitAtFrame: hit == null ? null : Math.max(0, Math.round(hit * fps) - from),
      scene,
      look: sceneLook(scene),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Veteran defaults for NEW visuals
// ---------------------------------------------------------------------------------------

/** Card-like templates that ride punch-ins a little (parallax) by default. */
export const CAMERA_COUPLED_TEMPLATES: ReadonlySet<MotionTemplate> = new Set([
  "STAT_CARD",
  "BAR_CHART",
  "LINE_CHART",
  "COMPARISON",
  "PERCENT_RING",
  "LIST_STEPS",
  "TIMELINE",
  "DEFINITION",
]);
export const THREE_D_TEMPLATES: ReadonlySet<MotionTemplate> = new Set(["ICON_3D", "MONEY_STACK_3D"]);
export const DEFAULT_CARD_COUPLING = 0.35;

/**
 * Interaction defaults a finishing editor with decades behind him would start a NEW graphic
 * from: cards ride punch-ins at 35% (parallax, they feel in the room — not glued, not
 * floating), shadows on everywhere, light-wrap on for 3D objects (real geometry catches the
 * room's light), scene matching on. Depth is left to the placement engine's auto-depth rule
 * (needs a matte + the classic composition). Applied when a visual is CREATED (editor insert,
 * Motion Designer output) — never to an existing one, so Chris's choices are never overridden.
 */
export function applyInteractionDefaults<V extends Pick<TimelineVisual, "template" | "cameraCoupling" | "integration">>(v: V): V {
  const bar3d = v.template === "BAR_CHART" && (v as unknown as { props?: { depth3d?: boolean } }).props?.depth3d === true;
  return {
    ...v,
    cameraCoupling: CAMERA_COUPLED_TEMPLATES.has(v.template) ? DEFAULT_CARD_COUPLING : v.cameraCoupling ?? 0,
    integration: { shadow: true, sceneMatch: true, lightWrap: THREE_D_TEMPLATES.has(v.template) || bar3d },
  };
}
