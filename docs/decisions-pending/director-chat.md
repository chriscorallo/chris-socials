# Director chat (2026-10-18)

Chris: "Add a feature for me to speak with you in the app." His example, IMG 4186 — a 9 s clip with
**no speech**, only his face: the check hits and he's happy → 2–3 s later rent, car payment,
utilities appear on the other side while the paycheck/money disappears → "well that was a fun 11
seconds". For every video he wants to describe the vision and have it built/animated/edited — not
led by captions or audio. To be folded into `/docs/DECISIONS.md` by the integrator.

## Decision 1 — A chat in the editor; every answer is a typed instruction set, applied by code

**Director** is a tool in the phone editor's toolbar (bottom sheet, full height) and a tab in the
desktop inspector (`DirectorPanel.tsx`). Chris types or dictates (iOS keyboard mic) his vision;
follow-ups ("make the bills drop faster", "move rent to the right") refine it.

- **Conversation** — new table `DirectorMessage` (append-only; migration
  `20261018180000_director_chat`, additive): Chris's MESSAGEs, the ANSWER that came back (parsed
  instructions + raw text + sha256), APPLIED (change list, notes, base + result EditPlan ids),
  REJECTED (errors + the fix-up message), UNDONE.
- **Versions** — each applied answer is saved through `saveFinishingEdit` as a NEW EditPlan version
  ("Finishing edit by Chris: Director chat — Added: …"); manual work is never overwritten. **Undo**
  saves the exact timeline the answer was applied to as another new version (asks first if Chris
  edited after it). Audit: `DIRECTOR_EDIT_APPLIED`, `DIRECTOR_EDIT_UNDONE`, `MEDIA_ASSET_UNDERSTOOD`.
- **Plain change list** — e.g. "Added: Paycheck +$2,400 at 0.9 s–3.3 s (left, 60% size) · Added:
  Rent payment -$1,450, Car payment -$520, Utilities -$240 … · Added text: “well that was a fun 11
  seconds” at 7.3 s–9.0 s (bottom)" + notes ("no room on the right beside your face, so it went
  lower right", "snapped to your smile", "ends at 3.3 s as the next graphic comes in").
- **Idempotent** — a double tap on Send (client key) or a re-pasted answer (sha of the text) never
  makes a second message/version.

## Decision 2 — What the chat sees: computed once per take, free, local

`packages/media/src/take-understanding.ts` (Node) runs in the worker (`take-understand` heavy job,
and inside `ingest` after the proxy; kill switch `DIRECTOR_UNDERSTANDING=off`; a failure never fails
ingest) and stores a `TakeUnderstanding` row (append-only, latest wins):

- one ffmpeg decode of the 720p proxy at 4 fps (coarser for long takes, ≤ 720 samples) — the same
  letterboxed 640×480 frames as the face tracker; **UltraFace** (MIT, vendored) finds the face;
- **facial expression** per 0.25 s: **FER+ `emotion-ferplus-12-int8.onnx`** (ONNX Model Zoo,
  **MIT** — license line `SPDX-License-Identifier: MIT` in the model's README; labels from
  Microsoft's FER+ on FER-2013 faces; 19 300 656 bytes, SHA-256
  `3e47195d…0ff5f1`) on a 64×64 grayscale face crop → softmax over neutral, happy, surprise, sad,
  angry, disgust, fear, contempt. ~25 ms per crop on a laptop CPU (whole 9 s take: ~2 s). The int8
  model was chosen over the 35 MB fp32 one: same top class on every test face. **Not committed**
  (size): downloaded on first use with the checksum verified (`EXPRESSION_MODEL_DOWNLOAD=off`
  forbids it; `EXPRESSION_MODEL_PATH` overrides), and by the snapshot build;
- **motion energy** = frame difference of tiny thumbnails (camera shake counts);
- a **frames sprite** (JPEG, one 180-px cell every 0.5 s) stored in storage.

Pure, browser-safe (`@chris/media/director` `understanding.ts`): smoothing, **events**
(expression onsets measured on the raw crossing, expression changes, head moves, lean in/out, face
lost/found, motion spikes — ids `e1…`), mapping onto the CURRENT edit's output time through the
clips (cuts move/remove events), free space around the face (`layoutWindows`), and the **frames
image** plan (`contactSheetPlan`: ≤ 30 cells, every 0.5 s+, each labelled "3.0s / happy 0.91"). The
image is drawn by the browser from the sprite (`lib/director/frames-image.ts`; served same-origin by
`/api/director/sprite/…` so the canvas isn't tainted) — always matching the current edit, $0.

**Honest about accuracy:** the pack says the expressions are APPROXIMATE with confidences and that
Chris's description wins; mouth-open/gaze aren't measured (no landmarks — "surprise" is the proxy).
FER+ was trained on small, mostly frontal web faces; profile or dim shots will read as neutral.

## Decision 3 — The brain: free ChatGPT round trip (default) or Claude (paid, gated)

One pack (`pack.ts`, ~23–27k chars) for both: Chris's words (he outranks everything), the
conversation and the previous instructions (follow-ups answer with move/update/remove on ids), word
timings (or "No speech"), FACE & MOVES (segments, events, a per-0.5 s table, where his head is and
the free space), CURRENT EDIT ids, the vocabulary (`catalog.ts`: ~40 library presets ranked for his
message — money/phone staples always included — with their data and a per-component field guide,
quick entry, text styles, sounds, zoom, captions), rules, and the strict answer SHAPE.

- **Free (default)** — like `/plan/scripts` and the studio: **Send to ChatGPT** (Web Share with the
  frames image on iPhone), **Copy message**, **Save the frames image**, Open ChatGPT; paste the
  answer → **Build it**.
- **AI (paid)** — `POST /api/director/ask` (Route Handler: carries the JPEG and takes tens of
  seconds, so it never blocks Save) → `runDirectorAgent` (prompt `DIRECTOR_CHAT` 1.0.0, MEDIUM,
  vision) through the existing cost-tracked provider + daily spend cap. Enabled only when
  `getDirectorAiAvailability` says so (key set, not out of credit, under the cap, `DIRECTOR_AI` not
  "off"); otherwise "Ask AI · needs AI credit". Shows ≈ cost per message (estimate ~$0.06 on Sonnet
  5.5; the real cost is logged). The model returns `reply` + `operations_json` (a thin wire shape the
  API's JSON-schema subset can express); the operations go through the SAME tolerant parser and
  strict validator as a paste. Tests use MockModelProvider only.

## Decision 4 — Strict schema, tolerant parser, deterministic applier

`schema.ts` (zod, `.strict()`): `{reply, operations[]}` with `addGraphic` (presetId + props / quick
entry / lines, start/end/duration, placement region or x/y, size, enter/exit, sfx, speed),
`addText`, `addZoom`, `addSfx`, `cut`, `trim`, `setCaptions`, `remove`, `move`, `update`, `note`.
Times: seconds, `"end"`, `{"expression":"happy","nth":1,"offset":0.2}`, `{"event":"e4"}`,
`{"expression":"happy","near":3}`.

`parse.ts` tolerates fences (the block with "operations" wins), prose, smart quotes, comments,
trailing commas, single quotes, a bare array, key/op-name aliases, "3.1s"/"0:03.1", "left side",
"cha-ching", "small", unknown fields (dropped and listed). A misfit changes nothing and returns
precise errors + **Copy the fix-up message**.

`apply.ts` (pure): times checked against the CURRENT edit (past the end / unknown event / an
expression never detected → refused with a fix-up message); presets resolved through the graphics
contract (unknown id → refused with the closest ids); "lines" work for any list component;
**expression snapping** — a numeric time within 0.6 s of an onset of an expression the op's `why`
mentions snaps to it; hand-offs (< 0.4 s overlap) end the earlier graphic as the next arrives; SFX
spacing (≥ 0.25 s, ≤ 24), zoom ≤ 1.6×, overlapping zooms skipped; cuts/trims run last (all times
refer to the edit Chris saw) and ripple everything after.

**Placement** (`placement.ts`): a named side is solved around his FACE (brow-to-chin, bottom-anchored
from the protected head region, over the graphic's whole window incl. zooms) as a hard obstacle,
hair/torso soft, captions/texts/other graphics on screen hard; scale 1 → 0.42; then the nearest
region (LEFT → lower left → upper left → bottom → top), said in the notes. Saved as MANUAL x/y/scale,
so the renderer draws exactly that (it never re-solves MANUAL graphics). An explicit x/y over his face
is moved off it. **Bounds:** the accurate per-app UI regions (`area.ts`: visible width on tall phones,
below the top bar, the right action rails and bottom caption blocks of Instagram/TikTok/YouTube as
obstacles) instead of the frozen margin rectangle the AUTO solver uses (which forbids the whole bottom
third) — when Chris names a side, he gets the space every app actually shows (e.g. lower left beside
his chest). AUTO placement is unchanged.

## Decision 5 — Numbers Chris puts on screen through the chat are his (provenance)

Every graphic the chat adds or changes is recorded in `plan.director.owner` — "Chris via Director
chat", the message id, the numbers it shows, which of them he typed, and a hash of the graphic's exact
data. The Quality Gate's FACTUAL visual-number check skips graphics whose data still hashes to what he
applied (`directorOwnedVisualIds`); a later hand edit changes the hash and the normal
research/script check applies again. This is an explicit owner decision (authority 1), logged per
graphic — not a silent weakening: numbers the answer chose are shown in the change list and the reply
must say which numbers it picked so he can correct them. One-line change in
`apps/worker/src/quality-gate-job.ts` (filter before `findUngroundedVisualNumbers`).

## Evidence (`docs/evidence/2026-10-18-director-chat/`)

**Test clip (IMG 4186 stand-in, not committed):** 9 s, 1080×1920, 30 fps, silent. Two public-domain
portraits of the same person (Colin Powell — official Secretary of State photo, smiling; 1980s
Major General portrait, neutral; US federal works via Wikimedia Commons), face-aligned with the face
tracker, blur-filled to 9:16 (face 33 % of the width, centre at 1/3 height — arm's-length selfie),
handheld drift + grain, cross-faded neutral → happy at 0.9–1.15 s and happy → neutral at 3.2–3.5 s.

**Measured by the real pipeline:** e1 happy onset @ 0.85 s (1.00), e4 happy → neutral @ 3.38 s (0.96),
motion spikes at the cross-fades; 0–0.8 s neutral 0.89, 1.0–3.3 s happy 0.90, 3.5–8.8 s neutral 0.94.
`0-frames-image-sent-to-chatgpt.jpg` = the labelled frames image. `pack-v1.txt` = the exact message.

**Round 1** (`answer-v1-chatgpt-style.txt`, written by hand from the pack the way ChatGPT answers —
prose + a fenced block; parsed with "took the JSON from the code block"): paycheck card
(`pay-received-500`, $2,400, cha-ching) on `{"expression":"happy"}` → 0.85 s, LEFT → lower left at
60 %; bills (`notif-stack-payday`: rent −$1,450, car −$520, utilities −$240) at smile + 2.4 s, RIGHT →
"no room on the right beside your face, so it went lower right" (65 %); balance counter $2,400 → $190
from the face drop; a 1.12× punch-in on the drop; "well that was a fun 11 seconds" at 7.3 s; captions
off. Rendered with the real renderer (Remotion layer + SFX + ffmpeg, 18–23 s): `1-render-v1-frames.jpg`.
Verdict when looking at it: the paycheck lands well; the bills stack was legible only at full size —
centred on the chest and small, NOT "the other side".

**Round 2** (Chris-style follow-up "bills too small and in the middle — put them on the RIGHT, bigger,
one at a time with a pop; keep the balance where the check was" → `answer-v2-followup.txt`, deltas
only: remove `bills`, three red amounts popping in at 3.3 / 3.8 / 4.3 s on the right, three soft pops,
move `balance` → BOTTOM_LEFT): `2-render-v2-followup-frames.jpg` — the balance now drains in the
paycheck's spot ($2,400 → $633 → $235 → $190), the bills stack up one by one right of centre, the
closing line lands at 8 s. Clearly readable at phone size; this is the version that matches his
description.

**Phone UI** (`3-phone-ui-393x852.jpg`; Playwright Chrome 393×852, throwaway PGlite :55617 +
`next dev` :3617, the stand-in seeded with NO understanding): editor → Director → "Reading your face
and moves…" (the REAL `take-understand` job, ~4 s) → message → pack copied (23k chars, events present)
+ frames image composed in the browser (232 KB) → a prose paste refused ("nothing was changed", fix-up
message) → answer v1 applied (8-line change list, new version) → follow-up pack carries the previous
instructions and ids → answer v2 applied → Undo (new version). "Ask AI · needs AI credit" disabled with
the reason (no key). No horizontal overflow. A UI race found and fixed in this run: after an apply, a
stale "pending message" re-opened the old paste box.

## Not verified

- **Real ChatGPT** answering this pack (format reliability, how well it reads the frames image) —
  both answers were hand-written from the pack as ChatGPT would; the parser is tested on messy output.
- **Real Claude** on the paid path (no credit; MockModelProvider only). Cost per message is an estimate.
- **Chris's real IMG 4186** (and real iPhone faces, lighting, profile turns) — FER+ on a real selfie
  close-up is untested; the stand-in uses two still photos.
- iOS Web Share with the image + text, iOS dictation into the box (standard textarea), real Safari.
- The cloud path: **the Vercel Sandbox snapshot must be rebuilt** (new `take-understand` kind, ingest
  step, `@chris/media` take-understanding; `scripts/sandbox` now downloads + checksums the FER+ model and
  sets `EXPRESSION_MODEL_PATH`). Until then, cloud ingest skips nothing visible — the panel shows
  "Reading your face…" and the `take-understand` job is refused/fails in the cloud; the chat still
  works without face data (the pack says so).
- Quality Gate integration of the provenance filter is covered by the pure helper's tests, not an
  end-to-end gate run.

## Alternatives considered

- **An LLM picking times from captions** — Chris explicitly doesn't want caption-led edits; his clip
  has no speech.
- **A bigger emotion model** (HSEmotion EfficientNet on AffectNet) — better accuracy but AffectNet's
  research-only license makes the weights unclear; FER+ (MIT) is permissive and small.
- **Server-side frames image** (ffmpeg drawtext per request) — needs a heavy job per message; the
  browser composes it from a sprite made once, for free, always matching the current edit.
- **Letting graphics overlap the bottom UI band / side rails** — the region model is precise enough;
  the conservative rectangle stays for AUTO placement.

## Reversibility

High. Two new tables (additive), one new heavy-job kind, a new editor panel/tab, one filter line in the
quality gate, a test-setup default. `DIRECTOR_UNDERSTANDING=off` stops the face read, `DIRECTOR_AI=off`
the paid path; removing the toolbar entry hides the feature. Every Director change is an ordinary
EditPlan version.

## Files

`packages/media/src/director/*` (understanding, schema, parse, catalog, placement, area, apply, pack),
`packages/media/src/take-understanding.ts`, `packages/domain/src/director.ts` + schema/migration,
`packages/agents/src/director-agent.ts`, `prompts/agents/DIRECTOR_CHAT.md`,
`apps/worker/src/take-understanding-job.ts` (+ heavy-job kinds/ingest, quality-gate filter),
`apps/web/lib/director/{server,frames-image}.ts`, `apps/web/app/content/[id]/edit/{DirectorPanel.tsx,
director-actions.ts}`, `apps/web/app/api/director/{ask,sprite}`, `scripts/sandbox/*`; tests
`packages/media/src/__tests__/{director,take-understanding}.test.ts`,
`apps/web/lib/director/server.test.ts`, `apps/worker/src/__tests__/heavy-jobs.test.ts`.
