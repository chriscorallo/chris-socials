import type { PrismaClient, QualityOverride } from "@prisma/client";
import { recordAudit } from "./audit";
import { setFlag } from "./feature-flags";
import { writeTransition } from "./state-machine";
import { CreateDecisionJournalEntrySchema } from "./decision-journal";
import { OWNER_GUARDED_TRANSITIONS } from "./manual-transition";

/**
 * Owner override: "skip the AI quality check" — Chris's explicit decision, as the human owner
 * (spec §5: the owner is #1, above the hard gates), to send ONE render to READY without the
 * AI-powered checks (Visual QA, brand/voice, creative, AI fact-check) — typically because the
 * AI has no credit yet. See docs/decisions-pending/quality-override.md.
 *
 * This is deliberately NOT a weakening of the Quality Gate:
 * - It never touches `aggregateHardGates` — no score, no average, no PASS is invented. The
 *   AI gates are recorded as SKIPPED BY THE OWNER, in a separate `QualityOverride` row; no
 *   QCReport is written claiming they passed.
 * - The free, deterministic TECHNICAL gate always runs first; a technical BLOCK refuses the
 *   override (enforced in the type of `technical` below AND re-checked against the stored
 *   render). The owner outranks gates, but not physics — a broken file can't be posted.
 * - On-screen numbers without a verified source need a per-video "I've checked the numbers
 *   in this video" confirmation (the FACTUAL gate is the one the owner must attest to).
 * - It is only possible while the owner's setting is "Let me skip it" (default: Firm).
 * - Every override writes a DecisionJournalEntry (userOverride), an AuditLog row and a HUMAN
 *   ContentStateTransition RENDERED -> READY, in one transaction.
 */

/** Feature flag: ON = "Let me skip it"; OFF/absent (default) = Firm. */
export const QUALITY_SKIP_AI_FLAG = "quality.owner_may_skip_ai_check";

export type QualityCheckMode = "FIRM" | "SKIP_ALLOWED";

export async function getQualityCheckMode(prisma: PrismaClient): Promise<QualityCheckMode> {
  const flag = await prisma.featureFlag.findUnique({ where: { key: QUALITY_SKIP_AI_FLAG } });
  return flag?.enabled ? "SKIP_ALLOWED" : "FIRM";
}

/** Chris's setting — audit-logged (setFlag). */
export async function setQualityCheckMode(prisma: PrismaClient, mode: QualityCheckMode, actorId: string): Promise<void> {
  await setFlag(prisma, {
    key: QUALITY_SKIP_AI_FLAG,
    enabled: mode === "SKIP_ALLOWED",
    description:
      "Quality check before scheduling: ON = 'Let me skip it' (the owner may send a video to the calendar without the AI checks, after the free technical check passes). OFF (default) = Firm.",
    actor: actorId,
    actorType: "HUMAN",
  });
}

/** Plain labels for what the override skips (stored on the row + shown in the UI). */
export const AI_QUALITY_CHECKS = {
  VISUAL_QA: "AI picture check (Visual QA)",
  BRAND: "Brand & voice review",
  CREATIVE: "Creative / originality review",
  FACTUAL: "AI fact-check of the claims",
} as const;

/** What always still runs, in plain words (UI copy, decision record). */
export const ALWAYS_RUN_CHECKS = [
  "The render exists and the file is valid",
  "Length, size, codec and loudness are within the platforms' limits",
  "No missing media",
  "No text or captions colliding on screen",
] as const;

/** An AI error that means "the AI can't run right now" (not a transient blip) → plain reason,
 * or null when the error is something else (that one stays an error). Pure. */
export function aiUnavailableReason(err: { name?: string; message?: string } | null | undefined): string | null {
  if (!err) return null;
  const name = err.name ?? "";
  const msg = err.message ?? "";
  if (name === "SpendCapExceededError" || /spend ?cap|spending limit/i.test(msg)) return "Today's AI spending limit was reached";
  if (/credit balance|billing|insufficient|quota|payment required/i.test(msg)) return "The AI account is out of credit";
  if (/api[_ ]?key|authentication|x-api-key|401|No Anthropic/i.test(msg)) return "No Anthropic API key is set up";
  return null;
}

export class QualityOverrideNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityOverrideNotAllowedError";
  }
}

/** The video shows numbers/claims without a verified source and Chris hasn't confirmed them. */
export class FactualConfirmationRequiredError extends Error {
  constructor(public readonly unverifiedClaims: string[]) {
    super(`Confirm you've checked the numbers in this video first: ${unverifiedClaims.join("; ")}`);
    this.name = "FactualConfirmationRequiredError";
  }
}

/** The free technical gate's verdict. Only a PASS can be handed to the override — a BLOCK is
 * not expressible here, by type, so a technical failure can never be "overridden". */
export interface TechnicalGatePass {
  status: "PASS";
  renderId: string;
  /** Non-blocking deterministic findings (kept for the record). */
  issues: Array<{ category: string; description: string; severity: string; timestampSeconds?: number | null }>;
}

export interface OwnerQualityOverrideInput {
  contentItemId: string;
  actorId: string;
  trigger: "AI_UNAVAILABLE" | "OWNER_CHOICE";
  /** Required for AI_UNAVAILABLE (e.g. "The AI account is out of credit"). */
  aiUnavailableReason?: string | null;
  technical: TechnicalGatePass;
  /** Which AI checks are being skipped (labels from AI_QUALITY_CHECKS). */
  skippedChecks: string[];
  /** On-screen numbers/claims without a verified source (empty = nothing to confirm). */
  unverifiedClaims: string[];
  factualConfirmed: boolean;
}

const OVERRIDE_TRANSITION = OWNER_GUARDED_TRANSITIONS.find((t) => t.from === "RENDERED" && t.to === "READY")!;

/**
 * Applies the owner override: RENDERED -> READY (actorType HUMAN) for the exact render the
 * technical check ran on. Idempotent per render: a repeat for an already-overridden render
 * returns the existing row without writing anything.
 */
export async function applyOwnerQualityOverride(prisma: PrismaClient, input: OwnerQualityOverrideInput): Promise<QualityOverride> {
  const renderId = input.technical.renderId;
  const existing = await prisma.qualityOverride.findFirst({ where: { contentItemId: input.contentItemId, renderId }, orderBy: { createdAt: "desc" } });
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: input.contentItemId }, select: { currentState: true, title: true } });
  if (existing && item.currentState !== "RENDERED") return existing;

  if ((await getQualityCheckMode(prisma)) !== "SKIP_ALLOWED") {
    throw new QualityOverrideNotAllowedError(
      "The quality check is set to Firm, so the AI check can't be skipped. Switch to 'Let me skip it' (More → AI credit) or add credit.",
    );
  }
  if (item.currentState !== OVERRIDE_TRANSITION.from) {
    throw new QualityOverrideNotAllowedError(
      `Only a rendered video waiting for its check can skip the AI check (this one is ${item.currentState.toLowerCase().replace(/_/g, " ")}).`,
    );
  }
  if (input.trigger === "AI_UNAVAILABLE" && !input.aiUnavailableReason?.trim()) {
    throw new QualityOverrideNotAllowedError("An 'AI unavailable' override needs the reason the AI couldn't run.");
  }
  // Defense in depth: re-check the technical verdict against what's stored, not just the type.
  if ((input.technical as { status: string }).status !== "PASS") {
    throw new QualityOverrideNotAllowedError("The technical check didn't pass — a technical problem can't be skipped.");
  }
  const latest = await prisma.render.findFirst({ where: { contentItemId: input.contentItemId, status: "SUCCESS" }, orderBy: { createdAt: "desc" } });
  if (!latest || latest.id !== renderId || !latest.storageKey) {
    throw new QualityOverrideNotAllowedError("The technical check ran on a different render than the latest one — run Finish again.");
  }
  if ((latest.technicalQCReport as { overall?: string } | null)?.overall !== "PASS") {
    throw new QualityOverrideNotAllowedError("The render didn't pass its technical check — a technical problem can't be skipped.");
  }
  if (input.unverifiedClaims.length > 0 && !input.factualConfirmed) {
    throw new FactualConfirmationRequiredError(input.unverifiedClaims);
  }

  const reasonText =
    input.trigger === "AI_UNAVAILABLE" ? `${input.aiUnavailableReason!.replace(/\.+$/, "")}` : "Chris chose to skip it for this video";
  const factualText =
    input.unverifiedClaims.length > 0
      ? ` Chris confirmed he checked the unverified numbers/claims himself: ${input.unverifiedClaims.join("; ")}.`
      : " No unverified on-screen numbers were found.";
  const journal = CreateDecisionJournalEntrySchema.parse({
    question: `Put "${item.title}" on the calendar without the AI quality check?`,
    selectedDecision: "Owner skipped AI quality check",
    alternatives: [
      "Wait for AI credit and run the full quality check",
      "Keep editing and render again",
      "Leave it off the calendar for now",
    ],
    rationale:
      `Reason: ${reasonText}. Skipped: ${input.skippedChecks.join(", ")}. ` +
      `The free technical check passed on render ${renderId} (file valid, length/size/codec/loudness within platform limits, no blocking on-screen collisions).` +
      factualText,
    evidenceIds: [renderId],
    decisionOwner: "Chris (owner)",
    userOverride: true,
  });

  return prisma.$transaction(async (tx) => {
    const entry = await tx.decisionJournalEntry.create({
      data: {
        question: journal.question,
        selectedDecision: journal.selectedDecision,
        alternatives: journal.alternatives,
        rationale: journal.rationale,
        evidenceIds: journal.evidenceIds,
        decisionOwner: journal.decisionOwner,
        userOverride: true,
      },
    });
    const row = await tx.qualityOverride.create({
      data: {
        contentItemId: input.contentItemId,
        renderId,
        trigger: input.trigger,
        aiUnavailableReason: input.aiUnavailableReason ?? null,
        technicalStatus: "PASS",
        technicalIssues: input.technical.issues as never,
        skippedChecks: input.skippedChecks as never,
        unverifiedClaims: input.unverifiedClaims as never,
        factualConfirmed: input.factualConfirmed,
        decisionJournalEntryId: entry.id,
        actorId: input.actorId,
      },
    });
    await recordAudit(tx, {
      actor: input.actorId,
      actorType: "HUMAN",
      action: "QUALITY_AI_CHECK_SKIPPED_BY_OWNER",
      entityType: "ContentItem",
      entityId: input.contentItemId,
      after: {
        qualityOverrideId: row.id,
        renderId,
        trigger: input.trigger,
        reason: reasonText,
        skippedChecks: input.skippedChecks,
        unverifiedClaims: input.unverifiedClaims,
        factualConfirmed: input.factualConfirmed,
        decisionJournalEntryId: entry.id,
      },
    });
    await writeTransition(tx, {
      contentItemId: input.contentItemId,
      fromState: "RENDERED",
      toState: "READY",
      reason: `${OVERRIDE_TRANSITION.label} (${reasonText}); technical check passed`,
      actorType: "HUMAN",
      actorId: input.actorId,
      idempotencyKey: `quality-override:${renderId}`,
      auditAction: "OWNER_QUALITY_OVERRIDE",
    });
    return row;
  });
}

export type AiCheckStatus =
  | { kind: "CHECKED" }
  | { kind: "SKIPPED"; override: QualityOverride }
  | { kind: "CHECKED_LATER"; override: QualityOverride; passed: boolean; reasons: string[] };

/**
 * Was the latest render scheduled without the AI check? Pure over the rows for ONE render:
 * the override counts until a newer QCReport for the same render exists ("Run the AI check
 * now"); then that report decides.
 */
export function aiCheckStatusFrom(
  override: QualityOverride | null,
  qc: { overallStatus: string; reasons: unknown; createdAt: Date } | null,
): AiCheckStatus {
  if (!override) return { kind: "CHECKED" };
  if (!qc || qc.createdAt <= override.createdAt) return { kind: "SKIPPED", override };
  return { kind: "CHECKED_LATER", override, passed: qc.overallStatus === "PASS", reasons: Array.isArray(qc.reasons) ? (qc.reasons as string[]) : [] };
}

export async function getAiCheckStatus(prisma: PrismaClient, contentItemId: string): Promise<AiCheckStatus> {
  const render = await prisma.render.findFirst({ where: { contentItemId, status: "SUCCESS" }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!render) return { kind: "CHECKED" };
  const override = await prisma.qualityOverride.findFirst({ where: { renderId: render.id }, orderBy: { createdAt: "desc" } });
  if (!override) return { kind: "CHECKED" };
  const qc = await prisma.qCReport.findFirst({ where: { renderId: render.id }, orderBy: { createdAt: "desc" } });
  return aiCheckStatusFrom(override, qc);
}

/** For the calendar: which of these items' latest renders went out without the AI check
 * (and haven't passed one since). Sequential reads (PGlite). */
export async function listAiCheckSkippedItemIds(prisma: PrismaClient, contentItemIds: string[]): Promise<Set<string>> {
  if (contentItemIds.length === 0) return new Set();
  const overrides = await prisma.qualityOverride.findMany({ where: { contentItemId: { in: contentItemIds } }, orderBy: { createdAt: "desc" } });
  if (overrides.length === 0) return new Set();
  const out = new Set<string>();
  for (const id of new Set(overrides.map((o) => o.contentItemId))) {
    const status = await getAiCheckStatus(prisma, id);
    if (status.kind === "SKIPPED" || (status.kind === "CHECKED_LATER" && !status.passed)) out.add(id);
  }
  return out;
}

/**
 * Preflight's approval rule for one render: its latest QCReport PASSes, or the owner's
 * override for it is newer than any QCReport (a later AI check that BLOCKs supersedes the
 * override — a real hard-gate finding still blocks publication). Deterministic.
 */
export async function renderPublishApproval(
  prisma: PrismaClient,
  renderId: string,
): Promise<{ ok: true; via: "QC_PASS" | "OWNER_OVERRIDE" } | { ok: false; reason: string }> {
  const qc = await prisma.qCReport.findFirst({ where: { renderId }, orderBy: { createdAt: "desc" } });
  const override = await prisma.qualityOverride.findFirst({ where: { renderId }, orderBy: { createdAt: "desc" } });
  if (override && override.technicalStatus === "PASS" && (!qc || qc.createdAt <= override.createdAt)) {
    return { ok: true, via: "OWNER_OVERRIDE" };
  }
  if (!qc) return { ok: false, reason: "No QC report exists for the latest render — the quality gate has not passed (QC check)." };
  if (qc.overallStatus !== "PASS") return { ok: false, reason: `Latest QC report for this render is ${qc.overallStatus}, not PASS (QC check).` };
  return { ok: true, via: "QC_PASS" };
}
