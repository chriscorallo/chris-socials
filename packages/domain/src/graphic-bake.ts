import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Baked preview graphics (docs/decisions-pending/editor-rebuild.md): rows of the editor's
 * preview cache. Each row is one graphic rendered by the real renderer at half size (stacked
 * alpha H.264). The editor asks for the keys it needs; missing ones become PENDING rows that the
 * `graphics-bake` heavy job renders. Renders never read these — they're a preview cache, so
 * superseded rows are deleted (newest GRAPHIC_BAKE_KEEP per video are kept, enough for undo).
 */

export const GRAPHIC_BAKE_KEEP = 60;
/** A FAILED bake is retried when asked for again after this long. */
export const GRAPHIC_BAKE_RETRY_MS = 10 * 60_000;
/** A PENDING bake no job has finished after this long is offered to the next job again. */
export const GRAPHIC_BAKE_STALE_MS = 15 * 60_000;

export type GraphicBakeStatus = "PENDING" | "READY" | "FAILED";

export interface GraphicBakeState {
  key: string;
  status: GraphicBakeStatus;
  storageKey: string | null;
  fps: number;
  frames: number | null;
  width: number | null;
  height: number | null;
}

function stateOf(r: { key: string; status: string; storageKey: string | null; fps: number; frames: number | null; width: number | null; height: number | null }): GraphicBakeState {
  return { key: r.key, status: r.status as GraphicBakeStatus, storageKey: r.storageKey, fps: r.fps, frames: r.frames, width: r.width, height: r.height };
}

/**
 * Looks up (and creates PENDING rows for) the bakes the editor needs. Returns every key's state
 * and whether any row needs a job (new, retried or stale).
 */
export async function requestGraphicBakes(
  db: PrismaClient,
  contentItemId: string,
  wanted: Array<{ key: string; input: Record<string, unknown> }>,
  now = new Date(),
): Promise<{ states: GraphicBakeState[]; needsJob: boolean }> {
  const keys = [...new Set(wanted.map((w) => w.key))].slice(0, 40);
  const rows = await db.graphicBake.findMany({ where: { contentItemId, key: { in: keys } } });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  let needsJob = false;
  for (const w of wanted) {
    if (!keys.includes(w.key)) continue;
    const r = byKey.get(w.key);
    if (!r) {
      const created = await db.graphicBake
        .create({ data: { contentItemId, key: w.key, status: "PENDING", input: w.input as Prisma.InputJsonValue } })
        .catch(async () => db.graphicBake.findUnique({ where: { contentItemId_key: { contentItemId, key: w.key } } }));
      if (created) byKey.set(w.key, created);
      needsJob = true;
    } else if (r.status === "FAILED" && now.getTime() - r.updatedAt.getTime() > GRAPHIC_BAKE_RETRY_MS) {
      byKey.set(w.key, await db.graphicBake.update({ where: { id: r.id }, data: { status: "PENDING", error: null } }));
      needsJob = true;
    } else if (r.status === "PENDING") {
      needsJob = true;
    }
  }
  return { states: [...byKey.values()].map(stateOf), needsJob };
}

/** PENDING rows for one video (oldest first) — what a `graphics-bake` job renders. */
export async function pendingGraphicBakes(db: PrismaClient, contentItemId: string, limit = 12) {
  return db.graphicBake.findMany({ where: { contentItemId, status: "PENDING" }, orderBy: { createdAt: "asc" }, take: limit });
}

export async function markGraphicBakeReady(db: PrismaClient, id: string, out: { storageKey: string; frames: number; width: number; height: number; fps: number }) {
  return db.graphicBake.update({ where: { id }, data: { status: "READY", storageKey: out.storageKey, frames: out.frames, width: out.width, height: out.height, fps: out.fps, error: null } });
}

export async function markGraphicBakeFailed(db: PrismaClient, id: string, error: string) {
  return db.graphicBake.update({ where: { id }, data: { status: "FAILED", error: error.slice(0, 500) } });
}

/** Deletes all but the newest GRAPHIC_BAKE_KEEP rows of a video; returns the files to delete. */
export async function pruneGraphicBakes(db: PrismaClient, contentItemId: string, keep = GRAPHIC_BAKE_KEEP): Promise<string[]> {
  const old = await db.graphicBake.findMany({ where: { contentItemId }, orderBy: { updatedAt: "desc" }, skip: keep, select: { id: true, storageKey: true } });
  if (!old.length) return [];
  await db.graphicBake.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  return old.map((o) => o.storageKey).filter((k): k is string => !!k);
}
