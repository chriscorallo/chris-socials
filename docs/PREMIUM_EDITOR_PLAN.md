# The premium automated editor — analysis and plan (2026-10-21)

Five rounds of analysis Chris asked for before any implementation ("quadruple check… what
would Apple, Meta, CapCut do… this is for planning and analyzing, not for implementing yet"),
then a critique from every seat that decides quality, then the recommendation he approved.
Implementation is handed to the next session: start from `/docs/PREMIUM_EDITOR_HANDOFF.md`,
which turns the Week 0 row of the recommendation into file-level contracts.

Chris's bar, in his words (2026-10-21): "NOT ONE STYLE IS LAW… it's how the actual art of the
video is as a final product: cutting dead space, making the story from beginning to end,
chopping it together into one cohesive solid video that has the hook factor, tension, and
payoff. Then the visuals complement." Cuts must land "right on the decibel" the voice changes.
No paste paths ("chatgpt is not automated"). Judge by watching, never by a metric alone.

---

## Context

Chris's bar: upload a take → the app edits it into one smooth story (hook, tension, payoff) with
visuals that complement the whole, so clean it reads as human-made, then posts it. Cuts exist to
remove dead space and make sentences join; they must land exactly where the voice stops and
starts — "on the decibel change" — not a few hundred ms either side. He uploaded reference videos
and hand-cut two videos as examples; the system should learn from both. No single style is law.
This round is analysis: what structurally stops us today, what I would build, and how the best
products do each piece. Four more rounds follow before anything is built.

## 1. Honest state of what we have (verified in code today)

**The cuts miss the voice by design.** `packages/media/src/style-cut.ts` (`cutOneTake`) keeps
0.12 s of air inside a sentence / 0.18 s after one, splits it as tail pad + lead pad (0.09 / 0.05
minimums), then snaps each edge *outward* to a 30 fps grid even when rendering at 60 fps. Result:
0.14–0.25 s of air at every splice. Pauses shorter than 0.18 s (mid-sentence) / 0.24 s (sentence
end) are never cut at all. With no measured silences the pads jump to 0.32 s+. Silences come from
20 ms RMS frames with an adaptive threshold and **no hysteresis** (`speech-activity.ts`), so soft
word tails get counted as silence and edges wobble a frame or two. Audio at a splice is an 8 ms
fade and a hard concat, clip length frame-quantized. The two pad constants were hand-copied from
his two hand edits once; nothing learns them.

**The references are measured but not learned.** ~50 numbers per reference video
(`style-metrics.ts`, `reference-analysis-job.ts`) collapse to medians; only five reach the edit
(duration, gap p90, longest gap, shot p25, first cut) and they are clamped so tightly the
references barely move anything. Dead data: `cuts.times`, transcripts, hook text, cuts/10 s,
pauses/min, hook duration. Nothing measures what a viewer *sees* in a reference — on-screen text
cadence, caption style, zoom use, headline density, hook pattern — because there is no OCR or
overlay detection. No reference signal reaches the Editor (one length note), the Visual
Strategist, the Motion Designer, captions or the hook title. "Did I put them in for shits and
gigs?" — close to yes, today.

**Nobody owns the screen.** Headlines (`full-edit/index.ts`), captions (`timeline-captions.ts`),
graphics (`visuals.ts` → VISUAL_STRATEGIST → MOTION_DESIGNER), zooms (retention/emphasis
heuristics) are four passes that avoid each other. `EDITOR_ORCHESTRATION.md` describes one
composed screen; no code builds one. The Editor's `viewerNeeds` never reached the visuals step
(worker pass-through missing). Captions are a fixed 3-word chunk at y=0.72, no quiet one-word
preset. Zooms ease in and snap back.

**The Editor exists (since today) but sees words, not time or screen.** It writes line ids with
roles/trims/headlines; first live cut made genuinely editorial choices (cut the invisible prop
line, reordered so the video ends on the question) but headlined only 3 of 7 beats and its
cold-viewer field came back as junk.

**No bar before posting.** Every check is PASS/WARN; the viewer review is advisory. Nothing can
say "not good enough, fix X, re-render", so nothing can be trusted to auto-post.

## 2. What I would build (target architecture)

One pipeline of typed artifacts. Deterministic unless marked (model).

| Stage | Owns | In → Out |
|---|---|---|
| S0 Ingest | transcript (large-v3-turbo, pieces), **1 ms audio envelope**, hysteresis speech edges, subject track, loudness | media → `TakeAnalysis` |
| S1 Learn | measure what matters in references **and his hand edits**; aggregate | references, hand-edited timelines → `StyleModel`, `SpliceModel` |
| S2 Editor (model, HIGH) | the story: order, roles, trims, one headline per *idea*, viewerNeeds, emphasis words, pacing | `TakeAnalysis` + brief + `StyleModel` digest → `EditorPlan v2` (with output seconds) |
| S3 Splice | sample-accurate cut placement from the audio, pads from `SpliceModel` | `EditorPlan` + `TakeAnalysis` → `CutList` |
| S4 Screen Orchestrator | one composed screen: lanes (headline, caption, graphic, zoom, face), fixed anchors, one lead per beat | `EditorPlan` + `CutList` + `StyleModel` + subject track → `ScreenPlan`; Motion Designer (model, MEDIUM) fills graphic slots the orchestrator opens, never places |
| S5 Render | 60 fps picture, sample-accurate audio with 4 ms equal-power crossfades, zoom in-hold-out | → render |
| S6 Watch-back gate (model, HIGH vision) | a checklist bar, findings mapped to a stage, one fix loop | render + `ScreenPlan` facts → `WatchVerdict` |
| S7 Publish | human click, or auto-post once the tier has earned it (`canActAutonomously`) | `WatchVerdict` → post |

**S3, the splice model (his "decibel" point).** New `packages/media/src/splice/`: speech onset/
offset on a 1 ms envelope with hysteresis (enter at floor+X dB, leave at X−6 dB, 40 ms hang);
cut-out = offset + learned tail pad, cut-in = onset − learned lead pad (moved earlier to catch a
plosive's transient via spectral flux); each cut moved to the nearest zero crossing; audio kept at
sample precision and joined with a 4 ms crossfade; the picture takes the nearest frame on its
own (a half-frame picture slip is invisible; 150 ms of silence is not). No outward snapping, no
0.1 s minimum silence, pauses shortened down to the learned keep and never padded up.
`SpliceModel` = per-speaker pad distributions (p50/p90, sentence-end vs mid-sentence) measured
from his hand edits against the audio, updated by every edit he accepts, never widened past the
hand-edit band.

**S1, learning that reads what a viewer sees.** Replace the scalar list with: cut rhythm as a
*sequence* (open / build / payoff tempo), frame OCR at ~4 fps → on-screen text events (appear,
hold, change), headline density per 10 s, caption style (words per chunk, band, highlight,
case), hook pattern (first 2 s text vs words), zoom usage (scale drift within a shot → rate,
hold, shape), background/music level. `StyleModel` feeds every stage: Editor (headline density,
hook pattern, length band), orchestrator (caption preset, anchors, zoom rate), splice (pads),
gate (what "like the references" means in words).

**S4, the orchestrator.** Five lanes, one solver: fixed anchor per lane for the whole video;
at most one lead per beat; headline on the first word of its idea, off on its last; captions as
support (a QUIET one-word preset positioned by the subject track, not a fixed y); zooms
in-hold-out at beat boundaries or on the Editor's emphasis words — never from a "nothing changed
for 7 s" heuristic. The Visual Strategist dissolves into the Editor's `viewerNeeds`.

**S6, the gate.** A checklist, not a score: no audible gap > 60 ms at a splice, no clipped
word, nothing on the face core, no two leads in a beat, headline count inside the StyleModel
band, hook visible by 1.5 s, story reads (hook → payoff) to a cold viewer. FIX names the stage and
re-runs only it, once; a second FIX goes to Chris. PASS + earned autonomy → posts.

## 3. How the best do it, and what to take

- **CapCut** (auto-cut, auto-captions, templates): take the one-tap default and caption presets
  *as a learned choice*; leave the template gallery — the StyleModel decides the look.
- **Descript** (text-based editing, filler removal, Studio Sound): take the word-exact edit
  contract (we have it) and per-speaker silence tuning; leave aggressive voice processing (an
  AI-processed voice reads as AI) and blanket "um" removal — the Editor decides.
- **Premiere / DaVinci** (audio-based cut tools, ripple at waveform zero crossings): take
  sample-accurate splices with micro-crossfades — this is exactly the "decibel" cut.
- **Opus Clip / Vizard** (virality scores): take nothing numeric; a score is unexplainable.
  Take hook-first framing as the Editor's first obligation, judged by the gate in words.
- **Apple / Meta product discipline**: strong defaults, one visual system per video, the system
  mostly says *no*; every element earns its place; consistency over flourish.

## 4. Delivery order (when we build)

| Phase | Objective | Pass test, judged by watching | Size |
|---|---|---|---|
| 1 Splice engine | cuts land on the voice | 60 s take on headphones: no audible gap or clipped word at any splice; blind A/B vs his hand edit, he can't pick the machine on 3 of 4 splices | ~1.5 wk |
| 2 Learning v1 | pads + headline cadence learned, not copied | SpliceModel reproduces his two hand edits within 30 ms median; OCR events on 10 references within 15% of a human count | ~2 wk |
| 3 Editor v2 + Orchestrator | one composed screen | 42 s video: 6–9 headlines at fixed anchors, never two leads, each graphic under its headline on its word; reads as one editor's work | ~2.5 wk |
| 4 Watch-back gate | hard bar, one loop | 5 planted defects caught 5/5 with the right stage named; one loop fixes 4/5 | ~1.5 wk |
| 5 Captions + zooms as learned style | quiet one-word captions, in-hold-out zooms | side by side with a reference reads as the same family | ~1 wk |
| 6 Publish by earned autonomy | post without a click when the gate passes | 3 PASS videos post; 1 FIX video stops and says why | ~0.5 wk + app connections |

Splice first: it is the loudest "machine" tell, deterministic, with an objective test. Learning
second because phases 3–5 all consume `StyleModel`.

## 5. Costs, risks, bounds

- Per video: Editor (1 HIGH) + Motion Designer (1 MEDIUM, only beats with a need) + gate (1–2
  HIGH vision) ≈ under $0.60, enforced by the existing spend cap and `ModelCallLog`; OCR local.
- Latency: envelope and OCR run beside Whisper in the sandbox; one fix loop → worst case two
  renders.
- Over-automation: the gate is a named checklist; autonomy stays behind `canActAutonomously`;
  every FIX and override feeds the taste model.
- Model variance: the Editor's output is a validated plan with StyleModel bands enforced
  deterministically by the orchestrator; plans are stored, so a re-apply never re-rolls.
- Learning from two hand edits: the SpliceModel starts as a prior from the two samples and only
  updates from accepted edits.

## Files that change (when built)

`packages/media/src/style-cut.ts` (cut placement → splice engine; `q()` becomes video-only),
`packages/media/src/speech-activity.ts` (1 ms envelope, hysteresis), `packages/media/src/
full-edit/index.ts` (headlines/zooms/visuals → Screen Orchestrator), `packages/media/src/
timeline-render.ts` (sample-accurate audio, crossfades, zoom out), `apps/worker/src/
reference-analysis-job.ts` + `packages/domain/src/style-metrics.ts` (OCR, cut sequence, caption
and zoom measurement, StyleModel, SpliceModel from hand edits), `packages/agents/src/
editor-agent.ts` + `prompts/agents/EDITOR.md` (v2: time-aware, headline per idea, emphasis
words), `apps/worker/src/viewer-review-job.ts` + `packages/agents/src/viewer-panel.ts`
(advisory → gate), `apps/worker/src/motion-design-job.ts` (beats pass-through).

## Verification

Each phase's pass test above is judged by watching the output (frames + headphones), plus unit
tests on synthetic audio for the splice model (planted onsets/offsets → cut within 10 ms), on
synthetic frames for OCR events, and on planted-defect renders for the gate.

---

# Round 2 — the watch-back gate and auto-post

## What exists today (verified)

- **Two unconnected reviews.** The *quality gate* (`apps/worker/src/quality-gate-job.ts`) is a
  real hard gate: FACTUAL fails closed on the Claims Gate verdict + ungrounded on-screen numbers;
  TECHNICAL = ffprobe-level checks (streams, loudness, peaks, black/frozen frames) + overlay
  collisions + VISUAL_QA on **6 evenly spaced frames, no audio**; BRAND/CREATIVE reuse
  *script-time* scores (no check of the video). PASS → READY. The *viewer review*
  (`viewer-review-job.ts`, VIEWER_PANEL) is the only thing that actually watches the video —
  80 frames incl. both sides of every cut, audio facts, transcript, brief, references — one HIGH
  vision call (~$0.36–0.50) — and **nothing reads its result**: no gate, no loop, no director.
- **The only repair loop** (`auto-repair-job.ts`) runs off *gate* findings and regenerates a whole
  plan through the legacy Edit Planner — not the Editor, not the timeline, no audio input. Viewer
  findings (`fixes`, `craft`, `dropOffs`) are free text and never applied.
- **Audio at cuts** is partly measured for the viewer (level jumps ≥ 6 dB, cut jumps ≥ 6 dB with
  speech both sides) — but no gap, click, clipped-word or room-tone check at splices, and none of
  it gates anything.
- **Autonomy** (`packages/domain/src/autonomy.ts`): levels per subsystem × tier, earned by
  "approved outcomes" — for PUBLISHING that means *the publish API succeeded on every platform*
  25 times (level 3), not that Chris agreed with the system. `autonomy.shadow_only` is seeded ON;
  `tryAutonomousPublish` exists but is only a button; the scheduled cron needs `CRON_SECRET` +
  the `publishing.scheduled_auto` flag; no demotion on failure; nothing records SCHEDULING /
  QUALITY_GATE outcomes.
- **Publishing itself is solid**: real IG/TikTok/YouTube adapters, idempotency keys, leases,
  AMBIGUOUS handling, verification read-back, append-only `Publication` rows, per-platform
  variants, preflight that requires a QC PASS for the exact render. Packaging (captions) reads
  the Creative Brief. Blocked externally by app connection + Meta review / TikTok audit / Google
  audit for public posts.

## What I would build

**One watch-back stage replaces the three reviews.** Order: free deterministic audits → one
model watch → verdict.

1. **Deterministic audits (free, every render):**
   - *Splice audit* on the rendered audio + CutList: any splice with > 60 ms of near-silence
     between voice offset and onset; any word straddling a cut by > 40 ms (clipped word); a
     transient/click within 10 ms of a cut; level step ≥ 4 dB across a cut with speech both
     sides; noise-floor change ≥ 6 dB across a cut.
   - *Screen audit* from the ScreenPlan + subject track: any element on the face core; two leads
     in one beat; headline/graphic count outside the StyleModel band; caption/text collisions;
     hook text on screen by 1.5 s; no element changes in any 7 s window.
   - *Story audit* from the EditorPlan: every storyline line present, in order; no dependent
     opener ("so that's…") without its referent; ending is the Editor's ENDING line.
   Any failure → FIX with the stage named (SPLICE / SCREEN / EDITOR) and machine parameters.
2. **One model watch (HIGH vision, the existing frame planner):** answers the checklist in
   words with timestamped evidence — hook stops a cold scroller by 1.5 s; story reads hook →
   payoff; nothing competes on screen; the ending serves the objective — and returns at most 5
   fixes as **typed operations**, not prose: `{stage: EDITOR, op: DROP_LINE|RESTORE_LINE|
   MOVE_ENDING, sentenceId}`, `{stage: SCREEN, op: MOVE|SHRINK|DROP|RETIME, elementId, …}`,
   `{stage: SPLICE, op: RETIME, cutIndex, deltaMs}`. The existing VIEWER_PANEL schema is
   reused for beats/attention/engagement estimates (kept as telemetry, never as the bar).
3. **Verdict:** PASS / FIX / HOLD. FIX re-runs only the named stages once (no new Editor call
   unless stage = EDITOR), re-renders, re-watches. A second FIX → HOLD: the video waits for
   Chris with the findings and two buttons (Fix it / Post anyway, the latter recorded as an
   override that trains the bar).
4. **The bar is a checklist, never a score.** Thresholds above + "would a cold viewer finish
   it" in words. Engagement estimates are logged for calibration against snapshots, never used
   to pass or fail.

**Autonomy redefined as agreement, not API success.** Evidence per video type (series) and tier:
Chris posted the gate-PASS video unchanged = approve; edited first = partial; rejected = reject.
Shadow mode (what exists today, kept): the gate runs and records a verdict on every video while
Chris still clicks; *shadow accuracy* = agreement between PASS and "posted unchanged".
Promotion to auto-post for a type when agreement ≥ 90 % over the last 10 and no HOLD
overrides in 10; automatic demotion on any rejected auto-post or any post Chris pulls down;
ceiling and `shadow_only` kill switch stay human-only. `recordApprovedOutcome` stops counting
API successes for PUBLISHING.

**Publish, when earned:** PASS + earned → scheduled into the next calendar slot per the weekly
cadence (not "now"), packaging text gated by the same watch (no claim in the caption that the
video doesn't make), per-platform variants, verification, snapshots. Snapshot metrics feed back
only as calibration: hook `stopChancePct` vs 3 s retention where a platform exposes it (YouTube
does; IG/TikTok mostly don't), so the watch's self-confidence is checked against reality.

## How the best do this step

- **YouTube Studio "Checks"** before publish: a pass/fix checklist (copyright, ad suitability)
  the uploader sees before the button — borrow the shape exactly; a score is never shown.
- **Meta Reels suggestions**: advisory nudges — the wrong model for us; ours is a bar.
- **Descript / Opus Clip "publish to"**: one click to all platforms with scheduling — borrow;
  Opus's virality number — leave.
- **Apple**: the review is the only human moment; defaults do the rest; the system says no
  silently and tells you only when it needs you.

## Delivery order for this part

| Phase | Objective | Pass test | Size |
|---|---|---|---|
| G1 Deterministic audits | free, immediate FIX reasons | 5 planted defects (gap, clipped word, face overlap, double lead, missing hook text) all caught with the right stage | 1 wk |
| G2 Watch-back with typed fixes + one loop | one review, machine-applicable fixes | on 10 videos the loop improves 7+, worsens 0 (judged by watching) | 1.5 wk |
| G3 Shadow autonomy evidence + HOLD queue | agreement tracking, demotion, UI queue | shadow accuracy visible per series; a HOLD shows findings with Fix / Post anyway | 1 wk |
| G4 Cron-triggered autonomous publish behind flags | hands-off posting for earned types | 3 earned-type videos post without a click; a non-earned one waits | 0.5 wk + app connections/audits (external, weeks) |

## Costs and risks

- Watch ≈ $0.40 at HIGH (+ ~30 % of videos get a second watch) → ~$0.55; with the Editor and
  visuals ≈ $0.80–1.00 per video. Once calibrated, the watch can move to MEDIUM vision (~$0.08).
- Variance in verdicts: bounded by the deterministic audits (hard floor) and by shadow-mode
  calibration before any auto-post; one loop max.
- The FACTUAL gate stays exactly as is (fails closed; unverified on-screen numbers block) —
  auto-post never bypasses it.
- External: Meta review, TikTok audit, Google audit — the only parts no code can shorten.

---

# Round 3 — splice precision ("right on the decibel")

## Exactly what happens at a splice today (verified)

1. **Silence detection** (`speech-activity.ts`): 20 ms RMS frames, adaptive threshold
   `floor + max(6 dB, 0.3·(speech − floor))`, minimum silence 0.1 s, **no hysteresis, no hang**.
   Edges land on a 20 ms grid; breathy tails and "s/f" sounds fall below the threshold, so a
   "silence" often starts inside the last word.
2. **Cut placement** (`style-cut.ts` `cutOneTake`): keep 0.12 s mid-sentence / 0.18 s at a
   sentence end; cut-out = pause start + max(0.09, 0.6·keep); cut-in = pause end − max(0.05,
   0.4·keep); then each edge is **snapped outward to the 30 fps grid** (ceil / floor) even when
   rendering at 60 fps. Net: **0.14–0.25 s of air at every splice, by design.** Pauses shorter
   than 0.18 s (mid) / 0.24 s (sentence end) are never cut. Without measured silences the pads
   are 0.32 s+.
3. **Render** (`timeline-render.ts`): accurate per-clip input seek (0.1 ms), but each clip's
   audio is `apad`/`atrim`-ed to whole output frames (±8 ms at 60 fps, ±16 ms at 30), joined
   with an 8 ms linear fade and a hard concat; no zero-crossing, no crossfade.
4. **The pads were copied by hand** from two of his edits once (DECISIONS 2026-10-19) and
   measured against Whisper word times, not the audio. Nothing learns them. His hand-cut
   timelines are stored at ms precision (clip `sourceStart/End`), so they *can* be learned from.
5. Caption word highlights use raw Whisper times (±0.2 s drift), so the highlighted word and
   the voice drift apart after tight splices.

So the gap he hears is three things stacked: designed pads (~0.14–0.25 s), outward frame
rounding (up to +67 ms), and silence edges that are 20 ms coarse and biased into word tails —
plus small pauses that are never tightened at all.

## What I would build: the splice model (`packages/media/src/splice/`)

1. **A real envelope.** 1 ms RMS at 16 kHz plus a high-band (2–8 kHz) energy track so
   fricative tails ("s", "f", "th") count as voice. Speech ON at floor + 10 dB (adaptive), OFF
   at floor + 4 dB with a 40 ms hang (hysteresis). Each Whisper word's start/end is **refined**
   to the nearest ON/OFF edge within ±150 ms; captions use the refined times too.
2. **Cut on the voice.** cut-out = refined offset + tail pad; cut-in = refined onset − lead pad.
   If the next word opens with a plosive (spectral-flux burst), cut-in sits 15 ms before the
   burst — a clipped "p/b/t/k" is the most audible machine tell. Every audio cut moves to the
   nearest zero crossing (±1 ms); no outward snapping, no 0.1 s minimum silence; any pause
   ≥ keep + 20 ms is shortened *to the learned keep*, never padded up.
3. **Pads learned, not copied — the `SpliceModel`.** Prior from his two hand edits, re-measured
   against the new envelope (offset→cut, cut→onset, by mid-sentence vs sentence end: p50/p90,
   kept-pause distribution — his internal pauses measured ~0.11 s median). Updated by: every
   edit he posts unchanged (its splices become samples), every clip edge he nudges in the
   editor (a labelled correction: envelope context + machine cut + human cut), and **the
   references**: at every detected cut in a reference, offset→cut and cut→onset on its envelope
   are *their* pads — the one reference signal that maps directly onto this stage. The model
   never widens pads past the hand-edit band.
4. **Sample-accurate audio, frame-accurate picture, independently.** The audio track is built
   as one stream from the CutList at sample precision with a 3–5 ms equal-power crossfade at
   every splice (replacing fade + hard concat); the picture cuts on the nearest frame and its
   per-clip frame counts track cumulative audio time (drift ≤ half a frame, never accumulating).
   Optional micro-L-cut: picture changes one frame after the audio does — a pro editor's habit
   that reads as "human".
5. **Framing at splices on one continuous take:** hold the crop (jump cut) by default; a
   punch-in only where the Editor marked a beat boundary or emphasis, or when the head moved
   enough between the two sides that a 1.08 push hides the jump.
6. **Measured, not assumed.** A splice audit (round 2's G1) on every render: gap > 60 ms,
   clipped word > 40 ms, click within 10 ms of a cut, level step ≥ 4 dB, noise-floor change
   ≥ 6 dB → FIX with the cut index and delta.

## What the pros do, and what to take

- **Premiere / DaVinci**: ripple-trim on the waveform, cuts at zero crossings, 2–3 frame
  constant-power crossfades by default — take all three; this is the "decibel" cut.
- **Descript**: "shorten gaps to X" per project and per speaker — take the per-speaker idea,
  set X from the SpliceModel, not a slider.
- **Pro habit**: J/L cuts (sound leads or lags picture by a frame or two) — take the micro-L.
- **CapCut "remove silence"**: a single threshold — leave it; it is why auto-cuts sound chopped.

## Pass tests

- Synthetic audio with planted onsets/offsets and plosives → cuts within 10 ms, no clipped
  burst, zero clicks on 100 splices (automated).
- SpliceModel reproduces his two hand edits' splices within 30 ms median.
- Headphone test on a 60 s take: no audible gap or clipped word; blind A/B against his hand
  edit, he can't pick the machine on 3 of 4 splices.
- Captions: highlighted word within 40 ms of the voice at every splice.

Size: ~1.5–2 weeks (envelope + pads prior 3 days; sample-accurate render 3 days; learning from
accepted/adjusted cuts + reference pads 3 days; audit + tests 2 days).

---

# Round 4 — reference learning ("did I put them in for nothing?")

## What the references do today (verified)

- Each uploaded reference is measured locally (`reference-analysis-job.ts`, no model): end-card
  detection, scene-change cut times, shot stats, Whisper transcript, wpm, pause stats, hook text
  and its duration, loudness, voice/background levels — ~50 numbers in `ReferenceContent.metrics`.
- They collapse to medians (`getReferenceStyleProfile`), and **five** reach the edit (length
  target, pause p90, longest pause, shot p25, first cut) — each clamped to a band so narrow the
  references barely move it. Dead: `cuts.times`, transcripts, hook text, cuts/10 s, pauses/min,
  hook duration, every audio detail. Nothing is measured about what a viewer *sees*: on-screen
  text, caption style, zooms, headline density, B-roll — because there is no OCR or overlay
  detection. No reference signal reaches the Editor (one length note), the visuals, captions or
  the hook title. The notes-AI reads only typed notes; the Creative Director's reference context
  is an empty string. Below 3 measured videos everything falls back to built-in defaults.
- Honest answer: today the references change the kept-pause length by a few hundredths of a
  second and set a length target. That is all.

## What a reference should teach, and how to read it

Measure **what a viewer sees and hears, as a sequence in time**, not a median:

| Signal | How it's read (local unless marked) | Who consumes it |
|---|---|---|
| Cut rhythm as a sequence | existing scene cuts → shot lengths by position (open / build / payoff thirds), jump vs angle change | Editor (pacing), Splice (kept pause), Orchestrator (zoom rate) |
| On-screen text events | frame OCR at 4 fps (tesseract in the snapshot; a LOW vision call only for frames OCR can't read) → appear / hold / change, words, size band, position band | Editor (headline density + length), Orchestrator (anchors, hold times) |
| Caption style | from the same OCR: words per chunk, position band, case, highlight present, one-word vs phrase | Orchestrator (caption preset) |
| Headline vs caption roles | text that holds ≥ 2 s = headline; text that changes with speech = caption | Editor (what a headline says: number / stake / choice), Orchestrator |
| Hook pattern | first 2 s: what's on screen vs what's said (OCR + transcript); hook line's mechanism (Editor's taxonomy) | Editor (hook choice), the gate (hook visible by 1.5 s) |
| Zoom usage | scale drift between frames inside a shot → punch-in rate, amount, hold, in/out shape | Orchestrator (zoom vocabulary) |
| Graphic / B-roll presence | frame-difference regions that aren't the speaker (subject track) → share of time with an insert, where on screen | Orchestrator (graphic density band), Visual strategist |
| Splice pads | offset→cut and cut→onset on the envelope at every detected cut | SpliceModel (round 3) |
| Music / loudness | background-under-voice, LUFS (already measured) | Render (music level), gate |
| Story shape | transcript → the Editor reads it once as a "reference brief": hook mechanism, where the turn is, how it ends (model, once per reference, cached) | Editor (exemplars for this series) |

Aggregate per **creator** and per **group** (talking / no-face), weighted by Chris's own tags
("why they matter", "don't copy" — typed today, unused) and, once snapshots flow, by what
performed. Output one typed `StyleModel` with bands (p25–p75), not medians, so every consumer
enforces a *range* and the Editor's judgment moves inside it.

## How it reaches each stage

- **Editor**: a 10-line digest in its prompt — "your references open with the question on
  screen by 0.8 s; a headline every 6–9 s; 2–5 words; the payoff number lands at ~70 %; endings
  ask a question" — plus two exemplar hooks from the same series.
- **Splice**: pad and kept-pause bands (round 3).
- **Orchestrator**: caption preset, headline anchor/size/hold bands, zoom rate and shape,
  graphic density band.
- **Gate**: the same bands as checklist thresholds ("like the references" becomes measurable).
- **Chris**: the `/reference` page shows what each creator *does* in these terms (not 50
  numbers), and which of his own videos sit inside or outside the band.

## Learning from his own work, in the same frame

- His hand edits and every "posted unchanged" video are references of the highest weight: the
  same measurements run on them, labelled "mine".
- Every correction in the editor (nudged cut, deleted graphic, moved headline, changed caption
  preset) is a labelled delta between machine and human — the existing `motion-taste.ts`
  pattern (signals → STRONG after ≥ 3 across ≥ 2 videos) extended to cuts, text and captions.
- Performance snapshots, when the apps connect, weight references and his own videos by
  outcome, never by vanity count (follows per 1k views, watch time where exposed).

## What the best do

- **TikTok/CapCut "use this template"**: copies a reference's text timing literally — take the
  idea that a reference is a *timing template*, not its literal copy.
- **Opus Clip / Vizard**: learn nothing from your references — nothing to take.
- **Runway / Descript style transfer**: none measure what a viewer sees in a *competitor's*
  video; this is a real edge, not a catch-up.

## Pass tests

- OCR text events on 10 references match a human count within 15 %; headline vs caption
  classification ≥ 90 % agreement with a human tag.
- The StyleModel for his MAIN group prints a one-paragraph description Chris agrees with.
- Given the same take, the Editor with the digest produces a cut whose headline density and
  hook timing sit inside the band; the gate's "like the references" check passes.

Size: ~2 weeks (tesseract in snapshot + OCR pipeline 3 days; text/caption/zoom/graphic
measurement 4 days; StyleModel + bands + digest 2 days; consumers wired 2 days; UI 1 day).

---

# Round 5 — screen orchestration (one editor owns the whole screen)

## How the screen is built today (verified)

- **Four passes that avoid each other, in this order** (`full-edit/index.ts`): the hook title
  (`placeTitle`, one text for ~2 s), beat headlines (added this week, placed by the same
  function), graphics (`chooseVisuals` → placement solver avoids face / captions / texts),
  then zooms (a "nothing changed for 7 s" push-in and a keyword-emphasis push-in). The AI edit
  adds a strategist/designer pass on top. Nobody reconciles them; nobody plans the whole beat.
- **Compositing** (`timeline-render.ts`): picture → zooms (ffmpeg perspective; ease in, snap
  back, no ease out) → graphics (Remotion overlays; may anchor to the head and ride punch-ins)
  → texts and captions as static ASS/drawtext layers. Texts have no anchor, no motion; captions
  sit at one fixed `y` in up-to-3-word chunks, big, with a gold highlight — the loudest layer.
- **The placement solver** finds "a clear spot" per graphic, so cards land in different places
  video to video; fixed zones don't exist. Over-hair placement is the close-up fallback.
- The reference reel (39 s): 8 headlines at one anchor, 1 sticker building in sync, 4 shots,
  zoom-ins at idea boundaries, one-word captions beside the speaker — one composed screen.

## What I would build: the Screen Orchestrator (`packages/media/src/screen/`)

**Input** — the Editor's plan (beats with output timing, headlines, viewerNeeds, emphasis words),
the CutList, the subject track (head position per frame), the StyleModel (anchors, caption
preset, hold bands, zoom rate/shape, density), the graphics catalogue.

**Output** — one `ScreenPlan`: five lanes on one clock.

| Lane | Rule |
|---|---|
| HEADLINE | one fixed anchor for the whole video (top zone, picked once from the subject track so the head never enters it; if the framing can't give a top zone, the headline moves to the side band — never onto the face); arrives on the first word of its idea, leaves on its last word (+0.2 s); 2–5 words; the hook headline covers the hook beat |
| GRAPHIC | directly under the headline anchor (or the opposite side band); one per beat at most, only where the Editor named a need; appears on the word that names it; builds in sync (a tick per spoken item); leaves at the beat's end |
| CAPTION | support: one fixed spot near the speaker (chest / beside the face from the subject track, not a fixed y), the StyleModel's preset — default QUIET: one word at a time, small, white, no box; when a headline is up, captions stay small; never both bold |
| ZOOM | in-hold-out (ease in 0.4 s, hold, ease out 0.4 s — the renderer gains the out); at beat boundaries and on the Editor's emphasis words; amount from the StyleModel (1.06–1.15); never on the same beat as a graphic build |
| FACE | the lead on confession / ask beats: no headline change, no graphic, captions quiet |

**The one-lead rule, enforced by a solver, not a prompt:** per beat exactly one lead
(headline change, graphic build, zoom, or face). Entrances never overlap exits; a 0.3–0.6 s
beat of plain speaker between leads is kept on purpose. Nothing changes for > 5 s → the
orchestrator adds the cheapest lead (a zoom or the next headline earlier), never a graphic.
Nothing crosses the face core; nothing sits on the hair when a side band is free.

**Motion felt, not seen:** headlines pop/settle in < 0.3 s on the word; stickers tick; graphics
build their content only; numbers are already final (no count-ups); exits are faster than
entrances; one visual system per video (one headline style, one caption preset, one sticker
family, one zoom amount) — variety comes from the words.

**Where the model fits:** the Editor decides *what* each beat needs (headline text, need);
the Motion Designer fills graphic *content* into the slot the orchestrator opens (size, anchor,
window given); the orchestrator decides *where, when, how long, how it moves* — deterministic,
testable, identical in preview and render.

## Changes this implies

- `TimelineText` gains an anchor (`TOP | SIDE_L | SIDE_R | NEAR_SPEAKER`) resolved from the
  subject track, and enter/exit; captions gain a `QUIET` preset and a `NEAR_SPEAKER` position
  mode; zooms gain `easeOutSeconds`; the render's text layer (ASS) takes per-text positions
  from the plan rather than a fixed y; the editor preview mirrors all three.
- `full-edit/index.ts` step 5–7 (titles, zooms, visuals) and `motion-design-job.ts` placement
  collapse into the orchestrator; the placement solver keeps face/caption avoidance as the
  orchestrator's constraint checker.
- The gate's screen audit (round 2) checks the same rules on the render.

## Pass tests

- A 42 s take: 6–9 headlines at one anchor, every graphic under its headline on its word, no
  beat with two leads, no element on the face core, no 5 s window without a change, captions
  readable in a 2× zoom-out screenshot but never louder than the headline.
- Side by side with the reference reel at matching timestamps: a cold viewer says both were
  "edited by someone", not "generated".
- Preview = render: the same ScreenPlan screenshots match within a few pixels.

Size: ~2.5 weeks (ScreenPlan + solver 1 wk; text anchors / QUIET captions / zoom-out in render
and preview 1 wk; wiring + tests 0.5 wk).

---

# Order of the whole build (rounds 1–5 together)

1. Splice precision (round 3) — the loudest machine tell; deterministic; objective test.
2. Gate G1–G2 (round 2) — free audits + typed-fix watch-back, so every later phase is judged.
3. Reference learning (round 4) — the StyleModel every later stage reads.
4. Screen Orchestrator (round 5) with Editor v2 — one composed screen.
5. Gate G3–G4 + publish — shadow accuracy, then hands-off posting for earned types.

Roughly 9–10 weeks of build at the sizes above; each phase ships on its own and is judged by
watching, never by a metric alone.

---

# Critique — arguing against my own plan, from every seat that decides quality

## What holds up

- The split of judgment and execution: the Editor owns the story, deterministic engines
  execute word- and sample-exactly, plans are typed and stored (replayable, no re-rolls).
- A checklist gate that fails closed on facts and names a stage to fix, never a score.
- Reference learning that reads what a viewer *sees*, with the owner's own posted videos and
  hand edits as the highest-weight references.
- Orchestration as a solver (anchors, timing to the word, held for the idea), not a prompt hope.

## What I would officially change

1. **Week 0 — a golden-set harness, before anything else.** Five of his takes + his two hand
   edits as fixtures; the whole pipeline replays offline on every change and diffs frames,
   splice metrics and the kept-line order. Today every iteration costs a 10-minute ship and his
   credit; that, not any single stage, is why quality moves slowly. Engineering seat.
2. **The Editor is one-shot and fragile.** Three headlines in 42 s and a junk cold-viewer
   field came from a single HIGH call. Change: write → critique (MEDIUM, checklist: a headline
   per beat, the hook stands alone, the ending serves the objective, every number a payoff) →
   revise once; schema minimums (headline required per beat, coldViewer ≥ 2 sentences,
   emphasis words). Editor seat.
3. **"One lead at a time" is too rigid.** The reference *stacks* a holding headline with a
   building sticker. The rule is "one *new* thing per beat" (one entrance), with stacking
   allowed when the StyleModel shows the references stack. Editor + viewer seat.
4. **The gate will flatter its own work.** A model rating the system's output rates it kindly.
   Change: contrastive judging — the watch gets matching-timestamp frames from a reference and
   answers "which reads as edited by a person, and why"; a separate, cheap isolated hook test
   (first frame + first 2 s of audio only: "would you keep watching?"); and the autonomy label
   becomes an explicit one-tap rating at post time, because "posted unchanged" is a noisy label
   when he's rushed. Guru + viewer seat.
5. **One-word captions are wrong for numbers.** The reference is lifestyle talk; this is money.
   Captions adapt: one word for short emotional lines, phrase chunks for lines with amounts,
   and numbers always carried by the headline, never only by a caption. Viewer seat.
6. **The cheapest quality lever is upstream: how he films.** A headline zone needs headroom; a
   clean splice needs a steady level and a real mic. A one-screen filming card in the app
   (frame with the top third free, lock exposure, mic on, say the hook twice, pause after the
   payoff) does more for the screen than any solver. Cinematographer seat.
7. **The cover frame is missing.** Frame one is the post's thumbnail and the first second of the
   scroll; the ScreenPlan must pick it (hook headline visible, face readable, no mid-blink).
   Platform seat.
8. **Sound is more than levelling.** Room-tone continuity at every splice (fill the crossfade
   with the take's own noise floor, not silence), voice EQ consistent across a take, and no
   SFX/music by default unless the StyleModel shows the references use them. Sound seat.
9. **State a latency budget.** Upload → ready in ≤ 8 minutes with honest progress; anything
   slower and he edits by hand again. Operator seat.
10. **Order: parallelise.** Splice time-boxed to one week alongside Editor v2 + orchestrator,
    gate G1 (free audits) immediately, OCR expectations tempered (stylised script/handwritten
    text will need the vision fallback more than "rarely").

## What needs refining, by seat

- **Editor:** tension is under-specified — "each beat adds something" needs a test (new number,
  new stake, new contrast) the critique pass checks; the TURN must be optional and honest.
- **Influencer / guru:** series recognition (the Signature openers) should be a StyleModel
  choice per series, not a library the strategist might pick; the ending objective should
  drive the caption's first line and the pinned comment, not just the last spoken line;
  posting cadence belongs to the calendar, not the gate.
- **New viewer:** the first second decides — the cover frame + hook headline test above; the
  ending should re-hook (loop or question) because replays count.
- **Platform / distribution:** sound-off viability (headlines + captions carry the idea),
  9:16 safe zones, no watermarks/AI markers, native encode — mostly covered; cover frame and
  "comment X" mechanics are not.
- **Brand / trust / compliance:** FACTUAL stays fail-closed; a disclaimer rule for advice-like
  lines belongs in the Editor's ENDING/packaging, not a post-hoc check.
- **Accessibility:** caption contrast and size minimums as gate thresholds.
- **Reliability:** every stage idempotent and replayable (mostly true today); the golden set
  makes it provable.

## Verdict

The architecture is right; the plan under-weights iteration speed, upstream filming, the cover
frame, sound continuity, and over-trusts a single Editor call and a self-judging gate. With the
ten changes above it is a plan I would stake the "feels human" claim on.

---

# Recommendation — the executable version (supersedes "Order of the whole build")

**Keep:** Editor owns the story + deterministic word-exact execution; typed stored plans; the
fail-closed FACTUAL gate; the transcription pipeline as shipped; the Signature library; the
orchestration rules; the cutting fixes already live.

**Adopt all ten critique changes.** The two that matter most: the week-0 golden-set harness
and the two-pass Editor.

| When | Build | Why first | Judged by |
|---|---|---|---|
| Week 0 (3–4 d) | Golden-set harness (5 takes + 2 hand edits replayed offline, frame/splice/kept-order diffs); filming card in the app; latency meter (upload → ready, target ≤ 8 min) | makes every later step fast and judgeable | harness runs green on today's output |
| Week 1 | Splice engine (envelope + hysteresis + learned pads + zero-crossing crossfades + room-tone fill), time-boxed; gate G1 free audits (gap, clipped word, click, level step, face, double lead, hook text) | loudest machine tell, objective | headphones + harness: no audible gap/clipped word; 5 planted defects caught |
| Weeks 2–4 | Editor v2 (write → critique → revise; headline per beat; emphasis words; tension test) + Screen Orchestrator (five lanes, one *new* thing per beat, fixed anchors, adaptive captions, cover frame, zoom in-hold-out); preview = render | the leap he will see | every Friday: 3 golden videos vs last week's, his verdict |
| Weeks 4–6 | Reference learning (tesseract OCR in snapshot, text events, caption/zoom/graphic measurement, cut rhythm, splice pads) → StyleModel bands → Editor digest, orchestrator presets, gate thresholds | "like my references" becomes measurable | StyleModel paragraph he agrees with; cuts land inside the band |
| Weeks 6–8 | Watch-back gate: contrastive judging vs reference frames, isolated hook test, typed fixes, one loop, HOLD queue; shadow autonomy with a one-tap rating as the label; demotion rules | trust before hands-off | shadow agreement ≥ 90 % over 10 per series |
| From week 1, external | Platform apps, Meta review, TikTok audit, Google audit; cron secrets; flags | the only thing code can't shorten | first scheduled post fires on its own |
| When earned | Auto-post per series behind `shadow_only` + ceiling | — | 3 earned videos post without a click; a non-earned one waits |

**Don't:** chase cut counts or pacing numbers; add graphics for their own sake; build paste
paths; let the gate become a score; ship without the harness green.

**Rhythm:** ship weekly; Friday review of three golden-set videos side by side; the measure is
his verdict plus the gate's shadow agreement — never a metric alone.
