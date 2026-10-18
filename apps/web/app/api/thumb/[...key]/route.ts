import { NextResponse } from "next/server";
import { auth } from "../../../../auth";
import { findMediaOwner } from "../../../../lib/media-owner";
import { generatePoster, getStoredPoster } from "../../../../lib/poster";

/**
 * Authenticated poster frame (small JPEG) for any key /api/media would serve — what video
 * lists show instead of loading the video file itself. See lib/poster.ts.
 *
 * `private` + immutable: storage keys never change content, so the browser keeps the image
 * and never asks again; nothing is cacheable by a shared cache. If a poster can't be made
 * (ffmpeg missing/failed), a transparent pixel is returned with a short cache so the card's
 * own gradient placeholder shows and a later visit retries — never a broken-image icon.
 */
const TRANSPARENT_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export async function GET(_request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { key: keySegments } = await params;
  // Same key handling as /api/media (Next hands over decoded segments).
  const storageKey = keySegments.join("/");
  // The stored-poster fast path reads storage before the ownership check — never let a key
  // walk out of the posters/ prefix.
  if (keySegments.some((s) => s === ".." || s === "." || s === "")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const jpegResponse = (jpeg: Buffer) =>
    new NextResponse(new Uint8Array(jpeg), {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(jpeg.length),
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });

  try {
    // Already generated → it was verified then; no database round trip needed.
    const stored = await getStoredPoster(storageKey);
    if (stored) return jpegResponse(stored);

    // First request for this key: only keys that belong to a real row get a poster.
    const owner = await findMediaOwner(storageKey);
    if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return jpegResponse(await generatePoster(storageKey));
  } catch (e) {
    console.warn("[thumb] poster unavailable", storageKey, e instanceof Error ? e.message : e);
    return new NextResponse(new Uint8Array(TRANSPARENT_GIF), {
      headers: { "Content-Type": "image/gif", "Cache-Control": "private, max-age=300" },
    });
  }
}
