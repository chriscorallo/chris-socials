import type { PrismaClient, ContentState } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";
import { writeTransition } from "./state-machine";

/**
 * Calendar shell — spec §9 step 19 ("Auto-Fill Week"), Phase 1 scope: one manually-set date
 * per ContentItem. Per-platform scheduling, quota awareness (see /docs/DECISIONS.md —
 * Instagram/TikTok/YouTube rate limits), and real auto-fill logic arrive with Phase 5 (below).
 */
export const SetScheduleEntrySchema = z.object({
  contentItemId: z.string().min(1),
  scheduledDate: z.coerce.date(),
  /** Optional (added for plan import): which platforms the planned video is meant for. When
   * omitted, an existing entry keeps its platforms. */
  targetPlatforms: z.array(z.enum(["INSTAGRAM", "TIKTOK", "YOUTUBE"])).optional(),
});

export type SetScheduleEntryInput = z.input<typeof SetScheduleEntrySchema>;

export async function setScheduleEntry(
  prisma: PrismaClient,
  input: SetScheduleEntryInput,
  actor: { actorId: string },
) {
  const parsed = SetScheduleEntrySchema.parse(input);

  const entry = await prisma.scheduleEntry.upsert({
    where: { contentItemId: parsed.contentItemId },
    create: {
      contentItemId: parsed.contentItemId,
      scheduledDate: parsed.scheduledDate,
      ...(parsed.targetPlatforms ? { targetPlatforms: parsed.targetPlatforms } : {}),
    },
    update: {
      scheduledDate: parsed.scheduledDate,
      ...(parsed.targetPlatforms ? { targetPlatforms: parsed.targetPlatforms } : {}),
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "SCHEDULE_ENTRY_SET",
    entityType: "ContentItem",
    entityId: parsed.contentItemId,
    after: { scheduledDate: entry.scheduledDate, ...(parsed.targetPlatforms ? { targetPlatforms: parsed.targetPlatforms } : {}) },
  });

  return entry;
}

export async function listScheduleEntries(prisma: PrismaClient) {
  return prisma.scheduleEntry.findMany({
    include: { contentItem: true },
    orderBy: { scheduledDate: "asc" },
  });
}

export async function getScheduleEntry(prisma: PrismaClient, contentItemId: string) {
  return prisma.scheduleEntry.findUnique({ where: { contentItemId } });
}

/**
 * Every hard-gate-passed item with nowhere on the calendar yet — the actual pool "Auto-Fill
 * Week" (spec §9 step 19) and the Calendar's manual placement form both draw from. Two
 * sequential queries, not a join — see /docs/DECISIONS.md's PGlite entries.
 */
export async function listUnscheduledReadyItems(prisma: PrismaClient) {
  const ready = await prisma.contentItem.findMany({
    where: { currentState: "READY" },
    orderBy: { createdAt: "asc" },
  });
  if (ready.length === 0) return [];
  const scheduled = await prisma.scheduleEntry.findMany({
    where: { contentItemId: { in: ready.map((r) => r.id) } },
    select: { contentItemId: true },
  });
  const scheduledIds = new Set(scheduled.map((s) => s.contentItemId));
  return ready.filter((item) => !scheduledIds.has(item.id));
}

/**
 * Phase 5 — the real "Auto-Fill Week" placement (spec §9 step 19), gated on the state machine:
 * only a `READY` item (all hard gates already PASSed — see /docs/PHASE_PLAN.md's Phase 4) can
 * be scheduled, and doing so is what drives `READY -> SCHEDULED`. Distinct from the plain
 * `setScheduleEntry` above (Phase 1's ungated calendar utility, still used for manual
 * date-only placement at any state) — this is the one real product code paths should call
 * once an item is actually being queued for publishing, because it also records which
 * platforms to target, which `apps/worker`'s publish job reads.
 *
 * Also the reschedule path: calling this again on an already-`SCHEDULED` item just updates the
 * existing `ScheduleEntry` (new date/platforms) with no state transition — there's nothing to
 * transition, it's already `SCHEDULED`. Every other state is rejected. Found this gap building
 * the real Calendar (post-Phase-8): the original version only ever accepted `READY`, so
 * dragging/reassigning an already-scheduled item to a new slot had no legal path at all.
 */
export class ScheduleForPublishingRequiresReadyStateError extends Error {
  constructor(actual: ContentState) {
    super(`Scheduling for publishing requires READY or SCHEDULED (current state: ${actual}).`);
    this.name = "ScheduleForPublishingRequiresReadyStateError";
  }
}

export const ScheduleForPublishingSchema = z.object({
  contentItemId: z.string().min(1),
  scheduledDate: z.coerce.date(),
  targetPlatforms: z.array(z.enum(["INSTAGRAM", "TIKTOK", "YOUTUBE"])).min(1),
});
export type ScheduleForPublishingInput = z.input<typeof ScheduleForPublishingSchema>;

export async function scheduleContentItemForPublishing(
  prisma: PrismaClient,
  input: ScheduleForPublishingInput,
  actor: { actorId: string },
) {
  const parsed = ScheduleForPublishingSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const item = await tx.contentItem.findUniqueOrThrow({ where: { id: parsed.contentItemId } });
    if (item.currentState !== "READY" && item.currentState !== "SCHEDULED") {
      throw new ScheduleForPublishingRequiresReadyStateError(item.currentState);
    }

    const entry = await tx.scheduleEntry.upsert({
      where: { contentItemId: parsed.contentItemId },
      create: {
        contentItemId: parsed.contentItemId,
        scheduledDate: parsed.scheduledDate,
        targetPlatforms: parsed.targetPlatforms,
      },
      update: { scheduledDate: parsed.scheduledDate, targetPlatforms: parsed.targetPlatforms },
    });

    // Only a real READY -> SCHEDULED move is a state transition; re-placing an already-
    // SCHEDULED item is just an update to where/when, not a new state.
    if (item.currentState === "READY") {
      await writeTransition(tx, {
        contentItemId: parsed.contentItemId,
        fromState: "READY",
        toState: "SCHEDULED",
        reason: `Scheduled for ${parsed.targetPlatforms.join(", ")}`,
        actorType: "HUMAN",
        actorId: actor.actorId,
        auditAction: "SCHEDULED_FOR_PUBLISHING",
      });
    } else {
      await recordAudit(tx, {
        actor: actor.actorId,
        actorType: "HUMAN",
        action: "SCHEDULE_RESCHEDULED",
        entityType: "ContentItem",
        entityId: parsed.contentItemId,
        after: { scheduledDate: entry.scheduledDate, targetPlatforms: parsed.targetPlatforms },
      });
    }

    return entry;
  });
}

export class UnscheduleRequiresScheduledStateError extends Error {
  constructor(actual: ContentState) {
    super(`Only a scheduled video can be taken off the calendar (this one is ${actual}).`);
    this.name = "UnscheduleRequiresScheduledStateError";
  }
}

/**
 * Calendar "Remove from calendar": SCHEDULED -> READY (a rollback). The video keeps its passed
 * hard gates and render — it simply goes back to the pool of ready videos. The ScheduleEntry
 * (where/when, not history) is removed in the same transaction; the transition + audit rows
 * record that it was scheduled and when it was taken off. Never possible once publishing has
 * started (PUBLISHING is not SCHEDULED).
 */
export async function unscheduleContentItem(
  prisma: PrismaClient,
  contentItemId: string,
  actor: { actorId: string },
) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
    if (item.currentState !== "SCHEDULED") {
      throw new UnscheduleRequiresScheduledStateError(item.currentState);
    }
    const entry = await tx.scheduleEntry.findUnique({ where: { contentItemId } });
    if (entry) await tx.scheduleEntry.delete({ where: { contentItemId } });
    await writeTransition(tx, {
      contentItemId,
      fromState: "SCHEDULED",
      toState: "READY",
      reason: entry
        ? `Removed from the calendar (was ${entry.scheduledDate.toISOString()})`
        : "Removed from the calendar",
      actorType: "HUMAN",
      actorId: actor.actorId,
      auditAction: "UNSCHEDULED",
    });
  });
}
