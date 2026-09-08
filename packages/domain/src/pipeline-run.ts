import type { PrismaClient, ContentState } from "@prisma/client";
import { z } from "zod";
import { applyTransition } from "./state-machine";
import { recordAudit } from "./audit";

/**
 * Persists the Research -> Claims Gate -> Script pipeline's output (packages/agents' Phase 2
 * pipeline) and drives the corresponding state transitions. Deliberately does NOT import
 * types from @chris/agents — packages/domain must not depend on packages/agents (see
 * /docs/ARCHITECTURE.md's package boundaries: agents depends on domain, never the reverse).
 * These schemas mirror packages/agents/src/schemas.ts by hand.
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

export const PipelineResultInputSchema = z.object({
  status: z.enum(["NEEDS_MORE_RESEARCH", "UNSUPPORTED", "OUT_OF_SCOPE", "RESEARCH_BLOCKED", "READY"]),
  research: ResearchInputSchema,
  claimsGateResult: z.unknown().optional(),
  script: ScriptInputSchema.optional(),
  brandGuardianReport: z.unknown().optional(),
});

export type PipelineResultInput = z.infer<typeof PipelineResultInputSchema>;

/**
 * Applies one pipeline run's result to a ContentItem currently in RESEARCHING:
 * - NEEDS_MORE_RESEARCH / UNSUPPORTED / OUT_OF_SCOPE: records the packet, no transition
 *   (research is incomplete — stays in RESEARCHING for a human decision or a re-run).
 * - RESEARCH_BLOCKED: records the packet (with its Claims Gate result), transitions to
 *   RESEARCH_BLOCKED. No script is ever drafted from blocked research — this is the code-level
 *   enforcement of the hard gate described in /docs/ARCHITECTURE.md.
 * - READY: records the packet, advances RESEARCHING -> RESEARCHED -> SCRIPTING -> SCRIPTED,
 *   and records the script (with its Brand Guardian report).
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

  if (
    parsed.status === "NEEDS_MORE_RESEARCH" ||
    parsed.status === "UNSUPPORTED" ||
    parsed.status === "OUT_OF_SCOPE"
  ) {
    return { researchRow, scriptRow: null };
  }

  if (parsed.status === "RESEARCH_BLOCKED") {
    const blockReason =
      (parsed.claimsGateResult as { blockReason?: string } | undefined)?.blockReason ??
      "Claims Gate BLOCK";
    await applyTransition(prisma, {
      contentItemId,
      to: "RESEARCH_BLOCKED",
      actorType: "SYSTEM",
      actorId: actor.actorId,
      reason: blockReason,
    });
    return { researchRow, scriptRow: null };
  }

  // READY
  if (!parsed.script) {
    throw new Error("Pipeline status READY but no script was provided.");
  }

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

  const scriptRow = await prisma.scriptVersion.create({
    data: {
      contentItemId,
      researchPacketId: researchRow.id,
      spokenScript: parsed.script.spokenScript,
      beats: parsed.script.beats as never,
      intendedPauses: parsed.script.intendedPauses as never,
      emphasizedWords: parsed.script.emphasizedWords as never,
      visualBeats: parsed.script.visualBeats as never,
      requiredFactualCaveats: parsed.script.requiredFactualCaveats as never,
      targetRuntimeSeconds: parsed.script.targetRuntimeSeconds,
      estimatedSpeakingRuntimeSeconds: parsed.script.estimatedSpeakingRuntimeSeconds,
      followUpIdeas: parsed.script.followUpIdeas as never,
      brandGuardianReport: parsed.brandGuardianReport as never,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "SCRIPT_VERSION_RECORDED",
    entityType: "ContentItem",
    entityId: contentItemId,
    after: { scriptVersionId: scriptRow.id },
  });

  await applyTransition(prisma, {
    contentItemId,
    to: "SCRIPTED",
    actorType: "SYSTEM",
    actorId: actor.actorId,
    reason: "Script drafted",
  });

  return { researchRow, scriptRow };
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
