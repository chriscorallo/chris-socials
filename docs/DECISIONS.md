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
