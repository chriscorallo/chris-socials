import type { PrismaClient, PostingPlan } from "@prisma/client";
import { recordAudit } from "./audit";
import { PostingPlanDataSchema, type PostingPlanData } from "./posting-plan-core";

/**
 * Persistence for the posting plan (pure logic in posting-plan-core.ts). Append-only and
 * versioned like the Brand Constitution: a save never updates a row in place — it writes
 * version N+1 as the only active row and deactivates the rest, in one transaction, with an
 * audit entry. Reading returns the single active plan (or null: no plan yet).
 */

export function postingPlanRowToData(row: PostingPlan): PostingPlanData {
  return PostingPlanDataSchema.parse({
    startDate: row.startDate,
    timezone: row.timezone,
    readyLeadDays: row.readyLeadDays,
    filmLeadDays: row.filmLeadDays,
    sameForAll: row.sameForAll,
    cadences: row.cadences,
  });
}

export async function getActivePostingPlan(prisma: PrismaClient): Promise<(PostingPlanData & { id: string; version: number }) | null> {
  const row = await prisma.postingPlan.findFirst({ where: { active: true }, orderBy: { version: "desc" } });
  if (!row) return null;
  return { ...postingPlanRowToData(row), id: row.id, version: row.version };
}

export async function listPostingPlanVersions(prisma: PrismaClient) {
  return prisma.postingPlan.findMany({ orderBy: { version: "desc" } });
}

export async function savePostingPlan(prisma: PrismaClient, input: PostingPlanData, actor: { actorId: string }) {
  const data = PostingPlanDataSchema.parse(input);
  // One cadence per platform — a duplicate would double-count slots.
  const platforms = data.cadences.map((c) => c.platform);
  if (new Set(platforms).size !== platforms.length) throw new Error("Each platform can appear only once in a posting plan.");

  return prisma.$transaction(async (tx) => {
    const previous = await tx.postingPlan.findFirst({ where: { active: true }, orderBy: { version: "desc" } });
    const last = await tx.postingPlan.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
    await tx.postingPlan.updateMany({ where: { active: true }, data: { active: false } });
    const row = await tx.postingPlan.create({
      data: {
        version: (last?.version ?? 0) + 1,
        active: true,
        startDate: data.startDate,
        timezone: data.timezone,
        readyLeadDays: data.readyLeadDays,
        filmLeadDays: data.filmLeadDays,
        sameForAll: data.sameForAll,
        cadences: data.cadences,
        createdBy: actor.actorId,
      },
    });
    await recordAudit(tx, {
      actor: actor.actorId,
      actorType: "HUMAN",
      action: "POSTING_PLAN_SAVED",
      entityType: "PostingPlan",
      entityId: row.id,
      before: previous ? { version: previous.version, cadences: previous.cadences } : undefined,
      after: { version: row.version, cadences: data.cadences, readyLeadDays: data.readyLeadDays, filmLeadDays: data.filmLeadDays },
    });
    return row;
  });
}

// ---- Nudge dismissals ("not today") -----------------------------------------------------

export async function dismissNudge(prisma: PrismaClient, key: string, day: string) {
  await prisma.nudgeDismissal.upsert({
    where: { key_day: { key, day } },
    create: { key, day },
    update: {},
  });
}

export async function listDismissedNudgeKeys(prisma: PrismaClient, day: string): Promise<Set<string>> {
  const rows = await prisma.nudgeDismissal.findMany({ where: { day }, select: { key: true } });
  return new Set(rows.map((r) => r.key));
}
