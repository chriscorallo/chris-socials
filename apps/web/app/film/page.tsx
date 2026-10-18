import Link from "next/link";
import { prisma } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel, SectionHeading, Button, EmptyState } from "../components/ui";
import { markFilmed } from "./actions";
import { TeleprompterLink } from "../components/TeleprompterLink";
import { DraftBadge } from "../components/VideoCard";
import { listPrompterDraftPicks, listPrompterPicks } from "../../lib/teleprompter/data";
import { APP_TZ } from "../../lib/calendar-data";

const SETUP_LABELS: Record<string, string> = {
  DESK: "Desk",
  STANDING: "Standing",
  CASUAL: "Casual",
  WALKING: "Walking",
  SKIT: "Skit",
  SPECIAL: "Special",
};

/**
 * Film Queue — spec §9 step 9: "batch by setup; no research during filming." Everything at
 * READY_TO_FILM, grouped by Creator Card setup so one lighting/location change covers a whole
 * batch, each with only what Chris needs on set (hook, talking points, notes). Checking items
 * off and submitting marks them FILMED in one go; uploads follow on each item's page (or the
 * FILMED list below).
 */
export default async function FilmQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ filmed?: string; error?: string }>;
}) {
  await requireSession();
  const { filmed, error } = await searchParams;

  const ready = await prisma.contentItem.findMany({
    where: { currentState: "READY_TO_FILM" },
    include: { creatorCard: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const awaitingUpload = await prisma.contentItem.findMany({
    where: { currentState: "FILMED" },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });

  const drafts = await listPrompterDraftPicks(prisma);
  const draftIds = new Set(drafts.map((d) => d.id));
  // Planned videos from the imported plan aren't READY_TO_FILM (no fact-checked script yet), but
  // they're exactly what Chris films next — list the soonest ones so this page is never "empty"
  // while 120 videos are waiting.
  const readyIds = new Set(ready.map((r) => r.id));
  const nextUp = (await listPrompterPicks(prisma, APP_TZ, 40)).filter((p) => p.ymd && !readyIds.has(p.id) && !draftIds.has(p.id)).slice(0, 12);
  const groups = new Map<string, typeof ready>();
  for (const item of ready) {
    const setup = item.creatorCard?.setup ?? "UNSPECIFIED";
    groups.set(setup, [...(groups.get(setup) ?? []), item]);
  }
  const orderedSetups = [...groups.keys()].sort((a, b) => (groups.get(b)!.length - groups.get(a)!.length));
  const totalMinutes = ready.reduce((sum, i) => sum + (i.creatorCard?.estimatedMinutes ?? 0), 0);

  return (
    <>
      <NavBar />
      <PageShell>
        <PageHeader
          eyebrow="Ready to shoot"
          title="Film"
          description={
            ready.length === 0
              ? nextUp.length
                ? "Next up from your plan — film with the teleprompter or upload what you filmed."
                : "Nothing waiting to be filmed."
              : `${ready.length} to film across ${groups.size} setup${groups.size === 1 ? "" : "s"}${totalMinutes ? ` · ~${totalMinutes} min estimated` : ""}.`
          }
        />

        <div className="mb-5">
          <Link href="/film/teleprompter?from=film" className="btn btn-primary w-full !min-h-[52px] gap-2 !text-[16px] sm:w-auto" data-testid="film-teleprompter-cta">
            Film with teleprompter
          </Link>
        </div>

        {drafts.length > 0 && (
          <Panel className="mb-5 !border-[var(--color-gold-500)]/45">
            <SectionHeading eyebrow={`${drafts.length} draft${drafts.length === 1 ? "" : "s"}`} title="Finish filming" />
            <ul className="-mx-2 flex flex-col" data-testid="film-drafts">
              {drafts.map((d) => (
                <li key={d.id}>
                  <Link href={`/film/teleprompter?id=${d.id}&from=film`} className="flex min-h-[56px] items-center justify-between gap-3 rounded-lg px-2 py-2 active:bg-white/[0.05]">
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <DraftBadge />
                        <span className="truncate text-[15px] font-medium">{d.title}</span>
                      </span>
                      <span className="mt-0.5 block text-[12.5px] text-[var(--color-text-faint)]">{d.label}</span>
                    </span>
                    <span className="shrink-0 text-[13px] font-medium text-[var(--color-gold-400)]">Continue ›</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {nextUp.length > 0 && (
          <Panel className="mb-5">
            <SectionHeading eyebrow={`${nextUp.length} coming up`} title="Next up from your plan" />
            <ul className="-mx-2 flex flex-col divide-y divide-[var(--color-border)]" data-testid="film-next-up">
              {nextUp.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link href={`/content/${p.id}`} className="line-clamp-2 text-[15px] font-medium leading-snug active:opacity-60">
                      {p.title}
                    </Link>
                    <p className="mt-0.5 text-[12.5px] text-[var(--color-text-faint)]">
                      {p.when}
                      {p.hasScript ? " · script ready" : " · no script yet"}
                    </p>
                  </div>
                  <Link href={`/film/teleprompter?id=${p.id}&from=film`} className="btn btn-primary shrink-0 !min-h-[44px] !px-3 !text-[13.5px]">
                    Film
                  </Link>
                  <Link href={`/content/${p.id}`} className="btn btn-ghost shrink-0 !min-h-[44px] !px-3 !text-[13.5px]">
                    Upload
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {filmed && <p className="mb-4 text-[15px] text-[var(--color-emerald-400)] sm:text-sm">Marked {filmed} as filmed — upload the footage below.</p>}
        {error && <p className="mb-4 text-sm text-[var(--color-rose-400)]">{error}</p>}

        <div className="flex flex-col gap-5">
          {orderedSetups.map((setup) => {
            const items = groups.get(setup)!;
            return (
              <Panel key={setup}>
                <form action={markFilmed} className="flex flex-col gap-4">
                  <SectionHeading eyebrow={`${items.length} video${items.length === 1 ? "" : "s"}`} title={SETUP_LABELS[setup] ?? "No setup chosen"} />
                  <ul className="-mx-1 flex flex-col divide-y divide-[var(--color-border)]">
                    {items.map((item) => (
                      <li key={item.id} className="flex gap-1 py-3 first:pt-0 last:pb-0">
                        {/* Whole left column is the checkbox's tap target. */}
                        <label className="flex w-11 shrink-0 cursor-pointer justify-center pt-0.5">
                          <input type="checkbox" name="contentItemId" value={item.id} aria-label={`Filmed: ${item.title}`} />
                        </label>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <Link href={`/content/${item.id}`} className="min-w-0 text-[16px] font-semibold leading-snug hover:underline sm:text-sm">
                              {item.title}
                            </Link>
                            <TeleprompterLink id={item.id} variant="icon" from="film" />
                          </div>
                          {item.creatorCard ? (
                            <>
                              <p className="mt-1.5 text-[15px] leading-snug sm:text-[13px]"><span className="text-[var(--color-text-faint)]">Hook: </span>{item.creatorCard.hook}</p>
                              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[14px] text-[var(--color-text-muted)] sm:text-[13px]">
                                {(item.creatorCard.talkingPoints as string[]).map((p, i) => (
                                  <li key={i}>{p}</li>
                                ))}
                              </ul>
                              {item.creatorCard.notes && <p className="mt-1 text-[12px] text-[var(--color-text-faint)]">{item.creatorCard.notes}</p>}
                            </>
                          ) : (
                            <p className="mt-1 text-[13px] text-[var(--color-text-faint)]">No shot notes yet.</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div>
                    <Button tone="primary" className="w-full sm:w-auto" pendingLabel="Saving…">Mark checked as filmed</Button>
                  </div>
                </form>
              </Panel>
            );
          })}

          {ready.length === 0 && (
            <Panel>
              <EmptyState>Nothing is ready to film yet. A video shows up here once its script and shot notes are done.</EmptyState>
            </Panel>
          )}

          <Panel>
            <SectionHeading eyebrow={`${awaitingUpload.length} video${awaitingUpload.length === 1 ? "" : "s"}`} title="Filmed — upload footage" />
            {awaitingUpload.length === 0 ? (
              <EmptyState>Nothing waiting for upload.</EmptyState>
            ) : (
              <ul className="-mx-2 flex flex-col">
                {awaitingUpload.filter((item) => !draftIds.has(item.id)).map((item) => (
                  <li key={item.id}>
                    <Link
                      href={`/content/${item.id}#upload`}
                      className="flex min-h-[48px] items-center justify-between gap-3 rounded-lg px-2 text-[15px] active:bg-white/[0.05] sm:text-sm"
                    >
                      <span className="min-w-0">{item.title}</span>
                      <span className="shrink-0 text-[13px] font-medium text-[var(--color-gold-400)]">Upload ›</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </PageShell>
    </>
  );
}
