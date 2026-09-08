import type { PrismaClient, ActorType, AuditLog, Prisma } from "@prisma/client";

/**
 * Audit log write path. Per /docs/SECURITY.md, every audited action is logged and never
 * silently dropped — this is the one function that should ever write to AuditLog directly,
 * so every call site is easy to find.
 */
export interface RecordAuditInput {
  actor: string;
  actorType: ActorType;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

// Accepts a transaction client too (same pattern as state-machine.ts's writeTransition) — a
// caller inside prisma.$transaction(async (tx) => ...) needs to audit-log using that same tx,
// not a fresh top-level client, or the audit write wouldn't be part of the transaction at all.
type Db = PrismaClient | Prisma.TransactionClient;

export async function recordAudit(
  prisma: Db,
  input: RecordAuditInput,
): Promise<AuditLog> {
  return prisma.auditLog.create({
    data: {
      actor: input.actor,
      actorType: input.actorType,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before ?? undefined,
      after: input.after ?? undefined,
      metadata: input.metadata ?? undefined,
    },
  });
}

export async function getAuditLogForEntity(
  prisma: PrismaClient,
  entityType: string,
  entityId: string,
): Promise<AuditLog[]> {
  return prisma.auditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: "asc" },
  });
}
