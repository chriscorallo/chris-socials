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
