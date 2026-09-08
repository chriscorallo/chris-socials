import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";
import { applyTransition } from "./state-machine";

/**
 * Weekly Programming Thesis + Portfolio — spec §9 steps 2-3. One thesis per week
 * (`weekStartDate` unique); portfolio items are the per-idea allocation the Weekly
 * Strategist produces against that thesis.
 */

export const UpsertWeeklyThesisSchema = z.object({
  weekStartDate: z.coerce.date(),
  thesis: z.string().min(1),
  primaryObjectives: z.array(z.string()).default([]),
  activeExperiments: z.array(z.string()).default([]),
  areasToExploit: z.array(z.string()).default([]),
  areasToExplore: z.array(z.string()).default([]),
  areasToReduce: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  contentGaps: z.array(z.string()).default([]),
  productionConstraints: z.array(z.string()).default([]),
  humanDecisionsNeeded: z.array(z.string()).default([]),
});
// z.input, not z.infer — see /docs/DECISIONS.md's z.infer-vs-z.input note. Every field here
// but weekStartDate/thesis has .default([]).
export type UpsertWeeklyThesisInput = z.input<typeof UpsertWeeklyThesisSchema>;

export async function upsertWeeklyThesis(
  prisma: PrismaClient,
  input: UpsertWeeklyThesisInput,
  actor: { actorId: string },
) {
  const parsed = UpsertWeeklyThesisSchema.parse(input);
  const thesis = await prisma.weeklyProgrammingThesis.upsert({
    where: { weekStartDate: parsed.weekStartDate },
    create: parsed,
    update: parsed,
  });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "WEEKLY_THESIS_RECORDED",
    entityType: "WeeklyProgrammingThesis",
    entityId: thesis.id,
    after: { weekStartDate: thesis.weekStartDate },
  });
  return thesis;
}

export async function getCurrentWeekThesis(prisma: PrismaClient) {
  return prisma.weeklyProgrammingThesis.findFirst({ orderBy: { weekStartDate: "desc" } });
}

export async function getWeeklyThesisWithPortfolio(prisma: PrismaClient, id: string) {
  const thesis = await prisma.weeklyProgrammingThesis.findUnique({ where: { id } });
  if (!thesis) return null;
  const portfolioItems = await prisma.weeklyPortfolioItem.findMany({
    where: { weeklyThesisId: id },
    orderBy: { createdAt: "asc" },
  });
  return { ...thesis, portfolioItems };
}

const PortfolioItemInputSchema = z.object({
  contentItemId: z.string().min(1),
  purpose: z.string().min(1),
  pillar: z.enum(["SKILL", "MINDSET", "LIFESTYLE", "PASSIONS"]).nullable().optional(),
  topic: z.string().min(1),
  subtopic: z.string().nullable().optional(),
  format: z.string().min(1),
  productionTier: z.enum(["RAW", "FAST", "MEDIUM", "HERO"]),
  targetLengthSeconds: z.number().int().nonnegative().nullable().optional(),
  primaryHypothesis: z.string().min(1),
  historicalAnalogue: z.string().nullable().optional(),
  referenceInfluence: z.string().nullable().optional(),
  whyThisWeek: z.string().min(1),
  duplicateRisk: z.string().nullable().optional(),
  researchBurden: z.string().nullable().optional(),
  productionBurden: z.string().nullable().optional(),
  selected: z.boolean().default(true),
});

export type PortfolioItemInput = z.input<typeof PortfolioItemInputSchema>;

/**
 * Records one portfolio allocation *proposal* for a candidate idea against a week's thesis.
 * This is the Weekly Strategist's raw output — it has NO effect on the ContentItem's state
 * machine by itself. A proposal always (re-)enters as PROPOSED, even if a prior proposal for
 * the same (thesis, item) pair had already been reviewed — a fresh AI proposal requires
 * fresh human review, per /docs/DECISIONS.md ("Weekly Strategist proposals require review
 * before taking effect"). Use approvePortfolioItem to actually select the idea.
 */
export async function recordPortfolioItem(
  prisma: PrismaClient,
  weeklyThesisId: string,
  input: PortfolioItemInput,
  actor: { actorId: string },
) {
  const parsed = PortfolioItemInputSchema.parse(input);

  const row = await prisma.weeklyPortfolioItem.upsert({
    where: {
      weeklyThesisId_contentItemId: { weeklyThesisId, contentItemId: parsed.contentItemId },
    },
    create: { weeklyThesisId, ...parsed, status: "PROPOSED" },
    update: { ...parsed, status: "PROPOSED" },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "PORTFOLIO_ITEM_PROPOSED",
    entityType: "ContentItem",
    entityId: parsed.contentItemId,
    after: { weeklyPortfolioItemId: row.id, selected: parsed.selected },
  });

  return row;
}

/**
 * Approves a proposed portfolio item. Only *now* — not at proposal time — does a
 * `selected: true` item transition its ContentItem IDEA -> SELECTED; the portfolio
 * allocation review *is* the selection event described in spec §9 step 3, not the agent's
 * proposal.
 */
export async function approvePortfolioItem(
  prisma: PrismaClient,
  id: string,
  actor: { actorId: string },
) {
  const item = await prisma.weeklyPortfolioItem.update({
    where: { id },
    data: { status: "APPROVED" },
  });

  if (item.selected) {
    const contentItem = await prisma.contentItem.findUnique({
      where: { id: item.contentItemId },
    });
    if (contentItem?.currentState === "IDEA") {
      await applyTransition(prisma, {
        contentItemId: item.contentItemId,
        to: "SELECTED",
        actorType: "HUMAN",
        actorId: actor.actorId,
        reason: "Approved via weekly portfolio allocation review",
      });
    }
  }

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "PORTFOLIO_ITEM_APPROVED",
    entityType: "ContentItem",
    entityId: item.contentItemId,
    after: { weeklyPortfolioItemId: item.id },
  });

  return item;
}

/** Rejects a proposed portfolio item. No effect on the ContentItem's state — it simply
 * remains wherever it already was (typically IDEA). */
export async function rejectPortfolioItem(
  prisma: PrismaClient,
  id: string,
  actor: { actorId: string },
) {
  const item = await prisma.weeklyPortfolioItem.update({
    where: { id },
    data: { status: "REJECTED" },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "PORTFOLIO_ITEM_REJECTED",
    entityType: "ContentItem",
    entityId: item.contentItemId,
    after: { weeklyPortfolioItemId: item.id },
  });

  return item;
}

export async function listPortfolioItems(prisma: PrismaClient, weeklyThesisId: string) {
  return prisma.weeklyPortfolioItem.findMany({
    where: { weeklyThesisId },
    orderBy: { createdAt: "asc" },
  });
}
