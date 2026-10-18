import { NextResponse } from "next/server";
import { advanceFilm } from "@chris/agents/studio";
import { auth } from "../../../../../auth";
import { getStudioDeps } from "../../../../../lib/studio/runtime";
import { loadStudioFilmView } from "../../../../../lib/studio/data";

export const maxDuration = 60;

/**
 * Crew room polling. GET = the film's current view. POST = advance the automatic crew a few
 * steps (validation, verification, engine jobs, continuity/quality/meaning-match) until it waits
 * for ChatGPT, Chris or the engine — resumable and idempotent, one worker per film (lease).
 * $0: no model call happens here.
 */

async function guard() {
  const session = await auth();
  return session?.user ? session.user.id! : null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await guard();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const view = await loadStudioFilmView(await getStudioDeps(userId), id);
  if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await guard();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const deps = await getStudioDeps(userId);
  try {
    await advanceFilm(deps, id, { maxSteps: 12 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "advance failed" }, { status: 500 });
  }
  const view = await loadStudioFilmView(deps, id);
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
