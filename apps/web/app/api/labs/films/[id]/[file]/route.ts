import { NextResponse } from "next/server";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { auth } from "../../../../../../auth";
import { labsFilmPath } from "../../../../../../lib/labs-films";

/**
 * Streams a rendered mini-movie proof film (labs). Auth-protected; whitelisted names only;
 * supports Range requests so the <video> player can seek (iOS Safari requires it).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, file } = await params;
  const path = labsFilmPath(id, file);
  if (!path) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const size = statSync(path).size;
  const range = request.headers.get("range");
  const m = range?.match(/bytes=(\d*)-(\d*)/);
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    if (start >= size || start > end) return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return new NextResponse(body, { status: 206, headers: { "Content-Type": "video/mp4", "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" } });
  }
  const body = Readable.toWeb(createReadStream(path)) as ReadableStream;
  return new NextResponse(body, { headers: { "Content-Type": "video/mp4", "Content-Length": String(size), "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" } });
}
