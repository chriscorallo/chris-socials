import Link from "next/link";
import { prisma, listContentItems, countContentItems, listAudienceInsights, countAudienceInsights } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel, SectionHeading, Badge, EmptyState, Button, contentStateTone, stateLabel } from "../components/ui";
import { runAudienceIntelligence } from "./actions";

// Server Actions on this page run model calls / ffmpeg synchronously — allow up to the
// Vercel Fluid Compute ceiling instead of the platform default. See /docs/DECISIONS.md.
export const maxDuration = 300;

const LIMIT = 40;
const MEASURED_STATES = ["PUBLISHED", "MEASURING", "ARCHIVED"] as const;

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ audienceError?: string }>;
}) {
  await requireSession();
  const { audienceError } = await searchParams;

  // Capped like every other list page — see /docs/DECISIONS.md's list-page bounding entry.
  const items = await listContentItems(prisma, { state: [...MEASURED_STATES], limit: LIMIT });
  const totalMeasured = await countContentItems(prisma, { state: [...MEASURED_STATES] });
  // Scoped to the (already capped) items actually rendered below, not every content item ever
  // measured — same list-page bounding discipline as everything else on this page.
  const snapshotCounts = await prisma.performanceSnapshot.groupBy({
    by: ["contentItemId"],
    where: { contentItemId: { in: items.map((i) => i.id) } },
    _count: { id: true },
  });
  const snapshotCountByItem = new Map(snapshotCounts.map((s) => [s.contentItemId, s._count.id]));
  const insights = await listAudienceInsights(prisma, { limit: 15 });
  const insightsTotal = await countAudienceInsights(prisma);

  return (
    <>
      <NavBar />
      <PageShell>
        <PageHeader
          eyebrow="Learning"
          title="Analytics"
          description="Measurement status for every published video, plus patterns across all your comments. Per-video snapshots and evaluations live on each video's own page."
        />

        {audienceError && (
          <Panel className="mb-5 !border-[var(--color-rose-500)]/40">
            <p className="text-sm text-[var(--color-rose-400)]">{audienceError}</p>
          </Panel>
        )}

        <Panel padding="p-0" className="mb-5">
          <div className="p-4 pb-0 sm:p-5 sm:pb-0">
            <SectionHeading
              eyebrow="Measured"
              title={totalMeasured > LIMIT ? `Published Content (${LIMIT} of ${totalMeasured})` : "Published Content"}
            />
          </div>
          {items.length === 0 ? (
            <div className="px-4 pb-4 sm:px-5 sm:pb-5">
              <EmptyState>Nothing published yet.</EmptyState>
            </div>
          ) : (
            <>
            {/* Phones: tappable rows instead of a 3-column table. */}
            <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)] sm:hidden">
              {items.map((item) => (
                <li key={item.id}>
                  <Link href={`/content/${item.id}`} className="flex min-h-[60px] items-center gap-3 px-4 py-3 active:bg-white/[0.05]">
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-[15px] font-medium leading-snug">{item.title}</p>
                      <p className="mt-1 flex items-center gap-2 text-[13px] text-[var(--color-text-faint)]">
                        <Badge tone={contentStateTone(item.currentState)}>{stateLabel(item.currentState)}</Badge>
                        {snapshotCountByItem.get(item.id) ?? 0} snapshot{(snapshotCountByItem.get(item.id) ?? 0) === 1 ? "" : "s"}
                      </p>
                    </div>
                    <svg width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="shrink-0 text-[var(--color-text-faint)]" aria-hidden>
                      <path d="m1 1 6 6-6 6" />
                    </svg>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-text-faint)]">
                    <th className="px-5 py-2 font-medium">Title</th>
                    <th className="px-5 py-2 font-medium">State</th>
                    <th className="px-5 py-2 font-medium">Snapshots captured</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="px-5 py-2.5">
                        <Link href={`/content/${item.id}`} className="hover:text-[var(--color-gold-400)]">
                          {item.title}
                        </Link>
                      </td>
                      <td className="px-5 py-2.5">
                        <Badge tone={contentStateTone(item.currentState)}>{stateLabel(item.currentState)}</Badge>
                      </td>
                      <td className="px-5 py-2.5 text-[var(--color-text-muted)]">
                        {snapshotCountByItem.get(item.id) ?? 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </Panel>

        <Panel>
          <SectionHeading
            eyebrow="Cross-video"
            title={insightsTotal > 15 ? `Audience Intelligence (15 of ${insightsTotal})` : "Audience Intelligence"}
          />
          <p className="mb-4 text-[14px] text-[var(--color-text-muted)] sm:text-[13px]">
            Classifies real ingested comments across every video into recurring patterns — a
            single comment is never treated as a signal on its own. Requires ANTHROPIC_API_KEY.
          </p>
          <form action={runAudienceIntelligence}>
            <Button className="w-full sm:w-auto" pendingLabel="Analyzing comments…">Run Audience Intelligence</Button>
          </form>

          {insights.length > 0 && (
            <ul className="mt-4 flex flex-col gap-3">
              {insights.map((insight) => (
                <li
                  key={insight.id}
                  className="rounded-lg border border-[var(--color-border)] bg-white/[0.03] p-3.5 text-sm"
                >
                  <span className="font-medium">{insight.category}</span>{" "}
                  <span className="text-[var(--color-text-faint)]">({insight.supportingCommentCount} comments)</span>
                  <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">{insight.description}</p>
                  {insight.actionableSuggestion && (
                    <p className="mt-1 text-[13px] text-[var(--color-gold-400)]">→ {insight.actionableSuggestion}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </PageShell>
    </>
  );
}
