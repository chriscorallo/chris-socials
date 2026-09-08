import { config } from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Loads the repo-root .env (gitignored, dev-only — see .env.example) into process.env for
// test runs. Prisma's own CLI does this automatically for migrate/seed; Vitest doesn't, so
// this setup file does it explicitly.
config({ path: join(dirname(fileURLToPath(import.meta.url)), ".env") });
