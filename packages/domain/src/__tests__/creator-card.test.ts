import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem } from "../content-item";
import { applyTransition } from "../state-machine";
import {
  createCreatorCardAndAdvance,
  getCreatorCard,
  CreatorCardRequiresScriptedStateError,
} from "../creator-card";

async function makeScriptedItem() {
  const item = await createContentItem(prisma, { title: "Creator card test idea" }, {
    actorId: "test-user",
  });
  for (const to of ["SELECTED", "CONTRACTED", "RESEARCHING", "RESEARCHED", "SCRIPTING", "SCRIPTED"] as const) {
    await applyTransition(prisma, { contentItemId: item.id, to, actorType: "SYSTEM" });
  }
  return item;
}

describe("creator cards", () => {
  it("issuing a card advances SCRIPTED -> READY_TO_FILM atomically", async () => {
    const item = await makeScriptedItem();

    const card = await createCreatorCardAndAdvance(
      prisma,
      {
        contentItemId: item.id,
        hook: "Why did my credit score drop after I paid off my card?",
        talkingPoints: ["Utilization drop", "Average account age", "New inquiry"],
        setup: "DESK",
      },
      { actorId: "chris" },
    );

    expect(card.talkingPoints).toEqual(["Utilization drop", "Average account age", "New inquiry"]);

    const updated = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.currentState).toBe("READY_TO_FILM");

    const fetched = await getCreatorCard(prisma, item.id);
    expect(fetched?.id).toBe(card.id);
  });

  it("rejects issuing a card from a state other than SCRIPTED", async () => {
    const item = await createContentItem(prisma, { title: "Not scripted yet" }, {
      actorId: "test-user",
    });

    await expect(
      createCreatorCardAndAdvance(
        prisma,
        { contentItemId: item.id, hook: "x", talkingPoints: ["a"], setup: "DESK" },
        { actorId: "chris" },
      ),
    ).rejects.toBeInstanceOf(CreatorCardRequiresScriptedStateError);
  });

  it("requires at least one talking point", async () => {
    const item = await makeScriptedItem();
    await expect(
      createCreatorCardAndAdvance(
        prisma,
        { contentItemId: item.id, hook: "x", talkingPoints: [], setup: "DESK" },
        { actorId: "chris" },
      ),
    ).rejects.toThrow();
  });
});
