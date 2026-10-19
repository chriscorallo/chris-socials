import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { auth } from "../../../../auth";
import { prisma } from "@chris/domain";
import { storage, getLocalStorage, streamFromStorage } from "../../../../lib/storage";

/**
 * Authenticated media serving for raw takes (MediaAsset), rendered outputs (Render) and
 * reference videos (ReferenceContent, preview only).
 *
 * - Blob mode: 302 to a 10-minute presigned URL for exactly this pathname. Proxying video
 *   bytes through a function would hit Vercel's response-size limit; the private store is
 *   never publicly readable, and the link expires.
 * - Local mode: streams from disk with HTTP Range support, so the <video> element can seek.
 *
 * Only keys that belong to a real MediaAsset or Render row are served — never an arbitrary
 * storage path.
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { key: keySegments } = await params;
  const storageKey = keySegments.join("/");

  const asset = await prisma.mediaAsset.findFirst({ where: { storageKey, removedAt: null } });
  // A take's person matte (Motion v2 — the editor previews graphics behind Chris with it).
  const matteOf = asset ? null : await prisma.mediaAsset.findFirst({ where: { matteStorageKey: storageKey } });
  // A take's editor preview proxy / filmstrip sprite (preview-only; renders use the original).
  const proxyOf = asset || matteOf ? null : await prisma.mediaAsset.findFirst({ where: { OR: [{ proxyStorageKey: storageKey }, { filmstripStorageKey: storageKey }] } });
  const isFilmstrip = !!proxyOf && proxyOf.filmstripStorageKey === storageKey;
  // A graphic baked for the editor preview (docs/decisions-pending/editor-rebuild.md).
  const bake = asset || matteOf || proxyOf ? null : storageKey.startsWith("bakes/") ? await prisma.graphicBake.findFirst({ where: { storageKey }, select: { id: true } }) : null;
  const render = asset || matteOf || proxyOf || bake ? null : await prisma.render.findFirst({ where: { storageKey } });
  // A reference video (private, preview-only on the Reference pages — never a render input).
  const reference = asset || matteOf || proxyOf || render || bake ? null : await prisma.referenceContent.findFirst({ where: { mediaStorageKey: storageKey } });
  if (!asset && !render && !matteOf && !proxyOf && !reference && !bake) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const contentType = asset?.mimeType ?? reference?.mediaMimeType ?? (isFilmstrip ? "image/jpeg" : "video/mp4");
  // Header-safe filename: strip quotes/control chars rather than trusting the upload name.
  const filename = (asset?.originalFilename ?? reference?.mediaFilename ?? (matteOf ? "matte.mp4" : isFilmstrip ? "filmstrip.jpg" : proxyOf ? "preview.mp4" : bake ? "graphic.mp4" : "render.mp4")).replace(/[^\w.-]+/g, "_");
  // Editor-preview files are write-once (bakes are content-addressed by key).
  const previewCache = bake ? "private, max-age=31536000, immutable" : proxyOf ? "private, max-age=86400" : null;

  const local = getLocalStorage();
  if (!local) {
    // The compositor preview reads proxies/bakes with fetch(); if the Blob origin refuses that
    // cross-origin read, it asks for the bytes through the app instead (`?stream=1`).
    if ((proxyOf || bake) && new URL(request.url).searchParams.get("stream") === "1") {
      const stream = await streamFromStorage(storageKey);
      if (stream) return new NextResponse(stream, { headers: { "Content-Type": contentType, "Cache-Control": previewCache ?? "private, max-age=0" } });
    }
    return NextResponse.redirect(await storage.signedUrl(storageKey, 600), 302);
  }

  const filePath = local.pathFor(storageKey);
  const { size } = await stat(filePath);
  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": `inline; filename="${filename}"`,
    // Preview proxies/filmstrips are write-once per take: let the phone keep them (no re-download
    // every time the editor opens). Everything else revalidates as before.
    "Cache-Control": previewCache ?? "private, max-age=0, must-revalidate",
    "Accept-Ranges": "bytes",
  };

  const range = request.headers.get("range");
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
    return new NextResponse(stream, {
      status: 206,
      headers: { ...baseHeaders, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new NextResponse(stream, { headers: { ...baseHeaders, "Content-Length": String(size) } });
}
