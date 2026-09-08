// Local dev/test Postgres, with no Docker/Homebrew required — see /docs/DECISIONS.md.
//
// Serves a real PGlite instance (compiled Postgres, not an emulation) over the actual
// Postgres wire protocol via @electric-sql/pglite-socket, so Prisma's standard `postgresql`
// provider connects to it exactly as it would connect to real Postgres. Data persists to
// packages/domain/.pglite/ between runs (gitignored).
//
// Usage: `pnpm db:up` (add `DEBUG=1` for verbose protocol logging).

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "packages", "domain", ".pglite");
const PORT = process.env.PGLITE_PORT ? parseInt(process.env.PGLITE_PORT, 10) : 55432;
const HOST = process.env.PGLITE_HOST ?? "127.0.0.1";
const DEBUG = process.env.DEBUG ? parseInt(process.env.DEBUG, 10) : 0;

const db = await PGlite.create(DATA_DIR, { debug: DEBUG });

// Prisma expects a role matching the DATABASE_URL user/password in .env.example
// ("chris"/"chris") — PGlite's default superuser is "postgres", so create one that matches.
// PGlite is a single embedded database — pglite-socket doesn't route by the dbname in the
// client's connection string, so the ?/chris_dev suffix in DATABASE_URL is accepted but
// doesn't need to correspond to a real CREATE DATABASE.
await db.exec(`
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'chris') THEN
      CREATE ROLE chris LOGIN SUPERUSER PASSWORD 'chris';
    END IF;
  END
  $$;
`);

// Match this to DATABASE_URL's ?connection_limit=N in .env.example — extra connections
// beyond this are rejected outright, not queued, by pglite-socket's design.
const server = new PGLiteSocketServer({
  db,
  port: PORT,
  host: HOST,
  maxConnections: 5,
  inspect: !!DEBUG,
});

server.addEventListener("listening", () => {
  console.log(`[dev-db] PGlite serving Postgres wire protocol on ${HOST}:${PORT}`);
  console.log(`[dev-db] DATABASE_URL=postgresql://chris:chris@${HOST}:${PORT}/chris_dev`);
});
server.addEventListener("connection", () => console.log("[dev-db] client connected"));
server.addEventListener("close", () => console.log("[dev-db] server closed"));
server.addEventListener("error", (event) => {
  console.error("[dev-db] server error:", event.detail ?? event);
});

await server.start();

process.on("SIGINT", async () => {
  await server.stop();
  await db.close();
  console.log("[dev-db] stopped");
  process.exit(0);
});
