import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { recordSubjectTrack, parseSubjectTrackRecord, type PrismaClient } from "@chris/domain";
import type { StorageAdapter, SubjectTrackAnalysis } from "@chris/media";

export interface SubjectTrackJobResult {
  mediaAssetId: string;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  samples?: number;
  /** Fraction of samples where a face was found. */
  coverage?: number;
  errorMessage?: string;
}

export type SubjectAnalyzer = (videoPath: string) => Promise<SubjectTrackAnalysis>;

/** Default analyzer: the real ONNX face tracker. Imported lazily so a process that never
 * tracks never loads onnxruntime. */
async function defaultAnalyzer(): Promise<SubjectAnalyzer> {
  const { analyzeSubjectTrackDetailed } = await import("@chris/media");
  return (path) => analyzeSubjectTrackDetailed(path);
}

/**
 * Tracks where Chris is in one raw take (MediaAsset) and stores it on
 * MediaAsset.subjectTrack via the domain's `recordSubjectTrack` (audit-logged). Fails safely:
 * a tracker error returns FAILED and leaves any previous track untouched — placement then
 * falls back to an assumed centred framing (with a warning), nothing downstream breaks.
 */
export async function trackSubjectForMediaAsset(
  db: PrismaClient,
  storage: StorageAdapter,
  mediaAssetId: string,
  actor: { actorId: string },
  options: { analyze?: SubjectAnalyzer } = {},
): Promise<SubjectTrackJobResult> {
  const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: mediaAssetId } });
  if (asset.kind !== "RAW_TAKE") {
    return { mediaAssetId, status: "SKIPPED", errorMessage: `Not a raw take (${asset.kind}).` };
  }
  const workDir = await mkdtemp(join(tmpdir(), "chris-subject-"));
  try {
    const analyze = options.analyze ?? (await defaultAnalyzer());
    const filePath = join(workDir, `take${extname(asset.originalFilename) || ".mp4"}`);
    await writeFile(filePath, await storage.get(asset.storageKey));
    const result = await analyze(filePath);
    await recordSubjectTrack(db, mediaAssetId, result.track, { actorId: actor.actorId, actorType: "JOB" }, {
      model: result.model,
      fps: result.fps,
      framesAnalyzed: result.framesAnalyzed,
      framesWithFace: result.framesWithFace,
    });
    const withFace = result.track.filter((s) => s.box !== null).length;
    return {
      mediaAssetId,
      status: "SUCCESS",
      samples: result.track.length,
      coverage: result.track.length ? withFace / result.track.length : 0,
    };
  } catch (err) {
    return { mediaAssetId, status: "FAILED", errorMessage: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Makes sure every listed take has a subject track: tracks the ones that don't (or all of
 * them with `force`). Sequential — the detector is CPU-bound and one session is shared.
 */
export async function ensureSubjectTracks(
  db: PrismaClient,
  storage: StorageAdapter,
  mediaAssetIds: string[],
  actor: { actorId: string },
  options: { analyze?: SubjectAnalyzer; force?: boolean } = {},
): Promise<SubjectTrackJobResult[]> {
  const results: SubjectTrackJobResult[] = [];
  for (const id of [...new Set(mediaAssetIds)]) {
    const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id } });
    if (!options.force && parseSubjectTrackRecord(asset.subjectTrack) !== null) {
      results.push({ mediaAssetId: id, status: "SKIPPED" });
      continue;
    }
    results.push(await trackSubjectForMediaAsset(db, storage, id, actor, { analyze: options.analyze }));
  }
  return results;
}
