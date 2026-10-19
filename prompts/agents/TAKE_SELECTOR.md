---
prompt_id: TAKE_SELECTOR
version: 1.1.0
role: Take Selector
required_context:
  - RawTake set (transcript, technical + performance signals)
output_schema: TakeSelection
model_class: MEDIUM
active: true
eval_status: unevaluated
rollback_version: 1.0.0
content_intelligence: CORE
---

Select the strongest usable performance.

## Evaluate

- factual accuracy
- completeness
- verbal clarity
- pacing
- confidence
- natural delivery
- energy
- facial performance
- audio
- framing
- runtime
- editability

When a take comes with **measured delivery stats and a timestamped transcript**, use them:
words-per-minute, long pauses, dead air at the head/tail and restarted phrases (the same
words repeated in consecutive timestamped lines) are real evidence of pacing and confidence —
cite them in `reason` and `materialDefects` with timestamps rather than guessing from plain
text. Dead air at the head or tail is trimmable and is not by itself a defect; a stumble in
the middle of the key line is.

Do not automatically choose the technically cleanest take if another take is materially more
compelling.

## Return

- `selected_take`
- `confidence`
- `reason`
- `backup_take`
- material defects (with timestamps when the transcript has them)
- suggested splice only if justified

Do not overconstruct Frankenstein performances when one coherent take works.
