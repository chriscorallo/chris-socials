"use server";

import { redirect } from "next/navigation";
import {
  prisma,
  listContentItems,
  upsertWeeklyThesis,
  recordPortfolioProposal,
  approvePortfolioItem,
  rejectPortfolioItem,
  approveIdeaProposal,
  rejectIdeaProposal,
  buildStrategicContext,
  getPlanContextForAgent,
} from "@chris/domain";
import {
  getBrandContextText,
  runCreativeDirectorAgent,
  runWeeklyStrategistAgent,
  type BacklogItemSummary,
} from "@chris/agents";
import { requireSession } from "../../lib/session";
import { getModelProvider } from "../../lib/model-provider";

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

async function getBacklogSummaries(): Promise<BacklogItemSummary[]> {
  const ideas = await listContentItems(prisma, { state: "IDEA" });
  return ideas.map((i) => ({
    id: i.id,
    title: i.title,
    description: i.description,
    pillar: i.pillar,
    format: i.format,
  }));
}

/** Runs the Creative Director agent against the current IDEA backlog + Brand Constitution
 * and upserts the result as this week's thesis. Requires ANTHROPIC_API_KEY. */
export async function generateThesis(formData: FormData) {
  const session = await requireSession();
  const weekStartDate = new Date(str(formData, "weekStartDate"));

  try {
    const backlog = await getBacklogSummaries();
    const brandContext = await getBrandContextText(prisma);
    // Accepted beliefs, last week's brief, performance, audience insights, taste feedback and
    // reference observations — the learning loop's output feeding the next week (spec §9 step
    // 27). Bounded to ~2K tokens.
    const strategicContext = await buildStrategicContext(prisma);
    const thesisOutput = await runCreativeDirectorAgent(getModelProvider(), {
      backlog,
      referenceContext: "",
      strategicContext,
      brandContext,
    });
    await upsertWeeklyThesis(
      prisma,
      { weekStartDate, ...thesisOutput },
      { actorId: session.user!.id! },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown thesis error";
    redirect(`/strategy?thesisError=${encodeURIComponent(message)}`);
  }

  redirect("/strategy");
}

/**
 * Runs the Weekly Strategist agent against a thesis + the current backlog and records every
 * returned allocation as a PROPOSAL only — see /docs/DECISIONS.md ("Weekly Strategist
 * proposals require review before taking effect"). Nothing is selected/transitioned here;
 * that only happens when a human approves a specific proposal via approveProposal below.
 */
export async function generatePortfolio(formData: FormData) {
  const session = await requireSession();
  const weeklyThesisId = str(formData, "weeklyThesisId");

  try {
    const thesis = await prisma.weeklyProgrammingThesis.findUniqueOrThrow({
      where: { id: weeklyThesisId },
    });
    const backlog = await getBacklogSummaries();
    const brandContext = await getBrandContextText(prisma);

    const allocation = await runWeeklyStrategistAgent(getModelProvider(), {
      thesis: {
        thesis: thesis.thesis,
        primaryObjectives: thesis.primaryObjectives as string[],
        activeExperiments: thesis.activeExperiments as string[],
        areasToExploit: thesis.areasToExploit as string[],
        areasToExplore: thesis.areasToExplore as string[],
        areasToReduce: thesis.areasToReduce as string[],
        risks: thesis.risks as string[],
        contentGaps: thesis.contentGaps as string[],
        productionConstraints: thesis.productionConstraints as string[],
        humanDecisionsNeeded: thesis.humanDecisionsNeeded as string[],
      },
      backlog,
      editingBudgetMinutesPerWeek: 300,
      strategicContext: await buildStrategicContext(prisma),
      brandContext,
      // Chris's ChatGPT planning conversation (optional, ~3K tokens).
      planContext: await getPlanContextForAgent(prisma, "WEEKLY_STRATEGIST"),
    });

    // Allocations + any brand-new idea proposals, all PROPOSED only; journaled once.
    await recordPortfolioProposal(prisma, weeklyThesisId, allocation, { actorId: session.user!.id! });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown portfolio error";
    redirect(`/strategy?portfolioError=${encodeURIComponent(message)}`);
  }

  redirect("/strategy");
}

export async function approveProposal(formData: FormData) {
  const session = await requireSession();
  const portfolioItemId = str(formData, "portfolioItemId");
  await approvePortfolioItem(prisma, portfolioItemId, { actorId: session.user!.id! });
  redirect("/strategy");
}

export async function rejectProposal(formData: FormData) {
  const session = await requireSession();
  const portfolioItemId = str(formData, "portfolioItemId");
  await rejectPortfolioItem(prisma, portfolioItemId, { actorId: session.user!.id! });
  redirect("/strategy");
}

/** Approves every PROPOSED allocation the Strategist recommended selecting, in one click —
 * the portfolio is reviewed as a whole, not 30 separate approvals. Each item is still its own
 * audited approval; one failure doesn't stop the rest. */
export async function approveAllRecommended(formData: FormData) {
  const session = await requireSession();
  const weeklyThesisId = str(formData, "weeklyThesisId");
  const recommended = await prisma.weeklyPortfolioItem.findMany({
    where: { weeklyThesisId, status: "PROPOSED", selected: true },
  });
  const failures: string[] = [];
  for (const item of recommended) {
    try {
      await approvePortfolioItem(prisma, item.id, { actorId: session.user!.id! });
    } catch (err) {
      failures.push(`${item.topic}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }
  if (failures.length > 0) redirect(`/strategy?portfolioError=${encodeURIComponent(failures.join("; "))}`);
  redirect("/strategy");
}

/** A brand-new idea the Strategist proposed to fill a portfolio gap — creating it (as an IDEA,
 * then selected for the week) only happens here, on Chris's approval. */
export async function approveNewIdea(formData: FormData) {
  const session = await requireSession();
  await approveIdeaProposal(prisma, str(formData, "proposalId"), { actorId: session.user!.id! });
  redirect("/strategy");
}

export async function rejectNewIdea(formData: FormData) {
  const session = await requireSession();
  await rejectIdeaProposal(prisma, str(formData, "proposalId"), { actorId: session.user!.id! }, str(formData, "reason") || undefined);
  redirect("/strategy");
}
