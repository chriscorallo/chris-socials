import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma";
import { hashPassword, verifyPassword } from "../auth";

/**
 * This exercises the same logic Next.js's Credentials `authorize()` callback runs
 * (apps/web/auth.ts): look up by email, verify the password hash. Full HTTP-level route
 * protection is verified manually per /docs/PHASE_PLAN.md's Phase 0 verification steps
 * (booting `pnpm dev:web` and confirming the redirect/login flow) — that's not yet automated
 * here.
 */
describe("password auth", () => {
  it("round-trips a correct password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("authenticates a seeded user by email + password, exactly like the app's authorize() callback", async () => {
    const email = `test-${randomUUID()}@example.com`;
    const passwordHash = await hashPassword("s3cret-dev-password");
    await prisma.user.create({ data: { email, passwordHash, name: "Test User" } });

    const found = await prisma.user.findUnique({ where: { email } });
    expect(found).not.toBeNull();
    expect(await verifyPassword("s3cret-dev-password", found!.passwordHash)).toBe(true);
    expect(await verifyPassword("wrong", found!.passwordHash)).toBe(false);
  });

  it("rejects a lookup for a non-existent email", async () => {
    const found = await prisma.user.findUnique({
      where: { email: `does-not-exist-${randomUUID()}@example.com` },
    });
    expect(found).toBeNull();
  });
});
