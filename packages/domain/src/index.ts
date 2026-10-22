export { prisma } from "./prisma";
export type { PrismaClient } from "./prisma";
export { Prisma } from "./prisma";

export * from "./state-machine";
export * from "./manual-transition";
export * from "./content-stage";
export * from "./footage-first";
export * from "./starter-edit";
export * from "./recording-session";
export * from "./delete-video";
export * from "./footage-removal";
export * from "./friendly-status";
export * from "./render-variant";
export * from "./audit";
export * from "./decision-journal";
export * from "./feature-flags";
export * from "./brand";
export * from "./auth";
export * from "./content-item";
export * from "./production-contract";
export * from "./creator-card";
export * from "./media-asset";
export * from "./schedule";
export * from "./pipeline-run";
export * from "./reference-creator";
export * from "./weekly-thesis";
export * from "./take-selection";
export * from "./edit-plan";
export * from "./render-record";
export * from "./quality-gate";
export * from "./quality-override";
export * from "./platform-package";
export * from "./preflight";
export * from "./publication";
export * from "./performance-snapshot";
export * from "./comment";
export * from "./audience-insight";
export * from "./performance-evaluation";
export * from "./evidence";
export * from "./belief";
export * from "./taste";
export * from "./motion-taste";
export * from "./brand-era";
export * from "./experiment";
export * from "./weekly-brief";
export * from "./adversarial-critique";
export * from "./autonomy";
export * from "./model-call-log";
export * from "./needs-you";
export * from "./script-version";
export * from "./strategic-context";

export type {
  User,
  ContentItem,
  ContentStateTransition,
  AuditLog,
  DecisionJournalEntry,
  FeatureFlag,
  BrandConstitutionVersion,
  BrandMemory,
  ContentState,
  ActorType,
  BrandMemoryKind,
  Pillar,
  ProductionTier,
  ResearchDepth,
  FactualRisk,
  FilmingSetup,
  MediaAssetKind,
  ProductionContract,
  CreatorCard,
  MediaAsset,
  ScheduleEntry,
  ResearchPacket,
  ScriptVersion,
  ResearchStatus,
  ContentPlatform,
  ReferenceCreator,
  ReferenceContent,
  ReferenceObservation,
  WeeklyProgrammingThesis,
  WeeklyPortfolioItem,
  PortfolioItemStatus,
  TakeSelection,
  EditPlan,
  Render,
  RenderStatus,
  QCReport,
  QCIssue,
  HardGateStatus,
  QCSeverity,
  PlatformPackage,
  Publication,
  PublicationStatus,
  PlatformCredential,
  PerformanceSnapshot,
  SnapshotOffset,
  Comment,
  AudienceInsight,
  PerformanceEvaluation,
  EvidenceEntry,
  EvidenceSourceType,
  Belief,
  BeliefStatus,
  TasteFeedback,
  ChrisAcceptanceProbability,
  BrandEra,
  Experiment,
  ExperimentVariant,
  ExperimentStatus,
  WeeklyBrief,
  AdversarialCritique,
  AutonomyLevel,
  AutonomySubsystem,
  ModelCallLog,
  LlmModelClass,
} from "@prisma/client";

// Platforms / publishing hardening (2026-10-16) — see docs/decisions-pending/platforms.md.
export * from "./platform-limits";
export * from "./platform-credential";
export * from "./job-run";
export type { JobRun } from "@prisma/client";

// Calendar views + posting plan + Stay-on-course (2026-10-17) — see docs/decisions-pending/calendar.md.
export * from "./tz";
export * from "./posting-plan-core";
export * from "./posting-plan";
export * from "./course";
export * from "./todo";
export type { PostingPlan, NudgeDismissal } from "@prisma/client";

// Plan import (2026-10-17) — see docs/decisions-pending/plan-import.md. The browser-safe
// parsers/matcher are at `@chris/domain/plan-import`.
export * from "./plan-import-db";
export type { PlanImport } from "@prisma/client";

// Scripts from ChatGPT (2026-10-17) — see docs/decisions-pending/chatgpt-scripts.md. The
// browser-safe prompt/parser/matcher are at `@chris/domain/script-import`.
export * from "./script-import-db";

// Reference videos (2026-10-17) — private, deterministic style measurement of creators Chris
// learns from. See docs/decisions-pending/reference-videos.md. `getReferenceStyleProfile` is the
// typed aggregate for the edit planner (not wired into any agent yet).
export * from "./style-metrics";
export * from "./style-model";
export * from "./reference-videos";
export type { ReferenceAnalysisStatus } from "@prisma/client";
// Style cut (2026-10-17) — persistence of the deterministic reference-paced edit
// (docs/decisions-pending/style-cut.md); the cut itself is packages/media style-cut.ts.
export * from "./style-cut-plan";
export * from "./latency";
// Viewer Panel (2026-10-17) — advisory AI first-time-viewer reviews of a whole video
// (docs/decisions-pending/viewer-panel.md). Never a hard-gate input.
export * from "./viewer-review";
// Watch-back gate (2026-10-22) — verdicts per render, Chris's one-tap ratings, autonomy as
// agreement per series (docs/PREMIUM_EDITOR_PLAN.md round 2).
export * from "./watch-back";
export type { ViewerReview as ViewerReviewRow } from "@prisma/client";
// ChatGPT connector (2026-10-17) — OAuth 2.1 server + MCP tool logic so Chris's own ChatGPT can
// read his plan and save scripts (docs/decisions-pending/chatgpt-connector.md). No model calls.
export * from "./connector-oauth";
export * from "./chatgpt-connector";
// Plan context (2026-10-17) — Chris's ChatGPT planning conversation(s), versioned; the
// `getActivePlanContext` API feeds the Script agent / Weekly Strategist / ChatGPT connector
// (docs/decisions-pending/plan-context.md). Browser-safe parsers at `@chris/domain/plan-context`.
export * from "./plan-context-db";
export type { PlanContext as PlanContextRow, PlanContextVersion as PlanContextVersionRow } from "@prisma/client";
export * from "./graphic-prefs";
export * from "./editor-health";
export * from "./graphic-bake";
export * from "./db-concurrency";
export * from "./director";
export * from "./creative-brief";
export * from "./creative-brief-text";
