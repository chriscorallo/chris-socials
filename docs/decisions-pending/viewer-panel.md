## Viewer Panel — an AI first-time viewer for one whole video (2026-10-17)

Chris asked for "the bot that oversees it" to watch each video as a new viewer would and say
what they'd be thinking (confused, entertained, educated, bored, irritated…), especially for
acquiring new viewers and followers. He also wants it to judge cuts against the speaker's
cadence and the story ("never a cut for the sake of a cut"), picture vs words, audio vs
picture, music over the voice, uneven levels, and what makes a video rewatchable, savable,
shareable. Long-term taste/performance learning is **out of scope here**.

---

## Decision 1 — A new agent (VIEWER_PANEL), not an extension of Visual QA

`prompts/agents/VIEWER_PANEL.md` (model_class HIGH, output_schema `ViewerReview`),
`packages/agents/src/viewer-panel.ts` + `viewer-panel-schema.ts`, registered in
`docs/AGENT_CONTRACTS.md`. Authority level 3, **advisory only**: it writes its own
`ViewerReview` rows; nothing in `aggregateHardGates` / `recordQualityGateResult` reads them, so a
hard-gate BLOCK can never be averaged away by a "great" viewer verdict (the aggregation's type
signature is untouched). It doesn't move the video's state either.

*Alternatives:* extend Visual QA (rejected: Visual QA is a defect finder feeding the TECHNICAL
gate; a viewer's subjective boredom must not become a gate input, and its 6 frames can't see a
whole video's rhythm); extend the Adversarial Evaluator (text-only, artifact-agnostic critic —
no time axis, no audience simulation); Audience Intelligence (reads real comments — the
complement of this, after posting); Creative Director (weekly strategy, not one video).

**Provenance in the type, not just the prompt:** every judgment (hook, beat, drop-off, craft
check, story jump, verdict, fix, strength) carries `evidence: [{t, kind: SEEN|SAID|HEARD|MEASURED,
detail}]` with at least one item. Engagement numbers are `{kind: "ESTIMATE", score 0–100,
uncertainty, rationale, evidenceTimes (≥1)}` — there is no field a view-count forecast could go
in (unknown fields are dropped). `checkViewerReview` (deterministic) clamps times into the video,
drops judgments whose evidence lies entirely outside it, sorts beats, orders fixes, and flags
certainty language ("will go viral", "guaranteed", "will get 1M views") as a warning shown under
"What it couldn't judge".

## Decision 2 — Frames + measured facts, not native video input

The input is built deterministically in the heavy-job worker (`apps/worker/src/viewer-review-job.ts`):

- **Frames** (`planViewerFrames`, pure): first + last frame, the opening every 0.5 s to 3 s,
  **both sides of every cut** (±0.1 s, labelled "just before/after a cut"), text/graphic/zoom
  starts, ~1 fps elsewhere; collisions within 0.12 s merge (a cut label wins over "opening").
  Capped at 80 (the API takes ≤ 100 images); over the cap, background samples go first, then
  graphic frames, then cut pairs — each time the one with the closest neighbour — the opening
  and first/last are never dropped. Extracted as JPEG with the long edge 640 px
  (`extractScaledFrames`, packages/media): 360×640 ≈ **308 image tokens** each vs ≈ 2 765 for a
  full-HD PNG, captions still legible. Each image block is preceded by its label
  (`t=3.10s — just after a cut`) through the existing `ModelImageInput.label` path of the
  Anthropic provider (base64 image blocks were already supported — no provider change needed;
  a new test pins the request shape).
- **Words**: Chris's render → the edit's own output-timed words (`timelineCaptionWords`); a
  legacy plan or a reference video → local Whisper on the file. Shown as short timed lines.
- **Edit facts** (exact, from the EditPlan timeline): every cut and its kind
  (PAUSE_REMOVED with seconds removed / FRAMING-only punch-in/out with zoom from→to / TAKE),
  zooms, captions on/off + style, texts, graphics (template, time, anchor phrase), music bed
  level + ducking, SFX count. Reference videos: the measured cut times (`metrics.cuts.times`,
  end card excluded) or fresh detection.
- **Sound** (measured): integrated loudness, true peak, clipping (`measureStyleLoudness`);
  voice vs background (`measureVoiceBackground`); per-second level, ≥ 6 dB jumps while talking,
  and ≥ 6 dB level changes across a cut with speech on both sides (`measureViewerAudio`, new, pure).
- **Pacing reference**: the MAIN reference style medians (`getReferenceStyleProfile`) —
  "a pacing reference, not a rule".
- **Brand context** only for Chris's own videos, labelled as "to keep FIXES in his voice — the
  viewer doesn't know any of this"; never for reference videos.

*Alternatives:* native video input (not available through this provider abstraction / the
Messages API takes images, not video files; and we'd lose the exact cut/audio facts); a
contact-sheet grid of frames (same tokens per pixel, worse per-frame timestamps); sending audio
(not supported as an input here — measured numbers are more consistent anyway, CLAUDE.md:
deterministic checks get deterministic code).

## Decision 3 — Model class HIGH (Opus 5.5, effort high)

Watching a whole video and simulating a viewer's moment-to-moment reaction while tying every
claim to evidence is the most semantic, vision-heavy judgment in the system, and it runs once
per video on demand, not in a loop. *Alternative:* MEDIUM (Sonnet 5.5, ~half the price) —
reversible with `MODEL_HIGH` or by flipping `model_class` in the prompt frontmatter if Chris finds
Sonnet's read good enough once there's credit to compare.

## Decision 4 — Cost per video (estimated BEFORE the call, shown on the button)

`estimateViewerReviewCost` (pure, the same frame plan the job builds):

- image tokens = frames × ⌈360×640/750⌉ = frames × 308
- text tokens = 3 200 (SYSTEM_BASE + VIEWER_PANEL + task) + facts (1 200 + 1.7 × words, or the
  real facts length ÷ 3.6 in the job) + 12 per frame label (+ brand context ÷ 3.6 for Chris's videos)
- output = 12 000 planning tokens (≈ 5–6 k of JSON + adaptive thinking at effort high); the
  button also shows the 1.6× high end.
- Opus 5.5: $4 / MTok in, $20 / MTok out.

| Video | Frames | Input tokens | Cost (12 k out) | High end (19.2 k out) |
|---|---|---|---|---|
| 20 s, 2 cuts, 1 graphic (test) | ≈ 30 | 30×308 + ~4.9 k ≈ 14.2 k | 0.057 + 0.240 ≈ **$0.30** | ≈ $0.44 |
| 45 s, 15 cuts, brand context | ≈ 75 | 75×308 + ~6.5 k ≈ 29.6 k | 0.118 + 0.240 ≈ **$0.36** | ≈ $0.50 |
| 60 s, 30 cuts (cap 80) | 80 | 80×308 + ~7.2 k ≈ 31.8 k | 0.127 + 0.240 ≈ **$0.37** | ≈ $0.51 |

Output dominates; ≈ $0.30–0.40 per video, ≈ $0.50 worst case. Guards: the existing
`CostTrackingModelProvider` (ModelCallLog + daily cap, fails closed) wraps the call, and a new
per-review ceiling `VIEWER_REVIEW_MAX_USD` (default $2) refuses before anything is sent when the
estimate's high end exceeds it. The actual cost is stored on the row (`costUsd`) next to the
estimate. **Not measured against a real call** (no credit) — the output figure is the biggest
uncertainty; the first real run's ModelCallLog row is the check.

## Decision 5 — A heavy-job kind, `viewer-review`, and a versioned table

Wired like the others (`HEAVY_JOB_KINDS`, `parseHeavyJobArgs` — exactly one of
`contentItemId` / `referenceContentId`, optional platform TIKTOK|INSTAGRAM|YOUTUBE and persona
COLD|FOLLOWER), lease subject = the video, or `reference-video:<id>` for a reference video;
`heavyJobNeedsModel` → true for both, so the dispatcher passes `ANTHROPIC_API_KEY` to the
sandbox (test). Progress lines: "Getting the finished video…", "Listening to the sound…",
"Picking the moments to watch (12 of 28)…", "Watching it like a new viewer…". Expected refusals
(no render, file deleted, estimate over the ceiling) and AI failures (spend cap, credit, key)
come back as `{ok:false, error, result:{errorName}}` — the page words them plainly.

Migration `20261017220000_viewer_reviews` adds `ViewerReview` (additive; see DATA_MODEL.md):
append-only, tied to `renderId` + `editPlanId` (or `referenceContentId`), the exact
`mediaStorageKey`, prompt id/version, model, review JSON, warnings, input summary (frame times +
reasons, word/cut counts and sources, the estimate), verdict tier, estimated + actual cost,
tokens, JobRun id; audit `VIEWER_REVIEW_RECORDED`. Failed runs stay on their JobRun only.

## Decision 6 — Where Chris sees it

- **Video page**, when a successful render exists: a "Viewer check" card (additive — one data
  load + one JSX line in `content/[id]/page.tsx`). Feed choice (TikTok / Reels / Shorts, default
  = the first scheduled platform, else Reels) and one button **"Watch it like a new viewer
  (≈ $0.30)"** with the high end and frame count underneath → live progress → verdict tier +
  headline + biggest reason, a player, the **attention/feeling strip** (one bar per beat: height
  = attention, colour = with you / learning / drifting / losing them; tap → the player jumps
  there and the beat's inner voice + evidence show), where they'd swipe away (red ticks + list),
  top fixes with tappable times. "Everything the viewer noticed" folds away story, craft
  problems, what works, likely reactions (labelled estimates, with uncertainty), limitations and
  cost. A review of an older render says so. The floating heavy-job banner ignores this kind
  (the card shows its own progress).
- **Reference creator page → a video's Details**: "What a viewer thinks", same card/agent; the
  prompt asks it to explain *why* the video works (which cuts serve the story vs only remove
  pauses) as transferable principles, never identity.
- AI off / out of credit / daily limit reached: a plain sentence + **More → AI credit**
  (`/settings/ai`); a job that fails for those reasons says so with the same link. Nothing
  crashes.
- The editor's Finish flow was **not** changed (another agent is editing nearby; the video page
  is one tap away after Finish).

## Reversibility

High. Additive table + code paths; no existing behaviour changes. Remove the card line(s) to
hide it; nothing else reads the rows. Model class / effort / frame cap / ceiling are constants
or env (`MODEL_HIGH`, `VIEWER_REVIEW_MAX_USD`).

## Verified / not verified

- **Tests** (MockModelProvider, recorded-shape fixture `packages/agents/src/viewer-panel-sample.ts`):
  schema rejects missing evidence / unlabeled estimates / predictions; post-check; frame
  planner (hook, cut pairs, events, cap, thinning); cost math; one HIGH call with labelled JPEG
  frames; the Anthropic provider's exact request shape (fake client, no network); spend cap fails
  closed (DB down and $0 cap → zero calls); worker end to end on real ffmpeg + throwaway DB
  (frames on both sides of each cut, edit facts, measured audio, row + audit, re-run = new row,
  state unchanged, no-render refusal without touching the AI, ceiling refusal, reference path);
  web loader + card states rendered server-side (ready / no render / running / out of credit /
  AI off / limit / done / reference); eval fixtures `fixtures/evals/viewer-panel.json`
  (music over voice, choppy cuts, calibration) graded in mock mode.
- **Visual check** at 393×852 against a throwaway PGlite DB with the REAL job run in-process on a
  real 20 s file and the mock model (screenshots in the final report).
- **Not verified:** any real model call (no Anthropic credit; never made) — so the real output
  quality, the true output-token count/cost, and whether 360×640 frames are enough for caption
  legibility judgments are unmeasured. The eval's frames are neutral placeholders (it grades fact
  handling and calibration, not vision); a vision eval needs real clips once there's credit.
  The cloud path is wired but **the Vercel Sandbox snapshot must be rebuilt** (apps/worker,
  packages/agents, packages/media and prompts changed) and `RENDER_SANDBOX_KINDS` must allow
  `viewer-review` (it does when set to `*`).
