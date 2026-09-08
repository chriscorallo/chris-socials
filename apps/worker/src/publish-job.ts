import { createHash } from "node:crypto";
import {
  startPublishing,
  recordPublicationAttempt,
  finalizePublishing,
  getLatestPublication,
  getLatestPlatformPackage,
  runPreflight,
  computePublishIdempotencyKey,
  type PrismaClient,
  type ContentPlatform,
} from "@chris/domain";
import { getYouTubeQuotaState, YOUTUBE_UPLOAD_DAILY_BUDGET, type PlatformAdapter } from "@chris/platforms";
import type { StorageAdapter } from "@chris/media";

export interface PublishJobResult {
  succeededPlatforms: ContentPlatform[];
  failedPlatforms: ContentPlatform[];
  /** Platforms that couldn't even be attempted — no PlatformPackage exists yet, so there is no
   * valid Publication row to write (the FK is required — see /docs/DECISIONS.md). A real
   * precondition failure ("you forgot to package this platform"), not an operational one. */
  skippedPlatforms: { platform: ContentPlatform; reason: string }[];
  transitioned: boolean;
}

/**
 * Orchestrates spec §9 steps 21-22 (Preflight, Publish + Verify) for one ContentItem across
 * every one of its scheduled target platforms — the process apps/worker exists for, same
 * rationale as render-job.ts/quality-gate-job.ts: real I/O (storage, network) belongs outside
 * packages/domain.
 *
 * Graceful per-platform failure (spec §21 "one platform fails, the others continue") is
 * structural here, not incidental: each platform is a separate iteration wrapped in its own
 * try/catch, and even a thrown exception from an adapter still gets recorded as a FAILED
 * Publication (never silently swallowed) before moving on to the next platform.
 */
export async function publishContentItem(
  db: PrismaClient,
  storage: StorageAdapter,
  adapters: Partial<Record<ContentPlatform, PlatformAdapter>>,
  contentItemId: string,
  actor: { actorId: string },
  /** Overridable for tests that need to exercise quota-exhaustion without waiting for (or
   * polluting) real wall-clock "today" — see /docs/DECISIONS.md's youtube-quota date-range
   * bug for why that matters. Production callers omit this and get the real current time. */
  options: { now?: Date } = {},
): Promise<PublishJobResult> {
  const now = options.now ?? new Date();
  const current = await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (current.currentState === "SCHEDULED") {
    await startPublishing(db, contentItemId, actor);
  }

  const schedule = await db.scheduleEntry.findUniqueOrThrow({ where: { contentItemId } });
  const targetPlatforms = schedule.targetPlatforms as unknown as ContentPlatform[];

  const render = await db.render.findFirst({
    where: { contentItemId, status: "SUCCESS" },
    orderBy: { createdAt: "desc" },
  });

  let mediaHash: string | null = null;
  let videoBytes: Buffer | null = null;
  if (render?.storageKey) {
    videoBytes = await storage.get(render.storageKey);
    mediaHash = createHash("sha256").update(videoBytes).digest("hex");
  }

  const succeededPlatforms: ContentPlatform[] = [];
  const failedPlatforms: ContentPlatform[] = [];
  const skippedPlatforms: { platform: ContentPlatform; reason: string }[] = [];

  for (const platform of targetPlatforms) {
    try {
      // Idempotent retry: a prior SUCCESS/DRAFT for this platform means the real work already
      // happened — never call an adapter again for it, just count it as already-succeeded.
      const existing = await getLatestPublication(db, contentItemId, platform);
      if (existing && (existing.status === "SUCCESS" || existing.status === "DRAFT")) {
        succeededPlatforms.push(platform);
        continue;
      }

      const pkg = await getLatestPlatformPackage(db, contentItemId, platform);
      if (!pkg) {
        skippedPlatforms.push({ platform, reason: `No PlatformPackage recorded for ${platform} yet.` });
        continue;
      }

      // YouTube's dedicated upload-quota bucket is checked before ever touching the adapter —
      // burning a real network call on a request already known to fail wastes the very quota
      // being protected. See /docs/DECISIONS.md's corrected quota numbers.
      if (platform === "YOUTUBE") {
        const quota = await getYouTubeQuotaState(db, now);
        if (!quota.canUploadNow) {
          await recordPublicationAttempt(
            db,
            {
              contentItemId,
              platform,
              platformPackageId: pkg.id,
              idempotencyKey: computePublishIdempotencyKey(contentItemId, platform),
              status: "FAILED",
              errorMessage: `YouTube daily upload quota exhausted (${quota.uploadCallsUsedToday}/${YOUTUBE_UPLOAD_DAILY_BUDGET} today).`,
            },
            actor,
          );
          failedPlatforms.push(platform);
          continue;
        }
      }

      const adapter = adapters[platform];
      const credentialCheck = adapter
        ? await adapter.checkCredentials()
        : { ok: false, reason: `No adapter configured for ${platform}.` };

      const preflight = await runPreflight(db, {
        contentItemId,
        platform,
        credentialsOk: credentialCheck.ok,
        credentialsReason: credentialCheck.reason,
        mediaHash,
      });
      if (preflight.status === "BLOCK") {
        await recordPublicationAttempt(
          db,
          {
            contentItemId,
            platform,
            platformPackageId: pkg.id,
            idempotencyKey: computePublishIdempotencyKey(contentItemId, platform),
            status: "FAILED",
            errorMessage: `Preflight blocked: ${preflight.reasons.join("; ")}`,
          },
          actor,
        );
        failedPlatforms.push(platform);
        continue;
      }

      if (!adapter || !videoBytes) {
        // Unreachable in practice (preflight already checked credentials and render
        // existence), kept as an explicit guard rather than a non-null assertion — a silent
        // `!` here would be exactly the kind of thing that turns into a confusing crash later.
        await recordPublicationAttempt(
          db,
          {
            contentItemId,
            platform,
            platformPackageId: pkg.id,
            idempotencyKey: computePublishIdempotencyKey(contentItemId, platform),
            status: "FAILED",
            errorMessage: "No adapter or no render bytes available despite preflight PASS.",
          },
          actor,
        );
        failedPlatforms.push(platform);
        continue;
      }

      const publishResult = await adapter.publish({
        contentItemId,
        videoBytes,
        publicVideoUrl: null, // no public signed-URL storage adapter yet — see /docs/DECISIONS.md
        caption: pkg.caption,
        title: pkg.title,
        hashtags: pkg.hashtags as unknown as string[],
        coverFrameSeconds: pkg.coverFrameSeconds,
        idempotencyKey: computePublishIdempotencyKey(contentItemId, platform),
      });

      await recordPublicationAttempt(
        db,
        {
          contentItemId,
          platform,
          platformPackageId: pkg.id,
          idempotencyKey: computePublishIdempotencyKey(contentItemId, platform),
          status: publishResult.status,
          platformPostId: publishResult.platformPostId,
          url: publishResult.url,
          mediaHash,
          rawResponse: publishResult.rawResponse,
          errorMessage: publishResult.errorMessage,
        },
        actor,
      );

      if (publishResult.status === "SUCCESS" || publishResult.status === "DRAFT") {
        succeededPlatforms.push(platform);
      } else {
        failedPlatforms.push(platform);
      }
    } catch (err) {
      // An adapter throwing (network error, unexpected shape) still gets recorded — never a
      // silent swallow — and never stops the loop over the remaining platforms.
      const pkg = await getLatestPlatformPackage(db, contentItemId, platform);
      if (pkg) {
        await recordPublicationAttempt(
          db,
          {
            contentItemId,
            platform,
            platformPackageId: pkg.id,
            idempotencyKey: computePublishIdempotencyKey(contentItemId, platform),
            status: "FAILED",
            errorMessage: err instanceof Error ? err.message : String(err),
          },
          actor,
        );
      }
      failedPlatforms.push(platform);
    }
  }

  const finalized = await finalizePublishing(db, contentItemId, actor);

  return { succeededPlatforms, failedPlatforms, skippedPlatforms, transitioned: finalized.transitioned };
}
