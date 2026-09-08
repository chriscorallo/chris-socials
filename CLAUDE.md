# CLAUDE.md — Chris Content Intelligence System

This repository is the source of truth. Not conversation memory, not a prior session's
summary — the repository. Every session, including this one after a context reset, follows
the bootstrap sequence below before touching architecture.

## Bootstrap sequence for any fresh session

1. Read this file.
2. Read `/docs/PRODUCT_SPEC.md`.
3. Read `/docs/ARCHITECTURE.md`.
4. Read `/docs/PHASE_PLAN.md`.
5. Read `/docs/DECISIONS.md`.
6. Inspect actual implementation and test status (run the test suite; don't assume).
7. Determine the current phase and the next incomplete acceptance criterion in
   `/docs/PHASE_PLAN.md`.
8. Continue from the next dependency-correct task. Do not redesign from memory of a past
   conversation — if something in this repo seems wrong, that's a decision to make and log,
   not a discrepancy to silently paper over.

`Chris_Content_Intelligence_Compact_Master_Spec.md` (repo root) is the canonical product
specification. `/docs/*.md` are derived from it and from decisions logged in
`/docs/DECISIONS.md`. If a doc and the spec ever disagree, the spec wins — fix the doc and
log why in `/docs/DECISIONS.md`.

## Standing rules

- **Read relevant docs before implementing a subsystem.** `/docs/ARCHITECTURE.md` for system
  shape, `/docs/AGENT_CONTRACTS.md` before touching any agent/prompt, `/docs/DATA_MODEL.md`
  and `/docs/STATE_MACHINE.md` before touching schema or transitions.
- **Never silently alter the Brand Constitution or Chris Brain** (`/brand/*.md`). These are
  human-owned. A change requires an explicit Chris decision, becomes a new
  `BrandConstitutionVersion`/`BrandMemory` row (never an overwrite), and gets logged in
  `/docs/DECISIONS.md`.
- **Never silently alter agent authority.** The hierarchy in `/docs/ARCHITECTURE.md` is fixed;
  a hard-gate `BLOCK` is never averaged away by a creative/brand score, by design, not by
  convention — this is enforced in the type signatures of the aggregation code, not just
  documented.
- **Never silently delete an audit trail.** `AuditLog` and `ContentStateTransition` rows are
  permanent. Deleting a `ContentItem`'s underlying media/PII is fine when required; deleting
  its history is not (see `/docs/SECURITY.md`).
- **Never commit secrets.** `.env.example` holds placeholders only; real values live in
  environment variables / a secret manager.
- **Use migrations for persistent schema changes.** No hand-edited schema drift between what
  Prisma's migration history says and what the database actually has.
- **Write tests for important behavior**, per `/docs/EVALUATION_PLAN.md`'s phase-by-phase
  test-category map. A phase does not count as done because its happy path works once.
- **Use typed schemas for agent outputs.** No specialist returns unrestricted prose for
  downstream parsing — see `/docs/AGENT_CONTRACTS.md` and the `output_schema` field every
  prompt's frontmatter declares.
- **Prefer deterministic code over LLM judgment when the check is actually deterministic**
  (technical QC, hard-gate aggregation, state-machine transitions). **Prefer LLM judgment over
  brittle heuristics when the judgment is actually semantic** (brand voice, factual nuance,
  creative quality). Don't reach for a model call to do arithmetic, and don't reach for a
  regex to do judgment.
- **Minimize unnecessary model calls.** Route by the model-routing classes in
  `/docs/ARCHITECTURE.md` — don't run a HIGH-judgment model for routine tagging.
- **Preserve provenance.** A belief without evidence, a claim without a source, a decision
  without a rationale — none of these are acceptable outputs from any specialist.
- **Make operations idempotent where possible.** State transitions, publish jobs, and render
  jobs all accept an idempotency key and must be safe to retry.
- **Log every external publishing action** — platform, post ID, URL, timestamp, exact
  packaging used, media hash, raw platform response. A publish isn't "done" until verified.
- **Maintain version history** for anything that changes meaningfully over time (scripts, edit
  plans, prompts, brand documents) — new rows, not overwrites.
- **Fail safely.** Graceful degradation per `/docs/PRODUCT_SPEC.md` §"Graceful failure" — one
  platform, one video, or one provider failing must never take down the rest of the week.
- **Use feature flags for risky/new autonomous behavior.** Autonomy is earned per subsystem,
  per `/docs/PRODUCT_SPEC.md` §"Autonomy levels" — never granted globally by default.
- **Maintain backward compatibility with persisted content** when reasonable — a schema change
  should have a migration path for existing rows, not just new ones.

## What NOT to do

- Do not redesign the product for convenience. If the spec says something is hard, that's
  usually deliberate (see `/docs/PRODUCT_SPEC.md`'s Final Test).
- Do not add major features not in the spec (`/docs/PRODUCT_SPEC.md` §"Explicitly out of
  scope").
- Do not skip a phase's acceptance tests to move faster. `/docs/PHASE_PLAN.md` defines the
  gate; do not claim a phase complete with a known critical failure.
- Do not stop merely because an external API or tool is temporarily unavailable. Build the
  interface/adapter and a graceful fallback, document the constraint in `/docs/DECISIONS.md`,
  and continue.

## When technical reality conflicts with the spec

1. Document the conflict.
2. Preserve product intent.
3. Choose the safest reversible implementation.
4. Update `/docs/DECISIONS.md` with the decision, alternatives considered, rationale, and
   reversibility.
5. Continue — don't stall waiting for a perfect answer when a reasonable path exists.

(See `/docs/DECISIONS.md`'s PGlite entry for a worked example of this rule in practice.)

## Final Test

Before any implementation or product decision:

> Does this make the system more capable, reliable, and intelligent while making Chris's real
> workflow simpler?

If it increases sophistication but increases Chris's friction, reconsider it. If it saves time
but materially damages quality, authenticity, or brand identity, reconsider it. If it increases
quality but consumes unreasonable human attention for negligible expected benefit, reconsider
it.

The product is **a premium AI creative organization in software** — not a dashboard full of
AI features.
