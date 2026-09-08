import type { PrismaClient } from "@chris/domain";
import { getCurrentBrandConstitution, getCurrentBrandMemory } from "@chris/domain";

/**
 * Fetches the live Brand Constitution + Chris Brain content for grounding a model call.
 * Every specialist prompt requires this per SYSTEM_BASE.md — this is where the *content*
 * (not just the instruction to use it) actually gets supplied.
 *
 * Sequential, not Promise.all — see /docs/DECISIONS.md ("the PGlite dev database can't
 * handle concurrently dispatched queries"). Real Postgres would handle either fine.
 */
export async function getBrandContextText(prisma: PrismaClient): Promise<string> {
  const constitution = await getCurrentBrandConstitution(prisma);
  const chrisBrain = await getCurrentBrandMemory(prisma, "CHRIS_BRAIN");

  const parts: string[] = [];
  if (constitution) {
    parts.push(`## Brand Constitution (v${constitution.version})\n\n${constitution.content}`);
  }
  if (chrisBrain) {
    parts.push(`## Chris Brain (v${chrisBrain.version})\n\n${chrisBrain.content}`);
  }
  return parts.join("\n\n---\n\n");
}
