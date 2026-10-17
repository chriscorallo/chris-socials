import Link from "next/link";
import { prisma } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel, SectionHeading, Button, EmptyState } from "../components/ui";
import { markFilmed } from "./actions";

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
          eyebrow="Production"
          title="Film Queue"
          description={
            ready.length === 0
              ? "Nothing waiting to be filmed."
              : `${ready.length} to film across ${groups.size} setup${groups.size === 1 ? "" : "s"}${totalMinutes ? ` · ~${totalMinutes} min estimated` : ""}.`
          }
        />

        {filmed && <p className="mb-4 text-[15px] text-[var(--color-emerald-400)] sm:text-sm">Marked {filmed} as filmed — upload the takes below.</p>}
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
                          <Link href={`/content/${item.id}`} className="text-[16px] font-semibold leading-snug hover:underline sm:text-sm">
                            {item.title}
                          </Link>
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
                            <p className="mt-1 text-[13px] text-[var(--color-text-faint)]">No Creator Card yet.</p>
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
              <EmptyState>Nothing at READY_TO_FILM. Scripts become filmable once their Creator Card is issued.</EmptyState>
            </Panel>
          )}

          <Panel>
            <SectionHeading eyebrow={`${awaitingUpload.length} video${awaitingUpload.length === 1 ? "" : "s"}`} title="Filmed — waiting for upload" />
            {awaitingUpload.length === 0 ? (
              <EmptyState>Nothing waiting for upload.</EmptyState>
            ) : (
              <ul className="-mx-2 flex flex-col">
                {awaitingUpload.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={`/content/${item.id}#media`}
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
