# Data Model

Full entity map from spec §19, grouped by the layer that owns each entity
(`/docs/ARCHITECTURE.md`) and the phase that first needs real schema for it
(`/docs/PHASE_PLAN.md`). All entities use durable IDs (cuid/uuid) and, where they represent
something that changes meaningfully over time, explicit versioning rather than in-place
overwrites.

**Only the Phase 0 subset below has real Prisma models today.** Everything else is a
documented commitment, not yet migrated — each phase adds its own entities via a proper
Prisma migration when that phase starts, per `CLAUDE.md`'s "no schema change without
migrations" rule. Introducing a table earlier than the phase that needs it is avoided
deliberately — undriven schema invites design mistakes made without real usage context.

## Mini-movie Studio (2026-10-18, migration `20261018070000_film_studio`)

| Entity | Purpose | Key fields |
|---|---|---|
| `Film` | One on-demand animated short made by the studio crew | `title, idea, targetSeconds, look, voiceId, voiceEngine, aiMode (CHATGPT/LOCAL), status, step, iteration, counters, limits, currentVersionId?, pending? (the ChatGPT pack waiting), engineJob?, confirmedClaims, chrisNotes, blockedReasons, leaseHolder?/leaseUntil?, sourceContentItemId?, contentItemId? (after Send to Videos)` |
| `FilmVersion` | Append-only versions of the film (DSL + script + brief) | `filmId, version (unique per film), origin (CREW_WRITE/CREW_REVISION/FIX/CHRIS_EDIT/CHATGPT_DRAFT), parentVersionId?, dsl, script?, brief?, note` |
| `FilmArtifact` | Append-only crew reports, engine results, round trips, Chris actions | `filmId, versionId?, kind, agent, via (DETERMINISTIC/LOCAL_EMBEDDING/CHATGPT/LOCAL_AI/ENGINE/CHRIS), promptVersion?, iteration, idempotencyKey (unique), summary, payload, gate?` |

No update/delete path for versions/artifacts (`packages/agents/src/studio/prisma-film-store.ts`).
See `docs/decisions-pending/studio-crew.md`.

## Segmented recording + drafts (2026-10-18)

| Entity | Purpose | Key fields |
|---|---|---|
| `RecordingSession` | The draft of a video filmed in parts with the teleprompter (at most one DRAFT per video) | `contentItemId, status (DRAFT/FINISHED/DISCARDED), scriptPosition, scriptFingerprint?, createdBy, finishedAt?, discardedAt?` |
| `RecordingSegment` | One recorded part, permanent (deleting a part marks it DELETED and removes only its media) | `recordingSessionId, clientKey (unique per session — idempotent registration), segmentIndex, status (ACTIVE/DELETED), mediaAssetId? (unique, SET NULL), durationSeconds?, scriptPositionStart/End?, deletedAt?` |

While a session is DRAFT the starter edit / style cut / take selector are refused; after Finish
the starter edit's `plan.sequence` lists every active part in order. See
`docs/decisions-pending/segmented-recording-drafts.md` and `packages/domain/src/recording-session.ts`.

## Phase 8 — concrete schema (implemented now, in addition to Phase 0-7's)

| Entity | Purpose | Key fields |
|---|---|---|
| `AutonomyLevel` | Spec §23 — one row per (subsystem, productionTier), the literal Phase 8 acceptance criterion's unit of tracking | `subsystem (AutonomySubsystem), productionTier, level (0-4), approvedOutcomeCount, ceilingLevel (default 4), lastEscalatedAt?, lastEscalationReason?` |

`AutonomySubsystem` is a fixed enum (`TAKE_SELECTION`, `EDIT_PLANNING`, `QUALITY_GATE`,
`SCHEDULING`, `PUBLISHING`) — the named steps in this system where a human currently clicks a
button to advance the pipeline. `level` only ever escalates via
`packages/domain/src/autonomy.ts`'s `recordApprovedOutcome` (a deterministic threshold
comparison against `AUTONOMY_LEVEL_THRESHOLDS`, never an LLM judgment call) and is capped by
`ceilingLevel`, which a human sets via `setAutonomyCeiling` — the mechanism behind spec's
"HERO/high-risk/ambiguous content may require human review permanently." The global
`autonomy.shadow_only` feature flag (seeded Phase 0) is the emergency stop: while enabled,
`canActAutonomously` returns `false` regardless of any row's earned `level`.

**Real pipeline wiring, not just a standalone tracker:** `recordQualityGateResult` (Phase 4)
records an approved `EDIT_PLANNING` outcome on a clean first-attempt hard-gate PASS;
`finalizePublishing` (Phase 5) records an approved `PUBLISHING` outcome when every target
platform succeeds with no failures. `apps/worker/src/autonomous-publish-job.ts`'s
`tryAutonomousPublish` is the one real "reduced review" behavior this phase implements: for a
`READY` item whose tier has earned `PUBLISHING` level ≥3, it schedules and publishes with no
human click at all.

**Not built this phase:** no cron/background scheduler invokes `tryAutonomousPublish`
automatically — this system has no async job queue yet (a documented Phase 5 limitation); the
function itself is real and tested, ready for whatever scheduling mechanism eventually exists.
`TAKE_SELECTION`, `EDIT_PLANNING`'s repair-avoidance signal, and `SCHEDULING` don't yet have
their own "reduced review" behavior wired the way `PUBLISHING` does — their `AutonomyLevel`
rows accumulate real data from day one, ready for that wiring once it's prioritized.

## Phase 7 — concrete schema (implemented now, in addition to Phase 0-6's)

| Entity | Purpose | Key fields |
|---|---|---|
| `EvidenceEntry` | Evidence Ledger (spec §7) — every `Belief` must cite at least one by id | `statement, sourceType (EvidenceSourceType), sourceId?, contentItemId?, platform?, confidence, recordedAt` |
| `Belief` | Semantic memory (spec §6 memory type 3) — one table, `status` moving PROPOSED → ACCEPTED/REJECTED is what "promotion" means | `statement, causalClaim?, isExperimentalEvidence, status (BeliefStatus), evidenceIds (json, required non-empty), sampleSize, applicablePlatform?/Topic?/Format?, dateRange?, confidence, confounders (json, required), contradictoryEvidence (json), firstObserved?, lastEvaluated?, retestConditions?, proposedBy, reviewedBy?, reviewedAt?` |
| `TasteFeedback` | Human Taste Model — raw feedback, kept alongside its interpretation | `contentItemId?, artifactType, rawFeedback, normalizedTag, productionTier?` |
| `ChrisAcceptanceProbability` | Derived from `TasteFeedback`, append-only | `artifactType, tag, context (json), probability, sampleSize, generalizes, confidence` |
| `BrandEra` | Brand Timeline — names/boundaries never hardcoded | `name, startDate, endDate? (null = current), description` |
| `Experiment` / `ExperimentVariant` | Experiment engine | `hypothesis, status (ExperimentStatus), confounders (json), minSampleSize, minDurationDays, portfolioMapping?, conclusion?` / `experimentId, contentItemId?, label, description` |
| `WeeklyBrief` | Weekly Review / Learning Council's output, one per week (upserted) | `weekStartDate (unique), whatHappened, whatItMeans, stillUncertain (json), recommendationsForNextWeek (json)` |
| `AdversarialCritique` | Advisory second-opinion output, persisted for provenance | `artifactType, artifactId, contentItemId?, concerns (json), noMaterialWeaknessesFound` |

`Belief.evidenceIds` is enforced non-empty at the schema level (`z.array(z.string()).min(1)`)
and cross-checked against real `EvidenceEntry` rows before a proposal is ever persisted — see
`packages/domain/src/belief.ts`. `acceptBelief` is the only promotion path in the entire
codebase, hardcodes `actorType: "HUMAN"`, and contains no reference to
`BrandConstitutionVersion` or `BrandMemory` at all — verified by a direct regression test.

**Not built this phase:** `ContentRelationship` (Content Graph edges — `derivative_of`,
`remake_of`, etc., spec §6 memory type "Content Graph") remains deferred; no automated job
schedules the Weekly Review / Learning Council or Experiment Agent — both are triggered
on-demand from `/learnings` for now, matching the same "human-triggered before automated"
scoping precedent as Phase 5's Scheduler.

## Phase 6 — concrete schema (implemented now, in addition to Phase 0-5's)

| Entity | Purpose | Key fields |
|---|---|---|
| `PerformanceSnapshot` | Spec §9 step 23 — one row per (ContentItem, platform, offset) | `contentItemId, platform, offset (SnapshotOffset: T_PLUS_1H/6H/24H/72H/7D/30D), capturedAt, viewCount?, likeCount?, commentCount?, shareCount?, saveCount?, reach?, avgWatchTimeSeconds?, rawResponse (json)?` |
| `Comment` | Spec §9 step 24 — real, platform-sourced comments | `contentItemId, platform, platformCommentId, authorHandle?, text, postedAt?, ingestedAt` |
| `AudienceInsight` | Audience Intelligence's output — cross-video by construction, not scoped to one ContentItem | `category, description, supportingCommentCount, exampleQuotes (json), actionableSuggestion?` |
| `PerformanceEvaluation` | Analytics Agent's per-video judgment, append-only | `contentItemId, overallSummary, strategicallyValuableDespiteLowerViews, categories (json)` |

Every metric field on `PerformanceSnapshot` is nullable and stays null when a platform
genuinely doesn't return it — verified per-platform during Phase 6 (see
`/docs/DECISIONS.md`): YouTube's Data API v3 returns no share/save/watch-time metric at all;
TikTok's Display API returns no watch-time/save metric; only Instagram's Reels insights return
average watch time. `(contentItemId, platform, offset)` is unique — capturing the same offset
twice updates the one row (the snapshot job is safe to re-run around a due time), never
duplicates.

**Not built this phase:** no "comment already analyzed" flag — Audience Intelligence
re-analyzes every ingested comment currently in the system each run rather than tracking
per-comment processing state, a reasonable simplification at this system's actual comment
volume (see `/docs/DECISIONS.md`).

## Phase 5 — concrete schema (implemented now, in addition to Phase 0-4's)

| Entity | Purpose | Key fields |
|---|---|---|
| `ScheduleEntry` (extended) | Adds the real per-platform target list the publish job reads | adds `targetPlatforms (json — ContentPlatform[])` |
| `PlatformPackage` | Spec §9 step 20 — one row per (ContentItem, platform), append-only | `contentItemId, platform, caption, title?, hashtags (json), coverFrameSeconds?, metadata (json)?` |
| `Publication` | Spec §9 step 22 — one row per publish *attempt* per (ContentItem, platform), append-only | `contentItemId, platform, platformPackageId, attempt, idempotencyKey, status (PublicationStatus: SUCCESS/FAILED/DRAFT), platformPostId?, url?, mediaHash?, rawResponse (json)?, errorMessage?, publishedAt?, verifiedAt?` |
| `PlatformCredential` | Spec §22 — encrypted token storage, one row per platform | `platform (unique), accountId, encryptedAccessToken, encryptedRefreshToken?, expiresAt?` |

`Publication.status` is never hand-set outside `packages/domain/src/publication.ts`'s
`recordPublicationAttempt` — its `attempt` counter and the `(contentItemId, platform)` pairing
are what let a retried publish job recognize "we already succeeded here" without a separate
idempotency-token table. `DRAFT` (TikTok's audit-gated fallback) is treated as a real success
outcome for the purpose of `PUBLISHING -> PUBLISHED`, not a failure — see /docs/DECISIONS.md.

Encryption for `PlatformCredential` (AES-256-GCM, application-layer, keyed by
`TOKEN_ENCRYPTION_KEY`) lives in `packages/platforms/src/token-crypto.ts` — the schema only
ever sees ciphertext.

**Not built this phase:** no `PlatformCredential` rows are actually written yet — real adapters
(`packages/platforms`) read credentials directly from environment variables for now (a full
OAuth authorization-code + refresh-token flow is a documented future enhancement, not required
for the mock-adapter-tested acceptance criteria — see `.env.example` and `/docs/DECISIONS.md`).
`RenderVariant` (per-platform render variants, distinct from packaging metadata) remains
deferred — Phase 5 packages the single master render differently per platform rather than
re-rendering it.

## Phase 4 — concrete schema (implemented now, in addition to Phase 0-3's)

| Entity | Purpose | Key fields |
|---|---|---|
| `QCReport` | Spec §9 step 16 — one row per Quality Gate run against a `Render`, append-only | `contentItemId, renderId, factualStatus/technicalStatus/brandStatus/creativeStatus/overallStatus (HardGateStatus: PASS/BLOCK), reasons (json), visualQAImpression?` |
| `QCIssue` | Machine-actionable finding, one or more per `QCReport` | `qcReportId, category, description, severity (QCSeverity: INFO/MINOR/MAJOR/BLOCKING), timestampSeconds?, recommendedRepair?, source ("VISUAL_QA" \| "OVERLAY_COLLISION")` |
| `QualityOverride` | The OWNER's explicit decision to send one render to READY without the AI-powered checks (spec §5: owner outranks the gates) — append-only, never a fake QCReport. Added 2026-10-18 (docs/decisions-pending/quality-override.md) | `contentItemId, renderId, trigger ("AI_UNAVAILABLE" \| "OWNER_CHOICE"), aiUnavailableReason?, technicalStatus (always PASS), technicalIssues (json), skippedChecks (json), unverifiedClaims (json), factualConfirmed, decisionJournalEntryId?, actorId` |

`overallStatus` is never hand-set — it's the persisted output of
`packages/domain/src/quality-gate.ts`'s `aggregateHardGates()`, the one function responsible
for combining all four gates (see `/docs/ARCHITECTURE.md`'s Authority hierarchy enforcement
rules, and `/docs/DECISIONS.md` for why BRAND/CREATIVE reuse Brand Guardian's Phase 2 scores
rather than a dedicated agent).

**Not built this phase:** no dedicated auto-repair table — a `QCIssue.recommendedRepair` string
is captured and displayed, but nothing yet automatically applies it; see
`/docs/PHASE_PLAN.md`'s Phase 4 completion record for what a future auto-repair phase would
consume.

## Phase 3 — concrete schema (implemented now, in addition to Phase 0-2's)

| Entity | Purpose | Key fields |
|---|---|---|
| `MediaAsset` (extended) | Adds real ffprobe-derived technical metadata + transcript | adds `durationSeconds?, width?, height?, frameRate?, hasAudio?, videoCodec?, audioCodec?, transcript?`; 2026-10-19 adds `removedAt?, removedReason?` — soft removal of a take ("Delete this clip" / "Replace footage"): files deleted, row kept for TakeSelection/EditPlan/audit history, ignored by every list and edit builder (docs/decisions-pending/replace-footage.md) |
| `TakeSelection` | Spec §9 step 11 — one row per selection decision, append-only | `contentItemId, selectedMediaAssetId, backupMediaAssetId?, confidence, reason, materialDefects (json)` |
| `EditPlan` | Spec §9 step 12 — the LLM's editorial decision, append-only | `contentItemId, takeSelectionId, productionTier, targetDurationSeconds, doNothingElse, plan (json — segments, textOverlays, targetDimensions, normalizeAudio, and the not-yet-executed bRoll/music/sfx/transitions fields; see /docs/DECISIONS.md)` |
| `Render` | Spec §9 step 13 — one row per render attempt (including repair re-renders), append-only | `contentItemId, editPlanId, attempt, status (RenderStatus: SUCCESS/FAILED), storageKey?, durationSeconds?, width?, height?, fileSizeBytes?, technicalQCReport (json)?, errorMessage?` |

`analyzeMediaAsset` (deterministic ffprobe, no LLM) is the canonical `FILMED ->
MEDIA_INGESTED` trigger. `Render.attempt`, scoped per `EditPlan`, is both the render's own
attempt counter and the shared repair-iteration budget Phase 4's Quality Gate BLOCKs also draw
from — see `/docs/DECISIONS.md`.

**Not built this phase:** `RenderVariant` (per-platform render variants — deferred to Phase 5's
platform packaging), `BrandAsset` (approved asset library — B-roll/music/fonts remain
externally supplied for now).

## Phase 2 — concrete schema (implemented now, in addition to Phase 0/1's)

| Entity | Purpose | Key fields |
|---|---|---|
| `ResearchPacket` | Spec §9 step 5 — one row per research attempt, append-only | `contentItemId, primaryClaim, facts (json), citations (json), numericInputs (json), calculationNotes?, caveats (json), confidence, contradictoryEvidence (json), prohibitedClaims (json), contentSafeWording, status, stopResearching, claimsGateResult (json, filled in once evaluated)` |
| `CreativeBrief` | Content Intelligence (2026-10-19) — one append-only row per creative-plan revision; the latest is what downstream bots read | `contentItemId, scriptVersionId?, source ("AGENT" \| "CHATGPT" \| "HUMAN"), series, primaryObjective (COMMENT \| SHARE \| FOLLOW \| PUNCHLINE), hookMechanism?, brief (json: series, targetAudience, coreReaction, hooks[3]{text, mechanism, onScreenText, openingVisual}, chosenHookIndex, hookRationale, story{hook, setup, firstDiscovery, midpointReversal?, payoff, ending}, storyboard, engagement, scorecard, editorial, research — validated by packages/domain creative-brief.ts)`. `ContentItem.series` mirrors the latest brief's series (null for items planned before). |
| `ScriptVersion` | Spec §9 step 7 — one row per script draft, append-only | `contentItemId, researchPacketId?, spokenScript, beats (json), intendedPauses (json), emphasizedWords (json), visualBeats (json), requiredFactualCaveats (json), targetRuntimeSeconds, estimatedSpeakingRuntimeSeconds, followUpIdeas (json), brandGuardianReport (json, filled in once evaluated), scriptClaimsGateResult (json?), authorType ("AGENT" \| "HUMAN" \| "IMPORTED" — pasted from ChatGPT via /plan/scripts, raw block kept in AuditLog SCRIPT_IMPORTED), revisedFromId?, revisionNote?` |

Both tables are append-only (episodic memory, per `/docs/ARCHITECTURE.md`) — the most recent
row per `ContentItem` is "current." `packages/agents` defines the corresponding Zod schemas
independently (`packages/agents/src/schemas.ts`) rather than importing from
`packages/domain` — see `/docs/ARCHITECTURE.md`'s package boundaries (`agents` depends on
`domain`, never the reverse).

| `ReferenceCreator` | Spec §8 — one row per tracked external creator | `name, platforms (json), brandPositioning, knownAudience?, formats (json), storytellingTendencies?, verbalTendencies?, editingTendencies?, visualCharacteristics?, hookArchetypes (json), ctaBehaviors?, contentEvolution?, relevanceToChris?, doNotTransfer?, sourceProvenance?` |
| `ReferenceContent` | Spec §8 — one row per piece of reference content: manually entered notes (no live scraping) and/or an uploaded reference video (private, measured deterministically — docs/decisions-pending/reference-videos.md) | `referenceCreatorId, description, platform?, durationSeconds?, hook?, topic?, publicPerformanceNotes?, sourceUrl?, mediaStorageKey?, mediaFilename?, mediaMimeType?, mediaSizeBytes?, mediaUploadedAt?, mediaDeletedAt?, analysisStatus? (PENDING/DONE/FAILED), analysisError?, analyzedAt?, metrics? (ReferenceVideoMetrics, zod; v3 adds `screen` on-screen text events, `zooms`, `pads`, `rhythm` — reference learning 2026-10-22), metricsVersion?` |
| `ReferenceObservation` | `/prompts/agents/REFERENCE_INTELLIGENCE.md`'s Return shape — one or more per `ReferenceContent` analysis | `referenceContentId, observed, likelyPrinciple, transferabilityToChris, reason, risks (json), testRequired, confidence?` |
| `WatchVerdict` | Watch-back gate (2026-10-22, docs/PREMIUM_EDITOR_PLAN.md round 2) — one row per watch of a render (append-only; `loop` 0 = first watch, 1 = after the one fix loop) | `contentItemId, renderId, editPlanId?, loop, verdict (PASS/FIX/HOLD), checklist (json), fixes (json, ≤ 5 typed ops), audits (json), hookTest (json?), coldViewer, promptVersion, model, inputSummary (json), costUsd?, jobRunId?, createdBy` |
| `WatchRating` | Chris's one-tap label on a watch (👍 posted as-is / 👎 had to change it; or his HOLD choice: Fix it / Post anyway) — what autonomy is earned against (`getSeriesAgreement`) | `watchVerdictId, contentItemId, rating (UP/DOWN), action (POSTED_UNCHANGED/EDITED_FIRST/REJECTED/POST_ANYWAY/FIX_IT/PULLED), note?, createdBy` |
| `WeeklyProgrammingThesis` | Spec §9 step 2 — one per week (`weekStartDate` unique) | `weekStartDate, thesis, primaryObjectives (json), activeExperiments (json), areasToExploit/Explore/Reduce (json), risks (json), contentGaps (json), productionConstraints (json), humanDecisionsNeeded (json)` |
| `WeeklyPortfolioItem` | Spec §9 step 3 — one row per candidate idea evaluated against a thesis | `weeklyThesisId, contentItemId, purpose, pillar?, topic, subtopic?, format, productionTier, targetLengthSeconds?, primaryHypothesis, historicalAnalogue?, referenceInfluence?, whyThisWeek, duplicateRisk?, researchBurden?, productionBurden?, selected` |

Recording a `WeeklyPortfolioItem` with `selected = true` transitions its `ContentItem`
`IDEA -> SELECTED` — the portfolio allocation *is* the selection event (spec §9 step 3),
enforced in `packages/domain/src/weekly-thesis.ts`'s `recordPortfolioItem`.

**Not built this phase:** dedicated `ModelRun`/`AgentRun`/`Job` tables — model calls are
logged via the existing `AuditLog` (actions `RESEARCH_PACKET_RECORDED`,
`SCRIPT_VERSION_RECORDED`, `REFERENCE_OBSERVATIONS_RECORDED`, `WEEKLY_THESIS_RECORDED`)
rather than new tables, consistent with the "no table without a proven need" precedent from
Phase 1. Promote to dedicated tables if audit-log query/analytics needs justify it later.
`StrategicObjective`, `Source`/`Claim`, and embeddings-based semantic similarity storage
remain deferred — see `/docs/DECISIONS.md`'s Phase 2 scoping notes.

## Phase 1 — concrete schema (implemented now, in addition to Phase 0's)

| Entity | Purpose | Key fields |
|---|---|---|
| `ContentItem` (extended) | Now carries display/backlog fields | adds `description, pillar, format` |
| `ProductionContract` | Spec §9 step 4 — issued once, 1:1 with a `ContentItem` | `contentItemId (unique), purpose, primaryIdea, audiencePromise, topic, format, productionTier, targetLengthMinSeconds, targetLengthMaxSeconds, researchDepth, factualRisk, experiment?, platformOpportunities (json), humanEditingBudgetMinutes?, requiredAssets (json), scope, doNotExpandInto` |
| `CreatorCard` | Spec §9 step 7/8 — filming-focused, 1:1 with a `ContentItem` | `contentItemId (unique), hook, talkingPoints (json), setup, estimatedMinutes?, notes?` |
| `MediaAsset` | Spec §9 step 10 — raw upload only in Phase 1 | `contentItemId, kind, storageKey, originalFilename, mimeType, sizeBytes` |
| `ScheduleEntry` | Calendar shell, spec §9 step 19 | `contentItemId (unique), scheduledDate` |

Issuing a `ProductionContract` atomically advances its `ContentItem` `SELECTED -> CONTRACTED`;
issuing a `CreatorCard` atomically advances `SCRIPTED -> READY_TO_FILM` (same DB transaction,
via `writeTransition` — see `/docs/DECISIONS.md` and `packages/domain/src/state-machine.ts`).

**Not built this phase, deferred per `/docs/DECISIONS.md`:** `ContentIdea` (unified into
`ContentItem`'s `IDEA` state) and `Notification` (no concrete consumer yet).

## Phase 0 — concrete schema (implemented now)

| Entity | Purpose | Key fields |
|---|---|---|
| `User` | Single human owner (Chris) | `id, email, passwordHash, name, createdAt` |
| `ContentItem` | Minimal shell the state machine operates on; most fields land in Phase 1 | `id, title, currentState (enum), createdAt, updatedAt` |
| `ContentStateTransition` | Permanent transition history (`/docs/STATE_MACHINE.md`) | `id, contentItemId, fromState, toState, reason, actorType, actorId, createdAt` |
| `AuditLog` | Every audited action, system-wide | `id, actor, actorType, action, entityType, entityId, before (json), after (json), metadata (json), createdAt` |
| `DecisionJournalEntry` | Decision provenance (architectural now; creative/strategic from Phase 1+) | `id, question, selectedDecision, alternatives (json), rationale, evidenceIds (json), confidence, decisionOwner, agentOrModel, userOverride, createdAt, laterOutcome, retrospective` |
| `FeatureFlag` | Gate risky/new behavior | `id, key (unique), enabled, description, updatedAt` |
| `BrandConstitutionVersion` | Versioned snapshots of `/brand/BRAND_CONSTITUTION.md` | `id, version, contentHash, content, createdAt` |
| `BrandMemory` | Versioned snapshots of Chris Brain (and future brand memory kinds) | `id, kind, version, contentHash, content, createdAt` |

## Full entity map (§19) — introduced by phase

### Truth layer
- `BrandConstitutionVersion`, `BrandMemory` — **Phase 0** (above)
- `StrategicObjective` — deferred (not yet needed — the Creative Director agent grounds
  itself in the Brand Constitution + backlog directly for now; see `/docs/DECISIONS.md`)
- `BrandEra` — **Phase 7** (above, Brand Timeline)
- `EvidenceEntry`, `Belief` — **Phase 7** (above, Evidence Ledger / Semantic Memory)
- `TasteFeedback`, `ChrisAcceptanceProbability` — **Phase 7** (above, Human Taste Model)
- `ReferenceCreator`, `ReferenceContent`, `ReferenceObservation` — **Phase 2** (above)
- `BrandAsset` — Phase 3 (Asset Library)
- `PlatformCredential` — **Phase 5** (above) — not individually named in spec §19, but a real
  table implementing §22's "encrypted token storage for platform credentials" requirement

### Intelligence layer
- `ContentIdea` — **deferred** (unified into `ContentItem`'s `IDEA` state; see
  `/docs/DECISIONS.md`)
- `WeeklySlate` — deferred (folded into `WeeklyProgrammingThesis` + `WeeklyPortfolioItem`,
  below — a separate slate object wasn't needed once portfolio items exist per-thesis)
- `WeeklyProgrammingThesis` — **Phase 2** (above)
- `ProductionContract` — **Phase 1** (above)
- `ResearchPacket`, `Source`, `Claim` — Phase 2
- `ScriptVersion` — Phase 2
- `AdversarialCritique` — **Phase 7** (above) — not individually named in spec §19, but the
  real persisted form of the Adversarial Evaluator's advisory output
- `ViewerReview` — **post-Phase-8 (2026-10-17)**, migration `20261017220000_viewer_reviews` —
  the Viewer Panel's advisory first-time-viewer review of one whole video. Append-only (a
  re-run is a new row). Key fields: `subjectKind (RENDER | REFERENCE_VIDEO), contentItemId?,
  renderId?, editPlanId?, referenceContentId?` (exactly what was watched), `mediaStorageKey,
  platform, persona, promptId, promptVersion, model, review (json — ViewerReview zod schema in
  packages/agents viewer-panel-schema.ts), warnings (json), inputSummary (json — frame times +
  reasons, word/cut counts and sources, the pre-call estimate), verdictTier, estimatedCostUsd,
  costUsd?, inputTokens?, outputTokens?, jobRunId?, createdBy`. Never read by the hard-gate
  aggregation. See `docs/decisions-pending/viewer-panel.md`.
- `PlanContext`, `PlanContextVersion` — **post-Phase-8 (2026-10-17)**, migration
  `20261017230000_plan_context` — Chris's ChatGPT planning conversation(s) (export / share
  link / paste). `PlanContext`: `title, source, conversationId?, useForAi, createdBy`.
  `PlanContextVersion` (append-only; a re-import adds a version, the latest is active):
  `version, source, sourceRef?, conversationId?, conversationTitle?, conversationCreatedAt?,
  conversationUpdatedAt?, messages (json — {role, text, at}[]), messageCount, charCount,
  wordCount, contentHash (idempotency), createdBy`. Private; delete purges the text (cascade)
  and keeps the AuditLog (hashes/counts only). Read by `getActivePlanContext`. See
  `docs/decisions-pending/plan-context.md`.
- `PromptDefinition`, `PromptVersion` — **not planned as DB tables** (see
  `/docs/DECISIONS.md` — file-based registry decision); listed here only because §19 names
  them. If a runtime rollback need later justifies a DB-backed registry, add it then.

### Production layer
- `ContentItem`, `ContentRelationship` — `ContentItem` **Phase 0** (shell) / **Phase 1**
  (full fields, above); `ContentRelationship` (Content Graph edges) Phase 2
- `CreatorCard` — **Phase 1** (above)
- `MediaAsset`, `RawTake` — **Phase 1** (upload, above) / **Phase 3** (analysis fields, above —
  no separate `RawTake` table; analysis fields were added to `MediaAsset` directly)
- `TakeSelection` — **Phase 3** (above)
- `EditPlan` — **Phase 3** (above)
- `Render`, `RenderVariant` — **Phase 3** (`Render`, above); `RenderVariant` deferred to Phase 5
- `QCReport`, `QCIssue` — **Phase 4** (above)

### Distribution & Learning layer
- `PlatformPackage` — **Phase 5** (above)
- `ScheduleEntry` — **Phase 1** (calendar shell, above) / **Phase 5** (real scheduling logic, above)
- `Publication` — **Phase 5** (above)
- `PerformanceSnapshot` — **Phase 6** (above)
- `Comment`, `AudienceInsight` — **Phase 6** (above)
- `PerformanceEvaluation` — **Phase 6** (above) — not individually named in spec §19, but the
  real persisted form of §9 step 25's Analytics Agent judgment
- `Experiment`, `ExperimentVariant` — **Phase 7** (above)
- `WeeklyBrief` — **Phase 7** (above)
- `DecisionJournalEntry` — **Phase 0** (above), extended with creative/strategic usage from
  Phase 1+

### Cross-cutting / platform infrastructure
- `User` — **Phase 0** (above)
- `ModelRun` — **built post-Phase-8** as `ModelCallLog` (not Phase 2 as originally planned —
  Phase 2-7 ran entirely on `MockModelProvider`, so there was nothing real to observe until a
  live `ANTHROPIC_API_KEY` existed). One row per real model call — `promptId, modelClass,
  model, inputTokens?, outputTokens?, costUsd?, latencyMs, success, errorMessage?,
  contentItemId?, createdAt`. Written by `packages/agents`' `CostTrackingModelProvider`
  decorator (wraps `AnthropicModelProvider` at the single instantiation point in
  `apps/web/lib/model-provider.ts`), not by individual agents — see `/docs/DECISIONS.md`'s
  cost-logging entry and `/docs/ARCHITECTURE.md` §16. `costUsd` is computed at write time from
  `packages/agents/src/pricing.ts`'s pricing snapshot, so historical rows keep the price that
  was actually in effect, immune to later pricing-table updates.
- `AgentRun`, `Job` — still deferred (no job queue exists; see the worker subpath-exports
  decision in `/docs/DECISIONS.md`)
- `AuditLog` — **Phase 0** (above)
- `Notification` — **deferred** (no concrete consumer yet; introduce when the `NEEDS YOU`
  queue is built — see `/docs/DECISIONS.md`)
- `FeatureFlag` — **Phase 0** (above)
- `AutonomyLevel` — **Phase 8** (above) — not individually named in spec §19, but the real
  persisted form of §23's per-subsystem reliability-threshold tracking
- `OAuthClient`, `OAuthAuthorizationCode`, `OAuthGrant`, `OAuthToken` — **ChatGPT connector
  (2026-10-17)**: the app's own OAuth 2.1 server for the MCP endpoint `/api/mcp`. Codes and
  tokens are stored only as SHA-256 hashes; revocation sets `revokedAt`, rows are never deleted.
  See `docs/decisions-pending/chatgpt-connector.md`.

## Conventions

- IDs: `cuid()` (Prisma default), never auto-increment integers exposed externally.
- Every entity that can meaningfully change over time (Brand Constitution, prompts, scripts,
  edit plans) is versioned by adding new rows, not mutating existing ones — episodic memory is
  permanent by construction.
- JSON columns are used only for genuinely variable-shape data (e.g. `alternatives`,
  `metadata`) — anything with a stable shape gets real typed columns.
- Every table that represents an audited action or decision carries `createdAt`; nothing is
  soft-deleted silently — deletion strategy is defined in `/docs/SECURITY.md`.
