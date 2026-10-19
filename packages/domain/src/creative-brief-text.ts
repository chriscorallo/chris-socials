import type { PrismaClient } from "@prisma/client";
import { formatCreativeBrief, getLatestCreativeBrief } from "./creative-brief";

/** The latest Creative Brief as prompt text, or null when the video has none (older items,
 * footage-first uploads). Never throws — a bot without a brief just works from the footage. */
export async function creativeBriefTextFor(prisma: PrismaClient, contentItemId: string): Promise<string | null> {
  try {
    const brief = await getLatestCreativeBrief(prisma, contentItemId);
    return brief ? formatCreativeBrief(brief) : null;
  } catch {
    return null;
  }
}
