import Link from "next/link";
import { prisma, listContentItems, countContentItems, listAudienceInsights, countAudienceInsights } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel, SectionHeading, Badge, EmptyState, Button, contentStateTone } from "../components/ui";
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
          description="Spec §9 steps 23-25 — metric snapshots, comment ingestion, and per-video performance evaluation happen on each item's own detail page. This dashboard tracks measurement status across every published item, plus cross-video Audience Intelligence (spec §9 step 24)."
        />

        {audienceError && (
          <Panel className="mb-5 !border-[var(--color-rose-500)]/40">
            <p className="text-sm text-[var(--color-rose-400)]">{audienceError}</p>
          </Panel>
        )}

        <Panel padding="p-0" className="mb-5">
          <div className="p-5 pb-0">
            <SectionHeading
              eyebrow="Measured"
              title={totalMeasured > LIMIT ? `Published Content (${LIMIT} of ${totalMeasured})` : "Published Content"}
            />
          </div>
          {items.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState>Nothing published yet.</EmptyState>
            </div>
          ) : (
            <div className="overflow-x-auto">
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
                        <Badge tone={contentStateTone(item.currentState)}>{item.currentState}</Badge>
                      </td>
                      <td className="px-5 py-2.5 text-[var(--color-text-muted)]">
                        {snapshotCountByItem.get(item.id) ?? 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel>
          <SectionHeading
            eyebrow="Cross-video"
            title={insightsTotal > 15 ? `Audience Intelligence (15 of ${insightsTotal})` : "Audience Intelligence"}
          />
          <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
            Classifies real ingested comments across every video into recurring patterns — a
            single comment is never treated as a signal on its own. Requires ANTHROPIC_API_KEY.
          </p>
          <form action={runAudienceIntelligence}>
            <Button>Run Audience Intelligence</Button>
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
