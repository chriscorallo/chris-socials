# 2026-10-17 — Motion v2: graphics that interact with the footage

Owner's request: "animations that interact with the actual video, not just placed on top —
layout, placement and interaction that feel like a 40-year editing veteran made them."
Contract: `packages/media/src/motion-contract.ts` (TimelineVisual v2 fields `depth`, `anchor`,
`cameraCoupling`, `integration`, `emphasisAt`; `timeline.motionTheme`; `MediaAsset.matteStorageKey`).
Unchanged by this work.

## 2026-10-17 — Person matte: MODNet (Apache-2.0) on onnxruntime-node, H.264 gray MP4

**Decision:** `computePersonMatte(videoPath, outPath, { fps?, size? })`
(`packages/media/src/person-matte.ts`) runs MODNet ("Xenova/modnet" ONNX fp32, 25.9 MB, sha256
`07c308cf…6480739`, Apache-2.0 — model card + upstream ZHKKKe/MODNet both Apache-2.0) directly with
onnxruntime-node: ffmpeg streams RGB frames (inference 512 px tall, width to a multiple of 32) →
MODNet → post-process → ffmpeg encodes. Output: the take's aspect at ≤ 512 px tall (even dims,
`matteDimensionsFor`), the take's fps capped at 30, H.264 yuv420p CRF 14, 1 s GOP, BT.709
tv-range, faststart. Stored at `mattes/<contentItemId>/<mediaAssetId>.mp4`;
`recordPersonMatte` (domain, audit `MEDIA_ASSET_PERSON_MATTED` with before/after key + model,
size, fps, coverage, ms; refuses non-takes and keys outside the item's `mattes/` prefix).

Post-processing (deterministic): `tightenAlpha` = smoothstep(0.06, 0.94) (kills background haze,
firms edges without aliasing hair); `stabilizeAlpha` = motion-adaptive per-pixel EMA (weight 0.45
where |Δα| ≤ 0.08, fading to 0 by |Δα| = 0.3) — no edge shimmer, no ghosting on movement.
Verified: decoded white = 255 / black = 0 in ffmpeg (range tags honoured).

Model cache: `MATTE_MODEL_PATH`, else `MATTE_CACHE_DIR`, else the nearest ancestor
`.cache/matte/Xenova/modnet/onnx/model.onnx` (git worktrees reuse the main checkout's), else
downloaded once to `<repo>/.cache/matte` and sha256-verified (`MATTE_ALLOW_DOWNLOAD=0` forbids).

Jobs: `apps/worker/src/person-matte-job.ts` — `computePersonMatteForMediaAsset`,
`ensurePersonMattes(db, storage, {contentItemId}|{mediaAssetIds}, actor, {compute?, force?})`
(exported as `@chris/worker/person-matte-job`). Upload path: after subject tracking in
`registerUploadedRawTake`'s `after()` (local only; `PERSON_MATTE=on|off`, off on Vercel by
default). Render fallback: `prepareInteraction` computes a missing matte when any visual is
`BEHIND_SUBJECT`; failure → warning, the graphic renders in front.

**Alternatives:** transformers.js `background-removal` pipeline (adds image decode/encode per
frame); MediaPipe selfie segmentation (binary-ish masks, poor hair); RVM (better temporal model
but GPL-3.0 weights — rejected on license); lossless FFV1/PNG mattes (don't play in browsers).

**Perf (M1 Pro, CPU):** 288×512 inference ≈ 105 ms/frame default threads (50 ms at 224×384 with 8
threads); end to end **7.8–8.7 matte fps** (11 s 1080×1920 take → 38 s). It runs in the background
after upload, so 512 px quality was preferred over speed. Matte for a 60 s take ≈ 3.5 min.

**Reversibility:** high — another model only has to write the same gray MP4.

## 2026-10-17 — Depth compositing order and matte alignment

**Decision:** in `renderTimeline`, when an overlay segment has `depth: "BEHIND_SUBJECT"` and a
clip it overlaps has a matte (`input.mattes[mediaAssetId]`):
graded footage → `split` → behind graphics (with their own shadows, which are therefore also
behind Chris) → **person** = footage `alphamerge` matte → front graphics → text plates/texts →
captions. The matte stream is built per clip with the clip's exact chain (`clipFrameChain`:
same `-ss`/`-t`, fps, cover-scale × crop zoom, pan crop, pad/trim to the same frame count —
geometry is defined relative to iw/ih, so the 512-px matte maps pixel-for-pixel onto the
footage), concatenated, run through the same `zoomFilter` (punch-ins), then
`MATTE_EDGE_FILTER` = `gblur σ1.1` + a contrast curve centred just above 50% (pulls the edge a
hair inward: no background halo pasted over a behind-graphic). Clips without a matte get a
black matte (their behind graphics read as front). No matte at all → warning, segment
composited in front. `RenderTimelineResult.motion` gains `behindSubject`, `mattedClips`.

Tests: `timeline-depth.test.ts` (real ffmpeg): a red "person" + a half-resolution synthetic
matte; a green behind-bar is hidden inside the person and visible outside, FRONT covers the
person; no matte → warning + front; with crop zoom 1.3 / pan (0.6, −0.2) and a 1.25 punch-in
the edges line up within ±12 px at both zoom states.

**Perf:** depth pass adds ≈ 4–7 s to a 11 s 1080×1920 master render (preset medium: 18.8 s vs
12.1 s flat in the last showcase run) — the full-res alphamerge/overlay runs for the whole
timeline. Gap: restrict the person layer to behind windows (segmenting the graph) if it matters.

## 2026-10-17 — Subject anchor + camera coupling: per-frame track computed by one pure helper

**Decision:** `visualMotionTrack` (`packages/media/src/visual-interaction.ts`, browser-safe)
produces per-local-frame centre (canvas px) + scale for a visual; `buildVisualInteractions`
bundles it with the emphasis hit and scene look; the worker passes the result as the Remotion
composition's `interactions` prop, the editor computes the identical object for the Player.
The composition applies it with `<TrackedMotion>` (translate + scale about the box centre),
outside the template, so templates are untouched.
- **Follow me** (`anchor.type = SUBJECT`): head box (subject track → crop → zoom, unclipped) centre
  + offset (canvas fractions). Zero-phase smoothing (forward/backward one-pole, τ = 0.12 s) —
  removes the tracker's 3 fps steps without lag; smoothing restarts per clip so the graphic
  CUTS with the picture on a cut instead of gliding across it. Unknown head → hold the last
  known spot; none → placement. Kept on the canvas (36 px margin) — not clamped to the
  platform-safe area: Chris placed it, and clamping made it jump away from where he dropped it
  (seen in the quality loop). `anchorOffsetFor` gives the offset that keeps a graphic exactly
  where it is when Follow is switched on, and dragging a following graphic edits the offset.
- **Move with camera** (`cameraCoupling`): scale = 1 + (z − 1)·c around the zoom focal point
  (`cameraCouplingTransform`; c = 1 reproduces the footage's own zoom exactly — tested). A
  following graphic already moves with the zoom through the head mapping; only its scale is
  coupled.

**Alternatives:** ffmpeg overlay x/y expressions (can't scale the alpha clip per frame cheaply,
and the editor preview couldn't share it); per-frame props in Remotion computed inside the
composition from raw tracks (would ship subject tracks into every clip render).

## 2026-10-17 — Scene integration in the composition: one SVG filter per graphic

**Decision:** the worker samples the footage region behind each graphic (`sceneRegionFor` →
un-zoom → inverse crop → ffmpeg crop + the edit's eq/temperature grade + area-scale to 8×8;
3 samples: after the entrance, middle, before the exit; `sampleSceneStatsForVisuals`), giving
mean RGB, Rec.709 luma and luma spread (`sceneStatsFromRgb`). `sceneLook` turns that into a
restrained look: scrim 0.08 → ~0.42 with luma (+≤0.08 for busy backgrounds; bare type gets it
in full, cards 35%), white balance ±4% toward the scene's temperature, black lift ≤ 0.03 on
bright footage, shadow tinted with the scene's own dark (22% of its colour, never pure black)
and stronger on bright footage, light-wrap colour = the scene colour normalised light, strength
0.25–0.6 with luma. `<SceneIntegration>` applies it as one SVG filter: feColorMatrix (match) →
light wrap (erode/blur alpha → inner-edge band → flood scene colour → screen) → contact shadow
(σ3, +3/+5 px) and drop shadow (σ22, +16/+30 px, down-right = key light top-left), plus a radial
scrim div. Values are in design px inside the scaled box, so they scale with the graphic.
`TemplateComponentProps` also carries `scene` for theme-aware styling (theme engineer).
Editor parity: `analyzeFootageAction` (server action) measures the same stats and per-word
loudness on demand (debounced 700 ms, cached per take), so the preview look matches the render.

Observed: on dark footage shadows and light-wrap are barely visible — by design (physically
true, and the restraint the brief asked for); on bright footage the scrim/shadow grow.

## 2026-10-17 — Emphasis timing: loudness z-scores + numbers → `hitAtFrame`

**Decision:** `measureWordLoudness` (16 kHz mono PCM, RMS/peak dBFS per transcript word);
`outputEmphasisWords` maps words to output time and scores z(RMS) + 0.5·z(peak) within each clip
+0.8 for number words (digits or spelled: "five", "thousand"…); `pickEmphasisHit` picks the hit:
+1.5 when the word is the very number/word the graphic shows (spelled numbers normalised, so
"five" matches a bar of 5), allowed window [start + 0.45 s, end − 0.9 s], slight preference for
the first half; lands on the word onset + 40 ms. `emphasisAt` semantics (contract-compatible):
`null` = automatic for NUMBER_COUNTER / BAR_CHART / KINETIC_TEXT / MONEY_STACK_3D; **`0` = off
(template timing)**; `> 0` = "land near start + emphasisAt" (snaps to a strong word within
±0.6 s, else exactly there). Template hooks (`templates/hit-timing.ts`, timing only): counter
and money-stack stretch/compress their build (0.45–3 s) to land on the hit; kinetic text spreads
the words before the key word (stagger ≤ 2.5×) so it punches on the hit; bar charts keep their
stagger and delay only the KEY bar, so the reveal lands on the word (quality loop: the "+$400"
bar rises exactly on "five years").

## 2026-10-17 — Veteran defaults; auto depth in the placement step

**Decision:** `applyInteractionDefaults` (new graphics only — editor insert; exported for the
Motion Designer path): cards ride punch-ins at 0.35, shadows on, scene match on, light wrap on
for 3D (ICON_3D, MONEY_STACK_3D, depth3d bar charts). Existing graphics are never rewritten.

Auto depth (`solveVisualPlacements`, AUTO only, needs `PlacementOptions.mattes` for every clip in
the window + a tracked head): big type — KINETIC_TEXT ≤ 28 chars, label-less NUMBER_COUNTER,
TITLE_CARD — tries the classic composition: full size (or 0.9/0.8), centred over Chris, its glyph
band crossing the top of his head (hair top at 62% of the band). The head is modelled as an
ellipse inside the protected region (`headEllipseFromProtected`); the share of the glyph band it
hides must be ≤ 0.20 for numbers (a hidden digit is a wrong number) and ≤ 0.34 for words, and the
box must be in the safe area and clear of captions/texts/other graphics. Pass → `depth:
BEHIND_SUBJECT` at that spot; fail → the normal solve, depth unchanged. AUTO owns depth like it
owns x/y/scale, so the editor's "Behind me" toggle pins the graphic (MANUAL, where it's drawn).
The editor persists the engine's depth on save. Manual behind-subject graphics no longer get the
"covers Chris's face" warning (that's the point).

Observed on the tight close-up stand-in (face ≈ 70% of the frame width): the rule correctly
refuses the number (it would hide too much under the platform-safe top), so the showcase placed it
by hand; the hand-placed result (hair over the bottom of "500", digits legible) is the look.

## 2026-10-17 — Editor: "In the shot" controls, theme picker, depth preview

**Decision:** for a selected graphic, an "In the shot" section: Behind me (pins), Follow me
(offset from where it is; dragging edits the offset), Move with camera (0–100%, hint when no
punch-in overlaps), Shadow / Light wrap / Match scene, Hit on my emphasis (+ "Hit near the
playhead", shows "Lands at X.Xs"). Each is one undo step (`lib/editor/visuals.ts` pure ops,
tested in `lib/editor/interaction.test.ts`). The Visuals sheet home has "Look of this video":
Auto (from topic) = `motionTheme: null`, or Custom (name, motion language, main/second colour,
icon style) — data only; the theme engineer's provider styles templates. Hit areas follow tracked
graphics.

**Preview parity (PersonCutout.tsx):** with behind-subject graphics and a matte, the motion layer
splits: behind Player → WebGL person cutout → front Player. The cutout uses the VISIBLE pool
`<video>` as the footage texture (no extra picture decoder) and ONE extra muted `<video>` for the
matte (a third element only while behind graphics exist; muted needs no iOS gesture unlock; kept
1-2 px visible so Safari keeps decoding). Shader = the renderer's geometry (cropGeometry + zoom
about the focal point) and edge curve; wrapped in the same `#ed-grade` SVG filter. Sync: paused →
exact seek; playing → re-seek past 0.12 s drift, ±5% playbackRate nudging under it. Fallbacks to
"everything in front" + a small "Depth shows in the export" pill: no WebGL, shader failure,
cross-origin footage without CORS (blob mode's presigned URLs taint the texture — **known gap
on production**: the Blob store would need CORS headers / a same-origin proxy for the preview
cutout), or > 50% of frames taking > 14 ms. Verified in Chrome at iPhone 15 size (393×852 ×3,
touch): number behind the hair in the preview, matching the render. `/api/media` now serves a
take's `matteStorageKey`.

## Gaps / follow-ups
- Real-iPhone performance of the WebGL cutout + two Players not measured (Chrome emulation only).
- Production (Blob) preview depth falls back to front (CORS) — renders are unaffected.
- Depth compositing runs for the whole timeline (perf above).
- Light wrap is an SVG approximation on the graphic's inner edge with one average colour per
  graphic (not a per-pixel blurred background); TITLE_CARD's dimming isn't scene-matched.
- `FULL_LAYER` render strategy has no per-visual depth (PER_VISUAL is the default and supports it).
- The Motion Designer (packages/agents) should call `applyInteractionDefaults` on proposed visuals
  and may set `depth`/`anchor` — integration note for the AI engineer.
- A real take of Chris should replace the public-domain stand-in in the next quality pass.

## Quality loop (2026-10-17)
`apps/worker/scripts/motion-v2-showcase.ts <video> <outDir>` renders through the worker's
functions (withResolvedPlacements → prepareInteraction → prepareMotion → renderTimeline) on an
11 s 1080×1920 stand-in made from the public-domain portrait (fixtures/NOTICE.txt): number behind
the head (RISER, lands on "$24,500"), a stat card following him, a bar chart riding a 1.16× ease
punch-in at 45% (key bar revealed on "five"), a 3D icon with light wrap. Iterations made from the
frames: the stand-in got natural headroom (the first framing left no room above the head); the
anchored card stopped being clamped to the safe area (it jumped onto his chin); the bar chart's
hit delayed the whole build (an empty card for ~1 s) → only the key bar waits now; spelled
numbers count; head-occlusion moved from box overlap to an ellipse model. Consecutive-frame
checks show a stable matte edge on the number and sub-pixel smooth follow motion.
Timings (last run): matte 38 s (cached afterwards), measurements 2.6 s, motion layer 17.7 s,
master 18.8 s (12.1 s without the depth pass). Evidence: `docs/evidence/2026-10-17-motion-v2/`.
