"use server";

import { redirect } from "next/navigation";
import {
  prisma,
  listContentItems,
  upsertWeeklyThesis,
  recordPortfolioItem,
  approvePortfolioItem,
  rejectPortfolioItem,
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
    const thesisOutput = await runCreativeDirectorAgent(getModelProvider(), {
      backlog,
      referenceContext: "",
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
      brandContext,
    });

    // Sequential, not Promise.all — see /docs/DECISIONS.md.
    for (const item of allocation.items) {
      await recordPortfolioItem(prisma, weeklyThesisId, item, { actorId: session.user!.id! });
    }
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
