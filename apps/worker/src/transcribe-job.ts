import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { recordTranscript, type PrismaClient } from "@chris/domain";
import type { TranscriptionProvider } from "@chris/agents";
import type { StorageAdapter } from "@chris/media";

export interface TranscribeJobResult {
  mediaAssetId: string;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  wordCount?: number;
  text?: string;
  errorMessage?: string;
  model?: string;
}

/**
 * Default provider: local Whisper (transformers.js) — zero credentials. Imported lazily so a
 * process that never transcribes never loads onnxruntime.
 */
async function defaultProvider(): Promise<TranscriptionProvider & { model?: string }> {
  const { LocalWhisperTranscriptionProvider } = await import("@chris/media/transcription");
  return new LocalWhisperTranscriptionProvider();
}

/**
 * Transcribes one MediaAsset (a raw take) end to end: fetch bytes from storage, run the
 * transcription provider, persist text + word timings + provenance via the domain's
 * `recordTranscript` (which audit-logs). Fails safely: a provider error returns
 * `{status: "FAILED"}` and leaves any existing transcript untouched — a manual transcript
 * is always still possible, and nothing downstream requires word timings.
 */
export async function transcribeMediaAsset(
  db: PrismaClient,
  storage: StorageAdapter,
  mediaAssetId: string,
  options: { provider?: TranscriptionProvider & { model?: string } } = {},
  actor: { actorId: string },
): Promise<TranscribeJobResult> {
  const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: mediaAssetId } });
  if (asset.kind !== "RAW_TAKE") {
    return { mediaAssetId, status: "SKIPPED", errorMessage: `Not a raw take (${asset.kind}).` };
  }
  const workDir = await mkdtemp(join(tmpdir(), "chris-transcribe-"));
  try {
    const provider = options.provider ?? (await defaultProvider());
    const filePath = join(workDir, `take${extname(asset.originalFilename) || ".mp4"}`);
    await writeFile(filePath, await storage.get(asset.storageKey));

    const result = await provider.transcribe(filePath);
    const words = result.words ?? null;
    await recordTranscript(
      db,
      {
        mediaAssetId,
        text: result.text,
        words,
        source: "LOCAL_WHISPER",
        model: provider.model,
      },
      { actorId: actor.actorId, actorType: "JOB" },
    );
    return {
      mediaAssetId,
      status: "SUCCESS",
      wordCount: words?.length ?? 0,
      text: result.text,
      model: provider.model,
    };
  } catch (err) {
    return {
      mediaAssetId,
      status: "FAILED",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Transcribes every raw take of a ContentItem that doesn't have word timings yet. A take
 * whose transcript Chris typed by hand (source MANUAL) is skipped unless `force` — never
 * silently overwrite a human's transcript with a machine one. Sequential on purpose: Whisper
 * is CPU-bound and one model instance is shared.
 */
export async function transcribeContentItemTakes(
  db: PrismaClient,
  storage: StorageAdapter,
  contentItemId: string,
  options: { provider?: TranscriptionProvider & { model?: string }; force?: boolean } = {},
  actor: { actorId: string },
): Promise<TranscribeJobResult[]> {
  const assets = await db.mediaAsset.findMany({
    // Takes only — a MUSIC bed has no speech to transcribe.
    where: { contentItemId, kind: "RAW_TAKE", removedAt: null },
    orderBy: { createdAt: "asc" },
  });
  const provider = options.provider ?? (await defaultProvider());
  const results: TranscribeJobResult[] = [];
  for (const asset of assets) {
    const alreadyTimed = asset.transcriptWords != null;
    const manual = asset.transcriptSource === "MANUAL";
    if (!options.force && (alreadyTimed || manual)) {
      results.push({ mediaAssetId: asset.id, status: "SKIPPED" });
      continue;
    }
    results.push(await transcribeMediaAsset(db, storage, asset.id, { provider }, actor));
  }
  return results;
}
