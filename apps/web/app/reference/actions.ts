"use server";

import { redirect } from "next/navigation";
import { prisma, createReferenceCreator } from "@chris/domain";
import { requireSession } from "../../lib/session";

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function lines(formData: FormData, key: string): string[] {
  return str(formData, key)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function createCreator(formData: FormData) {
  const session = await requireSession();

  const creator = await createReferenceCreator(
    prisma,
    {
      name: str(formData, "name"),
      platforms: lines(formData, "platforms"),
      brandPositioning: str(formData, "brandPositioning"),
      knownAudience: str(formData, "knownAudience") || undefined,
      formats: lines(formData, "formats"),
      hookArchetypes: lines(formData, "hookArchetypes"),
      relevanceToChris: str(formData, "relevanceToChris") || undefined,
      doNotTransfer: str(formData, "doNotTransfer") || undefined,
      sourceProvenance: str(formData, "sourceProvenance") || undefined,
    },
    { actorId: session.user!.id! },
  );

  redirect(`/reference/${creator.id}`);
}
