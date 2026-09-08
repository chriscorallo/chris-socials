# Phase Plan

Dependency-ordered. No phase begins until the previous phase's acceptance criteria are green
(tests passing, typecheck/lint clean, docs updated). Each phase's *exact* test names are
authored immediately before that phase starts, not speculatively far in advance — designing
Phase 6's precise fixtures today would be guesswork. This document is updated with a
completion record (date, evidence, known limitations) at the end of every phase.

## Phase 0 — Foundation

**Scope (§25):** repo scaffolding, auth, database + migrations, storage adapter interface,
secrets handling, Brand Constitution, Chris Brain, prompt registry, content state machine,
audit logging, Decision Journal, feature flags.

**Acceptance criteria:**
- pnpm monorepo scaffolded per `/docs/ARCHITECTURE.md`'s repo structure; `pnpm install`
  succeeds from a clean clone.
- Next.js app boots; has a login page and one protected page reading real DB state.
- Prisma schema for the Phase 0 entity subset (`/docs/DATA_MODEL.md`); migration applies
  cleanly from empty; seed script inserts the `User` row and version-1
  `BrandConstitutionVersion`/`BrandMemory` rows from `/brand/*.md`.
- State machine implemented with the full transition table (`/docs/STATE_MACHINE.md`);
  invalid transitions rejected; every transition persisted; idempotent execution.
- Audit log write path exercised by state transitions and feature-flag changes.
- Decision Journal CRUD works; `/docs/DECISIONS.md` seeded with this build's real decisions.
- Feature flags: table + `isEnabled()` helper + one seeded flag.
- Prompt registry: every file under `/prompts/**` has valid frontmatter; loader rejects a
  deliberately malformed fixture and duplicate active `prompt_id`s.
- All docs in `/docs` and `/brand` exist and cross-reference correctly.
- `.env.example`, `.gitignore`, and (for whoever has Docker) `docker-compose.yml` are present.
- **Tests:** see `/docs/EVALUATION_PLAN.md` Phase 0 section — all green.
- **Gate before Phase 1:** tests green, `tsc --noEmit` clean, lint clean.

## Phase 1 — Content OS

**Scope:** Calendar, Content Vault, Ideas, weekly slate, Production Contracts, Creator Cards,
filming queue, raw upload, basic workflow UI.

**Acceptance:** Chris can create an idea, move it through contract → researching (stub) →
ready-to-film states via the UI, upload a raw file against it, and see it on a calendar. This
phase must already be useful on its own, not merely a scaffold.

## Phase 2 — Intelligence

**Scope:** Research, Claims Gate, Script, Brand Guardian, reference library, semantic
similarity, Weekly Programming Thesis, portfolio constraints.

**Acceptance:** a `ResearchPacket → Claims Gate PASS/BLOCK → ScriptPackage` pipeline runs
end-to-end on a fixture topic with real model calls; gold-standard fixtures from
`/docs/EVALUATION_PLAN.md` pass their assigned evals.

## Phase 3 — Media Intelligence & Editing

**Scope:** transcription, media analysis, take selection, Edit Plans, deterministic renderer,
captions, approved assets, basic platform variants.

**Acceptance:** a raw fixture video produces a valid `EditPlan`, renders deterministically via
ffmpeg, and the output passes basic technical QC (dimensions/encoding/loudness).

**Open architectural decision that must be resolved in this phase, not before:** where the
renderer actually executes (Vercel Sandbox vs. a dedicated worker host) — Vercel Functions'
execution-time/payload limits are unsuited to video rendering; `/apps/worker` exists
specifically so this can be decided here without a monorepo restructure.

## Phase 4 — Quality System

**Scope:** visual QA, temporal text/face collision checks, technical QC, factual gate, brand
gate, auto-repair, independent evaluation.

**Acceptance:** injected-defect fixtures (text-over-face, wrong number, caption collision) are
caught and either auto-repaired or correctly `BLOCK`ed; a regression test asserts directly
that a hard-gate `BLOCK` is never averaged away by a high creative score.

## Phase 5 — Distribution

**Scope:** platform adapters, packaging, auto-fill, preflight, publishing, verification,
retries/fallbacks.

**Acceptance:** publishing-mock tests cover success, partial platform failure (the other
platforms still proceed), and idempotent retry of a publish call. TikTok's adapter ships with
its draft-and-manually-publish fallback from day one (see `/docs/DECISIONS.md` — TikTok audit
gate). YouTube's scheduler is quota-aware from day one (see `/docs/DECISIONS.md` — YouTube
quota ceiling).

## Phase 6 — Analytics

**Scope:** metric ingestion, time-series snapshots, normalized metrics, dashboards, comment
ingestion, Audience Intelligence, production ROI.

**Acceptance:** the snapshot job at each defined offset (T+1h…T+30d) records only metrics the
connected platform actually returns — a test asserts absent-metric fields stay `null`, never
defaulted or fabricated.

## Phase 7 — Adaptive Intelligence

**Scope:** Evidence Ledger, Belief system, Experiment engine, Taste Model, Brand Timeline,
reference comparisons, Learning Council, weekly brief.

**Acceptance:** a `BeliefProposal` requires evidence + confidence + confounders before it can
be promoted to `Belief` status; a test asserts the promotion path never writes to
`BrandConstitutionVersion` or `BrandMemory` directly — that write path simply does not exist
for any learning-system role.

## Phase 8 — Autonomy

**Scope:** reliability thresholds, reduced review, trusted content classes, escalation
policies.

**Acceptance:** a content class only reaches autonomy level ≥2 after a configured reliability
threshold of prior human-approved outcomes, evaluated **per subsystem**, never globally —
HERO/high-risk content can remain at level 0/1 indefinitely even after RAW/FAST content earns
higher autonomy.

---

## Completion log

### Phase 0 — Complete (2026-09-07)

**Evidence:**
- `pnpm install` succeeds from clean; pnpm workspace with `/apps/{web,worker}` +
  `/packages/{domain,agents,prompts,media,platforms,analytics,evals}` scaffolded per
  `/docs/ARCHITECTURE.md`.
- `pnpm test` — **26/26 tests passing** across 6 files (state machine, audit log, feature
  flags, decision journal, password auth, prompt registry).
- `pnpm typecheck` — clean across all packages.
- `pnpm lint` — clean.
- Prisma migration (`20260907171013_init`) applies cleanly to an empty database
  (`prisma migrate status` → "Database schema is up to date!"); seed script populates
  `BrandConstitutionVersion` v1, `BrandMemory` (CHRIS_BRAIN) v1, the seeded `User`, and the
  `autonomy.shadow_only` feature flag.
- Manual end-to-end verification via real HTTP requests against `pnpm dev:web`:
  unauthenticated `GET /` → `307` to `/login`; wrong password → `302` to
  `/login?error=CredentialsSignin`; correct password → authenticated session issued,
  `GET /` → `200` rendering live DB state (brand constitution version, feature flags, content
  item count).
- Prompt registry: all 22 files under `/prompts/shared` + `/prompts/agents` load with valid
  frontmatter, exactly one active version per `prompt_id`.
- All planning docs (`/docs/*.md`, `/brand/*.md`, `/prompts/**`, root `CLAUDE.md`) exist and
  cross-reference correctly.

**Known limitations, carried forward rather than blocking:**
- Local dev/test database uses PGlite-over-wire-protocol instead of Docker (environment has
  neither Docker nor Homebrew) — see `/docs/DECISIONS.md`. Functionally equivalent real
  Postgres; `docker-compose.yml` remains the standard path once Docker is available.
- The initial migration was authored via `prisma migrate diff` + `migrate deploy` rather than
  `migrate dev`, because `migrate dev`'s shadow-database step isn't supported by PGlite's
  single-embedded-database engine — see `/docs/DECISIONS.md` for the exact workflow to reuse
  for future migrations in this sandbox.
- **Test isolation:** `pnpm test`'s integration tests run against the same local dev database
  used for manual `pnpm dev:web` verification (no separate test database yet), so running the
  suite leaves behind test-created rows (extra `FeatureFlag`/`ContentItem` rows with
  random-UUID keys). This is cosmetic, not a correctness issue — tests use unique keys and
  never assert on total row counts — but a dedicated test database (or per-test transaction
  rollback) would be a reasonable Phase 1 hygiene improvement rather than a Phase 0 blocker.
- Full HTTP-level auth route testing is manual (documented above), not yet an automated
  integration test — `packages/domain/src/__tests__/auth.test.ts` automates the underlying
  lookup+verify logic the app's `authorize()` callback runs, but not a live Next.js request.
  Worth automating (e.g. via Playwright) once Phase 1 gives the UI enough surface to justify
  the investment.

**Gate check:** all Phase 0 acceptance criteria met. Proceeding to Phase 1 is unblocked.

### Phase 1 — Complete (2026-09-07)

**Evidence:**
- Schema extended (migration `20260907173327_content_os`): `ContentItem` gains
  `description/pillar/format`; new `ProductionContract`, `CreatorCard`, `MediaAsset`,
  `ScheduleEntry` tables — see `/docs/DATA_MODEL.md`.
- Domain modules added: `content-item`, `production-contract`, `creator-card`,
  `media-asset`, `schedule` (all in `packages/domain/src`), plus a `writeTransition` refactor
  of the state machine so "create an artifact + advance state" is one atomic transaction, not
  two separate writes with a failure window between them.
- `packages/media`'s `LocalFsStorageAdapter` implemented (write/read/delete, path-traversal
  rejection, an app-route-based `signedUrl()` approximation — see `/docs/SECURITY.md`).
- UI: Ideas (create + backlog list), Content (list + detail with per-state controls:
  select-for-week, Production Contract form, generic stub-advance buttons, Creator Card form,
  media upload, calendar scheduling, cancel-with-reason, full transition history), Calendar
  (date-grouped schedule list), Analytics/Learnings (honest placeholders — no fake
  functionality ahead of Phase 6/7).
- `pnpm test` — **48/48 tests passing** (22 new: content-item, production-contract,
  creator-card, media-asset, schedule, local-fs-adapter).
- `pnpm typecheck` / `pnpm lint` — clean.
- Manual end-to-end verification over real HTTP (authenticated session): `/ideas`,
  `/content`, `/calendar`, `/analytics`, `/learnings` all render `200`; content-detail pages
  for real items in `IDEA`, `SELECTED`, `CONTRACTED`, `SCRIPTED`, `CANCELLED` states each
  render the correct state-specific controls (contract form only at `SELECTED`, creator-card
  form only at `SCRIPTED`, generic advance only shows the actually-valid next state
  (`RESEARCHING` for `CONTRACTED`, not `CANCELLED`), terminal states show no
  advance/cancel controls).

**Scope decisions (logged in `/docs/DECISIONS.md`):** no separate `ContentIdea` table
(`ContentItem`'s `IDEA` state is the backlog); `Notification` deferred (no consumer yet).

**Known limitations, carried forward rather than blocking:**
- Server Action mutations (create idea, issue contract, issue creator card, upload media, set
  schedule) are verified via the domain-layer test suite (which exercises the exact same
  functions the actions call) plus manual GET-based page verification — not via an automated
  browser click-through. Same limitation as Phase 0's auth flow; Playwright remains a
  reasonable addition once there's enough UI surface to justify the investment.
- Local media serving approximates a signed URL with a plain authenticated route rather than a
  real time-limited signature (see `/docs/SECURITY.md`) — acceptable for a single-user system
  storing nothing high-value yet; revisit when the Vercel Blob adapter lands.

**Gate check:** all Phase 1 acceptance criteria met (create idea → advance through
contract/researching-stub/scripted/ready-to-film → upload raw media → appear on calendar, all
via the UI). Proceeding to Phase 2 is unblocked.

### Phase 2 — Core pipeline complete (2026-09-07); reference/thesis/portfolio deferred

**Scope note:** this pass covers the acceptance-critical spine only — see
`/docs/DECISIONS.md` ("Phase 2 scoped to the core Research -> Script pipeline; rest
deferred"). Reference library + semantic similarity, Weekly Programming Thesis, and portfolio
constraints remain open Phase 2 work.

**Evidence:**
- `packages/agents` built: provider-agnostic `ModelProvider` interface (spec §16 — never
  hardcoded to one vendor), `AnthropicModelProvider` (real, using `client.messages.parse()` +
  Zod structured outputs — needs a real `ANTHROPIC_API_KEY` to actually call out),
  `MockModelProvider` (deterministic, zero-cost, used by every automated test).
- Four agents wired to the real prompt registry (`packages/prompts`) and real Brand
  Constitution/Chris Brain content: Research, Claims Gate, Script, Brand Guardian.
- Orchestration pipeline (`runResearchToScriptPipeline`) enforces the hard-gate rule in code:
  a Claims Gate `BLOCK` stops the pipeline before the Script Agent ever runs — verified
  directly by a regression test asserting `SCRIPT`/`BRAND_GUARDIAN` are never called on a
  `BLOCK` result.
- Persistence (`packages/domain/src/pipeline-run.ts`): `applyPipelineResult` records a
  `ResearchPacket` (and, on success, a `ScriptVersion`) and drives the real state machine —
  `RESEARCHING -> RESEARCHED -> SCRIPTING -> SCRIPTED` on a full pass, or
  `RESEARCHING -> RESEARCH_BLOCKED` on a Claims Gate block, or no transition (stays
  `RESEARCHING`) when research itself is incomplete.
- `pnpm test` — **67/67 tests passing**, entirely against the mock provider (zero API cost).
  Covers: prompt-context wiring, each agent individually, the full pipeline (READY,
  NEEDS_MORE_RESEARCH, UNSUPPORTED, RESEARCH_BLOCKED, PASS_WITH_REQUIRED_EDIT paths), and
  persistence (all four pipeline outcomes against the real DB and state machine).
- `pnpm typecheck` / `pnpm lint` — clean.
- Manual end-to-end HTTP verification (existing pages still render correctly after the schema
  and query changes this phase required).

**Known limitations, carried forward rather than blocking:**
- The real Anthropic provider path itself (an actual network call) is unexercised by
  automated tests, deliberately — no API key exists in this environment, and spending real
  money to "prove" a thin SDK wrapper works is not a good trade against the mock-provider
  coverage already in place. It's ready to use the moment a key is configured.
- Discovered and fixed a real constraint of this sandbox's PGlite dev database: it cannot
  reliably handle concurrently dispatched Prisma queries (`Promise.all`), only sequential
  ones — see `/docs/DECISIONS.md`. Fixed at every call site found in this pass
  (`getContentItem`, `getBrandContextText`, the home page). Any future `Promise.all` over
  multiple Prisma calls in this codebase should be treated with suspicion until a real
  Postgres is in use.

**Gate check:** the acceptance-critical pipeline is built, tested, and ready for real model
calls. Reference library, Weekly Programming Thesis, and portfolio constraints remain before
Phase 2 is fully complete — continue there, or proceed to Phase 3 and return to them later,
per product priority.

### Phase 2 — Complete (2026-09-07)

**Evidence (in addition to the core-pipeline evidence above):**
- Schema: `ReferenceCreator`, `ReferenceContent`, `ReferenceObservation` (spec §8);
  `WeeklyProgrammingThesis`, `WeeklyPortfolioItem` (spec §9 steps 2-3).
- Domain: `reference-creator.ts`, `weekly-thesis.ts` — `recordPortfolioItem` ties portfolio
  allocation directly to the state machine (a `selected: true` allocation transitions
  `IDEA -> SELECTED`, matching spec's "the portfolio allocation *is* the selection event").
- Agents: Reference Intelligence, Creative Director (produces `WeeklyProgrammingThesis`),
  Weekly Strategist (produces per-idea portfolio allocation, validated against the real
  backlog ids the model was given — `PortfolioAllocationInvalidIdsError` if it invents one).
- UI: `/reference` (creator list/create), `/reference/[id]` (add content, run analysis, view
  observations), `/strategy` (generate thesis, generate + apply portfolio allocation). The
  content detail page's `RESEARCHING` state now offers a real "Run AI Research → Script
  pipeline" button alongside the existing manual stub-advance, with a graceful error display
  (e.g. missing `ANTHROPIC_API_KEY`) rather than a crash.
- `pnpm test` — **80/80 tests passing**, still entirely against the mock provider.
- `pnpm typecheck` / `pnpm lint` — clean.
- Manual end-to-end HTTP verification: `/reference`, `/strategy`, and a `RESEARCHING`-state
  content detail page all render correctly with real seeded data (a demo reference creator
  with content and observations); the pipeline-error display path verified directly.

**Real bugs found and fixed in this pass (logged in detail in `/docs/DECISIONS.md`):**
- A recurring `z.infer` vs `z.input` mistake — any exported `CreateXInput` type derived from
  a Zod schema with `.default(...)` must use `z.input`, not `z.infer`, or TypeScript wrongly
  requires fields the schema itself makes optional. Fixed at five call sites.
- Test-suite date collisions against the persistent PGlite dev database — fixed by using
  wall-clock-relative dates in tests instead of fixed literals, and by explicitly cleaning
  global-query test fixtures before asserting on "most recent" semantics.

**Fixed (was a known limitation, addressed same day):** the Weekly Strategist's portfolio
allocation originally applied immediately with no human-review step — a real gap relative to
the spec's `NEEDS YOU` philosophy and authority hierarchy (a Level 3 specialist unilaterally
making a Level 2/human-tier creative decision). Fixed by adding a `PROPOSED`/`APPROVED`/
`REJECTED` review status: `recordPortfolioItem` now only ever proposes, `approvePortfolioItem`
is the sole path that transitions `IDEA -> SELECTED`, and `/strategy` shows a "Needs your
review" queue. See `/docs/DECISIONS.md` for the full rationale and for a verification pass
confirming the other two agent-triggered actions (`runPipeline`, `analyzeContent`) didn't have
the same problem — they don't, because Claims Gate is a spec-sanctioned hard gate (Level 1/2
authority to autonomously PASS/BLOCK), unlike the Strategist's creative/strategic judgment.

**Gate check:** all of Phase 2's original scope (§25) is now built — Research, Claims Gate,
Script, Brand Guardian, reference library, semantic-similarity-adjacent reference matching
(via manual creator/content entry, not automated embeddings — see `/docs/DECISIONS.md` for
why full semantic-similarity infrastructure was deliberately not built), Weekly Programming
Thesis, and portfolio constraints. Proceeding to Phase 3 is unblocked.

### Phase 3 — Complete (2026-09-07)

**Evidence:**
- Schema (migrations `20260907181441_reference_and_weekly_thesis` ->
  `20260907190427_media_intelligence_editing`): `MediaAsset` extended with
  `durationSeconds/width/height/frameRate/hasAudio/videoCodec/audioCodec/transcript`; new
  `TakeSelection`, `EditPlan`, `Render` tables (`Render.status: RenderStatus`,
  `technicalQCReport: Json?`) — see `/docs/DATA_MODEL.md`.
- `packages/media` built from scratch: `ffmpeg-paths.ts` (resolves real static binaries from
  `ffmpeg-static`/`ffprobe-static` — no system install required), `probe.ts` (real ffprobe
  analysis), `render.ts` (deterministic `filter_complex` builder: hard-cut trim/concat,
  center-crop+scale to 1080x1920, `drawtext` overlays with a required explicit `fontPath`,
  single-pass `loudnorm`, H.264/AAC output), `technical-qc.ts` (deterministic dimensions/
  codec/duration/loudness-sanity checks, discriminated-union `PASS`/`FAIL` report).
- Domain: `analyzeMediaAsset` (canonical `FILMED -> MEDIA_INGESTED` trigger),
  `recordTakeSelection` (`MEDIA_INGESTED -> TAKE_SELECTED`), `recordEditPlan`
  (`TAKE_SELECTED -> EDIT_PLANNED`), `startRendering`/`recordRenderAttempt` (the render/QC/
  repair-loop state machine: `EDIT_PLANNED -> EDITING -> RENDERED`, then `RENDERED ->
  QC_REPAIR -> {RENDERED retry | QC_BLOCKED at `MAX_REPAIR_ATTEMPTS = 3`}`, always through
  `QC_REPAIR` — never a direct `RENDERED -> QC_BLOCKED`, per the state table).
- Agents: Take Selector and Edit Planner, both validating model output against real ground
  truth rather than trusting it blindly — `TakeSelectionInvalidIdError` if the model names a
  media asset id that doesn't exist among the real candidates, `EditPlanSegmentOutOfBoundsError`
  if a segment falls outside the known source duration.
- `apps/worker` exposed as an importable `@chris/worker` package (`renderContentItem`) rather
  than a standalone process — the renderer-hosting decision this phase was required to make
  (see `/docs/DECISIONS.md`): ffmpeg execution is synchronous, in-process, called directly by
  `apps/web`'s Server Actions. No job queue exists yet; deliberately deferred until real
  concurrent render load justifies one.
- UI: content detail page gained state-specific controls for `MEDIA_INGESTED` (Take Selector),
  `TAKE_SELECTED` (Edit Planner), and `EDIT_PLANNED`/`EDITING`/`QC_REPAIR` (Render), plus
  display sections for the latest Take Selection, Edit Plan, and Render (with a working "View
  rendered output" link); `/api/media/[...key]` extended to serve `Render` outputs, not just
  `MediaAsset` uploads.
- `pnpm test` — **113/113 tests passing** (33 new this phase), including real integration
  tests against real ffmpeg-generated fixtures (`packages/media`'s render-pipeline tests) and
  a real end-to-end test in `apps/worker` that drives an actual `ContentItem` through
  ingestion -> take selection -> edit planning -> ffmpeg rendering -> technical QC, landing at
  `RENDERED` with a `PASS` report — the literal Phase 3 acceptance criterion, proven with real
  media tooling, not mocks (only the LLM calls are mocked, consistent with every other phase).
- `pnpm typecheck` / `pnpm lint` — clean.
- Manual end-to-end HTTP verification against the live dev server: a full pipeline run (real
  synthetic fixture video, ingested through every Phase 3 stage via the actual Server Actions)
  reaches `RENDERED` with the content detail page correctly showing Take Selection (confidence
  0.92), Edit Plan (tier FAST, target 4s), Render (1080x1920, 4.0s, Technical QC: PASS), the
  full transition history through every Phase 3 state, and a "View rendered output" link that
  was independently fetched via `curl` and confirmed to return a real, valid MP4
  (`ISO Media, MP4 Base Media v1`, 277KB, `Content-Type: video/mp4`) — not a stub or an error
  page.

**Real bugs found and fixed in this pass (logged in detail in `/docs/DECISIONS.md`):**
- ffmpeg's `drawtext` filter silently falls back to fontconfig's default font resolution when
  no `fontPath` is given — on this machine that resolved to a random Japanese system font
  rather than erroring, which would have made text-overlay rendering non-deterministic across
  machines. Fixed by making `fontPath` a required parameter with no implicit fallback.
- ffmpeg's `trim` filter silently *clamps* an out-of-bounds segment instead of erroring —
  found via a test expecting failure that instead got a silently truncated clip. Fixed with a
  pre-flight duration check in `renderVideo()` itself (`RenderSegmentOutOfBoundsError`), as
  defense-in-depth beyond the Edit Planner agent's own bounds validation (an agent could still
  be bypassed by a hand-edited `EditPlan` row, which the test suite exercises directly).
- `render-record.ts` initially attempted the invalid direct transition `RENDERED ->
  QC_BLOCKED` on QC failure — caught immediately by the repair-loop test
  (`InvalidTransitionError`, not a silent bad state). Fixed to always route through
  `QC_REPAIR` first, matching `/docs/STATE_MACHINE.md`'s transition table.
- `renderContentItem` unconditionally called `startRendering` (which only accepts
  `EDIT_PLANNED`) — found while wiring the UI's render-trigger button, reachable from
  `EDIT_PLANNED`, `EDITING` (after a technical failure), and `QC_REPAIR` (a repair retry).
  Fixed to check current state first; added a dedicated test proving the `QC_REPAIR` retry
  path renders successfully without trying to re-enter `EDITING`.
- `/api/media/[...key]` only checked the `MediaAsset` table — found while wiring the new "View
  rendered output" link, which would have 404'd on every render. Fixed to also check `Render`,
  with `Content-Type: video/mp4` hardcoded there since renders don't carry their own
  `mimeType` column (the renderer always encodes to MP4 — see `/docs/DECISIONS.md`).

**Known limitations, carried forward rather than blocking:**
- Technical QC's loudness check is dBFS sanity (via ffmpeg's `volumedetect`), not true
  platform-LUFS-standard compliance measurement — adequate to catch silent/clipping renders,
  not to certify broadcast-loudness compliance. A real LUFS measurement (e.g. via `ebur128`)
  is a reasonable Phase 4 addition alongside the rest of the quality system.
- No `BrandAsset` (approved asset library) exists yet, so overlays use a single hardcoded dev
  font path and there's no B-roll/music/SFX mixing — `EditPlanOutput` already models these
  fields (`bRollRequests`, `musicTrack`, `sfxEvents`, `transitions`) and the renderer gracefully
  ignores what it can't yet execute, but nothing populates or applies them.
- No real transcription provider — `transcription-provider.ts` defines the interface,
  `providers/mock-transcription-provider.ts` is the only implementation. Media analysis
  currently requires a transcript to be supplied manually (or mocked in tests).
- No async job queue — `apps/web` calls `renderContentItem` in-process and synchronously,
  meaning a Server Action request blocks for the full ffmpeg render duration. Fine at
  single-operator scale with short-form clips; would need a real queue before rendering could
  run unattended or handle concurrent requests.
- No automated browser (Playwright) end-to-end testing — verification remains via real HTTP/
  curl requests against the live dev server plus domain- and integration-level tests, the same
  approach used since Phase 0. Still a reasonable future investment, not yet justified.

**Gate check:** the Phase 3 acceptance criterion — "a raw fixture video produces a valid
`EditPlan`, renders deterministically via ffmpeg, output passes basic technical QC" — is met
and independently verified twice: once via `apps/worker`'s automated integration test, and
once via live HTTP against the running application. The required renderer-hosting decision
(§Phase 3 scope) is made and recorded. Proceeding to Phase 4 is unblocked.

**Correction added 2026-09-07 (during Phase 4 work):** the "live HTTP against the running
application" verification above was real, but it verified a `ContentItem` that had been driven
to `RENDERED` by a standalone script calling `renderContentItem`/`probeMedia` directly — not by
an actual Next.js Server Action. It turns out `ffmpeg-static`/`ffprobe-static` broke under
Next's server bundling (`ENOENT` on a synthetic `/ROOT/...` path — see `/docs/DECISIONS.md`,
"Bug found and fixed: ffmpeg-static/ffprobe-static break under Next.js's server bundling"), so
`uploadMedia` and `runRender` — the real Server Actions — were silently broken this entire time
whenever actually clicked in the app. Found and fixed while building Phase 4's Quality Gate
action (the first code path to exercise this through Next's bundler), and re-verified via real
HTTP against a real `next dev` server: a real file upload now produces real ffprobe metadata,
and a real render now produces a real, valid, fetchable MP4. Not rewriting the record above —
leaving it as evidence of what was actually checked at the time, with this note for anyone
reading it later.

### Phase 4 — Complete (2026-09-07)

**Evidence:**
- Schema (migration `20260907195205_quality_gate`): new `QCReport` (one row per Quality Gate
  run — `factualStatus`/`technicalStatus`/`brandStatus`/`creativeStatus`/`overallStatus`, all
  `HardGateStatus` = `PASS`/`BLOCK`, plus `reasons`/`visualQAImpression`) and `QCIssue`
  (severity-typed findings, `source: "VISUAL_QA" | "OVERLAY_COLLISION"`) — see
  `/docs/DATA_MODEL.md`.
- `packages/domain/src/quality-gate.ts`: `aggregateHardGates()` — the exact function
  `/docs/ARCHITECTURE.md` promised since Phase 0 ("the function that aggregates a QCReport ...
  cannot silently average a BLOCK into a passing composite"), pure and deterministic; plus
  `brandGateFromScores`/`creativeGateFromScore`/`technicalGateFromIssues` (threshold helpers)
  and `recordQualityGateResult` (persists the QCReport + issues, drives `RENDERED -> READY` on
  an all-PASS result or `RENDERED -> QC_REPAIR` on any BLOCK, escalating to `QC_BLOCKED` at the
  same `MAX_REPAIR_ATTEMPTS` budget Phase 3's render repair loop already uses — one shared
  counter, not two).
- `packages/media`: `frame-extractor.ts` (deterministic ffmpeg frame sampling — always samples
  t=0 for the spec's "first-frame comprehension" check, reproducible given the same inputs) and
  `overlay-collision.ts` (pure, deterministic same-time-same-position caption/headline overlap
  detection straight off the EditPlan — no model call, per CLAUDE.md's "prefer deterministic
  code over LLM judgment when the check is actually deterministic").
- `packages/agents`: `visual-qa-agent.ts` — the first agent in this system that actually sends
  images to the model (extended `ModelProvider`'s `StructuredCompletionRequest` with an
  optional `images` field, wired through `AnthropicModelProvider`'s real content blocks and
  `MockModelProvider`'s call recording — see `/docs/DECISIONS.md`).
- `apps/worker`: `quality-gate-job.ts` (`runQualityGateForContentItem`, exposed as
  `@chris/worker/quality-gate-job`) — orchestrates the whole gate: reads the persisted
  ClaimsGateResult (FACTUAL) and BrandGuardianReport (BRAND/CREATIVE) from Phase 2, the
  persisted TechnicalQCReport (TECHNICAL) from Phase 3, runs the deterministic overlay-collision
  check, extracts real frames and calls Visual QA, escalates TECHNICAL on any BLOCKING finding,
  and calls `aggregateHardGates`/`recordQualityGateResult`.
- UI: content detail page gained a `RENDERED`-state "Run Quality Gate" control and a QCReport
  display section (per-gate PASS/BLOCK, reasons, Visual QA impression, full issue list with
  severity/timestamp/recommended repair) — wired through `getContentItem`'s existing
  sequential-query pattern (`qcReports`, `latestQCIssues`).
- `pnpm test` — **144/144 tests passing** (31 new this phase), including: the literal Phase 4
  acceptance-criterion regression test (`aggregateHardGates` — a single BLOCK on one gate
  forces an overall BLOCK regardless of how strongly the other three PASS, and multiple
  simultaneous BLOCKs are all surfaced, not collapsed to one); real ffmpeg frame-extraction
  tests (including the ffmpeg-exits-0-with-no-output-file quirk below); deterministic
  overlay-collision tests; a mock-provider Visual QA agent test proving frames are actually
  forwarded as images; and a real end-to-end `apps/worker` integration test that drives an
  actual `ContentItem` through the real Research->Script pipeline persistence, real media
  ingestion, and a real ffmpeg render, then runs the real Quality Gate (only Visual QA mocked)
  across four scenarios — all-clean (PASS -> READY), a BLOCKING Visual QA finding (BLOCK ->
  QC_REPAIR, proving TECHNICAL alone escalates without touching the other three gates), weak
  brand/voice scores (BLOCK -> QC_REPAIR via BRAND alone), and colliding text overlays (BLOCK
  via the deterministic check alone, with a clean Visual QA report).
- `pnpm typecheck` / `pnpm lint` — clean.
- Manual end-to-end HTTP verification against a real `next dev` server (see the correction note
  above Phase 3, and `/docs/DECISIONS.md`'s ffmpeg-static/ffprobe-static entry): the Quality
  Gate action's trigger renders correctly at `RENDERED`, and submitting it gets past frame
  extraction entirely, failing only at the correct, already-documented point (no
  `ANTHROPIC_API_KEY` configured) — proving the deterministic half of the pipeline (probe,
  frame extraction, overlay-collision check, gate persistence, state transition) is genuinely
  reachable through the real running application, not just through tests.

**Real bugs found and fixed in this pass (logged in detail in `/docs/DECISIONS.md`):**
- ffmpeg's frame-extraction seek exits code 0 with no output file when the timestamp is past
  the end of the video (`Output file is empty, nothing was encoded`) — the same silent-success
  class of bug as Phase 3's segment-clamping issue. Fixed with an explicit file-existence/
  non-empty check rather than trusting the exit code.
- `ffmpeg-static`/`ffprobe-static` broke entirely under Next.js's server bundling (`ENOENT` on
  a synthetic path) — a previously-undiscovered gap in Phase 3's own live-UI verification, only
  surfaced because Phase 4's Quality Gate was the first code path to exercise
  `packages/media`'s ffmpeg code through Next's actual bundler rather than a standalone script.
  Fixed via `serverExternalPackages` in `next.config.ts`; re-verified `uploadMedia` and
  `runRender` (not just the new Quality Gate action) all work for real now.
- `claude-haiku-4-5` was missing its dated suffix in the model-routing table (found by
  inspection, not by a failing test — no automated test exercises the real provider's default
  model IDs). Fixed to `claude-haiku-4-5-20251001`.

**Known limitations, carried forward rather than blocking:**
- The real Visual QA vision call is unexercised by automated tests against the real Anthropic
  API, for the same reason as every other agent since Phase 2 — no API key in this environment.
  Its contract is proven against the mock provider; it's ready the moment a key is configured.
- FACTUAL reuses the ClaimsGateResult persisted at RESEARCHING time rather than re-running
  Claims Gate against the final edited transcript — see `/docs/DECISIONS.md` for why, and that
  this is worth revisiting once a real final-render transcription step exists.
- BRAND and CREATIVE are derived from Brand Guardian's existing scores via fixed thresholds
  (70/60) rather than a dedicated agent call under those exact names — a documented, reversible
  mapping decision, not an oversight (see `/docs/DECISIONS.md`).
- Visual QA's issue categories are all visual/technical defects; nothing in this phase lets a
  Visual QA finding escalate the BRAND gate directly (only TECHNICAL), consistent with
  `/docs/AGENT_CONTRACTS.md`'s existing "feeds TECHNICAL/BRAND" language but not yet exercising
  the BRAND half — would need a category genuinely about brand-inappropriate visual content to
  justify that path, and none of Visual QA's current categories are that.
- No auto-repair loop yet (spec's `EDIT -> RENDER -> INSPECT -> FIX -> RENDER -> REINSPECT`) —
  a Quality Gate BLOCK lands the item at `QC_REPAIR` for a human (or a future automated repair
  step) to act on; the repair-iteration *limit* is enforced, but nothing yet automatically
  proposes or applies a fix from a QCIssue's `recommendedRepair` field. That field is captured
  and displayed specifically so a future auto-repair phase has real data to consume.
- No independent evaluation pass distinct from Visual QA itself (spec's "independent
  evaluation" phrase in the Phase 4 scope) — the Adversarial Evaluator role exists in
  `/docs/AGENT_CONTRACTS.md` and has a prompt file, but isn't wired into this pipeline yet.

**Gate check:** the Phase 4 acceptance criteria are met — injected-defect scenarios (a
BLOCKING Visual QA finding, weak brand/voice scores, colliding overlays) are each correctly
caught and routed to `QC_REPAIR`, never silently passed; and the regression test directly
proves a hard-gate BLOCK is never averaged away by strong scores elsewhere. Auto-repair itself
(automatically *fixing* a caught defect, not just catching and routing it) and independent
evaluation via a second agent remain open, documented, non-blocking work. Proceeding to
Phase 5 is unblocked.

### Phase 5 — Complete (2026-09-07)

**Evidence:**
- Schema (migration `20260907203400_distribution`): `ScheduleEntry` extended with
  `targetPlatforms`; new `PlatformPackage`, `Publication` (`PublicationStatus`:
  `SUCCESS`/`FAILED`/`DRAFT`), `PlatformCredential` — see `/docs/DATA_MODEL.md`.
- `packages/platforms` built from scratch: the `PlatformAdapter` interface (spec §21 — "one
  platform's limitation must never leak into the others"); real `InstagramGraphAdapter`
  (Content Publishing API — container create/poll/publish/verify), `YouTubeDataApiAdapter`
  (multipart `videos.insert` upload/verify), `TikTokContentPostingAdapter` (`FILE_UPLOAD`
  init/upload/status flow, with the audit-gated `SELF_ONLY`/`DRAFT` fallback built in from day
  one per the standing decision); `MockPlatformAdapter` for zero-cost tests; `token-crypto.ts`
  (real AES-256-GCM encryption for `PlatformCredential`, spec §22); `youtube-quota.ts`
  (deterministic, DB-derived daily-upload-quota tracking). All three adapters' endpoints and
  quota/audit behavior were verified against current platform docs via live fetch during this
  phase, not recalled from training data — see the quota-correction entry below.
- `packages/domain`: `platform-package.ts` (`recordPlatformPackage`, gated on
  READY/SCHEDULED — packaging requires a completed render), `preflight.ts` (`runPreflight` —
  spec §21's file/hash/credentials/account/packaging/schedule/approval/idempotency-key checks,
  fully deterministic, no model call), `publication.ts` (`startPublishing` /
  `recordPublicationAttempt` / `finalizePublishing` — the append-only, per-platform publish
  record and the `PUBLISHING -> PUBLISHED` decision, decoupled from the many-platforms-one-item
  shape so one platform's outcome never blocks recording another's), and
  `schedule.ts`'s new `scheduleContentItemForPublishing` (the real, state-machine-gated
  `READY -> SCHEDULED`, distinct from Phase 1's still-present ungated calendar utility).
- `packages/agents`: Platform Packaging (the first agent whose prompt is a real two-file
  composition — `PLATFORM_PACKAGING_BASE` + one of `_INSTAGRAM`/`_TIKTOK`/`_YOUTUBE`, built by
  `platform-packaging-agent.ts` since `buildSystemPrompt` only handles one named prompt) and
  Scheduler (`scheduler-agent.ts` — proposes placements across READY items, validated against
  the real backlog it was given, same `InvalidId`-error pattern as Take Selector/Weekly
  Strategist).
- `apps/worker`: `publish-job.ts`'s `publishContentItem`, exposed as
  `@chris/worker/publish-job` — orchestrates Preflight + Publish + Verify across every
  scheduled target platform per ContentItem: idempotency check first (an already-succeeded
  platform is never re-called), YouTube's quota gate checked before ever touching the network,
  preflight per platform, then the adapter call — every platform in its own try/catch so an
  exception on one never stops the loop over the others, and every outcome (including a thrown
  exception) is persisted, never silently dropped.
- UI: content detail page gained Platform Packaging controls (READY/SCHEDULED), a real gated
  Schedule form (platform checkboxes, drives `READY -> SCHEDULED`), Publish/Retry-publish
  controls (SCHEDULED/PUBLISHING), and display sections for recorded packages and publications
  (status color-coded, error messages shown in place).
- `pnpm test` — **180/180 tests passing** (36 new this phase), including: the two literal
  acceptance-criterion tests (`publish-job.test.ts` — one platform failing never blocks the
  others and the item still reaches `PUBLISHED`; a retried publish call never re-invokes an
  already-succeeded platform's adapter, while a previously-*failed* platform genuinely is
  retried); a TikTok `DRAFT`-outcome test (counts as reaching `PUBLISHED`, not a failure); a
  real end-to-end YouTube-quota-exhaustion test (the adapter is never even called once the
  daily budget is gone); domain-level preflight tests (each of file/packaging/schedule/
  credentials missing produces its own specific BLOCK reason); and mock-provider tests for
  both new agents.
- `pnpm typecheck` / `pnpm lint` — clean.
- Manual end-to-end HTTP verification against a real `next dev` server (lesson applied
  directly from Phase 4's correction — tested through the actual bundled app, not a script): a
  real `READY` item (with a script-seeded `PlatformPackage`, since packaging itself needs a
  model call and no key is configured) was scheduled via the real form
  (`READY -> SCHEDULED`), then published via the real form — preflight correctly detected the
  unconfigured Instagram credentials, recorded a graceful `FAILED` Publication with a specific
  reason (no crash), left the item at `PUBLISHING` (no platform succeeded, so no silent
  `PUBLISHED`), and a second real "Retry publish" click correctly re-attempted (attempt 2,
  same graceful outcome) rather than silently no-op'ing — proving the idempotency rule
  ("protects successes, not failures") end-to-end through the real app, not just in tests.

**Real bugs found and fixed in this pass (logged in detail in `/docs/DECISIONS.md`):**
- The original plan's YouTube quota figure (1,600 units/day-shared-budget, carried over
  uninspected since 2026-09-05) was wrong — verified against Google's current quota-cost docs
  during this phase: `videos.insert` has its own dedicated 100-calls/day bucket at 1 unit each,
  materially more headroom than previously assumed. Corrected in `/docs/DECISIONS.md` with the
  live-fetched source; the "file an early quota increase request" urgency no longer applies,
  though the system stays quota-aware regardless (a bigger limit is still a limit).
- `getYouTubeQuotaState`'s date-range query had no upper bound (`gte` only) — a synthetic
  future-dated test row leaked into every subsequent *real*-time quota check, caught
  immediately by a real integration test (a YouTube publish that should have succeeded came
  back skipped). Fixed with the missing `lt: startOfNextUtcDay` bound.
- A test-only bug in the fix above's own test file: a monotonic `RUN_BASE_MS` timestamp alone
  doesn't prevent same-*day* collisions when tests re-run repeatedly within a shorter real
  window than the day-level bucket the code under test actually groups by — fixed with
  explicit cleanup, the other half of this repo's established test-date-collision pattern.
- A `Buffer`-vs-DOM-lib `BodyInit`/`BlobPart` typing mismatch (Buffer's backing type admits
  `SharedArrayBuffer`, which current DOM lib types reject) surfaced only transitively through
  apps/web's stricter tsconfig, not through packages/platforms' own — fixed by wrapping a
  `Uint8Array.from(...)` copy in a `Blob` for both the YouTube and TikTok upload bodies.

**Known limitations, carried forward rather than blocking:**
- No OAuth authorization-code + refresh-token flow — adapters read long-lived access tokens
  directly from environment variables; `PlatformCredential`'s encrypted-storage schema and
  `token-crypto.ts` exist and are tested, but no row is actually written by any code path yet.
  A real token-refresh flow is a reasonable next investment once real platform apps exist.
- Instagram's adapter needs a real public signed video URL (`publicVideoUrl`) — this system's
  storage adapter only provides an authenticated route (Phase 1's signed-URL approximation),
  not a true public-but-unguessable URL, so a real Instagram publish would fail at that step
  today. Documented rather than worked around; the real fix is the Vercel Blob signed-URL
  adapter already flagged as future work in `/docs/SECURITY.md`.
- None of the three real adapters have been exercised against a real platform account — same
  category of limitation as every other real external integration in this system
  (`AnthropicModelProvider` included): built correct to current, live-verified API docs, ready
  the moment real credentials exist, never actually called for real in this environment.
- ~~The Scheduler agent (real "auto-fill the week" judgment) is built and tested but not wired
  into a dedicated UI page yet~~ — **closed, post-Phase-8**: the real Calendar rebuild wired
  `runSchedulerAgent` into an "Auto-Fill Week" button (`apps/web/app/calendar/actions.ts`),
  gathering the real unscheduled-READY pool, scheduling history, and YouTube quota state, and
  persisting every proposal through the same gated `scheduleContentItemForPublishing` a manual
  placement uses. See `/docs/DECISIONS.md`'s Calendar-rebuild entry.
- Platform Packaging uses the selected take's raw transcript as the "final transcript" input
  rather than re-transcribing the actual rendered/trimmed output — carried forward from
  Phase 3's no-real-transcription-provider limitation, not new to this phase.
- No metric-driven publish-time optimization (best-time-to-post evidence) — Scheduler's prompt
  already asks for "platform posting-time patterns" as one consideration, but there's no real
  performance data yet for it to draw on (that's Phase 6).

**Gate check:** the Phase 5 acceptance criteria are met — publishing-mock tests cover success,
partial platform failure (the other platforms genuinely still proceed), and idempotent retry
(proven both in tests and via live HTTP against the real app); TikTok's adapter ships with its
draft-and-manually-publish fallback from day one; YouTube's publish path is quota-aware from
day one (with corrected, live-verified quota numbers). Proceeding to Phase 6 is unblocked.

### Phase 6 — Complete (2026-09-07)

**Evidence:**
- Schema (migrations `20260907231352_analytics` and `20260907232948_performance_evaluation`):
  new `PerformanceSnapshot` (`SnapshotOffset` enum: `T_PLUS_1H/6H/24H/72H/7D/30D`, unique per
  `(contentItemId, platform, offset)`), `Comment` (unique per
  `(contentItemId, platform, platformCommentId)`), `AudienceInsight` (cross-video, not scoped
  to one item), `PerformanceEvaluation` — see `/docs/DATA_MODEL.md`.
- `packages/platforms`: extended `PlatformAdapter` with `getMetrics`/`listComments`, real per
  the platform's actual, live-verified API — Instagram's `/{media-id}/insights`
  (`views`/`likes`/`comments`/`shares`/`saved`/`reach`/`ig_reels_avg_watch_time` — the only one
  of the three with a real watch-time metric), YouTube's `videos.list?part=statistics`
  (view/like/comment counts only — confirmed the Data API v3 has no share/save/watch-time
  field at all), TikTok's `/v2/video/query/` (view/like/comment/share counts, no watch-time/
  saves) for metrics, and Instagram/YouTube's real comment-listing endpoints for comments —
  TikTok's `listComments` honestly returns empty, because comment access at this app's tier
  doesn't exist (it lives behind TikTok's separate, researcher-eligibility-gated Research API,
  confirmed via live search, not assumed).
- `packages/domain`: `performance-snapshot.ts` (`getDueSnapshotOffsets` — the pure,
  deterministic function the Phase 6 acceptance criterion is literally about;
  `recordPerformanceSnapshot`, idempotent per offset; `startMeasuring`/
  `archiveIfMeasurementWindowClosed` driving `PUBLISHED -> MEASURING -> ARCHIVED`),
  `comment.ts` (`ingestComments`, idempotent per platform comment id), `audience-insight.ts`,
  `performance-evaluation.ts`.
- `packages/agents`: Analytics Agent (evaluates real captured snapshots across all eight
  spec-named categories, with real production-cost context for `PRODUCTION_ROI`; formats every
  absent metric as "not available from this platform" in what the model actually reads, never
  as zero) and Audience Intelligence (classifies real comments into recurring patterns, with a
  defense-in-depth check rejecting any "insight" backed by only one comment — the prompt's own
  stated policy, enforced in code, not just trusted).
- `apps/worker`: `snapshot-job.ts`'s `captureDueSnapshots` (real per-platform metric fetch,
  one platform's failure never stopping the others, drives the two state transitions) and
  `comment-ingestion-job.ts`'s `ingestCommentsForContentItem` (same graceful-failure shape).
- UI: content detail page gained an Analytics block (`PUBLISHED`/`MEASURING` states) — capture
  snapshots, ingest comments, run performance evaluation — plus display sections for the
  snapshot table (absent metrics rendered as `—`, never `0`), the latest performance
  evaluation, and ingested comments. The `/analytics` page is now a real dashboard (published
  items + snapshot counts) plus a cross-video Audience Intelligence trigger and insight list,
  replacing the Phase 1 placeholder.
- `pnpm test` — **215/215 tests passing** (35 new this phase), including: the literal
  acceptance-criterion tests for `getDueSnapshotOffsets` (nothing due at publish time, exactly
  the right offset(s) due at each boundary, already-captured offsets excluded, nothing due one
  second before a boundary); a real end-to-end worker test proving captured snapshots leave
  absent platform fields `null` (not defaulted); one platform's metrics-fetch or comment-fetch
  failure never stopping the others; and the `archiveIfMeasurementWindowClosed` test proving a
  `FAILED` publication's platform doesn't gate archiving (only ones that actually published
  do).
- `pnpm typecheck` / `pnpm lint` — clean.
- Manual end-to-end HTTP verification against a real `next dev` server (per Phase 4/5's
  established lesson — tested through the actual bundled app, not a script): a real seeded
  `PUBLISHED` item's "Capture due snapshots" button, clicked for real, correctly transitioned
  `PUBLISHED -> MEASURING` and recorded a real `T+1h` `PerformanceSnapshot` for YouTube with
  every metric field genuinely null (no credentials configured) — rendered on the page as `—`,
  not `0`; "Ingest comments" and the `/analytics` page's "Run Audience Intelligence" both
  degraded gracefully (empty results / a clear missing-API-key error) rather than crashing;
  the `/analytics` dashboard correctly listed the item with its real snapshot count.

**Real bugs found and fixed in this pass (logged in detail in `/docs/DECISIONS.md`):**
- Two test files built a synthetic future date as "real now + N days," preserving real now's
  time-of-day — when real now happened to fall late in the UTC day, a same-day "+1 hour" check
  used by both tests rolled into the *next* UTC day, landing outside the day-bucket the test's
  own fixture rows and the quota query both lived in. Fixed by snapping both files' synthetic
  dates to a fixed noon UTC instead of preserving real now's time-of-day — verified stable
  across repeated runs.
- Relatedly, two of `publish-job.test.ts`'s orchestration tests included YOUTUBE with no
  synthetic date override at all, so they read real wall-clock "today" — after this session's
  many repeated `pnpm test` runs, real "today"'s simulated 100-upload budget was genuinely
  exhausted (1517 real rows), breaking both tests deterministically. Fixed by moving the
  general "multiple platforms" tests off YOUTUBE entirely (they don't need that specific
  platform) and adding the same cleanup-before-insert pattern to the file's own synthetic-day
  quota-exhaustion fixture, which had the same fixed-calendar-day accumulation problem as
  `youtube-quota.test.ts` originally did. Verified by running the file three times in
  immediate succession.

**Known limitations, carried forward rather than blocking:**
- TikTok has no comment-listing access at this app's API tier at all (Research-API-only,
  researcher-eligibility-gated) — a real, platform-level ceiling, not a bug; Audience
  Intelligence for TikTok content depends entirely on whatever Instagram/YouTube comments exist
  for the same content.
- The TikTok metrics/comments methods assume `platformPostId` is already the resolved real
  `video_id`, but TikTok's publish flow only returns the transient `publish_id` synchronously —
  resolving the real video id needs a follow-up status-fetch read `verify()` doesn't currently
  surface. Documented, not fixed, since it's unexercised without real TikTok credentials
  anyway (same category as every other real-adapter limitation in this system).
- No "already analyzed" tracking for Audience Intelligence — every run re-classifies every
  ingested comment currently in the system rather than only the new ones since the last run: a
  reasonable simplification at this system's real comment volume, revisit if volume grows.
- YouTube Analytics API (the separate, more heavily-scoped API that actually returns watch-time
  data) isn't integrated — `avgWatchTimeSeconds` genuinely stays null for YouTube content by
  design this phase, not as a gap to silently paper over.
- None of the three real adapters' metrics/comments methods have been exercised against a real
  platform account — same category of limitation as every other real external integration in
  this system, built correct to current, live-verified API docs, ready the moment real
  credentials exist.

**Gate check:** the Phase 6 acceptance criterion is met and independently verified twice: once
via `apps/worker`'s automated integration tests, and once via live HTTP against the running
application — captured snapshots record only what a platform actually returns, with every
absent metric staying genuinely `null`, never defaulted or fabricated. Proceeding to Phase 7 is
unblocked.

### Phase 7 — Complete (2026-09-07)

**Evidence:**
- Schema (migration `20260907234835_adaptive_intelligence`): `EvidenceEntry`, `Belief`
  (`BeliefStatus`: PROPOSED/ACCEPTED/REJECTED/RETIRED — one table, not two, matching the
  `WeeklyPortfolioItem` PROPOSED/APPROVED/REJECTED pattern already established), `TasteFeedback`,
  `ChrisAcceptanceProbability`, `BrandEra`, `Experiment`/`ExperimentVariant`, `WeeklyBrief`,
  `AdversarialCritique` — see `/docs/DATA_MODEL.md`.
- `packages/domain`: `belief.ts` is the literal enforcement point for this phase's acceptance
  criterion — `proposeBelief` requires evidence (schema-level `.min(1)`, plus a real-id
  cross-check against the Evidence Ledger, the same "validate against real candidates" pattern
  as Take Selector), confidence, and confounders (all three non-optional fields); `acceptBelief`
  is the *only* promotion path anywhere in the codebase, hardcodes `actorType: "HUMAN"` (not a
  parameter a caller could set to SYSTEM), and contains no reference at all to
  `BrandConstitutionVersion` or `BrandMemory`. Also: `evidence.ts`, `taste.ts` (raw feedback
  kept alongside its interpretation, per TASTE_LEARNER.md), `brand-era.ts` (closes the prior
  era automatically, rejects non-chronological eras), `experiment.ts` (real
  PROPOSED→RUNNING→CONCLUDED/INCONCLUSIVE lifecycle — INCONCLUSIVE is a first-class, honest
  outcome, not a failure), `weekly-brief.ts`, `adversarial-critique.ts`.
- `packages/agents`: Learning Agent (proposes only — cites evidence by restating its
  statement text, never by inventing an id, so the caller's resolution step can only ever
  reference real Evidence Ledger rows), Adversarial Evaluator (advisory, allows a genuine "no
  material weaknesses found" rather than manufacturing nitpicks), Taste Learner, Experiment
  Agent, and Weekly Review / Learning Council (produces both a `WeeklyBrief` and candidate
  `BeliefProposal`s in one call, per spec).
- UI: `/learnings` (replacing the Phase 1 placeholder) — Evidence Ledger browse + manual entry,
  Beliefs with a real "needs your review" queue and Accept/Reject actions (never
  auto-accepted), Experiments (manual create + Run Experiment Agent + start/conclude),
  Brand Timeline, Weekly Brief trigger + display, Taste Model summary. Content detail page
  gained a Taste Feedback + Adversarial Evaluator block (any non-terminal state) — raw
  feedback recorded in Chris's own words alongside a short tag, and an on-demand second
  opinion on the current script.
- `pnpm test` — **243/243 tests passing** (28 new this phase), including: the literal
  acceptance-criterion tests (`proposeBelief` rejects zero evidence and invented evidence ids;
  `acceptBelief` only promotes from PROPOSED; and the direct regression test proving
  acceptance never touches `BrandConstitutionVersion`/`BrandMemory` — checked both
  behaviorally, via real row counts before/after, and structurally, by asserting `belief.ts`'s
  own source contains no Prisma call against either table); `BrandEra` closing the prior era
  and rejecting non-chronological starts; the full `Experiment` lifecycle including the
  already-concluded guard; mock-provider tests for all five new agents.
- `pnpm typecheck` / `pnpm lint` — clean.
- Manual end-to-end HTTP verification against a real `next dev` server: real manual evidence
  recorded via the `/learnings` form: appeared in the ledger; "Run Learning Agent" correctly
  degraded gracefully (missing API key); a real Taste Feedback entry recorded from a content
  item's own page and displayed back; "Run Adversarial Evaluator" correctly short-circuited
  with a clear, specific error (no script exists yet for that item) before ever reaching the
  model call — proving the precondition check fires before spending anything.

**Real bugs found and fixed in this pass (logged in detail in `/docs/DECISIONS.md`):**
- A false-positive in the belief-promotion regression test itself: checking for the bare
  strings `"brandConstitutionVersion"`/`"brandMemory"` anywhere in `belief.ts` matched the
  file's own doc comments *explaining* why it never touches either table. Fixed to match the
  actual Prisma call pattern (`.brandMemory.`) instead of a bare mention.
- Two further instances of the test-date-collision class already seen in Phases 5-6: fixed
  literal `BrandEra` dates collided with a previous run's leftover "current era" in the
  persistent dev DB (the first genuinely global, non-per-fresh-item table this repo has
  tested); switching to `Date.now()`-based dates helped but wasn't fully sufficient either,
  since two real invocations seconds apart could still see `Date.now()` "go backwards"
  relative to a previous run's synthetic-future date. Fixed by reading the real current era
  from the database first and building every synthetic test date forward from *that*, not
  from the clock — verified stable across four rapid repeated runs.

**Known limitations, carried forward rather than blocking:**
- No automated job schedules the Weekly Review / Learning Council or the Experiment Agent —
  both are triggered on-demand from `/learnings`, the same "human-triggered before automated"
  scoping already used for Phase 5's Scheduler.
- `ContentRelationship` (the Content Graph memory type — `derivative_of`, `remake_of`, etc.)
  remains deferred; nothing in this phase's build required it yet.
- The Taste Learner and Weekly Review agents are built and tested (mock provider) but not yet
  wired into their own dedicated "run against real accumulated feedback" trigger on
  `/learnings` — Taste Learner's real invocation path is a reasonable near-term addition once
  enough real `TasteFeedback` rows exist to make its "don't over-generalize from one instance"
  guidance meaningful to see in practice.
- `AdversarialCritique` and `Belief` are both real, tested, persisted — but neither is wired
  into any *automatic* gate (correctly, per spec: both are advisory/human-reviewed, never a
  hard gate on their own).

**Gate check:** the Phase 7 acceptance criterion is met — a `BeliefProposal` requires evidence,
confidence, and confounders before promotion, enforced at both the schema and cross-reference
level, and the promotion path is proven (behaviorally and structurally) to never write to
`BrandConstitutionVersion` or `BrandMemory`. This completes Phases 0-7 — the system is now
wired end-to-end from idea through production, publication, measurement, and learning. Only
Phase 8 (Autonomy) remains.

### Phase 8 — Complete (2026-09-08)

**Evidence:**
- Schema (migration `20260908003806_autonomy`): `AutonomyLevel` — one row per
  (`AutonomySubsystem`, `ProductionTier`), `level` 0-4, `approvedOutcomeCount`, a human-settable
  `ceilingLevel` (default 4) — see `/docs/DATA_MODEL.md`.
- `packages/domain/src/autonomy.ts`: `AUTONOMY_LEVEL_THRESHOLDS` (deterministic escalation —
  no LLM judgment involved, per CLAUDE.md), `recordApprovedOutcome` (escalates via a `while`
  loop so a count crossing more than one threshold at once still lands correctly, gated by
  `ceilingLevel`), `setAutonomyCeiling` (human-only; lowering a ceiling below the current level
  clamps it immediately, not just going forward — the real mechanism behind spec's "HERO/
  high-risk content may require human review permanently"), `canActAutonomously` (folds in the
  global `autonomy.shadow_only` kill switch seeded back in Phase 0, so no caller can forget to
  check it).
- **Real pipeline wiring**, not just a standalone tracker: `recordQualityGateResult` (Phase 4)
  now records an approved `EDIT_PLANNING` outcome on a clean first-render-attempt hard-gate
  PASS; `finalizePublishing` (Phase 5) records an approved `PUBLISHING` outcome when every
  target platform succeeds with zero failures. Both deliberately use a stricter bar than "any
  success" — a QC-repaired pass or a partial-failure publish is a real success but a weaker
  reliability signal, so neither counts.
- `apps/worker/src/autonomous-publish-job.ts`'s `tryAutonomousPublish` — the one concrete
  "reduced review" behavior this phase implements end-to-end (spec §23 Level 3: "approved
  content classes may auto-schedule/publish"): for a `READY` item whose tier has genuinely
  earned `PUBLISHING` level ≥3, it schedules and publishes with no human click at all. A
  graceful no-op with a specific, visible reason when not eligible — never a silent failure or
  a crash.
- UI: `/learnings` gained an Autonomy section — a live (subsystem × tier) grid showing real
  level/count/ceiling per pair, a ceiling-setting form per row, and the global shadow-only
  emergency-stop toggle. The content detail page's `READY` state gained a "Try autonomous
  publish" trigger alongside the existing manual Schedule/Publish controls.
- `pnpm test` — **263/263 tests passing** (20 new this phase), including: the literal
  acceptance-criterion tests (escalation only at the configured threshold, multi-level jumps
  land correctly, and — the literal spec example — HERO staying at level 0 while RAW/FAST on
  the same subsystem advances); `setAutonomyCeiling`'s permanent-cap and immediate-clamp
  behavior; the global kill switch overriding a genuinely earned level; two new tests proving
  the *real* pipeline wiring (a real `recordQualityGateResult`/`finalizePublishing` call
  actually increments the right `AutonomyLevel` row, and a partial-failure publish does not);
  and a full `apps/worker` integration suite for `tryAutonomousPublish` (ineligible → no-op,
  eligible → genuinely autonomous `READY → PUBLISHED` with zero manual clicks, HERO's ceiling
  holding even with earned outcomes, the kill switch blocking a fully-earned level, and a
  graceful no-op when no `PlatformPackage` exists yet).
- `pnpm typecheck` / `pnpm lint` — clean.
- Manual end-to-end HTTP verification against a real `next dev` server: seeded a real `READY`
  item at tier FAST with `PUBLISHING` autonomy genuinely earned to level 3, confirmed
  `/learnings`' grid displayed it correctly (RAW/FAST/MEDIUM showing real earned levels, HERO
  still at 0 — the acceptance criterion, visible live), clicked "Try autonomous publish" once,
  and confirmed via the transition history that the item moved `READY → SCHEDULED →
  PUBLISHING` — both transitions timestamped one second after the single click, with the
  Instagram publish attempt itself failing gracefully on the expected missing-credentials
  error (same category as every other real-adapter limitation in this system) — proving the
  *autonomous* half of the mechanism genuinely fired without ever touching the manual
  Schedule/Publish forms. Also verified the shadow-only emergency-stop toggle and the
  ceiling-setting form both take effect for real, live, via actual form submissions.

**Real bugs found and fixed in this pass (logged in detail in `/docs/DECISIONS.md`):**
- `tryAutonomousPublishAction`'s first draft called `redirect()` from inside its own `try`
  block on the success path — since Next.js's `redirect()` works by throwing, that call would
  have been caught by the function's own `catch` block instead of actually navigating. Caught
  by inspection while writing the action, before it ever shipped or needed a bug report — the
  same class of gotcha this codebase has consistently avoided elsewhere, restructured to
  capture the outcome first and redirect exactly once, after the try/catch is fully resolved.
- `AutonomyLevel` is a global row per (subsystem, tier) — the same class of test-collision bug
  as `BrandEra` (Phase 7), but with no date field to build a "safely future" value from at all,
  since escalation is driven by a call count over a small, closed enum space (5 × 4 pairs).
  Fixed with direct `deleteMany` cleanup before each test that depends on a known starting
  count — the only real fix once neither a fresh id nor a synthetic date can create isolation.

**Known limitations, carried forward rather than blocking:**
- No cron/background scheduler invokes `tryAutonomousPublish` automatically — this system has
  no async job queue yet (documented since Phase 5); the function is real and tested, ready
  for whatever scheduling mechanism eventually exists, the same "real but human-triggered"
  pattern already established for the Scheduler/Experiment/Weekly-Review agents.
- Only `PUBLISHING` has a concrete "reduced review" behavior wired end-to-end.
  `TAKE_SELECTION`, `EDIT_PLANNING`, `QUALITY_GATE`, and `SCHEDULING` all accumulate real
  `AutonomyLevel` data from day one (via the same pipeline-wiring pattern) but don't yet skip
  their own manual trigger click at higher levels — a reasonable next increment once
  `PUBLISHING`'s pattern has proven out in real use.
- Autonomy thresholds (`AUTONOMY_LEVEL_THRESHOLDS`) are fixed constants, not per-deployment
  configurable yet — reasonable given this is a single-operator system where Chris IS the
  configuration authority via the ceiling controls, but worth revisiting if the thresholds
  ever need to differ by more than the ceiling mechanism already allows.

**Gate check:** the Phase 8 acceptance criterion is met and verified at every level — unit
(pure threshold math), integration (real pipeline wiring), worker orchestration (the full
autonomous publish chain), and live HTTP against the running application: a content class only
reaches autonomy level ≥2 after a configured reliability threshold of prior human-approved
outcomes, evaluated per subsystem, never globally, and HERO/high-risk content can remain at
level 0/1 indefinitely — by default policy, and permanently if a human sets its ceiling there
— even after RAW/FAST content on the same subsystem earns higher autonomy. This completes
Phases 0-8, the entire spec-defined phase plan.
