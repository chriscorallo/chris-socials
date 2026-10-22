import type { PrismaClient, ContentState } from "@prisma/client";
import { z } from "zod";
import { applyTransition } from "./state-machine";
import { recordAudit } from "./audit";
import { MAX_REPAIR_ATTEMPTS } from "./render-record";
import { recordApprovedOutcome } from "./autonomy";

/**
 * Phase 4 — Hard Gates (spec §9 step 16: `FACTUAL: PASS`, `TECHNICAL: PASS`, `BRAND:
 * threshold`, `CREATIVE: threshold`) and the RENDERED -> READY / QC_REPAIR decision they
 * drive. Two halves, deliberately separated:
 *
 * 1. `aggregateHardGates` — pure, deterministic, no I/O. This is the exact function
 *    /docs/ARCHITECTURE.md promises: "the function that aggregates a QCReport or
 *    ClaimsGateResult cannot silently average a BLOCK into a passing composite — its return
 *    type makes that impossible to express." Every gate here is already reduced to PASS/BLOCK
 *    by the time it reaches this function (score-vs-threshold conversion happens in the
 *    caller, below) — there is no numeric input this function could average even by mistake.
 * 2. `recordQualityGateResult` — persists the QCReport/QCIssue rows and drives the state
 *    machine transition, mirroring render-record.ts's own RENDERED -> QC_REPAIR ->
 *    (retry | QC_BLOCKED) loop rather than inventing a second one. A Quality Gate BLOCK is
 *    just another reason a render attempt needs repair — it shares the same
 *    MAX_REPAIR_ATTEMPTS budget, keyed off the same Render.attempt counter.
 */

export type GateStatus = "PASS" | "BLOCK";

export interface HardGateInputs {
  factual: GateStatus;
  technical: GateStatus;
  brand: GateStatus;
  creative: GateStatus;
}

export interface HardGateAggregationResult {
  overall: GateStatus;
  gates: HardGateInputs;
  /** One entry per BLOCKing gate, in a fixed FACTUAL/TECHNICAL/BRAND/CREATIVE order — never
   * silently dropped, and never collapsed into a single opaque "failed" boolean. */
  reasons: string[];
}

const GATE_ORDER: (keyof HardGateInputs)[] = ["factual", "technical", "brand", "creative"];

/**
 * OR the four gates together. That's the entire algorithm — there is deliberately no scoring,
 * no weighting, no averaging anywhere in this function, because the authority model
 * (/docs/ARCHITECTURE.md) requires that a single hard-gate BLOCK can never be offset by
 * strength anywhere else. See packages/domain/src/__tests__/quality-gate.test.ts for the
 * regression test this exists to satisfy: a BLOCK on one gate produces an overall BLOCK
 * regardless of how strongly the other three gates PASS.
 */
export function aggregateHardGates(
  gates: HardGateInputs,
  reasonsByGate: Partial<Record<keyof HardGateInputs, string>> = {},
): HardGateAggregationResult {
  const reasons: string[] = [];
  for (const gate of GATE_ORDER) {
    if (gates[gate] === "BLOCK") {
      reasons.push(reasonsByGate[gate] ?? `${gate.toUpperCase()} gate: BLOCK`);
    }
  }
  return { overall: reasons.length > 0 ? "BLOCK" : "PASS", gates, reasons };
}

/**
 * BRAND and CREATIVE are spec-named hard gates (§9 step 16) but no single existing agent
 * output is literally labelled either name — Brand Guardian (Phase 2) produces
 * brandScore/voiceScore/originalityScore instead (see /docs/AGENT_CONTRACTS.md). Mapping
 * decision, logged in /docs/DECISIONS.md: BRAND = brandScore + voiceScore (both must clear
 * the threshold — voice is part of what "brand" means here), CREATIVE = originalityScore (the
 * closest existing numeric proxy for non-derivative creative execution). Thresholds are
 * plain exported constants, not hardcoded inline, specifically so they're one place to change
 * without touching the aggregation logic itself — reversible by construction.
 */
export const DEFAULT_BRAND_SCORE_THRESHOLD = 70;
export const DEFAULT_CREATIVE_SCORE_THRESHOLD = 60;

export function brandGateFromScores(
  brandScore: number,
  voiceScore: number,
  threshold: number = DEFAULT_BRAND_SCORE_THRESHOLD,
): GateStatus {
  return brandScore >= threshold && voiceScore >= threshold ? "PASS" : "BLOCK";
}

export function creativeGateFromScore(
  originalityScore: number,
  threshold: number = DEFAULT_CREATIVE_SCORE_THRESHOLD,
): GateStatus {
  return originalityScore >= threshold ? "PASS" : "BLOCK";
}

/** A BLOCKING-severity finding (from Visual QA or the deterministic overlay-collision check)
 * escalates straight to a TECHNICAL gate BLOCK — see /docs/AGENT_CONTRACTS.md's Visual QA row
 * ("Feeds TECHNICAL/BRAND hard gate, doesn't itself issue BLOCK"). MAJOR/MINOR/INFO findings
 * are recorded (queryable evidence, and future auto-repair fodder) but never block on their
 * own — only BLOCKING does. */
export function technicalGateFromIssues(
  baseStatus: GateStatus,
  issues: { severity: "INFO" | "MINOR" | "MAJOR" | "BLOCKING" }[],
): GateStatus {
  if (baseStatus === "BLOCK") return "BLOCK";
  return issues.some((issue) => issue.severity === "BLOCKING") ? "BLOCK" : "PASS";
}

// --- Persistence ---

export class QualityGateRequiresRenderedStateError extends Error {
  constructor(actual: ContentState) {
    super(`The quality gate can only run from RENDERED (current state: ${actual}).`);
    this.name = "QualityGateRequiresRenderedStateError";
  }
}

const QCIssueInputSchema = z.object({
  category: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(["INFO", "MINOR", "MAJOR", "BLOCKING"]),
  timestampSeconds: z.number().nullable().optional(),
  recommendedRepair: z.string().nullable().optional(),
  source: z.enum(["VISUAL_QA", "OVERLAY_COLLISION", "SPLICE_AUDIT"]),
});
export type QCIssueInput = z.input<typeof QCIssueInputSchema>;

const RecordQualityGateResultSchema = z.object({
  contentItemId: z.string().min(1),
  renderId: z.string().min(1),
  gates: z.object({
    factual: z.enum(["PASS", "BLOCK"]),
    technical: z.enum(["PASS", "BLOCK"]),
    brand: z.enum(["PASS", "BLOCK"]),
    creative: z.enum(["PASS", "BLOCK"]),
  }),
  reasons: z.array(z.string()).default([]),
  visualQAImpression: z.string().nullable().optional(),
  issues: z.array(QCIssueInputSchema).default([]),
});
export type RecordQualityGateResultInput = z.input<typeof RecordQualityGateResultSchema>;

/**
 * Persists one Quality Gate run and drives RENDERED -> READY (overall PASS) or RENDERED ->
 * QC_REPAIR (overall BLOCK, escalating to QC_BLOCKED if this render's attempt count already
 * exhausted MAX_REPAIR_ATTEMPTS) — exactly render-record.ts's own repair-loop shape, reused
 * rather than duplicated.
 */
export async function recordQualityGateResult(
  prisma: PrismaClient,
  input: RecordQualityGateResultInput,
  actor: { actorId: string },
) {
  const parsed = RecordQualityGateResultSchema.parse(input);

  const item = await prisma.contentItem.findUniqueOrThrow({
    where: { id: parsed.contentItemId },
  });
  if (item.currentState !== "RENDERED") {
    throw new QualityGateRequiresRenderedStateError(item.currentState);
  }

  const render = await prisma.render.findUniqueOrThrow({ where: { id: parsed.renderId } });

  const { qcReport, aggregation, reasons } = await persistQCReport(prisma, parsed, actor);

  if (aggregation.overall === "PASS") {
    await applyTransition(prisma, {
      contentItemId: parsed.contentItemId,
      to: "READY",
      actorType: "SYSTEM",
      actorId: actor.actorId,
      reason: "All hard gates PASS",
    });

    // Phase 8 — a clean pass through every hard gate on the *first* render attempt (no
    // QC_REPAIR loop needed) is a real reliability signal for this ContentItem's production
    // tier. Feeds AutonomyLevel's EDIT_PLANNING count (see /docs/DECISIONS.md — this system's
    // actual "human-approved outcome" for this subsystem is "shipped clean," not a separate
    // manual approval click, since none exists for this step today). A pass that only arrived
    // after one or more repairs is a real success but a weaker reliability signal, so it
    // deliberately doesn't count here.
    if (render.attempt === 1) {
      const editPlan = await prisma.editPlan.findUnique({ where: { id: render.editPlanId } });
      if (editPlan) {
        await recordApprovedOutcome(prisma, "EDIT_PLANNING", editPlan.productionTier, actor);
      }
    }

    return qcReport;
  }

  await applyTransition(prisma, {
    contentItemId: parsed.contentItemId,
    to: "QC_REPAIR",
    actorType: "SYSTEM",
    actorId: actor.actorId,
    reason: reasons.join("; ") || "Quality gate BLOCK",
  });

  if (render.attempt >= MAX_REPAIR_ATTEMPTS) {
    await applyTransition(prisma, {
      contentItemId: parsed.contentItemId,
      to: "QC_BLOCKED",
      actorType: "SYSTEM",
      actorId: actor.actorId,
      reason: `Quality gate failed after ${render.attempt} render attempts (repair limit reached)`,
    });
  }

  return qcReport;
}

export class LateQualityCheckNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LateQualityCheckNotAllowedError";
  }
}

/**
 * "Run the AI check now" — the full Quality Gate on a render the OWNER already sent to READY
 * without it (QualityOverride; docs/decisions-pending/quality-override.md). Records the
 * QCReport for that render but makes NO state transition: the video stays where Chris put it.
 * Preflight then uses the newer record (renderPublishApproval) — a PASS is a normal approval,
 * a BLOCK stops it posting until Chris edits it (a real hard-gate finding still blocks).
 * Only for the latest successful render, only when it carries an owner override, only while
 * the video hasn't started publishing.
 */
export async function recordLateQualityCheck(
  prisma: PrismaClient,
  input: RecordQualityGateResultInput,
  actor: { actorId: string },
) {
  const parsed = RecordQualityGateResultSchema.parse(input);
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: parsed.contentItemId } });
  if (item.currentState !== "READY" && item.currentState !== "SCHEDULED") {
    throw new LateQualityCheckNotAllowedError(`The AI check can only be added to a ready or scheduled video (this one is ${item.currentState}).`);
  }
  const latest = await prisma.render.findFirst({ where: { contentItemId: parsed.contentItemId, status: "SUCCESS" }, orderBy: { createdAt: "desc" } });
  if (!latest || latest.id !== parsed.renderId) {
    throw new LateQualityCheckNotAllowedError("That isn't the video's latest render.");
  }
  const override = await prisma.qualityOverride.findFirst({ where: { renderId: parsed.renderId } });
  if (!override) {
    throw new LateQualityCheckNotAllowedError("This video already went through the quality check.");
  }
  const { qcReport } = await persistQCReport(prisma, parsed, actor, "QUALITY_GATE_RECORDED_AFTER_OWNER_OVERRIDE");
  return qcReport;
}

async function persistQCReport(
  prisma: PrismaClient,
  parsed: z.output<typeof RecordQualityGateResultSchema>,
  actor: { actorId: string },
  auditAction = "QUALITY_GATE_RECORDED",
) {
  const aggregation = aggregateHardGates(parsed.gates);
  const reasons = parsed.reasons.length > 0 ? parsed.reasons : aggregation.reasons;

  // Two sequential writes, not one nested create — this sandbox's PGlite dev database has
  // already shown it can't be trusted with compound/concurrent Prisma operations it wasn't
  // exercised against (see /docs/DECISIONS.md, the Promise.all and nested-include findings
  // from Phases 2-3); a nested `issues: { create: [...] }` write is untested territory here,
  // so this stays as two plain queries instead of one clever one.
  const qcReport = await prisma.qCReport.create({
    data: {
      contentItemId: parsed.contentItemId,
      renderId: parsed.renderId,
      factualStatus: parsed.gates.factual,
      technicalStatus: parsed.gates.technical,
      brandStatus: parsed.gates.brand,
      creativeStatus: parsed.gates.creative,
      overallStatus: aggregation.overall,
      reasons: reasons as never,
      visualQAImpression: parsed.visualQAImpression ?? null,
    },
  });

  if (parsed.issues.length > 0) {
    await prisma.qCIssue.createMany({
      data: parsed.issues.map((issue) => ({
        qcReportId: qcReport.id,
        category: issue.category,
        description: issue.description,
        severity: issue.severity,
        timestampSeconds: issue.timestampSeconds ?? null,
        recommendedRepair: issue.recommendedRepair ?? null,
        source: issue.source,
      })),
    });
  }

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "SYSTEM",
    action: auditAction,
    entityType: "ContentItem",
    entityId: parsed.contentItemId,
    after: { qcReportId: qcReport.id, overallStatus: aggregation.overall, gates: parsed.gates },
  });

  return { qcReport, aggregation, reasons };
}

export async function getLatestQCReport(prisma: PrismaClient, contentItemId: string) {
  return prisma.qCReport.findFirst({
    where: { contentItemId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getQCIssuesForReport(prisma: PrismaClient, qcReportId: string) {
  return prisma.qCIssue.findMany({
    where: { qcReportId },
    orderBy: { createdAt: "asc" },
  });
}
