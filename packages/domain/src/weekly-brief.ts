import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";

/** The Weekly Review / Learning Council's output — the backward-looking counterpart to
 * WeeklyProgrammingThesis's forward-looking plan (spec: "closes one week and opens the
 * next"). One row per week, upserted (a re-run the same week replaces the brief, since it's
 * meant to be the single authoritative close-out for that week, not an append-only series). */
export const RecordWeeklyBriefSchema = z.object({
  weekStartDate: z.coerce.date(),
  whatHappened: z.string().min(1),
  whatItMeans: z.string().min(1),
  stillUncertain: z.array(z.string()).default([]),
  recommendationsForNextWeek: z.array(z.string()).default([]),
});
export type RecordWeeklyBriefInput = z.input<typeof RecordWeeklyBriefSchema>;

export async function recordWeeklyBrief(
  prisma: PrismaClient,
  input: RecordWeeklyBriefInput,
  actor: { actorId: string },
) {
  const parsed = RecordWeeklyBriefSchema.parse(input);

  const brief = await prisma.weeklyBrief.upsert({
    where: { weekStartDate: parsed.weekStartDate },
    create: {
      weekStartDate: parsed.weekStartDate,
      whatHappened: parsed.whatHappened,
      whatItMeans: parsed.whatItMeans,
      stillUncertain: parsed.stillUncertain,
      recommendationsForNextWeek: parsed.recommendationsForNextWeek,
    },
    update: {
      whatHappened: parsed.whatHappened,
      whatItMeans: parsed.whatItMeans,
      stillUncertain: parsed.stillUncertain,
      recommendationsForNextWeek: parsed.recommendationsForNextWeek,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "SYSTEM",
    action: "WEEKLY_BRIEF_RECORDED",
    entityType: "WeeklyBrief",
    entityId: brief.id,
    after: { weekStartDate: brief.weekStartDate },
  });

  return brief;
}

export async function listWeeklyBriefs(prisma: PrismaClient) {
  return prisma.weeklyBrief.findMany({ orderBy: { weekStartDate: "desc" } });
}

export async function getWeeklyBrief(prisma: PrismaClient, weekStartDate: Date) {
  return prisma.weeklyBrief.findUnique({ where: { weekStartDate } });
}
