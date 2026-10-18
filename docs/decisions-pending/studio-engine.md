# Mini-movie studio — the engine (2026-10-18)

Status: **built, tested, wired to the studio crew; snapshot rebuild + first production use pending
(Chris).** To be folded into `/docs/DECISIONS.md` by the integrator. Interface:
`packages/cinema/README.md`. Evidence: `docs/evidence/2026-10-18-studio-engine/`.

Chris approved an on-demand studio: he types an idea → the crew (packages/agents/src/studio,
built alongside) writes/storyboards/reviews a film in the cinema DSL → it renders → it lands in
Videos. This is the engine and infrastructure the crew drives. Mid-build course change from
Chris: **the studio must cost $0** — local rendering on his Mac is first-class; the Vercel Sandbox
only on an explicit tap that shows the cost; no paid APIs anywhere.

---

## 1. Visual vocabulary — "visuals must literally depict what's said"

Chris's note on the proof film: on "you raised your baseline" the picture didn't look like a
floor rising. The cause was vocabulary: v1 had 10 props and no way to put things *on* a floor.

**Decision: an additive DSL v1.1 (still `dsl: 1`; every v1 film validates and renders the same).**

- **31 new procedural actors** (`src/remotion/world/{props,figure,sets}.tsx`): a faceless
  artist's-mannequin **FIGURE** (matte ceramic, gold ball joints — reads as "you" without being a
  character) with 13 blended poses and walk/run/climb cycles; **CROWD** (many vs one); **PLATFORM**
  (a solid floor whose top is `level`, glowing lip, front label, dashed "old floor" ghost);
  STAIRS, LADDER, BALANCE, DOOR (light spills out), WALLS (closing in), WHEEL (hamster wheel,
  rotation integrated from speed), SNOWBALL (rolls by distance), TREE (branching growth, coin
  leaves), BLOCKS (doubling), BUCKET (fills, leaks coins), HOURGLASS, CHAIN (snaps), FORK_PATH (two
  futures), MAGNIFIER + DOCUMENT (fine print), RECEIPT (unrolls), CALENDAR (pages flip), GAUGE,
  METER, DIVIDER (before/after), HOUSE, PHONE, BANK_CARD (original, unbranded), BAR/LINE/PIE
  charts as sculptures, TEXT_3D (layered-plane extrusion), ARROW. 3 new sets: CITY_NIGHT
  (procedural skyline), ROOM, HORIZON.
- **`parent`**: an actor rides on another's top surface (position relative to it, follows its
  rise). This is what makes "the floor rises UNDER your life" one line of DSL.
- **18 new actions**: SHIFT (relative move), POSE, WALK (pace-driven, faces its direction, cadence
  from distance), CLIMB (STAIRS step-by-step / LADDER hand over hand), PATH (Catmull-Rom, eased
  arc length), and 13 **semantic verbs** (OPEN CLOSE FILL DRAIN GROW BREAK TIP FLIP UNROLL REVEAL
  RAISE LOWER SPIN) mapped per kind in `VERB_TARGETS` — the author says what happens, the engine
  knows which param that is. A verb on the wrong kind is a validation error naming the kinds it
  fits (built for the repair loop).
- All deterministic: compiled into the evaluator's existing segment model (walks/paths/climbs are
  sampled into pos/rot segments), pure functions of (film, frame) — tested.
- **Assets/licenses:** everything is original procedural geometry and canvas textures generated
  by our code (manifest entry `procedural-actors`). No CC0 rigged character was added: the
  procedural mannequin covers poses/walks/sits/climbs without a third-party license or a download;
  a rigged Quaternius-style character remains the documented option if acting is ever needed.

**Semantic catalog** (`src/catalog.ts`): 92 entries — 41 actors, 27 actions, 5 sets and **19
recipes** (whole literal metaphors: raise-baseline, money-evaporates, spending-pulls-money,
climb-out, rat-race, walls-closing, leaky-bucket, snowball, compound-tree, doubling, break-free,
two-futures, fine-print, it-adds-up, time-passes, weigh-it, door-opens, many-vs-one,
before-after). Each has rich `depicts` + `goodFor` text, params, verbs, camera-friendly default
framing and a runnable example (`catalogExampleFilm`). Test-enforced: every kind/action/set has an
entry, every example validates and evaluates deterministically; every example was rendered
(`catalog/sheet-*.jpg`). Exported twice: `VISUAL_CATALOG` (engine shape) and `FILM_CATALOG` /
`getFilmCatalog()` (the crew port's shape, 138 entries incl. camera/lighting/transitions/text/
looks/SFX — the crew picks it up automatically).

**Meaning-Match helper ($0):** `matchLineToCatalog(line)` embeds with the crew's
`@chris/media/embeddings` LocalSentenceEmbedder (all-MiniLM-L6-v2, Apache-2.0, ONNX q8 ≈ 23 MB —
one model for the whole studio, not two), best of description + each good-for phrase, 15 %
keyword blend. Measured: "You raised your baseline." → recipe:raise-baseline 1.00 / PLATFORM
0.97; "Taxes take thirty-five percent." → money-evaporates 0.83; "running in place" → rat-race
0.82; "Break free from debt" → break-free 0.78; "Every month, the same bills" → time-passes 0.74
(~3 ms/line after a one-time ~1 s load).

## 2. "The Raise", re-cut

- **The twist** now shows exactly the words: you (FIGURE), your apartment, your car and the
  pedestal stand on a PLATFORM (`parent: "floor"`); on "raised" it RAISEs to 1.9 m and lifts them
  all; a dashed line stays on the old floor; the slab's face reads YOUR BASELINE; the figure
  steadies itself (BALANCE pose). "But here's the part nobody tells you" introduces you, thinking,
  beside the empty pedestal.
- **Subscriptions** cards at 1.9× (prices legible on a phone) and they shrink away on "Gone." —
  the literal disappearance.
- **Growth columns** no longer crop: the chart sculpture is shown at 62 % scale and every payoff
  camera is re-framed to its real height.
- Narration now pauses between sentences (§4).
- **Crew check:** the crew's free Meaning-Match first pass flagged the old film's baseline shot
  (plane rising THROUGH the apartment and car). The rule now understands PLATFORM/RAISE and
  `parent` riders; on the re-cut it flags nothing, and the original flaw (re-created by removing
  the riders) is still caught (`apps/web/lib/studio/proof-film.test.ts`).
- FINAL re-render on the Mac GPU: 39.7 s, 1190 frames, −14.0 LUFS / −1.5 dBTP, **113 s total**
  (narration 10 s, score+mix 6 s, picture 96 s = 2.4 s per film-second, assemble 1 s).
  Frames: `the-raise-v2/sheet-0{1,2,3}.jpg`. Output: `packages/cinema/.cache/films/the-raise/the-raise-final.mp4` (git-ignored).
- Honest critique: the twist reads clearly now, but the figure is small in that wide shot (≈ 1/7
  of the frame height) and the car is half-cropped at the right edge; the lifted world's top is
  dark — a stronger key light on the platform top would sell "a stage your life stands on" more.

## 3. Storyboards (cheap)

`renderStoryboard` renders only the chosen frames (Remotion `renderFrames({frames})` — one browser,
one page load), keyframe = the moment the shot's last action/text has landed (or 1–3 stills per
shot), at half size by default; each still is **measured** (`measureStill`: mean light, empty-frame
ratio, WCAG contrast per text band, safe-zone) and tiled into a **JPEG contact sheet with the
narration line under each still** (ChatGPT's vision review reads it). Per shot: timing + the words
it covers (measured from narration when `narrate:true`, else estimated).

| Host | 15-shot storyboard of The Raise (540×960 PREVIEW) |
|---|---|
| M1 Pro GPU (ANGLE/Metal) | **5.5 s** |
| M1 Pro CPU (SwiftShader, `REMOTION_GL=swangle`, 2 tabs) — the Sandbox proxy | **70 s** incl. bundling |
| Vercel Sandbox 8 vCPU (estimate ×1.25, bundle prebuilt) | ≈ 60–90 s → **≈ $0.03** of included credit |

So storyboards may run in the cloud when the Mac is off (within the included credit); on the Mac
they're seconds.

## 4. Narration

- **Voices:** all 28 English Kokoro voices auditioned on the same two sentences (q8) — Whisper
  intelligibility (all identical: 100 % of words; the 0.15 "WER" is just "$10,000" vs "ten
  thousand dollar"), pitch spread, voiced share, pace, high-frequency hiss
  (`voices/audition-all-28-q8.json`) — combined with the model card's grades. **Curated 9:**
  af_heart (default), am_michael, af_bella, bf_emma, bm_george, af_sarah, af_kore, am_fenrir,
  am_puck — samples `packages/cinema/assets/voice-samples/*.m4a` (48 kbps, −18 LUFS, 6–7.5 s).
  Excluded: D-grade voices, af_nicole (whispery ASMR: 22 % voiced frames, half pace), bm_fable
  (3–10× the hiss of the others). I can't listen; these are measured proxies — **Chris should
  play the 9 samples** (the crew's picker serves them).
- **Pauses:** a line is voiced sentence by sentence with `narration.sentencePause` (default
  0.32 s) between sentences; `[pause]` / `[pause 0.6]` in `say` adds a beat. Speed stays
  `narration.speed` (0.7–1.3). Kokoro has no other prosody controls.
- **q8 vs fp32:** not compared by ear. The fp32 model (326 MB) downloaded at ~30–60 KB/s on this
  connection (22 MB in 13 min); I stopped it rather than tie up the link for hours and removed the
  partial file. **Kept q8** (92 MB, ~1.4–1.6× real time on CPU, 100 % intelligible, the voice
  Chris already liked); `KOKORO_DTYPE=fp32` is supported for a later listening test (the
  Sandbox downloads fast, +234 MB in the snapshot if chosen).
- **Chris's own voice** (engine `CHRIS`): `narrationFromRecording` (one take of the whole script)
  or `narrationFromShotRecordings` (one per line) — Whisper word timings aligned to the script
  with Needleman–Wunsch (digits by value), ad-libs/fillers kept in the audio and reported, dropped
  words interpolated and reported, clips cut with a little air, < 60 % heard = "is this the right
  take?" (refused, nothing synthesized in his place). The picture is timed to his real words.
  UI: the studio film page's **Your narration** panel (record on the phone with MediaRecorder or
  upload a voice memo) → `POST /api/films/studio?action=narration` → a `film-voice-align` job
  pre-aligns and reports; renders pick it up automatically (or via the port's `chrisNarration`).

## 5. Rendering — $0 first, chunked cloud on request

**Pipeline split** (`src/render.ts`): `prepareFilm` (narration + timing + score/SFX + mix, once)
→ `renderFilmFrames` (one frame range, encoded straight to delivery quality — no mezzanine
re-encode) → `assembleFilm` (stream-copy concat + one mux; **verifies the frame count and that
audio and picture end together**, else `FilmAssemblyError`). `planChunks` = contiguous,
gap-free, near-equal ranges (property-tested), never shorter than 45 frames.

**Job kinds** (`apps/worker/src/film-jobs.ts`, one executor for local / Mac / Sandbox):
`film-render`, `film-render-chunk`, `film-storyboard`, `film-voice-align` (args/results in the
README; crew-compatible). Idempotent by a stable `renderId`; storage layout `films/<renderId>/…`
(manifest, film, clips, mix, chunks, result) so a crashed or timed-out render resumes with every
finished part. In the cloud the parent job enqueues N−1 `film-render-chunk` jobs (QUEUED;
started by the dispatcher's queue kick on every poll of the parent, and drained by finishing
workers), renders chunk 0 itself, **claims any still-queued parts of its own film** (no idle VM),
re-queues a failed part twice then renders it itself, and stops 4 min before its sandbox deadline
with "run it again to continue".

**Where it runs** (`apps/web/lib/film-jobs.ts startFilmJob`, used by the crew's dispatch):
1. **Chris's Mac render worker** when online (`pnpm --filter @chris/worker film-worker`, or the
   login item `scripts/mac/com.chris.film-worker.plist`; secrets in a git-ignored
   `.env.film-worker`). Presence = a `render-worker:<id>` JobRun heartbeat every 30 s (no schema
   change); film jobs are queued with `target: "mac"` and only the Mac worker claims them.
2. **Local dev** (`next dev` on the Mac): queued for the Mac + a one-shot worker child process (the
   engine never loads inside the Next.js server — same rule as the motion engine).
3. **Cloud only on an explicit tap**: a render waiting for the Mac shows "Render in the cloud
   instead (~N min, about $X of Vercel's included credit)" → `moveFilmJobToCloud` converts the
   same JobRun in place. Storyboards and "attach to Videos" may use the cloud automatically when
   the Mac is off (cents).

**Benchmarks / estimates (40 s FINAL film):**

| Host | Picture | Whole film | $ |
|---|---|---|---|
| M1 Pro GPU (measured: The Raise FINAL) | 2.4 s/film-s → 96 s | **≈ 2 min** | $0 |
| M1 Pro CPU swangle, 2 tabs (measured today: 60 FINAL frames, direct delivery encode, incl. bundle + browser start) | 42 s/film-s → ≈ 28 min | — | $0 |
| Built cloud runner, CPU swangle, 540×960 PREVIEW, 2 chunks (measured, this Mac) | 13.8 s/film-s incl. 2 browser starts | 63 s for a 4 s clip | — |
| Vercel Sandbox 8 vCPU, 1 worker (est. ×1.25 of the M1 CPU = 53 s/film-s) | ≈ 35 min | ≈ 37 min (close to the 45-min limit) | ≈ $0.84 |
| Sandbox, 4 parallel workers (default `HEAVY_JOB_MAX_SANDBOXES`) | ≈ 9 min each | **≈ 10 min** | **≈ $0.87** (upper bound: all 8 vCPU busy) |
| Sandbox, 8 workers (`FILM_RENDER_MAX_CHUNKS=8`) | ≈ 4.5 min each | **≈ 6 min** | ≈ $0.91 |
| PREVIEW tier, 4 workers | | ≈ 7 min | ≈ $0.54 |

(`estimateFilmRender` reproduces these; the Sandbox column is a scaled estimate ±30 % — the
cloud path was exercised with the built runner on this Mac, not in a sandbox, by instruction.)

**Registration** (`registerFilmVideo`): the finished film becomes a video through the normal
path, no state shortcuts — ContentItem (footage-first walk; the contract keeps STANDARD/MEDIUM so
the FACTUAL gate still applies) → RAW_TAKE `raw/<item>/film-<renderId>.mp4` → analyzed →
take selected → a no-cuts EditPlan (captions off — they're in the picture; no normalization —
it's mastered at −14 LUFS) → the normal render + technical QC → **RENDERED**. READY still needs
the quality gate like every video. Studio films: render first, then the crew's **Send to Videos**
creates the MINI_MOVIE item and the engine attaches the render (`film-render {attachRenderId,
contentItemId}` — never re-renders). Engine-only renders register themselves (format MINI_MOVIE).

## 6. Snapshot changes (not run against Vercel, by instruction)

`scripts/sandbox/build-runner.ts`: `kokoro-js` added to the npm externals (brings `phonemizer`
— eSpeak NG WASM — and the 28 English voice files); the **cinema Remotion project pre-bundled**
to `cinema-bundle/` (three.js, @react-three/fiber, postprocessing inside the bundle) with
`CINEMA_BUNDLE_DIR` in `run-job.sh`; `cinema-bundle/public` excluded from the upload and re-created
in the VM (`sandbox-setup.ts`, plus empty source-map stubs). `warmup` now also downloads the
Kokoro q8 model + tokenizer and the MiniLM embedder into `/vercel/sandbox/cache/transformers`.
Offline modes `film-render` / `film-storyboard`; `verify-offline.ts` renders a narrated 4-s
raise-baseline clip in 2 chunks in the VM. Verified locally: the built runner (`node
job-runner.mjs film-render --offline`, swangle, 2 chunks) produced a frame-exact, −14.1 LUFS clip.

**Operator:** rebuild the snapshot (`create-snapshot.ts --base <current>`), run
`verify-offline.ts`, set the new id, and add the film kinds to `RENDER_SANDBOX_KINDS`
(`film-render,film-render-chunk,film-storyboard,film-voice-align`) if cloud renders should be
offered. Snapshot grows ≈ +130 MB (Kokoro q8 92 MB, MiniLM 23 MB, cinema bundle ~5 MB, kokoro-js).

## 7. Tests

`packages/cinema/src/__tests__`: `vocabulary` (backward compat with the proof film and a v1 film;
RAISE lifts riders; WALK pace/facing/gait; CLIMB monotonic to the top tread; verbs → params; SPIN
integrated; validation messages; the proof film's twist lifts you/car/building/pedestal),
`catalog` (completeness, rich text, every example validates + evaluates deterministically,
keyword search), `chunks` (coverage property for many lengths × worker counts, estimates, **real
ffmpeg concat: frame-level identity of all 97 frames across 3 chunks, audio within one frame, a
missing chunk caught**), `narration` (sentence pauses + `[pause]`, the 9 voices with samples,
Chris-voice alignment with an ad-lib + a dropped word, wrong take refused, clips cut from an
uploaded m4a). `apps/worker/src/__tests__/film-jobs.test.ts` (throwaway DB, fake picture engine,
real assembly + real registration render: film → ContentItem RENDERED via the normal
transitions, idempotent re-run; chunked sandbox-mode render with queued parts claimed back;
a second worker rendering a part; crew-shaped storyboard/render + Send-to-Videos attach;
Chris voice align → render; invalid film; Mac targeting + heartbeat).
`apps/web/lib/studio/proof-film.test.ts` updated (fix accepted, flaw still caught).
`apps/web/lib/studio/studio-e2e.real.test.ts` (opt-in `STUDIO_E2E_REAL=1`): the whole studio with
the real engine — see §8.

## 8. End-to-end run (real engine)

`STUDIO_E2E_REAL=1 pnpm exec vitest run apps/web/lib/studio/studio-e2e.real.test.ts` — **passed,
148 s wall** (`e2e/studio-e2e-report.json`, `e2e/storyboard-sheet.jpg`, `e2e/render-sheet.jpg`):
the crew's pipeline on the throwaway test DB (PrismaFilmStore), the crew's demo answers standing
in for ChatGPT, `CinemaFilmEngine` → `heavyFilmDispatch` → `startFilmJob` (inline mode → queued for
"the Mac" + one-shot `film-worker` child processes, real Chrome/WebGL on the GPU, Kokoro af_heart,
Whisper, ffmpeg):
WRITE pack (contains the v1.1 vocabulary) → storyboard 1 (10 measured stills + captioned JPEG
sheet; the REVIEW pack carried it) → crew REVISE → storyboard 2 → APPROVE → Chris confirms the
facts → **real FINAL render: 32.1 s, 964 frames, −14.0 LUFS, −1.5 dBTP** (prepare/narration 34 s,
picture 85 s, assemble 7 s, review frames 2.4 s) → READY → Send to Videos (crew) → the engine's
attach job → MINI_MOVIE ContentItem **RENDERED** (take → no-cuts edit plan → normal render + QC).
Observations from the run, for the crew: the demo film's "flip" keyframe is a nearly empty frame
(camera on an un-grown chart) — exactly what `metrics.emptyRatio` exposes to the Quality bot; the
demo's baseline shot still uses the v1 BASELINE plane + MOVEs (valid; the v1.1 PLATFORM recipe is
the stronger picture).

## Reversibility

High. All DSL additions are optional fields; the job kinds are new; the domain additions
(`enqueueHeavyJob`, `getHeavyJobs`, render-worker heartbeat, `target`/`subjects` claim filters)
are additive with unchanged defaults; no migration. Turning the Mac worker off just queues film
jobs (they expire after 2 h like any queued job).

## Files

`packages/cinema/**` (schema, kinds, evaluate, validate, catalog, film-catalog, catalog-match,
figure-poses, chunks, render, storyboard, sheets, text-bands, narration/{voices,speech-text,
recording,narrate,kokoro}, remotion/world/{props,figure,sets,actors,World}, films/the-raise,
scripts/*, assets/voice-samples, README), `apps/worker/src/{film-jobs,film-worker,heavy-job-kinds,
heavy-jobs,job-runner,offline}.ts`, `packages/domain/src/job-run.ts`, `apps/web/lib/{film-jobs,
heavy-jobs,heavy-job-text}.ts`, `apps/web/lib/studio/{cinema-engine,heavy-dispatch}.ts`,
`apps/web/app/api/films/{file,studio}/route.ts`, `apps/web/app/studio/[id]/{page,FilmEnginePanel}.tsx`,
`apps/web/app/studio/actions.ts` (Send to Videos attaches), `apps/web/app/api/studio/voices/[id]`,
`packages/agents/src/studio/{film-types,meaning-match,deterministic,packs}.ts` (v1.1 awareness),
`scripts/sandbox/{build-runner,sandbox-setup,verify-offline}.ts`, `scripts/mac/com.chris.film-worker.plist`,
`.gitignore`, `pnpm-lock.yaml`.
