import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { getLatestTakeUnderstandings, recordTakeUnderstanding, type PrismaClient } from "@chris/domain";
import type { StorageAdapter, TakeUnderstandingAnalysis } from "@chris/media";

/**
 * Director chat: computes what the chat "sees" of each raw take ONCE (face boxes, FER+
 * expression timeline, motion, a frames sprite) and caches it in TakeUnderstanding — free and
 * local (two small ONNX models + ffmpeg). Fails safely: an error returns FAILED and the Director
 * chat simply works without face data (the pack says so). See
 * docs/decisions-pending/director-chat.md.
 */

export interface TakeUnderstandingJobResult {
  mediaAssetId: string;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  samples?: number;
  withFace?: number;
  ms?: number;
  errorMessage?: string;
}

export type UnderstandingAnalyzer = (videoPath: string, mediaAssetId: string) => Promise<TakeUnderstandingAnalysis>;

async function defaultAnalyzer(): Promise<UnderstandingAnalyzer> {
  const { analyzeTakeUnderstanding } = await import("@chris/media");
  return (path, mediaAssetId) => analyzeTakeUnderstanding(path, { mediaAssetId });
}

/** Kill switch: DIRECTOR_UNDERSTANDING=off skips the analysis (ingest stays as it was). */
export function isTakeUnderstandingEnabled(): boolean {
  return process.env.DIRECTOR_UNDERSTANDING !== "off";
}

export async function understandMediaAsset(
  db: PrismaClient,
  storage: StorageAdapter,
  mediaAssetId: string,
  actor: { actorId: string },
  options: { analyze?: UnderstandingAnalyzer } = {},
): Promise<TakeUnderstandingJobResult> {
  const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: mediaAssetId } });
  if (asset.kind !== "RAW_TAKE") return { mediaAssetId, status: "SKIPPED", errorMessage: `Not a raw take (${asset.kind}).` };
  const workDir = await mkdtemp(join(tmpdir(), "chris-understand-"));
  try {
    const analyze = options.analyze ?? (await defaultAnalyzer());
    // The 720p proxy is plenty for faces at 4 fps and much smaller to fetch than the original.
    const key = asset.proxyStorageKey ?? asset.storageKey;
    const filePath = join(workDir, `take${asset.proxyStorageKey ? ".mp4" : extname(asset.originalFilename) || ".mp4"}`);
    await writeFile(filePath, await storage.get(key));
    const r = await analyze(filePath, mediaAssetId);
    let spriteKey: string | null = null;
    if (r.spriteJpeg) {
      spriteKey = `understanding/${asset.contentItemId}/${mediaAssetId}-${Date.now().toString(36)}.jpg`;
      await storage.put(spriteKey, r.spriteJpeg, "image/jpeg");
    }
    await recordTakeUnderstanding(db, { mediaAssetId, data: r.understanding, spriteKey, model: r.understanding.model.id, ms: r.ms }, actor);
    return {
      mediaAssetId,
      status: "SUCCESS",
      samples: r.understanding.samples.length,
      withFace: r.understanding.samples.filter((s) => s.face).length,
      ms: r.ms,
    };
  } catch (err) {
    return { mediaAssetId, status: "FAILED", errorMessage: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Every listed take without an understanding gets one (all with `force`). Sequential. */
export async function ensureTakeUnderstandings(
  db: PrismaClient,
  storage: StorageAdapter,
  mediaAssetIds: string[],
  actor: { actorId: string },
  options: { analyze?: UnderstandingAnalyzer; force?: boolean } = {},
): Promise<TakeUnderstandingJobResult[]> {
  const ids = [...new Set(mediaAssetIds)];
  const have = options.force ? {} : await getLatestTakeUnderstandings(db, ids);
  const out: TakeUnderstandingJobResult[] = [];
  for (const id of ids) {
    if (!options.force && have[id]) {
      out.push({ mediaAssetId: id, status: "SKIPPED" });
      continue;
    }
    out.push(await understandMediaAsset(db, storage, id, actor, { analyze: options.analyze }));
  }
  return out;
}
