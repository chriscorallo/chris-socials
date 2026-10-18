import { prisma, getAiSpendOverview } from "@chris/domain";
import type { StudioDeps, StudioFilm, FilmRecord } from "@chris/agents/studio";
import { PrismaFilmStore } from "@chris/agents/studio";
import { buildStudioFilmView, type StudioFilmView } from "./view";

/** SERVER-ONLY loaders for the studio pages (sequential reads — PGlite). */

export async function loadStudioFilmView(deps: StudioDeps, id: string): Promise<StudioFilmView | null> {
  const film = await deps.store.getFilm(id);
  if (!film) return null;
  const versions = await deps.store.listVersions(id);
  const arts = await deps.store.listArtifacts(id);
  const cur = versions.find((v) => v.id === film.currentVersionId);
  const v = cur ? deps.engine.validateFilm(cur.film) : null;
  return buildStudioFilmView(film, versions, arts, v?.ok ? (v.film as StudioFilm) : null);
}

export async function listStudioFilms(): Promise<FilmRecord[]> {
  return new PrismaFilmStore(prisma).listFilms(30);
}

/** Ideas Chris can start from: planned videos still in planning (most recent first). */
export async function listIdeaSources(): Promise<Array<{ id: string; title: string; description: string | null }>> {
  const items = await prisma.contentItem.findMany({
    where: { currentState: { in: ["IDEA", "SELECTED", "CONTRACTED", "RESEARCHED", "SCRIPTING", "SCRIPTED"] } },
    orderBy: { updatedAt: "desc" },
    take: 25,
    select: { id: true, title: true, description: true },
  });
  return items;
}

/** The paid AI's state is irrelevant to the studio ($0) — shown only so Chris knows nothing here uses it. */
export async function paidAiTodayUsd(): Promise<number> {
  return (await getAiSpendOverview(prisma, new Date()).catch(() => null))?.todayUsd ?? 0;
}
