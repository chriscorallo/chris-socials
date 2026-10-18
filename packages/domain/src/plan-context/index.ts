/**
 * Plan context — browser-safe (no Prisma): reading Chris's ChatGPT planning conversation from
 * the official export (.zip / conversations.json / chat.html), a share page, or a paste;
 * Highlights by headings; finding the video plan inside it (same parsers as plan import);
 * and the bounded text block for model calls. The server side (versions, delete, the
 * `getActivePlanContext` API) is ../plan-context-db.ts. Exposed as `@chris/domain/plan-context`.
 * See docs/decisions-pending/plan-context.md.
 */
export * from "./types";
export * from "./chatgpt-export";
export * from "./zip";
export * from "./paste";
export * from "./share";
export * from "./highlights";
export * from "./plan-candidates";
export * from "./context-text";
