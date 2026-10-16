import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma, createMediaAsset, analyzeMediaAsset } from "@chris/domain";
import { probeMedia } from "@chris/media";
import { after } from "next/server";
import { transcribeMediaAsset } from "@chris/worker/transcribe-job";
import { storage } from "./storage";
import { isAutoTranscriptionEnabled } from "./render-config";

/**
 * Shared tail of every upload path (local streaming route, or a browser-direct Blob upload):
 * the file is already in storage under `storageKey`; record the MediaAsset and run
 * deterministic ffprobe analysis against a local copy. Analyzing the first take of an item
 * in FILMED is the canonical FILMED -> MEDIA_INGESTED trigger (packages/domain media-asset.ts).
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
}) {
  const asset = await createMediaAsset(
    prisma,
    {
      contentItemId: input.contentItemId,
      kind: "RAW_TAKE",
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

  // Transcribe in the background once the response is sent (word timings feed take
  // selection, cut snapping and burned-in captions). Failure just leaves the transcript empty
  // — the content page offers a retry and a manual-entry box.
  if (isAutoTranscriptionEnabled() && probed.hasAudio) {
    after(async () => {
      const result = await transcribeMediaAsset(prisma, storage, asset.id, {}, { actorId: input.actorId });
      if (result.status === "FAILED") {
        console.error(JSON.stringify({ level: "error", event: "transcription_failed", mediaAssetId: asset.id, message: result.errorMessage }));
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
