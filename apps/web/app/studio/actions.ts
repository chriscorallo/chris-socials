"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@chris/domain";
import {
  approveStoryboard,
  confirmClaims,
  demoAnswerFor,
  editLine,
  PrismaFilmStore,
  redoShots,
  requestFinalCheck,
  resumeFilm,
  sendFilmToVideos,
  skipFinalCheck,
  startFilm,
  submitPackAnswer,
  DEFAULT_FILM_LIMITS,
  type SubmitResult,
} from "@chris/agents/studio";
import { requireSession } from "../../lib/session";
import { demoCrewOn, getStudioDeps, localAiStatus } from "../../lib/studio/runtime";
import { attachStudioRender } from "../../lib/film-jobs";

/**
 * Mini-movie Studio actions. No model is ever called from here: creative steps are Chris's
 * ChatGPT round trips (or the optional free local model); everything else is code + our engine.
 * See docs/decisions-pending/studio-crew.md.
 */

async function actor() {
  const s = await requireSession();
  return s.user!.id!;
}

export async function createFilmAction(form: FormData): Promise<void> {
  const actorId = await actor();
  const deps = await getStudioDeps(actorId);
  const sourceId = String(form.get("sourceContentItemId") ?? "") || null;
  let idea = String(form.get("idea") ?? "").trim();
  // A working title until the Director names the film: the idea's first clause, cut at a word.
  const firstClause = idea.split(/[.?!\n]| — | - /)[0]!.trim();
  let title = (firstClause.length > 48 ? `${firstClause.slice(0, 48).replace(/\s+\S*$/, "")}…` : firstClause) || "New mini-movie";
  if (sourceId) {
    const item = await prisma.contentItem.findUnique({ where: { id: sourceId }, select: { title: true, description: true } });
    if (item) {
      title = item.title.slice(0, 80);
      idea = idea || `${item.title}${item.description ? ` — ${item.description}` : ""}`;
    }
  }
  if (!idea) redirect("/studio?error=idea");
  const seconds = Math.min(60, Math.max(30, Number(form.get("seconds") ?? 45) || 45));
  const voiceId = String(form.get("voice") ?? "am_michael");
  const local = await localAiStatus();
  const film = await startFilm(deps, {
    title,
    idea: idea.slice(0, 4000),
    targetSeconds: seconds,
    look: String(form.get("look") ?? "GOLD_STUDIO") === "NOIR_NUMBERS" ? "NOIR_NUMBERS" : "GOLD_STUDIO",
    voiceId: voiceId === "chris" ? "chris" : voiceId,
    voiceEngine: voiceId === "chris" ? "CHRIS" : "KOKORO",
    aiMode: local.on && form.get("aiMode") === "LOCAL" ? "LOCAL" : "CHATGPT",
    createdBy: actorId,
    sourceContentItemId: sourceId,
    limits: DEFAULT_FILM_LIMITS,
  });
  revalidatePath("/studio");
  redirect(`/studio/${film.id}`);
}

export async function submitAnswerAction(filmId: string, text: string): Promise<SubmitResult> {
  const actorId = await actor();
  const r = await submitPackAnswer(await getStudioDeps(actorId), filmId, text, actorId);
  revalidatePath(`/studio/${filmId}`);
  return r;
}

type Simple = { ok: true } | { ok: false; message: string };
const wrap = async (filmId: string, fn: () => Promise<{ ok: boolean; message?: string }>): Promise<Simple> => {
  try {
    const r = await fn();
    revalidatePath(`/studio/${filmId}`);
    return r.ok ? { ok: true } : { ok: false, message: r.message ?? "That didn't work." };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "That didn't work." };
  }
};

export async function approveAction(filmId: string): Promise<Simple> {
  const a = await actor();
  return wrap(filmId, async () => approveStoryboard(await getStudioDeps(a), filmId, a));
}

export async function confirmFactsAction(filmId: string, keys: string[]): Promise<Simple> {
  const a = await actor();
  return wrap(filmId, async () => confirmClaims(await getStudioDeps(a), filmId, keys, a));
}

export async function redoShotAction(filmId: string, shotId: string, note: string): Promise<Simple> {
  const a = await actor();
  return wrap(filmId, async () => redoShots(await getStudioDeps(a), filmId, [shotId], note.slice(0, 600), a));
}

export async function editLineAction(filmId: string, shotId: string, text: string): Promise<Simple> {
  const a = await actor();
  return wrap(filmId, async () => editLine(await getStudioDeps(a), filmId, shotId, text, a));
}

export async function finalCheckAction(filmId: string): Promise<Simple> {
  const a = await actor();
  return wrap(filmId, async () => requestFinalCheck(await getStudioDeps(a), filmId));
}

export async function skipFinalCheckAction(filmId: string): Promise<Simple> {
  const a = await actor();
  return wrap(filmId, async () => skipFinalCheck(await getStudioDeps(a), filmId));
}

export async function resumeAction(filmId: string): Promise<Simple> {
  const a = await actor();
  return wrap(filmId, async () => resumeFilm(await getStudioDeps(a), filmId));
}

export async function sendToVideosAction(filmId: string): Promise<{ ok: true; contentItemId: string } | { ok: false; message: string }> {
  const a = await actor();
  try {
    const r = await sendFilmToVideos(prisma, new PrismaFilmStore(prisma), filmId, a);
    // the engine attaches the finished render to that video (take → no-cuts edit → render; never re-renders)
    await attachStudioRender(filmId, r.contentItemId, a).catch((err) => console.error(JSON.stringify({ level: "warn", event: "studio_attach_render_failed", filmId, message: err instanceof Error ? err.message : String(err) })));
    revalidatePath(`/studio/${filmId}`);
    revalidatePath("/content");
    return { ok: true, contentItemId: r.contentItemId };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Couldn't send it to Videos." };
  }
}

/** DEV ONLY (STUDIO_DEMO_CREW=1, never on Vercel): the recorded-shape answer a good ChatGPT reply looks like. */
export async function demoAnswerAction(filmId: string): Promise<string | null> {
  const a = await actor();
  if (!demoCrewOn()) return null;
  const deps = await getStudioDeps(a);
  const film = await deps.store.getFilm(filmId);
  if (!film?.pending) return null;
  const cur = film.currentVersionId ? (await deps.store.getVersion(film.currentVersionId))?.film : null;
  return demoAnswerFor(film.pending.kind, cur ?? null);
}
