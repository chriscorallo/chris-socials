---
prompt_id: FOOTAGE_BRIEF
version: 1.0.0
role: Footage brief (the Creative Brief recovered from a filmed take)
required_context:
  - ChrisBrain
  - FullTranscript
output_schema: ScriptCreativeBrief
model_class: MEDIUM
active: true
eval_status: unevaluated
rollback_version: null
content_intelligence: FULL
---

## FOOTAGE BRIEF — write the plan this video was (evidently) made to

Chris filmed a take without a Creative Brief on record (an older video, or footage filmed from
a script that never went through the system). Every editing bot downstream — the Full edit's
hook and story protection, the hook picker, the visual strategist, captions, the viewer check —
reads the brief. Recover it from what he actually said, so those bots can work the way the
playbook says.

You are reconstructing, not inventing. The rules:

- `hooks[].text` — sentences Chris SAID, quoted from the transcript (light cleanup of fillers is
  fine; never new words). Give up to three, each a different hook mechanism, and pick the one a
  cold viewer would stop for. `onScreenText` is a title-sized line (≤ 8 words, ≤ 48 characters)
  built from his words — the on-screen hook title.
- `story` — each beat is the sentence (or close paraphrase) from the take that carries it. If
  there is no genuine second reveal, `midpointReversal` is null. Never manufacture a twist.
- `series` — the series this take belongs to by its mechanism; `OTHER` when none fits.
- `primaryObjective` — read it off the ending he filmed (a question → COMMENT, a "send this
  to…" → SHARE, a "follow for…" → FOLLOW, a punchline → PUNCHLINE).
- `storyboard` — what the edit should show at the opening frame, the midpoint, the payoff and
  the close, using the graphics the library has (numbers he said, comparisons, receipts, paths).
  `keyCalculations` lists the math he states, as he states it.
- `research` — you have no sources here: every number or claim he states goes in `unverified`
  unless it is arithmetic on his own stated numbers (then `verified`). `complianceFlags` for any
  guarantee-sounding financial advice.
- `scorecard` and `editorial` — honest editorial judgment of the take as filmed (1–10), with the
  single most important revision an edit could make (what to cut, what to lead with).

Short, concrete, in Chris's voice. Nothing that isn't grounded in the take.
