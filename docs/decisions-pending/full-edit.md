## Full edit (free) (2026-10-18)

Chris: the automatic edit only removed pauses. He wants two automatic choices in the editor — the
current **Cuts only** style cut, and a **Full edit** that is 80–100 % done, **$0** (no Anthropic,
no paid API), with a viral hook first, a tight story said once ("just because I film for 5
minutes does not mean I want it that long… like a conversation where you only need to say things
once… I GAVE YOU REFERENCE VIDEOS"), and graphics from the library matched to what he says. A
paid **AI edit** may come later as a third option. To be merged into `/docs/DECISIONS.md`.

## Decision 1 — Pure deterministic core + local embeddings, in `packages/media/src/full-edit/`

`buildFullEdit(input, embedder)` (pure; browser-safe; the only async part is the injected sentence
embedder) runs the "bots" as code:

| Bot | File | What it does (all deterministic) |
|---|---|---|
| Understand | `understand.ts`, `numbers.ts` | Sentences (Whisper punctuation + measured pauses ≥ 0.7 s); beats from cue phrases (greeting, meta, setup, point, example, number, list step, payoff, CTA, sign-off, tangent, recap, fluff); numbers he said with their word span (digits and spelled out; plan names/years skipped); delivery energy from a 100 ms loudness envelope; topic keywords; topic centrality = cosine to the take's centroid (local MiniLM). |
| Hook | `hook.ts` | Scores every remaining sentence (and a short line + the line that continues it) with evidence: real $/% numbers, contrast/stakes words, bold claims ("most people", "nobody"), "you", question, imperative at the start, 4–16 words, delivery energy, topic centrality; penalties for starting mid-thought ("So/But/And…", pointers), hypotheticals, list steps out of context, the ending (opening on it spoils the payoff) and **no clean pause to cut on (disqualifying)**. Up to 6 candidates (typed, with reasons) for "Try another hook". Moving a line is only done when it beats the natural first line by ≥ 0.6. |
| Hook title | `hook.ts` | ≤ 8 words, from his words/numbers only: "The $10K raise" (number + the noun he said with it), "$5K → 20 years", "2% vs 5%" (only when he compared them), his own question, his opening imperative, his strongest claim clause. The brand's avoid list (`brand/CHRIS_BRAIN.md` + clickbait) is enforced (`TITLE_AVOID`). 3 alternatives, swappable in the editor. Placed above his face when there's room, else between chin and captions, inside the platform-safe area; may cover hair, never the face. |
| Story | `story.ts` | See Decision 2. |
| Visuals | `visuals.ts` | Candidates from `suggestGraphics` (pre-filled with his numbers), list steps as tags in his words, his CTA as a CTA bar. Meaning match = MiniLM cosine (line ↔ preset name/description/tags). **Verification (hard):** every number a graphic shows (`graphicShownNumbers` + digits in its text) must be said **in the line it appears on** (continuity) — a preset whose placeholder numbers survive is dropped; text fields not made of his words are blanked or the graphic dropped. Never a FULL-screen graphic (would hide his face). Density ≈ one per 8 s, ≥ 2 s apart, none during the hook, one per line, variety (each repeat of a preset −0.5). Timed to the number word, held long enough to read (1.4 s + 0.22 s/word). |
| Quality bots | `index.ts` | Placement through the existing engine (`solveVisualPlacements`: face/captions/UI as hard obstacles); a graphic with no clear spot is swapped for the line's next-best graphic and re-checked (bounded, 6 rounds). Retention: a stretch > 7 s with nothing changing on screen gets a slow push-in (bounded). Checks reported (typed `FullEditCheck`): Meaning match, Numbers verified, Continuity, Fact source, Story & pacing (shot lengths vs references, arc), Quality (title vs face, text size, caption collisions via `findTimelineCollisions`, −14 LUFS), Retention (labelled **estimate**). |

Assembly reuses the style cut: `buildStyleCutFromRanges` (new, in `style-cut.ts`) cuts each kept
source range like a take (pause tightening from measured silences, face-centred punch-ins,
frame-aligned clips) and concatenates them in story order (the cold open jumps back). Range edges
sit in the measured pause **where Whisper puts the gap** (best overlap with the word gap, not the
longest nearby pause — the first version cut in the pause *before* "Anyway." and kept it).

## Decision 2 — Condensing: say it once, cut the fluff, fit the references' length

1. **Mechanical:** retakes/false starts keep the LAST complete take (prefix match or ≥ 60 % word
   overlap within 2 lines); restarts inside a line ("a lot of people, uh, a lot of people"), filler
   words, throat-clearing lead-ins ("So basically, I think, I don't know, …") — only when **both cut
   points are on a measured pause** (no clipped words).
2. **Say it once:** MiniLM alone measures *topic*, not *point* — measured on the 3-minute take,
   different points about "the minimum payment" scored 0.70–0.77 while true restatements scored
   0.31–0.63. So similarity is **topic-centred** (each vector minus the take's mean) and combined:
   `0.5·centred cosine + overlap of non-topic words + 0.15 if ≤ 2 lines apart + 0.15 for a
   restatement cue ("basically", "it really is", "in other words", "again"…)`, threshold 0.62 near /
   0.75 far, and the shorter line must add ≤ 1 new word (a line with a new number or claim is a new
   point). The best version stays (most concrete, complete, best delivered).
3. **Fluff out:** greetings, "this video is about…", recaps, sign-offs, tangents ("by the way",
   "funny enough", "one more thing… that's a whole different video") + their continuation lines,
   transition lines ("Anyway, where was I?"), reassurance lines ("I know that's a lot", "it's not
   that complicated"), extra CTAs (one is kept). A tangent with an on-topic number is kept and
   flagged instead.
4. **Start on the hook:** weak set-up/teaser lines before the hook go ("Slow start"); a real claim or
   number before it stays and the hook becomes a **cold open** (moved, played once — replayed in place
   only if the next line points back at it).
5. **Length:** target = the reference videos' median length (`StyleProfile.durationS`, p25–p75 band;
   defaults 58 s / 45–70 s with < 3 references) via `storyTargetFromProfile`. The lowest
   value-per-second units go first (value = beat + topic centrality + real numbers − hedging), a list
   (first step → last step, with its explanations) is one unit, the hook / a context line / the last
   payoff / the CTA are protected, and a line that points back ("That's how they make money") never
   survives without its antecedent (drop both, or keep both when the pointer is protected). If the
   real cut still runs long, the story is re-planned with a lower goal (≤ 4 passes).
6. Every removal carries a kind + plain-English reason; the editor lists them ("Removed lines") with
   one-tap **Restore** (`choices.forceKeep` → new version).

## Decision 3 — Wiring (same rules as the style cut)

- `packages/domain/style-cut-plan.ts`: `plan.fullEdit` (`StoredFullEdit`: summary, typed report,
  choices, cached silences + loudness envelope), `recordAutoFullEdit` (same CAS + advisory lock +
  idempotency + audit as the auto style cut; reason "Full edit (automatic, no AI)"),
  `saveFullEditChoice` (finishing edit = new version), eligibility also replaces an earlier AUTO full
  edit, never anything Chris saved. Choosing Cuts only / plain clears `fullEdit` on that version.
- **Setting** "New uploads get: Full edit | Cuts only" in the Auto edit sheet = feature flag
  `auto_edit.cuts_only` (absent/off → **Full edit is the default**, per Chris). Kill switch
  `FULL_EDIT_AUTO=off`. A multi-part recording gets the style cut (the full edit is one-take). Any
  full-edit failure falls back to the style cut (never leaves him with nothing).
- `apps/worker/style-cut-job.ts`: `maybeAutoStyleCut` runs the full edit when the mode is FULL;
  `applyStyleCutChoice(…, "FULL", choices)` for the editor. Embeddings: local
  `Xenova/all-MiniLM-L6-v2` via `@chris/media/embeddings`, degrading to the hashed-word embedder (id
  says so) if the model can't load; `FULL_EDIT_EMBEDDINGS=lexical` forces it (tests).
- Editor: the "Style cut" tool is now **Auto edit** (phone toolbar + desktop tab): Full edit (free) /
  Cuts only / AI edit (disabled, "Needs AI credit — coming later"); summary ("Hook: '…' (moved to the
  start) · 3:22 → 1:00 · kept 17 of 45 sentences · removed 1 repeat, 2 retakes, 20 fluff lines, 5
  tangents…"), Try another hook + all hook options with reasons, hook-title chips (local edit),
  per-graphic Remove (local edit), Removed lines + Restore, checks.
- **Render parity:** visuals are AUTO-placed by the same engine the renderer re-runs
  (`resolveVisualPlacements`) — unit-tested to be a no-op on the full edit's output; evidence renders
  used the worker's own `prepareMotion` (Remotion layer + SFX kit) + `renderTimeline`.
- **FACTUAL gate unchanged:** an on-screen number still needs a research/script source before
  publishing. The full edit only shows numbers he said, but a video without a gated script/research
  will get a FACTUAL block for them — the "Fact source" check says so up front. (Alternative
  rejected: treating his transcript as a source — that would quietly weaken a hard gate.)
- Music: none — the repo has no licensed track that is a MediaAsset; SFX come from the procedural kit
  (entrance pops/ticks, one soft whoosh at the cold-open cut).

## Extension point — the AI edit (later)

`buildFullEdit` is the executor + checker; an "AI edit" only needs to supply better *decisions*
(hook index / custom hook span, story keep/drop per sentence with reasons, graphic picks) through
the same `choices`/report shape, and everything after (assembly, placement, verification, checks,
versioning, editor UI) is reused. Nothing in this feature calls a paid model.

## Honest quality ceiling (free/local vs an LLM)

- **Better than expected:** retakes, greetings, sign-offs, tangents with cue phrases, recaps, filler
  lines, slow starts, list integrity, dangling pointers, length fitting, number grounding, clean cuts.
- **Weak spots an LLM would fix:** paraphrase detection without lexical overlap (MiniLM is
  topic-dominated; a restatement with all-new words survives); tangents without a cue phrase; judging
  *which* claim is the most surprising (scoring is keyword-based — "Nobody starts with $18,000" wins,
  but a subtle insight with no numbers or contrast words won't); titles are templates, not
  copywriting; graphics are chosen per line by rules (no cross-line story graphics like a running
  comparison); Whisper mis-hearings ("raise" → "race") flow into titles/captions.
- **Space for graphics** around a centred head is small under the existing platform-safe zone: big
  components (month grid, steps list, charts) usually have no clear spot and get swapped for compact
  ones (big number, stat card, step tags, CTA bar). Step tags/CTA bars are small type (~28 px).

## Evidence (`docs/evidence/2026-10-18-full-edit/`)

Test takes: macOS `say` monologues over a moving portrait framed like an arm's-length selfie (eyes
≈ 1/3 height), real Whisper `base.en`, real face tracker, real silence/loudness analysis, live
reference profile numbers (60 s median, 44–71 s). Renders with the real renderer (Remotion layer +
ffmpeg), audio checked at every splice (speech-level energy within 30 ms of a cut = a clipped word:
**0 of 50 splices** across the four full edits), and the output re-transcribed by Whisper to prove
what is heard.

| Take | Cuts only | Full edit | Hook (why) | Graphics |
|---|---|---|---|---|
| t1 raise (63 s; greeting, restart, teaser, tangent, list, CTA) | 53.0 s | **34 s**, kept 13/18 | "My friend got a $10,000 raise last year." — real $ amount, short, stakes; slow set-up lines dropped so the video starts on it | $400/month big number, 3 step tags, CTA bar |
| t2 401(k) (62 s; meta intro, sentence retake, tangent, comparison) | 49.5 s | **30 s**, kept 9/14 | "Most people leave free money on the table every single year…" — bold claim + stakes (5.08 vs 3.30) | $3,000 big number, 2% big percent, CTA bar ("Comment match") |
| t3 emergency fund (47 s; meta, restart "it's, um, it's", tangent, steps, CTA) | 40.4 s | **29 s**, kept 12/16 | "Nobody starts with $18,000." — cold open (moved from 12 s), bold claim + number | $3,000/month, 3 step tags |
| t4 rambly credit-card monologue (**3:22**, 45 sentences: restarts, repeats, two tangents, recap, reassurance, sign-offs) | 2:49 | **1:00**, kept 17/45 — removed 1 repeat, 2 retakes, 20 fluff/slow-start lines, 5 tangent lines, 1 for length | "20 years. For $5,000." — cold open; title "$5K → 20 years" | $5K stat card, $8K, $50 big numbers, CTA bar |

**t4 heard after the full edit (Whisper on the output):** "20 years for $5,000, I actually ran the
numbers on this last week because I was curious. If you owe $5,000 at 24% interest and you only pay
the minimum, it takes you about 20 years to pay it off and you pay almost $8,000 in interest. So the
minimum payment is designed to keep you in debt. The longer you're in debt, the more they make, what
do you actually do about it? Okay so first, pay more than the minimum, even if it's just $50 more,
$50 a month extra cuts years off the payoff. Second, pay the card with the highest interest rate
first. That's called the Avalanche method. Third, and this one is important. Stop using the card
while you're paying it off. Because if you keep using it, you're just, you're filling the bucket
while you're trying to empty it. So the bottom line is, the minimum payment is the most expensive way
to pay off your card. Pay it down faster and keep the interest for yourself. If this helped, follow
for more." (Before: `t4.txt`, 3:22 — greeting, "this video" meta, three set-up restatements,
"kind of insane", gym tangent ×3, "where was I / Right", "designed to keep you in debt" said twice,
"biggest traps" said twice, recap, "I know that's a lot", "not that complicated", balance-transfer
tangent, "And, ah, yeah. That's it. See you guys.")

Editor at 393×852 (throwaway PGlite + dev server on 55471/3671): upload → captions → the editor
opens on the automatic Full edit with the toast; Auto edit sheet (`shot-2-sheet.png`), Removed lines
(`shot-3-removed.png`), Restore (0:29 → 0:30, the line is back), Try another hook (new version, new
hook), Cuts only (new version) — all saved versions, undoable.

## Not verified

Real iPhone footage of Chris (only `say` + a portrait); real reference re-measurement (profile
numbers taken from the live 2026-10-17 measurement); the Vercel cloud path (web-side trigger without
measured silences uses Whisper-gap cuts until the cloud ingest refreshes — same as the style cut;
MiniLM inside a Vercel function untested — falls back to the word embedder); the Quality Gate's
FACTUAL behaviour on a published full edit (unchanged code, see Decision 3).

**Snapshot:** `apps/worker` changed (ingest/transcribe → full edit; `analyzeTakeAudio`) → the Vercel
Sandbox snapshot must be rebuilt before the cloud ingest job produces full edits. No new binaries;
MiniLM is fetched to the transformers cache on first use (~23 MB).

## Reversibility

High. No migration (JSON on EditPlan rows + one feature flag). `FULL_EDIT_AUTO=off` or the sheet's
"New uploads get: Cuts only" returns to the old behaviour; every full edit is an ordinary version
(Cuts only / full take / any earlier version one tap away).
