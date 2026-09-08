import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma";
import { recordAudit, getAuditLogForEntity } from "../audit";

describe("audit log", () => {
  it("write-then-read preserves before/after/metadata exactly", async () => {
    const entityId = randomUUID();
    await recordAudit(prisma, {
      actor: "test-actor",
      actorType: "SYSTEM",
      action: "TEST_ACTION",
      entityType: "TestEntity",
      entityId,
      before: { value: 1, nested: { a: "x" } },
      after: { value: 2, nested: { a: "y" } },
      metadata: { note: "unit test" },
    });

    const rows = await getAuditLogForEntity(prisma, "TestEntity", entityId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.before).toEqual({ value: 1, nested: { a: "x" } });
    expect(rows[0]?.after).toEqual({ value: 2, nested: { a: "y" } });
    expect(rows[0]?.metadata).toEqual({ note: "unit test" });
    expect(rows[0]?.action).toBe("TEST_ACTION");
  });

  it("never overwrites a prior entry — multiple audits for the same entity all persist", async () => {
    const entityId = randomUUID();
    for (let i = 0; i < 3; i++) {
      await recordAudit(prisma, {
        actor: "test-actor",
        actorType: "SYSTEM",
        action: `ACTION_${i}`,
        entityType: "TestEntity",
        entityId,
      });
    }
    const rows = await getAuditLogForEntity(prisma, "TestEntity", entityId);
    expect(rows).toHaveLength(3);
  });
});
