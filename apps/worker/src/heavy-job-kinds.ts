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
  "ingest",
  "motion-design",
  "reference-analyze",
] as const;

export type HeavyJobKind = (typeof HEAVY_JOB_KINDS)[number];

export interface HeavyJobArgsByKind {
  /** Render the latest edit (motion layer + matte compositing). `thenQualityGate` runs the four
   * hard gates right after a successful render in the same worker (the editor's Finish). */
  render: { contentItemId: string; thenQualityGate?: boolean };
  "quality-gate": { contentItemId: string };
  /** EDIT → RENDER → INSPECT → FIX loop (re-renders). */
  "auto-repair": { contentItemId: string };
  /** One take, or every take without word timings (`force` re-does all but never silently). */
  transcribe: { contentItemId: string; mediaAssetId?: string; force?: boolean };
  "subject-track": { contentItemId: string; mediaAssetIds?: string[]; force?: boolean };
  "person-matte": { contentItemId: string; mediaAssetIds?: string[]; force?: boolean };
  /** After an upload: transcribe → track → matte for every take of the item still missing them. */
  ingest: { contentItemId: string; transcribe: boolean; track: boolean; matte: boolean };
  /** "Design visuals with AI" (HUMAN trigger; subject tracking runs first). */
  "motion-design": { contentItemId: string; replaceExisting?: boolean };
  /** Measure reference videos' edit style (no model calls): every one waiting, or just `referenceContentIds`.
   * Not tied to a video — its lease is the whole reference library (REFERENCE_LIBRARY_SUBJECT). */
  "reference-analyze": { referenceContentIds?: string[] };
}

/** Lease subject of the reference-analysis job (one at a time for the whole library). */
export const REFERENCE_LIBRARY_SUBJECT = "reference-library";

/**
 * What a job's lease is held on: the content item for every per-video kind, the reference
 * library for reference analysis. One heavy job per subject at a time.
 */
export function heavyJobSubject(kind: HeavyJobKind, args: unknown): string {
  if (kind === "reference-analyze") return REFERENCE_LIBRARY_SUBJECT;
  return (args as { contentItemId: string }).contentItemId;
}

export type HeavyJobArgs<K extends HeavyJobKind = HeavyJobKind> = HeavyJobArgsByKind[K];

/** Kinds that call the model provider (need ANTHROPIC_API_KEY in the worker). */
export function heavyJobNeedsModel(kind: HeavyJobKind, args: unknown): boolean {
  if (kind === "quality-gate" || kind === "auto-repair" || kind === "motion-design") return true;
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
  ingest: "Analyzing your footage",
  "motion-design": "Designing visuals",
  "reference-analyze": "Measuring your reference videos",
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
  const contentItemId = str(a.contentItemId, "contentItemId");
  let out: unknown;
  switch (kind) {
    case "render":
      out = { contentItemId, thenQualityGate: optBool(a.thenQualityGate, "thenQualityGate") ?? false };
      break;
    case "quality-gate":
    case "auto-repair":
      out = { contentItemId };
      break;
    case "transcribe":
      out = { contentItemId, mediaAssetId: optStr(a.mediaAssetId, "mediaAssetId"), force: optBool(a.force, "force") ?? false };
      break;
    case "subject-track":
    case "person-matte":
      out = { contentItemId, mediaAssetIds: optIds(a.mediaAssetIds, "mediaAssetIds"), force: optBool(a.force, "force") ?? false };
      break;
    case "ingest":
      out = {
        contentItemId,
        transcribe: optBool(a.transcribe, "transcribe") ?? false,
        track: optBool(a.track, "track") ?? false,
        matte: optBool(a.matte, "matte") ?? false,
      };
      break;
    case "motion-design":
      out = { contentItemId, replaceExisting: optBool(a.replaceExisting, "replaceExisting") ?? false };
      break;
    default:
      throw new Error(`unknown heavy job kind: ${String(kind)}`);
  }
  return out as HeavyJobArgsByKind[K];
}
