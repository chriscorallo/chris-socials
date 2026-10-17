# Content State Machine

Implemented in `packages/domain/src/state-machine.ts`. This document is the authoritative
transition table — the code must match this document; if they diverge, fix the code (or,
if the model itself needs to change, update this doc first and log why in
`/docs/DECISIONS.md`).

## States (§18 — 23 total)

`IDEA, SELECTED, CONTRACTED, RESEARCHING, RESEARCH_BLOCKED, RESEARCHED, SCRIPTING, SCRIPTED,
READY_TO_FILM, FILMED, MEDIA_INGESTED, TAKE_SELECTED, EDIT_PLANNED, EDITING, RENDERED,
QC_REPAIR, QC_BLOCKED, READY, SCHEDULED, PUBLISHING, PUBLISHED, MEASURING, ARCHIVED,
CANCELLED`

## Transition table

| From | To | Trigger |
|---|---|---|
| `IDEA` | `SELECTED` | Weekly Portfolio Design includes the idea |
| `SELECTED` | `CONTRACTED` | Production Contract issued |
| `CONTRACTED` | `RESEARCHING` | Research Agent starts |
| `RESEARCHING` | `RESEARCHED` | Claims Gate `PASS` |
| `RESEARCHING` | `RESEARCH_BLOCKED` | Claims Gate `BLOCK` |
| `RESEARCH_BLOCKED` | `RESEARCHING` | Re-research (rollback) |
| `RESEARCH_BLOCKED` | `CANCELLED` | Human/system decision |
| `RESEARCHED` | `SCRIPTING` | Script Agent starts |
| `SCRIPTING` | `SCRIPTED` | Script drafted |
| `SCRIPTED` | `READY_TO_FILM` | Creator Card issued |
| `READY_TO_FILM` | `FILMED` | Filming complete |
| `FILMED` | `MEDIA_INGESTED` | Raw media ingested |
| `MEDIA_INGESTED` | `TAKE_SELECTED` | Take Selector runs |
| `TAKE_SELECTED` | `EDIT_PLANNED` | Edit Planner produces an `EditPlan` |
| `EDIT_PLANNED` | `EDITING` | Renderer picks up the plan |
| `EDITING` | `RENDERED` | Render completes |
| `RENDERED` | `READY` | Hard gates all `PASS` |
| `RENDERED` | `QC_REPAIR` | Visual QA / Technical QC finds issues |
| `QC_REPAIR` | `RENDERED` | Repair applied, re-rendered (loop) |
| `QC_REPAIR` | `QC_BLOCKED` | Repair-iteration limit reached |
| `QC_BLOCKED` | `EDIT_PLANNED` | Human-directed rework (rollback) |
| `EDITING` / `RENDERED` / `QC_REPAIR` / `READY` / `SCHEDULED` | `EDIT_PLANNED` | Chris saves a finishing edit in the in-app editor (rollback; from `EDITING` = fixing an edit whose render failed) |
| `QC_BLOCKED` | `CANCELLED` | Human/system decision |
| `READY` | `SCHEDULED` | Auto-Fill Week places it on the calendar |
| `SCHEDULED` | `PUBLISHING` | Preflight passes, publish job starts |
| `PUBLISHING` | `PUBLISHED` | Publish verified |
| `PUBLISHED` | `MEASURING` | First metric snapshot job scheduled |
| `MEASURING` | `ARCHIVED` | Final snapshot window closes |
| *(any non-terminal state)* | `CANCELLED` | Explicit human/system decision, always with a reason |

`CANCELLED` and `ARCHIVED` are terminal — no outbound transitions.

## Rollback

These transitions count as rollback (spec: "allow rollback where appropriate" — everywhere
else, going backward means cancel-and-recreate a new `ContentItem`, not mutating history):

- `QC_BLOCKED → EDIT_PLANNED`
- `RESEARCH_BLOCKED → RESEARCHING`
- `EDITING | RENDERED | QC_REPAIR | READY | SCHEDULED → EDIT_PLANNED` — added 2026-10-16 for the in-app
  finishing editor: saving a human edit to a finished/scheduled video sends it back through
  render + all four hard gates before it can be scheduled again (an edit can change what's on
  screen, so a previous PASS no longer applies). A SCHEDULED item leaving SCHEDULED is never
  picked up by the scheduled-publish job. See /docs/DECISIONS.md ("In-app finishing editor").

## Rules

- No arbitrary state mutation. Every transition must appear in the table above; the state
  machine implementation rejects anything else with a typed error before writing anything.
- Every transition — valid or attempted-and-rejected — that succeeds writes one
  `ContentStateTransition` row (`fromState`, `toState`, `reason`, `actorType`, `actorId`,
  `createdAt`). This is the permanent transition history; it is never deleted or overwritten.
- Transition execution is idempotent: a repeated request carrying the same idempotency key
  and the same target transition is a no-op (returns the existing result), not a duplicate
  row or an error.
- `CANCELLED` transitions always carry a human-readable `reason` — no silent cancellation.
