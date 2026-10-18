import type { ViewerReview, ViewerState, VerdictTier } from "@chris/agents";

/**
 * Client-safe view model for the "Viewer check" card (no Node / SDK imports — types only from
 * @chris/agents). Pure helpers: AI availability wording, the attention strip's segments, labels.
 */

export type ViewerSubjectRef = { kind: "RENDER"; contentItemId: string } | { kind: "REFERENCE_VIDEO"; referenceContentId: string };

export interface ViewerReviewView {
  id: string;
  createdAt: string;
  review: ViewerReview;
  warnings: string[];
  platform: string;
  persona: string;
  model: string;
  costUsd: number | null;
  estimatedCostUsd: number;
  durationS: number | null;
  frames: number | null;
  /** False when a newer render exists than the one this review watched. */
  isForCurrentVersion: boolean;
}

export type AiAvailability =
  | { state: "ok" }
  | { state: "off" | "no-credit" | "cap"; message: string };

export interface ViewerCheckData {
  subject: ViewerSubjectRef;
  /** What the viewer watches (and the player in the result) — null when there's nothing yet. */
  mediaUrl: string | null;
  /** Why it can't run yet (no render, file deleted). */
  unavailable: string | null;
  estimate: { label: string; usd: number; highUsd: number; frames: number } | null;
  ai: AiAvailability;
  defaultPlatform: "TIKTOK" | "INSTAGRAM" | "YOUTUBE";
  latest: ViewerReviewView | null;
  activeJobRunId: string | null;
}

export function aiAvailability(input: { keySet: boolean; creditError: boolean; todayUsd: number; capUsd: number | null }): AiAvailability {
  if (!input.keySet) return { state: "off", message: "The AI is off — no Anthropic key is set up yet." };
  if (input.creditError) return { state: "no-credit", message: "The AI is out of credit, so a viewer can't watch it right now." };
  if (input.capUsd != null && input.todayUsd >= input.capUsd) return { state: "cap", message: "Today's AI safety limit is reached — it resets at midnight UTC." };
  return { state: "ok" };
}

/** A job failure that means the AI can't run (vs. a problem with this video). */
export function isAiUnavailableError(error: string | null | undefined, errorName?: string | null): boolean {
  if (errorName === "SpendCapExceededError" || errorName === "SpendCapCheckFailedError") return true;
  return /credit balance|billing|insufficient|api[_ ]?key|authentication|spend ?cap|spending limit|ANTHROPIC/i.test(error ?? "");
}

export const STATE_LABEL: Record<ViewerState, string> = {
  confused: "Confused",
  curious: "Curious",
  hooked: "Hooked",
  entertained: "Entertained",
  amused: "Amused",
  educated: "Learning",
  inspired: "Inspired",
  moved: "Moved",
  neutral: "Neutral",
  bored: "Bored",
  irritated: "Irritated",
  skeptical: "Skeptical",
  overwhelmed: "Overwhelmed",
};

/** Strip colours: warm = with you, grey = drifting, rose = losing them. */
export function stateTone(state: ViewerState): "great" | "good" | "flat" | "bad" {
  if (state === "hooked" || state === "entertained" || state === "amused" || state === "inspired" || state === "moved") return "great";
  if (state === "curious" || state === "educated") return "good";
  if (state === "neutral") return "flat";
  return "bad";
}

export const TIER_LABEL: Record<VerdictTier, string> = {
  BAD: "Bad",
  OKAY: "Okay",
  GOOD: "Good",
  GREAT: "Great",
  EXCEPTIONAL: "Exceptional",
};

export interface StripSegment {
  index: number;
  leftPct: number;
  widthPct: number;
  heightPct: number;
  tone: ReturnType<typeof stateTone>;
  label: string;
  tStart: number;
  tEnd: number;
}

/** Beats → strip segments over the video's length (gaps stay empty; a beat never overflows). */
export function attentionStrip(review: ViewerReview, durationS: number): StripSegment[] {
  const d = durationS > 0 ? durationS : Math.max(1, ...review.beats.map((b) => b.tEnd));
  return review.beats.map((b, index) => {
    const a = Math.max(0, Math.min(d, b.tStart));
    const z = Math.max(a, Math.min(d, b.tEnd));
    return {
      index,
      leftPct: (a / d) * 100,
      widthPct: Math.max(0.8, ((z - a) / d) * 100),
      heightPct: Math.max(18, Math.min(100, b.attention)),
      tone: stateTone(b.state),
      label: `${fmtT(a)}–${fmtT(z)} ${STATE_LABEL[b.state]}, attention ${Math.round(b.attention)}`,
      tStart: a,
      tEnd: z,
    };
  });
}

export function fmtT(t: number): string {
  if (t < 60) return `${t.toFixed(t < 10 ? 1 : 0)}s`;
  const m = Math.floor(t / 60);
  const s = Math.round(t - m * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const ENGAGEMENT_LABEL: Record<keyof ViewerReview["engagement"], string> = {
  watchThrough: "Watch to the end",
  rewatch: "Rewatch",
  save: "Save",
  share: "Share",
  comment: "Comment",
  follow: "Follow",
};

export const CRAFT_LABEL: Record<string, string> = {
  CUT_TOO_CHOPPY: "Cuts too choppy",
  CUT_TOO_SLOW: "Too slow",
  CUT_MID_THOUGHT: "Cut mid-thought",
  CUT_WITHOUT_PURPOSE: "Cut without a reason",
  PACING: "Pacing",
  VISUAL_TONE_MISMATCH: "Picture vs tone",
  GRAPHIC_MISMATCH: "Graphic doesn't match",
  GRAPHIC_MISTIMED: "Graphic timing",
  BROLL_MISMATCH: "B-roll doesn't match",
  CAPTION_READABILITY: "Caption readability",
  CAPTION_OCCLUSION: "Caption covers something",
  AUDIO_LEVEL_JUMP: "Volume jump",
  MUSIC_OVER_VOICE: "Music over the voice",
  ABRUPT_AUDIO_AT_CUT: "Sound pops at a cut",
  AUDIO_VIDEO_MISMATCH: "Sound doesn't match picture",
  ENDING: "Ending",
  LOOP: "Loop",
  CTA: "Call to action",
  OTHER: "Other",
};
