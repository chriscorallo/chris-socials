import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createDecisionJournalEntry, listDecisionJournalEntries } from "../decision-journal";

describe("decision journal", () => {
  it("creates and lists entries", async () => {
    await createDecisionJournalEntry(prisma, {
      question: "Which DB engine?",
      selectedDecision: "PostgreSQL via Prisma",
      alternatives: ["SQLite", "MongoDB"],
      rationale: "Migrations + strong typing",
      decisionOwner: "test-suite",
      userOverride: false,
    });

    const entries = await listDecisionJournalEntries(prisma);
    expect(entries.some((e) => e.question === "Which DB engine?")).toBe(true);
  });

  it("filters to human-override entries only", async () => {
    await createDecisionJournalEntry(prisma, {
      question: "Override test",
      selectedDecision: "Chris's choice",
      rationale: "Chris overrode the specialist recommendation",
      decisionOwner: "chris",
      userOverride: true,
    });

    const overrides = await listDecisionJournalEntries(prisma, { userOverrideOnly: true });
    expect(overrides.every((e) => e.userOverride)).toBe(true);
    expect(overrides.some((e) => e.question === "Override test")).toBe(true);
  });
});
