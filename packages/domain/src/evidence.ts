import type { PrismaClient, EvidenceSourceType, ContentPlatform } from "@prisma/client";
import { z } from "zod";

/**
 * The Evidence Ledger (spec §7) — every `Belief` must cite at least one of these by id. No
 * agent proposes a belief from a bare assertion; this is the provenance layer that makes
 * "AI thinks this works" structurally impossible to submit as a belief on its own (see
 * belief.ts's `evidenceIds` requirement).
 */
export const RecordEvidenceEntrySchema = z.object({
  statement: z.string().min(1),
  sourceType: z.enum(["PERFORMANCE_SNAPSHOT", "EXPERIMENT", "AUDIENCE_INSIGHT", "DECISION_JOURNAL", "MANUAL"]),
  sourceId: z.string().nullable().optional(),
  contentItemId: z.string().nullable().optional(),
  platform: z.enum(["INSTAGRAM", "TIKTOK", "YOUTUBE"]).nullable().optional(),
  confidence: z.number().min(0).max(1),
});
export type RecordEvidenceEntryInput = z.input<typeof RecordEvidenceEntrySchema>;

export async function recordEvidenceEntry(prisma: PrismaClient, input: RecordEvidenceEntryInput) {
  const parsed = RecordEvidenceEntrySchema.parse(input);
  return prisma.evidenceEntry.create({
    data: {
      statement: parsed.statement,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId ?? null,
      contentItemId: parsed.contentItemId ?? null,
      platform: parsed.platform ?? null,
      confidence: parsed.confidence,
    },
  });
}

export async function listEvidenceEntries(
  prisma: PrismaClient,
  opts?: { sourceType?: EvidenceSourceType; contentItemId?: string; platform?: ContentPlatform; limit?: number },
) {
  return prisma.evidenceEntry.findMany({
    where: {
      sourceType: opts?.sourceType,
      contentItemId: opts?.contentItemId,
      platform: opts?.platform,
    },
    orderBy: { recordedAt: "desc" },
    take: opts?.limit,
  });
}

export async function countEvidenceEntries(prisma: PrismaClient) {
  return prisma.evidenceEntry.count();
}

export async function getEvidenceEntriesByIds(prisma: PrismaClient, ids: string[]) {
  return prisma.evidenceEntry.findMany({ where: { id: { in: ids } } });
}
