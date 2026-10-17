# 2026-10-16 — Motion graphics + sound design in the finishing editor

(Pending merge into /docs/DECISIONS.md. Same format; one entry per decision.)

## 2026-10-16 — Visuals and Sound are first-class editor tools, on one document and one undo history

**Decision:** the finishing editor edits `EditTimeline.visuals`, `.sfx`, `.audio.music` and
`.audio.sfxEnabled` through pure document operations (`apps/web/lib/editor/visuals.ts`) applied
by the existing reducer, so every change — insert, props edit, drag, trim, Auto-place, music
level — is one undo step (continuous gestures coalesce, like texts). Two new tools in both
shells:
- **Visuals** (magic-wand icon; mobile toolbar, desktop timeline toolbar + inspector tab): a
  "Design visuals with AI" card, a gallery of the 14 templates (tap = insert at the playhead),
  and the list of graphics on the timeline. Selecting a graphic turns the same panel into its
  editor: a typed props form, look (palette, enter/exit), entrance sound (with audition),
  position (Auto / placed by you, size, Auto-place) and timing. Selection toolbar on phones:
  Edit · Auto-place · Duplicate · Delete.
- **Sound** (note icon): sound effects on/off, the free SFX kit (preview + add at playhead), the
  effects on the timeline, and the music bed (upload, pick, level, duck, fades, track start).
- Two new tracks on both timelines: **Visuals** (teal — never confused with text/zoom; label =
  template + short summary, e.g. "Counter · $24,500", amber ⚠ when the placement engine warns)
  and **Sound** (music bar + SFX pins).

**Props editor = one generator, one hand-written spec.** `TEMPLATE_FIELDS` describes every
template's fields (text with max length, number, enum, toggle, list of strings, list of rows
with add/remove inside the contract's min/max, nested objects, a point, an index into a sibling
list). A unit test asserts the spec mirrors `MotionPropsSchemas` key for key, and that every
template's default props validate. Kinetic-text emphasis is picked by tapping the words of the
text itself. A graphic whose props don't validate (e.g. an emptied label) shows "won't render
until…" in its editor and in the warnings list, and **Save refuses it by name** — the renderer
would otherwise skip it silently.

**Inserting** prefills from what's being said under the playhead (`phraseAt` over the output
caption words): kinetic text/title/callout get the sentence; counter/stat/ring/money stack get
the first number in it; everything else starts from the template's designed sample. The
anchor phrase is kept as `anchorText`.

**Overlap rule — prevented, not just warned.** Graphics live on ONE track and never overlap in
time: an insert lands in the free gap at (or after/before) the playhead and refuses with a toast
when there's no ≥1.2 s gap (entrance 0.7 s + exit 0.45 s); move/trim stop at the neighbours
(CapCut same-lane behaviour); duplicate goes into the next free gap. Rationale: the placement
engine treats other on-screen graphics as hard obstacles and the Motion Designer keeps ≥0.4 s
between them, so overlapping graphics would only ever produce LOW_CONFIDENCE placements. A ripple
edit that shortens the video can still squeeze two together (`normalizeDoc` clamps spans into
the duration but doesn't move them) — that's reported as an "overlap in time — trim one"
warning rather than silently moving Chris's graphics.

**Alternatives considered:** allow overlaps + warn (rejected: two graphics fighting for the
same frame is never what he wants on a 9:16 talking head); multiple visual lanes (no renderer
need, more UI); introspecting zod for the form (zod 4 internals; brittle; labels/ordering
still need a spec).

**Reversibility:** high — pure functions + UI.

## 2026-10-16 — Placement is solved live in the editor with the render's own engine

**Decision:** `Editor.tsx` runs `solveVisualPlacements(doc, { subjectTracks, sourceDimensions,
wordsByAsset, measure })` on every doc change (memoised; a few ms per graphic) — the same
function and inputs the worker uses before rendering (`withResolvedPlacements`). The preview
draws AUTO graphics where the engine puts them; the saved doc gets the solved x/y/scale
(`withResolvedPlacements` on save). Dragging a graphic on the preview (or its corner handle, or
a two-finger pinch, or the Size slider) sets `placement.mode = "MANUAL"` from where it is drawn
(no jump); **Auto-place** flips it back to AUTO and re-solves (`autoPlaceVisuals`). While
dragging, Chris's protected head region is outlined ("Face"). Placement warnings are reworded
with the editor's names and times ("Bar chart 5.4–8.3s no fully clear spot — best option still
overlaps Chris's face…") and appear in the existing warnings chip/sheet and the graphic's
editor; WARNING-severity ones also badge the clip on the timeline. Subject tracks come from the
server loader (`MediaAsset.subjectTrack` per take via `parseSubjectTrackRecord`).

**Reversibility:** high.

## 2026-10-16 — Preview layer: `<VisualsPreview>` loaded client-only, composited in render order

**Decision:** `MotionLayer.tsx` renders `@chris/motion/player`'s `<VisualsPreview>` through
`next/dynamic(..., { ssr: false })`, and only when the edit has graphics — Remotion/three.js
never weigh on the editor's first load. It sits over the graded picture + vignette and under
the platform-UI mock, texts and captions — the renderer's compositing order. It's fed the
placement-solved visuals and a frame-quantised playhead (the Player seeks exactly while paused
and only re-syncs on >2-frame drift while playing). Hit areas for the graphics are plain divs
(`data-gesture="visual"`) handled by the canvas's single gesture controller; they sit under the
text/caption SVG so texts keep tap priority, and a full-frame title card only grabs its middle
so taps elsewhere still play/pause. `apps/web` depends on `@chris/motion` and lists it in
`transpilePackages` (Turbopack transpiles workspace packages anyway; this keeps webpack builds
correct).

Verified (Chromium + WebKit, iPhone 15 393×852 touch; Chromium desktop 1440×900): counter,
3D bar chart and 3D icon render in the preview at their mid-times, including WebGL in WebKit.

## 2026-10-16 — "Design visuals with AI" = save first, then the HUMAN Motion Designer job

**Decision:** the button saves unsaved edits (the job designs on the latest saved version),
then calls `designVisualsAction` → `designMotionForContentItem(..., { trigger: "HUMAN",
replaceExisting, skipTracking: !isAutoSubjectTrackingEnabled() })`, reads the new EditPlan's
`plan.timeline` back and loads it as the saved version — as an undoable `replace`, so Chris can
undo the AI's pass in one tap. The result shows counts, each added graphic with the phrase it
illustrates (tap to select), rejections in plain English (`plainRejection`: "Dropped a bar
chart: 30,000 isn't in your fact-checked research or script."), placement warnings and the
model's rationale. Errors are worded for Chris (no key / out of credit / spending cap / service
busy) and say the edit is unchanged — verified with an invalid key in the throwaway env.

## 2026-10-16 — The FACTUAL gate checks numbers drawn by motion graphics (deterministic)

**Problem:** the Motion Designer validates numbers when it proposes graphics, but Chris can type
any number into a graphic in the editor. The Quality Gate's FACTUAL check only looked at the
Claims Gate verdicts — on-screen numbers in `timeline.visuals` were never checked, so the
editor's "the quality gate checks on-screen numbers" note would have been false.

**Decision:** `runQualityGateForContentItem` now runs `findUngroundedVisualNumbers` (pure,
exported from `apps/worker/src/quality-gate-job.ts`) over the rendered timeline's visuals:
every number a graphic shows (`numbersShownBy` — numeric props and digits/spelled-out numbers in
its strings; structural fields excluded) must match the research packet (numeric inputs, FACT
statements, calculation notes, primary claim) or the latest Claims-Gate-passed script, with the
Motion Designer's own tolerance (`numberIsGrounded`: formatting variants, honest roundings
within 5%, percent↔fraction). Reuses the helpers `@chris/agents` already exports — one
definition of "grounded". Any miss → FACTUAL BLOCK with a reason naming each graphic and number
("the number counter at 2.2s shows 30,000"), appended to any Claims Gate reason. Applies even
to fact-check-exempt items (an on-screen number with no source is still a claim). Tests: pure
cases (`quality-gate-visual-numbers.test.ts`) + an integration case through the real gate
(ungrounded → BLOCK naming 30,000; researched 24,500 → PASS).

**Reversibility:** high — one block in the job.

## 2026-10-16 — Preview sound: music bed + SFX on the engine's clock, iOS-safe

**Decision:** `preview-audio.ts` (`PreviewAudio`) hooks the playback engine: a new
`engine.onPlayGesture` hook runs inside the play tap (the only moment iOS allows sound), where it
creates/resumes the AudioContext, starts the music `<audio>` at `trackStart + t` and warms the
SFX buffers. Music gain follows `lib/editor/music-mix.ts` (pure, tested): `levelDb` as linear
gain, minus `duckDb` while words are spoken (speech regions merged at 0.45 s, 0.15 s lead-in,
0.4 s release — the renderer's ramps), fades in/out; it re-syncs on >0.3 s drift. Same-origin
music (local storage) is routed through a WebAudio GainNode because iOS ignores
`HTMLMediaElement.volume`; in blob mode the file is a cross-origin presigned URL, so the
element's own volume is used (desktop honours it; on iPhone the bed plays at full level — the
sheet says so). SFX (entrance sounds + free effects, house gain 0.5 like the mixer) are decoded
once from `/api/sfx/<sound>.wav` and fired when the playhead crosses them (not on seeks). It's
an approximation for judging fit; the render's loudness-referenced mix is the truth.

## 2026-10-16 — `/api/sfx/[file]`: auth-protected, SFX_SOUNDS-whitelisted

Mirrors `/api/fonts`: only `<sound>.wav` for a contract `SFX_SOUNDS` id is served, from
`packages/motion/assets/sfx` located by a cwd walk (`lib/motion-assets.ts`, no import of
@chris/motion's Node entry). `next.config.ts` traces `packages/motion/assets/sfx/*.wav` into
functions; Remotion's compositor and rspack binaries are excluded from traces.

## 2026-10-16 — MUSIC uploads end to end; music is never a take

**Decision:** uploads take a `kind` (`RAW_TAKE` default | `MUSIC`): `PUT /api/upload?kind=MUSIC`
(local), `music/<contentItemId>/...` pathnames in `/api/blob-upload` (audio-only token) +
`registerBlobUpload({ kind })` (blob). MUSIC requires an audio mime (415 / error otherwise, and
`createMediaAsset` refuses too), keys live under `music/<item>/`, the asset is ffprobed for its
duration, and it **never** transcribes, tracks, or moves the item (`analyzeMediaAsset` only
treats a RAW_TAKE as ingestion). Takes-only consumers fixed: `listMediaAssetsForContentItem`
now defaults to RAW_TAKE (option `{ kind: "MUSIC" | "ALL" }`) — that's what take selection and
the pipeline use; `transcribeContentItemTakes`/`transcribeMediaAsset` skip non-takes; the
content page lists takes and music separately; the editor's media bin already loaded RAW_TAKE
only. The Sound sheet uploads with the same transports as the take uploader and shows "use
music you have the rights to". Verified: an audio upload creates a MUSIC asset that appears in
the Sound sheet; a video sent as music gets 415.

## 2026-10-16 — Subject tracking runs after upload (local only)

`registerUploadedRawTake` schedules `trackSubjectForMediaAsset` in the same `after()` as
transcription (after it), gated by `isAutoSubjectTrackingEnabled()` — on locally, off on Vercel
(`SUBJECT_TRACKING=on|off` overrides), mirroring transcription; only for takes with video.
The editor's AI design also skips tracking where it's off (placement then assumes centred
framing and says so).

## 2026-10-16 — Renders started from the app include the motion layer (child process)

**Problem found in verification:** "Finish" rendered successfully but **without graphics**:
inside the Next.js server, the worker's lazy `import("@chris/motion")` reaches Node's native ESM
loader, which can load the package's `.ts` entry but not its extensionless relative imports
(`Cannot find module …/packages/motion/src/timing`). `prepareMotion` degraded gracefully (warning
on the Render row), so the bug was silent in the UI. (Loading it through tsx's in-process
`tsImport` was tried and crashed the dev server — tsx's namespaced loader and Next's require hook
collide inside Remotion's CJS interop — so it's not used.)

**Decision:** the worker's `defaultLoadMotion` first uses a host-registered loader
(`globalThis.__chrisMotionLoader`, a 5-line change in `apps/worker/src/render-job.ts`). The web
app registers one in `instrumentation.ts` (Node runtime, not on Vercel):
`lib/motion-subprocess.ts` returns a `MotionModule` whose `sfxFiles()` are plain paths and whose
`renderVisualsLayer()` runs `apps/web/scripts/render-motion-layer.mts` under the repo's tsx in a
child process (JSON in/out). Remotion and @chris/motion's TypeScript never load inside the Next
server or its bundle. Covers every render path in the app (Finish, Render, pipeline,
auto-repair). Verified: the editor's Finish render now reports 3 overlays / 4 SFX / 261 motion
frames and the extracted MP4 frames show the counter, 3D bar chart and 3D icon exactly where
the preview drew them (`docs/evidence/2026-10-16-motion/editor-render-frames.jpg`).

**Vercel:** unchanged — no tsx/Chrome in a function; renders there degrade to "no visuals" with
a warning, as documented in the motion-engine INTEGRATION NOTES (use the worker host / Sandbox).

**Reversibility:** high — remove the registration to restore the old behaviour.

## Verification notes (2026-10-16)

Throwaway PGlite (migrated + seeded), a synthetic portrait talking-head take with a real `say`
voice + Whisper word timings, a constant subject track for the drawn head, research with
$24,500 / $4,080, a tone-generated music bed (MUSIC asset), a finishing edit with NUMBER_COUNTER,
BAR_CHART (depth3d) and ICON_3D + a CASH effect + music, rendered; `next dev` with an invalid
Anthropic key. Playwright: Chromium + WebKit at iPhone 15 (393×852, touch), Chromium desktop
1440×900. Evidence: `docs/evidence/2026-10-16-motion/editor-*.jpg`.

Known gaps: (1) the 3D bar chart's title and highlight value overlap when the chart is shrunk to
0.7 (template layout, `@chris/motion`); (2) with Chris filling the middle third, the bar chart had
no fully clear spot — the engine says so (LOW_CONFIDENCE) rather than hiding it; (3) the
Design-with-AI happy path is untested end to end here (no Anthropic credit) — its error path,
save-first and reload-as-saved-version logic are exercised; (4) real-iPhone audio checks
(WebAudio unlock, ducking audibility) still need a device pass; (5) Next's dev-tools badge
covers the first toolbar tool in dev only.
