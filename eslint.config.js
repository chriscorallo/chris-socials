import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/generated/**",
      "**/.pglite/**",
      "**/.pglite-*/**",
      ".claude/worktrees/**",
      "**/.cache/**",
      // cloud-worker build output (scripts/sandbox/build-runner.ts)
      ".sandbox-build/**",
    ],
  },
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      // Phase 0 scaffolding intentionally has some stub packages with unused exports.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);
