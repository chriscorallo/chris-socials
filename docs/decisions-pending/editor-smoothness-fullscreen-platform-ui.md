# Editor: smooth playback, full screen, real platform UI, proxies (2026-10-17)

Chris rated the editor ~80% ("not the smoothest"), then — after the automatic style cut made a
typical edit 10–25 short clips from one take — "SO glitchy and laggy… unbearable… feels
amateur", worst on first load, after playing a while, with big videos and with the graphics.
He also wanted a full-screen view and an honest picture of where TikTok / Reels / Shorts put
their buttons. Everything below was measured before it was changed; numbers are from Playwright
at iPhone size (393×852) against a production build (`next build && next start`) on a throwaway
PGlite DB. Measurement scripts are in the session scratchpad (`sm/measure.mjs`,
`sm/measure-load.mjs`), not in the repo.

## 1. Cut boundaries (the style cut's 10–25 clips)

**Measured cause.** A style cut is 1 continuation (framing-only cut) and 13 *jump* cuts (removed
pauses, 0.13–1.2 s forward) in 36 s. The engine played clip *i* on pool element *i % 2*; the other
element waited paused on the next clip's first frame and was `play()`ed at the boundary. Chrome
needs 2–3 vsyncs from `play()` to its first new frame, so every cut held the preroll frame for
~67–100 ms (1–2 dropped frames), and the tick (clock = `currentTime`, which runs ahead of the
picture) cut a frame late, so 9–12 of 13 cuts flashed one frame of the *removed* pause.

**Decision.**
- `lib/editor/player-pool.ts` (pure, tested): a **continuation** (same take, next clip starts
  within 1/60 s of where this one ends) stays on the same element — only the crop changes; a
  **jump** switches element.
- **Warm standby:** the next jump's element is pre-seeked 0.6 s *before* the next clip's first
  frame and started (muted, invisible) when the time left equals that lead; each tick nudges its
  `playbackRate` (0.8–1.25) so it lands one frame past the first frame exactly when the current
  clip ends. The cut is then a visibility + audio swap between two elements already playing — no
  seek, no `play()` latency on screen, no audio restart. If the standby isn't on time (playback
  started right before a cut, slow network) the cut falls back to the old seek-and-play.
- **Frame-accurate cut:** `requestVideoFrameCallback` on the active element cuts in the frame where
  it would first show footage past the out point (when it gets there before the clock check).
  Cutting *only* on frame callbacks was measured and was worse in Chrome (3–9 dropped vs 1–2).
- **Hidden element is stacked behind (z-index), not `opacity: 0`.** Measured in WebKit: an
  opacity-0 `<video>` stops presenting frames and, once shown, took ~0.9 s to present its first
  frame — every cut froze. Both elements cover the whole canvas, so the one behind is invisible.
- **Scrubbing:** a new `currentTime` while a seek is in flight aborts it (Chrome: 82 seeks issued,
  12 completed during a drag on an 8-s-GOP file). Seeks are now coalesced — the latest target is
  applied on `seeked`.
- Kill switch: `?warm=0` on the editor URL (real-device A/B).

| Chrome, 36 s style cut (13 jump cuts) | before | after |
|---|---|---|
| dropped frames at cuts (8 s GOP / 1 s GOP take) | 16 / 18 | 2–3 / 2 |
| freeze at a cut, median (max) | 83 ms (100) | 50 ms (83) = normal 30-fps-on-60-Hz cadence |
| cuts showing a removed frame | 12/13 / 8/13 | 2/13 / 2–3/13 |
| scrub: video updates/s (8 s GOP) | 4.7 | 8.5–9.4 |
| scrub: input→frame median / p95 (8 s GOP) | 66 / 232 ms | 32–48 / 83–115 ms |
| scrub on a 1 s-GOP take | 25.6/s, p95 31 ms | ~24/s, p95 16–31 ms |
| long tasks during playback | 0 | 0 |

WebKit (Playwright, headless, software decode, 30 Hz rAF — a weak proxy for an iPhone): baseline
(1 run) 27.6 fps, cut freeze median 132 ms, 38 dropped at cuts; after: 25.9–28.5 fps, median
67 ms (= one 30 Hz frame), 22–24 dropped at cuts — but 2 of 5 runs were bad (one 1.7 s stall
while the standby decoded; one run where the second element never presented a frame). Headless
WebKit decoding two 1080×1920 streams in software is the likely cause; **this must be checked on
the iPhone** (see "Check on a real iPhone").

## 2. Proxy workflow (the biggest fix for big files)

**Measured cause.** The editor played the camera original. Opening a 4K HEVC take downloaded the
**whole file** (113 MB for 80 s; 192 MB for a 20 Mbps 1080p take) before anything else, decoded it
twice for cuts, and a THIRD hidden `<video>` decoded it 48 more times to build the timeline
filmstrip (`toDataURL` JPEG encodes on the main thread). On an iPhone over Wi-Fi/cellular from
Blob storage that is the "laggy right when it loads" and the stalls.

**Decision.** Every raw take gets editor-only preview assets
(`packages/media/src/preview-proxy.ts`, pure planning in `preview-plan.ts`):
- **proxy:** H.264 High, fit inside 720×1280, ≤ 30 fps, ~2.5 Mbps, keyframe every 0.5 s (closed
  GOP, no scene-cut keyframes → any seek decodes ≤ 15 frames), AAC 128k, faststart;
- **filmstrip sprite:** one JPEG, ≤ 120 tiles 120 px tall (timeline thumbnails + instant
  placeholder);
- **audio peaks:** 20/s, 0–255 (stored for a waveform; not drawn yet).

Stored at `proxies/<contentItemId>/<id>.mp4` / `-filmstrip.jpg`; columns `proxyStorageKey`,
`filmstripStorageKey`, `previewMeta` on MediaAsset (migration `20261018020000_preview_proxies`,
additive, nullable — existing rows unchanged), written by `recordPreviewAssets` (audit
`MEDIA_ASSET_PREVIEW_PROXIED`, key prefix enforced). New heavy-job kind **`preview-proxy`**; the
upload's `ingest` job makes it right after transcription (captions still come first) and before
face tracking (`ingest.proxy`, default true). `/api/media` serves the two keys (proxies cached
`private, max-age=86400`).

**Renders always read the original** — the proxy never enters `renderTimeline`, so there's no
quality loss. The editor plays the proxy when one exists (`lib/editor/editor-assets.ts`), else the
original. **Existing takes:** the editor starts a background `preview-proxy` job when it opens on a
take without one, polls every 10 s (≤ 6 min), and swaps to the proxy *while paused* (the engine
never changes a source mid-play). Client-side frame grabbing is now only a fallback for small
sources without a sprite; a > 1080p original without a proxy isn't decoded for thumbnails at all.
A poster layer shows the sprite tile for the clip under the playhead (cropped like the clip)
under the videos, so the first picture appears before the video decodes.

Proxy generation measured locally (Apple Silicon): 80 s 4K HEVC → 27 MB proxy in 20 s; 80 s
20 Mbps 1080p → 27 MB in 10 s. The cloud sandbox will be slower (software HEVC decode) — not
measured.

Trade-off: while a `preview-proxy` job runs it holds the video's heavy-job lease, so a Finish
started in those ~10–60 s says "busy". Accepted (one-time per take; the upload path does it inside
`ingest`, which already holds the lease).

## 3. Motion graphics in the preview

**Measured cause.** With 5 graphics (2 of them 3D), playback had 3–4 main-thread long tasks of
0.2–0.5 s (desktop, 4× CPU throttle) exactly when a 3D graphic appeared — mounting a three.js
scene (WebGL context, PMREM environment map, geometry) inside the Remotion Player. The
composition also re-validated every visual (`parseVisuals`) on every frame, and 3D canvases drew
at the 1080-wide composition resolution × devicePixelRatio for a ~220-px-wide preview.

**Decision** (preview-only; renders are unchanged — `previewQuality` is never set by renders):
- `VisualsPreview` passes `previewQuality`: 3D canvases capped at the resolution they're shown at
  (× 0.6 while playing, full when paused), `antialias`/`preserveDrawingBuffer` off.
- Graphics are **premounted** (Remotion `premountFor`, hidden): 3D scenes from the start of the
  timeline once the editor is idle after opening (≤ 3 per video, else 3 s ahead), everything else
  3 s ahead. The WebGL setup now happens while Chris looks at the first frame, not mid-playback.
- `parseVisuals` memoized; the env map is disposed when a 3D scene unmounts; PersonCutout frees
  its GL program/textures/buffer on every re-init (it re-inits on resize — full screen, sheets).
- Remotion/three were already lazy (only loaded when the edit has graphics).
- Not done: pre-rendering each graphic to an alpha WebM in the cloud (a bigger pipeline; the
  premount removed the measured stalls — revisit if the phone still hitches).

| Chrome, 4× CPU throttle, 4K take, 5 graphics | before | after |
|---|---|---|
| long tasks while playing | 3–4 (352–667 ms) | 0 |
| dropped frames (34 s) | 12–35 | 3–6 |
| rAF gaps > 50 ms | 2–3 | 0 |
| scrub video updates/s / input→frame p95 | 16.4 / 49 ms | 28–38 / 15–32 ms |

## 4. First load

Code-split panels Chris opens on demand (graphics gallery + editor, sound, style cut, Finish
modal, the WebGL person cut-out) — `lazy-panels.tsx`. The editor's own chunks are small; the
`@chris/media/timeline` chunk (zod + layout, 84 KB gz) and Remotion (351 KB gz, only with
graphics) dominate.

| 4× CPU throttle, cold cache | before (4K / 1080p) | after (4K / 1080p) |
|---|---|---|
| JS on load (encoded / decoded) | 697 / 2509 KB | 654 / 2348 KB |
| media downloaded while opening | 113 MB / 192 MB (whole original) | 152 KB sprite + proxy streaming |
| play button ready | 203 / 428 ms | 278 / 205 ms |
| first video frame | 1220 / 1353 ms | 1282 / 1059 ms (sprite placeholder before that) |
| first video frame, reopen (warm) | 695 / 720 ms | 557 / 645 ms |

(The 3D warm-up now runs as idle work after the first frame — it shows up as ~0.3–0.5 s of long
tasks before playback, by design.) On localhost the original's download is free, so the load
numbers understate the phone win: over a real network the old editor waited on a 100+ MB file.

## 5. Long sessions

5-minute scripted session (play 20 s, scrub, switch platform tabs, full screen in/out), 4K take
with graphics, after a forced GC: JS heap 9.2→17.7 MB before / 11.7→16.8 MB after (flat after
warm-up), event listeners flat (≈ 650–700), DOM nodes in the document flat (514→515). Chrome's
total node count (incl. detached) creeps ~100/min in both builds — small, not traced. Fixed: GL
objects in PersonCutout re-init, 3D env maps on unmount; MotionLayer/VisualHandles no longer
re-render 30×/s when there are no graphics / while playing.

## 6. Full screen

`Fullscreen.tsx` + `lib/editor/fullscreen.ts`: a button on the preview (and in the desktop
header) turns the SAME stage box into a fixed, edge-to-edge overlay — the canvas and its pool
videos are never remounted, so playback continues seamlessly; the Fullscreen API is used too where
it exists (desktop/Android; iPhone Safari can't full-screen an element). Plain mode = the whole
frame fit to width, centred. Tap = play/pause, swipe down / Esc / × = close, auto-hiding scrub bar
+ time, mute (preview only), and "App UI: Off / TikTok / Reels / Shorts" (remembered in
localStorage, guarded). With an app's UI on, the video is laid out like the app's feed (filled
above an opaque nav bar, ~49 px cropped a side on a 19.5:9 phone) with the mock on top. Editing
shortcuts are disabled while it's open.

## 7. Platform UI model

`packages/media/src/platform-ui.ts`: per app, structured regions in 1080×1920 video px for the
reference phone (393×852 pt): right rail, caption/username block, top bar, progress bar — a
**best estimate** (what the mock draws and the warnings use) and a **conservative** set (official
ads safe zones). Screen fit (`screenFit`, `referenceAppFit`): all three fill the area above the
nav bar (49 pt + 34 pt home indicator) → scale 769/1920 pt/px, ~49 px of video hidden each side.
`PLATFORM_PROFILES[id].safeZone` is now **derived** from the conservative regions (TikTok
240/660/60/300, Reels 269/672/60/227, Shorts 288/672/60/192); the Reels right margin was 65 px —
far too small for its action rail.

The graphics auto-placement solver keeps its old union margins (`PLACEMENT_SAFE_ZONE`
288/672/65/192) so no existing render moves; switching it to the regions is a separate decision.

Warnings (`platformWarnings` / FinishModal `warningsForPlatform`) now test text, captions,
graphics (resolved placements) and **Chris's face** (tracked head box per clip, ≥ 15 % covered)
against the best-estimate regions, plus the side strips a tall phone crops. The preview draws a
realistic, unbranded mock (icon silhouettes, text-line placeholders, gradients, progress bar)
above captions, with an eye toggle; "All" shows the union of the keep-clear zones.

### Sources (accessed 2026-10-17)
- TikTok Ads Help, In-Feed Ads (updated June 2026), links the safe-zone templates:
  https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads?lang=en — "a maximum of 4 lines"
  of caption; template file (Apr 2025) `In-Feed Standard LTR / Feed.png`
  (https://lf-tt4b.tiktokcdn.com/obj/i18nblog/tt4b_cms/en-US/5jqet0ab9qci-10e7f5Vig4uhAscNP8XPB0.zip):
  720×1280 top 160, bottom 440, sides 80, right action column 120 wide from y 560.
- AdKit TikTok (2026-09-10) https://adkit.so/tools/safe-zones/tiktok — confirms; 4-line anchor
  variant reserves bottom 1014.
- Meta Ads Guide, Instagram Reels https://www.facebook.com/business/ads-guide/update/video/instagram-reels
  — "at least 14% of the top, 35% of the bottom, and 6% on each side"; AdKit Instagram
  (2026-09-10) https://adkit.so/tools/safe-zones/instagram — lower-right exclusion 226.8 px wide
  below y 1152; Billo (2026-06-16) https://billo.app/blog/meta-ads-safe-zones — Stories/Reels zones
  unified March 2026.
- Inro Reels checker (2026) https://www.inro.social/tools/instagram-reels-safe-zone-checker —
  organic bands disagree: top 108–269, bottom 250–672, right 35–140 px.
- Google Ads vertical-video safe zones https://support.google.com/google-ads/answer/9128498 (image);
  AdKit YouTube (2026-09-10) https://adkit.so/tools/safe-zones/youtube and Socialync
  (2026-10-11) https://www.socialync.io/tools/safe-zones/youtube-shorts — top 288, bottom 672,
  left 48, right 192.
- Revid (2026) https://www.revid.ai/tiktok-safe-zone ("trims a little off the sides on taller
  phones"); Kive (2026-10-14) https://kive.ai/learn/meta-ad-sizes ("Meta may zoom the creative to
  fill the screen").

Where sources disagree (mostly the bottom band, 250–672 px) the official ads value is the
conservative set and a short-caption organic estimate is the best estimate. No app publishes
organic positions; icon sizes/spacing and the screen fit are derived from the app geometry, not
sourced — **verify against one screenshot per app on Chris's phone**.

### Caption default (deliberate render change)
The style cut's captions sit at y ≈ 0.74 — clear of every app's caption block (TikTok's starts at
y 1500). But a 3-word BOLD_HIGHLIGHT chunk at 72 px is up to ~740 px wide and reached TikTok's
rail (x ≥ 860) on 3 of 44 chunks of the test take. `PLAN_CAPTION_PRESETS.BOLD_HIGHLIGHT.fontSize`
72 → **64** (widest chunk 658 px, clear). Affects new starter edits/style cuts and items whose plan
still has no explicit timeline; saved timelines keep their size. `captionTop` unchanged.

## Render parity / snapshot

Final-render output is unchanged except the caption size above. Renderer-side code that changed:
`packages/motion` (VisualsLayer memo + preview-only branches, three.tsx env-map dispose),
`packages/media` (new proxy module, platform profiles), `apps/worker` (new job kind + ingest step).
**The Vercel Sandbox snapshot must be rebuilt** before the cloud `ingest` makes proxies and before
`preview-proxy` can run in the cloud — and `RENDER_SANDBOX_KINDS` must include `preview-proxy`
(currently only `reference-analyze`; editing runs locally until then). Not touched here.

## Check on a real iPhone
1. Cuts: play a style cut — any visible hitch at cuts? Compare with `?warm=0`.
2. That unmuting the warm standby at the cut keeps sound (iOS autoplay rules; the standby was
   unlocked from the play tap) and that two elements playing at once never pauses one.
3. Proxy: an existing take switches to the proxy within a minute or two of opening (paused).
4. 3D graphics: no freeze when they appear; the 3D looks sharp when paused.
5. Full screen: overlay covers the Dynamic Island/home indicator area correctly; swipe-down closes;
   the App UI mock matches the real apps (one screenshot each).
6. Memory: a 10-minute session doesn't reload the tab (Safari kills heavy tabs silently).

## Reversibility
High. `?warm=0` disables the warm standby; proxies are additive columns (null → the original
plays, exactly as before); the platform model only feeds warnings/mock (placement kept its old
margins); the caption size is one constant.
