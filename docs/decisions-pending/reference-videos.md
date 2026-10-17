# Reference videos: upload + deterministic style measurement (2026-10-17)

Chris asked: "can I add the reference videos in the app?" He wants his auto-edits to feel like
the creators he admires (Alex Hormozi, Shelby Sapp…): cut timing, pacing, hooks, endings, audio
balance. This adds the upload and a free (no-AI) measurement of those things, aggregated into a
plain-English "style fingerprint" per creator and overall, plus a typed aggregate
(`getReferenceStyleProfile`) for the edit planner to use later. **No agent or the edit planner
was rewired.**

---

## Decision 1 — Reference videos are ReferenceContent rows with media + metrics (additive migration)

`20261017180000_reference_videos` adds nullable columns to `ReferenceContent`:
`mediaStorageKey, mediaFilename, mediaMimeType, mediaSizeBytes, mediaUploadedAt, mediaDeletedAt,
analysisStatus (enum PENDING|DONE|FAILED), analysisError, analyzedAt, metrics (jsonb),
metricsVersion` + an index on `analysisStatus`. Existing notes-only rows are untouched (all
null) and still render under "Written notes & AI observations". `metrics` is
`ReferenceVideoMetrics` (`packages/domain/src/style-metrics.ts`, zod, `version: 1`), validated on
every write (`recordReferenceAnalysis` — a malformed result is stored as a FAILED analysis, never
half-written) and on every read (`parseReferenceVideoMetrics`; rows that don't parse are skipped
by the aggregate). An uploaded video's `description` is `""` (the column is required; uploads have
no prose); a creator created from the upload screen gets only its name (`brandPositioning: ""`).

*Alternatives:* a new `ReferenceVideo` table (cleaner, but splits "a piece of reference content"
in two and duplicates the creator relation and the existing observations link); typed columns per
metric (rigid — the metric set will grow; zod-versioned JSON keeps it typed without migrations
for every new number). *Reversibility:* high — additive columns; dropping them loses only the new
data.

## Decision 2 — Upload reuses the take plumbing, under its own private prefix

Keys are `reference/<creatorId>/<ts>-<safe filename>` in the same storage adapter (private Blob in
production, `.storage/` locally). Local mode streams to a new `PUT /api/reference-upload` (same
pattern as `/api/upload`); blob mode uploads browser-direct to private Blob — `/api/blob-upload`
now also issues tokens for `reference/<creator>/<file>` (video/* only) — then the
`registerReferenceBlobUpload` action records it (idempotent per storage key). The key prefix can
never match a take's `raw/<item>/…` key, and nothing in the render/publish path reads
`ReferenceContent`.

UI (`/reference/add`, phone-first): pick a creator or "＋ Someone new…" (name), pick many videos
at once (iOS Photos/Files multi-select; `accept="video/*" multiple`), optional link per video,
two uploads in parallel with per-file progress, "Retry failed" re-sends only failures, works with
20+ files (each file is independent; the only per-batch step is one creator lookup). When the
batch is in, measuring starts automatically and its progress shows on the same screen.

## Decision 3 — Measurement is a new heavy-job kind, `reference-analyze`, with a library-wide lease

Runs through the existing dispatcher: in-process locally, in the Vercel Sandbox on the live site,
JobRun progress ("Measuring video 3 of 12 (IMG_1021.mp4)…") polled via `/api/jobs/[id]`.
Heavy-job leases were keyed by content item; reference analysis has none, so
`heavyJobSubject(kind, args)` (`apps/worker/src/heavy-job-kinds.ts`) returns the content item for
every existing kind (unchanged behaviour) and `"reference-library"` for this one — **one measuring
job for the whole library at a time**; a second tap follows the running job. The job re-reads the
queue until nothing new is waiting (videos uploaded while it runs are included), one failure never
stops the rest, and it stops starting new videos 8 min before the sandbox's hard timeout (the rest
stay PENDING; the page offers "Measure now"). Needs no model key (`heavyJobNeedsModel` false), so
a draining worker without the key may pick it up. `runHeavyJob` gained `background: true` for
inline mode (start in-process, return `started` with the JobRun id) so a 20-video job doesn't
block a local server action. `--offline` supports `reference-analyze` for snapshot verification.

**Operator: the Vercel Sandbox snapshot must be rebuilt** (scripts/sandbox/create-snapshot.ts
`--base <current>`) before this works on the live site — the current snapshot's runner doesn't
know the new kind and will fail it clearly ("unknown job kind"). Nothing new to download: it uses
ffmpeg + the Whisper model already in the snapshot.

## Decision 4 — Deterministic metrics, $0, no model calls

Per video (`apps/worker/src/reference-analysis-job.ts` → `packages/media/src/style-analysis.ts`
for measurement, `packages/domain/src/style-metrics.ts` for the math):

- **Video:** duration, display width/height (phone rotation honoured), aspect label, fps.
- **Cuts:** one ffmpeg pass decodes to 72×128 grey frames (and ffmpeg's scene score on a 240-px
  copy, each frame's own timestamp — VFR-safe). A cut = a one-frame **spike** in mean absolute
  luma change (≥ 4/255 and ≥ 2× the max of the 3 frames each side), or scene score ≥ 0.15, or
  change ≥ 30; candidates closer than 0.25 s keep the stronger. Why a spike detector: a talking-head
  jump cut barely moves ffmpeg's scene score (same background, same framing), but it is a sudden
  one-frame jump while continuous motion changes smoothly. The ±3-frame window was added after a
  grainy 360p encode "pulsed" every 3 frames (B-frames) and produced false cuts at ±2.
  From the cuts: count, times, shot length median/p25/p75, cuts per 10 s, first cut, pacing
  (cuts/10 s in the first 3 s, middle, last 3 s).
- **Speech** (the same local Whisper `base.en` word timings Chris's takes use): words per minute
  over the speech span, gaps between words (median, p90, longest), pauses ≥ 0.3 s per minute, the
  hook (first sentence by punctuation or a ≥ 0.7 s silence; a 1–2-word opener like "Okay." runs on
  into the next sentence; capped at 25 words) + its duration, when talking starts, the last
  sentence, seconds after the last word, whether it ends right on the last word (≤ 0.3 s), whether
  there's a cut after the last word (closing shot / end card). Transcript text stored (≤ 6000 chars).
- **Audio:** EBU R128 integrated loudness, loudness range, true peak (ebur128) and sample peak /
  peak count / flat factor (astats) → clipping flag (repeated or flat-topped full-scale peaks, or a
  decoded peak over 0 dBFS — an AAC encode of clipped audio rounds the flat tops off but overshoots;
  measured +0.98 dBFS on a deliberately clipped voice that astats' counters missed).
  **Voice vs background:** voice = energy mean of 20 ms frames inside words; background = the
  2nd-percentile 20 ms frame over the video (a music bed fills every dip between syllables;
  clean speech dips to near silence). "No background" when that floor is ≤ −55 dBFS or ≥ 36 dB
  under the voice. Displayed as "Music sits N dB under the voice", or "Faint background sound,
  N dB under" when ≥ 28 dB down.
- **Left out on purpose:** zoom / punch-in detection as its own metric — punch-ins are detected
  as cuts (34/34 and 23/23 in the studies below), but telling a punch-in from a jump cut, or
  measuring slow digital zooms, would need motion estimation I couldn't make reliable in the time;
  better absent than wrong. Music-vs-room-noise classification (both read as "background sound").

*Alternatives:* a vision/audio model (costs money per video and is less consistent than
arithmetic — CLAUDE.md: deterministic checks get deterministic code); ffmpeg scene score alone
(measured below — much worse on jump cuts); measuring background "between Whisper's words"
(tried first — Whisper's word edges are too loose: it read the voice's own tails as music, e.g.
"present, 26 dB under" on a clip with no music at all).

### Measured accuracy

**Cuts** — synthetic talking-head edits with known cut frames: the public-domain portrait fixture
(and, for the held-out set, a second portrait) animated with three motion styles (tripod sway,
head-bob, fast handheld) + sensor grain, x264 CRF 23, cut like a jump-cut edit removes pauses
(random 0.6–3.2 s segments, 0.3–1.8 s removed between them, 25 % punch-ins at 1.2×). Match
tolerance ±2 frames; matched cuts were frame-exact.

| Set | Cuts | Recall | Precision | Punch-ins found |
|---|---|---|---|---|
| Tuning set (seed 7, portrait A) | 74 | 89 % (66) | 100 % (0 false) | 34/34 |
| Held-out (seed 99, portrait B) | 82 | 85 % (70) | 100 % (0 false) | 23/23 |
| ffmpeg scene score ≥ 0.3 (baseline) | 74 | 51 % | 100 % | — |
| ffmpeg scene score ≥ 0.1 (baseline) | 74 | 81 % | 95 % | — |
| ffmpeg scene score ≥ 0.06 (baseline) | 74 | 92 % | 74 % | — |

By motion style: still/head-bob ≈ 93–100 % recall; **fast handheld ≈ 70 %** (a small jump is
smaller than the frame-to-frame motion itself). Misses are jump cuts where the position barely
changed — also near-invisible to a viewer. Effect: in very shaky footage "cuts every X s" can read
~15–30 % slower than reality; it never invents cuts on these sets. **Not verified on real
creator footage** (none was available) — real jump cuts also change expression/hands, which
should make them easier, but compression and on-screen text animations could add false cuts.
The first real uploads are the real test; `cuts.times` is stored so a spot check is easy.

**Background level** — `say` speech mixed with a synthetic chord+pink-noise bed at known levels:
true 25.8 / 31.8 / 37.8 dB under → measured 28.2 / 34.1 / none (≥ 36); tight speech (silences
removed) + bed 31.8 dB under → 31.5; clean speech → none; tight speech + faint room tone → none.
Bias ≈ +2 dB. Synthetic beds are steadier than real music; real-world error is likely larger.

**Loudness** — EBU Tech 3341 reference tone (1 kHz, −23 dBFS RMS stereo) reads −23 ± 0.5 LUFS
(unit test). **Speech** — Whisper `base.en` on `say` speech: word count / sentences right;
long pauses show up as gaps (a 600 ms inserted silence read as a 0.8 s gap). Gap values are
Whisper's estimate, consistent between references and Chris's takes (same model), which is what
the comparison needs.

## Decision 5 — Aggregation, sample size, plain English

Per creator and overall: the **median across videos** of each video's number (each video counts
once, however long). `confidence`: 0 → none, 1–2 → "early" ("From only 2 videos — an early read;
add a few more for a reliable picture", shown in gold), 3–7 → "fair", 8+ → "solid". Lines only for
numbers that were measured. `getReferenceStyleProfile(prisma, { referenceCreatorId? })` →
`StyleProfile` (typed medians with n/p25/p75, background share, example hooks) is exported from
`@chris/domain` for the edit planner later.

## Decision 6 — You vs them

`getOwnSpeechProfile` computes the same speech metrics from Chris's last 40 raw takes that
already have word timings (no new transcription, no cost) and `compareOwnToReference` says e.g.
"Your pauses are 69% longer than your references' — the edit can tighten them", "You talk 48%
slower", "Your opening line is 3.6× longer than theirs", "You start talking 1.1 s in". Only speech
is compared: raw takes are unedited, so cuts/loudness comparisons would be meaningless. Within
±20 % reads "about the same".

## Decision 7 — Copyright / privacy

Reference videos are other people's work, uploaded for **private analysis only**: stored in the
private store, never served publicly, never an input to a render, never published. "Delete file,
keep numbers" (`deleteReferenceVideoMedia`) removes the file from storage and keeps the
measurement (which still counts toward the style), the link and the audit trail
(`REFERENCE_VIDEO_MEDIA_DELETED`). Every upload / measurement / failure / deletion is audit-logged.
No scraping or downloading from links — Chris supplies the files; the link is just a note.

## Not verified / limits

- The cloud path (sandbox) was not exercised: the snapshot wasn't rebuilt (by instruction). The
  same `executeHeavyJob` code ran in-process locally (e2e) and in the worker test.
- Blob-mode upload (production) not exercised end to end; the local streaming route was.
- No real creator footage was available; accuracy figures are from synthetic clips.
- Whisper `base.en` is English-only.
