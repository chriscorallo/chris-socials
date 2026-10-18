import { prisma, queryAll } from "@chris/domain";

/**
 * Which row a storage key belongs to — the authorization check behind /api/media and
 * /api/thumb (only keys that belong to a real MediaAsset, person matte, Render or reference
 * video are ever served, never an arbitrary storage path).
 *
 * The four lookups are independent, so they go out together on Neon (one round trip instead
 * of up to four) and one at a time on PGlite; precedence is unchanged: asset, then matte,
 * then render, then reference video.
 */
export type MediaOwner =
  | { kind: "asset"; contentType: string; filename: string }
  | { kind: "matte"; contentType: string; filename: string }
  | { kind: "render"; contentType: string; filename: string }
  | { kind: "reference"; contentType: string; filename: string };

export async function findMediaOwner(storageKey: string): Promise<MediaOwner | null> {
  const [asset, matteOf, render, reference] = await queryAll([
    () => prisma.mediaAsset.findFirst({ where: { storageKey }, select: { mimeType: true, originalFilename: true } }),
    () => prisma.mediaAsset.findFirst({ where: { matteStorageKey: storageKey }, select: { id: true } }),
    () => prisma.render.findFirst({ where: { storageKey }, select: { id: true } }),
    () => prisma.referenceContent.findFirst({ where: { mediaStorageKey: storageKey }, select: { mediaMimeType: true, mediaFilename: true } }),
  ] as const);
  if (asset) return { kind: "asset", contentType: asset.mimeType, filename: asset.originalFilename };
  if (matteOf) return { kind: "matte", contentType: "video/mp4", filename: "matte.mp4" };
  if (render) return { kind: "render", contentType: "video/mp4", filename: "render.mp4" };
  if (reference) return { kind: "reference", contentType: reference.mediaMimeType ?? "video/mp4", filename: reference.mediaFilename ?? "render.mp4" };
  return null;
}
