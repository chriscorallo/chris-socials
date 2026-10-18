import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { auth } from "../../../../auth";
import { storage, getLocalStorage } from "../../../../lib/storage";

/**
 * Mini-movie files (storyboard stills, contact sheets, posters, review frames, rendered films):
 * `/api/films/file?key=films/…` — signed-in only, and only keys under `films/` (the engine's own
 * prefix; never a take, a render of Chris's footage or an arbitrary path). Blob mode: a 10-minute
 * presigned redirect; local mode: streamed with Range support (the <video> element can seek).
 */
const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", mp4: "video/mp4", wav: "audio/wav", m4a: "audio/mp4", json: "application/json" };

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!/^films\/[A-Za-z0-9._\-/]+$/.test(key) || key.includes("..")) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ext = (key.split(".").pop() ?? "").toLowerCase();
  const contentType = TYPES[ext];
  if (!contentType || ext === "json") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const local = getLocalStorage();
  if (!local) return NextResponse.redirect(await storage.signedUrl(key, 600), 302);
  const filePath = local.pathFor(key);
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const headers: Record<string, string> = { "Content-Type": contentType, "Cache-Control": "private, max-age=3600", "Accept-Ranges": "bytes" };
  const range = request.headers.get("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
    return new NextResponse(stream, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new NextResponse(stream, { headers: { ...headers, "Content-Length": String(size) } });
}
