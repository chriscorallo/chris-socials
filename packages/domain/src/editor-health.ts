import type { PrismaClient, Prisma } from "@prisma/client";

/**
 * Editor health telemetry (docs/decisions-pending/editor-rebuild.md). The finishing editor on
 * Chris's phone posts compact reports — timings, frame/stall counters, video events, errors,
 * device facts — so preview problems are measured on the real device. Never media, titles or
 * transcript text (the client never sends them; the server caps the size).
 *
 * Rows are append-only (never updated); a session posts cumulative checkpoints and the
 * diagnostics page shows the newest per session. Old rows are pruned here, on write.
 */

export const EDITOR_HEALTH_KEEP_ROWS = 400;
export const EDITOR_HEALTH_KEEP_DAYS = 30;
/** Largest accepted report (serialized JSON, bytes). */
export const EDITOR_HEALTH_MAX_BYTES = 48_000;

export interface EditorHealthInput {
  userId: string;
  contentItemId: string | null;
  sessionId: string;
  kind: "session" | "glitch";
  engine: string | null;
  userAgent: string | null;
  report: Record<string, unknown>;
}

export async function recordEditorHealthReport(db: PrismaClient, input: EditorHealthInput, now = new Date()): Promise<{ id: string }> {
  const row = await db.editorHealthReport.create({
    data: {
      userId: input.userId,
      contentItemId: input.contentItemId,
      sessionId: input.sessionId.slice(0, 64),
      kind: input.kind,
      engine: input.engine?.slice(0, 32) ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      report: input.report as Prisma.InputJsonValue,
      createdAt: now,
    },
    select: { id: true },
  });
  await pruneEditorHealthReports(db, now);
  return row;
}

/** Deletes reports older than KEEP_DAYS and everything beyond the newest KEEP_ROWS. */
export async function pruneEditorHealthReports(db: PrismaClient, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EDITOR_HEALTH_KEEP_DAYS * 86_400_000);
  const old = await db.editorHealthReport.deleteMany({ where: { createdAt: { lt: cutoff } } });
  const keep = await db.editorHealthReport.findMany({ orderBy: { createdAt: "desc" }, skip: EDITOR_HEALTH_KEEP_ROWS, take: 1, select: { createdAt: true } });
  let extra = 0;
  if (keep[0]) extra = (await db.editorHealthReport.deleteMany({ where: { createdAt: { lte: keep[0].createdAt } } })).count;
  return old.count + extra;
}

/** Newest first; the latest checkpoint per session plus every glitch report. */
export async function listEditorHealthReports(db: PrismaClient, limit = 60) {
  const rows = await db.editorHealthReport.findMany({ orderBy: { createdAt: "desc" }, take: 400 });
  const seen = new Set<string>();
  const out: typeof rows = [];
  for (const r of rows) {
    if (r.kind === "session") {
      if (seen.has(r.sessionId)) continue;
      seen.add(r.sessionId);
    }
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}
