import { notFound } from "next/navigation";
import { requireSession } from "../../../lib/session";
import { getStudioDeps, demoCrewOn } from "../../../lib/studio/runtime";
import { loadStudioFilmView } from "../../../lib/studio/data";
import { NavBar } from "../../components/NavBar";
import { BackLink, PageShell } from "../../components/ui";
import { StudioFilmClient } from "./StudioFilmClient";
import { FilmEnginePanel } from "./FilmEnginePanel";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function StudioFilmPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const view = await loadStudioFilmView(await getStudioDeps(session.user!.id!), id);
  if (!view) notFound();
  return (
    <>
      <NavBar />
      <PageShell maxWidth={720}>
        <BackLink href="/studio">Studio</BackLink>
        <StudioFilmClient initial={view} demo={demoCrewOn()} />
        <FilmEnginePanel filmId={id} />
      </PageShell>
    </>
  );
}
