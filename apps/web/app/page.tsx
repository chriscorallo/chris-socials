import Link from "next/link";
import {
  prisma,
  listScheduleEntries,
  getWeeklyThesisWithPortfolio,
  getCurrentWeekThesis,
  getNeedsYouQueue,
  needsYouCategoryLabel,
  type NeedsYouCategory,
} from "@chris/domain";
import { requireSession } from "../lib/session";
import { NavBar } from "./components/NavBar";
import { PageShell, Panel, SectionHeading, Badge, EmptyState, QuietLink } from "./components/ui";

// Home — spec §20: "THIS WEEK / PERFORMANCE / CREATIVE DIRECTOR / NEEDS YOU." Replaces the
// Phase 0 "Foundation OK" status page now that the data behind all four sections is real:
// WeeklyProgrammingThesis (Phase 2), PerformanceEvaluation (Phase 6), and the NEEDS YOU
// queue (packages/domain/src/needs-you.ts, built specifically for this page). See
// /docs/DECISIONS.md's Home-page entry.
//
// Spec, verbatim: "Backend may know hundreds of metrics. Chris should see only the few that
// matter... Do not create approval fatigue." Every section below is deliberately capped —
// this page links out to Strategy/Analytics/Learnings/Content for depth rather than trying
// to be the deep view itself.

const NEEDS_YOU_TONE: Record<NeedsYouCategory, "gold" | "violet" | "rose" | "emerald"> = {
  UNRESOLVED_QC: "rose",
  FACTUAL_NUANCE: "rose",
  PLATFORM_ISSUE: "rose",
  STRATEGY_DECISION: "gold",
  SUBJECTIVE_CHOICE: "violet",
  UNCERTAINTY: "violet",
};

function startOfWeek(now: Date): Date {
  const day = now.getDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

export default async function HomePage() {
  const session = await requireSession();

  // Sequential, not Promise.all — see /docs/DECISIONS.md ("the PGlite dev database can't
  // handle concurrently dispatched queries"). Real Postgres would handle either fine.
  const thesis = await getCurrentWeekThesis(prisma);
  const thesisWithPortfolio = thesis ? await getWeeklyThesisWithPortfolio(prisma, thesis.id) : null;
  const scheduleEntries = await listScheduleEntries(prisma);
  const recentEvaluations = await prisma.performanceEvaluation.findMany({
    orderBy: { createdAt: "desc" },
    take: 4,
    include: { contentItem: true },
  });
  const needsYou = await getNeedsYouQueue(prisma, { limit: 8 });

  const weekStart = startOfWeek(new Date());
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const thisWeeksEntries = scheduleEntries.filter(
    (e) => e.scheduledDate >= weekStart && e.scheduledDate < weekEnd,
  );

  const portfolioItems = thesisWithPortfolio?.portfolioItems ?? [];
  const approvedCount = portfolioItems.filter((p) => p.status === "APPROVED").length;

  return (
    <>
      <NavBar />
      <PageShell>
        <header className="mb-6 sm:mb-8">
          <p className="eyebrow mb-1">Chris Content Intelligence</p>
          <h1 className="text-[30px] font-semibold leading-tight tracking-tight sm:text-[28px]">
            Welcome back{session.user?.name ? `, ${session.user.name}` : ""}
          </h1>
        </header>

        <div className="grid gap-4 sm:gap-5 md:grid-cols-2">
          {/* THIS WEEK */}
          <Panel className="md:col-span-2">
            <SectionHeading
              eyebrow="This Week"
              title={
                thesis
                  ? new Date(thesis.weekStartDate).toLocaleDateString(undefined, { month: "long", day: "numeric" })
                  : "No thesis yet"
              }
            />

            {!thesis ? (
              <EmptyState>
                No Weekly Programming Thesis exists yet. <QuietLink href="/strategy">Build one in Strategy →</QuietLink>
              </EmptyState>
            ) : (
              <p className="mb-3 text-[14px] text-[var(--color-text-muted)] sm:text-[13px]">
                <span className="text-[var(--color-text)]">{approvedCount}</span> of{" "}
                {portfolioItems.length} portfolio ideas approved
                <span className="opacity-70"> (spec target ~30/week)</span> ·{" "}
                <span className="text-[var(--color-text)]">{thisWeeksEntries.length}</span> scheduled this
                calendar week
              </p>
            )}

            {thisWeeksEntries.length === 0 ? (
              <EmptyState>
                Nothing scheduled this week yet. <QuietLink href="/calendar">Open Calendar →</QuietLink>
              </EmptyState>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {thisWeeksEntries.slice(0, 6).map((entry) => (
                  <li key={entry.id}>
                    <Link
                      href={`/content/${entry.contentItemId}`}
                      className="-mx-2 flex min-h-[52px] items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-[15px] hover:text-[var(--color-gold-400)] active:bg-white/[0.05] sm:text-sm"
                    >
                    <span className="min-w-0 flex-1">{entry.contentItem.title}</span>
                    <span className="shrink-0 whitespace-nowrap text-xs text-[var(--color-text-faint)]">
                      {entry.scheduledDate.toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* PERFORMANCE */}
          <Panel>
            <SectionHeading eyebrow="Performance" title="What's actually working" />

            {recentEvaluations.length === 0 ? (
              <EmptyState>
                No performance evaluations yet — these appear once published content has been
                measured and judged (spec §9 step 25). <QuietLink href="/analytics">Open Analytics →</QuietLink>
              </EmptyState>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {recentEvaluations.map((evaluation) => (
                  <li key={evaluation.id} className="py-3 first:pt-0">
                    <Link
                      href={`/content/${evaluation.contentItemId}`}
                      className="block text-[15px] font-medium hover:text-[var(--color-gold-400)] active:opacity-70 sm:text-sm"
                    >
                      {evaluation.contentItem.title}
                    </Link>
                    <p className="mt-1 text-[14px] leading-snug text-[var(--color-text-muted)] sm:text-[13px]">
                      {evaluation.overallSummary}
                      {evaluation.strategicallyValuableDespiteLowerViews && (
                        <span className="text-[var(--color-gold-400)]"> · valuable despite lower views</span>
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* CREATIVE DIRECTOR */}
          <Panel>
            <SectionHeading eyebrow="Creative Director" title="This week's direction" />

            {!thesis ? (
              <EmptyState>No coherence call has been made for this week yet.</EmptyState>
            ) : (
              <>
                <p className="mb-3 text-[15px] leading-relaxed text-[var(--color-text)] sm:text-sm">{thesis.thesis}</p>
                {(thesis.risks as unknown as string[])?.length > 0 && (
                  <p className="text-[14px] text-[var(--color-text-muted)] sm:text-[13px]">
                    <span className="font-medium text-[var(--color-text)]">Watching: </span>
                    {(thesis.risks as unknown as string[]).slice(0, 2).join(" · ")}
                  </p>
                )}
                <div className="mt-auto pt-3">
                  <QuietLink href="/strategy">Full thesis, objectives, and portfolio →</QuietLink>
                </div>
              </>
            )}
          </Panel>

          {/* NEEDS YOU */}
          <Panel className="order-first md:order-none md:col-span-2">
            <SectionHeading
              eyebrow="Needs You"
              title={needsYou.entries.length === 0 ? "Nothing needs a decision right now" : `${needsYou.entries.length} waiting on you`}
            />

            {needsYou.entries.length === 0 ? (
              <EmptyState>
                This queue only ever shows subjective calls, factual nuance, unresolved QC,
                platform issues, strategy decisions, or real uncertainty — not routine status.
              </EmptyState>
            ) : (
              <>
                <ul className="grid gap-3 md:grid-cols-2">
                  {needsYou.entries.map((entry, i) => (
                    <li key={i}>
                      <Link
                        href={entry.href}
                        className="block h-full rounded-xl border border-[var(--color-border)] bg-white/[0.03] p-4 transition-colors hover:bg-white/[0.05] active:bg-white/[0.07]"
                      >
                        <Badge tone={NEEDS_YOU_TONE[entry.category]}>{needsYouCategoryLabel(entry.category)}</Badge>
                        <p className="mt-2 text-[15px] font-medium sm:text-sm">{entry.title}</p>
                        <p className="mt-1 line-clamp-3 text-[14px] leading-snug text-[var(--color-text-muted)] sm:text-[13px]">
                          {entry.description}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
                {needsYou.totalBeforeCap > needsYou.entries.length && (
                  <p className="mt-4 text-xs text-[var(--color-text-faint)]">
                    +{needsYou.totalBeforeCap - needsYou.entries.length} more, deliberately not shown here —
                    see Content, Strategy, and Learnings.
                  </p>
                )}
              </>
            )}
          </Panel>
        </div>
      </PageShell>
    </>
  );
}
