import type { PrismaClient, ContentPlatform, ViewerReview as ViewerReviewRow } from "@prisma/client";
import { recordAudit } from "./audit";

/**
 * Viewer Panel reviews — an AI first-time viewer's take on one whole video (prompt
 * VIEWER_PANEL, packages/agents viewer-panel.ts). ADVISORY ONLY: no hard gate, state
 * transition or quality-gate aggregation ever reads these rows. Append-only: every run is a new
 * row tied to exactly what was watched (Render + EditPlan, or a reference video); nothing here
 * updates or deletes one. The review JSON is validated by the agent's zod schema before it gets
 * here; this layer only checks the shape it relies on for listing.
 */

export const VIEWER_REVIEW_TIERS = ["BAD", "OKAY", "GOOD", "GREAT", "EXCEPTIONAL"] as const;
export type ViewerReviewTier = (typeof VIEWER_REVIEW_TIERS)[number];

export interface RecordViewerReviewInput {
  subject:
    | { kind: "RENDER"; contentItemId: string; renderId: string; editPlanId: string | null }
    | { kind: "REFERENCE_VIDEO"; referenceContentId: string };
  mediaStorageKey: string;
  platform: ContentPlatform;
  persona: "COLD" | "FOLLOWER";
  promptId: string;
  promptVersion: string;
  model: string;
  review: unknown;
  warnings: string[];
  inputSummary: Record<string, unknown>;
  estimatedCostUsd: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  jobRunId: string | null;
}

function tierOf(review: unknown): ViewerReviewTier {
  const tier = (review as { verdict?: { tier?: unknown } } | null)?.verdict?.tier;
  if (typeof tier !== "string" || !(VIEWER_REVIEW_TIERS as readonly string[]).includes(tier)) {
    throw new Error("A viewer review must have a verdict tier (BAD / OKAY / GOOD / GREAT / EXCEPTIONAL).");
  }
  return tier as ViewerReviewTier;
}

export async function recordViewerReview(
  prisma: PrismaClient,
  input: RecordViewerReviewInput,
  actor: { actorId: string },
): Promise<ViewerReviewRow> {
  const verdictTier = tierOf(input.review);
  const s = input.subject;
  const row = await prisma.viewerReview.create({
    data: {
      subjectKind: s.kind,
      contentItemId: s.kind === "RENDER" ? s.contentItemId : null,
      renderId: s.kind === "RENDER" ? s.renderId : null,
      editPlanId: s.kind === "RENDER" ? s.editPlanId : null,
      referenceContentId: s.kind === "REFERENCE_VIDEO" ? s.referenceContentId : null,
      mediaStorageKey: input.mediaStorageKey,
      platform: input.platform,
      persona: input.persona,
      promptId: input.promptId,
      promptVersion: input.promptVersion,
      model: input.model,
      review: input.review as object,
      warnings: input.warnings,
      inputSummary: input.inputSummary as object,
      verdictTier,
      estimatedCostUsd: input.estimatedCostUsd,
      costUsd: input.costUsd,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      jobRunId: input.jobRunId,
      createdBy: actor.actorId,
    },
  });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "VIEWER_REVIEW_RECORDED",
    entityType: "ViewerReview",
    entityId: row.id,
    after: {
      subjectKind: s.kind,
      contentItemId: row.contentItemId,
      renderId: row.renderId,
      referenceContentId: row.referenceContentId,
      verdictTier,
      model: input.model,
      estimatedCostUsd: input.estimatedCostUsd,
      costUsd: input.costUsd,
    },
  });
  return row;
}

/** Newest review of a video (any render) or of a reference video. */
export async function getLatestViewerReview(
  prisma: PrismaClient,
  where: { contentItemId: string } | { referenceContentId: string },
): Promise<ViewerReviewRow | null> {
  return prisma.viewerReview.findFirst({ where, orderBy: { createdAt: "desc" } });
}

/** Latest review per reference video, for a list of ids (one query). */
export async function latestViewerReviewsForReferences(prisma: PrismaClient, referenceContentIds: string[]): Promise<Map<string, ViewerReviewRow>> {
  const out = new Map<string, ViewerReviewRow>();
  if (referenceContentIds.length === 0) return out;
  const rows = await prisma.viewerReview.findMany({ where: { referenceContentId: { in: referenceContentIds } }, orderBy: { createdAt: "desc" } });
  for (const r of rows) if (r.referenceContentId && !out.has(r.referenceContentId)) out.set(r.referenceContentId, r);
  return out;
}

export async function countViewerReviews(prisma: PrismaClient, where: { contentItemId: string } | { referenceContentId: string }): Promise<number> {
  return prisma.viewerReview.count({ where });
}
