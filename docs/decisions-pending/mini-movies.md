# Mini-movies — a third content lane, engine foundations + proof film (2026-10-17)

Status: **pending Chris's quality call.** Nothing here touches publishing, the database, the
worker, or Vercel. One hidden labs page. Fold into `/docs/DECISIONS.md` once Chris decides whether
to build the full studio.

## What it is

Faceless, cinematic animated shorts (30–60 s, 9:16): a narrated story told with procedural 3D,
cinematic camera and lighting, kinetic typography synced to the words, and a generated score.
Made entirely by our own code — no paid AI video, $0 per film beyond our own compute.

Proof film: **"The Raise"** (38.7 s, 1080×1920, 30 fps, −14 LUFS).
- Full quality: `packages/cinema/.cache/films/the-raise/the-raise-final.mp4` (60 MB, git-ignored;
  re-render with the command below). 540p preview in the repo:
  `docs/evidence/2026-10-17-mini-movies/the-raise-540p-preview.mp4`.
- Watch it in the app (local dev): `/labs/mini-movies` (hidden, not in the nav).

```
TRANSCRIPTION_CACHE_DIR=<repo>/.cache/transformers pnpm --filter @chris/cinema exec tsx scripts/make-film.ts --tier FINAL
pnpm --filter @chris/cinema exec tsx scripts/storyboard.ts <outDir> --tier PREVIEW      # stills per shot, ~1 min
pnpm --filter @chris/cinema exec tsx scripts/contact-sheet.ts <film.mp4> <outDir>          # director review sheets
```

### The story (money psychology, Chris's voice)

| Beat | Line | Picture |
|---|---|---|
| Hook (0–2.9 s) | "Your ten-thousand-dollar raise is already gone." | Coins still raining onto a lit pedestal while **$10,000** assembles — then it's struck through on "gone". Image = desire, line = loss. |
| Setup | "Here's where it went. / Taxes take thirty-five percent." | Whip pan; 35 coins evaporate into gold dust, counter drains $10,000 → $6,500; footnote shows the math. |
| Escalation | "The nicer apartment? Three hundred more a month. / The car upgrade. One-eighty. / And sixty bucks of 'small' subscriptions." | A miniature building rises and *pulls* 36 coins in; a car glides in and takes 22; subscription cards orbit and nibble the last 7. |
| Beat | "Gone." | Silence, top-down on the empty pedestal, $0, a single shaft of light. |
| Twist | "But here's the part nobody tells you. You didn't just spend the raise. You raised your baseline." | The things stay; a glowing plane — YOUR BASELINE — rises to the height the raise used to be. |
| Payoff | "So flip it. Invest half of every raise before you ever see it. Two seventy a month, at seven percent, for twenty years, is about a hundred and forty thousand dollars. More than half of it, you never had to earn." | A 20-column sculpture of coins (one per year) grows; camera trucks along it and cranes up the last column: **$140,650**; the growth part of each column glows: **Growth $75,850**. |
| Button | "Same raise. Different life." | Wide pull-back over the whole chart; titles. |

Numbers (in `packages/cinema/src/films/the-raise.ts`): 22 % federal + 7.65 % FICA + ~5 % state ≈
34.65 % marginal → "35 %" (footnoted on screen); $10,000 × 0.65 = $6,500/yr ≈ $541/mo; half ≈
$270/mo; 100 coins = $10,000/yr so rent +$300/mo = 36 coins, car +$180/mo = 22, subs +$60/mo = 7.
FV of $270/mo at 7 %/12 for 240 months = $140,650.20; contributions $64,800 → growth $75,850
(53.9 %). On-screen footnote: "Hypothetical 7% average annual return, compounded monthly. Not a
guarantee." **Not yet through the Claims Gate** — a real mini-movie must go through the same
factual gate as every script.

## Architecture (`packages/cinema`, `@chris/cinema`)

Separate from `@chris/motion` (imports only `findLocalHeadlessShell` and its SFX kit files).

1. **Story/Scene DSL** (`src/dsl/schema.ts`, zod, `dsl: 1`): film → scenes (a procedural set) →
   shots {line (+ `say` pronunciation), duration/leadIn/hold, camera rig + lens (focal length,
   f-stop, focus target, rack focus, drift, shake, roll), actor actions, lighting preset, post FX,
   text beats, transition out, SFX cues, music intensity/hit/drop}; a film-level cast of
   procedural actors. Anything "when" is an **Anchor**: seconds, "start"/"end", `{word:"raise"}`
   (+ occurrence/edge/offset) or `{fraction}`.
2. **Validation** (`src/dsl/validate.ts`): shape errors at the exact path with field hints, then
   meaning — ids resolve (with "closest" suggestions), word anchors exist in that shot's line
   ("did you mean"), lineless shots need a duration, moving rigs need an end pose, CONTINUE never on
   shot 1, on-screen text ≤ 60 chars. Built for an LLM repair loop (`formatIssues`).
3. **Timing** (`src/timing.ts`): each line is synthesized, then **transcribed back with the repo's
   local Whisper**; script tokens are aligned to heard words (Needleman–Wunsch, digits compare by
   value, unmatched words interpolated), shots laid end to end on exact frames. Without narration
   it estimates at 2.6 words/s (storyboards).
4. **Evaluator** (`src/evaluate.ts`): `(resolved film, frame) → FrameState` — camera pose/fov/focus,
   every actor's transform/params/entrance/exit/flows, light rig blend, post values, transition
   overlays, text beats (count-ups, strikes), phrase captions. **Pure**: no three.js, no clock, no
   `Math.random`. Cinematic easing (a weighted bezier, log-space dolly distance, seeded breathing
   drift, decaying shake, whip pans that carry through the cut).
5. **Renderer** (`src/remotion/*`): one Remotion composition; `<ThreeCanvas>` world (set: infinity
   studio with a floor reflection, background sweep, haze, dust; key/rim/fill/top-spot lights with
   one shadow caster; a procedural softbox environment for metal reflections) + a DOM typography
   layer inside platform safe zones + legibility scrims.
   Post (pmndrs `postprocessing`, Zlib): DOF (focus distance + a range computed from f-stop and
   focal length), mip-chain bloom, ACES, grade (lift/gamma/gain, saturation, contrast, flash/black),
   lens pass (whip smear, chromatic aberration, vignette, frame-seeded grain).
   Tiers: **DRAFT** (half res, no DOF/bloom/grain), **PREVIEW** (full res, half-res DOF, no MSAA),
   **FINAL** (MSAA ×4, 0.75-res DOF, aberration).
6. **Procedural actors** (`src/remotion/world/actors.tsx`): instanced gold coins (generated coin-face
   and reeded-edge normal maps, original abstract mark — not any currency) that stack in clusters,
   rain in, evaporate into dust, and fly in arcs between actors; pedestal; miniature building with
   generated window light; extruded original car; subscription cards; baseline plane; coin chart
   sculpture (two-tone principal/growth); light shaft; number wall.
7. **Sound** (`src/audio/*`): **procedural score** (pads on a i–VI–III–VII progression, sub, FM
   plucks, heartbeat pulse, hits, drops; Freeverb; ducked in-sample from the real word timings),
   **SFX** = the repo's procedural kit + two new synthesized sounds (SUB_DROP, COIN_CLINK), auto
   whooshes/shimmers on transitions; **mix** = voice bus (HPF, gentle compression, presence) leveled
   to −16 LUFS, music under it, SFX −9 dB under the voice, **two-pass loudnorm to −14 LUFS / −1.5 dBTP**.
   Measured on the proof film: −14.0 LUFS, −1.5 dBTP; voice 13.3 dB over the music inside speech
   (`scripts/audio-balance.py`), music swells ~10 dB between lines.
8. **Narration** (`src/narration/*`): Kokoro-82M via kokoro-js on onnxruntime-node (CPU), q8
   weights by default (`KOKORO_DTYPE=fp32` for the larger model). ~1.4× faster than real time on an
   M1 Pro. Voice for the proof: `af_heart` (the model's top-graded voice); audition of 7 voices on
   the hook line: `docs/evidence/2026-10-17-mini-movies/voice-audition/*.m4a` — **Chris should pick**.
9. **Storyboards** (`src/storyboard.ts`): stills per shot (start/mid/end) in about a minute — the
   seed of the studio's "storyboard preview" and "shot reroll".

## Studio-director iterations (evidence: `docs/evidence/2026-10-17-mini-movies/`)

- **Round 1** (`storyboard-r1-before.jpg`): framing far too tight (9:16 is narrow: a 50 mm lens at
  7 m sees 3 m of width), hero number wrapping onto two lines and colliding with its kicker, coins
  reading as black cylinders (metal reflecting a black environment), flat emissive building
  windows, a pedestal top blown to white.
  Fixes: re-lensed every shot (28–40 mm, longer distances), no-wrap number sizing + kicker above the
  band, softbox environment with a warm surround and front fill, envMap ×2, finer window grid.
- **Round 2** (`storyboard-r2-lighting-pass.jpg`, `round2/`): gold now reads as gold; but a hot
  beige glare under every subject (the floor reflection copy of the pedestal's *bottom cap* lit from
  above, coplanar with the floor, plus a glossy floor catching the key), the twist shots composed
  as empty black with objects at the bottom, two near-identical consecutive shots, unreadable
  footnotes over bright coins, the payoff opening on an empty floor, narration too fast (35 s,
  lines back to back), "Different life." gold-on-gold, captions duplicating title text.
  Fixes: removed the cap + offset the mirror, matte low-spec floor, an empty light shaft over the
  pedestal for "the part nobody tells you", a low car-and-building composition with a rack focus for
  "you didn't just spend", footnote pills, chart pre-grown at the payoff start, speed 0.92 + holds
  after the hook / "Gone." / the twist / the number, captions hide when the same line is on screen
  as typography, end titles stacked in the upper band.
- **Round 3** (`round3/`): whip pans swung 75° into the void → a black frame at each whip; voice
  only 8.8 dB over the music. Fixes: 38° whips landing with the subject already entering frame,
  duck −14 dB and music level −20. **Round 4** (`round4-final/`) is the delivered film.

Honest self-critique of the result: it looks like a premium motion-design piece (dark product-film
lighting, real DOF/bloom/grain, purposeful moves, numbers that sit in the world), not like stock
templates. It is **not** Pixar: no characters, no acting, no fluids/cloth; the car and building are
deliberately miniature-stylized; scene variety is limited to the actors we've modeled; Kokoro is
clearly a (good) synthetic voice. The weakest moments are the growth shot (columns crop at the top)
and the subscriptions shot (cards are small on a phone).

## Render time and cost

| Host | Tier | Speed | 39 s film |
|---|---|---|---|
| M1 Pro laptop, GPU (ANGLE/Metal) | FINAL | **3.4 s per video-second** | picture 130 s + narration 10–35 s + score/mix 5 s + delivery encode 45 s ≈ **3.5 min** |
| M1 Pro, CPU WebGL (SwiftShader, `REMOTION_GL=swangle`), concurrency 2 — proxy for the Sandbox | FINAL | 65 s per video-second | ≈ 42 min |
| same | PREVIEW | 40 s per video-second (57 at concurrency 4) | ≈ 26 min |

Vercel Sandbox (8 vCPU, CPU only; Pro pricing in DECISIONS "Cost"): a FINAL film in one sandbox
would hit the 45-min timeout. Realistic cloud path: **chunk by frame range** across ~6 sandboxes
(Remotion `frameRange`, concat) ≈ 8–10 min wall, ≈ 5.6 vCPU-h ≈ **$0.7 CPU + ~$0.25 memory ≈ $1 per
FINAL film**, ~$0.6 PREVIEW; storyboards are seconds. Cheapest/fastest today: render finals on a
machine with a GPU (Chris's Mac). The DSL/evaluator are host-agnostic.

Snapshot needs (if/when cloud rendering is wanted — **not done**, per instructions): kokoro-js +
phonemizer + postprocessing in the runner's externals; the Kokoro q8 ONNX (92 MB) + tokenizer
pre-downloaded into `/vercel/sandbox/cache` by `warmup`; a pre-bundled cinema Remotion project
(`CINEMA_BUNDLE_DIR`, same pattern as `MOTION_BUNDLE_DIR`); fonts and the SFX kit are already there;
a chunked render job kind.

## Licenses (asset manifest: `packages/cinema/src/assets/manifest.ts`, test-enforced)

- All 3D objects, textures, the environment, the score, and two SFX: **original, generated by our
  code**. The other SFX: the repo's procedural kit (original).
- Fonts: Inter, DM Serif Display — OFL-1.1 (already in `packages/media/assets`).
- Kokoro-82M weights + voices: **Apache-2.0** (verified on the model card 2026-10-17; trained on
  permissive/non-copyrighted audio). Output is AI-generated speech — label where a platform requires.
- phonemizer.js: Apache-2.0 wrapper, **bundles eSpeak NG (GPL-3.0)**. We only *run* it on our own
  machines/sandbox; GPL obligations attach to distributing the program, not to the audio. Re-check
  if the renderer is ever shipped to third parties.
- Whisper base.en: MIT. three.js / R3F: MIT. postprocessing: Zlib. Remotion: Remotion License (free
  ≤ 3 employees — same caveat as `@chris/motion`).
- No downloaded third-party models/HDRIs/characters were needed; none are in the repo. Poly Haven /
  Kenney / Quaternius (CC0) remain the documented option for future sets — each must get a manifest
  entry with source + license before use.

## Brand / spec checks

- "Principles transfer. Identity does not." The inspiration (a faceless explainer channel) supplied
  principles only — hook-in-2-seconds, one physical metaphor, a twist. Look, palette, typography,
  voice, and story are Chris's: the app's ink/gold/violet palette, Inter + DM Serif, real numbers on
  screen with the math footnoted, skeptical plain-English lines, no guru clichés.
- §3 "AI should NOT replace Chris's voice": the narrator is a synthetic voice that is *not* Chris and
  doesn't pretend to be. **Recommended for real publishing: Chris records the lines** (the DSL's
  `narration.engine: "CHRIS"` exists; the timing pipeline already works from any recorded line via
  Whisper). TTS stays the scratch/temp track and the fallback.
- §10: this is HERO-tier production; it must pass the same Claims Gate and hard gates as any video.

## What a full studio would need (not built)

1. **Authoring**: a ChatGPT copy-paste prompt that outputs DSL JSON + an in-app "write a mini-movie"
   agent (MEDIUM model) with the validator in a repair loop; the Claims Gate on the lines.
2. **Storyboard review** in the app (the storyboard renderer exists), per-shot **reroll** (camera,
   lighting preset, framing), and a timeline of shots with their lines.
3. **More sets/actors**: a numbers void (exists, unpolished), a city, a home interior, charts as
   sculptures (bars, lines, pies), simple stylized characters (CC0 rigged, e.g. Quaternius) — every
   new asset with a manifest entry.
4. **Music library**: more procedural cue styles (tension, uplift, minimal) and/or CC0/royalty-free
   tracks with documented licenses.
5. **Chris narration recording** in the Film page flow, then automatic word-sync.
6. **Cloud rendering** by frame-range chunks (above) or a GPU host; render-farm progress in the job
   banner.
7. Visual QA for mini-movies (text-in-safe-zone and readability checks on the rendered frames).

## Files

`packages/cinema/**` (new package), `apps/web/app/labs/mini-movies/page.tsx`,
`apps/web/app/api/labs/films/[id]/[file]/route.ts`, `apps/web/lib/labs-films.ts`,
`docs/evidence/2026-10-17-mini-movies/**`, this file. `pnpm-lock.yaml` (kokoro-js 1.2.1,
postprocessing 6.39.5).

Tests (`packages/cinema/src/__tests__`): DSL validation (8), timing/word anchors/alignment +
determinism of frame state (5), evaluator behavior + asset-manifest licenses (8), score determinism,
ducking, mix graphs and a real ffmpeg −14 LUFS master (5), and a real Chrome/WebGL render of the
same frame twice in two browsers → identical PNG hash (skip with `CINEMA_SKIP_REAL_RENDER=1`).

Reversibility: total — delete the package and the labs page; nothing else depends on it.

Ops note: the laptop's disk was at 99–100 % during this work (≈ 81 GB in ~/Library/Caches/Adobe,
≈ 37 GB in `.claude/worktrees`); a Kokoro download failed once with ENOSPC. Nothing was deleted.
