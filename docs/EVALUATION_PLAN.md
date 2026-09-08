# Evaluation Plan

A subsystem is not done because a happy-path demo works (spec §24 / §27). This document maps
required test categories and gold-standard fixtures to the phase that first needs them, so
Phase 0's suite isn't over-built for capabilities that don't exist yet, and so no later phase
ships without the tests the spec requires.

## Gold-standard fixture set (§24)

Seeded incrementally into `/fixtures` starting Phase 2 (the first phase with real model
calls to evaluate against). Each fixture pair below is a positive/negative example used by
prompt evals and regression tests:

| Fixture pair | Exercises | First needed |
|---|---|---|
| Chris-voice script / non-Chris-voice script | Brand Guardian, Script Agent | Phase 2 |
| Good finance script / bad finance-bro script | Script Agent, Brand Guardian | Phase 2 |
| Accurate claim / misleading or unsupported claim | Claims Gate | Phase 2 |
| Good raw edit / overedited raw edit | Edit Planner, Visual Director | Phase 3 |
| Good chart / wrong-number chart | Edit Planner, Visual QA | Phase 3–4 |
| Clean caption / text-over-face defect | Visual QA | Phase 4 |
| Correct captions / broken/mismatched captions | Visual QA, auto-repair | Phase 4 |
| Good reference-inspired content / excessive creator copying | Reference Intelligence, Brand Guardian | Phase 2 |
| Appropriate CTA / cringe CTA | Script Agent, Brand Guardian | Phase 2 |
| Duplicate/repeated concept vs. genuinely distinct idea | Weekly Strategist (portfolio dedup) | Phase 2 |

## Test categories, mapped to phase

| Category | Purpose | First required in |
|---|---|---|
| Unit | Pure function correctness (state machine, aggregation logic, adapters) | **Phase 0** |
| Integration | Multiple components together (DB + service layer, auth flow) | **Phase 0** |
| State-machine | Valid/invalid transitions, persistence, idempotency, rollback | **Phase 0** |
| Prompt registry validation | Frontmatter completeness, no duplicate active `prompt_id` | **Phase 0** |
| Media fixtures | Known-good raw/rendered video samples | Phase 3 |
| Malformed-media | Corrupt/incomplete media handled without crashing the pipeline | Phase 3 |
| Publishing-mock | Platform adapter success/failure/partial-failure paths | Phase 5 |
| Retry | Idempotent retry of a failed job produces no duplicate side effects | Phase 3 (render), Phase 5 (publish) |
| Prompt eval | A prompt version change is evaluated against fixtures before going active | Phase 2 |
| Regression | Hard-gate BLOCK is never averaged away; previously-fixed defects stay fixed | Phase 4 |
| Visual QA | Frame/temporal defect detection against fixtures | Phase 4 |
| Factual | Claims Gate against the accurate/misleading fixture pairs | Phase 2 |
| Brand voice | Brand Guardian against voice fixture pairs | Phase 2 |
| Recovery / failure-path | Graceful degradation per §21 (one platform down, one video fails, etc.) | Phase 3+ |

## Phase 0 acceptance tests (concrete — see `/docs/PHASE_PLAN.md` for full list)

1. State machine: every valid transition in `/docs/STATE_MACHINE.md` succeeds; every
   transition not in the table is rejected with a typed error; every attempted transition
   (success or reject) is auditable via its history.
2. Audit log: writing an entry and reading it back preserves `before`/`after`/`metadata`
   exactly.
3. Feature flags: default value is respected; toggling persists and is immediately visible to
   a fresh read.
4. Prompt registry: all files under `/prompts/**` parse with valid frontmatter; a deliberately
   malformed fixture prompt is rejected by the loader with a specific error, not a silent skip.
5. Prisma migration: applies cleanly from an empty database.
6. Auth: an unauthenticated request to the protected route is redirected/rejected; the seeded
   user's credentials succeed.

## Prompt-change evaluation rule (§17, applies from Phase 2 onward)

No prompt version may move from `active: false` to `active: true` without first running
against its fixture set with a recorded pass result. This is enforced by
`packages/prompts`' loader once evals exist (Phase 2) — Phase 0 only enforces registry
*validity*, not eval status, since there are no real prompt executions yet to evaluate.
