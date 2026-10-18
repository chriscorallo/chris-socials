/**
 * Scripts from ChatGPT — browser-safe (no Prisma): the prompt Chris pastes into ChatGPT, the
 * parser for its answer, and the matcher that pairs each script with a planned video. The
 * server side (saving script versions, state walk, audit) lives in ../script-import-db.ts.
 * Exposed as `@chris/domain/script-import`. See docs/decisions-pending/chatgpt-scripts.md.
 */
export * from "./parse";
export * from "./match";
export * from "./prompt";
