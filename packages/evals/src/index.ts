/**
 * Eval harness + gold-standard fixture loader (/docs/EVALUATION_PLAN.md, spec §24).
 * Fixtures: /fixtures/evals/*.json. Real run: `pnpm --filter @chris/evals eval` (opt-in, needs
 * ANTHROPIC_API_KEY). Zero-cost self-test: src/__tests__/harness.test.ts (normal test suite).
 */
export * from "./types";
export * from "./runner";
