import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma 7 config: connection URL for the CLI (migrate/studio) lives here, not in
// schema.prisma. Runtime PrismaClient gets its own connection via the @prisma/adapter-pg
// driver adapter in src/prisma.ts. See /docs/DECISIONS.md.
//
// Deliberately NOT prisma/config's `env("DATABASE_URL")` helper, which throws synchronously
// (PrismaConfigEnvError) the moment this file loads if the var is unset at all — including
// during `prisma generate`, which never actually opens a connection, only reads schema.prisma
// to produce types. That made a fresh CI/build environment (no DATABASE_URL configured yet —
// exactly Vercel's first real deploy, before a production database exists) fail at
// `pnpm install`'s postinstall step before the app code was ever reached. A harmless
// placeholder here costs nothing for `generate`; anything that actually needs a live
// connection (`migrate deploy`, `db seed`, or the real running app via src/prisma.ts) still
// requires and uses the real DATABASE_URL — this fallback never masks a genuine missing-URL
// problem at the point where it would actually matter.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://placeholder:placeholder@localhost:5432/placeholder",
  },
});
