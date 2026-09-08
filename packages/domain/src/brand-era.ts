import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";

/**
 * Brand Timeline (spec §7) — "era names and boundaries are not hardcoded; the system and
 * Chris define them from actual evolution." No enum, no auto-detection: a human names an era
 * and its start date; the domain layer's only real job is closing out the previous era so
 * timeline segments never overlap.
 */
export const CreateBrandEraSchema = z.object({
  name: z.string().min(1),
  startDate: z.coerce.date(),
  description: z.string().min(1),
});
export type CreateBrandEraInput = z.input<typeof CreateBrandEraSchema>;

export class BrandEraStartBeforeCurrentEraError extends Error {
  constructor(newStart: Date, currentStart: Date) {
    super(
      `New era would start (${newStart.toISOString()}) before the current era started ` +
        `(${currentStart.toISOString()}) — eras must be chronological.`,
    );
    this.name = "BrandEraStartBeforeCurrentEraError";
  }
}

/** Closes whichever era is currently open (endDate: null) as of `startDate`, then opens the
 * new one — so there is always at most one "current" (open-ended) era. */
export async function createBrandEra(
  prisma: PrismaClient,
  input: CreateBrandEraInput,
  actor: { actorId: string },
) {
  const parsed = CreateBrandEraSchema.parse(input);

  const currentEra = await prisma.brandEra.findFirst({
    where: { endDate: null },
    orderBy: { startDate: "desc" },
  });

  if (currentEra && parsed.startDate <= currentEra.startDate) {
    throw new BrandEraStartBeforeCurrentEraError(parsed.startDate, currentEra.startDate);
  }

  if (currentEra) {
    await prisma.brandEra.update({ where: { id: currentEra.id }, data: { endDate: parsed.startDate } });
  }

  const era = await prisma.brandEra.create({
    data: { name: parsed.name, startDate: parsed.startDate, description: parsed.description },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "BRAND_ERA_CREATED",
    entityType: "BrandEra",
    entityId: era.id,
    after: { name: era.name, startDate: era.startDate },
  });

  return era;
}

export async function listBrandEras(prisma: PrismaClient, opts?: { limit?: number }) {
  // Unlimited (default, unchanged): ascending, the natural reading order for a timeline.
  if (opts?.limit == null) {
    return prisma.brandEra.findMany({ orderBy: { startDate: "asc" } });
  }
  // Limited: the most recent N eras are what's relevant, not the oldest N — fetch newest-first
  // with `take`, then restore ascending order for display.
  const rows = await prisma.brandEra.findMany({ orderBy: { startDate: "desc" }, take: opts.limit });
  return rows.reverse();
}

export async function countBrandEras(prisma: PrismaClient) {
  return prisma.brandEra.count();
}

export async function getCurrentBrandEra(prisma: PrismaClient) {
  return prisma.brandEra.findFirst({ where: { endDate: null }, orderBy: { startDate: "desc" } });
}
