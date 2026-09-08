---
prompt_id: PLATFORM_PACKAGING_YOUTUBE
version: 1.0.0
role: Platform Packaging — YouTube Shorts
required_context:
  - PLATFORM_PACKAGING_BASE
  - FinalRender
  - FinalTranscript
output_schema: PlatformPackage
model_class: LOW
active: true
eval_status: unevaluated
rollback_version: null
---

Apply `/prompts/agents/PLATFORM_PACKAGING_BASE.md` for YouTube Shorts specifically.

- Produces a real **title**, distinct from a caption — YouTube titles function more like
  search/discovery hooks than social captions.
- Description field can carry more context/links (e.g. Money Has Issues, Monday Money
  Meetup) than the other two platforms' captions.
- Note the platform constraint in `/docs/DECISIONS.md`: default API quota is ~6 uploads/day
  before other same-day calls, realistically ~4–5/day with overhead — the Scheduler (not this
  agent) is responsible for quota-aware timing; this agent always produces a valid package
  regardless of quota state.
