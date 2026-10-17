# Style cut — the no-AI edit paced like Chris's reference creators (2026-10-17)

Chris wants an uploaded talking-head take to come back feeling like Shelby Sapp / Alex Hormozi /
Jun Yuh / Humphrey Yang — and to judge that quality himself before anything else is switched on.
Before this, the no-AI starter edit was the whole longest take + captions + loudness: no cuts,
no pacing. The reference style profile (`getReferenceStyleProfile`, 2026-10-17) was measured but
unused.

## Decision 1 — A pure, deterministic cut; no model calls ($0)

`buildStyleCut` (`packages/media/src/style-cut.ts`, browser-safe, pure) turns a take's word
timings + measured silences + face track + a target into an EditTimeline v2:

1. **Dead air:** start 0.12 s before the first speech, end 0.3 s after the last (tight ending —
   the references' "4.4 s after the last word" is Instagram's end card and is ignored).
2. **Pauses:** a silence longer than the target is shortened to the target — `pauseKeepS`
   mid-sentence (references' gap p90, clamped 0.12–0.30 s) and a longer `sentencePauseKeepS` after
   punctuation (half the references' longest gap, clamped 0.22–0.50 s), split ~60/40 into a pad
   after the speech and a pad before the next (≥ 80 / 60 ms). Removing < 0.12 s isn't worth a
   jump cut; a short pause that would make a shot shorter than max(0.8 s, p25/2) (first shot:
   0.6 × the first-cut target) is kept, unless the silence is ≥ 0.75 s.
3. **Rhythm:** every removed pause is a cut. A shot longer than the references' p75 is split
   at the best boundary near the median (kept pauses > Whisper word boundaries; sentence end
   > comma); the first shot aims at the references' first-cut time (they open on a longer shot,
   then speed up). If no safe boundary exists the shot stays long — never a mid-word cut.
4. **Framing:** a cut on one camera = a framing change: WIDE 1.0 / MEDIUM 1.12 / TIGHT 1.2,
   WIDE alternating with the punch-ins (never the same twice in a row). Punch-ins are centred on
   the FACE (derived from the tracked protected-head box — they may crop hair/ear margins like any
   editor's punch-in, never the face) as far as the crop allows, keeping the face's height in the
   frame; a punch-in that would push the face off-frame or the chin into the caption band steps
   down a zoom. No track → an assumed centred talking head.
5. **Captions** on (the base timeline's style); they are derived from the clips by the shared
   `timelineCaptionWords`, so removed pauses never desync them. **Audio:** normalize on (the
   renderer masters at −14 LUFS = the references' median); music untouched (none selected).
6. Every clip is a whole number of 1/30 s frames (no A/V slip between contiguous clips).
7. Returns the timeline + per-shot list + stats + a plain-English summary ("Removed 14 pauses
   (7.9 s) · 15 cuts, one every 2.2 s · starts on your first word · ends 0.3 s after your last")
   + where the pacing came from ("Paced like your 15 reference videos (4 creators).") + an
   `inputsKey` (hash of every input — same key, same cut).

Targets: `styleCutTargetFromProfile(getReferenceStyleProfile(prisma, { group: "MAIN" }))`.
Fewer than 3 analysed videos (or a number measured on fewer than 3) → built-in defaults close to
the first live measurement (shot 2.4 s, p25–p75 1.9–3.6 s, first cut 3.2 s); everything clamped so
a broken measurement can't produce absurd shots. Multiple takes: still the starter edit's rule
(longest take) — stitching retakes is a judgment call, left out on purpose.

*Alternatives:* an LLM edit plan (costs money, non-deterministic, and this is arithmetic —
CLAUDE.md); a smooth zoom instead of punch-ins (references cut; slow zooms weren't measured);
cutting on every Whisper gap (see Decision 2).

## Decision 2 — Pauses come from the AUDIO, not from Whisper's word edges

Measured on the test take (`say` speech with known silences): Whisper `base.en` word ends run
~0.15–0.2 s early ("version." ended 0.21 s before the voice did), and a word after a long pause
often "starts" inside the pause ("put" 0.4 s early; "Second," spanned the whole 1.5 s silence).
Cutting on those edges with 60–80 ms pads would clip the ends of sentences. So
`packages/media/src/speech-activity.ts` measures silences from the audio (20 ms RMS frames,
threshold 30 % of the way from the room-noise floor (p5) to the speech level (p90), ≥ 6 dB over
the floor, ≥ 0.1 s) and `speechMap` assigns Whisper words to the sound "islands" between them, in
order, by overlap — the audio says WHERE it's quiet, Whisper says which pauses end sentences.
Wordless islands < 0.3 s (breaths, clicks) count as silence; longer ones are kept (could be words
Whisper missed). Without measured silences (`STYLE_CUT` WHISPER mode) the pads widen to 0.22 s /
0.10 s. The silences are cached on the plan (`plan.styleCut.silences`) so a re-apply doesn't
re-decode the take.

Caption timing still comes from Whisper (unchanged): on the test render captions lead the voice
by ~0.15 s. A Whisper word stretched across a removed pause could survive on both sides of the
splice; `timelineCaptionWords` now shows such a word once, on the side where more of it is (only
for a FORWARD splice of the same take — a duplicated clip keeps its own captions).

## Decision 3 — Whisper long-take bug fixed (chunk 30 s → 25 s)

`LocalWhisperTranscriptionProvider` used `chunk_length_s: 30` (= Whisper's own window). On a
46 s take, transformers.js returned 31 of 118 words: the first sentence all stamped 29.96 s, the
rest of the first 30 s missing. 25/5 and 20/4 returned all 118 with sane times; now 25/5
(`WHISPER_CHUNK_SECONDS`). **This affected every take and every reference video longer than 30 s**
(references are ~66 s), so reference speech metrics measured before this fix (wpm, gaps, hook)
are suspect — re-measuring the reference library is recommended (the measuring code wasn't
touched; another agent owns it).

## Decision 4 — Wiring: automatic only on an untouched starter edit; Chris's buttons are versions

- **Automatic** (`maybeAutoStyleCut`, apps/worker/src/style-cut-job.ts): after the upload's
  `ingest` job transcribes / face-tracks a take, after a `transcribe` job, and right after
  `createStarterEdit` (upload screen, "Edit video", plan board). It writes ONLY when the item is
  EDIT_PLANNED and its latest plan is the original starter edit (origin STARTER_EDIT, no
  timeline, no revision reason) or an earlier automatic style cut whose inputs changed (e.g. the
  face track arrived). Written by `recordAutoStyleCut` (packages/domain style-cut-plan.ts): a new
  EditPlan row (`revisionReason` "Style cut (automatic, no AI)", `plan.timeline` +
  `plan.styleCut`), audit `EDIT_PLAN_REPLANNED` by SYSTEM, compare-and-swap on the latest plan id
  under a per-item advisory lock — two triggers racing can't both write; same `inputsKey` → no
  row. No state transition (EDIT_PLANNED → EDIT_PLANNED re-plan, same as `recordReplannedEditPlan`).
  Never throws; a failure leaves the plain starter edit. Kill switch: `STYLE_CUT_AUTO=off`.
- **Chris** (editor → "Style cut" tool on the phone toolbar / "Style cut" tab on desktop): shows
  the summary line, "Redo the style cut" and "Use my full take instead". Each is a finishing edit
  through `saveFinishingEdit` (new `planExtras` param, additive) — a new version, normal rollback
  rules, Undo in the editor brings the previous doc back. Chris's rows are never touched by the
  automation. Without captions: "Style cut needs captions first…".
- On the live site, the web-side trigger doesn't download the take to measure silences (a big
  iPhone file in a function); it cuts on word timings with wide pads and the cloud `ingest` job
  refreshes it with measured silences. (Editing is currently off in the cloud anyway —
  `RENDER_SANDBOX_KINDS=reference-analyze`.)

*Alternatives:* make `createStarterEdit` itself produce the style cut (domain can't import
media; and the starter row is the honest "plain take" version to go back to); overwrite the
starter row (forbidden — append-only).

## Decision 5 — Renderer: de-click fades at splices

`clipAudioFades` adds an 8 ms fade-out/in where the audio jumps (a removed pause, or another
take); contiguous clips (framing-only cuts) play straight through. Measured on the test render:
largest sample step within ±2 ms of every splice ≤ 0.0015 (speech peaks reach 0.72), splices
sit at the room-noise level (≈ −60 dBFS around them). The browser preview has no fades
(unchanged).

## Reversibility

High. No migration. `STYLE_CUT_AUTO=off` stops the automatic cut; existing style-cut versions
are ordinary finishing edits (Chris can go back to the full take in one tap, or pick any earlier
version). The Whisper chunk change is one constant.

## Verified / not verified

- Unit tests: `packages/media/src/__tests__/style-cut.test.ts` (gap math, never mid-word, audio vs
  Whisper mode, breath handling, sentence beats, cadence in p25–p75, framing alternation/face
  safety, caption remap, idempotency, no transcript, few-reference fallback, silence detection,
  de-click fades); `apps/worker/src/__tests__/style-cut-job.test.ts` (auto apply → idempotent →
  refresh on face track → hands off Chris's edit → plain/re-apply versions).
- Real end-to-end render of a 46 s `say` take (real Whisper, real face tracker, real silences) —
  numbers in the final report / below.
- Not verified: real iPhone footage of Chris (none available); the cloud sandbox path (snapshot
  not rebuilt — the runner code changed, see below); Blob-mode storage.
- **Snapshot:** apps/worker changed (ingest/transcribe now call the style cut) — the Vercel
  Sandbox snapshot must be rebuilt before the cloud ingest job does this.
