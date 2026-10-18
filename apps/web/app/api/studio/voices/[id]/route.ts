import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NextResponse } from "next/server";
import { auth } from "../../../../../auth";

/** ▶ samples for the narrator picker: the Kokoro voice audition clips recorded for the proof film
 * (docs/evidence/2026-10-17-mini-movies/voice-audition/*.m4a). 404 when the file isn't deployed. */
const VOICE = /^[a-z]{2}_[a-z]{2,16}$/;

function findAuditionDir(id: string): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    // the engine's curated samples first (packages/cinema/assets/voice-samples), then the first audition
    for (const c of [join(dir, "packages", "cinema", "assets", "voice-samples"), join(dir, "docs", "evidence", "2026-10-17-mini-movies", "voice-audition")]) if (existsSync(join(c, `${id}.m4a`))) return c;
    const p = dirname(dir);
    if (p === dir) break;
    dir = p;
  }
  return null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!VOICE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const dir = findAuditionDir(id);
  const file = dir ? join(dir, `${id}.m4a`) : null;
  if (!file || !existsSync(file)) return NextResponse.json({ error: "No sample" }, { status: 404 });
  return new NextResponse(readFileSync(file), { headers: { "Content-Type": "audio/mp4", "Cache-Control": "private, max-age=86400" } });
}
