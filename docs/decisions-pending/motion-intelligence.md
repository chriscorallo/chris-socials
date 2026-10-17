# Decisions pending merge — Motion intelligence (subject tracking, placement, Motion Designer)

Same entry format as `/docs/DECISIONS.md` (**Date — Decision.** Alternatives. Rationale.
Reversibility). To be merged into `/docs/DECISIONS.md` when this branch lands. The rendering
side (Remotion templates, compositing) is a separate workstream; this file covers the
intelligence: where Chris is, where graphics can go, and which graphics to make when.

---

## 2026-10-16 — Subject tracking: UltraFace RFB-640 on onnxruntime-node, ~3 fps, protected head region

**Decision:** `packages/media/src/subject-track.ts` samples each raw take at 3 fps with
ffmpeg (letterboxed into 640x480, aspect preserved), runs the UltraFace "version-RFB-640"
ONNX face detector (Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB, **MIT**, 1.6 MB,
vendored at `packages/media/assets/models/ultraface/` with `LICENSE` + `SOURCE.txt` incl.
SHA-256) on CPU via `onnxruntime-node` (now a direct dependency of `@chris/media`, same
1.21.0 the Whisper stack already pulls in), keeps the dominant face per frame (size x score,
continuity bonus), fills gaps <= 1 s, median(5)+EMA smooths, and expands the face to a
**protected head region** (+60% above for hair, +35% each side, +25% below). Stored on
`MediaAsset.subjectTrack` as `[{ t, box | null }]` in SOURCE-frame fractions via
`recordSubjectTrack` (audit `MEDIA_ASSET_SUBJECT_TRACKED`, no state change). The body is
derived (`bodyRegionFromHead`, 2.6x head width down to the frame bottom), not stored.

**Alternatives considered:** YuNet (OpenCV Zoo) — smaller, but its multi-stride output
decoding is more code to get exactly right; transformers.js object detection (person boxes)
— whole-body boxes are too coarse to tell "over his face" from "over his shirt"; MediaPipe
— no maintained Node runtime; an LLM vision call per frame — expensive and non-deterministic
for a geometric question (CLAUDE.md: deterministic when the check is deterministic).

**Rationale:** the question "where is the face" is geometric and must be fast, free and
reproducible. Measured: a 6 s 1080x1920 clip analyses in ~0.4–0.5 s after warm-up (~15 ms
per inference; decoding dominates), i.e. a 60 s take in a few seconds. The slow test composites
a real public-domain portrait (Official Portrait of President Reagan, 1981 — US federal work,
Wikimedia Commons; see `src/__tests__/fixtures/NOTICE.txt`) sliding across a 1080x1920 frame
and asserts the track follows it within 0.08 of frame width.

**Reversibility:** high — the detector is behind `analyzeSubjectTrack`; the stored format is
detector-agnostic. Swap the model file + `decodeUltraFace` to change detectors. Known limits:
UltraFace is a frontal-ish face detector (profile shots may drop out → gaps → placement uses
the last known/assumed region); rotation is handled by reading the display rotation in
`displayDimensions`. `SUBJECT_TRACK_MODEL_PATH` overrides the model location (serverless).

---

## 2026-10-16 — Placement engine: deterministic grid search, hard vs soft obstacles, never a silent overlap

**Decision:** `packages/media/src/visual-placement.ts` (pure, browser-safe, exported from
`@chris/media/timeline`). For each `placement.mode === "AUTO"` visual it maps the head
region through each clip's crop (`cropGeometry`) and the output zooms into canvas px and
unions it over the visual's time window; obstacles are: head (HARD), caption blocks on
screen then (HARD — exact `layoutCaptionChunk` rects when `measure` + word timings are given,
else the whole caption band), text overlays active then (HARD), other visuals on screen then
(HARD), body (SOFT, penalised by overlap fraction); everything must stay inside the platform
safe area (`combinedSafeZone()` by default). It scores a 16 px grid of centres at scales
1 / 0.9 / 0.8 / 0.7 (bigger always wins if clear) by torso overlap, preferred height per
template, horizontal balance, and distance from the previous position (so re-solving while
Chris edits doesn't make graphics jump). Footprints per template live in
`visual-footprints.ts` (`TEMPLATE_FOOTPRINTS`, px at 1080x1920, scale 1) — the motion
templates must draw inside them. `TITLE_CARD` is full-frame and centred (allowed over the
subject; it dims the background). `CALLOUT` labels stay within ~520 px of `pointTo`, never on
the target, never on the face. In AUTO mode the engine owns x, y **and** scale (it always
solves from 1, so repeated solves never compound a shrink); MANUAL visuals are never moved —
they become obstacles and get `MANUAL_COVERS_SUBJECT` / `MANUAL_COVERS_CAPTIONS` /
`MANUAL_OUTSIDE_SAFE_ZONE` warnings. No clear spot → least-bad spot + `LOW_CONFIDENCE`
warning naming what it overlaps; no track for a take → `ASSUMED_HEAD_REGION` (centred
framing) + `NO_SUBJECT_TRACK`.

**Alternatives considered:** a fixed menu of named slots (top band / side / lower-middle) —
simpler but fails as soon as Chris is off-centre or a zoom moves his face; letting the LLM
choose coordinates — it cannot see the frame, and placement is geometry.

**Rationale:** deterministic, explainable, fast enough to run on every editor change (a
few ms per visual), and identical in preview and render because both call the same function.

**Reversibility:** high — weights and footprints are constants in two files.

**Note on the safe area:** the union of all three platforms' chrome (top 288, bottom 672,
left 65, right 192 px) leaves an 823 x 960 px box. Wide templates (BAR_CHART 900,
COMPARISON 940, KINETIC_TEXT 900) therefore shrink to ~0.9 for "post everywhere", and with
Chris filling the middle third, a big chart may only fit over his torso (soft) or not at all
(LOW_CONFIDENCE). This is honest; if it's too conservative in practice, pass a per-platform
`platformSafe` (e.g. Instagram only) or revisit footprints with the template designer.

---

## 2026-10-16 — Motion Designer agent (MEDIUM): model picks what/when, code enforces facts, timing, restraint, placement

**Decision:** `packages/agents/src/motion-designer-agent.ts` + `prompts/agents/MOTION_DESIGNER.md`
(model_class MEDIUM). Output schema is an explicit **discriminated union over the 14
templates**, each props object `.strict()` with every field required (nullable for optional)
— a strict structured-output schema, no `z.record`; a test asserts its keys mirror the
contract's `MotionPropsSchemas`, and the contract schema validates bounds afterwards.
`designVisualsForTimeline(provider, { timeline, wordsByAsset, subjectTracks, research,
script, tier, brandContext, ... })` then, in code:
1. **FACTUAL HARD RULE** — every number a visual would show (numeric props, and every digit
   or spelled-out number inside any string: labels, titles, kinetic text) must match a number
   from the research packet's numeric inputs (value + label), FACT statements, calculation
   notes, primary claim, or the latest Claims-Gate-passed script. Formatting variants are
   accepted ("24,500" = "$24.5K" = 24500; 20% = 0.2; "three" = 3) and honest roundings to
   fewer significant digits within 5% ("$24K" for 24,480; never "100" for 149). Anything
   else: the whole visual is dropped and reported in `rejectedVisuals` with
   `FACTUAL: <number> (<field>) not found…`. Structural fields (decimals, highlightIndex,
   callout coordinates, a counter's `from: 0`) aren't shown numbers.
2. snap to word boundaries on the OUTPUT timeline (start just before the key word's onset,
   end at a word end), 1.5–5 s, clamped to the video;
3. no overlaps, >= 0.4 s between graphics (trim the earlier if it keeps >= 1.5 s, else keep
   the more `importance`-ant one); existing visuals are kept (unless `replaceExisting`) and
   avoided in time; ids `mv-N` never collide;
4. restraint caps: per tier RAW 2 / FAST 4 / MEDIUM 7 / HERO 9, and never more than ~1 per
   6 s of video; TITLE_CARD only at MEDIUM/HERO, max one;
5. AUTO placement defaults, then `solveVisualPlacements` when subject tracks are provided.

`@chris/agents` now depends on `@chris/media` (only the pure `@chris/media/timeline` entry —
schemas, placement, caption timing). No cycle (media never imports agents).

**Alternatives considered:** enforcing the number rule only in the prompt (unreliable — the
spec's hard gates are code); letting the Quality Gate catch it after render (too late and
expensive; the QG's FACTUAL check still covers on-screen numbers as a second line);
`z.record` props (rejected: unparseable downstream, CLAUDE.md typed-output rule).

**Rationale:** the model is good at "this moment needs a chart"; it is not trustworthy on
"is 31,000 a real number here". Splitting judgment from verification is the system's
pattern (Edit Planner + snapping, Claims Gate + deterministic pre-checks).

**Reversibility:** high — prompt is versioned; caps/thresholds are exported constants.

---

## 2026-10-16 — Motion design job: two triggers, existing save paths, flag-gated autonomy

**Decision:** `apps/worker/src/motion-design-job.ts` →
`designMotionForContentItem(db, storage, provider, contentItemId, actor, { trigger, replaceExisting, analyze, skipTracking })`.
It builds the current Timeline (`timelineForPlan`: finishing edit or converted AI plan),
runs `ensureSubjectTracks` for every take the clips use (tracker failure degrades to assumed
framing + warning, never blocks), loads word timings, the latest ResearchPacket, the latest
**filmable** ScriptVersion (`isScriptVersionFilmable`), tier and brand context, runs the
Motion Designer, and saves a NEW EditPlan version with `plan.timeline` including visuals:
- `trigger: "HUMAN"` (the editor's "Design visuals with AI" button): `saveFinishingEdit` —
  allowed from every finishing state; a rendered item rolls back to EDIT_PLANNED exactly like
  any finishing edit (a previous render's gate PASS doesn't cover new on-screen numbers).
- `trigger: "AUTO"` (optional pass right after the Edit Planner on a fresh edit): only when
  feature flag **`motion.auto_design`** is on (fail-closed) and the item is EDIT_PLANNED;
  `recordReplannedEditPlan` with actorType SYSTEM, no state change.
Every run writes an `MOTION_DESIGN_RUN` audit row (added visuals, rejected visuals with
reasons, placement warnings, model, research/script ids). The state machine is unchanged.
`apps/worker/src/subject-track-job.ts` → `trackSubjectForMediaAsset`, `ensureSubjectTracks`.

**Alternatives considered:** writing visuals into the AI EditPlan schema (would fork the
plan/timeline split the finishing editor established); auto-running on every plan without a
flag (CLAUDE.md: autonomy is earned per subsystem).

**Reversibility:** high — both triggers are additive; turning the flag off stops the
automatic pass; every version is a new row.

---

## INTEGRATION NOTES (for the finishing editor UI and the render engine)

**Imports (browser-safe):** `import { solveVisualPlacements, resolveVisualPlacements,
placementWarnings, visualRect, subjectRegionsForWindow, TEMPLATE_FOOTPRINTS, parseSubjectTrack,
combinedSafeZone } from "@chris/media/timeline"`.

1. **Load once per editor session:** each clip take's `subjectTrack` (parse with
   `parseSubjectTrack`), `width/height` (→ `sourceDimensions`), `transcriptWords`
   (→ `wordsByAsset`), and the canvas `measureText` the preview already uses.
2. **Live while Chris edits** (drag/resize/retime a visual, move captions or text, change a
   crop/zoom, add/remove clips): call
   `solveVisualPlacements(timeline, { subjectTracks, sourceDimensions, wordsByAsset, measure, platformSafe })`
   and write `result.visuals` back into the document (only AUTO visuals change; it's
   deterministic and stable, so unchanged inputs give identical output — safe to call on
   every change; debounce ~50 ms if needed). Cost: a few ms per visual.
3. **Dragging a visual** = set its `placement.mode` to `"MANUAL"` with the dropped x/y (and
   scale if resized). Offer "Auto-place" to flip it back to `"AUTO"`.
4. **Warnings:** show `result.warnings` next to the visual (`visualId`): `WARNING` severity
   (`LOW_CONFIDENCE`, `MANUAL_COVERS_SUBJECT`, `MANUAL_COVERS_CAPTIONS`) as an amber badge on
   the clip in the timeline + the message in the inspector; `INFO` (`SHRUNK`,
   `NO_SUBJECT_TRACK`, `MANUAL_OUTSIDE_SAFE_ZONE`) as a subtle note. `result.details[id]`
   gives the footprint rect, the head/body regions and confidence — draw the head region as
   a faint "protected" overlay while dragging, and the footprint as the drop preview.
5. **"Design visuals with AI" button:** server action → `designMotionForContentItem(db, storage,
   provider, contentItemId, { actorId }, { trigger: "HUMAN" })` (worker export
   `@chris/worker/motion-design-job`). It may run the subject tracker first (a few seconds per
   take). Show `rationale`, the added visuals (each has `anchorText` = the phrase it
   illustrates), and `rejectedVisuals` ("dropped: FACTUAL — 31000 isn't in the research") so
   Chris sees what was held back and why. Then reload the latest plan (new version).
   Optional "Replace existing" → `replaceExisting: true`.
6. **Render engine:** before compositing, call `resolveVisualPlacements` with the same inputs
   (server: `measure = nodeMeasureText`) so the render matches the preview even if tracks
   arrived after the last save; templates must draw within `TEMPLATE_FOOTPRINTS` x `scale`,
   centred at `placement.x/y`.
7. **Pipeline (optional AUTO pass):** after the Edit Planner saves a fresh plan, call the job
   with `trigger: "AUTO"`; it is a no-op unless `motion.auto_design` is enabled.
8. **Tracking on ingest (recommended):** call `trackSubjectForMediaAsset` right after
   transcription for each take, so tracks exist before Chris opens the editor.
