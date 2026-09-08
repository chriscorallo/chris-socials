import type { PrismaClient, BrandMemoryKind } from "@prisma/client";
import { createHash } from "node:crypto";

/**
 * Versioned snapshots of /brand/*.md. Per /docs/ARCHITECTURE.md's authority enforcement:
 * nothing in this file ever overwrites a version in place, and nothing outside a human
 * decision calls it with new content — a learning-system role has no access to this module
 * at all, by construction (it isn't exported from any package a learning job depends on).
 */

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function seedBrandConstitutionIfChanged(
  prisma: PrismaClient,
  content: string,
): Promise<{ created: boolean; version: number }> {
  const contentHash = hashContent(content);
  const latest = await prisma.brandConstitutionVersion.findFirst({
    orderBy: { version: "desc" },
  });

  if (latest?.contentHash === contentHash) {
    return { created: false, version: latest.version };
  }

  const nextVersion = (latest?.version ?? 0) + 1;
  await prisma.brandConstitutionVersion.create({
    data: { version: nextVersion, contentHash, content },
  });
  return { created: true, version: nextVersion };
}

export async function seedBrandMemoryIfChanged(
  prisma: PrismaClient,
  kind: BrandMemoryKind,
  content: string,
): Promise<{ created: boolean; version: number }> {
  const contentHash = hashContent(content);
  const latest = await prisma.brandMemory.findFirst({
    where: { kind },
    orderBy: { version: "desc" },
  });

  if (latest?.contentHash === contentHash) {
    return { created: false, version: latest.version };
  }

  const nextVersion = (latest?.version ?? 0) + 1;
  await prisma.brandMemory.create({
    data: { kind, version: nextVersion, contentHash, content },
  });
  return { created: true, version: nextVersion };
}

export async function getCurrentBrandConstitution(prisma: PrismaClient) {
  return prisma.brandConstitutionVersion.findFirst({ orderBy: { version: "desc" } });
}

export async function getCurrentBrandMemory(
  prisma: PrismaClient,
  kind: BrandMemoryKind,
) {
  return prisma.brandMemory.findFirst({ where: { kind }, orderBy: { version: "desc" } });
}
