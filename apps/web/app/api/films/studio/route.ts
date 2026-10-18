import { NextResponse } from "next/server";
import { prisma, getHeavyJob } from "@chris/domain";
import { studioNarrationIndexKey, type StudioNarrationIndex } from "@chris/worker/film-jobs";
import { auth } from "../../../../auth";
import { storage } from "../../../../lib/storage";
import { filmCloudOffer, moveFilmJobToCloud, startFilmJob } from "../../../../lib/film-jobs";

/**
 * The engine side of a studio film page (apps/web/app/studio/[id]/FilmEnginePanel.tsx):
 *   GET  ?filmId=…                       → narrator engine, Chris's narration status, the cloud offer
 *   POST ?filmId=…&action=narration      → body = Chris's recording (one take of the whole script);
 *                                          stored under films/studio/<film>/narration/ and aligned
 *                                          (film-voice-align job: report of unheard/extra words)
 *   POST ?filmId=…&action=cloud          → "Render in the cloud": the waiting render moves to a sandbox
 */
export const maxDuration = 60;
const MAX_BYTES = 4_000_000;

async function readIndex(filmId: string): Promise<(StudioNarrationIndex & { alignJobRunId?: string }) | null> {
  try {
    return JSON.parse((await storage.get(studioNarrationIndexKey(filmId))).toString("utf8"));
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const filmId = new URL(request.url).searchParams.get("filmId") ?? "";
  const film = await prisma.film.findUnique({ where: { id: filmId }, select: { id: true, voiceEngine: true, status: true } });
  if (!film) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const index = await readIndex(filmId);
  const align = index?.alignJobRunId ? await getHeavyJob(prisma, index.alignJobRunId) : null;
  const alignResult = (align?.summary?.result ?? null) as { report?: unknown } | null;
  return NextResponse.json({
    voiceEngine: film.voiceEngine,
    status: film.status,
    narration: index ? { recorded: !!(index.recordingKey || index.shots), aligned: !!index.linesKey, updatedAt: index.updatedAt, job: align ? { status: align.status, message: align.summary?.progress?.message ?? null, error: align.error } : null, report: alignResult?.report ?? null } : null,
    cloud: await filmCloudOffer(filmId).catch(() => null),
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const filmId = url.searchParams.get("filmId") ?? "";
  const action = url.searchParams.get("action");
  const film = await prisma.film.findUnique({ where: { id: filmId }, select: { id: true, currentVersionId: true } });
  if (!film) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (action === "cloud") {
    const offer = await filmCloudOffer(filmId);
    if (!offer?.waitingForMac) return NextResponse.json({ ok: false, message: "The render isn't waiting for your Mac." }, { status: 409 });
    const r = await moveFilmJobToCloud(offer.jobRunId);
    return NextResponse.json(r, { status: r.ok ? 200 : 409 });
  }

  if (action === "narration") {
    const type = request.headers.get("content-type") ?? "";
    if (!/^(audio|video)\//.test(type)) return NextResponse.json({ ok: false, message: "Send an audio recording." }, { status: 415 });
    const body = Buffer.from(await request.arrayBuffer());
    if (body.length < 1000 || body.length > MAX_BYTES) return NextResponse.json({ ok: false, message: body.length > MAX_BYTES ? "That recording is too large (4 MB max — about 4 minutes of voice)." : "The recording is empty." }, { status: 413 });
    const ext = type.includes("mp4") || type.includes("m4a") || type.includes("aac") ? "m4a" : type.includes("webm") ? "webm" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : type.includes("mpeg") ? "mp3" : "m4a";
    const key = `films/studio/${filmId}/narration/${Date.now()}-take.${ext}`;
    await storage.put(key, body, type);
    const version = film.currentVersionId ? await prisma.filmVersion.findUnique({ where: { id: film.currentVersionId }, select: { dsl: true } }) : null;
    const index: StudioNarrationIndex & { alignJobRunId?: string } = { recordingKey: key, updatedAt: new Date().toISOString() };
    if (version?.dsl) {
      const r = await startFilmJob("film-voice-align", { film: version.dsl, recordingKey: key, filmId }, { actorId: session.user.id ?? "chris", where: "auto" }).catch(() => null);
      if (r && "jobRunId" in r && r.jobRunId) index.alignJobRunId = r.jobRunId;
    }
    await storage.put(studioNarrationIndexKey(filmId), Buffer.from(JSON.stringify(index)), "application/json");
    return NextResponse.json({ ok: true, recordingKey: key, alignJobRunId: index.alignJobRunId ?? null });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
