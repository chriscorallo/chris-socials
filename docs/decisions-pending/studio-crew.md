# Mini-movie Studio — the crew (2026-10-18)

Status: **built and verified with mocks + a fake engine; the engine's heavy jobs still need wiring.**
To be folded into `/docs/DECISIONS.md` by the integrator.

Chris asked for an on-demand studio: type (or pick) an idea → a crew of specialist bots, each
with one goal, makes an elite 30–60 s 9:16 animated short in the cinema DSL → storyboard →
review/revise → render → Videos. His example of what the crew must catch: in the proof film,
"you raised your baseline" played over visuals that didn't read as a floor/baseline rising.

**Mid-build course change from Chris: the studio must cost $0.** No Anthropic credit, no paid
API. The crew, typed artifacts, authority hierarchy and orchestrated pipeline stayed; *how*
each crew member runs changed:

- everything that can be code **is code** (automatic, free);
- the creative/vision judgment runs as **two copy-paste round trips with Chris's own ChatGPT**
  (like `/plan/scripts`): the app builds one "pack" (crew prompts from the versioned registry +
  brand + film + the exact JSON shape, plus the storyboard image), Chris sends it, pastes the
  JSON answer back, code validates/repairs and the orchestrator continues;
- an **optional local model** (Ollama on Chris's Mac) can answer the same packs automatically —
  feature flag, off by default;
- **no billed provider can reach the studio**: the pipeline only accepts a `FreeModelProvider`
  (`free: true`) — passing the Anthropic provider is a type error and is refused at runtime
  (`StudioPaidProviderError`, tested).

---

## 1. The crew — roles, goals, how each runs

| Crew member | Goal (one) | Runs as | Output (typed, persisted as a FilmArtifact) |
|---|---|---|---|
| **Film Director** (`FILM_DIRECTOR`) | Owns the brief and the call: good enough / revise X / stop | ChatGPT (WRITE: brief; REVIEW: decision) + **code guard** (stricter-only) | `FilmBrief`, `DirectorDecision`, guarded `FinalDecision` |
| **Hook** (`FILM_HOOK`) | Earn the first 1–3 s: ≥ 5 options (line + opening picture), scored as estimates | ChatGPT (WRITE) | `HookSet` |
| **Screenwriter** (`FILM_SCREENWRITER`) | Narration in Chris's voice, one metaphor, every number checkable | ChatGPT (WRITE) | `FilmScript` (lines l1…, numbers, **calculations**, claims, caveats) |
| **Cinematographer** (`FILM_CINEMATOGRAPHER`) | Each line's picture literally shows it, catalog vocabulary only | ChatGPT (WRITE / FIX) | `ShotPlan` (film DSL + shot notes) |
| **Verification** | Every number on screen/in a line recomputed; untraced numbers block; facts confirmed by Chris | **Code** — HARD GATE | `VerificationReport` (math checks, number traces, claims to confirm) |
| **Meaning-Match** (`FILM_MEANING_MATCH`) | The picture shows what the words say, line by line | **Code first pass** (concept rules + local sentence embeddings) → ChatGPT vision second pass (REVIEW) | `MeaningMatchReport` (MATCH / WEAK / MISMATCH + evidence + catalog replacement) |
| **Continuity** | Objects, counts, screen direction, lighting consistent shot to shot | **Code** (DSL state diff) | `ContinuityIssue[]` |
| **Quality** (`FILM_QUALITY`) | Safe zones, legibility, framing, timing, loudness — the premium bar on a phone | **Code** (DSL + measured stills/render) → ChatGPT vision (REVIEW; optional FINAL) | `QualityIssue[]`, `QualityReport` |
| **Retention** (`FILM_RETENTION`) | Where a cold viewer would swipe away — estimates only | ChatGPT (REVIEW) | `RetentionReport` |
| **Cohesion** (`FILM_COHESION`) | One world, one metaphor, story logic, an ending that lands | ChatGPT (REVIEW) | `CohesionReport` |
| **Fact check** (reuses `CLAIMS_GATE`'s rules + output shape) | Independent factual review of every factual line | ChatGPT (REVIEW) — never billed | `FactCheck` (= `ClaimsGateResult` fields); BLOCK feeds the Verification gate |
| **Analysis** (`FILM_ANALYSIS`, the `VIEWER_PANEL` idea condensed) | A first-time viewer's read of the finished film | ChatGPT (optional FINAL) | `analysis` (verdict tier, hook estimate, drop-offs, fixes) |
| **Engine** | Validate the DSL, draw the storyboard, render | `FilmEnginePort` (our own compute) | validation, `StoryboardResult`, `RenderResult` |

Not added: a separate Sound/Music bot — the engine's procedural score + `autoSfx` + per-shot
music intensity already cover it, and the Cinematographer authors SFX/music cues in the DSL; a bot
with no distinct deterministic check wouldn't pull its weight.

## 2. Pipeline (deterministic orchestrator — `packages/agents/src/studio/pipeline.ts`)

```
 Chris: idea · length · look · narrator ──► startFilm
        │
  WRITE ──► [ChatGPT round trip a]  Director brief · Hook ×5 · Screenwriter · Cinematographer (DSL)
        │       paste → tolerant parse → zod → 4 artifacts + FilmVersion v1
  VALIDATE ── engine validator + script↔shot coverage ──✗──► FIX round trip (validator's own messages), ≤ maxRepairs
  VERIFY ──── math recomputed + every number traced (HARD GATE) ──✗──► FIX round trip, ≤ maxRepairs → BLOCKED
  STORYBOARD ─ engine job (idempotency key) ─ poll ─ failure → retry ≤ maxStoryboards → BLOCKED (technical)
  AUTO_REVIEW  Meaning-Match first pass · Continuity · Quality basics   (code, $0)
  REVIEW ──► [ChatGPT round trip b, storyboard image attached]
        │       Meaning-Match (vision) · Cohesion · Retention · Quality (vision) · Fact check · Director
  DECIDE ──── guardDirectorDecision (stricter only):
        │       hard-gate BLOCK → REVISE (rounds left) | BLOCKED
        │       APPROVE over a rule MISMATCH / BLOCKING quality → REVISE (rounds left) | known issue for Chris
        │       REVISE + revisedFilm → new FilmVersion → iteration+1 → VALIDATE …   (≤ maxIterations = 3)
        │       REVISE without a film (or code-forced) → FIX round trip
  STORYBOARD_REVIEW (Chris, authority 1): approve · redo a shot (+note → FIX) · edit a line (new version)
        │       · confirm facts (required before render)
  RENDER ──── engine job ─ failure → Chris can retry ≤ maxRenders
  FINAL_QC ── measured render checks (loudness −14 ±1 LUFS, true peak ≤ −1 dBTP, safe zones, contrast) = TECHNICAL gate
  READY ───── Send to Videos (ContentItem, idempotent) · optional FINAL round trip (quality + analysis)
```

- **Execution:** the phone's crew room POSTs `/api/studio/films/[id]` while the automatic crew or
  the engine works; each call runs `advanceFilm` (up to 12 steps, one worker per film via a
  lease on the Film row), returning when it waits for ChatGPT, Chris or the engine. No long
  function; nothing runs when nobody is looking except engine jobs.
- **Idempotent + resumable:** every step's output is an artifact with an idempotency key
  (`<film>:v<version>:<step>`); engine requests carry `<film>:<version>:storyboard:<attempt>`;
  the same paste twice is a no-op; a crash mid-step leaves the film FAILED with the step recorded
  and **Resume** re-runs it — the test proves the retried storyboard reuses the same engine job and
  no artifact key is duplicated.
- **Append-only:** `FilmVersion` and `FilmArtifact` have no update/delete path. Audited:
  `FILM_CREATED`, `FILM_VERSION_CREATED`, `FILM_STATUS_CHANGED`, `FILM_CHRIS_ACTION`,
  `FILM_GATE_BLOCK`.

## 3. Authority & hard gates

Chris > hard gates > Brand > strategy > Director > specialists (spec §5).

- Gates are `{status:"PASS"} | {status:"BLOCK", reasons}`; `aggregateFilmGates` is an OR.
  `FinalDecision` `APPROVE` can only be constructed with `PassedGates` (both literally PASS) — a
  creative score has no way to approve over a block (types + tests).
- **VERIFICATION (hard gate):** every calculation recomputed (ADD, SUBTRACT, MULTIPLY, DIVIDE,
  PERCENT_OF, MONTHLY/ANNUAL, FUTURE_VALUE_MONTHLY, PERCENT_CHANGE; exact claims to $0.50/0.1 %,
  "about" ≤ 3 %); every digit number in a line, text beat, label or footnote must trace to a
  declared number (an untraced "$9,999" blocks); a DERIVED number without a calculation blocks;
  a fact check BLOCK blocks; **every FACT claim must be confirmed by Chris** before render
  (checkboxes on the storyboard screen — authority 1; opinions/hypotheticals pass, hypotheticals
  carry a footnote). Account names (401(k), 403b, 529) aren't numbers.
- **TECHNICAL (hard gate):** engine validation, storyboard/render job failure, measured BLOCKING
  issues on the render (text under platform UI, clipping).
- The Director can overrule a first-pass Meaning-Match MISMATCH only **with a written reason** in
  `overruled` (recorded); otherwise code forces a revision while rounds remain.

## 4. Meaning-Match — how Chris's example is caught for $0

1. **Concept rules** (strong signal): a line that names something the engine can literally show
   must show it. `BASELINE_RISES` ("raised your baseline / the floor went up"): a BASELINE actor
   whose `level` goes UP during the line, on screen and **in frame** (engine evaluator +
   projection), with the things that raised it in frame — **and lifted with it** (a MOVE up on
   the apartment/car). Others: GONE (something exits/drains/is struck through), GROWTH (a chart or
   stack grows), MONEY_TAKEN (coins flow out), RENT/CAR/SUBSCRIPTIONS (that object on screen).
2. **Local sentence embeddings** (soft signal): `Xenova/all-MiniLM-L6-v2` (Apache-2.0, ONNX q8
   ≈ 23 MB, transformers.js — the runtime/cache the repo's Whisper already uses) compares each
   line with a plain-words description of what the shot shows (on-screen text that just repeats
   the line is excluded — text isn't picture) and suggests the closest catalog alternatives.
   Advisory only (WEAK), never forcing. Falls back to a hashed lexical embedder if the model can't
   load (labelled).
3. ChatGPT's vision pass then confirms/corrects with the storyboard image.

**Verified on the REAL proof film** (`apps/web/lib/studio/proof-film.test.ts`): the engine's own
evaluator says the baseline, apartment and car are all in frame in shot "baseline" — so it's not
framing — but the plane rises to 1.8 m **through** the building and car while they stay on the
ground; the first pass flags exactly that shot as MISMATCH ("it reads as a glow passing by, not as
the floor under your life going up") with the fix "lift them with it (MOVE)", and no other shot.
MiniLM calibration on the studio demo film (`docs/evidence/2026-10-18-studio-crew/minilm-first-pass.txt`):
literal shots 0.28–0.37 cosine; the flawed baseline shot 0.13 vs 0.37 once fixed; abstract lines
("You didn't just spend the raise.") ≈ 0.05 → thresholds match ≥ 0.28, weak ≥ 0.12. CPU time
≈ 0.3 s per film after the one-time model download.

## 5. Routing (spec §16) — all $0

| Class | Who | How |
|---|---|---|
| HIGH judgment (Director, Meaning-Match vision, Analysis) | ChatGPT round trip (Chris's subscription) or local vision model | `prompts/agents/FILM_*.md` `model_class: HIGH` = the capability the pack needs |
| MEDIUM (Hook, Screenwriter, Cinematographer, Retention, Cohesion, Quality vision) | same packs | `model_class: MEDIUM` |
| LOCAL_EMBEDDING | Meaning-Match first pass | MiniLM on CPU |
| DETERMINISTIC | Verification, Continuity, Quality basics, coverage, Director guard, orchestrator | code |

**Optional local AI:** `OllamaModelProvider` (OpenAI-compatible `/v1/chat/completions`,
`response_format: json_schema`, images as data URLs). Defaults `qwen2.5:7b-instruct` (text) and
`qwen2.5vl:7b` (vision), overridable (`STUDIO_LOCAL_TEXT_MODEL`/`_VISION_MODEL`). On only when
the feature flag `studio.local_ai` is enabled **and** `STUDIO_LOCAL_AI_URL` is set; the new-film
form then offers "Let my Mac's local AI answer". Free but needs the Mac on and ~10 GB of disk
(two ~5 GB models); a phone on the Vercel deployment can't reach the Mac's localhost without a
tunnel Chris sets up. Any failure falls back to the ChatGPT step with a plain message.

## 6. Per-film limits (spec §16 governor)

`DEFAULT_FILM_LIMITS`: 3 revision rounds · 10 round trips · 3 repair rounds · 8 storyboards ·
3 renders · 12 local-AI calls. Hitting one → STOPPED with the reason ("used all 10 ChatGPT round
trips") — Resume after raising it. Paid spend: impossible by construction (no paid provider);
the daily cap is untouched.

## 7. Cost per film — the math

| Item | Typical | Cost |
|---|---|---|
| Model calls | 0 | **$0** (ChatGPT subscription Chris already pays; local AI optional) |
| Round trips | WRITE + REVIEW + 1 revision REVIEW ≈ 3 (best case 2; + 1 FIX if the DSL needs repair) | $0, ~1–2 min of Chris per round (copy, paste) |
| Pack sizes | WRITE ≈ 27 k chars, REVIEW ≈ 44 k chars + one image | $0 |
| Meaning-Match embeddings | 1 pass per version, ~0.3 s CPU | $0 |
| Storyboards | 2 per film (one per round), stills only | Mac: ~1 min each, $0 · Sandbox: seconds-to-minutes, ≈ $0.01–0.03 |
| Final render | 1 | Mac GPU: ~3.5 min, $0 · Sandbox (chunked, per the mini-movies decision): ≈ $1 |

So **$0 on Chris's Mac; ≈ $1 per film if he renders in the cloud** (compute, not AI).

## 8. Free path (ChatGPT) — the UX

Step 1 of 2 "Write the film" and Step 2 of 2 "Review the storyboard": **Send to ChatGPT** (Web
Share with the image + text on iPhone — straight into the ChatGPT app), or **Copy message** +
**Save the storyboard image**, "Open ChatGPT ↗", then paste the answer and **Continue**. The parser
tolerates code fences, chatter, smart quotes, trailing commas; a misfit answer changes nothing and
offers **Copy the fix-up message** (lists the exact fields). The answer shape is printed compactly
(TypeScript-like with `Evidence`/`Estimate` named once — ~4.5 k chars instead of ~12 k of JSON
Schema).

## 9. Data (migration `20261018070000_film_studio`, additive)

`Film` (status/step/iteration, counters, limits, pending pack, engine job, confirmed facts,
Chris's notes, lease, `contentItemId` once sent to Videos) · `FilmVersion` (DSL as received,
script, brief, origin CREW_WRITE / CREW_REVISION / FIX / CHRIS_EDIT, parent) · `FilmArtifact`
(kind, agent, via DETERMINISTIC / LOCAL_EMBEDDING / CHATGPT / LOCAL_AI / ENGINE / CHRIS, prompt
version, iteration, unique idempotency key, plain-English summary, payload, gate). No change to any
existing table (the ContentItem link is a plain column, no back-relation).

## 10. Port — `FilmEnginePort` (`packages/agents/src/studio/engine-port.ts`)

`capabilities · validateFilm · formatIssues · getCatalog · listVoices · describeShots ·
requestStoryboard · requestRender · getJob · loadImage?` — `FakeFilmEngine` (tests, dev sketch
storyboards) and `CinemaFilmEngine` (`apps/web/lib/studio/cinema-engine.ts`).

**Wired to the real engine now:** `validateFilm`/`formatIssues` (@chris/cinema/pure),
`describeShots` (real evaluator + pinhole projection → `inFrame`), voices (7 Kokoro voices with the
audition clips as ▶ samples via `/api/studio/voices/[id]`, + "My voice").

**For the integrator to wire (TODOs in code):**
1. `film-storyboard` / `film-render` heavy-job kinds → `heavyFilmDispatch` (apps/web/lib/studio/
   heavy-dispatch.ts) already calls `runHeavyJob` once `isHeavyJobKind` knows them. Args/results
   expected: `HEAVY_ARGS` in cinema-engine.ts (stills with `metrics`, a **JPEG** contact sheet with
   the line under each still — ChatGPT can't read SVG; render `{videoUrl, posterUrl,
   durationSeconds, loudnessLufs, truePeakDbtp, frames, contactSheetUrl, contentItemId?,
   renderId?}`); lease subject `film:<filmId>`.
2. `FILM_CATALOG` / `getFilmCatalog()` export from `@chris/cinema/pure` (`{version, entries:
   CatalogEntry[]}`) — picked up automatically; the fallback catalog covers DSL v1 meanwhile.
3. A `KOKORO_VOICES` list (new voices) and Chris-recorded narration: `requestRender` already
   passes `chrisNarration: {shotId: mediaKey}`; the recording UI is not built here.
4. `StillMetrics` (contrast per text band, safe-zone overlap, empty-frame ratio, text height) from
   the storyboard/render job — the Quality rules are written and tested; without metrics they say
   "stills not measured".
5. Render registration as a ContentItem render: "Send to Videos" creates/links the ContentItem
   (format `MINI_MOVIE`, idempotent); the engine attaches the file/Render row.

Until 1 is wired, on the real engine the crew reviews the shot list without stills (the review
pack says the image is missing) and rendering stops at the storyboard with "the storyboard/render
workers for mini-movies aren't connected yet".

## 11. Verified / not verified

**Tests (all mock / fake engine, $0):** `packages/agents/src/__tests__/studio-*.test.ts`
(deterministic math/number tracing/coverage/continuity/quality; Meaning-Match incl. the
baseline fixture, floor-alone, out-of-frame, text-isn't-picture; orchestrator happy path with the
revise loop, coerced revision, wrong-math BLOCK, iteration cap, validation repair, bad paste +
duplicate paste, crash → resume without duplicate job/artifacts, storyboard/render failure + retry,
round-trip limit, Chris edit/redo, paid provider refused, LOCAL mode; local-AI request shape;
Prisma store on the real throwaway DB: append-only, idempotent artifact, lease, Send to Videos,
audit); `apps/web/lib/studio/*.test.ts` (adapter with the real validator/evaluator, the real proof
film flagged, view-model states); eval `fixtures/evals/film-meaning-match.json` (3 cases, graded in
mock mode; the harness test proves a review that waves the flaw through fails). The demo film is
checked against the REAL cinema validator so the fixture can't drift from the engine.

**UI (Playwright, Chrome 393×852, throwaway PGlite :55493 + `next dev` :3493 with
`STUDIO_FAKE_ENGINE=1 STUDIO_DEMO_CREW=1`):** new film → Step 1 pack (clipboard read back: 27 k
chars) → bad paste rejected with field list + fix-up message → demo answer → automatic crew →
Step 2 pack with storyboard sketch; shot 7 "You raised your baseline." marked "doesn't show it" with
the fix → round-1 review REVISE → round 2 APPROVE → facts checkbox → Approve & render → ready →
Send to Videos (appears in Videos) → studio list; More shows "Mini-movie studio". No horizontal
overflow on any screen. Screenshots: `docs/evidence/2026-10-18-studio-crew/`.

**Not verified:** a real ChatGPT answer to these packs (format reliability, how well it reads the
contact sheet); the real storyboard/render jobs (not on this branch); a real Ollama model; Web
Share with an image into the ChatGPT iOS app; real still metrics.

## Alternatives considered

- Anthropic calls per crew member (the original brief): ~10–15 calls/film ≈ $1–3 — rejected by
  Chris ($0 requirement).
- One ChatGPT round trip per crew member: ~10 copy-pastes per film — too much friction (Final
  Test); merged into two packs, each section still its own typed artifact.
- Embeddings only for Meaning-Match: the proof film's baseline shot really does contain a rising
  baseline plane, so its picture description is about baselines rising — similarity can't tell
  "rises through the things" from "lifts them". Only a concept rule about what raising YOUR
  baseline literally looks like catches it; embeddings stay a soft signal.
- Custom GPT with Actions (no copy-paste): possible later (see the ChatGPT connector decision);
  needs an authenticated endpoint per pack.

## Reversibility

High. Additive tables, new routes (`/studio`, `/api/studio/*`), one More link, new prompt files,
a new `@chris/agents/studio` entry point and `@chris/media/embeddings`. Removing the link hides it;
nothing else reads Film rows.
