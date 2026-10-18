import { z } from "zod";

/**
 * Gold-standard eval case format (fixtures/evals/*.json — spec §24). Each case names the
 * prompt under test, the input to give it, deterministic assertions on the typed output, and a
 * `mockResponse` (a known-good output) used by the zero-cost harness self-test.
 */
export const AssertionSchema = z.object({
  /** Dot path into the agent output, e.g. "result" or "voiceScore". */
  path: z.string(),
  in: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  notIn: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  gte: z.number().optional(),
  lt: z.number().optional(),
  /** Array (or string) at path must be non-empty. */
  nonEmpty: z.boolean().optional(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

const ResearchFixtureSchema = z.object({
  primaryClaim: z.string(),
  facts: z.array(z.object({ statement: z.string(), type: z.string().default("FACT"), sourceUrl: z.string().nullable().default(null) })).default([]),
  citations: z
    .array(
      z.object({
        url: z.string().nullable(),
        title: z.string(),
        publisher: z.string().default(""),
        publishedOrEffectiveDate: z.string().nullable().default(null),
        accessedDate: z.string().nullable().default(null),
        isPrimarySource: z.boolean().default(false),
      }),
    )
    .default([]),
  numericInputs: z
    .array(z.object({ label: z.string(), value: z.string(), sourceUrl: z.string().nullable().default(null), asOfDate: z.string().nullable().default(null) }))
    .default([]),
  caveats: z.array(z.string()).default([]),
  prohibitedClaims: z.array(z.string()).default([]),
  contentSafeWording: z.string().default(""),
  confidence: z.number().default(0.8),
});
export type ResearchFixture = z.output<typeof ResearchFixtureSchema>;

export const EvalCaseSchema = z.discriminatedUnion("promptId", [
  z.object({
    id: z.string(),
    category: z.string(),
    description: z.string(),
    promptId: z.literal("CLAIMS_GATE"),
    input: z.object({
      mode: z.enum(["RESEARCH", "SCRIPT"]),
      research: ResearchFixtureSchema,
      script: z.string().optional(),
    }),
    expect: z.array(AssertionSchema).min(1),
    mockResponse: z.unknown(),
  }),
  z.object({
    id: z.string(),
    category: z.string(),
    description: z.string(),
    promptId: z.literal("BRAND_GUARDIAN"),
    input: z.object({ script: z.string(), strategyContext: z.string().optional() }),
    expect: z.array(AssertionSchema).min(1),
    /** "all" (default): every assertion must hold; "any": at least one. */
    expectMode: z.enum(["all", "any"]).default("all"),
    mockResponse: z.unknown(),
  }),
  /** Motion Designer: theme fits the topic, learned taste respected, no invented numbers. The
   * graded output is a summary of the real designVisualsForTimeline result (see runner). */
  z.object({
    id: z.string(),
    category: z.string(),
    description: z.string(),
    promptId: z.literal("MOTION_DESIGNER"),
    input: z.object({
      title: z.string(),
      pillar: z.string().nullable().default(null),
      /** Spoken script; word timings are synthesized at 0.4 s/word. */
      script: z.string(),
      tier: z.enum(["RAW", "FAST", "MEDIUM", "HERO"]).default("MEDIUM"),
      numericInputs: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
      tasteContext: z.string().nullable().default(null),
      avoidTemplates: z.array(z.string()).default([]),
      capDelta: z.number().default(0),
    }),
    expect: z.array(AssertionSchema).min(1),
    mockResponse: z.unknown(),
  }),
  /** Viewer Panel: given measured edit/audio facts (frames are neutral placeholders — this
   * grades fact handling, provenance and calibration, not vision), does the viewer flag what the
   * numbers say, cite evidence everywhere and avoid certainty language? The graded output is a
   * summary of the real runViewerPanelAgent result (see runner). */
  z.object({
    id: z.string(),
    category: z.string(),
    description: z.string(),
    promptId: z.literal("VIEWER_PANEL"),
    input: z.object({
      platform: z.enum(["TIKTOK", "INSTAGRAM", "YOUTUBE"]).default("INSTAGRAM"),
      /** Spoken script; word timings are synthesized at `secondsPerWord`. */
      script: z.string(),
      secondsPerWord: z.number().default(0.36),
      startS: z.number().default(0.3),
      tailS: z.number().default(0.4),
      cuts: z.array(z.object({ t: z.number(), kind: z.enum(["PAUSE_REMOVED", "FRAMING", "TAKE", "DETECTED"]), removedS: z.number().nullable().default(null) })).default([]),
      backgroundUnderVoiceDb: z.number().nullable().default(null),
      levelJumps: z.array(z.object({ t: z.number(), fromDb: z.number(), toDb: z.number() })).default([]),
      graphics: z.array(z.object({ template: z.string(), start: z.number(), end: z.number(), label: z.string().nullable().default(null) })).default([]),
    }),
    expect: z.array(AssertionSchema).min(1),
    mockResponse: z.unknown(),
  }),
]);
export type EvalCase = z.output<typeof EvalCaseSchema>;

export interface EvalCaseResult {
  id: string;
  category: string;
  promptId: string;
  passed: boolean;
  failures: string[];
  output: unknown;
  error?: string;
  costUsd: number;
  /** Summed provider usage (incl. cache reads + web searches) — null for mock runs. */
  usage: import("@chris/agents").ModelUsage | null;
  latencyMs: number;
  model: string | null;
}
