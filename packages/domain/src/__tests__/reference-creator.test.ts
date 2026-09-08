import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import {
  createReferenceCreator,
  createReferenceContent,
  recordReferenceObservations,
  getReferenceCreator,
  getReferenceContent,
  listReferenceCreators,
} from "../reference-creator";

describe("reference creator intelligence", () => {
  it("creates a creator, content, and observations, and links them together", async () => {
    const creator = await createReferenceCreator(
      prisma,
      {
        name: "Jun Yuh",
        platforms: ["tiktok", "instagram"],
        brandPositioning: "Personality-led finance creator",
        hookArchetypes: ["direct question"],
      },
      { actorId: "chris" },
    );
    expect(creator.name).toBe("Jun Yuh");

    const content = await createReferenceContent(
      prisma,
      {
        referenceCreatorId: creator.id,
        description: "Opens with a direct dollar figure, cuts every 2s, ends with a question.",
        platform: "TIKTOK",
        hook: "I spent $4,000 on a mistake so you don't have to.",
      },
      { actorId: "chris" },
    );
    expect(content.referenceCreatorId).toBe(creator.id);

    const observations = await recordReferenceObservations(
      prisma,
      content.id,
      [
        {
          observed: "Dollar-figure hook in first 2 seconds across several videos.",
          likelyPrinciple: "Concrete numbers may earn attention faster than abstract framing.",
          transferabilityToChris: "High — matches existing evidence-over-folklore principle.",
          reason: "Present across multiple strong-performing examples.",
          risks: ["Could feel gimmicky if overused"],
          testRequired: "A/B a dollar-figure hook against a question hook on 2 similar topics.",
          confidence: 0.6,
        },
      ],
      { actorId: "chris" },
    );
    expect(observations).toHaveLength(1);

    const fetchedCreator = await getReferenceCreator(prisma, creator.id);
    expect(fetchedCreator?.content).toHaveLength(1);

    const fetchedContent = await getReferenceContent(prisma, content.id);
    expect(fetchedContent?.observations).toHaveLength(1);
    expect(fetchedContent?.observations[0]?.likelyPrinciple).toContain("Concrete numbers");
  });

  it("lists creators alphabetically", async () => {
    await createReferenceCreator(
      prisma,
      { name: "Zzz Creator", brandPositioning: "test" },
      { actorId: "chris" },
    );
    await createReferenceCreator(
      prisma,
      { name: "Aaa Creator", brandPositioning: "test" },
      { actorId: "chris" },
    );
    const creators = await listReferenceCreators(prisma);
    const names = creators.map((c) => c.name);
    const aIndex = names.indexOf("Aaa Creator");
    const zIndex = names.indexOf("Zzz Creator");
    expect(aIndex).toBeLessThan(zIndex);
  });
});
