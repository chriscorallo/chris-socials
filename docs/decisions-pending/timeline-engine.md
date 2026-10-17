# Pending decisions — timeline render engine, fonts, platform variants (2026-10-16)

To be merged into `/docs/DECISIONS.md` by the integrator. Code: `packages/media/src/`
`timeline-layout.ts` (PURE, shared with the browser preview), `timeline-render.ts`
(`renderTimeline`), `plan-to-timeline.ts`, `font-metrics.ts`, `platform-profiles.ts` (PURE),
`platform-variant.ts`; worker: `apps/worker/src/render-job.ts`, `quality-gate-job.ts`.
The EditTimeline contract (`timeline.ts`) is unchanged; only FONT_REGISTRY entries and
helper exports were added. `@chris/media/timeline` (browser entry) now also exports
`font-metrics`, `timeline-layout` and `platform-profiles`.

---

## 2026-10-16 — One render engine: EditTimeline v2 rendered exactly, shared pure layout

**Decision.** Every render goes through `renderTimeline`. A plan row's `plan.timeline`
(finishing edit) is rendered as-is; otherwise `planToTimeline` converts the AI's EditPlan to
an explicit Timeline first. All geometry/typography/zoom/grade math lives in the pure
`timeline-layout.ts`, which the browser preview imports too; only glyph measurement is
injected (`MeasureText`: opentype.js on the server, canvas `measureText` in the browser).

**Alternatives.** (a) Reimplement layout separately in the editor — guaranteed drift.
(b) Render previews server-side — too slow for scrubbing.

**Rationale.** "What the editor previews is what renders" only holds if both sides run the
same code with the same fonts.

**Reversibility.** High — the legacy `renderVideo` (EditPlan renderer) is kept, untouched,
for its existing tests; only the worker switched. Switching back is a one-function change in
`render-job.ts`.

## 2026-10-16 — Legacy renderer kept; worker routed through the timeline engine

**Decision.** `renderVideo` + its tests stay as they were (they cover `targetDimensions:
null`, a `fontPath` override, and per-phrase caption relocation that a Timeline cannot express).
`renderContentItem` uses `timelineForPlan` + `renderTimeline`. `options.fontPath` is accepted
but ignored (fonts come from FONT_REGISTRY). `mapEditPlanToRenderInstructions` stays exported.

**Alternatives.** Rewrite `renderVideo` as `planToTimeline → renderTimeline` — breaks
several legacy pixel expectations (relocated captions, native framing) for no product gain.

**Reversibility.** High. The legacy renderer can be deleted once nothing imports it.

## 2026-10-16 — A present-but-invalid finishing edit FAILS the render; foreign assets refused

**Decision.** If `plan.timeline` exists but fails `EditTimelineSchema`, the render attempt is
recorded FAILED (`InvalidFinishingEditError`) — it does NOT fall back to the AI plan. A
timeline clip that references a MediaAsset of another ContentItem also fails the attempt.

**Rationale.** Falling back would silently discard Chris's edit and could publish the AI cut
he overrode. Cross-item assets are a data-integrity/security hole.

**Reversibility.** High (one branch in `timelineForPlan`).

## 2026-10-16 — One ffmpeg input per CLIP (accurate input seek), not per asset

**Decision.** Each clip is its own `-ss start -t (dur+0.5) -i take` input, then trimmed exactly
in the graph. The brief suggested one input per distinct asset.

**Alternatives.** One input per asset with `trim` per clip (the legacy approach).

**Rationale.** Clips may come from any point of any take in any order (e.g. the hook pulled
from the end of the take to the front). With one shared input, ffmpeg decodes the stream once
and queues every decoded frame a *later* clip needs while `concat` is still consuming earlier
ones — raw 1080x1920 frames are ~3 MB each, so a 60 s out-of-order edit can buffer gigabytes.
Per-clip inputs with input seeking decode only what each clip needs. Input seeking is
frame-accurate when transcoding (ffmpeg's default accurate_seek).

**Reversibility.** High (input construction is one loop).

## 2026-10-16 — Frame-aligned clip lengths; output fps 30 (60 when every source >= 50 fps)

**Decision.** Clip k gets `round(end_k*fps) - round(start_k*fps)` frames (end_k = cumulative
output end); its audio is trimmed/padded to exactly that many frames' duration. Mixed sources
are normalised to fps F, SAR 1, yuv420p, 48 kHz stereo fltp. F = 60 if every clip's source is
>= 50 fps, else 30. Audio-less takes get `anullsrc` silence. Clips that end up to 0.1 s past
their source hold the last frame (warning); further past = `RenderSegmentOutOfBoundsError`.

**Rationale.** Per-clip `ceil(d*fps)` rounding drifts captions/audio by up to a frame per cut
(0.66 s over 20 cuts); frame alignment bounds drift to half a frame regardless of cut count
(unit-tested). 60 fps sources keep their motion for platforms that accept 60.

**Reversibility.** High.

## 2026-10-16 — Zooms: perspective filter on the canvas, per-frame expression; semantics

**Decision.** All zooms are one `perspective` filter after concat, `eval=frame`, cubic
interpolation, driven by the frame index (`T = (in-1)/fps` — perspective's `in` is 1-based,
verified by a frame-exact test). Semantics: the focal point (x, y) stays fixed on screen
(CSS `transform-origin`); CUT = instant; EASE = ease-in-out cubic from 1 to `zoom` over
`easeSeconds` from `start`, then hold; every zoom cuts back to 1 at `end`. Zooms are sorted,
clamped to the video, and a zoom overlapping an earlier one is skipped with a warning
(`normalizeZooms`, shared with the preview).

**Alternatives.** `zoompan` (integer-rounded crop → visible jitter); split + static crops per
frame (huge graphs, still integer jitter); scale with `eval=frame` (variable frame size breaks
downstream filters).

**Rationale.** Sub-pixel sampling = no jitter; test asserts the eased push-in tracks the
analytic curve within 2.5 px every other frame. Cost ≈ 10 ms/frame, only when zooms exist.
Zooms resample the 1080x1920 canvas (not the original source), so a zoom on a 4K source is
slightly softer than a source-resolution re-crop would be — negligible for phone footage
(already ~canvas resolution); clip `crop.zoom` *does* resample the source.

**Reversibility.** High (`zoomFilter`).

## 2026-10-16 — Grade mapping and precedence

**Decision.** Effective grade = `GRADE_PRESET_VALUES[preset]` with every explicitly
NON-neutral field overriding the preset's value for that field (`resolveGrade`; a field left at
neutral means "use the preset"). Mapping: brightness/contrast/saturation → `eq` (same
parameters); temperature t → `colorchannelmixer` gains R = 1 + 0.10t, G = 1, B = 1 − 0.12t;
vignette v → `vignette=angle=v·π/3` (darkening = cos(angle·d)^4, d = distance from centre /
half-diagonal). Grade is applied after zooms and BEFORE texts/captions (type is never graded).

**Alternatives.** `colortemperature` (Kelvin model — not reproducible in CSS), `colorbalance`.

**Rationale.** Linear channel gains are exactly reproducible in the browser (SVG
`feColorMatrix`), so preview = render.

**Reversibility.** High (`gradeFilters`, `temperatureGains`, `vignetteAngle`).

## 2026-10-16 — Typography: explicit layout, no kerning anywhere, libass positioned by measured metrics

**Decision.** Texts: drawtext (`textfile=` + `expansion=none`) per laid-out line at an exact
baseline; plates are rounded rectangles drawn by libass vector drawing underneath. Captions:
libass, one event per line at `\an7\pos(lineLeft, baseline − winAscent·px/upm)` with ASS
`Fontsize = px·(winAscent+winDescent)/upm` — both relations measured for all 15 fonts
(`font-metrics.ts` is generated from the TTFs and a test keeps it in sync). Fonts are selected
by full name (name ID 4) via `fontsdir`. `Kerning: no` in ASS; drawtext does not kern; the
preview must set `font-kerning: none`. Line wrapping = greedy + balanced re-wrap (same
function both sides). Explicit `\n` in a text = hard line break.

Not carried over from the legacy presets (not expressible in the contract): the LOWER_THIRD
accent bar and the NUMBER_CALLOUT drop shadow. Text sizes are fixed per element (no auto-fit
in the renderer); `planToTimeline` performs the old auto-fit once, at conversion.

**Reversibility.** Medium — changing any LAYOUT constant changes renderer AND preview together.

## 2026-10-16 — Captions sit at one explicit y; planToTimeline picks a free band

**Decision.** The renderer no longer moves individual caption phrases around overlays (the
Timeline is explicit and WYSIWYG). `planToTimeline` puts captions in the plan's band (LOWER/
CENTER) unless a text occupies it, then the other band, then just above the colliding text.
`technicalQCReport.captions.relocatedAroundOverlays` is now always 0 (key kept). The quality
gate checks a finishing edit's own texts (text/text and caption/text rect intersections while
both are visible — `findTimelineCollisions`, same layouts the renderer drew); plain plans keep
the legacy checks exactly (as briefed), even though they now render via planToTimeline.

**Follow-up.** Switch the plain-plan gate check to `findTimelineCollisions(planToTimeline(…))`
too, so the gate checks exactly what rendered; kept legacy now to avoid changing gate behaviour.

## 2026-10-16 — Fonts: 12 OFL fonts added, variable families instanced to static TTFs

**Decision.** Added Montserrat ExtraBold/Black, Poppins Bold/ExtraBold, Archivo Black, Space
Grotesk Bold, Bebas Neue, Anton, Oswald Bold, Roboto Condensed Bold, DM Serif Display,
Playfair Display Bold (15 total incl. the 3 Inter). Source: google/fonts `ofl/*`. Families
that only ship variable fonts there (Montserrat, Oswald, Playfair, Space Grotesk, Roboto
Condensed) were instanced at the needed weight with fontTools `instancer` (name tables
updated) so FreeType/libass/opentype.js/the browser all see one static face. Licenses live in
`packages/media/assets/licenses/` — NOT in `fonts/`, because libass loads every file in its
fontsdir. Archivo Black is registered at weight 400 (its OS/2 class) although it looks black.

**Reversibility.** High.

## 2026-10-16 — Master render = mezzanine; per-platform variants re-encoded from it

**Decision.** Master: libx264 High, preset `slow`, CRF 16, closed 2 s GOP, BT.709 tags,
yuv420p, AAC-LC 320 kbps 48 kHz stereo, loudnorm −14 LUFS / −1.5 dBTP (single pass; skipped
when every clip is silent — loudnorm cannot process pure digital silence), faststart.
Variants (`encodePlatformVariant`) per `PLATFORM_PROFILES`: canvas 1080x1920, master fps
capped at 60, H.264 High 4.2, closed GOP (IG/TikTok 2 s; YouTube 0.5 s = "half the frame
rate" per its official recommendation, overriding the ~2 s suggestion), 2 B-frames, CRF +
VBV maxrate per platform/fps, AAC-LC 48 kHz stereo (IG 128k per Graph API spec, TikTok 192k
— no official figure, YouTube 384k per official), TWO-PASS loudnorm (measure, then apply with
measured values, `linear=true`) to the profile target, faststart. Over `maxFileSizeBytes` →
one retry at a computed average bitrate (~92 % of the cap; refuses below 300 kbps video) →
`VariantTooLargeError`. Optional cover JPEG at `coverFrameSeconds`.

**Measured.** 8 s two-take timeline (2 texts, captions, 2 zooms, grade) master at preset slow:
~8.2 s render on this Mac (M-series) ≈ 1x realtime; veryfast ≈ 4–6.6 s. Variant encode of a
4 s master: ~1 s per platform at veryfast.

**Known limitation.** ffmpeg's native AAC encoder undershoots high targets on simple material
(384k requested → ~240k measured on pink noise); libfdk_aac isn't in ffmpeg-static. Platforms
re-encode audio anyway; revisit if a platform rejects.

### Platform sources (checked 2026-10-16)
- Instagram Graph API media reference (MOV/MP4, H.264/HEVC, closed GOP, 4:2:0, 23–60 fps,
  max width 1920, VBR ≤ 25 Mbps, AAC ≤ 48 kHz 128 kbps, 3 s–15 min, 300 MB, moov first,
  `thumb_offset` ms / `cover_url`):
  https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
- Meta Reels ads safe zone (14 % top / 35 % bottom / 6 % sides → 269/672/65/65 px):
  https://www.facebook.com/business/ads-guide/update/video/instagram-reels — ads placement;
  Meta publishes no organic figure.
- TikTok Content Posting API (MP4/WebM/MOV, H.264 recommended, 23–60 fps, 360–4096 px,
  4 GB, up to 10 min; real cap per creator from creator_info):
  https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide ;
  `video_cover_timestamp_ms`: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
- TikTok safe zone: NO official pixel figure (TikTok ships overlay templates that vary by
  caption length — https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads). Community
  measurements range top 130–254, bottom 350–707, right 120–242 px; we use the conservative
  240/660/60/160.
- YouTube recommended upload encoding (H.264 High, progressive, CABAC, 2 B-frames, closed
  GOP of half the frame rate, 4:2:0, 1080p SDR 8 Mbps @24–30 / 12 Mbps @48–60, AAC-LC
  stereo 48 kHz 384 kbps, moov first): https://support.google.com/youtube/answer/1722171 ;
  Shorts ≤ 3 min: https://support.google.com/youtube/answer/15424877 ; 256 GB:
  https://developers.google.com/youtube/v3/docs/videos/insert
- YouTube Shorts safe zone 288/672/48/192 px: Google Ads vertical-video guidance
  (https://support.google.com/google-ads/answer/9128498), shown as an image there; px values
  as consistently transcribed by community tools — ads guidance, not an organic Shorts spec.
- YouTube Shorts thumbnails: no cover-timestamp field in the API; `thumbnails.set` is
  best-effort for Shorts (custom Shorts thumbnails reached desktop Studio for YPP creators in
  2026; API effect unverified).
- Loudness: no platform publishes an official target for short-form; YouTube's ~−14 LUFS
  playback normalisation is measured, not documented. −14 LUFS / −1 dBTP chosen everywhere
  (conservative, common practice).

---

## VARIANT INTEGRATION

Call contract for the integrator (no DB/worker wiring was built here):

```ts
import { encodePlatformVariant, PLATFORM_PROFILES, checkAgainstProfile, probeVariant,
         VariantTooLargeError } from "@chris/media";

const res = await encodePlatformVariant({
  masterPath,                       // local path of the SUCCESS Render's mp4 (the master)
  outputPath,                       // e.g. <tmp>/<renderId>-INSTAGRAM.mp4
  profile: PLATFORM_PROFILES.INSTAGRAM,  // | TIKTOK | YOUTUBE
  coverFrameSeconds,                // optional: PlatformPackage.coverFrameSeconds
  // preset?: "slow" (default) — tests pass "veryfast"
});
// res: { outputPath, width, height, fps, durationSeconds, fileSizeBytes, videoBitrateKbps,
//        audioBitrateKbps, integratedLufs, truePeakDbtp, coverImagePath?, retriedForSize,
//        issues: ProfileIssue[], ffmpegArgs }
```

- Throws `VariantTooLargeError` when the cap can't be met after one retry (treat as a
  per-platform failure; other platforms proceed — graceful degradation).
- `res.issues` is `checkAgainstProfile(probeVariant(output), profile)`; persist it and block
  publishing on any `severity: "BLOCKING"` issue. Preflight of any file: `checkAgainstProfile(
  await probeVariant(path), profile)`.
- Suggested `RenderVariant` row: renderId, platform, storageKey, sha256, width, height, fps,
  durationSeconds, fileSizeBytes, videoBitrateKbps, audioBitrateKbps, integratedLufs,
  truePeakDbtp, coverStorageKey, retriedForSize, issues (Json), ffmpegArgs (Json), createdAt.
  Idempotency key: (renderId, platform, profile version).
- Cover: IG → upload cover JPEG as `cover_url` or pass `thumb_offset = round(coverFrameSeconds
  *1000)`; TikTok → `post_info.video_cover_timestamp_ms`; YouTube → no timestamp; optionally
  `thumbnails.set` with the JPEG (best-effort).
- Typical cost: ~1 s per 4 s of video per platform at veryfast; "slow" ~2–3x that.

---

## PREVIEW PARITY NOTES

Everything below is implemented in `@chris/media/timeline` (browser-safe). **Call the
functions instead of re-deriving the math**: `cropGeometry`, `normalizeZooms`, `zoomStateAt`,
`zoomWindow`, `resolveGrade`, `temperatureGains`, `vignetteAngle`/`vignetteFactor`,
`layoutTimelineText`, `layoutCaptionChunk`, `captionPlateColor`, `normalizeTexts`,
`timelineCaptionChunks`, `findTimelineCollisions`, `LAYOUT`, `FONT_METRICS`,
`PLATFORM_PROFILES`. Coordinates are canvas px (1080x1920 by default); scale the preview by
`previewWidth / canvas.width`.

**Fonts / measurement.** `@font-face { font-family: <FONT_REGISTRY.family>; src:
url(/api/fonts/<file>); font-weight: <weight>; }`, render with `font-weight` = the registry
weight (no synthetic bold). Provide `measureText(text, fontId, px)` =
`ctx.font = \`${weight} ${px}px "${family}"\`; ctx.fontKerning = "none"; ctx.measureText(text).width`
(wait for `document.fonts.load`). All DOM/canvas text must use `font-kerning: none;
font-variant-ligatures: none; letter-spacing: 0`. `fontPx = round(fontSize · canvas.width/1080)`.

**Clip crop / pan** (`cropGeometry(sourceWH, canvas, crop)`):
`cover = max(W/sw, H/sh)`, `s = cover·zoom`, video drawn at `sw·s × sh·s`, translated by
`(−offsetX, −offsetY)` with `offsetX = (sw·s − W)·(panX+1)/2`, `offsetY = (sh·s − H)·(panY+1)/2`.
(Renderer rounds the scaled size to even px and the crop offset down to even px: ≤ 2 px.)
Use the video's *displayed* (rotation-corrected) `videoWidth/videoHeight`.

**Zoom** (output-time `t`; zooms from `normalizeZooms(timeline.zooms, duration)`):
`{zoom, x, y} = zoomStateAt(zooms, t)`; apply to the whole composited video layer (after the
clip crop, BEFORE grade, under texts/captions): CSS `transform-origin: (x·100)% (y·100)%;
transform: scale(zoom)`. EASE: `zoom(t) = 1 + (Z−1)·e(p)`, `p = clamp((t−start)/easeSeconds,0,1)`,
`e(p) = p<0.5 ? 4p³ : 1 − (−2p+2)³/2`; CUT = Z inside `[start,end)`; back to 1 at `end`. The
renderer evaluates at frame times `n/fps` — sample the preview at the same `t` when paused.

**Grade** (`g = resolveGrade(timeline.grade)`), on the video layer only (not on text):
exact match via an SVG filter (`filter: url(#grade)`):
1. contrast/brightness: `feComponentTransfer` with each of R,G,B `type="linear"
   slope=g.contrast intercept=0.5·(1−g.contrast)+g.brightness` (ffmpeg eq: `v' = c(v−0.5)+0.5+b`;
   eq applies it to luma — RGB application differs imperceptibly).
2. saturation: `feColorMatrix type="saturate" values=g.saturation`.
3. temperature: `feColorMatrix type="matrix"` diagonal `(r,1,b)` from
   `temperatureGains(g.temperature)` = `(1+0.10t, 1, 1−0.12t)`.
CSS-only fallback (approximate): `brightness(1+g.brightness) contrast(g.contrast)
saturate(g.saturation)` and for temperature t>0 `sepia(0.25t) saturate(1+0.2t)`, t<0
`hue-rotate(${-12·|t|}deg) saturate(1−0.1|t|)` — prefer the SVG path.
4. vignette (`g.vignette > 0`): overlay a `radial-gradient(circle farthest-corner at 50% 50%, …)`
   in black with alpha at radius fraction d = `1 − vignetteFactor(v, d)` (sample d = 0, 0.1,
   … 1.0 as gradient stops); `vignetteFactor = cos(v·π/3 · d)^4`, d = distance from centre /
   half-diagonal (a CIRCLE to the farthest corner = half-diagonal, matching ffmpeg's dmax with aspect 1). Use
   `mix-blend-mode: normal` black-with-alpha (= multiply by factor).

**Texts** (`L = layoutTimelineText(text, canvas, measureText)`; draw only for
`start ≤ t < end`; use `normalizeTexts` for clamping):
- lines: `L.lines[i]` → draw `text` with the alphabetic baseline at `baseline`, left edge
  at `x` (canvas `fillText(text, x, baseline)` with `textBaseline="alphabetic"`; in DOM, absolutely
  position a span whose baseline lands there). Colour = `color` (alpha from #RRGGBBAA).
- layout rules (already applied by the function): `lineHeight = round(fontPx·1.18)`; plate pad
  `padX = round(fontPx·0.40)`, `padY = round(fontPx·0.24)`, radius `round(fontPx·0.18)`; when no
  plate, pad = stroke width; wrap width `maxWidth·W − 2·padX`; block = widest line + 2·padX by
  lines·lineHeight + 2·padY, centred at (x·W, y·H) then clamped inside the canvas; each line's
  cap height is vertically centred in its line box: `baseline = lineTop + (lineHeight +
  capHeight/upm·fontPx)/2`; align left/center/right inside the block.
- plate: rounded rect `L.plate.rect`, radius `L.plate.radius`, fill `backgroundColor` (alpha).
- stroke: `L.strokeWidth = max(1, round(fontPx·0.045))` px OUTSIDE the glyph (drawtext
  `borderw`). CSS/canvas: stroke width `2·strokeWidth` painted UNDER the fill
  (`paint-order: stroke fill; -webkit-text-stroke: 2·sw color` or canvas `strokeText` with
  `lineWidth = 2·sw`, `lineJoin="round"` then `fillText`).
- `uppercase` → `toUpperCase()` before measuring; `\n` = hard break.

**Captions** (chunks from `timelineCaptionChunks(timeline, wordsByAsset)`; a chunk shows for
`chunk.start ≤ t < chunk.end`; `C = layoutCaptionChunk(chunk, timeline.captions, canvas,
measureText)`):
- geometry: `lineHeight = round(fontPx·1.15)`; wrap width `0.78·W − 2·padX`; block centred
  horizontally on the canvas and vertically at `captions.y·H`, clamped; lines centred; baseline
  = cap-height-centred as for texts; word boxes `C.lines[i].words[j].{x,width}`.
- stroke (`strokeColor` non-null): `round(fontPx·0.055)` px outside glyphs (libass `\bord`),
  same CSS technique as texts.
- plate: BOXED always (`backgroundColor ?? #000000B3`); other presets only when
  `backgroundColor` is set. Pad `padX = round(fontPx·0.36)`, `padY = round(fontPx·0.20)`,
  radius `round(fontPx·0.24)`; one plate around the whole block (`C.plate.rect`).
- CLEAN: phrase in `color`; soft drop shadow offset `C.shadowOffset = max(1,
  round(fontPx·0.035))` px right AND down, colour `#00000080`, no blur (`text-shadow: s s 0
  rgba(0,0,0,.5)`).
- BOLD_HIGHLIGHT: phrase in `color`; the active word in `highlightColor`. Word i is active from
  (i == 0 ? chunk.start : word.start) to (i == last ? chunk.end : nextWord.start). No scale/
  weight change.
- BOXED: phrase in `color` on the plate (no highlight).
- KARAOKE: each word fills left→right from `color` to `highlightColor`: word i sweeps from
  `word.start` to `nextWord.start` (last word: `word.end`), linear in time across the word's
  box width (`fill fraction = clamp((t − start)/(end − start), 0, 1)`); filled words stay
  highlighted; implement as a clip-rect over a highlight-coloured copy of the word. (libass
  `\kf` timing is quantised to 10 ms.)
- `uppercase` and `wordEdits` are already applied by `timelineCaptionChunks`.

**Platform safe zones.** Overlay `PLATFORM_PROFILES[id].safeZone` (px at 1080x1920; scale with
the canvas) — `combinedSafeZone()` for "post everywhere". Same numbers preflight uses.
