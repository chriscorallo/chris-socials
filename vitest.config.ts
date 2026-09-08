import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/lib/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // Integration tests hit the real local dev DB (pnpm db:up) — not mocked, per
    // /docs/EVALUATION_PLAN.md's Phase 0 test list. Sequential to avoid transaction
    // interleaving against the single-writer PGlite dev database.
    fileParallelism: false,
  },
});
