"use server";

import { redirect } from "next/navigation";
import { prisma, createContentItem } from "@chris/domain";
import { requireSession } from "../../lib/session";

const PILLARS = ["SKILL", "MINDSET", "LIFESTYLE", "PASSIONS"] as const;
type PillarValue = (typeof PILLARS)[number];

function parsePillar(value: string): PillarValue | undefined {
  return (PILLARS as readonly string[]).includes(value) ? (value as PillarValue) : undefined;
}

export async function createIdea(formData: FormData) {
  const session = await requireSession();

  const title = String(formData.get("title") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  const format = String(formData.get("format") ?? "").trim();

  const item = await createContentItem(
    prisma,
    {
      title,
      description: description || undefined,
      pillar: parsePillar(String(formData.get("pillar") ?? "").trim()),
      format: format || undefined,
    },
    { actorId: session.user!.id! },
  );

  redirect(`/content/${item.id}`);
}
