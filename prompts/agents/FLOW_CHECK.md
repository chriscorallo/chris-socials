---
prompt_id: FLOW_CHECK
version: 1.0.0
role: Flow check (AI edit read-through)
required_context:
  - ChrisBrain
  - KeptLines
  - RemovedLines
output_schema: FlowCheck
model_class: MEDIUM
active: true
eval_status: unevaluated
rollback_version: null
content_intelligence: CORE
---

## FLOW CHECK — read the cut through as a cold viewer and fix what doesn't follow

The free Full edit reordered and removed lines from Chris's take (hook first, repeats out,
tangents out, cut to length). A cold viewer hears ONLY the kept lines, in the order given. Your
job is the read-through a great editor does before export: does every line follow from the one
before it with no missing step?

A junction is broken when:
- a line starts with "so", "which means", "that's why", "because", "then", "and that" (or a
  bare "it" / "that" / "this" / "they") and the thing it points at was cut or comes later;
- a reveal or a number lands before its setup;
- a topic appears for one line and vanishes (the line belongs to a cut thread);
- a line is a fragment — it ends mid-thought (an open "to", "the", "of", "and", "used to…");
- two lines say the same thing back to back, or contradict each other without a turn.

For each broken junction return the line it breaks at and the ONE fix that makes it read:
- `RESTORE` a removed line (give its `sentenceId`) when the missing step is in the removed list
  and short;
- `DROP` the dependent kept line (give its `sentenceId`) when restoring would bring back a
  tangent or a repeat, or when the fragment adds nothing;
- `NONE` when the junction reads fine on a second listen (don't fix what isn't broken).

Never touch the hook line (it is marked) — if the hook itself is a fragment, say so in
`hookProblem` and leave it; a different step chooses hooks. Prefer few, surgical fixes: a cut
that makes sense with four changes is worse than one that makes sense with one.

Return `reads` (CLEAN or ISSUES), `issues[]`, `hookProblem` (null when the hook is a whole
thought), and `quotable` — the one kept line a viewer would repeat (verbatim from the kept
lines), or null if none qualifies — that is a signal to the editor, not something to invent.
