# Reference measuring v2: app end cards left out, no-talking videos read right (2026-10-17)

The first real run (17 reference videos on production: Shelby Sapp, Alex Hormozi, Jun Yuh,
Humphrey Yang = talking; Mindset.Therapy = no-face, music + on-screen text) showed two problems:

1. **Instagram's download end card** (≈2–4 s appended: the last frame frozen and dimmed, a
   centred Instagram logo + "@username") was measured as part of the creator's edit. It inflated
   "Ends 4.4 s after the last word", the length, last-3-s pacing, and the audio floor (a silent
   tail drags the "background" floor toward silence). All 17 production videos have it (checked
   on their last frames). TikTok downloads have a similar card (cut to black, animated logo).
2. **No-talking videos were read as talking**: "Starts talking at 19 s" on ~11 s videos, "Hook
   lasts 0.0 s", "No background music — just the voice" on music-led videos. Whisper invents words
   over music; their timestamps can land past the end (then the hook has zero length).

## Decision 1 — Detect the app end card deterministically and measure only up to it

`detectEndCard` (`packages/media/src/style-analysis.ts`) on the last 7 s decoded to 180×320 grey
(`measureTailFrames`, one extra ffmpeg pass with `-sseof`). All four must hold:

1. **Still run at the very end**: walking back from the last frame, consecutive frames whose
   *background* (frame minus the centre box where the logo animates) is the previous frame up to a
   brightness change — least-squares fit `b ≈ α + β·a`, mean |residual| ≤ 1.5/255, 0.6 ≤ β ≤ 1.15.
   A frozen frame fading darker passes; real footage (motion, grain) doesn't. Up to two isolated
   one-frame "refresh" glitches are tolerated (low-bitrate encodes do that on stills). When the
   light drops inside the run (a fade), the card starts where the final drop begins (dark, slow
   motion graphics can read as "still" for a while before the card).
2. **Position + length**: 1–6 s, and it doesn't start before the last spoken word (+0.5 s for
   Whisper's loose word ends; one or two stray words ≥ 1 s after the rest are ignored —
   `lastSpokenWordEnd`).
3. **Darker**: the background's light above video black is ≤ 75 % of the second before it.
   Content that is itself (nearly) black can't be seen to darken → not a card.
4. **Centred logo/handle**: bright pixels (≥ max(150, p90+60, p99.8+15) of the background) in
   the centre box, horizontally centred, 0.2–25 % of the box, almost none outside.

When found, the analyzed video ends at the card start: `durationS` = card start,
`sourceDurationS` = file length, `endCardS` = card length; cuts at/after it dropped; speech, the
ending, pacing, loudness (`ebur128` with `-t`) and voice/background (PCM truncated) all measured on
`[0, cardStart]`; a note says it was left out. The tail decode failing never fails a measurement
(the card check is skipped).

**What it deliberately keeps:** a creator's own closing shot at normal brightness (fails 3), a
fade to black with nothing on it (fails 4), a still held longer than 6 s (fails 2), any still
during which they're still talking (fails 2). **What it would also strip:** a creator's *own*
outro that looks exactly like a platform card (dimmed freeze + centred white handle) — acceptable,
it's equally not part of the edit's pacing.

### Measured accuracy (synthetic, `scratchpad` generator; 540×960, x264)

| Clip | Expected | Result |
|---|---|---|
| IG static (dim 0.45, logo + handle, 3 s) | card @7.33 | 7.333 ✓ |
| IG fade-in 0.5 s, logo at 0.4 s | card @7.33 | 7.333 ✓ |
| TikTok-like (cut to black, animated logo, 2.6 s) | card @7.57 | 7.567 ✓ |
| Dark motion graphics + music + IG fade (Mindset-like) | card @11.0 | 10.967 ✓ |
| IG short 1.8 s / long 4.6 s (dim 0.55) | card | ✓ / ✓ (±1 frame) |
| IG over a dark talking clip | card | ✓ |
| IG low-bitrate (360p, CRF 36) | card | ✓ (needed the glitch tolerance) |
| IG lighter dim (0.6) | card | ✓ (needed the p99.8 threshold) |
| Normal-brightness held last frame + centred text | keep | kept ✓ |
| Bright title card ("SAVE THIS") | keep | kept ✓ |
| Creator fade to black (moving) | keep | kept ✓ |
| Fade to black + 2 s black hold, nothing on it | keep | kept ✓ |
| Normal held frame + centred "@MYHANDLE" | keep | kept ✓ |
| No tail / plain dark music video / plain held frame | keep | kept ✓ |

17/17 (9 cards found to within one frame, 8 endings kept). The **logo test alone** was also run
on the 17 real production end frames (full-res stills saved earlier): 17/17 pass, 0 bright pixels
outside the centre box. The real cards' background light is 1.6–21/255 above black (strongly
dimmed — well inside rule 3). Unit tests: `packages/media/src/__tests__/end-card.test.ts`
(IG static + fade, TikTok, held closing / fade-black / plain kept, "talking continues" rejected,
pure fit + overlay), and an end-to-end worker test.

**Not verified on the real videos**: whether Instagram's card background is truly frozen (if it
were animated outside the centre, rule 1 fails → the card stays in, i.e. today's behaviour), and
whether very dark creators (Mindset.Therapy, 1.6–1.9 light on the card) have enough light before
the card to show the darkening (needs ≥ 1/255 mean above black; estimated ~3–5). The first
"Update measurements" run on production is the real test: the per-video Details row "App end card
3.0 s — left out" makes a spot check easy.

## Decision 2 — Speech only when someone is actually talking

`classifySpeech` (`packages/domain/src/style-metrics.ts`, pure): words outside the video and
non-speech tags ("[Music]", "(upbeat music)", "♪", punctuation) are dropped; then **not talking**
when: < 4 words; ≥ 50 % zero-length words (invented timings); one word ≥ 40 % of 6+ words (a
loop); median word ≥ 0.6 s (singing / stretched); words cover < 20 % of the video; or the
acoustic check says the words aren't ≥ 3 dB louder than the sound ≥ 0.15 s away from any word
(`measureAudioActivity`, 20 ms frames — a voice stands out from its gaps; words invented over
music sit on the same sound). Measured contrast with real Whisper on `say` speech: clean 9–16 dB,
over a music bed 12 dB under 7.7 dB, 6 dB under 7.2 dB → 3 dB leaves margin. Synthetic music
(chords, noise, a sine melody) produced **no** words from Whisper `base.en`, so the hallucination
rules are covered by unit tests with the production pattern (words at 19–21 s on an 11 s video,
zero length) rather than real hallucinations.

Not talking → `speech: null` (no WPM, hook, "starts talking", ending), `transcript: null`
(invented words aren't a transcript), `voice.present: false` + the reason, and
`audio.mix = "music-led"` when ≥ 50 % of 20 ms frames have sound (≥ −45 dBFS) and the integrated
loudness is above −40 LUFS, else `"quiet"`. Talking videos get `"voice"` / `"voice-over-music"`.
On-screen text pace was **left out** (no cheap, reliable deterministic measure).

Guards everywhere: `speechMetrics` drops words that start after the end and won't report a
zero-length hook; `sanitizeReferenceMetrics` (applied on every parse and in aggregation) drops
speech that starts after the video ends / ends > 1 s after it, zero hooks, impossible tails and
first cuts — so **old v1 rows stop showing nonsense immediately**, before re-measuring.

## Decision 3 — Aggregation skips n/a; plain English follows the soundtrack

Medians already skipped nulls; now n/a really is null (above). Additive `StyleProfile` fields:
`talking`, `musicLed`, `endCardsRemoved`. `backgroundPresent`/`backgroundUnderVoiceDb` now count
**talking videos only** (background "under the voice" means nothing without a voice). Cards: a
music-led group says "Music-led — no talking" (no "No background music — just the voice", no
speech lines); "Videos run about N s" adds "Not counting the app's end card…". No existing
`StyleProfile` field was renamed or removed (the edit planner's "style cut" reads it).

## Decision 4 — Version 2 + "Update measurements (improved accuracy)"

`REFERENCE_METRICS_VERSION = 2`; the schema accepts version 1 or 2 (new fields optional), so old
rows stay readable. `metricsVersion` now records the version the numbers were actually measured
with (not the constant). `countOutdatedReferenceVideos` + `requeueReferenceVideos({ outdated })`
(DONE, older version, file still present; audited with `toVersion`); `startReferenceMeasuring`
`{ updateOutdated }`; the existing Measure control on /reference and a creator page shows
"N videos were measured before the latest improvements…" + **Update measurements (improved
accuracy)**, reusing the same heavy job. While waiting, a video keeps its old numbers (shown, and
still counted in the style — `getReferenceStyleProfile` now counts any row with numbers, not only
DONE, so updating never blanks the style; a failed re-measure also keeps its last numbers).

**Operator:** the `reference-analyze` runner changed (new tail decode, classification, v2
schema) → **the Vercel Sandbox snapshot must be rebuilt** before production re-measures with v2.
Until then the old runner writes v1 numbers, which are stored as version 1 and keep showing as
"measured before the latest improvements". No new binaries/models.

**Reversibility:** high — additive schema fields, no migration; reverting the code leaves v2 rows
that the v1 schema would reject (they'd be skipped by the aggregate until re-measured).

## Not verified

- Real Instagram/TikTok downloads (only their last frames); real music with Whisper
  hallucinations; real sung lyrics (treated as not-talking only if drawn-out ≥ 0.6 s median).
- The sandbox path (snapshot not rebuilt, by instruction). Locally: in-process job, unit + worker
  tests, and a visual check of /reference + creator pages at 393×852 on a throwaway DB.
