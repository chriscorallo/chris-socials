import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma, createMediaAsset, analyzeMediaAsset } from "@chris/domain";
import { probeMedia } from "@chris/media";
import { after } from "next/server";
import { transcribeMediaAsset } from "@chris/worker/transcribe-job";
import { trackSubjectForMediaAsset } from "@chris/worker/subject-track-job";
import { computePersonMatteForMediaAsset } from "@chris/worker/person-matte-job";
import { storage } from "./storage";
import { heavyJobMode, isAutoPersonMatteEnabled, isAutoSubjectTrackingEnabled, isAutoTranscriptionEnabled } from "./render-config";
import { runHeavyJob } from "./heavy-jobs";

/** What an upload is: a filmed take (default) or a music bed for the finishing editor. */
export type UploadKind = "RAW_TAKE" | "MUSIC";

export function parseUploadKind(value: string | null | undefined): UploadKind {
  return value === "MUSIC" ? "MUSIC" : "RAW_TAKE";
}

/** Mime check per kind: takes are video (or audio-only takes); music must be audio. */
export function uploadMimeAllowed(kind: UploadKind, mimeType: string): boolean {
  return kind === "MUSIC" ? /^audio\//.test(mimeType) : /^(video|audio)\//.test(mimeType);
}

/**
 * Shared tail of every upload path (local streaming route, or a browser-direct Blob upload):
 * the file is already in storage under `storageKey`; record the MediaAsset and run
 * deterministic ffprobe analysis against a local copy. Analyzing the first take of an item
 * in FILMED is the canonical FILMED -> MEDIA_INGESTED trigger (packages/domain media-asset.ts);
 * a MUSIC asset is analyzed too (duration for the editor) but never moves the item and is
 * never transcribed or tracked.
 *
 * `localPath` must be a readable copy of the uploaded file (the caller already has one, or
 * downloads it) — ffprobe needs a real file path.
 */
export async function registerUploadedRawTake(input: {
  contentItemId: string;
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  localPath: string;
  actorId: string;
  kind?: UploadKind;
}) {
  const kind = input.kind ?? "RAW_TAKE";
  const asset = await createMediaAsset(
    prisma,
    {
      contentItemId: input.contentItemId,
      kind,
      storageKey: input.storageKey,
      originalFilename: input.originalFilename,
      mimeType: input.mimeType || "application/octet-stream",
      sizeBytes: input.sizeBytes,
    },
    { actorId: input.actorId },
  );

  const probed = await probeMedia(input.localPath);
  await analyzeMediaAsset(
    prisma,
    asset.id,
    {
      durationSeconds: probed.durationSeconds,
      width: probed.width,
      height: probed.height,
      frameRate: probed.frameRate,
      hasAudio: probed.hasAudio,
      videoCodec: probed.videoCodec,
      audioCodec: probed.audioCodec,
    },
    { actorId: input.actorId },
  );
  if (kind === "MUSIC") return asset;

  // Background work once the response is sent: transcription (word timings feed take
  // selection, cut snapping and burned-in captions), then subject tracking (where Chris is on
  // screen — motion graphics are placed around him). Failures just leave the field empty: the
  // content page offers a transcript retry/manual entry, and placement falls back to an
  // assumed centred framing with a warning. Both are local-only by default (ONNX is heavy).
  const transcribe = isAutoTranscriptionEnabled() && probed.hasAudio;
  const track = isAutoSubjectTrackingEnabled() && probed.width != null && probed.height != null;
  const matte = isAutoPersonMatteEnabled() && probed.width != null && probed.height != null;
  if ((transcribe || track || matte) && heavyJobMode() === "sandbox") {
    // Vercel: ONE cloud-worker job does all three (it also picks up any other take of this item
    // still missing them). Busy (another heavy job for this video) → that job's owner or the
    // video page's buttons cover it; logged, never fatal to the upload.
    after(async () => {
      const r = await runHeavyJob("ingest", { contentItemId: input.contentItemId, transcribe, track, matte }, { actorId: input.actorId }).catch((err) => ({
        status: "refused" as const,
        jobRunId: null,
        message: err instanceof Error ? err.message : String(err),
      }));
      if (r.status !== "started") {
        console.error(JSON.stringify({ level: "warn", event: "ingest_job_not_started", mediaAssetId: asset.id, status: r.status, message: "message" in r ? r.message : null }));
      }
    });
    return asset;
  }
  if (transcribe || track || matte) {
    after(async () => {
      if (transcribe) {
        const result = await transcribeMediaAsset(prisma, storage, asset.id, {}, { actorId: input.actorId });
        if (result.status === "FAILED") {
          console.error(JSON.stringify({ level: "error", event: "transcription_failed", mediaAssetId: asset.id, message: result.errorMessage }));
        }
      }
      if (track) {
        const result = await trackSubjectForMediaAsset(prisma, storage, asset.id, { actorId: input.actorId });
        if (result.status === "FAILED") {
          console.error(JSON.stringify({ level: "error", event: "subject_tracking_failed", mediaAssetId: asset.id, message: result.errorMessage }));
        }
      }
      // Person matte (graphics behind Chris) — after tracking; the slowest step (~8 matte fps).
      if (matte) {
        const result = await computePersonMatteForMediaAsset(prisma, storage, asset.id, { actorId: input.actorId });
        if (result.status === "FAILED") {
          console.error(JSON.stringify({ level: "error", event: "person_matte_failed", mediaAssetId: asset.id, message: result.errorMessage }));
        }
      }
    });
  }
  return asset;
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "chris-upload-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function rawTakeStorageKey(contentItemId: string, safeName: string): string {
  return `raw/${contentItemId}/${Date.now()}-${safeName}`;
}

export function musicStorageKey(contentItemId: string, safeName: string): string {
  return `music/${contentItemId}/${Date.now()}-${safeName}`;
}

/** The storage-key prefix an upload of `kind` must live under. */
export function uploadKeyPrefix(kind: UploadKind, contentItemId: string): string {
  return kind === "MUSIC" ? `music/${contentItemId}/` : `raw/${contentItemId}/`;
}
