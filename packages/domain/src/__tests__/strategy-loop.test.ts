import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma";
import { buildStrategicContext } from "../strategic-context";
import {
  upsertWeeklyThesis,
  recordPortfolioProposal,
  listPendingIdeaProposals,
  approveIdeaProposal,
  rejectIdeaProposal,
  IdeaProposalNotPendingError,
} from "../weekly-thesis";
import { recordTasteFeedback } from "../taste";
import { journalDecision } from "../decision-journal";

const proposal = (title: string) => ({
  title,
  description: "Answer the #1 audience question about Roth conversions",
  pillar: "SKILL" as const,
  topic: "Retirement",
  format: "Talking head",
  purpose: "Authority",
  productionTier: "FAST" as const,
  primaryHypothesis: "Audience-question videos drive saves",
  whyThisWeek: "Repeated in comments",
  gapFilled: "No authority video this week",
});

describe("buildStrategicContext", () => {
  it("renders every section, says so explicitly when a store is empty, and respects maxChars", async () => {
    await recordTasteFeedback(prisma, { artifactType: "SCRIPT", rawFeedback: "too corporate", normalizedTag: `too_corporate_${randomUUID().slice(0, 4)}` }, { actorId: "chris" });
    const text = await buildStrategicContext(prisma);
    for (const heading of ["Accepted beliefs", "Last weekly brief", "Recent performance evaluations", "Audience insights", "taste feedback", "Reference observations"]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("too corporate");
    const small = await buildStrategicContext(prisma, { maxChars: 300 });
    expect(small.length).toBeLessThanOrEqual(300);
  });
});

describe("Weekly Strategist new-idea proposals", () => {
  async function thesis() {
    return upsertWeeklyThesis(prisma, { weekStartDate: new Date(Date.UTC(2031, 0, Math.floor(Math.random() * 28) + 1)), thesis: "t" }, { actorId: "chris" });
  }

  it("records proposals without creating ContentItems; approval creates the item and selects it", async () => {
    const t = await thesis();
    const before = await prisma.contentItem.count();
    const { proposals } = await recordPortfolioProposal(prisma, t.id, { items: [], proposedNewIdeas: [proposal("Roth conversion Q"), proposal("Backdoor Roth Q")] }, { actorId: "system" });
    expect(await prisma.contentItem.count()).toBe(before);
    expect((await listPendingIdeaProposals(prisma, t.id)).map((p) => p.proposal.title)).toEqual(["Roth conversion Q", "Backdoor Roth Q"]);

    const { contentItem } = await approveIdeaProposal(prisma, proposals[0]!.proposalId, { actorId: "chris" });
    expect(contentItem.title).toBe("Roth conversion Q");
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItem.id } })).currentState).toBe("SELECTED");

    await rejectIdeaProposal(prisma, proposals[1]!.proposalId, { actorId: "chris" }, "Not this week");
    expect(await listPendingIdeaProposals(prisma, t.id)).toHaveLength(0);
    await expect(approveIdeaProposal(prisma, proposals[1]!.proposalId, { actorId: "chris" })).rejects.toBeInstanceOf(IdeaProposalNotPendingError);

    const journal = await prisma.decisionJournalEntry.findFirstOrThrow({ where: { question: "Which ideas make up this week's portfolio?", evidenceIds: { array_contains: [t.id] } } });
    expect(journal.selectedDecision).toContain("2 new idea(s) proposed");
  });
});

describe("journalDecision", () => {
  it("never throws — a journal failure can't undo the decision it records", async () => {
    const broken = { decisionJournalEntry: { create: async () => { throw new Error("db down"); } } } as unknown as typeof prisma;
    await expect(journalDecision(broken, { question: "q", selectedDecision: "d", rationale: "r", decisionOwner: "o" })).resolves.toBeNull();
  });
});
