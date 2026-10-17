import { prisma, getCurrentWeekThesis, getWeeklyThesisWithPortfolio, listPendingIdeaProposals } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel, SectionHeading, CollapsiblePanel, EmptyState, Button, Badge } from "../components/ui";
import {
  generateThesis,
  generatePortfolio,
  approveProposal,
  rejectProposal,
  approveAllRecommended,
  approveNewIdea,
  rejectNewIdea,
} from "./actions";

// Server Actions on this page run model calls / ffmpeg synchronously — allow up to the
// Vercel Fluid Compute ceiling instead of the platform default. See /docs/DECISIONS.md.
export const maxDuration = 300;

function nextMonday(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = ((8 - day) % 7) || 7;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

// Weekly Programming Thesis + Portfolio — spec §9 steps 2-3. See
// /prompts/agents/CREATIVE_DIRECTOR.md and /prompts/agents/WEEKLY_STRATEGIST.md.
//
// Portfolio proposals require human review before taking effect — see /docs/DECISIONS.md
// ("Weekly Strategist proposals require review before taking effect"). A PROPOSED item has
// not touched the state machine; only approving one selected: true item transitions its idea
// IDEA -> SELECTED.
export default async function StrategyPage({
  searchParams,
}: {
  searchParams: Promise<{ thesisError?: string; portfolioError?: string }>;
}) {
  await requireSession();
  const { thesisError, portfolioError } = await searchParams;

  const current = await getCurrentWeekThesis(prisma);
  const withPortfolio = current ? await getWeeklyThesisWithPortfolio(prisma, current.id) : null;
  const proposed = withPortfolio?.portfolioItems.filter((p) => p.status === "PROPOSED") ?? [];
  const reviewed = withPortfolio?.portfolioItems.filter((p) => p.status !== "PROPOSED") ?? [];
  const newIdeas = current ? await listPendingIdeaProposals(prisma, current.id) : [];
  const recommendedCount = proposed.filter((p) => p.selected).length;

  return (
    <>
      <NavBar />
      <PageShell maxWidth={760}>
        <PageHeader eyebrow="Intelligence" title="Weekly Strategy" />

        {(thesisError || portfolioError) && (
          <Panel className="mb-5 !border-[var(--color-rose-500)]/40">
            {thesisError && (
              <p className="text-sm text-[var(--color-rose-400)]">
                <span className="font-medium">Thesis error: </span>
                {thesisError}
              </p>
            )}
            {portfolioError && (
              <p className="text-sm text-[var(--color-rose-400)]">
                <span className="font-medium">Portfolio error: </span>
                {portfolioError}
              </p>
            )}
          </Panel>
        )}

        <CollapsiblePanel eyebrow="Creative Director" title="Generate a weekly thesis" className="mb-5" defaultOpen={!current}>
          <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
            Runs the Creative Director agent against the current IDEA backlog and Brand
            Constitution. Requires ANTHROPIC_API_KEY.
          </p>
          <form action={generateThesis} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="block sm:w-auto">
              <span className="field-label">Week starting</span>
              <input type="date" name="weekStartDate" defaultValue={nextMonday()} className="field-input sm:w-auto" />
            </label>
            <Button tone="primary" className="w-full sm:w-auto" pendingLabel="Thinking…">Generate thesis</Button>
          </form>
        </CollapsiblePanel>

        {withPortfolio && (
          <Panel className="mb-5">
            <SectionHeading
              eyebrow="This Week"
              title={`Week of ${withPortfolio.weekStartDate.toLocaleDateString()}`}
            />
            <p className="mb-4 text-[15px] leading-relaxed sm:text-sm">{withPortfolio.thesis}</p>

            <dl className="grid gap-3 text-[14px] sm:grid-cols-2 sm:text-[13px]">
              <div>
                <dt className="font-medium text-[var(--color-text)]">Primary objectives</dt>
                <dd className="text-[var(--color-text-muted)]">
                  {(withPortfolio.primaryObjectives as string[]).join("; ") || "—"}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-[var(--color-text)]">Areas to exploit</dt>
                <dd className="text-[var(--color-text-muted)]">
                  {(withPortfolio.areasToExploit as string[]).join("; ") || "—"}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-[var(--color-text)]">Areas to explore</dt>
                <dd className="text-[var(--color-text-muted)]">
                  {(withPortfolio.areasToExplore as string[]).join("; ") || "—"}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-[var(--color-text)]">Areas to reduce</dt>
                <dd className="text-[var(--color-text-muted)]">
                  {(withPortfolio.areasToReduce as string[]).join("; ") || "—"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="font-medium text-[var(--color-rose-400)]">Human decisions needed</dt>
                <dd className="text-[var(--color-text-muted)]">
                  {(withPortfolio.humanDecisionsNeeded as string[]).join("; ") || "—"}
                </dd>
              </div>
            </dl>

            <form action={generatePortfolio} className="mt-5">
              <input type="hidden" name="weeklyThesisId" value={withPortfolio.id} />
              <Button className="w-full sm:w-auto" pendingLabel="Proposing…">Generate portfolio proposal</Button>
              <p className="mt-2 text-xs text-[var(--color-text-faint)]">
                Proposes only — nothing is selected until you approve each item below.
              </p>
            </form>
          </Panel>
        )}

        {newIdeas.length > 0 && (
          <Panel className="mb-5">
            <SectionHeading eyebrow="New ideas" title={`Strategist proposes ${newIdeas.length} new idea${newIdeas.length === 1 ? "" : "s"}`} />
            <div className="flex flex-col gap-3">
              {newIdeas.map(({ proposalId, proposal }) => (
                <div key={proposalId} className="rounded-xl border border-[var(--color-border)] bg-white/[0.03] p-4">
                  <p className="text-sm font-medium">{proposal.title}</p>
                  <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">{proposal.description}</p>
                  <p className="mt-1.5 text-xs text-[var(--color-text-faint)]">
                    {proposal.productionTier}
                    {proposal.pillar ? ` · ${proposal.pillar}` : ""} · {proposal.format} · Fills: {proposal.gapFilled} · Why now: {proposal.whyThisWeek}
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:flex">
                    <form action={approveNewIdea}>
                      <input type="hidden" name="proposalId" value={proposalId} />
                      <Button tone="primary" className="w-full">Add &amp; select</Button>
                    </form>
                    <form action={rejectNewIdea}>
                      <input type="hidden" name="proposalId" value={proposalId} />
                      <Button tone="danger" className="w-full">Pass</Button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        )}

        {proposed.length > 0 && (
          <Panel className="mb-5">
            <SectionHeading eyebrow="Review" title={`Needs your review (${proposed.length})`} />
            {recommendedCount > 0 && withPortfolio && (
              <form action={approveAllRecommended} className="mb-4">
                <input type="hidden" name="weeklyThesisId" value={withPortfolio.id} />
                <Button tone="primary" className="w-full sm:w-auto" pendingLabel="Approving…">Approve all {recommendedCount} recommended</Button>
              </form>
            )}
            <div className="flex flex-col gap-3">
              {proposed.map((p) => (
                <div key={p.id} className="rounded-xl border border-[var(--color-border)] bg-white/[0.03] p-4">
                  <p className="text-[15px] leading-snug sm:text-sm">
                    <span className="font-medium">{p.topic}</span>{" "}
                    <span className="text-[var(--color-text-muted)]">
                      ({p.productionTier}
                      {p.pillar ? `, ${p.pillar}` : ""}) — {p.whyThisWeek}
                    </span>
                  </p>
                  <p className="mt-1.5 text-xs text-[var(--color-text-faint)]">
                    Hypothesis: {p.primaryHypothesis}
                    {p.duplicateRisk ? ` · Duplicate risk: ${p.duplicateRisk}` : ""}
                  </p>
                  <p className="mt-1.5 text-xs">
                    Agent recommends:{" "}
                    <Badge tone={p.selected ? "emerald" : "neutral"}>{p.selected ? "select" : "do not select"}</Badge>
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:flex">
                    <form action={approveProposal}>
                      <input type="hidden" name="portfolioItemId" value={p.id} />
                      <Button tone="primary" className="w-full">Approve</Button>
                    </form>
                    <form action={rejectProposal}>
                      <input type="hidden" name="portfolioItemId" value={p.id} />
                      <Button tone="danger" className="w-full">Reject</Button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        )}

        {reviewed.length > 0 && (
          <Panel className="mb-5">
            <SectionHeading eyebrow="Decided" title="Reviewed" />
            <ul className="flex flex-col gap-2">
              {reviewed.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 text-[15px] sm:text-sm">
                  <span className="min-w-0 font-medium">{p.topic}</span>
                  <Badge tone={p.status === "APPROVED" ? "emerald" : "rose"}>{p.status}</Badge>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {!current && (
          <Panel>
            <EmptyState>No thesis generated yet.</EmptyState>
          </Panel>
        )}
      </PageShell>
    </>
  );
}
