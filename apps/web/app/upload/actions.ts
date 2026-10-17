"use server";

import { prisma, createContentItemFromFootage } from "@chris/domain";
import { requireSession } from "../../lib/session";

/** Creates the video entry for footage Chris already filmed; the page then uploads the takes
 * into it with the normal uploader. */
export async function createFootageItem(title: string): Promise<{ id: string } | { error: string }> {
  const session = await requireSession();
  try {
    const item = await createContentItemFromFootage(prisma, { title }, { actorId: session.user!.id! });
    return { id: item.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't create the video" };
  }
}
