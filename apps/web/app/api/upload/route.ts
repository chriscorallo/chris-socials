import { NextResponse } from "next/server";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { auth } from "../../../auth";
import { prisma } from "@chris/domain";
import { getLocalStorage, safeFilename } from "../../../lib/storage";
import { registerUploadedRawTake, withTempDir, rawTakeStorageKey, musicStorageKey, parseUploadKind, uploadMimeAllowed } from "../../../lib/ingest-upload";

export const maxDuration = 300;

/**
 * Local-mode raw-take upload: the browser PUTs the file as the raw request body and this
 * route streams it straight to disk — no Server Action body limit (Next's default is 1 MB,
 * which rejected every real phone video), and no whole-file buffering in memory.
 *
 * Production (blob mode) never uses this route: Vercel caps function request bodies at
 * 4.5 MB, so the browser uploads directly to Blob instead (app/api/blob-upload + the
 * registerBlobUpload server action). See /docs/DECISIONS.md ("Uploads: streaming locally,
 * browser-direct to Blob in production").
 */
export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const localStorage = getLocalStorage();
  if (!localStorage) {
    return NextResponse.json(
      { error: "Direct uploads go to Blob storage in this deployment." },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const contentItemId = url.searchParams.get("contentItemId") ?? "";
  const originalFilename = url.searchParams.get("filename") ?? "upload";
  const mimeType = request.headers.get("content-type") ?? "application/octet-stream";
  // ?kind=MUSIC uploads a music bed for the finishing editor (audio only, never a take).
  const kind = parseUploadKind(url.searchParams.get("kind"));
  if (!request.body) {
    return NextResponse.json({ error: "Empty upload." }, { status: 400 });
  }
  const item = await prisma.contentItem.findUnique({ where: { id: contentItemId }, select: { id: true } });
  if (!item) {
    return NextResponse.json({ error: "Content item not found." }, { status: 404 });
  }
  if (!uploadMimeAllowed(kind, mimeType)) {
    const error = kind === "MUSIC" ? `Music must be an audio file (this is ${mimeType}).` : `Unsupported file type: ${mimeType}`;
    return NextResponse.json({ error }, { status: 415 });
  }

  const name = safeFilename(originalFilename);
  const storageKey = kind === "MUSIC" ? musicStorageKey(contentItemId, name) : rawTakeStorageKey(contentItemId, name);

  try {
    const asset = await withTempDir(async (dir) => {
      const tempPath = join(dir, name);
      await pipeline(Readable.fromWeb(request.body as never), createWriteStream(tempPath));
      const { size } = await stat(tempPath);
      if (size === 0) throw new Error("Empty upload.");
      await localStorage.putFile(storageKey, tempPath);
      return registerUploadedRawTake({
        contentItemId,
        storageKey,
        originalFilename,
        mimeType,
        sizeBytes: size,
        localPath: tempPath,
        actorId: session.user!.id!,
        kind,
      });
    });
    return NextResponse.json({ mediaAssetId: asset.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
