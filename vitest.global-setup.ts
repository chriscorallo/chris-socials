// Isolated, throwaway test database for every `pnpm test` run.
//
// Before this existed, the integration suite ran against the same local dev database the app
// itself uses (DATABASE_URL in .env) — and several tests legitimately need to reset global
// tables (AutonomyLevel, WeeklyProgrammingThesis, the autonomy.shadow_only kill switch). Run
// against the real dev DB, that silently disabled the kill switch, granted publishing
// autonomy no human had earned, and deleted every real weekly thesis. See /docs/DECISIONS.md
// ("Tests get their own throwaway database").
//
// Each run: a fresh PGlite instance in a temp dir, served over the Postgres wire protocol on a
// free port, migrated with the real migration history (`prisma migrate deploy`) and seeded
// with the real seed script — so the suite also proves the migrations replay from empty.
// The temp dir is deleted afterwards. Nothing here ever reads the dev DATABASE_URL.

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not allocate a free port"));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

export default async function setup(project: TestProject) {
  const dataDir = mkdtempSync(join(tmpdir(), "chris-test-db-"));
  const port = await freePort();
  const db = await PGlite.create(dataDir);
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'chris') THEN
        CREATE ROLE chris LOGIN SUPERUSER PASSWORD 'chris';
      END IF;
    END
    $$;
  `);
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 10 });
  await server.start();

  const databaseUrl = `postgresql://chris:chris@127.0.0.1:${port}/chris_test`;
  const childEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    SEED_USER_EMAIL: "test-user@example.com",
    SEED_USER_PASSWORD: "test-only-password",
  };
  const domainDir = join(REPO_ROOT, "packages", "domain");
  const prismaBin = join(domainDir, "node_modules", ".bin", "prisma");
  // Async, not execFileSync: the PGlite server lives in this same process, so blocking the
  // event loop would leave it unable to answer the very connection prisma is opening.
  const run = promisify(execFile);
  await run(prismaBin, ["migrate", "deploy"], { cwd: domainDir, env: childEnv });
  await run(prismaBin, ["db", "seed"], { cwd: domainDir, env: childEnv });

  project.provide("testDatabaseUrl", databaseUrl);

  return async () => {
    await server.stop();
    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}
