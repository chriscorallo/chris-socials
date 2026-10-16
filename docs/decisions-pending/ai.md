# Pending decisions — AI / agents / evals workstream

Entries in `/docs/DECISIONS.md` format, for the integrator to merge into that file (this
workstream was not allowed to edit it directly). All dated 2026-10-16.

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

## Known gaps / follow-ups

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

## WIRING NEEDED IN apps/web

1. **`app/content/[id]/actions.ts` → `runPipeline`:**
   ```ts
   const result = await runResearchToScriptPipeline(
     getModelProvider(),
     { contract, brandContext /* , strategyContext: optional */ },
     { contentItemId },               // attributes every ModelCallLog row to this item
   );
   await applyPipelineResult(prisma, contentItemId, toPipelineResultInput(result), { actorId });
   ```
   `toPipelineResultInput` (from `@chris/agents`) forwards the new `scriptClaimsGateResult`,
   `scriptHistory`, `blockReason`. The current hand-built object still compiles but DROPS the
   script-level gate result and history — replace it. New status `SCRIPT_BLOCKED` → item lands in
   RESEARCH_BLOCKED with the blocked script saved; show `blockReason` and the script's
   `scriptClaimsGateResult.requiredEdits/claims`. On READY, if `result.brandNeedsHumanReview`
   show a "Brand Guardian still has concerns" notice (state is SCRIPTED either way).
   Catch `PipelineBudgetExceededError`, `SpendCapExceededError`, `SpendCapCheckFailedError`,
   `ModelRefusalError`, `ModelOutputTruncatedError` and show their messages.
2. **Script page — edit + re-gate (new):** form posting `{contentItemId, baseScriptVersionId,
   spokenScript, note}` →
   ```ts
   const v = await createHumanScriptVersion(prisma, { contentItemId, baseScriptVersionId, spokenScript, note, actorId });
   const research = researchPacketFromRow((await getLatestResearchPacket(prisma, contentItemId))!);
   const { scriptClaimsGateResult, brandGuardianReport } = await regateEditedScript(getModelProvider(),
     { research, spokenScript, brandContext: await getBrandContextText(prisma), contentItemId });
   const { contentItemState } = await recordScriptRegate(prisma, { scriptVersionId: v.id, scriptClaimsGateResult, brandGuardianReport, actorId });
   ```
   Allowed only in SCRIPTED / RESEARCH_BLOCKED (`ScriptNotEditableError`). Show the version
   history via `listScriptVersions(prisma, id)` (authorType, revisedFromId, revisionNote,
   scriptClaimsGateResult.result). Use `isScriptVersionFilmable(latest)` to disable the Creator
   Card button with its `reason`; `createCreatorCardAndAdvance` now throws
   `ScriptNotClearedForFilmingError` otherwise.
3. **Production Contract form prefill:** "Draft with Production Director" button →
   `const draft = await draftProductionContract(prisma, getModelProvider(), contentItemId)`; prefill
   the existing 15-field form from `draft` (show `draft.rationale`); submit stays
   `createProductionContractAndAdvance`. Optional one-click:
   `draftAndIssueProductionContract(prisma, getModelProvider(), { contentItemId, actorId, triggeredByHuman: true })`.
   Autopilot callers omit `triggeredByHuman` and need flag `AUTOPILOT_PRODUCTION_DIRECTOR` on.
4. **Creator Card form prefill:** `const draft = await draftCreatorCard(prisma, getModelProvider(), contentItemId)`
   → prefill hook/talkingPoints/setup/estimatedMinutes/notes; or one-click
   `draftAndIssueCreatorCard(prisma, getModelProvider(), { contentItemId, actorId, triggeredByHuman: true })`.
5. **`app/strategy/actions.ts`:**
   - `generateThesis`: add `strategicContext: await buildStrategicContext(prisma)` to
     `runCreativeDirectorAgent` input (keep `referenceContext`).
   - `generatePortfolio`: pass `strategicContext: await buildStrategicContext(prisma)` and
     optionally `targetPortfolioSize`; replace the per-item `recordPortfolioItem` loop with
     `await recordPortfolioProposal(prisma, weeklyThesisId, allocation, { actorId })` (records
     items + new-idea proposals + journal entry).
   - New UI list: `listPendingIdeaProposals(prisma, weeklyThesisId)` → each shows title,
     description, gapFilled, whyThisWeek with Approve → `approveIdeaProposal(prisma, proposalId, { actorId })`
     (creates the IDEA item and selects it) / Reject → `rejectIdeaProposal(prisma, proposalId, { actorId }, reason)`.
6. **`/learnings` page:** "Refresh taste model" button → `await refreshTasteModel(prisma, getModelProvider(), { actorId })`;
   render the returned `[{artifactType, status: UPDATED|SKIPPED|FAILED, recorded, error?}]`.
7. **Platform packaging:** no change needed (`pkg.metadata` is still `Record<string,string> | null`).
   Taste Learner callers persisting results should use `toAcceptanceProbabilityInputs(artifactType, result)`.
8. **`lib/model-provider.ts`:** no change required; `withContext` is available on the existing
   `CostTrackingModelProvider` instance. Note the cap now fails closed.
9. **Env (add to `.env.example` / Vercel):** `RESEARCH_WEB_SEARCH=on`,
   `RESEARCH_WEB_SEARCH_MAX_USES=5`, `CLAIMS_GATE_WEB_SEARCH_MAX_USES=3`,
   `RESEARCH_WEB_FETCH_MAX_USES=3`, `MODEL_REFUSAL_FALLBACK=on` (set `off` to disable);
   `MODEL_HIGH/MEDIUM/LOW` remain optional overrides.
10. **Serverless file tracing:** `getBrandContextText` reads `brand/VOICE_SAMPLES.md` at runtime
    (missing file degrades to "no samples"); include `brand/**` alongside `prompts/**` in
    `outputFileTracingIncludes` so samples reach production once Chris fills them.
