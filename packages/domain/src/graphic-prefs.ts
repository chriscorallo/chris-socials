import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Graphics-library preferences per user: favourite (starred) presets and recently used ones
 * (docs/decisions-pending/animation-library.md). Small, idempotent upserts — starring twice is
 * a no-op, "used" just bumps a counter and a timestamp. Preferences are UI convenience, not
 * audit history (the edit itself is versioned via EditPlan), so no AuditLog rows.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const RECENT_PRESETS_LIMIT = 12;
const PRESET_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

export interface GraphicPrefs {
  favorites: string[];
  /** Most recent first. */
  recents: string[];
}

function assertPresetId(presetId: string): void {
  if (!PRESET_ID.test(presetId)) throw new Error(`Invalid preset id: ${presetId.slice(0, 40)}`);
}

export async function getGraphicPrefs(db: Db, userId: string): Promise<GraphicPrefs> {
  const [favs, recent] = await Promise.all([
    db.graphicPresetPref.findMany({ where: { userId, favorite: true }, orderBy: { favoritedAt: "desc" }, select: { presetId: true } }),
    db.graphicPresetPref.findMany({ where: { userId, lastUsedAt: { not: null } }, orderBy: { lastUsedAt: "desc" }, take: RECENT_PRESETS_LIMIT, select: { presetId: true } }),
  ]);
  return { favorites: favs.map((f) => f.presetId), recents: recent.map((r) => r.presetId) };
}

/** Star / unstar a preset (idempotent). */
export async function setGraphicFavorite(db: Db, userId: string, presetId: string, favorite: boolean, now: Date = new Date()): Promise<GraphicPrefs> {
  assertPresetId(presetId);
  await db.graphicPresetPref.upsert({
    where: { userId_presetId: { userId, presetId } },
    create: { userId, presetId, favorite, favoritedAt: favorite ? now : null },
    update: { favorite, favoritedAt: favorite ? now : null },
  });
  return getGraphicPrefs(db, userId);
}

/** Record that a preset was inserted (recents + use count). */
export async function recordGraphicPresetUse(db: Db, userId: string, presetId: string, now: Date = new Date()): Promise<GraphicPrefs> {
  assertPresetId(presetId);
  await db.graphicPresetPref.upsert({
    where: { userId_presetId: { userId, presetId } },
    create: { userId, presetId, useCount: 1, lastUsedAt: now },
    update: { useCount: { increment: 1 }, lastUsedAt: now },
  });
  return getGraphicPrefs(db, userId);
}
