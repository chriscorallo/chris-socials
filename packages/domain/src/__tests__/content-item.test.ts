import { describe, it, expect } from "vitest";
import { prisma } from "../prisma";
import { createContentItem, getContentItem, listContentItems } from "../content-item";

describe("content items (IDEAS backlog)", () => {
  it("creates an item defaulting to IDEA state", async () => {
    const item = await createContentItem(
      prisma,
      { title: "Why does my credit score drop when I pay off a card?", pillar: "SKILL" },
      { actorId: "test-user" },
    );
    expect(item.currentState).toBe("IDEA");
    expect(item.pillar).toBe("SKILL");
  });

  it("records an audit log entry on creation", async () => {
    const item = await createContentItem(
      prisma,
      { title: "Audit test idea" },
      { actorId: "test-user" },
    );
    const audit = await prisma.auditLog.findMany({
      where: { entityType: "ContentItem", entityId: item.id, action: "CONTENT_ITEM_CREATED" },
    });
    expect(audit).toHaveLength(1);
  });

  it("fetches an item with its relations", async () => {
    const item = await createContentItem(
      prisma,
      { title: "Relation fetch test" },
      { actorId: "test-user" },
    );
    const fetched = await getContentItem(prisma, item.id);
    expect(fetched?.id).toBe(item.id);
    expect(fetched?.mediaAssets).toEqual([]);
    expect(fetched?.transitions).toEqual([]);
  });

  it("lists items filtered by state", async () => {
    await createContentItem(prisma, { title: "Filter test idea" }, { actorId: "test-user" });
    const ideas = await listContentItems(prisma, { state: "IDEA" });
    expect(ideas.every((i) => i.currentState === "IDEA")).toBe(true);
    expect(ideas.some((i) => i.title === "Filter test idea")).toBe(true);
  });

  it("rejects an empty title", async () => {
    await expect(
      createContentItem(prisma, { title: "" }, { actorId: "test-user" }),
    ).rejects.toThrow();
  });
});
