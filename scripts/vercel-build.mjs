// Runs before `next build` (apps/web's build script). On a Vercel PRODUCTION build only, it
// applies pending database migrations and runs the idempotent seed against the production
// database — so the schema can never lag the code that depends on it, and no one has to
// copy production credentials to a laptop to migrate. Preview builds share the same database
// on this project, so they deliberately do NOT migrate (an unmerged branch must never change
// the production schema). Locally (no VERCEL_ENV) it does nothing.
//
// A failed migration fails the build: deploying code against the wrong schema is worse than
// keeping the previous deployment live. See /docs/DECISIONS.md ("Migrations run on deploy").

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env.VERCEL_ENV;
if (env !== "production") {
  console.log(`[vercel-build] VERCEL_ENV=${env ?? "(unset)"} — skipping migrations/seed.`);
  process.exit(0);
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOMAIN_DIR = join(REPO_ROOT, "packages", "domain");

// Migrations need a session-capable connection (advisory locks), not a transaction-mode pooler.
const migrateUrl =
  process.env.POSTGRES_URL_NON_POOLING || process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!migrateUrl) {
  console.error("[vercel-build] No database URL in the build environment — cannot migrate.");
  process.exit(1);
}

function run(label, args, extraEnv = {}) {
  console.log(`[vercel-build] ${label}…`);
  const result = spawnSync("pnpm", ["exec", "prisma", ...args], {
    cwd: DOMAIN_DIR,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: migrateUrl, ...extraEnv },
    timeout: 5 * 60 * 1000,
  });
  if (result.status !== 0) {
    console.error(`[vercel-build] ${label} failed (exit ${result.status ?? result.signal}).`);
    process.exit(1);
  }
}

run("prisma migrate deploy", ["migrate", "deploy"]);

if (process.env.SEED_USER_EMAIL && process.env.SEED_USER_PASSWORD) {
  run("seed (brand docs, owner login, default flags)", ["db", "seed"]);
} else {
  console.log("[vercel-build] SEED_USER_EMAIL/SEED_USER_PASSWORD not set — skipping seed.");
}
