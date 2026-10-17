# Pending decisions — Motion engine (packages/motion), compositing + sound design

Format follows `/docs/DECISIONS.md`. To be merged into it by the integrating session.

---

## 2026-10-16 — Motion graphics are rendered by Remotion 4 (React + three.js) in a new `@chris/motion` package

**Decision:** `packages/motion` (`@chris/motion`) renders `EditTimeline.visuals` (the committed
contract in `packages/media/src/motion-contract.ts`, unchanged) with Remotion 4.0.533 —
`remotion`, `@remotion/bundler`, `@remotion/renderer`, `@remotion/player`, `@remotion/three` —
plus `three` 0.186.1 and `@react-three/fiber` 9.8.1 on React 19.2.8 (all pinned exactly;
R3F 9.8 peer range `react >=19 <19.4` matches the repo's React). No drei: every 3D object is
modeled procedurally (ExtrudeGeometry rounded slabs, tubes, tori, lathe-free primitives) so
there is no asset/CDN dependency.

Package layout:
- `src/timing.ts` (pure): props parsing with defaults (`parseVisual(s)` — never throws; invalid
  visuals are reported and skipped, never rendered wrong), frame windows
  (`round(start*fps)`, same rounding as the renderer), AUTO transition table, placement box
  math (`placementBox`: center = placement x/y, designed size × `placement.scale` × canvas
  unit; clamped inside a 36 px margin and shrunk if it would not fit — `clamped` says so),
  MONEY_STACK_3D stack-count scale.
- `src/remotion/*`: the `VisualsLayer` composition (all visuals, transparent), `VisualClip`
  (one visual from frame 0 — used by the renderer) and `Preview-<TEMPLATE>` compositions
  (sample props, 4 s) for thumbnails/testing; 14 template components; motion vocabulary
  (`SPRINGS`, eases, enter/exit styles with a velocity-tracking blur for a motion-blur feel).
- `src/render.ts` (Node): `renderVisualsLayer()`; `src/assets.ts`: SFX kit paths.
- `src/player.tsx` (client): `<VisualsPreview>` on `@remotion/player`.
- `scripts/generate-sfx.mjs`, `scripts/showcase.ts` (quality loop).

**Alternatives considered:** hand-written canvas/ffmpeg drawtext animation (no 3D, weak
typography, no spring physics); Motion Canvas (smaller ecosystem, no first-class React Player
for the editor); Lottie (needs a designer pipeline, no data-driven 3D).

**Rationale:** the same React components render the server output and the browser preview,
so "what the editor previews is what renders" (the timeline-engine principle) extends to
motion. Remotion gives frame-exact deterministic rendering, spring physics and WebGL 3D.

**License:** Remotion is source-available under the Remotion License: free for individuals
and companies with up to 3 employees (this is a single-operator product — Chris), otherwise a
company license is required (remotion.pro). `acknowledgeRemotionLicense` is set on the Player.
**Re-check if the business grows past 3 people.** three.js / R3F are MIT.

**Reversibility:** moderate — the contract (`motion-contract.ts`) is engine-agnostic; another
renderer could implement the same 14 templates and the compositor only needs alpha clips.

---

## 2026-10-16 — Alpha format: ProRes 4444 (`yuva444p10le`) .mov clips, one per visual

**Decision:** `renderVisualsLayer` renders with `codec: "prores"`, `proResProfile: "4444"`,
`pixelFormat: "yuva444p10le"`, `imageFormat: "png"`, `colorSpace: "bt709"`. Default strategy
`PER_VISUAL`: one short clip per visual (only its own frames); `FULL_LAYER` (one full-length
layer) is available. The compositor overlays each clip with
`setpts=PTS-STARTPTS+start/TB` and `overlay=...:eof_action=pass:enable='gte(t,s)*lt(t,e)'`.

**Alternatives considered:** VP8/VP9 WebM with alpha (smaller, but ffmpeg only decodes the
alpha plane when the `libvpx` decoder is forced on the input — easy to get silently-opaque
output); a PNG sequence (huge, slow I/O); FULL_LAYER as default (renders every empty frame).

**Rationale:** ffmpeg-static's native ProRes decoder always yields `yuva444p12le` with alpha —
verified by test (`timeline-motion-mix.test.ts` composites a synthetic ProRes 4444 clip and
asserts graphics pixels inside the window and none outside it; the motion integration test
asserts the Remotion clip's `pix_fmt` is `yuva*` and that graphics appear only in their
windows/regions). BT.709 tagging matches the H.264 master so gold stays gold. PER_VISUAL
renders only frames where something is on screen.

**Reversibility:** high — format and strategy are parameters.

---

## 2026-10-16 — Compositing order and audio mix in `renderTimeline`

**Decision:** in `packages/media/src/timeline-render.ts`:
- Video: base clips → zoom → grade → **motion overlays** → text plates / texts → captions.
  Graphics are not color-graded, and speech captions stay on top of graphics.
- Audio (`buildAudioMix`, pure, unit-tested): voice = the existing loudnorm chain; SFX = one
  input per distinct sound, `asplit` per hit, `adelay` to the hit time, gain =
  volume × `SFX_HOUSE_GAIN` (0.5); visual `enterSfx` hits at the visual's start use
  `VISUAL_SFX_VOLUME` (0.6, the TimelineSfx default); `audio.sfxEnabled=false` drops all of
  them; music bed = `-ss trackStart`, referenced to −14 LUFS (so `levelDb` really means "dB
  under the voice"), `apad`/`atrim` to the video, fades, then ducking; `amix normalize=0` and
  a final `loudnorm I=-14:TP=-1.5:LRA=11` (or `alimiter` when normalize is off).
- **Ducking:** deterministic volume automation from the real word timings when any clip's
  take has them: speech regions (words mapped through each clip's source window, merged when
  gaps < 0.45 s), level − duckDb under speech, 0.15 s ramp down *before* each region (the duck
  is in place when the first syllable lands), 0.4 s release. Fallback with no word timings:
  `sidechaincompress` keyed by the voice, ratio chosen so ~18 dB over threshold ≈ `duckDb`.
- Missing SFX files / missing music file → a warning and the render continues (graceful
  failure); a missing motion clip path → error (the layer was supposed to exist).
- With no visuals, no SFX and no music the filter graph is byte-identical to before (the
  existing render tests pass unchanged; a unit test asserts the legacy chain).

New optional inputs: `visualsLayer.segments`, `musicPath`, `sfxFiles`. New result field:
`motion { overlays, sfxEvents, music }`.

**Alternatives considered:** sidechain-only ducking (reacts after the first syllable and
pumps on breaths/room noise); ducking by a fixed `volume` per caption chunk (coarser).

**Reversibility:** high.

---

## 2026-10-16 — Procedural SFX kit (no licensing risk)

**Decision:** `packages/motion/assets/sfx/{whoosh,swoosh_up,soft_pop,click,tick,riser,impact,shimmer,cash}.wav`
— one per `SFX_SOUNDS` id — are synthesized from scratch by
`packages/motion/scripts/generate-sfx.mjs` (seeded noise, Chamberlin SVF sweeps, sine/FM
oscillators with pitch envelopes, a Freeverb-style stereo reverb, raised-cosine releases, TPDF
dither). 48 kHz stereo 16-bit, peak-normalized to −8 dBFS (true peak ≤ −7.6 dBFS), short
tails, gentle top end. Reproducible: `pnpm --filter @chris/motion sfx`.

Measured (ffmpeg ebur128/astats): peak −8.0 dBFS on all; integrated −16.8 … −21.8 LUFS for
the sustained ones (CLICK/TICK/SOFT_POP are too short to gate). Spectrograms were checked
(showspectrumpic) and the design iterated: hard cut-offs at buffer ends (WHOOSH, SHIMMER,
CASH, IMPACT) were fixed with releases and longer buffers; the RISER keeps its crisp end
into a short reverb tail by design. Evidence: `docs/evidence/2026-10-16-motion/sfx-spectrograms.jpg`.

**Rationale:** original audio is the only zero-risk option for a publishing product; the
synth palette (filtered noise + soft sines) is exactly what tasteful UI/explainer SFX are.

**Reversibility:** high — files are swappable; the mixer only needs `sfxFiles`.

---

## 2026-10-16 — Render performance

See the numbers recorded at the end of this file ("Render timings"). PER_VISUAL is the
default because a typical 30–60 s edit has visuals on screen for well under half its length.
Concurrency defaults to Remotion's (half the CPU cores); pass `concurrency` to tune. The
Remotion bundle (webpack/rspack) is built once per process and cached.

---

## INTEGRATION NOTES

**Worker (`apps/worker/src/render-job.ts`).** `renderContentItem` calls
`prepareMotion(db, storage, timeline, sources, workDir, warnings, options.motion)` before
`renderTimeline`:
- visuals present → lazily loads `@chris/motion` (non-literal `import()` so Next.js never
  bundles Remotion through apps/web → @chris/worker) and runs `renderVisualsLayer` at the
  same fps `renderTimeline` will choose (probe of the actual sources, `chooseOutputFps`);
- any SFX will play → `sfxFiles()` from the kit;
- `audio.music` → downloads the MUSIC MediaAsset from storage (must be `kind: MUSIC`).
Every failure becomes an `unexecutedInstructions` warning on the Render row and the video
still renders (graceful degradation). `options.motion.visualsEnabled=false` is the feature
flag to render without the motion layer. The QC report gets a `motion` block
(visuals, overlays, framesRendered, motionRenderMs, sfxEvents, music mode).
AUTO placement is NOT solved here — the given `placement` is rendered as is (another
engineer's `resolveVisualPlacements` should run before rendering).

**Editor (`@chris/motion/player`).**
```tsx
"use client";
import { VisualsPreview } from "@chris/motion/player";
<div style={{ position: "relative", width: w, height: h }}>
  {/* existing preview surface */}
  <VisualsPreview timeline={timeline} currentTime={t} playing={isPlaying}
                  width={w} height={h} fps={30} fontBaseUrl="/api/fonts" />
</div>
```
The editor's clock is the source of truth: paused → exact `seekTo(round(t*fps))`; playing →
the Player runs and is re-synced when it drifts > 2 frames. Transparent, pointer-events none.
Fonts: the web app already serves `packages/media/assets/fonts` at `/api/fonts/<file>`.
apps/web needs `@chris/motion` as a dependency and (Next.js) `transpilePackages:
["@chris/motion"]` because the package ships TS source; `three`/`@react-three/fiber` are only
loaded by the 3D templates. Pure helpers (timing/placement/samples) for the editor UI:
`@chris/motion/pure`.

**Where rendering can run.** Remotion needs a headless Chrome (+ WebGL for the 3D templates;
we launch with `gl: "angle"`). `renderVisualsLayer` uses `REMOTION_BROWSER_EXECUTABLE` if set,
else an existing Puppeteer/Playwright `chrome-headless-shell`, else Remotion downloads its own
(`ensureBrowser`, ~90 MB, cached). It cannot run inside a regular Vercel Function (no Chrome,
250 MB bundle limit, short timeouts). Options:
1. the existing long-running worker host (current model — recommended);
2. **Vercel Sandbox** (Firecracker microVM, can install Chrome + run `renderVisualsLayer`,
   hand back the clips/MP4 via Blob) — good fit for burst renders without a dedicated host;
3. **Remotion Lambda** (AWS) — fastest for long videos (parallel chunks), but adds AWS and the
   alpha clips must be fetched back for compositing.
The browser Player has none of these constraints (runs client-side).

**Tests.** `packages/motion/src/__tests__/timing.test.ts` (props/defaults/timing/placement),
`render.integration.test.ts` (real Remotion + ffmpeg; `MOTION_SKIP_REAL_RENDER=1` skips it on
hosts without Chrome/network), `packages/media/src/__tests__/timeline-motion-mix.test.ts`
(graph unit tests + real compositing/SFX/ducking measurements),
`apps/worker/src/__tests__/render-job-motion.test.ts` (wiring + graceful degradation).

## Render timings

(filled in below from the measured runs)
