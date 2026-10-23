# Premium editor — implementation handoff (written 2026-10-21)

For the session that implements `/docs/PREMIUM_EDITOR_PLAN.md`. Everything below was verified
against the code on 2026-10-21; file paths and names are real. Follow the CLAUDE.md bootstrap
first, then this file, then the plan's "Recommendation — the executable version" table. Build
in that order; Week 0 is not optional ("don't ship without the harness green").

## 1. Working rules Chris has set (do not relearn these the hard way)

- **Tell him the time cost before a ship cycle.** A worker/media/motion change ships with the
  scratchpad `ship.sh <base-snapshot>` (push → `scripts/sandbox/create-snapshot.ts --base` →
  PATCH `RENDER_SANDBOX_SNAPSHOT_ID` → wait for the git deploy → forceNew redeploy) and takes
  10–12 minutes; a web-only change is a push (~3 minutes). He was annoyed when a second
  10–12-minute cycle appeared unannounced. Run node scripts with
  `NODE_OPTIONS=--dns-result-order=ipv4first` (his Mac's IPv6 path to Vercel times out).
- **Never print secrets; never materialize production credentials locally;** never weaken
  Vercel deployment protection. The pull script below logs in with the app's own login, the
  same way the existing scratchpad playwright scripts did.
- **No paste paths.** Anything that asks him to copy text into ChatGPT is rejected.
- **"Make it free" is scoped** to the feature being discussed; ask before cutting model calls
  elsewhere (memory: cost-scope-feedback).
- **Judge by watching**: frames and the kept-line order, not the summary line. He said the AI
  edit "must be at least as good as the free one" and the bots must act like a creator who built
  a huge brand from videos alone.
- **His laptop must stay awake** for long background runs; say so when one starts.
- Tests: DB-backed suites (agents, worker, web) need `DATABASE_URL` exported from `.env` and
  `pnpm db:migrate:deploy` first; run the worker suite with `--no-file-parallelism` (dev PGlite
  `connection_limit=1`). Known pre-existing failures: chatgpt-connector date order, film-jobs
  chunk count (DB pollution), three web test files that fail to parse (vite JSX config).
- Unpushed local commit as of this writing: `902e4b7` (worker test import dedup). Push it with
  the first Week 0 commit.

## 2. State of the editor today (verified)

| Piece | Where | What it does today |
|---|---|---|
| The Editor agent | `packages/agents/src/editor-agent.ts`, prompt `prompts/agents/EDITOR.md` 1.0.0 | one HIGH call: numbered lines → `EditorPlan` (storyline ids/roles/keepWords/headline/viewerNeeds, cut list, title, pacing, rationale, coldViewer). One shot; no critique pass; headlines not required per beat (first live cut headlined 3 of 7 beats, coldViewer came back as junk) |
| Plan execution | `packages/media/src/full-edit/editor-plan.ts` (`sanitizeEditorPlan`, `planFromEditor`, `editorBeats`) and `full-edit/index.ts` (editor branch: skips hook scoring and length loop; `holdFraming` for LONG_SHOTS_ZOOMS; beat headlines as `TimelineText` ids `fe-beat-i`; `report.editor.beats` with output timing) | deterministic, word-exact |
| Cut placement | `packages/media/src/style-cut.ts` `cutOneTake` | keeps 0.12 s mid-sentence / 0.18 s at a sentence end, pads 0.09 tail / 0.05 lead, snaps edges outward to a 30 fps grid even at 60 fps → 0.14–0.25 s of air at every splice; pauses < 0.18/0.24 s never cut |
| Silences | `packages/media/src/speech-activity.ts` | 20 ms RMS frames, adaptive threshold, no hysteresis, min silence 0.1 s; `analyzeTakeAudio(file)` returns `{ silences, envelope: { frameS: 0.1, db[] } }` |
| Render audio at a splice | `packages/media/src/timeline-render.ts` | per-clip audio padded/trimmed to whole frames, 8 ms fade, hard concat; voice chain `dynaudnorm` → `loudnorm` |
| Worker entry | `apps/worker/src/style-cut-job.ts` | `computeFullEdit(db, storage, id, loaded, choices, measure, provider)` builds `FullEditInput` from `load()` (module-private), `takeAudioFor()` (cached silences+envelope on the latest stored full edit, else measured from the blob), `briefForFullEdit()`, `getReferenceStyleProfile(db, { group: "MAIN" })`, `editorPlannerFor()`; `maybeAutoStyleCut` runs on upload in mode EDITOR (falls back to FULL, then CUTS) |
| Stored result | `plan.fullEdit` on the `EditPlan` row (`packages/domain/src/style-cut-plan.ts` `StoredFullEdit`: report, choices incl. `editorPlan`, silences, envelope); automatic rows carry `revisionReason` = `FULL_EDIT_AUTO_REASON` ("Full edit (automatic, no AI)") or `STYLE_CUT_AUTO_REASON`; Chris's saves carry `revisionReason` starting `"Finishing edit by Chris"` (`packages/domain/src/edit-plan.ts` `saveFinishingEdit`) | hand edits are therefore identifiable |
| Screen | hook title + beat headlines (`placeTitle`), graphics (`visuals.ts` → VISUAL_STRATEGIST → MOTION_DESIGNER), captions (`timeline-captions.ts`, fixed y=0.72, ≤3-word chunks), zooms (heuristics) | four passes that avoid each other; `EDITOR_ORCHESTRATION.md` describes one composed screen, no code builds one; the worker does not pass `report.editor.beats` to the Visual Strategist yet (`apps/worker/src/motion-design-job.ts`) |
| Reviews | `apps/worker/src/quality-gate-job.ts` (FACTUAL fail-closed, TECHNICAL ffprobe + 6 frames), `viewer-review-job.ts` (VIEWER_PANEL, 80 frames, ~$0.40, advisory, unread) | nothing gates on watching |
| References | `apps/worker/src/reference-analysis-job.ts`, `packages/domain/src/style-metrics.ts`, `reference-videos.ts` `getReferenceStyleProfile` | ~50 numbers/video → medians → 5 reach the edit, clamped; no OCR |
| Autonomy | `packages/domain/src/autonomy.ts` | levels earned by API successes, `autonomy.shadow_only` ON |

## 3. Week 0 — build this first

### 3.1 Golden-set harness

Purpose: replay the whole edit offline, on five of his takes plus his two hand edits, on every
code change, and diff what matters — the kept-line order, the splices, the screen plan — so an
iteration no longer costs a 10-minute ship and his credit.

**Fixtures** live in `fixtures/golden/<slug>.json` (committed; they hold his transcript words,
silences, envelope, subject track, brief, reference profile, the stored Editor plan, the machine
timeline prod produced, and the hand-edited timeline when one exists). Media is NOT in a
fixture; `fixtures/golden/media/` is gitignored for optional local renders later.

**Which videos:** the two hand edits — "the car payment" and "why $100k isn't spending money"
(DECISIONS 2026-10-19) — plus three recent takes that have an Editor plan (pick from `/content`;
the ids are the `/content/<id>` URLs). Slugs: `car-payment`, `100k-not-spending`, then by title.

**Files to add**

1. `packages/media/src/golden/index.ts` (export it from `packages/media/src/index.ts`; keep it
   out of `timeline-browser.ts`):

   ```ts
   export const GoldenFixtureSchema = z.object({
     version: z.literal(1),
     slug: z.string(), contentItemId: z.string(), title: z.string().nullable(), exportedAt: z.string(),
     take: z.object({
       mediaAssetId: z.string(), durationSeconds: z.number(),
       width: z.number().nullable(), height: z.number().nullable(),
       words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })),
       subjectTrack: z.unknown().nullable(),            // parse with parseSubjectTrack (subject-track-core.ts)
     }),
     audio: z.object({
       silences: z.array(z.object({ start: z.number(), end: z.number() })).nullable(),
       envelope: z.object({ frameS: z.number(), db: z.array(z.number()) }).nullable(),
     }),
     base: EditTimelineSchema,                           // the worker's plainTimeline(l.takes, l.current)
     brief: z.object({ hook: z.string().nullable(), keep: z.array(z.string()), onScreenText: z.string().nullable() }).nullable(),
     profile: z.unknown().nullable(),                    // getReferenceStyleProfile(db, { group: "MAIN" }) as returned
     editorPlan: EditorPlanSchema.nullable(),            // latest stored full edit's choices.editorPlan
     machine: z.object({ editPlanId: z.string(), createdAt: z.string(), reason: z.string().nullable(), summary: z.string(), timeline: EditTimelineSchema }).nullable(),
     handEdit: z.object({ editPlanId: z.string(), createdAt: z.string(), note: z.string().nullable(), timeline: EditTimelineSchema }).nullable(),
   });
   ```

   `replayGolden(fixture, { embedder = LEXICAL_EMBEDDER })` runs `buildFullEdit` twice with the
   same input (`base`, `mediaAssetId`, `words`, `durationSeconds`, `subjectTrack`, `sourceSize`,
   `silences`, `envelope`, `target: styleCutTargetFromProfile(profile)`,
   `story: storyTargetFromProfile(profile)`, `brief`, `editorPlanner: null`): once with
   `choices: {}` (the free cut) and, when `editorPlan` is present, once with
   `choices: { useEditor: true, editorPlan }` (the Editor's cut; never a model call). Each result
   is summarised as a `GoldenCut`:

   ```ts
   interface GoldenCut {
     ok: boolean; error?: string; outputDurationS: number;
     kept: Array<{ sentenceId: number; text: string; beat: string }>;   // report.kept
     removed: Array<{ sentenceId: number; kind: string }>;              // report.removed
     title: string | null;                                               // report.hook.titles[titleIndex]
     headlines: Array<{ text: string; start: number; end: number }>;    // timeline.texts whose id starts "fe-beat-"
     graphics: Array<{ presetId: string; start: number }>;              // report.visuals
     zooms: number; checks: Array<{ id: string; status: string }>;
     splices: SpliceMetric[]; spliceSummary: SpliceSummary;
   }
   ```

   `spliceMetrics(timeline, words, silences)` — one entry per boundary between consecutive
   clips of the same media asset:
   - `outS` = previous clip `sourceEnd`; `inS` = next clip `sourceStart`; `removedS = inS − outS`.
   - `tailAirS` = `outS` − end of the last word whose end ≤ `outS + 0.02` (negative = clipped).
   - `leadAirS` = start of the first word whose start ≥ `inS − 0.02`, minus `inS`.
   - `clippedTailMs` = `(word.end − outS)·1000` for a word with `start < outS < end`, else 0;
     `clippedLeadMs` likewise for `inS`.
   - `airS = tailAirS + leadAirS` (what the viewer hears as the pause at the splice).
   - `inSilence` = both edges fall inside a measured silence (±20 ms) when silences exist.
   - `SpliceSummary`: `n`, `airMedianS`, `airP90S`, `airMaxS`, `clippedCount` (either side
     > 40 ms), `clippedMaxMs`, `airOver026Count`.

   `compareToHandEdit(machineTimeline, handTimeline, words)` → for every hand cut (`outS`,
   `inS` per hand clip boundary) the nearest machine `outS` / `inS` distance: `medianDeltaMs`,
   `p90DeltaMs`, `within30ms / total`; plus source-interval coverage `machineKeptOfHand` and
   `handKeptOfMachine` (0–1). The plan's bar: median ≤ 30 ms once the splice engine exists.

   `diffGolden(expected: GoldenReplay, actual: GoldenReplay): string[]` — exact on kept order
   (sentence ids), removed ids + kinds, title, headline texts, graphic preset ids, zoom count,
   check statuses, splice count; tolerant on `outputDurationS` (±0.05 s), every splice
   `outS`/`inS` (±5 ms), `airMedianS` (±5 ms). An empty array is green.

2. `apps/worker/src/style-cut-job.ts`: `export async function exportGoldenFixture(db, storage,
   contentItemId): Promise<GoldenFixture>` next to `computeFullEdit`, using the module-private
   `load`, `takeAudioFor(…, measure = true)`, `briefForFullEdit`, `plainTimeline`, plus
   `getReferenceStyleProfile`, the latest plan with `readStoredFullEdit` (its
   `choices.editorPlan`, its `timeline`, `revisionReason`, `summary`) and the latest plan whose
   `revisionReason` starts with `"Finishing edit by Chris"` (its `plan.timeline`). Reject
   multi-take items with the same message `computeFullEdit` uses.

3. `apps/web/app/api/golden/route.ts`: `POST { contentItemId }` → the fixture JSON. Check
   `auth()` from `apps/web/auth.ts` and return 401 without a session (the existing
   `apps/web/app/api/editor/*/route.ts` files are the pattern); `export const maxDuration = 120`
   (a first export may decode the take's audio).

4. `scripts/golden/pull.mjs` — `node scripts/golden/pull.mjs <base-url> <contentItemId>=<slug> …`.
   Logs in with the app's own Auth.js v5 credentials flow and a tiny cookie jar:
   `GET /api/auth/csrf` → `{ csrfToken }` + cookies; `POST /api/auth/callback/credentials`
   (form fields `csrfToken`, `email`, `password`; `redirect: "manual"`; keep every `Set-Cookie`,
   the session cookie is `authjs.session-token` or `__Secure-authjs.session-token`); then
   `POST /api/golden` with the `Cookie` header. Email/password come from `SEED_USER_EMAIL` /
   `SEED_USER_PASSWORD` in the environment (load `.env` with `dotenv`; the scratchpad scripts
   used exactly these against prod). Never print them. Writes `fixtures/golden/<slug>.json`.

5. `scripts/golden/replay.ts` (run with `tsx`; import media by relative path
   `../../packages/media/src/…` like `scripts/sandbox/*.ts` do) — replays every fixture, prints
   per fixture: kept order (id + first words), title, headlines, splice summary, hand-edit
   comparison when present, then the diff against `fixtures/golden/expected/<slug>.json`.
   `--update` rewrites the expected files; a non-empty diff without `--update` exits 1.
   Add root scripts `"golden:pull"` and `"golden:replay"`.

6. `packages/media/src/__tests__/golden.test.ts` — for every `fixtures/golden/*.json`
   (resolve the repo root from `import.meta.url`; `it.skip` when there are none): replay, assert
   `ok`, and assert `diffGolden(expected, actual)` is empty when an expected file exists. This
   is what "harness green" means in the plan.

**Pass test for 3.1:** five fixtures pulled; `pnpm golden:replay --update` then
`pnpm golden:replay` prints no diff; the vitest file passes; the hand-edit comparison prints for
the two hand-edited fixtures (today's numbers will be far from 30 ms — that is the Week 1
baseline, write them into the DECISIONS entry).

**Frames** are deliberately not in Week 0: a render needs the media and the full render path;
add `fixtures/golden/media/<slug>.mp4` (gitignored) + a `scripts/golden/frames.ts` that renders
through `renderTimeline` once the splice engine lands (Week 1), so before/after contact sheets
come from the same harness.

### 3.2 Filming card

One screen, no settings. `apps/web/app/components/FilmingCard.tsx`, a `<details>` using the
`Panel` styling from `apps/web/app/components/ui`; open by default at the top of `/film`
(`apps/web/app/film/page.tsx`, above the READY_TO_FILM batches) and closed by default on
`/upload` (`apps/web/app/upload/page.tsx`, under the upload panel). Copy, in this order:

1. **Leave the top third empty.** Headlines live above your head; you sit in the lower two
   thirds, chest up. Shoot wide; punch-ins are the editor's.
2. **Lock exposure and focus** (tap and hold on the iPhone camera); keep the light steady.
3. **Mic on, same distance the whole take.** No music in the room.
4. **Say the hook twice**, then a full second of silence.
5. **Pause a beat after the payoff and after the last line.** Skip "let me know" — the editor
   ends on your question.
6. **Stumbled? Stop, breathe, restart the sentence.** Restarts are removed automatically.

### 3.3 Latency meter (upload → ready, budget 8 minutes)

`packages/domain/src/latency.ts`:

```ts
export const READY_BUDGET_MINUTES = 8;
export async function uploadToReadyLatency(prisma, contentItemId): Promise<{
  uploadedAt: Date; transcribedAt: Date | null; readyAt: Date | null;
  minutes: number | null; overBudget: boolean;
} | null>;
```

`uploadedAt` = earliest RAW_TAKE `MediaAsset.createdAt` (`removedAt: null`); `transcribedAt` =
that asset's `transcribedAt`; `readyAt` = earliest `EditPlan.createdAt` after `uploadedAt`
whose `revisionReason` is `FULL_EDIT_AUTO_REASON` or `STYLE_CUT_AUTO_REASON`. Show it on the
content page (`apps/web/app/content/[id]/(detail)/page.tsx`, under `FlowProgress`): "Ready 6 min
after upload" in the muted style, gold with "over the 8-minute budget" when it is. In
`maybeAutoStyleCut` (worker), after `recordAutoFullEdit`/`recordAutoStyleCut` succeed, log
`[latency] upload→ready N.N min (budget 8)` so Vercel logs carry it. Add a unit test on the
domain function with seeded rows (worker/domain DB test conventions above).

### 3.4 Week 0 definition of done

- Harness: fixtures committed, expected snapshots committed, `golden.test.ts` green, the replay
  script's output pasted into a DECISIONS entry as the baseline (splice air median/p90, clipped
  count, hand-edit median delta, kept order for each fixture).
- Filming card on `/film` and `/upload` (web-only ship: a push).
- Latency line on the content page + worker log line (needs a worker ship: say "10–12 minutes"
  before starting it).
- Push `902e4b7` with it.

## 3.5 Status (2026-10-21, night)

- Week 0: done. Harness, filming card, latency meter shipped; six fixtures pulled and their
  expected replays committed (`fixtures/golden`); baseline in DECISIONS ("Golden set pulled").
- Week 1: done and shipped. Splice engine, sample-exact render, caption times on the voice,
  free splice audit (MAJOR), SpliceModel fitted from 57 of his hand cuts. Worker snapshot
  `snap_zTd4zsWbRV8aDvtUj5uyPozidI76` (+ one more ship for the fitted model).
- Weeks 2–4: built and SHIPPED 2026-10-22 (main `348087c` + `18fa514`; worker snapshot
  `snap_UH00hLNWOECDqqJNDuWzk6wY8dEJ`, the base for the next ship). Editor v2 (`EDITOR` 2.0.0 + `EDITOR_CRITIQUE` 1.0.0: write → checklist + critique →
  revise once; headline per beat, emphasis words, `review` stored on the plan), the Screen
  Orchestrator (`packages/media/src/screen/`: anchors, five lanes, one new thing per beat, quiet
  adaptive captions, in-hold-out zooms, cover frame, screen audit), timeline schema additions
  (`TimelineText.anchor/fadeIn/fadeOut`, `TimelineZoom.easeOutSeconds`, `captions.chunking`,
  caption preset `QUIET`; all defaulted — old rows parse unchanged), preview parity (text fades,
  ease-out, caption windows), the screen audit in the gate (MAJOR, `SCREEN_AUDIT`), Editor beats
  passed to the Visual Strategist, the title never on the forehead. Golden baseline re-written;
  DECISIONS "Editor v2 + Screen Orchestrator". Open: story joins should prefer a voice gap;
  editor preview captions still on raw Whisper times; multi-part takes get no analysis; promote
  the splice/screen audits to BLOCKING once a few real videos show zero findings; the two Editor
  fixtures show his framing leaves no clean top zone (headlines sit over the hair) — the filming
  card's first line is the real fix; re-pull fixtures after the v2 Editor has run on a video.
- Weeks 4–6: built and shipped 2026-10-22 in the same batch; the reference library still needs
  the Measure button pressed once for the screen signals to exist. Reference metrics v3 (`screen` text events
  via tesseract.js OCR, `zooms` from the head track, `pads` from the reference's own cuts,
  `rhythm` by thirds; `REFERENCE_METRICS_VERSION` 3 so the page offers to re-measure), the
  `StyleModel` (bands; his hand edits as "mine" ×2; "don't copy" exclusions; `getStyleModel`),
  consumers: the Editor's digest (`styleDigest`), orchestrator presets + caption habit
  (`screenStyleFromStyleModel`, `captionDefaultsFromStyleModel`), the paragraph on `/reference`
  and per creator. Not done: graphic/B-roll density (no region detection yet), gate thresholds
  from the bands, a LOW vision fallback for frames OCR can't read, posted-unchanged videos as
  "mine" (needs the Weeks 6–8 rating label). The snapshot must carry
  `packages/media/assets/models/tesseract/eng.traineddata.gz` (restoreRunner downloads it); the
  references must be re-measured once shipped for the screen signals to exist.
- Weeks 6–8: built 2026-10-22 and SHIPPED 2026-10-23 (main `84b777e`; migration
  `20261022230000_watch_back` applied by the git deploy; worker snapshot
  `snap_QSlkutyf0S5ueYcjLLzk1pg2dSiw`, the base for the next ship). The watch-back gate: free audits (splice,
  screen, the new story audit) → `WATCH_BACK` (HIGH vision, contrastive reference frames,
  typed fixes) + `HOOK_TEST` (MEDIUM) → PASS / FIX / HOLD recorded as `WatchVerdict`; the one
  fix loop (`applyWatchFixes` + re-cut / re-render / re-gate / re-watch) behind
  `watch_back.fix_loop`; HOLD stops the publish preflight behind `watch_back.gating`; the watch
  runs after every gate PASS behind `watch_back.auto`; Chris's one-tap rating (`WatchRating`)
  on the content page; autonomy as agreement per series (`getSeriesAgreement`: ≥ 90 % over
  ten, no override, demoted on a pulled post); PUBLISHING outcomes count only with a 👍. All
  three flags default off (shadow). Also in: the HOLD queue on the home page, "I pulled this
  post" (PULLED), the StyleModel headline band as a gate threshold, auto-post requires the series
  to have earned it. Still open: promoting the splice/screen audits to BLOCKING once real renders
  are clean; the external platform apps / reviews.
- Routine: after any cutting change run `pnpm golden:replay` (diff must be empty or explained),
  `--update` to re-baseline, and note it in DECISIONS. Re-pull a fixture after the AI edit runs
  on that video so it gains an Editor plan.

## 4. After Week 0 — contracts to hold to

Sizes and pass tests are in the plan's recommendation table; these are the implementation
constraints the analysis settled:

- **Week 1, splice engine** (`packages/media/src/splice/`, replacing cut placement in
  `style-cut.ts`; `q()` becomes video-only): 1 ms envelope at 16 kHz + a 2–8 kHz band so
  fricative tails count as voice; ON at floor + 10 dB, OFF at floor + 4 dB with a 40 ms hang;
  Whisper word edges refined to the nearest ON/OFF within ±150 ms (captions use the refined
  times); cut-out = offset + tail pad, cut-in = onset − lead pad, 15 ms before a plosive burst;
  nearest zero crossing; no outward frame snapping, no 0.1 s minimum silence; pauses shortened
  to the learned keep, never padded up. `SpliceModel` pads start as a prior from the two hand
  edits re-measured on the new envelope and update only from accepted edits and reference cuts,
  never wider than the hand-edit band. Render: one sample-accurate audio stream with 3–5 ms
  equal-power crossfades and room-tone fill (`timeline-render.ts`), picture on the nearest
  frame, drift ≤ half a frame. Judged by the harness (hand-edit median ≤ 30 ms, zero clipped
  words) and on headphones.
- **Gate G1 free audits** at the same time (`apps/worker/src/quality-gate-job.ts`): splice gap
  > 60 ms, clipped word > 40 ms, click within 10 ms, level step ≥ 4 dB, face-core overlap, two
  leads in a beat, hook text absent by 1.5 s → FIX with the stage named (SPLICE / SCREEN /
  EDITOR). Five planted defects must be caught.
- **Weeks 2–4, Editor v2 + Screen Orchestrator** (`packages/media/src/screen/`): Editor becomes
  write → critique (MEDIUM, checklist) → revise once; schema minimums (a headline per beat,
  `coldViewer` ≥ 2 sentences, emphasis words); five lanes on one clock with fixed anchors, one
  *new* thing per beat (stacking allowed when references stack), adaptive captions (one word
  for short emotional lines, phrase chunks for lines with amounts; numbers always in the
  headline), zoom in-hold-out, a chosen cover frame; `TimelineText` gains an anchor and
  enter/exit; preview = render. Known immediate Editor fixes to fold in: pass
  `report.editor.beats` to the Visual Strategist in `motion-design-job.ts`; headline never on
  the forehead (`placeTitle` face-core fallback).
- **Weeks 4–6, reference learning**: tesseract in the sandbox snapshot, OCR text events at
  4 fps, caption/zoom/graphic/cut-rhythm measurement, splice pads from reference cuts →
  `StyleModel` bands (p25–p75) → a 10-line Editor digest, orchestrator presets, gate thresholds;
  his hand edits and posted-unchanged videos are the highest-weight references.
- **Weeks 6–8, watch-back gate**: contrastive judging against reference frames at matching
  timestamps, an isolated hook test (first frame + 2 s of audio), ≤ 5 typed fixes, one loop,
  HOLD queue with Fix / Post anyway; autonomy label = a one-tap rating at post time; promotion
  at ≥ 90 % agreement over 10 per series, demotion on any pulled post; `shadow_only` and the
  ceiling stay human-only; FACTUAL stays fail-closed.
- **Don't:** chase cut counts or pacing numbers; add graphics for their own sake; build paste
  paths; let the gate become a score; ship without the harness green.
- **Rhythm:** ship weekly; a Friday review of three golden videos side by side; the measure is
  his verdict plus the gate's shadow agreement.

## 3.6 Status (2026-10-23, after Chris watched the first live Editor cut)

- The orchestrator's screen defaults are REVERTED to his old screen (DECISIONS "The
  orchestrator's screen defaults reverted"): hook title ≤ 2.4 s, his captions untouched, no
  beat headlines. `ScreenStyle.headlines: "ALL"` / `captionLook: "QUIET"` are opt-in. Live:
  main `3901e94`, worker snapshot `snap_WzC7WIjqQYjMPjMd0b5FyyMjnlYF` (the next `--base`).
- Before any screen change ships again: a frame contact sheet of a real take, looked at. The
  harness needs `fixtures/golden/media/` + a frames script (Week 0 deferred it) — build that
  first.
- Also live but not yet used by the editor panel: the `ai-edit` heavy job (brief → Editor cut →
  visuals as one background job) and posting via `after()` with a job banner. The panel still
  drives the AI edit from the browser; switching it to the job is the next small change.

## 3.7 Status (2026-10-23, later)

- Chris watched the first live Editor cut on "Money opinions…" and rated it far below the free
  cut (DECISIONS "The AI edit goes back to the proven flow"). Live now (main `a06e9a0`, worker
  snapshot `snap_3eAkP1ULY3TvLjo5TxrmJG2MMlyU` — the next `--base`): AI edit = free Full edit →
  AI hook → read-through → visuals; uploads default to the free Full edit; the Editor is opt-in
  (`auto_edit.editor`). The Editor's lines get the word-level cleanup; unsafe joins are marked
  and flagged; free graphics are back on the Editor path.
- Written, tested, NOT applied: transcript hygiene for duplicated / stretched Whisper tokens
  (`dedupeOverlappingWords`) — it changes the free cut's kept lines on every fixture; needs a
  watched before/after first. Build the golden frames script (media + `renderTimeline` contact
  sheets) before any further cutting or screen change.
- Open from the watch: why the Motion Designer rejected all three visuals on that video (read
  the MOTION_DESIGN_RUN audit row in prod); the Editor's own line choices; 24 cuts/min vs his
  hand edits.
