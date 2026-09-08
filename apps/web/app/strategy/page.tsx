import { prisma, getCurrentWeekThesis, getWeeklyThesisWithPortfolio } from "@chris/domain";
import { requireSession } from "../../lib/session";
import { NavBar } from "../components/NavBar";
import { PageShell, PageHeader, Panel, SectionHeading, EmptyState, Button, Badge } from "../components/ui";
import { generateThesis, generatePortfolio, approveProposal, rejectProposal } from "./actions";

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

        <Panel className="mb-5">
          <SectionHeading eyebrow="Creative Director" title="Generate this week's thesis" />
          <p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
            Runs the Creative Director agent against the current IDEA backlog and Brand
            Constitution. Requires ANTHROPIC_API_KEY.
          </p>
          <form action={generateThesis} className="flex items-center gap-3">
            <input type="date" name="weekStartDate" defaultValue={nextMonday()} className="field-input w-auto" />
            <Button tone="primary">Generate thesis</Button>
          </form>
        </Panel>

        {withPortfolio && (
          <Panel className="mb-5">
            <SectionHeading
              eyebrow="This Week"
              title={`Week of ${withPortfolio.weekStartDate.toLocaleDateString()}`}
            />
            <p className="mb-4 text-sm leading-relaxed">{withPortfolio.thesis}</p>

            <dl className="grid gap-3 text-[13px] sm:grid-cols-2">
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
              <Button>Generate portfolio proposal</Button>
              <p className="mt-2 text-xs text-[var(--color-text-faint)]">
                Proposes only — nothing is selected until you approve each item below.
              </p>
            </form>
          </Panel>
        )}

        {proposed.length > 0 && (
          <Panel className="mb-5">
            <SectionHeading eyebrow="Review" title={`Needs your review (${proposed.length})`} />
            <div className="flex flex-col gap-3">
              {proposed.map((p) => (
                <div key={p.id} className="rounded-xl border border-[var(--color-border)] bg-white/[0.03] p-4">
                  <p className="text-sm">
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
                  <div className="mt-3 flex gap-2">
                    <form action={approveProposal}>
                      <input type="hidden" name="portfolioItemId" value={p.id} />
                      <Button tone="primary">Approve</Button>
                    </form>
                    <form action={rejectProposal}>
                      <input type="hidden" name="portfolioItemId" value={p.id} />
                      <Button tone="danger">Reject</Button>
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
                <li key={p.id} className="flex items-center justify-between text-sm">
                  <span className="font-medium">{p.topic}</span>
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
