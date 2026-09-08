import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import {
  upsertWeeklyThesis,
  getCurrentWeekThesis,
  getWeeklyThesisWithPortfolio,
  recordPortfolioItem,
  approvePortfolioItem,
  rejectPortfolioItem,
  listPortfolioItems,
} from "../weekly-thesis";

// Unique per test-suite run AND monotonically increasing run-over-run — the dev DB persists
// across repeated `pnpm test` runs (see /docs/DECISIONS.md's PGlite notes). A fixed literal
// date would keep matching the *same* thesis row across every past run (accumulating
// portfolio items against it); a *random* date (tried first) fixed that but broke
// "getCurrentWeekThesis returns the most recent week" instead — that assertion only holds if
// this run's dates are actually the latest ever inserted, which a random draw doesn't
// guarantee against a prior run's data. Date.now() is both unique per run and strictly
// greater than every previous run's base (real time only moves forward), satisfying both.
const RUN_BASE = Date.now();
function uniqueWeek(offsetDays: number): Date {
  return new Date(RUN_BASE + offsetDays * 24 * 60 * 60 * 1000);
}

describe("weekly programming thesis + portfolio", () => {
  it("upserts a thesis by weekStartDate (no duplicate per week)", async () => {
    const weekStartDate = uniqueWeek(1);
    await upsertWeeklyThesis(
      prisma,
      { weekStartDate, thesis: "First draft" },
      { actorId: "chris" },
    );
    await upsertWeeklyThesis(
      prisma,
      { weekStartDate, thesis: "Revised thesis" },
      { actorId: "chris" },
    );

    const all = await prisma.weeklyProgrammingThesis.findMany({ where: { weekStartDate } });
    expect(all).toHaveLength(1);
    expect(all[0]?.thesis).toBe("Revised thesis");
  });

  it("getCurrentWeekThesis returns the most recent week", async () => {
    // getCurrentWeekThesis is intentionally global (the single most-recent week across the
    // whole system) — cleaned first so this assertion isn't at the mercy of every other
    // test's own weeks (in this file or a prior run against the persisted dev DB; see
    // /docs/DECISIONS.md). Portfolio items first: they FK-reference theses.
    await prisma.weeklyPortfolioItem.deleteMany({});
    await prisma.weeklyProgrammingThesis.deleteMany({});

    await upsertWeeklyThesis(
      prisma,
      { weekStartDate: uniqueWeek(10), thesis: "old" },
      { actorId: "chris" },
    );
    await upsertWeeklyThesis(
      prisma,
      { weekStartDate: uniqueWeek(20), thesis: "newest" },
      { actorId: "chris" },
    );
    const current = await getCurrentWeekThesis(prisma);
    expect(current?.thesis).toBe("newest");
  });

  it("recording a portfolio item is only a PROPOSAL — it does not touch the idea's state", async () => {
    const item = await createContentItem(prisma, { title: "Portfolio test idea" }, {
      actorId: "test-user",
    });
    const thesis = await upsertWeeklyThesis(
      prisma,
      { weekStartDate: uniqueWeek(30), thesis: "test thesis" },
      { actorId: "chris" },
    );

    const proposal = await recordPortfolioItem(
      prisma,
      thesis.id,
      {
        contentItemId: item.id,
        purpose: "Acquisition",
        topic: "Credit",
        format: "Talking head",
        productionTier: "FAST",
        primaryHypothesis: "Dollar-specific hooks convert better",
        whyThisWeek: "Fits this week's acquisition focus",
        selected: true,
      },
      { actorId: "chris" },
    );
    expect(proposal.status).toBe("PROPOSED");

    const unchanged = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.currentState).toBe("IDEA");

    const withPortfolio = await getWeeklyThesisWithPortfolio(prisma, thesis.id);
    expect(withPortfolio?.portfolioItems).toHaveLength(1);
    expect(withPortfolio?.portfolioItems[0]?.status).toBe("PROPOSED");
  });

  it("approving a selected proposal transitions the idea IDEA -> SELECTED", async () => {
    const item = await createContentItem(prisma, { title: "Approve test idea" }, {
      actorId: "test-user",
    });
    const thesis = await upsertWeeklyThesis(
      prisma,
      { weekStartDate: uniqueWeek(35), thesis: "test thesis" },
      { actorId: "chris" },
    );
    const proposal = await recordPortfolioItem(
      prisma,
      thesis.id,
      {
        contentItemId: item.id,
        purpose: "Acquisition",
        topic: "Credit",
        format: "Talking head",
        productionTier: "FAST",
        primaryHypothesis: "h",
        whyThisWeek: "w",
        selected: true,
      },
      { actorId: "chris" },
    );

    const approved = await approvePortfolioItem(prisma, proposal.id, { actorId: "chris" });
    expect(approved.status).toBe("APPROVED");

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("SELECTED");
  });

  it("rejecting a proposal never transitions the idea, even if selected: true", async () => {
    const item = await createContentItem(prisma, { title: "Reject test idea" }, {
      actorId: "test-user",
    });
    const thesis = await upsertWeeklyThesis(
      prisma,
      { weekStartDate: uniqueWeek(38), thesis: "test thesis" },
      { actorId: "chris" },
    );
    const proposal = await recordPortfolioItem(
      prisma,
      thesis.id,
      {
        contentItemId: item.id,
        purpose: "Acquisition",
        topic: "Credit",
        format: "Talking head",
        productionTier: "FAST",
        primaryHypothesis: "h",
        whyThisWeek: "w",
        selected: true,
      },
      { actorId: "chris" },
    );

    const rejected = await rejectPortfolioItem(prisma, proposal.id, { actorId: "chris" });
    expect(rejected.status).toBe("REJECTED");

    const unchanged = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.currentState).toBe("IDEA");
  });

  it("approving a non-selected proposal does NOT transition the idea", async () => {
    const item = await createContentItem(prisma, { title: "Not selected idea" }, {
      actorId: "test-user",
    });
    const thesis = await upsertWeeklyThesis(
      prisma,
      { weekStartDate: uniqueWeek(40), thesis: "test thesis" },
      { actorId: "chris" },
    );

    const proposal = await recordPortfolioItem(
      prisma,
      thesis.id,
      {
        contentItemId: item.id,
        purpose: "Exploration",
        topic: "Investing",
        format: "Skit",
        productionTier: "HERO",
        primaryHypothesis: "Too experimental for this week",
        whyThisWeek: "Considered but not selected — production burden too high",
        selected: false,
      },
      { actorId: "chris" },
    );
    await approvePortfolioItem(prisma, proposal.id, { actorId: "chris" });

    const unchanged = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(unchanged.currentState).toBe("IDEA");
  });

  it("upserting the same content item's proposal again does not duplicate the row, and resets it to PROPOSED", async () => {
    const item = await createContentItem(prisma, { title: "Reallocate idea" }, {
      actorId: "test-user",
    });
    const thesis = await upsertWeeklyThesis(
      prisma,
      { weekStartDate: uniqueWeek(50), thesis: "test thesis" },
      { actorId: "chris" },
    );

    const base = {
      contentItemId: item.id,
      purpose: "Acquisition",
      topic: "Credit",
      format: "Talking head",
      productionTier: "FAST" as const,
      primaryHypothesis: "v1",
      whyThisWeek: "v1",
      selected: true,
    };
    const first = await recordPortfolioItem(prisma, thesis.id, base, { actorId: "chris" });
    await approvePortfolioItem(prisma, first.id, { actorId: "chris" });

    // A fresh proposal for the same (thesis, item) pair resets review status — a new AI
    // proposal requires fresh human review, even if a prior one was already approved.
    await recordPortfolioItem(
      prisma,
      thesis.id,
      { ...base, primaryHypothesis: "v2 revised" },
      { actorId: "chris" },
    );

    const items = await listPortfolioItems(prisma, thesis.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.primaryHypothesis).toBe("v2 revised");
    expect(items[0]?.status).toBe("PROPOSED");
  });
});
