import type { PrismaClient, ExperimentStatus } from "@prisma/client";
import { z } from "zod";
import { recordAudit } from "./audit";

/** Experiment engine (EXPERIMENT_AGENT.md) — a hypothesis, its variants, and an honest
 * conclusion (or explicit "not enough data yet," which is INCONCLUSIVE, a real, non-failing
 * status — see /docs/PRODUCT_SPEC.md's Learning section: "stores uncertainty explicitly"). */
export const CreateExperimentSchema = z.object({
  hypothesis: z.string().min(1),
  confounders: z.array(z.string()),
  minSampleSize: z.number().int().positive(),
  minDurationDays: z.number().int().positive(),
  portfolioMapping: z.string().nullable().optional(),
});
export type CreateExperimentInput = z.input<typeof CreateExperimentSchema>;

export async function createExperiment(
  prisma: PrismaClient,
  input: CreateExperimentInput,
  actor: { actorId: string },
) {
  const parsed = CreateExperimentSchema.parse(input);

  const experiment = await prisma.experiment.create({
    data: {
      hypothesis: parsed.hypothesis,
      status: "PROPOSED",
      confounders: parsed.confounders,
      minSampleSize: parsed.minSampleSize,
      minDurationDays: parsed.minDurationDays,
      portfolioMapping: parsed.portfolioMapping ?? null,
    },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "EXPERIMENT_CREATED",
    entityType: "Experiment",
    entityId: experiment.id,
    after: { hypothesis: experiment.hypothesis },
  });

  return experiment;
}

const AddExperimentVariantSchema = z.object({
  experimentId: z.string().min(1),
  contentItemId: z.string().nullable().optional(),
  label: z.string().min(1),
  description: z.string().min(1),
});
export type AddExperimentVariantInput = z.input<typeof AddExperimentVariantSchema>;

export async function addExperimentVariant(prisma: PrismaClient, input: AddExperimentVariantInput) {
  const parsed = AddExperimentVariantSchema.parse(input);
  return prisma.experimentVariant.create({
    data: {
      experimentId: parsed.experimentId,
      contentItemId: parsed.contentItemId ?? null,
      label: parsed.label,
      description: parsed.description,
    },
  });
}

export class ExperimentAlreadyConcludedError extends Error {
  constructor(actual: ExperimentStatus) {
    super(`This experiment is already ${actual} — it can't be concluded again.`);
    this.name = "ExperimentAlreadyConcludedError";
  }
}

/** `status` here is the honest research finding, not a success/failure judgment —
 * INCONCLUSIVE is a first-class, equally valid outcome to CONCLUDED (see EXPERIMENT_AGENT.md:
 * "do not infer causal relationships casually"). */
export async function concludeExperiment(
  prisma: PrismaClient,
  experimentId: string,
  input: { status: "CONCLUDED" | "INCONCLUSIVE"; conclusion: string },
  actor: { actorId: string },
) {
  const experiment = await prisma.experiment.findUniqueOrThrow({ where: { id: experimentId } });
  if (experiment.status === "CONCLUDED" || experiment.status === "INCONCLUSIVE") {
    throw new ExperimentAlreadyConcludedError(experiment.status);
  }

  const updated = await prisma.experiment.update({
    where: { id: experimentId },
    data: { status: input.status, conclusion: input.conclusion, concludedAt: new Date() },
  });

  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "EXPERIMENT_CONCLUDED",
    entityType: "Experiment",
    entityId: experimentId,
    after: { status: updated.status },
  });

  return updated;
}

export async function startExperiment(prisma: PrismaClient, experimentId: string, actor: { actorId: string }) {
  const experiment = await prisma.experiment.findUniqueOrThrow({ where: { id: experimentId } });
  if (experiment.status !== "PROPOSED") {
    throw new Error(`Experiment can only start from PROPOSED (current status: ${experiment.status}).`);
  }
  const updated = await prisma.experiment.update({ where: { id: experimentId }, data: { status: "RUNNING" } });
  await recordAudit(prisma, {
    actor: actor.actorId,
    actorType: "HUMAN",
    action: "EXPERIMENT_STARTED",
    entityType: "Experiment",
    entityId: experimentId,
    after: { status: "RUNNING" },
  });
  return updated;
}

export async function listExperiments(
  prisma: PrismaClient,
  opts?: { status?: ExperimentStatus; limit?: number },
) {
  return prisma.experiment.findMany({
    where: opts?.status ? { status: opts.status } : undefined,
    orderBy: { createdAt: "desc" },
    include: { variants: true },
    take: opts?.limit,
  });
}

export async function countExperiments(prisma: PrismaClient, opts?: { status?: ExperimentStatus }) {
  return prisma.experiment.count({ where: opts?.status ? { status: opts.status } : undefined });
}

export async function getExperiment(prisma: PrismaClient, id: string) {
  return prisma.experiment.findUnique({ where: { id }, include: { variants: true } });
}
