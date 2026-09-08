import type { PrismaClient, ActorType } from "@prisma/client";
import { recordAudit } from "./audit";

/**
 * Minimal feature-flag system — one table, no vendor. See /docs/DECISIONS.md for why.
 * Used from Phase 0 onward to gate risky/new autonomous behavior per CLAUDE.md's standing
 * rules; real autonomy-level gating lands in Phase 8.
 */

export async function isEnabled(
  prisma: PrismaClient,
  key: string,
): Promise<boolean> {
  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  // An unknown flag defaults to disabled — fail closed, never fail open on a typo'd key.
  return flag?.enabled ?? false;
}

export async function setFlag(
  prisma: PrismaClient,
  input: {
    key: string;
    enabled: boolean;
    description?: string;
    actor: string;
    actorType: ActorType;
  },
): Promise<void> {
  const existing = await prisma.featureFlag.findUnique({
    where: { key: input.key },
  });

  const after = await prisma.featureFlag.upsert({
    where: { key: input.key },
    create: {
      key: input.key,
      enabled: input.enabled,
      description: input.description ?? "",
    },
    update: {
      enabled: input.enabled,
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
  });

  await recordAudit(prisma, {
    actor: input.actor,
    actorType: input.actorType,
    action: existing ? "FEATURE_FLAG_UPDATED" : "FEATURE_FLAG_CREATED",
    entityType: "FeatureFlag",
    entityId: after.id,
    before: existing ? { enabled: existing.enabled } : null,
    after: { enabled: after.enabled },
  });
}

export async function listFlags(prisma: PrismaClient) {
  return prisma.featureFlag.findMany({ orderBy: { key: "asc" } });
}
