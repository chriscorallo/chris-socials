import Link from "next/link";
import { studioStatusLabel } from "@chris/agents/studio";
import { requireSession } from "../../lib/session";
import { listIdeaSources, listStudioFilms } from "../../lib/studio/data";
import { localAiStatus } from "../../lib/studio/runtime";
import { STUDIO_VOICES } from "../../lib/studio/cinema-engine";
import { NavBar } from "../components/NavBar";
import { PageHeader, PageShell, Panel } from "../components/ui";
import { NewFilmForm } from "./NewFilmForm";

export const dynamic = "force-dynamic";

/**
 * Mini-movie Studio — an idea in, a premium animated short out. A crew of specialist bots (most
 * run automatically as code; the creative ones run as two copy-paste rounds with Chris's own
 * ChatGPT) writes, storyboards, checks and renders it. $0. See docs/decisions-pending/studio-crew.md.
 */
export default async function StudioPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireSession();
  const sp = await searchParams;
  const films = await listStudioFilms();
  const ideas = await listIdeaSources();
  const local = await localAiStatus();
  return (
    <>
      <NavBar />
      <PageShell maxWidth={680}>
        <PageHeader eyebrow="Studio" title="Mini-movie studio" description="Type an idea. Your crew writes it, storyboards it, checks every number and every picture, and renders a 30–60 s animated short. Costs $0 — it uses your ChatGPT for the creative calls." />
        {sp.error === "idea" && <p className="mb-3 rounded-xl bg-[color-mix(in_srgb,var(--color-rose-500)_14%,transparent)] px-3 py-2 text-[14px] text-[var(--color-rose-400)]">Type an idea (or pick one of your planned videos) first.</p>}
        <Panel>
          <NewFilmForm ideas={ideas} voices={STUDIO_VOICES} localAi={local.on} />
        </Panel>

        <h2 className="mb-2 mt-7 text-[17px] font-semibold">Your films</h2>
        {films.length === 0 ? (
          <p className="text-[15px] text-[var(--color-text-muted)]">No films yet — your first one starts above.</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="film-list">
            {films.map((f) => (
              <li key={f.id}>
                <Link href={`/studio/${f.id}`} className="panel flex min-h-[64px] items-center justify-between gap-3 px-4 py-3 active:opacity-70">
                  <div className="min-w-0">
                    <p className="truncate text-[16px] font-semibold">{f.title}</p>
                    <p className="truncate text-[13px] text-[var(--color-text-faint)]">
                      Round {f.iteration} · {f.counters.roundTrips} ChatGPT round{f.counters.roundTrips === 1 ? "" : "s"} · $0
                    </p>
                  </div>
                  <span className={`badge ${f.status === "READY" ? "badge-emerald" : f.status === "BLOCKED" || f.status === "FAILED" ? "badge-rose" : f.status === "NEEDS_CHATGPT" || f.status === "NEEDS_CHRIS" ? "badge-gold" : "badge-violet"} !text-[12px] !normal-case !tracking-normal`}>{studioStatusLabel(f)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageShell>
    </>
  );
}
