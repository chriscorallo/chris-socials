import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma 7 config: connection URL for the CLI (migrate/studio) lives here, not in
// schema.prisma. Runtime PrismaClient gets its own connection via the @prisma/adapter-pg
// driver adapter in src/prisma.ts. See /docs/DECISIONS.md.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
