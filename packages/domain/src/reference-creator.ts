import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";

/**
 * Reference Creator Intelligence — spec §8. No live scraping/API integration in this
 * system; ReferenceContent.description is manually entered (a transcript, notes, or summary
 * Chris or a specialist supplies). Governing principle: "Principles transfer. Identity does
 * not." — see /prompts/agents/REFERENCE_INTELLIGENCE.md.
 */

export const CreateReferenceCreatorSchema = z.object({
  name: z.string().min(1),
  platforms: z.array(z.string()).default([]),
  brandPositioning: z.string().min(1),
  knownAudience: z.string().optional(),
  formats: z.array(z.string()).default([]),
  storytellingTendencies: z.string().optional(),
  verbalTendencies: z.string().optional(),
  editingTendencies: z.string().optional(),
  visualCharacteristics: z.string().optional(),
  hookArchetypes: z.array(z.string()).default([]),
  ctaBehaviors: z.string().optional(),
  contentEvolution: z.string().optional(),
  relevanceToChris: z.string().optional(),
  doNotTransfer: z.string().optional(),
  sourceProvenance: z.string().optional(),
});
// z.input, not z.infer — see /docs/DECISIONS.md's z.infer-vs-z.input note.
export type CreateReferenceCreatorInput = z.input<typeof CreateReferenceCreatorSchema>;

export async function createReferenceCreator(
  prisma: PrismaClient,
  input: CreateReferenceCreatorInput,
  actor: { actorId: string },
) {
  const parsed = CreateReferenceCreatorSchema.parse(input);
  const creator = await prisma.referenceCreator.create({ data: parsed });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "REFERENCE_CREATOR_CREATED",
    entityType: "ReferenceCreator",
    entityId: creator.id,
    after: { name: creator.name },
  });
  return creator;
}

export async function listReferenceCreators(prisma: PrismaClient, opts?: { limit?: number }) {
  return prisma.referenceCreator.findMany({ orderBy: { name: "asc" }, take: opts?.limit });
}

export async function countReferenceCreators(prisma: PrismaClient) {
  return prisma.referenceCreator.count();
}

export async function getReferenceCreator(prisma: PrismaClient, id: string) {
  const creator = await prisma.referenceCreator.findUnique({ where: { id } });
  if (!creator) return null;
  // Sequential, not Promise.all — see /docs/DECISIONS.md.
  const content = await prisma.referenceContent.findMany({
    where: { referenceCreatorId: id },
    orderBy: { createdAt: "desc" },
  });
  return { ...creator, content };
}

export const CreateReferenceContentSchema = z.object({
  referenceCreatorId: z.string().min(1),
  description: z.string().min(1),
  platform: z.enum(["INSTAGRAM", "TIKTOK", "YOUTUBE"]).optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  hook: z.string().optional(),
  topic: z.string().optional(),
  publicPerformanceNotes: z.string().optional(),
  sourceUrl: z.string().optional(),
});
export type CreateReferenceContentInput = z.infer<typeof CreateReferenceContentSchema>;

export async function createReferenceContent(
  prisma: PrismaClient,
  input: CreateReferenceContentInput,
  actor: { actorId: string },
) {
  const parsed = CreateReferenceContentSchema.parse(input);
  const content = await prisma.referenceContent.create({ data: parsed });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "REFERENCE_CONTENT_CREATED",
    entityType: "ReferenceCreator",
    entityId: parsed.referenceCreatorId,
    after: { referenceContentId: content.id },
  });
  return content;
}

export async function getReferenceContent(prisma: PrismaClient, id: string) {
  const content = await prisma.referenceContent.findUnique({ where: { id } });
  if (!content) return null;
  const observations = await prisma.referenceObservation.findMany({
    where: { referenceContentId: id },
    orderBy: { createdAt: "desc" },
  });
  return { ...content, observations };
}

const ReferenceObservationInputSchema = z.object({
  observed: z.string(),
  likelyPrinciple: z.string(),
  transferabilityToChris: z.string(),
  reason: z.string(),
  risks: z.array(z.string()),
  testRequired: z.string(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export async function recordReferenceObservations(
  prisma: PrismaClient,
  referenceContentId: string,
  observations: z.infer<typeof ReferenceObservationInputSchema>[],
  actor: { actorId: string },
) {
  const parsed = observations.map((o) => ReferenceObservationInputSchema.parse(o));
  const rows = [];
  // Sequential, not createMany+Promise.all — see /docs/DECISIONS.md; also createMany doesn't
  // return created rows in all providers, and this list is small (a handful per analysis).
  for (const o of parsed) {
    const row = await prisma.referenceObservation.create({
      data: { ...o, referenceContentId, confidence: o.confidence ?? null },
    });
    rows.push(row);
  }
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "REFERENCE_OBSERVATIONS_RECORDED",
    entityType: "ReferenceContent",
    entityId: referenceContentId,
    after: { count: rows.length },
  });
  return rows;
}
