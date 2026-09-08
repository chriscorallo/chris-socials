import { z } from "zod";

/**
 * Typed output shapes for the Phase 2 agent pipeline. Field sets mirror each prompt file's
 * documented "Return" / "Output" section under /prompts/agents/. Keep these in sync with the
 * prompt files by hand — the prompt is the instruction, this is the contract it must satisfy.
 */

// --- Research Agent -> /prompts/agents/RESEARCH.md ---
export const FactEntrySchema = z.object({
  statement: z.string(),
  type: z.enum(["FACT", "INTERPRETATION", "EXAMPLE", "ASSUMPTION", "UNKNOWN"]),
});

export const ResearchPacketSchema = z.object({
  primaryClaim: z.string(),
  facts: z.array(FactEntrySchema),
  citations: z.array(z.string()),
  numericInputs: z.array(z.object({ label: z.string(), value: z.string() })),
  calculationNotes: z.string().nullable(),
  caveats: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  contradictoryEvidence: z.array(z.string()),
  prohibitedClaims: z.array(z.string()),
  contentSafeWording: z.string(),
  status: z.enum(["READY", "NEEDS_MORE_RESEARCH", "UNSUPPORTED", "OUT_OF_SCOPE"]),
  stopResearching: z.boolean(),
});
export type ResearchPacket = z.infer<typeof ResearchPacketSchema>;

// --- Claims Gate -> /prompts/agents/CLAIMS_GATE.md ---
export const ClaimEvaluationSchema = z.object({
  claimText: z.string(),
  sourceSupport: z.string(),
  evidenceStrength: z.enum(["WEAK", "MODERATE", "STRONG"]),
  freshnessConcern: z.boolean(),
  numericConsistency: z.boolean(),
  omittedCaveatRisk: z.boolean(),
  overstatesEvidence: z.boolean(),
});

export const ClaimsGateResultSchema = z.object({
  claims: z.array(ClaimEvaluationSchema),
  result: z.enum(["PASS", "PASS_WITH_REQUIRED_EDIT", "BLOCK"]),
  requiredEdits: z.array(z.string()),
  blockReason: z.string().nullable(),
});
export type ClaimsGateResult = z.infer<typeof ClaimsGateResultSchema>;

// --- Script Agent -> /prompts/agents/SCRIPT.md ---
export const ScriptBeatSchema = z.object({ label: z.string(), text: z.string() });

export const ScriptVersionSchema = z.object({
  spokenScript: z.string(),
  beats: z.array(ScriptBeatSchema),
  intendedPauses: z.array(z.string()),
  emphasizedWords: z.array(z.string()),
  visualBeats: z.array(z.string()),
  requiredFactualCaveats: z.array(z.string()),
  targetRuntimeSeconds: z.number(),
  estimatedSpeakingRuntimeSeconds: z.number(),
  followUpIdeas: z.array(z.string()),
});
export type ScriptVersion = z.infer<typeof ScriptVersionSchema>;

// --- Brand Guardian -> /prompts/agents/BRAND_GUARDIAN.md ---
export const BrandGuardianReportSchema = z.object({
  brandScore: z.number().min(0).max(100),
  voiceScore: z.number().min(0).max(100),
  originalityScore: z.number().min(0).max(100),
  strategicFit: z.string(),
  risks: z.array(z.string()),
  requiredChanges: z.array(z.string()),
  optionalImprovements: z.array(z.string()),
});
export type BrandGuardianReport = z.infer<typeof BrandGuardianReportSchema>;

// --- Reference Intelligence -> /prompts/agents/REFERENCE_INTELLIGENCE.md ---
export const ReferenceObservationSchema = z.object({
  observed: z.string(),
  likelyPrinciple: z.string(),
  transferabilityToChris: z.string(),
  reason: z.string(),
  risks: z.array(z.string()),
  testRequired: z.string(),
  confidence: z.number().min(0).max(1).nullable(),
});

export const ReferenceIntelligenceResultSchema = z.object({
  observations: z.array(ReferenceObservationSchema),
});
export type ReferenceIntelligenceResult = z.infer<typeof ReferenceIntelligenceResultSchema>;

// --- Creative Director -> WeeklyProgrammingThesis, /prompts/agents/CREATIVE_DIRECTOR.md ---
export const WeeklyProgrammingThesisSchema = z.object({
  thesis: z.string(),
  primaryObjectives: z.array(z.string()),
  activeExperiments: z.array(z.string()),
  areasToExploit: z.array(z.string()),
  areasToExplore: z.array(z.string()),
  areasToReduce: z.array(z.string()),
  risks: z.array(z.string()),
  contentGaps: z.array(z.string()),
  productionConstraints: z.array(z.string()),
  humanDecisionsNeeded: z.array(z.string()),
});
export type WeeklyProgrammingThesisOutput = z.infer<typeof WeeklyProgrammingThesisSchema>;

// --- Weekly Strategist -> portfolio allocation, /prompts/agents/WEEKLY_STRATEGIST.md ---
export const PortfolioItemAllocationSchema = z.object({
  contentItemId: z.string(),
  purpose: z.string(),
  pillar: z.enum(["SKILL", "MINDSET", "LIFESTYLE", "PASSIONS"]).nullable(),
  topic: z.string(),
  subtopic: z.string().nullable(),
  format: z.string(),
  productionTier: z.enum(["RAW", "FAST", "MEDIUM", "HERO"]),
  targetLengthSeconds: z.number().nullable(),
  primaryHypothesis: z.string(),
  historicalAnalogue: z.string().nullable(),
  referenceInfluence: z.string().nullable(),
  whyThisWeek: z.string(),
  duplicateRisk: z.string().nullable(),
  researchBurden: z.string().nullable(),
  productionBurden: z.string().nullable(),
  selected: z.boolean(),
});

export const PortfolioAllocationResultSchema = z.object({
  items: z.array(PortfolioItemAllocationSchema),
});
export type PortfolioAllocationResult = z.infer<typeof PortfolioAllocationResultSchema>;

// --- Take Selector -> /prompts/agents/TAKE_SELECTOR.md ---
export const TakeSelectionResultSchema = z.object({
  selectedMediaAssetId: z.string(),
  backupMediaAssetId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  materialDefects: z.array(z.string()),
});
export type TakeSelectionResult = z.infer<typeof TakeSelectionResultSchema>;

// --- Edit Planner -> /prompts/agents/EDIT_PLANNER.md ---
export const EditPlanSegmentSchema = z.object({
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
});

export const EditPlanTextOverlaySchema = z.object({
  text: z.string(),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  position: z.enum(["TOP", "CENTER", "BOTTOM"]),
  style: z.enum(["HEADLINE", "CAPTION", "NUMBER_CALLOUT", "LOWER_THIRD"]),
});

/**
 * The renderer (packages/media) currently executes: segments, targetDimensions,
 * textOverlays, normalizeAudio. Everything else here is a real, validated field the spec
 * calls for that the renderer gracefully skips for now (B-roll/music/SFX need an approved
 * asset library; transitions beyond hard cuts aren't implemented) — see /docs/DECISIONS.md.
 * Reserving the field now means no schema migration is needed when those land.
 */
export const EditPlanOutputSchema = z.object({
  segments: z.array(EditPlanSegmentSchema).min(1),
  targetDimensions: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .nullable(),
  textOverlays: z.array(EditPlanTextOverlaySchema),
  normalizeAudio: z.boolean(),
  bRollRequests: z.array(z.string()),
  musicTrack: z.string().nullable(),
  sfxEvents: z.array(z.object({ atSeconds: z.number(), sfx: z.string() })),
  transitions: z.array(z.object({ atSeconds: z.number(), type: z.string() })),
  targetDurationSeconds: z.number().positive(),
  productionTier: z.enum(["RAW", "FAST", "MEDIUM", "HERO"]),
  doNothingElse: z.boolean(),
  rationale: z.string(),
});
export type EditPlanOutput = z.infer<typeof EditPlanOutputSchema>;

// --- Visual QA -> /prompts/agents/VISUAL_QA.md ---
// Category list mirrors the prompt's "## Check" list exactly, plus a catch-all bucket — see
// /docs/PRODUCT_SPEC.md item 14. Kept as one flat enum (not per-defect-type schemas) because
// every category shares the same shape (description + severity + optional timestamp); a
// deterministic aggregator (packages/domain/src/quality-gate.ts) only needs `severity` to
// decide whether a finding blocks, so a richer per-category schema wouldn't earn its keep yet.
export const QCIssueCategorySchema = z.enum([
  "FACE_OBSTRUCTION",
  "EYE_OBSTRUCTION",
  "MOUTH_OBSTRUCTION",
  "HEADLINE_COLLISION",
  "CAPTION_COLLISION",
  "SAFE_ZONE",
  "CROPPING",
  "TYPOGRAPHY",
  "LINE_WRAPPING",
  "TEXT_DURATION",
  "LEGIBILITY",
  "CONTRAST",
  "CHART_ACCURACY",
  "NUMBER_ACCURACY",
  "FIRST_FRAME_COMPREHENSION",
  "VISUAL_ARTIFACT",
  "GENERATIVE_ARTIFACT",
  "BLACK_FRAME",
  "SCENE_BOUNDARY",
  "OTHER",
]);
export type QCIssueCategory = z.infer<typeof QCIssueCategorySchema>;

export const QCSeveritySchema = z.enum(["INFO", "MINOR", "MAJOR", "BLOCKING"]);
export type QCSeverity = z.infer<typeof QCSeveritySchema>;

export const QCIssueSchema = z.object({
  category: QCIssueCategorySchema,
  description: z.string(),
  severity: QCSeveritySchema,
  timestampSeconds: z.number().nullable(),
  recommendedRepair: z.string().nullable(),
});
export type QCIssue = z.infer<typeof QCIssueSchema>;

export const VisualQAReportSchema = z.object({
  issues: z.array(QCIssueSchema),
  overallImpression: z.string(),
});
export type VisualQAReport = z.infer<typeof VisualQAReportSchema>;

// --- Platform Packaging -> /prompts/agents/PLATFORM_PACKAGING_{BASE,INSTAGRAM,TIKTOK,YOUTUBE}.md ---
export const PlatformPackageOutputSchema = z.object({
  caption: z.string(),
  // Only YouTube's prompt actually asks for a distinct title; Instagram/TikTok legitimately
  // return null here rather than duplicating the caption into a fake title field.
  title: z.string().nullable(),
  hashtags: z.array(z.string()),
  coverFrameSeconds: z.number().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type PlatformPackageOutput = z.infer<typeof PlatformPackageOutputSchema>;

// --- Scheduler -> /prompts/agents/SCHEDULER.md ---
export const ScheduleProposalItemSchema = z.object({
  contentItemId: z.string(),
  platforms: z.array(z.enum(["INSTAGRAM", "TIKTOK", "YOUTUBE"])),
  scheduledDate: z.string(), // ISO 8601 — validated/parsed by the caller against real Date
  reasoning: z.string(),
});
export const SchedulerResultSchema = z.object({
  items: z.array(ScheduleProposalItemSchema),
});
export type SchedulerResult = z.infer<typeof SchedulerResultSchema>;

// --- Analytics Agent -> /prompts/agents/ANALYTICS_AGENT.md ---
export const PerformanceCategorySchema = z.enum([
  "ATTENTION",
  "CONSUMPTION",
  "AMPLIFICATION",
  "CONVERSATION",
  "IDENTITY_CONVERSION",
  "RELATIONSHIP",
  "BUSINESS_VALUE",
  "PRODUCTION_ROI",
]);
export const PerformanceCategoryEvaluationSchema = z.object({
  category: PerformanceCategorySchema,
  assessment: z.string(),
  confidence: z.number().min(0).max(1),
  // The prompt's own words: "some platforms won't return some metrics" — this is the model
  // stating, per category, whether it actually had enough real data to judge from.
  dataCompleteness: z.enum(["COMPLETE", "PARTIAL", "MISSING"]),
});
export const PerformanceEvaluationSchema = z.object({
  categories: z.array(PerformanceCategoryEvaluationSchema),
  overallSummary: z.string(),
  // The prompt explicitly calls this out as something to state, not default away from.
  strategicallyValuableDespiteLowerViews: z.boolean(),
});
export type PerformanceEvaluation = z.infer<typeof PerformanceEvaluationSchema>;

// --- Audience Intelligence -> /prompts/agents/AUDIENCE_INTELLIGENCE.md ---
export const AudienceInsightCategorySchema = z.enum([
  "questions",
  "confusion",
  "objections",
  "disagreements",
  "stories",
  "requested_topics",
  "repeated_language",
  "sentiment",
  "misconceptions",
]);
export const AudienceInsightItemSchema = z.object({
  category: AudienceInsightCategorySchema,
  description: z.string(),
  supportingCommentCount: z.number().int().positive(),
  exampleQuotes: z.array(z.string()),
  actionableSuggestion: z.string().nullable(),
});
export const AudienceIntelligenceResultSchema = z.object({
  insights: z.array(AudienceInsightItemSchema),
});
export type AudienceIntelligenceResult = z.infer<typeof AudienceIntelligenceResultSchema>;

// --- Learning Agent -> /prompts/agents/LEARNING_AGENT.md ---
// Mirrors packages/domain/src/belief.ts's ProposeBeliefInput by hand (agents must not depend
// on domain — see /docs/ARCHITECTURE.md's package boundaries), with one addition:
// `evidenceStatements` lets the model cite evidence descriptively; the caller
// (apps/web) is responsible for resolving those to real EvidenceEntry ids before persisting —
// the model never invents an id directly.
export const BeliefProposalOutputSchema = z.object({
  statement: z.string(),
  causalClaim: z.string().nullable(),
  isExperimentalEvidence: z.boolean(),
  evidenceStatements: z.array(z.string()).min(1),
  sampleSize: z.number().int().positive(),
  applicablePlatform: z.enum(["INSTAGRAM", "TIKTOK", "YOUTUBE"]).nullable(),
  applicableTopic: z.string().nullable(),
  applicableFormat: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  confounders: z.array(z.string()),
  contradictoryEvidence: z.array(z.string()),
  retestConditions: z.string().nullable(),
});
export type BeliefProposalOutput = z.infer<typeof BeliefProposalOutputSchema>;

// --- Adversarial Evaluator -> /prompts/agents/ADVERSARIAL_EVALUATOR.md ---
export const AdversarialConcernSchema = z.object({
  description: z.string(),
  whyItMatters: z.string(),
  evidence: z.string(),
});
export const AdversarialCritiqueOutputSchema = z.object({
  concerns: z.array(AdversarialConcernSchema),
  noMaterialWeaknessesFound: z.boolean(),
});
export type AdversarialCritiqueOutput = z.infer<typeof AdversarialCritiqueOutputSchema>;

// --- Taste Learner -> /prompts/agents/TASTE_LEARNER.md ---
export const AcceptanceProbabilityItemSchema = z.object({
  tag: z.string(),
  context: z.record(z.string(), z.unknown()),
  probability: z.number().min(0).max(1),
  sampleSize: z.number().int().positive(),
  generalizes: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export const TasteLearnerResultSchema = z.object({
  probabilities: z.array(AcceptanceProbabilityItemSchema),
});
export type TasteLearnerResult = z.infer<typeof TasteLearnerResultSchema>;

// --- Experiment Agent -> /prompts/agents/EXPERIMENT_AGENT.md ---
export const ExperimentVariantOutputSchema = z.object({
  label: z.string(),
  description: z.string(),
});
export const ExperimentProposalSchema = z.object({
  hypothesis: z.string(),
  variants: z.array(ExperimentVariantOutputSchema).min(2),
  confounders: z.array(z.string()),
  minSampleSize: z.number().int().positive(),
  minDurationDays: z.number().int().positive(),
  portfolioMapping: z.string().nullable(),
});
export const ExperimentAgentResultSchema = z.object({
  experiments: z.array(ExperimentProposalSchema),
});
export type ExperimentAgentResult = z.infer<typeof ExperimentAgentResultSchema>;

// --- Weekly Review / Learning Council -> /prompts/agents/WEEKLY_REVIEW_LEARNING_COUNCIL.md ---
export const WeeklyReviewResultSchema = z.object({
  whatHappened: z.string(),
  whatItMeans: z.string(),
  stillUncertain: z.array(z.string()),
  recommendationsForNextWeek: z.array(z.string()),
  candidateBeliefs: z.array(BeliefProposalOutputSchema),
});
export type WeeklyReviewResult = z.infer<typeof WeeklyReviewResultSchema>;
