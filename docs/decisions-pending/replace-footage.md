# Replace footage / Delete this clip (2026-10-19)

## Problem

Chris: "I want to delete the FOOTAGE I uploaded — not the video idea from the plan. I want to
import a new video since the other one is trash." The only delete was "Delete video", which
cancels the whole video (plan slot, script, schedule) — the wrong thing. Uploading another take
didn't help either: the existing edit kept using the old take.

## Decision

1. **Replace footage** — on the video page (under the primary button, whenever the video has
   takes and hasn't started posting) and in the editor (desktop media bin; phone "Clips &
   footage" sheet, opened by "Add clip"). Pick a clip → one confirm ("Replace the footage on
   '…'? Your old clip and its edit are removed; the video stays in your plan." + a line about
   the calendar day when it's scheduled) → the clip uploads through the normal upload plumbing
   (`uploadRawTake`: local stream / browser-direct Blob + `registerBlobUpload`; it now returns
   the new MediaAsset id) → `replaceFootageNow` → `replaceFootage` (domain) → the normal
   single-upload ending (`useOpenEditor`: wait for captions → `createStarterEdit` → automatic
   Full edit / Cuts only per "New uploads get" → editor). The old footage is removed only after
   the new clip has landed and been analyzed, so a failed upload never leaves the video empty.
2. **Delete this clip** — on every take (video page "Your clips" panel + the takes list under
   Details, and every take card in the editor) with a confirm that says what happens:
   - not in the current edit → only the file goes; the edit is untouched;
   - in the current (saved, or the editor's unsaved) edit and another usable take remains →
     the edit is rebuilt from it (longest remaining take, via `createStarterEdit`, + the
     automatic edit);
   - the last take → the video goes back to "needs footage" (FILMED: Upload / Film buttons);
     it stays in the plan.
3. **"Delete video" is renamed "Delete this video idea"**; the Plan trash icon's label and the
   confirm now read "Delete this video from your plan?" and point to Replace footage.

## Data / state

- `MediaAsset.removedAt` / `removedReason` (migration `20261019090000_media_asset_removed_at`,
  additive + nullable — existing rows are "not removed"). Removal is **soft for every take**:
  TakeSelection has an FK to MediaAsset and EditPlans / audit rows name take ids, so rows stay
  as history. The original, proxy, filmstrip, person matte and director sprite files are
  deleted (best effort, logged); derived-file pointers are cleared. Alternative considered:
  hard-delete unreferenced rows like recording segments do — rejected as an extra code path
  with no user benefit (the row also anchors MEDIA_ASSET_UPLOADED audit entries). A part of an
  open recording DRAFT still goes through the draft's own `deleteRecordingSegment`.
- Every take list / edit builder / job ignores removed takes (getContentItem,
  listMediaAssetsForContentItem, starter edit, captions wait, editor page + actions, video
  cards, teleprompter, director, transcription / ingest / proxy / matte jobs, finished-recording
  sequences, plan-import counts, reference style data, `/api/media`). `recordPreviewAssets` /
  `recordPersonMatte` refuse a removed take (a job that raced the removal can't re-attach files).
- New state transitions, explicit rollbacks (`FOOTAGE_ROLLBACK_SOURCES`, documented in
  STATE_MACHINE.md, tested): `TAKE_SELECTED…SCHEDULED → MEDIA_INGESTED` (rebuild) and
  `MEDIA_INGESTED…SCHEDULED → FILMED` (no takes left). Reachable only through
  `footage-removal.ts`, never a bare button; never from PUBLISHING onward. Re-selecting a take
  then uses the existing MEDIA_INGESTED → TAKE_SELECTED → EDIT_PLANNED path (new TakeSelection
  + EditPlan rows; the new starter edit is "untouched", so the automatic edit applies).
  Alternative considered: re-select a take in place from EDIT_PLANNED…SCHEDULED — rejected:
  it would need a second take-selection path that skips the state machine's ingest step.
- Stale renders: when the edit is invalidated, every Render's file + RenderVariant files are
  deleted and `Render.storageKey` is cleared (rows, QC reports, overrides stay). Graphic bakes
  are footage-independent and kept.
- Schedule: the ScheduleEntry is **kept** (same calendar day; the calendar already shows a
  dated, not-ready video as "Dated on the calendar but not finished yet"); the video page says
  "Still on your calendar for … — it won't post until it's finished again". The publish job only
  takes SCHEDULED items, so nothing posts until it renders and passes every gate again.
- Open recording drafts are discarded on replace (`discardRecordingSession`).
- Audit: `TAKE_REMOVED` (per take, with file count) and `FOOTAGE_REPLACED`; transitions write
  their usual rows. Concurrency: removal takes the same advisory lock as the automatic style
  cut / full edit, whose CAS requires EDIT_PLANNED — a racing auto edit can't land on old
  footage.

## Reversibility

The migration is additive; a removed row could be un-removed in SQL, but its files are gone
(that's the point — Chris called them trash). Transitions are additive to the table.

## Files

`packages/domain/src/footage-removal.ts` (+ test), `state-machine.ts`, `media-asset.ts`,
`recording-session.ts`, `content-item.ts`, `starter-edit.ts`; `apps/web/app/components/
{ReplaceFootage,DeleteTakeButton,DeleteVideoButton}.tsx`, `app/content/[id]/flow-actions.ts`,
`(detail)/page.tsx`, `edit/{Editor,MediaBin,MobileShell,context}`, `lib/upload-client.ts`,
`app/upload/OpenEditor.tsx`; worker jobs (removed-take filters only).

Worker code changed (filters in heavy-jobs / transcribe / proxy / matte / film jobs): the
cloud-worker sandbox snapshot should be rebuilt so the live ingest job ignores removed takes.
