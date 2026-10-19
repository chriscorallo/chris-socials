/**
 * Finish & schedule — what the quality step does, as pure decisions (client-safe; unit-tested
 * in finish-quality.test.ts, used by FinishModal). docs/decisions-pending/quality-override.md.
 */

export type QualityMode = "FIRM" | "SKIP_ALLOWED";

export interface QualityPlanInput {
  mode: QualityMode;
  ai: { ready: boolean; reason: string | null };
  /** The "Skip the AI check for this video" tick (only meaningful in SKIP_ALLOWED). */
  skipThis: boolean;
}

export type QualityPlan =
  | { kind: "AI_CHECK" }
  | { kind: "SKIP"; trigger: "AI_UNAVAILABLE" | "OWNER_CHOICE"; reason: string | null };

/** Before rendering: run the AI check, or go straight to the free technical check? Firm
 * always runs the AI check (and stops if it can't). */
export function planQualityStep(i: QualityPlanInput): QualityPlan {
  if (i.mode !== "SKIP_ALLOWED") return { kind: "AI_CHECK" };
  if (!i.ai.ready) return { kind: "SKIP", trigger: "AI_UNAVAILABLE", reason: i.ai.reason ?? "The AI can't run right now" };
  if (i.skipThis) return { kind: "SKIP", trigger: "OWNER_CHOICE", reason: null };
  return { kind: "AI_CHECK" };
}

export type CheckFailureAction = { kind: "SKIP"; reason: string } | { kind: "FIRM_STOP"; reason: string } | { kind: "ERROR" };

/** The AI check failed: was it because the AI can't run (no key / credit / cap)? Then skip if
 * the owner allows it, else stop firmly (and offer the switch). Any other failure is an error. */
export function onAiCheckFailure(mode: QualityMode, aiUnavailable: string | null | undefined, state: string | undefined): CheckFailureAction {
  if (!aiUnavailable || state !== "RENDERED") return { kind: "ERROR" };
  return mode === "SKIP_ALLOWED" ? { kind: "SKIP", reason: aiUnavailable } : { kind: "FIRM_STOP", reason: aiUnavailable };
}

/** "Technical check passed. AI check skipped — the AI account is out of credit (your call, logged)." */
export function skippedDetail(reason: string | null): string {
  return `Technical check passed. AI check skipped${reason ? ` — ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : ""} (your call, logged).`;
}
