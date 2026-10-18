# @chris/cinema — the mini-movie engine

Faceless, cinematic 30–60 s 9:16 films from a JSON **film DSL**: procedural 3D (three.js via
Remotion), cinematic camera/lighting/post, word-synced typography, local Kokoro narration (or
Chris's own recording), a procedural score and a −14 LUFS mix. **$0 per film** on Chris's Mac.

The studio crew (packages/agents/src/studio, apps/web/app/studio) drives this engine through
`FilmEnginePort` (apps/web/lib/studio/cinema-engine.ts) and the heavy-job kinds below.
Decisions: `docs/decisions-pending/studio-engine.md` (this work) and `docs/DECISIONS.md` "Mini-movies".

## Entry points

| Import | What | Runs in |
|---|---|---|
| `@chris/cinema/pure` | DSL schema + `validateFilm`/`formatIssues`, timing, evaluator, catalog, chunk planning, cost estimates, voices | anywhere (browser-safe) |
| `@chris/cinema` | everything above + the Node pipeline (render, storyboard, narration, audio, metrics) | Node with ffmpeg / Chrome |

## The DSL (`dsl: 1`, v1.1 vocabulary — additive, every v1 film still validates)

`film → scenes (a set) → shots {line, camera, actions, text, lighting, post, transitionOut, sfx, music}`
over a `cast` of actors. Anchors: seconds, `"start"|"end"`, `{word:"raised"}`, `{fraction:0.5}`.

- **Actors (41)**: v1 `COIN_STACK PEDESTAL BUILDING CAR CARD CARD_FAN BASELINE COIN_CHART NUMBER_WALL LIGHT_SHAFT`
  + v1.1 `FIGURE CROWD PLATFORM STAIRS LADDER BALANCE DOOR WALLS WHEEL SNOWBALL TREE BLOCKS BUCKET HOURGLASS CHAIN FORK_PATH MAGNIFIER DOCUMENT RECEIPT CALENDAR GAUGE METER DIVIDER HOUSE PHONE BANK_CARD BAR_CHART LINE_CHART PIE_CHART TEXT_3D ARROW`.
- **`parent`** on an actor: it rides on another actor's top surface (a `PLATFORM`'s level, a `PEDESTAL`) and moves/rises with it.
- **Actions (27)**: v1 `ENTER EXIT MOVE TURN SCALE SET FLOW PULSE GLOW` + `SHIFT{by}` `POSE{pose}` `WALK{to,pace?,run?}` `CLIMB{on,from?,to?}` `PATH{points,orient?}` and verbs
  `OPEN CLOSE FILL DRAIN GROW BREAK TIP FLIP UNROLL REVEAL RAISE LOWER SPIN {to?}` — each verb drives its kind's own param (`VERB_TARGETS` in `src/kinds.ts`; a verb on the wrong kind is a validation error naming the kinds it fits).
- **Poses**: `STAND WALK RUN SIT CLIMB CHEER SLUMP THINK REACH PUSH CARRY POINT BALANCE` (blend), plus `params.cycle: "RUN"|"WALK"|"CLIMB"` to run in place (treadmill, wheel).
- **Sets**: `INFINITY_STUDIO NUMBERS_VOID CITY_NIGHT ROOM HORIZON`.
- **Narration**: `{engine:"KOKORO"|"CHRIS", voice, speed?, gapSeconds?, sentencePause?}`; `say` may contain `[pause]` / `[pause 0.6]`.

## The visual catalog (for the Visual / Meaning bots)

- `VISUAL_CATALOG: CatalogEntry[]` — 92 entries: 41 actors, 27 actions, 5 sets, 19 **recipes**
  (whole literal metaphors: `recipe:raise-baseline`, `rat-race`, `leaky-bucket`, `break-free`,
  `two-futures`, `fine-print`, …). Each: `{id, type, title, depicts, goodFor[], avoid?, params[], verbs?, framing?, example}`.
- `catalogExampleFilm(entry)` → a one-shot film that validates and renders (test-enforced).
- `FILM_CATALOG` / `getFilmCatalog()` — the same in the crew port's format `{version, entries:[{id, kind, name, depicts, goodFor, usage}]}` (+ camera, lighting, transitions, text styles, looks, SFX).
- `searchCatalog(line)` — deterministic keyword ranking (no model).
- `matchLineToCatalog(line, {limit, types})` (Node) — semantic ranking with the crew's local MiniLM embedder (`@chris/media/embeddings`, $0): `[{entry, score, semantic, matchedPhrase, keyword}]`.

## Node functions

| Function | Does |
|---|---|
| `renderFilm({film, outDir, tier, chunks?, narration?, frameRange?})` | whole pipeline locally → `{output, frames, stagesMs, mix…}` |
| `prepareFilm({film, workDir, narration?})` | validate → narration (Kokoro+Whisper or given lines) → timing → score/SFX → mix.wav |
| `renderFilmFrames({film, clips, tier, frameRange, outPath})` | one frame range, encoded straight to delivery quality |
| `assembleFilm({chunkPaths, audioPath, outPath, expectedFrames, fps})` | stream-copy concat + mux; verifies the frame count and audio/picture sync (throws `FilmAssemblyError`) |
| `renderStoryboard({film, clips?, outDir, stillsPerShot?, points?, shots?, scale?})` | keyframe stills (one browser, chosen frames only) + per-shot timing/words + **metrics** + a captioned JPEG sheet |
| `framesFromVideo({film, clips, videoPath, outDir})` | measured review frames + sheet + poster from a rendered film |
| `measureStill(path, texts)` | `{meanLuma, emptyRatio, textContrast{UPPER,CENTER,LOWER}, textInsideSafeZone}` |
| `narrationFromRecording({film, recordingPath, outDir})` | Chris's one-take recording → per-shot clips + word times + report (missed/extra words) |
| `narrationFromShotRecordings({film, recordings, outDir})` | same, one take per shot |
| `estimateFilmRender({durationSeconds, tier, host, chunks})` | wall time + $ before starting (pure) |

## Heavy-job kinds (apps/worker/src/film-jobs.ts — same executor locally, on the Mac worker, in the Sandbox)

| Kind | Args | Result |
|---|---|---|
| `film-storyboard` | `{film | filmKey, filmId?, versionId?, shotIds?, points?, stillsPerShot?, tier?, scale?, narrate?, idempotencyKey?}` | `{stills:[{id, shotId, point, url, caption, metrics}], contactSheetUrl, shots[], timingMeasured, durationSeconds, ms}` |
| `film-render` | `{film | filmKey, tier, filmId?, versionId?, chunks?, chrisNarration?: {shotId|"*": key}, narrationKey?, contentItemId?, register?, idempotencyKey?}` or `{attachRenderId, contentItemId}` | `{renderId, videoUrl, posterUrl, durationSeconds, loudnessLufs, truePeakDbtp, frames: Still[], contactSheetUrl, contentItemId, state, frameCount, chunks, msByStage}` |
| `film-render-chunk` | `{renderId, chunkIndex}` (queued by film-render) | `{key, frames, ms}` |
| `film-voice-align` | `{film | filmKey, recordingKey, filmId?}` | `{linesKey, report}` |

Lease subject `film:<filmId>` when a studio film id is given. URLs are `/api/films/file?key=films/…`
(signed-in, `films/` keys only). Idempotent: a finished render is returned; a re-run reuses the
manifest, the mix and every finished chunk.

**Where jobs run ($0 first)** — `apps/web/lib/film-jobs.ts startFilmJob(kind, args, {where})`:
Chris's Mac render worker when online (`pnpm --filter @chris/worker film-worker`, or the login
item `scripts/mac/com.chris.film-worker.plist`); local dev = a one-shot worker on this Mac; the
cloud only on an explicit "Render in the cloud (~$X)" (`moveFilmJobToCloud`), where film-render
splits into parallel `film-render-chunk` sandboxes. Storyboards and attach may use the cloud's
included credit when the Mac is off.

**Registration**: `registerFilmVideo` — ContentItem (footage-first walk: the FACTUAL gate still
applies) → RAW_TAKE `raw/<item>/film-<renderId>.mp4` → MEDIA_INGESTED → TAKE_SELECTED → no-cuts
EditPlan → the normal render + technical QC → RENDERED. Studio films: Send to Videos creates the
MINI_MOVIE item, then `film-render {attachRenderId, contentItemId}` attaches the file (no re-render).

## Voices

`KOKORO_VOICES` / `NARRATION_VOICES` (9 curated of 28): af_heart (default), am_michael, af_bella,
bf_emma, bm_george, af_sarah, af_kore, am_fenrir, am_puck — samples in `assets/voice-samples/`.
`KOKORO_ENGLISH_VOICES` lists all 28 with the model card's grades.

## Scripts

```
pnpm --filter @chris/cinema exec tsx scripts/make-film.ts --tier FINAL [--film f.json] [--chunks 3]
pnpm --filter @chris/cinema exec tsx scripts/storyboard.ts <outDir> [--film f.json] [--stills 2]
pnpm --filter @chris/cinema exec tsx scripts/catalog-sheet.ts <outDir>        # every catalog example
pnpm --filter @chris/cinema exec tsx scripts/match-line.ts "You raised your baseline."
pnpm --filter @chris/cinema exec tsx scripts/voice-audition.ts <outDir> [--voices a,b] [--dtype q8]
pnpm --filter @chris/cinema exec tsx scripts/voice-samples.ts
pnpm --filter @chris/cinema exec tsx scripts/contact-sheet.ts <film.mp4> <outDir>
```
