# Editor rebuild: smooth on an iPhone by construction (2026-10-18)

Chris (iPhone, Safari / home-screen app) said 3–4 times the editor is unusable: "it glitches, it's
not smooth, it doesn't show anything properly… it doesn't even work". Earlier fixes were measured
only in desktop Chromium and declared done. This pass measured in **WebKit** (Safari's engine) with
real-phone-like footage, found the root causes, rebuilt the preview, and measured again the same way.

## 0. How it was measured (so it can be repeated)

- **Fixtures** (made locally, not committed): iPhone-like vertical takes stored LANDSCAPE with a
  −90° display rotation — `4K HEVC 30 fps, 60 s, 31.5 Mbps` and `1080p H.264 60 fps, 40 s,
  23.8 Mbps` — real speech from macOS `say` with natural pauses, a moving test pattern with noise,
  a big frame number and a **12-bit frame barcode** burned into every frame.
- **Real pipeline**: upload bytes → `probeMedia` → the `ingest` heavy job (local Whisper → 720p
  preview proxy → automatic **style cut**: 13 clips / 9 clips) → Chris's typical edit on top:
  captions on, 5 library graphics (bar chart, text thread, 3D piggy bank, donut, 3D money stack),
  a zoom, a music bed.
- **Server**: `next build && next start` on :3791, throwaway PGlite on :55491, local storage.
- **Sessions** (Playwright, recorded on video): WebKit with the iPhone 15 descriptor (393×852,
  DSF 3, touch, iOS UA) and Chrome with mobile emulation + **6× CPU throttle**. Open → wait →
  play 22 s → pause → scrub the timeline → open/close a sheet.
- **Ground truth from the recording**: every recorded frame's barcode is decoded
  (`decode.py`) → which source frame was actually on screen → freezes (same frame ≥ 120 ms),
  frames of footage the edit REMOVED shown at cuts, real playback rate. Plus in-page signals
  (rAF gaps — Safari has no Long Tasks API —, long tasks, rVFC frames, media events) and the new
  health recorder's own counters.
- **Parity**: the same edit rendered by the real renderer (`render` heavy job), frames compared
  with paused preview frames at the same timestamps.

Scripts live in the session scratchpad (`er/`: `mkvideo.sh`, `seed.mts`, `run.mjs`,
`decode.py`, `cuts.py`, `report.py`, `shots.mjs`, `compare.py`, `longrun.mjs`), not the repo.

## 1. What was actually broken (evidence)

**F1 — Graphics: live Remotion DOM with CSS/SVG filters costs WebKit 0.5–1 s of main thread
PER FRAME.** Same edit, same machine: Chrome (even 6× throttled) plays at 49–60 fps; WebKit at
**6–11 fps with 4–5 s total freezes**. A/B in WebKit (rAF fps over 15–20 s of playback):
no graphics 30.1 (no stalls) · 2D graphics only 12.8 (≈1 s stall every second) · 3D only 19.8
(two 4.1 s stalls when the 3D scenes premount) · all 5: 2.6. Then with the graphics present, CSS
override experiments: `filter:none` alone → **30.0 fps, no stalls**; backdrop-filter off 13.8;
box-shadow off 20.6; text-shadow off 16.3. The graphics' glows/drop-shadows/blurs and the
per-graphic scene-integration SVG filter are rasterised on the CPU by WebKit every frame (at the
1080-wide composition size, scaled down). Chrome does them on the GPU — which is why every earlier
Chromium measurement looked fine.
Consequences on screen (recording, 4K edit, WebKit): the picture updated about **once a second**,
the first **7.8 s after pressing play nothing moved** (3D premount), the playhead overran a cut and
showed **25 frames of footage the edit removed** (one held for 1 s), playback ran at 0.73× real
time, and a 6-second scrub gesture took **82 s** to finish (rAF 2.6 fps).

**F2 — The two-`<video>` pool freezes in WebKit even without graphics.** With all graphics
removed, WebKit still froze the picture on one frame for **6.7 s** mid-playback while the
captions kept running (frame strip: `out/base-4k-novis-webkit/freeze-strip.png`) — the cut
handed over to the other `<video>` element and it never presented. The old engine's own
decision record already flagged "one run where the second element never presented a frame".

**F3 — Server Actions block each other.** Next.js runs Server Actions one at a time per client
(documented). The editor's footage analysis (`analyzeFootageAction`: scene stats + loudness
read from the **camera original** — in production that's a download of the whole original into a
function) ran as a Server Action on every open with graphics, so Save, the proxy poll and
everything else queued behind it.

**F4 — The preview was small.** On an iPhone 15 the 9:16 preview was **128×228 pt** (~27% of the
screen; less on a real device after the safe areas): a platform-switch row sat above it and the
timeline/transport took the rest.

Also seen: the proxy was downloaded twice per open by the two pool elements (2× ~20 MB on
cellular); "market return return" in captions is in the **render too** (transcript), not a
preview bug.

## 2. What changed (architecture)

**Compositor engine** (`apps/web/lib/editor/engine/*`, default where supported):
- **One canvas.** The take's 720p proxy (our own H.264, keyframe every 0.5 s, AAC, faststart) is
  downloaded once into memory (progressive; MP4 index parsed as soon as `moov` arrives — the first
  ~60 KB), demuxed by a small parser (`mp4.ts`), decoded with **WebCodecs VideoDecoder** (hardware
  H.264) and drawn with **WebGL2** (`gl.ts`) using the renderer's math: clip crop → punch-in zoom →
  grade (contrast/brightness → saturate → temperature gains, as a shader — no SVG filter over a
  video) → cos⁴ vignette. Baked graphics are composited in the same draw.
- **Decode-ahead across cuts** (`video-pump.ts`, `plan.ts`): the plan of source spans in output
  order is fed to the decoder ~2.5 s ahead; continuations keep decoding, jumps restart at the key
  frame before the span (≤ 15 frames of lead-in, dropped), B-frame reorder handled (re-tagging at
  continuation boundaries, flush before a switch to another take). The clock's frame is taken
  from a small queue — the first frame after a cut exists before the clock gets there.
- **One clock** (`clock.ts`, `audio.ts`): one AudioContext (48 kHz). Each take's AAC is decoded
  to PCM in ~4 s chunks as bytes arrive (ADTS-wrapped + decodeAudioData — works on iOS 15+;
  2 frames of pre-roll rebuild the MDCT overlap so chunks join cleanly). Every clip is a buffer
  source scheduled at an exact context time (4 ms ramps at hard cuts, none at continuations). The
  picture is slaved to the context clock minus output latency. Music bed + SFX share the context.
  iOS: `navigator.audioSession.type = "playback"` so the silent switch doesn't mute the preview.
- **Paused / scrubbing**: exact-frame decode from the previous key frame, frames shown as they
  improve (key frame first), new targets coalesced.
- **Instant reopen**: finished proxies are kept in the Cache API (newest 8).
- **Production storage**: proxies/bakes are read with `fetch()` through `/api/media` (302 to the
  private Blob URL). If the Blob origin refuses the cross-origin read, the engine re-requests
  `?stream=1` and the route streams the file same-origin. Which path ran is in telemetry.
- **Fallbacks**: no VideoDecoder / no WebGL2 / a take without its proxy → the `<video>`-pool
  engine (`select.ts`, pure + tested). WebGL context failure → remembers `video` on that device
  and reloads once. Kill switch: `?engine=video` (or localStorage `chris-editor-engine=video`).
- **Not in the compositor**: the person cut-out (behind-you graphics) needs a `<video>`; with
  the compositor those graphics draw in front with the existing "Depth shows in the export"
  note. Texts/captions stay in the SVG overlay (measured cheap in WebKit: 30 fps with captions,
  no graphics) — they carry the touch targets — driven by the same tick.

**Baked graphics** (`packages/media/src/graphic-bake.ts`, `apps/worker/src/graphics-bake-job.ts`,
`packages/motion` `renderVisualBake`): each graphic is rendered ONCE by the real renderer (the
same `VisualClip` Remotion composition the export uses) at half size, colour over stacked alpha
in one H.264 stream (keyframe every 15 frames, no B-frames), stored at
`bakes/<item>/<key>.mp4` (table `GraphicBake`, migration
`20261018120000_editor_health_graphic_bakes`, additive). The key hashes everything that changes
the pixels (visual minus id/absolute time, its interaction track, canvas, theme, fps, format
version) — moving a graphic in time keeps its bake; any other change is a cache miss
(tested). New heavy-job kind `graphics-bake` with its own lease subject (`bake:<id>`) so it never
makes Finish say "busy". Until a bake is ready (or when the editor runs the `<video>` engine)
the graphic is live Remotion in **lite mode** while playing/scrubbing (filters off — the
measured cause), full look after the playhead rests 0.5 s; the Player is now frame-locked to the
editor clock (no own clock, no 2-frame drift re-seeks); 3D scenes are no longer premounted at open.

**Non-blocking server work**: the footage analysis and the bake request/poll are Route Handlers
(`/api/editor/analyze`, `/api/editor/bakes`) — never queued in front of Save. The last analysis
per video is cached on the device, so reopening finds the bakes immediately.

**Layout (touch shell)**: the platform switch row is gone from above the preview (the switch is
in the Platforms sheet); an app chip + the warnings chip float beside the picture; timeline cap
236 → 220 px, transport 58 → 52 px. Preview on iPhone 15: **128×228 → 174×310 pt** (+85% area).

**Real-device telemetry** (`apps/web/lib/editor/health.ts`): the editor records open → first
frame → interactive, frames presented vs expected while playing (dropped frames), rAF stalls
(≥100/250/1000 ms), long tasks (where supported), video element events, decoder/media events,
scrub latency, JS errors (URLs stripped), memory where available, device facts and edit size.
Reports go to `POST /api/editor-health` (signed-in, schema-checked numbers/short strings only,
≤ 48 KB, append-only table `EditorHealthReport`, pruned to 400 rows / 30 days): 30 s after the
first play, every 2 min, when the page hides (sendBeacon), and on **"Something glitched"** (flag
button top-left of the preview on the phone, "Glitch?" in the desktop header) which snapshots
the last 20 s of events. Read them at **More → Editor diagnostics** (`/settings/diagnostics`).

## 3. Before / after (same scripts, same fixtures, same machine)

BEFORE = branch tip c2f9587. AFTER = this change (compositor engine). WebKit = Playwright WebKit,
iPhone 15 profile (its rAF runs at 30 Hz headless). Chrome = mobile emulation, 6× CPU throttle.
"Recording" columns are decoded from the session video (what was on screen).

| | 4K HEVC · WebKit | 4K HEVC · Chrome 6× | 1080p60 · WebKit | 1080p60 · Chrome 6× |
|---|---|---|---|---|
| navigation → first frame | 626 → 632 ms | 2259 → **1535 ms** | 525 → **455 ms** | 2225 → 2158 ms |
| navigation → interactive (play hydrated) | 220 → 360 ms ✗ | 971 → 1344 ms ✗ | 207 → 227 ms | 937 → 1250 ms ✗ |
| playback rAF fps (max gap) | 11.1 (4123 ms) → **30.0 (44 ms)** | 49.4 (67) → **59.9 (50)** | 6.0 (4893) → **29.9 (112)** | 49.7 (100) → **60.0 (17)** |
| frames presented / expected (engine) | — → **659/662 (0.5% dropped)** | — → 659/664 | — → 650/662 | — → 659/663 |
| recording: freezes ≥120 ms (longest) | 6 (7840 ms) → **0–1 (160)** | 1 (240) → 1 (160–200) | 6 (9400) → 1–2 (≤400, at play start) | 1 (160) → 1 (200) |
| recording: removed footage shown at cuts | 25 frames → **0** | 0 → 0 | 6 → **0** | 0 → 0 |
| recording: playback rate vs real time | 0.73 → **0.999** | 0.991 → 0.995 | 0.65 → **0.98** | 0.988 → 0.993 |
| long tasks while playing | n/a (Safari) | 13 (729 ms) → **0** | n/a | 1 (66 ms) → **0** |
| 6 s scrub gesture took / rAF fps | 81.8 s / 2.6 → **6.8 s / 30** | 6.0 s / 44.6 → 5.7 s / 58.4 | 78.2 s / 2.8 → **6.8 s / 30** | 6.0 s / 45.7 → 5.7 s / 58.2 |
| scrub → frame p95 | 4358 ms → **52 ms** | 76 → **22 ms** | 4432 → **53 ms** | 65 → **24 ms** |
| JS heap after session (Chrome) | — | 44.6 → **14.4 MB** | — | 59.6 → **13.5 MB** |
| JS on load (encoded) | 913 → 930 KB | | | |

Scrub "before" = scroll event → next presented `<video>` frame (rVFC); "after" = seek → exact
frame drawn (engine). WebKit without graphics (isolates F2): before one **6.7 s** frozen picture
mid-playback; after 0 freezes, 659/662 frames presented, rate 1.001.

`<video>` fallback engine after this change (WebKit, 4K, `?engine=video`, lite graphics): rAF
29.9 fps (was 11.1), but still 5 freezes up to 480 ms and 8 removed frames at cuts, 10.4% dropped —
which is why the compositor is the default.

**5-minute session** (Chrome, no throttle; 19 loops of play 12 s / scrub / sheet / full screen;
heap after forced GC): compositor 10.0 → 11.8 MB (max 12.8), DOM nodes 1168 → 507, 6620/6898
frames presented (4% dropped, unthrottled headless), 0 stalls ≥ 250 ms, scrub p95 12 ms;
`<video>` engine (same build, `?engine=video`) 10.0 → 18.7 MB, DOM nodes 1522 → 2281 (growing),
12.4% dropped, 14 long tasks. No memory API in WebKit — on the phone, telemetry reports it where
Safari allows (it mostly doesn't).

First-frame/interactive numbers are from navigation start (both columns). The first picture is
not faster locally (everything is on localhost; the old engine's win/loss here is network): the
compositor waits for the proxy's index + one key-frame decode. Interactive got **~20–40% later**
(more work at hydration: the engine, its AudioContext and the health recorder start then; +17 KB
JS). Not chased further in this pass — it's under 0.4 s in WebKit and the editor shows the
filmstrip poster meanwhile.

Note on the recording decoder: "removed footage" counts at cuts were checked by eye on the frame
strips — the 3 frames flagged in one 1080p run were barcode misreads under a graphic (true frames
290 → 292 | cut | 330 → 332, clips end/start at 294/328), see `out/final-1080-webkit`.

**Preview vs final render** (`out/parity-4k.png`): at 5.5 / 15.5 / 26 / 35 / 44 s the compositor
preview shows the same source frame (±1 frame from ffmpeg's seek rounding), the same graphics at
the same place and animation state (incl. both 3D objects), the same caption chunk and highlight.
Mean absolute RGB difference vs the render 10.8–14.8 (0–255; dominated by the preview's rounded
corners and 720p softness), old engine 9.8–12.7. Baked graphics are slightly softer (half size).

## 4. What could not be verified here — needs Chris's iPhone

1. Real Safari/iOS: hardware VideoDecoder throughput, AudioContext resume inside the play tap,
   `audioSession` on a muted phone, 60 Hz rAF. (Playwright WebKit is macOS WebKit, 30 Hz headless.)
2. Production Blob: whether the presigned Blob URL allows a CORS `fetch` (else `?stream=1`
   through the function — size/time limits of streaming a ~20–30 MB proxy through a Vercel
   Function are unverified). Telemetry reports `mediaPath` (direct / stream / cache).
3. **Bakes in the cloud need a snapshot rebuild** (new `graphics-bake` kind + `renderVisualBake`
   in the worker/motion bundle). Until then bakes are refused/fail in production and graphics stay
   on the live lite path (smooth, filters off while playing). Local bake time: ~8–10 s per graphic.
4. Takes with no v2 proxy run the `<video>` engine (by design) — the diagnostics page shows the
   engine and reason per session.
5. Memory over a long session on the phone (Safari kills heavy tabs silently): the PCM and proxy
   bytes are held in memory (~25 MB + ~20–30 MB per take).

## 5. How Chris uses it

- Nothing to do: the editor picks the new engine itself. If anything looks wrong, tap the small
  **flag** button at the top-left of the preview right after it happens — it saves the last 20 s.
- **More → Editor diagnostics** lists every editor session: first picture time, smoothness
  (dropped frames, freezes), scrub delay, errors, device, and the engine that ran.
- Escape hatch: add `?engine=video` to the editor URL for the old engine.

## Reversibility

High. `?engine=video` / localStorage switches back per device; `select.ts` is one function. The
two tables are additive and only used by the editor; dropping bakes leaves the lite live path.
Renders are unchanged (bakes are preview-only; `renderVisualBake` is a new export).
