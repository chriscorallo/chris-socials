import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";
import { applyTransition } from "./state-machine";

/**
 * Raw media ingestion — spec §9 step 10. Phase 1 only recorded the fact of an upload
 * (storageKey + metadata); Phase 3 adds the technical/transcript analysis fields on this
 * same table (see /docs/DATA_MODEL.md) and the analyzeMediaAsset function below.
 */
export const CreateMediaAssetSchema = z.object({
  contentItemId: z.string().min(1),
  kind: z.enum(["RAW_TAKE"]),
  storageKey: z.string().min(1),
  originalFilename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

export type CreateMediaAssetInput = z.infer<typeof CreateMediaAssetSchema>;

export async function createMediaAsset(
  prisma: PrismaClient,
  input: CreateMediaAssetInput,
  actor: { actorId: string },
) {
  const parsed = CreateMediaAssetSchema.parse(input);
  const asset = await prisma.mediaAsset.create({ data: parsed });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "MEDIA_ASSET_UPLOADED",
    entityType: "ContentItem",
    entityId: parsed.contentItemId,
    after: {
      mediaAssetId: asset.id,
      originalFilename: asset.originalFilename,
      sizeBytes: asset.sizeBytes,
    },
  });

  return asset;
}

export async function listMediaAssetsForContentItem(
  prisma: PrismaClient,
  contentItemId: string,
) {
  return prisma.mediaAsset.findMany({
    where: { contentItemId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getMediaAsset(prisma: PrismaClient, id: string) {
  return prisma.mediaAsset.findUnique({ where: { id } });
}

const MediaAnalysisSchema = z.object({
  durationSeconds: z.number().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  frameRate: z.number().positive().nullable(),
  hasAudio: z.boolean(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  transcript: z.string().nullable().optional(),
});
export type MediaAnalysisInput = z.input<typeof MediaAnalysisSchema>;

/**
 * Records deterministic technical analysis (packages/media's probeMedia — no LLM judgment)
 * for a MediaAsset. This is the canonical trigger for FILMED -> MEDIA_INGESTED: analyzing
 * the first take for a ContentItem still in FILMED is what "ingestion" means, per spec §9
 * step 10 — same "issuing X advances state" pattern as ProductionContract/CreatorCard.
 */
export async function analyzeMediaAsset(
  prisma: PrismaClient,
  mediaAssetId: string,
  analysis: MediaAnalysisInput,
  actor: { actorId: string },
) {
  const parsed = MediaAnalysisSchema.parse(analysis);

  const asset = await prisma.mediaAsset.update({
    where: { id: mediaAssetId },
    data: {
      durationSeconds: parsed.durationSeconds,
      width: parsed.width,
      height: parsed.height,
      frameRate: parsed.frameRate,
      hasAudio: parsed.hasAudio,
      videoCodec: parsed.videoCodec,
      audioCodec: parsed.audioCodec,
      transcript: parsed.transcript ?? undefined,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "MEDIA_ASSET_ANALYZED",
    entityType: "ContentItem",
    entityId: asset.contentItemId,
    after: { mediaAssetId: asset.id, durationSeconds: asset.durationSeconds },
  });

  const item = await prisma.contentItem.findUnique({ where: { id: asset.contentItemId } });
  if (item?.currentState === "FILMED") {
    await applyTransition(prisma, {
      contentItemId: asset.contentItemId,
      to: "MEDIA_INGESTED",
      actorType: "HUMAN",
      actorId: actor.actorId,
      reason: "Raw media analyzed",
    });
  }

  return asset;
}
