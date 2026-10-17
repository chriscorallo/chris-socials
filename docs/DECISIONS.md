# Decisions

Every material architectural decision, in the order it was made. Entry format: **Date —
Decision.** Alternatives considered. Rationale. Reversibility. This file is maintained by
every session, per root `CLAUDE.md` — it is how a future Claude Code session (or Chris)
understands *why*, not just *what*.

---

## 2026-09-05 — Compact spec file is the authoritative source of truth

**Decision:** `Chris_Content_Intelligence_Compact_Master_Spec.md` (repo root) is canonical.
The earlier long-form pasted specification is used only as supplementary detail for prompt
*wording* (Parts II–XV) where it doesn't contradict the compact spec.

**Alternatives considered:** ask Chris to paste the missing tail of the long-form spec and
reconcile both in full.

**Rationale:** the long-form paste was cut off mid-sentence in Part XVI. Chris then provided
the compact file — read in full (728 lines), it is self-consistent, complete, and covers every
section the long-form spec covers, just condensed. Treating it as canonical resolves the
truncation problem without waiting on a reconciliation pass across two overlapping documents.

**Reversibility:** high — if a genuine conflict surfaces later between the two documents, it
gets logged here and resolved case-by-case; nothing was deleted.

---

## 2026-09-05 — Implementation stack: Next.js + TypeScript + Postgres on Vercel

**Decision:** Next.js (App Router, TypeScript strict), PostgreSQL via Prisma, deployed to
Vercel.

**Alternatives considered:** plain Node/TS service (framework-agnostic, more portable, more
to wire up manually — auth, routing, hosting).

**Rationale:** the spec deliberately avoids naming a stack (only demands provider
abstractions, typed schemas, deterministic media tooling). This environment already has
Vercel tooling loaded, and Next.js/Vercel is the path of least setup friction for a
single-operator product that still needs real hosting, auth, and a database. Confirmed
directly with Chris via question before Phase 0 began.

**Reversibility:** moderate — the domain/state-machine/prompt logic lives in framework-agnostic
packages (`packages/domain`, etc.) specifically so the web framework itself is not deeply
load-bearing; swapping Next.js for another framework later would touch `apps/web` only.

---

## 2026-09-05 — Monorepo tooling: pnpm workspaces, no Turborepo yet

**Decision:** pnpm workspaces only.

**Rationale:** matches the spec's `/apps` + `/packages` layout with the least tooling. Add
Turborepo later if build/caching performance actually demands it — premature build-tool
investment isn't justified at Phase 0 scale.

**Reversibility:** high — additive change, no restructuring required.

---

## 2026-09-05 — Database: Prisma ORM over Postgres; Auth.js (NextAuth v5) credentials provider

**Decision:** Prisma for schema/migrations; Auth.js v5 with a Credentials provider and a
single seeded `User` row (Chris).

**Alternatives considered:** a custom auth flow; an OAuth-only provider.

**Rationale:** Prisma gives real migrations (spec requirement: "no schema change without
migrations") and strong TypeScript types. This is a single-operator internal tool, not
multi-tenant SaaS, so Credentials-based auth is the least infrastructure for the actual
requirement; the `User`/session model is generic enough to add OAuth later without a schema
change.

**Reversibility:** DB engine choice is the more expensive one to reverse (migrations exist);
auth mechanism is cheap to swap later since there's exactly one user.

---

## 2026-09-05 — Prompt registry: version-controlled Markdown files, not a DB table

**Decision:** Prompts live under `/prompts/**` as Markdown with YAML frontmatter
(`prompt_id`, `version`, `role`, `required_context`, `output_schema`, `model_class`, `active`,
`eval_status`, `rollback_version`). `packages/prompts` loads and validates them. No
`PromptDefinition`/`PromptVersion` DB table yet.

**Rationale:** the spec explicitly allows "version-controlled files **or** a prompt registry."
Files are git-diffable and human-editable without a deploy. A DB-backed registry can be added
later specifically to support *runtime* prompt rollback without moving the authoring source —
that's a real but not-yet-needed capability.

**Reversibility:** high — the DB table, if added later, would be populated *from* these files,
not replace them as the authoring source.

---

## 2026-09-05 — Feature flags: single table + helper, no vendor

**Decision:** one `FeatureFlag` table, `isEnabled(key)` helper.

**Rationale:** avoids adopting a vendor (LaunchDarkly, etc.) before the need is proven. The
spec's requirement is "use feature flags for risky/new autonomous behavior" — a simple
DB-backed flag satisfies that at Phase 0/8 scale.

**Reversibility:** high — swappable for a vendor later; the `isEnabled()` call-site interface
would not need to change.

---

## 2026-09-05 — Cost expectations discussed and accepted

**Decision:** proceed cloud-hosted on Vercel as planned, accepting an estimated **$350–
$1,300+/month** run-rate at the target ~130 videos/month (~390 platform placements/month),
driven mainly by LLM/agent calls, vision/QA calls, render compute, storage, and Vercel+Postgres
hosting — generative/HERO media is the largest variable on top of that.

**Alternatives considered:** local-first/hybrid self-hosting (storage/render/DB on Chris's own
machine) to cut cost to an estimated $30–$150/month, at the cost of always-on
scheduling/publishing reliability, multi-device access, and managed backups.

**Rationale:** Chris explicitly chose to keep the cloud-hosted plan, prioritizing reliability
and access over minimizing run-rate. Actual per-video cost becomes visible from Phase 0 onward
via the observability requirements in `/docs/SECURITY.md` rather than staying an estimate —
the model-routing cost governor (`/docs/ARCHITECTURE.md` §16, arrives Phase 3+) is the lever to
pull if real numbers run high.

**Reversibility:** high — this is a running-cost decision, not an architectural one; nothing
about the code depends on staying cloud-hosted forever.

---

## 2026-09-05 — Platform API rate-limit risks documented before Phase 5

**Decision:** the following constraints are treated as known risks to design around, not
surprises to discover during Phase 5:
- **Instagram Graph API:** 25 published posts/24h per account. Target ~4.3/day/platform —
  comfortable headroom.
- **YouTube Data API v3:** default 10,000 units/day quota, 1,600 units per video insert
  (~6/day ceiling before other same-day calls, realistically ~4–5/day with overhead). Target
  sits right at this ceiling — a quota-increase request should be filed with Google early in
  Phase 5 planning, and the Scheduler must be quota-aware rather than assume unlimited calls.
- **TikTok Content Posting API:** public direct-posting requires app-audit approval; unaudited
  apps can only post private/draft. No guaranteed approval timeline. The spec already
  anticipates this (§21 graceful failure) — the TikTok adapter ships with a
  draft-and-manually-publish fallback from day one in Phase 5, not added after the fact.

**Reversibility:** n/a (external platform constraint, not a choice) — documented so Phase 5's
design starts from these limits rather than assuming unlimited API access.

**Correction — 2026-09-07 (verified against current Google docs when Phase 5 actually
started):** the YouTube figure above was wrong, carried forward uncorrected from the original
plan. `videos.insert` no longer draws from the shared 10,000-unit/day bucket at 1,600 units per
call — Google's current quota-cost table
(`https://developers.google.com/youtube/v3/determine_quota_cost`) puts it in its **own**
dedicated bucket: **100 calls/day, 1 unit per call**, separate from the general 10,000/day
budget (which still applies to everything else — `videos.list` status checks, etc.). At the
~4.3/day/platform target this is comfortable headroom, not "right at the ceiling" — the
early-quota-increase-request urgency from the original entry no longer applies. The
Scheduler/publish job is still built quota-aware (packages/platforms' `youtube-quota.ts`
tracks both buckets independently from today's real `Publication` rows), because "still a
hard external limit, just a bigger one" is not the same as "no limit" — and because this same
kind of platform-detail drift is exactly why the check-before-building rule exists.

---

## 2026-09-07 — Local dev/test database: PGlite over the Postgres wire protocol, not Docker

**Decision:** this build environment has no Docker and no Homebrew (confirmed by direct
check). Local dev/test uses `@electric-sql/pglite` served over a real TCP socket via
`@electric-sql/pglite-socket`, which speaks the actual Postgres wire protocol. Prisma's
standard `postgresql` provider connects to it exactly as it would connect to real Postgres —
no schema dialect changes, no drift risk between dev/test and production.

**Alternatives considered:** (a) ask Chris to install Docker Desktop or Homebrew+Postgres
before continuing; (b) fall back to SQLite for dev/test, accepting schema-dialect drift risk
(no native enums, different JSON handling) between environments.

**Rationale:** per `CLAUDE.md`'s standing rule — when technical reality conflicts with the
plan, document the conflict, preserve product intent, choose the safest reversible
implementation, and continue rather than stopping. PGlite is real compiled Postgres (not an
emulation), so this preserves the "Postgres via Prisma, migrations are real Postgres SQL"
product intent exactly, with zero external install requirement. `docker-compose.yml` remains
in the repo as the standard path for any future environment that does have Docker — switching
is a one-line `DATABASE_URL` change plus starting Docker instead of the PGlite socket script.

**Reversibility:** high — purely a local dev/test convenience; production always uses a real
managed Postgres (Neon via Vercel Marketplace), unaffected by this choice.

---

## 2026-09-07 — The PGlite dev database can't handle concurrently dispatched queries

**Decision:** `getContentItem` (`packages/domain/src/content-item.ts`) fetches its seven
related artifacts (`productionContract`, `creatorCard`, `mediaAssets`, `scheduleEntry`,
`transitions`, `researchPackets`, `scriptVersions`) as **sequential** `await`s, one query at a
time — not one `findUnique` with all seven nested in `include`, and not `Promise.all` over
seven independent queries either.

**Rationale:** isolated by bisection across three hypotheses, in order:
1. First suspected `take`+`orderBy` on a to-many relation inside `include` (a Prisma
   LATERAL-join query strategy) — a single such relation alone worked, but combined with
   several sibling relations it broke, so this wasn't the real trigger.
2. Then suspected "too many relations combined in one `include`" generally — moved to
   `Promise.all` over seven separate single-relation queries instead. This *still* broke,
   even after removing `take` and `orderBy` complexity, on as few as 3-4 concurrently
   in-flight queries.
3. Confirmed the actual trigger is **concurrent query dispatch itself** — even with Prisma's
   connection pool forced to `connection_limit=1` (a single real TCP connection), `Promise.all`
   still failed, meaning it's pipelined/overlapping requests on the wire that this PGlite
   build's connection handler can't reliably process, not connection-pool concurrency. Purely
   **sequential** `await`s (proven in isolated single-query test scripts throughout this
   investigation) are the one pattern that has been reliable at every step.

Real Postgres (Docker locally, Neon in production) supports concurrent/pipelined queries and
complex multi-relation `include`s fine — none of this reflects a real product constraint.

**Consequence for future sessions:** in code that runs against this sandbox's dev database,
prefer sequential `await`s over `Promise.all` for multiple Prisma queries until a real
Postgres is available. If a future query hits "Server has closed the connection," suspect
concurrent dispatch first (not query complexity) and try sequential awaits before anything
else.

**Reversibility:** high — sequential awaits are semantically identical to `Promise.all` here
(a handful of fast local queries; the latency difference is negligible), and nothing prevents
switching back to `Promise.all` once a real Postgres is in use.

---

## 2026-09-07 — Phase 2 scoped to the core Research -> Script pipeline; rest deferred

**Decision:** this pass of Phase 2 builds and ships: the model-provider abstraction
(`packages/agents`), the Research Agent, Claims Gate, Script Agent, and Brand Guardian, the
orchestration pipeline tying them together, and DB persistence
(`ResearchPacket`/`ScriptVersion`) wired to real state transitions. It does **not** build
reference library + semantic similarity, Weekly Programming Thesis, or portfolio constraints
— all four of those remain in `/docs/PHASE_PLAN.md`'s Phase 2 scope but are deferred to a
follow-up pass.

**Rationale:** `/docs/PHASE_PLAN.md`'s Phase 2 acceptance criterion (written during initial
planning) is specifically the Research -> Claims Gate -> Script pipeline running end-to-end
against gold-standard fixtures — that's the acceptance-critical spine, and it's what's built
and tested here (with a mock model provider, so zero API cost was spent proving it works; the
real Anthropic provider is wired in and ready the moment an API key is added). The remaining
four subsystems are each a meaningfully separate, non-trivial body of work with real open
product questions (which reference creators beyond Jun Yuh, what the actual portfolio
allocation ratios should be) that benefit from Chris's input rather than being guessed at to
hit a scope target in one pass.

**Reversibility:** high — nothing built here needs to change to add the remaining four
subsystems later; they're additive.

**Update (same day, later pass):** reference library, Weekly Programming Thesis, and
portfolio constraints were subsequently built (see Phase 2's second completion entry in
`/docs/PHASE_PLAN.md`) — schema, domain CRUD, three more agents (Reference Intelligence,
Creative Director, Weekly Strategist), and UI (`/reference`, `/strategy`). One piece was
deliberately still not built: **embeddings-based semantic similarity** ("reference library,
semantic similarity" in spec §25's Phase 2 scope). What exists instead is manual
creator/content entry analyzed per-item by the Reference Intelligence agent — genuinely
useful, but not the same as automated similarity search across a growing corpus (e.g. "find
past Chris videos with a similar hook family," spec §7's Content Graph `same_hook_family`
edge). Real semantic similarity needs an embeddings provider choice and a vector storage/index
decision (pgvector vs. a dedicated vector DB) — a real infrastructure investment worth its own
consideration once there's enough reference/content volume to make similarity search valuable,
not a snap decision folded into an already-large session. Revisit when Content Graph work
(Phase 2's `ContentRelationship` entity, still deferred per `/docs/DATA_MODEL.md`) is tackled.

**Also fixed in this pass (recurring pattern, worth naming once):** every exported
`CreateXInput`/`UpsertXInput` type in `packages/domain` derived from a Zod schema containing
`.default(...)` must use `z.input<typeof Schema>`, not `z.infer<typeof Schema>` — `z.infer`
is the schema's *output* type (post-parse, defaults filled in and therefore required),
`z.input` is what a caller may actually omit. Using `z.infer` for a Zod schema's exported
"caller input" type makes TypeScript wrongly require fields the schema's own `.default(...)`
makes optional at runtime — caught first on `ScheduleEntry`'s `scheduledDate`, then recurred
in `production-contract.ts`, `weekly-thesis.ts`, `reference-creator.ts`, and
`decision-journal.ts` once tests actually omitted a defaulted field (earlier tests happened
to always pass every field explicitly, masking it). Fixed at all five sites; any new
`Create.../Upsert...Schema` with a `.default(...)` field should export via `z.input` from the
start.

---

## 2026-09-07 — Weekly Strategist proposals require review before taking effect

**Decision:** `WeeklyPortfolioItem` gained a `status` field (`PROPOSED` / `APPROVED` /
`REJECTED`, default `PROPOSED`). `recordPortfolioItem` (called when the Weekly Strategist
agent runs) only ever writes a proposal — it never transitions the underlying `ContentItem`.
A new `approvePortfolioItem` is the only path that transitions `IDEA -> SELECTED` (and only
for a proposal marked `selected: true`); `rejectPortfolioItem` marks a proposal rejected with
no state-machine effect at all. Re-running the Strategist for the same (thesis, item) pair
resets its status back to `PROPOSED` — a fresh AI proposal requires fresh human review, even
if a prior one had already been approved.

**Alternatives considered:** the original implementation (see the first Phase 2 entry above)
applied every returned allocation immediately.

**Rationale:** the original approach let the Weekly Strategist agent silently move ideas
`IDEA -> SELECTED` with no human in the loop — a genuine violation of the spec's authority
hierarchy (`/docs/ARCHITECTURE.md`: specialists recommend, they don't get to make Level-2
Creative-Director-tier decisions unilaterally) and its `NEEDS YOU` philosophy (subjective
creative/strategic choices are exactly the category that should surface for review, not
auto-apply). Caught during a deliberate pass over already-flagged known limitations rather
than left to accumulate — the fix was contained enough to do immediately instead of deferring
further.

**Reversibility:** high — this is additive (a new required review step, not a removed
capability); `/strategy`'s UI now shows a "Needs your review" queue for `PROPOSED` items with
Approve/Reject actions.

---

## 2026-09-07 — Confirmed: prior Phase 2 UI already correctly avoided the same mistake elsewhere

**Note (verification, not a change):** re-checked every other agent-triggering Server Action
for the same "agent output silently takes effect" risk before considering the review-gap fix
complete. `runPipeline` (Research → Script) and `analyzeContent` (Reference Intelligence) were
already correct — `applyPipelineResult` only ever *advances* a state the human already put the
item into (`RESEARCHING`, entered manually) and reports a `RESEARCH_BLOCKED` result rather
than silently discarding it; `recordReferenceObservations` never touches the state machine at
all, it only ever writes observations for Chris to read. The Weekly Strategist path was the
one actual gap.

---

## 2026-09-07 — Phase 3 renderer: `ffmpeg-static` + `ffprobe-static`, hosted in `apps/worker`

**Decision:** the deterministic renderer and media-analysis layer use `ffmpeg-static` and
`ffprobe-static` (npm packages that download a real, static, platform-matched `ffmpeg`/
`ffprobe` binary at install time) rather than requiring a system-installed ffmpeg. Resolves
the open question flagged back in Phase 0/`/docs/PHASE_PLAN.md` ("where does the renderer
actually execute").

**Rationale:** this sandbox has neither Docker nor Homebrew (per earlier decisions), so a
system ffmpeg install isn't available — but `ffmpeg-static`'s bundled binary was verified
directly: real ffmpeg 6.0 with `libx264`/`libx265`/`libass`/`libfreetype` (needed for text
overlays and burned captions) and a matching `ffprobe` 4.4, both running natively on this
machine. This isn't a workaround specific to the sandbox — it's a legitimate, commonly-used
production pattern (bundling a static binary directly into a Node process/serverless
function) that avoids a system dependency entirely, in dev and in a real deployment alike.

**Where it runs:** `apps/worker` — the process boundary that has existed since Phase 0
specifically for this decision. Whether that's a long-lived worker host or a Vercel
Sandbox/Function invocation in production is still open (function execution time and
deployment package size — `ffmpeg-static`'s binary is ~45MB — are real constraints worth
validating against an actual deploy, not decided from first principles here) — but the
renderer's own interface doesn't care which; this is a deployment-target decision, not an
API change, so it stays reversible.

**What the renderer actually implements now (real, tested, not a stub):** trim/concat source
segments, center-crop + scale to a 9:16 target (1080×1920), burned text overlays (`drawtext`,
timed), single-pass audio loudness normalization (`loudnorm`), H.264/AAC MP4 output at fixed,
reproducible encode settings.

**Deliberately not implemented yet (EditPlan's schema reserves the fields; the renderer skips
them gracefully per spec §21's graceful-degradation principle rather than failing):** B-roll
compositing and music/SFX mixing (both need an approved asset library — `BrandAsset`,
deferred, see below), transitions between segments (hard cuts only for now), face-tracked
reframing (computer vision is out of scope for a *deterministic* renderer — center-crop is
the documented simpler fallback for RAW/FAST tiers).

**Also deferred this phase:** `BrandAsset` (the approved reusable asset library, spec §15) —
nothing in the core "does the deterministic renderer produce a valid, QC'd output" acceptance
criterion depends on it, and introducing it now (with no real assets to populate it) would be
the same "table without a proven need" mistake avoided in Phase 1/2. Add it when B-roll/music
mixing is actually implemented.

**Reversibility:** high — the ffmpeg-command-building code is isolated in
`packages/media`; swapping the binary source (system ffmpeg, a different static package, a
cloud transcoding API) touches one module, not the renderer's callers.

---

## 2026-09-07 — Transcription: interface only, no provider chosen yet

**Decision:** a `TranscriptionProvider` interface exists (mirroring `ModelProvider`'s
pattern) with a mock implementation for tests; no real transcription API is wired in yet.

**Rationale:** consistent with how the Anthropic model provider was handled in Phase 2 — the
abstraction and its tests don't need a real key or real cost to be built and proven correct.
Take Selector and Edit Planner both accept a transcript as plain input, so they work
identically whether that transcript came from a real provider or was typed in manually while
no provider is configured; nothing downstream needs to change when a real provider is added.

**Reversibility:** high.

---

## 2026-09-07 — Bug caught by tests: `render-record.ts` tried an invalid direct transition

**Note:** `recordRenderAttempt`'s repair-limit logic originally jumped `RENDERED -> QC_BLOCKED`
directly once the attempt count hit the limit. `/docs/STATE_MACHINE.md` doesn't allow that —
`QC_BLOCKED` is only reachable via `QC_REPAIR -> QC_BLOCKED`. The state machine's own
`InvalidTransitionError` caught this immediately in the repair-loop test (`render-record.test.ts`,
"repeated QC failures hit the repair-iteration limit"), before it ever reached real usage.
Fixed by always landing in `QC_REPAIR` first, then immediately following with the documented
second transition to `QC_BLOCKED` when the limit is already reached — two real transitions,
both in the actual table, rather than one invalid shortcut. No decision to record beyond
"the test did its job" — logged so a future session sees this exact class of mistake (a
domain function's business logic drifting out of sync with the state table it's supposed to
drive) has already been caught once here.

---

## 2026-09-07 — Bug caught by tests: ffmpeg silently clamps out-of-bounds segments

**Decision:** `renderVideo()` (`packages/media/src/render.ts`) now probes the source file's
actual duration and rejects (`RenderSegmentOutOfBoundsError`) any segment whose `endSeconds`
exceeds it — *before* building or running the ffmpeg command — rather than trusting the
caller.

**Rationale:** an integration test (`apps/worker`'s `render-job.test.ts`) deliberately fed a
segment ending far past the source's real length, expecting the render to fail. It didn't —
`renderVideo` returned `SUCCESS`. ffmpeg's own `trim` filter doesn't error on an out-of-bounds
end time; it silently clamps to the frames actually available, producing a shorter clip than
requested instead of a clear failure. `packages/agents`' Edit Planner already validates
segment bounds against the source duration *it was told about* — but that's not true defense
in depth if the render layer itself will happily accept a bad value anyway (a stale duration,
an EditPlan created outside the agent path, direct DB edits). The fix moves the same check to
where it can't be bypassed: immediately before rendering, against the file that's actually
about to be rendered.

**Reversibility:** high — additive validation; no existing correct caller is affected (see
the passing happy-path test), only ones that were silently getting wrong output.

---

## 2026-09-07 — Real Phase 3 acceptance-criterion pipeline verified end-to-end

**Note (verification, not a decision):** `apps/worker/src/render-job.ts`'s
`renderContentItem` — and its integration test — prove the actual Phase 3 acceptance
criterion for real: a synthetic fixture (no real Chris footage needed) moves through a real
`ContentItem` state machine (FILMED → MEDIA_INGESTED → TAKE_SELECTED → EDIT_PLANNED →
EDITING → RENDERED), a real `MediaAsset` in a real (local-fs) `StorageAdapter`, a real
hand-constructed `EditPlan` (the Edit Planner agent's own output-validation is proven
separately with a mock provider in `packages/agents`), a real ffmpeg render, and real
ffprobe-based technical QC — landing at `RENDERED` with a `PASS` report. The failure path
(an invalid EditPlan) is verified too: it fails clearly and leaves the `ContentItem` at
`EDITING` for a real retry, not silently corrupting state.

---

## 2026-09-07 — `apps/web` calls the render job in-process, no queue yet

**Decision:** `apps/worker`'s package.json now exposes `./src/render-job.ts` as its main
export, so `apps/web`'s Server Actions can `import { renderContentItem } from "@chris/worker"`
and run a render synchronously within the same request, rather than enqueueing a job for a
separately-running worker process to pick up.

**Rationale:** no job queue exists yet (deliberately — building one now would be exactly the
kind of premature complexity CLAUDE.md's standing rules warn against, before there's a real
concurrency/scale need). For Phase 3's actual requirement — proving the render pipeline works
and giving Chris a way to trigger it — running it in-process is the simplest thing that
works, and Vercel Functions' current 300s default timeout comfortably covers a single
short-form render. `apps/worker` still exists as the intended eventual home for a real
async job runner (Phase 5+, once publishing/scale pressure makes one necessary) — this
decision doesn't foreclose that, it just doesn't build it before it's needed.

**Reversibility:** high — `renderContentItem` doesn't know or care whether it's called
in-process from a Server Action or dequeued by a standalone worker; swapping to a real queue
later changes the caller, not this function.

**Also decided in this pass:** used `client.messages.parse()` with Zod-based
`output_config.format` (via `@anthropic-ai/sdk/helpers/zod`'s `zodOutputFormat`) for
structured agent outputs, rather than hand-rolled JSON-mode parsing or tool-use-as-structured-
output — this is the SDK's own recommended current pattern (confirmed via the bundled
Claude API skill, not assumed from training data, given how fast this surface changes) and
gives schema-validated typed output directly from the API call.

---

## 2026-09-07 — Phase 1: no separate `ContentIdea` table; `Notification` deferred

**Decision:** Phase 1 does not introduce the `ContentIdea` entity `/docs/DATA_MODEL.md`
originally slotted for this phase. `ContentItem`'s `IDEA` state (already real since Phase 0)
serves as the ideas backlog — the IDEAS nav view is simply `ContentItem`s in state `IDEA`.
`Notification` is also deferred past Phase 1 — nothing in Phase 1's actual acceptance
criteria (create idea → advance through stub states → upload raw media → appear on calendar)
needs it, and building it now would be a table with no real consumer.

**Alternatives considered:** build `ContentIdea` as a separate, lighter-weight pre-selection
entity (raw unstructured brainstorm) that later gets "promoted" into a `ContentItem`; build
`Notification` now since the data model doc already listed it for this phase.

**Rationale:** `ContentItem` already starts life in `IDEA` state by default (Phase 0 schema).
A second table representing the same conceptual thing (an idea that hasn't been selected yet)
would be duplicate structure with no distinct behavior to justify it yet. If raw brainstorm
volume ever outgrows the structured `ContentItem` shape (e.g. Chris wants to jot ten
one-line thoughts a day without titling/pillar-tagging each one), `ContentIdea` can be added
then, with a promotion path into `ContentItem` — nothing about this decision blocks that.

**Reversibility:** high — additive; introducing `ContentIdea` and `Notification` later needs
new tables, not a rework of anything built now.

---

## 2026-09-07 — Prisma 7's connection-config model (driver adapters, `prisma.config.ts`)

**Decision:** `packages/domain/prisma/schema.prisma`'s `datasource` block declares only
`provider = "postgresql"` — no `url`. The connection string for the Prisma CLI (migrate,
studio) lives in `packages/domain/prisma.config.ts` (`datasource.url`, reading
`DATABASE_URL`). At runtime, `PrismaClient` is constructed with an explicit driver adapter
(`@prisma/adapter-pg`'s `PrismaPg`, wrapping `pg`) rather than reading a schema-level `url`.
Seeding is configured via `prisma.config.ts`'s `migrations.seed` (not `package.json#prisma.seed`)
and must be run explicitly (`prisma db seed`) — Prisma 7 no longer auto-seeds after `migrate
dev`/`migrate reset`.

**Alternatives considered:** pin to an older Prisma major (6.x) to keep the pre-7
schema-embedded-`url` model and avoid this added indirection.

**Rationale:** the registry's latest stable `@prisma/client`/`prisma` is 7.10.0, and this is a
new project with no existing Prisma investment to preserve — there's no reason to start on a
deliberately older major. Confirmed against Prisma's own current docs (fetched directly,
not from training-data memory, since this is exactly the kind of "APIs change without
warning" case the environment's tooling warnings call out) rather than guessed.

**Reversibility:** moderate — this is Prisma's own current architecture, not a choice we can
easily reverse without leaving Prisma entirely; documented here so a future session doesn't
"fix" `schema.prisma` back to a `url` field and reintroduce the validation error this
resolved.

**Also decided in this pass:** `typescript` is pinned to `^6.0.3`, not the registry's `latest`
tag (`7.0.2`) — `typescript-eslint@8.69.0`'s peer range caps at `<6.1.0`, and TS7 isn't yet
supported by the lint tooling ecosystem. Revisit once `typescript-eslint` publishes TS7
support.

---

## 2026-09-07 — Initial migration generated via `migrate diff`, applied via `migrate deploy`

**Decision:** the very first Prisma migration was generated with `prisma migrate diff
--from-empty --to-schema prisma/schema.prisma --script` (writing the SQL by hand into
`prisma/migrations/<timestamp>_init/migration.sql` + `migration_lock.toml`) and applied with
`prisma migrate deploy`, instead of the normal interactive `prisma migrate dev`.

**Alternatives considered:** debug why `migrate dev` itself fails against the PGlite dev
database further (it failed with `P1017: Server has closed the connection` partway through,
with no error surfaced by `pglite-socket`'s own server/connection/error events — most likely
`migrate dev`'s shadow-database step, which needs to `CREATE DATABASE`, something PGlite's
single-embedded-database engine cannot actually do); or add a real Postgres via Docker just
for this one step.

**Rationale:** `migrate dev` computes its diff by spinning up a temporary **shadow database**
so it can safely detect drift — a mechanism several real hosted-Postgres providers also can't
support (for unrelated reasons: restricted users, PgBouncer, etc.), for which Prisma's own
documented workaround is exactly this: generate the SQL out-of-band and apply it with
`migrate deploy`, which only applies SQL files and records them in `_prisma_migrations` —
no shadow database involved. This keeps every future migration's *history* fully real and
Prisma-native (`migrate status` confirms "Database schema is up to date!"); only the
*authoring* step for schema changes in this sandbox needs the extra `migrate diff` command
instead of `migrate dev`'s one-liner.

**Consequence for future sessions:** until a real Postgres (Docker, or Neon in
production/staging) is available, author new migrations the same way: **`prisma migrate diff
--from-config-datasource --to-schema prisma/schema.prisma --script`** (diffs the live dev
database's actual current state against the target schema — no shadow database needed,
unlike `--from-migrations`, which *also* requires a shadow database and fails with "You must
set `datasource.shadowDatabaseUrl`" in this sandbox). Place the output in a new timestamped
`prisma/migrations/<ts>_<name>/migration.sql`, then `prisma migrate deploy`. This only works
correctly when the live dev database's schema is already fully in sync with migration
history before making the change (true here since every prior migration was applied via
`migrate deploy`) — if it ever drifts, reconcile it before trusting a `--from-config-datasource`
diff. Once a real Postgres is available (e.g. via `docker-compose.yml`), `migrate dev` should
work normally again — this is a sandbox-specific workaround, not a permanent change to how
this project does migrations.

**Reversibility:** high — the resulting migration history is indistinguishable from one
`migrate dev` would have produced; switching back to `migrate dev` once a real shadow-database-
capable Postgres is available requires no schema or history changes.

---

## 2026-09-07 — `apps/web/CLAUDE.md` and `apps/web/AGENTS.md` are Next.js–owned, not ours

**Note (not really a decision):** running `next dev` auto-generates
`apps/web/CLAUDE.md` (a one-line pointer, `@AGENTS.md`) and `apps/web/AGENTS.md` (framework
guidance telling an agent to check `node_modules/next/dist/docs/` for breaking changes before
writing Next.js code in that directory) — a Next.js 16 feature, regenerated on every `next
dev` run. This is scoped to `apps/web` and is unrelated to, and does not override, this
repository's root `CLAUDE.md`. Leave it alone — don't delete it (it just comes back) and don't
mistake it for a second copy of this project's own operating rules.

---

## 2026-09-07 — Phase 4: hard-gate aggregation is pure, and BRAND/CREATIVE reuse Brand Guardian's scores

**Decision:** `packages/domain/src/quality-gate.ts`'s `aggregateHardGates()` is a pure function
over four already-reduced `PASS`/`BLOCK` inputs (FACTUAL, TECHNICAL, BRAND, CREATIVE) — it ORs
them together and can't average a `BLOCK` away because its inputs and output are never numbers,
only the two-value union. FACTUAL is read from the ClaimsGateResult already persisted on the
ResearchPacket at RESEARCHING time (Phase 2) — Claims Gate is never re-run against the final
edit, since its contract (`/docs/AGENT_CONTRACTS.md`) takes ResearchPacket + ScriptVersion, not
Render, and an EditPlan can only trim/caption the script's existing claims, never add a new
one. BRAND and CREATIVE are spec-named hard gates (§9 step 16) with no agent literally producing
scores under those names — Brand Guardian (Phase 2) produces `brandScore`/`voiceScore`/
`originalityScore` instead. Mapping used: BRAND = brandScore AND voiceScore both ≥ 70; CREATIVE
= originalityScore ≥ 60 (both plain exported constants, not buried in logic).

**Alternatives considered:** (a) build a dedicated Brand/Creative review agent for this phase
instead of reusing Brand Guardian's existing scores — rejected as unjustified scope now, since
Brand Guardian's existing fields already cover the same territory (voice/originality/strategic
fit) the spec's BRAND/CREATIVE gates are gesturing at; (b) re-run Claims Gate against the final
render's transcript for genuine defense-in-depth against edit-introduced factual drift —
rejected for this phase because there's no dedicated final-render transcription step yet (see
the still-open "no real transcription provider" limitation) and the spec's own Claims Gate
contract doesn't name Render as an input; worth revisiting once transcription is real.

**Reversibility:** high — both the score-to-gate thresholds and the FACTUAL source are one
function call each (`brandGateFromScores`, `creativeGateFromScore`, the ClaimsGateResult read)
and can be swapped for dedicated agents/re-checks later without touching
`aggregateHardGates()`'s shape.

---

## 2026-09-07 — Visual QA is the first agent needing vision input; extended ModelProvider accordingly

**Decision:** added an optional `images?: ModelImageInput[]` field to
`StructuredCompletionRequest` (`packages/agents/src/model-provider.ts`) rather than a separate
vision-specific interface. `AnthropicModelProvider` maps each image to a labelled
(`t=<seconds>s`) content block placed before the text prompt when present; `MockModelProvider`
just records them on `calls` for test assertions. Frame extraction itself
(`packages/media/src/frame-extractor.ts`) is deterministic ffmpeg work — `-ss` seek +
single-frame PNG per sampled timestamp — with the same defense-in-depth pattern as Phase 3's
render segment-bounds check: a seek past the end of the video exits ffmpeg with code 0 and
writes no file ("Output file is empty, nothing was encoded") rather than erroring, verified
directly against the real binary, so `extractFrames` explicitly checks the output file exists
and is non-empty rather than trusting the exit code.

**Alternatives considered:** a separate `completeWithVision()` method on `ModelProvider` —
rejected because every other call shape (system prompt, schema, promptId, model routing) is
identical; a parallel method would duplicate the whole interface for one optional field.

**Reversibility:** high — `images` is optional and additive; no existing agent call changes
shape.

---

## 2026-09-07 — Bug found and fixed: ffmpeg-static/ffprobe-static break under Next.js's server bundling

**What happened:** every real-model-call-free Phase 3 verification claim in this repo (`pnpm
test`'s integration tests, and the "verified via live UI" language in Phase 3's completion
record below) was true only through *either* Vitest *or* a standalone Node script
(`renderContentItem`/`probeMedia` called directly, bypassing Next.js entirely) — never through
an actual Next.js Server Action running inside `next dev`. Phase 4's `runQualityGate` action was
the first code path to invoke `packages/media`'s ffmpeg/ffprobe functions through Next's own
bundler, and it failed immediately: `spawn /ROOT/node_modules/.pnpm/ffprobe-static.../ffprobe
ENOENT`. Root cause: `ffmpeg-static`/`ffprobe-static` compute their binary path via `__dirname`
inside their own package code; Next's default Server Components bundling rewrites `__dirname`
to a synthetic build-time path for bundled dependencies, which is real for most JS code but
wrong for a package whose entire job is "point at a real file on disk."

**Fix:** `apps/web/next.config.ts` now sets `serverExternalPackages: ["ffmpeg-static",
"ffprobe-static"]` (a stable Next.js 15+ option — see
`node_modules/next/dist/docs/.../serverExternalPackages.md`), which opts these two packages out
of bundling and uses plain Node `require` instead, restoring correct `__dirname` resolution.

**Verification:** confirmed via real HTTP against a restarted `next dev` server (not a script):
(1) `uploadMedia` against a real uploaded fixture produced a `MediaAsset` with real ffprobe
values (640×480, 5s, h264/aac, 30fps, hasAudio) instead of failing; (2) `runRender` against a
fresh `EDIT_PLANNED` item produced a real `RENDERED` item with `Technical QC: PASS`, and the
resulting file fetched back through `/api/media/...` was confirmed to be a genuine, valid MP4;
(3) `runQualityGate` got past `probeMedia`/`extractFrames` entirely and failed only at the
correct, already-known, already-documented point (no `ANTHROPIC_API_KEY` configured).

**Consequence:** Phase 3's completion record's "verified via live UI" language was not fully
accurate — the actual Next.js-bundled render/upload code paths were silently broken the entire
time; only the Vitest integration tests (which run outside Next's bundler) and the standalone
demo script exercised the real logic. This is now fixed and independently re-verified through a
real server rather than a script, and Phase 3's completion record below has a correction note
added rather than being silently rewritten.

**Reversibility:** high — a one-line config addition; trivially reversible, and would need to
be revisited (not reversed) if these packages are ever swapped for a cloud-hosted transcoding
API that doesn't need local binaries at all.

---

## 2026-09-07 — Model ID fix: Haiku 4.5 needs the dated suffix

**What happened:** `packages/agents/src/providers/anthropic-provider.ts`'s `LOW` model-class
default was `"claude-haiku-4-5"`, missing the dated suffix (`-20251001`) every other model ID
in that table already carried correctly (`claude-opus-5`, `claude-sonnet-5`). Found while
reviewing the provider file during Phase 4 work — never triggered by any test, since every
automated test in this repo uses `MockModelProvider`, and no `LOW`-class agent has been built
yet to exercise the real provider's default at all.

**Fix:** corrected to `"claude-haiku-4-5-20251001"`.

**Reversibility:** trivial — a string constant, and already overridable per-deployment via the
`MODEL_LOW` environment variable regardless.

---

## 2026-09-07 — Bug found and fixed: unbounded date range let future-dated test rows leak into real quota checks

**What happened:** `packages/platforms/src/youtube-quota.ts`'s `getYouTubeQuotaState` counted
`Publication` rows with `createdAt: { gte: startOfUtcDay(now) }` — no upper bound. A Phase 5
test (`youtube-quota.test.ts`'s exhaustion case) deliberately used a synthetic future date to
avoid polluting real "today" across repeated `pnpm test` runs — the same pattern already
established elsewhere in this repo for test-date collisions. But because the query had no
`lt: startOfNextUtcDay(now)` bound, those future-dated rows were still `>= startOfUtcDay(realNow)`
and so counted against every *real* quota check made afterward, for the rest of real time (or
until the real day catches up to them). Caught immediately by `apps/worker`'s
`publish-job.test.ts` failing — a YouTube publish that should have succeeded came back skipped,
traced to `getYouTubeQuotaState` reporting the real day already exhausted (106 rows present)
purely from other tests' synthetic future data.

**Fix:** added the missing upper bound (`lt: startOfNextUtcDay(now)`), so the query is a real
closed `[today, tomorrow)` window. Also threaded an optional `now` override through
`apps/worker/src/publish-job.ts`'s `publishContentItem` (production callers omit it and get
real time) so the quota-exhaustion path can be tested end-to-end via a synthetic day without
ever needing 100 real rows created against real "today."

**Consequence:** the ~106 already-created rows from before the fix remain in the dev DB
(harmless now — they're excluded from every future query by the day bound) rather than being
deleted; per CLAUDE.md, `ContentStateTransition`/`AuditLog`-adjacent history is not something
sessions delete casually, and these rows are inert, not actively wrong.

**Reversibility:** trivial — a query bound and an optional parameter; no schema change.

---

## 2026-09-07 — Bug found and fixed: a monotonic `RUN_BASE_MS` alone doesn't prevent same-day test collisions

**What happened:** `packages/platforms/src/__tests__/youtube-quota.test.ts` used the
established `RUN_BASE_MS = Date.now()` pattern (see the earlier Phase 2 test-date-collision
entries) to pick synthetic "fake now" days for its quota tests, believing a monotonically
increasing base was sufficient. It isn't, when the granularity of the collision is a *calendar
day*: two invocations of `pnpm test` run within the same real hour still compute
`fakeNowForOffset(2)`/`fakeNowForOffset(3)` timestamps that fall in the *same* UTC day bucket
(`getYouTubeQuotaState` buckets by day, not by millisecond) — so rows from an earlier
invocation today accumulated under a later one, breaking exact-count assertions after a few
repeated runs in one session. Caught by `pnpm test` failing on the second/third run of the
day, not the first.

**Fix:** added the other half of the established pattern this repo already uses for date
collisions (see Phase 2's entries): explicit `deleteMany` cleanup of that synthetic day's
`YOUTUBE` rows before each test's own inserts, so exact-count assertions never depend on
whatever earlier runs left behind. Verified by running the same test file twice in immediate
succession — passes both times.

**Consequence for future sessions:** a monotonic run-base timestamp prevents collisions at the
granularity the *consuming* code actually buckets by. When that's day-level (or coarser) and
tests run repeatedly within a shorter real window than that granularity, pair it with explicit
cleanup — don't assume "monotonic" alone is sufficient without checking the bucket size.

**Reversibility:** trivial — test-only change, no product code affected.

---

## 2026-09-07 — TikTok has no comment-listing access at this app's tier; metrics field mapping verified per platform

**Decision:** verified all three platforms' metric and comment endpoints against current docs
before building Phase 6, the same discipline as Phase 5's adapter work:
- **Instagram**: `/{media-id}/insights` real fields `views`, `likes`, `comments`, `shares`,
  `saved`, `reach`, `ig_reels_avg_watch_time` — the only one of the three platforms with a
  watch-time metric available to a standard app. Comments via `/{media-id}/comments`.
- **YouTube Data API v3**: `videos.list?part=statistics` returns only `viewCount`,
  `likeCount`, `commentCount` — no share count, no save count, and (confirmed directly) no
  watch-time/average-view-duration field anywhere in this API; that data lives only in the
  separate, more heavily-scoped YouTube Analytics API, not integrated this phase. Comments via
  `commentThreads.list`.
- **TikTok**: `/v2/video/query/` returns `like_count`/`comment_count`/`share_count`/
  `view_count` (no watch-time, no saves) at the same standard access tier this app already
  uses for publishing. **Comments, however, have no listing endpoint at this tier at all** —
  the only comment-data endpoint TikTok exposes
  (`/v2/research/video/comment/list/`) belongs to the separate Research API, which requires
  its own researcher-eligibility approval a personal creator/publishing app doesn't have and
  wouldn't qualify for. Confirmed by live search, not assumed.

**Consequence:** `TikTokContentPostingAdapter.listComments()` returns an empty array with a
documented reason, rather than calling an endpoint this app's credentials could never actually
reach. Every `PlatformMetrics` field this system doesn't get from a given platform stays
genuinely `null` — this is now backed by real, per-platform-verified API capability, not a
generic "might not be available" hedge.

**Known simplification, logged rather than fixed now:** `getMetrics`/`listComments` are typed
to take the same `platformPostId` `publish()` returns, but for TikTok specifically that's the
transient `publish_id`, not the real resolved `video_id` metrics/comments queries need — TikTok
only resolves the real video id via a follow-up status-fetch read after publishing completes,
which `verify()` doesn't currently surface. Not fixed now because it's unexercised without
real TikTok credentials anyway (same category as every other real-adapter limitation in this
system); worth resolving before this adapter is ever pointed at a real account.

**Reversibility:** high — purely adapter-internal; the `PlatformAdapter` interface and every
caller are unaffected regardless of how TikTok's id resolution is eventually fixed.

---

## 2026-09-07 — Bug found and fixed: synthetic test dates built from "real now + N days" can cross a UTC day boundary

**What happened:** two test files (`packages/platforms/src/__tests__/youtube-quota.test.ts`
and `apps/worker/src/__tests__/publish-job.test.ts`) picked a synthetic future day as `new
Date(Date.now() + N * 24h)` — preserving real "now"'s time-of-day. That's fine most of the
time, but both tests also compute a "check slightly later" timestamp (`+1 hour` past the last
inserted row) to read the quota state back. When real "now" happens to fall late enough in the
UTC day (this was found at ~23:xx UTC), `+N days` lands at that same late hour on the target
day, and `+1 hour` on top of that rolls into the *next* UTC day — outside the very day-bucket
`getYouTubeQuotaState`'s query and the test's own 100 filler rows both live in. Result: a
query that should find 100 rows found 0, failing an assertion that has nothing to do with the
real bug. Caught by `pnpm test` failing, non-deterministically by time-of-day, not by
inspection.

**Fix:** both files now snap their synthetic day to a fixed noon UTC
(`Math.floor(ms / dayMs) * dayMs + 12h`) instead of preserving real now's time-of-day — a full
12-hour margin in both directions absorbs any same-day offset either file adds, regardless of
what real wall-clock time the test suite happens to run at.

**Consequence for future sessions:** a synthetic test date built from "real now + offset" is
only safe from day-boundary bugs if either (a) nothing else in the test does further same-day
arithmetic on it, or (b) it's snapped to a fixed, safely-mid-day time first. Prefer (b) by
default — it's cheap and removes an entire class of test flakiness that otherwise only shows
up depending on what time of day (UTC) the suite happens to run.

**Reversibility:** trivial — test-only change, no product code affected.

---

## 2026-09-07 — Bug found and fixed: `publishContentItem`'s YouTube tests polluted both real "today" and their own synthetic future day across many repeated runs

**What happened:** two orchestration tests in `apps/worker/src/__tests__/publish-job.test.ts`
("all platforms succeeding", "one platform failing") included YOUTUBE in their target
platforms with no synthetic `now` override, so `publishContentItem`'s real YouTube quota check
read real wall-clock "today." `recordPublicationAttempt` (`packages/domain/src/publication.ts`)
always timestamps the `Publication` row it creates with real `now()` — there's no
synthetic-date override, unlike most other domain functions in this repo, because a real
publish attempt genuinely should be timestamped with real time. After enough `pnpm test` runs
in one real day (this session ran the full suite dozens of times while building Phases 5-6),
real "today"'s simulated 100-upload YouTube budget was genuinely exhausted (1517 real rows
found), so both tests started failing — not flakily, but deterministically, once the
threshold was crossed. Separately, the file's own dedicated quota-exhaustion test computes its
synthetic future day via `Math.floor(...)` (flooring to a calendar day, not a monotonic
per-run value), so its own 100 filler rows accumulated identically across every same-day
re-run — 1400 rows found on one such day after repeated debugging runs — which then broke a
fix attempt that pointed the other two tests at that same synthetic day expecting it to be
clean.

**Fix, two parts:**
1. The two orchestration tests don't need YouTube specifically — they're testing "multiple
   platforms, one platform's outcome doesn't affect the others," a claim that doesn't depend
   on which platform. "All platforms succeeding" now uses INSTAGRAM+TIKTOK, sidestepping the
   quota gate entirely. "One platform failing" still legitimately needs three platforms
   (TIKTOK failing, INSTAGRAM+YOUTUBE succeeding) and now explicitly passes a synthetic future
   `now` for the quota check, since the row `recordPublicationAttempt` writes is always
   real-timestamped regardless — the override only needs to make the *check* pass, not the
   write.
2. The dedicated quota-exhaustion test (and the "one platform failing" test, which now shares
   the same synthetic day) both call a new `clearYouTubeQuotaDayFillerRows()` cleanup before
   inserting anything — the same cleanup-before-insert pattern already established in
   `packages/platforms/src/__tests__/youtube-quota.test.ts`, applied here because a
   `Math.floor`-based synthetic day is fixed per calendar day, not monotonic per run, and
   accumulates identically to real "today" across repeated same-day invocations.

**Verified:** ran the fixed file three times in immediate succession — 7/7 pass every time.

**Consequence for future sessions:** any test that exercises `publishContentItem` (or anything
else that ultimately calls `recordPublicationAttempt`) against YOUTUBE needs one of: (a) not
using YOUTUBE at all when the test isn't specifically about YouTube's quota behavior, (b) a
synthetic `now` passed to the *quota check* even though the *row* will still be real-dated
(sufficient when the test only runs a handful of times), or (c) explicit day-bucket cleanup
before asserting exact counts (necessary once repeated runs could plausibly approach the real
100-upload ceiling on whatever day is in play, real or synthetic-but-fixed).

**Reversibility:** trivial — test-only changes, no product code affected.

---

## 2026-09-07 — Bug found and fixed: even `Date.now()`-based test dates collide for a genuinely global singleton table

**What happened:** `BrandEra`'s Phase 7 tests used fixed literal dates, then (once that
collided with a previous run's leftover "current era") `Date.now()`-based dates — the standard
fix pattern elsewhere in this repo. It still wasn't enough: `BrandEra` is the first table in
this repo that is a genuine global singleton (only one open-ended "current" era can exist at
any time), not scoped to a fresh per-test `ContentItem` the way nearly everything else is.
Re-running the test suite twice within the same second (routine while iterating) meant the
second run's fresh `Date.now()` could land *earlier* than the first run's synthetic
`Date.now() + 2000ms` era, which is still "the current era" as far as the persistent dev DB is
concerned — breaking the chronological-ordering check the very next run.

**Fix:** stopped deriving test dates from wall-clock time at all. The test now reads whatever
era is *actually* current in the real database first (`getCurrentBrandEra`) and builds every
synthetic date at least a minute past that (and past real `Date.now()`, for the very first run
when no era exists yet) — correctness no longer depends on how much real time elapsed between
runs, because it's anchored to the persistent DB's actual current state rather than to the
clock.

**Consequence for future sessions:** the `Date.now()`-based monotonic pattern used everywhere
else in this repo assumes real time only moves forward *and* that repeated invocations are
spaced further apart than whatever offsets the test adds — true for day-bucketed data, not
reliably true for tests that add only small (sub-few-second) offsets to "now" and might be
re-run seconds apart. For a genuinely global (not per-fresh-row) piece of state, read the real
current value and build forward from *that* instead of from the clock.

**Reversibility:** trivial — test-only change, no product code affected.

---

## 2026-09-08 — `AutonomyLevel`'s tests needed direct cleanup, not a date-based dodge

**What happened:** `AutonomyLevel` (Phase 8) is a global row per (subsystem, productionTier),
like `BrandEra` — but unlike `BrandEra`, there's no date field to build a "safely in the
future" synthetic value from at all: escalation is driven purely by a call *count*, and the
(subsystem, tier) space is a small, closed set of enum pairs (5 × 4), not something a test can
sidestep by picking a fresh, never-before-used combination. The very first version of this
test file used fixed pairs like `SCHEDULING`/`RAW` with no reset, and — predictably, given
every other instance of this bug class this session — failed on a second run because the
row's count had already crossed a threshold from the first run.

**Fix:** each test explicitly deletes its own (subsystem, tier) row (`resetAutonomyLevel`)
before asserting anything that depends on a known starting count. Verified stable across four
rapid repeated runs.

**Consequence for future sessions:** when the state under test is keyed by a small closed
enum space rather than a free-form id, neither a fresh id nor a synthetic date can create
isolation — direct `deleteMany` cleanup before the test's own writes is the only real fix,
and it should be reached for immediately rather than after discovering (again) that a
clever date/id trick doesn't apply here.

**Reversibility:** trivial — test-only, no product code affected.

---

## 2026-09-08 — Real per-call cost logging (`ModelCallLog`), computed from a live cost estimate

**What happened:** Chris asked for a rough cost calculation now that a real
`ANTHROPIC_API_KEY` was verified working. Built one grounded in the real agent roster
(`/docs/AGENT_CONTRACTS.md`), live-fetched pricing from claude.com/pricing, and the spec's
~30-videos/week volume: ~$14/week, ~$61/month, ~$0.41/video in Claude API spend at full
volume — a small fraction of the original full-stack estimate of $350–$1,300+/month (that
number also includes hosting, storage, transcription, render compute, and generative media,
none of which this figure covers). Chris then asked to make that estimate real rather than
staying a guess.

**Decision:** added `ModelCallLog` (Prisma model, migration
`20260908013333_model_call_log`) — one row per real model call, with token counts, computed
`costUsd`, latency, success/failure, and optional `contentItemId`. Logging happens via a new
decorator, `CostTrackingModelProvider` (`packages/agents/src/providers/cost-tracking-provider.ts`),
wrapping `ModelProvider` rather than being called from inside every agent file. It's wired in
at the single real instantiation point, `apps/web/lib/model-provider.ts`'s `getModelProvider()`
— every Server Action in `apps/web/app/content/[id]/actions.ts` already routes through that
one function, so this is a one-file wire-in that covers every real call in the app.
`MockModelProvider` (used by all 275 automated tests) is never wrapped — tests stay free.

Pricing itself lives in `packages/agents/src/pricing.ts` as a hardcoded snapshot (not fetched
live at request time) — a real invoice must reflect the price in effect when the call
happened, not today's price, so `costUsd` is computed once at write time and never rewritten.

**Alternatives considered:**
1. Log to `AuditLog` instead of a new table — rejected: `AuditLog`'s `before`/`after` JSON
   shape isn't built for numeric aggregation (summing cost/tokens across thousands of rows),
   and cost logging isn't really an audit-trail concern (no before/after entity state).
2. Have each agent call a logging function directly — rejected: would require touching all 18
   agent files in `packages/agents/src` for a concern orthogonal to what any agent actually
   does; the provider-decorator seam already existed structurally (every agent depends on the
   `ModelProvider` interface, never a concrete implementation) and is the correct extension
   point per the same reasoning that put `MockModelProvider` there in the first place.
3. Fetch Anthropic's pricing live at call time instead of a hardcoded table — rejected: ties
   every real agent call to an extra network dependency and makes historical cost figures
   silently drift if Anthropic changes pricing later; a versioned snapshot with a `/docs`
   changelog entry on update is simpler and matches how the repo already treats prompts/brand
   docs (new versions, not silent mutation).

**Rationality/testing:** 12 new tests (`packages/domain/src/__tests__/model-call-log.test.ts`,
`packages/agents/src/__tests__/pricing.test.ts`, `.../cost-tracking-provider.test.ts`) —
successful-call logging with correct cost, failed-call logging with null cost (never a
fabricated $0), summary aggregation across model classes, `since`-filtering, and — the "fail
safely" case — the real `completeStructured` result still returns correctly even when the
database write itself throws. Full suite: 275/275 passing, `tsc --noEmit` clean, lint clean.

**Known gap, deliberately not built here:** this is the *logging* half of §16's "cost &
latency governor," not the *enforcement* half. Nothing yet stops a real run from spending
freely — no per-job call budget, no max-reasoning-calls limit, no escalation threshold. Real
numbers now exist to build that against; the enforcement layer is future work, not silently
assumed done.

**Reversibility:** easy — additive-only (new table, new decorator, one wire-in edit). Removing
the wrapper reverts `getModelProvider()` to its pre-existing behavior with zero other changes.

---

## 2026-09-08 — Spend cap: the enforcement half of the cost & latency governor

**What happened:** immediately after building `ModelCallLog` (previous entry), Chris asked
for "a stop" — the enforcement half that entry explicitly flagged as a known gap ("nothing
yet stops a real run from spending freely").

**Decision:** `CostTrackingModelProvider` now enforces a rolling-UTC-day USD ceiling in
addition to logging. Before calling the delegate provider, it reads today's total spend
(`getModelCallCostSummary` since UTC midnight) and, if that total has already reached the cap,
throws `SpendCapExceededError` (`packages/agents/src/spend-cap.ts`) *before* the delegate is
ever invoked — a blocked call spends zero tokens, not just zero dollars logged after the fact.
The refusal is written to `AuditLog` (`MODEL_SPEND_CAP_BLOCKED`) so it's visible later. Default
cap is $30/day (`DEFAULT_DAILY_SPEND_CAP_USD`), overridable via `MODEL_SPEND_DAILY_CAP_USD`
(`.env.example`), or disabled entirely by passing `dailyCapUsd: null` to the constructor.

**Why $30/day:** the cost-calculation entry above estimated ~$14/week (~$2/day steady-state)
at full ~30-videos/week volume, but Chris plausibly batches research/scripting/editing for a
whole week's slate in a single working day — which could plausibly be the full $14 in one day.
$30/day is roughly 2x that full-week figure concentrated into one day: generous enough that a
real, even heavy, day of pipeline work shouldn't trip it, tight enough to stop a genuine
runaway (retry loop, accidental batch-of-batches) well short of real money.

**Two sub-decisions worth recording:**
1. **Fail OPEN on the cap-check read itself**, not fail closed. If reading today's spend
   fails (DB hiccup), the call is allowed through rather than blocked — a brief window with no
   cap enforcement during an outage is a better outcome for a single-operator tool than every
   real agent call breaking because the governor couldn't read its own state. This is the one
   place in this codebase where "fail safely" is interpreted as "let the primary operation
   proceed" rather than "the primary operation must never be blocked by an observability
   failure" (`ModelCallLog` writes still fail silently/best-effort, unchanged) — a deliberate,
   asymmetric choice: reads-that-gate get fail-open, writes-that-observe get best-effort.
2. **Not perfectly atomic.** The check-then-act between "read today's spend" and "record this
   call's cost" isn't transactional, so calls fired genuinely concurrently could both pass the
   check before either lands. Accepted as-is: this app drives sequential Server Actions for a
   single operator, and PGlite itself can't reliably handle concurrent queries regardless (see
   the PGlite entries above) — a precise billing gate wasn't the goal, a ceiling against
   runaway/accidental spend was.

**Alternatives considered:**
- Per-agent or per-model-class sub-budgets instead of one blunt total — rejected for now as
  more governor than a single-operator tool needs on day one; the full per-job limit list
  `/docs/ARCHITECTURE.md` §16 always named (max reasoning calls, vision passes, render
  iterations, etc.) remains explicitly un-built, logged as a known gap rather than implied
  done.
- A DB-backed, runtime-adjustable cap (mirroring the `FeatureFlag` pattern) instead of an env
  var — rejected for the same "prefer the reversible/simple choice" reasoning used throughout
  this repo's stack decisions; an env var matches how `ANTHROPIC_API_KEY` itself is already
  configured and needs no new UI to change.

**Testing:** 13 new tests across `packages/agents/src/__tests__/spend-cap.test.ts` (pure
`startOfUtcDay`/error-shape unit tests) and an expanded
`.../cost-tracking-provider.test.ts` (blocks before the delegate is called; audits the block;
allows calls under cap; `dailyCapUsd: null` disables it; a $0 cap is meaningfully different
from `null`; the existing DB-outage test now also proves the fail-open path). Full suite:
284/284 passing, `tsc --noEmit` clean, lint clean.

**Reversibility:** easy — additive-only. Passing `dailyCapUsd: null` (or deleting the options
argument's default in `apps/web/lib/model-provider.ts`) fully reverts to logging-only
behavior with no other code changes.

---

## 2026-09-08 — Home page rebuilt to spec §20: THIS WEEK / PERFORMANCE / CREATIVE DIRECTOR / NEEDS YOU

**What happened:** Home had been the literal Phase 0 "Foundation OK" status page (brand
constitution version, feature flag list, content item count) through Phases 1-8 — flagged
explicitly in an earlier gap analysis as the most visible unaddressed gap, with my own Phase 0
comment on the page noting it needed "Phase 2 + Phase 7 to mean something." Both now exist.
Chris picked this as the next priority (over Calendar or Nav consolidation) after the
cost-governor work.

**Decision:** rebuilt `apps/web/app/page.tsx` into the spec's four named sections, each backed
by real data, nothing synthesized:
- **THIS WEEK** — the current `WeeklyProgrammingThesis`'s portfolio approval count (vs. the
  spec's ~30/week target) and this calendar week's `ScheduleEntry` rows.
- **PERFORMANCE** — the 4 most recent `PerformanceEvaluation.overallSummary` rows (the
  Analytics Agent's actual judgment, not a metrics table — Analytics remains the deep-dive
  page this links out to).
- **CREATIVE DIRECTOR** — the current thesis's narrative + top risks, linking to Strategy for
  the full picture.
- **NEEDS YOU** — a new domain module, `packages/domain/src/needs-you.ts`, mapping all six of
  spec §20's named categories (subjective choice, factual nuance, unresolved QC, platform
  issue, strategy decision, uncertainty above threshold) to real, already-existing schema
  signals: `QC_BLOCKED`/`RESEARCH_BLOCKED` content states, `Publication.status === FAILED`
  (deduped so a later successful retry doesn't leave a stale entry), the current thesis's own
  `humanDecisionsNeeded`, `Belief` rows `PROPOSED` (never self-promoted — see the
  Belief-promotion entry above), and `AdversarialCritique` rows with
  `noMaterialWeaknessesFound: false`. Hard-capped (default 8) with an honest
  `totalBeforeCap` count shown as "+N more" rather than either truncating silently or dumping
  everything — spec's own words, "do not create approval fatigue," is treated as a hard
  constraint on the function's shape, not a UI nicety layered on afterward.

Also gave the page real visual craft (a small local palette, card-style sections, clear
typographic hierarchy) rather than reusing the bare inline-style/table pattern the rest of the
app still uses — Home is the entry point and the flagship "visual/UI is nowhere" complaint;
Calendar and Nav (declined for this round) still use the old pattern and will need their own
pass.

**Alternatives considered:**
- Infer "subjective choice" from something looser (e.g. any `READY` item awaiting a schedule
  decision) — rejected: that's normal production flow, not a genuine judgment call, and would
  have reintroduced approval fatigue through the back door.
- Build a `NeedsYouEntry` database table instead of a computed query — rejected: every
  underlying signal already has a durable home (ContentState, Publication, Belief,
  AdversarialCritique); persisting a derived view would be one more thing to keep in sync for
  no real benefit at this data volume.

**Testing:** 7 new tests (`packages/domain/src/__tests__/needs-you.test.ts`) — one per
category's mapping correctness, the FAILED-publication supersession-by-retry case, and the
cap/`totalBeforeCap` behavior. Full suite: 291/291 passing, `tsc --noEmit` clean, lint clean.
Live-verified against the real running dev server with a real authenticated session (not just
tests): all four section headers render, real data flows through every section, and the NEEDS
YOU cap correctly reduced 343 real accumulated signals (mostly leftover test fixtures in the
shared dev DB) down to 8 shown + an honest "+335 more" — the exact scenario the cap exists for.

**Reversibility:** easy — `needs-you.ts` is additive (new file, new export), and `page.tsx`'s
previous version is fully recoverable from git history / this entry if ever needed.

---

## 2026-09-08 — Full visual redesign + a real, unrelated bug class it surfaced (unbounded list pages)

**What happened:** Chris asked for a full visual pass across the entire app — "Apple-level of
premium," deep contrast, color, blur, intuitive flow — and asked specifically that it be
verified visually (screenshots), not just by reading the code.

**Decision — design system:** added Tailwind CSS v4 to `apps/web` (`postcss.config.mjs`,
`app/globals.css`) as the styling layer, replacing the ad hoc inline-`style` objects every
page had used since Phase 0/1. `globals.css` defines the actual design tokens via `@theme`
(near-black ground, a warm gold + cool violet duotone accent pair, glass-panel/badge/button
component classes) and a fixed `.ambient-field` (two large blurred radial-gradient orbs behind
the page — the "Apple keynote" ambient-color treatment). `app/components/ui.tsx` is the shared
primitive set (`PageShell`, `Panel`, `SectionHeading`, `Badge`, `Button`/`ButtonLink`,
`EmptyState`, `contentStateTone`) every page composes from, rather than each page reinventing
its own box/table styling. Every page in the app was rebuilt against this system: Home (this
session's earlier entry), Login, Calendar, Content (list + detail), Ideas, Strategy,
Reference (list + detail), Analytics, Learnings, and the NavBar (redesigned as a sticky glass
bar with active-link highlighting).

**A real bug found along the way:** `NavBar`'s active-link highlight needs `usePathname`
(client-only), split into a separate `NavLinks.tsx` client component wrapped in `Suspense`
inside the server `NavBar.tsx` (`usePathname` requires a Suspense boundary on dynamic routes
like `/content/[id]`, or the whole page silently CSR-bails-out). The first version exported the
link data (`NAV_LINKS`) from the `"use client"` file for the server fallback to reuse — this
does not work: every export of a `"use client"` module becomes an opaque client reference
across the RSC boundary, not just its component exports, so the server component's
`NAV_LINKS.map` crashed with `TypeError: NAV_LINKS.map is not a function`. Fixed by moving
`NAV_LINKS` into its own plain (non-`"use client"`) data file both components import. Found by
actually loading the page (`500` in the dev server log), not by inspection — this class of bug
doesn't show up in `tsc --noEmit`.

**A second, more significant thing the screenshots found:** several list pages
(Content: 307,132px tall; Ideas: 83,857px; Analytics: 38,560px; Calendar: 43,149px; Reference:
13,404px; Learnings: 17,772px) rendered every row of an unbounded `findMany` against the real
dev DB, which — after many sessions' worth of `pnpm test` runs — has thousands of accumulated
test rows (`ContentItem`: 4,698; `ScheduleEntry`: many on one date; `ReferenceCreator`: 184;
`AudienceInsight`: 33; etc.). This is dev-only pollution, not production data, but it exposed a
real, structural flaw: **none of these pages had ever been bounded** — the same "do not create
approval fatigue" principle already load-bearing for Home's `NEEDS YOU` queue had never been
applied to any list page. Fixed at the domain layer, not just the UI: added an optional
`limit` (and a paired `count*` function) to `listContentItems`, `listReferenceCreators`,
`listEvidenceEntries`, `listBrandEras`, `listExperiments`, `listTasteFeedback`, `listBeliefs`,
and `listAudienceInsights` — all additive (`limit` undefined = unlimited, the exact prior
behavior, so no existing caller or test needed to change). Every affected page now queries with
a real `take` (not fetch-everything-then-`.slice()`) and shows an honest "showing N of TOTAL"
line rather than either silently truncating or fetching rows nobody will scroll to. Calendar
additionally windows by date (7 days back / 30 days ahead) and caps entries per day (12),
since its problem was one date with 668+ entries, not many dates. Post-fix heights: Content
3,650px, Ideas 2,704px, Analytics 4,053px (after also fixing an unbounded `listAudienceInsights`
call and scoping the snapshot-count `groupBy` to only the rendered items), Calendar 3,103px,
Reference 3,287px, Learnings 7,747px (legitimately dense — 7 real sections plus a fixed
20-row autonomy table, not pollution).

**Verification:** typecheck clean, lint clean, full suite 291/291 passing (one flaky,
order-dependent pre-existing failure on a single rerun, confirmed unrelated by a clean rerun —
see the repeated test-flakiness pattern logged earlier in this file), and a real production
`next build` succeeds. Visually verified via Playwright screenshots of every real page against
the live dev server through a real authenticated session (not just curl/grep) — caught both
bugs above this way, plus one purely cosmetic issue (a Creative-Director panel on Home had
visible dead space from CSS Grid's `align-items: stretch` matching its shorter sibling's
height with nothing to fill it — fixed by making `Panel` a flex column and anchoring the
panel's trailing link to the bottom with `mt-auto` instead of leaving it floating after the
text).

**Alternatives considered:**
- Hand-rolled CSS custom properties + inline `style` objects (the pre-existing pattern),
  scaled up — rejected: correctly applying consistent blur/gradient/spacing tokens across 12
  pages by hand is slow and error-prone compared to a utility-class system; Tailwind v4's
  CSS-first `@theme` config keeps the actual token values in one file either way.
- Truncating each list to a fixed number without a real `count()` or `take` — rejected: still
  fetches every row from the database only to throw most of them away in the UI, which is real
  wasted DB work at the row counts observed here (thousands), not just a rendering cost.

**Reversibility:** the design system is additive infrastructure (new CSS/config files, a new
shared component module) — reverting individual pages to their pre-redesign markup is a
straightforward per-file revert with no schema or domain-logic dependency. The `limit`
parameters on domain list functions are additive and backward-compatible; removing them only
restores the pre-fix (unbounded) behavior.

---

## 2026-09-08 — Calendar rebuilt for real: week grid, time slots, manual placement, and the orphaned Scheduler Agent finally wired up

**What happened:** Chris pushed back on the previous Calendar pass — it was still fundamentally
a flat date-grouped list with a visual coat of paint, not what spec §9 step 19 ("Auto-Fill
Week") or §20 (Calendar as one of five primary nav destinations) actually describe. He asked
for a full analysis of what Calendar is supposed to look and act like, not just another visual
pass.

**The analysis, in short:**
- Spec §9 step 19: "Auto-Fill Week — schedule coherently using topic spacing, format spacing,
  tone, funnel role, experiments, newsletter timing, platform evidence, and content expiry."
  This is a real scheduling *algorithm*, not just a UI. `packages/agents/src/scheduler-agent.ts`
  (`runSchedulerAgent`) has implemented this since an earlier phase — real prompt, real typed
  output (`ScheduleProposalItemSchema`: contentItemId, platforms[], scheduledDate, reasoning) —
  but **had zero callers anywhere in `apps/**`**. Nothing in the running app ever invoked it.
  That's the literal answer to "where is the importing": it existed in the codebase, wired to
  nothing.
- `ScheduleEntry.scheduledDate` is a real `DateTime` (date *and* time), and
  `scheduleContentItemForPublishing` (the real, gated publish-path scheduler, distinct from
  Phase 1's ungated `setScheduleEntry`) already persists it correctly, transitioning
  `READY -> SCHEDULED`. So "where are the saved on the backend" was already true — the gap was
  entirely on the *reading and placing* side: the UI only ever showed a flat list group by date
  string, never a real week grid, and there was no way to place or move an item onto the
  calendar from the calendar itself — only from a plain date/time input buried on each content
  item's own page.
- "Where are the days of the week with the certain scheduled time slots" — there was no grid at
  all, just day-labeled sections in a single vertical column with no time-of-day structure
  beyond the timestamp already sitting unused in the data.

**Decision — what was actually built:**
1. **Real week grid.** 7 day columns (Mon-Sun), `?week=YYYY-MM-DD` navigation (Prev/Today/Next),
   each entry shows its real time-of-day, not just its date. Structurally bounded to one week's
   data per view (the actual fix for the earlier 43,000px-tall page — a week grid can't grow
   unbounded the way a flat list could, not a band-aid cap layered on top).
2. **`runAutoFillWeek`** (`apps/web/app/calendar/actions.ts`) — the real caller
   `runSchedulerAgent` never had. Gathers the real unscheduled-READY pool
   (`listUnscheduledReadyItems`, new), real recent scheduling history, and real YouTube quota
   state (`getYouTubeQuotaState`, already existed) into the agent's actual input contract, then
   persists every returned proposal through the same `scheduleContentItemForPublishing` a
   manual placement uses — no separate, less-gated write path for AI-driven scheduling.
   Requires `ANTHROPIC_API_KEY`, same UX convention as every other AI-pipeline step in the app.
3. **Manual placement and reschedule directly from the grid.** Each day has a "+ Add"
   (`<details>`-based progressive disclosure, zero client JS/libraries) to place any
   unscheduled READY item onto that day at a chosen time/platforms, and each existing entry
   expands into a reschedule form pre-filled with its current date/platforms. Both call one
   Server Action, `placeOnCalendar`, which is exactly `scheduleContentItemForPublishing` under
   the hood.
4. **`scheduleContentItemForPublishing` extended to support rescheduling.** It previously only
   accepted `READY` (the initial placement); calling it again on an already-`SCHEDULED` item
   threw `ScheduleForPublishingRequiresReadyStateError`. There was no legal path to move an
   already-scheduled item to a new slot at all. Now: `READY` still transitions to `SCHEDULED`
   (audited via `ContentStateTransition`, as before); `SCHEDULED` just updates the existing
   entry's date/platforms with no re-transition (a real move, not a fake state change), audited
   via a new `SCHEDULE_RESCHEDULED` `AuditLog` action. Every other state is still rejected.
5. **`listUnscheduledReadyItems`** (new) — the actual pool both Auto-Fill Week and the manual
   "+ Add" dropdown draw from: every `READY` item (all hard gates already passed) with no
   `ScheduleEntry` yet.

**A real bug caught before it shipped:** the first draft of `runAutoFillWeek` called
`redirect()` from inside its own `try` block on the early-return "nothing to place" path — the
exact same bug class as the `tryAutonomousPublishAction` entry above (Next's `redirect()` works
by throwing, so it would have been caught by the function's own `catch` and misreported as a
failure). Fixed by capturing an `errorMessage` variable through the try/catch and calling
`redirect()` exactly once, after it fully resolves — in both `placeOnCalendar` and
`runAutoFillWeek`.

**A real type fix along the way:** `recordAudit` only accepted a top-level `PrismaClient`, so
calling it from inside `scheduleContentItemForPublishing`'s `prisma.$transaction(async (tx) =>
...)` (needed for the new `SCHEDULE_RESCHEDULED` audit entry to be part of the same
transaction) failed to typecheck — `tx` is a `Prisma.TransactionClient`, missing
`$connect`/`$disconnect`/etc. Widened `recordAudit`'s parameter type to
`PrismaClient | Prisma.TransactionClient`, the same `Db` union `writeTransition` in
`state-machine.ts` already used for exactly this reason.

**Verification:** 4 new domain tests (`listUnscheduledReadyItems`'s three inclusion/exclusion
cases, the reschedule-without-retransition case with an explicit assertion that no new
`ContentStateTransition` row was written) — full suite 295/295 passing, `tsc --noEmit` clean,
lint clean, a real production `next build` succeeds. Live-verified beyond just screenshots:
scripted a real Playwright session that opened a day's "+ Add," selected a real unscheduled
item, submitted, did a **fresh, independent page load** (not trusting the submitting page's own
post-redirect DOM state — an earlier, less careful version of this check was fooled by a stale
`<details>` render), and confirmed the target day's entry count actually increased by one with
the correct item. Auto-Fill Week itself was not exercised live in this pass (it spends real
API tokens per the cost-cap work above) — verified by type-correctness and matching the agent's
actual input/output contracts instead.

**Alternatives considered:**
- Real drag-and-drop between days — rejected for this pass: would require introducing a
  client-side drag library and converting large parts of a server-rendered page into a
  client component, a much bigger architectural change than the mechanics gap itself called
  for. Click-to-open, pick-a-slot via `<details>` achieves the same real mechanic (place/move
  an item onto a specific day+time) with zero new dependencies and no client/server boundary
  restructuring — revisit drag-and-drop only if this proves genuinely too slow to use.
- Confining Auto-Fill Week's placements to strictly the currently-viewed week — rejected: the
  Scheduler Agent's own judgment (topic spacing, content expiry, etc.) may reasonably want to
  place an item further out; constraining it to one week would fight the agent's actual job.
  The button's copy is honest about this ("places every unscheduled READY item," not "fills
  just this week").

**Reversibility:** additive throughout — `listUnscheduledReadyItems` and the widened
`recordAudit` signature don't change any existing caller's behavior; the `scheduleContentItemForPublishing`
SCHEDULED-state branch only adds a previously-impossible code path. Reverting the Calendar page
to the flat-list version is a straightforward file revert with no schema dependency.

---

## 2026-09-08 — Correction: Calendar's week navigation was actually broken (both directions)

**What happened:** Chris reported "previous button does work but next does not" immediately
after the Calendar rebuild above. Investigated by directly comparing what each button's
generated `href` actually rendered (via `curl` against the real dev server, then confirmed
through real Playwright clicks) rather than reasoning about the code in the abstract — the
same discipline this whole build has used throughout, applied to a bug report instead of a new
feature.

**Root cause:** the page's `week` query param round-trip had a UTC/local timezone mismatch.
Writing the param used `date.toISOString().slice(0, 10)` (UTC serialization) on a Date that
was always local midnight; reading it back used `new Date(paramString)`, which the ECMAScript
spec parses a date-only string as **UTC midnight**, then fed straight into `mondayOf()`, which
reads it with *local* getters (`getDay`, `getFullYear`, `getMonth`, `getDate`). This server
runs in PDT (UTC-7). Requesting `?week=2026-08-31` — Prev's own generated target — rendered
"Week of August 24": the UTC-midnight instant for Aug 31 is 5pm PDT on Aug 30 (a Sunday), and
`mondayOf` walked that back another 6 days to Aug 24. **Both buttons were broken** — Next's
error happened to look like "nothing happens" (the miscalculation round-tripped back near the
starting week), Prev's looked like it worked because it visibly moved, just to the wrong week
Chris hadn't necessarily checked against.

**Fix:** replaced the UTC-touching read/write pair with two functions that never leave local
time — `toWeekParam` formats a Date's local Y/M/D directly (no `.toISOString()`), and
`parseWeekParam` constructs a local Date directly from a regex-parsed Y/M/D (no `new
Date(string)`), rejecting anything that doesn't round-trip to the exact date requested (catches
JS Date's silent month/day-overflow rollover too — e.g. month 13 quietly becoming January of
the following year). Pulled all four date helpers (`mondayOf`, `toWeekParam`, `parseWeekParam`,
`toDatetimeLocal`) out of the page component into `apps/web/lib/calendar-week.ts` specifically
so they're unit-testable — a page component's local helpers can't be imported by a test file,
which is exactly why this class of bug had no regression test to catch it the first time.
Widened `vitest.config.ts`'s include glob to `apps/*/lib/**/*.test.ts` (this app has no `src/`
directory, so the existing `apps/*/src/**/*.test.ts` pattern silently matched nothing here).

**Verification:** 9 new tests in `apps/web/lib/calendar-week.test.ts`, including the literal
reported scenario (`parseWeekParam("2026-09-14")` must round-trip back to
`"2026-09-14"` after `mondayOf`, and the same for `"2026-08-31"`), a 4-hop chained-Next
simulation, and the month-overflow rejection case — run in this process's *actual* timezone,
not a hardcoded one, since the bug was timezone-dependent and a test that only passed by
coincidence in UTC wouldn't have caught it. 304/304 full suite passing, `tsc --noEmit` clean,
lint clean, production `next build` succeeds. Re-verified live: `curl` against the exact URLs
both buttons generate now returns the correct week for each, chained 6 hops deep; a real
Playwright browser session clicking Next → Next → Prev now shows September 14 → 21 → 14, not
the stuck/wrong-week behavior from the bug report.

**Reversibility:** trivial — pure function extraction plus a bug fix, no schema or API surface
changed.

---

# 2026-10-16 — "Usable v1" pass (branch `fix/usable-v1`)

Entries below were written by four parallel workstreams (integration, media, platforms, AI layer) with disjoint file ownership, then merged. Evidence frames: `docs/evidence/2026-10-16-usable-v1/`.

## 2026-10-16 — Full audit; "Phases 0–8 complete" did not mean "usable"

**What happened:** a deep audit (5 parallel reviews + hands-on verification: fresh-DB test run,
production build, a real Anthropic call, a real ffmpeg render inspected frame-by-frame, live
HTTP against the Vercel deployment) found the suite green (304/304) but the product not
usable for real work: uploads capped at 1 MB, every AI action broken on Vercel (prompts not
shipped), a one-click bypass of all four hard gates that could then genuinely publish, Claims
Gate never seeing the final script, no transcription, Instagram publishing hardcoded to fail,
no scheduler of any kind, and a test suite that mutated the dev database's safety state.

**Decision:** a "usable v1" pass (branch `fix/usable-v1`) fixing those, split into four
parallel workstreams with disjoint file ownership (media / platforms / AI layer / web +
domain integration). Each workstream's own decisions follow below or in the merged entries.

**Reversibility:** each fix is its own commit on the branch.

---

## 2026-10-16 — Tests get their own throwaway database

**Problem:** `pnpm test` ran against the same dev DB the app used (vitest.setup loaded
`.env`'s `DATABASE_URL`). Tests legitimately reset global tables, so one test run turned the
`autonomy.shadow_only` kill switch OFF, left PUBLISHING autonomy at level 3–4 for RAW/FAST/
MEDIUM (unearned), deleted every WeeklyProgrammingThesis, and left thousands of junk rows.
After any test run, "Try autonomous publish" would really have published.

**Decision:** `vitest.global-setup.ts` starts a fresh PGlite instance in a temp dir on a free
port per run, applies the real migration history (`prisma migrate deploy`) and the real seed,
injects that URL into every test file (`vitest.setup.ts` overwrites `DATABASE_URL` before any
import), and deletes the dir afterwards. `ANTHROPIC_API_KEY` is deleted inside tests so a
billed call is impossible, not just unlikely. Migrate/seed run via async `execFile` — the DB
server lives in the same process, so a blocking `execFileSync` deadlocks it.

**Alternatives:** a second long-lived "test" PGlite (state still accumulates); per-test
transaction rollback (doesn't cover code that opens its own transactions).

**Reversibility:** trivial — revert the three vitest files.

---

## 2026-10-16 — Local dev DB corrupted by an unclean shutdown

`packages/domain/.pglite` no longer opened (PGlite `RuntimeError: Aborted()` on start, stale
`postmaster.pid`); a fresh PGlite opened fine, so the data dir itself was damaged. It was
moved (not deleted) to `packages/domain/.pglite-corrupted-2026-10-16/` and a fresh dev DB was
migrated + seeded (same seed user). `scripts/dev-db.mjs` now closes cleanly on SIGTERM/SIGHUP
too (it only handled SIGINT — a closing terminal/IDE task sends SIGTERM).

---

## 2026-10-16 — Manual transitions are an explicit allowlist

**Problem:** the content page rendered a generic "→ {next state}" button (`advanceStub`) for
nearly every state. One click took RENDERED → READY with no Quality Gate, preflight never
checked for a passing QCReport, so the ungated render could be scheduled and really published
— the exact "a BLOCK is never averaged away" violation CLAUDE.md forbids. Same for
RESEARCHING → RESEARCHED (skipping Claims Gate), PUBLISHING → PUBLISHED (no Publication row),
MEASURING → ARCHIVED, etc.

**Decision:** `packages/domain/src/manual-transition.ts` — `MANUAL_TRANSITIONS` lists the only
bare-button transitions: facts only Chris can attest to (CONTRACTED → RESEARCHING "Start
research", READY_TO_FILM → FILMED "I've filmed this") and the two documented rollbacks.
`applyManualTransition` rejects anything else (`ManualTransitionNotAllowedError`); the web
action and page use it. A test asserts no manual path exists into READY, PUBLISHED,
PUBLISHING, RESEARCHED, SCRIPTED, RENDERED, SCHEDULED or ARCHIVED. Preflight additionally
requires a passing QCReport (platforms workstream) — defense in depth.

**Reversibility:** add a row to the allowlist.

---

## 2026-10-16 — FACTUAL gate fails closed

**Problem:** `quality-gate-job.ts` returned FACTUAL = PASS whenever no Claims Gate verdict
existed (`result === "BLOCK" ? "BLOCK" : "PASS"`).

**Decision:** prefer the verdict on the final script (`ScriptVersion.scriptClaimsGateResult`,
AI workstream), fall back to the research-packet verdict, and BLOCK when neither exists —
except when the contract explicitly declares no factual surface (`researchDepth = NONE` and
`factualRisk = LOW`). Regression test included.

---

## 2026-10-16 — Repair loop: revised plans share one repair budget

**Problem:** QC_REPAIR could only re-render the identical EditPlan (`recordEditPlan` required
TAKE_SELECTED), so "Render again" produced the same defect until QC_BLOCKED; QCIssue
`recommendedRepair` was stored and never used. Attempts were counted per EditPlan, so any
future "new plan" fix would also have reset the budget.

**Decision:** `recordReplannedEditPlan` (EDIT_PLANNED or QC_REPAIR, no state change, append-
only, audited) with `revisionOfEditPlanId` + `revisionReason`. Render attempts are counted
across the whole repair chain (`getRepairChainEditPlanIds`), so automated revisions share
`MAX_REPAIR_ATTEMPTS`; a human re-plan (`revisionOfEditPlanId: null`, e.g. after the
QC_BLOCKED → EDIT_PLANNED rollback) deliberately starts a fresh chain. The automated
EDIT → RENDER → INSPECT → FIX loop itself lives in the worker (`auto-repair-job`).

---

## 2026-10-16 — Uploads: streaming locally, browser-direct to Blob in production

**Problem:** uploads went through a Server Action — Next's default 1 MB body limit rejected
every real phone video (verified: 4.6 MB → "Body exceeded 1 MB limit"); even raised, Vercel
caps function request bodies at 4.5 MB, and the whole file was buffered in memory.

**Decision:**
- Local mode: `PUT /api/upload` streams the raw request body to a temp file, `putFile`s it
  into local storage (no buffering), runs ffprobe. Verified with a real 100 MB / 40 s file
  over HTTP: stored, analyzed, FILMED → MEDIA_INGESTED.
- Blob mode: the browser uploads directly to the private Blob store (`@vercel/blob/client`
  `upload()`, token from `POST /api/blob-upload`, restricted to signed-in users, `raw/<id>/…`
  pathnames, video/audio types, ≤5 GB; multipart above 50 MB), then calls the
  `registerBlobUpload` server action, which streams the blob to a temp file for ffprobe and
  records the MediaAsset. Not an upload-completed webhook: that can't reach a local server.
- `RawTakeUploader` client component picks the transport, supports several files, shows
  progress. Filenames are sanitized before they touch a storage key or temp path.

---

## 2026-10-16 — Production storage: private Vercel Blob + presigned URLs

**Decision:** `apps/web/lib/storage.ts` selects `VercelBlobStorageAdapter` whenever
`BLOB_READ_WRITE_TOKEN` is set, else `LocalFsStorageAdapter`. The Blob store is **private**;
`signedUrl()` is a real presigned GET (`issueSignedToken` + `presignUrl`, one pathname,
expiring) — finally the "real signed URLs" SECURITY.md promised. `/api/media` redirects to a
10-minute presigned URL in blob mode (proxying video through a function would hit response
limits) and streams from disk with HTTP Range support locally (seekable `<video>`).
`getPublicVideoUrl(key)` returns a 2-hour presigned URL — what Instagram's Content Publishing
API needs to fetch a Reel — or null locally (Instagram then fails with a clear reason).
Adapter lives in apps/web (not packages/media) so the shared StorageAdapter interface didn't
change. Also fixed: `LocalFsStorageAdapter`'s traversal check was a bare prefix match that
let a sibling dir like `.storage-x/` through.

**Owner action:** create a Blob store (private) in the Vercel project; that sets
`BLOB_READ_WRITE_TOKEN` automatically.

---

## 2026-10-16 — Deploy: ship runtime-read files explicitly

**Problem:** the prompt registry reads `/prompts/**` with `readdirSync`/`readFileSync` at call
time; Next's file tracer can't see that, so the deployed functions contained 0 prompt files
and every AI action on Vercel would have thrown ENOENT.

**Decision:** `outputFileTracingRoot` = repo root and `outputFileTracingIncludes` for
`prompts/**/*.md`, `brand/**/*.md`, `packages/media/assets/**` on every route. Verified in
the build's `.nft.json` (25/25 prompts, 2/2 brand docs) and by reading Turbopack's runtime:
`import.meta.url` in bundled packages resolves against the tracing root, so the existing
relative path math finds the shipped files. `maxDuration = 300` on every page whose Server
Actions run model calls or ffmpeg.

---

## 2026-10-16 — App time zone

**Problem:** schedule times come from `<input type="datetime-local">` parsed with
`new Date(...)` in the server's zone — UTC on Vercel — so "7 PM" was stored as 7 PM UTC; the
calendar's day grouping and time displays had the same assumption.

**Decision:** `apps/web/instrumentation.ts` sets `process.env.TZ` from `APP_TIMEZONE` (default
`America/Los_Angeles`) once at server start (Vercel reserves the `TZ` env var itself; a
runtime assignment re-points Node's Date everywhere). One fix for every call site instead of
threading a zone through a dozen. Also adds structured `onRequestError` logging.

---

## 2026-10-16 — Content list grouped by stage, as a to-do list

`CONTENT_STAGES` / `NEXT_STEP` (domain, pure data) map the 24 states onto 7 stages and say
who moves each item next ("You" vs system). `/content` shows stage tabs with counts and the
next step per row, instead of 50 undifferentiated rows.


---

## 2026-10-16 — Overlay text goes through drawtext `textfile=` + `expansion=none`, not inline `text=`

**Decision:** every overlay line is written to its own temp UTF-8 file and drawn with
`drawtext=textfile='…':expansion=none`. `sanitizeDrawtextValue` is deleted. Only file paths
(developer-controlled) are escaped for the filtergraph; untrusted text never enters it.

**Bug fixed (verified):** `sanitizeDrawtextValue` didn't escape `%`, so "Save 50% more" made
drawtext log `Stray %` and draw *nothing* while ffmpeg still exited 0. It also rewrote `:` to
`–` and stripped commas, semicolons and brackets.

**Alternatives:** (a) better escaping of inline `text=`, rejected: ffmpeg's nested quoting
plus `%{}` expansion is fragile, and getting it wrong lets text inject into the filtergraph;
(b) render all text through libass, rejected for overlays because drawtext + our own
font-metric layout gives exact pixel rects that the collision and safe-zone code can reason
about.

**Regression tests:** `render-pipeline.test.ts` renders `Save 50% more: "don't" [yes], ok;
café \ naïve`. It asserts no ffmpeg warnings (no `Stray %`), that the laid-out text equals the
input byte-for-byte, and that the measured **ink width of each rendered line** matches the
font-metric width of the full line (a dropped glyph makes the line measurably narrower).
A NUMBER_CALLOUT of just "50%" must put ink in its rect.

**Reversibility:** high.

---

## 2026-10-16 — Bundled Inter (OFL) fonts; missing font is a hard error

**Decision:** ship Inter 4.1 static TTFs in `packages/media/assets/fonts/`
(`Inter-SemiBold`, `InterDisplay-Bold`, `InterDisplay-ExtraBold`, about 1.2 MB total). They
come from the official rsms/inter GitHub release, and the OFL license sits at
`packages/media/assets/Inter-OFL-LICENSE.txt`. It lives outside `fonts/` because libass tries
to load every file in its `fontsdir`. `resolveBundledFontPath()`, `resolveBundledFontsDir()`
and `DEFAULT_FONT_PATH` are exported from `@chris/media`. `renderVideo` now **throws
`RenderFontNotFoundError`** if a given `fontPath` doesn't exist, or if any bundled weight is
missing. Before this, ffmpeg silently substituted a random fontconfig font and exited 0.

`RenderInstructions.fontPath` is now optional. Omitted, or pointing at a bundled file, each
overlay style uses its own bundled weight. Any other existing path is used for all overlays,
as an explicit brand-font override.

**Alternatives:** `@fontsource*` packages ship WOFF2 only. FreeType reads WOFF2 only when
built with brotli, which we can't assume of a static ffmpeg, so we use TTF. DejaVu Sans was
also considered; Inter reads as more premium and has proper display cuts.

**Font discovery** order: `RENDER_FONTS_DIR` env, then a path relative to the module
(`import.meta.url`), then a walk up from `cwd`. The cwd walk exists because Next's server
bundling rewrites `import.meta.url`, the same bug class as the ffmpeg-static `__dirname` entry.

**Reversibility:** high. Replace the TTFs or set `RENDER_FONTS_DIR`.

---

## 2026-10-16 — Deterministic text layout: font-metric wrapping, auto-shrink, per-style presets, safe zones

**Decision:**
- Text is measured with `opentype.js` (pure JS) reading the same TTF that drawtext renders.
  ffmpeg 6's drawtext does no shaping or GPOS kerning, so summed advances match the screen.
  A 4% margin absorbs FreeType's per-glyph rounding.
- Wrapping is greedy and then balanced (no orphan last line). Font size shrinks in steps of
  about 6% down to a per-style minimum to respect max lines. Text is **never truncated**: a
  word too wide for a line is hard-broken by character.
- Multi-line blocks use one drawtext per line with `y=<baseline>-ascent`, so baselines are
  exact whatever glyphs a line contains.
- Styles (`OVERLAY_STYLE_PRESETS`) are restrained by design: one family, one accent colour
  (`#FFD84D`), flat translucent plates.
  - HEADLINE: Inter Display Bold, 78→50 px, ≤3 lines, black@0.58 plate.
  - CAPTION: Inter SemiBold, 54→40 px, black@0.48 plate.
  - NUMBER_CALLOUT: Inter Display ExtraBold, 170→92 px, accent colour, outline + soft shadow,
    no plate.
  - LOWER_THIRD: Inter SemiBold, 46→36 px, left-aligned, black@0.62 plate with an accent bar.
- Safe zones (`SAFE_ZONE_9X16_REFERENCE`, `getSafeArea()`): on a 1080×1920 canvas, top 250,
  bottom 420, right 140 and left 60 px are off limits, scaled for other 9:16 sizes. Landscape
  canvases get a 5% margin. Centred blocks are at most `2·min(540−60, 940−540)` = 800 px wide.
  Every block is clamped inside the safe area.

**Alternatives:** an average char-width heuristic was rejected as less accurate, and real
metrics only cost about 170 KB of JS. Rasterising text in JS (canvas/sharp) was rejected as a
heavier dependency for no gain.

**Reversibility:** high. The presets are data.

---

## 2026-10-16 — Word-level burned-in captions via libass (`ass` filter)

**Decision:** the bundled ffmpeg-static 6.0 has `--enable-libass`, so captions are generated
as an ASS script and burned in with `ass=filename=…:fontsdir=<bundled fonts>`. The pipeline:

1. Source-timeline words are remapped through the kept segments
   (`remapWordsToOutputTimeline`). Words in cut regions are dropped. Partially cut words are
   kept only if at least 50% or at least 0.12 s survives.
2. `buildCaptionChunks` makes 2–4-word phrases. It breaks on sentence or clause punctuation,
   on pauses over 0.35 s, and at a per-preset char limit. It merges orphan words, bridges gaps
   under 0.3 s, and enforces at least 0.45 s on screen without overlap.
3. `layoutCaptionChunks` pre-wraps lines with real metrics (`WrapStyle: 2`), so libass draws
   exactly what the layout computed.
4. Each chunk is placed with `\an2\pos()`.

Presets: `CLEAN` (Inter Display Bold, white, soft outline) and `BOLD_HIGHLIGHT` (Inter Display
ExtraBold, one event per word with the spoken word in the accent colour). Positions: `LOWER`
(bottom just above the bottom safe zone) and `CENTER`.

**Collision avoidance:** the renderer lays out overlays first. A caption phrase whose rect
would intersect a time-overlapping overlay is moved above that overlay, or below it, or to the
other caption band, whichever is first to fit inside the safe area without collision. Any
residual collision is reported in `unexecutedInstructions`. The new
`checkCaptionOverlayCollisions()` in `overlay-collision.ts` runs the exact same layout, so QC
sees only real residual collisions.

**Text safety:** in caption text, `{`/`}` become `(`/`)` and `\` becomes `/`, so ASS override
syntax can't be injected. This is a tiny, documented fidelity loss for characters that
essentially never occur in speech.

**Defaults:** an EditPlan with `captions: null` (incl. every row persisted before this change)
renders captions on, `CLEAN`, `LOWER` whenever the take has word timings. An explicit
`{enabled:false}` is respected.

**Alternatives:** one drawtext per chunk with `enable=between()` was rejected: no per-word
highlight, and hundreds of filters for a 60 s video.

**Reversibility:** high.

---

## 2026-10-16 — Punch-ins: split-trim-crop-concat (hard jump zooms)

**Decision:** `punchIns: [{startSeconds,endSeconds,zoom 1.0–1.3,focus CENTER|UPPER_THIRD}]`
on the output timeline. The renderer splits the concatenated video into pieces at the punch-in
boundaries and frames each piece with a **static crop in source pixels**:
`crop=min(iw,ih·W/H)/z × …`, then `scale=W:H:flags=lanczos`. The pieces are then
concatenated (video only; audio is untouched).

Zoom 1.0 is exactly the old cover-crop. Because the crop happens in source resolution, a
punch-in re-samples the original footage rather than upscaling an already-upscaled frame.
UPPER_THIRD centres the crop at 38% height to keep the face in frame.

Overlapping, out-of-range or sub-0.2 s punch-ins are skipped or clamped and listed in
`unexecutedInstructions`. The schema also enforces zoom 1.0–1.3.

**Alternatives:** `zoompan` was rejected. It is built for stills, has frame-rate/duration
pitfalls on video, and adds jitter. Per-frame `scale eval=frame` was rejected because
mid-stream size changes are fragile. Animated (eased) zooms are deferred: hard punch-ins are
the standard talking-head grammar and carry zero artifact risk.

**Test:** pixel diff vs a no-punch-in render is large inside the window and below 3 outside
it; output stays 1080×1920 at the right duration.

**Reversibility:** high.

---

## 2026-10-16 — Unexecuted EditPlan instructions are surfaced, and the planner is told the truth

**Decision:** `bRollRequests`, `musicTrack`, `sfxEvents` and `transitions` stay in the schema
for forward compatibility. They are now `.describe()`d as "NOT YET EXECUTED — leave empty",
and the Edit Planner prompt (v1.1.0) lists exactly what the renderer executes.
`listUnexecutedPlanInstructions(plan)` (worker) plus `RenderResult.unexecutedInstructions`
(renderer: skipped punch-ins, captions with no word timings, residual caption collisions) are
merged and stored **inside `Render.technicalQCReport`** under
`unexecutedInstructions` (plus `captions.rendered` / `captions.relocatedAroundOverlays`). They
are also returned on `RenderJobResult.unexecutedInstructions`. No schema change:
`technicalQCReport` is Json, and `overall`/`checks` keep their shape.

**Reversibility:** high.

---

## 2026-10-16 — Technical QC: EBU R128 loudness, true peak, blackdetect, freezedetect

**Decision:** the `volumedetect` dBFS sanity check is replaced by a single ffmpeg analysis
pass: `ebur128=peak=true` on audio, and `blackdetect=d=0.2:pix_th=0.10,freezedetect=n=0.003:d=1`
on video.

| Check | Rule | Severity |
|---|---|---|
| `integrated_loudness` | Integrated loudness must be within −24…−8 LUFS (target −14) | FAIL |
| `true_peak` | True peak must be ≤ −0.5 dBTP | FAIL |
| `black_frames` | Opening black ≥ 0.3 s, or any black stretch ≥ 1.0 s | FAIL |
| `black_frames_short` | A 0.5–1.0 s black stretch | WARN |
| `frozen_video` | A freeze ≥ 2 s | WARN, never FAIL |

Freezes are WARN only because a deliberate held frame (chart, still) is legitimate, and
telling it from a stuck decoder is Visual QA's semantic job.

`loudnorm` in the renderer now targets I=−14 (was −16), matching the QC target. On the demo
render: −14.4 LUFS, −1.4 dBTP.

**Shape compatibility:** `TechnicalQCReport` is still `{overall: "PASS"|"FAIL", checks}`. Checks
gain an optional `severity` (absent = FAIL). New optional fields `warnings` and `measurements`
are added. Only FAIL-severity failures make `overall` FAIL, so render-record's
`qc.overall === "FAIL"` logic is unchanged.

**Reversibility:** high. Thresholds are exported constants.

---

## 2026-10-16 — Real transcription: local Whisper via transformers.js (zero credentials)

**Decision:** `LocalWhisperTranscriptionProvider` lives in `@chris/media/transcription`. It is
a **subpath export**, so importing `@chris/media` never loads onnxruntime, and
`@huggingface/transformers` is imported dynamically inside it.

- Audio is decoded by the bundled ffmpeg to 16 kHz mono f32le.
- The pipeline is `automatic-speech-recognition` with `return_timestamps:"word"`,
  `chunk_length_s:30`, `stride_length_s:5`.
- Whisper sub-word continuations ("50" + "%") are merged into one word.

The default model is `onnx-community/whisper-base.en_timestamped`, fp32. The plain
`whisper-base.en` export fails with "Model outputs must contain cross attentions", so a
`_timestamped` export is required for word timings. Override with env `TRANSCRIPTION_MODEL`.

The model downloads once (about 290 MB) into `TRANSCRIPTION_CACHE_DIR`, default
`<repo>/.cache/transformers` (git-ignored). The provider satisfies packages/agents'
`TranscriptionProvider` structurally, because media and agents don't depend on each other.
That interface now has optional `words`.

The domain gains `recordTranscript(prisma, {mediaAssetId, text, words|null, source:
"LOCAL_WHISPER"|"MANUAL", model?}, actor)` and `parseTranscriptWords(json)`.
`recordTranscript` writes the new MediaAsset fields plus a `MEDIA_ASSET_TRANSCRIBED` AuditLog
row, with the previous provenance in `before` and the model in `metadata`. A MANUAL transcript
clears stale word timings.

The worker gains `apps/worker/src/transcribe-job.ts` (`@chris/worker/transcribe-job`) with
`transcribeMediaAsset` and `transcribeContentItemTakes`. It fails safely: a provider error
returns `{status:"FAILED"}` and leaves the existing transcript untouched. A batch never
overwrites a MANUAL transcript unless `force`.

**Verified for real:** the `say`-generated speech sample came back word-perfect: "Most people
think a credit score is a grade, it is not. Save 50% more by paying your card twice a month.
That is the whole trick." It returned 27 words with plausible timings (e.g. "50%" 3.60–4.02 s).
Model load took about 19 s on first use and about 1 s per 10 s of audio after that.

`RUN_WHISPER_TESTS=1` runs a 37 s, four-repeat `say` sample through the 30 s chunking. It
**passed** (more than 70 words, monotonic timings, the last repetition placed in the last
quarter). That test is skipped by default so `pnpm test` stays offline.

**Alternatives:**
- An OpenAI-compatible hosted `/audio/transcriptions` API was rejected: no key is available,
  and it adds cost and data egress.
- whisper.cpp was rejected as a native build step.

pnpm reports `onnxruntime-node`/`sharp` build scripts as "ignored". They aren't needed: the
macOS arm64 binaries ship prebuilt in the package. This should be re-verified on the Linux
production host.

**Reversibility:** high. Any `TranscriptionProvider` can be injected into the job.

---

## 2026-10-16 — Edit Planner / Take Selector grounded in timestamped speech; deterministic cut snapping; repair context

**Decision:**
- New pure module `packages/agents/src/transcript-timing.ts`.
  - `buildTranscriptPhrases` groups words into phrases at sentence ends and at pauses over
    0.3 s.
  - `formatTimestampedTranscript` prints lines like
    `[2.00-3.30] (pause 1.00s before) Most people think wrong.`
  - `snapSegmentsToWordBoundaries` handles cut points:
    - A cut **inside a word** moves to the nearer word edge.
    - A cut in silence but within the pre-roll (0.08 s) or post-roll (0.15 s) of a word moves
      out to give the word its breath.
    - A cut comfortably in a pause is left alone.
    - Pre/post-roll never reaches into the neighbouring word.
- `runEditPlannerAgent` takes an optional `takeWords`. When present, the prompt shows
  timestamped phrases and returned segments are snapped. The bounds check still runs on the
  model's raw output first. Adjustments are appended to `rationale` as `[deterministic] …` for
  provenance.
- `runEditPlannerAgent` also takes an optional `repairContext: {previousPlan, qcIssues[]}`.
  It adds a REPAIR PASS section: fix every listed issue with minimal change, keep everything
  else identical, explain per issue.
- `CandidateTake.words` gives the Take Selector measured delivery stats (`summarizeDelivery`:
  wpm, leading/trailing silence, longest pause, pauses over 1 s) plus the timestamped
  transcript.
- Schema: `captions` (`{enabled, style CLEAN|BOLD_HIGHLIGHT, position LOWER|CENTER}`,
  nullable, default null) and `punchIns` (default []) are added to `EditPlanOutputSchema`.
  Both use `.default()`, so legacy rows still parse; zodOutputFormat still marks them required
  for the model. A new `EditPlanRepairContext` type is added.
- Prompts: EDIT_PLANNER 1.1.0, TAKE_SELECTOR 1.1.0 and VISUAL_QA 1.1.0 (rollback 1.0.0).
  VISUAL_QA now knows what the renderer guarantees, so it focuses on face/legibility and emits
  repair parameters the planner can consume.

**Reversibility:** high. Prompt rollback is "flip to 1.0.0 from git history".

---

### Known limitations / left undone

- B-roll, music, SFX and transitions remain unexecuted (no asset library). They are reported,
  not hidden.
- Caption/overlay vs **face** collisions need vision; that stays Visual QA's job. Our layout
  can't know where the face is. A future improvement is face-aware placement via a lightweight
  detector.
- Punch-ins are hard cuts only (no eased zoom).
- Whisper `base.en` is English-only. Set `TRANSCRIPTION_MODEL` (e.g.
  `onnx-community/whisper-small_timestamped`) for multilingual or higher accuracy at about 3×
  the CPU.
- The `quality-gate-job.ts` integration of `checkCaptionOverlayCollisions` is not done (file
  not owned). See wiring below.

---

### Evidence (real end-to-end render, 2026-10-16)

The source was synthetic: a 1920×1080 talking-head stand-in (grid background, face and body
blocks), 9 s long, with a real macOS `say` voice track. The steps:

1. It was transcribed with `LocalWhisperTranscriptionProvider` (27 words).
2. Two segments, as a planner would return them, were snapped:
   `0.00-3.05 → 0.00-3.17` and `3.38-8.00 → 3.36-8.00`.
3. The plan was rendered to 1080×1920 with these instructions:
   - HEADLINE "Save 50% more: the twice-a-month card trick nobody explains" (TOP)
   - NUMBER_CALLOUT "50%" (CENTER)
   - LOWER_THIRD "Chris — credit, explained" (BOTTOM)
   - captions (BOLD_HIGHLIGHT and CLEAN)
   - a 1.2× UPPER_THIRD punch-in at 3.1–5.3 s

Results: 7.9 s output, zero ffmpeg warnings, zero unexecuted instructions, Technical QC PASS
(−14.4 LUFS, −1.4 dBTP).

- `docs/evidence/2026-10-16-usable-v1/frame-BOLD_HIGHLIGHT-0.5.png`: the headline wraps to 3 balanced lines inside
  the safe area; "%" and ":" render verbatim; the caption "Most people think" has the spoken
  word lit.
- `docs/evidence/2026-10-16-usable-v1/frame-BOLD_HIGHLIGHT-3.5.png`: the punch-in is active (grid visibly larger),
  the "50%" callout shows, and the caption "Save **50%**" is in sync with the audio (output
  3.5 s = source 3.69 s, inside the word "50%" at 3.60–4.02).
- `docs/evidence/2026-10-16-usable-v1/frame-BOLD_HIGHLIGHT-5.6.png`: the caption was automatically moved above the
  lower third instead of colliding; the active word "twice" matches source 5.79 s.
- `docs/evidence/2026-10-16-usable-v1/frame-BOLD_HIGHLIGHT-7.2.png`, `frame-CLEAN-1.5.png`, `frame-CLEAN-6.png`
  show the remaining frames.
- `docs/evidence/2026-10-16-usable-v1/contact-sheet-bold-highlight.png` shows six frames side by side.

Visible but *by content, not renderer*: the TOP headline sits over the stand-in's eyes and the
CENTER callout over the mouth. These are exactly the FACE/EYE/MOUTH_OBSTRUCTION findings
Visual QA exists to catch, and the repair pass to fix (move the headline to BOTTOM, etc.).

---


---

## 2026-10-16 — Preflight requires a QC PASS for the exact render being published (critical)

**Decision:** `runPreflight` now BLOCKs unless the latest QC report for the latest successful
render has `overallStatus = PASS`. A missing QC report counts as a block too: a skipped gate
fails closed. Preflight also now checks:
- **Media spec, per platform** (`packages/domain/src/platform-limits.ts`):
  - vertical 9:16 within ±3%
  - Instagram Reels: 3s–15min, ≤300MB, width ≤1920
  - YouTube Shorts: ≤180s
  - TikTok: 3s–10min (API cap), ≤4GB, 360–4096px; the live `creator_info`
    `max_video_post_duration_sec` overrides when available
  - Missing duration/dimensions/size fail closed.
- **Text limits:**
  - Instagram: caption ≤2,200 chars, ≤30 hashtags, ≤20 @-mentions, measured on the *composed*
    caption (caption + appended package hashtags)
  - TikTok: ≤2,200 UTF-16 units
  - YouTube: an explicit title ≤100 chars with no `<` `>`; description ≤5,000 bytes
  - Overflowing hashtags block instead of being silently dropped.
- **Credentials:** through the adapter's `checkCredentials()`, which now goes through the
  refreshing credential store, so an expired-and-unrefreshable token shows up as a specific
  "reconnect" reason.

Every failure is its own specific reason string.

**Alternatives:**
- Check QC once at READY. Rejected: READY doesn't stop a re-render from slipping through.
- Warn instead of block. Rejected: this is a hard gate (CLAUDE.md: a BLOCK is never averaged
  away).

**Rationale:** the audit found that a gate-skipped video could be published. This is the one
place every publish path passes through: human click, autonomy, and the scheduled cron.
`tryAutonomousPublish` is covered by a test proving earned autonomy can't bypass it.

**Reversibility:** high. Pure, deterministic checks; the limits are constants in one file.

---

## 2026-10-16 — Retrying a failed platform after the item is PUBLISHED

**Decision:**
- Preflight accepts `PUBLISHED`/`MEASURING` in addition to `SCHEDULED`/`PUBLISHING`, but only
  for a platform whose latest attempt is not SUCCESS/DRAFT.
- `publishContentItem` only calls `startPublishing` from SCHEDULED.
- `finalizePublishing` transitions only from PUBLISHING. It also records the PUBLISHING
  autonomy outcome only on that transition, which fixes a pre-existing double count on
  idempotent re-runs.

**Alternatives:** a separate "retry platform" state. Rejected: it would need a schema/state-machine change, and
nothing regresses this way.

**Reversibility:** high.

---

## 2026-10-16 — Per-(item, platform) publish lease: advisory-locked claim + JobRun row

**Decision:** before calling an adapter, the publish job claims a lease:
1. A short `$transaction` takes `pg_advisory_xact_lock(hashtext('publish-lease:<item>:<platform>'))`.
2. Inside it, it checks for a RUNNING `JobRun` of that kind (younger than 20 min) and inserts
   one if there isn't one.
3. The slow network work runs *outside* any transaction. The lease row is closed as
   SUCCEEDED/FAILED in `finally`.
4. A lease older than 20 min is treated as a crashed process and taken over. The old row is
   marked FAILED with a reason.
5. A held lease means the platform is *skipped* ("already in progress"), not FAILED.

**Alternatives:**
- A unique-constrained "pending" Publication: needs a schema/enum change, which isn't allowed
  here.
- A session advisory lock held for the whole publish: unsafe with a connection pool (lock and
  unlock can land on different connections) and on serverless.
- A JobRun row without the advisory lock: racy (two inserts can both see "no lease").

**Rationale:** prevents double-click, two tabs, and cron + human from double-posting, with no
schema change. Verified on the PGlite test database: advisory xact locks work there, and a
`Promise.all` of two concurrent `publishContentItem` calls posts exactly once.

**Reversibility:** high. Lease rows are ordinary JobRun rows with kind `publish-lease:*`.

---

## 2026-10-16 — Ambiguous publish outcomes and recovery

**Decision:**
- Adapters throw `AmbiguousPublishError` when the *committing* step gets no response:
  - Instagram `media_publish`
  - a YouTube upload whose session status can't be read
  - TikTok's final chunk
- The publish job records it as FAILED with errorMessage prefix `AMBIGUOUS:`.
- On the next attempt, before posting again, it calls the adapter's optional
  `findExistingPost` (I chose matchers that cost little or no quota):
  - **Instagram:** recent `/{ig-user}/media` whose caption equals the composed caption,
    posted after the attempt minus 15 min
  - **YouTube:** the channel's uploads playlist (1 unit, not search.list's 100) matching the
    exact composed title
  - **TikTok DIRECT:** `/v2/video/list/` (scope `video.list`), matching title + `create_time`
  - **TikTok INBOX:** drafts can't be looked up, so this throws
- Outcomes:
  - **Found:** a SUCCESS attempt is recorded with the recovered id/url ("Recovered: … not
    re-posted") and verified.
  - **Confirmed absent:** it posts normally.
  - **Can't check:** it records a FAILED "check the account; if the post isn't there, retry to
    post" and doesn't post. The next deliberate retry posts.

**Alternatives:**
- Treat every network error as FAILED. That's the old behavior, and it causes double-posts.
- Block forever until a human marks it resolved. That needs new UI/state.
- Embed an idempotency marker in the public caption/description. That pollutes public text.

**Rationale:** the safest reversible behavior that keeps Chris's workflow to "retry".

**Reversibility:** high. The matchers are adapter-internal.

---

## 2026-10-16 — Publish verification actually runs (verifiedAt)

**Decision:** after every SUCCESS/DRAFT, the publish job calls `adapter.verify()` with a short
budget (default delays 2s/5s/10s, injectable).
- On success, `markPublicationVerified` sets `verifiedAt`, can replace `platformPostId`/`url`
  with a resolved value (TikTok publish_id → video id), and appends caveats to `errorMessage`.
  The original id is kept in `rawResponse.originalPlatformPostId`; the publish response moves
  to `rawResponse.publish` and verification goes to `rawResponse.verification`.
- If the post isn't verified in time, it gets a "Not yet verified … re-checked by the snapshot
  sweep." note, which is cleared once verified.
- `captureDueSnapshotsForAll` re-verifies unverified publications from the last 7 days.

**Alternatives:** a separate Verification table. Rejected: `verifiedAt` already exists on
Publication.

**Rationale:** spec §22: a publish isn't done until verified. Updating the attempt's own
verification fields completes that row; it doesn't rewrite history, and both responses are
kept.

**Reversibility:** high.

---

## 2026-10-16 — OAuth connect flow, encrypted credential store, automatic refresh

**Decision:**
- **Domain:** `packages/domain/src/platform-credential.ts` persists already-encrypted strings
  and lists non-secret summaries. Audit entries never contain token material.
- **Platforms:**
  - `packages/platforms/src/oauth.ts`: authorization URLs, code exchange, refresh.
  - `credential-store.ts` (`PlatformCredentialStore`): decrypts (AES-256-GCM,
    `TOKEN_ENCRYPTION_KEY`), refreshes near expiry, persists refreshed tokens, and falls back
    to the legacy `*_ACCESS_TOKEN` env vars when no row exists.
  - `factory.ts` (`createPlatformAdapters({ prisma, env?, fetchImpl? })`): the replacement for
    `apps/web/lib/platform-adapters.ts`.
- **Adapters** take a token provider per call. Their old static-credential constructor shapes
  still work, so the current web code compiles unchanged.
- **Refresh windows:**
  - YouTube: ~1h tokens, refreshed within 5 min of expiry with the Google `refresh_token`
    grant.
  - TikTok: access 24h, refreshed within 5 min of expiry. The refresh token (365d) may rotate,
    and the new one is always stored. Its expiry goes in `metadata.refreshExpiresAt`.
  - Instagram: the long-lived token (60d) refreshes itself with `ig_refresh_token` within 7
    days of expiry, but only once it's ≥24h old (Meta's rule).
  - A failed refresh of a still-valid token falls back to that token; an expired one surfaces
    a "reconnect in Settings → Connections" error.
- **Scopes:**
  - Instagram: `instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights,instagram_business_manage_comments`
  - YouTube: `youtube.upload youtube.readonly`, with `access_type=offline&prompt=consent` so a
    refresh token is always issued. If one is missing, the exchange errors and tells Chris how
    to fix it.
  - TikTok: `user.info.basic,video.publish,video.upload,video.list`
- **PKCE:** TikTok documents PKCE only for mobile/desktop. The web flow uses `client_secret`
  server-side, so no PKCE.
- **Instagram account id:** taken from `GET /me?fields=user_id,username` after the long-lived
  exchange.
- **CSRF:** a random 32-byte `state` in an httpOnly, SameSite=Lax cookie (path `/api/oauth`,
  10 min), compared with `timingSafeEqual` in the callback.
- **Web:** `/settings/connections` (new) shows each platform's status, account, expiry,
  scopes, missing scopes, and missing server env, with Connect/Reconnect/Disconnect. It also
  has the `publishing.scheduled_auto` toggle and recent cron JobRuns.

**Alternatives:**
- Credential store in packages/domain: impossible without a circular dependency (domain must
  not depend on platforms, and the crypto lives in platforms).
- NextAuth account linking: that's for app sign-in, not long-lived posting credentials.

**Reversibility:** high. The env-token fallback keeps old deployments working.

---

## 2026-10-16 — Instagram adapter corrections

**Decision:**
- **Host/version:** stays on `graph.instagram.com` (Instagram Login, consistent with OAuth).
  The version comes from `INSTAGRAM_GRAPH_API_VERSION`, default `v25.0`, which is the current
  docs' examples.
- **URL:** taken from `permalink` after publish and again on verify. The old `/reel/{media-id}/`
  was wrong: media ids aren't shortcodes.
- **Insights:**
  - `views, likes, comments, shares, saved, reach, ig_reels_avg_watch_time`. `plays` is gone;
    `views` is currently marked "in development".
  - `ig_reels_avg_watch_time` is converted from ms to seconds. The reference page doesn't state
    the unit; ms matches observed API behavior and the audit finding.
  - Reads now throw `PlatformHttpError` on non-2xx.
- **Caption:** package hashtags are appended to the caption, normalized and deduped
  case-insensitively, within limits. `coverFrameSeconds` maps to `thumb_offset` in ms, and
  `share_to_feed=true` is set.
- **Status polling:** the budget is configurable (default 6 × 10s ≈ 1 min, down from 5 min
  inside a request).
  - **Still IN_PROGRESS:** FAILED with a `PENDING_PROCESSING:` prefix plus a `resumeToken`
    (container id + createdAt). The publish job stores it in `rawResponse.resumeToken`; the
    next retry, or the scheduled sweep within 23h, resumes without re-uploading.
  - **Container already PUBLISHED:** the adapter recovers the post with `findExistingPost`.
- **Comments:** paginated through `paging.next` (up to 20 pages of 50).

**Not done:** Instagram's resumable upload (`rupload.facebook.com`). The docs restrict it to
Facebook Login for Business, so it doesn't apply here.

**Reversibility:** high.

---

## 2026-10-16 — YouTube adapter corrections

**Decision:**
- **Upload:** the resumable upload protocol (session POST → PUT). On a dropped connection or a
  5xx it queries `Content-Range: bytes */N` and resumes from the acknowledged `Range`, up to 3
  times. A session it can't read is AMBIGUOUS.
- **Metadata:**
  - Title: explicit title, or the caption's first line; `<` `>` stripped, ≤100 code points (no
    split surrogate pairs).
  - Description: caption + deduped hashtags, ≤5,000 bytes, no `<` `>`.
  - Tags: ≤500 chars counted the YouTube way (commas, plus quotes for tags with spaces).
- **Privacy:** `privacyStatus` comes from `YOUTUBE_PRIVACY_STATUS` (default `public`).
  `verify()` reads `status.uploadStatus`/`privacyStatus`: rejected/failed/deleted means not
  verified, with the reason. A requested-public video that comes back private is verified with
  the note "Uploaded but private — YouTube API audit required …".

**Correction to the brief:** the current `videos.insert` page says "Videos uploaded from
unverified API projects are not restricted to private viewing mode." The lock-to-private
situation can still happen (older policy, or a channel that defaults uploads to private), so
the check stays, but the note names both causes.

- **Read errors:** metrics/comments throw on HTTP errors; metrics also throw for a missing
  video. Comments are paginated by `pageToken`, and `commentsDisabled` yields `[]`.

**Reversibility:** high.

---

## 2026-10-16 — TikTok adapter: INBOX by default, creator_info, chunking, id resolution

**Decision:**
- **Post mode:** `TIKTOK_POST_MODE` = `INBOX` | `DIRECT`. Default is INBOX unless
  `TIKTOK_APP_AUDITED=true`.
  - **INBOX:** `/v2/post/publish/inbox/video/init/` (scope `video.upload`). The video lands in
    Chris's TikTok inbox to finish in the app, so the outcome is DRAFT with that message.
    Limit: 5 pending shares per 24h; the error code is mapped to a hint.
  - **DIRECT:**
    - Calls `creator_info/query` first.
    - Privacy: `PUBLIC_TO_EVERYONE` only when audited and allowed, else `SELF_ONLY` when
      offered. If nothing is usable it fails before uploading and points at INBOX: unaudited
      clients can only post to *private* accounts.
    - Respects `comment/duet/stitch_disabled` and the creator's max duration, and sends
      `video_cover_timestamp_ms`.
- **Chunking** follows the media transfer guide: ≤64MB is a single chunk; otherwise 10MB chunks
  (clamped 5–64MB, ≤1000 chunks), `total_chunk_count = floor(size / chunk)`, with the trailing
  bytes merged into the last chunk (≤128MB). Sequential PUTs with `Content-Range`.
- **Status and ids:**
  - A short status poll after upload catches an immediate FAILED (`fail_reason`).
  - `publicaly_available_post_id` (sic) is parsed from the raw JSON text, because those int64
    ids exceed 2^53.
  - A resolved id becomes `platformPostId` (via verify/sweep).
  - `getMetrics` refuses an unresolved publish_id (throws, so the offset stays due) and throws
    on API errors.
- **Comments:** `listComments` stays `[]`; there's no endpoint at this tier (unchanged
  decision).

**Known limit:**
- TikTok exposes the video id only for *public* posts after moderation. Private/inbox posts
  never get one, so they have no TikTok metrics. That's an honest gap.
- The post URL needs `creator_username` from creator_info. It's cached per adapter instance,
  so a URL resolved in a later sweep (new instance) may stay null.

**Reversibility:** high. An env flag switches modes.

---

## 2026-10-16 — Honest snapshot windows; archiving no longer waits forever

**Decision:**
- An offset can only be captured inside its own window, `[dueAt, dueAt + max(1h, 25% of the
  offset))`: T+1h → [1h, 2h), 6h → [6h, 7.5h), 24h → [24h, 30h), 72h → [72h, 90h),
  7d → [7d, 8.75d), 30d → [30d, 37.5d). The windows never overlap.
- A capture on day 8 records only T+7d. Earlier offsets are reported as `missed` and never
  backfilled.
- All offsets due in one run share one metrics read.
- An adapter read error records nothing, is reported in `errors`, and leaves the offset due.
- Archiving happens when every published platform has T+30d captured *or* its T+30d window has
  closed (37.5d).
- An item stuck at PUBLISHED with nothing capturable moves PUBLISHED → MEASURING → ARCHIVED
  once the window closes.

**Alternatives:** capture late offsets with a "late" flag. Rejected: that needs a schema
change, and a late number labelled T+1h still misleads downstream evaluation.

**Rationale:** spec §23: never fabricate a metric.

**Consequence:** the sweep must run at least hourly to catch T+1h.

**Reversibility:** high. The window function is one pure function.

---

## 2026-10-16 — Scheduled publishing and measurement sweeps (`apps/worker/src/scheduled-jobs.ts`)

**Decision:**
- **`publishDueScheduledItems({ prisma, storage, adapters, now?, getPublicVideoUrl?, … })`**
  - Gated by feature flag `publishing.scheduled_auto`. It's OFF when the row is absent; the
    toggle is on Settings → Connections.
  - Publishes SCHEDULED items with `scheduledDate <= now`. Items more than 24h overdue are
    reported as `missed` and never posted late.
  - Also resumes only `PENDING_PROCESSING` platforms (resume token less than 23h old) through
    `publishContentItem(..., { onlyPlatforms })`. It never blanket-retries real failures.
  - Each item is isolated; every run writes a `JobRun` (kind `scheduled-publish`) with a
    summary.
- **`captureDueSnapshotsForAll({ prisma, adapters, now? })`** (JobRun kind `snapshot-sweep`)
  - Re-verifies unverified publications, captures due snapshots for every PUBLISHED/MEASURING
    item, and archives finished ones.
  - Ingests comments only for items that hit a measurement point this run, to bound API cost.
  - It's read-only toward the platforms, so it has no flag.

**Rationale:** a human scheduled the item, so the content is approved. Posting with nobody
clicking is still new autonomous behavior, so it's flagged off by default (CLAUDE.md).

**Reversibility:** high. Turn the flag off.

---

## 2026-10-16 — Instagram public video URL is an injected dependency

**Decision:** `publishContentItem(..., { getPublicVideoUrl?: (storageKey) => Promise<string | null> })`.
It's only called for Instagram, once per run. If it's absent or returns null, Instagram is
recorded as FAILED with a clear reason, and the adapter is never called.

**Rationale:** Instagram fetches the video itself. The storage choice (Vercel Blob) belongs to
`apps/web`.

**Reversibility:** high.

---


---

## 2026-10-16 — The Claims Gate reviews the FINAL SCRIPT, not just the research

**Decision:** The pipeline is now Research → Claims Gate (MODE: RESEARCH) → Script →
Claims Gate (MODE: SCRIPT, on the script's actual wording vs. the packet) → bounded revision →
Brand Guardian → bounded brand revision. Research-level `requiredEdits` and the packet's
`prohibitedClaims` are handed to the Script Agent from the first draft. A script-level
`PASS_WITH_REQUIRED_EDIT` triggers up to `maxScriptRevisions` (default 1) Script revisions
that apply the edits, each re-gated; anything other than `PASS` after that is
`SCRIPT_BLOCKED`. A Brand Guardian revision is a new script, so it is re-gated too; if it
doesn't `PASS` it is discarded and the last gated script stands. Every model call in a run is
counted against `maxModelCalls` (default = worst case, 10) and refused past it
(`PipelineBudgetExceededError`). The gate's own output is normalised deterministically, only
ever stricter (PASS with edits → PASS_WITH_REQUIRED_EDIT; PASS_WITH_REQUIRED_EDIT with no edits
→ BLOCK). A deterministic pre-check lists numbers/FACTs without a source URL and hands them to
the gate as unsupported.

**Alternatives considered:** gate only the research (status quo — the script could add a
number nobody checked); gate only the script (loses the early, cheap stop before drafting);
unbounded revise-until-pass loops (unpredictable spend, can oscillate).

**Rationale:** viewers hear the script, not the packet. For finance content the most likely
failure is the script hardening "can" into "will", dropping a caveat, or adding a punchy
number. Regression test: `pipeline.test.ts` "a script that adds an unsupported number is
caught at the script-level gate".

**Reversibility:** high — `maxScriptRevisions`/`maxModelCalls` are options; the extra gate
call can be removed in one place (`pipeline.ts`).

---

## 2026-10-16 — A script-level BLOCK routes RESEARCHING → RESEARCH_BLOCKED (no new state)

**Decision:** The state machine is unchanged. When the final script fails the gate,
`applyPipelineResult` records the research packet AND every gated script version (the final
one carrying its BLOCK/unresolved result in `ScriptVersion.scriptClaimsGateResult`), then
transitions RESEARCHING → RESEARCH_BLOCKED with reason "Script-level Claims Gate …". Defense in
depth: a `READY` input whose final `scriptClaimsGateResult` is present and not `PASS` is
downgraded to this path. Script history is an append-only `revisedFromId` chain.

**Alternatives considered:** leave the item at SCRIPTING (the brief's other option) — rejected
because SCRIPTING has only one exit (→ SCRIPTED), so a blocked item would be stuck with no
legal recovery transition, and NEEDS YOU doesn't surface SCRIPTING; add a SCRIPT_BLOCKED state —
out of scope (state machine owned elsewhere; doc + migration + UI change).

**Rationale:** RESEARCH_BLOCKED is already the factual-hard-gate state, already surfaced in
NEEDS YOU (FACTUAL_NUANCE), and already has both recovery paths: rollback to RESEARCHING to
re-run, or a human fix that re-gates PASS (`recordScriptRegate` walks RESEARCH_BLOCKED →
RESEARCHING → RESEARCHED → SCRIPTING → SCRIPTED, each a real audited transition). The
transition reason distinguishes research-level from script-level blocks.

**Reversibility:** high — if a dedicated state is added later, only `applyPipelineResult`'s
SCRIPT_BLOCKED branch and `recordScriptRegate`'s walk change.

---

## 2026-10-16 — Human script edits are new versions and must re-pass the gate before filming

**Decision:** `createHumanScriptVersion` creates a new `ScriptVersion` (authorType HUMAN,
`revisedFromId`, `revisionNote`) — never an overwrite — allowed only while SCRIPTED or
RESEARCH_BLOCKED; writes AuditLog `SCRIPT_VERSION_HUMAN_EDIT` and a Decision Journal entry
(`userOverride: true` when the base was agent-written — ARCHITECTURE.md requires overrides to
be journaled). Beat/pause/emphasis annotations are cleared (they described the agent's
wording). `regateEditedScript` (agents) re-runs Claims Gate (+ Brand Guardian unless BLOCK);
`recordScriptRegate` (domain) stores the verdict once (never overwrites an existing verdict).
`createCreatorCardAndAdvance` now refuses (`ScriptNotClearedForFilmingError`) when the latest
version is HUMAN and un-regated, or has any recorded verdict other than PASS. Legacy agent rows
with no verdict (written before this change) are still allowed — backward compatible.

**Alternatives considered:** trust human edits (a hand-typed "$25k Roth limit" would film);
block legacy rows too (would strand every existing SCRIPTED item).

**Rationale:** the factual hard gate applies to what gets filmed regardless of author.

**Reversibility:** high.

---

## 2026-10-16 — Web retrieval for Research and Claims Gate (Anthropic server-side tools)

**Decision:** Research and Claims Gate calls attach Anthropic's server-side `web_search` and
`web_fetch` tools (`web_search_20260209` / `web_fetch_20260209` with dynamic filtering on
Opus/Sonnet 5.x; basic `_20250305` / `_20250910` on other models). Configurable:
`RESEARCH_WEB_SEARCH=on|off` (default on), `RESEARCH_WEB_SEARCH_MAX_USES` (5),
`CLAIMS_GATE_WEB_SEARCH_MAX_USES` (3), `RESEARCH_WEB_FETCH_MAX_USES` (3). Structured outputs
and server tools combine in ONE call — verified with a real request on 2026-10-16 (sonnet-5-5,
web search + `output_config.format` + refusal fallback: valid parsed JSON, 1 search) — so no
two-step search-then-extract was needed. `pause_turn` is resumed up to 3 times. The
`ModelProvider` interface gained a vendor-neutral `tools?: {webSearch?: {maxUses,
allowedDomains?}, webFetch?: {maxUses}}`. `ResearchPacket.citations` became structured
(`url, title, publisher, publishedOrEffectiveDate, accessedDate, isPrimarySource`), facts and
numeric inputs carry `sourceUrl` (+ `asOfDate`); prompts (RESEARCH/CLAIMS_GATE 1.1.0) require
primary sources (IRS, SSA, Fed, BLS, Treasury, CFPB, SEC, FINRA, FDIC) and forbid URLs not
actually retrieved. Search fees ($10/1,000) are priced into `costUsd`; per-call
search/fetch/cache counts go to an AuditLog `MODEL_SERVER_TOOL_USAGE` row (ModelCallLog has no
columns for them — see "Known gaps").

**Alternatives considered:** a third-party search API + our own fetch loop (more code, another
secret, no benefit); retrieval off by default (facts from model memory — the original problem).

**Rationale:** finance limits change every year; model memory is not a source.

**Reversibility:** high — `RESEARCH_WEB_SEARCH=off` restores memory-only behaviour (prompts then
instruct the model to mark everything unsourced and prefer NEEDS_MORE_RESEARCH/BLOCK). Old
string citations in existing rows are still readable (`researchPacketFromRow`).

---

## 2026-10-16 — Current model generation, explicit effort, per-model pricing

**Decision:** Defaults HIGH `claude-opus-5-5`, MEDIUM `claude-sonnet-5-5`, LOW
`claude-haiku-5-5` (each verified with `models.retrieve` on 2026-10-16). Thinking is adaptive
(always on for these models; `budget_tokens`/disabled are 400s), so `output_config.effort` is
always sent: HIGH→high, MEDIUM→medium, LOW→low (Opus 5.5 and Haiku 5.5 default to medium, so
leaving it unset would silently under-think HIGH calls). `max_tokens` 64K/32K/16K and calls are
streamed (`finalMessage()`), so thinking can't truncate the answer and large caps don't trip the
SDK's non-streaming timeout guard. `pricing.ts` is keyed by model ID (input, output, 1.25x cache
write, published cache read, Haiku 5.5's >100K long-context tier, $0.01/web search); an unknown
model logs a warning and is priced at the most expensive known rate ($10/$50) so it can only be
over-counted against the cap. Dated aliases (`-20251001`) resolve to their family. Server-side
refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) is enabled for
Opus 5.5 / Sonnet 5.5 (disable with `MODEL_REFUSAL_FALLBACK=off`); the call is costed at
`response.model` (the serving model).

**Alternatives considered:** keep class-keyed pricing (env overrides mis-costed); omit effort
(HIGH calls run at medium on Opus 5.5).

**Reversibility:** high — env `MODEL_HIGH/MEDIUM/LOW` overrides; price table is one file.

---

## 2026-10-16 — Model routing alignment with spec §16

**Decision:** AUDIENCE_INTELLIGENCE moves LOW → MEDIUM (prompt 1.1.0) — spec §16 lists
"audience intelligence" under MEDIUM and the spec wins over frontmatter. PRODUCTION_DIRECTOR
(newly implemented) is MEDIUM (AGENT_CONTRACTS says LOW/MEDIUM; contract drafting sets factual
risk and scope fences — judgment, not formatting). **Not changed (owned by another workstream):**
EDIT_PLANNER frontmatter says HIGH while spec §16 / ARCHITECTURE.md say MEDIUM ("editing plans")
— recommend the Edit Planner owner set MEDIUM or log why HIGH is earned. `/docs/ARCHITECTURE.md`
and `/docs/AGENT_CONTRACTS.md` should list Audience Intelligence and Production Director as
MEDIUM (integrator: not editable from this workstream).

**Reversibility:** high (frontmatter flip, rollback_version 1.0.0).

---

## 2026-10-16 — Provider robustness: typed stop reasons, billed failures count, fail-CLOSED cap

**Decision:** `stop_reason` is checked before reading content: `max_tokens` →
`ModelOutputTruncatedError`, `refusal` → `ModelRefusalError` (with `stop_details.category`),
unparseable/invalid → `ModelOutputParseError`; all extend `BilledModelCallError` carrying the
usage, so `CostTrackingModelProvider` logs failed-but-billed calls WITH tokens and cost (they
now count toward the spend cap). Prompt caching: `cache_control` on the system prompt and on the
new `stableContext` block (brand docs, rendered before the per-call prompt; agents moved brand
context there). Attribution: `provider.withContext({contentItemId})` (helper `scopeProvider`)
sets `ModelCallLog.contentItemId` per call on a shared instance; the pipeline accepts
`options.contentItemId`. **The spend-cap check now fails CLOSED:** if today's spend can't be
read, the call is refused with `SpendCapCheckFailedError` and audited
(`MODEL_SPEND_CAP_CHECK_FAILED`). This reverses the earlier fail-open entry.

**Alternatives considered:** keep fail-open (a DB hiccup = unmetered spend; and if the DB is
down the agent's result can't be persisted anyway, so refusing loses nothing real).

**Reversibility:** high — one branch in `cost-tracking-provider.ts`.

**Cache verification:** a real call on 2026-10-16 (sonnet-5-5, cached system block) reported
`cache_creation_input_tokens: 6892` and `cache_read_input_tokens: 11632` across the server-tool
iterations of a single request, i.e. caching is active. A cross-request hit on the brand-context
block could not be measured: the shared API key ran out of credit mid-session (see eval entry).
The eval runner now records per-case `usage.cacheReadInputTokens` so the next run shows it.

---

## 2026-10-16 — Structured-output schemas must not use z.record

**Decision:** `PlatformPackageOutputSchema.metadata` (model side) is now `metadataEntries:
{key, value}[]` (`PlatformPackageModelOutputSchema`), folded back into a record by
`runPlatformPackagingAgent` — the public return type still has `metadata: Record<string,string>
| null`, so the existing web call compiles unchanged. Taste Learner `context` is now explicit
nullable fields `{productionTier, topic, format, platform}`; `toAcceptanceProbabilityInputs`
compacts nulls away for persistence.

**Rationale:** the SDK's schema transform renders a record as an object with no properties and
`additionalProperties: false`, so the model could only ever return `{}`.

**Reversibility:** high.

---

## 2026-10-16 — Production Director implemented (contract + creator card drafts)

**Decision:** `runProductionDirectorAgent` (modes CONTRACT / CREATOR_CARD; also
`runProductionDirectorContractAgent`, `runProductionDirectorCreatorCardAgent`) drafts every
field of `CreateProductionContractSchema` (plus a `rationale`) from the idea, the current week's
thesis, its portfolio allocation and brand; and a Creator Card from the latest gated script.
`toCreateProductionContractInput` / `toCreateCreatorCardInput` map drafts to the existing domain
create functions. Non-interactive: `draftAndIssueProductionContract` /
`draftAndIssueCreatorCard` — gated by feature flag `AUTOPILOT_PRODUCTION_DIRECTOR` (off by
default) unless `triggeredByHuman: true`; the contract path journals the tier/risk decision. The
creator-card path still goes through the filming gate. Inverted min/max lengths are repaired
deterministically.

**Reversibility:** high — drafts are suggestions; the existing manual forms remain.

---

## 2026-10-16 — Learning loop closes into strategy; Strategist may propose new ideas

**Decision:** `buildStrategicContext(prisma, {maxChars=8000})` (domain) assembles a
token-bounded (~2K tokens) block: accepted Beliefs, last WeeklyBrief, recent
PerformanceEvaluations (with titles), AudienceInsights, TasteFeedback counts + recent verbatim,
recent ReferenceObservations — each section explicitly says "no data yet" when empty. Creative
Director and Weekly Strategist accept optional `strategicContext` (backward compatible). The
Strategist returns `proposedNewIdeas[]` (with `targetPortfolioSize`, default 30); nothing is
created until a human approves. Pending proposals are stored as append-only AuditLog rows
(`NEW_IDEA_PROPOSED`, metadata = proposal) and resolved by `NEW_IDEA_PROPOSAL_APPROVED/_REJECTED`
rows — no schema change. `approveIdeaProposal` creates the ContentItem (IDEA), records its
portfolio allocation and approves it (IDEA → SELECTED). `refreshTasteModel(prisma, provider)`
runs the Taste Learner per artifact type with ≥2 feedback rows and appends
ChrisAcceptanceProbability rows. `journalDecision` (best-effort, never throws) is written for:
research-level and script-level Claims Gate BLOCKs, multi-version script selection, portfolio
allocation proposals, Production Director contracts, human script edits (override), and rejected
idea proposals (override) — not for routine passes.

**Alternatives considered:** a `ProposedIdea` table (cleaner querying — recommended when the
schema owner next migrates; the AuditLog rows migrate 1:1); auto-creating IDEA items (violates
"proposals require review").

**Reversibility:** high.

---

## 2026-10-16 — Brand voice grounding scaffold

**Decision:** `brand/VOICE_SAMPLES.md` ships EMPTY with instructions for Chris (3–8 verbatim
transcripts between `SAMPLES START/END` markers; optional labelled `NOT ME` counter-example).
`getBrandContextText` appends the samples only when the region is non-empty. No samples were
invented — a fake "real transcript" would teach every agent the wrong voice with false
authority. Filling it is a brand change Chris logs like any `/brand` edit.

**Reversibility:** high.

---

## 2026-10-16 — Eval harness (spec §24) and first real results

**Decision:** `packages/evals`: gold-standard fixtures in `fixtures/evals/*.json` (case = prompt
under test, input, deterministic assertions, known-good `mockResponse`). Runner
`pnpm --filter @chris/evals eval` (flags `--only=`, `--prompt=`, `--mock`, `--max-cost=`;
`ENV_FILE=` for the key) runs against real models, prints a pass/fail table + cost, writes
`fixtures/evals/results/<timestamp>.json`. Mock self-test in the normal suite proves fixtures
parse, known-good answers pass through the real agent functions/schemas, and wrong answers fail.
`packages/evals/src/e2e-pipeline.ts` runs one real end-to-end pipeline (no DB).

Coverage now: accurate vs misleading finance claims (Claims Gate: correct 2026 limits must not
BLOCK; "$25,000 Roth IRA limit" in the packet must BLOCK; 2025 limit labelled 2026; "you can't
lose money in index funds" in a script; a script adding an unsupported "$3.2 million every time"
projection); Chris vs non-Chris voice; generic-AI copy; good vs cringe CTA; excessive reference
copying (Brand Guardian). Figures verified 2026-10-16 against IRS IR-2025-111: 401(k) $24,500,
IRA $7,500, 50+ catch-up $8,000 (IRA catch-up $1,100; ages 60–63 $11,250). Note the misleading
SCRIPT-mode cases accept `BLOCK` or `PASS_WITH_REQUIRED_EDIT` (either stops filming: the
pipeline forces a revision and re-gates); RESEARCH-mode false numbers require `BLOCK` (the stale
year case accepts either non-PASS verdict).

**First real run (2026-10-16, Brand Guardian on sonnet-5-5, $0.077):** 4/5 — chris-voice PASS
(brand 72 / voice 74, borderline), generic-AI PASS (4/3), cringe-CTA PASS (22/28, 5 required
changes), reference-copying PASS (originality 0), good-CTA **FAIL** (62/60). Inspection: the
good-CTA fixture's body was genuinely vague (no numbers, "it usually bounces back") and the
Guardian's critique was correct — the case tested script quality, not the CTA. Fixture v2 gives
the good/cringe pair the SAME concrete body so only the CTA differs; it has **not** been re-run.
**Claims Gate evals and the end-to-end run could not run:** the shared Anthropic key hit "credit
balance is too low" mid-session (other workstreams share it). No prompt's `eval_status` was
changed (none has fully passed).

**Reversibility:** n/a (additive).

---

### Known gaps / follow-ups

- Run `pnpm --filter @chris/evals eval` and `npx tsx src/e2e-pipeline.ts` (in packages/evals)
  once API credit is restored (~$0.6 for evals incl. 5 Opus Claims Gate cases with search,
  ~$0.3–0.8 for e2e); set `eval_status: passed` only for prompts whose cases all pass.
- ModelCallLog lacks columns for cache read/write tokens and web search/fetch counts (breakdown
  is in AuditLog `MODEL_SERVER_TOOL_USAGE` for retrieval calls only). Recommend adding
  `cacheReadTokens`, `cacheWriteTokens`, `webSearchRequests` columns.
- Refusal fallback: cost is computed at the serving model's price; a fallback run's iterations
  could be costed per-iteration from `usage.iterations` for exactness.
- A `ProposedIdea` table would replace the AuditLog-backed proposal store.
- Spend cap remains a single daily ceiling; the per-run `maxModelCalls` budget is the first
  per-job limit (spec §16), only for the research→script pipeline.

---

---

## 2026-10-16 — Integration: shared step functions + Autopilot; wiring of all workstreams

**Decision:** the per-state production steps (research → script pipeline, take selection,
edit planning, packaging) live once in `apps/web/lib/content-steps.ts`, used by both the
individual buttons and **Autopilot** (`runAutopilot`), so the two can't drift. Autopilot is
started by a human click and acts with that authority for steps Chris would otherwise click
one by one: Production Director contract → start research → pipeline → Creator Card
(only if the script cleared the script-level Claims Gate and Brand Guardian has no concerns)
→ stop for filming/upload → transcribe → take → edit plan → render → Quality Gate + auto-repair
→ package for all three platforms → stop ("ready to schedule"). It goes through every hard gate
via the same domain functions, and it **never schedules or publishes** — those stay explicit
(or the flag-gated scheduled-publish cron). The Content list can run it over a checked batch in
the background (`after()`), recorded as one `JobRun` (`autopilot.batch`) whose per-item outcome
is shown on the page.

**Other wiring:** credential-store adapters per call; Instagram gets a 2-hour presigned private
Blob URL (not a public upload — SECURITY.md's "no permanently public media"); `/api/cron/[job]`
(`tick` | `publish-scheduled` | `snapshots`, `Authorization: Bearer $CRON_SECRET`, timing-safe);
`vercel.json` keeps a once-daily cron (safe on every plan) and `.github/workflows/cron-tick.yml`
calls `tick` every 10 minutes (Hobby can't run sub-daily Vercel crons); transcription runs in
the background after upload locally (off by default on Vercel — too heavy for a function; a
manual transcript box is always available); auto-repair, re-plan, script edit + re-gate,
one-click Production Director, strategic context, new-idea proposals, approve-all-recommended,
taste refresh, Film Queue.

**Verified live (local `next dev`, real HTTP):** all 12 pages 200; cron 401 without/with a wrong
secret and a clean `tick` run with the right one (scheduled publishing correctly off by
default); a 100 MB upload streamed and ingested; a real spoken take uploaded → background local
Whisper → word-perfect transcript with word timings; that take rendered through the real render
job with a HEADLINE containing `:`/`()`/`%`, a NUMBER_CALLOUT and BOLD_HIGHLIGHT word captions →
Technical QC PASS (frames in `docs/evidence/2026-10-16-usable-v1/integration-*.png`).

**Not verifiable today:** any step needing a model call — the shared Anthropic key ran out of
credit mid-run ("credit balance is too low"). All of it is covered by mock-provider tests; the
real evals (`pnpm --filter @chris/evals eval`) and the e2e pipeline script are ready to run once
the key has credit.

## 2026-10-16 — Edit Planner routed MEDIUM, per spec §16

Spec §16 lists "editing plans" under MEDIUM; the prompt frontmatter said HIGH (Opus). Spec
wins (CLAUDE.md): `EDIT_PLANNER.md` → `model_class: MEDIUM`, version 1.1.1 (rollback 1.1.0).
The planner's hard parts are now deterministic (cut snapping to word boundaries, bounds
validation, caption layout, collision relocation), so the judgment left for the model is
mid-tier. Reversible by flipping the frontmatter back if real evals show quality loss.

---

## 2026-10-16 — In-app finishing editor (explicit owner decision)

**Chris's request:** after the system edits a video, he wants to finish it himself in the app —
length, clips and their order (across takes), cuts, captions (text, font, color), grading,
zoom, crop — "like the most premium Adobe app or CapCut", then save it to its calendar slot,
"so you don't need to go out of house."

**Conflict with the spec:** §26 lists "full Premiere replacement" under *Do not build yet*.
Chris is the human owner (authority level 1, above the spec's defaults), and his request is
scoped to *finishing* an AI edit, not a general-purpose NLE — so this is built, and the scope
line is held: single-layer timeline over his own raw takes, text/caption/zoom tracks, a
whole-video grade. Not in scope: multi-layer compositing, keyframe curves, effects
libraries, audio mixing beyond per-clip volume, B-roll/music (still no asset library).

**Architecture:** the edit stays a *document*, not pixels. `EditTimeline` v2
(`packages/media/src/timeline.ts`) is the single source of truth for both the browser preview
and the ffmpeg renderer; the AI's `EditPlanOutput` converts deterministically into one
(`planToTimeline`). Saving stores the timeline on a NEW `EditPlan` row (append-only history)
via `saveFinishingEdit`, which rolls a RENDERED/QC_REPAIR/QC_BLOCKED/READY/SCHEDULED item back
to EDIT_PLANNED (new rollback transitions, `/docs/STATE_MACHINE.md`) — an edit changes what's
on screen, so it must render and pass all four hard gates again before it can be scheduled;
"Finish & schedule" chains save → render → Quality Gate → schedule and reports each step.
Caption selection/timing/chunking is one pure module shared by preview and renderer, so the
captions Chris sees are the captions that render.

**Alternatives considered:** embedding a third-party web editor SDK (heavy, licensing, and
its export wouldn't go through our hard gates/provenance); exporting to CapCut/Premiere
(exactly the "going out of house" Chris wants to avoid); a destructive in-browser render
(non-reproducible, bypasses the deterministic renderer).

**Reversibility:** additive. The editor is one route; removing it leaves plans/timelines
renderable. The rollback transitions only ever lead back into the gated path.

---

# 2026-10-16 — Finishing editor + per-platform variants (engine and UI workstreams)

Evidence: `docs/evidence/2026-10-16-finishing-editor/`.


---

## 2026-10-16 — One render engine: EditTimeline v2 rendered exactly, shared pure layout

**Decision.** Every render goes through `renderTimeline`. A plan row's `plan.timeline`
(finishing edit) is rendered as-is; otherwise `planToTimeline` converts the AI's EditPlan to
an explicit Timeline first. All geometry/typography/zoom/grade math lives in the pure
`timeline-layout.ts`, which the browser preview imports too; only glyph measurement is
injected (`MeasureText`: opentype.js on the server, canvas `measureText` in the browser).

**Alternatives.** (a) Reimplement layout separately in the editor — guaranteed drift.
(b) Render previews server-side — too slow for scrubbing.

**Rationale.** "What the editor previews is what renders" only holds if both sides run the
same code with the same fonts.

**Reversibility.** High — the legacy `renderVideo` (EditPlan renderer) is kept, untouched,
for its existing tests; only the worker switched. Switching back is a one-function change in
`render-job.ts`.

## 2026-10-16 — Legacy renderer kept; worker routed through the timeline engine

**Decision.** `renderVideo` + its tests stay as they were (they cover `targetDimensions:
null`, a `fontPath` override, and per-phrase caption relocation that a Timeline cannot express).
`renderContentItem` uses `timelineForPlan` + `renderTimeline`. `options.fontPath` is accepted
but ignored (fonts come from FONT_REGISTRY). `mapEditPlanToRenderInstructions` stays exported.

**Alternatives.** Rewrite `renderVideo` as `planToTimeline → renderTimeline` — breaks
several legacy pixel expectations (relocated captions, native framing) for no product gain.

**Reversibility.** High. The legacy renderer can be deleted once nothing imports it.

## 2026-10-16 — A present-but-invalid finishing edit FAILS the render; foreign assets refused

**Decision.** If `plan.timeline` exists but fails `EditTimelineSchema`, the render attempt is
recorded FAILED (`InvalidFinishingEditError`) — it does NOT fall back to the AI plan. A
timeline clip that references a MediaAsset of another ContentItem also fails the attempt.

**Rationale.** Falling back would silently discard Chris's edit and could publish the AI cut
he overrode. Cross-item assets are a data-integrity/security hole.

**Reversibility.** High (one branch in `timelineForPlan`).

## 2026-10-16 — One ffmpeg input per CLIP (accurate input seek), not per asset

**Decision.** Each clip is its own `-ss start -t (dur+0.5) -i take` input, then trimmed exactly
in the graph. The brief suggested one input per distinct asset.

**Alternatives.** One input per asset with `trim` per clip (the legacy approach).

**Rationale.** Clips may come from any point of any take in any order (e.g. the hook pulled
from the end of the take to the front). With one shared input, ffmpeg decodes the stream once
and queues every decoded frame a *later* clip needs while `concat` is still consuming earlier
ones — raw 1080x1920 frames are ~3 MB each, so a 60 s out-of-order edit can buffer gigabytes.
Per-clip inputs with input seeking decode only what each clip needs. Input seeking is
frame-accurate when transcoding (ffmpeg's default accurate_seek).

**Reversibility.** High (input construction is one loop).

## 2026-10-16 — Frame-aligned clip lengths; output fps 30 (60 when every source >= 50 fps)

**Decision.** Clip k gets `round(end_k*fps) - round(start_k*fps)` frames (end_k = cumulative
output end); its audio is trimmed/padded to exactly that many frames' duration. Mixed sources
are normalised to fps F, SAR 1, yuv420p, 48 kHz stereo fltp. F = 60 if every clip's source is
>= 50 fps, else 30. Audio-less takes get `anullsrc` silence. Clips that end up to 0.1 s past
their source hold the last frame (warning); further past = `RenderSegmentOutOfBoundsError`.

**Rationale.** Per-clip `ceil(d*fps)` rounding drifts captions/audio by up to a frame per cut
(0.66 s over 20 cuts); frame alignment bounds drift to half a frame regardless of cut count
(unit-tested). 60 fps sources keep their motion for platforms that accept 60.

**Reversibility.** High.

## 2026-10-16 — Zooms: perspective filter on the canvas, per-frame expression; semantics

**Decision.** All zooms are one `perspective` filter after concat, `eval=frame`, cubic
interpolation, driven by the frame index (`T = (in-1)/fps` — perspective's `in` is 1-based,
verified by a frame-exact test). Semantics: the focal point (x, y) stays fixed on screen
(CSS `transform-origin`); CUT = instant; EASE = ease-in-out cubic from 1 to `zoom` over
`easeSeconds` from `start`, then hold; every zoom cuts back to 1 at `end`. Zooms are sorted,
clamped to the video, and a zoom overlapping an earlier one is skipped with a warning
(`normalizeZooms`, shared with the preview).

**Alternatives.** `zoompan` (integer-rounded crop → visible jitter); split + static crops per
frame (huge graphs, still integer jitter); scale with `eval=frame` (variable frame size breaks
downstream filters).

**Rationale.** Sub-pixel sampling = no jitter; test asserts the eased push-in tracks the
analytic curve within 2.5 px every other frame. Cost ≈ 10 ms/frame, only when zooms exist.
Zooms resample the 1080x1920 canvas (not the original source), so a zoom on a 4K source is
slightly softer than a source-resolution re-crop would be — negligible for phone footage
(already ~canvas resolution); clip `crop.zoom` *does* resample the source.

**Reversibility.** High (`zoomFilter`).

## 2026-10-16 — Grade mapping and precedence

**Decision.** Effective grade = `GRADE_PRESET_VALUES[preset]` with every explicitly
NON-neutral field overriding the preset's value for that field (`resolveGrade`; a field left at
neutral means "use the preset"). Mapping: brightness/contrast/saturation → `eq` (same
parameters); temperature t → `colorchannelmixer` gains R = 1 + 0.10t, G = 1, B = 1 − 0.12t;
vignette v → `vignette=angle=v·π/3` (darkening = cos(angle·d)^4, d = distance from centre /
half-diagonal). Grade is applied after zooms and BEFORE texts/captions (type is never graded).

**Alternatives.** `colortemperature` (Kelvin model — not reproducible in CSS), `colorbalance`.

**Rationale.** Linear channel gains are exactly reproducible in the browser (SVG
`feColorMatrix`), so preview = render.

**Reversibility.** High (`gradeFilters`, `temperatureGains`, `vignetteAngle`).

## 2026-10-16 — Typography: explicit layout, no kerning anywhere, libass positioned by measured metrics

**Decision.** Texts: drawtext (`textfile=` + `expansion=none`) per laid-out line at an exact
baseline; plates are rounded rectangles drawn by libass vector drawing underneath. Captions:
libass, one event per line at `\an7\pos(lineLeft, baseline − winAscent·px/upm)` with ASS
`Fontsize = px·(winAscent+winDescent)/upm` — both relations measured for all 15 fonts
(`font-metrics.ts` is generated from the TTFs and a test keeps it in sync). Fonts are selected
by full name (name ID 4) via `fontsdir`. `Kerning: no` in ASS; drawtext does not kern; the
preview must set `font-kerning: none`. Line wrapping = greedy + balanced re-wrap (same
function both sides). Explicit `\n` in a text = hard line break.

Not carried over from the legacy presets (not expressible in the contract): the LOWER_THIRD
accent bar and the NUMBER_CALLOUT drop shadow. Text sizes are fixed per element (no auto-fit
in the renderer); `planToTimeline` performs the old auto-fit once, at conversion.

**Reversibility.** Medium — changing any LAYOUT constant changes renderer AND preview together.

## 2026-10-16 — Captions sit at one explicit y; planToTimeline picks a free band

**Decision.** The renderer no longer moves individual caption phrases around overlays (the
Timeline is explicit and WYSIWYG). `planToTimeline` puts captions in the plan's band (LOWER/
CENTER) unless a text occupies it, then the other band, then just above the colliding text.
`technicalQCReport.captions.relocatedAroundOverlays` is now always 0 (key kept). The quality
gate checks a finishing edit's own texts (text/text and caption/text rect intersections while
both are visible — `findTimelineCollisions`, same layouts the renderer drew); plain plans keep
the legacy checks exactly (as briefed), even though they now render via planToTimeline.

**Follow-up.** Switch the plain-plan gate check to `findTimelineCollisions(planToTimeline(…))`
too, so the gate checks exactly what rendered; kept legacy now to avoid changing gate behaviour.

## 2026-10-16 — Fonts: 12 OFL fonts added, variable families instanced to static TTFs

**Decision.** Added Montserrat ExtraBold/Black, Poppins Bold/ExtraBold, Archivo Black, Space
Grotesk Bold, Bebas Neue, Anton, Oswald Bold, Roboto Condensed Bold, DM Serif Display,
Playfair Display Bold (15 total incl. the 3 Inter). Source: google/fonts `ofl/*`. Families
that only ship variable fonts there (Montserrat, Oswald, Playfair, Space Grotesk, Roboto
Condensed) were instanced at the needed weight with fontTools `instancer` (name tables
updated) so FreeType/libass/opentype.js/the browser all see one static face. Licenses live in
`packages/media/assets/licenses/` — NOT in `fonts/`, because libass loads every file in its
fontsdir. Archivo Black is registered at weight 400 (its OS/2 class) although it looks black.

**Reversibility.** High.

## 2026-10-16 — Master render = mezzanine; per-platform variants re-encoded from it

**Decision.** Master: libx264 High, preset `slow`, CRF 16, closed 2 s GOP, BT.709 tags,
yuv420p, AAC-LC 320 kbps 48 kHz stereo, loudnorm −14 LUFS / −1.5 dBTP (single pass; skipped
when every clip is silent — loudnorm cannot process pure digital silence), faststart.
Variants (`encodePlatformVariant`) per `PLATFORM_PROFILES`: canvas 1080x1920, master fps
capped at 60, H.264 High 4.2, closed GOP (IG/TikTok 2 s; YouTube 0.5 s = "half the frame
rate" per its official recommendation, overriding the ~2 s suggestion), 2 B-frames, CRF +
VBV maxrate per platform/fps, AAC-LC 48 kHz stereo (IG 128k per Graph API spec, TikTok 192k
— no official figure, YouTube 384k per official), TWO-PASS loudnorm (measure, then apply with
measured values, `linear=true`) to the profile target, faststart. Over `maxFileSizeBytes` →
one retry at a computed average bitrate (~92 % of the cap; refuses below 300 kbps video) →
`VariantTooLargeError`. Optional cover JPEG at `coverFrameSeconds`.

**Measured.** 8 s two-take timeline (2 texts, captions, 2 zooms, grade) master at preset slow:
~8.2 s render on this Mac (M-series) ≈ 1x realtime; veryfast ≈ 4–6.6 s. Variant encode of a
4 s master: ~1 s per platform at veryfast.

**Known limitation.** ffmpeg's native AAC encoder undershoots high targets on simple material
(384k requested → ~240k measured on pink noise); libfdk_aac isn't in ffmpeg-static. Platforms
re-encode audio anyway; revisit if a platform rejects.

### Platform sources (checked 2026-10-16)
- Instagram Graph API media reference (MOV/MP4, H.264/HEVC, closed GOP, 4:2:0, 23–60 fps,
  max width 1920, VBR ≤ 25 Mbps, AAC ≤ 48 kHz 128 kbps, 3 s–15 min, 300 MB, moov first,
  `thumb_offset` ms / `cover_url`):
  https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
- Meta Reels ads safe zone (14 % top / 35 % bottom / 6 % sides → 269/672/65/65 px):
  https://www.facebook.com/business/ads-guide/update/video/instagram-reels — ads placement;
  Meta publishes no organic figure.
- TikTok Content Posting API (MP4/WebM/MOV, H.264 recommended, 23–60 fps, 360–4096 px,
  4 GB, up to 10 min; real cap per creator from creator_info):
  https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide ;
  `video_cover_timestamp_ms`: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
- TikTok safe zone: NO official pixel figure (TikTok ships overlay templates that vary by
  caption length — https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads). Community
  measurements range top 130–254, bottom 350–707, right 120–242 px; we use the conservative
  240/660/60/160.
- YouTube recommended upload encoding (H.264 High, progressive, CABAC, 2 B-frames, closed
  GOP of half the frame rate, 4:2:0, 1080p SDR 8 Mbps @24–30 / 12 Mbps @48–60, AAC-LC
  stereo 48 kHz 384 kbps, moov first): https://support.google.com/youtube/answer/1722171 ;
  Shorts ≤ 3 min: https://support.google.com/youtube/answer/15424877 ; 256 GB:
  https://developers.google.com/youtube/v3/docs/videos/insert
- YouTube Shorts safe zone 288/672/48/192 px: Google Ads vertical-video guidance
  (https://support.google.com/google-ads/answer/9128498), shown as an image there; px values
  as consistently transcribed by community tools — ads guidance, not an organic Shorts spec.
- YouTube Shorts thumbnails: no cover-timestamp field in the API; `thumbnails.set` is
  best-effort for Shorts (custom Shorts thumbnails reached desktop Studio for YPP creators in
  2026; API effect unverified).
- Loudness: no platform publishes an official target for short-form; YouTube's ~−14 LUFS
  playback normalisation is measured, not documented. −14 LUFS / −1 dBTP chosen everywhere
  (conservative, common practice).

---

### VARIANT INTEGRATION

Call contract for the integrator (no DB/worker wiring was built here):

```ts
import { encodePlatformVariant, PLATFORM_PROFILES, checkAgainstProfile, probeVariant,
         VariantTooLargeError } from "@chris/media";

const res = await encodePlatformVariant({
  masterPath,                       // local path of the SUCCESS Render's mp4 (the master)
  outputPath,                       // e.g. <tmp>/<renderId>-INSTAGRAM.mp4
  profile: PLATFORM_PROFILES.INSTAGRAM,  // | TIKTOK | YOUTUBE
  coverFrameSeconds,                // optional: PlatformPackage.coverFrameSeconds
  // preset?: "slow" (default) — tests pass "veryfast"
});
// res: { outputPath, width, height, fps, durationSeconds, fileSizeBytes, videoBitrateKbps,
//        audioBitrateKbps, integratedLufs, truePeakDbtp, coverImagePath?, retriedForSize,
//        issues: ProfileIssue[], ffmpegArgs }
```

- Throws `VariantTooLargeError` when the cap can't be met after one retry (treat as a
  per-platform failure; other platforms proceed — graceful degradation).
- `res.issues` is `checkAgainstProfile(probeVariant(output), profile)`; persist it and block
  publishing on any `severity: "BLOCKING"` issue. Preflight of any file: `checkAgainstProfile(
  await probeVariant(path), profile)`.
- Suggested `RenderVariant` row: renderId, platform, storageKey, sha256, width, height, fps,
  durationSeconds, fileSizeBytes, videoBitrateKbps, audioBitrateKbps, integratedLufs,
  truePeakDbtp, coverStorageKey, retriedForSize, issues (Json), ffmpegArgs (Json), createdAt.
  Idempotency key: (renderId, platform, profile version).
- Cover: IG → upload cover JPEG as `cover_url` or pass `thumb_offset = round(coverFrameSeconds
  *1000)`; TikTok → `post_info.video_cover_timestamp_ms`; YouTube → no timestamp; optionally
  `thumbnails.set` with the JPEG (best-effort).
- Typical cost: ~1 s per 4 s of video per platform at veryfast; "slow" ~2–3x that.

---

### PREVIEW PARITY NOTES

Everything below is implemented in `@chris/media/timeline` (browser-safe). **Call the
functions instead of re-deriving the math**: `cropGeometry`, `normalizeZooms`, `zoomStateAt`,
`zoomWindow`, `resolveGrade`, `temperatureGains`, `vignetteAngle`/`vignetteFactor`,
`layoutTimelineText`, `layoutCaptionChunk`, `captionPlateColor`, `normalizeTexts`,
`timelineCaptionChunks`, `findTimelineCollisions`, `LAYOUT`, `FONT_METRICS`,
`PLATFORM_PROFILES`. Coordinates are canvas px (1080x1920 by default); scale the preview by
`previewWidth / canvas.width`.

**Fonts / measurement.** `@font-face { font-family: <FONT_REGISTRY.family>; src:
url(/api/fonts/<file>); font-weight: <weight>; }`, render with `font-weight` = the registry
weight (no synthetic bold). Provide `measureText(text, fontId, px)` =
`ctx.font = \`${weight} ${px}px "${family}"\`; ctx.fontKerning = "none"; ctx.measureText(text).width`
(wait for `document.fonts.load`). All DOM/canvas text must use `font-kerning: none;
font-variant-ligatures: none; letter-spacing: 0`. `fontPx = round(fontSize · canvas.width/1080)`.

**Clip crop / pan** (`cropGeometry(sourceWH, canvas, crop)`):
`cover = max(W/sw, H/sh)`, `s = cover·zoom`, video drawn at `sw·s × sh·s`, translated by
`(−offsetX, −offsetY)` with `offsetX = (sw·s − W)·(panX+1)/2`, `offsetY = (sh·s − H)·(panY+1)/2`.
(Renderer rounds the scaled size to even px and the crop offset down to even px: ≤ 2 px.)
Use the video's *displayed* (rotation-corrected) `videoWidth/videoHeight`.

**Zoom** (output-time `t`; zooms from `normalizeZooms(timeline.zooms, duration)`):
`{zoom, x, y} = zoomStateAt(zooms, t)`; apply to the whole composited video layer (after the
clip crop, BEFORE grade, under texts/captions): CSS `transform-origin: (x·100)% (y·100)%;
transform: scale(zoom)`. EASE: `zoom(t) = 1 + (Z−1)·e(p)`, `p = clamp((t−start)/easeSeconds,0,1)`,
`e(p) = p<0.5 ? 4p³ : 1 − (−2p+2)³/2`; CUT = Z inside `[start,end)`; back to 1 at `end`. The
renderer evaluates at frame times `n/fps` — sample the preview at the same `t` when paused.

**Grade** (`g = resolveGrade(timeline.grade)`), on the video layer only (not on text):
exact match via an SVG filter (`filter: url(#grade)`):
1. contrast/brightness: `feComponentTransfer` with each of R,G,B `type="linear"
   slope=g.contrast intercept=0.5·(1−g.contrast)+g.brightness` (ffmpeg eq: `v' = c(v−0.5)+0.5+b`;
   eq applies it to luma — RGB application differs imperceptibly).
2. saturation: `feColorMatrix type="saturate" values=g.saturation`.
3. temperature: `feColorMatrix type="matrix"` diagonal `(r,1,b)` from
   `temperatureGains(g.temperature)` = `(1+0.10t, 1, 1−0.12t)`.
CSS-only fallback (approximate): `brightness(1+g.brightness) contrast(g.contrast)
saturate(g.saturation)` and for temperature t>0 `sepia(0.25t) saturate(1+0.2t)`, t<0
`hue-rotate(${-12·|t|}deg) saturate(1−0.1|t|)` — prefer the SVG path.
4. vignette (`g.vignette > 0`): overlay a `radial-gradient(circle farthest-corner at 50% 50%, …)`
   in black with alpha at radius fraction d = `1 − vignetteFactor(v, d)` (sample d = 0, 0.1,
   … 1.0 as gradient stops); `vignetteFactor = cos(v·π/3 · d)^4`, d = distance from centre /
   half-diagonal (a CIRCLE to the farthest corner = half-diagonal, matching ffmpeg's dmax with aspect 1). Use
   `mix-blend-mode: normal` black-with-alpha (= multiply by factor).

**Texts** (`L = layoutTimelineText(text, canvas, measureText)`; draw only for
`start ≤ t < end`; use `normalizeTexts` for clamping):
- lines: `L.lines[i]` → draw `text` with the alphabetic baseline at `baseline`, left edge
  at `x` (canvas `fillText(text, x, baseline)` with `textBaseline="alphabetic"`; in DOM, absolutely
  position a span whose baseline lands there). Colour = `color` (alpha from #RRGGBBAA).
- layout rules (already applied by the function): `lineHeight = round(fontPx·1.18)`; plate pad
  `padX = round(fontPx·0.40)`, `padY = round(fontPx·0.24)`, radius `round(fontPx·0.18)`; when no
  plate, pad = stroke width; wrap width `maxWidth·W − 2·padX`; block = widest line + 2·padX by
  lines·lineHeight + 2·padY, centred at (x·W, y·H) then clamped inside the canvas; each line's
  cap height is vertically centred in its line box: `baseline = lineTop + (lineHeight +
  capHeight/upm·fontPx)/2`; align left/center/right inside the block.
- plate: rounded rect `L.plate.rect`, radius `L.plate.radius`, fill `backgroundColor` (alpha).
- stroke: `L.strokeWidth = max(1, round(fontPx·0.045))` px OUTSIDE the glyph (drawtext
  `borderw`). CSS/canvas: stroke width `2·strokeWidth` painted UNDER the fill
  (`paint-order: stroke fill; -webkit-text-stroke: 2·sw color` or canvas `strokeText` with
  `lineWidth = 2·sw`, `lineJoin="round"` then `fillText`).
- `uppercase` → `toUpperCase()` before measuring; `\n` = hard break.

**Captions** (chunks from `timelineCaptionChunks(timeline, wordsByAsset)`; a chunk shows for
`chunk.start ≤ t < chunk.end`; `C = layoutCaptionChunk(chunk, timeline.captions, canvas,
measureText)`):
- geometry: `lineHeight = round(fontPx·1.15)`; wrap width `0.78·W − 2·padX`; block centred
  horizontally on the canvas and vertically at `captions.y·H`, clamped; lines centred; baseline
  = cap-height-centred as for texts; word boxes `C.lines[i].words[j].{x,width}`.
- stroke (`strokeColor` non-null): `round(fontPx·0.055)` px outside glyphs (libass `\bord`),
  same CSS technique as texts.
- plate: BOXED always (`backgroundColor ?? #000000B3`); other presets only when
  `backgroundColor` is set. Pad `padX = round(fontPx·0.36)`, `padY = round(fontPx·0.20)`,
  radius `round(fontPx·0.24)`; one plate around the whole block (`C.plate.rect`).
- CLEAN: phrase in `color`; soft drop shadow offset `C.shadowOffset = max(1,
  round(fontPx·0.035))` px right AND down, colour `#00000080`, no blur (`text-shadow: s s 0
  rgba(0,0,0,.5)`).
- BOLD_HIGHLIGHT: phrase in `color`; the active word in `highlightColor`. Word i is active from
  (i == 0 ? chunk.start : word.start) to (i == last ? chunk.end : nextWord.start). No scale/
  weight change.
- BOXED: phrase in `color` on the plate (no highlight).
- KARAOKE: each word fills left→right from `color` to `highlightColor`: word i sweeps from
  `word.start` to `nextWord.start` (last word: `word.end`), linear in time across the word's
  box width (`fill fraction = clamp((t − start)/(end − start), 0, 1)`); filled words stay
  highlighted; implement as a clip-rect over a highlight-coloured copy of the word. (libass
  `\kf` timing is quantised to 10 ms.)
- `uppercase` and `wordEdits` are already applied by `timelineCaptionChunks`.

**Platform safe zones.** Overlay `PLATFORM_PROFILES[id].safeZone` (px at 1080x1920; scale with
the canvas) — `combinedSafeZone()` for "post everywhere". Same numbers preflight uses.


---

## 2026-10-16 — The finishing editor is a single-document, single-reducer client app

**Decision:** The editor edits exactly one `EditTimeline` (plus the not-yet-formalized
`coverFrameSeconds`) held in one `useReducer`. Every edit is a pure recipe from
`apps/web/lib/editor/timeline-ops.ts`; the reducer normalizes after each one (clips stay inside
their take and ≥ 0.1 s, overlays/cover clamped to the new duration) and keeps undo/redo as a
list of whole documents (cap 200). Continuous gestures (dragging a clip edge, moving text,
dragging a slider) pass a `coalesce` key, so one gesture = one undo step; pointer-up commits.
IDs are generated by the caller, never inside a recipe, so recipes stay pure under React's
double-invoked reducers.

**Alternatives considered:** an external state library (zustand/redux) or a command-pattern
history with inverse operations.

**Rationale:** the document is small (tens of items), so snapshot history is cheap, trivially
correct and directly testable (`apps/web/lib/editor/editor.test.ts`). No new dependency.

**Reversibility:** high — the ops are framework-free and would sit unchanged under another
state container.

---

## 2026-10-16 — Preview = real <video> elements + the renderer's own layout math, on one rAF clock

**Decision:** The 9:16 preview plays the timeline with one `<video>` per (take × slot):
consecutive uses of the same take alternate between two elements so the next clip is already
paused on its first frame — a cut is a visibility swap, not a seek. While playing, the active
video's `currentTime` is the master clock (no A/V drift); a wall clock only bridges stalls.
Everything visual uses the renderer's browser-safe math from `@chris/media/timeline`
(PREVIEW PARITY NOTES in timeline-engine.md): `cropGeometry` for crop/pan, `normalizeZooms` +
`zoomStateAt` (ease-in-out cubic) for punch-ins, `resolveGrade` → an exact SVG filter
(feComponentTransfer eq + feColorMatrix saturate + temperature gains, sRGB) and the cos⁴
vignette as a radial gradient, and `layoutTimelineText` / `layoutCaptionChunk` with browser
glyph measurement (canvas `measureText`, kerning off, registry weight) for texts and captions,
drawn in an SVG whose viewBox is the canvas (alphabetic baselines, plates, outside strokes via
`paint-order`, CLEAN shadow, BOLD_HIGHLIGHT active-word rule, KARAOKE clip-rect wipe updated per
frame). Per-frame work bypasses React (direct DOM writes + `useSyncExternalStore` selectors).

**Verified:** preview frame vs. the rendered MP4 frame at the same time are visually identical
(evidence 06/07).

**Alternatives considered:** WebCodecs/canvas compositing (pixel-exact, much more code, codec
edge cases); a server-rendered proxy per edit (slow feedback, contradicts "instant").

**Reversibility:** high — `playback.ts` / `Overlays.tsx` are self-contained.

---

## 2026-10-16 — "Finish & schedule" is four sequential Server Actions, not one

**Decision:** save (`saveFinishingEdit`) → render (`renderContentItem`) → Quality Gate
(`runQualityGateForContentItem`) → schedule (`scheduleContentItemForPublishing`), each its own
Server Action called in sequence by the modal, each returning a plain-English result instead
of throwing. Steps already satisfied are skipped (not dirty + READY → straight to schedule; not
dirty + RENDERED → straight to the gate). Any failure stops the flow with the edit saved, and
a gate failure never schedules (hard gates are not bypassable from the editor).

**Alternatives considered:** one long action (simpler, but no real progress and an all-or-nothing
timeout); a background job + polling (the right answer once render moves off-request, see below).

**Rationale:** real per-step progress for an impatient owner; every step stays within the page's
`maxDuration = 300`; failures are explained where they happened.

**Reversibility:** high.

---

## 2026-10-16 — Platform preview, safe zones and per-platform readiness are deterministic checks

**Decision:** The preview header offers All / TikTok / Reels / Shorts. A platform overlays a
stylized, unbranded mock of that app's UI (top bar, right action column, caption/username area)
plus a dashed safe-area guide; "All" shows only the union guide, faintly. Warnings
(`apps/web/lib/editor/platform-warnings.ts`) are pure code over the renderer's exact layouts:
text/caption footprints (`layoutTimelineText` / `layoutCaptionChunk`) vs. `PLATFORM_PROFILES`
safe zones (`combinedSafeZone` for "All"), duration vs. the profile's min/max, canvas aspect,
source sharpness (a reframe so tight that < 720 source px span the 1080 canvas), and the
Quality Gate's own `findTimelineCollisions` (captions over a text, text over text). Clicking a warning selects the offending
item. The Finish modal shows ✓ / ⚠ N per platform and lets Chris schedule anyway — the warnings
are advisory, the hard gates are not.

**Rationale:** per CLAUDE.md, geometry is deterministic code, not model judgment — and using the
renderer's layout functions means the warning is about the pixels that will actually render.
Warnings are computed client-side only after webfonts load (avoids SSR/client mismatch and
fallback-font widths).

**Reversibility:** high.

---

## 2026-10-16 — Local draft autosave + leave warning

**Decision:** Unsaved edits are mirrored to `localStorage` (`chris-editor:<itemId>:<editPlanId>`,
debounced 400 ms) and restored on reload with a visible "Unsaved changes restored · Discard"
chip; `beforeunload` warns while dirty. A server save (or Finish) clears the draft. Keying by
EditPlan id means a newer server version never silently loses to a stale draft.

**Reversibility:** high.

---

## 2026-10-16 — `/api/fonts/[file]`: auth-protected, FONT_REGISTRY-whitelisted font serving

**Decision:** The preview's `@font-face` rules load `/api/fonts/<file>`. The route only serves a
`file` listed in `FONT_REGISTRY`, resolved with the renderer's own `resolveBundledFontsDir()`
(so preview and render use the same TTFs), behind the session like `/api/media`, with
`Cache-Control: private, max-age=31536000, immutable`. Fonts are declared with
`font-weight: 1 1000` so the browser never synthesizes bold on top of an already-bold face.

**Reversibility:** high.

---

## 2026-10-16 — Grade semantics in the UI follow `resolveGrade`

**Decision:** The renderer resolves a grade as "preset values, overridden by any field that is
explicitly non-neutral". So in the editor, picking a look stores the preset with NEUTRAL fields
(the pure look); moving any slider BAKES the resolved look into explicit numbers and sets the
preset to NONE (labelled "Custom look"), so a slider dragged back to neutral really is neutral
in the render. Sliders always display `resolveGrade(grade)`.

**Reversibility:** high.

---

### INTEGRATION NOTES

State after merging `fix/usable-v1` (timeline render engine, EDITING rollback, render variants):

1. **No temporary fallbacks remain.** The initial timeline is the worker's own
   `timelineForPlan` (→ `planToTimeline`), called from the server loader
   (`apps/web/app/content/[id]/edit/lib/initial-timeline.ts`); a last-resort whole-take
   timeline is used only if a plan row can't be parsed at all. `PLATFORM_PROFILES` /
   `combinedSafeZone` are re-exported from `@chris/media/timeline`
   (`apps/web/lib/editor/platform-profiles.ts` adds only display order + short labels).
   `coverFrameSeconds` is stored directly on the timeline (schema field) — no side channel.
2. **Fonts:** the font picker and `@font-face` rules are generated from `FONT_REGISTRY`
   (15 fonts) at their registry weights; `/api/fonts/[file]` serves them via the renderer's
   `resolveBundledFontsDir()`, whitelisted by the registry.
3. **EDITING:** the domain now allows finishing edits from EDITING (rollback to
   EDIT_PLANNED), so the editor opens and saves after a failed render; the earlier workaround
   messaging was removed. The Finish flow re-saves from EDITING automatically.
4. **End-to-end verified** (real dev server + PGlite + two synthetic takes): set the look to
   B&W and added a text in the editor → Finish → save + render succeeded (the quality check then
   stopped on the missing Anthropic key, as expected) → a frame extracted with ffmpeg-static from
   the rendered MP4 shows the B&W grade, the new text and the highlighted caption exactly where
   the preview drew them (evidence 06 vs 07).
5. **Remaining preview approximations (all small):** the renderer applies `eq` to luma while the
   SVG filter applies it per RGB channel (imperceptible per the parity notes); the paused preview
   samples zooms at the playhead time rather than snapping to frame times `n/fps`; volume above
   100% previews at 100% (HTMLMediaElement limit) — the render applies the gain.
6. **Blob storage mode:** media URLs are `/api/media/<storageKey>` (302 to a presigned URL in
   blob mode). Playback works cross-origin; filmstrip thumbnails, the Look-tab frame and the
   cover thumbnail read pixels via canvas and fall back gracefully (clip colour + name /
   gradient swatch) unless the Blob store sends CORS headers.
7. **Entry points (additive only):** "Open editor" panel + "Edit this video" link on
   `apps/web/app/content/[id]/page.tsx` (when there's an edit plan and the state is in
   `FINISHING_EDIT_STATES`), "Edit video →" on scheduled calendar entries.
8. **Long renders:** Finish renders inside a Server Action (page `maxDuration = 300`). If
   renders move to a background worker, swap `renderStepAction` for enqueue + poll; the modal's
   step model already supports a long "running" state.
9. **Overlapping zooms:** the renderer drops a zoom that overlaps an earlier one
   (`normalizeZooms`); the preview uses the same function, so it shows exactly what renders. The
   timeline still lets you place overlapping zooms — a small follow-up could dim skipped ones.

Verification evidence: docs/evidence/2026-10-16-finishing-editor/ (01–07; headless Chrome against
the real dev server).

---

## 2026-10-16 — Migrations run on deploy (production builds only)

**Problem:** nothing applied Prisma migrations to the production database — someone had to copy
production credentials to a laptop and run `migrate deploy` by hand (the audit flagged this),
and the schema could silently lag the deployed code.

**Decision:** `apps/web`'s build runs `scripts/vercel-build.mjs` before `next build`. When
`VERCEL_ENV === "production"` it runs `prisma migrate deploy` (against
`POSTGRES_URL_NON_POOLING` — a session-capable connection, since migrations take advisory
locks — falling back to `DATABASE_URL`) and then the idempotent seed (brand docs, owner login
from `SEED_USER_EMAIL`/`SEED_USER_PASSWORD`, default flags). A failed migration fails the build,
so the previous deployment stays live. Preview builds share this project's database and so do
**not** migrate — an unmerged branch must never change the production schema. Locally the
script is a no-op. The seed no longer re-asserts `autonomy.shadow_only = true` on every run
(it only creates the flag when absent) so a deploy never overrides Chris's own setting.

**Production setup done 2026-10-16:** private Vercel Blob store `chris-content-media`
connected to the project (`BLOB_READ_WRITE_TOKEN`); env vars `CRON_SECRET`, `APP_TIMEZONE`,
`APP_BASE_URL`, `SEED_USER_EMAIL`, `SEED_USER_PASSWORD` set. The existing Supabase Postgres
integration provides `DATABASE_URL` / `POSTGRES_URL_NON_POOLING`.

**Reversibility:** revert the build script line; migrations can still be run manually.

---

# 2026-10-16 — iPhone-first app + editor, motion intelligence


---

## 2026-10-16 — Mobile-first UI: phones are the primary target, desktop is the enhancement

**Decision:** Chris mostly uses the system on his iPhone, so every page is styled phone-first
(Tailwind defaults = phone, `sm:`/`md:`/`lg:` add the tablet/desktop treatment). Concretely:
16px+ form text (iOS Safari zooms the page on focus below 16px), 44px minimum tap targets for
buttons/inputs/tabs/checkbox hit areas (Apple HIG), `100dvh` instead of `100vh`, long words wrap
(`overflow-wrap: break-word`, `break-all` on URLs/filenames), and wide tables become cards on
phones (Analytics list, Autonomy grid, Performance Snapshots) while the tables stay from `sm`/`md`
up. Every form submit button shows a spinner + "Working…" and disables itself while the Server
Action runs (`SubmitButton`, `useFormStatus`) — many actions take tens of seconds, and without
feedback a phone tap looks like nothing happened.

**Rationale:** spec Final Test — simpler for Chris's real workflow. Verified with Playwright
device emulation (iPhone SE / 15 / 15 Pro Max, iPad, 1440 desktop): no element extends past the
viewport on any page, no form control below 16px, no console errors.

**Alternatives considered:** a separate mobile route tree (duplicated logic, two UIs to keep in
sync) — rejected.

**Reversibility:** high (CSS/markup only; no schema or behavior change).

---

## 2026-10-16 — Navigation: bottom tab bar + "More" sheet below `lg`, top bar on desktop

**Decision:** Below 1024px (phones and iPad portrait) the 10-link top nav is replaced by a fixed
bottom tab bar — Home, Content, Film, Calendar, More — padded by `env(safe-area-inset-bottom)`,
and a bottom sheet for the rest (Ideas, Strategy, Analytics, Learnings, Reference, Connections,
Sign out). The top bar shrinks to the brand only and pads under the status bar. The desktop top
bar is unchanged. One source list (`nav-links-data.ts`); a unit test asserts tabs + More cover
every desktop destination exactly once.

**Rationale:** the old nav was ~965px wide and pushed every phone page sideways. The four tabs
are the daily loop (what needs me → what's in production → what to film → when it posts).

**Reversibility:** high.

---

## 2026-10-16 — Content detail page: sticky "next step" in the thumb zone, history collapsed

**Decision:** On phones/tablets the detail page pins the single next action above the tab bar
(`StickyActionBar`) — the same Server Action the gold "Next Step" panel uses (e.g. Run Quality
Gate, Publish now), or a jump link to the panel when the step needs input (Schedule → `#schedule`,
Upload → `#media`). Read-only history (contract, research, script, take, edit plan, render, QC,
packages, publications, snapshots, evaluation, comments, creator card, feedback, cancel, audit
trail) is in native `<details>` panels, collapsed by default except where the current state
makes one the thing to look at (e.g. the script while SCRIPTED, the render video when it
succeeded, snapshots once live). Hidden at `lg+`, where the panels are all visible.

**Rationale:** the page was ~6,000px of identical panels on a phone; "what do I do next" is now
one thumb-reach away. No behavior change: no new actions, no changed authority, nothing skips a
gate — it's a second entry point to the same forms.

**Reversibility:** high.

---

## 2026-10-16 — Calendar: day-by-day agenda on phones, week grid from `lg`

**Decision:** One markup renders as a vertical agenda (one card per day, full-width entries,
thumb-sized platform toggles and native `datetime-local`) with a sticky 7-day strip that jumps
to each day, and as the existing 7-column grid at `lg+`.

**Reversibility:** high.

---

## 2026-10-16 — Home-screen app: manifest, icons, `viewport` export

**Decision:** `export const viewport` in the root layout (`width=device-width`, `initialScale 1`,
`viewportFit: "cover"`, `themeColor #050506`, dark color scheme — Next 16 moved these out of
`metadata`). `metadata.appleWebApp` (capable, title "Chris Studio", `black-translucent` status
bar), `app/manifest.ts` (standalone, dark, 192/512 + maskable icons), `app/apple-icon.png`
(180px) and `app/icon.svg` — all rendered from the existing gold→violet circle mark (sharp, one
time; PNGs committed). Short name "Chris Studio". Pinch-zoom is **not** disabled (accessibility);
zoom-on-focus is prevented by the 16px inputs instead.

**Reversibility:** high.

---

## 2026-10-16 — Raw-take picker accepts `video/*` on phones

**Decision:** The uploader is a large "Add raw takes" tile wrapping a hidden
`<input type="file" multiple>`. On touch devices `accept="video/*"`, because iOS only offers the
Photos library (plus camera and Files) when every accepted type is image/video; with
`audio/*` included it falls back to Files only. Fine-pointer (desktop) devices still accept
`video/*,audio/*` so audio-only takes remain possible there. Upload progress per file, a
"keep this screen open" hint, and a `beforeunload` warning while a transfer is in flight.

**Alternatives considered:** `video/*` everywhere (drops audio-only uploads on desktop).

**Reversibility:** high.

---

## 2026-10-16 — Shared CSS changes that also reach the editor

**Note for the editor owner:** `globals.css` changes are global. `.btn` now has
`min-height: 44px` (38px at `lg+` with a fine pointer), wraps its label on phones only, and is
`nowrap` from 640px; `.field-input` is 16px (14px at `lg+` fine pointer) with `min-height` 44px;
checkboxes/radios default to 20px (in `@layer base`, so utility classes like `h-4 w-4` still
win); `body` has `overflow-x: clip` as a last-resort guard. Editor files were not touched.

---

## 2026-10-16 — Verification environment notes (no product impact)

Turbopack's Google Fonts fetch timed out in the agent sandbox, so the throwaway screenshot
environment mirrors Inter locally via `NEXT_FONT_GOOGLE_MOCKED_RESPONSES`. Pages were checked in
Chromium (Playwright iPhone/iPad descriptors: `isMobile`, `hasTouch`, DPR 2–3) at 320/375/393/
430/820/1440px and in WebKit (Safari's engine) at 320/375/393/430px — no horizontal overflow, no
form control under 16px, no app console errors (WebKit headless logs its own `<video>` control
icon "placard" warnings, not ours). Desktop WebKit is not iOS Safari: a check on a real iPhone
(safe-area insets, home-screen launch, Photos picker) remains a follow-up.


---

## 2026-10-16 — The finishing editor gets a touch shell; desktop stays a ≥1024px enhancement

**Problem:** Chris edits on his iPhone. The editor was a desktop three-column workspace
(media bin | 9:16 preview | inspector, timeline below) driven by mouse and keyboard; at 393px
wide it rendered the desktop grid squeezed off-screen (baseline screenshot before this change).

**Decision:** `Editor` keeps one document/reducer/playback engine and renders one of two shells,
chosen by a media query (`layout-hooks.ts`): **desktop** at `(min-width: 1024px) and
(min-height: 560px)` (unchanged workspace), otherwise the **touch shell** (`MobileShell.tsx`) —
phones in portrait and landscape, iPad in portrait. Mobile-first: the server and the first
hydration pass render the touch shell; `useSyncExternalStore` swaps to desktop before paint.

Touch shell (CapCut / VN / Edits conventions):
- Full-screen `100dvh` app shell with `env(safe-area-inset-*)` padding; the edit route exports
  its own `viewport` (`viewportFit: "cover"`, `maximumScale: 1`, `userScalable: false`,
  dark `themeColor`) — the root layout is untouched. `html:has(.ed-root)` turns off page
  scroll/overscroll; iOS `gesturestart` is prevented so pinches never zoom the page.
- Compact top bar (back, truncated title + length/save status, Save when dirty, **Finish**),
  preview filling the upper area, transport row (time, big play, undo/redo), the timeline,
  and a bottom toolbar of 64px icon+label tools (Split, Edit, Text, Captions, Zoom, Look,
  Add clip, Cover, Platforms). Selecting something swaps the toolbar for that item's quick
  actions (clip: Split/Trim/Volume/Reframe/Duplicate/Delete; text: Edit text/Style/
  Duplicate/Delete; zoom: Adjust/Aim/Delete).
- **Timeline with a fixed centre playhead** (`MobileTimeline.tsx`): tracks scroll under it
  (native momentum scrolling = scrubbing), pinch zooms, tap selects; a selected clip grows
  20px white trim handles (`touch-action: none`) that snap to the playhead/cut points with a
  haptic tick where supported; long-press (380ms) lifts a clip to reorder it (a document-level
  non-passive `touchmove` blocks scrolling only while lifted). Text/zoom spans: tap to select,
  then drag body/handles.
- **Bottom sheets** (`Sheet.tsx`) hold the existing inspector panels: grabber + title + Done,
  half/full snap points, flick or swipe down to dismiss, transform-only animation. While a sheet
  is at half height the stage shrinks so the whole 9:16 preview and the transport stay visible
  above it. On a landscape phone sheets become a right-hand side panel.
- Inspector controls are re-laid-out for fingers under `.ed-m` (44px inputs at 16px font so iOS
  never zooms on focus, 28px slider thumbs, 36px swatches, iOS-size toggles, 40px segments).
- **Typing** a text happens in a bar docked above the keyboard (`visualViewport` inset — iOS
  overlays the keyboard rather than resizing the page); it edits the element live. Tapping a
  selected text opens it; the canvas suppresses compatibility mouse events on touch so the
  bar's field keeps focus.
- Finish & schedule becomes a near-full-screen sheet with 16px date input, 56px platform rows
  (the whole row is the checkbox's label) and a 52px primary button.

**Alternatives considered:** CSS-only responsiveness of the desktop shell (rejected: a
side-panel inspector and a left-anchored, mouse-drag timeline are the wrong interaction model
on a phone, not just the wrong size); a separate mobile route (rejected: two editors would
drift; one doc/engine/reducer is shared and every edit op is the same pure function).

**Reversibility:** high — the desktop shell is untouched except shared refactors below; the
breakpoint is one media query.

## 2026-10-16 — One multi-pointer gesture controller on the preview (mouse and touch)

**Decision:** overlays (`Overlays.tsx`) no longer attach their own window listeners; elements
carry `data-gesture`/`data-id` and the canvas (`Preview.tsx` `Canvas`) runs a single
Pointer Events controller with pointer capture and per-pointer tracking: one finger drags
(text with centre-snap guides, captions vertically, reframe pan, zoom aim), two fingers pinch
(text size, caption size, reframe zoom), re-baselining whenever a finger is added or lifted so
nothing jumps. Pinching on empty picture while a text is selected scales that text. A tap on
empty picture toggles playback on touch (selects the clip on screen with a mouse). Behaviour
change on desktop: clicking an already-selected text starts typing (double-click still works).
The pure geometry (pinch scale/translation, slop, snap) is in `lib/editor/touch-math.ts` with
unit tests.

## 2026-10-16 — Preview playback uses a fixed pool of two `<video>` elements

**Problem:** the engine mounted up to two elements per take (2 × N decoders). iOS Safari limits
concurrent hardware decoders and only lets an element play with sound once `play()` was called
on it inside a user gesture.

**Decision:** clip *i* plays on pool element *i % 2* (`lib/editor/player-pool.ts`); the engine
swaps `src` only when the take changes and applies the seek on `loadedmetadata`. The other
element is pre-rolled to the next clip's first frame, so cuts remain a visibility swap
(verified: playing across a Take 1 → Take 2 cut switches elements with the clock continuous).
`play()` is only ever called from the play tap, and in that same gesture the engine starts
(muted) and pauses the other pool element to unlock it for sound. Elements are `playsInline`,
`preload="auto"`, `disablePictureInPicture`; no `requestVideoFrameCallback` dependency.

**Known limit:** iOS ignores `HTMLMediaElement.volume` — on an iPhone the preview plays at full
volume (mute works); the clip level is applied by the renderer. The volume sheet says so.

## 2026-10-16 — Mobile visual verification ran on Chromium only

Playwright WebKit could not be installed offline in this environment, so the iPhone/iPad checks
(375×667, 393×852, 430×932, 852×393 landscape, 820×1180, plus desktop 1440×900) ran on Chromium
with `isMobile`/`hasTouch`, an iOS user agent and real CDP multi-touch (taps, swipes, pinches,
long-press). iOS-specific behaviour (keyboard/visualViewport, gesture unlock for audio, decoder
limits, safe-area insets) is implemented to the WebKit rules but **still needs a pass on a real
iPhone**. Evidence: `docs/evidence/2026-10-16-mobile/editor-*.jpg`.


---

## 2026-10-16 — Subject tracking: UltraFace RFB-640 on onnxruntime-node, ~3 fps, protected head region

**Decision:** `packages/media/src/subject-track.ts` samples each raw take at 3 fps with
ffmpeg (letterboxed into 640x480, aspect preserved), runs the UltraFace "version-RFB-640"
ONNX face detector (Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB, **MIT**, 1.6 MB,
vendored at `packages/media/assets/models/ultraface/` with `LICENSE` + `SOURCE.txt` incl.
SHA-256) on CPU via `onnxruntime-node` (now a direct dependency of `@chris/media`, same
1.21.0 the Whisper stack already pulls in), keeps the dominant face per frame (size x score,
continuity bonus), fills gaps <= 1 s, median(5)+EMA smooths, and expands the face to a
**protected head region** (+60% above for hair, +35% each side, +25% below). Stored on
`MediaAsset.subjectTrack` as `[{ t, box | null }]` in SOURCE-frame fractions via
`recordSubjectTrack` (audit `MEDIA_ASSET_SUBJECT_TRACKED`, no state change). The body is
derived (`bodyRegionFromHead`, 2.6x head width down to the frame bottom), not stored.

**Alternatives considered:** YuNet (OpenCV Zoo) — smaller, but its multi-stride output
decoding is more code to get exactly right; transformers.js object detection (person boxes)
— whole-body boxes are too coarse to tell "over his face" from "over his shirt"; MediaPipe
— no maintained Node runtime; an LLM vision call per frame — expensive and non-deterministic
for a geometric question (CLAUDE.md: deterministic when the check is deterministic).

**Rationale:** the question "where is the face" is geometric and must be fast, free and
reproducible. Measured: a 6 s 1080x1920 clip analyses in ~0.4–0.5 s after warm-up (~15 ms
per inference; decoding dominates), i.e. a 60 s take in a few seconds. The slow test composites
a real public-domain portrait (Official Portrait of President Reagan, 1981 — US federal work,
Wikimedia Commons; see `src/__tests__/fixtures/NOTICE.txt`) sliding across a 1080x1920 frame
and asserts the track follows it within 0.08 of frame width.

**Reversibility:** high — the detector is behind `analyzeSubjectTrack`; the stored format is
detector-agnostic. Swap the model file + `decodeUltraFace` to change detectors. Known limits:
UltraFace is a frontal-ish face detector (profile shots may drop out → gaps → placement uses
the last known/assumed region); rotation is handled by reading the display rotation in
`displayDimensions`. `SUBJECT_TRACK_MODEL_PATH` overrides the model location (serverless).

---

## 2026-10-16 — Placement engine: deterministic grid search, hard vs soft obstacles, never a silent overlap

**Decision:** `packages/media/src/visual-placement.ts` (pure, browser-safe, exported from
`@chris/media/timeline`). For each `placement.mode === "AUTO"` visual it maps the head
region through each clip's crop (`cropGeometry`) and the output zooms into canvas px and
unions it over the visual's time window; obstacles are: head (HARD), caption blocks on
screen then (HARD — exact `layoutCaptionChunk` rects when `measure` + word timings are given,
else the whole caption band), text overlays active then (HARD), other visuals on screen then
(HARD), body (SOFT, penalised by overlap fraction); everything must stay inside the platform
safe area (`combinedSafeZone()` by default). It scores a 16 px grid of centres at scales
1 / 0.9 / 0.8 / 0.7 (bigger always wins if clear) by torso overlap, preferred height per
template, horizontal balance, and distance from the previous position (so re-solving while
Chris edits doesn't make graphics jump). Footprints per template live in
`visual-footprints.ts` (`TEMPLATE_FOOTPRINTS`, px at 1080x1920, scale 1) — the motion
templates must draw inside them. `TITLE_CARD` is full-frame and centred (allowed over the
subject; it dims the background). `CALLOUT` labels stay within ~520 px of `pointTo`, never on
the target, never on the face. In AUTO mode the engine owns x, y **and** scale (it always
solves from 1, so repeated solves never compound a shrink); MANUAL visuals are never moved —
they become obstacles and get `MANUAL_COVERS_SUBJECT` / `MANUAL_COVERS_CAPTIONS` /
`MANUAL_OUTSIDE_SAFE_ZONE` warnings. No clear spot → least-bad spot + `LOW_CONFIDENCE`
warning naming what it overlaps; no track for a take → `ASSUMED_HEAD_REGION` (centred
framing) + `NO_SUBJECT_TRACK`.

**Alternatives considered:** a fixed menu of named slots (top band / side / lower-middle) —
simpler but fails as soon as Chris is off-centre or a zoom moves his face; letting the LLM
choose coordinates — it cannot see the frame, and placement is geometry.

**Rationale:** deterministic, explainable, fast enough to run on every editor change (a
few ms per visual), and identical in preview and render because both call the same function.

**Reversibility:** high — weights and footprints are constants in two files.

**Note on the safe area:** the union of all three platforms' chrome (top 288, bottom 672,
left 65, right 192 px) leaves an 823 x 960 px box. Wide templates (BAR_CHART 900,
COMPARISON 940, KINETIC_TEXT 900) therefore shrink to ~0.9 for "post everywhere", and with
Chris filling the middle third, a big chart may only fit over his torso (soft) or not at all
(LOW_CONFIDENCE). This is honest; if it's too conservative in practice, pass a per-platform
`platformSafe` (e.g. Instagram only) or revisit footprints with the template designer.

---

## 2026-10-16 — Motion Designer agent (MEDIUM): model picks what/when, code enforces facts, timing, restraint, placement

**Decision:** `packages/agents/src/motion-designer-agent.ts` + `prompts/agents/MOTION_DESIGNER.md`
(model_class MEDIUM). Output schema is an explicit **discriminated union over the 14
templates**, each props object `.strict()` with every field required (nullable for optional)
— a strict structured-output schema, no `z.record`; a test asserts its keys mirror the
contract's `MotionPropsSchemas`, and the contract schema validates bounds afterwards.
`designVisualsForTimeline(provider, { timeline, wordsByAsset, subjectTracks, research,
script, tier, brandContext, ... })` then, in code:
1. **FACTUAL HARD RULE** — every number a visual would show (numeric props, and every digit
   or spelled-out number inside any string: labels, titles, kinetic text) must match a number
   from the research packet's numeric inputs (value + label), FACT statements, calculation
   notes, primary claim, or the latest Claims-Gate-passed script. Formatting variants are
   accepted ("24,500" = "$24.5K" = 24500; 20% = 0.2; "three" = 3) and honest roundings to
   fewer significant digits within 5% ("$24K" for 24,480; never "100" for 149). Anything
   else: the whole visual is dropped and reported in `rejectedVisuals` with
   `FACTUAL: <number> (<field>) not found…`. Structural fields (decimals, highlightIndex,
   callout coordinates, a counter's `from: 0`) aren't shown numbers.
2. snap to word boundaries on the OUTPUT timeline (start just before the key word's onset,
   end at a word end), 1.5–5 s, clamped to the video;
3. no overlaps, >= 0.4 s between graphics (trim the earlier if it keeps >= 1.5 s, else keep
   the more `importance`-ant one); existing visuals are kept (unless `replaceExisting`) and
   avoided in time; ids `mv-N` never collide;
4. restraint caps: per tier RAW 2 / FAST 4 / MEDIUM 7 / HERO 9, and never more than ~1 per
   6 s of video; TITLE_CARD only at MEDIUM/HERO, max one;
5. AUTO placement defaults, then `solveVisualPlacements` when subject tracks are provided.

`@chris/agents` now depends on `@chris/media` (only the pure `@chris/media/timeline` entry —
schemas, placement, caption timing). No cycle (media never imports agents).

**Alternatives considered:** enforcing the number rule only in the prompt (unreliable — the
spec's hard gates are code); letting the Quality Gate catch it after render (too late and
expensive; the QG's FACTUAL check still covers on-screen numbers as a second line);
`z.record` props (rejected: unparseable downstream, CLAUDE.md typed-output rule).

**Rationale:** the model is good at "this moment needs a chart"; it is not trustworthy on
"is 31,000 a real number here". Splitting judgment from verification is the system's
pattern (Edit Planner + snapping, Claims Gate + deterministic pre-checks).

**Reversibility:** high — prompt is versioned; caps/thresholds are exported constants.

---

## 2026-10-16 — Motion design job: two triggers, existing save paths, flag-gated autonomy

**Decision:** `apps/worker/src/motion-design-job.ts` →
`designMotionForContentItem(db, storage, provider, contentItemId, actor, { trigger, replaceExisting, analyze, skipTracking })`.
It builds the current Timeline (`timelineForPlan`: finishing edit or converted AI plan),
runs `ensureSubjectTracks` for every take the clips use (tracker failure degrades to assumed
framing + warning, never blocks), loads word timings, the latest ResearchPacket, the latest
**filmable** ScriptVersion (`isScriptVersionFilmable`), tier and brand context, runs the
Motion Designer, and saves a NEW EditPlan version with `plan.timeline` including visuals:
- `trigger: "HUMAN"` (the editor's "Design visuals with AI" button): `saveFinishingEdit` —
  allowed from every finishing state; a rendered item rolls back to EDIT_PLANNED exactly like
  any finishing edit (a previous render's gate PASS doesn't cover new on-screen numbers).
- `trigger: "AUTO"` (optional pass right after the Edit Planner on a fresh edit): only when
  feature flag **`motion.auto_design`** is on (fail-closed) and the item is EDIT_PLANNED;
  `recordReplannedEditPlan` with actorType SYSTEM, no state change.
Every run writes an `MOTION_DESIGN_RUN` audit row (added visuals, rejected visuals with
reasons, placement warnings, model, research/script ids). The state machine is unchanged.
`apps/worker/src/subject-track-job.ts` → `trackSubjectForMediaAsset`, `ensureSubjectTracks`.

**Alternatives considered:** writing visuals into the AI EditPlan schema (would fork the
plan/timeline split the finishing editor established); auto-running on every plan without a
flag (CLAUDE.md: autonomy is earned per subsystem).

**Reversibility:** high — both triggers are additive; turning the flag off stops the
automatic pass; every version is a new row.

---

### INTEGRATION NOTES (for the finishing editor UI and the render engine)

**Imports (browser-safe):** `import { solveVisualPlacements, resolveVisualPlacements,
placementWarnings, visualRect, subjectRegionsForWindow, TEMPLATE_FOOTPRINTS, parseSubjectTrack,
combinedSafeZone } from "@chris/media/timeline"`.

1. **Load once per editor session:** each clip take's `subjectTrack` (parse with
   `parseSubjectTrack`), `width/height` (→ `sourceDimensions`), `transcriptWords`
   (→ `wordsByAsset`), and the canvas `measureText` the preview already uses.
2. **Live while Chris edits** (drag/resize/retime a visual, move captions or text, change a
   crop/zoom, add/remove clips): call
   `solveVisualPlacements(timeline, { subjectTracks, sourceDimensions, wordsByAsset, measure, platformSafe })`
   and write `result.visuals` back into the document (only AUTO visuals change; it's
   deterministic and stable, so unchanged inputs give identical output — safe to call on
   every change; debounce ~50 ms if needed). Cost: a few ms per visual.
3. **Dragging a visual** = set its `placement.mode` to `"MANUAL"` with the dropped x/y (and
   scale if resized). Offer "Auto-place" to flip it back to `"AUTO"`.
4. **Warnings:** show `result.warnings` next to the visual (`visualId`): `WARNING` severity
   (`LOW_CONFIDENCE`, `MANUAL_COVERS_SUBJECT`, `MANUAL_COVERS_CAPTIONS`) as an amber badge on
   the clip in the timeline + the message in the inspector; `INFO` (`SHRUNK`,
   `NO_SUBJECT_TRACK`, `MANUAL_OUTSIDE_SAFE_ZONE`) as a subtle note. `result.details[id]`
   gives the footprint rect, the head/body regions and confidence — draw the head region as
   a faint "protected" overlay while dragging, and the footprint as the drop preview.
5. **"Design visuals with AI" button:** server action → `designMotionForContentItem(db, storage,
   provider, contentItemId, { actorId }, { trigger: "HUMAN" })` (worker export
   `@chris/worker/motion-design-job`). It may run the subject tracker first (a few seconds per
   take). Show `rationale`, the added visuals (each has `anchorText` = the phrase it
   illustrates), and `rejectedVisuals` ("dropped: FACTUAL — 31000 isn't in the research") so
   Chris sees what was held back and why. Then reload the latest plan (new version).
   Optional "Replace existing" → `replaceExisting: true`.
6. **Render engine:** before compositing, call `resolveVisualPlacements` with the same inputs
   (server: `measure = nodeMeasureText`) so the render matches the preview even if tracks
   arrived after the last save; templates must draw within `TEMPLATE_FOOTPRINTS` x `scale`,
   centred at `placement.x/y`.
7. **Pipeline (optional AUTO pass):** after the Edit Planner saves a fresh plan, call the job
   with `trigger: "AUTO"`; it is a no-op unless `motion.auto_design` is enabled.
8. **Tracking on ingest (recommended):** call `trackSubjectForMediaAsset` right after
   transcription for each take, so tracks exist before Chris opens the editor.

## 2026-10-16 — Production database moved from Supabase (suspended) to Neon

The first deploy of the usable-v1 branch failed at `prisma migrate deploy` (P1001): Vercel
reported the project's Supabase Free database as **suspended** (Supabase pauses free projects
after inactivity; this one had never been used). Because a failed migration fails the build,
the previous deployment stayed live — the guard worked as designed.

**Decision:** a free Neon Postgres (`chris-studio-db`, iad1) was created through the team's
existing Neon integration and connected to the project (it provides `DATABASE_URL` pooled and
`POSTGRES_URL_NON_POOLING` for migrations). Neon's free compute auto-suspends but wakes on the
next connection, so it never needs a manual "restore". The Supabase store was disconnected
from the project, not deleted (it had no app data); its stale `DATABASE_URL` env var was
removed so Neon's could be attached. Redeploy applied all 16 migrations and seeded the owner
login; live login verified over HTTPS.

**Reversibility:** reconnect the Supabase store (after restoring it in Supabase) and swap the
env vars back.

---

# 2026-10-16 — Cinematic motion engine

## 2026-10-16 — Motion graphics are rendered by Remotion 4 (React + three.js) in a new `@chris/motion` package

**Decision:** `packages/motion` (`@chris/motion`) renders `EditTimeline.visuals` (the committed
contract in `packages/media/src/motion-contract.ts`, unchanged) with Remotion 4.0.533 —
`remotion`, `@remotion/bundler`, `@remotion/renderer`, `@remotion/player`, `@remotion/three` —
plus `three` 0.186.1 and `@react-three/fiber` 9.8.1 on React 19.2.8 (all pinned exactly;
R3F 9.8 peer range `react >=19 <19.4` matches the repo's React). No drei: every 3D object is
modeled procedurally (ExtrudeGeometry rounded slabs, tubes, tori, lathe-free primitives) so
there is no asset/CDN dependency.

Package layout:
- `src/timing.ts` (pure): props parsing with defaults (`parseVisual(s)` — never throws; invalid
  visuals are reported and skipped, never rendered wrong), frame windows
  (`round(start*fps)`, same rounding as the renderer), AUTO transition table, placement box
  math (`placementBox`: center = placement x/y, designed size × `placement.scale` × canvas
  unit; clamped inside a 36 px margin and shrunk if it would not fit — `clamped` says so),
  MONEY_STACK_3D stack-count scale.
- `src/remotion/*`: the `VisualsLayer` composition (all visuals, transparent), `VisualClip`
  (one visual from frame 0 — used by the renderer) and `Preview-<TEMPLATE>` compositions
  (sample props, 4 s) for thumbnails/testing; 14 template components; motion vocabulary
  (`SPRINGS`, eases, enter/exit styles with a velocity-tracking blur for a motion-blur feel).
- `src/render.ts` (Node): `renderVisualsLayer()`; `src/assets.ts`: SFX kit paths.
- `src/player.tsx` (client): `<VisualsPreview>` on `@remotion/player`.
- `scripts/generate-sfx.mjs`, `scripts/showcase.ts` (quality loop).

**Alternatives considered:** hand-written canvas/ffmpeg drawtext animation (no 3D, weak
typography, no spring physics); Motion Canvas (smaller ecosystem, no first-class React Player
for the editor); Lottie (needs a designer pipeline, no data-driven 3D).

**Rationale:** the same React components render the server output and the browser preview,
so "what the editor previews is what renders" (the timeline-engine principle) extends to
motion. Remotion gives frame-exact deterministic rendering, spring physics and WebGL 3D.

**License:** Remotion is source-available under the Remotion License: free for individuals
and companies with up to 3 employees (this is a single-operator product — Chris), otherwise a
company license is required (remotion.pro). `acknowledgeRemotionLicense` is set on the Player.
**Re-check if the business grows past 3 people.** three.js / R3F are MIT.

**Reversibility:** moderate — the contract (`motion-contract.ts`) is engine-agnostic; another
renderer could implement the same 14 templates and the compositor only needs alpha clips.

---

## 2026-10-16 — Alpha format: ProRes 4444 (`yuva444p10le`) .mov clips, one per visual

**Decision:** `renderVisualsLayer` renders with `codec: "prores"`, `proResProfile: "4444"`,
`pixelFormat: "yuva444p10le"`, `imageFormat: "png"`, `colorSpace: "bt709"`. Default strategy
`PER_VISUAL`: one short clip per visual (only its own frames); `FULL_LAYER` (one full-length
layer) is available. The compositor overlays each clip with
`setpts=PTS-STARTPTS+start/TB` and `overlay=...:eof_action=pass:enable='gte(t,s)*lt(t,e)'`.

**Alternatives considered:** VP8/VP9 WebM with alpha (smaller, but ffmpeg only decodes the
alpha plane when the `libvpx` decoder is forced on the input — easy to get silently-opaque
output); a PNG sequence (huge, slow I/O); FULL_LAYER as default (renders every empty frame).

**Rationale:** ffmpeg-static's native ProRes decoder always yields `yuva444p12le` with alpha —
verified by test (`timeline-motion-mix.test.ts` composites a synthetic ProRes 4444 clip and
asserts graphics pixels inside the window and none outside it; the motion integration test
asserts the Remotion clip's `pix_fmt` is `yuva*` and that graphics appear only in their
windows/regions). BT.709 tagging matches the H.264 master so gold stays gold. PER_VISUAL
renders only frames where something is on screen.

**Reversibility:** high — format and strategy are parameters.

---

## 2026-10-16 — Compositing order and audio mix in `renderTimeline`

**Decision:** in `packages/media/src/timeline-render.ts`:
- Video: base clips → zoom → grade → **motion overlays** → text plates / texts → captions.
  Graphics are not color-graded, and speech captions stay on top of graphics.
- Audio (`buildAudioMix`, pure, unit-tested): voice = the existing loudnorm chain; SFX = one
  input per distinct sound, `asplit` per hit, `adelay` to the hit time, gain =
  volume × `SFX_HOUSE_GAIN` (0.5); visual `enterSfx` hits at the visual's start use
  `VISUAL_SFX_VOLUME` (0.6, the TimelineSfx default); `audio.sfxEnabled=false` drops all of
  them; music bed = `-ss trackStart`, referenced to −14 LUFS (so `levelDb` really means "dB
  under the voice"), `apad`/`atrim` to the video, fades, then ducking; `amix normalize=0` and
  a final `loudnorm I=-14:TP=-1.5:LRA=11` (or `alimiter` when normalize is off).
- **Ducking:** deterministic volume automation from the real word timings when any clip's
  take has them: speech regions (words mapped through each clip's source window, merged when
  gaps < 0.45 s), level − duckDb under speech, 0.15 s ramp down *before* each region (the duck
  is in place when the first syllable lands), 0.4 s release. Fallback with no word timings:
  `sidechaincompress` keyed by the voice, ratio chosen so ~18 dB over threshold ≈ `duckDb`.
- Missing SFX files / missing music file → a warning and the render continues (graceful
  failure); a missing motion clip path → error (the layer was supposed to exist).
- With no visuals, no SFX and no music the filter graph is byte-identical to before (the
  existing render tests pass unchanged; a unit test asserts the legacy chain).

New optional inputs: `visualsLayer.segments`, `musicPath`, `sfxFiles`. New result field:
`motion { overlays, sfxEvents, music }`.

**Alternatives considered:** sidechain-only ducking (reacts after the first syllable and
pumps on breaths/room noise); ducking by a fixed `volume` per caption chunk (coarser).

**Reversibility:** high.

---

## 2026-10-16 — Procedural SFX kit (no licensing risk)

**Decision:** `packages/motion/assets/sfx/{whoosh,swoosh_up,soft_pop,click,tick,riser,impact,shimmer,cash}.wav`
— one per `SFX_SOUNDS` id — are synthesized from scratch by
`packages/motion/scripts/generate-sfx.mjs` (seeded noise, Chamberlin SVF sweeps, sine/FM
oscillators with pitch envelopes, a Freeverb-style stereo reverb, raised-cosine releases, TPDF
dither). 48 kHz stereo 16-bit, peak-normalized to −8 dBFS (true peak ≤ −7.6 dBFS), short
tails, gentle top end. Reproducible: `pnpm --filter @chris/motion sfx`.

Measured (ffmpeg ebur128/astats): peak −8.0 dBFS on all; integrated −16.8 … −21.8 LUFS for
the sustained ones (CLICK/TICK/SOFT_POP are too short to gate). Spectrograms were checked
(showspectrumpic) and the design iterated: hard cut-offs at buffer ends (WHOOSH, SHIMMER,
CASH, IMPACT) were fixed with releases and longer buffers; the RISER keeps its crisp end
into a short reverb tail by design. Evidence: `docs/evidence/2026-10-16-motion/sfx-spectrograms.jpg`.

**Rationale:** original audio is the only zero-risk option for a publishing product; the
synth palette (filtered noise + soft sines) is exactly what tasteful UI/explainer SFX are.

**Reversibility:** high — files are swappable; the mixer only needs `sfxFiles`.

---

## 2026-10-16 — Render performance

See the numbers recorded at the end of this file ("Render timings"). PER_VISUAL is the
default because a typical 30–60 s edit has visuals on screen for well under half its length.
Concurrency defaults to Remotion's (half the CPU cores); pass `concurrency` to tune. The
Remotion bundle (webpack/rspack) is built once per process and cached.

---

### INTEGRATION NOTES

**Worker (`apps/worker/src/render-job.ts`).** `renderContentItem` calls
`prepareMotion(db, storage, timeline, sources, workDir, warnings, options.motion)` before
`renderTimeline`:
- visuals present → lazily loads `@chris/motion` (non-literal `import()` so Next.js never
  bundles Remotion through apps/web → @chris/worker) and runs `renderVisualsLayer` at the
  same fps `renderTimeline` will choose (probe of the actual sources, `chooseOutputFps`);
- any SFX will play → `sfxFiles()` from the kit;
- `audio.music` → downloads the MUSIC MediaAsset from storage (must be `kind: MUSIC`).
Every failure becomes an `unexecutedInstructions` warning on the Render row and the video
still renders (graceful degradation). `options.motion.visualsEnabled=false` is the feature
flag to render without the motion layer. The QC report gets a `motion` block
(visuals, overlays, framesRendered, motionRenderMs, sfxEvents, music mode).
AUTO placement is NOT solved here — the given `placement` is rendered as is (another
engineer's `resolveVisualPlacements` should run before rendering).

**Editor (`@chris/motion/player`).**
```tsx
"use client";
import { VisualsPreview } from "@chris/motion/player";
<div style={{ position: "relative", width: w, height: h }}>
  {/* existing preview surface */}
  <VisualsPreview timeline={timeline} currentTime={t} playing={isPlaying}
                  width={w} height={h} fps={30} fontBaseUrl="/api/fonts" />
</div>
```
The editor's clock is the source of truth: paused → exact `seekTo(round(t*fps))`; playing →
the Player runs and is re-synced when it drifts > 2 frames. Transparent, pointer-events none.
Fonts: the web app already serves `packages/media/assets/fonts` at `/api/fonts/<file>`.
apps/web needs `@chris/motion` as a dependency and (Next.js) `transpilePackages:
["@chris/motion"]` because the package ships TS source; `three`/`@react-three/fiber` are only
loaded by the 3D templates. Pure helpers (timing/placement/samples) for the editor UI:
`@chris/motion/pure`.

**Where rendering can run.** Remotion needs a headless Chrome (+ WebGL for the 3D templates;
we launch with `gl: "angle"`). `renderVisualsLayer` uses `REMOTION_BROWSER_EXECUTABLE` if set,
else an existing Puppeteer/Playwright `chrome-headless-shell`, else Remotion downloads its own
(`ensureBrowser`, ~90 MB, cached). It cannot run inside a regular Vercel Function (no Chrome,
250 MB bundle limit, short timeouts). Options:
1. the existing long-running worker host (current model — recommended);
2. **Vercel Sandbox** (Firecracker microVM, can install Chrome + run `renderVisualsLayer`,
   hand back the clips/MP4 via Blob) — good fit for burst renders without a dedicated host;
3. **Remotion Lambda** (AWS) — fastest for long videos (parallel chunks), but adds AWS and the
   alpha clips must be fetched back for compositing.
The browser Player has none of these constraints (runs client-side).
Vercel function size (250 MB trace cap): apps/web only reaches @chris/motion through the
worker's non-literal `import()`, which Next's file tracing does not follow, so Remotion's
compositor/rspack binaries and three.js should not land in function traces. If a future
static import changes that, add `../../node_modules/.pnpm/@remotion+compositor-*/**`,
`../../node_modules/.pnpm/@rspack+binding-*/**` and `../../packages/motion/assets/**` to
`outputFileTracingExcludes` in apps/web/next.config.ts.

**Tests.** `packages/motion/src/__tests__/timing.test.ts` (props/defaults/timing/placement),
`render.integration.test.ts` (real Remotion + ffmpeg; `MOTION_SKIP_REAL_RENDER=1` skips it on
hosts without Chrome/network), `packages/media/src/__tests__/timeline-motion-mix.test.ts`
(graph unit tests + real compositing/SFX/ducking measurements),
`apps/worker/src/__tests__/render-job-motion.test.ts` (wiring + graceful degradation).

## 2026-10-16 — Templates draw inside the placement engine's footprints (footprints adjusted)

**Decision:** `TEMPLATE_DESIGN_SIZE` (packages/motion) is read from `TEMPLATE_FOOTPRINTS`
(packages/media/src/visual-footprints.ts) — the box the placement engine keeps clear of
Chris/captions/UI is exactly the box each template lays out in, centred on placement x/y,
× `placement.scale` × canvas width/1080 (same rule as `footprintPx`). Footprints were adjusted
to the final designs: KINETIC_TEXT 900×380 (was 320), STAT_CARD 720×400 (700×380),
LINE_CHART 900×680 (640), COMPARISON 900×560 (940×520), LIST_STEPS 860×640 (620), ICON_3D
560×600 (520×520), MONEY_STACK_3D 720×680 (600×600), TIMELINE 760×800 (940×420 — the
template is a vertical milestone list: a horizontal 5-event row cannot fit 16-char labels +
40-char subs at ≥ 34 px on a phone), DEFINITION 880×440 (420). NUMBER_COUNTER (760×300),
PERCENT_RING (520×560), BAR_CHART, CALLOUT, TITLE_CARD unchanged (designs fitted to them). The
placement-engine tests pass with these numbers. Designs hold up at scale 0.7–1.0 (min text
34 px at scale 1 ⇒ ≥ 24 px at 0.7 — still legible at phone size, but 0.7 is the floor).

The worker re-solves AUTO placements (`withResolvedPlacements` → `resolveVisualPlacements`
with the takes' `subjectTrack`, source dimensions, word timings and the renderer's glyph
measurement) right before rendering visuals, so the render matches the editor; MANUAL
placements are never moved.

---

### Quality loop (2026-10-16)

`packages/motion/scripts/showcase.ts` renders all 14 templates (2.6 s each, ~40 s) over a
dark and a light "talking head" stand-in through the real pipeline (alpha clips → compositor
with SFX + music), plus `--gallery3d` (every ICON_3D model + the extruded 3D bar chart), and
extracts entrance / mid / exit frames into contact sheets. Iterations made after looking at
the frames: bare type (KINETIC_TEXT, NUMBER_COUNTER) gets a soft invisible scrim so white/gold
type holds on bright footage; TIMELINE moved onto a glass panel (white text on a light wall was
weak); bill stacks re-textured (ACES + key light washed them to white) and made taller with a
lower camera; integer bar values count in integers (no "$649.9" mid-count); pig/floor
materials. Evidence: `docs/evidence/2026-10-16-motion/` (contact-sheet-{dark,light,3d}.jpg,
frame-*.jpg, sfx-spectrograms.jpg).

Known gaps: TITLE_CARD dims the background but does not blur it (a blur would have to happen
in the ffmpeg graph, not in the alpha layer) — follow-up: a `gblur` on the base during the
title window. Glass cards are "frosted" by gradient, not a true backdrop blur (the layer is
rendered without the footage behind it). The stand-in background is synthetic; a pass over a
real take is recommended once one is available.

---

### Render timings

Measured on an Apple M1 Pro (10 cores), Remotion default concurrency, 1080×1920 @ 30 fps:
- Showcase: 14 visuals, 1,091 frames of motion over a 40 s timeline → **60 s** for the alpha
  layer (≈ 18 frames/s, incl. 3D), bundle 1.5–2.6 s with the webpack cache warm (cold first bundle not separately measured; the whole first integration-test run incl. cold bundle + browser start took 27 s); the
  compositing render (H.264 veryfast + SFX + music) **15 s** for 40 s.
- 3D gallery: 11 three.js visuals, 660 frames → 35 s (≈ 19 frames/s).
- Integration test: 3 visuals (one 3D), 111 frames + composite of a 6 s video → ~25 s total
  including bundling and browser start.
Typical 45 s video with ~5 visuals of ~4 s (≈ 600 motion frames): ≈ 35 s for the layer +
the existing master render. PER_VISUAL avoids rendering the ~55 % of frames with nothing on
screen; FULL_LAYER would render all 1,350.

---

# 2026-10-16 — Visuals + sound in the finishing editor

## 2026-10-16 — Visuals and Sound are first-class editor tools, on one document and one undo history

**Decision:** the finishing editor edits `EditTimeline.visuals`, `.sfx`, `.audio.music` and
`.audio.sfxEnabled` through pure document operations (`apps/web/lib/editor/visuals.ts`) applied
by the existing reducer, so every change — insert, props edit, drag, trim, Auto-place, music
level — is one undo step (continuous gestures coalesce, like texts). Two new tools in both
shells:
- **Visuals** (magic-wand icon; mobile toolbar, desktop timeline toolbar + inspector tab): a
  "Design visuals with AI" card, a gallery of the 14 templates (tap = insert at the playhead),
  and the list of graphics on the timeline. Selecting a graphic turns the same panel into its
  editor: a typed props form, look (palette, enter/exit), entrance sound (with audition),
  position (Auto / placed by you, size, Auto-place) and timing. Selection toolbar on phones:
  Edit · Auto-place · Duplicate · Delete.
- **Sound** (note icon): sound effects on/off, the free SFX kit (preview + add at playhead), the
  effects on the timeline, and the music bed (upload, pick, level, duck, fades, track start).
- Two new tracks on both timelines: **Visuals** (teal — never confused with text/zoom; label =
  template + short summary, e.g. "Counter · $24,500", amber ⚠ when the placement engine warns)
  and **Sound** (music bar + SFX pins).

**Props editor = one generator, one hand-written spec.** `TEMPLATE_FIELDS` describes every
template's fields (text with max length, number, enum, toggle, list of strings, list of rows
with add/remove inside the contract's min/max, nested objects, a point, an index into a sibling
list). A unit test asserts the spec mirrors `MotionPropsSchemas` key for key, and that every
template's default props validate. Kinetic-text emphasis is picked by tapping the words of the
text itself. A graphic whose props don't validate (e.g. an emptied label) shows "won't render
until…" in its editor and in the warnings list, and **Save refuses it by name** — the renderer
would otherwise skip it silently.

**Inserting** prefills from what's being said under the playhead (`phraseAt` over the output
caption words): kinetic text/title/callout get the sentence; counter/stat/ring/money stack get
the first number in it; everything else starts from the template's designed sample. The
anchor phrase is kept as `anchorText`.

**Overlap rule — prevented, not just warned.** Graphics live on ONE track and never overlap in
time: an insert lands in the free gap at (or after/before) the playhead and refuses with a toast
when there's no ≥1.2 s gap (entrance 0.7 s + exit 0.45 s); move/trim stop at the neighbours
(CapCut same-lane behaviour); duplicate goes into the next free gap. Rationale: the placement
engine treats other on-screen graphics as hard obstacles and the Motion Designer keeps ≥0.4 s
between them, so overlapping graphics would only ever produce LOW_CONFIDENCE placements. A ripple
edit that shortens the video can still squeeze two together (`normalizeDoc` clamps spans into
the duration but doesn't move them) — that's reported as an "overlap in time — trim one"
warning rather than silently moving Chris's graphics.

**Alternatives considered:** allow overlaps + warn (rejected: two graphics fighting for the
same frame is never what he wants on a 9:16 talking head); multiple visual lanes (no renderer
need, more UI); introspecting zod for the form (zod 4 internals; brittle; labels/ordering
still need a spec).

**Reversibility:** high — pure functions + UI.

## 2026-10-16 — Placement is solved live in the editor with the render's own engine

**Decision:** `Editor.tsx` runs `solveVisualPlacements(doc, { subjectTracks, sourceDimensions,
wordsByAsset, measure })` on every doc change (memoised; a few ms per graphic) — the same
function and inputs the worker uses before rendering (`withResolvedPlacements`). The preview
draws AUTO graphics where the engine puts them; the saved doc gets the solved x/y/scale
(`withResolvedPlacements` on save). Dragging a graphic on the preview (or its corner handle, or
a two-finger pinch, or the Size slider) sets `placement.mode = "MANUAL"` from where it is drawn
(no jump); **Auto-place** flips it back to AUTO and re-solves (`autoPlaceVisuals`). While
dragging, Chris's protected head region is outlined ("Face"). Placement warnings are reworded
with the editor's names and times ("Bar chart 5.4–8.3s no fully clear spot — best option still
overlaps Chris's face…") and appear in the existing warnings chip/sheet and the graphic's
editor; WARNING-severity ones also badge the clip on the timeline. Subject tracks come from the
server loader (`MediaAsset.subjectTrack` per take via `parseSubjectTrackRecord`).

**Reversibility:** high.

## 2026-10-16 — Preview layer: `<VisualsPreview>` loaded client-only, composited in render order

**Decision:** `MotionLayer.tsx` renders `@chris/motion/player`'s `<VisualsPreview>` through
`next/dynamic(..., { ssr: false })`, and only when the edit has graphics — Remotion/three.js
never weigh on the editor's first load. It sits over the graded picture + vignette and under
the platform-UI mock, texts and captions — the renderer's compositing order. It's fed the
placement-solved visuals and a frame-quantised playhead (the Player seeks exactly while paused
and only re-syncs on >2-frame drift while playing). Hit areas for the graphics are plain divs
(`data-gesture="visual"`) handled by the canvas's single gesture controller; they sit under the
text/caption SVG so texts keep tap priority, and a full-frame title card only grabs its middle
so taps elsewhere still play/pause. `apps/web` depends on `@chris/motion` and lists it in
`transpilePackages` (Turbopack transpiles workspace packages anyway; this keeps webpack builds
correct).

Verified (Chromium + WebKit, iPhone 15 393×852 touch; Chromium desktop 1440×900): counter,
3D bar chart and 3D icon render in the preview at their mid-times, including WebGL in WebKit.

## 2026-10-16 — "Design visuals with AI" = save first, then the HUMAN Motion Designer job

**Decision:** the button saves unsaved edits (the job designs on the latest saved version),
then calls `designVisualsAction` → `designMotionForContentItem(..., { trigger: "HUMAN",
replaceExisting, skipTracking: !isAutoSubjectTrackingEnabled() })`, reads the new EditPlan's
`plan.timeline` back and loads it as the saved version — as an undoable `replace`, so Chris can
undo the AI's pass in one tap. The result shows counts, each added graphic with the phrase it
illustrates (tap to select), rejections in plain English (`plainRejection`: "Dropped a bar
chart: 30,000 isn't in your fact-checked research or script."), placement warnings and the
model's rationale. Errors are worded for Chris (no key / out of credit / spending cap / service
busy) and say the edit is unchanged — verified with an invalid key in the throwaway env.

## 2026-10-16 — The FACTUAL gate checks numbers drawn by motion graphics (deterministic)

**Problem:** the Motion Designer validates numbers when it proposes graphics, but Chris can type
any number into a graphic in the editor. The Quality Gate's FACTUAL check only looked at the
Claims Gate verdicts — on-screen numbers in `timeline.visuals` were never checked, so the
editor's "the quality gate checks on-screen numbers" note would have been false.

**Decision:** `runQualityGateForContentItem` now runs `findUngroundedVisualNumbers` (pure,
exported from `apps/worker/src/quality-gate-job.ts`) over the rendered timeline's visuals:
every number a graphic shows (`numbersShownBy` — numeric props and digits/spelled-out numbers in
its strings; structural fields excluded) must match the research packet (numeric inputs, FACT
statements, calculation notes, primary claim) or the latest Claims-Gate-passed script, with the
Motion Designer's own tolerance (`numberIsGrounded`: formatting variants, honest roundings
within 5%, percent↔fraction). Reuses the helpers `@chris/agents` already exports — one
definition of "grounded". Any miss → FACTUAL BLOCK with a reason naming each graphic and number
("the number counter at 2.2s shows 30,000"), appended to any Claims Gate reason. Applies even
to fact-check-exempt items (an on-screen number with no source is still a claim). Tests: pure
cases (`quality-gate-visual-numbers.test.ts`) + an integration case through the real gate
(ungrounded → BLOCK naming 30,000; researched 24,500 → PASS).

**Reversibility:** high — one block in the job.

## 2026-10-16 — Preview sound: music bed + SFX on the engine's clock, iOS-safe

**Decision:** `preview-audio.ts` (`PreviewAudio`) hooks the playback engine: a new
`engine.onPlayGesture` hook runs inside the play tap (the only moment iOS allows sound), where it
creates/resumes the AudioContext, starts the music `<audio>` at `trackStart + t` and warms the
SFX buffers. Music gain follows `lib/editor/music-mix.ts` (pure, tested): `levelDb` as linear
gain, minus `duckDb` while words are spoken (speech regions merged at 0.45 s, 0.15 s lead-in,
0.4 s release — the renderer's ramps), fades in/out; it re-syncs on >0.3 s drift. Same-origin
music (local storage) is routed through a WebAudio GainNode because iOS ignores
`HTMLMediaElement.volume`; in blob mode the file is a cross-origin presigned URL, so the
element's own volume is used (desktop honours it; on iPhone the bed plays at full level — the
sheet says so). SFX (entrance sounds + free effects, house gain 0.5 like the mixer) are decoded
once from `/api/sfx/<sound>.wav` and fired when the playhead crosses them (not on seeks). It's
an approximation for judging fit; the render's loudness-referenced mix is the truth.

## 2026-10-16 — `/api/sfx/[file]`: auth-protected, SFX_SOUNDS-whitelisted

Mirrors `/api/fonts`: only `<sound>.wav` for a contract `SFX_SOUNDS` id is served, from
`packages/motion/assets/sfx` located by a cwd walk (`lib/motion-assets.ts`, no import of
@chris/motion's Node entry). `next.config.ts` traces `packages/motion/assets/sfx/*.wav` into
functions; Remotion's compositor and rspack binaries are excluded from traces.

## 2026-10-16 — MUSIC uploads end to end; music is never a take

**Decision:** uploads take a `kind` (`RAW_TAKE` default | `MUSIC`): `PUT /api/upload?kind=MUSIC`
(local), `music/<contentItemId>/...` pathnames in `/api/blob-upload` (audio-only token) +
`registerBlobUpload({ kind })` (blob). MUSIC requires an audio mime (415 / error otherwise, and
`createMediaAsset` refuses too), keys live under `music/<item>/`, the asset is ffprobed for its
duration, and it **never** transcribes, tracks, or moves the item (`analyzeMediaAsset` only
treats a RAW_TAKE as ingestion). Takes-only consumers fixed: `listMediaAssetsForContentItem`
now defaults to RAW_TAKE (option `{ kind: "MUSIC" | "ALL" }`) — that's what take selection and
the pipeline use; `transcribeContentItemTakes`/`transcribeMediaAsset` skip non-takes; the
content page lists takes and music separately; the editor's media bin already loaded RAW_TAKE
only. The Sound sheet uploads with the same transports as the take uploader and shows "use
music you have the rights to". Verified: an audio upload creates a MUSIC asset that appears in
the Sound sheet; a video sent as music gets 415.

## 2026-10-16 — Subject tracking runs after upload (local only)

`registerUploadedRawTake` schedules `trackSubjectForMediaAsset` in the same `after()` as
transcription (after it), gated by `isAutoSubjectTrackingEnabled()` — on locally, off on Vercel
(`SUBJECT_TRACKING=on|off` overrides), mirroring transcription; only for takes with video.
The editor's AI design also skips tracking where it's off (placement then assumes centred
framing and says so).

## 2026-10-16 — Renders started from the app include the motion layer (child process)

**Problem found in verification:** "Finish" rendered successfully but **without graphics**:
inside the Next.js server, the worker's lazy `import("@chris/motion")` reaches Node's native ESM
loader, which can load the package's `.ts` entry but not its extensionless relative imports
(`Cannot find module …/packages/motion/src/timing`). `prepareMotion` degraded gracefully (warning
on the Render row), so the bug was silent in the UI. (Loading it through tsx's in-process
`tsImport` was tried and crashed the dev server — tsx's namespaced loader and Next's require hook
collide inside Remotion's CJS interop — so it's not used.)

**Decision:** the worker's `defaultLoadMotion` first uses a host-registered loader
(`globalThis.__chrisMotionLoader`, a 5-line change in `apps/worker/src/render-job.ts`). The web
app registers one in `instrumentation.ts` (Node runtime, not on Vercel):
`lib/motion-subprocess.ts` returns a `MotionModule` whose `sfxFiles()` are plain paths and whose
`renderVisualsLayer()` runs `apps/web/scripts/render-motion-layer.mts` under the repo's tsx in a
child process (JSON in/out). Remotion and @chris/motion's TypeScript never load inside the Next
server or its bundle. Covers every render path in the app (Finish, Render, pipeline,
auto-repair). Verified: the editor's Finish render now reports 3 overlays / 4 SFX / 261 motion
frames and the extracted MP4 frames show the counter, 3D bar chart and 3D icon exactly where
the preview drew them (`docs/evidence/2026-10-16-motion/editor-render-frames.jpg`).

**Vercel:** unchanged — no tsx/Chrome in a function; renders there degrade to "no visuals" with
a warning, as documented in the motion-engine INTEGRATION NOTES (use the worker host / Sandbox).

**Reversibility:** high — remove the registration to restore the old behaviour.

### Verification notes (2026-10-16)

Throwaway PGlite (migrated + seeded), a synthetic portrait talking-head take with a real `say`
voice + Whisper word timings, a constant subject track for the drawn head, research with
$24,500 / $4,080, a tone-generated music bed (MUSIC asset), a finishing edit with NUMBER_COUNTER,
BAR_CHART (depth3d) and ICON_3D + a CASH effect + music, rendered; `next dev` with an invalid
Anthropic key. Playwright: Chromium + WebKit at iPhone 15 (393×852, touch), Chromium desktop
1440×900. Evidence: `docs/evidence/2026-10-16-motion/editor-*.jpg`.

Known gaps: (1) the 3D bar chart's title and highlight value overlap when the chart is shrunk to
0.7 (template layout, `@chris/motion`); (2) with Chris filling the middle third, the bar chart had
no fully clear spot — the engine says so (LOW_CONFIDENCE) rather than hiding it; (3) the
Design-with-AI happy path is untested end to end here (no Anthropic credit) — its error path,
save-first and reload-as-saved-version logic are exercised; (4) real-iPhone audio checks
(WebAudio unlock, ducking audibility) still need a device pass; (5) Next's dev-tools badge
covers the first toolbar tool in dev only.

## 2026-10-16 — Footage-first upload ("where do I upload?")

**Problem (reported by Chris):** the only uploader lived inside each video's page, at the
bottom of a long page — and only once a video entry existed. On a fresh production database
there was literally nowhere to upload.

**Decision:** an **Upload** tab (center of the phone tab bar, gold "+"; also in the desktop
nav) opens `/upload`: optional title + "Choose videos" (Photos/Files/camera, several takes).
`createContentItemFromFootage` creates the item and walks it to FILMED with SYSTEM
transitions whose reason says "Footage-first", then the normal uploader ingests the takes
(FILMED → MEDIA_INGESTED, transcription in the background) and the page opens the new video.
The auto-contract is deliberately NOT fact-check-exempt (STANDARD research / MEDIUM risk), so
the FACTUAL hard gate still blocks publishing until the footage's claims are checked —
footage-first shortcuts to editing, never to publishing unchecked claims. On a video's page,
the upload panel now moves to the top whenever the video is waiting for footage
(READY_TO_FILM / FILMED / MEDIA_INGESTED). Upload logic was extracted to
`apps/web/lib/upload-client.ts` so both entry points share it. Verified in a real browser at
iPhone size: login → Upload → pick file → item created, take uploaded and analyzed → opened.

## 2026-10-17 — Calendar "Remove from calendar" (SCHEDULED → READY rollback)

The new calendar had no way to take a video off the calendar: the state machine had no exit
from SCHEDULED except publishing, a finishing edit, or cancelling. A calendar without
"remove" isn't a real calendar (Chris asked for Google/Apple-calendar behavior), and the move
is safe: the video already passed all four hard gates and keeps its render — it only loses its
ScheduleEntry. Added `SCHEDULED -> READY` as a rollback (`unscheduleContentItem`, one
transaction: delete ScheduleEntry + transition + audit `UNSCHEDULED`); "Remove from calendar"
in the calendar's event sheet. The scheduled-publish job only picks SCHEDULED items, so a
removed video can never auto-post. Reversible: drop the transition and button.

---

# 2026-10-17 — Calendar, posting plan, stay on course

## 2026-10-17 — Calendar becomes Month / Week / Day / List (Apple/Google-style)

**Request:** "Make the calendar look and be modular like an actual calendar — month, week, or
day view. Combine how it is now with this."

**Decision:** `/calendar` renders one of four views, picked with a segmented control and
addressable by URL (`?view=month|week|day|agenda&date=YYYY-MM-DD`; the old `?week=` links still
open the week view). The last-picked view is remembered in a `cal_view` cookie (read on the
server, so there's no flash of the wrong view). Default with no cookie: Month.

- **Month** — desktop: a grid of whole Monday–Sunday weeks (leading/trailing days dimmed),
  up to 3 chips per day (platform dots + time + title, colored by status) and "+N more" →
  that day. iPhone: Apple-Calendar-style compact grid with up to 3 status dots per day (a
  hollow gold dot = an open plan slot) and the selected day's list below it.
- **Week** — 7-column time grid with hour rows, a red now-line, events as fixed one-hour
  blocks (posts are instants; a fixed visual length reads well and stacks cleanly),
  overlapping events side by side (`layoutOverlaps`), and an all-day "due" lane that shows
  pipeline deadlines ("Film 2", "Finish editing 1") on the day they fall due.
  **On iPhone (393px) it's a 3-day swipe view**: the same grid, three columns visible with a
  sticky time gutter, scroll-snapped horizontally across the week (opens on today's column).
  Chosen over the old day-agenda strip because the List view already covers "agenda", and a
  real time grid is what makes overlaps and the now-line legible.
- **Day** — a week strip on top (tap any day) and a single-column hour timeline with large
  events (title, time, status, platforms).
- **List** — 28 days of agenda from the anchor date, day headers sticky, empty days skipped.

Everything relevant is on the calendar: SCHEDULED items at their ScheduleEntry time;
PUBLISHED/MEASURING items at their first live publication time (Publication.publishedAt,
SUCCESS or DRAFT); failed (latest attempt FAILED) and missed (SCHEDULED, 30 min past due)
posts in rose; dated-but-not-READY items as "Not ready" (gold); and open posting-plan slots as
dashed placeholders. Status colors and platform dots live in one place
(`app/calendar/calendar-ui.tsx`) and a legend sits under every view.

Kept: Auto-Fill Week (now told the plan's open slots — see below), manual placement (the "+
Add" sheet, plus click an empty spot in Week/Day/Month on desktop), platform toggles, the
unscheduled READY pool.

**Time zone:** all calendar math uses APP_TIMEZONE explicitly through the new pure
`packages/domain/src/tz.ts` (Intl-based, DST-correct, no reliance on the process TZ that
instrumentation.ts sets). Days are carried as "YYYY-MM-DD" strings. The reschedule actions
convert wall time → instant on the server with the explicit zone; `placeOnCalendar` now parses
the datetime-local value the same way instead of `new Date(str)`.

**Reversibility:** UI only; no data changes. The old page is in git history.

## 2026-10-17 — Event sheet; no "Unschedule" button (state machine has no SCHEDULED → READY)

Tapping an event opens a bottom sheet (centered dialog on desktop; portaled to `<body>` so it
sits above the tab bar): latest successful render as a thumbnail (`<video #t=0.5>`, served by
the existing `/api/media` route; "No render yet" otherwise), status, time, platforms, post
links, failure note, and actions: Open, Edit video (only in FINISHING_EDIT_STATES), and
Reschedule (date + time + platforms) for READY/SCHEDULED items.

**Unschedule is deliberately not offered.** /docs/STATE_MACHINE.md has no `SCHEDULED → READY`
transition; the only legal ways off the calendar are `SCHEDULED → EDIT_PLANNED` (save an edit)
and `→ CANCELLED`. The sheet says so in one line. **Open question for Chris:** add
`SCHEDULED → READY` ("Unschedule") as a rollback? It's cheap (no re-render needed, gates still
valid) and would make "take this off Thursday" one tap. Not done here because changing the
transition table is a state-machine decision, not a UI one.

## 2026-10-17 — Drag to reschedule (desktop drag, iPhone long-press)

Pointer-event drag (`app/calendar/useEventDrag.ts`): mouse/pen drags after a 4px move; touch
picks the event up after a 350ms still long-press (a normal swipe still scrolls), then a
non-passive `touchmove` listener (registered at touch start, before iOS commits to scrolling)
stops the page scrolling while you move it. Time-grid drops snap to 15 minutes; month drops
keep the original time. Moves are optimistic and every one goes through the same domain path
as any other placement — `scheduleContentItemForPublishing` (audit `SCHEDULE_RESCHEDULED`, or
the READY → SCHEDULED transition) via the `moveEvent` server action. Only READY/SCHEDULED
events are draggable. Verified in Chrome with a mouse drag (Tue 6pm → Thu 3pm) and a CDP touch
long-press drag on the iPhone viewport (Mon 12pm → 3pm).

## 2026-10-17 — PostingPlan: versioned, append-only, one active row

**Decision:** new `PostingPlan` model (migration `20261017120000_posting_plan`): `version`
(unique), `active`, `startDate` (YYYY-MM-DD; no slots before it, so a new plan doesn't flag
last month as missed), `timezone`, `readyLeadDays` (default 1), `filmLeadDays` (default 3),
`sameForAll` (UI convenience), and `cadences` JSON — per platform `{platform, enabled,
postsPerWeek, preferredDays (0–6), preferredTimes ("HH:mm")}` validated by
`PostingPlanDataSchema` on every read and write. `savePostingPlan` writes version N+1, flips
the previous active row off and audits `POSTING_PLAN_SAVED`, in one transaction; old rows are
never edited. Single-active is enforced in that transaction rather than by a partial unique
index (Prisma's schema can't express one, and a hand-written index would drift from
`migrate diff`).

Editor at `/calendar/plan` (linked from the calendar's Stay-on-course panel and /todo):
per-platform on/off switch, posts/week stepper, Mon–Sun day chips, time chips with add/remove,
"Same schedule for all platforms" toggle, lead-time steppers, start date, and a live preview
of the resulting week that runs the same `generatePlanSlots` in the browser (via the new
Prisma-free `@chris/domain/planning` export). If posts/week exceeds days × times the editor
says "Only N fit" — the generator caps rather than silently stacking.

Slot generation (`generatePlanSlots`, pure): per Monday-start week, per enabled cadence,
`postsPerWeek` picks spread evenly over the preferred days (Monday-first), doubling up on a
day across its times when posts > days. `matchSlotsToSchedule` (pure): a post fills a slot when
it targets that platform, is on the same local day and within ±3h; each (post, platform) fills
at most one slot, nearest wins. Open slots at the same local time are grouped — one video
posted to several platforms is one "video" of work.

Auto-Fill Week now appends each platform's cadence and its next open plan slots to the
Scheduler Agent's existing per-platform quota notes, so it aims at the plan instead of
inventing a cadence (no change to the agent or its prompt).

**Reversibility:** drop the two tables; nothing else references them.

## 2026-10-17 — Stay on course + unified to-do list (deterministic)

**Decision:** pure `computeCourse` (`packages/domain/src/course.ts`) — arithmetic, not a model
call (CLAUDE.md: deterministic checks stay deterministic):

- **Coverage** for this week and next, per platform: planned / filled (scheduled or live) /
  live / missed / open; **streak** = consecutive complete weeks where every slot got a live
  post.
- **Open slots** (future, soonest first), each paired with the oldest unscheduled READY video
  → a one-tap "Schedule ‹title› into Thu 6pm TikTok + Reels" action.
- **Pipeline worked backwards** over open slots through the end of next week: the earliest
  slots get the most-finished videos (ready → editing → filmed → to film → being written →
  nothing); each group gets a deadline from the lead times (ready-by = slot − readyLeadDays,
  film-by = slot − filmLeadDays, scripts a day before that, ideas two days before) and is "at
  risk" once the deadline has passed. Summary line: "To fill 3 open slots through Sun, Oct 25
  you need 3 videos ready, the first by Tue, Oct 20. You have 2 ready, 2 in editing… → finish
  editing 1 by Thu, Oct 22" (the most urgent step).
- **Stuck:** MISSED (SCHEDULED > 30 min past due — and it no longer counts as filling its
  slot), PUBLISH_FAILED (latest attempt per platform), PUBLISHING > 60 min, QC_BLOCKED,
  RESEARCH_BLOCKED, FILMED > 2 days, editing states > 2 days, and dated-but-not-ready within
  48h. Thresholds are in `COURSE_THRESHOLDS`.
- Status: AT_RISK (any critical stuck item or a passed deadline) / BEHIND (missed slots this
  week, or slots with nothing in the pipeline) / ON_TRACK / NO_PLAN.

`buildTodoList` (`todo.ts`, pure) merges those nudges with: NEEDS YOU strategy decisions,
proposed beliefs and critiques (QC/claims/platform failures are already course items, so not
duplicated); platform connections the plan posts to (not connected / expired → critical if
posts are due there within a week; expiring within 7 days without a refresh token);
auto-publish on but no `scheduled-publish` JobRun in 24h (GitHub cron); auto-publish off with
posts due; Anthropic credit exhausted (latest failed ModelCallLog in 3 days whose error looks
like billing/credit, with no success since) else "AI agents are off" when the key is unset;
`brand/VOICE_SAMPLES.md` empty; no posting plan. Each nudge has a stable key, one action, and a
bucket (Today / This week / Setup); sorted blocking-first.

**Dismiss "Not today":** a tiny `NudgeDismissal (key, day)` table rather than a cookie, so a
dismissal on the iPhone also hides it on the desktop. It's keyed by local day, so the nudge
returns tomorrow if it's still true. Not an audit record; rows can be pruned.

**Surfaces:** a collapsible "Stay on course" bar at the top of `/calendar` (two lines when
collapsed — status pill + the single next step — so the calendar itself stays first on an
iPhone; expands to coverage bars + top 4 nudges), a compact On track / Behind card at the top
of Home (headline + top 3 + "See all"), and `/todo` (new; "To-do" added to the More sheet and
the desktop nav) with the full list grouped Today / This week / Setup.

**Alternatives considered:** an LLM "coach" summary — rejected for now; every number here is
countable, and a model would add cost and the risk of an invented deadline.

**Reversibility:** additive; remove the panel/card/page and the two tables.

### Known gaps

- Thumbnails come from the latest successful Render (master). RenderVariant cover frames
  aren't served by `/api/media` yet, so they aren't used.
- No "Unschedule" (see above) — needs Chris's call on the state machine.
- Touch drag is implemented in Week/Day; on iPhone Month you reschedule through the sheet.
- The plan's slots don't yet feed the worker or publish jobs — they're guidance and nudges,
  not an auto-publisher of their own.

---

# 2026-10-17 — Motion themes + evolving motion taste

## 2026-10-17 — One pure `resolveMotionStyle(visual, theme)` decides every visual's look

**Decision:** `packages/motion/src/style.ts` (exported from `@chris/motion/pure` and the Node
entry). Input: the visual's palette (`BRAND`/`MONO`/`VIVID`) and the timeline's
`motionTheme` (contract: `MotionThemeSchema`). Output: `{ palette, feel, iconStyle, themeName }`.
- Theme `primary`/`secondary` override BRAND and VIVID accents. **MONO is never recolored** —
  it is a deliberate restraint choice; it still gets the motion feel and icon style.
- Contrast guard at render time: primary is lightened (hue kept) to WCAG 4.5:1 and secondary
  to 3:1 against the glass surface `#12121A`, so a color Chris picks in the editor can never
  make values unreadable.
- `motionTheme: null` ⇒ exactly the previous house style (BRAND + CRISP + GOLD_METAL, the
  original AUTO transition table). Every v1 timeline renders as before (unit-tested).
- `resolveThemedTransition(template, which, value, language)`: explicit enter/exit always win;
  `AUTO` follows the language (CALM never springs in, CINEMATIC defocuses in, PLAYFUL springs).

**Alternatives:** theme logic inside each template (14 copies, drift between preview and
render); a `palette` enum per language (can't express Chris's own colors).
**Reversibility:** high — removing the theme makes everything CRISP/BRAND again.

## 2026-10-17 — Motion languages are physical parameter sets, not new animations

**Decision:** `MOTION_FEELS[CALM|CRISP|PUNCHY|CINEMATIC|PLAYFUL]` = spring configs (settle,
soft, punch, grow, object), out-ease bezier, tempo (stagger multiplier), travel distance,
blur, hit scale, rotation accent, entrance/exit stretch, cinematic push, letterbox depth,
title tracking, glow, 3D spin. All 14 templates multiply their designed values by these; the
container entrance/exit (`enterExitStyle`) takes the feel as an optional last argument.
CRISP is numerically identical to the old constants. **Key "hit" moments (counter landing,
bar peak, word punch) are not re-timed** — only the feel around them — so the interaction
engineer's emphasis-timing hooks compose with this.

Measured springs (30 fps; frames to 90 % / settle / peak):

| language | settle | soft | punch | grow |
|---|---|---|---|---|
| CALM | 16/30/1.00 | 14/27/1.00 | 10/20/1.00 | 16/31/1.00 |
| CRISP | 11/21/1.00 | 8/18/1.02 | 4/15/1.09 | 13/24/1.00 |
| PUNCHY | 5/12/1.07 | 4/20/1.22 | 3/17/1.31 | 5/19/1.10 |
| CINEMATIC | 19/36/1.00 | 17/32/1.00 | 13/24/1.00 | 20/37/1.00 |
| PLAYFUL | 5/21/1.16 | 4/31/1.30 | 3/22/1.33 | 6/30/1.18 |

Quality-loop fixes made after looking at frames (docs/evidence/2026-10-17-motion-themes/):
overshooting word punches no longer squash below 95 % scale; bar/stack overshoot capped at
8 % so the tallest value label never meets the card title; tracked titles (CINEMATIC) only
track when the title is one line and the widest state still fits (no mid-animation re-wrap —
this also fixes a latent re-wrap in the house style's 0.1 em settle on long titles); exits in
defocus-heavy languages are capped (×1.15 blur, ×1.2 length) so graphics don't smear out.

## 2026-10-17 — Icon styles: GOLD_METAL / SOFT_CLAY / GLASS / LINE

**Decision:** `useMaterials(palette, iconStyle)` returns the same material *slots* for every
family, so all 10 ICON_3D models, MONEY_STACK_3D and the depth3d bar chart render in every
family without per-model code. SOFT_CLAY = matte pastel (roughness ~0.8, sheen, softer key,
saturated enough to survive ACES — the first pass washed to white). GLASS = tinted acrylic
with a **fresnel rim shader patch** (onBeforeCompile) — plain transparency read as dull gray
on the dark layer; true transmission is impossible because the alpha layer has no footage
behind it to refract. LINE = 2D line icons (`templates/line-icons.tsx`, original 64-grid
geometry, stroke-by-stroke draw-on on a glass disc), an isometric line-drawn money stack, and
outlined bars for depth3d charts. Footprints are unchanged, so placement is unaffected.

**Known gaps:** glass money stacks are the weakest combination (bills as glass is odd) —
acceptable, the designer rarely pairs them; glass cannot refract the footage (would need
compositing in the ffmpeg graph).

## 2026-10-17 — Topic → theme: the model chooses, a deterministic preset backs it up

**Decision:** Motion Designer output gains a strict, required-nullable `theme`
(`MotionDesignerThemeSchema`). Code then:
1. keeps the timeline's existing theme unless `replaceExisting` (Chris's override is an
   explicit decision — authority order — and is never silently redone) → `themeSource: KEPT`;
2. else uses the model's theme after `sanitizeMotionTheme` (schema, contrast lightening,
   gray/near-white "accents" dropped, primary==secondary separated) → `MODEL`;
3. else the topic preset → `FALLBACK`.
Topic = `classifyMotionTopic` (packages/domain, deterministic keyword scoring over title ×3,
description ×2, script ×1 capped, plus pillar priors; "credit card debt" resolves to DEBT).
Presets (`MOTION_THEME_PRESETS`, all contrast-tested): DEBT "Debt pressure" PUNCHY amber/red;
CREDIT CRISP amber/red; INVESTING "Compounding growth" CINEMATIC gold/emerald GLASS; SAVING
CALM gold/green; CAREER CRISP gold/blue; LIFESTYLE "Golden hour" PLAYFUL sunset SOFT_CLAY;
MINDSET CALM gold/violet LINE; GENERAL = house style. The suggestion is shown to the model,
which may deviate when the tone calls for it (e.g. a hopeful debt-freedom story).
The motion design job saves `motionTheme` on the new timeline version and audit-logs theme +
source. The factual hard rule is untouched (tested again with a theme present).
Prompt `MOTION_DESIGNER` 1.0.0 → **1.1.0** (`rollback_version: 1.0.0`, `required_context` +
`MotionTasteProfile`; AGENT_CONTRACTS row updated). `eval_status` stays `unevaluated` (no
credit for a real run).

## 2026-10-17 — Learning motion taste from editor saves (`TasteFeedback.context`)

**Decision:** additive migration `20261017140000_taste_feedback_context` (`context JSONB`,
nullable; existing rows untouched). `recordTasteFeedback` accepts an optional `context`.
`packages/domain/src/motion-taste.ts`:
- `diffMotionEdits(before, after, {topic, beforeWasAiDesign})` (pure). AI visuals are the
  designer's `mv-N` ids. Tags (event-level interpretations): REJECTED_TEMPLATE,
  ACCEPTED_TEMPLATE (only on the first save after an AI design, so untouched visuals aren't
  re-counted every save), ADJUSTED_TEMPLATE (changes: props/placement/timing/depth/palette/
  transitions/sound), SWAPPED_TEMPLATE, ADDED_TEMPLATE, SHORTER/LONGER_ANIMATIONS (≥ 0.3 s and
  ≥ 15 %), MORE/LESS_BEHIND_HEAD, LESS_SOUND, TOO_BUSY (≥ 2 and ≥ 40 % of AI visuals deleted in
  one save), PREFERS_THEME, FORGET. Raw feedback is auto-written ("Deleted AI bar chart at
  5.4s on a debt video"); structured context holds template, topic, time, 3D flag, changes.
- `recordMotionEditSignals(prisma, {contentItemId, before, after, actorId, planId,
  beforeWasAiDesign})` persists rows (artifactType `MOTION_GRAPHIC`), idempotent per saved
  plan version, audit-logged.
- Capture point: `saveFinishingEditAction` (apps/web edit actions) reads the latest plan
  before saving and calls a best-effort `learnMotionTaste` after — wrapped so learning can
  never fail or block a save.

## 2026-10-17 — Motion taste profile: evidence thresholds, decay, scope, forget

**Decision:** `buildMotionTasteProfile(rows, now)` (pure). Preference keys: AVOID/FAVOR
_TEMPLATE:<T>, PREFERS_3D / AVOIDS_3D, FEWER_VISUALS, SHORTER/LONGER_ANIMATIONS,
MORE_BEHIND_HEAD, LESS_SOUND, THEME:<topic>:<language>, ICON_STYLE:<style>. Each signal
supports some keys and opposes their opposites (adding a bar chart contradicts "avoid bar
charts"). Recency half-life 45 days. **STRONG** only with ≥ 3 supporting signals from ≥ 2
videos and ≥ 70 % weighted consistency; **WEAK** (a hint) at ≥ 60 %; below that it is
dropped. Evidence from a single topic stays **scoped** to that topic; theme-language
preferences are always topic-scoped. "Forget this" writes a FORGET counter-signal; evidence
before it is ignored for that key, later edits can re-teach it, nothing is deleted.
`motionTasteForDesign(profile, topic)` → `{context, capDelta, avoidTemplates}`: the text block
goes in the prompt (STRONG = follow unless the moment needs otherwise; WEAK = never a rule);
the only deterministic levers are STRONG + in-scope: "fewer graphics" lowers the cap by one
(never below 1), and STRONG-avoided templates are the first cut *when something must be cut*
— never banned. The /learnings page shows "Your motion style" (strength, evidence, videos,
scope, confidence, Forget this).

**Alternatives:** feeding raw feedback to the LLM Taste Learner only (non-deterministic,
costs a call, and can't enforce "one instance ≠ rule"); hard-banning disliked templates
(violates spec §7). The LLM Taste Learner still sees MOTION_GRAPHIC rows via the existing
"Refresh taste model" path (a richer, slower second opinion).
**Reversibility:** high — the capture hook is one wrapped call; the profile is derived.

## 2026-10-17 — Evals

`fixtures/evals/motion-designer.json` (4 SYNTHETIC cases: debt theme fits, investing
fallback fits, STRONG taste respected under a tight cap, invented number dropped) run through
the real `designVisualsForTimeline` in the mock self-test; the grader is shown to fail a
PLAYFUL theme on a debt video. `@chris/evals` now depends on `@chris/media` (timeline schema).

---

### INTEGRATION NOTES

1. **Composition props (interaction engineer).** `VisualsLayerProps.motionTheme?:
   MotionTheme | null` is the one prop. My plumbing in `VisualsLayer.tsx` is deliberately
   tiny: wrap the tree in `<MotionThemeProvider theme={motionTheme}>` and, in `VisualItem`,
   `const ms = useVisualMotionStyle(pv.template, v)` → pass `palette: ms.palette, feel:
   ms.feel, iconStyle: ms.iconStyle` to the template and `ms.feel` as the last argument of
   `enterExitStyle`; `enter`/`exit` come from `ms` (language-aware AUTO). If your branch also
   added a `motionTheme` prop, keep one — same name and type. Context/hook live in
   `src/remotion/motion-theme-context.tsx`.
2. **Player / editor preview:** pass `motionTheme: timeline.motionTheme` in
   `VisualsPreview`'s `inputProps` (not done here — player.tsx is yours). Render path:
   `renderVisualsLayer` already forwards `input.timeline.motionTheme` (one-line change in
   `packages/motion/src/render.ts`); the worker passes the timeline through unchanged.
3. **Template props are optional:** `feel?` / `iconStyle?` on `TemplateComponentProps`
   default to CRISP / GOLD_METAL, so templates still render if a caller doesn't pass them.
   Timing hooks (`hitAtFrame`-style) can be added beside them; the feel never moves hits.
4. **Editor theme picker:** use `@chris/motion/pure` → `resolveMotionStyle`, `MOTION_FEELS`,
   `contrastRatio`/`ensureContrast` for swatches; the topic presets for a "suggested" chip are
   `MOTION_THEME_PRESETS` / `fallbackMotionTheme({title, description, pillar})` in
   `@chris/agents` (server-side).
5. **Saving a theme override** from the picker flows through `saveFinishingEditAction`, so
   it is automatically captured as a PREFERS_THEME signal.
6. **No-model path:** when a timeline has `motionTheme: null` (e.g. never designed), it
   renders in the house style. A caller that wants the topic look without a model call can
   set `fallbackMotionTheme(...)` on the timeline.
7. **Quality loop:** `pnpm --filter @chris/motion exec tsx scripts/theme-matrix.ts <outDir>
   [--only=icons,languages,themes]` (real Remotion pipeline, RGBA frames).
8. **Merge note:** the mock Motion Designer responses in tests must now include `theme`
   (required-nullable, strict structured output).

---

# 2026-10-17 — Motion v2: graphics interact with the footage

## 2026-10-17 — Person matte: MODNet (Apache-2.0) on onnxruntime-node, H.264 gray MP4

**Decision:** `computePersonMatte(videoPath, outPath, { fps?, size? })`
(`packages/media/src/person-matte.ts`) runs MODNet ("Xenova/modnet" ONNX fp32, 25.9 MB, sha256
`07c308cf…6480739`, Apache-2.0 — model card + upstream ZHKKKe/MODNet both Apache-2.0) directly with
onnxruntime-node: ffmpeg streams RGB frames (inference 512 px tall, width to a multiple of 32) →
MODNet → post-process → ffmpeg encodes. Output: the take's aspect at ≤ 512 px tall (even dims,
`matteDimensionsFor`), the take's fps capped at 30, H.264 yuv420p CRF 14, 1 s GOP, BT.709
tv-range, faststart. Stored at `mattes/<contentItemId>/<mediaAssetId>.mp4`;
`recordPersonMatte` (domain, audit `MEDIA_ASSET_PERSON_MATTED` with before/after key + model,
size, fps, coverage, ms; refuses non-takes and keys outside the item's `mattes/` prefix).

Post-processing (deterministic): `tightenAlpha` = smoothstep(0.06, 0.94) (kills background haze,
firms edges without aliasing hair); `stabilizeAlpha` = motion-adaptive per-pixel EMA (weight 0.45
where |Δα| ≤ 0.08, fading to 0 by |Δα| = 0.3) — no edge shimmer, no ghosting on movement.
Verified: decoded white = 255 / black = 0 in ffmpeg (range tags honoured).

Model cache: `MATTE_MODEL_PATH`, else `MATTE_CACHE_DIR`, else the nearest ancestor
`.cache/matte/Xenova/modnet/onnx/model.onnx` (git worktrees reuse the main checkout's), else
downloaded once to `<repo>/.cache/matte` and sha256-verified (`MATTE_ALLOW_DOWNLOAD=0` forbids).

Jobs: `apps/worker/src/person-matte-job.ts` — `computePersonMatteForMediaAsset`,
`ensurePersonMattes(db, storage, {contentItemId}|{mediaAssetIds}, actor, {compute?, force?})`
(exported as `@chris/worker/person-matte-job`). Upload path: after subject tracking in
`registerUploadedRawTake`'s `after()` (local only; `PERSON_MATTE=on|off`, off on Vercel by
default). Render fallback: `prepareInteraction` computes a missing matte when any visual is
`BEHIND_SUBJECT`; failure → warning, the graphic renders in front.

**Alternatives:** transformers.js `background-removal` pipeline (adds image decode/encode per
frame); MediaPipe selfie segmentation (binary-ish masks, poor hair); RVM (better temporal model
but GPL-3.0 weights — rejected on license); lossless FFV1/PNG mattes (don't play in browsers).

**Perf (M1 Pro, CPU):** 288×512 inference ≈ 105 ms/frame default threads (50 ms at 224×384 with 8
threads); end to end **7.8–8.7 matte fps** (11 s 1080×1920 take → 38 s). It runs in the background
after upload, so 512 px quality was preferred over speed. Matte for a 60 s take ≈ 3.5 min.

**Reversibility:** high — another model only has to write the same gray MP4.

## 2026-10-17 — Depth compositing order and matte alignment

**Decision:** in `renderTimeline`, when an overlay segment has `depth: "BEHIND_SUBJECT"` and a
clip it overlaps has a matte (`input.mattes[mediaAssetId]`):
graded footage → `split` → behind graphics (with their own shadows, which are therefore also
behind Chris) → **person** = footage `alphamerge` matte → front graphics → text plates/texts →
captions. The matte stream is built per clip with the clip's exact chain (`clipFrameChain`:
same `-ss`/`-t`, fps, cover-scale × crop zoom, pan crop, pad/trim to the same frame count —
geometry is defined relative to iw/ih, so the 512-px matte maps pixel-for-pixel onto the
footage), concatenated, run through the same `zoomFilter` (punch-ins), then
`MATTE_EDGE_FILTER` = `gblur σ1.1` + a contrast curve centred just above 50% (pulls the edge a
hair inward: no background halo pasted over a behind-graphic). Clips without a matte get a
black matte (their behind graphics read as front). No matte at all → warning, segment
composited in front. `RenderTimelineResult.motion` gains `behindSubject`, `mattedClips`.

Tests: `timeline-depth.test.ts` (real ffmpeg): a red "person" + a half-resolution synthetic
matte; a green behind-bar is hidden inside the person and visible outside, FRONT covers the
person; no matte → warning + front; with crop zoom 1.3 / pan (0.6, −0.2) and a 1.25 punch-in
the edges line up within ±12 px at both zoom states.

**Perf:** depth pass adds ≈ 4–7 s to a 11 s 1080×1920 master render (preset medium: 18.8 s vs
12.1 s flat in the last showcase run) — the full-res alphamerge/overlay runs for the whole
timeline. Gap: restrict the person layer to behind windows (segmenting the graph) if it matters.

## 2026-10-17 — Subject anchor + camera coupling: per-frame track computed by one pure helper

**Decision:** `visualMotionTrack` (`packages/media/src/visual-interaction.ts`, browser-safe)
produces per-local-frame centre (canvas px) + scale for a visual; `buildVisualInteractions`
bundles it with the emphasis hit and scene look; the worker passes the result as the Remotion
composition's `interactions` prop, the editor computes the identical object for the Player.
The composition applies it with `<TrackedMotion>` (translate + scale about the box centre),
outside the template, so templates are untouched.
- **Follow me** (`anchor.type = SUBJECT`): head box (subject track → crop → zoom, unclipped) centre
  + offset (canvas fractions). Zero-phase smoothing (forward/backward one-pole, τ = 0.12 s) —
  removes the tracker's 3 fps steps without lag; smoothing restarts per clip so the graphic
  CUTS with the picture on a cut instead of gliding across it. Unknown head → hold the last
  known spot; none → placement. Kept on the canvas (36 px margin) — not clamped to the
  platform-safe area: Chris placed it, and clamping made it jump away from where he dropped it
  (seen in the quality loop). `anchorOffsetFor` gives the offset that keeps a graphic exactly
  where it is when Follow is switched on, and dragging a following graphic edits the offset.
- **Move with camera** (`cameraCoupling`): scale = 1 + (z − 1)·c around the zoom focal point
  (`cameraCouplingTransform`; c = 1 reproduces the footage's own zoom exactly — tested). A
  following graphic already moves with the zoom through the head mapping; only its scale is
  coupled.

**Alternatives:** ffmpeg overlay x/y expressions (can't scale the alpha clip per frame cheaply,
and the editor preview couldn't share it); per-frame props in Remotion computed inside the
composition from raw tracks (would ship subject tracks into every clip render).

## 2026-10-17 — Scene integration in the composition: one SVG filter per graphic

**Decision:** the worker samples the footage region behind each graphic (`sceneRegionFor` →
un-zoom → inverse crop → ffmpeg crop + the edit's eq/temperature grade + area-scale to 8×8;
3 samples: after the entrance, middle, before the exit; `sampleSceneStatsForVisuals`), giving
mean RGB, Rec.709 luma and luma spread (`sceneStatsFromRgb`). `sceneLook` turns that into a
restrained look: scrim 0.08 → ~0.42 with luma (+≤0.08 for busy backgrounds; bare type gets it
in full, cards 35%), white balance ±4% toward the scene's temperature, black lift ≤ 0.03 on
bright footage, shadow tinted with the scene's own dark (22% of its colour, never pure black)
and stronger on bright footage, light-wrap colour = the scene colour normalised light, strength
0.25–0.6 with luma. `<SceneIntegration>` applies it as one SVG filter: feColorMatrix (match) →
light wrap (erode/blur alpha → inner-edge band → flood scene colour → screen) → contact shadow
(σ3, +3/+5 px) and drop shadow (σ22, +16/+30 px, down-right = key light top-left), plus a radial
scrim div. Values are in design px inside the scaled box, so they scale with the graphic.
`TemplateComponentProps` also carries `scene` for theme-aware styling (theme engineer).
Editor parity: `analyzeFootageAction` (server action) measures the same stats and per-word
loudness on demand (debounced 700 ms, cached per take), so the preview look matches the render.

Observed: on dark footage shadows and light-wrap are barely visible — by design (physically
true, and the restraint the brief asked for); on bright footage the scrim/shadow grow.

## 2026-10-17 — Emphasis timing: loudness z-scores + numbers → `hitAtFrame`

**Decision:** `measureWordLoudness` (16 kHz mono PCM, RMS/peak dBFS per transcript word);
`outputEmphasisWords` maps words to output time and scores z(RMS) + 0.5·z(peak) within each clip
+0.8 for number words (digits or spelled: "five", "thousand"…); `pickEmphasisHit` picks the hit:
+1.5 when the word is the very number/word the graphic shows (spelled numbers normalised, so
"five" matches a bar of 5), allowed window [start + 0.45 s, end − 0.9 s], slight preference for
the first half; lands on the word onset + 40 ms. `emphasisAt` semantics (contract-compatible):
`null` = automatic for NUMBER_COUNTER / BAR_CHART / KINETIC_TEXT / MONEY_STACK_3D; **`0` = off
(template timing)**; `> 0` = "land near start + emphasisAt" (snaps to a strong word within
±0.6 s, else exactly there). Template hooks (`templates/hit-timing.ts`, timing only): counter
and money-stack stretch/compress their build (0.45–3 s) to land on the hit; kinetic text spreads
the words before the key word (stagger ≤ 2.5×) so it punches on the hit; bar charts keep their
stagger and delay only the KEY bar, so the reveal lands on the word (quality loop: the "+$400"
bar rises exactly on "five years").

## 2026-10-17 — Veteran defaults; auto depth in the placement step

**Decision:** `applyInteractionDefaults` (new graphics only — editor insert; exported for the
Motion Designer path): cards ride punch-ins at 0.35, shadows on, scene match on, light wrap on
for 3D (ICON_3D, MONEY_STACK_3D, depth3d bar charts). Existing graphics are never rewritten.

Auto depth (`solveVisualPlacements`, AUTO only, needs `PlacementOptions.mattes` for every clip in
the window + a tracked head): big type — KINETIC_TEXT ≤ 28 chars, label-less NUMBER_COUNTER,
TITLE_CARD — tries the classic composition: full size (or 0.9/0.8), centred over Chris, its glyph
band crossing the top of his head (hair top at 62% of the band). The head is modelled as an
ellipse inside the protected region (`headEllipseFromProtected`); the share of the glyph band it
hides must be ≤ 0.20 for numbers (a hidden digit is a wrong number) and ≤ 0.34 for words, and the
box must be in the safe area and clear of captions/texts/other graphics. Pass → `depth:
BEHIND_SUBJECT` at that spot; fail → the normal solve, depth unchanged. AUTO owns depth like it
owns x/y/scale, so the editor's "Behind me" toggle pins the graphic (MANUAL, where it's drawn).
The editor persists the engine's depth on save. Manual behind-subject graphics no longer get the
"covers Chris's face" warning (that's the point).

Observed on the tight close-up stand-in (face ≈ 70% of the frame width): the rule correctly
refuses the number (it would hide too much under the platform-safe top), so the showcase placed it
by hand; the hand-placed result (hair over the bottom of "500", digits legible) is the look.

## 2026-10-17 — Editor: "In the shot" controls, theme picker, depth preview

**Decision:** for a selected graphic, an "In the shot" section: Behind me (pins), Follow me
(offset from where it is; dragging edits the offset), Move with camera (0–100%, hint when no
punch-in overlaps), Shadow / Light wrap / Match scene, Hit on my emphasis (+ "Hit near the
playhead", shows "Lands at X.Xs"). Each is one undo step (`lib/editor/visuals.ts` pure ops,
tested in `lib/editor/interaction.test.ts`). The Visuals sheet home has "Look of this video":
Auto (from topic) = `motionTheme: null`, or Custom (name, motion language, main/second colour,
icon style) — data only; the theme engineer's provider styles templates. Hit areas follow tracked
graphics.

**Preview parity (PersonCutout.tsx):** with behind-subject graphics and a matte, the motion layer
splits: behind Player → WebGL person cutout → front Player. The cutout uses the VISIBLE pool
`<video>` as the footage texture (no extra picture decoder) and ONE extra muted `<video>` for the
matte (a third element only while behind graphics exist; muted needs no iOS gesture unlock; kept
1-2 px visible so Safari keeps decoding). Shader = the renderer's geometry (cropGeometry + zoom
about the focal point) and edge curve; wrapped in the same `#ed-grade` SVG filter. Sync: paused →
exact seek; playing → re-seek past 0.12 s drift, ±5% playbackRate nudging under it. Fallbacks to
"everything in front" + a small "Depth shows in the export" pill: no WebGL, shader failure,
cross-origin footage without CORS (blob mode's presigned URLs taint the texture — **known gap
on production**: the Blob store would need CORS headers / a same-origin proxy for the preview
cutout), or > 50% of frames taking > 14 ms. Verified in Chrome at iPhone 15 size (393×852 ×3,
touch): number behind the hair in the preview, matching the render. `/api/media` now serves a
take's `matteStorageKey`.

### Gaps / follow-ups
- Real-iPhone performance of the WebGL cutout + two Players not measured (Chrome emulation only).
- Production (Blob) preview depth falls back to front (CORS) — renders are unaffected.
- Depth compositing runs for the whole timeline (perf above).
- Light wrap is an SVG approximation on the graphic's inner edge with one average colour per
  graphic (not a per-pixel blurred background); TITLE_CARD's dimming isn't scene-matched.
- `FULL_LAYER` render strategy has no per-visual depth (PER_VISUAL is the default and supports it).
- The Motion Designer (packages/agents) should call `applyInteractionDefaults` on proposed visuals
  and may set `depth`/`anchor` — integration note for the AI engineer.
- A real take of Chris should replace the public-domain stand-in in the next quality pass.

### Quality loop (2026-10-17)
`apps/worker/scripts/motion-v2-showcase.ts <video> <outDir>` renders through the worker's
functions (withResolvedPlacements → prepareInteraction → prepareMotion → renderTimeline) on an
11 s 1080×1920 stand-in made from the public-domain portrait (fixtures/NOTICE.txt): number behind
the head (RISER, lands on "$24,500"), a stat card following him, a bar chart riding a 1.16× ease
punch-in at 45% (key bar revealed on "five"), a 3D icon with light wrap. Iterations made from the
frames: the stand-in got natural headroom (the first framing left no room above the head); the
anchored card stopped being clamped to the safe area (it jumped onto his chin); the bar chart's
hit delayed the whole build (an empty card for ~1 s) → only the key bar waits now; spelled
numbers count; head-occlusion moved from box overlap to an ellipse model. Consecutive-frame
checks show a stable matte edge on the number and sub-pixel smooth follow motion.
Timings (last run): matte 38 s (cached afterwards), measurements 2.6 s, motion layer 17.7 s,
master 18.8 s (12.1 s without the depth pass). Evidence: `docs/evidence/2026-10-17-motion-v2/`.

---

# 2026-10-17 — Simplified flow: upload → editor, Videos home, plain language

## 2026-10-17 — Upload goes straight into the editor, with no AI required

**Decision:** after a footage-first upload (`/upload`, or "Upload footage" on a video's page)
the app waits briefly for the captions, then makes a deterministic **starter edit** and opens
`/content/[id]/edit`. `createStarterEdit(prisma, contentItemId, actor)`
(`packages/domain/src/starter-edit.ts`) makes zero model calls and goes through the real state
machine — `recordTakeSelection` (MEDIA_INGESTED → TAKE_SELECTED, reason "Auto: no AI
needed — …") then `recordEditPlan` (TAKE_SELECTED → EDIT_PLANNED). Idempotent: an item that
already has a plan in an editable state just returns it. Every "Edit video" button on an item
at MEDIA_INGESTED/TAKE_SELECTED runs it (`startEditing` in `app/content/[id]/flow-actions.ts`).

- **Take choice:** one take → it; several → the **longest** (ties → most recent upload). The
  upload screen says "several takes of the same video is fine", i.e. retakes; stitching them
  all together would repeat the video. The longest is the likeliest complete take; the others
  are in the editor's media bin to swap or add.
- **Plan:** a plain `EditPlanOutput` (whole take, 1080x1920, loudness-normalized, captions ON
  in the house BOLD_HIGHLIGHT style, no overlays) with **no `plan.timeline`**. The editor
  (`initialEditorDoc`) and the renderer (`timelineForPlan`) both convert it with
  `planToTimeline` at load time, which enables captions only when the take has word timings.
  So captions appear as soon as the background transcription lands — no re-plan needed. A
  web test (`apps/web/lib/starter-edit.test.ts`) pins the plan to `EditPlanOutputSchema`
  (domain can't import packages/agents).
- **Waiting for captions:** the upload screen polls `captionStatus` every 2 s for up to 90 s
  ("Getting your captions ready…", with "Open the editor now" to skip). On Vercel, where
  transcription is off, it doesn't wait.
- Uploading footage to a video still at READY_TO_FILM first applies the allowlisted manual
  transition READY_TO_FILM → FILMED ("I've filmed this") — uploading footage is that fact.
- "Improve with AI" (the existing Edit Planner re-plan from EDIT_PLANNED) is still on the
  video page; Take Selector / Edit Planner are still offered as secondary actions before an
  edit exists.

**Alternatives considered:** keep all takes as consecutive clips (rejected as the default
for retakes, see above); store a full `plan.timeline` (rejected — it would freeze captions
off when the transcript hadn't arrived yet); skip the state machine and write EDIT_PLANNED
directly (forbidden).

**Reversibility:** high. Additive domain function; AI planning is untouched.

**Known limit:** if Chris saves a finishing edit before the transcript lands, that saved
timeline has captions off (he can turn them on in the Captions tool). The editor only picks
up a newly-landed transcript on reload — we don't poll inside the editor (not this change's
file).

---

## 2026-10-17 — Plain language for every status; one shared module

**Decision:** `packages/domain/src/friendly-status.ts` maps all 24 ContentStates to plain
words (Idea · Planned · Writing · Ready to film · Filmed — upload footage · Editing ·
Checking · Needs a fix · Ready to post · Scheduled · Posting… · Posted · Done · Cancelled),
the five-step progress (Plan → Write → Film → Edit → Post), the Home groups, and the ONE next
action per state (`nextActionFor`). It's exported from the browser-safe
`@chris/domain/planning` too. `stateLabel`/`contentStateTone`/`StatusPill` in
`app/components/ui.tsx` use it, so lists, badges, calendar sheets, analytics and the video
page never show an enum. (The audit-trail list shows friendly names with the raw transition
in a tooltip.) Tests: `friendly-status.test.ts` asserts every state has a label with no
enum-looking text and exactly one next action.

**Reversibility:** high — presentation only; the state machine is unchanged.

---

## 2026-10-17 — Home = your videos; Videos = card grid; Home · Videos · + Upload · Calendar · More

**Decision:**
- **Home** (`app/page.tsx`): greeting; one big "Do this next" card (a blocked video first,
  then a video mid-edit/awaiting upload, then the top posting-plan nudge, then any video
  waiting on Chris); a one-line Stay-on-course row (→ /todo); then "In progress", "Ready to
  post", "Posted" as big cards (thumbnail = latest good render, else the first take via a
  `#t=` media fragment; plain status pill; one button: Edit video / Edit / Upload footage /
  Film it / Schedule / View post / Fix). Ideas are counted, not listed. **First run** (no
  videos): "Let's make your first video" with "Upload a video I filmed" and "Plan a new
  video". The thesis/performance/creative-director/needs-you panels moved off Home (they're
  under More → Strategy / Analytics / Learnings / To-do).
- **Videos** (`app/content/page.tsx`): the same cards in a grid with filters (In progress,
  Needs a fix, Ready to post, Posted, Ideas, All). Batch Autopilot is kept, folded under
  "Autopilot (AI)".
- **Nav:** phone tab bar Home · Videos · (+) Upload (center) · Calendar · More. Film moves
  into More (and into every "Film it" button). Desktop shows the same four + a "More" menu.
  `nav-links-data.ts` (`PRIMARY_LINKS`, `MORE_LINKS`, `TAB_LINKS`) + `mobile-nav.test.ts`.

**Reversibility:** high — no data changes.

---

## 2026-10-17 — The video page: video, status, progress, ONE button; the rest under "Details & history"

**Decision:** `/content/[id]` now opens with the video (latest good render, else the take,
else a placeholder — small beside the title on phones so the next step stays above the
fold), the title, the plain status pill, "Scheduled for …"/"Posted …", the 5-step progress
bar, and one big primary button for the next step plus at most two secondary ones. The
sticky Next-step bar on phones shows the same action. Only the input the current step needs
is open on the page (upload box, schedule form, plan-by-hand, shot-notes-by-hand, what the
final check found). Every other panel — Autopilot, each AI step, contract, research, script
versions + editing, take selection, edit plan, renders + technical QC, quality gate,
packages, publications, snapshots, evaluation, comments, creator card, takes + transcripts,
calendar date, taste feedback, cancel, audit trail — is unchanged and lives in a collapsed
"Details & history" section. No control was removed.

The editor page's "no edit yet" screen (an old link to `/edit` before an edit exists) now
offers "Edit video" (the starter edit) instead of "once the AI has planned the edit" — a
small, link-only change to `app/content/[id]/edit/page.tsx`.

**Reversibility:** high — re-arrangement of existing panels.


## Plan import (2026-10-17)

Chris asked for "a place where I can import my video plan — a day, week, month or year — then
build from it and upload efficiently." He posts 4 videos a day on each of TikTok, Instagram and
YouTube, so a month plan is ~120 videos × 3 platforms. Built: `/plan/import`, `/plan` (board +
filming checklist), `/plan/upload` (batch clip upload with auto-matching). To be merged into
`/docs/DECISIONS.md` by the integrator.

---

## 2026-10-17 — Plan import: deterministic parsing first, AI cleanup optional

**Decision:** every import path (CSV/TSV file, Excel .xlsx, Google Sheets link, pasted text)
is parsed by deterministic code in `packages/domain/src/plan-import/` (browser-safe, exposed
as `@chris/domain/plan-import`): header auto-mapping by synonyms (correctable in a "Columns"
panel), checkbox-style platform columns, merged week/date cells carried down, a line grammar
for free text (week headings, day headings, "date — title — platforms (time)" in any order,
"Hook:/Notes:/Platforms:" label lines, markdown pipe tables and pasted spreadsheet cells, chat
preamble/sign-off ignored). "Clean up with AI" (new Plan Importer agent, MEDIUM,
`prompts/agents/PLAN_IMPORTER.md`, strict `PlanImporterResult` schema) is an optional button on
text imports only; code drops any row whose title isn't in the pasted text and clears invented
hooks/notes.

**Rationale:** CLAUDE.md — deterministic code for deterministic checks; the import must work
with zero AI credit; an LLM restructuring Chris's own plan must not add to it (provenance).

**Alternatives:** AI-first parsing (costly, non-deterministic, unusable without credit);
SheetJS (npm releases years out of date) — `exceljs` 4.4.0 (MIT) used server-side instead, via
`PUT /api/plan-xlsx` (a route handler, not a Server Action, because of the 1 MB action body
limit). Reversible: the AI button can be removed without touching the parsers.

## 2026-10-17 — Date conventions

- Numeric dates are US month/day (`10/20` = Oct 20). A written weekday that contradicts the
  date ("Mon 10/20" when Oct 20 is a Tuesday) keeps the date and shows a warning.
- No year → nearest upcoming occurrence with a 60-day look-back (a plan that started last week
  stays this year; "Jan 3" imported in December → next year).
- Ranges ("Oct 20–24") use the first day, flagged in the preview.
- Relative plans ("Day 3", "Week 2 Tue", bare weekdays) resolve against a start date the
  preview asks for only when needed; a "Week 2" heading after "Week 1 (Oct 19 – 25)" counts
  from the dated week. Bare weekday lists roll forward (Mon, Wed, Mon → next week's Mon).
- Rows without a usable date or title must be fixed (inline date picker) or removed before
  "Create" is enabled.
- No time → the day's posting slots from the posting plan (Chris's: 09:00/12:00/17:00/20:00):
  untimed videos on the same day are spread across the slots in order, skipping slots another
  row that day asked for — so a 4-a-day plan lands exactly on the 4 daily slots.
- "All"/no platforms → the posting plan's enabled platforms. Non-connected networks
  (Facebook…) are reported, not silently dropped.

## 2026-10-17 — Imported videos are SELECTED + dated via the ungated ScheduleEntry

**Decision:** each row → `ContentItem` (title; hook + notes in the description as written —
never a fake script; pillar/format when given) → `IDEA → SELECTED` (HUMAN, reason "Imported
plan") → `ScheduleEntry` via `setScheduleEntry` (now optionally records `targetPlatforms`) on its
planned day/time. A video Chris put on a dated plan is a committed choice — that's what
SELECTED means in the state machine; leaving them as IDEA would hide them from every
"in progress" view. No hard gate is touched: `scheduleContentItemForPublishing` (READY only) is
still the only way to queue a publish; the calendar shows these as "not ready yet" and they
fill their posting-plan slots.

**Schema (migration `20261017160000_plan_import`):** new `PlanImport` (source kind/ref, raw
input sha256 + 2 000-char excerpt, idempotency key, row/created/skipped counts, createdBy,
undoneAt/By) and nullable `ContentItem.planImportId` (provenance). Additive; existing rows
unaffected.

**Idempotency:** the import's key is the sha256 of the canonical rows; re-importing the same
plan reuses the import, and every row is also checked against existing dated, non-cancelled
videos by (normalized title, local day) — so double taps, retries, and overlapping plans
(CSV then the same videos pasted from ChatGPT) never duplicate. The preview shows these as
"Already planned — skipped" (collapsed).

**Undo:** "Undo this import" cancels (with a reason) only imported videos still untouched
(IDEA/SELECTED, no footage) and removes their ScheduleEntry; started videos are kept and
counted. Nothing is deleted; transitions and audit rows stay. Idempotent.

## 2026-10-17 — `advancePlannedItemToFilmed` (generalized footage-first)

Uploading footage for a planned video walks it from wherever it is (IDEA … READY_TO_FILM) to
FILMED with one SYSTEM transition per skipped step, reason "Planned video — footage uploaded"
(IDEA → SELECTED is HUMAN). A missing Production Contract is created STANDARD research / MEDIUM
risk — not the fact-check-exempt NONE/LOW — so the FACTUAL hard gate still blocks publishing
until the footage's own claims pass. Existing contracts are kept. Already FILMED or later:
no-op (extra takes). Research-blocked / cancelled / posted: refused with a plain message.
Per-step idempotency keys make it retry-safe. `createContentItemFromFootage` now shares the
same walk.

## 2026-10-17 — Batch upload auto-matching (`matchClipsToPlan`)

Pure function in `plan-import/match.ts`. Signals: filename ↔ title (token overlap +
Jaro-Winkler; camera names like `IMG_4031` carry no signal), capture date (File.lastModified in
APP_TIMEZONE) vs planned day (filmed 0–5 days before scores highest, up to 2 days after
still matches), then order within a day (clips by capture time take the earliest unclaimed
planned videos). Several clips can map to one video (takes). Each match shows Sure / Likely /
Guess with a reason; Chris can reassign (day-grouped picker), mark "New video" (footage-first)
or "Skip".

**iOS assumption (unverified on a device):** Safari's Photos picker hands over an exported
copy whose `lastModified` may be the pick time rather than the capture time. Timestamps within
10 minutes of "now" are therefore treated as unknown (name/order still work). If real devices
always report pick time, date matching simply never fires — nothing breaks.

**Resilience:** sequential uploads, per-file progress, one failure doesn't stop the rest,
"Retry failed" re-sends only failures, and files already uploaded from this phone are
recognized (localStorage signature name+size+mtime) if he picks them again after a refresh.
After the batch, each video that got footage gets the no-AI starter edit (`createStarterEdit`)
so its "Edit" button opens the editor directly — same as the single-upload flow.

## 2026-10-17 — Plan board

`/plan`: dated videos grouped Behind / Today / This week / Next week / Week of …; filters
"This week" (rolling 7 days) · "30 days" · "All". Status words come from friendly-status, except
anything not yet filmed reads "Not filmed yet" with one action, "Upload" (the research/script
steps are optional for a video Chris planned himself). "Filming checklist" lists what to film
in a date range (film-by = post day − the plan's filming lead) with hooks and notes; ticks are
a per-device convenience (localStorage), the real signal is uploading.

## Verification

Unit/integration: parsers (CSV/xlsx/sheets URL/free text, messy fixtures in
`fixtures/plans/`), volume (120-video month; 60 clips × 400 planned), import idempotency + undo,
`advancePlannedItemToFilmed`, matcher, Plan Importer provenance. Visual: throwaway PGlite
(migrated + seeded + 4/day posting plan), `next dev`, Playwright system Chrome at iPhone 15 —
CSV import with a bad row fixed, ChatGPT text import (7 duplicates detected), Excel import,
board, filming checklist, calendar month, 4 synthetic clips auto-matched (2 takes by name, 1 by
name, 1 camera-named by date/order) and uploaded, single-video upload from the board.
Screenshots: `docs/evidence/2026-10-17-plan-import/`. Google Sheets fetch is unit-tested
(URL conversion + private-sheet detection) but not exercised live (no network in the sandbox).


## Cloud renderer — heavy jobs in Vercel Sandbox (2026-10-17)

---

## 2026-10-17 — Heavy jobs run in a Vercel Sandbox microVM on the live site

**Problem.** Chris uses the app on his iPhone against the Vercel deployment. Everything heavy
was impossible there: the motion layer needs headless Chrome (Remotion) — renders silently
degraded to "no graphics"; Whisper, the face tracker and the MODNet person matte need
onnxruntime and minutes of CPU — all were off on Vercel. No transcripts, no mattes, no
animated exports from the phone.

**Decision.** Every heavy job goes through one dispatcher, `apps/web/lib/heavy-jobs.ts`
`runHeavyJob(kind, args, { actorId })`:

- **inline** (local `next dev`, default when `VERCEL` is unset): runs in-process exactly as
  before and returns the outcome (same domain functions, same audit trail);
- **sandbox** (default on Vercel; `RENDER_MODE=inline|sandbox` overrides): claims the item's
  lease, boots a **Vercel Sandbox** from the cloud-worker snapshot (`RENDER_SANDBOX_SNAPSHOT_ID`,
  8 vCPU / 16 GB, 45 min hard timeout), writes the job's env + args as files, starts
  `run-job.sh <kind>` **detached** and returns the JobRun id at once (~2 s). The phone polls
  `GET /api/jobs/[id]`.

Job kinds (`apps/worker/src/heavy-job-kinds.ts`): `render` (motion layer + matte compositing;
`thenQualityGate` runs the four hard gates in the same VM for the editor's Finish),
`quality-gate`, `auto-repair`, `transcribe`, `subject-track`, `person-matte`, `ingest`
(upload analysis: every take's captions first, then face tracking, then mattes — re-reading the
item so takes uploaded meanwhile are included), `motion-design` (Design visuals with AI, with
face tracking first). Platform variants (publish) were not moved: they are light ffmpeg work
that already runs in a function.

**One implementation.** `apps/worker/src/heavy-jobs.ts` `executeHeavyJob` /
`runHeavyJobRecorded` is the only executor — the local in-process path and the sandbox CLI
(`apps/worker/src/job-runner.ts`) call the same function, which calls the existing worker jobs
(`renderContentItem`, `runQualityGateForContentItem`, …). The cloud path is the local path.

**Runner (`job-runner.ts`).** `node job-runner.mjs <kind> <json|@file> --job-run-id <id>
--env-file <0600 json> --stop-self`. Secrets (DATABASE_URL, BLOB_READ_WRITE_TOKEN, and
ANTHROPIC_API_KEY *only* for kinds that call the model) travel in a file the runner deletes on
read — never on a command line. Real database (Prisma 7 + `@prisma/adapter-pg` + the WASM
query compiler: no native engine, bundles cleanly), real private Blob store (the Blob adapter
moved to `apps/worker/src/blob-storage.ts`; `apps/web/lib/blob-storage.ts` re-exports it). The
model provider is the same cost-tracked, spend-capped Anthropic provider the web app uses.
Progress goes on the JobRun (throttled to one write / 2 s); the result and a plain-English
message when done; a crash, a kill (SIGTERM) or a timeout records FAILED with the reason.
`--offline <job.json>` runs render / transcribe / subject-track / person-matte on local files
(no DB, no storage) — used to verify a snapshot. `warmup` downloads every model.

**JobRun as job record + lease, no schema change.** `kind = heavy:<contentItemId>` (exact-match
on the existing `(kind, startedAt)` index, like the publish lease); `summary` JSON holds
`{ jobKind, args, mode, actorId, progress { pct, message, stage }, sandboxName, result }`.
`acquireHeavyJobLease` (packages/domain job-run.ts) serializes claims with one advisory lock:
**one heavy job per video** (a second tap gets BUSY and follows the running job), **at most
`HEAVY_JOB_MAX_SANDBOXES` (default 4) sandboxes at once**, and a RUNNING row older than the
sandbox timeout + 5 min is taken over as dead. Beyond the cap a job is **QUEUED** (status
`QUEUED`, FIFO, "Waiting for a free cloud worker…", reads as running to clients with
`queued: true`) instead of refused — a batch upload of many clips must not lose captions:
a worker that finishes keeps its VM and **drains the queue** (`claimQueuedHeavyJob`; without the
model key only non-AI kinds; only while ≥ 15 min of its sandbox time is left), and every poll of
a queued/finished job (`/api/jobs/[id]`, the upload screen's caption wait) starts queued jobs in
new sandboxes while there's capacity (`kickQueuedHeavyJobs`). A queued job nobody starts within
2 h is FAILED.
Progress/finish writes are single-statement `jsonb ||` merges; `finishHeavyJob` is
first-writer-wins (a late worker can't overwrite the web app's "worker vanished" verdict).

**Always stopped.** Measured: powering the VM off from inside (`/proc/sysrq-trigger`) ends the
VM but Vercel keeps reporting the sandbox "running" until its timeout (watched for 2+ min), so
it isn't a stop. The worker therefore **stops its own sandbox through the API** when the job is
recorded, with the project's short-lived OIDC token the dispatcher passes in the env file
(verified: "stopped" 4 s after launch for a job that failed fast — `scripts/sandbox/verify-dispatch.ts`).
Backstops: each poll of `/api/jobs/[id]` stops a finished job's sandbox once, and marks a job
FAILED when its sandbox is gone or stopped while the job says RUNNING (checked only after 60 s
without progress); the 45-min sandbox timeout is the last resort. Launch failure → the JobRun
is FAILED with the reason, the sandbox (if created) is stopped, nothing else was written.

**UI (progress only — page layouts untouched).** `useJobProgress` / `waitForJob`
(`apps/web/lib/use-job-progress.ts`) poll every 2 s and ride out flaky mobile connections.
A floating card on a video's pages (`app/content/[id]/layout.tsx` + `HeavyJobBanner.tsx`) shows
"Rendering your graphics… 40%", refreshes the page when the job ends, and says how it went;
the content page's Render / Quality check / Transcribe / Auto-repair / Autopilot buttons open the
page with `?job=<id>`. Finish & schedule: on Vercel one job renders and then quality-checks;
the modal shows the render's stages and percentage, then the check, then schedules (locally:
unchanged, four sequential actions). Design visuals with AI follows its job, then loads the
saved version. Autopilot stops at a cloud step and says so (press again when it's done).
Upload flow: the upload's one `ingest` job transcribes first; the upload screen's "Getting your
captions ready…" wait (flow-actions `captionStatus`) now shows the job's progress line and stops
waiting if no job is running (failed / never started). Batch upload (`/plan/upload`): every
clip's registration starts (or queues) its item's `ingest` job; the starter edit is a plain
EditPlan converted at editor LOAD time, so captions are on as soon as the transcript has landed
(an editor opened before that shows captions after a reload — the editor doesn't live-poll).

**Flags.** `isAutoTranscriptionEnabled` / `isAutoSubjectTrackingEnabled` / `isAutoPersonMatteEnabled`
default to ON on Vercel when the cloud worker is configured (still `TRANSCRIPTION|SUBJECT_TRACKING|PERSON_MATTE=on|off`
overrides). Without `RENDER_SANDBOX_SNAPSHOT_ID`, sandbox mode refuses heavy jobs with a clear
message ("The cloud renderer isn't set up yet…") instead of silently rendering without graphics.

**Alternatives considered.** A long-running worker host (another service to run and pay for
24/7, for a single operator); Remotion Lambda (AWS account + fetching alpha clips back; Whisper/
ONNX still homeless); a Vercel Function with `@sparticuz/chromium` (250 MB / 300 s limits — no
room for Whisper + MODNet + Chrome, and long renders don't fit); a custom VCR image instead of a
snapshot (cleaner, but needs a Docker build pipeline — the snapshot is built by a script).

**Reversibility.** High: `RENDER_MODE=inline` restores the previous behaviour everywhere; unset
`RENDER_SANDBOX_SNAPSHOT_ID` and heavy actions refuse clearly. No schema change.

---

## 2026-10-17 — The cloud-worker artifact and snapshot

**Image.** Managed image `vercel/sandbox/node:24` (Ubuntu 26.04, Node 24, apt, passwordless
sudo — the `runtime: "node24"` Amazon Linux option is deprecated in SDK 3.x). Chrome headless
shell's libraries via apt (t64 package names, with fallbacks).

**Artifact (`scripts/sandbox/build-runner.ts`, deterministic, content-hashed `VERSION`).**
`.sandbox-build/runner/`: `apps/worker/dist/job-runner.mjs` (esbuild, node24 ESM, minified with
names kept; Prisma client, pg, Blob, Anthropic SDK, the domain/agents/media/motion code all
bundled); externals installed with npm in the sandbox at the repo's pinned versions —
`ffmpeg-static`, `ffprobe-static`, `onnxruntime-node`, `@huggingface/transformers`,
`@remotion/renderer` (+ its Linux compositor); `prompts/`, `brand/`, `packages/media/assets`,
the SFX kit — laid out like the repo so `REPO_ROOT`-relative reads keep working; and the
**Remotion project pre-bundled** with `@remotion/bundler` at build time (`motion-bundle/`, used
via the new `MOTION_BUNDLE_DIR`; no webpack/rspack in the VM). `bin/run-job.sh` sets the
runtime paths (`RENDER_FONTS_DIR`, `SUBJECT_TRACK_MODEL_PATH`, `MOTION_SFX_DIR`,
`MOTION_BUNDLE_DIR`, `MATTE_CACHE_DIR`, `TRANSCRIPTION_CACHE_DIR`, `REMOTION_GL=swangle`,
`REMOTION_CONCURRENCY=2`; each overridable per job). `MANIFEST.sha256` lists every file.

**Snapshot (`scripts/sandbox/create-snapshot.ts`).** Boot → apt → upload the runner →
restore → `npm install` → `run-job.sh warmup` (Chrome headless shell, Whisper base.en
timestamped ~280 MB and MODNet ~26 MB downloaded *inside* the VM into `/vercel/sandbox/cache`)
→ smoke tests (ffmpeg/ffprobe, an offline render with a 2D and a 3D graphic that must produce 2
overlays, the face tracker, the person matte) → `sandbox.snapshot({ expiration: 0 })` → prints
the id and writes `.sandbox-build/snapshot.json`. Snapshot ≈ 1.4 GB.

*Upload constraint found:* the operator's connection uploaded at ~50 KB/s (writeFiles and a
plain HTTPS POST alike), and one 15 MB `writeFiles` stalled. So the upload is "lite" (7.2 MB):
source maps dropped (empty stub maps are written — Remotion opens them when it symbolicates an
error, and a missing map hid the real error), the Remotion `public/` copy re-created from the
assets, the UltraFace model downloaded from its source URL, the SFX regenerated by their
deterministic generator — then the whole tree is checked with `sha256sum -c MANIFEST.sha256`
(it passes: the regenerated WAVs are byte-identical). Uploads go in 768 KB chunks with
per-chunk retry. `--resume <sandbox> --from <step>` + `--keep-on-failure` continue a failed
build; `--base <snapshotId>` rebuilds on top of a previous snapshot and uploads only changed
files (MANIFEST diff) — ~1.5 min instead of ~6.

*GPU-less WebGL:* `gl: "angle"` fails in the VM ("Error creating WebGL context") — the 3D
templates need `REMOTION_GL=swangle` (ANGLE on SwiftShader). SwiftShader is multi-threaded per
tab, so fewer tabs is faster: same 159 frames on 8 vCPU took 89 s at concurrency 1, **60 s at
2**, 117 s at 4, 152 s at 8 (single runs, ±30 % run-to-run). 4 vCPU was much slower (render
213 s vs 86–131 s) — 8 vCPU (Pro max) is the default.

**Verified for real (2026-10-17, snapshot `snap_w3kag80j7aDxYTFz8kXk7FzO3e2b`, runner
`d4ec0ab1e37ecd97`; the same render path verified on its predecessors).**
`scripts/sandbox/verify-offline.ts`: a 6 s 1080×1920 talking-head stand-in (the public-domain
portrait fixture with headroom, drift and a tone) with `$24,500` NUMBER_COUNTER **BEHIND_SUBJECT**
over the head and a 3D ICON_3D (shadow, light wrap, scene match), rendered by
`run-job.sh render --offline` in the sandbox: face track → MODNet matte → Remotion layer →
depth compositing, `behindSubject: 1, mattedClips: 1`, no warnings. Frames:
`docs/evidence/2026-10-17-cloud-renderer/` — the digits pass behind the hair, the 3D piggy bank
renders (WebGL in the VM). Report: `sandbox-verify-report.json`.

| Measurement (8 vCPU) | Value |
|---|---|
| Boot from snapshot | 1.4–2.9 s |
| Dispatch (create + write files + start detached), as the web app does it | 2.2 s |
| Render, 6 s clip, 2 graphics, matte computed in-job | 83–131 s (matte 15–23 s · motion 57–93 s · compose 9–13 s) |
| Whisper base.en, 6 s clip / face track | 4.4–5.5 s / 1.6–2 s |
| Verification session (render + transcribe + track + download to laptop) | 168 s, 812 s active CPU |

---

## 2026-10-17 — Cost (Vercel Sandbox pricing fetched 2026-10-17, iad1, Pro)

Active CPU **$0.128 / hour**, provisioned memory **$0.0212 / GB-hour** (2 GB per vCPU → 16 GB at
8 vCPU = $0.34 / hour of wall time), creations $0.60 / million, snapshot storage $0.08 / GB-month,
inbound data free. Pro's $20/month credit applies first.

- Verification session above: 812 s CPU → $0.029 + 16 GB × 168 s → $0.016 ≈ **$0.045**.
- Typical Finish (45 s video, ~12 s of graphics ≈ 360 motion frames, quality check included):
  ~5 min wall (motion 2.5–3.5 min, compose ~1.3 min, I/O + check ~1 min) → memory ≈ $0.03,
  CPU ≤ 8 vCPU × 5 min ≈ $0.085 → **≈ $0.06–0.11 per render**.
- Upload analysis of a 60 s take (captions ~30 s, tracking ~10 s, matte ~3 min) ≈ 4 min →
  **≈ $0.05–0.09**.
- 20 videos/month × (1 upload analysis + 2 renders) ≈ **$3–6/month**, inside the Pro credit.
- Snapshots: ≈ 1.4 GB each → ~$0.11/month each. Five were created while building this
  (`snap_bqmr6jQmSOpDb6olu9MiFvJ8vRFo` → `snap_XviN8nZ3XOl96YHWJWnVv1IZeo1t` →
  `snap_sGD2s7x7nqNLVHlpKvNkCmpVPmxi` → `snap_bAJfwcdh2pE3LoBCvqYGdASVFwIB` →
  `snap_w3kag80j7aDxYTFz8kXk7FzO3e2b` (active), each built on the previous); keep the active
  one, delete older ones (Vercel dashboard → Sandboxes → Snapshots) once a new one is verified.
- Model calls (quality check, Motion Designer) are billed by Anthropic as before and stay under
  the daily spend cap (the worker uses the same cost-tracked provider).

---

## Operator steps

1. **Set on Vercel** (Production; Preview too only if previews should render):
   - `RENDER_SANDBOX_SNAPSHOT_ID=snap_w3kag80j7aDxYTFz8kXk7FzO3e2b`
   - optional: `RENDER_SANDBOX_VCPUS` (default 8; Hobby max 4), `RENDER_SANDBOX_TIMEOUT_MS`
     (default 2 700 000 = 45 min; Hobby's session max is 45 min), `HEAVY_JOB_MAX_SANDBOXES`
     (default 4; more jobs wait in the queue).
   - Nothing else: the sandbox SDK authenticates with the project's OIDC token automatically;
     the worker receives `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN` and (for AI steps)
     `ANTHROPIC_API_KEY` from the function's env per job. Redeploy.
2. **Check** on the phone: batch-upload 4 clips via /plan/upload, wait ~1–2 min, open each
   editor → captions on. Upload a take → "Getting your captions ready…" shows the job's
   progress and the editor opens with captions; Finish & schedule shows "Rendering your
   graphics… N%" then the check; the export has the graphics (and behind-subject depth).
   Vercel dashboard → Sandboxes: each job's sandbox is `heavy-<jobRunId>` and stops when done.
3. **Rebuild the snapshot** after changing anything the worker runs (apps/worker, packages/*,
   prompts, brand, Remotion templates, dependency versions):
   `SANDBOX_ENV_FILE=<dotenv with VERCEL_TOKEN> pnpm exec tsx scripts/sandbox/create-snapshot.ts`
   (full, ~6 min + upload) or `… --base <current snapshot id>` (incremental). Then
   `pnpm exec tsx scripts/sandbox/verify-offline.ts --snapshot <new id>` (look at
   `.sandbox-build/verify/frames/`) and `scripts/sandbox/verify-dispatch.ts`, set the new id on
   Vercel, redeploy, delete the old snapshot. **The web app and the snapshot must match**: a
   deploy that changes job args/results without a new snapshot can break cloud jobs.
4. `scripts/sandbox/stop.ts --all-running` stops every running sandbox of the project (after an
   interrupted script).

## Limits / known gaps

- **Not exercised end to end against production data.** The sandbox cannot reach a laptop's
  throwaway database, and no throwaway Neon branch was available, so the online DB + Blob path
  was verified in parts: the runner CLI end to end against the throwaway PGlite + local storage
  as a child process with the real face tracker (test), the dispatcher against a fake launcher
  (tests), the real launcher + self-stop against Vercel (verify-dispatch), and every heavy
  computation in the real VM offline (verify-offline). First live run: watch the first Finish.
- Neon's pooled `DATABASE_URL` is used from the VM (Neon allows public connections).
- Snapshot ↔ code version coupling (above). The runner validates args and fails clearly on an
  unknown kind.
- The OIDC token used for self-stop is short-lived; a job that outlives it can't stop itself —
  the poll-time stop and the timeout cover it.
- Captions for an editor that was already open when the transcript landed need a reload.
- One heavy job per video: while an upload's analysis (matte ≈ 3 min for a 60 s take) runs,
  Render/Finish for that video answers "Analyzing your footage for this video right now…".
- `HEAVY_JOB_MAX_SANDBOXES` counts RUNNING JobRuns, not live VMs; a VM orphaned by a crashed
  dispatcher is bounded by its timeout.
- Motion-layer rendering on CPU WebGL is the slow part (≈ 0.4–0.6 s per graphic frame).


## AI credit screen instead of in-app Apple Pay (2026-10-17)

**Request:** Chris asked for Apple Pay in the app to fund the AI (Anthropic credits).

**Conflict:** Anthropic has no API for buying credit on an account's behalf. A payment taken
inside this app (Apple Pay via Stripe or similar) would land in a merchant account, never in
the Anthropic balance — it would cost fees and still leave the credit empty.

**Decision:** `/settings/ai` ("AI credit", in More) shows whether the AI is working, out of
credit (the same `ANTHROPIC_CREDIT_ERROR_RE` detection the to-do nudge uses, now shared from
`model-call-log.ts`), or unconfigured; spend today / last 30 days / per video from
`ModelCallLog`; the daily safety cap; and an "Add credit" button that opens Anthropic's own
billing page. The to-do nudge points at this screen.

**Alternatives:** Stripe + Apple Pay into a merchant account (rejected — money never reaches
Anthropic); storing a card for automatic top-ups (impossible without an Anthropic API).

**Reversibility:** high — one page, one domain function, one nav link. If Anthropic ever ships
a billing API, the button becomes an in-app flow.


## Reference videos (2026-10-17)

Chris asked: "can I add the reference videos in the app?" He wants his auto-edits to feel like
the creators he admires (Alex Hormozi, Shelby Sapp…): cut timing, pacing, hooks, endings, audio
balance. This adds the upload and a free (no-AI) measurement of those things, aggregated into a
plain-English "style fingerprint" per creator and overall, plus a typed aggregate
(`getReferenceStyleProfile`) for the edit planner to use later. **No agent or the edit planner
was rewired.**

---

## Decision 1 — Reference videos are ReferenceContent rows with media + metrics (additive migration)

`20261017180000_reference_videos` adds nullable columns to `ReferenceContent`:
`mediaStorageKey, mediaFilename, mediaMimeType, mediaSizeBytes, mediaUploadedAt, mediaDeletedAt,
analysisStatus (enum PENDING|DONE|FAILED), analysisError, analyzedAt, metrics (jsonb),
metricsVersion` + an index on `analysisStatus`. Existing notes-only rows are untouched (all
null) and still render under "Written notes & AI observations". `metrics` is
`ReferenceVideoMetrics` (`packages/domain/src/style-metrics.ts`, zod, `version: 1`), validated on
every write (`recordReferenceAnalysis` — a malformed result is stored as a FAILED analysis, never
half-written) and on every read (`parseReferenceVideoMetrics`; rows that don't parse are skipped
by the aggregate). An uploaded video's `description` is `""` (the column is required; uploads have
no prose); a creator created from the upload screen gets only its name (`brandPositioning: ""`).

*Alternatives:* a new `ReferenceVideo` table (cleaner, but splits "a piece of reference content"
in two and duplicates the creator relation and the existing observations link); typed columns per
metric (rigid — the metric set will grow; zod-versioned JSON keeps it typed without migrations
for every new number). *Reversibility:* high — additive columns; dropping them loses only the new
data.

## Decision 2 — Upload reuses the take plumbing, under its own private prefix

Keys are `reference/<creatorId>/<ts>-<safe filename>` in the same storage adapter (private Blob in
production, `.storage/` locally). Local mode streams to a new `PUT /api/reference-upload` (same
pattern as `/api/upload`); blob mode uploads browser-direct to private Blob — `/api/blob-upload`
now also issues tokens for `reference/<creator>/<file>` (video/* only) — then the
`registerReferenceBlobUpload` action records it (idempotent per storage key). The key prefix can
never match a take's `raw/<item>/…` key, and nothing in the render/publish path reads
`ReferenceContent`.

UI (`/reference/add`, phone-first): pick a creator or "＋ Someone new…" (name), pick many videos
at once (iOS Photos/Files multi-select; `accept="video/*" multiple`), optional link per video,
two uploads in parallel with per-file progress, "Retry failed" re-sends only failures, works with
20+ files (each file is independent; the only per-batch step is one creator lookup). When the
batch is in, measuring starts automatically and its progress shows on the same screen.

## Decision 3 — Measurement is a new heavy-job kind, `reference-analyze`, with a library-wide lease

Runs through the existing dispatcher: in-process locally, in the Vercel Sandbox on the live site,
JobRun progress ("Measuring video 3 of 12 (IMG_1021.mp4)…") polled via `/api/jobs/[id]`.
Heavy-job leases were keyed by content item; reference analysis has none, so
`heavyJobSubject(kind, args)` (`apps/worker/src/heavy-job-kinds.ts`) returns the content item for
every existing kind (unchanged behaviour) and `"reference-library"` for this one — **one measuring
job for the whole library at a time**; a second tap follows the running job. The job re-reads the
queue until nothing new is waiting (videos uploaded while it runs are included), one failure never
stops the rest, and it stops starting new videos 8 min before the sandbox's hard timeout (the rest
stay PENDING; the page offers "Measure now"). Needs no model key (`heavyJobNeedsModel` false), so
a draining worker without the key may pick it up. `runHeavyJob` gained `background: true` for
inline mode (start in-process, return `started` with the JobRun id) so a 20-video job doesn't
block a local server action. `--offline` supports `reference-analyze` for snapshot verification.

**Operator: the Vercel Sandbox snapshot must be rebuilt** (scripts/sandbox/create-snapshot.ts
`--base <current>`) before this works on the live site — the current snapshot's runner doesn't
know the new kind and will fail it clearly ("unknown job kind"). Nothing new to download: it uses
ffmpeg + the Whisper model already in the snapshot.

## Decision 4 — Deterministic metrics, $0, no model calls

Per video (`apps/worker/src/reference-analysis-job.ts` → `packages/media/src/style-analysis.ts`
for measurement, `packages/domain/src/style-metrics.ts` for the math):

- **Video:** duration, display width/height (phone rotation honoured), aspect label, fps.
- **Cuts:** one ffmpeg pass decodes to 72×128 grey frames (and ffmpeg's scene score on a 240-px
  copy, each frame's own timestamp — VFR-safe). A cut = a one-frame **spike** in mean absolute
  luma change (≥ 4/255 and ≥ 2× the max of the 3 frames each side), or scene score ≥ 0.15, or
  change ≥ 30; candidates closer than 0.25 s keep the stronger. Why a spike detector: a talking-head
  jump cut barely moves ffmpeg's scene score (same background, same framing), but it is a sudden
  one-frame jump while continuous motion changes smoothly. The ±3-frame window was added after a
  grainy 360p encode "pulsed" every 3 frames (B-frames) and produced false cuts at ±2.
  From the cuts: count, times, shot length median/p25/p75, cuts per 10 s, first cut, pacing
  (cuts/10 s in the first 3 s, middle, last 3 s).
- **Speech** (the same local Whisper `base.en` word timings Chris's takes use): words per minute
  over the speech span, gaps between words (median, p90, longest), pauses ≥ 0.3 s per minute, the
  hook (first sentence by punctuation or a ≥ 0.7 s silence; a 1–2-word opener like "Okay." runs on
  into the next sentence; capped at 25 words) + its duration, when talking starts, the last
  sentence, seconds after the last word, whether it ends right on the last word (≤ 0.3 s), whether
  there's a cut after the last word (closing shot / end card). Transcript text stored (≤ 6000 chars).
- **Audio:** EBU R128 integrated loudness, loudness range, true peak (ebur128) and sample peak /
  peak count / flat factor (astats) → clipping flag (repeated or flat-topped full-scale peaks, or a
  decoded peak over 0 dBFS — an AAC encode of clipped audio rounds the flat tops off but overshoots;
  measured +0.98 dBFS on a deliberately clipped voice that astats' counters missed).
  **Voice vs background:** voice = energy mean of 20 ms frames inside words; background = the
  2nd-percentile 20 ms frame over the video (a music bed fills every dip between syllables;
  clean speech dips to near silence). "No background" when that floor is ≤ −55 dBFS or ≥ 36 dB
  under the voice. Displayed as "Music sits N dB under the voice", or "Faint background sound,
  N dB under" when ≥ 28 dB down.
- **Left out on purpose:** zoom / punch-in detection as its own metric — punch-ins are detected
  as cuts (34/34 and 23/23 in the studies below), but telling a punch-in from a jump cut, or
  measuring slow digital zooms, would need motion estimation I couldn't make reliable in the time;
  better absent than wrong. Music-vs-room-noise classification (both read as "background sound").

*Alternatives:* a vision/audio model (costs money per video and is less consistent than
arithmetic — CLAUDE.md: deterministic checks get deterministic code); ffmpeg scene score alone
(measured below — much worse on jump cuts); measuring background "between Whisper's words"
(tried first — Whisper's word edges are too loose: it read the voice's own tails as music, e.g.
"present, 26 dB under" on a clip with no music at all).

### Measured accuracy

**Cuts** — synthetic talking-head edits with known cut frames: the public-domain portrait fixture
(and, for the held-out set, a second portrait) animated with three motion styles (tripod sway,
head-bob, fast handheld) + sensor grain, x264 CRF 23, cut like a jump-cut edit removes pauses
(random 0.6–3.2 s segments, 0.3–1.8 s removed between them, 25 % punch-ins at 1.2×). Match
tolerance ±2 frames; matched cuts were frame-exact.

| Set | Cuts | Recall | Precision | Punch-ins found |
|---|---|---|---|---|
| Tuning set (seed 7, portrait A) | 74 | 89 % (66) | 100 % (0 false) | 34/34 |
| Held-out (seed 99, portrait B) | 82 | 85 % (70) | 100 % (0 false) | 23/23 |
| ffmpeg scene score ≥ 0.3 (baseline) | 74 | 51 % | 100 % | — |
| ffmpeg scene score ≥ 0.1 (baseline) | 74 | 81 % | 95 % | — |
| ffmpeg scene score ≥ 0.06 (baseline) | 74 | 92 % | 74 % | — |

By motion style: still/head-bob ≈ 93–100 % recall; **fast handheld ≈ 70 %** (a small jump is
smaller than the frame-to-frame motion itself). Misses are jump cuts where the position barely
changed — also near-invisible to a viewer. Effect: in very shaky footage "cuts every X s" can read
~15–30 % slower than reality; it never invents cuts on these sets. **Not verified on real
creator footage** (none was available) — real jump cuts also change expression/hands, which
should make them easier, but compression and on-screen text animations could add false cuts.
The first real uploads are the real test; `cuts.times` is stored so a spot check is easy.

**Background level** — `say` speech mixed with a synthetic chord+pink-noise bed at known levels:
true 25.8 / 31.8 / 37.8 dB under → measured 28.2 / 34.1 / none (≥ 36); tight speech (silences
removed) + bed 31.8 dB under → 31.5; clean speech → none; tight speech + faint room tone → none.
Bias ≈ +2 dB. Synthetic beds are steadier than real music; real-world error is likely larger.

**Loudness** — EBU Tech 3341 reference tone (1 kHz, −23 dBFS RMS stereo) reads −23 ± 0.5 LUFS
(unit test). **Speech** — Whisper `base.en` on `say` speech: word count / sentences right;
long pauses show up as gaps (a 600 ms inserted silence read as a 0.8 s gap). Gap values are
Whisper's estimate, consistent between references and Chris's takes (same model), which is what
the comparison needs.

## Decision 5 — Aggregation, sample size, plain English

Per creator and overall: the **median across videos** of each video's number (each video counts
once, however long). `confidence`: 0 → none, 1–2 → "early" ("From only 2 videos — an early read;
add a few more for a reliable picture", shown in gold), 3–7 → "fair", 8+ → "solid". Lines only for
numbers that were measured. `getReferenceStyleProfile(prisma, { referenceCreatorId? })` →
`StyleProfile` (typed medians with n/p25/p75, background share, example hooks) is exported from
`@chris/domain` for the edit planner later.

## Decision 6 — You vs them

`getOwnSpeechProfile` computes the same speech metrics from Chris's last 40 raw takes that
already have word timings (no new transcription, no cost) and `compareOwnToReference` says e.g.
"Your pauses are 69% longer than your references' — the edit can tighten them", "You talk 48%
slower", "Your opening line is 3.6× longer than theirs", "You start talking 1.1 s in". Only speech
is compared: raw takes are unedited, so cuts/loudness comparisons would be meaningless. Within
±20 % reads "about the same".

## Decision 7 — Copyright / privacy

Reference videos are other people's work, uploaded for **private analysis only**: stored in the
private store, never served publicly, never an input to a render, never published. "Delete file,
keep numbers" (`deleteReferenceVideoMedia`) removes the file from storage and keeps the
measurement (which still counts toward the style), the link and the audit trail
(`REFERENCE_VIDEO_MEDIA_DELETED`). Every upload / measurement / failure / deletion is audit-logged.
No scraping or downloading from links — Chris supplies the files; the link is just a note.

## Not verified / limits

- The cloud path (sandbox) was not exercised: the snapshot wasn't rebuilt (by instruction). The
  same `executeHeavyJob` code ran in-process locally (e2e) and in the worker test.
- Blob-mode upload (production) not exercised end to end; the local streaming route was.
- No real creator footage was available; accuracy figures are from synthetic clips.
- Whisper `base.en` is English-only.


## Reference upload: each batch keeps its creator; move + preview; no-face style group (2026-10-17)

**Problem:** the first live use filed all 17 of Chris's reference videos (5 creators) under the
last name he typed. The add screen chose ONE creator at upload time, while letting him change
the name and keep picking batches — so earlier batches silently followed the last name.

**Decision:** the creator is stamped on each clip at the moment it's picked (`creatorKey`), the
list is grouped by creator, and the upload prepares one creator per group. Each reference video
can be moved to another (or a new) creator (`moveReferenceVideo`, audited; the storage key
keeps its original prefix — it's only validated at registration and the file never moves).
Reference videos are now previewable (`/api/media` serves `ReferenceContent.mediaStorageKey`,
signed-in only, preview only). Creators can be marked "No-face motivational"
(`ReferenceCreator.formats` tag, no migration) so faceless/motivational references get their
own style card instead of skewing the talking-video target style.

**Reversibility:** high — UI + additive domain functions; no schema change.


## Cloud processing per job kind (2026-10-17)

Chris approved cloud (Vercel Sandbox) processing for **measuring reference videos only** —
video editing/rendering stays off until he has seen and approved its quality.
`RENDER_SANDBOX_KINDS` (comma list; unset or `*` = all kinds) gates which heavy-job kinds may
dispatch to the sandbox; anything else is refused with a plain message and nothing changes.
Production: `RENDER_SANDBOX_KINDS=reference-analyze`, snapshot
`snap_GeA378dem515lBwMM1c64y192O1r` (runner b1ee76956ae20fd7, includes `reference-analyze`).
Reversible by editing one env var.
