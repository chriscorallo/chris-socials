# Pending decisions — media / rendering / transcription

Entries below are written in `/docs/DECISIONS.md` format for the integrator to merge into
that file (this branch does not edit `DECISIONS.md` directly, to avoid merge conflicts).
Evidence frames: `docs/decisions-pending/media-evidence/`.

---

## 2026-10-16 — Overlay text goes through drawtext `textfile=` + `expansion=none`, not inline `text=`

**Decision:** every overlay line is written to its own temp UTF-8 file and drawn with
`drawtext=textfile='…':expansion=none`. `sanitizeDrawtextValue` is deleted. Only file paths
(developer-controlled) are escaped for the filtergraph; untrusted text never enters it.

**Bug fixed (verified):** `sanitizeDrawtextValue` didn't escape `%`, so "Save 50% more" made
drawtext log `Stray %` and draw *nothing* while ffmpeg still exited 0. It also rewrote `:` to
`–` and stripped commas, semicolons and brackets.

**Alternatives:** (a) better escaping of inline `text=`, rejected: ffmpeg's nested quoting
plus `%{}` expansion is fragile, and getting it wrong lets text inject into the filtergraph;
(b) render all text through libass, rejected for overlays because drawtext + our own
font-metric layout gives exact pixel rects that the collision and safe-zone code can reason
about.

**Regression tests:** `render-pipeline.test.ts` renders `Save 50% more: "don't" [yes], ok;
café \ naïve`. It asserts no ffmpeg warnings (no `Stray %`), that the laid-out text equals the
input byte-for-byte, and that the measured **ink width of each rendered line** matches the
font-metric width of the full line (a dropped glyph makes the line measurably narrower).
A NUMBER_CALLOUT of just "50%" must put ink in its rect.

**Reversibility:** high.

---

## 2026-10-16 — Bundled Inter (OFL) fonts; missing font is a hard error

**Decision:** ship Inter 4.1 static TTFs in `packages/media/assets/fonts/`
(`Inter-SemiBold`, `InterDisplay-Bold`, `InterDisplay-ExtraBold`, about 1.2 MB total). They
come from the official rsms/inter GitHub release, and the OFL license sits at
`packages/media/assets/Inter-OFL-LICENSE.txt`. It lives outside `fonts/` because libass tries
to load every file in its `fontsdir`. `resolveBundledFontPath()`, `resolveBundledFontsDir()`
and `DEFAULT_FONT_PATH` are exported from `@chris/media`. `renderVideo` now **throws
`RenderFontNotFoundError`** if a given `fontPath` doesn't exist, or if any bundled weight is
missing. Before this, ffmpeg silently substituted a random fontconfig font and exited 0.

`RenderInstructions.fontPath` is now optional. Omitted, or pointing at a bundled file, each
overlay style uses its own bundled weight. Any other existing path is used for all overlays,
as an explicit brand-font override.

**Alternatives:** `@fontsource*` packages ship WOFF2 only. FreeType reads WOFF2 only when
built with brotli, which we can't assume of a static ffmpeg, so we use TTF. DejaVu Sans was
also considered; Inter reads as more premium and has proper display cuts.

**Font discovery** order: `RENDER_FONTS_DIR` env, then a path relative to the module
(`import.meta.url`), then a walk up from `cwd`. The cwd walk exists because Next's server
bundling rewrites `import.meta.url`, the same bug class as the ffmpeg-static `__dirname` entry.

**Reversibility:** high. Replace the TTFs or set `RENDER_FONTS_DIR`.

---

## 2026-10-16 — Deterministic text layout: font-metric wrapping, auto-shrink, per-style presets, safe zones

**Decision:**
- Text is measured with `opentype.js` (pure JS) reading the same TTF that drawtext renders.
  ffmpeg 6's drawtext does no shaping or GPOS kerning, so summed advances match the screen.
  A 4% margin absorbs FreeType's per-glyph rounding.
- Wrapping is greedy and then balanced (no orphan last line). Font size shrinks in steps of
  about 6% down to a per-style minimum to respect max lines. Text is **never truncated**: a
  word too wide for a line is hard-broken by character.
- Multi-line blocks use one drawtext per line with `y=<baseline>-ascent`, so baselines are
  exact whatever glyphs a line contains.
- Styles (`OVERLAY_STYLE_PRESETS`) are restrained by design: one family, one accent colour
  (`#FFD84D`), flat translucent plates.
  - HEADLINE: Inter Display Bold, 78→50 px, ≤3 lines, black@0.58 plate.
  - CAPTION: Inter SemiBold, 54→40 px, black@0.48 plate.
  - NUMBER_CALLOUT: Inter Display ExtraBold, 170→92 px, accent colour, outline + soft shadow,
    no plate.
  - LOWER_THIRD: Inter SemiBold, 46→36 px, left-aligned, black@0.62 plate with an accent bar.
- Safe zones (`SAFE_ZONE_9X16_REFERENCE`, `getSafeArea()`): on a 1080×1920 canvas, top 250,
  bottom 420, right 140 and left 60 px are off limits, scaled for other 9:16 sizes. Landscape
  canvases get a 5% margin. Centred blocks are at most `2·min(540−60, 940−540)` = 800 px wide.
  Every block is clamped inside the safe area.

**Alternatives:** an average char-width heuristic was rejected as less accurate, and real
metrics only cost about 170 KB of JS. Rasterising text in JS (canvas/sharp) was rejected as a
heavier dependency for no gain.

**Reversibility:** high. The presets are data.

---

## 2026-10-16 — Word-level burned-in captions via libass (`ass` filter)

**Decision:** the bundled ffmpeg-static 6.0 has `--enable-libass`, so captions are generated
as an ASS script and burned in with `ass=filename=…:fontsdir=<bundled fonts>`. The pipeline:

1. Source-timeline words are remapped through the kept segments
   (`remapWordsToOutputTimeline`). Words in cut regions are dropped. Partially cut words are
   kept only if at least 50% or at least 0.12 s survives.
2. `buildCaptionChunks` makes 2–4-word phrases. It breaks on sentence or clause punctuation,
   on pauses over 0.35 s, and at a per-preset char limit. It merges orphan words, bridges gaps
   under 0.3 s, and enforces at least 0.45 s on screen without overlap.
3. `layoutCaptionChunks` pre-wraps lines with real metrics (`WrapStyle: 2`), so libass draws
   exactly what the layout computed.
4. Each chunk is placed with `\an2\pos()`.

Presets: `CLEAN` (Inter Display Bold, white, soft outline) and `BOLD_HIGHLIGHT` (Inter Display
ExtraBold, one event per word with the spoken word in the accent colour). Positions: `LOWER`
(bottom just above the bottom safe zone) and `CENTER`.

**Collision avoidance:** the renderer lays out overlays first. A caption phrase whose rect
would intersect a time-overlapping overlay is moved above that overlay, or below it, or to the
other caption band, whichever is first to fit inside the safe area without collision. Any
residual collision is reported in `unexecutedInstructions`. The new
`checkCaptionOverlayCollisions()` in `overlay-collision.ts` runs the exact same layout, so QC
sees only real residual collisions.

**Text safety:** in caption text, `{`/`}` become `(`/`)` and `\` becomes `/`, so ASS override
syntax can't be injected. This is a tiny, documented fidelity loss for characters that
essentially never occur in speech.

**Defaults:** an EditPlan with `captions: null` (incl. every row persisted before this change)
renders captions on, `CLEAN`, `LOWER` whenever the take has word timings. An explicit
`{enabled:false}` is respected.

**Alternatives:** one drawtext per chunk with `enable=between()` was rejected: no per-word
highlight, and hundreds of filters for a 60 s video.

**Reversibility:** high.

---

## 2026-10-16 — Punch-ins: split-trim-crop-concat (hard jump zooms)

**Decision:** `punchIns: [{startSeconds,endSeconds,zoom 1.0–1.3,focus CENTER|UPPER_THIRD}]`
on the output timeline. The renderer splits the concatenated video into pieces at the punch-in
boundaries and frames each piece with a **static crop in source pixels**:
`crop=min(iw,ih·W/H)/z × …`, then `scale=W:H:flags=lanczos`. The pieces are then
concatenated (video only; audio is untouched).

Zoom 1.0 is exactly the old cover-crop. Because the crop happens in source resolution, a
punch-in re-samples the original footage rather than upscaling an already-upscaled frame.
UPPER_THIRD centres the crop at 38% height to keep the face in frame.

Overlapping, out-of-range or sub-0.2 s punch-ins are skipped or clamped and listed in
`unexecutedInstructions`. The schema also enforces zoom 1.0–1.3.

**Alternatives:** `zoompan` was rejected. It is built for stills, has frame-rate/duration
pitfalls on video, and adds jitter. Per-frame `scale eval=frame` was rejected because
mid-stream size changes are fragile. Animated (eased) zooms are deferred: hard punch-ins are
the standard talking-head grammar and carry zero artifact risk.

**Test:** pixel diff vs a no-punch-in render is large inside the window and below 3 outside
it; output stays 1080×1920 at the right duration.

**Reversibility:** high.

---

## 2026-10-16 — Unexecuted EditPlan instructions are surfaced, and the planner is told the truth

**Decision:** `bRollRequests`, `musicTrack`, `sfxEvents` and `transitions` stay in the schema
for forward compatibility. They are now `.describe()`d as "NOT YET EXECUTED — leave empty",
and the Edit Planner prompt (v1.1.0) lists exactly what the renderer executes.
`listUnexecutedPlanInstructions(plan)` (worker) plus `RenderResult.unexecutedInstructions`
(renderer: skipped punch-ins, captions with no word timings, residual caption collisions) are
merged and stored **inside `Render.technicalQCReport`** under
`unexecutedInstructions` (plus `captions.rendered` / `captions.relocatedAroundOverlays`). They
are also returned on `RenderJobResult.unexecutedInstructions`. No schema change:
`technicalQCReport` is Json, and `overall`/`checks` keep their shape.

**Reversibility:** high.

---

## 2026-10-16 — Technical QC: EBU R128 loudness, true peak, blackdetect, freezedetect

**Decision:** the `volumedetect` dBFS sanity check is replaced by a single ffmpeg analysis
pass: `ebur128=peak=true` on audio, and `blackdetect=d=0.2:pix_th=0.10,freezedetect=n=0.003:d=1`
on video.

| Check | Rule | Severity |
|---|---|---|
| `integrated_loudness` | Integrated loudness must be within −24…−8 LUFS (target −14) | FAIL |
| `true_peak` | True peak must be ≤ −0.5 dBTP | FAIL |
| `black_frames` | Opening black ≥ 0.3 s, or any black stretch ≥ 1.0 s | FAIL |
| `black_frames_short` | A 0.5–1.0 s black stretch | WARN |
| `frozen_video` | A freeze ≥ 2 s | WARN, never FAIL |

Freezes are WARN only because a deliberate held frame (chart, still) is legitimate, and
telling it from a stuck decoder is Visual QA's semantic job.

`loudnorm` in the renderer now targets I=−14 (was −16), matching the QC target. On the demo
render: −14.4 LUFS, −1.4 dBTP.

**Shape compatibility:** `TechnicalQCReport` is still `{overall: "PASS"|"FAIL", checks}`. Checks
gain an optional `severity` (absent = FAIL). New optional fields `warnings` and `measurements`
are added. Only FAIL-severity failures make `overall` FAIL, so render-record's
`qc.overall === "FAIL"` logic is unchanged.

**Reversibility:** high. Thresholds are exported constants.

---

## 2026-10-16 — Real transcription: local Whisper via transformers.js (zero credentials)

**Decision:** `LocalWhisperTranscriptionProvider` lives in `@chris/media/transcription`. It is
a **subpath export**, so importing `@chris/media` never loads onnxruntime, and
`@huggingface/transformers` is imported dynamically inside it.

- Audio is decoded by the bundled ffmpeg to 16 kHz mono f32le.
- The pipeline is `automatic-speech-recognition` with `return_timestamps:"word"`,
  `chunk_length_s:30`, `stride_length_s:5`.
- Whisper sub-word continuations ("50" + "%") are merged into one word.

The default model is `onnx-community/whisper-base.en_timestamped`, fp32. The plain
`whisper-base.en` export fails with "Model outputs must contain cross attentions", so a
`_timestamped` export is required for word timings. Override with env `TRANSCRIPTION_MODEL`.

The model downloads once (about 290 MB) into `TRANSCRIPTION_CACHE_DIR`, default
`<repo>/.cache/transformers` (git-ignored). The provider satisfies packages/agents'
`TranscriptionProvider` structurally, because media and agents don't depend on each other.
That interface now has optional `words`.

The domain gains `recordTranscript(prisma, {mediaAssetId, text, words|null, source:
"LOCAL_WHISPER"|"MANUAL", model?}, actor)` and `parseTranscriptWords(json)`.
`recordTranscript` writes the new MediaAsset fields plus a `MEDIA_ASSET_TRANSCRIBED` AuditLog
row, with the previous provenance in `before` and the model in `metadata`. A MANUAL transcript
clears stale word timings.

The worker gains `apps/worker/src/transcribe-job.ts` (`@chris/worker/transcribe-job`) with
`transcribeMediaAsset` and `transcribeContentItemTakes`. It fails safely: a provider error
returns `{status:"FAILED"}` and leaves the existing transcript untouched. A batch never
overwrites a MANUAL transcript unless `force`.

**Verified for real:** the `say`-generated speech sample came back word-perfect: "Most people
think a credit score is a grade, it is not. Save 50% more by paying your card twice a month.
That is the whole trick." It returned 27 words with plausible timings (e.g. "50%" 3.60–4.02 s).
Model load took about 19 s on first use and about 1 s per 10 s of audio after that.

`RUN_WHISPER_TESTS=1` runs a 37 s, four-repeat `say` sample through the 30 s chunking. It
**passed** (more than 70 words, monotonic timings, the last repetition placed in the last
quarter). That test is skipped by default so `pnpm test` stays offline.

**Alternatives:**
- An OpenAI-compatible hosted `/audio/transcriptions` API was rejected: no key is available,
  and it adds cost and data egress.
- whisper.cpp was rejected as a native build step.

pnpm reports `onnxruntime-node`/`sharp` build scripts as "ignored". They aren't needed: the
macOS arm64 binaries ship prebuilt in the package. This should be re-verified on the Linux
production host.

**Reversibility:** high. Any `TranscriptionProvider` can be injected into the job.

---

## 2026-10-16 — Edit Planner / Take Selector grounded in timestamped speech; deterministic cut snapping; repair context

**Decision:**
- New pure module `packages/agents/src/transcript-timing.ts`.
  - `buildTranscriptPhrases` groups words into phrases at sentence ends and at pauses over
    0.3 s.
  - `formatTimestampedTranscript` prints lines like
    `[2.00-3.30] (pause 1.00s before) Most people think wrong.`
  - `snapSegmentsToWordBoundaries` handles cut points:
    - A cut **inside a word** moves to the nearer word edge.
    - A cut in silence but within the pre-roll (0.08 s) or post-roll (0.15 s) of a word moves
      out to give the word its breath.
    - A cut comfortably in a pause is left alone.
    - Pre/post-roll never reaches into the neighbouring word.
- `runEditPlannerAgent` takes an optional `takeWords`. When present, the prompt shows
  timestamped phrases and returned segments are snapped. The bounds check still runs on the
  model's raw output first. Adjustments are appended to `rationale` as `[deterministic] …` for
  provenance.
- `runEditPlannerAgent` also takes an optional `repairContext: {previousPlan, qcIssues[]}`.
  It adds a REPAIR PASS section: fix every listed issue with minimal change, keep everything
  else identical, explain per issue.
- `CandidateTake.words` gives the Take Selector measured delivery stats (`summarizeDelivery`:
  wpm, leading/trailing silence, longest pause, pauses over 1 s) plus the timestamped
  transcript.
- Schema: `captions` (`{enabled, style CLEAN|BOLD_HIGHLIGHT, position LOWER|CENTER}`,
  nullable, default null) and `punchIns` (default []) are added to `EditPlanOutputSchema`.
  Both use `.default()`, so legacy rows still parse; zodOutputFormat still marks them required
  for the model. A new `EditPlanRepairContext` type is added.
- Prompts: EDIT_PLANNER 1.1.0, TAKE_SELECTOR 1.1.0 and VISUAL_QA 1.1.0 (rollback 1.0.0).
  VISUAL_QA now knows what the renderer guarantees, so it focuses on face/legibility and emits
  repair parameters the planner can consume.

**Reversibility:** high. Prompt rollback is "flip to 1.0.0 from git history".

---

## Known limitations / left undone

- B-roll, music, SFX and transitions remain unexecuted (no asset library). They are reported,
  not hidden.
- Caption/overlay vs **face** collisions need vision; that stays Visual QA's job. Our layout
  can't know where the face is. A future improvement is face-aware placement via a lightweight
  detector.
- Punch-ins are hard cuts only (no eased zoom).
- Whisper `base.en` is English-only. Set `TRANSCRIPTION_MODEL` (e.g.
  `onnx-community/whisper-small_timestamped`) for multilingual or higher accuracy at about 3×
  the CPU.
- The `quality-gate-job.ts` integration of `checkCaptionOverlayCollisions` is not done (file
  not owned). See wiring below.

---

## Evidence (real end-to-end render, 2026-10-16)

The source was synthetic: a 1920×1080 talking-head stand-in (grid background, face and body
blocks), 9 s long, with a real macOS `say` voice track. The steps:

1. It was transcribed with `LocalWhisperTranscriptionProvider` (27 words).
2. Two segments, as a planner would return them, were snapped:
   `0.00-3.05 → 0.00-3.17` and `3.38-8.00 → 3.36-8.00`.
3. The plan was rendered to 1080×1920 with these instructions:
   - HEADLINE "Save 50% more: the twice-a-month card trick nobody explains" (TOP)
   - NUMBER_CALLOUT "50%" (CENTER)
   - LOWER_THIRD "Chris — credit, explained" (BOTTOM)
   - captions (BOLD_HIGHLIGHT and CLEAN)
   - a 1.2× UPPER_THIRD punch-in at 3.1–5.3 s

Results: 7.9 s output, zero ffmpeg warnings, zero unexecuted instructions, Technical QC PASS
(−14.4 LUFS, −1.4 dBTP).

- `media-evidence/frame-BOLD_HIGHLIGHT-0.5.png`: the headline wraps to 3 balanced lines inside
  the safe area; "%" and ":" render verbatim; the caption "Most people think" has the spoken
  word lit.
- `media-evidence/frame-BOLD_HIGHLIGHT-3.5.png`: the punch-in is active (grid visibly larger),
  the "50%" callout shows, and the caption "Save **50%**" is in sync with the audio (output
  3.5 s = source 3.69 s, inside the word "50%" at 3.60–4.02).
- `media-evidence/frame-BOLD_HIGHLIGHT-5.6.png`: the caption was automatically moved above the
  lower third instead of colliding; the active word "twice" matches source 5.79 s.
- `media-evidence/frame-BOLD_HIGHLIGHT-7.2.png`, `frame-CLEAN-1.5.png`, `frame-CLEAN-6.png`
  show the remaining frames.
- `media-evidence/contact-sheet-bold-highlight.png` shows six frames side by side.

Visible but *by content, not renderer*: the TOP headline sits over the stand-in's eyes and the
CENTER callout over the mouth. These are exactly the FACE/EYE/MOUTH_OBSTRUCTION findings
Visual QA exists to catch, and the repair pass to fix (move the headline to BOTTOM, etc.).

---

## WIRING NEEDED IN apps/web

All functions below are exported and tested. `apps/web` wasn't touched by this branch.

1. **Fonts (`apps/web/lib/render-config.ts`).** Stop defaulting to the macOS Arial path:
   ```ts
   export function getRenderFontPath(): string | undefined {
     return process.env.RENDER_FONT_PATH || undefined; // undefined => bundled Inter per style
   }
   ```
   `renderContentItem`'s `options.fontPath` is now optional; pass `{}` or
   `{ fontPath: getRenderFontPath() }`. Do **not** pass `DEFAULT_FONT_PATH` for all styles
   unless you want a single weight; passing it is harmless, though, since a bundled path is
   treated as "use bundled presets". If you keep a custom path it must exist, or the render
   FAILS by design.

2. **`apps/web/next.config.ts`.** Extend `serverExternalPackages` to
   `["ffmpeg-static", "ffprobe-static", "@huggingface/transformers", "onnxruntime-node", "sharp"]`.
   transformers.js loads native onnxruntime binaries via `__dirname`, the same bug class as
   ffmpeg-static. For a Vercel build, also add the fonts to file tracing:
   `outputFileTracingIncludes: { "/**": ["../../packages/media/assets/fonts/**"] }`, or set
   `RENDER_FONTS_DIR`. Realistically, transcription (CPU-heavy, a 290 MB model) should run on
   the worker host, not a serverless function.

3. **Transcribe on upload (`apps/web/app/content/[id]/actions.ts`).** After
   `analyzeMediaAsset(...)` in the upload action, or behind a "Transcribe takes" button, call:
   ```ts
   import { transcribeMediaAsset, transcribeContentItemTakes } from "@chris/worker/transcribe-job";
   const r = await transcribeMediaAsset(prisma, storage, asset.id, {}, { actorId: session.user!.id! });
   // or: await transcribeContentItemTakes(prisma, storage, contentItemId, {}, { actorId })
   if (r.status === "FAILED") /* show r.errorMessage; offer the manual transcript form */;
   ```
   It never throws for provider failures. The first call downloads the model (about 290 MB)
   and takes about 20 s, so show a pending state. Env: `TRANSCRIPTION_MODEL`,
   `TRANSCRIPTION_CACHE_DIR` (add both to `.env.example`, plus `RENDER_FONTS_DIR`).

4. **Manual transcript form.** Call
   `recordTranscript(prisma, { mediaAssetId, text, words: null, source: "MANUAL" }, { actorId })`
   from `@chris/domain`. The batch job never overwrites it unless `{ force: true }`.

5. **Take Selector (`runTakeSelector` action).** Pass word timings:
   ```ts
   takes: assets.map((a) => ({ mediaAssetId: a.id, transcript: a.transcript,
     durationSeconds: a.durationSeconds, words: parseTranscriptWords(a.transcriptWords) })),
   ```
   (`parseTranscriptWords` from `@chris/domain`).

6. **Edit Planner (`runEditPlanner` action).** Add
   `takeWords: parseTranscriptWords(selectedAsset.transcriptWords)` to the
   `runEditPlannerAgent` input.

7. **Auto-repair loop**, when an item lands in `QC_REPAIR`:
   ```ts
   const prev = await getLatestEditPlan(prisma, id);
   const revised = await runEditPlannerAgent(provider, { ...sameInputsAsAbove,
     repairContext: { previousPlan: EditPlanOutputSchema.parse(prev.plan),
       qcIssues: issues.map((i) => ({ category: i.category, severity: i.severity,
         description: i.description, timestampSeconds: i.timestampSeconds,
         recommendedRepair: i.recommendedRepair })) } });
   await recordEditPlan(prisma, { ...,
     plan: revised, revisionOfEditPlanId: prev.id,
     revisionReason: issues.map((i) => `${i.category}: ${i.description}`).join("; ") }, actor);
   await renderContentItem(prisma, storage, id, {}, actor);
   ```
   `recordEditPlan` (packages/domain/src/edit-plan.ts, not owned here) must accept and persist
   `revisionOfEditPlanId` / `revisionReason`; the columns already exist.

8. **Quality gate (`apps/worker/src/quality-gate-job.ts`, not owned here).** Next to
   `checkOverlayCollisions(plan.textOverlays)`, add:
   ```ts
   checkCaptionOverlayCollisions({ overlays: plan.textOverlays,
     captions: plan.captions ?? DEFAULT_CAPTIONS_CONFIG,
     sourceWords: parseTranscriptWords(sourceAsset.transcriptWords) ?? [],
     segments: plan.segments, canvas: plan.targetDimensions ?? { width: 1080, height: 1920 } })
   ```
   Map each result to a `CAPTION_COLLISION` QC issue; the residual ones are real.

9. **Render / QC UI.** `Render.technicalQCReport` now also carries:
   - `unexecutedInstructions: string[]`: show it, since it's what the edit asked for but
     didn't get.
   - `warnings: string[]`: WARN checks, which don't fail the gate.
   - `measurements: {integratedLufs, truePeakDbtp, loudnessRangeLu, blackIntervals,
     freezeIntervals}`
   - `captions: {rendered, relocatedAroundOverlays}`

   Each check may have `severity: "WARN"`; render it as amber, not red.

10. **EditPlan display.** Show `plan.captions`; `null` means "default: on/CLEAN/LOWER if word
    timings". Show `plan.punchIns` as well. The four non-executed fields can be shown greyed as
    "not executed yet".
