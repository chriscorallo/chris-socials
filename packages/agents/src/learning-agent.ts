import type { ModelProvider } from "./model-provider";
import { buildSystemPrompt } from "./prompt-context";
import { BeliefProposalOutputSchema, type BeliefProposalOutput } from "./schemas";

export interface EvidenceEntrySummary {
  id: string;
  statement: string;
  sourceType: string;
  confidence: number;
}

function buildUserPrompt(input: { evidence: EvidenceEntrySummary[]; brandContext: string }): string {
  const evidenceList = input.evidence
    .map((e) => `- [${e.id}] (${e.sourceType}, confidence ${e.confidence}) ${e.statement}`)
    .join("\n");

  return `${input.brandContext}

## Evidence Ledger entries available to you

${evidenceList}

## Task

Propose a durable belief per your instructions above, if the evidence genuinely supports one.
Cite the evidence you're drawing on by restating its statement text in \`evidenceStatements\`
(not by inventing an id — the caller resolves your statements back to real Evidence Ledger
entries). Do not propose a belief the evidence doesn't actually support just because you were
asked to look.`;
}

/** Propose only — see /docs/ARCHITECTURE.md's authority enforcement and
 * packages/domain/src/belief.ts, which is the only place a `BeliefProposal` can ever become an
 * accepted `Belief`, and only via a human actor. */
export async function runLearningAgent(
  provider: ModelProvider,
  input: { evidence: EvidenceEntrySummary[]; brandContext: string },
): Promise<BeliefProposalOutput> {
  if (input.evidence.length === 0) {
    throw new Error("runLearningAgent requires at least one Evidence Ledger entry.");
  }

  const { systemPrompt, modelClass } = buildSystemPrompt("LEARNING_AGENT");
  const result = await provider.completeStructured({
    modelClass,
    systemPrompt,
    userPrompt: buildUserPrompt(input),
    schema: BeliefProposalOutputSchema,
    promptId: "LEARNING_AGENT",
  });

  return result.output;
}
