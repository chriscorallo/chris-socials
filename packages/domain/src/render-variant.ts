import type { ContentPlatform, PrismaClient } from "@prisma/client";
import { recordAudit } from "./audit";

/**
 * Per-platform encodes of a master Render (spec §9 step 17 "one master + lightweight
 * variants"). Created on demand by the publish path (apps/worker) and reused: one row per
 * (render, platform, profileVersion). Append-only like every other production artifact.
 */
export interface RecordRenderVariantInput {
  renderId: string;
  contentItemId: string;
  platform: ContentPlatform;
  profileVersion: string;
  storageKey: string;
  coverStorageKey?: string | null;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  fileSizeBytes: number;
  videoBitrateKbps?: number | null;
  audioBitrateKbps?: number | null;
  integratedLufs?: number | null;
  truePeakDbtp?: number | null;
}

export async function recordRenderVariant(
  prisma: PrismaClient,
  input: RecordRenderVariantInput,
  actor: { actorId: string },
) {
  const variant = await prisma.renderVariant.create({ data: { ...input, coverStorageKey: input.coverStorageKey ?? null } });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "SYSTEM",
    action: "RENDER_VARIANT_CREATED",
    entityType: "ContentItem",
    entityId: input.contentItemId,
    after: {
      renderVariantId: variant.id,
      renderId: input.renderId,
      platform: input.platform,
      profileVersion: input.profileVersion,
      fileSizeBytes: input.fileSizeBytes,
      integratedLufs: input.integratedLufs ?? null,
    },
  });
  return variant;
}

export async function findRenderVariant(
  prisma: PrismaClient,
  where: { renderId: string; platform: ContentPlatform; profileVersion: string },
) {
  return prisma.renderVariant.findUnique({ where: { renderId_platform_profileVersion: where } });
}

export async function listRenderVariantsForContentItem(prisma: PrismaClient, contentItemId: string) {
  return prisma.renderVariant.findMany({ where: { contentItemId }, orderBy: { createdAt: "desc" } });
}
