# Teleprompter (2026-10-17)

Chris asked for a teleprompter so he can read his framework/script while filming — either
recording inside the app (like BIGVU) or keeping the full iPhone Camera app (Cinematic mode,
stabilization, HDR) with the script floating over it. To be merged into `/docs/DECISIONS.md`
by the integrator.

## The Apple constraint

A web app (Safari / home-screen PWA) cannot draw over, or control, the native Camera app.
The only thing iOS lets a web page keep on screen above other apps is a **Picture-in-Picture
video window**. So "script over the real Camera" can only be a PiP video whose frames are the
script.

## Decision — two modes, one entry point

Entry: **"Film with teleprompter"** — on a video's page while it isn't filmed yet, a camera
icon on every not-filmed row of the plan board and filming checklist, a button + per-video
icon on `/film`, and standalone at `/film/teleprompter` ("What are you filming?" → planned
videos not filmed yet, or "New video").

**Script source** (read-only, deterministic, no AI): latest `ScriptVersion` → Creator Card
(hook + talking points + notes) → the imported plan's hook + notes (`ContentItem.description`,
`Hook: …\n\nnotes`) → a paste box. Inline edits are for filming only: kept on that phone in
localStorage per video, tied to a fingerprint of the source so a newer script version wins.
Script versions are never overwritten (CLAUDE.md). The Creator Card step was added between
script and plan because it is literally "only what Chris needs to film" (spec §9 step 8).

**Mode 1 — Record here.** `getUserMedia` (front by default, flip to back), ideal 1920×1080 @
30 fps (4K / 60 fps offered only when `getCapabilities()` says the camera can), the ACTUAL
settings shown as "1080p · 30fps". Voice processing (echo cancel / noise suppression / auto
gain) OFF by default for a natural voice; "Voice cleanup" toggle turns it on. Script scrolls at
the TOP of the screen (reading line ~14% down the top 46%), i.e. under the front lens. Text
size, speed (1–10 = 90–225 words/min; pace is word-based so it doesn't change with text size),
tap to pause, drag to scrub, mirror-text toggle (teleprompter glass), 3-2-1 countdown,
"scroll only while recording" (default on). Preview is mirrored with CSS only; the recorded
track is not mirrored. `MediaRecorder` with MP4/H.264+AAC preferred (iPhone Safari), WebM
fallback, 10 Mbps at 1080p30 (15 at 60 fps, 35 at 4K), 192 kbps audio, 1 s timeslices so an
interruption (app switch, call, camera grabbed → track `ended`/`mute`, `visibilitychange`)
finalizes the take with everything recorded so far. Wake Lock while open (re-acquired on
return). Review: **Use this take** / **Retake** / **Keep & film another** (multiple takes per
session; only File/Blob references kept, object URLs revoked).

**Hand-off uses the existing plumbing only:** `preparePlannedUpload` →
`advancePlannedItemToFilmed` (honest SYSTEM steps to FILMED; no-op if already filmed) or, for a
new video, `createFootageItem` → `createContentItemFromFootage`; then `uploadRawTake` (Blob in
production, local streaming route in dev) with 3 attempts per take (2 s / 6 s back-off;
permanent errors like 413/415 are not retried); a partial failure keeps what landed and retries
only the failed takes into the same video; "Save a copy to this phone" is offered so a take is
never lost. Then the single-upload ending — extracted from `FootageUpload` into
`app/upload/OpenEditor.tsx` (`useOpenEditor` + `FinishingCard`) and shared — waits for captions
(capped, skippable), makes the starter edit + automatic style cut, opens the editor.

**Mode 2 — Use iPhone Camera (floating script).** The script is drawn on a 1280×720 canvas
(big bold white text, gold reading marker, "Starts in 10 — open Camera and hit record"
countdown), streamed into a muted inline `<video>` via `canvas.captureStream(30)`, and floated
with `requestPictureInPicture()` (fallback `webkitSetPresentationMode("picture-in-picture")`).
PiP play/pause → `pause`/`play` events → scrolling pauses/resumes. The draw loop is a 30 fps
timer, not `requestAnimationFrame` (rAF stops in the background). If the window doesn't open
(rejection, or no response within 3.5 s) the screen says so and offers **"Make a script video"**:
the scroll (with the countdown baked in) is recorded once into an ordinary MP4/WebM blob, which
floats natively — its PiP controls and scrolling no longer depend on the page running at all.
If PiP or `captureStream` is missing entirely, the screen says plainly it can't float here and
points to "Record here". "Upload my clip" on the same screen runs the same hand-off; "Upload
many clips" goes to `/plan/upload`.

Voice-follow scrolling (`webkitSpeechRecognition`) was **skipped**: on iPhone it competes with
the recorder for the audio session and in Camera mode the page is in the background; it could
not degrade gracefully enough to be worth the risk.

No schema change, no AI, no cloud jobs, $0 runtime cost.

## Alternatives considered

- **Native iOS app** (AVFoundation camera + overlay, or a Camera-app-adjacent widget): the only
  way to get true overlay control and native-quality capture, but App Store distribution,
  signing, a second codebase and review — far more friction than value at this stage. Still
  the upgrade path if PiP proves unreliable on Chris's phone.
- **Only in-app recording**: loses Cinematic mode / stabilization / HDR, which Chris asked to
  keep.
- **Only PiP**: depends on iOS behavior we can't verify here; Mode 1 is the dependable path.
- **Pre-render only (no live stream)**: robust, but costs the script's duration in waiting
  every time and can't change speed live. Kept as the fallback instead.
- **Persisting prompter edits as a new ScriptVersion**: would turn a filming tweak into a
  script revision (and an unchecked one for the claims gate); local-only is simpler and safe.

## Rationale

Final Test: one tap from where filming happens, plain language, no setup; quality preserved
(camera original at a high bitrate, or the real Camera app); nothing new to maintain
server-side; the take lands exactly like any other upload, so captions → style cut → editor are
unchanged.

## Reversibility

Fully reversible: delete `apps/web/app/film/teleprompter/`, `apps/web/lib/teleprompter/`,
`apps/web/app/components/TeleprompterLink.tsx` and the link insertions (video page, plan board,
filming checklist, `/film`). `OpenEditor.tsx` is a behavior-neutral extraction from
`FootageUpload`. No data written except normal takes; localStorage keys `tp:settings:v1`,
`tp:edit:<id>`.

## Verified / not verified

- Unit + DB tests: `apps/web/lib/teleprompter/teleprompter.test.ts`,
  `teleprompter-db.test.ts` (source selection, scroll math, wrap, mime/bitrate, settings,
  hand-off order/retry/permanent errors/partial failure, SELECTED → FILMED walk, footage-first
  new video, picker list).
- Playwright Chromium (fake camera) at 393×852: plan → teleprompter → record (countdown,
  scrolling, timer) → review → Use this take → raw take `video/mp4` H.264 + audio registered,
  item walked SELECTED → … → FILMED → MEDIA_INGESTED, starter edit made, editor opened. Float
  mode entered real PiP in Chromium. No horizontal overflow on any screen.
- Playwright WebKit (macOS engine, headless, no camera, no PiP in that build): feature
  detection, the "didn't open" message + fallback, and **"Make a script video" produced a
  15 s 1280×720 `video/mp4`** with WebKit's MediaRecorder; camera-denied path shows the plain
  message.
- **Not verified (needs a real iPhone):** PiP for a canvas stream on iOS; whether the live
  stream keeps scrolling while Safari is backgrounded; PiP from the home-screen PWA; recording
  orientation/rotation metadata and real resolution/fps; Camera recording while the PiP plays;
  Wake Lock in standalone mode.
