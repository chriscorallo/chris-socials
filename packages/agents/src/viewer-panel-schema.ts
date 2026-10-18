import { z } from "zod";

/**
 * Viewer Panel — the typed output of /prompts/agents/VIEWER_PANEL.md: an AI first-time viewer
 * watching one whole video (sampled frames + word-timed transcript + measured edit/audio facts)
 * and reporting, beat by beat, what they'd be thinking.
 *
 * Shape rules that enforce CLAUDE.md's provenance rule in the TYPE, not just the prompt:
 *  - every judgment (hook, beat, drop-off, craft check, story jump, verdict, fix, strength)
 *    carries `evidence` with at least one timestamped item saying what was SEEN / SAID / HEARD /
 *    MEASURED at that moment;
 *  - engagement numbers are `kind: "ESTIMATE"` with an explicit uncertainty and the timestamps
 *    they rest on — there is no field for a "this will go viral" prediction, and certainty
 *    language in rationales is flagged by checkViewerReview (viewer-panel.ts).
 *
 * ADVISORY ONLY: nothing here is a hard-gate input. The quality gate's aggregation
 * (packages/domain quality-gate.ts) never reads a ViewerReview.
 */

export const VIEWER_STATES = [
  "confused",
  "curious",
  "hooked",
  "entertained",
  "amused",
  "educated",
  "inspired",
  "moved",
  "neutral",
  "bored",
  "irritated",
  "skeptical",
  "overwhelmed",
] as const;
export type ViewerState = (typeof VIEWER_STATES)[number];

/** States that pull a cold viewer toward the next video in the feed. */
export const NEGATIVE_VIEWER_STATES: ReadonlySet<ViewerState> = new Set(["confused", "bored", "irritated", "skeptical", "overwhelmed"]);

export const ViewerEvidenceSchema = z.object({
  t: z.number().min(0).describe("Seconds into the video this evidence is from."),
  kind: z
    .enum(["SEEN", "SAID", "HEARD", "MEASURED"])
    .describe("SEEN = in a frame; SAID = in the transcript; HEARD = in the audio facts; MEASURED = a number from the edit/audio facts."),
  detail: z.string().min(1).describe("What exactly is on screen / was said (quote) / was heard / was measured at t."),
});
export type ViewerEvidence = z.infer<typeof ViewerEvidenceSchema>;

const Evidence = z.array(ViewerEvidenceSchema).min(1);

export const ViewerHookSchema = z.object({
  tEnd: z.number().min(0).describe("Where the hook window ends (usually 1–3 s)."),
  wouldStopScrolling: z.enum(["YES", "MAYBE", "NO"]),
  stopChancePct: z.number().min(0).max(100).describe("Estimated chance a cold viewer stops scrolling (an estimate, not a fact)."),
  firstFrameRead: z.string().describe("What a viewer understands from the very first frame alone."),
  why: z.string(),
  evidence: Evidence,
});

export const ViewerBeatSchema = z.object({
  tStart: z.number().min(0),
  tEnd: z.number().min(0),
  state: z.enum(VIEWER_STATES),
  secondaryState: z.enum(VIEWER_STATES).nullable(),
  intensity: z.number().int().min(1).max(5).describe("How strongly they feel it, 1 = faint, 5 = strong."),
  attention: z.number().min(0).max(100).describe("0 = gone, 100 = locked in."),
  scrollAwayPct: z.number().min(0).max(100).describe("Estimated chance a cold viewer still watching swipes away during this beat."),
  thinking: z.string().describe("Their inner voice, first person, one short line (e.g. \"wait, how is that legal?\")."),
  driver: z.string().describe("What in the video is driving this feeling."),
  evidence: Evidence,
});
export type ViewerBeat = z.infer<typeof ViewerBeatSchema>;

export const ViewerDropOffSchema = z.object({
  t: z.number().min(0),
  riskPct: z.number().min(0).max(100),
  reason: z.string(),
  evidence: Evidence,
});

export const CRAFT_CATEGORIES = [
  "CUT_TOO_CHOPPY",
  "CUT_TOO_SLOW",
  "CUT_MID_THOUGHT",
  "CUT_WITHOUT_PURPOSE",
  "PACING",
  "VISUAL_TONE_MISMATCH",
  "GRAPHIC_MISMATCH",
  "GRAPHIC_MISTIMED",
  "BROLL_MISMATCH",
  "CAPTION_READABILITY",
  "CAPTION_OCCLUSION",
  "AUDIO_LEVEL_JUMP",
  "MUSIC_OVER_VOICE",
  "ABRUPT_AUDIO_AT_CUT",
  "AUDIO_VIDEO_MISMATCH",
  "ENDING",
  "LOOP",
  "CTA",
  "OTHER",
] as const;
export type CraftCategory = (typeof CRAFT_CATEGORIES)[number];

export const ViewerCraftCheckSchema = z.object({
  category: z.enum(CRAFT_CATEGORIES),
  verdict: z.enum(["GOOD", "MINOR", "PROBLEM"]),
  tStart: z.number().min(0),
  tEnd: z.number().min(0).nullable(),
  finding: z.string(),
  evidence: Evidence,
});
export type ViewerCraftCheck = z.infer<typeof ViewerCraftCheckSchema>;

export const ViewerStorySchema = z.object({
  corePromise: z.string().describe("The promise of the video in one line, as a viewer would put it — or \"unclear\"."),
  promiseClearAtS: z.number().min(0).nullable().describe("When a viewer first understands the promise (null = never)."),
  clarity: z.enum(["CLEAR", "MOSTLY_CLEAR", "MUDDY"]),
  cohesive: z.boolean(),
  confusingJumps: z.array(z.object({ t: z.number().min(0), what: z.string(), evidence: Evidence })),
  summary: z.string(),
});

export const ENGAGEMENT_METRICS = ["watchThrough", "rewatch", "save", "share", "comment", "follow"] as const;
export type EngagementMetric = (typeof ENGAGEMENT_METRICS)[number];

export const EngagementEstimateSchema = z.object({
  kind: z.literal("ESTIMATE"),
  score: z.number().min(0).max(100).describe("Relative likelihood, 0–100 — an estimate from this one viewing, never a forecast of views."),
  uncertainty: z.enum(["LOW", "MEDIUM", "HIGH"]),
  rationale: z.string().describe("One line tied to concrete moments."),
  evidenceTimes: z.array(z.number().min(0)).min(1).describe("The timestamps this estimate rests on."),
});
export type EngagementEstimate = z.infer<typeof EngagementEstimateSchema>;

export const VERDICT_TIERS = ["BAD", "OKAY", "GOOD", "GREAT", "EXCEPTIONAL"] as const;
export type VerdictTier = (typeof VERDICT_TIERS)[number];

export const ViewerReviewSchema = z.object({
  persona: z.string().describe("Who watched, one line (e.g. \"cold viewer on TikTok, never seen this creator\")."),
  verdict: z.object({
    tier: z.enum(VERDICT_TIERS),
    headline: z.string().describe("One plain sentence a creator can act on."),
    biggestReason: z.string(),
    evidence: Evidence,
  }),
  hook: ViewerHookSchema,
  beats: z.array(ViewerBeatSchema).min(1),
  dropOffs: z.array(ViewerDropOffSchema),
  craft: z.array(ViewerCraftCheckSchema),
  story: ViewerStorySchema,
  engagement: z.object({
    watchThrough: EngagementEstimateSchema,
    rewatch: EngagementEstimateSchema,
    save: EngagementEstimateSchema,
    share: EngagementEstimateSchema,
    comment: EngagementEstimateSchema,
    follow: EngagementEstimateSchema,
  }),
  strengths: z.array(z.object({ t: z.number().min(0), what: z.string(), evidence: Evidence })).max(5),
  fixes: z
    .array(
      z.object({
        priority: z.number().int().min(1).max(5),
        tStart: z.number().min(0),
        tEnd: z.number().min(0).nullable(),
        instruction: z.string().describe("Concrete and doable in the editor (what to cut / move / change, where)."),
        expectedEffect: z.string().describe("What it should change for the viewer — an expectation, not a promise."),
        evidence: Evidence,
      }),
    )
    .max(5),
  limitations: z.array(z.string()).describe("What this viewing couldn't judge (between sampled frames, audio known only from measurements, …)."),
});
export type ViewerReview = z.infer<typeof ViewerReviewSchema>;
