import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";
import { applyTransition } from "./state-machine";
import { journalDecision } from "./decision-journal";

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

// --- New-idea proposals from the Weekly Strategist ---------------------------------------
//
// The Strategist may propose NEW ideas to fill portfolio gaps. Nothing is created until a
// human approves. Pending proposals are stored as append-only AuditLog rows
// (NEW_IDEA_PROPOSED, metadata = the proposal) and resolved by a later
// NEW_IDEA_PROPOSAL_APPROVED / _REJECTED row pointing at it — no schema change needed, and
// the full proposal history is permanent. See docs/decisions-pending/ai.md.

export const ProposedNewIdeaInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  pillar: z.enum(["SKILL", "MINDSET", "LIFESTYLE", "PASSIONS"]).nullable().optional(),
  topic: z.string().min(1),
  format: z.string().min(1),
  purpose: z.string().min(1),
  productionTier: z.enum(["RAW", "FAST", "MEDIUM", "HERO"]),
  primaryHypothesis: z.string().min(1),
  whyThisWeek: z.string().min(1),
  gapFilled: z.string().min(1),
});
export type ProposedNewIdeaInput = z.input<typeof ProposedNewIdeaInputSchema>;

export interface PendingIdeaProposal {
  proposalId: string;
  weeklyThesisId: string;
  proposal: z.infer<typeof ProposedNewIdeaInputSchema>;
  proposedAt: Date;
}

/**
 * Records one Weekly Strategist run as proposals: every per-item allocation (PROPOSED, via
 * recordPortfolioItem) plus every new-idea proposal, and journals the allocation decision once.
 */
export async function recordPortfolioProposal(
  prisma: PrismaClient,
  weeklyThesisId: string,
  allocation: { items: PortfolioItemInput[]; proposedNewIdeas?: ProposedNewIdeaInput[] },
  actor: { actorId: string },
) {
  const items = [];
  for (const item of allocation.items) {
    items.push(await recordPortfolioItem(prisma, weeklyThesisId, item, actor));
  }
  const proposals = [];
  for (const raw of allocation.proposedNewIdeas ?? []) {
    const proposal = ProposedNewIdeaInputSchema.parse(raw);
    const row = await recordAudit(prisma, {
      actor: actor.actorId,
      actorType: "SYSTEM",
      action: "NEW_IDEA_PROPOSED",
      entityType: "WeeklyProgrammingThesis",
      entityId: weeklyThesisId,
      metadata: { proposal },
    });
    proposals.push({ proposalId: row.id, proposal });
  }

  const selected = allocation.items.filter((i) => i.selected !== false);
  await journalDecision(prisma, {
    question: "Which ideas make up this week's portfolio?",
    selectedDecision: `${selected.length} existing idea(s) selected, ${proposals.length} new idea(s) proposed`,
    alternatives: allocation.items.filter((i) => i.selected === false).map((i) => `Not selected: ${i.topic}`),
    rationale: [
      ...selected.map((i) => `${i.topic}: ${i.whyThisWeek}`),
      ...proposals.map((p) => `NEW "${p.proposal.title}": ${p.proposal.gapFilled}`),
    ].join(" | ").slice(0, 4000),
    decisionOwner: "WEEKLY_STRATEGIST",
    agentOrModel: "WEEKLY_STRATEGIST",
    evidenceIds: [weeklyThesisId],
  });

  return { items, proposals };
}

export async function listPendingIdeaProposals(
  prisma: PrismaClient,
  weeklyThesisId: string,
): Promise<PendingIdeaProposal[]> {
  const proposed = await prisma.auditLog.findMany({
    where: { action: "NEW_IDEA_PROPOSED", entityType: "WeeklyProgrammingThesis", entityId: weeklyThesisId },
    orderBy: { createdAt: "asc" },
  });
  const resolved = await prisma.auditLog.findMany({
    where: { action: { in: ["NEW_IDEA_PROPOSAL_APPROVED", "NEW_IDEA_PROPOSAL_REJECTED"] }, entityId: { in: proposed.map((p) => p.id) } },
    select: { entityId: true },
  });
  const done = new Set(resolved.map((r) => r.entityId));
  return proposed
    .filter((p) => !done.has(p.id))
    .map((p) => ({
      proposalId: p.id,
      weeklyThesisId,
      proposal: ProposedNewIdeaInputSchema.parse((p.metadata as { proposal: unknown }).proposal),
      proposedAt: p.createdAt,
    }));
}

export class IdeaProposalNotPendingError extends Error {
  constructor(proposalId: string) {
    super(`Idea proposal ${proposalId} doesn't exist or was already resolved.`);
    this.name = "IdeaProposalNotPendingError";
  }
}

async function getPendingProposal(prisma: PrismaClient, proposalId: string) {
  const row = await prisma.auditLog.findUnique({ where: { id: proposalId } });
  if (!row || row.action !== "NEW_IDEA_PROPOSED") throw new IdeaProposalNotPendingError(proposalId);
  const resolved = await prisma.auditLog.findFirst({
    where: { entityId: proposalId, action: { in: ["NEW_IDEA_PROPOSAL_APPROVED", "NEW_IDEA_PROPOSAL_REJECTED"] } },
  });
  if (resolved) throw new IdeaProposalNotPendingError(proposalId);
  return { row, proposal: ProposedNewIdeaInputSchema.parse((row.metadata as { proposal: unknown }).proposal) };
}

/**
 * Human approval of a proposed new idea: only now is a ContentItem created (IDEA), allocated
 * to the week's portfolio, and approved (IDEA -> SELECTED) — same selection semantics as an
 * existing idea.
 */
export async function approveIdeaProposal(prisma: PrismaClient, proposalId: string, actor: { actorId: string }) {
  const { row, proposal } = await getPendingProposal(prisma, proposalId);
  const contentItem = await prisma.contentItem.create({
    data: {
      title: proposal.title,
      description: proposal.description,
      pillar: proposal.pillar ?? null,
      format: proposal.format,
    },
  });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "CONTENT_ITEM_CREATED",
    entityType: "ContentItem",
    entityId: contentItem.id,
    after: { title: contentItem.title, currentState: contentItem.currentState, fromProposalId: proposalId },
  });
  const portfolioItem = await recordPortfolioItem(
    prisma,
    row.entityId,
    {
      contentItemId: contentItem.id,
      purpose: proposal.purpose,
      pillar: proposal.pillar ?? null,
      topic: proposal.topic,
      format: proposal.format,
      productionTier: proposal.productionTier,
      primaryHypothesis: proposal.primaryHypothesis,
      whyThisWeek: proposal.whyThisWeek,
      selected: true,
    },
    actor,
  );
  await approvePortfolioItem(prisma, portfolioItem.id, actor);
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "NEW_IDEA_PROPOSAL_APPROVED",
    entityType: "AuditLog",
    entityId: proposalId,
    after: { contentItemId: contentItem.id, weeklyPortfolioItemId: portfolioItem.id },
  });
  return { contentItem, portfolioItem };
}

export async function rejectIdeaProposal(
  prisma: PrismaClient,
  proposalId: string,
  actor: { actorId: string },
  reason?: string,
) {
  const { proposal } = await getPendingProposal(prisma, proposalId);
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "NEW_IDEA_PROPOSAL_REJECTED",
    entityType: "AuditLog",
    entityId: proposalId,
    metadata: { reason: reason ?? null },
  });
  // A rejected agent proposal is a human override — Taste Model raw material.
  await journalDecision(prisma, {
    question: `Add the proposed idea "${proposal.title}" to the week?`,
    selectedDecision: "Rejected",
    alternatives: ["Approve"],
    rationale: reason?.trim() || "Chris rejected the Weekly Strategist's proposal.",
    decisionOwner: actor.actorId,
    agentOrModel: "WEEKLY_STRATEGIST",
    userOverride: true,
  });
}

export async function listPortfolioItems(prisma: PrismaClient, weeklyThesisId: string) {
  return prisma.weeklyPortfolioItem.findMany({
    where: { weeklyThesisId },
    orderBy: { createdAt: "asc" },
  });
}
