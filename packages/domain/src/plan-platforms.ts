/**
 * The platforms a posting plan covers. Its own zod-free module so browser code (plan import,
 * calendar) can use it without pulling zod's ~90 KB into the client bundle — posting-plan-core
 * re-exports it. See docs/decisions-pending/app-performance.md.
 */
export const PLAN_PLATFORMS = ["TIKTOK", "INSTAGRAM", "YOUTUBE"] as const;
export type PlanPlatform = (typeof PLAN_PLATFORMS)[number];
