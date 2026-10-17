import type { PrismaClient, ContentState, ActorType, Prisma } from "@prisma/client";

/** Anything shaped like PrismaClient's model delegates — the plain client or a $transaction
 * callback's `tx` argument. Lets writeTransition compose into a caller's own transaction
 * (e.g. "create ProductionContract + advance to CONTRACTED" as one atomic write) instead of
 * being locked inside its own. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Content state machine. Authoritative transition table lives in /docs/STATE_MACHINE.md —
 * this file must match that document exactly. If they diverge, fix the code, or if the model
 * itself needs to change, update the doc first and log why in /docs/DECISIONS.md.
 */

// Explicit adjacency list. Deliberately NOT derived from anything clever — a state machine
// this consequential (it gates real publishing actions) should be readable at a glance.
const TRANSITIONS: Record<ContentState, ContentState[]> = {
  IDEA: ["SELECTED"],
  SELECTED: ["CONTRACTED"],
  CONTRACTED: ["RESEARCHING"],
  RESEARCHING: ["RESEARCHED", "RESEARCH_BLOCKED"],
  RESEARCH_BLOCKED: ["RESEARCHING"], // rollback
  RESEARCHED: ["SCRIPTING"],
  SCRIPTING: ["SCRIPTED"],
  SCRIPTED: ["READY_TO_FILM"],
  READY_TO_FILM: ["FILMED"],
  FILMED: ["MEDIA_INGESTED"],
  MEDIA_INGESTED: ["TAKE_SELECTED"],
  TAKE_SELECTED: ["EDIT_PLANNED"],
  EDIT_PLANNED: ["EDITING"],
  EDITING: ["RENDERED"],
  RENDERED: ["READY", "QC_REPAIR", "EDIT_PLANNED"], // EDIT_PLANNED = finishing-edit rollback
  QC_REPAIR: ["RENDERED", "QC_BLOCKED", "EDIT_PLANNED"], // EDIT_PLANNED = finishing-edit rollback
  QC_BLOCKED: ["EDIT_PLANNED"], // rollback
  READY: ["SCHEDULED", "EDIT_PLANNED"], // EDIT_PLANNED = finishing-edit rollback
  SCHEDULED: ["PUBLISHING", "EDIT_PLANNED"], // EDIT_PLANNED = finishing-edit rollback
  PUBLISHING: ["PUBLISHED"],
  PUBLISHED: ["MEASURING"],
  MEASURING: ["ARCHIVED"],
  ARCHIVED: [], // terminal
  CANCELLED: [], // terminal
};

const TERMINAL_STATES = new Set<ContentState>(["ARCHIVED", "CANCELLED"]);

export const ROLLBACK_TRANSITIONS = new Set<string>([
  "QC_BLOCKED->EDIT_PLANNED",
  "RESEARCH_BLOCKED->RESEARCHING",
  // In-app finishing editor (2026-10-16): a saved human edit re-enters render + hard gates.
  "RENDERED->EDIT_PLANNED",
  "QC_REPAIR->EDIT_PLANNED",
  "READY->EDIT_PLANNED",
  "SCHEDULED->EDIT_PLANNED",
]);

export class InvalidTransitionError extends Error {
  constructor(from: ContentState, to: ContentState) {
    super(`Invalid content state transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class MissingCancellationReasonError extends Error {
  constructor() {
    super("A transition to CANCELLED requires a non-empty reason.");
    this.name = "MissingCancellationReasonError";
  }
}

/**
 * True if `to` is reachable from `from` in exactly one step — either via the explicit
 * adjacency list, or via the universal "any non-terminal state may transition to CANCELLED"
 * rule from /docs/STATE_MACHINE.md.
 */
export function isValidTransition(from: ContentState, to: ContentState): boolean {
  if (to === "CANCELLED") {
    return !TERMINAL_STATES.has(from);
  }
  return TRANSITIONS[from].includes(to);
}

export function isRollback(from: ContentState, to: ContentState): boolean {
  return ROLLBACK_TRANSITIONS.has(`${from}->${to}`);
}

export interface ApplyTransitionInput {
  contentItemId: string;
  to: ContentState;
  reason?: string;
  actorType: ActorType;
  actorId?: string;
  /** Same key + same target transition on retry is a no-op, not a duplicate row. */
  idempotencyKey?: string;
}

export interface ApplyTransitionResult {
  contentItemId: string;
  fromState: ContentState;
  toState: ContentState;
  transitionId: string;
  /** True if this call found an existing idempotent result rather than writing a new one. */
  idempotentReplay: boolean;
}

export interface WriteTransitionInput {
  contentItemId: string;
  fromState: ContentState;
  toState: ContentState;
  reason?: string;
  actorType: ActorType;
  actorId?: string;
  idempotencyKey?: string;
  /** Defaults to "STATE_TRANSITION" — override when the transition is a side effect of
   * creating another artifact (e.g. "PRODUCTION_CONTRACT_CREATED") so the audit trail reads
   * as what actually happened, not a generic transition. */
  auditAction?: string;
}

/**
 * The raw, unchecked write: update ContentItem.currentState, insert the permanent
 * ContentStateTransition row, insert the AuditLog entry. No validation, no idempotency check
 * — callers that need those use applyTransition. This exists so other domain flows (creating
 * a ProductionContract while advancing SELECTED -> CONTRACTED, a CreatorCard while advancing
 * SCRIPTED -> READY_TO_FILM) can fold the transition into their own `$transaction` and get one
 * atomic write instead of two separate ones with a window for partial failure between them.
 */
export async function writeTransition(db: Db, input: WriteTransitionInput) {
  await db.contentItem.update({
    where: { id: input.contentItemId },
    data: { currentState: input.toState },
  });

  const transition = await db.contentStateTransition.create({
    data: {
      contentItemId: input.contentItemId,
      fromState: input.fromState,
      toState: input.toState,
      reason: input.reason,
      actorType: input.actorType,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
    },
  });

  await db.auditLog.create({
    data: {
      actor: input.actorId ?? input.actorType,
      actorType: input.actorType,
      action: input.auditAction ?? "STATE_TRANSITION",
      entityType: "ContentItem",
      entityId: input.contentItemId,
      before: { currentState: input.fromState },
      after: { currentState: input.toState },
      metadata: { reason: input.reason, transitionId: transition.id },
    },
  });

  return transition;
}

/**
 * Applies a single state transition, persists the ContentItem's new state, and writes the
 * permanent ContentStateTransition history row — all in one DB transaction. Also writes an
 * AuditLog entry, satisfying Phase 0's requirement that the audit path is exercised by real
 * state changes, not left theoretical.
 *
 * Throws InvalidTransitionError before writing anything if the transition isn't in the table.
 */
export async function applyTransition(
  prisma: PrismaClient,
  input: ApplyTransitionInput,
): Promise<ApplyTransitionResult> {
  const { contentItemId, to, reason, actorType, actorId, idempotencyKey } = input;

  if (idempotencyKey) {
    const existing = await prisma.contentStateTransition.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      return {
        contentItemId: existing.contentItemId,
        fromState: existing.fromState,
        toState: existing.toState,
        transitionId: existing.id,
        idempotentReplay: true,
      };
    }
  }

  const item = await prisma.contentItem.findUniqueOrThrow({
    where: { id: contentItemId },
  });
  const from = item.currentState;

  if (!isValidTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
  if (to === "CANCELLED" && !reason?.trim()) {
    throw new MissingCancellationReasonError();
  }

  const result = await prisma.$transaction((tx) =>
    writeTransition(tx, {
      contentItemId,
      fromState: from,
      toState: to,
      reason,
      actorType,
      actorId,
      idempotencyKey,
    }),
  );

  return {
    contentItemId,
    fromState: from,
    toState: to,
    transitionId: result.id,
    idempotentReplay: false,
  };
}

export function listValidNextStates(from: ContentState): ContentState[] {
  const explicit = TRANSITIONS[from];
  if (TERMINAL_STATES.has(from)) return explicit;
  return [...explicit, "CANCELLED"];
}
