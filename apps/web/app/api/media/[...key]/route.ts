import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { auth } from "../../../../auth";
import { prisma } from "@chris/domain";
import { storage, getLocalStorage } from "../../../../lib/storage";

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

  const asset = await prisma.mediaAsset.findFirst({ where: { storageKey } });
  // A take's person matte (Motion v2 — the editor previews graphics behind Chris with it).
  const matteOf = asset ? null : await prisma.mediaAsset.findFirst({ where: { matteStorageKey: storageKey } });
  const render = asset || matteOf ? null : await prisma.render.findFirst({ where: { storageKey } });
  // A reference video (private, preview-only on the Reference pages — never a render input).
  const reference = asset || matteOf || render ? null : await prisma.referenceContent.findFirst({ where: { mediaStorageKey: storageKey } });
  if (!asset && !render && !matteOf && !reference) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const contentType = asset?.mimeType ?? reference?.mediaMimeType ?? "video/mp4";
  // Header-safe filename: strip quotes/control chars rather than trusting the upload name.
  const filename = (asset?.originalFilename ?? reference?.mediaFilename ?? (matteOf ? "matte.mp4" : "render.mp4")).replace(/[^\w.-]+/g, "_");

  const local = getLocalStorage();
  if (!local) {
    return NextResponse.redirect(await storage.signedUrl(storageKey, 600), 302);
  }

  const filePath = local.pathFor(storageKey);
  const { size } = await stat(filePath);
  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": `inline; filename="${filename}"`,
    "Cache-Control": "private, max-age=0, must-revalidate",
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
