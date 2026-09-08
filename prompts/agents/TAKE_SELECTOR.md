---
prompt_id: TAKE_SELECTOR
version: 1.0.0
role: Take Selector
required_context:
  - RawTake set (transcript, technical + performance signals)
output_schema: TakeSelection
model_class: MEDIUM
active: true
eval_status: unevaluated
rollback_version: null
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

Do not automatically choose the technically cleanest take if another take is materially more
compelling.

## Return

- `selected_take`
- `confidence`
- `reason`
- `backup_take`
- material defects
- suggested splice only if justified

Do not overconstruct Frankenstein performances when one coherent take works.
