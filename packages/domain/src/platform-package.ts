import type { PrismaClient, ContentState, ContentPlatform } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";

/**
 * Spec §9 step 20 — "generated only after the final render exists." Packaging itself doesn't
 * drive a state transition (a ContentItem can be packaged while READY or already SCHEDULED —
 * re-packaging after a caption edit is legitimate at either point), but it does require a real
 * render to exist, checked here rather than trusted from the caller.
 */
export class PlatformPackageRequiresRenderError extends Error {
  constructor(actual: ContentState) {
    super(
      `A PlatformPackage requires a completed render — the item must be READY or SCHEDULED ` +
        `(current state: ${actual}).`,
    );
    this.name = "PlatformPackageRequiresRenderError";
  }
}

export const RecordPlatformPackageSchema = z.object({
  contentItemId: z.string().min(1),
  platform: z.enum(["INSTAGRAM", "TIKTOK", "YOUTUBE"]),
  caption: z.string().min(1),
  title: z.string().nullable().optional(),
  hashtags: z.array(z.string()).default([]),
  coverFrameSeconds: z.number().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type RecordPlatformPackageInput = z.input<typeof RecordPlatformPackageSchema>;

export async function recordPlatformPackage(
  prisma: PrismaClient,
  input: RecordPlatformPackageInput,
  actor: { actorId: string },
) {
  const parsed = RecordPlatformPackageSchema.parse(input);

  const item = await prisma.contentItem.findUniqueOrThrow({ where: { id: parsed.contentItemId } });
  if (item.currentState !== "READY" && item.currentState !== "SCHEDULED") {
    throw new PlatformPackageRequiresRenderError(item.currentState);
  }

  const pkg = await prisma.platformPackage.create({
    data: {
      contentItemId: parsed.contentItemId,
      platform: parsed.platform,
      caption: parsed.caption,
      title: parsed.title ?? null,
      hashtags: parsed.hashtags,
      coverFrameSeconds: parsed.coverFrameSeconds ?? null,
      metadata: (parsed.metadata ?? undefined) as never,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "PLATFORM_PACKAGE_RECORDED",
    entityType: "ContentItem",
    entityId: parsed.contentItemId,
    after: { platformPackageId: pkg.id, platform: pkg.platform },
  });

  return pkg;
}

export async function getLatestPlatformPackage(
  prisma: PrismaClient,
  contentItemId: string,
  platform: ContentPlatform,
) {
  return prisma.platformPackage.findFirst({
    where: { contentItemId, platform },
    orderBy: { createdAt: "desc" },
  });
}

export async function listPlatformPackagesForContentItem(prisma: PrismaClient, contentItemId: string) {
  return prisma.platformPackage.findMany({
    where: { contentItemId },
    orderBy: { createdAt: "desc" },
  });
}
