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
