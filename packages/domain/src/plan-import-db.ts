import { createHash } from "node:crypto";
import type { ContentState, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";
import { createContentItem } from "./content-item";
import { setScheduleEntry } from "./schedule";
import { applyTransition } from "./state-machine";
import { parseHhmm, ymdInTz, ymdMinutesToUtc, minutesInTz, formatHhmm } from "./tz";
import { PLAN_PLATFORMS, type PostingPlanData } from "./posting-plan-core";
import {
  canonicalCommitRows,
  dedupeKey,
  assignDefaultTimes,
  plannedDescription,
  type CommitRow,
  type ExistingPlanned,
} from "./plan-import/preview";

/**
 * Plan import — the persistence half (the parsing half is the browser-safe ./plan-import).
 *
 * Creating a plan: each row becomes a ContentItem (title; hook + notes kept in the
 * description as written — no fake scripts) moved IDEA -> SELECTED with reason "Imported
 * plan" (a video Chris put on a dated plan is a committed choice, which is exactly what
 * SELECTED means in /docs/STATE_MACHINE.md), plus a ScheduleEntry on its planned day/time and
 * platforms via the ungated `setScheduleEntry` — so it shows on the calendar as "not ready yet"
 * and fills its posting-plan slot. Nothing here touches the hard gates: these items still have
 * to be filmed, edited and pass every gate before they can be SCHEDULED for publishing.
 * See docs/decisions-pending/plan-import.md.
 */

export const PLAN_IMPORT_REASON = "Imported plan";

const CommitRowSchema = z.object({
  title: z.string().trim().min(1).max(300),
  ymd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  platforms: z.array(z.enum(PLAN_PLATFORMS)).min(1),
  hook: z.string().max(2000).nullable(),
  notes: z.string().max(10000).nullable(),
  format: z.string().max(200).nullable(),
  pillar: z.enum(["SKILL", "MINDSET", "LIFESTYLE", "PASSIONS"]).nullable(),
});

export const CommitPlanImportSchema = z.object({
  sourceKind: z.enum(["CSV", "XLSX", "GOOGLE_SHEETS", "TEXT", "AI_CLEANUP"]),
  sourceRef: z.string().max(500).nullable().optional(),
  rawInput: z.string(),
  rows: z.array(CommitRowSchema).min(1).max(1000),
});
export type CommitPlanImportInput = z.input<typeof CommitPlanImportSchema>;

export interface CommitPlanImportResult {
  importId: string;
  created: number;
  skipped: number;
  failed: { title: string; error: string }[];
  /** True when this exact plan was already imported and nothing new was created. */
  alreadyImported: boolean;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Every dated, non-cancelled video (title + local day) — the duplicate check's reference set. */
export async function listExistingPlanned(prisma: PrismaClient, tz: string): Promise<ExistingPlanned[]> {
  const entries = await prisma.scheduleEntry.findMany({
    include: { contentItem: { select: { id: true, title: true, currentState: true } } },
  });
  return entries
    .filter((e) => e.contentItem.currentState !== "CANCELLED")
    .map((e) => ({ title: e.contentItem.title, ymd: ymdInTz(e.scheduledDate, tz), contentItemId: e.contentItem.id }));
}

export async function commitPlanImport(
  prisma: PrismaClient,
  input: CommitPlanImportInput,
  actor: { actorId: string },
  opts: { tz: string; plan: Pick<PostingPlanData, "cadences"> | null },
): Promise<CommitPlanImportResult> {
  const parsed = CommitPlanImportSchema.parse(input);
  const rows = parsed.rows as CommitRow[];
  const idempotencyKey = sha256(canonicalCommitRows(rows));

  // Same rows imported again (double tap, retry after a dropped connection, re-upload of the
  // same file): reuse the import; the duplicate check below then skips everything already
  // created — and still finishes any rows a partial earlier attempt didn't get to.
  const existingImport = await prisma.planImport.findFirst({ where: { idempotencyKey, undoneAt: null } });
  const imp =
    existingImport ??
    (await prisma.planImport.create({
      data: {
        sourceKind: parsed.sourceKind,
        sourceRef: parsed.sourceRef ?? null,
        rawInputHash: sha256(parsed.rawInput),
        rawInputExcerpt: parsed.rawInput.slice(0, 2000),
        idempotencyKey,
        rowCount: rows.length,
        createdBy: actor.actorId,
      },
    }));

  const known = new Set((await listExistingPlanned(prisma, opts.tz)).map((e) => dedupeKey(e.title, e.ymd)));
  let created = 0;
  let skipped = 0;
  const failed: { title: string; error: string }[] = [];

  // Untimed rows spread over the day's posting slots (4 videos a day → 09:00, 12:00, 17:00, 20:00).
  const times = assignDefaultTimes(rows, opts.plan);
  // Sequential on purpose (PGlite; and one bad row must not sink the rest — see DECISIONS).
  for (const [idx, row] of rows.entries()) {
    const key = dedupeKey(row.title, row.ymd);
    if (known.has(key)) {
      skipped++;
      continue;
    }
    try {
      const item = await createContentItem(
        prisma,
        {
          title: row.title.trim(),
          description: plannedDescription(row),
          pillar: row.pillar ?? undefined,
          format: row.format ?? undefined,
        },
        actor,
      );
      await prisma.contentItem.update({ where: { id: item.id }, data: { planImportId: imp.id } });
      await applyTransition(prisma, {
        contentItemId: item.id,
        to: "SELECTED",
        actorType: "HUMAN",
        actorId: actor.actorId,
        reason: PLAN_IMPORT_REASON,
        idempotencyKey: `plan-import:${item.id}:SELECTED`,
      });
      const time = times[idx] ?? "09:00";
      await setScheduleEntry(
        prisma,
        { contentItemId: item.id, scheduledDate: ymdMinutesToUtc(row.ymd, parseHhmm(time) ?? 18 * 60, opts.tz), targetPlatforms: row.platforms },
        actor,
      );
      known.add(key);
      created++;
    } catch (err) {
      failed.push({ title: row.title, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await prisma.planImport.update({
    where: { id: imp.id },
    data: { createdCount: { increment: created }, skippedCount: existingImport ? imp.skippedCount : skipped },
  });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: existingImport ? "PLAN_IMPORT_REPLAYED" : "PLAN_IMPORTED",
    entityType: "PlanImport",
    entityId: imp.id,
    after: { sourceKind: parsed.sourceKind, rows: rows.length, created, skipped, failed: failed.length },
  });

  return { importId: imp.id, created, skipped, failed, alreadyImported: !!existingImport && created === 0 };
}

/** States an imported item can be in and still count as "untouched" by undo. */
const UNTOUCHED: ReadonlySet<ContentState> = new Set<ContentState>(["IDEA", "SELECTED"]);

export interface UndoPlanImportResult {
  cancelled: number;
  /** Items Chris already started (filmed, contracted, …) — left exactly as they are. */
  kept: number;
  alreadyUndone: boolean;
}

/**
 * "Undo this import": cancels every imported video Chris hasn't started yet (still just
 * planned, no footage) with a reason, and takes it off the calendar. Never deletes an item or
 * its history; videos he already started are kept and reported. Idempotent.
 */
export async function undoPlanImport(prisma: PrismaClient, importId: string, actor: { actorId: string }): Promise<UndoPlanImportResult> {
  const imp = await prisma.planImport.findUniqueOrThrow({ where: { id: importId } });
  if (imp.undoneAt) return { cancelled: 0, kept: 0, alreadyUndone: true };
  const items = await prisma.contentItem.findMany({ where: { planImportId: importId }, select: { id: true, currentState: true } });
  const reason = `Undo plan import from ${imp.createdAt.toISOString().slice(0, 10)}`;
  let cancelled = 0;
  let kept = 0;
  for (const item of items) {
    if (item.currentState === "CANCELLED") continue;
    const media = await prisma.mediaAsset.count({ where: { contentItemId: item.id } });
    if (!UNTOUCHED.has(item.currentState) || media > 0) {
      kept++;
      continue;
    }
    await applyTransition(prisma, { contentItemId: item.id, to: "CANCELLED", actorType: "HUMAN", actorId: actor.actorId, reason });
    const entry = await prisma.scheduleEntry.findUnique({ where: { contentItemId: item.id } });
    if (entry) {
      await prisma.scheduleEntry.delete({ where: { contentItemId: item.id } });
      await recordAudit(prisma, {
        actor: actor.actorId,
        actorType: "HUMAN",
        action: "SCHEDULE_ENTRY_REMOVED",
        entityType: "ContentItem",
        entityId: item.id,
        before: { scheduledDate: entry.scheduledDate, targetPlatforms: entry.targetPlatforms },
        metadata: { reason },
      });
    }
    cancelled++;
  }
  await prisma.planImport.update({ where: { id: importId }, data: { undoneAt: new Date(), undoneBy: actor.actorId } });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "PLAN_IMPORT_UNDONE",
    entityType: "PlanImport",
    entityId: importId,
    after: { cancelled, kept },
  });
  return { cancelled, kept, alreadyUndone: false };
}

export async function listPlanImports(prisma: PrismaClient, limit = 10) {
  return prisma.planImport.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}

export interface PlannedVideo {
  id: string;
  title: string;
  description: string | null;
  state: ContentState;
  /** Local planned post day + time. */
  ymd: string;
  time: string;
  at: Date;
  platforms: string[];
  planImportId: string | null;
  takes: number;
}

/**
 * Every dated, non-cancelled video in [fromYmd, toYmd) (either bound optional), oldest first —
 * the Plan board and the batch-upload matcher's targets. Sequential queries (PGlite).
 */
export async function listPlannedVideos(
  prisma: PrismaClient,
  opts: { tz: string; from?: Date; to?: Date },
): Promise<PlannedVideo[]> {
  const entries = await prisma.scheduleEntry.findMany({
    where: { scheduledDate: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lt: opts.to } : {}) } },
    include: { contentItem: { select: { id: true, title: true, description: true, currentState: true, planImportId: true } } },
    orderBy: { scheduledDate: "asc" },
  });
  const live = entries.filter((e) => e.contentItem.currentState !== "CANCELLED");
  const ids = live.map((e) => e.contentItemId);
  const media = ids.length
    ? await prisma.mediaAsset.groupBy({ by: ["contentItemId"], where: { contentItemId: { in: ids }, kind: "RAW_TAKE", removedAt: null }, _count: { _all: true } })
    : [];
  const takesBy = new Map(media.map((m) => [m.contentItemId, m._count._all]));
  return live.map((e) => ({
    id: e.contentItem.id,
    title: e.contentItem.title,
    description: e.contentItem.description,
    state: e.contentItem.currentState,
    ymd: ymdInTz(e.scheduledDate, opts.tz),
    time: formatHhmm(minutesInTz(e.scheduledDate, opts.tz)),
    at: e.scheduledDate,
    platforms: (e.targetPlatforms as string[]) ?? [],
    planImportId: e.contentItem.planImportId,
    takes: takesBy.get(e.contentItemId) ?? 0,
  }));
}
