import type { PrismaClient, ContentState, ContentPlatform, PublicationStatus } from "@prisma/client";
import { z } from "zod";
import { applyTransition } from "./state-machine";
import { recordAudit } from "./audit";
import { recordApprovedOutcome } from "./autonomy";

/**
 * Spec §9 step 22 ("Publish + Verify... not done until verified") and the graceful-failure
 * principle (§21: "one platform fails, the others continue"). Three separate functions,
 * called in this order by `apps/worker`'s publish job — one ContentItem publishes to multiple
 * platforms, but the state machine only has one PUBLISHING/PUBLISHED state per item, so the
 * per-platform outcomes and the item-level transition are deliberately decoupled:
 *
 * 1. `startPublishing` — SCHEDULED -> PUBLISHING, once, before any platform is attempted.
 * 2. `recordPublicationAttempt` — one call per platform, per attempt. Append-only (same
 *    rationale as Render/QCReport): every attempt is real audit trail, not just the latest.
 *    Never throws on a platform-level failure — a FAILED status is a normal, valid outcome to
 *    persist, not an exception; the caller's per-platform try/catch is for adapter-level
 *    exceptions (network errors etc.), which also get persisted as FAILED here, never left
 *    unrecorded.
 * 3. `finalizePublishing` — call once after every target platform has been attempted.
 *    PUBLISHING -> PUBLISHED if at least one platform's latest attempt is SUCCESS or DRAFT
 *    (TikTok's audit-gated fallback is a real, intentional outcome, not a failure — see
 *    /docs/DECISIONS.md). If every platform failed, the item stays at PUBLISHING — visible as
 *    a "needs you" item for retry (idempotent — see below) or manual intervention, never
 *    silently stuck with no signal.
 */

export class PublishingRequiresScheduledStateError extends Error {
  constructor(actual: ContentState) {
    super(`Publishing can only start from SCHEDULED (current state: ${actual}).`);
    this.name = "PublishingRequiresScheduledStateError";
  }
}

export async function startPublishing(
  prisma: PrismaClient,
  contentItemId: string,
  actor: { actorId: string },
) {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  if (item.currentState !== "SCHEDULED") {
    throw new PublishingRequiresScheduledStateError(item.currentState);
  }
  return applyTransition(prisma, {
    contentItemId,
    to: "PUBLISHING",
    actorType: "SYSTEM",
    actorId: actor.actorId,
    reason: "Publish job started",
  });
}

const RecordPublicationAttemptSchema = z.object({
  contentItemId: z.string().min(1),
  platform: z.enum(["INSTAGRAM", "TIKTOK", "YOUTUBE"]),
  platformPackageId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  status: z.enum(["SUCCESS", "FAILED", "DRAFT"]),
  platformPostId: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  mediaHash: z.string().nullable().optional(),
  rawResponse: z.unknown().optional(),
  errorMessage: z.string().nullable().optional(),
});
export type RecordPublicationAttemptInput = z.input<typeof RecordPublicationAttemptSchema>;

export async function recordPublicationAttempt(
  prisma: PrismaClient,
  input: RecordPublicationAttemptInput,
  actor: { actorId: string },
) {
  const parsed = RecordPublicationAttemptSchema.parse(input);

  const priorAttempts = await prisma.publication.count({
    where: { contentItemId: parsed.contentItemId, platform: parsed.platform },
  });

  const publication = await prisma.publication.create({
    data: {
      contentItemId: parsed.contentItemId,
      platform: parsed.platform,
      platformPackageId: parsed.platformPackageId,
      attempt: priorAttempts + 1,
      idempotencyKey: parsed.idempotencyKey,
      status: parsed.status,
      platformPostId: parsed.platformPostId ?? null,
      url: parsed.url ?? null,
      mediaHash: parsed.mediaHash ?? null,
      rawResponse: (parsed.rawResponse ?? undefined) as never,
      errorMessage: parsed.errorMessage ?? null,
      publishedAt: parsed.status === "SUCCESS" || parsed.status === "DRAFT" ? new Date() : null,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "SYSTEM",
    action: "PUBLICATION_ATTEMPT_RECORDED",
    entityType: "ContentItem",
    entityId: parsed.contentItemId,
    after: {
      publicationId: publication.id,
      platform: publication.platform,
      status: publication.status,
      attempt: publication.attempt,
    },
  });

  return publication;
}

/** One row per (contentItemId, platform) — the most recent attempt, which is what idempotency
 * checks and the finalize step both care about. */
export async function getLatestPublication(
  prisma: PrismaClient,
  contentItemId: string,
  platform: ContentPlatform,
) {
  return prisma.publication.findFirst({
    where: { contentItemId, platform },
    orderBy: { createdAt: "desc" },
  });
}

export async function listPublicationsForContentItem(prisma: PrismaClient, contentItemId: string) {
  return prisma.publication.findMany({
    where: { contentItemId },
    orderBy: { createdAt: "desc" },
  });
}

const TERMINAL_SUCCESS_STATUSES: PublicationStatus[] = ["SUCCESS", "DRAFT"];

export interface FinalizePublishingResult {
  transitioned: boolean;
  succeededPlatforms: ContentPlatform[];
  failedPlatforms: ContentPlatform[];
}

/** Reads the latest attempt per target platform (from the ScheduleEntry's targetPlatforms, not
 * just whatever Publication rows happen to exist — a platform preflight-BLOCKed before ever
 * reaching recordPublicationAttempt still needs to count as "failed" here, not be silently
 * invisible to the finalize decision). */
export async function finalizePublishing(
  prisma: PrismaClient,
  contentItemId: string,
  actor: { actorId: string },
): Promise<FinalizePublishingResult> {
  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: contentItemId } });
  const schedule = await prisma.scheduleEntry.findUnique({ where: { contentItemId } });
  const targetPlatforms = (schedule?.targetPlatforms as unknown as ContentPlatform[]) ?? [];

  const succeededPlatforms: ContentPlatform[] = [];
  const failedPlatforms: ContentPlatform[] = [];

  for (const platform of targetPlatforms) {
    const latest = await getLatestPublication(prisma, contentItemId, platform);
    if (latest && TERMINAL_SUCCESS_STATUSES.includes(latest.status)) {
      succeededPlatforms.push(platform);
    } else {
      failedPlatforms.push(platform);
    }
  }

  if (succeededPlatforms.length === 0) {
    return { transitioned: false, succeededPlatforms, failedPlatforms };
  }

  // Only the PUBLISHING -> PUBLISHED transition itself is an item-level outcome. A retry of a
  // failed platform on an already-PUBLISHED/MEASURING item (or an idempotent re-run) must not
  // transition again nor double-count the autonomy reliability signal below.
  if (item.currentState !== "PUBLISHING") {
    return { transitioned: false, succeededPlatforms, failedPlatforms };
  }

  await applyTransition(prisma, {
    contentItemId,
    to: "PUBLISHED",
    actorType: "SYSTEM",
    actorId: actor.actorId,
    reason:
      failedPlatforms.length === 0
        ? "All target platforms published successfully"
        : `Published to ${succeededPlatforms.join(", ")}; ${failedPlatforms.join(", ")} did not succeed`,
  });

  // Phase 8 — every target platform succeeding with no failures is the real reliability
  // signal for PUBLISHING; a partial-failure publish is a genuine success (graceful
  // degradation working as designed) but a weaker signal, so it deliberately doesn't count
  // here — same standard as EDIT_PLANNING's "first attempt only" rule in quality-gate.ts.
  // Since 2026-10-22 (watch-back gate) an API success alone is no longer the signal: the
  // outcome counts only when Chris rated this video's edit UP (posted as-is). Without a rating
  // nothing is counted — autonomy is agreement with him, not with the platform.
  if (failedPlatforms.length === 0) {
    const rating = await prisma.watchRating.findFirst({ where: { contentItemId }, orderBy: { createdAt: "desc" } });
    const editPlan = await prisma.editPlan.findFirst({
      where: { contentItemId },
      orderBy: { createdAt: "desc" },
    });
    if (editPlan && rating?.rating === "UP") {
      await recordApprovedOutcome(prisma, "PUBLISHING", editPlan.productionTier, actor);
    }
  }

  return { transitioned: true, succeededPlatforms, failedPlatforms };
}

// ---------------------------------------------------------------------------------------------
// Verification + ambiguity helpers (spec §22: "a publish isn't done until verified")
// ---------------------------------------------------------------------------------------------

/** Prefix on `Publication.errorMessage` for an attempt whose outcome is unknown — the request
 * may have reached the platform (timeout / connection reset after upload). A retry must check
 * the platform for an existing post before re-posting. */
export const AMBIGUOUS_PUBLISH_PREFIX = "AMBIGUOUS:";
/** Prefix for a FAILED attempt that left a resumable platform-side state (e.g. an Instagram
 * container still processing) — a retry resumes instead of re-uploading. */
export const PENDING_PROCESSING_PREFIX = "PENDING_PROCESSING:";

export function isAmbiguousPublication(pub: { status: PublicationStatus; errorMessage: string | null }): boolean {
  return pub.status === "FAILED" && (pub.errorMessage ?? "").startsWith(AMBIGUOUS_PUBLISH_PREFIX);
}

/** The adapter-specific resume token recorded on a PENDING_PROCESSING attempt, if any. */
export function getResumeToken(pub: { status: PublicationStatus; rawResponse: unknown }): unknown {
  if (pub.status !== "FAILED") return null;
  const raw = pub.rawResponse as { resumeToken?: unknown } | null;
  return raw && typeof raw === "object" && "resumeToken" in raw ? (raw.resumeToken ?? null) : null;
}

export interface MarkPublicationVerifiedInput {
  publicationId: string;
  verifiedAt?: Date;
  /** The platform's durable post id when it differs from what publish() returned (TikTok's
   * `publish_id` -> real video id once moderation finishes). */
  resolvedPostId?: string | null;
  url?: string | null;
  verificationResponse: unknown;
  /** A human-relevant caveat — e.g. "uploaded but private". Appended to errorMessage so the
   * UI shows it next to the attempt. */
  note?: string | null;
}

/** Sets `verifiedAt` (and resolved id/url) on an existing attempt row. This is the attempt's
 * own outcome being completed, not a history rewrite: the original publish response stays in
 * `rawResponse.publish`, verification goes in `rawResponse.verification`. Audit-logged. */
export async function markPublicationVerified(
  prisma: PrismaClient,
  input: MarkPublicationVerifiedInput,
  actor: { actorId: string },
) {
  const existing = await prisma.publication.findUniqueOrThrow({ where: { id: input.publicationId } });
  const priorRaw = existing.rawResponse as Record<string, unknown> | null;
  const alreadyWrapped = priorRaw !== null && typeof priorRaw === "object" && "publish" in priorRaw;
  const rawResponse = {
    ...(alreadyWrapped ? priorRaw : { publish: priorRaw }),
    verification: input.verificationResponse ?? null,
    ...(input.resolvedPostId && input.resolvedPostId !== existing.platformPostId
      ? { originalPlatformPostId: existing.platformPostId }
      : {}),
  };
  const note = input.note ?? null;
  const withoutPending = stripVerificationPendingNotes(existing.errorMessage);
  const errorMessage =
    note && !(withoutPending ?? "").includes(note) ? [withoutPending, note].filter(Boolean).join(" ") : withoutPending;

  const updated = await prisma.publication.update({
    where: { id: existing.id },
    data: {
      verifiedAt: input.verifiedAt ?? new Date(),
      platformPostId: input.resolvedPostId ?? existing.platformPostId,
      url: input.url ?? existing.url,
      rawResponse: rawResponse as never,
      errorMessage,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "SYSTEM",
    action: "PUBLICATION_VERIFIED",
    entityType: "ContentItem",
    entityId: existing.contentItemId,
    after: {
      publicationId: existing.id,
      platform: existing.platform,
      platformPostId: updated.platformPostId,
      url: updated.url,
      note,
    },
  });
  return updated;
}

const VERIFICATION_PENDING_NOTE = /\s*Not yet verified\b.*?re-checked by the snapshot sweep\./g;

/** Every pending-verification note ends with this sentence, so it can be cleared once the
 * post is verified. */
export function verificationPendingNote(detail: string | null): string {
  return detail ? `Not yet verified (${detail}) — re-checked by the snapshot sweep.` : "Not yet verified — re-checked by the snapshot sweep.";
}

function stripVerificationPendingNotes(message: string | null): string | null {
  if (!message) return message;
  const stripped = message.replace(VERIFICATION_PENDING_NOTE, "").trim();
  return stripped.length > 0 ? stripped : null;
}

/** Records a verification problem/caveat without marking verified (e.g. "still processing",
 * or "resolved post id not yet available"). Idempotent on identical notes. */
export async function notePublicationVerificationPending(
  prisma: PrismaClient,
  publicationId: string,
  note: string,
  verificationResponse: unknown,
) {
  const existing = await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } });
  const priorRaw = existing.rawResponse as Record<string, unknown> | null;
  const alreadyWrapped = priorRaw !== null && typeof priorRaw === "object" && "publish" in priorRaw;
  const rawResponse = {
    ...(alreadyWrapped ? priorRaw : { publish: priorRaw }),
    lastVerification: verificationResponse ?? null,
  };
  return prisma.publication.update({
    where: { id: publicationId },
    data: {
      rawResponse: rawResponse as never,
      // Replace any earlier pending note rather than accumulating one per sweep.
      errorMessage: [stripVerificationPendingNotes(existing.errorMessage), note].filter(Boolean).join(" "),
    },
  });
}

/** Successful (SUCCESS/DRAFT) attempts not yet verified — the verify sweep's work list. */
export async function listUnverifiedPublications(
  prisma: PrismaClient,
  options: { contentItemId?: string; since?: Date; limit?: number } = {},
) {
  return prisma.publication.findMany({
    where: {
      status: { in: ["SUCCESS", "DRAFT"] },
      verifiedAt: null,
      ...(options.contentItemId ? { contentItemId: options.contentItemId } : {}),
      ...(options.since ? { createdAt: { gte: options.since } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 100,
  });
}
