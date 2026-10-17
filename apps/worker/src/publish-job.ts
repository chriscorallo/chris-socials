import { createHash } from "node:crypto";
import { ensurePlatformVariant } from "./platform-variant-job";
import {
  startPublishing,
  recordPublicationAttempt,
  finalizePublishing,
  getLatestPublication,
  getLatestPlatformPackage,
  runPreflight,
  computePublishIdempotencyKey,
  acquirePublishLease,
  releasePublishLease,
  isAmbiguousPublication,
  getResumeToken,
  markPublicationVerified,
  notePublicationVerificationPending,
  verificationPendingNote,
  AMBIGUOUS_PUBLISH_PREFIX,
  type PrismaClient,
  type ContentPlatform,
  type Publication,
} from "@chris/domain";
import {
  getYouTubeQuotaState,
  YOUTUBE_UPLOAD_DAILY_BUDGET,
  AmbiguousPublishError,
  type PlatformAdapter,
} from "@chris/platforms";
import type { StorageAdapter } from "@chris/media";

export interface PublishJobResult {
  succeededPlatforms: ContentPlatform[];
  failedPlatforms: ContentPlatform[];
  /** Platforms that couldn't even be attempted — no PlatformPackage yet, or another publish of
   * the same (item, platform) is already in flight (lease held). */
  skippedPlatforms: { platform: ContentPlatform; reason: string }[];
  /** Successful platforms whose post was independently confirmed on the platform. */
  verifiedPlatforms: ContentPlatform[];
  transitioned: boolean;
}

export interface PublishJobOptions {
  /** Overridable for quota tests — see /docs/DECISIONS.md's youtube-quota date-range bug. */
  now?: Date;
  /** Resolves a render's storage key to a public, time-limited URL (Instagram fetches the
   * video itself; it has no binary upload in the Instagram-Login API). Wired by apps/web to
   * Vercel Blob. Absent / null => Instagram fails with a clear reason. */
  getPublicVideoUrl?: (storageKey: string) => Promise<string | null>;
  /** Delays before each verify attempt (ms). Default [2000, 5000, 10000] — a short budget;
   * anything still unverified is re-checked by the snapshot sweep. */
  verifyDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  /** Restrict this run to a subset of the scheduled target platforms (e.g. the scheduled
   * sweep resuming only a platform with a pending-processing container). */
  onlyPlatforms?: ContentPlatform[];
  /** Upload each platform's own optimized encode of the master render (RenderVariant —
   * platform-variant-job.ts) instead of the master itself. Wired ON by apps/web; off by
   * default so unit tests can use placeholder render bytes. */
  platformVariants?: boolean;
}

/** A resumable platform state older than this is considered dead (Instagram containers expire
 * after 24h) — the retry starts over instead. */
const RESUME_MAX_AGE_MS = 23 * 60 * 60 * 1000;

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Spec §9 steps 21-22 (Preflight, Publish + Verify) for one ContentItem across its scheduled
 * target platforms. Per-platform isolation (spec §21): each platform runs in its own
 * try/catch; a thrown adapter error is still recorded as a FAILED Publication.
 *
 * Safety properties:
 * - Idempotent: a platform whose latest attempt is SUCCESS/DRAFT is never re-posted.
 * - Mutually exclusive per (item, platform): a lease (packages/domain job-run.ts) makes a
 *   double-click / second tab / cron+human overlap skip instead of double-posting.
 * - Ambiguous outcomes (no response during the commit step) are recorded with an AMBIGUOUS
 *   prefix; the next retry first asks the platform whether the post exists.
 * - Resumable: an Instagram container still processing is resumed, not re-uploaded.
 * - Verified: every success is read back from the platform (verifiedAt).
 * - Retrying a FAILED platform on an already-PUBLISHED/MEASURING item is allowed (no state
 *   regression).
 */
export async function publishContentItem(
  db: PrismaClient,
  storage: StorageAdapter,
  adapters: Partial<Record<ContentPlatform, PlatformAdapter>>,
  contentItemId: string,
  actor: { actorId: string },
  options: PublishJobOptions = {},
): Promise<PublishJobResult> {
  const now = options.now ?? new Date();
  const sleep = options.sleep ?? sleepReal;
  const verifyDelaysMs = options.verifyDelaysMs ?? [2000, 5000, 10000];

  const current = await db.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (current.currentState === "SCHEDULED") {
    await startPublishing(db, contentItemId, actor);
  }

  const schedule = await db.scheduleEntry.findUniqueOrThrow({ where: { contentItemId } });
  const targetPlatforms = (schedule.targetPlatforms as unknown as ContentPlatform[]).filter(
    (p) => !options.onlyPlatforms || options.onlyPlatforms.includes(p),
  );

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

  const publicUrlCache = new Map<string, { url: string | null; error: string | null }>();
  async function publicVideoUrl(storageKey: string | null | undefined): Promise<{ url: string | null; error: string | null }> {
    if (!storageKey || !options.getPublicVideoUrl) return { url: null, error: null };
    const cached = publicUrlCache.get(storageKey);
    if (cached) return cached;
    let resolved: { url: string | null; error: string | null };
    try {
      resolved = { url: await options.getPublicVideoUrl(storageKey), error: null };
    } catch (err) {
      resolved = { url: null, error: err instanceof Error ? err.message : String(err) };
    }
    publicUrlCache.set(storageKey, resolved);
    return resolved;
  }

  // The thumbnail Chris picked in the finishing editor wins over the packaging agent's pick.
  const latestPlan = await db.editPlan.findFirst({ where: { contentItemId }, orderBy: { createdAt: "desc" } });
  const timelineCover = ((latestPlan?.plan as { timeline?: { coverFrameSeconds?: number | null } } | null)?.timeline
    ?.coverFrameSeconds ?? null) as number | null;

  const succeededPlatforms: ContentPlatform[] = [];
  const failedPlatforms: ContentPlatform[] = [];
  const skippedPlatforms: { platform: ContentPlatform; reason: string }[] = [];
  const verifiedPlatforms: ContentPlatform[] = [];

  for (const platform of targetPlatforms) {
    const idempotencyKey = computePublishIdempotencyKey(contentItemId, platform);
    let leaseId: string | null = null;
    let outcome: "SUCCEEDED" | "FAILED" = "FAILED";
    let outcomeError: string | null = null;

    try {
      const existing = await getLatestPublication(db, contentItemId, platform);
      if (existing && (existing.status === "SUCCESS" || existing.status === "DRAFT")) {
        succeededPlatforms.push(platform);
        if (existing.verifiedAt) verifiedPlatforms.push(platform);
        continue;
      }

      const pkg = await getLatestPlatformPackage(db, contentItemId, platform);
      if (!pkg) {
        skippedPlatforms.push({ platform, reason: `No PlatformPackage recorded for ${platform} yet.` });
        continue;
      }

      const lease = await acquirePublishLease(db, contentItemId, platform);
      if (!lease.acquired) {
        skippedPlatforms.push({
          platform,
          reason: `A publish to ${platform} for this item is already in progress (started ${lease.heldSince.toISOString()}).`,
        });
        continue;
      }
      leaseId = lease.leaseId;

      // Re-read under the lease: a concurrent run may have finished between the check above
      // and acquiring the lease.
      const latest = await getLatestPublication(db, contentItemId, platform);
      if (latest && (latest.status === "SUCCESS" || latest.status === "DRAFT")) {
        succeededPlatforms.push(platform);
        if (latest.verifiedAt) verifiedPlatforms.push(platform);
        outcome = "SUCCEEDED";
        continue;
      }

      const recordFailure = (errorMessage: string, rawResponse?: unknown) =>
        recordPublicationAttempt(
          db,
          { contentItemId, platform, platformPackageId: pkg.id, idempotencyKey, status: "FAILED", errorMessage, rawResponse, mediaHash },
          actor,
        );

      // YouTube's dedicated upload-quota bucket is checked before touching the adapter.
      if (platform === "YOUTUBE") {
        const quota = await getYouTubeQuotaState(db, now);
        if (!quota.canUploadNow) {
          await recordFailure(`YouTube daily upload quota exhausted (${quota.uploadCallsUsedToday}/${YOUTUBE_UPLOAD_DAILY_BUDGET} today).`);
          failedPlatforms.push(platform);
          outcomeError = "quota exhausted";
          continue;
        }
      }

      const adapter = adapters[platform];
      let credentialCheck: { ok: boolean; reason?: string };
      try {
        credentialCheck = adapter ? await adapter.checkCredentials() : { ok: false, reason: `No adapter configured for ${platform}.` };
      } catch (err) {
        credentialCheck = { ok: false, reason: `${platform} credential check errored: ${err instanceof Error ? err.message : String(err)}` };
      }

      let maxDurationSecondsOverride: number | undefined;
      if (adapter?.getPublishConstraints && credentialCheck.ok) {
        try {
          maxDurationSecondsOverride = (await adapter.getPublishConstraints()).maxDurationSeconds;
        } catch {
          // Live constraints are an extra safety check; the static platform limits still apply.
        }
      }

      const preflight = await runPreflight(db, {
        contentItemId,
        platform,
        credentialsOk: credentialCheck.ok,
        credentialsReason: credentialCheck.reason,
        mediaHash,
        maxDurationSecondsOverride,
      });
      if (preflight.status === "BLOCK") {
        await recordFailure(`Preflight blocked: ${preflight.reasons.join("; ")}`);
        failedPlatforms.push(platform);
        outcomeError = "preflight blocked";
        continue;
      }

      if (!adapter || !videoBytes || !render?.storageKey) {
        await recordFailure("No adapter or no render bytes available despite preflight PASS.");
        failedPlatforms.push(platform);
        continue;
      }

      const hashtags = pkg.hashtags as unknown as string[];
      const coverFrameSeconds = timelineCover ?? pkg.coverFrameSeconds;

      // What actually uploads: this platform's optimized encode of the master (when enabled),
      // else the master itself.
      let uploadBytes: Buffer = videoBytes;
      let uploadHash: string | null = mediaHash;
      let uploadKey: string = render.storageKey;
      let uploadDuration: number | null = render.durationSeconds;
      if (options.platformVariants) {
        try {
          const variant = await ensurePlatformVariant(db, storage, { renderId: render.id, platform, coverFrameSeconds }, actor);
          uploadBytes = variant.bytes;
          uploadHash = variant.sha256;
          uploadKey = variant.storageKey;
          uploadDuration = variant.durationSeconds;
        } catch (err) {
          await recordFailure(`Couldn't prepare the ${platform} version: ${err instanceof Error ? err.message : String(err)}`);
          failedPlatforms.push(platform);
          outcomeError = "variant failed";
          continue;
        }
      }

      // The previous attempt may have posted without us hearing back — look before re-posting.
      if (latest && isAmbiguousPublication(latest)) {
        const recovered = await resolveAmbiguousAttempt(db, adapter, latest, pkg, hashtags, mediaHash, actor);
        if (recovered === "BLOCKED") {
          failedPlatforms.push(platform);
          outcomeError = "ambiguous previous attempt could not be checked";
          continue;
        }
        if (recovered) {
          succeededPlatforms.push(platform);
          if (await verifyPublication(db, adapter, recovered, verifyDelaysMs, sleep, actor)) verifiedPlatforms.push(platform);
          outcome = "SUCCEEDED";
          continue;
        }
      }

      const resumeToken =
        latest && now.getTime() - latest.createdAt.getTime() < RESUME_MAX_AGE_MS ? getResumeToken(latest) : null;

      let publicUrl: string | null = null;
      if (platform === "INSTAGRAM" && !resumeToken) {
        const resolved = await publicVideoUrl(uploadKey);
        if (!resolved.url) {
          await recordFailure(
            resolved.error
              ? `Could not create a public video URL for Instagram: ${resolved.error}`
              : "Instagram needs a public video URL and no public media URL provider is configured (getPublicVideoUrl).",
          );
          failedPlatforms.push(platform);
          continue;
        }
        publicUrl = resolved.url;
      }

      let publishResult;
      try {
        publishResult = await adapter.publish({
          contentItemId,
          videoBytes: uploadBytes,
          publicVideoUrl: publicUrl,
          caption: pkg.caption,
          title: pkg.title,
          hashtags,
          coverFrameSeconds,
          idempotencyKey,
          durationSeconds: uploadDuration,
          resumeToken,
        });
      } catch (err) {
        if (err instanceof AmbiguousPublishError) {
          await recordFailure(
            `${AMBIGUOUS_PUBLISH_PREFIX} ${err.message} The next retry checks ${platform} for this post before posting again.`,
            { ambiguous: true, partial: err.partialResponse },
          );
          failedPlatforms.push(platform);
          outcomeError = "ambiguous";
          continue;
        }
        throw err;
      }

      const publication = await recordPublicationAttempt(
        db,
        {
          contentItemId,
          platform,
          platformPackageId: pkg.id,
          idempotencyKey,
          status: publishResult.status,
          platformPostId: publishResult.platformPostId,
          url: publishResult.url,
          mediaHash: uploadHash,
          rawResponse:
            publishResult.resumeToken !== undefined
              ? { ...(asObject(publishResult.rawResponse)), resumeToken: publishResult.resumeToken }
              : publishResult.rawResponse,
          errorMessage: publishResult.errorMessage,
        },
        actor,
      );

      if (publishResult.status === "SUCCESS" || publishResult.status === "DRAFT") {
        succeededPlatforms.push(platform);
        outcome = "SUCCEEDED";
        if (await verifyPublication(db, adapter, publication, verifyDelaysMs, sleep, actor)) verifiedPlatforms.push(platform);
      } else {
        failedPlatforms.push(platform);
        outcomeError = publishResult.errorMessage ?? "failed";
      }
    } catch (err) {
      // Never a silent swallow, never stops the loop over the remaining platforms.
      outcomeError = err instanceof Error ? err.message : String(err);
      const pkg = await getLatestPlatformPackage(db, contentItemId, platform);
      if (pkg) {
        await recordPublicationAttempt(
          db,
          { contentItemId, platform, platformPackageId: pkg.id, idempotencyKey, status: "FAILED", errorMessage: outcomeError },
          actor,
        );
      }
      failedPlatforms.push(platform);
    } finally {
      if (leaseId) {
        await releasePublishLease(db, leaseId, {
          status: outcome,
          summary: { contentItemId, platform },
          error: outcome === "FAILED" ? outcomeError : null,
        });
      }
    }
  }

  const finalized = await finalizePublishing(db, contentItemId, actor);

  return { succeededPlatforms, failedPlatforms, skippedPlatforms, verifiedPlatforms, transitioned: finalized.transitioned };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { response: value };
}

/**
 * Returns the recovered Publication when the platform already has the post, null when it
 * definitely doesn't (safe to post), or "BLOCKED" when the platform can't be checked — in which
 * case a FAILED attempt (without the AMBIGUOUS prefix) tells Chris to check manually; a further
 * deliberate retry then posts.
 */
async function resolveAmbiguousAttempt(
  db: PrismaClient,
  adapter: PlatformAdapter,
  latest: Publication,
  pkg: { id: string; caption: string; title: string | null },
  hashtags: string[],
  mediaHash: string | null,
  actor: { actorId: string },
): Promise<Publication | null | "BLOCKED"> {
  const base = {
    contentItemId: latest.contentItemId,
    platform: latest.platform,
    platformPackageId: pkg.id,
    idempotencyKey: latest.idempotencyKey,
    mediaHash,
  };
  if (!adapter.findExistingPost) {
    await recordPublicationAttempt(
      db,
      {
        ...base,
        status: "FAILED",
        errorMessage: `Previous ${latest.platform} attempt was ambiguous and this platform can't be searched automatically — check the account; if the post isn't there, retry to post.`,
      },
      actor,
    );
    return "BLOCKED";
  }
  try {
    const existing = await adapter.findExistingPost({
      caption: pkg.caption,
      title: pkg.title,
      hashtags,
      since: new Date(latest.createdAt.getTime() - 15 * 60 * 1000),
    });
    if (!existing) return null;
    return recordPublicationAttempt(
      db,
      {
        ...base,
        status: "SUCCESS",
        platformPostId: existing.platformPostId,
        url: existing.url,
        rawResponse: { recoveredFromAmbiguousAttempt: latest.id, post: existing.rawResponse },
        errorMessage: "Recovered: the earlier ambiguous attempt had in fact published — not re-posted.",
      },
      actor,
    );
  } catch (err) {
    await recordPublicationAttempt(
      db,
      {
        ...base,
        status: "FAILED",
        errorMessage: `Previous ${latest.platform} attempt was ambiguous and checking for it failed (${err instanceof Error ? err.message : String(err)}) — check the account; if the post isn't there, retry to post.`,
      },
      actor,
    );
    return "BLOCKED";
  }
}

/** Reads the post back from the platform within a short budget; sets verifiedAt on success. */
export async function verifyPublication(
  db: PrismaClient,
  adapter: PlatformAdapter,
  publication: Publication,
  delaysMs: number[],
  sleep: (ms: number) => Promise<void>,
  actor: { actorId: string },
): Promise<boolean> {
  if (!publication.platformPostId) return false;
  let lastNote: string | null = null;
  let lastRaw: unknown = null;
  for (const delay of delaysMs) {
    if (delay > 0) await sleep(delay);
    try {
      const result = await adapter.verify(publication.platformPostId);
      lastRaw = result.rawResponse;
      lastNote = result.note ?? null;
      if (result.verified) {
        await markPublicationVerified(
          db,
          {
            publicationId: publication.id,
            resolvedPostId: result.resolvedPostId ?? null,
            url: result.url ?? null,
            verificationResponse: result.rawResponse,
            note: result.note ?? null,
          },
          actor,
        );
        return true;
      }
      if (!result.pending && result.note) break; // a definitive negative (e.g. rejected)
    } catch (err) {
      lastNote = `Verification errored: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  await notePublicationVerificationPending(
    db,
    publication.id,
    verificationPendingNote(lastNote),
    lastRaw,
  );
  return false;
}
