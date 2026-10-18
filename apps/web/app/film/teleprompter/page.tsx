import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { storageMode } from "../../../lib/storage";
import { APP_TZ } from "../../../lib/calendar-data";
import { listPrompterDraftPicks, listPrompterPicks, loadPrompterDraft, loadPrompterVideo } from "../../../lib/teleprompter/data";
import { pickPrompterSource } from "../../../lib/teleprompter/script-source";
import { NavBar } from "../../components/NavBar";
import { BackLink, PageHeader, PageShell, Panel } from "../../components/ui";
import { Teleprompter } from "./Teleprompter";

export const maxDuration = 300;
export const metadata = { title: "Teleprompter" };

/**
 * Film with teleprompter. `?id=<video>` opens the prompter for that video (script from its
 * latest script version → shot notes → plan hook/notes → paste box); `?new=1` is a brand-new
 * video; neither shows "Which video are you filming?". Read-only until a take is used — see
 * docs/decisions-pending/teleprompter.md.
 */
export default async function TeleprompterPage({ searchParams }: { searchParams: Promise<{ id?: string; new?: string; from?: string }> }) {
  await requireSession();
  const sp = await searchParams;
  const back = sp.from === "plan" ? { href: "/plan", label: "Plan" } : sp.from === "film" ? { href: "/film", label: "Film" } : null;

  if (sp.id) {
    const video = await loadPrompterVideo(prisma, sp.id);
    if (!video) notFound();
    const draft = await loadPrompterDraft(prisma, video.id);
    return (
      <>
        <NavBar />
        <PageShell maxWidth={640}>
          <BackLink href={back?.href ?? `/content/${video.id}`}>{back?.label ?? "Video"}</BackLink>
          <PageHeader eyebrow="Teleprompter" title={video.title} />
          {video.canFilm ? (
            <Teleprompter video={{ id: video.id, title: video.title }} source={video.source} mode={storageMode} draft={draft} />
          ) : (
            <Panel>
              <p className="text-[15px]">This video can&apos;t take new footage right now ({video.state === "CANCELLED" ? "it was cancelled" : "it's past the filming step"}).</p>
              <Link href="/film/teleprompter?new=1" className="btn btn-primary mt-4 w-full">
                Film a new video instead
              </Link>
            </Panel>
          )}
        </PageShell>
      </>
    );
  }

  if (sp.new) {
    return (
      <>
        <NavBar />
        <PageShell maxWidth={640}>
          <BackLink href="/film/teleprompter">Pick a video</BackLink>
          <PageHeader eyebrow="Teleprompter" title="New video" />
          <Teleprompter video={null} source={pickPrompterSource({})} mode={storageMode} />
        </PageShell>
      </>
    );
  }

  const [allPicks, drafts] = await Promise.all([listPrompterPicks(prisma, APP_TZ), listPrompterDraftPicks(prisma)]);
  const draftIds = new Set(drafts.map((d) => d.id));
  const picks = allPicks.filter((p) => !draftIds.has(p.id));
  return (
    <>
      <NavBar />
      <PageShell maxWidth={640}>
        {back && <BackLink href={back.href}>{back.label}</BackLink>}
        <PageHeader eyebrow="Teleprompter" title="What are you filming?" description="Pick a video and its script is ready to read." />
        {drafts.length > 0 && (
          <ul className="panel mb-4 divide-y divide-[var(--color-border)] !border-[var(--color-gold-500)]/45" data-testid="tp-drafts">
            {drafts.map((d) => (
              <li key={d.id}>
                <Link href={`/film/teleprompter?id=${d.id}`} className="flex min-h-[64px] items-center gap-3 px-4 py-3 active:bg-white/[0.05]">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-semibold uppercase tracking-wide text-[var(--color-gold-400)]">Continue · Draft</span>
                    <span className="line-clamp-2 block text-[15.5px] font-medium leading-snug">{d.title}</span>
                    <span className="mt-0.5 block truncate text-[12.5px] text-[var(--color-text-faint)]">{d.label}</span>
                  </span>
                  <span className="shrink-0 text-[13px] font-medium text-[var(--color-gold-400)]">Continue ›</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Link href="/film/teleprompter?new=1" className="btn btn-primary mb-4 w-full !min-h-[52px]" data-testid="tp-new">
          New video (type or paste a script)
        </Link>
        {picks.length === 0 ? (
          <Panel>
            <p className="text-[15px] text-[var(--color-text-muted)]">
              Nothing planned to film right now. <Link href="/plan/import" className="link-quiet">Import your plan</Link> or start a new video above.
            </p>
          </Panel>
        ) : (
          <ul className="panel divide-y divide-[var(--color-border)]" data-testid="tp-picks">
            {picks.map((p) => (
              <li key={p.id}>
                <Link href={`/film/teleprompter?id=${p.id}`} className="flex min-h-[60px] items-center gap-3 px-4 py-3 active:bg-white/[0.05]">
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 block text-[15.5px] font-medium leading-snug">{p.title}</span>
                    <span className="mt-0.5 block truncate text-[12.5px] text-[var(--color-text-faint)]">
                      {[p.when, p.hasScript ? "Script ready" : p.hook ? `“${p.hook}”` : "No script yet"].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 text-[13px] font-medium text-[var(--color-gold-400)]">Film ›</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageShell>
    </>
  );
}
