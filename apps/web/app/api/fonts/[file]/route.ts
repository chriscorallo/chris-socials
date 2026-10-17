import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBundledFontsDir } from "@chris/media";
import { FONT_REGISTRY } from "@chris/media/font-registry";
import { auth } from "../../../../auth";

/**
 * Serves the renderer's own font files to the finishing editor's preview (@font-face), so the
 * preview draws text with exactly the glyphs the render will burn in. Whitelisted by
 * FONT_REGISTRY — only a registered `file` is ever read, never an arbitrary path — and
 * resolved with the same directory lookup the renderer uses. Auth-protected like /api/media.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { file } = await params;
  const font = FONT_REGISTRY.find((f) => f.file === file);
  if (!font) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(join(resolveBundledFontsDir(), font.file));
  } catch {
    return NextResponse.json({ error: "Font file missing on this server" }, { status: 404 });
  }
  const type = font.file.endsWith(".woff2") ? "font/woff2" : font.file.endsWith(".otf") ? "font/otf" : "font/ttf";
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.length),
      // Font files are immutable per name; private because the route is behind auth.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
