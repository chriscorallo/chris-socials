import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma";
import { isEnabled, setFlag, listFlags } from "../feature-flags";

describe("feature flags", () => {
  it("defaults an unknown key to disabled (fail closed)", async () => {
    const result = await isEnabled(prisma, `unknown.${randomUUID()}`);
    expect(result).toBe(false);
  });

  it("toggling persists and is immediately visible to a fresh read", async () => {
    const key = `test.flag.${randomUUID()}`;

    await setFlag(prisma, {
      key,
      enabled: true,
      description: "test flag",
      actor: "test",
      actorType: "SYSTEM",
    });
    expect(await isEnabled(prisma, key)).toBe(true);

    await setFlag(prisma, {
      key,
      enabled: false,
      actor: "test",
      actorType: "SYSTEM",
    });
    expect(await isEnabled(prisma, key)).toBe(false);
  });

  it("writes an audit log entry on every flag change", async () => {
    const key = `test.flag.audit.${randomUUID()}`;
    await setFlag(prisma, {
      key,
      enabled: true,
      description: "audited flag",
      actor: "test",
      actorType: "SYSTEM",
    });

    const flag = await prisma.featureFlag.findUniqueOrThrow({ where: { key } });
    const audit = await prisma.auditLog.findMany({
      where: { entityType: "FeatureFlag", entityId: flag.id },
    });
    expect(audit.length).toBeGreaterThan(0);
  });

  it("lists all flags", async () => {
    const key = `test.flag.list.${randomUUID()}`;
    await setFlag(prisma, {
      key,
      enabled: true,
      description: "list test",
      actor: "test",
      actorType: "SYSTEM",
    });
    const flags = await listFlags(prisma);
    expect(flags.some((f) => f.key === key)).toBe(true);
  });
});
