# Pending decisions — Plan import (2026-10-17)

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
