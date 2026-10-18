import type { StudioFilm } from "./film-types";

/**
 * FilmEnginePort — the ONLY way the Mini-movie Studio crew touches the film engine
 * (packages/cinema + its heavy jobs in apps/worker). The crew and the orchestrator code against
 * this interface; tests use `FakeFilmEngine` (fake-engine.ts); the app wires a thin adapter
 * (apps/web/lib/studio/cinema-engine.ts) onto the real functions / heavy-job kinds.
 *
 * Every method is free ($0): validation and the catalog are pure code, storyboards / narration /
 * renders run on our own compute (local machine or the Vercel Sandbox snapshot).
 */

export interface EngineIssue {
  path: string;
  message: string;
  hint?: string;
}

export type EngineValidation =
  | { ok: true; film: StudioFilm; warnings: EngineIssue[] }
  | { ok: false; errors: EngineIssue[]; warnings: EngineIssue[] };

export type CatalogKind = "ACTOR" | "ACTION" | "CAMERA" | "LIGHTING" | "TRANSITION" | "TEXT_STYLE" | "SET" | "LOOK" | "SFX";

/** One thing the engine can show — what it depicts and the narration it is good for. The
 * Meaning-Match first pass embeds `depicts` + `goodFor`; the write pack lists them so ChatGPT
 * only uses vocabulary the engine can actually render. */
export interface CatalogEntry {
  /** Stable id, e.g. "actor:BASELINE", "action:SET.level", "camera:CRANE_UP". */
  id: string;
  kind: CatalogKind;
  name: string;
  depicts: string;
  goodFor: string[];
  /** Params / usage hint for authors ("params.level = height in m"). */
  usage?: string;
}

export interface FilmCatalog {
  version: string;
  entries: CatalogEntry[];
}

export interface NarratorVoice {
  id: string;
  label: string;
  engine: "KOKORO" | "CHRIS";
  /** A short ▶ sample (URL the phone can play), or null if none rendered yet. */
  sampleUrl: string | null;
  note?: string;
}

/** Deterministic facts about one shot at its line's key words (from the engine's evaluator when
 * available). `inFrame` is null when the engine can't project (fake / unknown). */
export interface ShotFacts {
  shotId: string;
  /** Actor id → what the evaluator says about it during the shot. */
  actors: Array<{ id: string; kind: string; visible: boolean; inFrame: boolean | null; changes: string[] }>;
  cameraTarget: string;
  cameraMove: string;
  textOnScreen: string[];
}

/** Pixel measurements of one still (storyboard or rendered frame). All optional: an engine that
 * can't measure leaves them out and the deterministic Quality bot says it couldn't check. */
export interface StillMetrics {
  /** 0..1 mean luminance. */
  meanLuma?: number;
  /** 0..1 fraction of the frame that is near-black/near-uniform (an empty frame). */
  emptyRatio?: number;
  /** WCAG-style contrast ratio of on-screen text against its background, per text band. */
  textContrast?: Partial<Record<"UPPER" | "CENTER" | "LOWER", number>>;
  /** Text glyph height in px at 1080×1920 (legibility on a phone). */
  minTextHeightPx?: number;
  /** Fraction of text bounding boxes inside the platform-safe zone (1 = all inside). */
  textInsideSafeZone?: number;
}

export interface Still {
  id: string;
  shotId: string;
  /** Where in the shot: 0..1. */
  point: number;
  /** Something the phone can show: https URL, /api path or data: URL. */
  url: string;
  /** Narration under it (for the contact sheet / UI). */
  caption?: string;
  metrics?: StillMetrics;
}

export interface StoryboardResult {
  stills: Still[];
  /** ONE image with every still + its line under it — attached to the ChatGPT review pack. */
  contactSheetUrl: string | null;
}

export interface RenderResult {
  tier: "PREVIEW" | "FINAL";
  videoUrl: string | null;
  posterUrl: string | null;
  durationSeconds: number;
  loudnessLufs: number | null;
  truePeakDbtp: number | null;
  /** Sampled frames of the rendered film (for the final Quality pass + contact sheet). */
  frames: Still[];
  contactSheetUrl: string | null;
  /** Set when the engine registered the film as a ContentItem render itself. */
  contentItemId?: string | null;
  renderId?: string | null;
}

export type EngineJobKind = "STORYBOARD" | "RENDER" | "NARRATION";
export type EngineJobStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED";

export interface EngineJob {
  id: string;
  kind: EngineJobKind;
  status: EngineJobStatus;
  progressPct?: number;
  message?: string;
  storyboard?: StoryboardResult;
  render?: RenderResult;
  error?: string;
}

export interface EngineCapabilities {
  storyboard: boolean;
  render: boolean;
  chrisNarration: boolean;
  /** Plain words when something is missing ("Cloud rendering isn't set up yet…"). */
  note?: string;
}

export interface FilmEnginePort {
  readonly name: string;
  capabilities(): EngineCapabilities;
  validateFilm(dsl: unknown): EngineValidation;
  formatIssues(issues: EngineIssue[]): string;
  getCatalog(): FilmCatalog;
  listVoices(): NarratorVoice[];
  /** Deterministic per-shot facts (who is visible / in frame / changing). */
  describeShots(film: StudioFilm): ShotFacts[];
  requestStoryboard(input: { filmId: string; versionId: string; film: StudioFilm; shotIds?: string[]; idempotencyKey: string }): Promise<{ jobId: string }>;
  requestRender(input: {
    filmId: string;
    versionId: string;
    film: StudioFilm;
    tier: "PREVIEW" | "FINAL";
    /** Chris's own recorded lines (shot id → media URL/key), aligned to the picture by the engine. */
    chrisNarration?: Record<string, string> | null;
    idempotencyKey: string;
  }): Promise<{ jobId: string }>;
  getJob(jobId: string): Promise<EngineJob | null>;
  /** Base64 of a still (only needed by the optional local vision model). */
  loadImage?(url: string): Promise<{ base64: string; mediaType: "image/png" | "image/jpeg" } | null>;
}
