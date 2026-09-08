# Architecture

See `/docs/PRODUCT_SPEC.md` for the product-level view and `/docs/DECISIONS.md` for why each
stack choice below was made. This document is the system-level view: layers, orchestration
pattern, authority enforcement, memory, and repo structure.

## Four layers

The system's components each belong to one of four conceptual layers (long-form spec Parts
introducing the system; consistent with compact spec §4/§7/§11). Every subsystem built from
Phase 1 onward should be placeable in exactly one (or clearly two) of these:

1. **Truth** — Brand Constitution, Chris Brain, factual sources/citations, the content
   archive, Evidence Ledger, Decision Journal, Taste Model, Brand Timeline, strategic
   objectives, platform constraints, approved asset library, reference creator corpus.
2. **Intelligence** — Creative Director, Weekly Strategy, Research, Reference Intelligence,
   Scripting, Audience Intelligence, Experimentation, Learning, Adversarial Evaluation.
3. **Production** — Creator Cards, filming queue, raw media ingestion, transcription, take
   selection, edit planning, deterministic editing/rendering, captions, graphics, asset
   management, visual QA, technical QC, auto-repair.
4. **Distribution & Learning** — content calendar, auto-fill, platform packaging, publishing,
   publication verification, metric snapshots, comments, performance analysis, experiments,
   weekly review, belief updates, next-week planning.

## Orchestration pattern (§4)

**One orchestrated intelligence system, not autonomous bots chatting freely.** A single
Creative Director / Orchestrator sits above named specialists. Specialists communicate through
**typed, structured, persisted artifacts** (`WeeklyProgrammingThesis`, `ProductionContract`,
`ResearchPacket`, `CreatorCard`, `ScriptPackage`, `EditPlan`, `QCReport`, `PlatformPackage`,
`PerformanceSnapshot`, `BeliefProposal`, `DecisionJournalEntry` — see `/docs/DATA_MODEL.md`),
never unrestricted prose chains.

Subagents are used only when isolated context, real parallelism, independent evaluation, or a
different toolset materially improves quality — never for trivial sequential work merely
because agents exist. Deterministic code is preferred over LLM judgment wherever the check is
actually deterministic (technical QC, hard-gate aggregation, state transitions); LLM judgment
is reserved for genuinely semantic decisions.

Full specialist roster, inputs, outputs, and model-routing class: `/docs/AGENT_CONTRACTS.md`.

## Authority hierarchy (§5) — and how it's enforced in code, not just convention

1. Human Owner (Chris) — final say on everything except platform/security/factual hard
   constraints.
2. Hard Gates — factual failure, severe technical failure, security issue, invalid platform
   state, required compliance failure, missing final media, unresolved blocking QC.
3. Brand Constitution
4. Current Strategic Direction
5. Creative Director
6. Strong first-party Chris evidence
7. Specialist domain guidance
8. Reference creator patterns
9. Generic industry assumptions

**Enforcement rules, not just documentation:**

- Hard-gate results are modeled as a discriminated union, `{status: "PASS"} | {status:
  "BLOCK", reason}`, never a numeric score. The function that aggregates a `QCReport` or
  `ClaimsGateResult` cannot silently average a `BLOCK` into a passing composite — its return
  type makes that impossible to express, not just discouraged by convention (see
  `packages/domain/src/state-machine.ts` and the hard-gate result types once Phase 4 lands).
- Every human override of a specialist recommendation writes a `DecisionJournalEntry` with
  `userOverride = true`. This is the raw material Phase 7's Taste Model learns from — it must
  never be optional or best-effort.
- Learning-system belief proposals (`BeliefProposal`, Phase 7+) never gain write access to
  `BrandConstitutionVersion`, `BrandMemory`, or strategic-objective tables. They can only be
  *read* by the Creative Director and a human for promotion to `Belief` status. This is a
  permissions-layer fact, not a prompt-level instruction — no service role granted to a
  learning job includes write scope on those tables.

## Memory (§6)

Four distinct memory types — deliberately not collapsed into one generic "memory" store:

1. **Constitutional** — what the brand *is*. `/brand/*.md` + `BrandConstitutionVersion` /
   `BrandMemory` rows. Slow-changing, human-owned.
2. **Episodic** — what *happened*. Every idea, content item, script version, edit, render,
   publication, metric snapshot, comment, human intervention. This is most of the data model.
3. **Semantic** — what the system currently *believes*. Every `Belief` carries statement,
   evidence, sample size, applicable platform/topic/format, date range, confidence,
   confounders, contradictory evidence, first/last-evaluated dates, retest conditions, status.
   Arrives Phase 7.
4. **Strategic** — where the brand is *deliberately going*. `StrategicObjective` entities.
   Historical performance must never silently override a deliberate strategic move (e.g.
   reducing debt-content concentration even if it currently performs well).

## Required intelligence stores (§7)

- **Evidence Ledger** — every learned rule carries provenance; "AI thinks this works" is never
  a valid belief state on its own.
- **Decision Journal** — question, selected decision, alternatives, rationale, evidence,
  confidence, decision owner, agent/model/prompt version, human override, later outcome,
  retrospective. Exists from Phase 0 (used first for architectural decisions via
  `/docs/DECISIONS.md`; used for creative/strategic decisions via the DB entity from Phase 1+).
- **Brand Timeline** — what historically worked / what works now / where the brand is
  intentionally going, tracked as eras. Era names and boundaries are not hardcoded — the
  system and Chris define them from actual evolution (Phase 7).
- **Human Taste Model** — learns from Chris's edits/rejections (too corny, too corporate, too
  AI, too busy, sounds like me, leave it raw, etc.) via `TasteFeedback`. Never converts one
  preference into a universal rule without accumulated evidence (Phase 7).
- **Content Graph** — `ContentRelationship` edges: `derivative_of`, `remake_of`,
  `inspired_by`, `same_topic_as`, `same_hook_family`, `same_format_family`,
  `experiment_variant_of`, `newsletter_related`, `reference_influenced_by` (Phase 2+).

## Reference creator intelligence (§8)

Reference creators (e.g. Jun Yuh and similar personality-led creators) are supplemental
evidence, never brand authority. Evidence hierarchy: Chris first-party evidence > Chris
historical evidence > similar reference creators > broad creator best practice > untested AI
intuition. Governing principle: **"Principles transfer. Identity does not."** External
creators propose tests; they never become Chris's identity (enforced at the prompt level in
`/prompts/agents/REFERENCE_INTELLIGENCE.md` and checked by `Brand Guardian`).

## Model routing (§16)

Provider/model abstraction — never hardcoded to one vendor or model generation.

- **HIGH-JUDGMENT** (Creative Director, Weekly Strategist, Adversarial Evaluator, nuanced
  brand/reference decisions) → strongest configured reasoning model.
- **MEDIUM** (scripting, edit plans, visual review, audience intelligence) → high-quality
  configured multimodal/text model.
- **LOW/HIGH-VOLUME** (tagging, metadata extraction, simple classification, formatting) →
  cost-efficient configured model.
- **DETERMINISTIC** — plain code, no LLM call at all.

Every job carries limits: max reasoning calls, max independent evaluations, max vision passes,
render iterations, generated-media budget, escalation threshold, timeout, retry count (the
"cost & latency governor"). This exists conceptually from Phase 0 (documented here, in the
data model as job-level config) and becomes load-bearing once real model calls exist in Phase
2+.

**Logging AND a first enforcement mechanism implemented (post-Phase-8):** every real call now
writes a `ModelCallLog` row (tokens, computed `costUsd`, latency, success/failure) via
`CostTrackingModelProvider` wrapping `ModelProvider` at the single real instantiation point
(`apps/web/lib/model-provider.ts`) — see `/docs/DECISIONS.md`'s cost-logging entry and
`/docs/DATA_MODEL.md`. The same decorator also enforces a rolling-UTC-day USD ceiling
(`MODEL_SPEND_DAILY_CAP_USD`, default $30/day — `packages/agents/src/spend-cap.ts`): a call
that would push today's spend at/over the cap is refused *before* it ever reaches Anthropic
(zero tokens spent) and the refusal is written to `AuditLog` as `MODEL_SPEND_CAP_BLOCKED`, so
it's visible later rather than silently invisible. See `/docs/DECISIONS.md`'s spend-cap entry
for the fail-open decision on the cap-check read itself. `MockModelProvider` (all automated
tests) is never wrapped — neither logging nor the cap apply to tests.

**Still deliberately not built:** per-job granular limits (max reasoning calls, max
independent evaluations, max vision passes, render iterations, generated-media budget,
escalation threshold, timeout, retry count — the rest of this section's original list). The
daily USD ceiling is a single blunt safety net across the whole app, not a per-agent/per-job
governor; that finer-grained version is real future work.

## Repo structure and rationale

```
/apps/web            Next.js app — all human-facing UI and API routes.
/apps/worker          Separate deployable process boundary. Exists from Phase 0 specifically so
                      that Phase 3's render-hosting decision (Vercel Sandbox vs. a dedicated
                      long-lived host for ffmpeg) doesn't force a monorepo restructure later.
/packages/domain      Shared types, Zod schemas, the state machine, Prisma client/schema. The
                      one package every app and every other package may depend on.
/packages/agents      Agent contracts/interfaces — typed input/output shapes per
                      /docs/AGENT_CONTRACTS.md. Stub until Phase 2.
/packages/prompts     Loads and validates /prompts/** against the registry format in
                      /prompts/README.md. Real from Phase 0 (the registry itself must be valid
                      before any agent can run).
/packages/media       Storage adapter interface (+ local-fs implementation now, Vercel Blob
                      implementation later — swappable by config, not by rewrite).
/packages/platforms   Platform adapter interfaces (Instagram/TikTok/YouTube). Stub until Phase
                      5; the interface boundary exists early so one platform's limitations
                      (see /docs/DECISIONS.md — rate limits) never leak into the others.
/packages/analytics   Stub until Phase 6.
/packages/evals       Eval harness + gold-standard fixture loader (/docs/EVALUATION_PLAN.md).
                      Stub until Phase 2, when the first real prompt evals are needed.
/brand                 Brand Constitution, Chris Brain — human-owned, versioned via DB rows.
/prompts               Versioned, git-diffable prompt source (see /prompts/README.md).
/docs                  This documentation set — the source of truth for future sessions.
/fixtures              Gold-standard eval fixtures (seeded incrementally from Phase 2 on).
```

Package boundaries follow the four layers above: `domain` and `prompts` are Truth-adjacent
infrastructure every layer depends on; `agents` is Intelligence; `media` and the render path in
`apps/worker` are Production; `platforms` and `analytics` are Distribution & Learning.
