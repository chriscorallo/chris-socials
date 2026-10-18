import Link from "next/link";
import { prisma, nextActionFor, queryAll } from "@chris/domain";
import { requireSession } from "../../../lib/session";
import { NavBar } from "../../components/NavBar";
import { PageShell, PageHeader, Panel, Button, EmptyState, StatusPill } from "../../components/ui";
import { VideoCard } from "../../components/VideoCard";
import { RevealActiveChip } from "../../components/RevealActiveChip";
import { runAutopilotBatch } from "../actions";
import { AUTOPILOT_JOB_KIND } from "../../../lib/content-steps";
import { loadVideoCards, sortInProgress, type VideoCardData } from "../../../lib/video-cards";

const LIMIT = 300;

const FILTERS = [
  { key: "progress", label: "In progress" },
  { key: "fix", label: "Needs a fix" },
  { key: "ready", label: "Ready to post" },
  { key: "posted", label: "Posted" },
  { key: "ideas", label: "Ideas" },
  { key: "all", label: "All" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

function matches(card: VideoCardData, key: FilterKey): boolean {
  switch (key) {
    case "progress":
      return card.group === "IN_PROGRESS";
    case "fix":
      return card.next.kind === "FIX";
    case "ready":
      return card.group === "READY";
    case "posted":
      return card.group === "POSTED";
    case "ideas":
      return card.group === "IDEA";
    case "all":
      return card.group !== "HIDDEN";
  }
}

// Videos — every video as a card (thumbnail, plain status, one button for the next step),
// filtered by where it is. Autopilot over several videos is still here, folded away at the
// bottom. See docs/decisions-pending/flow.md.
export default async function VideosPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; stage?: string; batch?: string }>;
}) {
  await requireSession();
  const { show, stage, batch } = await searchParams;

  const [cards, lastBatch] = await queryAll([
    () => loadVideoCards({ limit: LIMIT }),
    () => prisma.jobRun.findFirst({ where: { kind: AUTOPILOT_JOB_KIND }, orderBy: { startedAt: "desc" } }),
  ] as const);
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, cards.filter((c) => matches(c, f.key)).length])) as Record<FilterKey, number>;
  const requested = FILTERS.find((f) => f.key === (show ?? stage))?.key;
  const active: FilterKey = requested ?? (counts.progress > 0 ? "progress" : counts.ready > 0 ? "ready" : "all");
  const shown = cards.filter((c) => matches(c, active));
  const list = active === "progress" ? sortInProgress(shown) : shown;

  const batchItems =
    (lastBatch?.summary as { items?: { contentItemId: string; title: string; finalState: string; stoppedBecause: string }[] } | null)?.items ?? [];
  // Autopilot only makes sense for videos the system can move forward on its own.
  const autopilotable = list.filter((c) => c.group === "IN_PROGRESS" || c.group === "IDEA");

  return (
    <>
      <NavBar />
      <PageShell maxWidth={1040}>
        <PageHeader
          eyebrow="Your videos"
          title="Videos"
          actions={
            <Link href="/upload" className="btn btn-primary !min-h-[40px] !px-4 !text-[14px]">
              + Upload
            </Link>
          }
        />

        <nav
          id="video-filters"
          className="scroll-row relative mb-4 flex gap-2 py-0.5 sm:flex-wrap"
          aria-label="Filter videos"
          style={{ marginLeft: "calc(-1 * var(--gutter))", marginRight: "calc(-1 * var(--gutter))", paddingLeft: "var(--gutter)", paddingRight: "var(--gutter)" }}
        >
          {FILTERS.map((f) => {
            const on = f.key === active;
            return (
              <Link
                key={f.key}
                href={`/content?show=${f.key}`}
                className={`flex min-h-[40px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-4 text-[14px] font-medium transition-colors active:opacity-70 sm:min-h-[36px] sm:text-[13px] ${
                  on
                    ? "border-[var(--color-gold-500)]/50 bg-[var(--color-gold-500)]/15 text-[var(--color-gold-400)]"
                    : "border-[var(--color-border)] bg-white/[0.04] text-[var(--color-text-muted)]"
                }`}
                aria-current={on ? "page" : undefined}
              >
                {f.label}
                <span className={`text-[12px] tabular-nums ${on ? "opacity-90" : "opacity-60"}`}>{counts[f.key]}</span>
              </Link>
            );
          })}
        </nav>
        <RevealActiveChip containerId="video-filters" />

        {list.length === 0 ? (
          <Panel>
            <EmptyState>
              {active === "progress" ? (
                <>Nothing in progress. <Link href="/upload" className="link-quiet underline">Upload a video</Link> to start one.</>
              ) : active === "ideas" ? (
                <>No ideas saved. <Link href="/ideas" className="link-quiet underline">Add one</Link>.</>
              ) : (
                "Nothing here right now."
              )}
            </EmptyState>
          </Panel>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list.map((c) => (
              <VideoCard key={c.id} card={c} />
            ))}
          </ul>
        )}

        {(autopilotable.length > 0 || batch || lastBatch) && (
          <details className="panel mt-8" open={Boolean(batch)}>
            <summary className="flex min-h-[56px] cursor-pointer items-center justify-between gap-3 px-4 py-3 sm:px-6">
              <span>
                <span className="block text-[15px] font-semibold">Autopilot (AI)</span>
                <span className="block text-[13px] text-[var(--color-text-faint)]">Let the AI move several videos forward at once</span>
              </span>
            </summary>
            <div className="px-4 pb-4 sm:px-6 sm:pb-6">
              {(batch || lastBatch) && (
                <div className="mb-4 text-[14px]">
                  <p>
                    <span className="font-medium">Last run: </span>
                    {lastBatch?.status === "RUNNING" || (batch && !lastBatch)
                      ? `running on ${batch ?? "the selected"} video(s) in the background — refresh to see progress.`
                      : `${lastBatch?.status.toLowerCase()} ${lastBatch?.finishedAt ? `at ${lastBatch.finishedAt.toLocaleString()}` : ""}`}
                  </p>
                  {batchItems.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1.5 text-[13px] text-[var(--color-text-muted)]">
                      {batchItems.map((b) => (
                        <li key={b.contentItemId}>
                          <Link href={`/content/${b.contentItemId}`} className="link-quiet underline">{b.title}</Link> — {b.stoppedBecause}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {autopilotable.length > 0 && (
                <form action={runAutopilotBatch} className="flex flex-col gap-3">
                  <input type="hidden" name="stage" value={active} />
                  <ul className="flex flex-col divide-y divide-[var(--color-border)]">
                    {autopilotable.map((c) => (
                      <li key={c.id}>
                        <label className="flex min-h-[48px] cursor-pointer items-center gap-3 py-1.5">
                          <input type="checkbox" name="contentItemId" value={c.id} defaultChecked={!nextActionFor(c.state).needsYou} />
                          <span className="min-w-0 flex-1 truncate text-[14px]">{c.title}</span>
                          <StatusPill state={c.state} />
                        </label>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[12px] text-[var(--color-text-faint)]">
                    Runs in the background, one at a time; each stops when it needs you. Never schedules or posts. Needs AI credit.
                  </p>
                  <div>
                    <Button tone="ghost" pendingLabel="Starting…">Run Autopilot on checked</Button>
                  </div>
                </form>
              )}
            </div>
          </details>
        )}
      </PageShell>
    </>
  );
}
