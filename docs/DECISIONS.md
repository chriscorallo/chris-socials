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
`snap_TAcmkLfKwF08taalKvQoEwHjncvD` (… + graphics library + studio engine: cinema bundle, Kokoro, MiniLM); `RENDER_SANDBOX_KINDS=*` since Chris approved cloud editing for his quality test.
Reversible by editing one env var.


## Reference measuring v2 (2026-10-17)

The first real run (17 reference videos on production: Shelby Sapp, Alex Hormozi, Jun Yuh,
Humphrey Yang = talking; Mindset.Therapy = no-face, music + on-screen text) showed two problems:

1. **Instagram's download end card** (≈2–4 s appended: the last frame frozen and dimmed, a
   centred Instagram logo + "@username") was measured as part of the creator's edit. It inflated
   "Ends 4.4 s after the last word", the length, last-3-s pacing, and the audio floor (a silent
   tail drags the "background" floor toward silence). All 17 production videos have it (checked
   on their last frames). TikTok downloads have a similar card (cut to black, animated logo).
2. **No-talking videos were read as talking**: "Starts talking at 19 s" on ~11 s videos, "Hook
   lasts 0.0 s", "No background music — just the voice" on music-led videos. Whisper invents words
   over music; their timestamps can land past the end (then the hook has zero length).

## Decision 1 — Detect the app end card deterministically and measure only up to it

`detectEndCard` (`packages/media/src/style-analysis.ts`) on the last 7 s decoded to 180×320 grey
(`measureTailFrames`, one extra ffmpeg pass with `-sseof`). All four must hold:

1. **Still run at the very end**: walking back from the last frame, consecutive frames whose
   *background* (frame minus the centre box where the logo animates) is the previous frame up to a
   brightness change — least-squares fit `b ≈ α + β·a`, mean |residual| ≤ 1.5/255, 0.6 ≤ β ≤ 1.15.
   A frozen frame fading darker passes; real footage (motion, grain) doesn't. Up to two isolated
   one-frame "refresh" glitches are tolerated (low-bitrate encodes do that on stills). When the
   light drops inside the run (a fade), the card starts where the final drop begins (dark, slow
   motion graphics can read as "still" for a while before the card).
2. **Position + length**: 1–6 s, and it doesn't start before the last spoken word (+0.5 s for
   Whisper's loose word ends; one or two stray words ≥ 1 s after the rest are ignored —
   `lastSpokenWordEnd`).
3. **Darker**: the background's light above video black is ≤ 75 % of the second before it.
   Content that is itself (nearly) black can't be seen to darken → not a card.
4. **Centred logo/handle**: bright pixels (≥ max(150, p90+60, p99.8+15) of the background) in
   the centre box, horizontally centred, 0.2–25 % of the box, almost none outside.

When found, the analyzed video ends at the card start: `durationS` = card start,
`sourceDurationS` = file length, `endCardS` = card length; cuts at/after it dropped; speech, the
ending, pacing, loudness (`ebur128` with `-t`) and voice/background (PCM truncated) all measured on
`[0, cardStart]`; a note says it was left out. The tail decode failing never fails a measurement
(the card check is skipped).

**What it deliberately keeps:** a creator's own closing shot at normal brightness (fails 3), a
fade to black with nothing on it (fails 4), a still held longer than 6 s (fails 2), any still
during which they're still talking (fails 2). **What it would also strip:** a creator's *own*
outro that looks exactly like a platform card (dimmed freeze + centred white handle) — acceptable,
it's equally not part of the edit's pacing.

### Measured accuracy (synthetic, `scratchpad` generator; 540×960, x264)

| Clip | Expected | Result |
|---|---|---|
| IG static (dim 0.45, logo + handle, 3 s) | card @7.33 | 7.333 ✓ |
| IG fade-in 0.5 s, logo at 0.4 s | card @7.33 | 7.333 ✓ |
| TikTok-like (cut to black, animated logo, 2.6 s) | card @7.57 | 7.567 ✓ |
| Dark motion graphics + music + IG fade (Mindset-like) | card @11.0 | 10.967 ✓ |
| IG short 1.8 s / long 4.6 s (dim 0.55) | card | ✓ / ✓ (±1 frame) |
| IG over a dark talking clip | card | ✓ |
| IG low-bitrate (360p, CRF 36) | card | ✓ (needed the glitch tolerance) |
| IG lighter dim (0.6) | card | ✓ (needed the p99.8 threshold) |
| Normal-brightness held last frame + centred text | keep | kept ✓ |
| Bright title card ("SAVE THIS") | keep | kept ✓ |
| Creator fade to black (moving) | keep | kept ✓ |
| Fade to black + 2 s black hold, nothing on it | keep | kept ✓ |
| Normal held frame + centred "@MYHANDLE" | keep | kept ✓ |
| No tail / plain dark music video / plain held frame | keep | kept ✓ |

17/17 (9 cards found to within one frame, 8 endings kept). The **logo test alone** was also run
on the 17 real production end frames (full-res stills saved earlier): 17/17 pass, 0 bright pixels
outside the centre box. The real cards' background light is 1.6–21/255 above black (strongly
dimmed — well inside rule 3). Unit tests: `packages/media/src/__tests__/end-card.test.ts`
(IG static + fade, TikTok, held closing / fade-black / plain kept, "talking continues" rejected,
pure fit + overlay), and an end-to-end worker test.

**Not verified on the real videos**: whether Instagram's card background is truly frozen (if it
were animated outside the centre, rule 1 fails → the card stays in, i.e. today's behaviour), and
whether very dark creators (Mindset.Therapy, 1.6–1.9 light on the card) have enough light before
the card to show the darkening (needs ≥ 1/255 mean above black; estimated ~3–5). The first
"Update measurements" run on production is the real test: the per-video Details row "App end card
3.0 s — left out" makes a spot check easy.

## Decision 2 — Speech only when someone is actually talking

`classifySpeech` (`packages/domain/src/style-metrics.ts`, pure): words outside the video and
non-speech tags ("[Music]", "(upbeat music)", "♪", punctuation) are dropped; then **not talking**
when: < 4 words; ≥ 50 % zero-length words (invented timings); one word ≥ 40 % of 6+ words (a
loop); median word ≥ 0.6 s (singing / stretched); words cover < 20 % of the video; or the
acoustic check says the words aren't ≥ 3 dB louder than the sound ≥ 0.15 s away from any word
(`measureAudioActivity`, 20 ms frames — a voice stands out from its gaps; words invented over
music sit on the same sound). Measured contrast with real Whisper on `say` speech: clean 9–16 dB,
over a music bed 12 dB under 7.7 dB, 6 dB under 7.2 dB → 3 dB leaves margin. Synthetic music
(chords, noise, a sine melody) produced **no** words from Whisper `base.en`, so the hallucination
rules are covered by unit tests with the production pattern (words at 19–21 s on an 11 s video,
zero length) rather than real hallucinations.

Not talking → `speech: null` (no WPM, hook, "starts talking", ending), `transcript: null`
(invented words aren't a transcript), `voice.present: false` + the reason, and
`audio.mix = "music-led"` when ≥ 50 % of 20 ms frames have sound (≥ −45 dBFS) and the integrated
loudness is above −40 LUFS, else `"quiet"`. Talking videos get `"voice"` / `"voice-over-music"`.
On-screen text pace was **left out** (no cheap, reliable deterministic measure).

Guards everywhere: `speechMetrics` drops words that start after the end and won't report a
zero-length hook; `sanitizeReferenceMetrics` (applied on every parse and in aggregation) drops
speech that starts after the video ends / ends > 1 s after it, zero hooks, impossible tails and
first cuts — so **old v1 rows stop showing nonsense immediately**, before re-measuring.

## Decision 3 — Aggregation skips n/a; plain English follows the soundtrack

Medians already skipped nulls; now n/a really is null (above). Additive `StyleProfile` fields:
`talking`, `musicLed`, `endCardsRemoved`. `backgroundPresent`/`backgroundUnderVoiceDb` now count
**talking videos only** (background "under the voice" means nothing without a voice). Cards: a
music-led group says "Music-led — no talking" (no "No background music — just the voice", no
speech lines); "Videos run about N s" adds "Not counting the app's end card…". No existing
`StyleProfile` field was renamed or removed (the edit planner's "style cut" reads it).

## Decision 4 — Version 2 + "Update measurements (improved accuracy)"

`REFERENCE_METRICS_VERSION = 2`; the schema accepts version 1 or 2 (new fields optional), so old
rows stay readable. `metricsVersion` now records the version the numbers were actually measured
with (not the constant). `countOutdatedReferenceVideos` + `requeueReferenceVideos({ outdated })`
(DONE, older version, file still present; audited with `toVersion`); `startReferenceMeasuring`
`{ updateOutdated }`; the existing Measure control on /reference and a creator page shows
"N videos were measured before the latest improvements…" + **Update measurements (improved
accuracy)**, reusing the same heavy job. While waiting, a video keeps its old numbers (shown, and
still counted in the style — `getReferenceStyleProfile` now counts any row with numbers, not only
DONE, so updating never blanks the style; a failed re-measure also keeps its last numbers).

**Operator:** the `reference-analyze` runner changed (new tail decode, classification, v2
schema) → **the Vercel Sandbox snapshot must be rebuilt** before production re-measures with v2.
Until then the old runner writes v1 numbers, which are stored as version 1 and keep showing as
"measured before the latest improvements". No new binaries/models.

**Reversibility:** high — additive schema fields, no migration; reverting the code leaves v2 rows
that the v1 schema would reject (they'd be skipped by the aggregate until re-measured).

## Not verified

- Real Instagram/TikTok downloads (only their last frames); real music with Whisper
  hallucinations; real sung lyrics (treated as not-talking only if drawn-out ≥ 0.6 s median).
- The sandbox path (snapshot not rebuilt, by instruction). Locally: in-process job, unit + worker
  tests, and a visual check of /reference + creator pages at 393×852 on a throwaway DB.


## Style cut (2026-10-17)

Chris wants an uploaded talking-head take to come back feeling like Shelby Sapp / Alex Hormozi /
Jun Yuh / Humphrey Yang — and to judge that quality himself before anything else is switched on.
Before this, the no-AI starter edit was the whole longest take + captions + loudness: no cuts,
no pacing. The reference style profile (`getReferenceStyleProfile`, 2026-10-17) was measured but
unused.

## Decision 1 — A pure, deterministic cut; no model calls ($0)

`buildStyleCut` (`packages/media/src/style-cut.ts`, browser-safe, pure) turns a take's word
timings + measured silences + face track + a target into an EditTimeline v2:

1. **Dead air:** start 0.12 s before the first speech, end 0.3 s after the last (tight ending —
   the references' "4.4 s after the last word" is Instagram's end card and is ignored).
2. **Pauses:** a silence longer than the target is shortened to the target — `pauseKeepS`
   mid-sentence (references' gap p90, clamped 0.12–0.30 s) and a longer `sentencePauseKeepS` after
   punctuation (half the references' longest gap, clamped 0.22–0.50 s), split ~60/40 into a pad
   after the speech and a pad before the next (≥ 80 / 60 ms). Removing < 0.12 s isn't worth a
   jump cut; a short pause that would make a shot shorter than max(0.8 s, p25/2) (first shot:
   0.6 × the first-cut target) is kept, unless the silence is ≥ 0.75 s.
3. **Rhythm:** every removed pause is a cut. A shot longer than the references' p75 is split
   at the best boundary near the median (kept pauses > Whisper word boundaries; sentence end
   > comma); the first shot aims at the references' first-cut time (they open on a longer shot,
   then speed up). If no safe boundary exists the shot stays long — never a mid-word cut.
4. **Framing:** a cut on one camera = a framing change: WIDE 1.0 / MEDIUM 1.12 / TIGHT 1.2,
   WIDE alternating with the punch-ins (never the same twice in a row). Punch-ins are centred on
   the FACE (derived from the tracked protected-head box — they may crop hair/ear margins like any
   editor's punch-in, never the face) as far as the crop allows, keeping the face's height in the
   frame; a punch-in that would push the face off-frame or the chin into the caption band steps
   down a zoom. No track → an assumed centred talking head.
5. **Captions** on (the base timeline's style); they are derived from the clips by the shared
   `timelineCaptionWords`, so removed pauses never desync them. **Audio:** normalize on (the
   renderer masters at −14 LUFS = the references' median); music untouched (none selected).
6. Every clip is a whole number of 1/30 s frames (no A/V slip between contiguous clips).
7. Returns the timeline + per-shot list + stats + a plain-English summary ("Removed 14 pauses
   (7.9 s) · 15 cuts, one every 2.2 s · starts on your first word · ends 0.3 s after your last")
   + where the pacing came from ("Paced like your 15 reference videos (4 creators).") + an
   `inputsKey` (hash of every input — same key, same cut).

Targets: `styleCutTargetFromProfile(getReferenceStyleProfile(prisma, { group: "MAIN" }))`.
Fewer than 3 analysed videos (or a number measured on fewer than 3) → built-in defaults close to
the first live measurement (shot 2.4 s, p25–p75 1.9–3.6 s, first cut 3.2 s); everything clamped so
a broken measurement can't produce absurd shots. Multiple takes: still the starter edit's rule
(longest take) — stitching retakes is a judgment call, left out on purpose.

*Alternatives:* an LLM edit plan (costs money, non-deterministic, and this is arithmetic —
CLAUDE.md); a smooth zoom instead of punch-ins (references cut; slow zooms weren't measured);
cutting on every Whisper gap (see Decision 2).

## Decision 2 — Pauses come from the AUDIO, not from Whisper's word edges

Measured on the test take (`say` speech with known silences): Whisper `base.en` word ends run
~0.15–0.2 s early ("version." ended 0.21 s before the voice did), and a word after a long pause
often "starts" inside the pause ("put" 0.4 s early; "Second," spanned the whole 1.5 s silence).
Cutting on those edges with 60–80 ms pads would clip the ends of sentences. So
`packages/media/src/speech-activity.ts` measures silences from the audio (20 ms RMS frames,
threshold 30 % of the way from the room-noise floor (p5) to the speech level (p90), ≥ 6 dB over
the floor, ≥ 0.1 s) and `speechMap` assigns Whisper words to the sound "islands" between them, in
order, by overlap — the audio says WHERE it's quiet, Whisper says which pauses end sentences.
Wordless islands < 0.3 s (breaths, clicks) count as silence; longer ones are kept (could be words
Whisper missed). Without measured silences (`STYLE_CUT` WHISPER mode) the pads widen to 0.22 s /
0.10 s. The silences are cached on the plan (`plan.styleCut.silences`) so a re-apply doesn't
re-decode the take.

Caption timing still comes from Whisper (unchanged): on the test render captions lead the voice
by ~0.15 s. A Whisper word stretched across a removed pause could survive on both sides of the
splice; `timelineCaptionWords` now shows such a word once, on the side where more of it is (only
for a FORWARD splice of the same take — a duplicated clip keeps its own captions).

## Decision 3 — Whisper long-take bug fixed (chunk 30 s → 25 s)

`LocalWhisperTranscriptionProvider` used `chunk_length_s: 30` (= Whisper's own window). On a
46 s take, transformers.js returned 31 of 118 words: the first sentence all stamped 29.96 s, the
rest of the first 30 s missing. 25/5 and 20/4 returned all 118 with sane times; now 25/5
(`WHISPER_CHUNK_SECONDS`). **This affected every take and every reference video longer than 30 s**
(references are ~66 s), so reference speech metrics measured before this fix (wpm, gaps, hook)
are suspect — re-measuring the reference library is recommended (the measuring code wasn't
touched; another agent owns it).

## Decision 4 — Wiring: automatic only on an untouched starter edit; Chris's buttons are versions

- **Automatic** (`maybeAutoStyleCut`, apps/worker/src/style-cut-job.ts): after the upload's
  `ingest` job transcribes / face-tracks a take, after a `transcribe` job, and right after
  `createStarterEdit` (upload screen, "Edit video", plan board). It writes ONLY when the item is
  EDIT_PLANNED and its latest plan is the original starter edit (origin STARTER_EDIT, no
  timeline, no revision reason) or an earlier automatic style cut whose inputs changed (e.g. the
  face track arrived). Written by `recordAutoStyleCut` (packages/domain style-cut-plan.ts): a new
  EditPlan row (`revisionReason` "Style cut (automatic, no AI)", `plan.timeline` +
  `plan.styleCut`), audit `EDIT_PLAN_REPLANNED` by SYSTEM, compare-and-swap on the latest plan id
  under a per-item advisory lock — two triggers racing can't both write; same `inputsKey` → no
  row. No state transition (EDIT_PLANNED → EDIT_PLANNED re-plan, same as `recordReplannedEditPlan`).
  Never throws; a failure leaves the plain starter edit. Kill switch: `STYLE_CUT_AUTO=off`.
- **Chris** (editor → "Style cut" tool on the phone toolbar / "Style cut" tab on desktop): shows
  the summary line, "Redo the style cut" and "Use my full take instead". Each is a finishing edit
  through `saveFinishingEdit` (new `planExtras` param, additive) — a new version, normal rollback
  rules, Undo in the editor brings the previous doc back. Chris's rows are never touched by the
  automation. Without captions: "Style cut needs captions first…".
- On the live site, the web-side trigger doesn't download the take to measure silences (a big
  iPhone file in a function); it cuts on word timings with wide pads and the cloud `ingest` job
  refreshes it with measured silences. (Editing is currently off in the cloud anyway —
  `RENDER_SANDBOX_KINDS=reference-analyze`.)

*Alternatives:* make `createStarterEdit` itself produce the style cut (domain can't import
media; and the starter row is the honest "plain take" version to go back to); overwrite the
starter row (forbidden — append-only).

## Decision 5 — Renderer: de-click fades at splices

`clipAudioFades` adds an 8 ms fade-out/in where the audio jumps (a removed pause, or another
take); contiguous clips (framing-only cuts) play straight through. Measured on the test render:
largest sample step within ±2 ms of every splice ≤ 0.0015 (speech peaks reach 0.72), splices
sit at the room-noise level (≈ −60 dBFS around them). The browser preview has no fades
(unchanged).

## Reversibility

High. No migration. `STYLE_CUT_AUTO=off` stops the automatic cut; existing style-cut versions
are ordinary finishing edits (Chris can go back to the full take in one tap, or pick any earlier
version). The Whisper chunk change is one constant.

## Verified / not verified

- Unit tests: `packages/media/src/__tests__/style-cut.test.ts` (gap math, never mid-word, audio vs
  Whisper mode, breath handling, sentence beats, cadence in p25–p75, framing alternation/face
  safety, caption remap, idempotency, no transcript, few-reference fallback, silence detection,
  de-click fades); `apps/worker/src/__tests__/style-cut-job.test.ts` (auto apply → idempotent →
  refresh on face track → hands off Chris's edit → plain/re-apply versions).
- Real end-to-end render of a 46 s `say` take (real Whisper, real face tracker, real silences) —
  numbers in the final report / below.
- Not verified: real iPhone footage of Chris (none available); the cloud sandbox path (snapshot
  not rebuilt — the runner code changed, see below); Blob-mode storage.
- **Snapshot:** apps/worker changed (ingest/transcribe now call the style cut) — the Vercel
  Sandbox snapshot must be rebuilt before the cloud ingest job does this.


## Teleprompter (2026-10-17)

Chris asked for a teleprompter so he can read his framework/script while filming — either
recording inside the app (like BIGVU) or keeping the full iPhone Camera app (Cinematic mode,
stabilization, HDR) with the script floating over it. To be merged into `/docs/DECISIONS.md`
by the integrator.

## The Apple constraint

A web app (Safari / home-screen PWA) cannot draw over, or control, the native Camera app.
The only thing iOS lets a web page keep on screen above other apps is a **Picture-in-Picture
video window**. So "script over the real Camera" can only be a PiP video whose frames are the
script.

## Decision — two modes, one entry point

Entry: **"Film with teleprompter"** — on a video's page while it isn't filmed yet, a camera
icon on every not-filmed row of the plan board and filming checklist, a button + per-video
icon on `/film`, and standalone at `/film/teleprompter` ("What are you filming?" → planned
videos not filmed yet, or "New video").

**Script source** (read-only, deterministic, no AI): latest `ScriptVersion` → Creator Card
(hook + talking points + notes) → the imported plan's hook + notes (`ContentItem.description`,
`Hook: …\n\nnotes`) → a paste box. Inline edits are for filming only: kept on that phone in
localStorage per video, tied to a fingerprint of the source so a newer script version wins.
Script versions are never overwritten (CLAUDE.md). The Creator Card step was added between
script and plan because it is literally "only what Chris needs to film" (spec §9 step 8).

**Mode 1 — Record here.** `getUserMedia` (front by default, flip to back), ideal 1920×1080 @
30 fps (4K / 60 fps offered only when `getCapabilities()` says the camera can), the ACTUAL
settings shown as "1080p · 30fps". Voice processing (echo cancel / noise suppression / auto
gain) OFF by default for a natural voice; "Voice cleanup" toggle turns it on. Script scrolls at
the TOP of the screen (reading line ~14% down the top 46%), i.e. under the front lens. Text
size, speed (1–10 = 90–225 words/min; pace is word-based so it doesn't change with text size),
tap to pause, drag to scrub, mirror-text toggle (teleprompter glass), 3-2-1 countdown,
"scroll only while recording" (default on). Preview is mirrored with CSS only; the recorded
track is not mirrored. `MediaRecorder` with MP4/H.264+AAC preferred (iPhone Safari), WebM
fallback, 10 Mbps at 1080p30 (15 at 60 fps, 35 at 4K), 192 kbps audio, 1 s timeslices so an
interruption (app switch, call, camera grabbed → track `ended`/`mute`, `visibilitychange`)
finalizes the take with everything recorded so far. Wake Lock while open (re-acquired on
return). Review: **Use this take** / **Retake** / **Keep & film another** (multiple takes per
session; only File/Blob references kept, object URLs revoked).

**Hand-off uses the existing plumbing only:** `preparePlannedUpload` →
`advancePlannedItemToFilmed` (honest SYSTEM steps to FILMED; no-op if already filmed) or, for a
new video, `createFootageItem` → `createContentItemFromFootage`; then `uploadRawTake` (Blob in
production, local streaming route in dev) with 3 attempts per take (2 s / 6 s back-off;
permanent errors like 413/415 are not retried); a partial failure keeps what landed and retries
only the failed takes into the same video; "Save a copy to this phone" is offered so a take is
never lost. Then the single-upload ending — extracted from `FootageUpload` into
`app/upload/OpenEditor.tsx` (`useOpenEditor` + `FinishingCard`) and shared — waits for captions
(capped, skippable), makes the starter edit + automatic style cut, opens the editor.

**Mode 2 — Use iPhone Camera (floating script).** The script is drawn on a 1280×720 canvas
(big bold white text, gold reading marker, "Starts in 10 — open Camera and hit record"
countdown), streamed into a muted inline `<video>` via `canvas.captureStream(30)`, and floated
with `requestPictureInPicture()` (fallback `webkitSetPresentationMode("picture-in-picture")`).
PiP play/pause → `pause`/`play` events → scrolling pauses/resumes. The draw loop is a 30 fps
timer, not `requestAnimationFrame` (rAF stops in the background). If the window doesn't open
(rejection, or no response within 3.5 s) the screen says so and offers **"Make a script video"**:
the scroll (with the countdown baked in) is recorded once into an ordinary MP4/WebM blob, which
floats natively — its PiP controls and scrolling no longer depend on the page running at all.
If PiP or `captureStream` is missing entirely, the screen says plainly it can't float here and
points to "Record here". "Upload my clip" on the same screen runs the same hand-off; "Upload
many clips" goes to `/plan/upload`.

Voice-follow scrolling (`webkitSpeechRecognition`) was **skipped**: on iPhone it competes with
the recorder for the audio session and in Camera mode the page is in the background; it could
not degrade gracefully enough to be worth the risk.

No schema change, no AI, no cloud jobs, $0 runtime cost.

## Alternatives considered

- **Native iOS app** (AVFoundation camera + overlay, or a Camera-app-adjacent widget): the only
  way to get true overlay control and native-quality capture, but App Store distribution,
  signing, a second codebase and review — far more friction than value at this stage. Still
  the upgrade path if PiP proves unreliable on Chris's phone.
- **Only in-app recording**: loses Cinematic mode / stabilization / HDR, which Chris asked to
  keep.
- **Only PiP**: depends on iOS behavior we can't verify here; Mode 1 is the dependable path.
- **Pre-render only (no live stream)**: robust, but costs the script's duration in waiting
  every time and can't change speed live. Kept as the fallback instead.
- **Persisting prompter edits as a new ScriptVersion**: would turn a filming tweak into a
  script revision (and an unchecked one for the claims gate); local-only is simpler and safe.

## Rationale

Final Test: one tap from where filming happens, plain language, no setup; quality preserved
(camera original at a high bitrate, or the real Camera app); nothing new to maintain
server-side; the take lands exactly like any other upload, so captions → style cut → editor are
unchanged.

## Reversibility

Fully reversible: delete `apps/web/app/film/teleprompter/`, `apps/web/lib/teleprompter/`,
`apps/web/app/components/TeleprompterLink.tsx` and the link insertions (video page, plan board,
filming checklist, `/film`). `OpenEditor.tsx` is a behavior-neutral extraction from
`FootageUpload`. No data written except normal takes; localStorage keys `tp:settings:v1`,
`tp:edit:<id>`.

## Verified / not verified

- Unit + DB tests: `apps/web/lib/teleprompter/teleprompter.test.ts`,
  `teleprompter-db.test.ts` (source selection, scroll math, wrap, mime/bitrate, settings,
  hand-off order/retry/permanent errors/partial failure, SELECTED → FILMED walk, footage-first
  new video, picker list).
- Playwright Chromium (fake camera) at 393×852: plan → teleprompter → record (countdown,
  scrolling, timer) → review → Use this take → raw take `video/mp4` H.264 + audio registered,
  item walked SELECTED → … → FILMED → MEDIA_INGESTED, starter edit made, editor opened. Float
  mode entered real PiP in Chromium. No horizontal overflow on any screen.
- Playwright WebKit (macOS engine, headless, no camera, no PiP in that build): feature
  detection, the "didn't open" message + fallback, and **"Make a script video" produced a
  15 s 1280×720 `video/mp4`** with WebKit's MediaRecorder; camera-denied path shows the plain
  message.
- **Not verified (needs a real iPhone):** PiP for a canvas stream on iOS; whether the live
  stream keeps scrolling while Safari is backgrounded; PiP from the home-screen PWA; recording
  orientation/rotation metadata and real resolution/fps; Camera recording while the PiP plays;
  Wake Lock in standalone mode.


## Viewer Panel (2026-10-17)

Chris asked for "the bot that oversees it" to watch each video as a new viewer would and say
what they'd be thinking (confused, entertained, educated, bored, irritated…), especially for
acquiring new viewers and followers. He also wants it to judge cuts against the speaker's
cadence and the story ("never a cut for the sake of a cut"), picture vs words, audio vs
picture, music over the voice, uneven levels, and what makes a video rewatchable, savable,
shareable. Long-term taste/performance learning is **out of scope here**.

---

## Decision 1 — A new agent (VIEWER_PANEL), not an extension of Visual QA

`prompts/agents/VIEWER_PANEL.md` (model_class HIGH, output_schema `ViewerReview`),
`packages/agents/src/viewer-panel.ts` + `viewer-panel-schema.ts`, registered in
`docs/AGENT_CONTRACTS.md`. Authority level 3, **advisory only**: it writes its own
`ViewerReview` rows; nothing in `aggregateHardGates` / `recordQualityGateResult` reads them, so a
hard-gate BLOCK can never be averaged away by a "great" viewer verdict (the aggregation's type
signature is untouched). It doesn't move the video's state either.

*Alternatives:* extend Visual QA (rejected: Visual QA is a defect finder feeding the TECHNICAL
gate; a viewer's subjective boredom must not become a gate input, and its 6 frames can't see a
whole video's rhythm); extend the Adversarial Evaluator (text-only, artifact-agnostic critic —
no time axis, no audience simulation); Audience Intelligence (reads real comments — the
complement of this, after posting); Creative Director (weekly strategy, not one video).

**Provenance in the type, not just the prompt:** every judgment (hook, beat, drop-off, craft
check, story jump, verdict, fix, strength) carries `evidence: [{t, kind: SEEN|SAID|HEARD|MEASURED,
detail}]` with at least one item. Engagement numbers are `{kind: "ESTIMATE", score 0–100,
uncertainty, rationale, evidenceTimes (≥1)}` — there is no field a view-count forecast could go
in (unknown fields are dropped). `checkViewerReview` (deterministic) clamps times into the video,
drops judgments whose evidence lies entirely outside it, sorts beats, orders fixes, and flags
certainty language ("will go viral", "guaranteed", "will get 1M views") as a warning shown under
"What it couldn't judge".

## Decision 2 — Frames + measured facts, not native video input

The input is built deterministically in the heavy-job worker (`apps/worker/src/viewer-review-job.ts`):

- **Frames** (`planViewerFrames`, pure): first + last frame, the opening every 0.5 s to 3 s,
  **both sides of every cut** (±0.1 s, labelled "just before/after a cut"), text/graphic/zoom
  starts, ~1 fps elsewhere; collisions within 0.12 s merge (a cut label wins over "opening").
  Capped at 80 (the API takes ≤ 100 images); over the cap, background samples go first, then
  graphic frames, then cut pairs — each time the one with the closest neighbour — the opening
  and first/last are never dropped. Extracted as JPEG with the long edge 640 px
  (`extractScaledFrames`, packages/media): 360×640 ≈ **308 image tokens** each vs ≈ 2 765 for a
  full-HD PNG, captions still legible. Each image block is preceded by its label
  (`t=3.10s — just after a cut`) through the existing `ModelImageInput.label` path of the
  Anthropic provider (base64 image blocks were already supported — no provider change needed;
  a new test pins the request shape).
- **Words**: Chris's render → the edit's own output-timed words (`timelineCaptionWords`); a
  legacy plan or a reference video → local Whisper on the file. Shown as short timed lines.
- **Edit facts** (exact, from the EditPlan timeline): every cut and its kind
  (PAUSE_REMOVED with seconds removed / FRAMING-only punch-in/out with zoom from→to / TAKE),
  zooms, captions on/off + style, texts, graphics (template, time, anchor phrase), music bed
  level + ducking, SFX count. Reference videos: the measured cut times (`metrics.cuts.times`,
  end card excluded) or fresh detection.
- **Sound** (measured): integrated loudness, true peak, clipping (`measureStyleLoudness`);
  voice vs background (`measureVoiceBackground`); per-second level, ≥ 6 dB jumps while talking,
  and ≥ 6 dB level changes across a cut with speech on both sides (`measureViewerAudio`, new, pure).
- **Pacing reference**: the MAIN reference style medians (`getReferenceStyleProfile`) —
  "a pacing reference, not a rule".
- **Brand context** only for Chris's own videos, labelled as "to keep FIXES in his voice — the
  viewer doesn't know any of this"; never for reference videos.

*Alternatives:* native video input (not available through this provider abstraction / the
Messages API takes images, not video files; and we'd lose the exact cut/audio facts); a
contact-sheet grid of frames (same tokens per pixel, worse per-frame timestamps); sending audio
(not supported as an input here — measured numbers are more consistent anyway, CLAUDE.md:
deterministic checks get deterministic code).

## Decision 3 — Model class HIGH (Opus 5.5, effort high)

Watching a whole video and simulating a viewer's moment-to-moment reaction while tying every
claim to evidence is the most semantic, vision-heavy judgment in the system, and it runs once
per video on demand, not in a loop. *Alternative:* MEDIUM (Sonnet 5.5, ~half the price) —
reversible with `MODEL_HIGH` or by flipping `model_class` in the prompt frontmatter if Chris finds
Sonnet's read good enough once there's credit to compare.

## Decision 4 — Cost per video (estimated BEFORE the call, shown on the button)

`estimateViewerReviewCost` (pure, the same frame plan the job builds):

- image tokens = frames × ⌈360×640/750⌉ = frames × 308
- text tokens = 3 200 (SYSTEM_BASE + VIEWER_PANEL + task) + facts (1 200 + 1.7 × words, or the
  real facts length ÷ 3.6 in the job) + 12 per frame label (+ brand context ÷ 3.6 for Chris's videos)
- output = 12 000 planning tokens (≈ 5–6 k of JSON + adaptive thinking at effort high); the
  button also shows the 1.6× high end.
- Opus 5.5: $4 / MTok in, $20 / MTok out.

| Video | Frames | Input tokens | Cost (12 k out) | High end (19.2 k out) |
|---|---|---|---|---|
| 20 s, 2 cuts, 1 graphic (test) | ≈ 30 | 30×308 + ~4.9 k ≈ 14.2 k | 0.057 + 0.240 ≈ **$0.30** | ≈ $0.44 |
| 45 s, 15 cuts, brand context | ≈ 75 | 75×308 + ~6.5 k ≈ 29.6 k | 0.118 + 0.240 ≈ **$0.36** | ≈ $0.50 |
| 60 s, 30 cuts (cap 80) | 80 | 80×308 + ~7.2 k ≈ 31.8 k | 0.127 + 0.240 ≈ **$0.37** | ≈ $0.51 |

Output dominates; ≈ $0.30–0.40 per video, ≈ $0.50 worst case. Guards: the existing
`CostTrackingModelProvider` (ModelCallLog + daily cap, fails closed) wraps the call, and a new
per-review ceiling `VIEWER_REVIEW_MAX_USD` (default $2) refuses before anything is sent when the
estimate's high end exceeds it. The actual cost is stored on the row (`costUsd`) next to the
estimate. **Not measured against a real call** (no credit) — the output figure is the biggest
uncertainty; the first real run's ModelCallLog row is the check.

## Decision 5 — A heavy-job kind, `viewer-review`, and a versioned table

Wired like the others (`HEAVY_JOB_KINDS`, `parseHeavyJobArgs` — exactly one of
`contentItemId` / `referenceContentId`, optional platform TIKTOK|INSTAGRAM|YOUTUBE and persona
COLD|FOLLOWER), lease subject = the video, or `reference-video:<id>` for a reference video;
`heavyJobNeedsModel` → true for both, so the dispatcher passes `ANTHROPIC_API_KEY` to the
sandbox (test). Progress lines: "Getting the finished video…", "Listening to the sound…",
"Picking the moments to watch (12 of 28)…", "Watching it like a new viewer…". Expected refusals
(no render, file deleted, estimate over the ceiling) and AI failures (spend cap, credit, key)
come back as `{ok:false, error, result:{errorName}}` — the page words them plainly.

Migration `20261017220000_viewer_reviews` adds `ViewerReview` (additive; see DATA_MODEL.md):
append-only, tied to `renderId` + `editPlanId` (or `referenceContentId`), the exact
`mediaStorageKey`, prompt id/version, model, review JSON, warnings, input summary (frame times +
reasons, word/cut counts and sources, the estimate), verdict tier, estimated + actual cost,
tokens, JobRun id; audit `VIEWER_REVIEW_RECORDED`. Failed runs stay on their JobRun only.

## Decision 6 — Where Chris sees it

- **Video page**, when a successful render exists: a "Viewer check" card (additive — one data
  load + one JSX line in `content/[id]/page.tsx`). Feed choice (TikTok / Reels / Shorts, default
  = the first scheduled platform, else Reels) and one button **"Watch it like a new viewer
  (≈ $0.30)"** with the high end and frame count underneath → live progress → verdict tier +
  headline + biggest reason, a player, the **attention/feeling strip** (one bar per beat: height
  = attention, colour = with you / learning / drifting / losing them; tap → the player jumps
  there and the beat's inner voice + evidence show), where they'd swipe away (red ticks + list),
  top fixes with tappable times. "Everything the viewer noticed" folds away story, craft
  problems, what works, likely reactions (labelled estimates, with uncertainty), limitations and
  cost. A review of an older render says so. The floating heavy-job banner ignores this kind
  (the card shows its own progress).
- **Reference creator page → a video's Details**: "What a viewer thinks", same card/agent; the
  prompt asks it to explain *why* the video works (which cuts serve the story vs only remove
  pauses) as transferable principles, never identity.
- AI off / out of credit / daily limit reached: a plain sentence + **More → AI credit**
  (`/settings/ai`); a job that fails for those reasons says so with the same link. Nothing
  crashes.
- The editor's Finish flow was **not** changed (another agent is editing nearby; the video page
  is one tap away after Finish).

## Reversibility

High. Additive table + code paths; no existing behaviour changes. Remove the card line(s) to
hide it; nothing else reads the rows. Model class / effort / frame cap / ceiling are constants
or env (`MODEL_HIGH`, `VIEWER_REVIEW_MAX_USD`).

## Verified / not verified

- **Tests** (MockModelProvider, recorded-shape fixture `packages/agents/src/viewer-panel-sample.ts`):
  schema rejects missing evidence / unlabeled estimates / predictions; post-check; frame
  planner (hook, cut pairs, events, cap, thinning); cost math; one HIGH call with labelled JPEG
  frames; the Anthropic provider's exact request shape (fake client, no network); spend cap fails
  closed (DB down and $0 cap → zero calls); worker end to end on real ffmpeg + throwaway DB
  (frames on both sides of each cut, edit facts, measured audio, row + audit, re-run = new row,
  state unchanged, no-render refusal without touching the AI, ceiling refusal, reference path);
  web loader + card states rendered server-side (ready / no render / running / out of credit /
  AI off / limit / done / reference); eval fixtures `fixtures/evals/viewer-panel.json`
  (music over voice, choppy cuts, calibration) graded in mock mode.
- **Visual check** at 393×852 against a throwaway PGlite DB with the REAL job run in-process on a
  real 20 s file and the mock model (screenshots in the final report).
- **Not verified:** any real model call (no Anthropic credit; never made) — so the real output
  quality, the true output-token count/cost, and whether 360×640 frames are enough for caption
  legibility judgments are unmeasured. The eval's frames are neutral placeholders (it grades fact
  handling and calibration, not vision); a vision eval needs real clips once there's credit.
  The cloud path is wired but **the Vercel Sandbox snapshot must be rebuilt** (apps/worker,
  packages/agents, packages/media and prompts changed) and `RENDER_SANDBOX_KINDS` must allow
  `viewer-review` (it does when set to `*`).


## Scripts from ChatGPT (2026-10-17)

Chris planned ~120 videos in ChatGPT and imported the plan (`/plan/import`). He wants scripts
for all of them written by ChatGPT, for free, using his ChatGPT subscription — no OpenAI API
key, no Anthropic credit. To be merged into `/docs/DECISIONS.md` by the integrator.

## Decision: a copy-paste round trip, parsed deterministically

`/plan/scripts` ("Scripts from ChatGPT"; banner on the Plan board when planned videos lack a
script; also under More). One phone screen, three steps:

1. **Copy the prompt.** Built in the browser (`buildScriptPrompt`, pure) for a batch of the
   planned, not-yet-filmed videos with no script (from a week back, soonest first). Batch size
   10 / 15 / 20 / 30 (default 15 — ChatGPT's answer length is the limit), "Batch 1 of 8" with
   prev/next. The prompt works pasted into the chat where he planned the videos ("if we planned
   these together, use that") and standalone: it embeds each video's title, date, hook, notes
   and a 4-character video code; a faithful summary of `/brand/BRAND_CONSTITUTION.md` +
   `/brand/CHRIS_BRAIN.md` (+ `/brand/VOICE_SAMPLES.md` when Chris fills it; a test fails if a
   quoted phrase disappears from the brand files — the files are never edited); the delivery
   targets from `getReferenceStyleProfile` (talking videos): median wpm, the references' middle
   half of lengths (p25–p75) → word range, median hook length — falling back to 200 wpm,
   45–70 s ≈ 150–230 words, 3 s hook; the facts rule (only claims he can stand behind, `[CHECK]`
   after every number/stat/rate/limit/rule); and a strict block format
   (`### VIDEO n | YYYY-MM-DD | Title | CODE` / `HOOK:` / `SCRIPT:` / `ON-SCREEN:` / `CTA:`),
   all in one code block (ChatGPT's "Copy" button on a code block is one tap on iPhone).
   Clipboard API with a select-and-copy fallback; "Open ChatGPT" link.
2. **Paste ChatGPT's answer** (or choose a .txt/.md file) → "Read scripts".
3. **Preview**: one card per script: matched video + date, confidence (Exact / Likely / Pick
   one) with the reason, word count and length at his pace (own measured takes when ≥ 3,
   else the target wpm), `[CHECK]` claims listed and highlighted, a day-grouped picker to
   change the video, "+ Create as a new planned video" (title + date; goes through
   `commitPlanImport`, so it's dated, on the calendar and de-duplicated like any import), or
   Skip. A video that already has a script shows "Replace (keeps the old version)" / "Skip"
   (default Skip). Two scripts can't target one video. "Save N scripts".

**Parser** (`packages/domain/src/script-import/parse.ts`, browser-safe,
`@chris/domain/script-import`): tolerates code fences, markdown headings/bold/italics, `—`/`-`
separators instead of `|`, headings without "VIDEO" when a `Hook:`/`Script:` label follows,
dates as ISO / "Oct 21" / "Wed 10/21" / "Thursday, October 22" / "(Oct 23)" / "Today", the code
in brackets or as `Code:`, `DATE:`/`TITLE:`/`CODE:` lines, "Hook (0–3s):" labels, line
timestamps, stage directions (`[pause]`, `[B-roll …]`), smart quotes, CRLF/NBSP/zero-width
characters, "Word count: ~95" lines, separators, preambles and trailing "Want me to keep
going?" offers (never emptying a script on that heuristic). The spoken script is SCRIPT with
the hook prepended / CTA appended only when they aren't already in it; `[CHECK]` markers are
removed from the spoken text and listed. The server re-parses each raw block, so what is saved
is exactly what the parser reads from what was pasted.

**Matcher** (`match.ts`): the video code (only trusted when the title or date doesn't
contradict it — a collision or a code ChatGPT moved can't win alone), title similarity (case,
punctuation, emoji, smart quotes, `&`/`and` ignored; token overlap + Jaro-Winkler; numbers like
401(k) kept), the hook as a second opinion, the date, then order within a day (the VIDEO number
is a weak hint) — greedy one-to-one. Codes are derived only from the item id (letter-digit-
letter-digit, no I/O/0/1), so a prompt copied today still matches next week.

## Saving: new versions, honest states, factual gate intact

`saveImportedScripts` / `saveImportedScript` (`packages/domain/src/script-import-db.ts`):

- A **new `ScriptVersion`** per script — never an overwrite: `authorType "IMPORTED"`,
  `revisedFromId` = the previous latest (if Replace), `revisionNote` "Imported from ChatGPT
  (pasted by Chris) · N claims marked [CHECK]", `beats` Hook/CTA, `visualBeats` = ON-SCREEN,
  no Claims Gate verdict, speaking estimate at his pace, target runtime = the prompt's max.
- **Provenance**: AuditLog `SCRIPT_IMPORTED` per video (source "ChatGPT (pasted by Chris)",
  the raw block, header, `[CHECK]` claims, sha256) and `SCRIPTS_IMPORTED_FROM_CHATGPT` per save
  (counts, paste sha256 + 2 000-char excerpt). Replacing an agent-written script writes a
  Decision Journal entry with `userOverride: true` (ARCHITECTURE.md).
- **State**: a planned video still in planning (IDEA/SELECTED/CONTRACTED/RESEARCHED/SCRIPTING)
  walks to **SCRIPTED**, one transition per step, reason "Script imported from ChatGPT (pasted by
  Chris) — not fact-checked yet; the factual check is still required before posting" (IDEA →
  SELECTED is HUMAN; the rest SYSTEM), exactly like footage-first. A missing Production
  Contract is created **STANDARD research / MEDIUM risk — never the fact-check-exempt NONE/LOW**.
  RESEARCHING (an AI run may be in flight), RESEARCH_BLOCKED, SCRIPTED and READY_TO_FILM keep
  their state and just gain a version. Filmed videos are refused ("Already filmed").
  SCRIPTED is honest about what exists (a script) and makes the existing script editor, the
  teleprompter's "ready to film" list and footage upload (SCRIPTED → READY_TO_FILM → FILMED via
  `advancePlannedItemToFilmed`) work unchanged. Undo-plan-import treats these as started (kept).
- **Factual hard gate still blocks** — two fixes made this airtight for any non-agent script:
  - `isScriptVersionFilmable`: only legacy AGENT rows without a verdict are grandfathered;
    IMPORTED (and HUMAN) need a verdict ("This script came from ChatGPT and hasn't been
    fact-checked yet."), so autopilot / Creator Card stop there.
  - `quality-gate-job.ts` FACTUAL: when the latest script is non-AGENT and unchecked, it no
    longer falls back to an older research-packet PASS (previously a hand edit whose re-gate
    failed mid-way could borrow the research verdict). Stricter only; regression test added.
- **Idempotent**: sha256 of the normalized script text (case, whitespace, quote style ignored)
  is compared with every existing version of that video — re-pasting the same answer, a double
  tap or a retry never duplicates (status "already-saved"; an interrupted walk is completed).
  "Create as new" reuses plan import's (title, day) de-duplication.
- `editScriptAction` (video page): with no research packet to re-gate against (imported
  scripts), the edit is saved as a new unchecked version with a plain message instead of an
  error.

**Teleprompter**: already reads the latest `ScriptVersion` first; label now says "Your script
(from ChatGPT)" / "(v2, from ChatGPT)". No priority change needed.

No schema change, no migration, no model call — $0 at runtime.

## Alternatives considered

- **OpenAI API** (app calls GPT directly): billed separately from a ChatGPT subscription
  (Plus/Pro don't include API access), needs a key + spend management — the opposite of "free".
- **Anthropic (the app's own Script agent)**: costs credit; Chris explicitly wants ChatGPT, and
  the AI credit is a constraint right now. The agent path stays available.
- **Custom GPT with Actions** pushing scripts straight into the app: feasible — a GPT in
  Chris's ChatGPT account with an OpenAPI Action calling an authenticated endpoint (e.g.
  `POST /api/scripts/import` with a per-user bearer token) that runs the same
  `saveImportedScripts`. Effort ~1–2 days: an authenticated, rate-limited public endpoint +
  token issue/rotation UI, the OpenAPI schema, GPT setup instructions, and a review step
  (scripts would land without Chris seeing the matches unless they go to a pending queue).
  Custom GPT Actions work on paid ChatGPT plans, but "Actions in the GPT he planned in" means
  moving his planning chat into that GPT. Worth it later if copy-paste gets tedious; the
  parser/matcher/save path are already the reusable core.
- **Browser extension / scraping ChatGPT**: brittle, against ChatGPT's terms, not iPhone-friendly.
- **Free-form parsing with an LLM**: costs money and isn't deterministic; the strict block
  format + tolerant parser is enough (verified on messy fixtures).
- **Store raw block on ScriptVersion (new columns)**: needs a migration while another agent is
  touching the schema; the permanent AuditLog row already carries provenance.

## Rationale

Final Test: Chris's real workflow is "talk to ChatGPT"; this keeps that and removes the retyping
— one copy, one paste, one save per 15 videos, on the phone. Quality and authenticity: his
brand voice and the measured reference pacing go into every prompt; numbers are flagged for
checking and the factual gate still stands between a pasted claim and a post.

## Reversibility

High. Remove `apps/web/app/plan/scripts/`, the banner in `apps/web/app/plan/page.tsx`, the More
link, `packages/domain/src/script-import*` and its export. Saved scripts are ordinary
`ScriptVersion` rows (authorType IMPORTED) and stay valid; the two gate tightenings are
independent safety fixes worth keeping.

## Verified

- Tests: `script-import-parse.test.ts` (14: clean/messy/loose fixtures in
  `fixtures/chatgpt-scripts/`, header variants, labels, CRLF/NBSP, chatter, `[CHECK]`, raw
  re-parse round trip), `script-import-match.test.ts` (12: codes, contradicting code, reworded
  title, day-off date, order within a day, duplicates, 30 × 400 scale), `script-import-prompt.test.ts`
  (12: batching, reference numbers, brand guidance drift, format round trip, length caps, voice
  samples), `script-import-db.test.ts` (5: versions, provenance, SELECTED → SCRIPTED steps,
  contract not exempt, filmable refusal, idempotency, Replace keeps old + journal, filmed
  refused, partial failures, create-as-new), `quality-gate-job.test.ts` (imported unchecked
  script BLOCKs FACTUAL despite research PASS), teleprompter (label + DB pickup + replace wins).
- Playwright (Chrome, 393×852, throwaway PGlite + dev server on non-default ports, 30 planned
  videos seeded through `commitPlanImport`): banner "30 videos need a script" → copy prompt
  (clipboard read back: 5.7k chars, 15 videos) → pasted a messy ChatGPT-style answer built from
  that prompt (code fence, bold header with dashes, dropped codes, reworded title, numbering
  drift + human date + timestamps, `[CHECK]`, an extra unplanned video, "Want me to keep going?")
  → 16 found, 14 Exact / 2 Likely → extra one "Create as a new planned video" → "16 scripts
  saved" → re-paste shows "Replace (keeps the old version) / Skip" and saves nothing → the
  teleprompter shows "Your script (from ChatGPT)" with the text. No horizontal overflow.
- Not verified: real ChatGPT output (the fixtures imitate it); iOS Safari's clipboard (the
  fallback path is in place); ChatGPT's file download (.txt/.md) on iPhone.


## ChatGPT connector (2026-10-18)

Chris planned about 120 videos and his business model in one long ChatGPT conversation. He wants to type something like "write the scripts for the next 15 videos and save them to my app" inside that same conversation, and have it happen with no OpenAI API cost. This entry is to be merged into `/docs/DECISIONS.md` by the integrator.

The decision is a **remote MCP server inside the app** (`/api/mcp`). ChatGPT connects to it as a custom connector, using an **OAuth 2.1 authorization server** that is also inside the app (`/oauth/*`, `/.well-known/*`). Chris's ChatGPT subscription writes the scripts. The app only lists his planned videos and saves what ChatGPT sends, using the same code path as the copy-paste flow ("Scripts from ChatGPT").

## What OpenAI's docs say (checked 2026-10-17)

Sources:
- Help article "Developer mode and MCP apps in ChatGPT": https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt (updated about 2026-10-16)
- https://developers.openai.com/api/docs/guides/custom-mcp-server
- https://developers.openai.com/apps-sdk/build/auth
- https://developers.openai.com/apps-sdk/build/mcp-server
- https://developers.openai.com/apps-sdk/reference
- Custom GPTs: https://help.openai.com/en/articles/8554397-creating-and-editing-gpts and https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq

### Plan requirement (this is the main constraint)

- "Custom MCP server connections and full MCP support are available for ChatGPT **Business and Enterprise/Edu** customers on ChatGPT web."
- "Pro users can connect custom MCP servers with **read/fetch** permissions." Plus is not mentioned.
- On Business, "only admins and owners can create and publish plugins for custom MCP servers."
- So **saving scripts from ChatGPT needs Business (or Enterprise/Edu), with Chris as owner or admin.** On Plus or Pro, the copy-paste screen remains the way to do it.
- The setup page says this plainly.

### UI path

- Current path: chatgpt.com/plugins → **+** → **Add custom MCP server**. Enter a name and description, then the URL, then Authentication **OAuth**. Tick "I understand…", then Create.
- Developer Mode is no longer required.
- Older path, still documented: Settings → Apps → Advanced → Developer mode → Create.
- Adding a server works on the **web only**. After that it works in chats, including on the phone.
- In a chat, Chris picks the app with **@** or from the + menu.

### Transport

- "Expose a streamable HTTP endpoint, typically at `/mcp`."
- We serve **Streamable HTTP, stateless** (one fresh server per request, JSON responses), so it fits a plain Vercel Function.
- GET and DELETE return 405, which is allowed for a stateless server.

### Auth

ChatGPT expects:
- Authorization code with **PKCE S256**.
- RFC 8414 metadata.
- RFC 9728 protected-resource metadata, reached through `WWW-Authenticate: Bearer resource_metadata="…"` on a 401.
- The **`resource` parameter** (RFC 8707) on both the authorize and token requests.
- **`iss` in authorization responses** (RFC 9207).
- **`offline_access`** listed in `scopes_supported`, with refresh tokens issued. Otherwise "ChatGPT may lose access after the original authorization expires".

Client registration:
- **CIMD is preferred.** The client_id is `https://chatgpt.com/oauth/…/client.json`.
- **DCR is still accepted.**

Redirect URIs: `https://chatgpt.com/connector_platform_oauth_redirect`, or `https://chatgpt.com/connector/oauth/{callback_id}`.

### Write tools

- "Tools without [readOnlyHint] are treated as write actions." "Write actions by default require confirmation". The confirmation can be remembered for the rest of that conversation.
- `destructiveHint` means "may delete or overwrite user data". `openWorldHint: false` is for "a bounded private account".
- The hints only change how ChatGPT presents a call: "servers must still enforce their own authorization logic."

### Limits

- **No official response-size limit is documented.** Community reports describe truncation, and roughly 5k tokens across all tool definitions.
- So we keep three small tools, cap a batch at 30, and paginate.

### Known risk

- Business users reported write calls blocked by "OpenAI's safety checks" (community thread, June–July 2026). Plainer tool descriptions partly helped.
- Our descriptions avoid alarming wording, but we can't test this without a real Business workspace.

## Decision

### Tools

There are three tools, and no model call happens anywhere ($0). They are built in `apps/web/lib/chatgpt-mcp/server.ts`. The logic is in `packages/domain/src/chatgpt-connector.ts`.

**`list_videos_needing_scripts`** (read-only; idempotent; openWorld false)
- Arguments: `{batchSize=15 (max 30), from?, includeWithScripts?, offset?}`.
- Returns not-yet-filmed planned videos, soonest first, starting a week back. That is the same window as the Plan banner and `/plan/scripts`.
- Each video has: id, the **same 4-character code** as the copy-paste prompt, date, title, hook idea, notes, and whether it has a script.
- It also returns Chris's live **style targets** from `getReferenceStyleProfile`, and **`scriptRules`**.
- `scriptRules` comes from `scriptWritingRules()`. That is the exact brand, voice, format and `[CHECK]` text that `buildScriptPrompt` uses; the text was extracted, not copied. Output was verified byte-identical, and a test asserts the prompt contains the rules.

**`get_video`** (read-only)
- Looks up a video by id or code.
- Returns its details and the latest script, with an author label and fact-checked yes/no.

**`save_scripts`** (write; `destructiveHint: false`, because it never deletes or overwrites)
- Takes **structured** items: `{videoId|code, hook, script, onScreen?, cta?, replace?}`, up to 30.
- Each item is rendered as one canonical block in the copy-paste format and read by the **same parser**. So `[CHECK]` extraction, hook and CTA joining, and cleaning behave exactly as they do for a paste.
- It is then saved through the **existing** `saveImportedScript`, with a new provenance option:
  - a new `ScriptVersion` with authorType `IMPORTED`, revisionNote "Imported from ChatGPT connector · N claims marked [CHECK]";
  - a `SCRIPT_IMPORTED` audit row with the canonical block, `source: "ChatGPT connector"` and the grant id;
  - an idempotent text hash;
  - never an overwrite;
  - an honest walk to SCRIPTED, with reason "Script saved by ChatGPT through the Chris Studio connector (approved by Chris) — not fact-checked yet…";
  - a contract that is STANDARD/MEDIUM, never the exempt NONE/LOW.
- Matching is by id or code. An unknown id or code gives **not-found**. A code shared by two videos, an id and code that disagree, or two scripts for one video in a single call gives **ambiguous**. A filmed video gives **not-allowed**.
- A video that already has a script gives **needs-confirmation-to-replace**, with a message telling ChatGPT to ask Chris first. It is replaced only with `replace: true`, and the old version is kept.
- Re-sending the same words gives **skipped-duplicate**.
- The result includes a one-line `summary` plus a plain-language message for each item, for ChatGPT to relay to Chris.

**`get_plan_context`** — **not built.** The separate "plan context import" feature hadn't landed on `fix/usable-v1` when this was finished (checked the branch tip, 70d6012). There is a clearly marked `TODO(plan-context)` in `server.ts`, and no model was created, to avoid a conflicting schema.

### Factual gate

- Connector scripts are `IMPORTED` versions with no Claims Gate verdict.
- `isScriptVersionFilmable` refuses them, and the FACTUAL hard gate BLOCKs them exactly like pasted scripts. That BLOCK is covered by `quality-gate-job.test.ts` for IMPORTED; the connector tests assert IMPORTED, no verdict, and filmable false.

### Auth design

The OAuth server is hand-rolled in `packages/domain/src/connector-oauth.ts`. Routes:
- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/api/mcp`
- `/oauth/register`, `/oauth/token`, `/oauth/revoke`
- the `/oauth/authorize` page

What it does:
- **Flows:** authorization code + PKCE **S256 only**. There is no implicit grant, no `plain`, and no client credentials. Only public clients are accepted (`token_endpoint_auth_method: none`); a `client_secret` is rejected.
- **Clients:** DCR (RFC 7591) and **CIMD**. A CIMD document is fetched only from `chatgpt.com`, with redirects refused, a 5 s timeout and a 20 KB cap. It is cached for a day as an `OAuthClient` row, and its `client_id` must equal the URL.
- **Redirect URIs:** must be ChatGPT's two callback forms, or exact URIs from `CHATGPT_CONNECTOR_REDIRECT_URIS`. Loopback is allowed only outside production (for MCP Inspector and local testing).
- If the client or redirect URI is invalid, the authorize page **shows an error and never redirects**. Other errors redirect back with `error`, `state` and `iss`.
- **Consent:** `/oauth/authorize` uses the app's existing Auth.js session.
  - If Chris isn't signed in, the login page now takes a same-site `next` path, validated on the server: it must start with `/`, not `//`, and contain no backslash. After sign-in he returns to the consent screen.
  - The screen lists what is allowed and what isn't. It shows a red warning if the return address isn't chatgpt.com.
  - Visiting the page grants nothing. Only the **Allow** server action creates a code, and it re-validates every parameter. Server actions also get Next's built-in origin check, which guards against CSRF.
- **Tokens:**
  - Opaque random 256-bit values (`cs_at_…`, `cs_rt_…`, `csc_code_…`), stored **only as SHA-256**.
  - Each token carries its own scope (a refresh can narrow it, never widen it).
  - Each token is bound to the resource `${APP_BASE_URL}/api/mcp`. A token is rejected for any other resource, and `resource` is checked at authorize and at token.
  - Access tokens last 1 h. Refresh tokens last 30 days and are **single-use with rotation**.
  - **Reusing a refresh token or replaying a code revokes the whole grant.**
  - Claiming a code or refresh token is race-safe (`updateMany … where usedAt: null`).
  - No signing key is needed, so there is **no new secret**.
- **Scopes:** `plan:read` for the two read tools, `scripts:write` for `save_scripts`, and `offline_access` is advertised. Each tool checks its own scope.
- **Revocation:** "Disconnect ChatGPT" in Settings, plus the RFC 7009 `/oauth/revoke` endpoint. Both revoke grants by setting `revokedAt` and a reason. **Rows are never deleted.**
- **Rate limits:**
  - 30 tool calls per minute and 1,000 per day per grant. These are counted from the audit trail itself, so they hold across serverless instances.
  - 20 dynamic registrations per hour across all clients. DCR is unauthenticated, so this caps junk clients. An attacker could use up the quota and block DCR for an hour, but CIMD still works.
  - Bodies on the unauthenticated endpoints are capped at 16 KB.
- **Audit:**
  - `CHATGPT_TOOL_CALL` is recorded per tool call: who, which tool, ok or error, counts, duration and client. It holds **no script text**; the save path's `SCRIPT_IMPORTED` already keeps the text.
  - Also recorded: `CHATGPT_CONNECTOR_CLIENT_REGISTERED`, `CHATGPT_CONNECTOR_AUTHORIZED` and `CHATGPT_CONNECTOR_REVOKED`, the last with its reason (disconnect, client revoke, refresh reuse, code replay).
- **Kill switch:** `CHATGPT_CONNECTOR=off` makes the metadata, OAuth and MCP endpoints answer 503.
- **Off by default?** No. The connector does nothing until Chris himself approves a client while signed in, and that approval is the opt-in (CLAUDE.md "feature flags for risky behavior": the risky part is gated behind his consent, and the env switch turns it off).
- **CORS:** `*` on the bearer and metadata endpoints. They are cookie-less, and MCP Inspector runs in a browser.

### Threat model

| Threat | Mitigation |
|---|---|
| Anyone on the internet calls `/api/mcp` | 401 without a valid, unexpired, unrevoked access token for this exact resource |
| An attacker registers a client and phishes Chris into approving it | Redirect URIs must be ChatGPT's own callbacks (or loopback, dev only), so a code can't land on the attacker's server. The consent screen names the app and the return host, and warns when it isn't chatgpt.com |
| Code interception | PKCE S256; codes are single-use and last 5 min; a replay revokes the grant |
| A stolen refresh token | Rotation and reuse detection revoke the grant; Disconnect in Settings |
| A database leak | Only SHA-256 hashes of tokens and codes are stored |
| A token replayed against another server (confused deputy) | Audience binding (`resource`) |
| An over-permissive token | Two scopes, checked per tool; refresh can't widen them |
| Write damage from a confused model | No delete or overwrite path exists. A replace needs an explicit flag, ChatGPT's own confirmation dialog, and keeps the old version. Facts stay gated |
| Abuse or volume | Per-grant rate limits; per-call audit |
| SSRF through CIMD | Only `https://chatgpt.com/...`, no redirects, timeout, size cap |
| Login redirect abuse | `next` only accepts a same-site path |

### Libraries and versions

- `@modelcontextprotocol/sdk@1.32.1`, published 2026-10-05 and pinned. It is the v1 maintenance line.
  - Server: `McpServer` + `WebStandardStreamableHTTPServerTransport`.
  - Tests: its client `StreamableHTTPClientTransport` + `OAuthClientProvider`.
- `zod@4.5.4`, the same version already used in packages/domain.
- **Not used:**
  - Vercel's `mcp-handler`. The 2.x line needs the v2 SDK packages; its newest version (2.3.0) was under two weeks old, and 2.2.0 would have meant adopting SDK v2. Its auth helpers only wrap the resource side, and the authorization server still had to be written.
  - An off-the-shelf OAuth server (`oidc-provider` and similar). It would bring a much larger surface: sessions, interactions, JWKS and adapters, all on top of Auth.js. Our server is 5 endpoints with every branch unit-tested. The SDK's own `mcpAuthRouter` is Express-only.

## Alternatives considered

- **Custom GPT with Actions.** OpenAI now says "New GPT creation and publishing are not available on personal ChatGPT accounts, including Free, Go, Plus, and Pro", and custom GPTs are being retired (Enterprise on Dec 11, 2026, other plans "expected to follow"). A GPT also runs as its own chat, not inside his existing planning conversation. Rejected.
- **OpenAI API from the app.** It's billed separately from the subscription, which is the opposite of $0. Rejected (same as the copy-paste decision).
- **No auth, or a static bearer token in the URL.** It exposes write access to production data on a public URL, and ChatGPT's custom MCP UI supports OAuth properly. Rejected.
- **Stateful MCP sessions.** They need shared session storage across functions and give no benefit for three request/response tools.
- **One tool that accepts the copy-paste text.** Structured arguments are more reliable for a model than a formatted blob. The canonical block keeps the parser and provenance identical.

## Reversibility

High.
- Remove:
  - `apps/web/app/api/mcp`, `apps/web/app/oauth`, `apps/web/app/.well-known`, `apps/web/app/settings/chatgpt`, `apps/web/lib/chatgpt-mcp`
  - `packages/domain/src/connector-oauth.ts`, `chatgpt-connector.ts` and their exports
  - the More link and the one-line hint on `/plan/scripts`
- Or set `CHATGPT_CONNECTOR=off` without a deploy of code.
- The migration `20261018010000_chatgpt_connector` only adds tables (`OAuthClient`, `OAuthAuthorizationCode`, `OAuthGrant`, `OAuthToken`). They can stay or be dropped by a later migration.
- Saved scripts are ordinary IMPORTED `ScriptVersion` rows.
- Shared edits are additive:
  - `buildScriptPrompt`'s text was extracted into `scriptWritingRules` / `scriptFormatRules` / `SCRIPT_FACTS_RULES` (output byte-identical).
  - `saveImportedScript` takes an optional `provenance`; it defaults to the paste wording.
  - The login page takes an optional `next`.

## Verified

### Tests (all green)

`pnpm typecheck`, `pnpm lint` and `pnpm test` all pass: 140 files, 1,164 tests. New tests:
- `packages/domain/src/__tests__/connector-oauth.test.ts` (11 tests):
  - metadata, the redirect allow-list and scope parsing;
  - DCR accept and reject cases;
  - CIMD (host-locked, client_id mismatch);
  - never redirecting to an unverified client, and error + `iss` + `state` on redirect;
  - PKCE: a wrong verifier, wrong client, wrong redirect, wrong resource and an expired code are each rejected, and a code replay revokes the grant;
  - hashed storage;
  - refresh rotation, reuse revoking the grant, and no scope widening;
  - expired, wrong-audience, refresh-as-access and revoked tokens;
  - the rate limit, status, and Disconnect keeping its rows;
  - the RFC 7636 test vector.
- `packages/domain/src/__tests__/chatgpt-connector.test.ts` (9 tests):
  - argument schemas, and the rules text matching the prompt;
  - the canonical block;
  - date ordering, batching, offset, includeWithScripts and get_video;
  - save: IMPORTED, provenance, SCRIPTED walk, contract not exempt, not filmable;
  - idempotency, needs-confirmation, replace keeping the old version;
  - not-found, ambiguous, mismatch, duplicate-in-call, filmed and code-collision cases.
- `apps/web/lib/chatgpt-mcp/chatgpt-mcp.test.ts` (3 tests), using the **official SDK client end to end through the real route functions**:
  - an unauthenticated call gets 401 with `resource_metadata`; a bad token gets `invalid_token`;
  - the full flow: discovery → DCR → authorize (PKCE, `resource`) → approve → token;
  - tools/list with the annotations;
  - list → save → duplicate → needs-confirmation → get_video → invalid arguments;
  - per-call audit with no script text;
  - a refresh narrowed to `plan:read` → save_scripts refused;
  - a wrong audience gets 401; Disconnect gets 401.

### Live check

Setup: a throwaway PGlite on port 56544 and `next dev` on port 3917, with 18 planned videos.
- The SDK client ran the full OAuth flow against localhost. Chromium at 393×852 followed the real authorize URL to `/login?next=…`, Chris's email and password brought it back to the consent screen, and **Allow** redirected with `code` + `iss`.
- Tokens came back with a refresh token. The tools showed as 2 read-only and 1 write.
- list returned 15 of 18; save returned "15 saved"; re-save returned skipped-duplicate; changed text returned needs-confirmation-to-replace; the next list returned 3.
- In the app:
  - `/plan` shows "3 videos need a script";
  - the teleprompter shows the script, labeled "Your script (from ChatGPT)";
  - `/settings/chatgpt` shows Connected ✓, last used, and recent activity;
  - Disconnect → the old token gets 401.
- No horizontal overflow on any screen.

### Not verified

These need real ChatGPT and Chris's account:
- whether his plan allows write tools (Business/Enterprise/Edu only, per the docs);
- that ChatGPT accepts this server's metadata, using CIMD or DCR;
- that the redirect URI it uses is on the allow-list (if ChatGPT shows a different one, set `CHATGPT_CONNECTOR_REDIRECT_URIS`);
- the confirmation UX;
- whether OpenAI's safety check lets `save_scripts` through;
- how ChatGPT handles 15 full scripts in one call (fallback: "save them 5 at a time");
- the iPhone experience once it's set up on the web.


## Plan context (2026-10-17)

Chris built his whole 120-video plan and business model in one long ChatGPT conversation and
wants it inside the app ("let me just export it in"): for the in-app Script agent and Weekly
Strategist (when he has credit), for the ChatGPT connector another agent is building (it calls
a domain function), and for his own reference. To be merged into `/docs/DECISIONS.md` by the
integrator.

## Decision 1 — Three sources, all deterministic, $0

`/plan/context` ("Your ChatGPT conversation"; card on `/plan`, "ChatGPT conversation" under
More — `/settings/chatgpt` didn't exist on fix/usable-v1 yet; the connector agent can link
here or fold this in).

1. **Official data export** (Settings → Data Controls → Export Data → emailed .zip). The .zip
   is read **in the browser**: a small dependency-free ZIP reader
   (`packages/domain/src/plan-context/zip.ts`) reads the central directory with `File.slice`
   and decompresses only `conversations.json` (any folder; split `conversations-000.json`…
   files too; ZIP64 sizes/offsets) with `fflate@0.8.2`'s `inflateSync` (pinned, apps/web).
   Photos/audio in the zip are never read or uploaded — a test asserts < 200 KB read from a zip
   carrying a 2 MB image. Also accepts `conversations.json` directly, and `chat.html`
   (`var jsonData = …`, string-aware bracket match) when conversations.json is missing.
   **Format** (researched; OpenAI doesn't document it — third-party write-ups + the shape every
   exporter tool uses): an array of `{title, create_time, update_time, conversation_id|id,
   current_node, mapping: {id: {parent, children[], message: {author.role, create_time,
   recipient, metadata, content: {content_type, parts|text}}}}}`. Messages are a tree; the
   visible chat is the path `current_node → root` (no/unknown `current_node`: follow the
   newest child). Kept: user + assistant text (`text`, `multimodal_text` string parts, audio
   transcriptions, assistant `code` only when addressed to Chris). Dropped: system, custom
   instructions (`user_editable_context`), memory, hidden reasoning (`thoughts`,
   `reasoning_recap`), tool calls (`recipient ≠ all`) and tool output, browsing quotes,
   `is_visually_hidden_from_conversation`, images (counted: "1 image left out"). Consecutive
   assistant pieces (split around tool calls) merge into one reply; citation tokens
   (`cite…`, `【4:0†source】`) are stripped; timestamps kept. Picker: title, date,
   message count, preview, search over titles + text; several chats can be saved.
2. **Share link** (`chatgpt.com/share/<id>`): one server-side fetch (only that host/path, 15 s).
   The public page is React Router SSR streaming turbo-stream chunks
   (`streamController.enqueue("…")`); we decode the flat, index-referenced format and look for
   an object with `mapping` / `linear_conversation`, then reuse the export parser. Probed live:
   a non-existent id returns HTTP 200 with `serverResponse: {type: "error", error:
   "Conversation has been deleted…"}` — shown to Chris verbatim. A real share's payload was
   **not** observed (no public share link to test); if ChatGPT blocks the fetch (Cloudflare) or
   changes the page, the message says so and points to export/paste. No further scraping.
3. **Paste** ("select all in the chat and paste"): ChatGPT's web page carries hidden speaker
   labels that come along in a copy ("You said:" / "ChatGPT said:"); also "You:"/"ChatGPT:",
   "User:"/"Assistant:", `## You`, `**ChatGPT:**`. Split only when ≥ 2 labels alternate
   between both speakers; otherwise one block with role `unknown` and a plain note. UI noise
   ("Copy code", "Thought for 12s", "ChatGPT can make mistakes…") dropped. Optional "Update
   “X” (keeps the old version)".

## Decision 2 — Storage: versioned, idempotent, private (migration `20261017230000_plan_context`)

New tables only: `PlanContext` (title, source, conversationId?, `useForAi` default true) and
append-only `PlanContextVersion` (messages JSON `{role, text, at}[]`, counts, `contentHash`).
Same chat again (ChatGPT conversation id → same share link → explicit paste target) adds a
version unless the normalized content hash matches the latest ("Already saved — nothing
changed"). Latest version is active; older versions viewable. Saved through
`POST /api/plan-context` (a route handler: a long chat exceeds the 1 MB Server Action body
limit; the browser gzips the JSON to stay under Vercel's 4.5 MB request cap; ~3M-char cap).

**Privacy** (docs/SECURITY.md): signed-in pages only; never sent anywhere except model calls
Chris triggers (scripts / weekly plan) and the connector (his own ChatGPT). AuditLog rows
(`PLAN_CONTEXT_IMPORTED`, `PLAN_CONTEXT_AI_USE_CHANGED`, `PLAN_CONTEXT_DELETED`) carry counts,
hashes and titles — never the text. **Delete** purges the text (all versions, cascade) and
keeps the audit trail — the same "purge PII, keep history" rule as media. "Stop using" keeps
it readable but out of every AI context.

## Decision 3 — Useful without AI

- **Readable view** (`/plan/context/[id]`): chat bubbles, long messages folded ("Show all"),
  search with highlighted matches, newest 80 messages first ("Show earlier").
- **Highlights**: sections whose HEADING (markdown `#`, whole-line bold, short "Label:" lines,
  "1. Heading", inline "**Target audience:** …") names business model, audience, offer,
  pillars, posting cadence or monetization; section = heading → next heading of the same or
  higher level (≤ 1 500 chars); newest first, ≤ 3 per category; empty headings ignored. Labelled
  "found by their headings … not an AI summary". Body-text mentions never count (no guessing).
- **"Update my plan from this conversation"**: every message is run through the plan-import
  parsers (markdown tables / pasted cells → `tableToRows`, else `parseFreeText`); a candidate
  needs ≥ 3 titled rows, ≥ 3 and ≥ 50% dated. Chat prose is stripped first
  (`stripChatProse`: non-bullet, non-label, non-dated sentence lines of ≥ 6 words ending in
  `.!?` — found because "That keeps the pillars balanced across the week." parsed as a row).
  ChatGPT revises plans and delivers them week by week, so a candidate whose titles are ≥ 50%
  repeated by a newer one is marked "older draft" and unticked by default. The ticked messages
  go to `/plan/import?context=<versionId>&m=…`, each parsed separately (a table and a list
  can't confuse each other; keys re-prefixed) straight into the existing preview — Chris fixes
  / removes rows and taps Create; `commitPlanImport`'s idempotency and (title, day)
  de-duplication apply unchanged (`sourceKind TEXT`, `sourceRef "ChatGPT conversation: …"`).
  ImportClient change is one optional prop.

## Decision 4 — Domain API + agent context

`getActivePlanContext(prisma, { maxChars })` → `{ text, truncated, chars, includedMessages,
totalMessages, conversations, sources[] }`: every `useForAi` conversation's latest version,
newest first, budget shared (unused rolls over). Per conversation: a header that says it's
background, NOT a verified source; Highlights first (≤ 35% of budget); then the most recent
messages walking backwards, shown chronologically with "the most recent N of M messages (K
earlier left out)"; an oversized message is cut with "…[cut]". `truncated` is true whenever
anything was left out. `getPlanContextForAgent(prisma, "SCRIPT" | "WEEKLY_STRATEGIST")` wraps
it with `PLAN_CONTEXT_BUDGET_CHARS` (6 000 ≈ 1.5K tokens / 12 000 ≈ 3K tokens) and returns
undefined on any error (fail safe).

Wired as **optional** context: `runScriptAgent` / `runWeeklyStrategistAgent` take
`planContext?`, clip it to their budget again (own hard cap) and append it after the brand
context in `stableContext` (provider prompt-cached — it's identical across a pipeline's
draft + revisions, so the repeat cost is cache reads). `runResearchToScriptPipeline` passes it
to every Script call only — never to Research, Claims Gate or Brand Guardian (the factual
gate judges against the Research Packet alone). Callers: `apps/web/lib/content-steps.ts`
(research → script) and `generatePortfolio` (strategy). Prompts: `SCRIPT` and
`WEEKLY_STRATEGIST` → **v1.2.0** (rollback 1.1.0), `required_context` gains
`PlanContext (optional)`, plus a short section: intent only, never facts; Contract / Brand
Constitution / explicit decisions / first-party evidence outrank it; don't guess what was cut.
`docs/AGENT_CONTRACTS.md` updated. No model was called ($0); tests use MockModelProvider.

## Alternatives considered

- **Server-side zip upload**: hundreds of MB over mobile data, and the photos would leave the
  phone — rejected. A streaming server unzip still needs the upload.
- **Whole zip in memory with fflate `unzip`**: simpler, but loads the full file into memory
  on an iPhone; central-directory + slice reads only what's needed.
- **AI summary of the conversation** as the context: costs credit, not deterministic, loses
  his words. A summary could be added later as an optional button; the raw text is the source
  of truth either way.
- **Scraping chatgpt.com with a headless browser / logged-in session**: brittle, against
  ChatGPT's terms, not iPhone-friendly.
- **Storing messages as rows** (one per message): no query needs it; JSON per version keeps
  versions immutable and simple.

## Rationale

Final Test: Chris's real workflow is "talk to ChatGPT". One export (or one paste) puts the
full context where every AI step and he can use it, and the plan inside it reaches the board
through the preview he already knows — without AI credit. Quality: the context is labelled as
intent, never facts, so the factual gate is untouched.

## Reversibility

High. Remove `apps/web/app/plan/context/`, `apps/web/app/api/plan-context/`, the Plan card
and More link, the `fromConversation` prop, `packages/domain/src/plan-context*`, the agent
`planContext` params (prompts roll back to 1.1.0 by flipping the version). The tables are
additive; dropping them loses only the saved conversations.

## Verified / not verified

- Tests: `plan-context-parse.test.ts` (export tree walk incl. edited + regenerated branches,
  hidden/system/custom-instructions/reasoning/tool messages, multimodal parts, missing fields
  & current_node, citation tokens, chat.html, split-file names, zip central-directory read
  without touching media, not-a-zip; paste labels / inline / headings / no labels / false
  positive; share URL recognition, turbo-stream decode of a conversation, ChatGPT's own error,
  blocked page; highlights; plan candidates incl. superseded drafts and prose stripping;
  bounded context text), `plan-context-db.test.ts` (versions, unchanged re-import, paste
  target, share link versions, delete keeps audit without text, `getActivePlanContext` +
  "Stop using", found rows → `commitPlanImport` with no duplicates on repeat),
  `plan-context-agents.test.ts` (Script / Strategist inclusion + budgets, pipeline passes it to
  Script calls only, prompt registry v1.2.0).
- Playwright at 393×852 (throwaway PGlite + dev server on non-default ports): fixture export
  .zip (with a 3 MB fake photo) → pick the planning chat (search) → save → view, Highlights,
  search → "Update my plan from this conversation" → import preview → Create → re-save shows
  "Already saved". Screenshots in `docs/evidence/2026-10-17-plan-context/`.
- Not verified: a real ChatGPT export (the fixture imitates the documented-by-community
  schema), a real share page with a conversation, iOS Safari's file picker with a large zip.


## Segmented recording + drafts (2026-10-18)

Chris films with the in-app teleprompter. "Record here" made one continuous take per recording,
and with several takes the starter edit picked the LONGEST. He wants it like the TikTok / Reels /
Shorts cameras: record a part, pause, record the next part — all one video — and DRAFTS: if he
can't finish a video now, it's saved and he comes back hours or days later to film the rest.
To be merged into `/docs/DECISIONS.md` by the integrator.

## Decision 1 — Each part is its own recording, uploaded immediately

The big button records a PART; tapping it again pauses (= the part is done). Every part is its
own `MediaRecorder` session → its own MP4/WebM file (we do NOT rely on `MediaRecorder.pause()`,
whose iOS behavior and file timestamps are unreliable). The moment a part stops it's queued for
upload with the existing take uploader (`uploadRawTake`: local streaming route / browser-direct
Blob + registration) and the take retry policy (3 attempts, 2 s / 6 s back-off, permanent errors
not retried). The file is kept in memory only until it has uploaded; then it's dropped (object
URL revoked) and "Preview" plays the server copy. A dead phone or closed tab loses at most the
part being recorded (MediaRecorder's 1 s slices finalize the part on interruption, as before).

Screen (393×852 first): a TikTok-style parts bar at the very top (one block per part, the part
being recorded in red, "3 parts · 0:41"), a per-part upload status chip ("Saving part 3 · 45%",
"All 3 parts saved", "Part 2 didn't save — tap to retry"), and — while paused — four 44 px pills:
**Delete** (last part, with a confirm), **Preview** (all parts back-to-back), **Save draft**,
**Finish ✓**. The record button shows pause bars while recording. The 3-2-1 countdown runs only
before the first part of each visit (later parts start instantly, like TikTok).

Teleprompter position: the script does NOT reset between parts — it resumes exactly where it
paused; "Back a line" rewinds one line per tap (the drag-to-scrub still works). Deleting the
last part puts the script back where that part started. Each part records its script start/end
and the session's `scriptPosition` is auto-saved with every part (and on Save draft / leaving).
On resume the saved position is used only if the script text's fingerprint matches (a changed
script restarts at the top — the old position would point at different words).

## Decision 2 — The draft is server-side: `RecordingSession` + `RecordingSegment`

Migration `20261018030000_recording_sessions` (new tables only):

- `RecordingSession {id, contentItemId, status DRAFT|FINISHED|DISCARDED, scriptPosition,
  scriptFingerprint?, createdBy, createdAt, updatedAt, finishedAt?, discardedAt?}` — at most one
  DRAFT per video (find-or-create under a per-video advisory lock; two racing opens make one).
- `RecordingSegment {id, recordingSessionId, clientKey, segmentIndex, status ACTIVE|DELETED,
  mediaAssetId? (unique, SET NULL), durationSeconds?, scriptPositionStart/End?,
  originalFilename?, sizeBytes?, createdAt, deletedAt?}` — `(session, clientKey)` unique.

A join table rather than columns on `MediaAsset`: the segment row must outlive its media (a
deleted part is history), and registration needs its own idempotency key. Rows are never
deleted. **Idempotent registration:** the phone generates a key per part; a retried upload whose
first attempt actually landed returns the first take (the local route checks before reading the
body; the Blob registration checks before downloading; a race inside registration is resolved in
the transaction and the extra take + file are removed). **Delete last part / Discard draft:** the
segment is marked DELETED and its `MediaAsset` row + file are deleted (SECURITY.md: Chris's media
may go; the segment row and the AuditLog keep what was removed). A take referenced by an old
`TakeSelection` is never deleted. Audit actions: `RECORDING_SESSION_STARTED`,
`RECORDING_SEGMENT_ADDED`, `RECORDING_SEGMENT_DELETED`, `RECORDING_SESSION_FINISHED`,
`RECORDING_SESSION_DISCARDED`. Code: `packages/domain/src/recording-session.ts`.

Drafts show up where Chris looks: the video page (gold "Draft — 3 parts · 0:41 filmed" badge, the
big button becomes **Continue filming**, plus **Discard draft** with a confirm; the upload box is
hidden), video cards (Draft badge + Continue filming — a new `NextActionKind` CONTINUE_FILMING via
`nextActionFor(state, draft)`), the Plan board ("Draft · …" badge + Continue), the Film page
("Finish filming" list) and the teleprompter's "What are you filming?" ("Continue · Draft" at the
top). Continue opens the prompter with a Draft panel; the camera opens with the existing parts in
the bar and the script at the saved spot. A brand-new video ("New video") is created
footage-first when its first part is recorded, and the URL is switched to `?id=` so a reload or a
later visit resumes it.

## Decision 3 — State machine & gating (no shortcuts)

- The draft is opened when the first part is recorded: the video is walked to FILMED with the
  same honest steps as any upload (`advancePlannedItemToFilmed`), and the first analysed part is
  the canonical FILMED → MEDIA_INGESTED trigger. No new states or transitions. While drafting the
  video sits in MEDIA_INGESTED (or FILMED until a part lands) — true: raw media is ingested.
- **Gated while a DRAFT is open** (`assertNoOpenRecordingDraft` / `hasOpenRecordingDraft`):
  `createStarterEdit` (so every caller — flow-actions `startEditing`/`startEditingNow`, the plan
  board's `editPlannedVideo`/`makeStarterEdit`, `useOpenEditor` — is refused), the AI Take
  Selector step, and `maybeAutoStyleCut` (ingest/transcribe job hooks). The UI never offers
  "Edit video" for a drafting video. Discarding leaves the video where it is (MEDIA_INGESTED or
  FILMED with no footage) — there's no honest backwards transition, and it can be filmed again.
- **Transcription runs early** (decided): it only fills in `MediaAsset` fields, never moves the
  video or writes an edit, so it's safe — and captions are ready sooner when Chris finishes. Same
  for face tracking / matte. On the live site, Finish also kicks the cloud ingest job if any part
  is still missing captions (one heavy job per video at a time could have refused a part's job).
- The factual hard gate is untouched (footage-first contracts stay fact-check-required).

## Decision 4 — Finish → all parts in order, then the style cut joins them

`finishRecordingSession` (idempotent; needs ≥ 1 uploaded part; refuses parts arriving afterwards)
→ the existing single-upload ending (`useOpenEditor`: wait for captions → `startEditingNow` →
editor). `createStarterEdit` now prefers the video's latest FINISHED recording over "the longest
take": the take selection is the first part ("Auto: no AI needed — your 3 recorded parts, in
order.") and the plan carries `plan.sequence = {recordingSessionId, takes:[{mediaAssetId,
durationSeconds}]}` (still an untouched starter edit: no `timeline`, so the automatic style cut
may replace it). The worker's `timelineForPlan` turns `sequence` into one whole clip per part, in
order — so the editor and the renderer open/render every part (the multi-take timeline already
existed). A one-part recording is an ordinary one-take starter edit. In the editor's media bin
the parts are listed in recording order as "Part 1, Part 2…".

`buildStyleCut` (pure) now also accepts `{ base, takes: [...] }`: each part is cut on its own —
dead air at its start and end trimmed (so every join is tight), long pauses inside removed — and
the shots are concatenated in order; each join is a cut (`cutBefore: "JOIN"`), the WIDE/punch-in
framing alternation continues across joins (never the same framing twice in a row), captions
come from each part's own words (`timelineCaptionWords` is per asset, so they stay in sync), and
no cut is ever inside a word. A part with no transcribed words is kept whole. Summary: "Joined
your 3 parts (4.9 s of dead air cut at the joins) · removed 4 pauses …". `StoredStyleCut` gains
`mediaAssetIds` + `silencesByAsset` (each part's measured silences, cached). The single-take path
is byte-for-byte unchanged (verified against the previous implementation on 118 generated takes
before the refactor landed; a one-part list equals the single-take call). "Use my full take
instead" = every part whole, in order.

*Alternatives considered:* `MediaRecorder.pause()/resume()` into one file (one file is simpler to
edit, but iOS Safari's pause support/timestamps are unreliable and a crash loses everything);
client-only drafts in IndexedDB (lost with the phone, can't continue on another device, 100s of MB
in browser storage); stitching parts into one file server-side with ffmpeg (an extra heavy job
and a re-encode; the timeline already handles several takes losslessly); columns on `MediaAsset`
(the segment history would vanish with the media).

## Reversibility

High. The migration only adds two tables. Remove the segmented UI by restoring
`RecordMode.tsx`; the domain gate is a single call in `createStarterEdit` / `maybeAutoStyleCut` /
`runTakeSelectionStep`. Existing videos are unaffected (no session → old behavior everywhere);
normal uploads never carry segment fields. `STYLE_CUT_AUTO=off` still stops the automatic cut.

## Verified / not verified

- Tests: `packages/domain/src/__tests__/recording-session.test.ts` (open/idempotent/race, append
  in order, idempotent registration + duplicate race, gating, delete-last + index monotonic,
  resume, finish → sequence starter edit, closed-session refusal, discard, badges list, refuse
  past editing); `packages/media/src/__tests__/style-cut.test.ts` (multi-part: order, joins, dead
  air at each join, never mid-word, pauses, caption remap across parts, framing across joins,
  frames/idempotency, one-part == single, word-less part); `apps/worker/src/__tests__/
  recording-sequence.test.ts` (real ffmpeg parts: skipped while draft → starter timeline = all
  parts in order → auto style cut joins them, captions in order, plain/re-apply);
  `apps/web/lib/teleprompter/segments.test.ts` (bar, status, resume/rewind math, countdown rule,
  retry policy) and `recording-db.test.ts` (upload tail: idempotent retry, refusal after Finish
  without a stray take, draft view, Continue list, video-card next action).
- Playwright Chromium (fake camera + a `say`-voiced fake microphone) at 393×852 against a
  throwaway PGlite DB — see the final report for the screenshots.
- **Not verified (needs a real iPhone):** MediaRecorder start/stop latency between parts on iOS
  Safari (a first frame may be dark/blank for a few ms); background upload while the screen locks;
  memory with many long 1080p parts before they upload on a slow connection; Wake Lock between
  parts; resuming on a different phone (local script edits are per phone — the position is then
  used only if the text matches).
- **Snapshot:** `apps/worker` changed (`timelineForPlan` sequence expansion, style-cut job) — the
  Vercel Sandbox snapshot must be rebuilt before the cloud renderer/ingest job handles
  multi-part videos.


## Editor smoothness, full screen, platform UI (2026-10-18)

Chris rated the editor ~80% ("not the smoothest"), then — after the automatic style cut made a
typical edit 10–25 short clips from one take — "SO glitchy and laggy… unbearable… feels
amateur", worst on first load, after playing a while, with big videos and with the graphics.
He also wanted a full-screen view and an honest picture of where TikTok / Reels / Shorts put
their buttons. Everything below was measured before it was changed; numbers are from Playwright
at iPhone size (393×852) against a production build (`next build && next start`) on a throwaway
PGlite DB. Measurement scripts are in the session scratchpad (`sm/measure.mjs`,
`sm/measure-load.mjs`), not in the repo.

## 1. Cut boundaries (the style cut's 10–25 clips)

**Measured cause.** A style cut is 1 continuation (framing-only cut) and 13 *jump* cuts (removed
pauses, 0.13–1.2 s forward) in 36 s. The engine played clip *i* on pool element *i % 2*; the other
element waited paused on the next clip's first frame and was `play()`ed at the boundary. Chrome
needs 2–3 vsyncs from `play()` to its first new frame, so every cut held the preroll frame for
~67–100 ms (1–2 dropped frames), and the tick (clock = `currentTime`, which runs ahead of the
picture) cut a frame late, so 9–12 of 13 cuts flashed one frame of the *removed* pause.

**Decision.**
- `lib/editor/player-pool.ts` (pure, tested): a **continuation** (same take, next clip starts
  within 1/60 s of where this one ends) stays on the same element — only the crop changes; a
  **jump** switches element.
- **Warm standby:** the next jump's element is pre-seeked 0.6 s *before* the next clip's first
  frame and started (muted, invisible) when the time left equals that lead; each tick nudges its
  `playbackRate` (0.8–1.25) so it lands one frame past the first frame exactly when the current
  clip ends. The cut is then a visibility + audio swap between two elements already playing — no
  seek, no `play()` latency on screen, no audio restart. If the standby isn't on time (playback
  started right before a cut, slow network) the cut falls back to the old seek-and-play.
- **Frame-accurate cut:** `requestVideoFrameCallback` on the active element cuts in the frame where
  it would first show footage past the out point (when it gets there before the clock check).
  Cutting *only* on frame callbacks was measured and was worse in Chrome (3–9 dropped vs 1–2).
- **Hidden element is stacked behind (z-index), not `opacity: 0`.** Measured in WebKit: an
  opacity-0 `<video>` stops presenting frames and, once shown, took ~0.9 s to present its first
  frame — every cut froze. Both elements cover the whole canvas, so the one behind is invisible.
- **Scrubbing:** a new `currentTime` while a seek is in flight aborts it (Chrome: 82 seeks issued,
  12 completed during a drag on an 8-s-GOP file). Seeks are now coalesced — the latest target is
  applied on `seeked`.
- Kill switch: `?warm=0` on the editor URL (real-device A/B).

| Chrome, 36 s style cut (13 jump cuts) | before | after |
|---|---|---|
| dropped frames at cuts (8 s GOP / 1 s GOP take) | 16 / 18 | 2–3 / 2 |
| freeze at a cut, median (max) | 83 ms (100) | 50 ms (83) = normal 30-fps-on-60-Hz cadence |
| cuts showing a removed frame | 12/13 / 8/13 | 2/13 / 2–3/13 |
| scrub: video updates/s (8 s GOP) | 4.7 | 8.5–9.4 |
| scrub: input→frame median / p95 (8 s GOP) | 66 / 232 ms | 32–48 / 83–115 ms |
| scrub on a 1 s-GOP take | 25.6/s, p95 31 ms | ~24/s, p95 16–31 ms |
| long tasks during playback | 0 | 0 |

WebKit (Playwright, headless, software decode, 30 Hz rAF — a weak proxy for an iPhone): baseline
(1 run) 27.6 fps, cut freeze median 132 ms, 38 dropped at cuts; after: 25.9–28.5 fps, median
67 ms (= one 30 Hz frame), 22–24 dropped at cuts — but 2 of 5 runs were bad (one 1.7 s stall
while the standby decoded; one run where the second element never presented a frame). Headless
WebKit decoding two 1080×1920 streams in software is the likely cause; **this must be checked on
the iPhone** (see "Check on a real iPhone").

## 2. Proxy workflow (the biggest fix for big files)

**Measured cause.** The editor played the camera original. Opening a 4K HEVC take downloaded the
**whole file** (113 MB for 80 s; 192 MB for a 20 Mbps 1080p take) before anything else, decoded it
twice for cuts, and a THIRD hidden `<video>` decoded it 48 more times to build the timeline
filmstrip (`toDataURL` JPEG encodes on the main thread). On an iPhone over Wi-Fi/cellular from
Blob storage that is the "laggy right when it loads" and the stalls.

**Decision.** Every raw take gets editor-only preview assets
(`packages/media/src/preview-proxy.ts`, pure planning in `preview-plan.ts`):
- **proxy:** H.264 High, fit inside 720×1280, ≤ 30 fps, ~2.5 Mbps, keyframe every 0.5 s (closed
  GOP, no scene-cut keyframes → any seek decodes ≤ 15 frames), AAC 128k, faststart;
- **filmstrip sprite:** one JPEG, ≤ 120 tiles 120 px tall (timeline thumbnails + instant
  placeholder);
- **audio peaks:** 20/s, 0–255 (stored for a waveform; not drawn yet).

Stored at `proxies/<contentItemId>/<id>.mp4` / `-filmstrip.jpg`; columns `proxyStorageKey`,
`filmstripStorageKey`, `previewMeta` on MediaAsset (migration `20261018020000_preview_proxies`,
additive, nullable — existing rows unchanged), written by `recordPreviewAssets` (audit
`MEDIA_ASSET_PREVIEW_PROXIED`, key prefix enforced). New heavy-job kind **`preview-proxy`**; the
upload's `ingest` job makes it right after transcription (captions still come first) and before
face tracking (`ingest.proxy`, default true). `/api/media` serves the two keys (proxies cached
`private, max-age=86400`).

**Renders always read the original** — the proxy never enters `renderTimeline`, so there's no
quality loss. The editor plays the proxy when one exists (`lib/editor/editor-assets.ts`), else the
original. **Existing takes:** the editor starts a background `preview-proxy` job when it opens on a
take without one, polls every 10 s (≤ 6 min), and swaps to the proxy *while paused* (the engine
never changes a source mid-play). Client-side frame grabbing is now only a fallback for small
sources without a sprite; a > 1080p original without a proxy isn't decoded for thumbnails at all.
A poster layer shows the sprite tile for the clip under the playhead (cropped like the clip)
under the videos, so the first picture appears before the video decodes.

Proxy generation measured locally (Apple Silicon): 80 s 4K HEVC → 27 MB proxy in 20 s; 80 s
20 Mbps 1080p → 27 MB in 10 s. The cloud sandbox will be slower (software HEVC decode) — not
measured.

Trade-off: while a `preview-proxy` job runs it holds the video's heavy-job lease, so a Finish
started in those ~10–60 s says "busy". Accepted (one-time per take; the upload path does it inside
`ingest`, which already holds the lease).

## 3. Motion graphics in the preview

**Measured cause.** With 5 graphics (2 of them 3D), playback had 3–4 main-thread long tasks of
0.2–0.5 s (desktop, 4× CPU throttle) exactly when a 3D graphic appeared — mounting a three.js
scene (WebGL context, PMREM environment map, geometry) inside the Remotion Player. The
composition also re-validated every visual (`parseVisuals`) on every frame, and 3D canvases drew
at the 1080-wide composition resolution × devicePixelRatio for a ~220-px-wide preview.

**Decision** (preview-only; renders are unchanged — `previewQuality` is never set by renders):
- `VisualsPreview` passes `previewQuality`: 3D canvases capped at the resolution they're shown at
  (× 0.6 while playing, full when paused), `antialias`/`preserveDrawingBuffer` off.
- Graphics are **premounted** (Remotion `premountFor`, hidden): 3D scenes from the start of the
  timeline once the editor is idle after opening (≤ 3 per video, else 3 s ahead), everything else
  3 s ahead. The WebGL setup now happens while Chris looks at the first frame, not mid-playback.
- `parseVisuals` memoized; the env map is disposed when a 3D scene unmounts; PersonCutout frees
  its GL program/textures/buffer on every re-init (it re-inits on resize — full screen, sheets).
- Remotion/three were already lazy (only loaded when the edit has graphics).
- Not done: pre-rendering each graphic to an alpha WebM in the cloud (a bigger pipeline; the
  premount removed the measured stalls — revisit if the phone still hitches).

| Chrome, 4× CPU throttle, 4K take, 5 graphics | before | after |
|---|---|---|
| long tasks while playing | 3–4 (352–667 ms) | 0 |
| dropped frames (34 s) | 12–35 | 3–6 |
| rAF gaps > 50 ms | 2–3 | 0 |
| scrub video updates/s / input→frame p95 | 16.4 / 49 ms | 28–38 / 15–32 ms |

## 4. First load

Code-split panels Chris opens on demand (graphics gallery + editor, sound, style cut, Finish
modal, the WebGL person cut-out) — `lazy-panels.tsx`. The editor's own chunks are small; the
`@chris/media/timeline` chunk (zod + layout, 84 KB gz) and Remotion (351 KB gz, only with
graphics) dominate.

| 4× CPU throttle, cold cache | before (4K / 1080p) | after (4K / 1080p) |
|---|---|---|
| JS on load (encoded / decoded) | 697 / 2509 KB | 654 / 2348 KB |
| media downloaded while opening | 113 MB / 192 MB (whole original) | 152 KB sprite + proxy streaming |
| play button ready | 203 / 428 ms | 278 / 205 ms |
| first video frame | 1220 / 1353 ms | 1282 / 1059 ms (sprite placeholder before that) |
| first video frame, reopen (warm) | 695 / 720 ms | 557 / 645 ms |

(The 3D warm-up now runs as idle work after the first frame — it shows up as ~0.3–0.5 s of long
tasks before playback, by design.) On localhost the original's download is free, so the load
numbers understate the phone win: over a real network the old editor waited on a 100+ MB file.

## 5. Long sessions

5-minute scripted session (play 20 s, scrub, switch platform tabs, full screen in/out), 4K take
with graphics, after a forced GC: JS heap 9.2→17.7 MB before / 11.7→16.8 MB after (flat after
warm-up), event listeners flat (≈ 650–700), DOM nodes in the document flat (514→515). Chrome's
total node count (incl. detached) creeps ~100/min in both builds — small, not traced. Fixed: GL
objects in PersonCutout re-init, 3D env maps on unmount; MotionLayer/VisualHandles no longer
re-render 30×/s when there are no graphics / while playing.

## 6. Full screen

`Fullscreen.tsx` + `lib/editor/fullscreen.ts`: a button on the preview (and in the desktop
header) turns the SAME stage box into a fixed, edge-to-edge overlay — the canvas and its pool
videos are never remounted, so playback continues seamlessly; the Fullscreen API is used too where
it exists (desktop/Android; iPhone Safari can't full-screen an element). Plain mode = the whole
frame fit to width, centred. Tap = play/pause, swipe down / Esc / × = close, auto-hiding scrub bar
+ time, mute (preview only), and "App UI: Off / TikTok / Reels / Shorts" (remembered in
localStorage, guarded). With an app's UI on, the video is laid out like the app's feed (filled
above an opaque nav bar, ~49 px cropped a side on a 19.5:9 phone) with the mock on top. Editing
shortcuts are disabled while it's open.

## 7. Platform UI model

`packages/media/src/platform-ui.ts`: per app, structured regions in 1080×1920 video px for the
reference phone (393×852 pt): right rail, caption/username block, top bar, progress bar — a
**best estimate** (what the mock draws and the warnings use) and a **conservative** set (official
ads safe zones). Screen fit (`screenFit`, `referenceAppFit`): all three fill the area above the
nav bar (49 pt + 34 pt home indicator) → scale 769/1920 pt/px, ~49 px of video hidden each side.
`PLATFORM_PROFILES[id].safeZone` is now **derived** from the conservative regions (TikTok
240/660/60/300, Reels 269/672/60/227, Shorts 288/672/60/192); the Reels right margin was 65 px —
far too small for its action rail.

The graphics auto-placement solver keeps its old union margins (`PLACEMENT_SAFE_ZONE`
288/672/65/192) so no existing render moves; switching it to the regions is a separate decision.

Warnings (`platformWarnings` / FinishModal `warningsForPlatform`) now test text, captions,
graphics (resolved placements) and **Chris's face** (tracked head box per clip, ≥ 15 % covered)
against the best-estimate regions, plus the side strips a tall phone crops. The preview draws a
realistic, unbranded mock (icon silhouettes, text-line placeholders, gradients, progress bar)
above captions, with an eye toggle; "All" shows the union of the keep-clear zones.

### Sources (accessed 2026-10-17)
- TikTok Ads Help, In-Feed Ads (updated June 2026), links the safe-zone templates:
  https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads?lang=en — "a maximum of 4 lines"
  of caption; template file (Apr 2025) `In-Feed Standard LTR / Feed.png`
  (https://lf-tt4b.tiktokcdn.com/obj/i18nblog/tt4b_cms/en-US/5jqet0ab9qci-10e7f5Vig4uhAscNP8XPB0.zip):
  720×1280 top 160, bottom 440, sides 80, right action column 120 wide from y 560.
- AdKit TikTok (2026-09-10) https://adkit.so/tools/safe-zones/tiktok — confirms; 4-line anchor
  variant reserves bottom 1014.
- Meta Ads Guide, Instagram Reels https://www.facebook.com/business/ads-guide/update/video/instagram-reels
  — "at least 14% of the top, 35% of the bottom, and 6% on each side"; AdKit Instagram
  (2026-09-10) https://adkit.so/tools/safe-zones/instagram — lower-right exclusion 226.8 px wide
  below y 1152; Billo (2026-06-16) https://billo.app/blog/meta-ads-safe-zones — Stories/Reels zones
  unified March 2026.
- Inro Reels checker (2026) https://www.inro.social/tools/instagram-reels-safe-zone-checker —
  organic bands disagree: top 108–269, bottom 250–672, right 35–140 px.
- Google Ads vertical-video safe zones https://support.google.com/google-ads/answer/9128498 (image);
  AdKit YouTube (2026-09-10) https://adkit.so/tools/safe-zones/youtube and Socialync
  (2026-10-11) https://www.socialync.io/tools/safe-zones/youtube-shorts — top 288, bottom 672,
  left 48, right 192.
- Revid (2026) https://www.revid.ai/tiktok-safe-zone ("trims a little off the sides on taller
  phones"); Kive (2026-10-14) https://kive.ai/learn/meta-ad-sizes ("Meta may zoom the creative to
  fill the screen").

Where sources disagree (mostly the bottom band, 250–672 px) the official ads value is the
conservative set and a short-caption organic estimate is the best estimate. No app publishes
organic positions; icon sizes/spacing and the screen fit are derived from the app geometry, not
sourced — **verify against one screenshot per app on Chris's phone**.

### Caption default (deliberate render change)
The style cut's captions sit at y ≈ 0.74 — clear of every app's caption block (TikTok's starts at
y 1500). But a 3-word BOLD_HIGHLIGHT chunk at 72 px is up to ~740 px wide and reached TikTok's
rail (x ≥ 860) on 3 of 44 chunks of the test take. `PLAN_CAPTION_PRESETS.BOLD_HIGHLIGHT.fontSize`
72 → **64** (widest chunk 658 px, clear). Affects new starter edits/style cuts and items whose plan
still has no explicit timeline; saved timelines keep their size. `captionTop` unchanged.

## Render parity / snapshot

Final-render output is unchanged except the caption size above. Renderer-side code that changed:
`packages/motion` (VisualsLayer memo + preview-only branches, three.tsx env-map dispose),
`packages/media` (new proxy module, platform profiles), `apps/worker` (new job kind + ingest step).
**The Vercel Sandbox snapshot must be rebuilt** before the cloud `ingest` makes proxies and before
`preview-proxy` can run in the cloud — and `RENDER_SANDBOX_KINDS` must include `preview-proxy`
(currently only `reference-analyze`; editing runs locally until then). Not touched here.

## Check on a real iPhone
1. Cuts: play a style cut — any visible hitch at cuts? Compare with `?warm=0`.
2. That unmuting the warm standby at the cut keeps sound (iOS autoplay rules; the standby was
   unlocked from the play tap) and that two elements playing at once never pauses one.
3. Proxy: an existing take switches to the proxy within a minute or two of opening (paused).
4. 3D graphics: no freeze when they appear; the 3D looks sharp when paused.
5. Full screen: overlay covers the Dynamic Island/home indicator area correctly; swipe-down closes;
   the App UI mock matches the real apps (one screenshot each).
6. Memory: a 10-minute session doesn't reload the tab (Safari kills heavy tabs silently).

## Reversibility
High. `?warm=0` disables the warm standby; proxies are additive columns (null → the original
plays, exactly as before); the platform model only feeds warnings/mock (placement kept its old
margins); the caption size is one constant.


## Graphics library (2026-10-18)

**Why:** Chris tried to build a graphic on the fly — "three positions: Employee, Freelance,
Business owner; above Employee a card of 4k × 12 months; then Freelance; then Business owner with
$0, $5k, −$15k, −$5k, $50k, $5k, $0, $100k, all on the same card" — and couldn't: the 14 classic
templates have fixed shapes (a bar chart is 2–6 bars, a comparison is exactly two strings).
He asked for a library of 100–200 animations that are modular, multi-animated, highly adjustable
(any data, labels, number of items/series), categorised, searchable, with suggestions.

## Decision 1 — ONE new template, `GRAPHIC`, over a universal data model (not 200 one-offs)

`packages/media/src/graphics/contract.ts` (pure). `MOTION_TEMPLATES` gains `GRAPHIC`; its props
are a base `component` (28 of them) + one universal, fully editable data model shared by every
component:

- `series[]` (label, values[], icon, colour, note, text cells) · `categories[]` · `items[]` (text,
  sub, value, icon, colour, formula operator, checklist state) · `title/subtitle/body` ·
  `highlight` · `showTotal` · `range` · `format` (NUMBER/CURRENCY/PERCENT, k/M auto or forced,
  decimals, signs, red negatives, prefix/suffix) · `animation` (element entrance RISE/POP/FADE/
  SLIDE/WIPE/DROP/FLIP/BLUR; order TOGETHER/STAGGER/GROUP_BY_GROUP/ONE_BY_ONE; stagger; group
  pause; speed; count-up; emphasis NONE/PULSE/GLOW/RING/SHAKE; element exit CONTAINER/REVERSE/
  DROP/FADE_UP) · `screen` (OVERLAY box, or FULL-screen scene with its own backdrop).
- `GRAPHIC_COMPONENT_SPECS` says, per component, its variants (layouts) and which parts of the
  model it reads with bounds — this drives validation (plain-English issues via `superRefine`),
  the edit sheet (which sections show), the Motion Designer catalogue and the quick-entry mapping.
- **Base components (28 new + the 14 classic templates = 42):** STAT_TILES, BIG_NUMBER (solo /
  from→to / odometer), MONTH_GRID (strip / calendar), VALUE_COLUMNS (Chris's layout), FORMULA (row /
  receipt), VERSUS, ENTITY_CARDS (row / grid / podium), BEFORE_AFTER, BAR_GROUP (grouped / stacked /
  horizontal, negatives), LINE_AREA, WATERFALL (steps / cash-flow "rollercoaster"), DONUT (donut /
  pie / half), PROGRESS (rings / bars), GAUGE (dial / segments), SCATTER (dots / bubbles), STEPS
  (vertical / horizontal / roadmap), CHECKLIST, RANKING, TABLE, KINETIC (stack / highlighter /
  strike→replace / outline), QUOTE (quote / note / bubble), LOWER_THIRD, ANNOTATION (circle / arrow /
  underline / box), STICKER (badge / stamp / price bubble), MAP_PIN (abstract map, pins / route),
  ICON_BURST, CTA (follow / save / comment / share), TRANSITION (wipe / iris / slam / flash —
  full-frame).
- **Footprints follow the data:** `graphicDesignSize(props)` is the box the component lays out in;
  `footprintOf(template, props)` (visual-footprints.ts) returns it (or FULL_FRAME for full-screen
  scenes), and the placement engine, interaction engine, scene sampling and the renderer's
  `placementBox`/`designSizeOf` all use it — so a 4-person, 12-month graphic reserves a taller box
  than a 2-row one, in the editor and the render alike. Classic templates are unchanged.

**Alternatives:** 150 hand-made templates (unmaintainable, not editable); one zod schema per
component in a discriminated union (28 forms, a 28-way agent schema, no shared quick entry);
generic "props: record" (rejected: CLAUDE.md typed outputs).

## Decision 2 — Presets are DATA (169 of them), so every one is fully editable

`graphics/presets.ts`: 169 curated presets (147 GRAPHIC + 22 on the classic templates, incl. all
ten 3D objects and three money stacks), each with id, name, description, category (10: Money &
numbers, Charts, Comparisons, Timelines & steps, Lists & tables, Text & titles, Callouts &
annotations, 3D objects, Transitions & emphasis, Social & CTA), tags, suggested seconds,
placement/palette/SFX. Chris's example is the flagship preset `income-3-people-12-months` with his
exact numbers (Freelance's values are placeholders — he gave none), full-screen, built person by
person, totals under each column. Numbers in presets are illustrative; the editor says so and
the Quality Gate still refuses any ungrounded on-screen number.

## Decision 3 — Rendering: shared kit + pure sequencer; parity by construction

`packages/motion/src/remotion/graphics/` — `kit.tsx` (context, colour tokens → theme palette,
count-up with a format planned from the FINAL value so "1k 2k 3k 4k" never flips to "2,700",
element entrance/exit/emphasis vocabulary scaled by the motion language), `graphics-timing.ts`
(pure `graphicSequence`: groups × order × stagger, **auto-compressed so the build always finishes
before the exit with a 0.6 s hold**; `emphasisFrame` lands the highlight on the speaker's vocal
hit when Motion v2 provides one), `icons.tsx` (58 original line icons — never system emoji: the
iPhone and the Linux render host have different emoji fonts), and the families `money.tsx`,
`charts.tsx`, `compare.tsx`, `text.tsx`, dispatched by `Graphic.tsx` (overlay box or full-screen
scene). The same components render in `VisualsLayer` (server render) and the editor's Player.
Performance: pure functions of the frame, no React state/effects, CSS blur only when ≤ 12
elements animate. The classic AUTO transition for GRAPHIC is a plain FADE (elements carry the
motion).

## Decision 4 — Quick entry: a deterministic parser (no AI)

`graphics/quick-entry.ts`: `Employee: 4k x12 | Freelance: 2k,6k,0,8k,3k,… | Business owner: 0,
5k, -15k, -5k, 50k, 5k, 0, 100k` → series. Groups by `|`, `;`, newline; `Label: values`; label/
value pairs (`Rent 1800, Food 650`); word-only groups → categories; numbers with $/€/£, thousands
commas (kept apart from list commas), k/m/mm/b/bn, %, +/−/-, accounting `(15k)`; repeats `4k x12`,
`4k ×12`, `4k*12`, `x12 4k`; ellipses ignored; unreadable tokens become warnings, never guesses.
`applyQuickEntry` maps it onto series- or item-shaped components (12 unlabelled values → month
names; existing icons/colours kept); `toQuickEntry` round-trips the current data into the box.

## Decision 5 — Search + suggestions are deterministic; AI is an optional extra

- `graphics/search.ts`: every query word must match (exact, prefix, synonym group — "paycheck" →
  income, "vs" → comparison — or Damerau–Levenshtein ≤ 1/2), ranked name > tag > component >
  description, +phrase, +featured, +favourite, +recent.
- `graphics/suggest.ts`: from the words around the playhead (sentence + ~9 s ahead, because
  comparisons span sentences) it detects money/percent/plain numbers (incl. "five thousand
  dollars", "lost 15k" = −15k), roles (employee / freelancer / business owner / renting / owning…),
  vs-language, from→to, lists, monthly/yearly, debt/growth/budget, and returns presets PRE-FILLED
  with those values (each role gets the amounts said after it). Always offers the words as
  kinetic text.
- **"Suggest with AI"** reuses the Motion Designer with a new optional `focus` window (one
  graphic for one moment; proposals outside it dropped) through the existing job/heavy-job path.

## Decision 6 — Motion Designer 1.1.0 → 1.2.0 chooses among presets and fills data

The model-facing schema gains a strict `GRAPHIC` variant: `preset` (id or null), `component`,
`variant`, content fields (null = keep the preset's), `range`, `format`, `order`, `screen`.
`graphicPropsFromModel` merges the content onto the named preset (unknown presets ignored), then
the contract validates. `numbersShownBy("GRAPHIC")` uses `graphicShownNumbers`, which includes
DERIVED numbers (column totals, running totals, donut shares, gauge scale) — the factual hard rule
and the Quality Gate's FACTUAL check cover them (a test proves an ungrounded total drops the
graphic). The prompt carries a compact library catalogue (component → reads → preset ids).
`AGENT_CONTRACTS.md` row updated. Tested with MockModelProvider only (no credit).

## Decision 7 — Favourites + recents per user (additive migration)

`20261018050000_graphic_preset_prefs`: new table `GraphicPresetPref` (userId, presetId, favorite,
useCount, lastUsedAt, favoritedAt; unique per user+preset). `packages/domain/src/graphic-prefs.ts`
— idempotent upserts, recents capped at 12. Server actions in the editor are best-effort (the
library works without them). No AuditLog rows: UI convenience, not history (edits are versioned).

## Decision 8 — Editor: library in the Visuals sheet, generated edit sheet

- `GraphicLibrary.tsx`: sticky search, "For this moment" suggestions (+ Suggest with AI), category
  chips incl. ★ Favorites / Recent, a 2-column grid of real rendered posters
  (`apps/web/public/motion-posters/<id>.jpg`, built by `packages/motion/scripts/graphics-library.ts
  --posters=…` through the real renderer; a drawn fallback if one is missing), ▶ opens a live
  looping preview (`@chris/motion/preset-player`, mounted only while open). Tap = insert at the
  playhead in the free gap (presets carry their own length), then its edit sheet opens.
- `GraphicEditor.tsx`: layout/variant + full-screen, quick entry (live parse summary), text, a data
  table (rows × columns, add/remove, sticky row labels, per-row "Fill: 4k x12", icon + colour per
  row, text cells for tables), entries (value, sub, icon, operator, state, colour, reorder),
  highlight/totals/range, number format with a live example, animation controls. Pure ops in
  `lib/editor/graphics.ts`; every change is one undo step.
- The classic 14-template gallery is replaced by the library (the classic templates are presets
  in it); their typed forms are unchanged.

## Backward compatibility

Additive everywhere: existing timelines never contain `GRAPHIC`; classic templates, their props,
footprints, transitions and rendering are untouched (all pre-existing tests pass unchanged except
the "model schema mirrors contract" test, which now documents GRAPHIC's model-only `order` key).
No persisted-timeline migration is needed. An old app build reading a timeline with a GRAPHIC
visual would reject that visual (unknown template) — only relevant if a deploy is rolled back
after Chris used the library.

## Renderer / deploy note

The motion package changed (new components, compositions per preset): **the cloud renderer's
snapshot / pre-built Remotion bundle (MOTION_BUNDLE_DIR) needs a rebuild** before graphics render
on the live site. Not done here (no Vercel changes).

## Not verified / gaps

- Real iPhone performance of the edit sheet and a 36-cell graphic in the live Player (Chromium
  emulation at 393×852 only).
- Text fitting in the text family is estimated from a per-character table, not measured.
- Medal colours (podium/ranking) are fixed gold/silver/bronze (don't follow MONO/VIVID).
- Suggestions' role detection is English keyword rules; unusual phrasing falls back to the
  hero-number / kinetic-text suggestions.

## Reversibility

High: GRAPHIC is one additive template; removing the library UI leaves stored graphics renderable;
the prefs table is independent; the agent prompt has `rollback_version: 1.1.0`.


## App performance (2026-10-18)

Chris (iPhone-first): "the whole app is very laggy and feels amateur." This pass measured first,
then fixed root causes everywhere except the video editor (`app/content/[id]/edit/**`) and
`/api/media` (owned by the parallel editor/playback pass).

## How it was measured

- **Production** (`chris-content-intelligence.vercel.app`, deploy `c485174`): Playwright/Chromium at
  393×852 @3x, iPhone UA, touch, **CPU 2× throttle, 4G-like network (100 ms added RTT, 9/3 Mbps)**.
  Logged in as the seeded owner. Metrics: TTFB/FCP/LCP per full load, tap-to-feedback and
  tap-to-content for bottom-tab switches (event timing for INP), JS/media bytes, RSC requests.
  Plus `curl` server timing per route with a real session (doc request time minus connection setup).
- **Local before/after on the same machine**: `next build && next start` against a throwaway
  PGlite (migrated + seeded) with 120 planned videos and 6 filmed videos, each with a 126 MB raw
  take (moov at the end, like a phone file), same Playwright profile.
- Scripts were kept out of the repo (scratchpad); the numbers below are their output.

## Region check

Vercel function region **iad1** (project `functionDefaultRegions: ["iad1"]`, Fluid compute on);
Neon host suffix **`c-14.us-east-1.aws.neon.tech`** (pooled + unpooled) → **co-located** (iad1 is
AWS us-east-1). No region change needed; `vercel.json` is unchanged. Measured server time per page
(curl, minus ~120 ms edge RTT from the test machine): Upload (auth only, no DB) ≈ 60 ms, Home ≈
190 ms, Videos ≈ 220 ms, Plan ≈ 280 ms → roughly 7 ms per sequential query on top of the base.
Occasional 0.6–2 s outliers = cold starts (see "Remaining").

## Baseline (production, before)

| | Value |
|---|---|
| Videos page with **2** videos | pulled a **228 MB** iPhone `.mov` + a **12 MB** render (`<video preload="metadata" src=…#t=0.6>` per card, each through a fresh 10-minute presigned URL so never cached); `load` event fired after **52 s** unthrottled |
| First tab switch Home → Videos (4G) | **5.4 s** to content (2.3 s before anything changed) — the RSC fetch was starved by the video downloads |
| Later tab switches | median **431 ms**, max **1.3 s** of nothing visible after the tap; INP up to **1.28 s** |
| FCP | 0.8 s Home, 1.3 s Videos (bandwidth contention) vs ~0.2 s on pages without videos |
| Calendar / Plan client JS | zod (375 KB raw / 88 KB br) shipped to the browser: Calendar 443 KB raw / 108 KB gz entry JS, Plan 554 KB / 141 KB |
| Plan HTML | ~530 KB (120 rows) |
| Function trace | every route ≈ 85 MB (ffmpeg-static 43.5 MB, sharp, media fonts) |

## Root causes found

1. **Lists loaded the actual video files.** Every `VideoThumb` was a `<video>` pointing at the raw
   take/render. On a phone that's tens to hundreds of MB per card, re-downloaded on every visit
   (fresh presigned URL each time), competing with navigation requests, and tearing those media
   elements down on navigation cost hundreds of ms of main thread (INP up to 2.3 s locally).
2. **No loading states anywhere.** No `loading.tsx` existed, so (per Next 16) dynamic routes weren't
   prefetched and a tap did nothing visible until the server had rendered the whole page and it had
   crossed the phone connection.
3. **Sequential queries in production.** The PGlite "sequential awaits, never Promise.all"
   convention (correct for the local DB) also ran on Neon: Home ≈ 17 sequential round trips,
   `getContentItem` 20, To-do/needs-you 15+ (incl. an N+1), Reference 8, Calendar 6–8.
4. **zod in client bundles.** `@chris/domain/planning` re-exports `posting-plan-core` (zod schemas);
   `components/ui.tsx`, `lib/calendar-views.ts`, the calendar sheet and plan-import modules imported
   it (or `PLAN_PLATFORMS` from it) for tiny helpers.
5. **Compositing cost.** Every `.panel` had `backdrop-filter: blur(20px)` — over a flat/pre-blurred
   background it changed no pixel but made each card (120+ on Plan) its own blurred layer,
   re-rasterized while scrolling on iOS. Same for three ≥94%-opaque sticky calendar headers.
6. **Smooth-scroll on every navigation.** `html { scroll-behavior: smooth }` + Next 16 no longer
   overriding it → a tab tap from a scrolled page animated the scroll to the top.

## Fixes

- **Poster thumbnails** — `GET /api/thumb/<storageKey>` (`lib/poster.ts`): a 360-px-wide JPEG frame
  (~16 KB) made once with ffmpeg (input-side seek, so over HTTPS from Blob it reads only the needed
  byte ranges), stored at `posters/v1/<key>.jpg`, served `Cache-Control: private, max-age=31536000,
  immutable` (keys are immutable). Ownership check (`lib/media-owner.ts`, the same rules as
  `/api/media`, its four lookups in one parallel batch) runs only on first generation; afterwards a
  stored poster is served with no DB round trip. Max 2 ffmpeg decodes per instance + one generation
  per key. If a poster can't be made (ffmpeg missing/failed/timeout), a transparent pixel with a
  5-minute cache → the card's existing gradient placeholder shows, never a broken image; `<img
  alt="">` (the link names the video). Used by Home/Videos cards and the calendar sheet; on-page
  players (video page hero + render, viewer check, reference videos) keep `<video>` but with
  `preload="none"` + `poster=` so no bytes load until Chris taps play.
- **Instant navigation** — `loading.tsx` for every main route, rendering the real nav bar (the
  tapped tab already highlighted) + a skeleton of the page's shape (`components/RouteSkeleton.tsx`,
  `data-skeleton`). Home, Videos and the video page were moved into route groups
  (`app/(home)`, `app/content/(list)`, `app/content/[id]/(detail)`) so their skeletons don't wrap the
  editor route (`/content/[id]/edit` has no new loading boundary — unchanged). URLs unchanged.
- **Tab prefetch** — the four tabs (`MobileNav`, desktop `NavLinks`) use `prefetch={true}` (full
  route prefetch), so a tab tap shows the real page from the client cache; `experimental.staleTimes
  .static = 30` (was 5 min) bounds that cache to 30 s; server actions that revalidate still clear it.
- **`queryAll`** (`packages/domain/src/db-concurrency.ts`) — runs independent query thunks with
  `Promise.all` when the DB is a hosted Postgres and strictly sequentially when it is local (PGlite
  is only ever served on localhost; `DB_PARALLEL_QUERIES=1|0` overrides). Applied to:
  `getContentItem` (20 → 2 waves), video page (item ‖ draft), `getTodoData` + `loadCourseInput`
  (≈15 → ~2 waves; the transitions query now filters by the same "not cancelled" condition via the
  relation instead of waiting for the id list), `getNeedsYouQueue` (6 → 1 wave, N+1 latest-attempt
  lookups in one parallel batch, push order preserved so sorting ties are unchanged), Home, Videos,
  Plan, Calendar (+ `loadCalendarEvents`), Film, Reference. This supersedes the "sequential awaits"
  convention for **production**; on PGlite behaviour is identical to before.
- **zod-free client imports** — `PLAN_PLATFORMS` moved to `plan-platforms.ts` (re-exported from
  `posting-plan-core`, so nothing else changes); new `@chris/domain/tz` and
  `@chris/domain/friendly-status` subpaths; client code (`ui.tsx`, `calendar-views.ts`,
  `CalendarClient`, `EventSheet`, `BatchUpload`) imports those. `PlanEditor` still imports
  `planning` (it validates the plan in the browser).
- **CSS** — removed `.panel`'s backdrop blur and three near-opaque sticky calendar header blurs
  (visually identical); kept the glass on the fixed top bar, tab bar, sheets and sticky action bars.
  `<html data-scroll-behavior="smooth">` so navigations jump to the top while in-page anchors still
  scroll smoothly.
- **Indexes** (migration `20261018050000_perf_lookup_indexes`, additive): `MediaAsset(storageKey)`,
  `Render(storageKey)`, `ContentItem(currentState)`, `ScheduleEntry(scheduledDate)`. At today's row
  counts Postgres may still seq-scan; these are for growth.

## After (local, same machine/profile; production expected to match or beat the local deltas)

| Metric | Before | After |
|---|---|---|
| Tap → something visible (tab switch, median / max) | 230 / 2305 ms | **~65 / 117 ms** |
| Tap → real content (tab switch, median / max) | 238 / 2315 ms | **~85 / 145 ms** (full-prefetch cache; skeleton fallback otherwise) |
| INP on tab taps (median / max) | 160 / 2272 ms | **16–32 / 56 ms** |
| First tab switch after load | 619 ms feedback, 4.3 s content | 117 ms / 145 ms |
| Video bytes downloaded by Home / Videos / video page in 6 s | 12.6 / 12.6 / 9.5 MB (and climbing) | **0 / 0 / 0** (posters ~16 KB each, cached forever) |
| Calendar entry JS (raw / gzip) | 443 / 108 KB | **93 / 30 KB** |
| Plan entry JS (raw / gzip) | 554 / 141 KB | **191 / 58 KB** |
| Home / Videos / video page entry JS (gzip) | 10 / 10 / 54 KB | 10 / 17 / 61 KB (route-group + skeleton chunks) |
| JS fetched in the first 6 s of a cold Home visit | 142 KB | 230 KB — the extra is the **prefetched** code of the 4 tabs, which is what makes the taps instant |
| Server queries per page on Neon (sequential waves) | Home ≈ 17, video page ≈ 21, To-do ≈ 15 | Home ≈ 3, video page ≈ 3, To-do ≈ 2 → ≈ 7 ms per wave saved, ~100 ms/page |

Production expectations: the ~5 s first-tab and 1–2 s tab stalls disappear (no video downloads,
skeleton/prefetch on tap); Home/Videos/video page stop spending 10–240 MB per visit on cellular;
page server time drops by ~100 ms on Home/video page/To-do; Calendar/Plan parse ~300–450 KB less JS.
The first visit after deploy generates each video's poster once (~1–2 s per video in the
background, max 2 at a time per instance); after that they're instant.

## Trade-offs and checks

- **Prefetch load**: each page view now asks the server for up to 4 full tab renders (one user;
  bounded by the 30 s cache). Remove `prefetch={true}` to fall back to skeleton-then-content.
- **Streaming status codes**: with a loading boundary the response starts streaming before the page
  runs, so `/content/<unknown id>` now renders the not-found UI with HTTP 200 + `noindex` (Next 16
  documented behaviour) instead of a 404 status. Same for the auth redirect (client-side redirect).
- **Local PGlite + `next start`**: concurrent requests (prefetches, first poster generation) can hit
  PGlite's known "Server has closed the connection" — the same pre-existing limitation the baseline
  showed on `/api/media`. `next dev` doesn't prefetch, so day-to-day dev is unaffected; Neon is fine.
- **Not verified locally**: ffmpeg reading an HTTPS presigned Blob URL from the Linux
  `ffmpeg-static` build (the network here was too unreliable to test; the Linux static build ships
  with TLS). If it fails, cards show the old gradient placeholder (no broken image) and the logs say
  `[thumb] poster unavailable`. Check one Videos visit after deploy.
- Tests: `db-concurrency.test.ts` (detection, strict sequential mode, parallel overlap, order,
  errors, real PGlite queries), `poster.test.ts` (URLs/keys/args, real ffmpeg on a normal and a
  too-short clip, failure). Full suite, typecheck and lint green. Visual check at 393×852 of Home,
  Videos, Plan, Calendar and the Videos skeleton; all main routes smoke-tested (200).

## Remaining recommendations (not done here)

1. **Cold starts** — every route's function traces ~85 MB (ffmpeg-static 43.5 MB, sharp, media
   fonts) because NavBar/VideoCard import server-action modules whose graphs reach `@chris/media`;
   server actions run in the page's function, so excluding them per route is unsafe without an
   audit. Worth a dedicated pass: move heavy actions behind route handlers or dynamic `import()`
   inside the action, then `outputFileTracingExcludes` per page.
2. **Fluid pool hygiene** — consider `attachDatabasePool` from `@vercel/functions` for the pg pool.
3. **Plan page payload** (~460–530 KB HTML for 120 rows): virtualize or paginate the "All" range, or
   render rows from a compact JSON prop.
4. **Posters at ingest** — generating the poster right after upload (the take is already local for
   ffprobe) would remove the one-time first-view cost; the editor/proxy work may already produce a
   frame to reuse (`posters/v1/<key>.jpg` is the shared location).
5. **`/api/media`** — its four sequential ownership lookups can use `lib/media-owner.ts`
   (one parallel batch) once the playback work there has landed.
6. **Server-Timing** — no permanent instrumentation was added; Vercel Observability's function
   duration per route is the place to watch the before/after on production.

Reversibility: high. Each piece is independent — revert the route groups/loading files, the
`prefetch`/`staleTimes` pair, the poster route + `<img>` swap, or set `DB_PARALLEL_QUERIES=0` to
restore fully sequential queries in production without a code change.


## Mini-movies (2026-10-18)

Status: **pending Chris's quality call.** Nothing here touches publishing, the database, the
worker, or Vercel. One hidden labs page. Fold into `/docs/DECISIONS.md` once Chris decides whether
to build the full studio.

## What it is

Faceless, cinematic animated shorts (30–60 s, 9:16): a narrated story told with procedural 3D,
cinematic camera and lighting, kinetic typography synced to the words, and a generated score.
Made entirely by our own code — no paid AI video, $0 per film beyond our own compute.

Proof film: **"The Raise"** (38.7 s, 1080×1920, 30 fps, −14 LUFS).
- Full quality: `packages/cinema/.cache/films/the-raise/the-raise-final.mp4` (60 MB, git-ignored;
  re-render with the command below). 540p preview in the repo:
  `docs/evidence/2026-10-17-mini-movies/the-raise-540p-preview.mp4`.
- Watch it in the app (local dev): `/labs/mini-movies` (hidden, not in the nav).

```
TRANSCRIPTION_CACHE_DIR=<repo>/.cache/transformers pnpm --filter @chris/cinema exec tsx scripts/make-film.ts --tier FINAL
pnpm --filter @chris/cinema exec tsx scripts/storyboard.ts <outDir> --tier PREVIEW      # stills per shot, ~1 min
pnpm --filter @chris/cinema exec tsx scripts/contact-sheet.ts <film.mp4> <outDir>          # director review sheets
```

### The story (money psychology, Chris's voice)

| Beat | Line | Picture |
|---|---|---|
| Hook (0–2.9 s) | "Your ten-thousand-dollar raise is already gone." | Coins still raining onto a lit pedestal while **$10,000** assembles — then it's struck through on "gone". Image = desire, line = loss. |
| Setup | "Here's where it went. / Taxes take thirty-five percent." | Whip pan; 35 coins evaporate into gold dust, counter drains $10,000 → $6,500; footnote shows the math. |
| Escalation | "The nicer apartment? Three hundred more a month. / The car upgrade. One-eighty. / And sixty bucks of 'small' subscriptions." | A miniature building rises and *pulls* 36 coins in; a car glides in and takes 22; subscription cards orbit and nibble the last 7. |
| Beat | "Gone." | Silence, top-down on the empty pedestal, $0, a single shaft of light. |
| Twist | "But here's the part nobody tells you. You didn't just spend the raise. You raised your baseline." | The things stay; a glowing plane — YOUR BASELINE — rises to the height the raise used to be. |
| Payoff | "So flip it. Invest half of every raise before you ever see it. Two seventy a month, at seven percent, for twenty years, is about a hundred and forty thousand dollars. More than half of it, you never had to earn." | A 20-column sculpture of coins (one per year) grows; camera trucks along it and cranes up the last column: **$140,650**; the growth part of each column glows: **Growth $75,850**. |
| Button | "Same raise. Different life." | Wide pull-back over the whole chart; titles. |

Numbers (in `packages/cinema/src/films/the-raise.ts`): 22 % federal + 7.65 % FICA + ~5 % state ≈
34.65 % marginal → "35 %" (footnoted on screen); $10,000 × 0.65 = $6,500/yr ≈ $541/mo; half ≈
$270/mo; 100 coins = $10,000/yr so rent +$300/mo = 36 coins, car +$180/mo = 22, subs +$60/mo = 7.
FV of $270/mo at 7 %/12 for 240 months = $140,650.20; contributions $64,800 → growth $75,850
(53.9 %). On-screen footnote: "Hypothetical 7% average annual return, compounded monthly. Not a
guarantee." **Not yet through the Claims Gate** — a real mini-movie must go through the same
factual gate as every script.

## Architecture (`packages/cinema`, `@chris/cinema`)

Separate from `@chris/motion` (imports only `findLocalHeadlessShell` and its SFX kit files).

1. **Story/Scene DSL** (`src/dsl/schema.ts`, zod, `dsl: 1`): film → scenes (a procedural set) →
   shots {line (+ `say` pronunciation), duration/leadIn/hold, camera rig + lens (focal length,
   f-stop, focus target, rack focus, drift, shake, roll), actor actions, lighting preset, post FX,
   text beats, transition out, SFX cues, music intensity/hit/drop}; a film-level cast of
   procedural actors. Anything "when" is an **Anchor**: seconds, "start"/"end", `{word:"raise"}`
   (+ occurrence/edge/offset) or `{fraction}`.
2. **Validation** (`src/dsl/validate.ts`): shape errors at the exact path with field hints, then
   meaning — ids resolve (with "closest" suggestions), word anchors exist in that shot's line
   ("did you mean"), lineless shots need a duration, moving rigs need an end pose, CONTINUE never on
   shot 1, on-screen text ≤ 60 chars. Built for an LLM repair loop (`formatIssues`).
3. **Timing** (`src/timing.ts`): each line is synthesized, then **transcribed back with the repo's
   local Whisper**; script tokens are aligned to heard words (Needleman–Wunsch, digits compare by
   value, unmatched words interpolated), shots laid end to end on exact frames. Without narration
   it estimates at 2.6 words/s (storyboards).
4. **Evaluator** (`src/evaluate.ts`): `(resolved film, frame) → FrameState` — camera pose/fov/focus,
   every actor's transform/params/entrance/exit/flows, light rig blend, post values, transition
   overlays, text beats (count-ups, strikes), phrase captions. **Pure**: no three.js, no clock, no
   `Math.random`. Cinematic easing (a weighted bezier, log-space dolly distance, seeded breathing
   drift, decaying shake, whip pans that carry through the cut).
5. **Renderer** (`src/remotion/*`): one Remotion composition; `<ThreeCanvas>` world (set: infinity
   studio with a floor reflection, background sweep, haze, dust; key/rim/fill/top-spot lights with
   one shadow caster; a procedural softbox environment for metal reflections) + a DOM typography
   layer inside platform safe zones + legibility scrims.
   Post (pmndrs `postprocessing`, Zlib): DOF (focus distance + a range computed from f-stop and
   focal length), mip-chain bloom, ACES, grade (lift/gamma/gain, saturation, contrast, flash/black),
   lens pass (whip smear, chromatic aberration, vignette, frame-seeded grain).
   Tiers: **DRAFT** (half res, no DOF/bloom/grain), **PREVIEW** (full res, half-res DOF, no MSAA),
   **FINAL** (MSAA ×4, 0.75-res DOF, aberration).
6. **Procedural actors** (`src/remotion/world/actors.tsx`): instanced gold coins (generated coin-face
   and reeded-edge normal maps, original abstract mark — not any currency) that stack in clusters,
   rain in, evaporate into dust, and fly in arcs between actors; pedestal; miniature building with
   generated window light; extruded original car; subscription cards; baseline plane; coin chart
   sculpture (two-tone principal/growth); light shaft; number wall.
7. **Sound** (`src/audio/*`): **procedural score** (pads on a i–VI–III–VII progression, sub, FM
   plucks, heartbeat pulse, hits, drops; Freeverb; ducked in-sample from the real word timings),
   **SFX** = the repo's procedural kit + two new synthesized sounds (SUB_DROP, COIN_CLINK), auto
   whooshes/shimmers on transitions; **mix** = voice bus (HPF, gentle compression, presence) leveled
   to −16 LUFS, music under it, SFX −9 dB under the voice, **two-pass loudnorm to −14 LUFS / −1.5 dBTP**.
   Measured on the proof film: −14.0 LUFS, −1.5 dBTP; voice 13.3 dB over the music inside speech
   (`scripts/audio-balance.py`), music swells ~10 dB between lines.
8. **Narration** (`src/narration/*`): Kokoro-82M via kokoro-js on onnxruntime-node (CPU), q8
   weights by default (`KOKORO_DTYPE=fp32` for the larger model). ~1.4× faster than real time on an
   M1 Pro. Voice for the proof: `af_heart` (the model's top-graded voice); audition of 7 voices on
   the hook line: `docs/evidence/2026-10-17-mini-movies/voice-audition/*.m4a` — **Chris should pick**.
9. **Storyboards** (`src/storyboard.ts`): stills per shot (start/mid/end) in about a minute — the
   seed of the studio's "storyboard preview" and "shot reroll".

## Studio-director iterations (evidence: `docs/evidence/2026-10-17-mini-movies/`)

- **Round 1** (`storyboard-r1-before.jpg`): framing far too tight (9:16 is narrow: a 50 mm lens at
  7 m sees 3 m of width), hero number wrapping onto two lines and colliding with its kicker, coins
  reading as black cylinders (metal reflecting a black environment), flat emissive building
  windows, a pedestal top blown to white.
  Fixes: re-lensed every shot (28–40 mm, longer distances), no-wrap number sizing + kicker above the
  band, softbox environment with a warm surround and front fill, envMap ×2, finer window grid.
- **Round 2** (`storyboard-r2-lighting-pass.jpg`, `round2/`): gold now reads as gold; but a hot
  beige glare under every subject (the floor reflection copy of the pedestal's *bottom cap* lit from
  above, coplanar with the floor, plus a glossy floor catching the key), the twist shots composed
  as empty black with objects at the bottom, two near-identical consecutive shots, unreadable
  footnotes over bright coins, the payoff opening on an empty floor, narration too fast (35 s,
  lines back to back), "Different life." gold-on-gold, captions duplicating title text.
  Fixes: removed the cap + offset the mirror, matte low-spec floor, an empty light shaft over the
  pedestal for "the part nobody tells you", a low car-and-building composition with a rack focus for
  "you didn't just spend", footnote pills, chart pre-grown at the payoff start, speed 0.92 + holds
  after the hook / "Gone." / the twist / the number, captions hide when the same line is on screen
  as typography, end titles stacked in the upper band.
- **Round 3** (`round3/`): whip pans swung 75° into the void → a black frame at each whip; voice
  only 8.8 dB over the music. Fixes: 38° whips landing with the subject already entering frame,
  duck −14 dB and music level −20. **Round 4** (`round4-final/`) is the delivered film.

Honest self-critique of the result: it looks like a premium motion-design piece (dark product-film
lighting, real DOF/bloom/grain, purposeful moves, numbers that sit in the world), not like stock
templates. It is **not** Pixar: no characters, no acting, no fluids/cloth; the car and building are
deliberately miniature-stylized; scene variety is limited to the actors we've modeled; Kokoro is
clearly a (good) synthetic voice. The weakest moments are the growth shot (columns crop at the top)
and the subscriptions shot (cards are small on a phone).

## Render time and cost

| Host | Tier | Speed | 39 s film |
|---|---|---|---|
| M1 Pro laptop, GPU (ANGLE/Metal) | FINAL | **3.4 s per video-second** | picture 130 s + narration 10–35 s + score/mix 5 s + delivery encode 45 s ≈ **3.5 min** |
| M1 Pro, CPU WebGL (SwiftShader, `REMOTION_GL=swangle`), concurrency 2 — proxy for the Sandbox | FINAL | 65 s per video-second | ≈ 42 min |
| same | PREVIEW | 40 s per video-second (57 at concurrency 4) | ≈ 26 min |

Vercel Sandbox (8 vCPU, CPU only; Pro pricing in DECISIONS "Cost"): a FINAL film in one sandbox
would hit the 45-min timeout. Realistic cloud path: **chunk by frame range** across ~6 sandboxes
(Remotion `frameRange`, concat) ≈ 8–10 min wall, ≈ 5.6 vCPU-h ≈ **$0.7 CPU + ~$0.25 memory ≈ $1 per
FINAL film**, ~$0.6 PREVIEW; storyboards are seconds. Cheapest/fastest today: render finals on a
machine with a GPU (Chris's Mac). The DSL/evaluator are host-agnostic.

Snapshot needs (if/when cloud rendering is wanted — **not done**, per instructions): kokoro-js +
phonemizer + postprocessing in the runner's externals; the Kokoro q8 ONNX (92 MB) + tokenizer
pre-downloaded into `/vercel/sandbox/cache` by `warmup`; a pre-bundled cinema Remotion project
(`CINEMA_BUNDLE_DIR`, same pattern as `MOTION_BUNDLE_DIR`); fonts and the SFX kit are already there;
a chunked render job kind.

## Licenses (asset manifest: `packages/cinema/src/assets/manifest.ts`, test-enforced)

- All 3D objects, textures, the environment, the score, and two SFX: **original, generated by our
  code**. The other SFX: the repo's procedural kit (original).
- Fonts: Inter, DM Serif Display — OFL-1.1 (already in `packages/media/assets`).
- Kokoro-82M weights + voices: **Apache-2.0** (verified on the model card 2026-10-17; trained on
  permissive/non-copyrighted audio). Output is AI-generated speech — label where a platform requires.
- phonemizer.js: Apache-2.0 wrapper, **bundles eSpeak NG (GPL-3.0)**. We only *run* it on our own
  machines/sandbox; GPL obligations attach to distributing the program, not to the audio. Re-check
  if the renderer is ever shipped to third parties.
- Whisper base.en: MIT. three.js / R3F: MIT. postprocessing: Zlib. Remotion: Remotion License (free
  ≤ 3 employees — same caveat as `@chris/motion`).
- No downloaded third-party models/HDRIs/characters were needed; none are in the repo. Poly Haven /
  Kenney / Quaternius (CC0) remain the documented option for future sets — each must get a manifest
  entry with source + license before use.

## Brand / spec checks

- "Principles transfer. Identity does not." The inspiration (a faceless explainer channel) supplied
  principles only — hook-in-2-seconds, one physical metaphor, a twist. Look, palette, typography,
  voice, and story are Chris's: the app's ink/gold/violet palette, Inter + DM Serif, real numbers on
  screen with the math footnoted, skeptical plain-English lines, no guru clichés.
- §3 "AI should NOT replace Chris's voice": the narrator is a synthetic voice that is *not* Chris and
  doesn't pretend to be. **Recommended for real publishing: Chris records the lines** (the DSL's
  `narration.engine: "CHRIS"` exists; the timing pipeline already works from any recorded line via
  Whisper). TTS stays the scratch/temp track and the fallback.
- §10: this is HERO-tier production; it must pass the same Claims Gate and hard gates as any video.

## What a full studio would need (not built)

1. **Authoring**: a ChatGPT copy-paste prompt that outputs DSL JSON + an in-app "write a mini-movie"
   agent (MEDIUM model) with the validator in a repair loop; the Claims Gate on the lines.
2. **Storyboard review** in the app (the storyboard renderer exists), per-shot **reroll** (camera,
   lighting preset, framing), and a timeline of shots with their lines.
3. **More sets/actors**: a numbers void (exists, unpolished), a city, a home interior, charts as
   sculptures (bars, lines, pies), simple stylized characters (CC0 rigged, e.g. Quaternius) — every
   new asset with a manifest entry.
4. **Music library**: more procedural cue styles (tension, uplift, minimal) and/or CC0/royalty-free
   tracks with documented licenses.
5. **Chris narration recording** in the Film page flow, then automatic word-sync.
6. **Cloud rendering** by frame-range chunks (above) or a GPU host; render-farm progress in the job
   banner.
7. Visual QA for mini-movies (text-in-safe-zone and readability checks on the rendered frames).

## Files

`packages/cinema/**` (new package), `apps/web/app/labs/mini-movies/page.tsx`,
`apps/web/app/api/labs/films/[id]/[file]/route.ts`, `apps/web/lib/labs-films.ts`,
`docs/evidence/2026-10-17-mini-movies/**`, this file. `pnpm-lock.yaml` (kokoro-js 1.2.1,
postprocessing 6.39.5).

Tests (`packages/cinema/src/__tests__`): DSL validation (8), timing/word anchors/alignment +
determinism of frame state (5), evaluator behavior + asset-manifest licenses (8), score determinism,
ducking, mix graphs and a real ffmpeg −14 LUFS master (5), and a real Chrome/WebGL render of the
same frame twice in two browsers → identical PNG hash (skip with `CINEMA_SKIP_REAL_RENDER=1`).

Reversibility: total — delete the package and the labs page; nothing else depends on it.

Ops note: the laptop's disk was at 99–100 % during this work (≈ 81 GB in ~/Library/Caches/Adobe,
≈ 37 GB in `.claude/worktrees`); a Kokoro download failed once with ENOSPC. Nothing was deleted.


## Person cut-out on demand, not on every upload (2026-10-18) — REVERTED same day

**Reverted:** this was a misreading — Chris's "make it free" applied ONLY to the mini-movie
studio. `PERSON_MATTE` override removed from production, so uploads cut him out automatically
again (the default). The editor's "Behind me" still starts a cut-out if one is missing (harmless
fallback). Original (now superseded) note follows.

Chris: "make it free and don't lose quality as much as possible." The person matte (MODNet) was
the slowest, costliest step of every cloud upload (~5–8¢/take) yet only matters when a graphic
sits behind him. Production now sets `PERSON_MATTE=off`, so uploads skip it; the cut-out is made
(1) when he turns on "Behind me" in the editor (`ensurePersonCutoutAction`, background job), and
(2) by the render job itself whenever a graphic is behind him and the matte is missing (already
the render job's behavior). Quality of finished videos is unchanged for graphics he puts behind
him; trade-off: AUTO-depth graphics (no explicit "Behind me") stay in front unless a matte
already exists. Reversible: set `PERSON_MATTE=on`.


## Mini-movie Studio crew (2026-10-18)

Status: **built and verified with mocks + a fake engine; the engine's heavy jobs still need wiring.**
To be folded into `/docs/DECISIONS.md` by the integrator.

Chris asked for an on-demand studio: type (or pick) an idea → a crew of specialist bots, each
with one goal, makes an elite 30–60 s 9:16 animated short in the cinema DSL → storyboard →
review/revise → render → Videos. His example of what the crew must catch: in the proof film,
"you raised your baseline" played over visuals that didn't read as a floor/baseline rising.

**Mid-build course change from Chris: the studio must cost $0.** No Anthropic credit, no paid
API. The crew, typed artifacts, authority hierarchy and orchestrated pipeline stayed; *how*
each crew member runs changed:

- everything that can be code **is code** (automatic, free);
- the creative/vision judgment runs as **two copy-paste round trips with Chris's own ChatGPT**
  (like `/plan/scripts`): the app builds one "pack" (crew prompts from the versioned registry +
  brand + film + the exact JSON shape, plus the storyboard image), Chris sends it, pastes the
  JSON answer back, code validates/repairs and the orchestrator continues;
- an **optional local model** (Ollama on Chris's Mac) can answer the same packs automatically —
  feature flag, off by default;
- **no billed provider can reach the studio**: the pipeline only accepts a `FreeModelProvider`
  (`free: true`) — passing the Anthropic provider is a type error and is refused at runtime
  (`StudioPaidProviderError`, tested).

---

## 1. The crew — roles, goals, how each runs

| Crew member | Goal (one) | Runs as | Output (typed, persisted as a FilmArtifact) |
|---|---|---|---|
| **Film Director** (`FILM_DIRECTOR`) | Owns the brief and the call: good enough / revise X / stop | ChatGPT (WRITE: brief; REVIEW: decision) + **code guard** (stricter-only) | `FilmBrief`, `DirectorDecision`, guarded `FinalDecision` |
| **Hook** (`FILM_HOOK`) | Earn the first 1–3 s: ≥ 5 options (line + opening picture), scored as estimates | ChatGPT (WRITE) | `HookSet` |
| **Screenwriter** (`FILM_SCREENWRITER`) | Narration in Chris's voice, one metaphor, every number checkable | ChatGPT (WRITE) | `FilmScript` (lines l1…, numbers, **calculations**, claims, caveats) |
| **Cinematographer** (`FILM_CINEMATOGRAPHER`) | Each line's picture literally shows it, catalog vocabulary only | ChatGPT (WRITE / FIX) | `ShotPlan` (film DSL + shot notes) |
| **Verification** | Every number on screen/in a line recomputed; untraced numbers block; facts confirmed by Chris | **Code** — HARD GATE | `VerificationReport` (math checks, number traces, claims to confirm) |
| **Meaning-Match** (`FILM_MEANING_MATCH`) | The picture shows what the words say, line by line | **Code first pass** (concept rules + local sentence embeddings) → ChatGPT vision second pass (REVIEW) | `MeaningMatchReport` (MATCH / WEAK / MISMATCH + evidence + catalog replacement) |
| **Continuity** | Objects, counts, screen direction, lighting consistent shot to shot | **Code** (DSL state diff) | `ContinuityIssue[]` |
| **Quality** (`FILM_QUALITY`) | Safe zones, legibility, framing, timing, loudness — the premium bar on a phone | **Code** (DSL + measured stills/render) → ChatGPT vision (REVIEW; optional FINAL) | `QualityIssue[]`, `QualityReport` |
| **Retention** (`FILM_RETENTION`) | Where a cold viewer would swipe away — estimates only | ChatGPT (REVIEW) | `RetentionReport` |
| **Cohesion** (`FILM_COHESION`) | One world, one metaphor, story logic, an ending that lands | ChatGPT (REVIEW) | `CohesionReport` |
| **Fact check** (reuses `CLAIMS_GATE`'s rules + output shape) | Independent factual review of every factual line | ChatGPT (REVIEW) — never billed | `FactCheck` (= `ClaimsGateResult` fields); BLOCK feeds the Verification gate |
| **Analysis** (`FILM_ANALYSIS`, the `VIEWER_PANEL` idea condensed) | A first-time viewer's read of the finished film | ChatGPT (optional FINAL) | `analysis` (verdict tier, hook estimate, drop-offs, fixes) |
| **Engine** | Validate the DSL, draw the storyboard, render | `FilmEnginePort` (our own compute) | validation, `StoryboardResult`, `RenderResult` |

Not added: a separate Sound/Music bot — the engine's procedural score + `autoSfx` + per-shot
music intensity already cover it, and the Cinematographer authors SFX/music cues in the DSL; a bot
with no distinct deterministic check wouldn't pull its weight.

## 2. Pipeline (deterministic orchestrator — `packages/agents/src/studio/pipeline.ts`)

```
 Chris: idea · length · look · narrator ──► startFilm
        │
  WRITE ──► [ChatGPT round trip a]  Director brief · Hook ×5 · Screenwriter · Cinematographer (DSL)
        │       paste → tolerant parse → zod → 4 artifacts + FilmVersion v1
  VALIDATE ── engine validator + script↔shot coverage ──✗──► FIX round trip (validator's own messages), ≤ maxRepairs
  VERIFY ──── math recomputed + every number traced (HARD GATE) ──✗──► FIX round trip, ≤ maxRepairs → BLOCKED
  STORYBOARD ─ engine job (idempotency key) ─ poll ─ failure → retry ≤ maxStoryboards → BLOCKED (technical)
  AUTO_REVIEW  Meaning-Match first pass · Continuity · Quality basics   (code, $0)
  REVIEW ──► [ChatGPT round trip b, storyboard image attached]
        │       Meaning-Match (vision) · Cohesion · Retention · Quality (vision) · Fact check · Director
  DECIDE ──── guardDirectorDecision (stricter only):
        │       hard-gate BLOCK → REVISE (rounds left) | BLOCKED
        │       APPROVE over a rule MISMATCH / BLOCKING quality → REVISE (rounds left) | known issue for Chris
        │       REVISE + revisedFilm → new FilmVersion → iteration+1 → VALIDATE …   (≤ maxIterations = 3)
        │       REVISE without a film (or code-forced) → FIX round trip
  STORYBOARD_REVIEW (Chris, authority 1): approve · redo a shot (+note → FIX) · edit a line (new version)
        │       · confirm facts (required before render)
  RENDER ──── engine job ─ failure → Chris can retry ≤ maxRenders
  FINAL_QC ── measured render checks (loudness −14 ±1 LUFS, true peak ≤ −1 dBTP, safe zones, contrast) = TECHNICAL gate
  READY ───── Send to Videos (ContentItem, idempotent) · optional FINAL round trip (quality + analysis)
```

- **Execution:** the phone's crew room POSTs `/api/studio/films/[id]` while the automatic crew or
  the engine works; each call runs `advanceFilm` (up to 12 steps, one worker per film via a
  lease on the Film row), returning when it waits for ChatGPT, Chris or the engine. No long
  function; nothing runs when nobody is looking except engine jobs.
- **Idempotent + resumable:** every step's output is an artifact with an idempotency key
  (`<film>:v<version>:<step>`); engine requests carry `<film>:<version>:storyboard:<attempt>`;
  the same paste twice is a no-op; a crash mid-step leaves the film FAILED with the step recorded
  and **Resume** re-runs it — the test proves the retried storyboard reuses the same engine job and
  no artifact key is duplicated.
- **Append-only:** `FilmVersion` and `FilmArtifact` have no update/delete path. Audited:
  `FILM_CREATED`, `FILM_VERSION_CREATED`, `FILM_STATUS_CHANGED`, `FILM_CHRIS_ACTION`,
  `FILM_GATE_BLOCK`.

## 3. Authority & hard gates

Chris > hard gates > Brand > strategy > Director > specialists (spec §5).

- Gates are `{status:"PASS"} | {status:"BLOCK", reasons}`; `aggregateFilmGates` is an OR.
  `FinalDecision` `APPROVE` can only be constructed with `PassedGates` (both literally PASS) — a
  creative score has no way to approve over a block (types + tests).
- **VERIFICATION (hard gate):** every calculation recomputed (ADD, SUBTRACT, MULTIPLY, DIVIDE,
  PERCENT_OF, MONTHLY/ANNUAL, FUTURE_VALUE_MONTHLY, PERCENT_CHANGE; exact claims to $0.50/0.1 %,
  "about" ≤ 3 %); every digit number in a line, text beat, label or footnote must trace to a
  declared number (an untraced "$9,999" blocks); a DERIVED number without a calculation blocks;
  a fact check BLOCK blocks; **every FACT claim must be confirmed by Chris** before render
  (checkboxes on the storyboard screen — authority 1; opinions/hypotheticals pass, hypotheticals
  carry a footnote). Account names (401(k), 403b, 529) aren't numbers.
- **TECHNICAL (hard gate):** engine validation, storyboard/render job failure, measured BLOCKING
  issues on the render (text under platform UI, clipping).
- The Director can overrule a first-pass Meaning-Match MISMATCH only **with a written reason** in
  `overruled` (recorded); otherwise code forces a revision while rounds remain.

## 4. Meaning-Match — how Chris's example is caught for $0

1. **Concept rules** (strong signal): a line that names something the engine can literally show
   must show it. `BASELINE_RISES` ("raised your baseline / the floor went up"): a BASELINE actor
   whose `level` goes UP during the line, on screen and **in frame** (engine evaluator +
   projection), with the things that raised it in frame — **and lifted with it** (a MOVE up on
   the apartment/car). Others: GONE (something exits/drains/is struck through), GROWTH (a chart or
   stack grows), MONEY_TAKEN (coins flow out), RENT/CAR/SUBSCRIPTIONS (that object on screen).
2. **Local sentence embeddings** (soft signal): `Xenova/all-MiniLM-L6-v2` (Apache-2.0, ONNX q8
   ≈ 23 MB, transformers.js — the runtime/cache the repo's Whisper already uses) compares each
   line with a plain-words description of what the shot shows (on-screen text that just repeats
   the line is excluded — text isn't picture) and suggests the closest catalog alternatives.
   Advisory only (WEAK), never forcing. Falls back to a hashed lexical embedder if the model can't
   load (labelled).
3. ChatGPT's vision pass then confirms/corrects with the storyboard image.

**Verified on the REAL proof film** (`apps/web/lib/studio/proof-film.test.ts`): the engine's own
evaluator says the baseline, apartment and car are all in frame in shot "baseline" — so it's not
framing — but the plane rises to 1.8 m **through** the building and car while they stay on the
ground; the first pass flags exactly that shot as MISMATCH ("it reads as a glow passing by, not as
the floor under your life going up") with the fix "lift them with it (MOVE)", and no other shot.
MiniLM calibration on the studio demo film (`docs/evidence/2026-10-18-studio-crew/minilm-first-pass.txt`):
literal shots 0.28–0.37 cosine; the flawed baseline shot 0.13 vs 0.37 once fixed; abstract lines
("You didn't just spend the raise.") ≈ 0.05 → thresholds match ≥ 0.28, weak ≥ 0.12. CPU time
≈ 0.3 s per film after the one-time model download.

## 5. Routing (spec §16) — all $0

| Class | Who | How |
|---|---|---|
| HIGH judgment (Director, Meaning-Match vision, Analysis) | ChatGPT round trip (Chris's subscription) or local vision model | `prompts/agents/FILM_*.md` `model_class: HIGH` = the capability the pack needs |
| MEDIUM (Hook, Screenwriter, Cinematographer, Retention, Cohesion, Quality vision) | same packs | `model_class: MEDIUM` |
| LOCAL_EMBEDDING | Meaning-Match first pass | MiniLM on CPU |
| DETERMINISTIC | Verification, Continuity, Quality basics, coverage, Director guard, orchestrator | code |

**Optional local AI:** `OllamaModelProvider` (OpenAI-compatible `/v1/chat/completions`,
`response_format: json_schema`, images as data URLs). Defaults `qwen2.5:7b-instruct` (text) and
`qwen2.5vl:7b` (vision), overridable (`STUDIO_LOCAL_TEXT_MODEL`/`_VISION_MODEL`). On only when
the feature flag `studio.local_ai` is enabled **and** `STUDIO_LOCAL_AI_URL` is set; the new-film
form then offers "Let my Mac's local AI answer". Free but needs the Mac on and ~10 GB of disk
(two ~5 GB models); a phone on the Vercel deployment can't reach the Mac's localhost without a
tunnel Chris sets up. Any failure falls back to the ChatGPT step with a plain message.

## 6. Per-film limits (spec §16 governor)

`DEFAULT_FILM_LIMITS`: 3 revision rounds · 10 round trips · 3 repair rounds · 8 storyboards ·
3 renders · 12 local-AI calls. Hitting one → STOPPED with the reason ("used all 10 ChatGPT round
trips") — Resume after raising it. Paid spend: impossible by construction (no paid provider);
the daily cap is untouched.

## 7. Cost per film — the math

| Item | Typical | Cost |
|---|---|---|
| Model calls | 0 | **$0** (ChatGPT subscription Chris already pays; local AI optional) |
| Round trips | WRITE + REVIEW + 1 revision REVIEW ≈ 3 (best case 2; + 1 FIX if the DSL needs repair) | $0, ~1–2 min of Chris per round (copy, paste) |
| Pack sizes | WRITE ≈ 27 k chars, REVIEW ≈ 44 k chars + one image | $0 |
| Meaning-Match embeddings | 1 pass per version, ~0.3 s CPU | $0 |
| Storyboards | 2 per film (one per round), stills only | Mac: ~1 min each, $0 · Sandbox: seconds-to-minutes, ≈ $0.01–0.03 |
| Final render | 1 | Mac GPU: ~3.5 min, $0 · Sandbox (chunked, per the mini-movies decision): ≈ $1 |

So **$0 on Chris's Mac; ≈ $1 per film if he renders in the cloud** (compute, not AI).

## 8. Free path (ChatGPT) — the UX

Step 1 of 2 "Write the film" and Step 2 of 2 "Review the storyboard": **Send to ChatGPT** (Web
Share with the image + text on iPhone — straight into the ChatGPT app), or **Copy message** +
**Save the storyboard image**, "Open ChatGPT ↗", then paste the answer and **Continue**. The parser
tolerates code fences, chatter, smart quotes, trailing commas; a misfit answer changes nothing and
offers **Copy the fix-up message** (lists the exact fields). The answer shape is printed compactly
(TypeScript-like with `Evidence`/`Estimate` named once — ~4.5 k chars instead of ~12 k of JSON
Schema).

## 9. Data (migration `20261018070000_film_studio`, additive)

`Film` (status/step/iteration, counters, limits, pending pack, engine job, confirmed facts,
Chris's notes, lease, `contentItemId` once sent to Videos) · `FilmVersion` (DSL as received,
script, brief, origin CREW_WRITE / CREW_REVISION / FIX / CHRIS_EDIT, parent) · `FilmArtifact`
(kind, agent, via DETERMINISTIC / LOCAL_EMBEDDING / CHATGPT / LOCAL_AI / ENGINE / CHRIS, prompt
version, iteration, unique idempotency key, plain-English summary, payload, gate). No change to any
existing table (the ContentItem link is a plain column, no back-relation).

## 10. Port — `FilmEnginePort` (`packages/agents/src/studio/engine-port.ts`)

`capabilities · validateFilm · formatIssues · getCatalog · listVoices · describeShots ·
requestStoryboard · requestRender · getJob · loadImage?` — `FakeFilmEngine` (tests, dev sketch
storyboards) and `CinemaFilmEngine` (`apps/web/lib/studio/cinema-engine.ts`).

**Wired to the real engine now:** `validateFilm`/`formatIssues` (@chris/cinema/pure),
`describeShots` (real evaluator + pinhole projection → `inFrame`), voices (7 Kokoro voices with the
audition clips as ▶ samples via `/api/studio/voices/[id]`, + "My voice").

**For the integrator to wire (TODOs in code):**
1. `film-storyboard` / `film-render` heavy-job kinds → `heavyFilmDispatch` (apps/web/lib/studio/
   heavy-dispatch.ts) already calls `runHeavyJob` once `isHeavyJobKind` knows them. Args/results
   expected: `HEAVY_ARGS` in cinema-engine.ts (stills with `metrics`, a **JPEG** contact sheet with
   the line under each still — ChatGPT can't read SVG; render `{videoUrl, posterUrl,
   durationSeconds, loudnessLufs, truePeakDbtp, frames, contactSheetUrl, contentItemId?,
   renderId?}`); lease subject `film:<filmId>`.
2. `FILM_CATALOG` / `getFilmCatalog()` export from `@chris/cinema/pure` (`{version, entries:
   CatalogEntry[]}`) — picked up automatically; the fallback catalog covers DSL v1 meanwhile.
3. A `KOKORO_VOICES` list (new voices) and Chris-recorded narration: `requestRender` already
   passes `chrisNarration: {shotId: mediaKey}`; the recording UI is not built here.
4. `StillMetrics` (contrast per text band, safe-zone overlap, empty-frame ratio, text height) from
   the storyboard/render job — the Quality rules are written and tested; without metrics they say
   "stills not measured".
5. Render registration as a ContentItem render: "Send to Videos" creates/links the ContentItem
   (format `MINI_MOVIE`, idempotent); the engine attaches the file/Render row.

Until 1 is wired, on the real engine the crew reviews the shot list without stills (the review
pack says the image is missing) and rendering stops at the storyboard with "the storyboard/render
workers for mini-movies aren't connected yet".

## 11. Verified / not verified

**Tests (all mock / fake engine, $0):** `packages/agents/src/__tests__/studio-*.test.ts`
(deterministic math/number tracing/coverage/continuity/quality; Meaning-Match incl. the
baseline fixture, floor-alone, out-of-frame, text-isn't-picture; orchestrator happy path with the
revise loop, coerced revision, wrong-math BLOCK, iteration cap, validation repair, bad paste +
duplicate paste, crash → resume without duplicate job/artifacts, storyboard/render failure + retry,
round-trip limit, Chris edit/redo, paid provider refused, LOCAL mode; local-AI request shape;
Prisma store on the real throwaway DB: append-only, idempotent artifact, lease, Send to Videos,
audit); `apps/web/lib/studio/*.test.ts` (adapter with the real validator/evaluator, the real proof
film flagged, view-model states); eval `fixtures/evals/film-meaning-match.json` (3 cases, graded in
mock mode; the harness test proves a review that waves the flaw through fails). The demo film is
checked against the REAL cinema validator so the fixture can't drift from the engine.

**UI (Playwright, Chrome 393×852, throwaway PGlite :55493 + `next dev` :3493 with
`STUDIO_FAKE_ENGINE=1 STUDIO_DEMO_CREW=1`):** new film → Step 1 pack (clipboard read back: 27 k
chars) → bad paste rejected with field list + fix-up message → demo answer → automatic crew →
Step 2 pack with storyboard sketch; shot 7 "You raised your baseline." marked "doesn't show it" with
the fix → round-1 review REVISE → round 2 APPROVE → facts checkbox → Approve & render → ready →
Send to Videos (appears in Videos) → studio list; More shows "Mini-movie studio". No horizontal
overflow on any screen. Screenshots: `docs/evidence/2026-10-18-studio-crew/`.

**Not verified:** a real ChatGPT answer to these packs (format reliability, how well it reads the
contact sheet); the real storyboard/render jobs (not on this branch); a real Ollama model; Web
Share with an image into the ChatGPT iOS app; real still metrics.

## Alternatives considered

- Anthropic calls per crew member (the original brief): ~10–15 calls/film ≈ $1–3 — rejected by
  Chris ($0 requirement).
- One ChatGPT round trip per crew member: ~10 copy-pastes per film — too much friction (Final
  Test); merged into two packs, each section still its own typed artifact.
- Embeddings only for Meaning-Match: the proof film's baseline shot really does contain a rising
  baseline plane, so its picture description is about baselines rising — similarity can't tell
  "rises through the things" from "lifts them". Only a concept rule about what raising YOUR
  baseline literally looks like catches it; embeddings stay a soft signal.
- Custom GPT with Actions (no copy-paste): possible later (see the ChatGPT connector decision);
  needs an authenticated endpoint per pack.

## Reversibility

High. Additive tables, new routes (`/studio`, `/api/studio/*`), one More link, new prompt files,
a new `@chris/agents/studio` entry point and `@chris/media/embeddings`. Removing the link hides it;
nothing else reads Film rows.


## Studio engine (2026-10-18)

Status: **built, tested, wired to the studio crew; snapshot rebuild + first production use pending
(Chris).** To be folded into `/docs/DECISIONS.md` by the integrator. Interface:
`packages/cinema/README.md`. Evidence: `docs/evidence/2026-10-18-studio-engine/`.

Chris approved an on-demand studio: he types an idea → the crew (packages/agents/src/studio,
built alongside) writes/storyboards/reviews a film in the cinema DSL → it renders → it lands in
Videos. This is the engine and infrastructure the crew drives. Mid-build course change from
Chris: **the studio must cost $0** — local rendering on his Mac is first-class; the Vercel Sandbox
only on an explicit tap that shows the cost; no paid APIs anywhere.

---

## 1. Visual vocabulary — "visuals must literally depict what's said"

Chris's note on the proof film: on "you raised your baseline" the picture didn't look like a
floor rising. The cause was vocabulary: v1 had 10 props and no way to put things *on* a floor.

**Decision: an additive DSL v1.1 (still `dsl: 1`; every v1 film validates and renders the same).**

- **31 new procedural actors** (`src/remotion/world/{props,figure,sets}.tsx`): a faceless
  artist's-mannequin **FIGURE** (matte ceramic, gold ball joints — reads as "you" without being a
  character) with 13 blended poses and walk/run/climb cycles; **CROWD** (many vs one); **PLATFORM**
  (a solid floor whose top is `level`, glowing lip, front label, dashed "old floor" ghost);
  STAIRS, LADDER, BALANCE, DOOR (light spills out), WALLS (closing in), WHEEL (hamster wheel,
  rotation integrated from speed), SNOWBALL (rolls by distance), TREE (branching growth, coin
  leaves), BLOCKS (doubling), BUCKET (fills, leaks coins), HOURGLASS, CHAIN (snaps), FORK_PATH (two
  futures), MAGNIFIER + DOCUMENT (fine print), RECEIPT (unrolls), CALENDAR (pages flip), GAUGE,
  METER, DIVIDER (before/after), HOUSE, PHONE, BANK_CARD (original, unbranded), BAR/LINE/PIE
  charts as sculptures, TEXT_3D (layered-plane extrusion), ARROW. 3 new sets: CITY_NIGHT
  (procedural skyline), ROOM, HORIZON.
- **`parent`**: an actor rides on another's top surface (position relative to it, follows its
  rise). This is what makes "the floor rises UNDER your life" one line of DSL.
- **18 new actions**: SHIFT (relative move), POSE, WALK (pace-driven, faces its direction, cadence
  from distance), CLIMB (STAIRS step-by-step / LADDER hand over hand), PATH (Catmull-Rom, eased
  arc length), and 13 **semantic verbs** (OPEN CLOSE FILL DRAIN GROW BREAK TIP FLIP UNROLL REVEAL
  RAISE LOWER SPIN) mapped per kind in `VERB_TARGETS` — the author says what happens, the engine
  knows which param that is. A verb on the wrong kind is a validation error naming the kinds it
  fits (built for the repair loop).
- All deterministic: compiled into the evaluator's existing segment model (walks/paths/climbs are
  sampled into pos/rot segments), pure functions of (film, frame) — tested.
- **Assets/licenses:** everything is original procedural geometry and canvas textures generated
  by our code (manifest entry `procedural-actors`). No CC0 rigged character was added: the
  procedural mannequin covers poses/walks/sits/climbs without a third-party license or a download;
  a rigged Quaternius-style character remains the documented option if acting is ever needed.

**Semantic catalog** (`src/catalog.ts`): 92 entries — 41 actors, 27 actions, 5 sets and **19
recipes** (whole literal metaphors: raise-baseline, money-evaporates, spending-pulls-money,
climb-out, rat-race, walls-closing, leaky-bucket, snowball, compound-tree, doubling, break-free,
two-futures, fine-print, it-adds-up, time-passes, weigh-it, door-opens, many-vs-one,
before-after). Each has rich `depicts` + `goodFor` text, params, verbs, camera-friendly default
framing and a runnable example (`catalogExampleFilm`). Test-enforced: every kind/action/set has an
entry, every example validates and evaluates deterministically; every example was rendered
(`catalog/sheet-*.jpg`). Exported twice: `VISUAL_CATALOG` (engine shape) and `FILM_CATALOG` /
`getFilmCatalog()` (the crew port's shape, 138 entries incl. camera/lighting/transitions/text/
looks/SFX — the crew picks it up automatically).

**Meaning-Match helper ($0):** `matchLineToCatalog(line)` embeds with the crew's
`@chris/media/embeddings` LocalSentenceEmbedder (all-MiniLM-L6-v2, Apache-2.0, ONNX q8 ≈ 23 MB —
one model for the whole studio, not two), best of description + each good-for phrase, 15 %
keyword blend. Measured: "You raised your baseline." → recipe:raise-baseline 1.00 / PLATFORM
0.97; "Taxes take thirty-five percent." → money-evaporates 0.83; "running in place" → rat-race
0.82; "Break free from debt" → break-free 0.78; "Every month, the same bills" → time-passes 0.74
(~3 ms/line after a one-time ~1 s load).

## 2. "The Raise", re-cut

- **The twist** now shows exactly the words: you (FIGURE), your apartment, your car and the
  pedestal stand on a PLATFORM (`parent: "floor"`); on "raised" it RAISEs to 1.9 m and lifts them
  all; a dashed line stays on the old floor; the slab's face reads YOUR BASELINE; the figure
  steadies itself (BALANCE pose). "But here's the part nobody tells you" introduces you, thinking,
  beside the empty pedestal.
- **Subscriptions** cards at 1.9× (prices legible on a phone) and they shrink away on "Gone." —
  the literal disappearance.
- **Growth columns** no longer crop: the chart sculpture is shown at 62 % scale and every payoff
  camera is re-framed to its real height.
- Narration now pauses between sentences (§4).
- **Crew check:** the crew's free Meaning-Match first pass flagged the old film's baseline shot
  (plane rising THROUGH the apartment and car). The rule now understands PLATFORM/RAISE and
  `parent` riders; on the re-cut it flags nothing, and the original flaw (re-created by removing
  the riders) is still caught (`apps/web/lib/studio/proof-film.test.ts`).
- FINAL re-render on the Mac GPU: 39.7 s, 1190 frames, −14.0 LUFS / −1.5 dBTP, **113 s total**
  (narration 10 s, score+mix 6 s, picture 96 s = 2.4 s per film-second, assemble 1 s).
  Frames: `the-raise-v2/sheet-0{1,2,3}.jpg`. Output: `packages/cinema/.cache/films/the-raise/the-raise-final.mp4` (git-ignored).
- Honest critique: the twist reads clearly now, but the figure is small in that wide shot (≈ 1/7
  of the frame height) and the car is half-cropped at the right edge; the lifted world's top is
  dark — a stronger key light on the platform top would sell "a stage your life stands on" more.

## 3. Storyboards (cheap)

`renderStoryboard` renders only the chosen frames (Remotion `renderFrames({frames})` — one browser,
one page load), keyframe = the moment the shot's last action/text has landed (or 1–3 stills per
shot), at half size by default; each still is **measured** (`measureStill`: mean light, empty-frame
ratio, WCAG contrast per text band, safe-zone) and tiled into a **JPEG contact sheet with the
narration line under each still** (ChatGPT's vision review reads it). Per shot: timing + the words
it covers (measured from narration when `narrate:true`, else estimated).

| Host | 15-shot storyboard of The Raise (540×960 PREVIEW) |
|---|---|
| M1 Pro GPU (ANGLE/Metal) | **5.5 s** |
| M1 Pro CPU (SwiftShader, `REMOTION_GL=swangle`, 2 tabs) — the Sandbox proxy | **70 s** incl. bundling |
| Vercel Sandbox 8 vCPU (estimate ×1.25, bundle prebuilt) | ≈ 60–90 s → **≈ $0.03** of included credit |

So storyboards may run in the cloud when the Mac is off (within the included credit); on the Mac
they're seconds.

## 4. Narration

- **Voices:** all 28 English Kokoro voices auditioned on the same two sentences (q8) — Whisper
  intelligibility (all identical: 100 % of words; the 0.15 "WER" is just "$10,000" vs "ten
  thousand dollar"), pitch spread, voiced share, pace, high-frequency hiss
  (`voices/audition-all-28-q8.json`) — combined with the model card's grades. **Curated 9:**
  af_heart (default), am_michael, af_bella, bf_emma, bm_george, af_sarah, af_kore, am_fenrir,
  am_puck — samples `packages/cinema/assets/voice-samples/*.m4a` (48 kbps, −18 LUFS, 6–7.5 s).
  Excluded: D-grade voices, af_nicole (whispery ASMR: 22 % voiced frames, half pace), bm_fable
  (3–10× the hiss of the others). I can't listen; these are measured proxies — **Chris should
  play the 9 samples** (the crew's picker serves them).
- **Pauses:** a line is voiced sentence by sentence with `narration.sentencePause` (default
  0.32 s) between sentences; `[pause]` / `[pause 0.6]` in `say` adds a beat. Speed stays
  `narration.speed` (0.7–1.3). Kokoro has no other prosody controls.
- **q8 vs fp32:** not compared by ear. The fp32 model (326 MB) downloaded at ~30–60 KB/s on this
  connection (22 MB in 13 min); I stopped it rather than tie up the link for hours and removed the
  partial file. **Kept q8** (92 MB, ~1.4–1.6× real time on CPU, 100 % intelligible, the voice
  Chris already liked); `KOKORO_DTYPE=fp32` is supported for a later listening test (the
  Sandbox downloads fast, +234 MB in the snapshot if chosen).
- **Chris's own voice** (engine `CHRIS`): `narrationFromRecording` (one take of the whole script)
  or `narrationFromShotRecordings` (one per line) — Whisper word timings aligned to the script
  with Needleman–Wunsch (digits by value), ad-libs/fillers kept in the audio and reported, dropped
  words interpolated and reported, clips cut with a little air, < 60 % heard = "is this the right
  take?" (refused, nothing synthesized in his place). The picture is timed to his real words.
  UI: the studio film page's **Your narration** panel (record on the phone with MediaRecorder or
  upload a voice memo) → `POST /api/films/studio?action=narration` → a `film-voice-align` job
  pre-aligns and reports; renders pick it up automatically (or via the port's `chrisNarration`).

## 5. Rendering — $0 first, chunked cloud on request

**Pipeline split** (`src/render.ts`): `prepareFilm` (narration + timing + score/SFX + mix, once)
→ `renderFilmFrames` (one frame range, encoded straight to delivery quality — no mezzanine
re-encode) → `assembleFilm` (stream-copy concat + one mux; **verifies the frame count and that
audio and picture end together**, else `FilmAssemblyError`). `planChunks` = contiguous,
gap-free, near-equal ranges (property-tested), never shorter than 45 frames.

**Job kinds** (`apps/worker/src/film-jobs.ts`, one executor for local / Mac / Sandbox):
`film-render`, `film-render-chunk`, `film-storyboard`, `film-voice-align` (args/results in the
README; crew-compatible). Idempotent by a stable `renderId`; storage layout `films/<renderId>/…`
(manifest, film, clips, mix, chunks, result) so a crashed or timed-out render resumes with every
finished part. In the cloud the parent job enqueues N−1 `film-render-chunk` jobs (QUEUED;
started by the dispatcher's queue kick on every poll of the parent, and drained by finishing
workers), renders chunk 0 itself, **claims any still-queued parts of its own film** (no idle VM),
re-queues a failed part twice then renders it itself, and stops 4 min before its sandbox deadline
with "run it again to continue".

**Where it runs** (`apps/web/lib/film-jobs.ts startFilmJob`, used by the crew's dispatch):
1. **Chris's Mac render worker** when online (`pnpm --filter @chris/worker film-worker`, or the
   login item `scripts/mac/com.chris.film-worker.plist`; secrets in a git-ignored
   `.env.film-worker`). Presence = a `render-worker:<id>` JobRun heartbeat every 30 s (no schema
   change); film jobs are queued with `target: "mac"` and only the Mac worker claims them.
2. **Local dev** (`next dev` on the Mac): queued for the Mac + a one-shot worker child process (the
   engine never loads inside the Next.js server — same rule as the motion engine).
3. **Cloud only on an explicit tap**: a render waiting for the Mac shows "Render in the cloud
   instead (~N min, about $X of Vercel's included credit)" → `moveFilmJobToCloud` converts the
   same JobRun in place. Storyboards and "attach to Videos" may use the cloud automatically when
   the Mac is off (cents).

**Benchmarks / estimates (40 s FINAL film):**

| Host | Picture | Whole film | $ |
|---|---|---|---|
| M1 Pro GPU (measured: The Raise FINAL) | 2.4 s/film-s → 96 s | **≈ 2 min** | $0 |
| M1 Pro CPU swangle, 2 tabs (measured today: 60 FINAL frames, direct delivery encode, incl. bundle + browser start) | 42 s/film-s → ≈ 28 min | — | $0 |
| Built cloud runner, CPU swangle, 540×960 PREVIEW, 2 chunks (measured, this Mac) | 13.8 s/film-s incl. 2 browser starts | 63 s for a 4 s clip | — |
| Vercel Sandbox 8 vCPU, 1 worker (est. ×1.25 of the M1 CPU = 53 s/film-s) | ≈ 35 min | ≈ 37 min (close to the 45-min limit) | ≈ $0.84 |
| Sandbox, 4 parallel workers (default `HEAVY_JOB_MAX_SANDBOXES`) | ≈ 9 min each | **≈ 10 min** | **≈ $0.87** (upper bound: all 8 vCPU busy) |
| Sandbox, 8 workers (`FILM_RENDER_MAX_CHUNKS=8`) | ≈ 4.5 min each | **≈ 6 min** | ≈ $0.91 |
| PREVIEW tier, 4 workers | | ≈ 7 min | ≈ $0.54 |

(`estimateFilmRender` reproduces these; the Sandbox column is a scaled estimate ±30 % — the
cloud path was exercised with the built runner on this Mac, not in a sandbox, by instruction.)

**Registration** (`registerFilmVideo`): the finished film becomes a video through the normal
path, no state shortcuts — ContentItem (footage-first walk; the contract keeps STANDARD/MEDIUM so
the FACTUAL gate still applies) → RAW_TAKE `raw/<item>/film-<renderId>.mp4` → analyzed →
take selected → a no-cuts EditPlan (captions off — they're in the picture; no normalization —
it's mastered at −14 LUFS) → the normal render + technical QC → **RENDERED**. READY still needs
the quality gate like every video. Studio films: render first, then the crew's **Send to Videos**
creates the MINI_MOVIE item and the engine attaches the render (`film-render {attachRenderId,
contentItemId}` — never re-renders). Engine-only renders register themselves (format MINI_MOVIE).

## 6. Snapshot changes (not run against Vercel, by instruction)

`scripts/sandbox/build-runner.ts`: `kokoro-js` added to the npm externals (brings `phonemizer`
— eSpeak NG WASM — and the 28 English voice files); the **cinema Remotion project pre-bundled**
to `cinema-bundle/` (three.js, @react-three/fiber, postprocessing inside the bundle) with
`CINEMA_BUNDLE_DIR` in `run-job.sh`; `cinema-bundle/public` excluded from the upload and re-created
in the VM (`sandbox-setup.ts`, plus empty source-map stubs). `warmup` now also downloads the
Kokoro q8 model + tokenizer and the MiniLM embedder into `/vercel/sandbox/cache/transformers`.
Offline modes `film-render` / `film-storyboard`; `verify-offline.ts` renders a narrated 4-s
raise-baseline clip in 2 chunks in the VM. Verified locally: the built runner (`node
job-runner.mjs film-render --offline`, swangle, 2 chunks) produced a frame-exact, −14.1 LUFS clip.

**Operator:** rebuild the snapshot (`create-snapshot.ts --base <current>`), run
`verify-offline.ts`, set the new id, and add the film kinds to `RENDER_SANDBOX_KINDS`
(`film-render,film-render-chunk,film-storyboard,film-voice-align`) if cloud renders should be
offered. Snapshot grows ≈ +130 MB (Kokoro q8 92 MB, MiniLM 23 MB, cinema bundle ~5 MB, kokoro-js).

## 7. Tests

`packages/cinema/src/__tests__`: `vocabulary` (backward compat with the proof film and a v1 film;
RAISE lifts riders; WALK pace/facing/gait; CLIMB monotonic to the top tread; verbs → params; SPIN
integrated; validation messages; the proof film's twist lifts you/car/building/pedestal),
`catalog` (completeness, rich text, every example validates + evaluates deterministically,
keyword search), `chunks` (coverage property for many lengths × worker counts, estimates, **real
ffmpeg concat: frame-level identity of all 97 frames across 3 chunks, audio within one frame, a
missing chunk caught**), `narration` (sentence pauses + `[pause]`, the 9 voices with samples,
Chris-voice alignment with an ad-lib + a dropped word, wrong take refused, clips cut from an
uploaded m4a). `apps/worker/src/__tests__/film-jobs.test.ts` (throwaway DB, fake picture engine,
real assembly + real registration render: film → ContentItem RENDERED via the normal
transitions, idempotent re-run; chunked sandbox-mode render with queued parts claimed back;
a second worker rendering a part; crew-shaped storyboard/render + Send-to-Videos attach;
Chris voice align → render; invalid film; Mac targeting + heartbeat).
`apps/web/lib/studio/proof-film.test.ts` updated (fix accepted, flaw still caught).
`apps/web/lib/studio/studio-e2e.real.test.ts` (opt-in `STUDIO_E2E_REAL=1`): the whole studio with
the real engine — see §8.

## 8. End-to-end run (real engine)

`STUDIO_E2E_REAL=1 pnpm exec vitest run apps/web/lib/studio/studio-e2e.real.test.ts` — **passed,
148 s wall** (`e2e/studio-e2e-report.json`, `e2e/storyboard-sheet.jpg`, `e2e/render-sheet.jpg`):
the crew's pipeline on the throwaway test DB (PrismaFilmStore), the crew's demo answers standing
in for ChatGPT, `CinemaFilmEngine` → `heavyFilmDispatch` → `startFilmJob` (inline mode → queued for
"the Mac" + one-shot `film-worker` child processes, real Chrome/WebGL on the GPU, Kokoro af_heart,
Whisper, ffmpeg):
WRITE pack (contains the v1.1 vocabulary) → storyboard 1 (10 measured stills + captioned JPEG
sheet; the REVIEW pack carried it) → crew REVISE → storyboard 2 → APPROVE → Chris confirms the
facts → **real FINAL render: 32.1 s, 964 frames, −14.0 LUFS, −1.5 dBTP** (prepare/narration 34 s,
picture 85 s, assemble 7 s, review frames 2.4 s) → READY → Send to Videos (crew) → the engine's
attach job → MINI_MOVIE ContentItem **RENDERED** (take → no-cuts edit plan → normal render + QC).
Observations from the run, for the crew: the demo film's "flip" keyframe is a nearly empty frame
(camera on an un-grown chart) — exactly what `metrics.emptyRatio` exposes to the Quality bot; the
demo's baseline shot still uses the v1 BASELINE plane + MOVEs (valid; the v1.1 PLATFORM recipe is
the stronger picture).

## Reversibility

High. All DSL additions are optional fields; the job kinds are new; the domain additions
(`enqueueHeavyJob`, `getHeavyJobs`, render-worker heartbeat, `target`/`subjects` claim filters)
are additive with unchanged defaults; no migration. Turning the Mac worker off just queues film
jobs (they expire after 2 h like any queued job).

## Files

`packages/cinema/**` (schema, kinds, evaluate, validate, catalog, film-catalog, catalog-match,
figure-poses, chunks, render, storyboard, sheets, text-bands, narration/{voices,speech-text,
recording,narrate,kokoro}, remotion/world/{props,figure,sets,actors,World}, films/the-raise,
scripts/*, assets/voice-samples, README), `apps/worker/src/{film-jobs,film-worker,heavy-job-kinds,
heavy-jobs,job-runner,offline}.ts`, `packages/domain/src/job-run.ts`, `apps/web/lib/{film-jobs,
heavy-jobs,heavy-job-text}.ts`, `apps/web/lib/studio/{cinema-engine,heavy-dispatch}.ts`,
`apps/web/app/api/films/{file,studio}/route.ts`, `apps/web/app/studio/[id]/{page,FilmEnginePanel}.tsx`,
`apps/web/app/studio/actions.ts` (Send to Videos attaches), `apps/web/app/api/studio/voices/[id]`,
`packages/agents/src/studio/{film-types,meaning-match,deterministic,packs}.ts` (v1.1 awareness),
`scripts/sandbox/{build-runner,sandbox-setup,verify-offline}.ts`, `scripts/mac/com.chris.film-worker.plist`,
`.gitignore`, `pnpm-lock.yaml`.


## Rotation-aware media sizes + preview proxies v2 (2026-10-18)

Bug (Chris: "the graph does not even load"): iPhone takes are stored landscape with a 90° display
rotation. `probeMedia` saved the CODED size (e.g. 1920x1080), and the preview-proxy plan used it
while ffmpeg auto-rotated the frames — producing a squashed 1280x720 sideways proxy; the editor laid
the take out landscape and its clock stalled waiting on that video, freezing graphics on frame 0.
Fix: `probeMedia` returns the DISPLAY size; `makePreviewAssets` plans from `displayDimensions`;
the proxy job corrects stored width/height on existing takes; previews carry `v: 2`
(`PREVIEW_META_VERSION`) and v1 proxies are ignored by the editor (plays the original) and
regenerated by the background job when the editor opens. Tests: rotated fixture → 360x640 probe,
upright proxy.


## Graphics library 2 (2026-10-18)

**Why:** Chris wants the motion-graphics library to go far beyond finance charts — "a ton of
content and animations for like if you're on Google, TikTok, Apple, YouTube, as well as trending
on Twitter, or other things besides social media… as many as you could think of for video
content that would add value and visual hooks or even just visuals."

## Decision 1 — Same system, more base components (no one-offs)

Library 2 extends the existing `GRAPHIC` template (Graphics library decision, 2026-10-18): every
new graphic is a parametric **base component** reading the one shared, editable data model, and
every library entry is a **preset** (data). Nothing is a bespoke template.

- **33 new base components** (61 GRAPHIC components + 14 classic templates in total), in
  `packages/media/src/graphics/families/{social,phone,web,life,fx}.ts` (spec + design size per
  component; the header comment of each file is the field mapping per variant). Their specs are
  merged into `GRAPHIC_COMPONENT_SPECS`; `graphicDesignSize` delegates to the family sizers.
  - Search & web: SEARCH_BAR (typing + autocomplete / results / "people also ask" / command
    search), BROWSER (window / loading / 404 / cookie banner), WEB_CARD (link preview /
    encyclopedia box / review / product).
  - Social posts: SOCIAL_POST (short post / pro network / forum / photo post), COMMENT (reply
    sticker / pinned / thread / question box), TRENDING (ranked / hashtags / rising), VIDEO_CARD
    (tile / player + chapters / subscribe press / view counter), STORY (poll / question / slider
    / quiz stickers), SOCIAL_COUNTER (milestone / action rail / profile / live), BURST (floating
    hearts / double tap / rain / confetti).
  - Phone & apps: DM_CHAT (messages / DM / group / bubbles — typing dots, receipts, tap-backs),
    NOTIFICATION (stack / lock screen / banner), CALL (incoming / banner / video / missed),
    PHONE_APP (notes / reminders / inbox / email / invite), CLOCK_TIMER (alarm / timer /
    stopwatch / clock time-lapse), STATUS_ALERT (battery / no signal / alert / toast), APP_GRID
    (home grid with badges / dock / app listing), KEYNOTE (stage-style big number / title /
    specs / reveal on a plain black or white stage).
  - News & media: NEWS (breaking bar + ticker / headline / front page / highlighted article /
    clippings / "as seen in"), MEDIA_PLAYER (podcast / now playing / title card / voice memo).
  - Life & places: MAP_NAV (route + ETA / pin drop / flight arc / trip), WEATHER (now / week),
    SCREEN_TIME, PAYMENT (received / feed / receipt printing / declined), TRAVEL (ride /
    delivery / boarding pass / ticket), DATE (page flip / month crossed off / years / days
    until), TRACKER (habit grid / workout sets / mood), LIST_SPLIT (pros & cons / do's & don'ts /
    myth → fact).
  - Hooks, reactions & FX: VERDICT (MYTH/FACT/TRUE/FALSE stamps, big tick, big X, tape),
    HOOK_TEXT (comic POW / meme captions / POV / wait for it / plot twist / chapter), COUNTDOWN
    (3-2-1 / ring / flip digits / bar), QUIZ (question + reveal / poll results / stars / rate
    1–10 / this or that), SCREEN_FX (full-frame: glitch, film burn, light leak, speed lines, VHS,
    spotlight, punch frame, before/after split).
- **13 new 3D objects** on the classic ICON_3D template (TROPHY, ROCKET, LIGHTBULB, BRAIN, GIFT,
  KEY, MAGNIFIER, MEGAPHONE, CROWN, FIRE, LIGHTNING, TARGET, LAPTOP), procedurally modeled in
  `templates/three.tsx` with the existing studio lighting/material families and LINE fallbacks.
- **7 new categories**, chip order: Money & numbers · Charts · Comparisons · **Social posts** ·
  **Phone & apps** · **Search & web** · **News & media** · **Hooks & quizzes** · **Reactions &
  FX** · Timelines & steps · Lists & tables · **Life & places** · Text & titles · Callouts &
  annotations · 3D objects · Transitions & emphasis · Follow & CTA (the old "Social & CTA",
  relabelled; ids are stable).

## Decision 2 — The data model grows additively

`GraphicPropsSchema` gains `meta` (≤ 60, nullable — a time stamp, URL, app/source name) and
`tone` (AUTO / DARK / LIGHT; AUTO = the component's `toneDefault`); `GraphicItemSchema` gains
`side` (NONE / ME / THEM — conversations) and `meta` (≤ 40); `itemText` max 80 → 120 (longer
messages/comments). All default, so every saved timeline and all 171 earlier presets parse
unchanged (tested). Specs gain optional `uses.meta / tone / quick / ownFormat / labels`,
`items.side / meta / valueRequired`, `toneDefault`, `backdrop: "PLAIN"`; the edit sheet reads
them (Look: Auto/Dark/Light; per-component field labels — "Display name", "Handle", "Search
query"…; a Me/Them picker per message; meta inputs; the generic number-format section is hidden
where numbers are drawn in the component's own style, e.g. social counts "12.4K").
`graphicShownNumbers` lists `meta`/`item.meta` text, so the FACTUAL gate sees them.

The Motion Designer's strict model schema is unchanged (prompt version unchanged):
`meta`/`tone` are contract-only keys taken from the preset, and when the model supplies items,
the preset's per-entry `side`/`meta` are kept by position. The library catalogue in its prompt
is generated, so it now lists the new components and presets; the GRAPHIC guide line says to use
platform-style UI only when Chris refers to it and never to invent quotes/posts/messages or use
real brand names. The ICON_3D enum (contract **and** the model's strict schema + guide line) gains
the 13 new objects, so the model is never told about icons its schema would reject.

## Decision 3 — Brand-safe, no impersonation (hard rule)

All platform-like graphics are **generic "-style" UIs**: no official logos, wordmarks, trademarks,
verification badges, exact proprietary layouts, system fonts or signature colours (no bird/X
mark, no red play-button logo, no search-engine letter colours, no messaging-app blue — "me"
bubbles use the palette's accent). The platform feel comes from layout conventions and neutral
marks (a generic play glyph, a magnifier, initials avatars on gradients, original line glyphs on
tinted app tiles — `ui.tsx` `Avatar`/`AppTile`). Every name, handle, app name, outlet and URL is
an editable field; defaults are placeholders ("Your Name", "@yourhandle", "Alex", "Mom", "Bank",
"The Daily Ledger") with Chris-relevant sample copy. "As seen in" draws placeholder outlet names
as neutral type, never logos. Tags may contain platform words ("tweet", "google", "imessage") so
search works — the graphics themselves never show a brand. Numbers in presets are illustrative;
the Quality Gate still refuses ungrounded on-screen numbers, quotes are Chris's to supply.

## Decision 4 — Quick entry speaks three text dialects (deterministic)

`quick-entry.ts` `parseQuickText` / `applyQuickText` (+ `toQuickEntry` round-trip), selected by
`uses.quick`: **CHAT** `Me: running late | Mom: again?? | Me: rent went up $300` (Me = right,
other names = them with the name as sender, unlabelled lines alternate); **LINES** `1. Rent
prices 120K | 2. #budget — Trending in Finance 48K` (rank dropped, trailing count → value,
" — " → second line); **QUERY** `is a 401k worth it | …suggestions` (first group = query /
question, rest = entries; trailing numbers stay text when the component has no values). Numeric
quick entry is unchanged for every other component.

## Decision 5 — Search + suggestions

- ~35 new synonym groups ("google"→search, "tweet"/"x"→post, "text message"/"imessage"/"dm"→
  conversation, "notification", "news", "map", "subscribe", "viral/trending", "venmo"→payment,
  "uber"→ride, "boarding"→flight, "myth"→verdict…).
- `suggestGraphics` detects explicit language and pre-fills: "I googled is a 401k worth it" →
  SEARCH_BAR typing exactly that query; "my landlord texted me '…'" → DM_CHAT with the quote as
  their message; "breaking news: …" → NEWS with the headline; "went viral / trending" → TRENDING;
  "subscribe" (not "subscriptions") → subscribe press + follow CTA; "hit 100k followers" →
  milestone counter with 100k; myth/false/fact → VERDICT; "plot twist", "wait for it", "POV: …",
  "storytime", quizzes, "rate it out of 10", pros & cons, countdowns, weather, flights, a named
  city → pin drop, screen time, gym sets, streaks, podcasts, rides, "declined". Library-2
  suggestions resolve presets by component + variant (featured first), not by id.

## Decision 6 — Rendering

New families `packages/motion/src/remotion/graphics/{social,phone,web,life,fx}.tsx`, wired in
`registry.ts`; shared library-2 kit `ui.tsx` (tone colours with contrast-safe accents
`readableOn`, `card`, `Avatar`, `AppTile`, `socialCount`, typewriter/caret, typing dots, press/
ripple); 50 new original line icons (app glyphs, weather, OS, reaction faces, skull, 100…) —
never system emoji. Full-screen scenes honour `tone` (soft light studio backdrop) and
`backdrop: "PLAIN"` (keynote stage). Same performance rules as before (pure functions of the
frame, no React state/effects, no per-element blur, modest node counts) — the editor Player and
the server render draw the same components, so preview = render.

## Counts

| | Before | Library 2 | Total |
|---|---|---|---|
| GRAPHIC base components | 28 | +33 | 61 (+ 14 classic templates) |
| ICON_3D objects | 10 | +13 | 23 |
| Presets | 171 | +279 (263 GRAPHIC + 16 3D) | 450 |
| Categories | 10 | +7 | 17 |

New presets per family: social 56, phone & apps 61, search/web/news/media 46, life & places 53,
hooks/reactions/FX 47, 3D objects 16. Library chips at the end of the pass: Social posts 48 ·
Phone & apps 61 · Search & web 27 · News & media 19 · Hooks & quizzes 28 · Reactions & FX 27 ·
Life & places 47 (+ 6 in Lists & tables) · 3D objects 30.

## Evidence (verification)

- **Real renderer, every new preset:** `packages/motion/scripts/graphics-library.ts <out> --from=171
  --mid --posters=apps/web/public/motion-posters` (new `--from` flag) rendered all 279 presets
  (settled + mid-animation) through Remotion — **0 failures**, 113 s. Every settled frame and a
  sample of mid sheets were reviewed by eye (plus close crops at phone size). Fixes from that
  review: the video-call tile no longer takes an olive tint from the caller's name; brand names
  removed from preset copy ("Lambo", "reddit" in a search suggestion, "signal" as an outlet);
  one over-long pin subtitle shortened. Each family builder had already iterated its own frames
  (both tones, long text) before integration.
- **Posters:** 279 new posters (all 450 now exist; folder 5.4 MB).
- **MP4 samples** (alpha layer over a stand-in, frames checked): text thread (typing dots →
  bubbles → receipt), search typing + autocomplete + tap, breaking-news bar with looping ticker,
  100K follower milestone (odometer + confetti).
- **Editor at 393×852** (throwaway PGlite on 55491, `next dev` on 3471, Playwright): library
  shows "Search 450 graphics…"; every new category chip lists its presets with real posters
  (0 broken, 0 drawn fallbacks); searches "google", "text message", "breaking news", "tweet",
  "subscribe" return the right graphics first; inserting a text thread opens its edit sheet with
  Look (Auto/Dark/Light), contact/status/receipt fields, quick entry ("6 messages") and a Them/Me
  picker per message; 0 page errors.
- **Tests:** `pnpm typecheck`, `pnpm lint`, `pnpm test` green (1896 passed). New:
  `packages/media/src/__tests__/graphics-library-2.test.ts` (bounds, ≥200 new presets, original
  order intact, old props parse, tone defaults, canvas fit, meta in the factual list, **a
  brand-safety scan of every new preset's on-screen copy**, quick-entry dialects + round-trip,
  14 search synonyms, transcript suggestions incl. "subscriptions" ≠ subscribe); editor tests for
  the chat dialect, side alternation and inserting every new preset; the existing headless test
  renders every preset (incl. all new ones) at entrance/mid/settled/exit with no NaN.

## Not verified / known gaps

- Real iPhone playback of the heaviest new presets in the live Player (Chromium emulation only);
  particle/rain/confetti presets are capped at ≤ 40 particles but weren't profiled on a device.
- The motion designer was only exercised with the mock provider (no model call).
- Some fixed UI words are not editable (Decline/Accept, Snooze/Stop, Get/Open, "Subscribed").
- Short presets reach their settled look early (the 34 % "mid" frame is often already built).
- Two family files duplicate layout constants between the sizer (`families/*.ts`) and the
  component (phone chat metrics, life month table) — edit them together.

## Renderer / deploy note

The motion package changed (new components, new compositions per preset, new 3D models):
**the cloud renderer's snapshot / pre-built Remotion bundle (MOTION_BUNDLE_DIR) needs a rebuild**
before library-2 graphics render on the live site. Not done here (no Vercel changes).

## Reversibility

High: everything is additive (components, presets, optional fields, categories, synonyms).
Removing a family leaves saved graphics of that component unrenderable (the visual is reported,
not mis-rendered) — keep the components if Chris has used them. An old app build reading a
timeline that uses a library-2 component would reject that visual (unknown component).


## Editor rebuild (2026-10-18)

Chris (iPhone, Safari / home-screen app) said 3–4 times the editor is unusable: "it glitches, it's
not smooth, it doesn't show anything properly… it doesn't even work". Earlier fixes were measured
only in desktop Chromium and declared done. This pass measured in **WebKit** (Safari's engine) with
real-phone-like footage, found the root causes, rebuilt the preview, and measured again the same way.

## 0. How it was measured (so it can be repeated)

- **Fixtures** (made locally, not committed): iPhone-like vertical takes stored LANDSCAPE with a
  −90° display rotation — `4K HEVC 30 fps, 60 s, 31.5 Mbps` and `1080p H.264 60 fps, 40 s,
  23.8 Mbps` — real speech from macOS `say` with natural pauses, a moving test pattern with noise,
  a big frame number and a **12-bit frame barcode** burned into every frame.
- **Real pipeline**: upload bytes → `probeMedia` → the `ingest` heavy job (local Whisper → 720p
  preview proxy → automatic **style cut**: 13 clips / 9 clips) → Chris's typical edit on top:
  captions on, 5 library graphics (bar chart, text thread, 3D piggy bank, donut, 3D money stack),
  a zoom, a music bed.
- **Server**: `next build && next start` on :3791, throwaway PGlite on :55491, local storage.
- **Sessions** (Playwright, recorded on video): WebKit with the iPhone 15 descriptor (393×852,
  DSF 3, touch, iOS UA) and Chrome with mobile emulation + **6× CPU throttle**. Open → wait →
  play 22 s → pause → scrub the timeline → open/close a sheet.
- **Ground truth from the recording**: every recorded frame's barcode is decoded
  (`decode.py`) → which source frame was actually on screen → freezes (same frame ≥ 120 ms),
  frames of footage the edit REMOVED shown at cuts, real playback rate. Plus in-page signals
  (rAF gaps — Safari has no Long Tasks API —, long tasks, rVFC frames, media events) and the new
  health recorder's own counters.
- **Parity**: the same edit rendered by the real renderer (`render` heavy job), frames compared
  with paused preview frames at the same timestamps.

Scripts live in the session scratchpad (`er/`: `mkvideo.sh`, `seed.mts`, `run.mjs`,
`decode.py`, `cuts.py`, `report.py`, `shots.mjs`, `compare.py`, `longrun.mjs`), not the repo.

## 1. What was actually broken (evidence)

**F1 — Graphics: live Remotion DOM with CSS/SVG filters costs WebKit 0.5–1 s of main thread
PER FRAME.** Same edit, same machine: Chrome (even 6× throttled) plays at 49–60 fps; WebKit at
**6–11 fps with 4–5 s total freezes**. A/B in WebKit (rAF fps over 15–20 s of playback):
no graphics 30.1 (no stalls) · 2D graphics only 12.8 (≈1 s stall every second) · 3D only 19.8
(two 4.1 s stalls when the 3D scenes premount) · all 5: 2.6. Then with the graphics present, CSS
override experiments: `filter:none` alone → **30.0 fps, no stalls**; backdrop-filter off 13.8;
box-shadow off 20.6; text-shadow off 16.3. The graphics' glows/drop-shadows/blurs and the
per-graphic scene-integration SVG filter are rasterised on the CPU by WebKit every frame (at the
1080-wide composition size, scaled down). Chrome does them on the GPU — which is why every earlier
Chromium measurement looked fine.
Consequences on screen (recording, 4K edit, WebKit): the picture updated about **once a second**,
the first **7.8 s after pressing play nothing moved** (3D premount), the playhead overran a cut and
showed **25 frames of footage the edit removed** (one held for 1 s), playback ran at 0.73× real
time, and a 6-second scrub gesture took **82 s** to finish (rAF 2.6 fps).

**F2 — The two-`<video>` pool freezes in WebKit even without graphics.** With all graphics
removed, WebKit still froze the picture on one frame for **6.7 s** mid-playback while the
captions kept running (frame strip: `out/base-4k-novis-webkit/freeze-strip.png`) — the cut
handed over to the other `<video>` element and it never presented. The old engine's own
decision record already flagged "one run where the second element never presented a frame".

**F3 — Server Actions block each other.** Next.js runs Server Actions one at a time per client
(documented). The editor's footage analysis (`analyzeFootageAction`: scene stats + loudness
read from the **camera original** — in production that's a download of the whole original into a
function) ran as a Server Action on every open with graphics, so Save, the proxy poll and
everything else queued behind it.

**F4 — The preview was small.** On an iPhone 15 the 9:16 preview was **128×228 pt** (~27% of the
screen; less on a real device after the safe areas): a platform-switch row sat above it and the
timeline/transport took the rest.

Also seen: the proxy was downloaded twice per open by the two pool elements (2× ~20 MB on
cellular); "market return return" in captions is in the **render too** (transcript), not a
preview bug.

## 2. What changed (architecture)

**Compositor engine** (`apps/web/lib/editor/engine/*`, default where supported):
- **One canvas.** The take's 720p proxy (our own H.264, keyframe every 0.5 s, AAC, faststart) is
  downloaded once into memory (progressive; MP4 index parsed as soon as `moov` arrives — the first
  ~60 KB), demuxed by a small parser (`mp4.ts`), decoded with **WebCodecs VideoDecoder** (hardware
  H.264) and drawn with **WebGL2** (`gl.ts`) using the renderer's math: clip crop → punch-in zoom →
  grade (contrast/brightness → saturate → temperature gains, as a shader — no SVG filter over a
  video) → cos⁴ vignette. Baked graphics are composited in the same draw.
- **Decode-ahead across cuts** (`video-pump.ts`, `plan.ts`): the plan of source spans in output
  order is fed to the decoder ~2.5 s ahead; continuations keep decoding, jumps restart at the key
  frame before the span (≤ 15 frames of lead-in, dropped), B-frame reorder handled (re-tagging at
  continuation boundaries, flush before a switch to another take). The clock's frame is taken
  from a small queue — the first frame after a cut exists before the clock gets there.
- **One clock** (`clock.ts`, `audio.ts`): one AudioContext (48 kHz). Each take's AAC is decoded
  to PCM in ~4 s chunks as bytes arrive (ADTS-wrapped + decodeAudioData — works on iOS 15+;
  2 frames of pre-roll rebuild the MDCT overlap so chunks join cleanly). Every clip is a buffer
  source scheduled at an exact context time (4 ms ramps at hard cuts, none at continuations). The
  picture is slaved to the context clock minus output latency. Music bed + SFX share the context.
  iOS: `navigator.audioSession.type = "playback"` so the silent switch doesn't mute the preview.
- **Paused / scrubbing**: exact-frame decode from the previous key frame, frames shown as they
  improve (key frame first), new targets coalesced.
- **Instant reopen**: finished proxies are kept in the Cache API (newest 8).
- **Production storage**: proxies/bakes are read with `fetch()` through `/api/media` (302 to the
  private Blob URL). If the Blob origin refuses the cross-origin read, the engine re-requests
  `?stream=1` and the route streams the file same-origin. Which path ran is in telemetry.
- **Fallbacks**: no VideoDecoder / no WebGL2 / a take without its proxy → the `<video>`-pool
  engine (`select.ts`, pure + tested). WebGL context failure → remembers `video` on that device
  and reloads once. Kill switch: `?engine=video` (or localStorage `chris-editor-engine=video`).
- **Not in the compositor**: the person cut-out (behind-you graphics) needs a `<video>`; with
  the compositor those graphics draw in front with the existing "Depth shows in the export"
  note. Texts/captions stay in the SVG overlay (measured cheap in WebKit: 30 fps with captions,
  no graphics) — they carry the touch targets — driven by the same tick.

**Baked graphics** (`packages/media/src/graphic-bake.ts`, `apps/worker/src/graphics-bake-job.ts`,
`packages/motion` `renderVisualBake`): each graphic is rendered ONCE by the real renderer (the
same `VisualClip` Remotion composition the export uses) at half size, colour over stacked alpha
in one H.264 stream (keyframe every 15 frames, no B-frames), stored at
`bakes/<item>/<key>.mp4` (table `GraphicBake`, migration
`20261018120000_editor_health_graphic_bakes`, additive). The key hashes everything that changes
the pixels (visual minus id/absolute time, its interaction track, canvas, theme, fps, format
version) — moving a graphic in time keeps its bake; any other change is a cache miss
(tested). New heavy-job kind `graphics-bake` with its own lease subject (`bake:<id>`) so it never
makes Finish say "busy". Until a bake is ready (or when the editor runs the `<video>` engine)
the graphic is live Remotion in **lite mode** while playing/scrubbing (filters off — the
measured cause), full look after the playhead rests 0.5 s; the Player is now frame-locked to the
editor clock (no own clock, no 2-frame drift re-seeks); 3D scenes are no longer premounted at open.

**Non-blocking server work**: the footage analysis and the bake request/poll are Route Handlers
(`/api/editor/analyze`, `/api/editor/bakes`) — never queued in front of Save. The last analysis
per video is cached on the device, so reopening finds the bakes immediately.

**Layout (touch shell)**: the platform switch row is gone from above the preview (the switch is
in the Platforms sheet); an app chip + the warnings chip float beside the picture; timeline cap
236 → 220 px, transport 58 → 52 px. Preview on iPhone 15: **128×228 → 174×310 pt** (+85% area).

**Real-device telemetry** (`apps/web/lib/editor/health.ts`): the editor records open → first
frame → interactive, frames presented vs expected while playing (dropped frames), rAF stalls
(≥100/250/1000 ms), long tasks (where supported), video element events, decoder/media events,
scrub latency, JS errors (URLs stripped), memory where available, device facts and edit size.
Reports go to `POST /api/editor-health` (signed-in, schema-checked numbers/short strings only,
≤ 48 KB, append-only table `EditorHealthReport`, pruned to 400 rows / 30 days): 30 s after the
first play, every 2 min, when the page hides (sendBeacon), and on **"Something glitched"** (flag
button top-left of the preview on the phone, "Glitch?" in the desktop header) which snapshots
the last 20 s of events. Read them at **More → Editor diagnostics** (`/settings/diagnostics`).

## 3. Before / after (same scripts, same fixtures, same machine)

BEFORE = branch tip c2f9587. AFTER = this change (compositor engine). WebKit = Playwright WebKit,
iPhone 15 profile (its rAF runs at 30 Hz headless). Chrome = mobile emulation, 6× CPU throttle.
"Recording" columns are decoded from the session video (what was on screen).

| | 4K HEVC · WebKit | 4K HEVC · Chrome 6× | 1080p60 · WebKit | 1080p60 · Chrome 6× |
|---|---|---|---|---|
| navigation → first frame | 626 → 632 ms | 2259 → **1535 ms** | 525 → **455 ms** | 2225 → 2158 ms |
| navigation → interactive (play hydrated) | 220 → 360 ms ✗ | 971 → 1344 ms ✗ | 207 → 227 ms | 937 → 1250 ms ✗ |
| playback rAF fps (max gap) | 11.1 (4123 ms) → **30.0 (44 ms)** | 49.4 (67) → **59.9 (50)** | 6.0 (4893) → **29.9 (112)** | 49.7 (100) → **60.0 (17)** |
| frames presented / expected (engine) | — → **659/662 (0.5% dropped)** | — → 659/664 | — → 650/662 | — → 659/663 |
| recording: freezes ≥120 ms (longest) | 6 (7840 ms) → **0–1 (160)** | 1 (240) → 1 (160–200) | 6 (9400) → 1–2 (≤400, at play start) | 1 (160) → 1 (200) |
| recording: removed footage shown at cuts | 25 frames → **0** | 0 → 0 | 6 → **0** | 0 → 0 |
| recording: playback rate vs real time | 0.73 → **0.999** | 0.991 → 0.995 | 0.65 → **0.98** | 0.988 → 0.993 |
| long tasks while playing | n/a (Safari) | 13 (729 ms) → **0** | n/a | 1 (66 ms) → **0** |
| 6 s scrub gesture took / rAF fps | 81.8 s / 2.6 → **6.8 s / 30** | 6.0 s / 44.6 → 5.7 s / 58.4 | 78.2 s / 2.8 → **6.8 s / 30** | 6.0 s / 45.7 → 5.7 s / 58.2 |
| scrub → frame p95 | 4358 ms → **52 ms** | 76 → **22 ms** | 4432 → **53 ms** | 65 → **24 ms** |
| JS heap after session (Chrome) | — | 44.6 → **14.4 MB** | — | 59.6 → **13.5 MB** |
| JS on load (encoded) | 913 → 930 KB | | | |

Scrub "before" = scroll event → next presented `<video>` frame (rVFC); "after" = seek → exact
frame drawn (engine). WebKit without graphics (isolates F2): before one **6.7 s** frozen picture
mid-playback; after 0 freezes, 659/662 frames presented, rate 1.001.

`<video>` fallback engine after this change (WebKit, 4K, `?engine=video`, lite graphics): rAF
29.9 fps (was 11.1), but still 5 freezes up to 480 ms and 8 removed frames at cuts, 10.4% dropped —
which is why the compositor is the default.

**5-minute session** (Chrome, no throttle; 19 loops of play 12 s / scrub / sheet / full screen;
heap after forced GC): compositor 10.0 → 11.8 MB (max 12.8), DOM nodes 1168 → 507, 6620/6898
frames presented (4% dropped, unthrottled headless), 0 stalls ≥ 250 ms, scrub p95 12 ms;
`<video>` engine (same build, `?engine=video`) 10.0 → 18.7 MB, DOM nodes 1522 → 2281 (growing),
12.4% dropped, 14 long tasks. No memory API in WebKit — on the phone, telemetry reports it where
Safari allows (it mostly doesn't).

First-frame/interactive numbers are from navigation start (both columns). The first picture is
not faster locally (everything is on localhost; the old engine's win/loss here is network): the
compositor waits for the proxy's index + one key-frame decode. Interactive got **~20–40% later**
(more work at hydration: the engine, its AudioContext and the health recorder start then; +17 KB
JS). Not chased further in this pass — it's under 0.4 s in WebKit and the editor shows the
filmstrip poster meanwhile.

Note on the recording decoder: "removed footage" counts at cuts were checked by eye on the frame
strips — the 3 frames flagged in one 1080p run were barcode misreads under a graphic (true frames
290 → 292 | cut | 330 → 332, clips end/start at 294/328), see `out/final-1080-webkit`.

**Preview vs final render** (`out/parity-4k.png`): at 5.5 / 15.5 / 26 / 35 / 44 s the compositor
preview shows the same source frame (±1 frame from ffmpeg's seek rounding), the same graphics at
the same place and animation state (incl. both 3D objects), the same caption chunk and highlight.
Mean absolute RGB difference vs the render 10.8–14.8 (0–255; dominated by the preview's rounded
corners and 720p softness), old engine 9.8–12.7. Baked graphics are slightly softer (half size).

## 4. What could not be verified here — needs Chris's iPhone

1. Real Safari/iOS: hardware VideoDecoder throughput, AudioContext resume inside the play tap,
   `audioSession` on a muted phone, 60 Hz rAF. (Playwright WebKit is macOS WebKit, 30 Hz headless.)
2. Production Blob: whether the presigned Blob URL allows a CORS `fetch` (else `?stream=1`
   through the function — size/time limits of streaming a ~20–30 MB proxy through a Vercel
   Function are unverified). Telemetry reports `mediaPath` (direct / stream / cache).
3. **Bakes in the cloud need a snapshot rebuild** (new `graphics-bake` kind + `renderVisualBake`
   in the worker/motion bundle). Until then bakes are refused/fail in production and graphics stay
   on the live lite path (smooth, filters off while playing). Local bake time: ~8–10 s per graphic.
4. Takes with no v2 proxy run the `<video>` engine (by design) — the diagnostics page shows the
   engine and reason per session.
5. Memory over a long session on the phone (Safari kills heavy tabs silently): the PCM and proxy
   bytes are held in memory (~25 MB + ~20–30 MB per take).

## 5. How Chris uses it

- Nothing to do: the editor picks the new engine itself. If anything looks wrong, tap the small
  **flag** button at the top-left of the preview right after it happens — it saves the last 20 s.
- **More → Editor diagnostics** lists every editor session: first picture time, smoothness
  (dropped frames, freezes), scrub delay, errors, device, and the engine that ran.
- Escape hatch: add `?engine=video` to the editor URL for the old engine.

## Reversibility

High. `?engine=video` / localStorage switches back per device; `select.ts` is one function. The
two tables are additive and only used by the editor; dropping bakes leaves the lite live path.
Renders are unchanged (bakes are preview-only; `renderVisualBake` is a new export).


## Cloud worker uses the system ffmpeg (drawtext) (2026-10-18)

The studio's storyboard failed in production: "No such filter: 'drawtext'" — the Linux
ffmpeg-static build has no FreeType, so storyboard contact sheets (and any on-screen Text
overlay in final renders) could not draw text in the Sandbox. The snapshot now apt-installs
`ffmpeg` (FreeType/libass) and `run-job.sh` exports `FFMPEG_BIN=/usr/bin/ffmpeg` when it has
drawtext; `FFMPEG_PATH` honors `FFMPEG_BIN` (falls back to ffmpeg-static locally). Snapshot
creation now fails unless drawtext works. `create-snapshot --base X --from system` re-runs apt.


## Full edit (free) (2026-10-18)

Chris: the automatic edit only removed pauses. He wants two automatic choices in the editor — the
current **Cuts only** style cut, and a **Full edit** that is 80–100 % done, **$0** (no Anthropic,
no paid API), with a viral hook first, a tight story said once ("just because I film for 5
minutes does not mean I want it that long… like a conversation where you only need to say things
once… I GAVE YOU REFERENCE VIDEOS"), and graphics from the library matched to what he says. A
paid **AI edit** may come later as a third option. To be merged into `/docs/DECISIONS.md`.

## Decision 1 — Pure deterministic core + local embeddings, in `packages/media/src/full-edit/`

`buildFullEdit(input, embedder)` (pure; browser-safe; the only async part is the injected sentence
embedder) runs the "bots" as code:

| Bot | File | What it does (all deterministic) |
|---|---|---|
| Understand | `understand.ts`, `numbers.ts` | Sentences (Whisper punctuation + measured pauses ≥ 0.7 s); beats from cue phrases (greeting, meta, setup, point, example, number, list step, payoff, CTA, sign-off, tangent, recap, fluff); numbers he said with their word span (digits and spelled out; plan names/years skipped); delivery energy from a 100 ms loudness envelope; topic keywords; topic centrality = cosine to the take's centroid (local MiniLM). |
| Hook | `hook.ts` | Scores every remaining sentence (and a short line + the line that continues it) with evidence: real $/% numbers, contrast/stakes words, bold claims ("most people", "nobody"), "you", question, imperative at the start, 4–16 words, delivery energy, topic centrality; penalties for starting mid-thought ("So/But/And…", pointers), hypotheticals, list steps out of context, the ending (opening on it spoils the payoff) and **no clean pause to cut on (disqualifying)**. Up to 6 candidates (typed, with reasons) for "Try another hook". Moving a line is only done when it beats the natural first line by ≥ 0.6. |
| Hook title | `hook.ts` | ≤ 8 words, from his words/numbers only: "The $10K raise" (number + the noun he said with it), "$5K → 20 years", "2% vs 5%" (only when he compared them), his own question, his opening imperative, his strongest claim clause. The brand's avoid list (`brand/CHRIS_BRAIN.md` + clickbait) is enforced (`TITLE_AVOID`). 3 alternatives, swappable in the editor. Placed above his face when there's room, else between chin and captions, inside the platform-safe area; may cover hair, never the face. |
| Story | `story.ts` | See Decision 2. |
| Visuals | `visuals.ts` | Candidates from `suggestGraphics` (pre-filled with his numbers), list steps as tags in his words, his CTA as a CTA bar. Meaning match = MiniLM cosine (line ↔ preset name/description/tags). **Verification (hard):** every number a graphic shows (`graphicShownNumbers` + digits in its text) must be said **in the line it appears on** (continuity) — a preset whose placeholder numbers survive is dropped; text fields not made of his words are blanked or the graphic dropped. Never a FULL-screen graphic (would hide his face). Density ≈ one per 8 s, ≥ 2 s apart, none during the hook, one per line, variety (each repeat of a preset −0.5). Timed to the number word, held long enough to read (1.4 s + 0.22 s/word). |
| Quality bots | `index.ts` | Placement through the existing engine (`solveVisualPlacements`: face/captions/UI as hard obstacles); a graphic with no clear spot is swapped for the line's next-best graphic and re-checked (bounded, 6 rounds). Retention: a stretch > 7 s with nothing changing on screen gets a slow push-in (bounded). Checks reported (typed `FullEditCheck`): Meaning match, Numbers verified, Continuity, Fact source, Story & pacing (shot lengths vs references, arc), Quality (title vs face, text size, caption collisions via `findTimelineCollisions`, −14 LUFS), Retention (labelled **estimate**). |

Assembly reuses the style cut: `buildStyleCutFromRanges` (new, in `style-cut.ts`) cuts each kept
source range like a take (pause tightening from measured silences, face-centred punch-ins,
frame-aligned clips) and concatenates them in story order (the cold open jumps back). Range edges
sit in the measured pause **where Whisper puts the gap** (best overlap with the word gap, not the
longest nearby pause — the first version cut in the pause *before* "Anyway." and kept it).

## Decision 2 — Condensing: say it once, cut the fluff, fit the references' length

1. **Mechanical:** retakes/false starts keep the LAST complete take (prefix match or ≥ 60 % word
   overlap within 2 lines); restarts inside a line ("a lot of people, uh, a lot of people"), filler
   words, throat-clearing lead-ins ("So basically, I think, I don't know, …") — only when **both cut
   points are on a measured pause** (no clipped words).
2. **Say it once:** MiniLM alone measures *topic*, not *point* — measured on the 3-minute take,
   different points about "the minimum payment" scored 0.70–0.77 while true restatements scored
   0.31–0.63. So similarity is **topic-centred** (each vector minus the take's mean) and combined:
   `0.5·centred cosine + overlap of non-topic words + 0.15 if ≤ 2 lines apart + 0.15 for a
   restatement cue ("basically", "it really is", "in other words", "again"…)`, threshold 0.62 near /
   0.75 far, and the shorter line must add ≤ 1 new word (a line with a new number or claim is a new
   point). The best version stays (most concrete, complete, best delivered).
3. **Fluff out:** greetings, "this video is about…", recaps, sign-offs, tangents ("by the way",
   "funny enough", "one more thing… that's a whole different video") + their continuation lines,
   transition lines ("Anyway, where was I?"), reassurance lines ("I know that's a lot", "it's not
   that complicated"), extra CTAs (one is kept). A tangent with an on-topic number is kept and
   flagged instead.
4. **Start on the hook:** weak set-up/teaser lines before the hook go ("Slow start"); a real claim or
   number before it stays and the hook becomes a **cold open** (moved, played once — replayed in place
   only if the next line points back at it).
5. **Length:** target = the reference videos' median length (`StyleProfile.durationS`, p25–p75 band;
   defaults 58 s / 45–70 s with < 3 references) via `storyTargetFromProfile`. The lowest
   value-per-second units go first (value = beat + topic centrality + real numbers − hedging), a list
   (first step → last step, with its explanations) is one unit, the hook / a context line / the last
   payoff / the CTA are protected, and a line that points back ("That's how they make money") never
   survives without its antecedent (drop both, or keep both when the pointer is protected). If the
   real cut still runs long, the story is re-planned with a lower goal (≤ 4 passes).
6. Every removal carries a kind + plain-English reason; the editor lists them ("Removed lines") with
   one-tap **Restore** (`choices.forceKeep` → new version).

## Decision 3 — Wiring (same rules as the style cut)

- `packages/domain/style-cut-plan.ts`: `plan.fullEdit` (`StoredFullEdit`: summary, typed report,
  choices, cached silences + loudness envelope), `recordAutoFullEdit` (same CAS + advisory lock +
  idempotency + audit as the auto style cut; reason "Full edit (automatic, no AI)"),
  `saveFullEditChoice` (finishing edit = new version), eligibility also replaces an earlier AUTO full
  edit, never anything Chris saved. Choosing Cuts only / plain clears `fullEdit` on that version.
- **Setting** "New uploads get: Full edit | Cuts only" in the Auto edit sheet = feature flag
  `auto_edit.cuts_only` (absent/off → **Full edit is the default**, per Chris). Kill switch
  `FULL_EDIT_AUTO=off`. A multi-part recording gets the style cut (the full edit is one-take). Any
  full-edit failure falls back to the style cut (never leaves him with nothing).
- `apps/worker/style-cut-job.ts`: `maybeAutoStyleCut` runs the full edit when the mode is FULL;
  `applyStyleCutChoice(…, "FULL", choices)` for the editor. Embeddings: local
  `Xenova/all-MiniLM-L6-v2` via `@chris/media/embeddings`, degrading to the hashed-word embedder (id
  says so) if the model can't load; `FULL_EDIT_EMBEDDINGS=lexical` forces it (tests).
- Editor: the "Style cut" tool is now **Auto edit** (phone toolbar + desktop tab): Full edit (free) /
  Cuts only / AI edit (disabled, "Needs AI credit — coming later"); summary ("Hook: '…' (moved to the
  start) · 3:22 → 1:00 · kept 17 of 45 sentences · removed 1 repeat, 2 retakes, 20 fluff lines, 5
  tangents…"), Try another hook + all hook options with reasons, hook-title chips (local edit),
  per-graphic Remove (local edit), Removed lines + Restore, checks.
- **Render parity:** visuals are AUTO-placed by the same engine the renderer re-runs
  (`resolveVisualPlacements`) — unit-tested to be a no-op on the full edit's output; evidence renders
  used the worker's own `prepareMotion` (Remotion layer + SFX kit) + `renderTimeline`.
- **FACTUAL gate unchanged:** an on-screen number still needs a research/script source before
  publishing. The full edit only shows numbers he said, but a video without a gated script/research
  will get a FACTUAL block for them — the "Fact source" check says so up front. (Alternative
  rejected: treating his transcript as a source — that would quietly weaken a hard gate.)
- Music: none — the repo has no licensed track that is a MediaAsset; SFX come from the procedural kit
  (entrance pops/ticks, one soft whoosh at the cold-open cut).

## Extension point — the AI edit (later)

`buildFullEdit` is the executor + checker; an "AI edit" only needs to supply better *decisions*
(hook index / custom hook span, story keep/drop per sentence with reasons, graphic picks) through
the same `choices`/report shape, and everything after (assembly, placement, verification, checks,
versioning, editor UI) is reused. Nothing in this feature calls a paid model.

## Honest quality ceiling (free/local vs an LLM)

- **Better than expected:** retakes, greetings, sign-offs, tangents with cue phrases, recaps, filler
  lines, slow starts, list integrity, dangling pointers, length fitting, number grounding, clean cuts.
- **Weak spots an LLM would fix:** paraphrase detection without lexical overlap (MiniLM is
  topic-dominated; a restatement with all-new words survives); tangents without a cue phrase; judging
  *which* claim is the most surprising (scoring is keyword-based — "Nobody starts with $18,000" wins,
  but a subtle insight with no numbers or contrast words won't); titles are templates, not
  copywriting; graphics are chosen per line by rules (no cross-line story graphics like a running
  comparison); Whisper mis-hearings ("raise" → "race") flow into titles/captions.
- **Space for graphics** around a centred head is small under the existing platform-safe zone: big
  components (month grid, steps list, charts) usually have no clear spot and get swapped for compact
  ones (big number, stat card, step tags, CTA bar). Step tags/CTA bars are small type (~28 px).

## Evidence (`docs/evidence/2026-10-18-full-edit/`)

Test takes: macOS `say` monologues over a moving portrait framed like an arm's-length selfie (eyes
≈ 1/3 height), real Whisper `base.en`, real face tracker, real silence/loudness analysis, live
reference profile numbers (60 s median, 44–71 s). Renders with the real renderer (Remotion layer +
ffmpeg), audio checked at every splice (speech-level energy within 30 ms of a cut = a clipped word:
**0 of 50 splices** across the four full edits), and the output re-transcribed by Whisper to prove
what is heard.

| Take | Cuts only | Full edit | Hook (why) | Graphics |
|---|---|---|---|---|
| t1 raise (63 s; greeting, restart, teaser, tangent, list, CTA) | 53.0 s | **34 s**, kept 13/18 | "My friend got a $10,000 raise last year." — real $ amount, short, stakes; slow set-up lines dropped so the video starts on it | $400/month big number, 3 step tags, CTA bar |
| t2 401(k) (62 s; meta intro, sentence retake, tangent, comparison) | 49.5 s | **30 s**, kept 9/14 | "Most people leave free money on the table every single year…" — bold claim + stakes (5.08 vs 3.30) | $3,000 big number, 2% big percent, CTA bar ("Comment match") |
| t3 emergency fund (47 s; meta, restart "it's, um, it's", tangent, steps, CTA) | 40.4 s | **29 s**, kept 12/16 | "Nobody starts with $18,000." — cold open (moved from 12 s), bold claim + number | $3,000/month, 3 step tags |
| t4 rambly credit-card monologue (**3:22**, 45 sentences: restarts, repeats, two tangents, recap, reassurance, sign-offs) | 2:49 | **1:00**, kept 17/45 — removed 1 repeat, 2 retakes, 20 fluff/slow-start lines, 5 tangent lines, 1 for length | "20 years. For $5,000." — cold open; title "$5K → 20 years" | $5K stat card, $8K, $50 big numbers, CTA bar |

**t4 heard after the full edit (Whisper on the output):** "20 years for $5,000, I actually ran the
numbers on this last week because I was curious. If you owe $5,000 at 24% interest and you only pay
the minimum, it takes you about 20 years to pay it off and you pay almost $8,000 in interest. So the
minimum payment is designed to keep you in debt. The longer you're in debt, the more they make, what
do you actually do about it? Okay so first, pay more than the minimum, even if it's just $50 more,
$50 a month extra cuts years off the payoff. Second, pay the card with the highest interest rate
first. That's called the Avalanche method. Third, and this one is important. Stop using the card
while you're paying it off. Because if you keep using it, you're just, you're filling the bucket
while you're trying to empty it. So the bottom line is, the minimum payment is the most expensive way
to pay off your card. Pay it down faster and keep the interest for yourself. If this helped, follow
for more." (Before: `t4.txt`, 3:22 — greeting, "this video" meta, three set-up restatements,
"kind of insane", gym tangent ×3, "where was I / Right", "designed to keep you in debt" said twice,
"biggest traps" said twice, recap, "I know that's a lot", "not that complicated", balance-transfer
tangent, "And, ah, yeah. That's it. See you guys.")

Editor at 393×852 (throwaway PGlite + dev server on 55471/3671): upload → captions → the editor
opens on the automatic Full edit with the toast; Auto edit sheet (`shot-2-sheet.png`), Removed lines
(`shot-3-removed.png`), Restore (0:29 → 0:30, the line is back), Try another hook (new version, new
hook), Cuts only (new version) — all saved versions, undoable.

## Not verified

Real iPhone footage of Chris (only `say` + a portrait); real reference re-measurement (profile
numbers taken from the live 2026-10-17 measurement); the Vercel cloud path (web-side trigger without
measured silences uses Whisper-gap cuts until the cloud ingest refreshes — same as the style cut;
MiniLM inside a Vercel function untested — falls back to the word embedder); the Quality Gate's
FACTUAL behaviour on a published full edit (unchanged code, see Decision 3).

**Snapshot:** `apps/worker` changed (ingest/transcribe → full edit; `analyzeTakeAudio`) → the Vercel
Sandbox snapshot must be rebuilt before the cloud ingest job produces full edits. No new binaries;
MiniLM is fetched to the transformers cache on first use (~23 MB).

## Reversibility

High. No migration (JSON on EditPlan rows + one feature flag). `FULL_EDIT_AUTO=off` or the sheet's
"New uploads get: Cuts only" returns to the old behaviour; every full edit is an ordinary version
(Cuts only / full take / any earlier version one tap away).


## Close-up placement: protect the face core, never full-screen cutaways (2026-10-19)

Chris on real selfie footage: graphics were dropped ("no spot clear of your face") and my
same-day fallback (turn them into full-screen cutaways) covered his whole face — "so trash… it
places the animation over the ENTIRE screen". Removed the cutaway fallback entirely. Instead the
placement solver (shared by preview and renderer) uses `protectedFaceRect`: when Chris's face is
TRACKED and the protected head region fills ≥45% of the platform-safe area (a selfie close-up),
only the eyes→mouth core is a hard obstacle — graphics may sit smaller over hair/forehead or
beside the cheeks. Wider shots and untracked takes keep full head protection.


## Owner quality override (2026-10-19)

**Decision owner: Chris (the human owner).** This is Chris's decision as owner, recorded as such:

> "Without the AI final quality checker — since I don't have credits yet — allow it to bypass to
> the calendar… allow the option for it to bypass quality or to be firm."

Spec §5 puts the human owner (#1) above the hard gates (#2). Until now the only path from
RENDERED to READY was the Quality Gate, whose Visual QA step is a model call — so with no AI
credit, Finish rendered and then stopped at "out of credit", and no video could ever reach the
calendar.

## What was built

An explicit, logged **owner override**, not a weaker gate.

1. **Setting** — "Quality check before scheduling": **Firm** (default; today's behaviour) or
   **Let me skip it**. Stored as feature flag `quality.owner_may_skip_ai_check` (setFlag → audit
   row on every change). Two places: More → **AI credit** (`/settings/ai`, a "Quality check
   before scheduling" panel with both choices explained) and inline in the **Finish** sheet (a
   Firm / Let me skip it switch, plus "Skip the AI check for this video" when skipping is on).
2. **Always runs (free, deterministic, never skippable)** — the TECHNICAL gate exactly as the
   Quality Gate computes it (shared code, `runDeterministicChecks` in
   `apps/worker/src/quality-gate-job.ts`): the render exists and its stored technical QC
   (`Render.technicalQCReport`: file valid, duration/resolution/codec/loudness within platform
   specs, no missing media) PASSes, and no BLOCKING on-screen collisions (text over text,
   captions over text). A technical BLOCK still blocks: `skipAiQualityCheckForContentItem`
   returns `TECHNICAL_BLOCK` and the video stays RENDERED. The editor's safe-zone warnings stay
   warnings, as before.
3. **What the override skips** — the AI-powered checks: Visual QA (the model call), the brand /
   voice and creative thresholds (Brand Guardian scores — "none on record" when no AI ever ran),
   and the AI fact-check (Claims Gate verdict). Each skipped check is recorded with why.
4. **When** — only while the setting is "Let me skip it", and only when either the AI can't run
   (no key / out of credit / spend cap — `aiUnavailableReason`, and `aiReadiness` checks this
   up front so Finish doesn't boot a check that can only fail) or Chris ticks "Skip the AI check
   for this video". Then Finish goes render → free technical check → READY → schedule.
5. **Record** — `applyOwnerQualityOverride` (`packages/domain/src/quality-override.ts`), one DB
   transaction:
   - `DecisionJournalEntry` — question ("Put "<title>" on the calendar without the AI quality
     check?"), decision "Owner skipped AI quality check", alternatives (wait for credit; keep
     editing; leave it off the calendar), rationale (the reason, e.g. out of credit; what was
     skipped; that the technical check passed on render X; the numbers Chris vouched for),
     decision owner "Chris (owner)", `userOverride: true`, evidence = the render id, timestamp.
   - `QualityOverride` row (new table, migration `20261018130000_quality_override`, additive) —
     render, trigger, reason, technical status (always PASS) + findings, skipped checks,
     unverified claims, `factualConfirmed`, journal id, actor.
   - `AuditLog` `QUALITY_AI_CHECK_SKIPPED_BY_OWNER` (actorType HUMAN).
   - `ContentStateTransition` RENDERED → READY, actorType HUMAN, reason "Owner override: skip AI
     quality check (<reason>); technical check passed", idempotency key per render (a retry is a
     no-op).
6. **Factual gate** — the owner outranks it, but must attest per video: when the FACTUAL gate
   can't pass on its own and the video shows numbers without a verified source, Finish lists
   them (graphic numbers not in the research/script, on-screen text with numbers, spoken lines
   with numbers — captions on or off — and any Claims Gate BLOCK reason) and requires
   **"I've checked the numbers in this video"**. Without it the override refuses
   (`FactualConfirmationRequiredError`). The list and the confirmation go in the journal.
7. **Honest mark** — the video page shows **"Scheduled without AI quality check"** (badge + a
   panel saying why, when, and whether Chris confirmed the numbers); the calendar shows "· No AI
   check" on the day list, in the month chip tooltip and in the event sheet. When the AI is
   ready again the panel offers **Run the AI check now** (optional; see below).
8. **Publishing** — scheduled overridden videos publish as scheduled. Preflight's approval rule
   (`renderPublishApproval`) accepts a passing QCReport **or** the owner's override for that
   exact render; every other preflight check still runs (state, schedule, credentials, media
   hash, media spec, packaging). Autonomous publish goes through the same preflight, so it also
   treats the override as approval. The override does **not** count toward autonomy
   (`recordApprovedOutcome` is only called for a real clean gate pass) — an unchecked video is
   not evidence the edit planner is reliable.
9. **Firm** keeps today's behaviour exactly, with a clearer message: "The AI check needs credit —
   switch to "Let me skip it" in Settings (More → AI credit) or add credit. Your edit is saved and
   rendered." The stopped sheet also offers "Let me skip it & schedule" (flips the setting —
   audited — then runs the override).

## Authority & invariants kept

- `aggregateHardGates` is untouched; no QCReport is written claiming the AI gates passed. The
  override is a separate, explicit human decision with its own row — not aggregation, so a
  creative/brand score still cannot average away a BLOCK.
- The bare-button guarantee stands: `MANUAL_TRANSITIONS` still has no path into READY
  (`listManualTransitions("RENDERED")` is empty — test). The override is listed in a separate
  `OWNER_GUARDED_TRANSITIONS` allowlist that `applyManualTransition` ignores; it only succeeds
  through `applyOwnerQualityOverride`, which re-checks the stored render (latest, has a file,
  technical QC PASS) — the `TechnicalGatePass` input type can't even express a BLOCK.
- "Run the AI check now" (`runQualityGateForContentItem(..., { lateCheck: true })` →
  `recordLateQualityCheck`) records a normal QCReport for that render with no state change. A
  PASS clears the mark; a BLOCK supersedes the override in preflight (a real hard-gate finding
  still blocks publication) and the video page says so ("It won't post until it's fixed").

## Alternatives considered

- **Write a QCReport with PASS for the AI gates** — rejected: a false record; the audit trail
  would claim checks that never ran.
- **Add a SKIPPED value to `HardGateStatus`** — rejected: touches the aggregation types every gate
  uses and invites "SKIPPED counts as PASS" bugs; a separate owner-decision row is clearer.
- **A bare "Mark ready" button (MANUAL_TRANSITIONS)** — rejected: exactly the 2026-10-16 bug
  (one click past all four gates, no technical check, no record).
- **Override even a technical BLOCK** — rejected: the owner outranks the gates, but a broken or
  out-of-spec file can't be posted; that check is free and deterministic.
- **Detect non-numeric factual claims** — not possible deterministically; the confirmation is
  triggered by unverified numbers and Claims Gate BLOCK verdicts, and the journal records that
  the AI fact-check was skipped.

## Verified

- Tests: `packages/domain/src/__tests__/quality-override.test.ts` (Firm refuses; journal/audit/
  HUMAN transition rows; idempotent; numbers confirmation; technical FAIL / stale render / lying
  caller refused; bare-button guarantee; schedule + preflight after override; late check BLOCK
  supersedes, PASS clears; `aiUnavailableReason`), `apps/worker/src/__tests__/quality-override-job.test.ts`
  (Firm refuses; no-numbers → READY + preflight; on-screen numbers need confirmation; overlapping
  text = technical BLOCK; `listUnverifiedClaims`), `apps/web/lib/editor/finish-quality.test.ts`
  (Finish decisions: Firm never skips; skip when AI can't run / ticked; failure → skip / firm stop
  / error).
- End to end at 393×852 (Playwright, iPhone-sized touch context) against a throwaway PGlite DB +
  `next dev` on non-default ports with **no AI key**, real local render of a 9 s portrait take
  (`docs/evidence/2026-10-18-quality-override/`):
  - **Firm** (default): Finish → saved → rendered → "Quality check" fails with "The AI check needs
    the AI service, which isn't set up (no Anthropic API key) — switch to "Let me skip it" in
    Settings…", plus a "Let me skip it & schedule" button (`1-firm-form`, `2-firm-stopped`).
    The video stayed RENDERED.
  - More → AI credit → "Let me skip it" (`4-settings-skip`; flag change audited, actor HUMAN).
  - **Skip**: Finish (`5-skip-form`: the tick is on and locked because the AI can't run) →
    rendered → free technical check passed → "Check the numbers first" listing the three spoken
    lines with numbers ("401k", "2026", "24,500 dollars") (`6-confirm-numbers`) → ticked "I've
    checked the numbers" → "It's on the calendar" + "Scheduled without AI quality check"
    (`7-done-badge`). Calendar day list "· No AI check" and the event sheet line
    (`9-calendar-sheet`); video page badge + panel (`11-video-page-panel`).
  - DB after the run: QualityOverride (AI_UNAVAILABLE, "No Anthropic API key is set up",
    factualConfirmed, 3 claims, 4 skipped checks), DecisionJournalEntry (userOverride, "Chris
    (owner)", full rationale), AuditLog `QUALITY_AI_CHECK_SKIPPED_BY_OWNER` + `OWNER_QUALITY_OVERRIDE`
    (HUMAN), transitions EDITING→RENDERED (SYSTEM) → READY (HUMAN, "Owner override: skip AI quality
    check (No Anthropic API key is set up); technical check passed") → SCHEDULED (HUMAN).
  - (Screens were taken just before a copy tweak that stopped lower-casing the reason, e.g.
    "(No Anthropic API key is set up)".)
- `pnpm typecheck`, `pnpm lint`, `pnpm test` (182 files / 1963 tests) green.

## Not verified / gaps

- The live site (Vercel + cloud worker): the skip path itself runs in the web function (DB reads +
  layout arithmetic, fonts are already shipped), and with skipping the cloud render job is
  started with `thenQualityGate: false` — **no snapshot rebuild is needed for the override**. The
  optional **"Run the AI check now"** uses the cloud `quality-gate` job's new `lateCheck` arg,
  which **needs a worker snapshot rebuild**; until then the old worker ignores it and the run
  fails harmlessly (the gate refuses a non-RENDERED video) with no state change.
- Plain (non-timeline) edit plans: spoken numbers aren't listed (only on-screen overlays); all
  Finish-made videos are timelines.

## Reversibility

High. Set the setting back to Firm (one tap; nothing can be overridden while Firm). To remove the
feature: drop the Finish/settings UI, `OWNER_GUARDED_TRANSITIONS` and the preflight branch; the
`QualityOverride` table can stay as history (append-only — never delete the rows, they are the
audit trail of what was posted unchecked).


## Director chat (2026-10-19)

Chris: "Add a feature for me to speak with you in the app." His example, IMG 4186 — a 9 s clip with
**no speech**, only his face: the check hits and he's happy → 2–3 s later rent, car payment,
utilities appear on the other side while the paycheck/money disappears → "well that was a fun 11
seconds". For every video he wants to describe the vision and have it built/animated/edited — not
led by captions or audio. To be folded into `/docs/DECISIONS.md` by the integrator.

## Decision 1 — A chat in the editor; every answer is a typed instruction set, applied by code

**Director** is a tool in the phone editor's toolbar (bottom sheet, full height) and a tab in the
desktop inspector (`DirectorPanel.tsx`). Chris types or dictates (iOS keyboard mic) his vision;
follow-ups ("make the bills drop faster", "move rent to the right") refine it.

- **Conversation** — new table `DirectorMessage` (append-only; migration
  `20261018180000_director_chat`, additive): Chris's MESSAGEs, the ANSWER that came back (parsed
  instructions + raw text + sha256), APPLIED (change list, notes, base + result EditPlan ids),
  REJECTED (errors + the fix-up message), UNDONE.
- **Versions** — each applied answer is saved through `saveFinishingEdit` as a NEW EditPlan version
  ("Finishing edit by Chris: Director chat — Added: …"); manual work is never overwritten. **Undo**
  saves the exact timeline the answer was applied to as another new version (asks first if Chris
  edited after it). Audit: `DIRECTOR_EDIT_APPLIED`, `DIRECTOR_EDIT_UNDONE`, `MEDIA_ASSET_UNDERSTOOD`.
- **Plain change list** — e.g. "Added: Paycheck +$2,400 at 0.9 s–3.3 s (left, 60% size) · Added:
  Rent payment -$1,450, Car payment -$520, Utilities -$240 … · Added text: “well that was a fun 11
  seconds” at 7.3 s–9.0 s (bottom)" + notes ("no room on the right beside your face, so it went
  lower right", "snapped to your smile", "ends at 3.3 s as the next graphic comes in").
- **Idempotent** — a double tap on Send (client key) or a re-pasted answer (sha of the text) never
  makes a second message/version.

## Decision 2 — What the chat sees: computed once per take, free, local

`packages/media/src/take-understanding.ts` (Node) runs in the worker (`take-understand` heavy job,
and inside `ingest` after the proxy; kill switch `DIRECTOR_UNDERSTANDING=off`; a failure never fails
ingest) and stores a `TakeUnderstanding` row (append-only, latest wins):

- one ffmpeg decode of the 720p proxy at 4 fps (coarser for long takes, ≤ 720 samples) — the same
  letterboxed 640×480 frames as the face tracker; **UltraFace** (MIT, vendored) finds the face;
- **facial expression** per 0.25 s: **FER+ `emotion-ferplus-12-int8.onnx`** (ONNX Model Zoo,
  **MIT** — license line `SPDX-License-Identifier: MIT` in the model's README; labels from
  Microsoft's FER+ on FER-2013 faces; 19 300 656 bytes, SHA-256
  `3e47195d…0ff5f1`) on a 64×64 grayscale face crop → softmax over neutral, happy, surprise, sad,
  angry, disgust, fear, contempt. ~25 ms per crop on a laptop CPU (whole 9 s take: ~2 s). The int8
  model was chosen over the 35 MB fp32 one: same top class on every test face. **Not committed**
  (size): downloaded on first use with the checksum verified (`EXPRESSION_MODEL_DOWNLOAD=off`
  forbids it; `EXPRESSION_MODEL_PATH` overrides), and by the snapshot build;
- **motion energy** = frame difference of tiny thumbnails (camera shake counts);
- a **frames sprite** (JPEG, one 180-px cell every 0.5 s) stored in storage.

Pure, browser-safe (`@chris/media/director` `understanding.ts`): smoothing, **events**
(expression onsets measured on the raw crossing, expression changes, head moves, lean in/out, face
lost/found, motion spikes — ids `e1…`), mapping onto the CURRENT edit's output time through the
clips (cuts move/remove events), free space around the face (`layoutWindows`), and the **frames
image** plan (`contactSheetPlan`: ≤ 30 cells, every 0.5 s+, each labelled "3.0s / happy 0.91"). The
image is drawn by the browser from the sprite (`lib/director/frames-image.ts`; served same-origin by
`/api/director/sprite/…` so the canvas isn't tainted) — always matching the current edit, $0.

**Honest about accuracy:** the pack says the expressions are APPROXIMATE with confidences and that
Chris's description wins; mouth-open/gaze aren't measured (no landmarks — "surprise" is the proxy).
FER+ was trained on small, mostly frontal web faces; profile or dim shots will read as neutral.

## Decision 3 — The brain: free ChatGPT round trip (default) or Claude (paid, gated)

One pack (`pack.ts`, ~23–27k chars) for both: Chris's words (he outranks everything), the
conversation and the previous instructions (follow-ups answer with move/update/remove on ids), word
timings (or "No speech"), FACE & MOVES (segments, events, a per-0.5 s table, where his head is and
the free space), CURRENT EDIT ids, the vocabulary (`catalog.ts`: ~40 library presets ranked for his
message — money/phone staples always included — with their data and a per-component field guide,
quick entry, text styles, sounds, zoom, captions), rules, and the strict answer SHAPE.

- **Free (default)** — like `/plan/scripts` and the studio: **Send to ChatGPT** (Web Share with the
  frames image on iPhone), **Copy message**, **Save the frames image**, Open ChatGPT; paste the
  answer → **Build it**.
- **AI (paid)** — `POST /api/director/ask` (Route Handler: carries the JPEG and takes tens of
  seconds, so it never blocks Save) → `runDirectorAgent` (prompt `DIRECTOR_CHAT` 1.0.0, MEDIUM,
  vision) through the existing cost-tracked provider + daily spend cap. Enabled only when
  `getDirectorAiAvailability` says so (key set, not out of credit, under the cap, `DIRECTOR_AI` not
  "off"); otherwise "Ask AI · needs AI credit". Shows ≈ cost per message (estimate ~$0.06 on Sonnet
  5.5; the real cost is logged). The model returns `reply` + `operations_json` (a thin wire shape the
  API's JSON-schema subset can express); the operations go through the SAME tolerant parser and
  strict validator as a paste. Tests use MockModelProvider only.

## Decision 4 — Strict schema, tolerant parser, deterministic applier

`schema.ts` (zod, `.strict()`): `{reply, operations[]}` with `addGraphic` (presetId + props / quick
entry / lines, start/end/duration, placement region or x/y, size, enter/exit, sfx, speed),
`addText`, `addZoom`, `addSfx`, `cut`, `trim`, `setCaptions`, `remove`, `move`, `update`, `note`.
Times: seconds, `"end"`, `{"expression":"happy","nth":1,"offset":0.2}`, `{"event":"e4"}`,
`{"expression":"happy","near":3}`.

`parse.ts` tolerates fences (the block with "operations" wins), prose, smart quotes, comments,
trailing commas, single quotes, a bare array, key/op-name aliases, "3.1s"/"0:03.1", "left side",
"cha-ching", "small", unknown fields (dropped and listed). A misfit changes nothing and returns
precise errors + **Copy the fix-up message**.

`apply.ts` (pure): times checked against the CURRENT edit (past the end / unknown event / an
expression never detected → refused with a fix-up message); presets resolved through the graphics
contract (unknown id → refused with the closest ids); "lines" work for any list component;
**expression snapping** — a numeric time within 0.6 s of an onset of an expression the op's `why`
mentions snaps to it; hand-offs (< 0.4 s overlap) end the earlier graphic as the next arrives; SFX
spacing (≥ 0.25 s, ≤ 24), zoom ≤ 1.6×, overlapping zooms skipped; cuts/trims run last (all times
refer to the edit Chris saw) and ripple everything after.

**Placement** (`placement.ts`): a named side is solved around his FACE (brow-to-chin, bottom-anchored
from the protected head region, over the graphic's whole window incl. zooms) as a hard obstacle,
hair/torso soft, captions/texts/other graphics on screen hard; scale 1 → 0.42; then the nearest
region (LEFT → lower left → upper left → bottom → top), said in the notes. Saved as MANUAL x/y/scale,
so the renderer draws exactly that (it never re-solves MANUAL graphics). An explicit x/y over his face
is moved off it. **Bounds:** the accurate per-app UI regions (`area.ts`: visible width on tall phones,
below the top bar, the right action rails and bottom caption blocks of Instagram/TikTok/YouTube as
obstacles) instead of the frozen margin rectangle the AUTO solver uses (which forbids the whole bottom
third) — when Chris names a side, he gets the space every app actually shows (e.g. lower left beside
his chest). AUTO placement is unchanged.

## Decision 5 — Numbers Chris puts on screen through the chat are his (provenance)

Every graphic the chat adds or changes is recorded in `plan.director.owner` — "Chris via Director
chat", the message id, the numbers it shows, which of them he typed, and a hash of the graphic's exact
data. The Quality Gate's FACTUAL visual-number check skips graphics whose data still hashes to what he
applied (`directorOwnedVisualIds`); a later hand edit changes the hash and the normal
research/script check applies again. This is an explicit owner decision (authority 1), logged per
graphic — not a silent weakening: numbers the answer chose are shown in the change list and the reply
must say which numbers it picked so he can correct them. One-line change in
`apps/worker/src/quality-gate-job.ts` (filter before `findUngroundedVisualNumbers`).

## Evidence (`docs/evidence/2026-10-18-director-chat/`)

**Test clip (IMG 4186 stand-in, not committed):** 9 s, 1080×1920, 30 fps, silent. Two public-domain
portraits of the same person (Colin Powell — official Secretary of State photo, smiling; 1980s
Major General portrait, neutral; US federal works via Wikimedia Commons), face-aligned with the face
tracker, blur-filled to 9:16 (face 33 % of the width, centre at 1/3 height — arm's-length selfie),
handheld drift + grain, cross-faded neutral → happy at 0.9–1.15 s and happy → neutral at 3.2–3.5 s.

**Measured by the real pipeline:** e1 happy onset @ 0.85 s (1.00), e4 happy → neutral @ 3.38 s (0.96),
motion spikes at the cross-fades; 0–0.8 s neutral 0.89, 1.0–3.3 s happy 0.90, 3.5–8.8 s neutral 0.94.
`0-frames-image-sent-to-chatgpt.jpg` = the labelled frames image. `pack-v1.txt` = the exact message.

**Round 1** (`answer-v1-chatgpt-style.txt`, written by hand from the pack the way ChatGPT answers —
prose + a fenced block; parsed with "took the JSON from the code block"): paycheck card
(`pay-received-500`, $2,400, cha-ching) on `{"expression":"happy"}` → 0.85 s, LEFT → lower left at
60 %; bills (`notif-stack-payday`: rent −$1,450, car −$520, utilities −$240) at smile + 2.4 s, RIGHT →
"no room on the right beside your face, so it went lower right" (65 %); balance counter $2,400 → $190
from the face drop; a 1.12× punch-in on the drop; "well that was a fun 11 seconds" at 7.3 s; captions
off. Rendered with the real renderer (Remotion layer + SFX + ffmpeg, 18–23 s): `1-render-v1-frames.jpg`.
Verdict when looking at it: the paycheck lands well; the bills stack was legible only at full size —
centred on the chest and small, NOT "the other side".

**Round 2** (Chris-style follow-up "bills too small and in the middle — put them on the RIGHT, bigger,
one at a time with a pop; keep the balance where the check was" → `answer-v2-followup.txt`, deltas
only: remove `bills`, three red amounts popping in at 3.3 / 3.8 / 4.3 s on the right, three soft pops,
move `balance` → BOTTOM_LEFT): `2-render-v2-followup-frames.jpg` — the balance now drains in the
paycheck's spot ($2,400 → $633 → $235 → $190), the bills stack up one by one right of centre, the
closing line lands at 8 s. Clearly readable at phone size; this is the version that matches his
description.

**Phone UI** (`3-phone-ui-393x852.jpg`; Playwright Chrome 393×852, throwaway PGlite :55617 +
`next dev` :3617, the stand-in seeded with NO understanding): editor → Director → "Reading your face
and moves…" (the REAL `take-understand` job, ~4 s) → message → pack copied (23k chars, events present)
+ frames image composed in the browser (232 KB) → a prose paste refused ("nothing was changed", fix-up
message) → answer v1 applied (8-line change list, new version) → follow-up pack carries the previous
instructions and ids → answer v2 applied → Undo (new version). "Ask AI · needs AI credit" disabled with
the reason (no key). No horizontal overflow. A UI race found and fixed in this run: after an apply, a
stale "pending message" re-opened the old paste box.

## Not verified

- **Real ChatGPT** answering this pack (format reliability, how well it reads the frames image) —
  both answers were hand-written from the pack as ChatGPT would; the parser is tested on messy output.
- **Real Claude** on the paid path (no credit; MockModelProvider only). Cost per message is an estimate.
- **Chris's real IMG 4186** (and real iPhone faces, lighting, profile turns) — FER+ on a real selfie
  close-up is untested; the stand-in uses two still photos.
- iOS Web Share with the image + text, iOS dictation into the box (standard textarea), real Safari.
- The cloud path: **the Vercel Sandbox snapshot must be rebuilt** (new `take-understand` kind, ingest
  step, `@chris/media` take-understanding; `scripts/sandbox` now downloads + checksums the FER+ model and
  sets `EXPRESSION_MODEL_PATH`). Until then, cloud ingest skips nothing visible — the panel shows
  "Reading your face…" and the `take-understand` job is refused/fails in the cloud; the chat still
  works without face data (the pack says so).
- Quality Gate integration of the provenance filter is covered by the pure helper's tests, not an
  end-to-end gate run.

## Alternatives considered

- **An LLM picking times from captions** — Chris explicitly doesn't want caption-led edits; his clip
  has no speech.
- **A bigger emotion model** (HSEmotion EfficientNet on AffectNet) — better accuracy but AffectNet's
  research-only license makes the weights unclear; FER+ (MIT) is permissive and small.
- **Server-side frames image** (ffmpeg drawtext per request) — needs a heavy job per message; the
  browser composes it from a sprite made once, for free, always matching the current edit.
- **Letting graphics overlap the bottom UI band / side rails** — the region model is precise enough;
  the conservative rectangle stays for AUTO placement.

## Reversibility

High. Two new tables (additive), one new heavy-job kind, a new editor panel/tab, one filter line in the
quality gate, a test-setup default. `DIRECTOR_UNDERSTANDING=off` stops the face read, `DIRECTOR_AI=off`
the paid path; removing the toolbar entry hides the feature. Every Director change is an ordinary
EditPlan version.

## Files

`packages/media/src/director/*` (understanding, schema, parse, catalog, placement, area, apply, pack),
`packages/media/src/take-understanding.ts`, `packages/domain/src/director.ts` + schema/migration,
`packages/agents/src/director-agent.ts`, `prompts/agents/DIRECTOR_CHAT.md`,
`apps/worker/src/take-understanding-job.ts` (+ heavy-job kinds/ingest, quality-gate filter),
`apps/web/lib/director/{server,frames-image}.ts`, `apps/web/app/content/[id]/edit/{DirectorPanel.tsx,
director-actions.ts}`, `apps/web/app/api/director/{ask,sprite}`, `scripts/sandbox/*`; tests
`packages/media/src/__tests__/{director,take-understanding}.test.ts`,
`apps/web/lib/director/server.test.ts`, `apps/worker/src/__tests__/heavy-jobs.test.ts`.


## Delete video (2026-10-19)

Chris couldn't delete a planned/imported/filmed video ("Cancel this item" was buried in Details,
and cancelled videos still showed in Videos/Home). Now: a "Delete video" button on the video page
and a trash icon on each Plan row (native confirm). `deleteVideo` discards open recording drafts,
transitions to CANCELLED ("Deleted by Chris"), audits VIDEO_DELETED and returns every storage key
(takes, proxies, filmstrips, mattes, renders, platform variants, graphic bakes); the action deletes
those files (best effort). History (transitions, audit, rows) is kept per SECURITY.md. Lists
(video cards, plan, calendar) skip CANCELLED.


## Replace footage / Delete clip (2026-10-19)

## Problem

Chris: "I want to delete the FOOTAGE I uploaded — not the video idea from the plan. I want to
import a new video since the other one is trash." The only delete was "Delete video", which
cancels the whole video (plan slot, script, schedule) — the wrong thing. Uploading another take
didn't help either: the existing edit kept using the old take.

## Decision

1. **Replace footage** — on the video page (under the primary button, whenever the video has
   takes and hasn't started posting) and in the editor (desktop media bin; phone "Clips &
   footage" sheet, opened by "Add clip"). Pick a clip → one confirm ("Replace the footage on
   '…'? Your old clip and its edit are removed; the video stays in your plan." + a line about
   the calendar day when it's scheduled) → the clip uploads through the normal upload plumbing
   (`uploadRawTake`: local stream / browser-direct Blob + `registerBlobUpload`; it now returns
   the new MediaAsset id) → `replaceFootageNow` → `replaceFootage` (domain) → the normal
   single-upload ending (`useOpenEditor`: wait for captions → `createStarterEdit` → automatic
   Full edit / Cuts only per "New uploads get" → editor). The old footage is removed only after
   the new clip has landed and been analyzed, so a failed upload never leaves the video empty.
2. **Delete this clip** — on every take (video page "Your clips" panel + the takes list under
   Details, and every take card in the editor) with a confirm that says what happens:
   - not in the current edit → only the file goes; the edit is untouched;
   - in the current (saved, or the editor's unsaved) edit and another usable take remains →
     the edit is rebuilt from it (longest remaining take, via `createStarterEdit`, + the
     automatic edit);
   - the last take → the video goes back to "needs footage" (FILMED: Upload / Film buttons);
     it stays in the plan.
3. **"Delete video" is renamed "Delete this video idea"**; the Plan trash icon's label and the
   confirm now read "Delete this video from your plan?" and point to Replace footage.

## Data / state

- `MediaAsset.removedAt` / `removedReason` (migration `20261019090000_media_asset_removed_at`,
  additive + nullable — existing rows are "not removed"). Removal is **soft for every take**:
  TakeSelection has an FK to MediaAsset and EditPlans / audit rows name take ids, so rows stay
  as history. The original, proxy, filmstrip, person matte and director sprite files are
  deleted (best effort, logged); derived-file pointers are cleared. Alternative considered:
  hard-delete unreferenced rows like recording segments do — rejected as an extra code path
  with no user benefit (the row also anchors MEDIA_ASSET_UPLOADED audit entries). A part of an
  open recording DRAFT still goes through the draft's own `deleteRecordingSegment`.
- Every take list / edit builder / job ignores removed takes (getContentItem,
  listMediaAssetsForContentItem, starter edit, captions wait, editor page + actions, video
  cards, teleprompter, director, transcription / ingest / proxy / matte jobs, finished-recording
  sequences, plan-import counts, reference style data, `/api/media`). `recordPreviewAssets` /
  `recordPersonMatte` refuse a removed take (a job that raced the removal can't re-attach files).
- New state transitions, explicit rollbacks (`FOOTAGE_ROLLBACK_SOURCES`, documented in
  STATE_MACHINE.md, tested): `TAKE_SELECTED…SCHEDULED → MEDIA_INGESTED` (rebuild) and
  `MEDIA_INGESTED…SCHEDULED → FILMED` (no takes left). Reachable only through
  `footage-removal.ts`, never a bare button; never from PUBLISHING onward. Re-selecting a take
  then uses the existing MEDIA_INGESTED → TAKE_SELECTED → EDIT_PLANNED path (new TakeSelection
  + EditPlan rows; the new starter edit is "untouched", so the automatic edit applies).
  Alternative considered: re-select a take in place from EDIT_PLANNED…SCHEDULED — rejected:
  it would need a second take-selection path that skips the state machine's ingest step.
- Stale renders: when the edit is invalidated, every Render's file + RenderVariant files are
  deleted and `Render.storageKey` is cleared (rows, QC reports, overrides stay). Graphic bakes
  are footage-independent and kept.
- Schedule: the ScheduleEntry is **kept** (same calendar day; the calendar already shows a
  dated, not-ready video as "Dated on the calendar but not finished yet"); the video page says
  "Still on your calendar for … — it won't post until it's finished again". The publish job only
  takes SCHEDULED items, so nothing posts until it renders and passes every gate again.
- Open recording drafts are discarded on replace (`discardRecordingSession`).
- Audit: `TAKE_REMOVED` (per take, with file count) and `FOOTAGE_REPLACED`; transitions write
  their usual rows. Concurrency: removal takes the same advisory lock as the automatic style
  cut / full edit, whose CAS requires EDIT_PLANNED — a racing auto edit can't land on old
  footage.

## Reversibility

The migration is additive; a removed row could be un-removed in SQL, but its files are gone
(that's the point — Chris called them trash). Transitions are additive to the table.

## Files

`packages/domain/src/footage-removal.ts` (+ test), `state-machine.ts`, `media-asset.ts`,
`recording-session.ts`, `content-item.ts`, `starter-edit.ts`; `apps/web/app/components/
{ReplaceFootage,DeleteTakeButton,DeleteVideoButton}.tsx`, `app/content/[id]/flow-actions.ts`,
`(detail)/page.tsx`, `edit/{Editor,MediaBin,MobileShell,context}`, `lib/upload-client.ts`,
`app/upload/OpenEditor.tsx`; worker jobs (removed-take filters only).

Worker code changed (filters in heavy-jobs / transcribe / proxy / matte / film jobs): the
cloud-worker sandbox snapshot should be rebuilt so the live ingest job ignores removed takes.

---

## 2026-10-19 — Captions at Finish (each app's text written before scheduling, editable)

**What happened:** Chris asked whether the caption / title / description reach each app's
native fields (they do — IG `caption`, YouTube `snippet.title/description/tags`, TikTok
`post_info.title` once audited; inbox mode can't carry text) and then for captions without
extra effort. Inspection found a real gap: **Finish & schedule never packaged** — only
Autopilot called `runPackagingStep` — so a video scheduled from the editor reached publish
with no `PlatformPackage` and was skipped ("No PlatformPackage recorded…", publish-job.ts).

**Decision:**
- Finish gains a step between Check and Schedule: **Write the captions**
  (`writeCaptionsAction`, `app/content/[id]/caption-actions.ts`). For each chosen app with no
  package yet it runs the existing packaging agents (LOW class → Haiku 5.5, ≈ $0.001/app,
  ≈ $0.003/video); an app that already has text (incl. Chris's edits) is never rewritten.
- The step **never fails the Finish** (graceful degradation): an app the AI couldn't write for
  (no credit, cap, etc.) comes back in `missing`, and the done screen shows empty fields to
  type into, with the reason. Preflight still blocks an app with no text at post time.
- **Editable**: the done screen and the video page ("Captions for each app") show one card per
  app — IG caption, TikTok caption, YouTube title + description — plus hashtags.
  `saveCaptionAction` validates with `validatePackageText` (the same limits preflight applies)
  and records a **new** PlatformPackage row (`metadata.source = "OWNER_EDIT"`,
  `editedFromPackageId`), so history is kept and publish uses the latest.
- Captions describe the **finished cut**: `finalTranscriptFor` reads the words that survive the
  latest successful render's timeline (`timelineCaptionWords`), falling back to the selected
  take's transcript, then any kept take's. A condensed Full edit no longer gets captions about
  the fluff it cut. (Also used by Autopilot's packaging.)

**Alternatives considered:** a free ChatGPT copy-paste round trip for packaging (rejected for
now — at ≈ $0.003/video the AI path is effectively free and adds no steps; can be added later
on the Studio `parsePackAnswer` pattern); packaging at publish time (rejected — Chris must be
able to read/edit the text before it posts).

**Reversibility:** additive — no schema change; removing the step restores the old Finish.

---

## 2026-10-19 — Stale "out of credit" re-checked (AI buttons stuck gray after a top-up)

**Bug:** `creditError` (getAiSpendOverview / getDirectorAiAvailability) is inferred from the
last failed call and clears only after a later success — but the gates reading it (Director
"Ask the AI" button, viewer check, Finish's AI check via `aiReadiness`) refuse to call while
it's set. After Chris topped up, nothing could succeed, so the AI stayed "out of credit".

**Fix:** `apps/web/lib/ai-credit-probe.ts` `recheckAiCreditIfStale()` — only while creditError
is set, at most once a minute, one Haiku call with max_tokens 1 (≈ $0.000002), logged to
ModelCallLog as `AI_CREDIT_PROBE`. Success clears the state for every gate; a credit refusal is
logged (state stays honest); other failures (overload, network) aren't evidence and aren't
logged. Called before each gate (ai-readiness, viewer-check, director state/ask, AI credit page).

**Reversibility:** remove the calls; no schema change.

---

## 2026-10-19 — AI edit (the third Auto edit choice, was a "coming later" placeholder)

Chris pointed at the grayed "AI edit — coming later" choice in the editor's Auto edit tab; it
was never built. Built from existing, tested pieces plus one new agent:
1. **Base:** the free Full edit (cut to reference length, fluff out, hook candidates found) —
   reused as-is if it's already the current edit.
2. **Hook:** new `HOOK_PICKER` agent (`prompts/agents/HOOK_PICKER.md`, MEDIUM class, typed
   `HookPickSchema`) chooses among the Full edit's candidates — sentences Chris actually said;
   it can't invent words and an out-of-range pick is refused. Semantic judgment (does the line
   stand alone, does it pay off) replaces the keyword heuristic's choice; re-cut via the
   existing `hookIndex` choice.
3. **Graphics:** the existing Motion Designer (`designVisualsAction`, replaceExisting) designs
   graphics for what he's saying, replacing the Full edit's template graphics.
Each step saves a new version (undo walks back). If step 3 fails, the AI hook stays and the
error says so. Client orchestration: `StyleCutPanel.tsx` `runAi`; action
`edit/ai-edit-actions.ts`. Not yet measured on a real video: hook pick ≈ a few cents (Sonnet),
graphics per the Motion Designer's own estimate.

---

## 2026-10-19 — AI edit v2: viewer-first visuals, reference length enforced, whole-thought titles

Validated the AI edit live on "Your car payment is not a personality trait" (5:08 take): it ran
(48 s, ≈ $0.10) but the result wasn't good — 2:38 against references of 60–95 s, the hook title
chopped to "If you are literally paying 80", and the AI graphics step REPLACED the Full edit's 11
number graphics with 3 kinetic-text overlays that repeated the captions (two over his head).
Chris's direction: graphics must understand the concept deeper than his literal words and exist
to help the viewer ("when are they confused? when would they need a visual?"), never to decorate.

1. **Length** (`full-edit/story.ts`): lines with no clean pause at an edge were pinned for good,
   so a fast talker couldn't be cut to length. Pass 2: if the plan still runs past the longest
   reference length (`target.maxS`), those lines may be cut on a word boundary (LOW_VALUE only;
   hook, context, last payoff and CTA stay protected). A video already within range never gets
   word-edge cuts.
2. **Hook titles** (`full-edit/hook.ts`): whole thoughts only — no clause chopped to fit, none
   starting with if/when/because, none ending on a bare number; number runs ("80, 90%") are not
   split; "Topic: N%" fallback dropped (money only).
3. **Visual Strategist** (new `VISUAL_STRATEGIST`, HIGH, typed `VisualBrief`): reads the whole
   video (topic, underlying theme, core message, viewer takeaway, who's watching) and walks it
   as a cold viewer, planning moments by need (CONFUSION, ABSTRACT_IDEA, SCALE, CAUSE_EFFECT,
   COMPARISON, PROCESS, STAKES, ATTENTION_DIP) with the concept to make click and a visual idea
   deeper than his words. The AI edit runs it before the Motion Designer (`strategize`), which
   builds one visual per moment (cap = moments, ≈ one per 5 s max, not the tier cap).
4. **Motion Designer 1.3.0** (rollback 1.2.0): numbers Chris SAYS in the edit are allowed on
   screen (same rule as the free Full edit; the Quality Gate still checks every on-screen number
   against a source before publishing — previously no research packet meant "no numbers at
   all"); a code check (`captionEcho`) rejects text-only graphics that restate ≥70% of what he
   says around that moment.

Reversibility: prompt rollback 1.2.0; `strategize` is per-call (the "Design visuals with AI"
button is unchanged apart from the number and echo rules); story pass 2 is gated on exceeding
the references' max.

---

## 2026-10-19 — "Post it yourself" (download + copy text) while the apps aren't connected

Chris can't wait on the platform developer-app setup. The video page now has a "Post it
yourself" panel whenever a finished render exists: **Save video to Photos** (iPhone: first tap
fetches the render, second tap opens the share sheet → Save Video; Safari only opens the sheet
straight from a tap; elsewhere a plain download) and one-tap **copy** of each app's exact text —
Instagram caption, TikTok caption, YouTube title + description — composed with the same
functions the publishers use (hashtags, limits). Finish's done screen links to it.
`/api/media/<render>?download=1` serves renders as attachments (Vercel Blob honours
`download=1` on a presigned URL and sends `Access-Control-Allow-Origin: *` — both verified live
2026-10-19); takes and previews are never offered for download. One master file for all three
apps (per-platform variants are still encoded at publish time when an app is connected).


---

## 2026-10-19 — Content Intelligence: brand v2, shared playbook, Creative Brief, every bot aligned

**What happened:** Chris pasted a master strategy ("The Content Intelligence Engine") written
while gameplanning topics and strategy, and asked for it to teach the entire system; he chose
to make it the new brand version, to leave the existing 75-video library untouched, and to wait
for platform connections rather than enter results by hand.

**Decisions:**
1. **Brand v2** — `/brand/BRAND_CONSTITUTION.md` and `/brand/CHRIS_BRAIN.md` rewritten from the
   master prompt (positioning "entertainment that happens to teach people about money", the
   six series, reactions, voice/reading level/avoid list/humor/behavior). Seeded as NEW
   `BrandConstitutionVersion` / `BrandMemory` rows on the next production build (the seed only
   inserts when the hash changed); v1 stays in history. `BRAND_GUIDANCE` (free ChatGPT script
   prompt) rewritten to match, with its guard test.
2. **Shared playbook** — `/prompts/shared/CONTENT_INTELLIGENCE.md` (+ `_CORE.md` excerpt),
   appended to agents' system prompts per a new frontmatter key `content_intelligence`
   (FULL/CORE/NONE; see AGENT_CONTRACTS). Cached with the system prompt, so the per-call cost
   is small. The free ChatGPT prompt carries a condensed version (`PLAYBOOK_GUIDANCE`), guarded
   against drift by test.
3. **Creative Brief** — new append-only `CreativeBrief` model (+ `ContentItem.series`),
   validated/normalised in `packages/domain/src/creative-brief.ts` (lenient enums: a drifting
   label becomes OTHER / PUNCHLINE rather than failing; scorecard list → record). SCRIPT v2.0.0
   (rollback 1.2.0) returns the brief with the script; `applyPipelineResult` records it. The
   ChatGPT block format gains a `BRIEF:` JSON line parsed tolerantly (`parseBriefJson`); a bad
   brief never blocks the script import.
4. **Downstream** — all post-production bots receive `formatCreativeBrief` text (see
   AGENT_CONTRACTS "Shared inputs"); the free Full edit matches the brief's hook and story beats
   to the take's sentences by meaning (`FullEditInput.brief`, `StoryInput.protect`): the planned
   hook always competes as a candidate and wins unless Chris picked one; matched midpoint/payoff/
   ending sentences are protected from length trims. `report.hook.fromBrief` says so.
5. **Learning, prepared** — `PerformanceSnapshot.followsGained/profileVisits` (nullable; no
   public API returns them today), `followersPerThousandViews`, Analytics judges the brief's
   ending objective / "what to test" directionally.

**Alternatives considered:** per-agent copies of the strategy (rejected: drifts); a single
"meeting" mega-agent (rejected: the master prompt itself says not to simulate one; the roster
and the Claims Gate hard gate stay); merging v1 and v2 brand docs (Chris chose the clean v2).

**Reversibility:** prompts roll back by version; the playbook is removable by frontmatter; the
brief model is additive (older items have none and every bot still works without one).

## 2026-10-19 — Graphics library 3: Signature family (brand recognition), new VFX and 3D objects

**Context:** Chris asked for the visual library to be audited for glitches, "souped up" with more
visuals / animation / 3D / VFX, made more appealing with some brand recognition, and kept highly
searchable and plug-and-play. The audit pass (previous commit) fixed wrong intermediate math in
count-ups, typewriter overflow and chopped labels. This pass adds 40 presets (450 → 490).

**Decision:**
1. **SIGNATURE category** (`packages/media/src/graphics/families/signature.ts`, motion
   `graphics/signature.tsx`): one visual signature across the brand — serif series pill, gold
   rule sweep, tabular episode tag, gold → violet accent.
   - `SERIES_CARD` — an opener per series from the Content Intelligence playbook: POISON (two
     tiles + "or" badge), MATH (receipt-style addition with a glowing result), BUTTERFLY (a
     forking path drawn over time), BROKE (ledger + rubber-stamp verdict), NO_SENSE (a pulsing
     "?" that resolves into the answer), ALIVE (paper receipt with a torn edge), EPISODE.
   - `DILEMMA` — the sound-off opening frame: two giant contrasting amounts (SPLIT / SIDE), a
     3-second TIMER, or a coin FLIP that lands on one side.
   - `SIGNATURE_STING` — INTRO sweep, OUTRO follow card, PART bumper, branded LOWER third.
   Series names are *Chris's own series* (brand recognition), never third-party brands — the
   brand-safe regex scan still covers every preset ≥ 171.
2. **SCREEN_FX** gains MONEY_RAIN (bills + coins fall in the side bands, centre clear for the
   face), SHOCKWAVE (chromatic ring punch + flash) and GOLD_DUST (quiet premium particles).
3. **ICON_3D** gains CAR, DIAMOND, WALLET (opens, cards fan out) and BANK (a coin drops in),
   with line-icon fallbacks and 8 presets; the enum is mirrored in `motion-contract.ts` and
   the Motion Designer's schema/guide.
4. **Search** — synonym groups for series / episode / sting / bumper / dilemma / poison / math /
   butterfly / broke / mystery / receipt / shockwave / money rain / dust / car / wallet /
   diamond / bank, so "pick your poison", "part 2", "money rain" or "choose" land on the right
   preset first.
5. **Totals never count** (carried from the audit): every result/total in the new family shows
   its final value from the first frame it appears.

**Glitches fixed in review before commit:** receipt tear polygon drew a bow-tie (point order);
diamond rendered as an hourglass (duplicate cone); dilemma TIMER's "or" badge overlapped a
tile's sub-text (badge removed for TIMER, wider gap for SPLIT); INTRO sting text shrank to one
tiny line (two lines at a readable size); dilemma numbers could push the label out of the
tile (capped at half the tile height); BUTTERFLY card too short for its last label.

**Alternatives considered:** real logos for recognition (rejected: impersonation / brand-safety
rule); more generic templates (rejected: the ask was identity, not volume).

**Reversibility:** additive — new category, components and presets; nothing existing changed
its id, data shape or look.

## 2026-10-19 — Cut like the hand edits (pauses, jump cuts, restarts, voice levelling, planned title)

**Context:** Chris hand-edited two videos ("the car payment", "why $100k isn't spending money")
and said that is how he wants every video cut: the cut lands right after the word, the whole
video plays as one sentence instead of chopped phrases, nothing is clipped. Measured on those
edits (scratchpad `remeasure.mjs`): ~0.14 s kept after a word (Whisper-relative; ~0.09 s true),
~0.09 s before the next, internal pauses median 0.11 s, versus the automatic cut's 0.18 s /
0.32 s targets and a rule that *kept* a pause whenever removing it would make a shot shorter
than ~1 s. The viewer check on both posted videos also flagged volume jumps between lines.

**Decision (packages/media):**
1. **Targets** — `DEFAULT_STYLE_CUT_TARGET.pauseKeepS` 0.18 → 0.12, `sentencePauseKeepS`
   0.32 → 0.18; the reference-derived values are capped to the hand-edit band
   (`pauseKeepS` 0.08–0.14, `sentencePauseKeepS` 0.12–0.22). A creator who leaves air is not a
   reason to leave air. Pads: `minTailPadS` 0.09, `minLeadPadS` 0.05, `minRemovalS` 0.06 (a
   0.2 s hesitation is now trimmed; it was below the old 0.12 s floor).
2. **Jump cuts** — the "keep the pause to avoid a short shot" rule is gone. The pause is always
   removed; when the shot so far is shorter than the framing floor the cut is a *jump cut*
   (`StyleCutShot.jump`): the next clip copies the previous crop exactly, and the
   never-the-same-framing-twice rule skips it. That is what a hand edit does — air out, picture
   stays.
3. **Restarts across a sentence boundary** — `wordLevelCuts` now searches to the end of a
   directly following kept sentence, so "…wild, the car payment. | The car payment is…" drops
   the first attempt (whole-sentence false starts were already RETAKEs).
4. **Word-edge boundaries** — the Full edit accepts measured silences ≥ 0.05 s (was 0.08) as
   clean cut points.
5. **Voice levelling** — the render's voice chain is now
   `dynaudnorm=f=400:g=21:m=4:p=0.9` → house `loudnorm` (`VOICE_LEVEL_FILTER`), voice only —
   music/SFX are mixed after. A louder take or a turned-away line no longer steps at the cut.
6. **Planned title** — the Creative Brief's chosen hook `onScreenText` is the first hook-title
   choice when it is title-sized (≤ 48 chars, ≤ 8 words), template `PLANNED`; the worker passes
   it (`briefForFullEdit`).

Tests: `style-cut.test.ts` "cuts like the hand edits" (kept air ≤ 0.26 s at every splice, jump
cuts keep the crop), `full-edit.test.ts` planned title + cross-sentence restart, mix-chain
expectation updated.

**Dev note:** the worker's DB-backed tests share one PGlite connection (`connection_limit=1`),
so the suite must run serially (`vitest run --no-file-parallelism`) with `DATABASE_URL` set;
in parallel ~60 tests fail with connection errors that look like code failures.

**Alternatives considered:** learning the pads per video from Chris's timeline edits (deferred:
two samples; the numbers above are those samples); crossfades longer than the 8 ms de-click
(rejected: audible smear on consonants); per-clip loudnorm (rejected: cost; dynaudnorm is one
pass).

**Reversibility:** numbers and a flag — the old behaviour is the old constants plus
`alwaysCutGapS` gating; `VOICE_LEVEL_FILTER` is one string.

## 2026-10-19 — Footage Brief: the plan for videos that have none, and the editor says what it follows

**Context:** Chris asked whether the Content Intelligence prompt affects the free Full edit and
the AI edit, and for the new cut style to be applied "considering the prompt". The honest
answer: the free Full edit is deterministic code — the prompt reaches it only through the
Creative Brief (planned hook opens, midpoint/payoff/ending sentences protected, planned
on-screen line as the title). Videos filmed from the in-app script or the ChatGPT paste have
a brief; older uploads and footage-first videos have none, so nothing from the playbook reached
their edits.

**Decision:**
1. **`FOOTAGE_BRIEF` agent** (prompt 1.0.0, MEDIUM, playbook FULL) recovers a Creative Brief
   from the transcript: hooks/beats are sentences he said, series by mechanism, objective from
   the filmed ending, stated numbers go to `research.unverified`. Recorded append-only with a
   new source `FOOTAGE`.
2. **AI edit step 0** (`ensureBriefAction`): when the video has no brief, the AI edit writes one
   first (one MEDIUM call, cents), then the Full edit, hook pick and visuals follow it. The
   free Full edit stays free and brief-aware; it does not call a model.
3. **Editor transparency:** the Auto edit tab shows the plan it follows (series · opening line ·
   ending objective, "recovered from the footage" when applicable) or says there is none; a
   notice marks a Full edit made by an older cutter and offers the re-cut (current version
   stays in history). `STYLE_CUT_VERSION` 3 / `FULL_EDIT_VERSION` 2 so a re-apply recomputes.

**Alternatives considered:** running the footage brief inside the free Full edit (rejected:
the free path stays free — Chris's standing rule); a deterministic "brief" from the transcript
(rejected: series, mechanism and objective are semantic judgments).

**Reversibility:** the step is one `if (!brief)` in the editor; the agent is a prompt row; the
source value is additive.

## 2026-10-19 — AI edit builds ON the free edit (it was ending up with fewer graphics than the free one)

**Context:** Chris ran the AI edit on "You don't need to look rich…" (68 s) and got ONE graphic
at 1:00; the free Full edit on comparable videos places four. Cause, by code reading: the AI
edit ran the designer with `replaceExisting: true` (the free edit's number graphics were thrown
away), the Visual Strategist's prompt said "an empty plan is better than a decorative one" and
capped at one moment per ~6 s, and the designer's brief cap subtracted the kept graphics. Then
the usual rejections (caption echo, face coverage, overlaps) took the few that were planned.

**Decision:**
1. The free edit's graphics are the **floor**: the AI edit keeps them (`replaceExisting: false`)
   and the strategist is told what is already there. A brief moment on the same phrase
   **replaces** the free graphic there (the concept is the deeper one — `warnings` says so);
   elsewhere both stay. The brief cap is one per planned moment, no longer minus the kept.
2. Visual Strategist 1.1.0: density target of one moment every 5–8 s (a 60 s explainer: 7–10),
   hard ceiling one per 4.5 s; the opening frame from 1.5 s may be a DILEMMA / series opener;
   Chris's signature families are named so the designer reaches for them. Motion Designer
   1.4.0 mirrors this (kept graphics stay; signature preset ids).
3. House look: MINDSET and SAVING themes are CRISP with gold objects, not CALM/line icons.
4. The AI edit summary now says how many graphics are on the timeline, how many the AI added,
   and lists every dropped idea with the engine's reason — so a weak result is explainable in
   the editor, not a mystery.

**Alternatives considered:** keeping replace-everything and raising the strategist's density
(rejected: the free edit's number graphics are grounded and good — discarding them is waste).

**Reversibility:** one flag in `StyleCutPanel.runAi`, prompt versions roll back.

## 2026-10-19 — The Operator persona, and the cut has to make sense (read-through + whole-thought sentences)

**Context:** Chris: the bots writing hooks/scripts/shot lists "should act as if they built a
massive brand from videos alone and know what keeps attention, interest, engagement, trust…
it should be so good it can take crap material and make it compelling… and it should make
sense — sometimes sentences don't go together, or I wonder why a line was placed there." The
live AI edit on "You don't need to look rich…" confirmed the last point: the hook was a
fragment ("…the money you should have used to") because the sentence splitter ended a sentence
at a ≥ 0.7 s pause mid-clause, and the hook scorer accepted it.

**Decision:**
1. **`CREATOR_OPERATOR` shared prompt** (+ `_CORE`): the persona and craft knowledge above,
   appended before the playbook for every FULL/CORE agent (`contentIntelligenceFor`), and
   `OPERATOR_GUIDANCE` in the free ChatGPT script prompt. SCRIPT 2.1.0 (rollback 2.0.0) names
   the weak-material discipline and a final cold-viewer read-through (re-hook every 7–10 s,
   no reveal before setup, a line they'd repeat).
2. **Whole-thought sentences** (deterministic, free edit): a long pause after a word no thought
   ends on (`DANGLING_END`: to/the/of/and/should/used/…) is a hesitation — the sentence
   continues; `scoreHookCandidates` never offers a fragment. `fixDangling` now only trusts a
   REPEAT/RETAKE twin that plays BEFORE the dependent line.
3. **`FLOW_CHECK` agent** (MEDIUM, CORE) in the AI edit after the hook pick: hears
   `FullEditReport.kept` (new field: the lines in output order) + `removed`, returns broken
   junctions with one fix each; the editor applies ≤ 4 as `forceKeep`/`forceDrop` and re-cuts;
   never the hook. The summary shows "Read-through: N junctions fixed…", the hook problem if
   any, and the quotable line.
4. The "older cut" notice hides once a Full/AI edit has run in the session.

**Verification (live, before the read-through shipped):** the AI edit on that video went from 1
graphic to 8 on the timeline (4 ideas dropped: 2 invented numbers blocked by the fact gate, 2
would have covered his face) — and surfaced the fragment hook this entry fixes.

**Alternatives considered:** fixing coherence only with regex rules (rejected: "does this line
follow?" is semantic — the deterministic rules catch the mechanical cases, the model the rest);
letting the flow check rewrite lines (rejected: the edit only ever uses words he said).

**Reversibility:** prompts roll back by version; the flow step is one block in `runAi`; the
splitter rule is one regex.

## 2026-10-19 — No half-empty graphics (the preset's own sample is the bar)

**Context:** frames of the live AI edit showed two cards that were valid but read as
placeholders: a "Take-home pay formula" with no numbers and a "Before / after" with one side.
The contract validated them (counts/bounds), the fact gate had nothing to object to (no
numbers), so they rendered.

**Decision:** `graphicFillTooThin(props, presetProps)` in the graphics contract — a GRAPHIC is
rejected (reason "too thin to show — …") when it carries fewer than half the numbers its preset
shows, fewer than two entries where the preset has two, or fewer than half the plotted values.
Applied in the Motion Designer before the fact gate; the prompt (1.4.1) says so. Close-up
placement over hair/forehead stays as designed (face core protected; top creators place there).

**Reversibility:** one check; no schema change.

## 2026-10-19 — The free cut, cut like a creator (from a frame-by-frame look at a live free cut)

**Context:** Chris: the free cut "is especially sloppy — not even close". A live free Full edit
of "both making $100K" (1:03 → 0:52, 13 of 14 lines kept — so not over-trimmed) showed, in
frames: a Big number reading **$4,727** while he said $5,000 (a count-up caught mid-animation),
**$192** for $200, a month strip showing $4,053 / $3,926 / $3,664 he never said (cells counting
up); graphics parked on his hair/forehead; the hook title across his eyes (reported as a WARN,
not fixed); a 30-word run-on as the opener while the actual hook ("…who would you rather be?")
was cut as a "slow start"; the ending trailing "Let me know. Kind of curious. So, a name."; a
title "$$8,333 → 100000 year".

**Decision (all deterministic — the free cut stays free):**
1. **Numbers read as said:** `animation.countUp` defaults to **false** for every graphic — a
   number he said appears as said in every frame. A graphic may opt in.
2. **Off his head:** the placement score now penalises overlap with the whole head region
   (hair/forehead) so a clear spot beside or below the head wins; over-hair remains the
   close-up fallback. The hook title falls back to the face CORE rule (eyes → mouth) at the
   smallest size — above the core over the hair, else between chin and captions — instead of
   parking at the top of the frame across the face; the Quality check judges against the core.
3. **The hook is the choice:** `CHOICE` ("which one are you", "who would you rather be",
   "would you rather", "pick one") scores +1.6 and is never dropped as a slow start.
4. **End on the question:** short non-number lines after the last question / CTA are removed
   as `TRAILING` ("Ends on your question"); a ≤ 3-word last line that isn't a question is a
   trailing fragment (FLUFF), never the PAYOFF.
5. **Titles:** an amount said "a year" is money, not a time span (the "→ N years" template
   needs a small integer count); doubled "$" collapsed in titles and graphic reasons.

Tests: `full-edit.test.ts` "the free cut reads like a creator cut it", title formatting.

**Reversibility:** one default (`countUp`), one weight, one regex family, one removal kind.

## 2026-10-19 — Transcription model: whisper-large-v3-turbo (the words every bot works from)

**Context:** the free cut's remaining sloppiness was the words themselves: "I would rather be
the savior", "So, a name", "So one, you are very nice house or car rent" — Whisper base.en
mis-hearings that the captions burn in and every editing bot (beats, hook, read-through) reasons
over. Benchmarked the four word-timestamped ONNX exports inside a sandbox on Chris's real
"both making $100K" take (62.7 s, 8 vCPU, fp32; `scripts/sandbox/whisper-bench.ts`):

| model | load | transcribe | RTF | word errors vs large | notes |
|---|---|---|---|---|---|
| base.en (was default) | 2.4 s | 7.8 s | 0.12 | 10.1% | "$3500" merged, garbage lines |
| small.en | 7.9 s | 21 s | 0.34 | 9.0% | "saver rightver" |
| medium.en | 16 s | 47 s | 0.75 | 6.0% | "7733", one bad timestamp |
| large-v3-turbo | 14 s | 30 s | 0.48 | — | clean punctuation, sentence breaks |

**Decision:** `DEFAULT_TRANSCRIPTION_MODEL = onnx-community/whisper-large-v3-turbo_timestamped`,
fp32 (word timing), `language: "en"` forced for the multilingual export. The snapshot warm-up
pre-downloads it (≈3 GB); a 60 s take transcribes in ~30 s. Existing takes keep their words
until re-transcribed (`force`). `TRANSCRIPTION_MODEL` still overrides per environment.

**Alternatives considered:** medium.en (slower AND worse here); small.en (fast, barely better
than base); q8 weights (rejected for now: fp32 is the measured-good setting for word timing).

**Reversibility:** one constant / one env var; the old model stays cached in older snapshots.

## 2026-10-19 — Whisper window 30/5 for the large model; sentences split at breaths; generic names for topic presets

**Context:** after switching to large-v3-turbo, the first re-transcription of the "$100K" take
showed two new artifacts: a window-merge glitch ("end up**733** a month" lost "saving about $")
and one window decoded without punctuation (a 60-word run the sentence splitter then kept as
one 11.5 s "sentence"). Benchmarked window/overlap on the same take
(`scripts/sandbox/whisper-bench.ts … CHUNKS=`):

| window / overlap | transcribe | words | punctuation marks | merge glitch |
|---|---|---|---|---|
| 25 / 5 (was) | 32.7 s | 208 | 7 (middle unpunctuated) | none in this run |
| 20 / 5 | 44.1 s | 202 | 14 | — |
| 28 / 6 | 32.3 s | 205 | 8 | none |
| **30 / 5** | **24.5 s** | **211** | **13** | none |
| 15 / 4 | 54.6 s | 207 | 13 | none |

**Decision:** (1) 30 s / 5 s for the large model, 25 / 5 for the small English exports (where a
30 s window broke word timestamps on 2026-10-17); a word-starved result (< 1.2 words/s on a
take > 20 s) retries the other window and keeps the fuller transcript. (2) The sentence splitter
closes a sentence at a ≥ 0.45 s breath once it is 18+ words (after a word a thought can end
on), so an unpunctuated window never becomes a one-minute sentence. (3) When the free visuals
bot uses a topic-named preset generically, the editor calls it "Big number" / "Number card"
and the emergency-fund shield icon is dropped unless he is talking about a fund.

**Verified live (free cut on the re-transcribed take):** "One's a spender, one's a saver." as
its own line, no "savior" / "So, a name", numbers static and correct, title clear of the face.

**Reversibility:** window list is two numbers; splitter rule one threshold; naming is a label.

## 2026-10-19 — Long takes are transcribed in quiet-cut pieces, not overlap-merged windows

**Context:** with large-v3-turbo the remaining transcript errors were all at window seams:
25 s/5 s lost "saving about $" ("end up**733**"), 30 s/5 s lost ",000 a" ("**$5** month" — and that
wrong number went on screen). transformers.js merges overlapping windows by text alignment, and
numbers at a seam are exactly what it mangles. Benchmarked on the same real take
(`scripts/sandbox/whisper-bench.ts … CHUNKS=0/0,25/5,30/5`):

| method | $5,000 | $733 | $3,500 | $1,600 | words | punctuation | time |
|---|---|---|---|---|---|---|---|
| 25 s / 5 s overlap | ok | ok | ok | ok | 208 | 7 (middle unpunctuated) | 29.9 s |
| 30 s / 5 s overlap | **"$5 month"** | ok | ok | ok | 211 | 13 | 24.2 s |
| **quiet-cut pieces** | ok | ok | ok | ok | **212** | 12 | **24.0 s** |

**Decision:** `quietSplitPoints` cuts the 16 kHz audio at the quietest 150 ms between 14 s and
26 s after the previous cut (a real silence wins wherever it is; else quieter-and-later), each
piece (≤ 26 s, under Whisper's native 30 s) is transcribed on its own with word timestamps, and
timings are offset per piece. No overlap, no merge, no seam. Unit-tested on synthetic audio.

**Reversibility:** the chunk/stride path is one call away; `WHISPER_CHUNK_SECONDS` stays.

## 2026-10-21 — The Editor: an agent writes the cut; the engine executes it

**Context:** Chris, after a frame-by-frame look at a reference reel he wants to match: the
product is the finished video as a piece of work — dead space cut, the story built from
beginning to end (hook, tension, payoff), chopped together into one cohesive video, and only then
visuals that complement it. "Not one style is law"; cuts, pace and placement are means. Our
system had no editor: the free Full edit is a rules machine (regex beats, a value formula, a
keyword hook score, number-matched graphics) and the AI edit added judgments on top of that
skeleton. Nobody ever made the story. The reference reel was also read for *orchestration*
(one lead element at a time, fixed anchors, headlines held for the idea, zoom-ins instead of
cuts on a continuous take) — written down as `EDITOR_ORCHESTRATION.md`.

**Decision:**
1. **`EDITOR` agent** (HIGH; Operator + playbook + orchestration): title + brief + numbered
   transcript lines → `EditorPlan`: storyline (ids, roles, `keepWords` trims, a headline per
   beat, what the viewer needs to see), cut list with reasons, hook title, pacing, rationale,
   cold-viewer read-through. Only lines he said; the engine validates ids and trims.
2. **The engine executes the plan** (`planFromEditor`): the heuristic planner, hook scorer and
   length trims are skipped; the editor's order plays; trims land on the nearest clean pause
   within one word, else the word edge; `LONG_SHOTS_ZOOMS` holds the framing across every pause
   cut (`holdFraming`); beat headlines are held on screen for the beat in the top zone (the
   hook beat is the hook title); `report.editor` carries the beats with their output timing.
3. **Automatic on upload**: auto-edit mode `EDITOR` is the default (`auto_edit.no_editor` flag
   → the free Full edit; `auto_edit.cuts_only` → cuts); without a model (no key, no credit, cap)
   it falls back to the free Full edit — never nothing. The AI edit's first step is now the
   Editor; the hook picker and read-through run only when there is no editor plan.
4. **Visuals per beat**: the Visual Strategist receives the editor's beats and plans only inside
   beats that name a need, under the headline, never restating it.
5. The plan is stored with the edit's choices, so "Try another hook" / restore a line re-apply
   without another model call.

**Not done (next):** the watch-it-back gate (a model watches the finished render and sends it
back when it would not post it) — required before any auto-post; the caption style (one word,
small, near the speaker) and zoom-ins at beat boundaries as a first-class pacing mode.

**Reversibility:** the auto-edit flag; `choices.useEditor` off = the old path untouched.

## 2026-10-21 — The premium editor plan: analysed, approved, handed to the next session

**Context:** After the Editor shipped, Chris ran five planning-only rounds ("what would you do
if you built a very premium AI editor… what would Apple, Meta, CapCut do… cuts right on the
decibel… did I upload the references for nothing?"), chose the four deep-dives (gate and
auto-post, splice precision, reference learning, screen orchestration), asked for a critique
from the editor / influencer / viewer / new-viewer seats, then for a recommendation, and
approved it. He is handing implementation to a fresh session (Opus 5.5), so the analysis and
the recommendation now live in the repo, not in a conversation.

**Decision:**
1. `/docs/PREMIUM_EDITOR_PLAN.md` holds the five rounds, the critique (ten changes) and the
   approved recommendation table (Week 0 golden-set harness + filming card + latency meter →
   Week 1 splice engine + free gate audits → Weeks 2–4 Editor v2 + Screen Orchestrator →
   Weeks 4–6 reference learning → Weeks 6–8 watch-back gate + shadow autonomy → auto-post when
   earned).
2. `/docs/PREMIUM_EDITOR_HANDOFF.md` turns Week 0 into file-level contracts (golden fixture
   schema, splice metrics, hand-edit comparison, the worker export, the authenticated route,
   the pull/replay scripts, the vitest harness, the filming card copy, the latency function)
   and lists the verified state of every piece the later weeks touch, plus Chris's working
   rules (ship cost warnings, no secrets locally, no paste paths, judge by watching).
3. Nothing was implemented in this session beyond the docs. The next session starts at
   handoff §3 (Week 0) and does not skip it: the harness is the gate for every later change.

**Alternatives considered:** start the splice engine immediately (rejected — every iteration
would still cost a 10-minute ship and his credit; the harness is what makes the rest fast);
keep the plan only in the session's plan file (rejected — CLAUDE.md: the repository is the
source of truth).

**Reversibility:** docs only; the recommendation's order can be re-cut in a later entry.

## 2026-10-21 — Week 0 built: golden-set harness, filming card, upload → ready meter

Implements `/docs/PREMIUM_EDITOR_HANDOFF.md` §3.

1. **Golden-set harness** — `packages/media/src/golden` (`GoldenFixtureSchema`, `replayGolden`,
   `spliceMetrics`, `summariseSplices`, `compareToHandEdit`, `diffGolden`); the worker's
   read-only `exportGoldenFixture`; `POST /api/golden` (signed-in only);
   `pnpm golden:pull <base-url> <id>=<slug>[@<handEditPlanId>]` (signs in with the app's own
   login, credentials from the environment, never printed) and `pnpm golden:replay [--update]`;
   `golden.test.ts` replays every committed fixture against `fixtures/golden/expected/`.
   Replays never call a model: the Editor's cut is rebuilt from its stored plan.
2. **Hand edits are told apart from machine saves.** The editor's buttons and "Design visuals
   with AI" also save as "Finishing edit by Chris: …"; `isHandEditReason` (domain) keeps only
   real editor saves, so the harness never learns splices from a machine cut by mistake.
3. **Filming card** on `/film` (open) and `/upload` (closed): six tips, no settings.
4. **Upload → ready** — `uploadToReadyLatency` (domain; budget `READY_BUDGET_MINUTES` = 8) shown
   on the content page under the progress bar, gold when over budget; the worker logs
   `[latency] … upload→ready N min` when the automatic edit lands (live with the next worker
   ship — no ship cycle spent on a log line).

**Still to do for Week 0's definition of done:** pull the five fixtures from prod once the route
is deployed (the two hand edits "the car payment" and "why $100k isn't spending money", plus
three recent takes with an Editor plan), write the expected replays, commit them, and record
the baseline numbers (splice air median/p90, clipped count, hand-edit median delta, kept order)
in this file. Those numbers are the bar Week 1's splice engine is judged against.

**Reversibility:** additive; nothing in the edit path changed behaviour.

## 2026-10-21 — Week 1: the splice engine (cuts land on the voice) and the free splice audit

Implements `/docs/PREMIUM_EDITOR_HANDOFF.md` §4 "Week 1" (plan round 3). Chris's words: cuts
"right on the decibel the voice changes". Until today every splice carried 0.14–0.25 s of
designed air plus up to 67 ms of outward frame rounding, and the silences it was placed by
came from 20 ms RMS frames with no hysteresis (DECISIONS 2026-10-19 copied two pad numbers by
hand; nothing measured the voice itself).

**Decision (packages/media `splice/`):**
1. **Voice analysis** (`analysis.ts`, `analyzeSplicePcm`): a 1 ms-hop RMS envelope of the full
   band and of the band above 2 kHz (so fricative tails count as voice); voice ON at
   floor + 10 dB on the fine (5 ms) view, OFF when a 20 ms-smoothed view falls below floor + 4 dB
   for 40 ms, with the exact offset taken as the last fine frame still within 30 dB of the span's
   peak and above the room's own fine-frame peak (so a rumbling room stretches no tail); spans
   under 30 ms or below floor + 6 dB mean are not voice; plosive bursts = a ≥ 12 dB high-band
   rise out of ≥ 20 ms of quiet whose energy is mostly high band. The output (`SpliceAnalysis`:
   voice spans with their level, bursts, floor/speech dB) is a few KB and is stored with the
   edit (`StoredFullEdit.splice`, `StoredStyleCut.splice`); the PCM is never kept.
   Synthetic-audio tests: onsets/offsets within 3 ms, a 60 ms fricative tail kept, a 20 ms dip
   never splits a word, a quiet line's tail not stretched, the burst found within 2 ms.
2. **The SpliceModel** (`model.ts`): tail/lead pads mid-sentence and at a sentence end. Prior
   from the hand edits (mid 80/50 ms, sentence 110/60 ms); `learnSpliceModel` re-fits medians
   from `spliceSamplesFromTimeline` (a hand-edited timeline measured against the voice), never
   outside the band tail 30–140 ms / lead 20–100 ms. The worker uses the prior today; learning
   runs through the golden harness once fixtures carry an analysis (see "not done").
3. **Placement** (`place.ts`): cut-out = voice offset + tail pad, cut-in = voice onset − lead
   pad, pulled to 15 ms before a plosive burst up to 90 ms ahead of voicing; no frame grid; a
   pause shorter than the pads is left alone. `refineWordEdges` snaps the first/last Whisper
   word of each voice span to the span's edges (±150 ms).
4. **Inside the cutter**: `cutOneTake` takes the analysis — the voice gaps are the pauses, the
   model's pads the air, `q()` no longer touches an audio cut (it still quantizes picture-only
   rhythm cuts); story joins get the sentence-end pads on both sides (was pre-roll + join tail,
   ~0.24 s). The Full edit refines the words and passes the analysis; `STYLE_CUT_VERSION` 4,
   inputs keys include the voice spans.
5. **Render**: picture and audio are concatenated as separate streams; each clip's audio is its
   exact source length (was padded/trimmed to whole output frames, ±8–16 ms per splice) with a
   4 ms equal-power fade at each non-contiguous join (was 8 ms linear); the picture keeps
   `clipFrameCounts` (cumulative rounding, drift ≤ half a frame). Room-tone fill is unnecessary
   with no gap to fill.
6. **Gate G1, free splice audit** (`audit.ts`, run in `runDeterministicChecks`): per cut, GAP
   (air beyond the pads + 60 ms), CLIPPED_WORD (the cut sits > 40 ms inside a voice span) and
   LEVEL_STEP (≥ 4 dB across a cut with voice within 0.3 s on both sides), each with the cut
   index, output time and delta. Recorded as `SPLICE_AUDIT` issues at MAJOR severity — not
   blocking — until the golden baseline shows the engine meets the bar; then BLOCKING. Planted
   defects test: a gap, a clipped word and a level step caught at the right cuts; a clean cut
   passes.

7. **Captions follow the voice**: the render refines each take's Whisper word times with the
   stored analysis before the caption chunks are built (`apps/worker/src/splice-store.ts`,
   shared with the gate), so a highlighted word and the voice never drift apart after a tight
   splice. The editor's preview still shows raw Whisper times (parity pending).

**Not done / next:** the learned model is not yet fed from Chris's hand edits automatically
(fixtures pulled after this ships carry the analysis; `pnpm golden:replay` can then fit it and
the worker can read a stored model); the editor preview's captions use raw Whisper times
(the render's refined ones should reach it for preview = render); multi-part recordings
(several takes) get no analysis yet; the screen audits (face core, two leads, hook text by
1.5 s) wait for the Screen Orchestrator (Weeks 2–4). Needs a worker ship (10–12 min) — not
shipped in this session (no network).

**Verification:** `splice.test.ts` (12 tests incl. the cutter integration: exactly the model's
air at every pause cut, off the frame grid, no clipped word; a story join's pads), the whole
media suite (30 files, 365 tests) and the worker edit-job/gate tests green.

**Reversibility:** without an analysis (`splice: null`) every path is byte-for-byte the previous
behaviour; `STYLE_CUT_VERSION` 4 only changes the inputs key.

## 2026-10-21 — Golden set pulled; the splice baseline; the SpliceModel fitted from his hand edits

**Golden set** (`fixtures/golden/*.json`, expected replays in `fixtures/golden/expected/`): six
of Chris's takes, pulled from prod with `pnpm golden:pull` after the Week 0/1 ship:

| slug | video | take | hand edit | Editor plan |
|---|---|---|---|---|
| car-payment | Your car payment is not a personality trait | 308 s | yes (16 cuts) | no |
| 100k-not-spending | Why a $100K salary isn't $100K of spending money | 88 s | yes (13) | no |
| two-people-100k | Two people making $100K: who's actually winning? | 63 s | yes (19) | yes |
| before-investing | What I would organize before investing $1 | 239 s | no | yes |
| look-rich | You don't need to look rich to be wealthy | 199 s | yes (20) | no |
| img-4128 | IMG 4128 | 166 s | yes (45) | no |

Only two videos in prod carry an Editor plan today; the others replay the free cut only. A video
gets an Editor replay as soon as the AI edit has run on it once and the fixture is re-pulled.

**Harness fixes found by the first replay:** (1) the machine cut must never be a hand save —
`saveFinishingEdit` keeps the earlier `fullEdit` block on the row, so "has a fullEdit block" is
no proof (`isHandEditReason` decides); (2) splices are measured against the voice analysis, not
Whisper's words (±0.2–0.4 s: even the hand edits read as "clipped" by that ruler); (3)
"clipped" means inside the voice AND inside a word — continuous speech is one long voice span,
and a cut between two of its words is not clipping. The same rule is in the gate's audit.

**The SpliceModel is fitted, not a prior** (`LEARNED_SPLICE_MODEL`, now the default): 57 pause
cuts across the five hand edits, each measured against the voice. Mid-sentence tail 96 ms
(p25–p75 76–112), lead 72 ms (59–77); sentence end tail 146 ms (99–175), lead 121 ms (91–151).
The band widened to tail 30–200 ms / lead 20–160 ms so a sentence-end pad is not clamped. His
real air is therefore ~170 ms inside a sentence and ~270 ms between sentences — more than the
hand-copied 2026-10-19 numbers (120/180 ms) assumed, and now measured, not guessed.

**Baseline (replay with the fitted model, air measured against the voice):**

| fixture | engine (free cut) | prod cut before the engine | hand edit |
|---|---|---|---|
| car-payment | 25 splices · air median 0.168 s · p90 0.267 · >0.26 s: 6 · clipped 0 | 21 · 0.183 · 0.339 · 5 · 1 | 16 · 0.142 · 0.23 · 0 · 4 |
| 100k-not-spending | 17 · 0.189 · 0.267 · 8 · 0 | 15 · 0.171 · 0.356 · 4 · 2 | 13 · 0.089 · 0.328 · 3 · 5 |
| two-people-100k | 12 · 0.168 · 0.243 · 1 · 1 (Editor: 9 · 0.168 · 0.266 · 2 · 0) | 15 · 0.071 · 0.195 · 1 · 3 | 19 · 0.078 · 0.215 · 0 · 6 |
| before-investing | 15 · 0.168 · 0.219 · 1 · 1 (Editor: 20 · 0.168 · 0.267 · 3 · 0) | 27 · 0.091 · 0.807 · 4 · 8 (max 4.8 s) | — |
| look-rich | 13 · 0.168 · 0.247 · 2 · 0 | 20 · 0.053 · 0.195 · 0 · 10 | same row |
| img-4128 | 23 · 0.168 · 0.252 · 3 · 1 | 17 · 0.174 · 0.309 · 3 · 2 | 45 · 0.14 · 0.298 · 5 · 2 |

Reading it: the engine leaves the same air at every cut (the model's pads, to the millisecond)
and clips nothing; the old cut's air varied from 0 to 4.8 s. The "> 0.26 s" column is the
sentence-end pad (0.267 s) — his own sentence-end cuts sit there too. Kept-line agreement with
his hand edits (which lines he kept vs the machine) is 57–97 % — that is the Editor's job,
not the splice engine's, and is judged on Fridays by watching.

**Not done:** the few remaining "clipped" cuts (≤ 1 per fixture, 122–285 ms) are story joins the
planner placed at a Whisper boundary inside continuous speech (no pause ≥ 50 ms between the two
sentences) — the Editor v2 / join placement should prefer a voice gap; the harness's hand-edit
"air" and the pad samples use slightly different cut sets (all cuts vs pause cuts only).

**Ship note:** the scratchpad `ship.sh` once wrote an empty snapshot id to Vercel when the
snapshot build failed (a Node-only import had reached the browser bundle); the id was restored
by hand and the script now stops on an empty snapshot. Never let a ship script PATCH an env
from an unchecked value.

## 2026-10-22 — Editor v2 + Screen Orchestrator (Weeks 2–4 of the premium editor plan)

**Decision:** the Editor becomes write → critique → revise once, and one deterministic Screen
Orchestrator owns everything on screen from the Editor's plan. Built against the golden harness;
not yet shipped (needs a worker ship + a web push).

1. **Editor v2** (`prompts/agents/EDITOR.md` 2.0.0, new `prompts/agents/EDITOR_CRITIQUE.md`
   1.0.0 at MEDIUM, `packages/agents/src/editor-agent.ts`). The draft is read by a deterministic
   checklist (`editorPlanChecklist` in `full-edit/editor-plan.ts`: headline per beat, hook stands
   alone, ending is ENDING/PAYOFF, a kept line leaning on a cut line, an amount under a headline
   without a number, emphasis words he did not say, two TENSION lines with the same numbers, a
   one-sentence cold read) and by the Critique (semantic: the same eight checks, confirms or
   dismisses the deterministic findings, ≤ 8 findings with a line and a fix). Any finding → one
   revision with the draft and the findings in the prompt. The plan gains `emphasisWords` per
   line and a stored `review` (verdict, findings, revised) — the provenance of the cut. Cost: one
   HIGH when the draft is clean (+ one MEDIUM read); HIGH + MEDIUM + HIGH at most. A failed
   critique never costs the cut. `sanitizeEditorPlan` carries a missing headline forward from the
   previous entry (reported), so the engine always has a headline per beat; `critique: false`
   keeps the one-shot v1 call for tests. Alternatives: a second HIGH critique (too costly for a
   checklist read); a loop (the plan says once).
2. **Screen Orchestrator** (`packages/media/src/screen/`: `anchors.ts`, `plan.ts`, `audit.ts`).
   Anchors are resolved ONCE per video from the subject track (the stored track is the protected
   head region; the face is derived from it as the placement solver does), as the band the head
   stays inside 80 % of the time (p10/p90 of each edge per sample — a union grows to the whole
   frame the moment he leans once). Zone order: top zone above the head → over the hair above
   the face box (never the forehead, never the core) → side band (≥ 30 % of the width) → under
   the chin; the title is anchored over the hook's own framing (its punch-in), headlines and
   captions over the rest. Lanes: the title covers the hook beat; each later headline arrives
   on the first word of its idea (−0.05 s) and leaves after its last (+0.2 s), fading 0.2 s in /
   0.12 s out, exits 0.1 s before the next entrance, consecutive identical headlines merge, a
   beat shorter than 1.4 s shows none; a graphic slot opens only where the Editor named a need
   (never on the ending), 0.6 s after the headline settled (stacking = HELD_HEADLINE, the
   reference reel's pattern; NONE is available); the ending is a face beat; captions are QUIET
   (44 px, white, thin stroke, no plate, no highlight) at one spot near the chest — never higher
   than the base look's y — with chunk windows per beat (one word for a short emotional line,
   three for lines with amounts, two otherwise; `captions.chunking`, shared by preview and
   render); zooms are in-hold-out (1.08, 0.4 s in / 0.4 s out, ≤ 6 s hold) on the Editor's
   emphasis word, else at an idea boundary alternating wide/tight on a continuous take — the
   punch and the headline change share one instant — never on a beat with a graphic slot, and a
   push-in a third of the way into any stretch > 5 s with nothing changing (one per beat); the
   cover frame is the calmest gap between words in the hook once the title has settled. The
   free visuals bot now only picks graphics inside slots, and the placement solver takes the
   slot's zone as a preference (`preferredRects`). `FULL_EDIT_VERSION` 3. The free cut (no Editor
   plan) is unchanged except the hook title's close-up fallback, which no longer uses the face
   core as its limit (that put it on his forehead).
3. **Timeline schema** (all defaulted, persisted rows parse unchanged): `TimelineText.anchor`
   (TOP / SIDE_L / SIDE_R / NEAR_SPEAKER / FREE), `fadeIn` / `fadeOut` (drawtext `alpha`, ASS
   `\fad`, preview opacity — one curve, `textOpacityAt`); `TimelineZoom.easeOutSeconds` (the
   renderer's expression and `zoomStateAt` share `zoomProgressAt`); caption preset `QUIET`;
   `captions.chunking` windows. Preview = render for all four by construction.
4. **Gate G1 screen audit** (`screen/audit.ts`, run in `runDeterministicChecks` as
   `SCREEN_AUDIT`, MAJOR like the splice audit): text on the face core, two leads within 0.5 s,
   a zoom during a graphic, no title by 1.5 s, > 7 s with nothing changing, captions bigger than
   the headline. Promote to BLOCKING with the splice audit once real renders are clean.
5. **Known immediate fixes folded in:** `motion-design-job.ts` passes the stored edit's
   `report.editor.beats` to the Visual Strategist; the title never on the forehead.

**Golden baseline after this change** (`pnpm golden:replay --update`; the free cuts are
byte-identical to the Week 1 baseline except the title fallback size on close-ups):

| fixture (Editor cut) | headlines | zone | captions | zooms | graphics | audit |
|---|---|---|---|---|---|---|
| two-people-100k | 4 of 6 beats (one 1.1 s beat skipped) | TOP, over the hair | CHEST / QUIET | 1 (static, in the 16 s tension beat) | 1 | clean |
| before-investing | 8 of 10 beats | TOP, over the hair | CHEST / QUIET | 2 (boundary, with the headline change) | 1 | clean |

Both of his real framings leave no clean top zone (the head fills the top third; his chin sits
near the platform-safe bottom), so headlines sit over the hair above the face box, as prod's
title already did — the honest fix is upstream (the filming card: leave the top third empty).
Kept-line agreement with the hand edits is unchanged (the Editor's job, judged on Fridays).

**Verification:** `screen.test.ts` (anchors on wide / tight / untracked framings, headline
timing, one new thing per beat incl. strict mode, caption windows, zoom lane incl. the static
rule, cover frame, the audit catching six planted defects), `screen-render.test.ts` (fades,
ease-out, caption windows: preview = render), the Editor v2 tests (write → critique → revise,
accept path, v1 path), `full-edit.test.ts` updated for the orchestrator, the golden set green
on the new baseline; media + agents suites (63 files) green; worker, web, agents, domain
typecheck clean.

**Reversibility:** the orchestrator runs only when an Editor plan exists; the free cut is the
fallback; every schema field defaults to the previous behaviour; `EDITOR` 1.0.0 is the
rollback version.

## 2026-10-22 — Reference learning: what a viewer sees, as bands (Weeks 4–6)

**Decision:** references (and Chris's own hand edits) are measured as what a viewer sees and
hears in time, aggregated as bands, and read by the Editor, the orchestrator and Chris. The
previous profile (~50 scalars → medians → five clamped numbers) stays for the length target and
the pause keep; the StyleModel sits beside it. Built against unit tests and a synthetic OCR
reel; not shipped (same batch as Editor v2 + the orchestrator; needs a worker ship and, once
live, a re-measure of the reference library).

1. **Reference metrics v3** (`packages/domain/src/style-metrics.ts`, `REFERENCE_METRICS_VERSION`
   3; the job in `apps/worker/src/reference-analysis-job.ts`): `screen` — on-screen text events
   from OCR frames at 3 fps (appear / hold / leave, words, band, role HEADLINE when held ≥ 2 s
   with ≤ 8 words, CAPTION when short text chains in one band), headline cadence (per 10 s,
   hold, words, band, case), caption style (words per chunk, band, one-word share, coverage of
   the talking time), the hook text and when it is on screen, the longest bare stretch; `zooms`
   — punch-ins read off the head width within shots (the ONNX tracker at 3 fps: a monotonic
   change ≥ 6 % over ≤ 1.5 s then a hold ≥ 0.4 s; amount, ramp, hold, in-out share); `pads` —
   at every detected cut with voice within 0.6 s on both sides, voice offset → cut and cut →
   voice onset on the reference's own envelope (the reference's splice pads); `rhythm` — cuts
   per 10 s in the opening / middle / closing third and the jump-cut share. Each is a bonus:
   when it fails the rest of the measurement stands and a note says why. OCR is **tesseract.js**
   (pure WASM: the same code on the Mac and in the sandbox, no apt package; the English
   tessdata_fast model lives in `packages/media/assets/models/tesseract/`, downloaded into the
   snapshot by `restoreRunner`, gitignored locally; `TESSERACT_LANG_PATH` overrides). The
   package is loaded by name at runtime, so a machine without it still runs everything else.
   Alternatives: the tesseract CLI via apt (needs the snapshot's apt step and a Mac install;
   this Mac has no Homebrew) — rejected for parity; a vision model per frame — rejected for
   cost; a LOW vision fallback for frames OCR cannot read is still open.
2. **StyleModel** (`packages/domain/src/style-model.ts`, loader `getStyleModel` in
   `reference-videos.ts`): per-video samples → bands (p25 / p50 / p75 + n) for length, shot,
   cuts per 10 s, first cut, rhythm thirds, headlines per 10 s, headline hold / words / band /
   case, caption preset (ONE_WORD / PHRASE / NONE by mode) / words per chunk / band / coverage,
   hook text time and the share with text by 1.5 s, zooms per 10 s / amount / hold / in-out
   share, kept pause, pads, ends-on-last-word share, music share and level. **His hand edits are
   samples of his own** (`sampleFromTimeline`: headlines = texts held ≥ 2 s, caption preset from
   the chunk sizes, zooms, cuts — read straight off the stored timeline, no OCR), weighted
   double. A creator whose "don't copy" note names a signal (captions, headlines, zooms, cuts,
   music, length, hook) is left out of that band, and the model says so. Posted-unchanged
   videos join as "mine" once the Weeks 6–8 rating label exists. `describeStyleModel` is the
   one paragraph Chris can agree with; `editorDigest` the ten lines the Editor reads.
3. **Consumers:** the Editor's prompt gets the digest ("a range to work inside, never a quota");
   the orchestrator gets presets (`screenStyleFromStyleModel`: zoom amount inside 1.04–1.15,
   minimum headline hold from the references' holds, a longer face hold when they never punch
   in) and the caption habit (`captionDefaultsFromStyleModel`: one-word captioners get one word
   on every short line, phrase captioners their phrase size; amounts always get phrases); the
   `/reference` page and each creator's page show the paragraph. Both are part of the full
   edit's inputs key, so a changed model re-cuts. Not wired yet: gate thresholds from the bands
   (the orchestrator's audit stays rule-based until the watch-back weeks), graphic / B-roll
   density (no region detection yet), the splice model's band from the reference pads (shown
   and in the digest; the fitted hand-edit model stays authoritative).
4. **The sandbox snapshot** gains the tesseract.js language data (`restoreRunner`,
   `LITE_EXCLUDES`, `TESSERACT_LANG_PATH` in the runtime env). The reference-analyze job now
   also runs the head tracker and OCR per video (≈ 1–3 minutes more per reference); the time
   budget and "continue" flow already handle that.

**Verification:** `reference-learning.test.ts` (synthetic OCR reel → two headlines and
one-word captions classified; zoom detection vs jitter; reference pads at voiced cuts only),
`style-model.test.ts` (bands, mine ×2, exclusions, the paragraph and the digest as sentences, v2
rows without screen signals), the OCR adapter smoke-tested on a synthetic 6 s reel rendered
with drawtext (headline + one-word captions read back, see the session log), media + domain +
agents suites green, worker reference/edit job tests green, typecheck clean.

**Reversibility:** v1/v2 metrics rows parse unchanged; the StyleModel is additive (the old
profile and its five numbers are untouched); without references the digest and presets are
empty and the orchestrator uses its built-in defaults; OCR off = `screen: null`.

**Ship note (2026-10-22, evening):** both builds went live together — main `348087c` (web, git
deploy) then worker snapshot `snap_UH00hLNWOECDqqJNDuWzk6wY8dEJ` (built with `--base` on
`snap_4vt9RJNeBryX9SfkCtthOaea0YTO`, 2.2 min) set as `RENDER_SANDBOX_SNAPSHOT_ID` and a forced
production redeploy so web and worker match. The first snapshot attempt failed because the new
OCR-model download sat after the assets→bundle copy the manifest checks; fixed in `18fa514`.
The reference library must be re-measured (Measure on `/reference`) for the v3 screen signals.

## 2026-10-22 — The watch-back gate (Weeks 6–8 of the premium editor plan)

**Decision:** one watch-back stage, a bar not a score, replaces "three reviews that nothing
reads": free audits → one model watch judged against a reference → PASS / FIX / HOLD with typed
fixes, one fix loop, a HOLD for Chris, and autonomy redefined as agreement with him. Built
behind three flags that all default off; not shipped yet.

1. **Order inside the job** (`apps/worker/src/watch-back-job.ts`, heavy job `watch-back`):
   (a) the free audits — the splice audit and the screen audit from Weeks 1–4 plus a new story
   audit (`packages/media/src/watch/story-audit.ts`: every Editor line present and in order, no
   dependent opener whose referent was cut, the ENDING line last); (b) frames on both sides of
   every cut and screen change (the viewer check's planner, ≤ 36) and, when a measured reference
   with media exists, six of its frames at the same fractions of its length — **contrastive**
   judging, so the model answers "which reads as edited by a person" instead of rating its own
   work; (c) `WATCH_BACK` (HIGH vision): a six-item checklist answered in words with timestamped
   evidence, a cold-viewer read, ≤ 5 typed fixes; (d) `HOOK_TEST` (MEDIUM): the first frame and
   the first two seconds of words alone. The verdict is then settled by rule (`settleVerdict`):
   a clean checklist = PASS; fixes on the first watch = FIX; the loop spent = HOLD; a failed
   HOOK_BY_1_5S together with a NO from the hook test = HOLD regardless. Cost ≈ the viewer
   check's (same cap, `VIEWER_REVIEW_MAX_USD`) plus one MEDIUM call.
2. **Typed fixes** (`packages/media/src/watch/fixes.ts`, `WatchFixSchema`): EDITOR
   DROP_LINE / RESTORE_LINE / MOVE_ENDING by sentence id → Full-edit choices and a re-cut;
   SCREEN MOVE (to a zone) / SHRINK / DROP / RETIME (±3 s) by element id; SPLICE RETIME a cut by
   ±250 ms (never crossing the other side, never a clip under 0.2 s). Unknown elements are
   skipped and said so. With `watch_back.fix_loop` on, a FIX applies them (a re-cut when EDITOR
   fixes exist, else a new finishing-edit version noted "Watch-back fixes (automatic)" — kept
   out of the hand-edit set, `isHandEditReason`), re-renders, re-runs the hard gate and watches
   once more; a second FIX is a HOLD.
3. **HOLD without a new state.** The state machine is untouched (CLAUDE.md). A HOLD is a
   `WatchVerdict` row; with `watch_back.gating` on, `runPreflight` refuses to publish that exact
   render (`watchBackHoldFor`) until Chris answers on the content page: **Fix it** (rates 👎,
   runs the job with the loop forced) or **Post anyway** (a journaled `WatchRating` override
   that lets preflight through). In shadow (default) the verdict is recorded and shown only.
4. **Autonomy as agreement** (`packages/domain/src/watch-back.ts`): Chris's one-tap rating at
   post time (👍 good as-is / 👎 had to change it) is the label. Per series, over the last ten
   rated videos: agreement = PASS↔👍 or FIX/HOLD↔👎; earned at ≥ 90 % with no "post anyway"
   override; demoted by any pulled post or a rejected PASS. `watchBackEarnedFor` folds in the
   global `autonomy.shadow_only` switch; the ceiling stays human-only. `recordApprovedOutcome`
   for PUBLISHING now counts only when the video was rated 👍 — an API success is no longer the
   signal. The rating UI sits on the content page's watch-back card; a `PULLED` action is
   defined but no "pull this post" button exists yet.
5. **Flags:** `watch_back.auto` (run after every gate PASS, inside the render job, never costing
   the render), `watch_back.fix_loop`, `watch_back.gating`. Turn on in that order as the shadow
   agreement earns it; FACTUAL is never touched by any of them.

**Alternatives considered:** a new HOLD content state (rejected: the state machine is fixed and
the preflight + a verdict row express it); letting the model rate (rejected: the plan's "never
a score"); applying fixes without a re-watch (rejected: the second watch is what makes the loop
honest).

**Verification:** `watch.test.ts` (fixes applied and bounded, unknown elements skipped, five
max; the story audit on a clean and a broken cut), `watch-back.test.ts` (frames and reference
pairs labelled, audits and digest in the prompt, the hook test, the verdict rules),
`watch-back-agreement.test.ts` (the promotion and demotion rules), `watch-back-job.test.ts` (a
real tiny render: audits → HIGH watch → MEDIUM hook test → the row with its fixes; the loop
off; the preflight hold under the gating flag and its override; the agreement), the touched
worker suites (publish, autonomous publish, gate, viewer review) green; typecheck and lint
clean. Migration `20261022230000_watch_back` applied to the dev database.

**Reversibility:** every behaviour is behind a flag that defaults off; the tables are additive;
removing the flags leaves the hard gate exactly as it was.
