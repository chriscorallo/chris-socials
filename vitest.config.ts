import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/lib/**/*.test.ts"],
    environment: "node",
    // A fresh, migrated, seeded throwaway Postgres per run — never the dev database. See
    // vitest.global-setup.ts and /docs/DECISIONS.md ("Tests get their own throwaway database").
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Sequential: PGlite is a single-writer embedded engine (see /docs/DECISIONS.md).
    fileParallelism: false,
  },
});
