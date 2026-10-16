import { config } from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";

// Loads the repo-root .env (gitignored, dev-only — see .env.example) for any non-secret dev
// config a test may read. Prisma's CLI does this automatically; Vitest doesn't.
config({ path: join(dirname(fileURLToPath(import.meta.url)), ".env"), quiet: true });

// Always the throwaway database vitest.global-setup.ts created for this run — never the dev
// DATABASE_URL from .env. Set before any test file imports packages/domain's prisma client.
process.env.DATABASE_URL = inject("testDatabaseUrl");

// Every automated test uses MockModelProvider; make an accidental real (billed) model call
// impossible rather than merely unlikely.
delete process.env.ANTHROPIC_API_KEY;
