import type { PrismaClient, ContentState } from "@prisma/client";
import { z } from "zod";
import { writeTransition } from "./state-machine";
import { isScriptVersionFilmable } from "./script-version";

/**
 * Creator Card — spec §9 step 7/8: "only what Chris needs while filming." Issuing one moves
 * a ContentItem SCRIPTED -> READY_TO_FILM, atomically, same pattern as ProductionContract.
 */
export class CreatorCardRequiresScriptedStateError extends Error {
  constructor(actual: ContentState) {
    super(`A Creator Card can only be issued from SCRIPTED (current state: ${actual}).`);
    this.name = "CreatorCardRequiresScriptedStateError";
  }
}

export class ScriptNotClearedForFilmingError extends Error {
  constructor(reason: string) {
    super(`Can't issue a Creator Card: ${reason}`);
    this.name = "ScriptNotClearedForFilmingError";
  }
}

export const CreateCreatorCardSchema = z.object({
  contentItemId: z.string().min(1),
  hook: z.string().min(1),
  talkingPoints: z.array(z.string()).min(1),
  setup: z.enum(["DESK", "STANDING", "CASUAL", "WALKING", "SKIT", "SPECIAL"]),
  estimatedMinutes: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
});

export type CreateCreatorCardInput = z.infer<typeof CreateCreatorCardSchema>;

export async function createCreatorCardAndAdvance(
  prisma: PrismaClient,
  input: CreateCreatorCardInput,
  actor: { actorId: string },
) {
  const parsed = CreateCreatorCardSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const item = await tx.contentItem.findUniqueOrThrow({
      where: { id: parsed.contentItemId },
    });
    if (item.currentState !== "SCRIPTED") {
      throw new CreatorCardRequiresScriptedStateError(item.currentState);
    }

    // Filming gate: the version Chris will read must have passed the script-level Claims
    // Gate (a hand-edited version must have been re-gated). See script-version.ts.
    const latestScript = await tx.scriptVersion.findFirst({
      where: { contentItemId: parsed.contentItemId },
      orderBy: { createdAt: "desc" },
    });
    if (latestScript) {
      const filmable = isScriptVersionFilmable(latestScript);
      if (!filmable.ok) throw new ScriptNotClearedForFilmingError(filmable.reason);
    }

    const card = await tx.creatorCard.create({
      data: {
        contentItemId: parsed.contentItemId,
        hook: parsed.hook,
        talkingPoints: parsed.talkingPoints,
        setup: parsed.setup,
        estimatedMinutes: parsed.estimatedMinutes,
        notes: parsed.notes,
      },
    });

    await writeTransition(tx, {
      contentItemId: parsed.contentItemId,
      fromState: "SCRIPTED",
      toState: "READY_TO_FILM",
      reason: "Creator Card issued",
      actorType: "HUMAN",
      actorId: actor.actorId,
      auditAction: "CREATOR_CARD_CREATED",
    });

    return card;
  });
}

export async function getCreatorCard(prisma: PrismaClient, contentItemId: string) {
  return prisma.creatorCard.findUnique({ where: { contentItemId } });
}
