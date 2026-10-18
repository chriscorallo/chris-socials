import { requireSession } from "../../../lib/session";
import { listLabsFilms } from "../../../lib/labs-films";
import { NavBar } from "../../components/NavBar";
import { PageShell, PageHeader, Panel } from "../../components/ui";

// Labs — hidden (not in the nav). Proof films from the mini-movie engine (@chris/cinema) so Chris
// can judge the quality before a full studio is built. See docs/decisions-pending/mini-movies.md.
export const dynamic = "force-dynamic";

export default async function MiniMoviesLabsPage() {
  await requireSession();
  const films = listLabsFilms();
  return (
    <>
      <NavBar />
      <PageShell maxWidth={640}>
        <PageHeader eyebrow="Labs" title="Mini-movies (preview)" description="Animated, faceless shorts made entirely by our own code — no paid AI video. Judge the look; nothing here is published." />
        {films.length === 0 ? (
          <Panel>
            <p className="text-[15px] text-[var(--color-text-muted)]">No films rendered on this server yet. Render one with <code>pnpm --filter @chris/cinema exec tsx scripts/make-film.ts --tier FINAL</code>.</p>
          </Panel>
        ) : (
          films.map((f) => (
            <Panel key={`${f.id}/${f.file}`} className="mb-4">
              <video src={`/api/labs/films/${f.id}/${f.file}`} controls playsInline preload="metadata" className="w-full rounded-xl bg-black" style={{ aspectRatio: "9 / 16" }} />
              <div className="mt-3 flex items-baseline justify-between gap-3">
                <p className="text-[16px] font-semibold">{f.id}</p>
                <p className="text-[13px] text-[var(--color-text-faint)]">
                  {f.tier.toLowerCase()} · {f.durationSeconds ? `${f.durationSeconds.toFixed(1)} s` : "—"} · {(f.sizeBytes / 1e6).toFixed(1)} MB{f.loudnessLufs !== null ? ` · ${f.loudnessLufs.toFixed(1)} LUFS` : ""}
                </p>
              </div>
            </Panel>
          ))
        )}
      </PageShell>
    </>
  );
}
