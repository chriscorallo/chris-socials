import { NextResponse } from "next/server";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { auth } from "../../../auth";
import { prisma } from "@chris/domain";
import { getLocalStorage } from "../../../lib/storage";
import { withTempDir } from "../../../lib/ingest-upload";
import { referenceStorageKey, registerReferenceUpload } from "../../../lib/reference-upload";

export const maxDuration = 300;

/**
 * Local-mode reference-video upload — the same streaming approach as /api/upload (raw body
 * straight to disk, no Server Action body limit). Production uses browser-direct private Blob
 * (/api/blob-upload with a `reference/<creator>/…` pathname) + the registerReferenceBlobUpload
 * action instead. Never touches a content item or the render path.
 */
export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const local = getLocalStorage();
  if (!local) return NextResponse.json({ error: "Direct uploads go to Blob storage in this deployment." }, { status: 400 });
  const url = new URL(request.url);
  const referenceCreatorId = url.searchParams.get("referenceCreatorId") ?? "";
  const filename = url.searchParams.get("filename") ?? "video.mp4";
  const sourceUrl = url.searchParams.get("sourceUrl");
  const rawType = request.headers.get("content-type") ?? "";
  const mimeType = rawType && rawType !== "application/octet-stream" ? rawType : undefined;
  if (mimeType && !/^video\//.test(mimeType)) return NextResponse.json({ error: `Reference videos must be video files (this is ${mimeType}).` }, { status: 415 });
  if (!request.body) return NextResponse.json({ error: "Empty upload." }, { status: 400 });
  const creator = await prisma.referenceCreator.findUnique({ where: { id: referenceCreatorId }, select: { id: true } });
  if (!creator) return NextResponse.json({ error: "Creator not found." }, { status: 404 });

  const storageKey = referenceStorageKey(referenceCreatorId, filename);
  try {
    const row = await withTempDir(async (dir) => {
      const tempPath = join(dir, "upload");
      await pipeline(Readable.fromWeb(request.body as never), createWriteStream(tempPath));
      const { size } = await stat(tempPath);
      if (size === 0) throw new Error("Empty upload.");
      await local.putFile(storageKey, tempPath);
      return registerReferenceUpload({ referenceCreatorId, storageKey, filename, mimeType, sizeBytes: size, sourceUrl, actorId: session.user!.id! });
    });
    return NextResponse.json({ referenceContentId: row.id });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Upload failed" }, { status: 500 });
  }
}
