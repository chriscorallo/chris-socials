"use server";

import { redirect } from "next/navigation";
import {
  prisma,
  createReferenceContent,
  recordReferenceObservations,
  getReferenceContent,
} from "@chris/domain";
import { getBrandContextText, runReferenceIntelligenceAgent } from "@chris/agents";
import { requireSession } from "../../../lib/session";
import { getModelProvider } from "../../../lib/model-provider";

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

export async function addContent(formData: FormData) {
  const session = await requireSession();
  const referenceCreatorId = str(formData, "referenceCreatorId");

  const content = await createReferenceContent(
    prisma,
    {
      referenceCreatorId,
      description: str(formData, "description"),
      platform: (str(formData, "platform") || undefined) as never,
      hook: str(formData, "hook") || undefined,
      topic: str(formData, "topic") || undefined,
    },
    { actorId: session.user!.id! },
  );

  redirect(`/reference/${referenceCreatorId}?added=${content.id}`);
}

export async function analyzeContent(formData: FormData) {
  const session = await requireSession();
  const referenceCreatorId = str(formData, "referenceCreatorId");
  const referenceContentId = str(formData, "referenceContentId");

  try {
    const content = await getReferenceContent(prisma, referenceContentId);
    if (!content) throw new Error("Reference content not found.");

    const creator = await prisma.referenceCreator.findUniqueOrThrow({
      where: { id: referenceCreatorId },
    });

    const brandContext = await getBrandContextText(prisma);
    const result = await runReferenceIntelligenceAgent(getModelProvider(), {
      content: {
        creatorName: creator.name,
        description: content.description,
        platform: content.platform,
        topic: content.topic,
        hook: content.hook,
      },
      brandContext,
    });

    await recordReferenceObservations(prisma, referenceContentId, result.observations, {
      actorId: session.user!.id!,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    redirect(`/reference/${referenceCreatorId}?analysisError=${encodeURIComponent(message)}`);
  }

  redirect(`/reference/${referenceCreatorId}`);
}
