import type { PrismaClient, ContentState, Prisma } from "@prisma/client";
import { z } from "zod";
import { applyTransition } from "./state-machine";
import { recordAudit } from "./audit";
import { journalDecision } from "./decision-journal";

/**
 * Persists the Research -> Claims Gate -> Script -> Claims Gate (script) -> Brand Guardian
 * pipeline's output (packages/agents) and drives the corresponding state transitions.
 * Deliberately does NOT import types from @chris/agents — packages/domain must not depend on
 * packages/agents. These schemas mirror packages/agents/src/schemas.ts by hand.
 *
 * Script-level BLOCK state decision (docs/decisions-pending/ai.md): the state machine has no
 * SCRIPT_BLOCKED state and we don't add one. A script the Claims Gate won't pass routes the
 * item RESEARCHING -> RESEARCH_BLOCKED (the factual-hard-gate state), with the blocked script
 * recorded alongside its BLOCK result. That state is already surfaced in NEEDS YOU
 * (FACTUAL_NUANCE) and has both recovery paths: rollback to RESEARCHING to re-run, or a human
 * edit that re-gates PASS (script-version.ts walks RESEARCH_BLOCKED -> ... -> SCRIPTED).
 */

export class PipelineRequiresResearchingStateError extends Error {
  constructor(actual: ContentState) {
    super(`The pipeline can only be applied from RESEARCHING (current state: ${actual}).`);
    this.name = "PipelineRequiresResearchingStateError";
  }
}

const ResearchInputSchema = z.object({
  primaryClaim: z.string(),
  facts: z.unknown(),
  citations: z.unknown(),
  numericInputs: z.unknown(),
  calculationNotes: z.string().nullable().optional(),
  caveats: z.unknown(),
  confidence: z.number(),
  contradictoryEvidence: z.unknown(),
  prohibitedClaims: z.unknown(),
  contentSafeWording: z.string(),
  status: z.enum(["READY", "NEEDS_MORE_RESEARCH", "UNSUPPORTED", "OUT_OF_SCOPE"]),
  stopResearching: z.boolean(),
});

const ScriptInputSchema = z.object({
  spokenScript: z.string(),
  beats: z.unknown(),
  intendedPauses: z.unknown(),
  emphasizedWords: z.unknown(),
  visualBeats: z.unknown(),
  requiredFactualCaveats: z.unknown(),
  targetRuntimeSeconds: z.number(),
  estimatedSpeakingRuntimeSeconds: z.number(),
  followUpIdeas: z.unknown(),
});

const GateResultSchema = z
  .object({
    result: z.enum(["PASS", "PASS_WITH_REQUIRED_EDIT", "BLOCK"]),
    blockReason: z.string().nullable().optional(),
    requiredEdits: z.array(z.string()).optional(),
  })
  .passthrough();

const ScriptAttemptSchema = z.object({
  script: ScriptInputSchema,
  scriptClaimsGateResult: GateResultSchema,
  brandGuardianReport: z.unknown().nullable().optional(),
  revisionNote: z.string().nullable().optional(),
});

export const PipelineResultInputSchema = z.object({
  status: z.enum([
    "NEEDS_MORE_RESEARCH",
    "UNSUPPORTED",
    "OUT_OF_SCOPE",
    "RESEARCH_BLOCKED",
    "SCRIPT_BLOCKED",
    "READY",
  ]),
  research: ResearchInputSchema,
  claimsGateResult: z.unknown().optional(),
  script: ScriptInputSchema.optional(),
  /** Claims Gate verdict on the FINAL script's wording. */
  scriptClaimsGateResult: GateResultSchema.optional(),
  brandGuardianReport: z.unknown().optional(),
  /** Every gated script version in order (final last). Persisted as a revisedFromId chain. */
  scriptHistory: z.array(ScriptAttemptSchema).optional(),
  blockReason: z.string().optional(),
});

export type PipelineResultInput = z.input<typeof PipelineResultInputSchema>;
type ParsedScript = z.infer<typeof ScriptInputSchema>;

function scriptData(contentItemId: string, researchPacketId: string, s: ParsedScript) {
  return {
    contentItemId,
    researchPacketId,
    spokenScript: s.spokenScript,
    beats: s.beats as never,
    intendedPauses: s.intendedPauses as never,
    emphasizedWords: s.emphasizedWords as never,
    visualBeats: s.visualBeats as never,
    requiredFactualCaveats: s.requiredFactualCaveats as never,
    targetRuntimeSeconds: Math.round(s.targetRuntimeSeconds),
    estimatedSpeakingRuntimeSeconds: Math.round(s.estimatedSpeakingRuntimeSeconds),
    followUpIdeas: s.followUpIdeas as never,
  } satisfies Prisma.ScriptVersionUncheckedCreateInput;
}

/** Writes the script history as an append-only revisedFromId chain; returns the final row. */
async function persistScripts(
  prisma: PrismaClient,
  contentItemId: string,
  researchPacketId: string,
  parsed: z.infer<typeof PipelineResultInputSchema>,
  actorId: string,
) {
  const attempts =
    parsed.scriptHistory && parsed.scriptHistory.length > 0
      ? parsed.scriptHistory
      : [
          {
            script: parsed.script!,
            scriptClaimsGateResult: parsed.scriptClaimsGateResult,
            brandGuardianReport: parsed.brandGuardianReport,
            revisionNote: null,
          },
        ];

  let previousId: string | null = null;
  let row = null;
  for (const [i, attempt] of attempts.entries()) {
    const isFinal = i === attempts.length - 1;
    row = await prisma.scriptVersion.create({
      data: {
        ...scriptData(contentItemId, researchPacketId, attempt.script),
        scriptClaimsGateResult: (attempt.scriptClaimsGateResult ?? undefined) as never,
        brandGuardianReport: ((isFinal ? (attempt.brandGuardianReport ?? parsed.brandGuardianReport) : attempt.brandGuardianReport) ?? undefined) as never,
        authorType: "AGENT",
        revisedFromId: previousId,
        revisionNote: attempt.revisionNote ?? null,
      },
    });
    previousId = row.id;
    await recordAudit(prisma, {
      actor: actorId,
      actorType: "HUMAN",
      action: "SCRIPT_VERSION_RECORDED",
      entityType: "ContentItem",
      entityId: contentItemId,
      after: {
        scriptVersionId: row.id,
        revisedFromId: row.revisedFromId,
        scriptClaimsGate: attempt.scriptClaimsGateResult?.result ?? null,
      },
    });
  }
  return row!;
}

/**
 * Applies one pipeline run's result to a ContentItem currently in RESEARCHING:
 * - NEEDS_MORE_RESEARCH / UNSUPPORTED / OUT_OF_SCOPE: records the packet, no transition.
 * - RESEARCH_BLOCKED: records the packet (with its Claims Gate result), -> RESEARCH_BLOCKED.
 *   No script is ever drafted from blocked research.
 * - SCRIPT_BLOCKED: records the packet + every gated script version (final one carries its
 *   BLOCK / unresolved result), -> RESEARCH_BLOCKED with the script-level reason.
 * - READY: records packet + script chain, RESEARCHING -> RESEARCHED -> SCRIPTING -> SCRIPTED.
 *   Defense in depth: if the final script's own Claims Gate result is present and is not PASS,
 *   READY is downgraded to SCRIPT_BLOCKED — no unchecked or failed script reaches SCRIPTED.
 */
export async function applyPipelineResult(
  prisma: PrismaClient,
  contentItemId: string,
  result: PipelineResultInput,
  actor: { actorId: string },
) {
  const parsed = PipelineResultInputSchema.parse(result);

  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (item.currentState !== "RESEARCHING") {
    throw new PipelineRequiresResearchingStateError(item.currentState);
  }

  let status = parsed.status;
  if (status === "READY" && parsed.scriptClaimsGateResult && parsed.scriptClaimsGateResult.result !== "PASS") {
    status = "SCRIPT_BLOCKED";
  }

  const researchRow = await prisma.researchPacket.create({
    data: {
      contentItemId,
      primaryClaim: parsed.research.primaryClaim,
      facts: parsed.research.facts as never,
      citations: parsed.research.citations as never,
      numericInputs: parsed.research.numericInputs as never,
      calculationNotes: parsed.research.calculationNotes ?? null,
      caveats: parsed.research.caveats as never,
      confidence: parsed.research.confidence,
      contradictoryEvidence: parsed.research.contradictoryEvidence as never,
      prohibitedClaims: parsed.research.prohibitedClaims as never,
      contentSafeWording: parsed.research.contentSafeWording,
      status: parsed.research.status,
      stopResearching: parsed.research.stopResearching,
      claimsGateResult: parsed.claimsGateResult as never,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "RESEARCH_PACKET_RECORDED",
    entityType: "ContentItem",
    entityId: contentItemId,
    after: { researchPacketId: researchRow.id, status: researchRow.status },
  });

  if (status === "NEEDS_MORE_RESEARCH" || status === "UNSUPPORTED" || status === "OUT_OF_SCOPE") {
    return { researchRow, scriptRow: null, appliedStatus: status };
  }

  if (status === "RESEARCH_BLOCKED") {
    const blockReason =
      (parsed.claimsGateResult as { blockReason?: string } | undefined)?.blockReason ?? "Claims Gate BLOCK";
    await applyTransition(prisma, {
      contentItemId,
      to: "RESEARCH_BLOCKED",
      actorType: "SYSTEM",
      actorId: actor.actorId,
      reason: blockReason,
    });
    await journalDecision(prisma, {
      question: `Is the research for "${item.title}" factually safe to script?`,
      selectedDecision: "BLOCK (research level)",
      alternatives: ["PASS", "PASS_WITH_REQUIRED_EDIT"],
      rationale: blockReason,
      decisionOwner: "CLAIMS_GATE",
      agentOrModel: "CLAIMS_GATE",
    });
    return { researchRow, scriptRow: null, appliedStatus: status };
  }

  if (!parsed.script) {
    throw new Error(`Pipeline status ${status} but no script was provided.`);
  }

  if (status === "SCRIPT_BLOCKED") {
    const scriptRow = await persistScripts(prisma, contentItemId, researchRow.id, parsed, actor.actorId);
    const gate = parsed.scriptClaimsGateResult;
    const reason =
      parsed.blockReason ??
      (gate?.result === "BLOCK"
        ? `Script-level Claims Gate BLOCK: ${gate.blockReason ?? "no reason given"}`
        : `Script-level Claims Gate did not PASS (${gate?.result ?? "no result"})`);
    await applyTransition(prisma, {
      contentItemId,
      to: "RESEARCH_BLOCKED",
      actorType: "SYSTEM",
      actorId: actor.actorId,
      reason,
    });
    await journalDecision(prisma, {
      question: `Is the final script for "${item.title}" factually safe to film?`,
      selectedDecision: `BLOCK (script level) after ${(parsed.scriptHistory?.length ?? 1) - 1} revision(s)`,
      alternatives: ["PASS", "PASS_WITH_REQUIRED_EDIT + another revision", "Human edit + re-gate"],
      rationale: reason,
      decisionOwner: "CLAIMS_GATE",
      agentOrModel: "CLAIMS_GATE",
      evidenceIds: [scriptRow.id],
    });
    return { researchRow, scriptRow, appliedStatus: status };
  }

  // READY
  await applyTransition(prisma, {
    contentItemId,
    to: "RESEARCHED",
    actorType: "SYSTEM",
    actorId: actor.actorId,
    reason: "Claims Gate PASS",
  });
  await applyTransition(prisma, {
    contentItemId,
    to: "SCRIPTING",
    actorType: "SYSTEM",
    actorId: actor.actorId,
    reason: "Script Agent started",
  });

  const scriptRow = await persistScripts(prisma, contentItemId, researchRow.id, parsed, actor.actorId);

  await applyTransition(prisma, {
    contentItemId,
    to: "SCRIPTED",
    actorType: "SYSTEM",
    actorId: actor.actorId,
    reason: parsed.scriptClaimsGateResult ? "Script drafted; script-level Claims Gate PASS" : "Script drafted",
  });

  const revisions = (parsed.scriptHistory?.length ?? 1) - 1;
  if (revisions > 0) {
    await journalDecision(prisma, {
      question: `Which script version for "${item.title}" goes to filming?`,
      selectedDecision: `Revision ${revisions} (final gated version ${scriptRow.id})`,
      alternatives: ["First draft (failed or needed edits)", "Human rewrite"],
      rationale: (parsed.scriptHistory ?? [])
        .map((a) => a.revisionNote)
        .filter(Boolean)
        .join(" / "),
      decisionOwner: "PIPELINE",
      agentOrModel: "SCRIPT + CLAIMS_GATE + BRAND_GUARDIAN",
      evidenceIds: [scriptRow.id],
    });
  }

  return { researchRow, scriptRow, appliedStatus: status };
}

export async function getLatestResearchPacket(prisma: PrismaClient, contentItemId: string) {
  return prisma.researchPacket.findFirst({
    where: { contentItemId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getLatestScriptVersion(prisma: PrismaClient, contentItemId: string) {
  return prisma.scriptVersion.findFirst({
    where: { contentItemId },
    orderBy: { createdAt: "desc" },
  });
}
