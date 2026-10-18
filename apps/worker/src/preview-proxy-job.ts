import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { recordPreviewAssets, parsePreviewMeta, PREVIEW_META_VERSION, type PrismaClient } from "@chris/domain";
import type { PreviewAssetsResult, StorageAdapter } from "@chris/media";

/**
 * Editor preview assets for raw takes: download the original, `makePreviewAssets` (ffmpeg:
 * 720p H.264 proxy with a keyframe every 0.5 s + filmstrip sprite + audio peaks), upload to
 * `proxies/<contentItemId>/<id>.mp4` / `<id>-filmstrip.jpg`, `recordPreviewAssets`
 * (audit-logged). Fails safely per take: the editor just keeps playing the original.
 * Preview-only — renders always read the original (no quality loss).
 */

export interface PreviewProxyJobResult {
  mediaAssetId: string;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  proxyStorageKey?: string;
  ms?: number;
  proxyBytes?: number;
  errorMessage?: string;
}

export type PreviewMaker = (
  srcPath: string,
  outDir: string,
  src: { width: number; height: number; fps: number | null; durationSeconds: number; hasAudio: boolean },
) => Promise<PreviewAssetsResult>;

/** Default: the real ffmpeg pipeline. Imported lazily (keeps the job module light). */
async function defaultMaker(): Promise<PreviewMaker> {
  const { makePreviewAssets } = await import("@chris/media");
  return makePreviewAssets;
}

export async function makePreviewForMediaAsset(
  db: PrismaClient,
  storage: StorageAdapter,
  mediaAssetId: string,
  actor: { actorId: string },
  options: { make?: PreviewMaker } = {},
): Promise<PreviewProxyJobResult> {
  const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: mediaAssetId } });
  if (asset.kind !== "RAW_TAKE") return { mediaAssetId, status: "SKIPPED", errorMessage: `Not a raw take (${asset.kind}).` };
  if (asset.width == null || asset.height == null || !asset.durationSeconds) return { mediaAssetId, status: "SKIPPED", errorMessage: "Not analyzed yet (no video size/duration)." };
  const work = await mkdtemp(join(tmpdir(), "chris-proxy-"));
  try {
    const make = options.make ?? (await defaultMaker());
    const src = join(work, `take${extname(asset.originalFilename) || ".mp4"}`);
    await writeFile(src, await storage.get(asset.storageKey));
    // Older takes were stored with the CODED size (sideways for iPhone footage) — correct the row
    // to the display size so layout/crops/placement see the take upright.
    const { displayDimensions } = await import("@chris/media");
    const shown = await displayDimensions(src).catch(() => null);
    if (shown && (shown.width !== asset.width || shown.height !== asset.height)) {
      await db.mediaAsset.update({ where: { id: asset.id }, data: { width: shown.width, height: shown.height } });
    }
    const res = await make(src, work, {
      width: shown?.width ?? asset.width,
      height: shown?.height ?? asset.height,
      fps: asset.frameRate,
      durationSeconds: asset.durationSeconds,
      hasAudio: asset.hasAudio !== false,
    });
    const proxyKey = `proxies/${asset.contentItemId}/${asset.id}.mp4`;
    const stripKey = `proxies/${asset.contentItemId}/${asset.id}-filmstrip.jpg`;
    const proxyBytes = await readFile(res.proxyPath);
    await storage.put(proxyKey, proxyBytes, "video/mp4");
    await storage.put(stripKey, await readFile(res.filmstripPath), "image/jpeg");
    await recordPreviewAssets(
      db,
      asset.id,
      { proxyStorageKey: proxyKey, filmstripStorageKey: stripKey, meta: { v: PREVIEW_META_VERSION, proxy: res.plan.proxy, filmstrip: res.plan.filmstrip, peaks: res.peaks } },
      { actorId: actor.actorId, actorType: "JOB" },
      { ms: res.ms, sourceCodec: asset.videoCodec },
    );
    return { mediaAssetId, status: "SUCCESS", proxyStorageKey: proxyKey, ms: res.ms, proxyBytes: proxyBytes.length };
  } catch (err) {
    return { mediaAssetId, status: "FAILED", errorMessage: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Makes sure takes have preview assets: all RAW_TAKEs of a content item, or the given ids.
 * Takes that already have a proxy are skipped unless `force`. Sequential (one ffmpeg at a time).
 */
export async function ensurePreviewProxies(
  db: PrismaClient,
  storage: StorageAdapter,
  target: { contentItemId: string } | { mediaAssetIds: string[] },
  actor: { actorId: string },
  options: { make?: PreviewMaker; force?: boolean } = {},
): Promise<PreviewProxyJobResult[]> {
  const ids =
    "contentItemId" in target
      ? (await db.mediaAsset.findMany({ where: { contentItemId: target.contentItemId, kind: "RAW_TAKE" }, select: { id: true }, orderBy: { createdAt: "asc" } })).map((a) => a.id)
      : [...new Set(target.mediaAssetIds)];
  const out: PreviewProxyJobResult[] = [];
  for (const id of ids) {
    const a = await db.mediaAsset.findUniqueOrThrow({ where: { id } });
    if (!options.force && a.proxyStorageKey && parsePreviewMeta(a.previewMeta)?.v === PREVIEW_META_VERSION) {
      out.push({ mediaAssetId: id, status: "SKIPPED", proxyStorageKey: a.proxyStorageKey });
      continue;
    }
    out.push(await makePreviewForMediaAsset(db, storage, id, actor, { make: options.make }));
  }
  return out;
}
