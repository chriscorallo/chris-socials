/**
 * Worker process boundary — deliberately a stub in Phase 0. Exists as a separate deployable
 * so Phase 3's render-hosting decision (Vercel Sandbox vs. a dedicated long-lived host for
 * ffmpeg) doesn't force a monorepo restructure. See /docs/ARCHITECTURE.md and
 * /docs/PHASE_PLAN.md (Phase 3).
 */
console.log("[worker] stub process boundary — no jobs implemented until Phase 3.");
