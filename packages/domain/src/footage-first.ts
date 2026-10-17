import type { PrismaClient } from "@prisma/client";
import { createContentItem } from "./content-item";
import { applyTransition } from "./state-machine";
import { createProductionContractAndAdvance } from "./production-contract";

/**
 * "I already filmed something" — the footage-first path. Chris often films without going
 * through the plan → research → script flow first; requiring that before he can even upload
 * was the single biggest "where do I upload?" dead end.
 *
 * Creates the ContentItem and walks it to FILMED so uploaded takes ingest normally
 * (FILMED -> MEDIA_INGESTED on the first analyzed take). Honesty about what was skipped:
 *  - every skipped step is a SYSTEM transition whose reason says "footage-first", so the
 *    history shows exactly what did and didn't happen;
 *  - the contract records researchDepth STANDARD / factualRisk MEDIUM — NOT the NONE/LOW
 *    combination that exempts an item from fact-checking — so the FACTUAL hard gate still
 *    BLOCKs publishing until the video's own transcript passes the Claims Gate
 *    ("Fact-check this video"). Footage-first is a shortcut to editing, never to publishing
 *    unchecked claims. See /docs/DECISIONS.md ("Footage-first upload").
 */
export async function createContentItemFromFootage(
  prisma: PrismaClient,
  input: { title: string; description?: string },
  actor: { actorId: string },
) {
  const title = input.title.trim() || "Untitled video";
  const item = await createContentItem(prisma, { title, description: input.description }, actor);
  const reason = "Footage-first: Chris filmed this outside the planning flow";

  await applyTransition(prisma, { contentItemId: item.id, to: "SELECTED", actorType: "HUMAN", actorId: actor.actorId, reason });
  await createProductionContractAndAdvance(
    prisma,
    {
      contentItemId: item.id,
      purpose: "Footage-first upload",
      primaryIdea: title,
      audiencePromise: "To be confirmed from the footage",
      topic: title,
      format: "Talking head",
      productionTier: "FAST",
      targetLengthMinSeconds: 15,
      targetLengthMaxSeconds: 90,
      researchDepth: "STANDARD",
      factualRisk: "MEDIUM",
      scope: "What was said in the uploaded footage",
      doNotExpandInto: "Claims that aren't in the footage",
    },
    actor,
  );
  for (const to of ["RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED", "READY_TO_FILM", "FILMED"] as const) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM", actorId: actor.actorId, reason });
  }
  return prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
}
