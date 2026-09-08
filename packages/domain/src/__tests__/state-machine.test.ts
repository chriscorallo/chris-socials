import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { ContentState } from "@prisma/client";
import { prisma } from "../prisma";
import {
  applyTransition,
  isValidTransition,
  isRollback,
  InvalidTransitionError,
  MissingCancellationReasonError,
  listValidNextStates,
} from "../state-machine";

async function createContentItem(title = "test item") {
  return prisma.contentItem.create({ data: { title } });
}

describe("state machine", () => {
  it("accepts every documented happy-path transition in order", async () => {
    const item = await createContentItem();
    const path: Array<[ContentState, ContentState]> = [
      ["IDEA", "SELECTED"],
      ["SELECTED", "CONTRACTED"],
      ["CONTRACTED", "RESEARCHING"],
      ["RESEARCHING", "RESEARCHED"],
      ["RESEARCHED", "SCRIPTING"],
      ["SCRIPTING", "SCRIPTED"],
      ["SCRIPTED", "READY_TO_FILM"],
      ["READY_TO_FILM", "FILMED"],
      ["FILMED", "MEDIA_INGESTED"],
      ["MEDIA_INGESTED", "TAKE_SELECTED"],
      ["TAKE_SELECTED", "EDIT_PLANNED"],
      ["EDIT_PLANNED", "EDITING"],
      ["EDITING", "RENDERED"],
      ["RENDERED", "READY"],
      ["READY", "SCHEDULED"],
      ["SCHEDULED", "PUBLISHING"],
      ["PUBLISHING", "PUBLISHED"],
      ["PUBLISHED", "MEASURING"],
      ["MEASURING", "ARCHIVED"],
    ];

    for (const [, to] of path) {
      const result = await applyTransition(prisma, {
        contentItemId: item.id,
        to,
        actorType: "SYSTEM",
      });
      expect(result.toState).toBe(to);
    }

    const finalItem = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(finalItem.currentState).toBe("ARCHIVED");

    const history = await prisma.contentStateTransition.findMany({
      where: { contentItemId: item.id },
      orderBy: { createdAt: "asc" },
    });
    expect(history).toHaveLength(path.length);
  });

  it("rejects a transition not in the table, without writing anything", async () => {
    const item = await createContentItem();
    await expect(
      applyTransition(prisma, {
        contentItemId: item.id,
        to: "PUBLISHED",
        actorType: "SYSTEM",
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    const history = await prisma.contentStateTransition.findMany({
      where: { contentItemId: item.id },
    });
    expect(history).toHaveLength(0);
  });

  it("requires a reason when cancelling", async () => {
    const item = await createContentItem();
    await expect(
      applyTransition(prisma, {
        contentItemId: item.id,
        to: "CANCELLED",
        actorType: "HUMAN",
      }),
    ).rejects.toBeInstanceOf(MissingCancellationReasonError);
  });

  it("allows cancellation from any non-terminal state, with a reason, and audit-logs it", async () => {
    const item = await createContentItem();
    const result = await applyTransition(prisma, {
      contentItemId: item.id,
      to: "CANCELLED",
      reason: "duplicate idea",
      actorType: "HUMAN",
      actorId: "chris",
    });
    expect(result.toState).toBe("CANCELLED");

    const audit = await prisma.auditLog.findMany({
      where: { entityType: "ContentItem", entityId: item.id },
    });
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]?.action).toBe("STATE_TRANSITION");
  });

  it("rejects any transition out of a terminal state", async () => {
    const item = await createContentItem();
    await applyTransition(prisma, {
      contentItemId: item.id,
      to: "CANCELLED",
      reason: "test",
      actorType: "SYSTEM",
    });
    await expect(
      applyTransition(prisma, {
        contentItemId: item.id,
        to: "SELECTED",
        actorType: "SYSTEM",
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("is idempotent: replaying the same idempotency key returns the original result, not a new row", async () => {
    const item = await createContentItem();
    const key = randomUUID();

    const first = await applyTransition(prisma, {
      contentItemId: item.id,
      to: "SELECTED",
      actorType: "SYSTEM",
      idempotencyKey: key,
    });
    const second = await applyTransition(prisma, {
      contentItemId: item.id,
      to: "SELECTED",
      actorType: "SYSTEM",
      idempotencyKey: key,
    });

    expect(second.idempotentReplay).toBe(true);
    expect(second.transitionId).toBe(first.transitionId);

    const history = await prisma.contentStateTransition.findMany({
      where: { contentItemId: item.id },
    });
    expect(history).toHaveLength(1);
  });

  it("classifies only the two documented rollback transitions", () => {
    expect(isRollback("QC_BLOCKED", "EDIT_PLANNED")).toBe(true);
    expect(isRollback("RESEARCH_BLOCKED", "RESEARCHING")).toBe(true);
    expect(isRollback("IDEA", "SELECTED")).toBe(false);
  });

  it("lists CANCELLED as a valid next state for any non-terminal state", () => {
    expect(listValidNextStates("IDEA")).toContain("CANCELLED");
    expect(listValidNextStates("ARCHIVED")).not.toContain("CANCELLED");
  });

  it("agrees with isValidTransition for the branch states", () => {
    expect(isValidTransition("RESEARCHING", "RESEARCH_BLOCKED")).toBe(true);
    expect(isValidTransition("RESEARCHING", "SCRIPTING")).toBe(false);
    expect(isValidTransition("RENDERED", "QC_REPAIR")).toBe(true);
    expect(isValidTransition("QC_REPAIR", "QC_BLOCKED")).toBe(true);
  });
});
