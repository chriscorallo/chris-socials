import type { PrismaClient, ContentItem, ContentState } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";

/**
 * The IDEAS backlog and CONTENT list are both views over ContentItem — there is no separate
 * ContentIdea table in this phase. See /docs/DECISIONS.md ("Phase 1: no separate ContentIdea
 * table") for why. A ContentItem starts life in state IDEA (Phase 0 schema default) and is
 * exactly what the IDEAS nav shows until it's SELECTED into a week.
 */
export const CreateContentItemSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  pillar: z.enum(["SKILL", "MINDSET", "LIFESTYLE", "PASSIONS"]).optional(),
  format: z.string().optional(),
});

export type CreateContentItemInput = z.infer<typeof CreateContentItemSchema>;

export async function createContentItem(
  prisma: PrismaClient,
  input: CreateContentItemInput,
  actor: { actorId: string },
): Promise<ContentItem> {
  const parsed = CreateContentItemSchema.parse(input);
  const item = await prisma.contentItem.create({ data: parsed });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "CONTENT_ITEM_CREATED",
    entityType: "ContentItem",
    entityId: item.id,
    after: { title: item.title, currentState: item.currentState },
  });

  return item;
}

/**
 * Fetches a ContentItem with all its related artifacts, as separate sequential queries
 * rather than one `include` with many nested relations — see /docs/DECISIONS.md ("combining
 * many relations in one nested include crashes the PGlite dev database"). Sequential, not
 * `Promise.all`: this sandbox's PGlite dev database also breaks under concurrently
 * dispatched queries (confirmed by bisection — even a single pooled connection with
 * `connection_limit=1` still fails under `Promise.all`, so the issue is concurrent dispatch
 * itself, not pool size). Real Postgres handles both patterns fine; sequential awaits were
 * chosen because they're proven reliable here and the cost (a handful of fast local queries)
 * is negligible.
 *
 * researchPackets[0] / scriptVersions[0] is "current" — both are append-only (episodic
 * memory, per /docs/ARCHITECTURE.md), ordered most-recent-first.
 */
export async function getContentItem(prisma: PrismaClient, id: string) {
  const item = await prisma.contentItem.findUnique({ where: { id } });
  if (!item) return null;

  const productionContract = await prisma.productionContract.findUnique({
    where: { contentItemId: id },
  });
  const creatorCard = await prisma.creatorCard.findUnique({ where: { contentItemId: id } });
  const mediaAssets = await prisma.mediaAsset.findMany({
    where: { contentItemId: id },
    orderBy: { createdAt: "desc" },
  });
  const scheduleEntry = await prisma.scheduleEntry.findUnique({ where: { contentItemId: id } });
  const transitions = await prisma.contentStateTransition.findMany({
    where: { contentItemId: id },
    orderBy: { createdAt: "asc" },
  });
  const researchPackets = await prisma.researchPacket.findMany({
    where: { contentItemId: id },
    orderBy: { createdAt: "desc" },
  });
  const scriptVersions = await prisma.scriptVersion.findMany({
    where: { contentItemId: id },
    orderBy: { createdAt: "desc" },
  });
  const takeSelections = await prisma.takeSelection.findMany({
    where: { contentItemId: id },
    orderBy: { createdAt: "desc" },
  });
  const editPlans = await prisma.editPlan.findMany({
    where: { contentItemId: id },
    orderBy: { createdAt: "desc" },
  });
  const renders = await prisma.render.findMany({
    where: { contentItemId: id },
    orderBy: { createdAt: "desc" },
  });
  const qcReports = await prisma.qCReport.findMany({
    where: { contentItemId: id },
    orderBy: { createdAt: "desc" },
  });
  // Only the latest QCReport's issues are worth the page ever showing — fetched separately
  // (not folded into the qcReports query above) for the same reason every other relation here
  // is its own sequential call rather than a nested `include`.
  const latestQCIssues = qcReports[0]
    ? await prisma.qCIssue.findMany({
        where: { qcReportId: qcReports[0].id },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const platformPackages = await prisma.platformPackage.findMany({
    where: { contentItemId: id },
    orderBy: { createdAt: "desc" },
  });
  const publications = await prisma.publication.findMany({
    where: { contentItemId: id },
    orderBy: { createdAt: "desc" },
  });
  const performanceSnapshots = await prisma.performanceSnapshot.findMany({
    where: { contentItemId: id },
    orderBy: [{ platform: "asc" }, { capturedAt: "asc" }],
  });
  const comments = await prisma.comment.findMany({
    where: { contentItemId: id },
    orderBy: { ingestedAt: "desc" },
  });
  const performanceEvaluations = await prisma.performanceEvaluation.findMany({
    where: { contentItemId: id },
    orderBy: { createdAt: "desc" },
  });
  const tasteFeedback = await prisma.tasteFeedback.findMany({
    where: { contentItemId: id },
    orderBy: { createdAt: "desc" },
  });
  const adversarialCritiques = await prisma.adversarialCritique.findMany({
    where: { contentItemId: id },
    orderBy: { createdAt: "desc" },
  });

  return {
    ...item,
    productionContract,
    creatorCard,
    mediaAssets,
    scheduleEntry,
    transitions,
    researchPackets,
    scriptVersions,
    takeSelections,
    platformPackages,
    publications,
    editPlans,
    renders,
    qcReports,
    latestQCIssues,
    performanceSnapshots,
    comments,
    performanceEvaluations,
    tasteFeedback,
    adversarialCritiques,
  };
}

export async function listContentItems(
  prisma: PrismaClient,
  opts?: { state?: ContentState | ContentState[]; limit?: number },
) {
  return prisma.contentItem.findMany({
    where: opts?.state
      ? { currentState: Array.isArray(opts.state) ? { in: opts.state } : opts.state }
      : undefined,
    orderBy: { createdAt: "desc" },
    take: opts?.limit,
  });
}

/** Real row count behind a limited list() call — lets a UI say "+N more" honestly instead of
 * either fetching everything just to count it, or pretending a capped list is exhaustive. */
export async function countContentItems(
  prisma: PrismaClient,
  opts?: { state?: ContentState | ContentState[] },
) {
  return prisma.contentItem.count({
    where: opts?.state
      ? { currentState: Array.isArray(opts.state) ? { in: opts.state } : opts.state }
      : undefined,
  });
}
