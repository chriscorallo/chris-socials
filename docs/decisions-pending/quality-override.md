# Owner override: skip the AI quality check (2026-10-18)

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
