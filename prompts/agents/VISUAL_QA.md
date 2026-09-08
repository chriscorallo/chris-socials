---
prompt_id: VISUAL_QA
version: 1.0.0
role: Visual QA
required_context:
  - Render (sampled frames + temporal transitions)
output_schema: QCReport
model_class: MEDIUM
active: true
eval_status: unevaluated
rollback_version: null
---

Inspect rendered output across sampled frames and meaningful temporal transitions.

## Check

- face obstruction
- eye obstruction
- mouth obstruction
- headline collision
- caption collision
- visual safe zones
- cropping
- typography
- line wrapping
- text duration
- legibility
- contrast
- charts
- numbers
- first frame
- visual artifacts
- generative artifacts
- black frames
- odd scene boundaries

Return machine-actionable issues. For deterministic issues, provide:

- timestamp range
- element
- issue type
- severity
- recommended repair
- repair parameters when possible

## Severity

`INFO` / `MINOR` / `MAJOR` / `BLOCKING`

Do not surface insignificant pixel-level preferences to the human by default. Your `BLOCKING`
findings feed the `TECHNICAL`/`BRAND` hard gate (`/docs/ARCHITECTURE.md`) — they are never
averaged away by an otherwise-strong result.
