/**
 * Heavy jobs — the work that can't run inside a Vercel Function (headless Chrome for the motion
 * layer, ONNX models for Whisper / face tracking / person matte, long ffmpeg renders). Pure
 * definitions shared by the in-process executor (heavy-jobs.ts), the sandbox CLI
 * (job-runner.ts) and the web app's dispatcher (apps/web/lib/heavy-jobs.ts). No Node imports:
 * safe anywhere.
 */

export const HEAVY_JOB_KINDS = [
  "render",
  "quality-gate",
  "auto-repair",
  "transcribe",
  "subject-track",
  "person-matte",
  "preview-proxy",
  "graphics-bake",
  "ingest",
  "motion-design",
  "reference-analyze",
  "viewer-review",
  "take-understand",
  // mini-movie studio (packages/cinema) — see apps/worker/src/film-jobs.ts
  "film-render",
  "film-render-chunk",
  "film-storyboard",
  "film-voice-align",
] as const;

/** The mini-movie kinds (the Mac render worker runs only these). */
export const FILM_JOB_KINDS = ["film-render", "film-render-chunk", "film-storyboard", "film-voice-align"] as const;
export type FilmJobKind = (typeof FILM_JOB_KINDS)[number];
export function isFilmJobKind(v: unknown): v is FilmJobKind {
  return typeof v === "string" && (FILM_JOB_KINDS as readonly string[]).includes(v);
}

/** A film is passed inline (the DSL JSON object) or as a storage key of that JSON. */
export interface FilmSource {
  film?: unknown;
  filmKey?: string;
  /** The studio's Film id (lease subject `film:<filmId>` — one engine job per film at a time). */
  filmId?: string;
  versionId?: string;
  idempotencyKey?: string;
}

export type HeavyJobKind = (typeof HEAVY_JOB_KINDS)[number];

export interface HeavyJobArgsByKind {
  /** Render the latest edit (motion layer + matte compositing). `thenQualityGate` runs the four
   * hard gates right after a successful render in the same worker (the editor's Finish). */
  render: { contentItemId: string; thenQualityGate?: boolean };
  /** `lateCheck`: "Run the AI check now" on a video the owner sent to the calendar without
   * it — records the QCReport with no state change (docs/decisions-pending/quality-override.md). */
  "quality-gate": { contentItemId: string; lateCheck?: boolean };
  /** EDIT → RENDER → INSPECT → FIX loop (re-renders). */
  "auto-repair": { contentItemId: string };
  /** One take, or every take without word timings (`force` re-does all but never silently). */
  transcribe: { contentItemId: string; mediaAssetId?: string; force?: boolean };
  "subject-track": { contentItemId: string; mediaAssetIds?: string[]; force?: boolean };
  "person-matte": { contentItemId: string; mediaAssetIds?: string[]; force?: boolean };
  /** Director chat: face boxes + facial-expression timeline + motion + frames sprite for takes
   * still missing them (free, local models). */
  "take-understand": { contentItemId: string; mediaAssetIds?: string[]; force?: boolean };
  /** Editor preview assets (720p proxy + filmstrip + peaks) for takes still missing them. */
  "preview-proxy": { contentItemId: string; mediaAssetIds?: string[]; force?: boolean };
  /** Editor preview: render the video's PENDING GraphicBake rows (each graphic at half size,
   * stacked alpha) — docs/decisions-pending/editor-rebuild.md. Own lease subject
   * (`bake:<id>`) so it never blocks a Finish render of the same video. */
  "graphics-bake": { contentItemId: string };
  /** After an upload: transcribe → preview proxy → track → matte for every take of the item still
   * missing them. `proxy` defaults to true (older callers don't pass it). */
  ingest: { contentItemId: string; transcribe: boolean; track: boolean; matte: boolean; proxy?: boolean };
  /** "Design visuals with AI" (HUMAN trigger; subject tracking runs first). */
  "motion-design": { contentItemId: string; replaceExisting?: boolean; focus?: MotionDesignFocus | null; strategize?: boolean };
  /** Measure reference videos' edit style (no model calls): every one waiting, or just `referenceContentIds`.
   * Not tied to a video — its lease is the whole reference library (REFERENCE_LIBRARY_SUBJECT). */
  "reference-analyze": { referenceContentIds?: string[] };
  /** "Watch it like a new viewer" (Viewer Panel, one HIGH vision call): the latest successful
   * render of a video (`contentItemId`) OR one reference video (`referenceContentId`) — exactly
   * one. Advisory only; writes a new ViewerReview row. */
  "viewer-review": {
    contentItemId?: string;
    referenceContentId?: string;
    platform?: "TIKTOK" | "INSTAGRAM" | "YOUTUBE";
    persona?: "COLD" | "FOLLOWER";
  };
  /** Render a mini-movie (narration → picture in chunks → assembled film) and register it as a
   * video (a ContentItem's render) unless `register` is false. Idempotent per (film, tier,
   * narration, idempotencyKey): a finished render is returned, finished chunks are reused. */
  "film-render": FilmSource & {
    tier: "PREVIEW" | "FINAL";
    /** Picture chunks rendered in parallel cloud workers (default: from the length and HEAVY_JOB_MAX_SANDBOXES; 1 on a Mac). */
    chunks?: number;
    /** Chris's aligned narration (the `linesKey` a film-voice-align job returned). */
    narrationKey?: string;
    /** Chris's own recorded lines, shot id → storage key (the studio's per-line recorder), or
     * `{ "*": key }` for one take of the whole script. Aligned to the picture by the engine. */
    chrisNarration?: Record<string, string> | null;
    /** Attach an already-finished render (its renderId) to `contentItemId` — "Send to Videos". */
    attachRenderId?: string;
    /** Attach to this existing video instead of creating one. */
    contentItemId?: string;
    /** Title for a new video (default: the film's title). */
    title?: string;
    /** Register as a video right away (default: true, except studio films — they go to Videos via Send to Videos → attachRenderId). */
    register?: boolean;
  };
  /** One frame range of a film-render (queued by the film-render job; the manifest lives in storage). */
  "film-render-chunk": { renderId: string; chunkIndex: number; attempt?: number };
  /** Keyframe stills per shot (cheap; PREVIEW at half size by default) with per-shot timing + the line each covers. */
  "film-storyboard": FilmSource & { tier?: "DRAFT" | "PREVIEW"; stillsPerShot?: number; shots?: string[]; points?: number[]; narrate?: boolean; scale?: number };
  /** Chris's own narration: align an uploaded recording (storage key) against the film's lines. */
  "film-voice-align": FilmSource & { recordingKey: string };
}

/** FNV-1a over a string → 8 hex chars (stable ids for film work; pure). */
export function stableHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let h2 = 5381;
  for (let i = 0; i < s.length; i++) h2 = (Math.imul(h2, 33) ^ s.charCodeAt(i)) >>> 0;
  return (h >>> 0).toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** The render id of a film-render request: same film + tier + narration + key → same id (idempotency). */
export function filmRenderId(a: HeavyJobArgsByKind["film-render"]): string {
  if (a.attachRenderId) return a.attachRenderId;
  return `fr-${stableHash(JSON.stringify([a.film ?? null, a.filmKey ?? null, a.tier, a.narrationKey ?? null, a.chrisNarration ?? null, a.idempotencyKey ?? null]))}`;
}

/** Lease subject of the reference-analysis job (one at a time for the whole library). */
export const REFERENCE_LIBRARY_SUBJECT = "reference-library";

/** Lease subject of a viewer review of one reference video. */
export function referenceVideoSubject(referenceContentId: string): string {
  return `reference-video:${referenceContentId}`;
}

/**
 * What a job's lease is held on: the content item for every per-video kind, the reference
 * library for reference analysis, the one reference video for its viewer review. One heavy job
 * per subject at a time.
 */
export function heavyJobSubject(kind: HeavyJobKind, args: unknown): string {
  if (kind === "reference-analyze") return REFERENCE_LIBRARY_SUBJECT;
  if (kind === "film-render") {
    const a = args as HeavyJobArgsByKind["film-render"];
    if (a.attachRenderId && a.contentItemId) return a.contentItemId;
    return a.filmId ? `film:${a.filmId}` : (a.contentItemId ?? `film:${filmRenderId(a)}`);
  }
  if (kind === "film-render-chunk") {
    const a = args as HeavyJobArgsByKind["film-render-chunk"];
    return `film:${a.renderId}:chunk:${a.chunkIndex}`;
  }
  if (kind === "film-storyboard" || kind === "film-voice-align") {
    const id = (args as FilmSource).filmId;
    return id ? `film:${id}` : `${kind}:${stableHash(JSON.stringify(args))}`;
  }
  if (kind === "viewer-review") {
    const a = args as HeavyJobArgsByKind["viewer-review"];
    if (a.referenceContentId) return referenceVideoSubject(a.referenceContentId);
  }
  if (kind === "graphics-bake") return `bake:${(args as { contentItemId: string }).contentItemId}`;
  return (args as { contentItemId: string }).contentItemId;
}

export type HeavyJobArgs<K extends HeavyJobKind = HeavyJobKind> = HeavyJobArgsByKind[K];

/** Kinds that call the model provider (need ANTHROPIC_API_KEY in the worker). */
export function heavyJobNeedsModel(kind: HeavyJobKind, args: unknown): boolean {
  if (kind === "quality-gate" || kind === "auto-repair" || kind === "motion-design" || kind === "viewer-review") return true;
  if (kind === "render") return !!(args as HeavyJobArgsByKind["render"]).thenQualityGate;
  return false;
}

/** What Chris sees while the job is starting ("Rendering your video…"). */
export const HEAVY_JOB_LABEL: Record<HeavyJobKind, string> = {
  render: "Rendering your video",
  "quality-gate": "Running the quality check",
  "auto-repair": "Fixing and re-rendering",
  transcribe: "Transcribing your takes",
  "subject-track": "Finding you in the frame",
  "person-matte": "Cutting you out for graphics behind you",
  "preview-proxy": "Preparing a fast preview of your footage",
  "graphics-bake": "Preparing your graphics for a smooth preview",
  ingest: "Analyzing your footage",
  "motion-design": "Designing visuals",
  "reference-analyze": "Measuring your reference videos",
  "viewer-review": "Watching it like a new viewer",
  "take-understand": "Reading your face and moves",
  "film-render": "Rendering your mini-movie",
  "film-render-chunk": "Rendering part of your mini-movie",
  "film-storyboard": "Sketching the storyboard",
  "film-voice-align": "Syncing your narration",
};

export function isHeavyJobKind(v: unknown): v is HeavyJobKind {
  return typeof v === "string" && (HEAVY_JOB_KINDS as readonly string[]).includes(v);
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 200) throw new Error(`${name} must be a non-empty string`);
  return v;
}
function optStr(v: unknown, name: string): string | undefined {
  return v == null ? undefined : str(v, name);
}
/** "Suggest with AI" for one moment of the video (graphics library). */
export interface MotionDesignFocus {
  start: number;
  end: number;
  phrase?: string | null;
}
function optFocus(v: unknown): MotionDesignFocus | null {
  if (v == null) return null;
  const f = v as Record<string, unknown>;
  const start = Number(f.start);
  const end = Number(f.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 60) throw new Error("focus must be { start, end } seconds");
  const phrase = typeof f.phrase === "string" ? f.phrase.slice(0, 300) : null;
  return { start, end, phrase };
}
function optBool(v: unknown, name: string): boolean | undefined {
  if (v == null) return undefined;
  if (typeof v !== "boolean") throw new Error(`${name} must be a boolean`);
  return v;
}
function optIds(v: unknown, name: string): string[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v) || v.length > 50) throw new Error(`${name} must be an array of ids`);
  return v.map((x, i) => str(x, `${name}[${i}]`));
}

/**
 * Validates untrusted job args (they cross a process/VM boundary as JSON). Unknown keys are
 * dropped; a malformed payload throws with a precise message.
 */
export function parseHeavyJobArgs<K extends HeavyJobKind>(kind: K, raw: unknown): HeavyJobArgsByKind[K] {
  if (!raw || typeof raw !== "object") throw new Error("job args must be an object");
  const a = raw as Record<string, unknown>;
  if (kind === "reference-analyze") {
    const ids = optIds(a.referenceContentIds, "referenceContentIds");
    return (ids ? { referenceContentIds: ids } : {}) as HeavyJobArgsByKind[K];
  }
  if (kind === "film-render" || kind === "film-storyboard" || kind === "film-voice-align") {
    const film = a.film;
    const filmKey = optStr(a.filmKey, "filmKey");
    const attach = kind === "film-render" ? optStr(a.attachRenderId, "attachRenderId") : undefined;
    if (attach) {
      return { attachRenderId: attach, contentItemId: str(a.contentItemId, "contentItemId"), tier: a.tier === "PREVIEW" ? "PREVIEW" : "FINAL", register: true } as HeavyJobArgsByKind[K];
    }
    if (film == null && !filmKey) throw new Error(`${kind} needs a film (DSL object) or a filmKey`);
    if (film != null && (typeof film !== "object" || Array.isArray(film))) throw new Error("film must be a film DSL object");
    if (film != null && JSON.stringify(film).length > 400_000) throw new Error("film is too large (max 400 KB of JSON)");
    const src: FilmSource = film != null ? { film } : { filmKey };
    const filmId = optStr(a.filmId, "filmId");
    if (filmId) src.filmId = filmId;
    const versionId = optStr(a.versionId, "versionId");
    if (versionId) src.versionId = versionId;
    const idk = typeof a.idempotencyKey === "string" && a.idempotencyKey ? a.idempotencyKey.slice(0, 300) : undefined;
    if (idk) src.idempotencyKey = idk;
    if (kind === "film-render") {
      const tier = String(a.tier ?? "FINAL");
      if (tier !== "PREVIEW" && tier !== "FINAL") throw new Error("tier must be PREVIEW or FINAL");
      const chunks = a.chunks == null ? undefined : Number(a.chunks);
      if (chunks !== undefined && (!Number.isInteger(chunks) || chunks < 1 || chunks > 32)) throw new Error("chunks must be an integer 1..32");
      const out: HeavyJobArgsByKind["film-render"] = { ...src, tier };
      if (chunks !== undefined) out.chunks = chunks;
      const narrationKey = optStr(a.narrationKey, "narrationKey");
      if (narrationKey) out.narrationKey = narrationKey;
      const contentItemId = optStr(a.contentItemId, "contentItemId");
      if (contentItemId) out.contentItemId = contentItemId;
      if (typeof a.title === "string" && a.title.trim()) out.title = a.title.trim().slice(0, 120);
      const register = optBool(a.register, "register");
      if (register !== undefined) out.register = register;
      if (a.chrisNarration != null) {
        if (typeof a.chrisNarration !== "object" || Array.isArray(a.chrisNarration)) throw new Error("chrisNarration must be { shotId: storageKey }");
        const m: Record<string, string> = {};
        for (const [k, v] of Object.entries(a.chrisNarration as Record<string, unknown>).slice(0, 80)) m[str(k, "chrisNarration key")] = str(v, `chrisNarration.${k}`);
        if (Object.keys(m).length) out.chrisNarration = m;
      }
      return out as HeavyJobArgsByKind[K];
    }
    if (kind === "film-storyboard") {
      const tier = a.tier == null ? undefined : String(a.tier);
      if (tier !== undefined && tier !== "DRAFT" && tier !== "PREVIEW") throw new Error("storyboard tier must be DRAFT or PREVIEW");
      const stills = a.stillsPerShot == null ? undefined : Number(a.stillsPerShot);
      if (stills !== undefined && (!Number.isInteger(stills) || stills < 1 || stills > 3)) throw new Error("stillsPerShot must be 1..3");
      const scale = a.scale == null ? undefined : Number(a.scale);
      if (scale !== undefined && !(scale >= 0.25 && scale <= 1)) throw new Error("scale must be 0.25..1");
      const out: HeavyJobArgsByKind["film-storyboard"] = { ...src };
      if (tier) out.tier = tier as "DRAFT" | "PREVIEW";
      if (stills) out.stillsPerShot = stills;
      if (scale) out.scale = scale;
      const shots = optIds(a.shots ?? a.shotIds, "shots");
      if (shots) out.shots = shots;
      if (Array.isArray(a.points)) {
        const pts = a.points.map(Number).filter((p) => Number.isFinite(p) && p >= 0 && p <= 1).slice(0, 3);
        if (pts.length) out.points = pts;
      }
      const narrate = optBool(a.narrate, "narrate");
      if (narrate !== undefined) out.narrate = narrate;
      return out as HeavyJobArgsByKind[K];
    }
    return { ...src, recordingKey: str(a.recordingKey, "recordingKey") } as HeavyJobArgsByKind[K];
  }
  if (kind === "film-render-chunk") {
    const chunkIndex = Number(a.chunkIndex);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 63) throw new Error("chunkIndex must be an integer 0..63");
    const attempt = a.attempt == null ? undefined : Number(a.attempt);
    return { renderId: str(a.renderId, "renderId"), chunkIndex, ...(attempt ? { attempt } : {}) } as HeavyJobArgsByKind[K];
  }
  if (kind === "viewer-review") {
    const contentItemId = optStr(a.contentItemId, "contentItemId");
    const referenceContentId = optStr(a.referenceContentId, "referenceContentId");
    if (!!contentItemId === !!referenceContentId) throw new Error("viewer-review needs exactly one of contentItemId or referenceContentId");
    const platform = a.platform == null ? undefined : String(a.platform);
    if (platform !== undefined && !["TIKTOK", "INSTAGRAM", "YOUTUBE"].includes(platform)) throw new Error("platform must be TIKTOK, INSTAGRAM or YOUTUBE");
    const persona = a.persona == null ? undefined : String(a.persona);
    if (persona !== undefined && persona !== "COLD" && persona !== "FOLLOWER") throw new Error("persona must be COLD or FOLLOWER");
    const out: HeavyJobArgsByKind["viewer-review"] = contentItemId ? { contentItemId } : { referenceContentId };
    if (platform) out.platform = platform as NonNullable<HeavyJobArgsByKind["viewer-review"]["platform"]>;
    if (persona) out.persona = persona as "COLD" | "FOLLOWER";
    return out as HeavyJobArgsByKind[K];
  }
  const contentItemId = str(a.contentItemId, "contentItemId");
  let out: unknown;
  switch (kind) {
    case "render":
      out = { contentItemId, thenQualityGate: optBool(a.thenQualityGate, "thenQualityGate") ?? false };
      break;
    case "quality-gate":
      out = { contentItemId, ...(optBool(a.lateCheck, "lateCheck") ? { lateCheck: true } : {}) };
      break;
    case "auto-repair":
    case "graphics-bake":
      out = { contentItemId };
      break;
    case "transcribe":
      out = { contentItemId, mediaAssetId: optStr(a.mediaAssetId, "mediaAssetId"), force: optBool(a.force, "force") ?? false };
      break;
    case "subject-track":
    case "person-matte":
    case "preview-proxy":
    case "take-understand":
      out = { contentItemId, mediaAssetIds: optIds(a.mediaAssetIds, "mediaAssetIds"), force: optBool(a.force, "force") ?? false };
      break;
    case "ingest":
      out = {
        contentItemId,
        transcribe: optBool(a.transcribe, "transcribe") ?? false,
        track: optBool(a.track, "track") ?? false,
        matte: optBool(a.matte, "matte") ?? false,
        proxy: optBool(a.proxy, "proxy") ?? true,
      };
      break;
    case "motion-design":
      out = { contentItemId, replaceExisting: optBool(a.replaceExisting, "replaceExisting") ?? false, focus: optFocus(a.focus), strategize: optBool(a.strategize, "strategize") ?? false };
      break;
    default:
      throw new Error(`unknown heavy job kind: ${String(kind)}`);
  }
  return out as HeavyJobArgsByKind[K];
}
