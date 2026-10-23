import {
  canActAutonomously,
  watchBackEarnedFor,
  scheduleContentItemForPublishing,
  type PrismaClient,
  type ContentPlatform,
} from "@chris/domain";
import type { PlatformAdapter } from "@chris/platforms";
import type { StorageAdapter } from "@chris/media";
import { publishContentItem, type PublishJobOptions, type PublishJobResult } from "./publish-job";

export interface AutonomousPublishResult {
  attempted: boolean;
  reason: string;
  publishResult?: PublishJobResult;
}

/**
 * Spec §23 Level 3 — "approved content classes may auto-schedule/publish." This is the one
 * real "reduced review" behavior this phase implements concretely: for a `READY` item whose
 * production tier has genuinely earned PUBLISHING autonomy (spec's own reliability-threshold
 * mechanism, packages/domain/src/autonomy.ts), it schedules and publishes without a human
 * clicking Schedule/Publish — using whichever platforms the item was already packaged for.
 *
 * Deliberately *not* wired to a cron/background scheduler — this system has no async job
 * queue yet (a documented Phase 5 limitation, see /docs/DECISIONS.md); this function is real,
 * tested, and ready to be invoked by whatever scheduling mechanism eventually exists,
 * consistent with how the Scheduler/Experiment/Weekly-Review agents are also real but
 * currently human-triggered rather than autonomously scheduled.
 *
 * A no-op (never throws) when not eligible — every ineligibility reason is returned, not
 * hidden, so the caller (a human checking "why didn't this publish itself") always gets a
 * real answer.
 */
export async function tryAutonomousPublish(
  db: PrismaClient,
  storage: StorageAdapter,
  adapters: Partial<Record<ContentPlatform, PlatformAdapter>>,
  contentItemId: string,
  actor: { actorId: string },
  /** `publish` is forwarded to publishContentItem (getPublicVideoUrl etc.). The publish path
   * is the same one a human click takes — including preflight's QC-PASS requirement — so
   * autonomy can never bypass the quality gate. */
  options: { requiredLevel?: number; publish?: PublishJobOptions } = {},
): Promise<AutonomousPublishResult> {
  const requiredLevel = options.requiredLevel ?? 3;

  const item = await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (item.currentState !== "READY") {
    return { attempted: false, reason: `Item is at ${item.currentState}, not READY — nothing to auto-publish yet.` };
  }

  const editPlan = await db.editPlan.findFirst({
    where: { contentItemId },
    orderBy: { createdAt: "desc" },
  });
  if (!editPlan) {
    return { attempted: false, reason: "No EditPlan found — can't determine this item's production tier." };
  }

  const eligible = await canActAutonomously(db, "PUBLISHING", editPlan.productionTier, requiredLevel);
  if (!eligible) {
    return {
      attempted: false,
      reason: `PUBLISHING has not reached autonomy level ${requiredLevel} for ${editPlan.productionTier} yet (or the global autonomy.shadow_only kill switch is on) — publish manually.`,
    };
  }

  // The watch-back gate (2026-10-22): the SERIES must have earned hands-off posting — Chris's
  // ratings agreeing with the watch ≥ 90 % over the last ten, no override — on top of the
  // PUBLISHING level. Same kill switch; a stricter bar, never a looser one.
  const earned = await watchBackEarnedFor(db, contentItemId);
  if (!earned.earned) {
    return { attempted: false, reason: `This series hasn't earned hands-off posting yet (${earned.agreement.why}) — publish manually.` };
  }

  const packages = await db.platformPackage.findMany({ where: { contentItemId } });
  if (packages.length === 0) {
    return { attempted: false, reason: "No PlatformPackage exists yet — nothing to schedule/publish." };
  }
  const targetPlatforms = [...new Set(packages.map((p) => p.platform))];

  await scheduleContentItemForPublishing(
    db,
    { contentItemId, scheduledDate: new Date(), targetPlatforms },
    actor,
  );
  const publishResult = await publishContentItem(db, storage, adapters, contentItemId, actor, options.publish);

  return {
    attempted: true,
    reason: `Autonomously scheduled and published — ${editPlan.productionTier} has earned PUBLISHING level ${requiredLevel}+.`,
    publishResult,
  };
}
