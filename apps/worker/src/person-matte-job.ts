import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { recordPersonMatte, type PrismaClient } from "@chris/domain";
import type { PersonMatteResult, StorageAdapter } from "@chris/media";

/**
 * Person mattes for raw takes (Motion v2 — graphics BEHIND Chris). For each take: download,
 * `computePersonMatte` (MODNet, packages/media), upload to `mattes/<contentItemId>/<id>.mp4`,
 * `recordPersonMatte` (audit-logged). Fails safely per take: a failure is reported and the
 * take simply has no matte — its behind-subject graphics render in front (with a warning).
 */

export interface PersonMatteJobResult {
  mediaAssetId: string;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  storageKey?: string;
  frames?: number;
  ms?: number;
  coverage?: number;
  errorMessage?: string;
}

export type MatteComputer = (videoPath: string, outPath: string) => Promise<PersonMatteResult>;

/** Default: the real ONNX matte. Imported lazily so a process that never mattes never loads onnxruntime. */
async function defaultComputer(): Promise<MatteComputer> {
  const { computePersonMatte } = await import("@chris/media");
  return (src, out) => computePersonMatte(src, out);
}

export async function computePersonMatteForMediaAsset(
  db: PrismaClient,
  storage: StorageAdapter,
  mediaAssetId: string,
  actor: { actorId: string },
  options: { compute?: MatteComputer } = {},
): Promise<PersonMatteJobResult> {
  const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: mediaAssetId } });
  if (asset.kind !== "RAW_TAKE") return { mediaAssetId, status: "SKIPPED", errorMessage: `Not a raw take (${asset.kind}).` };
  if (asset.width == null || asset.height == null) return { mediaAssetId, status: "SKIPPED", errorMessage: "No video stream." };
  const work = await mkdtemp(join(tmpdir(), "chris-matte-"));
  try {
    const compute = options.compute ?? (await defaultComputer());
    const src = join(work, `take${extname(asset.originalFilename) || ".mp4"}`);
    const out = join(work, "matte.mp4");
    await writeFile(src, await storage.get(asset.storageKey));
    const res = await compute(src, out);
    const key = `mattes/${asset.contentItemId}/${asset.id}.mp4`;
    await storage.put(key, await readFile(out), "video/mp4");
    await recordPersonMatte(db, asset.id, key, { actorId: actor.actorId, actorType: "JOB" }, {
      model: res.model,
      width: res.width,
      height: res.height,
      fps: res.fps,
      frames: res.frames,
      coverage: res.coverage,
      ms: res.ms,
    });
    return { mediaAssetId, status: "SUCCESS", storageKey: key, frames: res.frames, ms: res.ms, coverage: res.coverage };
  } catch (err) {
    return { mediaAssetId, status: "FAILED", errorMessage: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Makes sure takes have a person matte: all RAW_TAKEs of a content item, or the given ids.
 * Takes that already have one are skipped unless `force`. Sequential (CPU-bound, one ONNX session).
 */
export async function ensurePersonMattes(
  db: PrismaClient,
  storage: StorageAdapter,
  target: { contentItemId: string } | { mediaAssetIds: string[] },
  actor: { actorId: string },
  options: { compute?: MatteComputer; force?: boolean } = {},
): Promise<PersonMatteJobResult[]> {
  const ids =
    "contentItemId" in target
      ? (await db.mediaAsset.findMany({ where: { contentItemId: target.contentItemId, kind: "RAW_TAKE" }, select: { id: true } })).map((a) => a.id)
      : [...new Set(target.mediaAssetIds)];
  const out: PersonMatteJobResult[] = [];
  for (const id of ids) {
    const a = await db.mediaAsset.findUniqueOrThrow({ where: { id } });
    if (!options.force && a.matteStorageKey) {
      out.push({ mediaAssetId: id, status: "SKIPPED", storageKey: a.matteStorageKey });
      continue;
    }
    out.push(await computePersonMatteForMediaAsset(db, storage, id, actor, { compute: options.compute }));
  }
  return out;
}
