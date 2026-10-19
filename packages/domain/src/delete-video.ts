import type { PrismaClient } from "@prisma/client";
import { applyTransition } from "./state-machine";
import { recordAudit } from "./audit";
import { discardRecordingSession } from "./recording-session";

/**
 * "Delete video" (Chris, from the video page or the Plan board): the video leaves every list
 * (Videos, Home, Plan, Calendar — they all skip CANCELLED) and its MEDIA is removed, but its
 * HISTORY stays (CLAUDE.md / docs/SECURITY.md: deleting media is fine, deleting the audit trail
 * is not). So: discard any open recording draft, transition to CANCELLED ("Deleted by Chris"),
 * audit it, and return every storage key (takes, proxies, filmstrips, mattes, renders, platform
 * variants, graphic bakes) for the caller to delete from storage. Idempotent.
 */
export async function deleteVideo(
  prisma: PrismaClient,
  input: { contentItemId: string; reason?: string },
  actor: { actorId: string },
): Promise<{ deleted: boolean; storageKeys: string[] }> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: input.contentItemId }, select: { id: true, currentState: true, title: true } });
  const keys = new Set<string>();
  for (const s of await prisma.recordingSession.findMany({ where: { contentItemId: item.id, status: "DRAFT" }, select: { id: true } })) {
    const r = await discardRecordingSession(prisma, { recordingSessionId: s.id, contentItemId: item.id }, actor);
    r.storageKeys.forEach((k) => keys.add(k));
  }
  for (const a of await prisma.mediaAsset.findMany({ where: { contentItemId: item.id }, select: { storageKey: true, matteStorageKey: true, proxyStorageKey: true, filmstripStorageKey: true } })) {
    [a.storageKey, a.matteStorageKey, a.proxyStorageKey, a.filmstripStorageKey].forEach((k) => k && keys.add(k));
  }
  for (const r of await prisma.render.findMany({ where: { contentItemId: item.id }, select: { storageKey: true } })) if (r.storageKey) keys.add(r.storageKey);
  for (const v of await prisma.renderVariant.findMany({ where: { contentItemId: item.id }, select: { storageKey: true, coverStorageKey: true } })) {
    [v.storageKey, v.coverStorageKey].forEach((k) => k && keys.add(k));
  }
  for (const b of await prisma.graphicBake.findMany({ where: { contentItemId: item.id }, select: { storageKey: true } })) if (b.storageKey) keys.add(b.storageKey);

  const already = item.currentState === "CANCELLED";
  if (!already) {
    await applyTransition(prisma, {
      contentItemId: item.id,
      to: "CANCELLED",
      actorType: "HUMAN",
      actorId: actor.actorId,
      reason: input.reason?.trim() || "Deleted by Chris",
    });
  }
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "VIDEO_DELETED",
    entityType: "ContentItem",
    entityId: item.id,
    before: { state: item.currentState, title: item.title },
    after: { state: "CANCELLED", mediaFilesRemoved: keys.size },
  });
  return { deleted: !already, storageKeys: [...keys] };
}
