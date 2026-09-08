import type { PrismaClient, DecisionJournalEntry } from "@prisma/client";
import { z } from "zod";

/**
 * Decision Journal. Used from Phase 0 for architectural decisions (mirrored in
 * /docs/DECISIONS.md for human readability) and, from Phase 1+, for creative/strategic
 * decisions per /docs/ARCHITECTURE.md. Every human override of a specialist recommendation
 * must be written here with userOverride = true — this is the raw material Phase 7's Taste
 * Model learns from.
 */
export const CreateDecisionJournalEntrySchema = z.object({
  question: z.string().min(1),
  selectedDecision: z.string().min(1),
  alternatives: z.array(z.string()).optional(),
  rationale: z.string().min(1),
  evidenceIds: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  decisionOwner: z.string().min(1),
  agentOrModel: z.string().optional(),
  userOverride: z.boolean().default(false),
});

// z.input, not z.infer — see /docs/DECISIONS.md's z.infer-vs-z.input note. userOverride has
// .default(false), which zod makes optional on input but required on output.
export type CreateDecisionJournalEntryInput = z.input<
  typeof CreateDecisionJournalEntrySchema
>;

export async function createDecisionJournalEntry(
  prisma: PrismaClient,
  input: CreateDecisionJournalEntryInput,
): Promise<DecisionJournalEntry> {
  const parsed = CreateDecisionJournalEntrySchema.parse(input);
  return prisma.decisionJournalEntry.create({
    data: {
      question: parsed.question,
      selectedDecision: parsed.selectedDecision,
      alternatives: parsed.alternatives ?? undefined,
      rationale: parsed.rationale,
      evidenceIds: parsed.evidenceIds ?? undefined,
      confidence: parsed.confidence,
      decisionOwner: parsed.decisionOwner,
      agentOrModel: parsed.agentOrModel,
      userOverride: parsed.userOverride,
    },
  });
}

export async function listDecisionJournalEntries(
  prisma: PrismaClient,
  opts?: { userOverrideOnly?: boolean },
): Promise<DecisionJournalEntry[]> {
  return prisma.decisionJournalEntry.findMany({
    where: opts?.userOverrideOnly ? { userOverride: true } : undefined,
    orderBy: { createdAt: "desc" },
  });
}

export async function recordRetrospective(
  prisma: PrismaClient,
  id: string,
  input: { laterOutcome: string; retrospective: string },
): Promise<DecisionJournalEntry> {
  return prisma.decisionJournalEntry.update({
    where: { id },
    data: input,
  });
}
