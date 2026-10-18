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
