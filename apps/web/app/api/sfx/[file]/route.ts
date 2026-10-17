import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SFX_SOUNDS } from "@chris/media/timeline";
import { auth } from "../../../../auth";

/**
 * Serves the procedural SFX kit (packages/motion/assets/sfx — original, license-free WAVs) to
 * the finishing editor: sound-picker previews and the preview mix. Whitelisted by the
 * contract's SFX_SOUNDS (`<sound>.wav`, lower case) — never an arbitrary path — and
 * auth-protected like /api/fonts and /api/media. Directory lookup mirrors @chris/motion's own
 * resolveSfxDir (MOTION_SFX_DIR, else a walk up from the app's cwd) without importing the
 * motion package's Node entry (which pulls in Remotion's renderer).
 */
const FILES = new Set(SFX_SOUNDS.map((s) => `${s.toLowerCase()}.wav`));

function sfxDir(): string | null {
  if (process.env.MOTION_SFX_DIR) return process.env.MOTION_SFX_DIR;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const c = join(dir, "packages", "motion", "assets", "sfx");
    if (existsSync(join(c, "whoosh.wav"))) return c;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { file } = await params;
  if (!FILES.has(file)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const dir = sfxDir();
  let bytes: Buffer;
  try {
    if (!dir) throw new Error("missing");
    bytes = await readFile(join(dir, file));
  } catch {
    return NextResponse.json({ error: "Sound file missing on this server" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(bytes.length),
      "Accept-Ranges": "none",
      // Generated once, immutable per name; private because the route is behind auth.
      "Cache-Control": "private, max-age=86400",
    },
  });
}
