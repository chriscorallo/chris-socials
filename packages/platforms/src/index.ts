/**
 * Platform adapter interfaces (Instagram/TikTok/YouTube) — real from Phase 5. The interface
 * boundary exists so one platform's limitations never leak into the others — see
 * /docs/DECISIONS.md for the confirmed rate-limit/audit constraints per platform.
 */
export const PHASE_INTRODUCED = 5;

export * from "./adapter";
export * from "./mock-adapter";
export * from "./instagram-adapter";
export * from "./youtube-adapter";
export * from "./tiktok-adapter";
export * from "./youtube-quota";
export * from "./token-crypto";
