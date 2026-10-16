import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Standard Next.js-safe singleton pattern: avoids exhausting DB connections from hot-reload
// re-imports in dev. See /docs/ARCHITECTURE.md — packages/domain is the one package every
// app/package may depend on for DB access.
const globalForPrisma = globalThis as unknown as { __chrisPrisma?: PrismaClient };

// Prisma 7: the postgresql provider requires an explicit driver adapter at runtime (the
// connection URL is no longer read from schema.prisma). See /docs/DECISIONS.md.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma: PrismaClient =
  globalForPrisma.__chrisPrisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__chrisPrisma = prisma;
}

export type { PrismaClient } from "@prisma/client";
export { Prisma } from "@prisma/client";
